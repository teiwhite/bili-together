import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseVideo, resolveVideo, VideoInputError } from './lib/video.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const MAX_ROOMS = 500;
const MAX_MESSAGES = 100;

const randomId = (bytes) => randomBytes(bytes).toString('base64url');
const asText = (v, max = 500) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const roomPosition = (room, now = Date.now()) => Math.max(0, Math.min(86400, room.sync.baseTime + (room.sync.playing ? Math.max(0, now - room.sync.updatedAt) / 1000 : 0)));
const summary = (room) => ({
  id: room.id,
  video: room.video,
  sync: room.sync,
  members: [...room.members.values()].map((m) => ({ id: m.id, name: m.name, online: Boolean(m.stream), ready: Boolean(m.ready) })),
  messages: room.messages,
  serverNow: Date.now(),
});
const writeSse = (res, type, data) => {
  if (!res || res.writableEnded || res.destroyed) return;
  try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* disconnected */ }
};

function broadcast(room, type, payload) {
  const data = { ...payload, serverNow: Date.now() };
  for (const member of room.members.values()) writeSse(member.stream, type, data);
}
function announcePresence(room) {
  broadcast(room, 'presence', { members: summary(room).members });
}
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function reject(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
async function readBody(req) {
  let content = '';
  for await (const part of req) {
    content += part;
    if (Buffer.byteLength(content, 'utf8') > 8192) throw reject(413, '请求内容太长。');
  }
  try { return JSON.parse(content || '{}'); }
  catch { throw reject(400, '请求内容不是有效的 JSON。'); }
}
function authorizedMember(room, body) {
  if (!body || typeof body.token !== 'string' || !TOKEN_RE.test(body.token)) throw reject(401, '需要先加入房间。');
  const member = room.members.get(body.token);
  if (!member) throw reject(403, '房间身份已失效，请重新进入。');
  return member;
}
function getRoom(rooms, id) {
  const room = ID_RE.test(id) ? rooms.get(id) : undefined;
  if (!room) throw reject(404, '房间不存在或服务器已经重启。请重新创建房间。');
  room.lastTouched = Date.now();
  return room;
}
function appendSystem(room, text) {
  const msg = { id: randomId(8), name: '系统', text, system: true, createdAt: Date.now() };
  room.messages.push(msg);
  if (room.messages.length > MAX_MESSAGES) room.messages.shift();
  broadcast(room, 'message', { message: msg });
}

export function createAppServer() {
  const rooms = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      for (const [token, m] of room.members) {
        if (!m.stream && m.disconnectedAt && now - m.disconnectedAt > 10 * 60_000) room.members.delete(token);
      }
      if (now - room.lastTouched > 24 * 60 * 60_000 && ![...room.members.values()].some((m) => m.stream)) {
        rooms.delete(id);
      }
    }
  }, 60_000);
  cleanup.unref();

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const p = requestUrl.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://player.bilibili.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (req.method === 'GET' && STATIC_FILES.has(p)) {
        const [name, contentType] = STATIC_FILES.get(p);
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        fs.createReadStream(path.join(DIR, 'public', name)).pipe(res);
        return;
      }
      if (req.method === 'GET' && p === '/api/health') {
        sendJson(res, 200, { ok: true, rooms: rooms.size }); return;
      }
      if (req.method === 'POST' && p === '/api/parse') {
        const data = await readBody(req);
        const video = await resolveVideo(data.url);
        sendJson(res, 200, { video }); return;
      }
      if (req.method === 'POST' && p === '/api/rooms') {
        const data = await readBody(req);
        if (rooms.size >= MAX_ROOMS) throw reject(503, '当前房间已满，请稍后再试。');
        const video = await resolveVideo(data.url);
        const id = randomId(12); // 随机不可猜的邀请房间号
        const now = Date.now();
        const room = {
          id, video, members: new Map(), messages: [],
          sync: { playing: false, baseTime: video.startTime || 0, updatedAt: now, countdownUntil: null, version: 1 },
          lastTouched: now,
        };
        rooms.set(id, room);
        sendJson(res, 201, { id, video }); return;
      }
      const match = p.match(/^\/api\/rooms\/([^/]+)(?:\/(join|events|messages|video|sync|ready|leave))?$/);
      if (!match) throw reject(404, '页面不存在。');
      const room = getRoom(rooms, match[1]);
      const op = match[2];
      if (req.method === 'POST' && op === 'join') {
        const data = await readBody(req);
        const name = asText(data.name, 18) || '观影伙伴';
        const supplied = typeof data.token === 'string' && TOKEN_RE.test(data.token) ? data.token : '';
        let member = supplied ? room.members.get(supplied) : undefined;
        if (!member) {
          if (room.members.size >= 2) throw reject(409, '房间已经有两位成员，请稍后再试。');
          member = { id: randomId(6), token: randomId(24), name, stream: null, ready: false, disconnectedAt: null, lastMessageAt: 0 };
          room.members.set(member.token, member);
          appendSystem(room, `${name} 加入了房间`);
        } else {
          member.name = name;
        }
        member.disconnectedAt = null;
        sendJson(res, 200, { token: member.token, memberId: member.id, room: summary(room) });
        announcePresence(room);
        return;
      }
      if (req.method === 'GET' && op === 'events') {
        const token = requestUrl.searchParams.get('token');
        const member = authorizedMember(room, { token });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2500\n\n');
        if (member.stream && member.stream !== res) member.stream.end();
        member.stream = res;
        member.disconnectedAt = null;
        writeSse(res, 'snapshot', summary(room));
        announcePresence(room);
        const ping = setInterval(() => {
          if (!res.destroyed) res.write(': heartbeat\n\n');
          room.lastTouched = Date.now();
        }, 20000);
        ping.unref();
        res.on('close', () => {
          clearInterval(ping);
          if (member.stream !== res) return; // 旧连接不能覆盖已重连的在线状态
          member.stream = null;
          member.ready = false;
          member.disconnectedAt = Date.now();
          announcePresence(room);
        });
        return;
      }
      if (req.method !== 'POST') throw reject(405, '不支持此请求方法。');
      const data = await readBody(req);
      const member = authorizedMember(room, data);
      if (op === 'messages') {
        const text = asText(data.text, 500);
        if (!text) throw reject(400, '不能发送空消息。');
        const now = Date.now();
        if (now - member.lastMessageAt < 350) throw reject(429, '发送过快，请稍等。');
        member.lastMessageAt = now;
        const message = { id: randomId(8), userId: member.id, name: member.name, text, system: false, createdAt: now };
        room.messages.push(message);
        if (room.messages.length > MAX_MESSAGES) room.messages.shift();
        broadcast(room, 'message', { message });
        sendJson(res, 201, { ok: true, message }); return;
      }
      if (op === 'video') {
        const video = await resolveVideo(data.url);
        room.video = video;
        room.sync = { playing: false, baseTime: video.startTime || 0, updatedAt: Date.now(), countdownUntil: null, version: room.sync.version + 1 };
        for (const m of room.members.values()) m.ready = false;
        broadcast(room, 'video', { video, sync: room.sync, actorName: member.name });
        announcePresence(room);
        appendSystem(room, `${member.name} 切换了视频`);
        sendJson(res, 200, { ok: true, video }); return;
      }
      if (op === 'sync') {
        const action = data.action;
        const now = Date.now();
        const current = roomPosition(room, now);
        if (action === 'start') {
          room.sync = { ...room.sync, baseTime: current, playing: true, updatedAt: now + 5000, countdownUntil: now + 5000, version: room.sync.version + 1 };
          for (const m of room.members.values()) m.ready = false;
          announcePresence(room);
        } else if (action === 'pause') {
          room.sync = { ...room.sync, baseTime: current, playing: false, updatedAt: now, countdownUntil: null, version: room.sync.version + 1 };
        } else if (action === 'seek') {
          const seconds = Number(data.seconds);
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw reject(400, '请输入 0 到 86400 秒以内的进度。');
          room.sync = { ...room.sync, baseTime: Math.floor(seconds), playing: false, updatedAt: now, countdownUntil: null, version: room.sync.version + 1 };
        } else {
          throw reject(400, '未知的同步操作。');
        }
        broadcast(room, 'sync', { sync: room.sync, action, actorName: member.name });
        sendJson(res, 200, { ok: true, sync: room.sync }); return;
      }
      if (op === 'ready') {
        member.ready = Boolean(data.ready);
        announcePresence(room);
        // 双人准备完成后自动进入 5 秒同步倒计时
        const everyone = [...room.members.values()];
        if (everyone.length === 2 && everyone.every((m) => m.ready && m.stream)) {
          const now = Date.now();
          room.sync = { ...room.sync, baseTime: roomPosition(room, now), playing: true, updatedAt: now + 5000, countdownUntil: now + 5000, version: room.sync.version + 1 };
          everyone.forEach((m) => { m.ready = false; });
          announcePresence(room);
          broadcast(room, 'sync', { sync: room.sync, action: 'start', actorName: '双方已准备' });
        }
        sendJson(res, 200, { ok: true }); return;
      }
      if (op === 'leave') {
        if (member.stream) member.stream.end();
        room.members.delete(member.token);
        appendSystem(room, `${member.name} 离开了房间`);
        announcePresence(room);
        sendJson(res, 200, { ok: true }); return;
      }
      throw reject(404, '接口不存在。');
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      const status = err instanceof VideoInputError ? 400 : err.status || 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: status >= 500 ? '服务器处理失败，请重试。' : err.message });
    }
  });
  server.on('close', () => {
    clearInterval(cleanup);
    for (const room of rooms.values()) for (const member of room.members.values()) member.stream?.end();
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createAppServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`\n  一起看 B站，已启动：http://localhost:${server.address().port}\n`);
  });
}
