import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer } from '../server.js';
import { getEmbedUrl, parseVideo, parseTimestamp, resolveVideo, VideoInputError } from '../lib/video.js';

let server;
let origin;
before(async () => {
  server = createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function request(method, route, body) {
  const response = await fetch(origin + route, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
const post = (url, body) => request('POST', url, body);
const invite = async () => {
  const result = await post('/api/rooms', { url: 'https://www.bilibili.com/video/BV1Lvu3zhEpr/?p=2&t=43' });
  assert.equal(result.status, 201);
  return result.data.id;
};

function subscribe(route) {
  const controller = new AbortController();
  let reader;
  let pending = '';
  let decoder = new TextDecoder();
  async function next(type) {
    if (!reader) {
      const response = await fetch(origin + route, { signal: controller.signal });
      assert.equal(response.status, 200);
      reader = response.body.getReader();
    }
    while (true) {
      const split = pending.indexOf('\n\n');
      if (split !== -1) {
        const chunk = pending.slice(0, split);
        pending = pending.slice(split + 2);
        const lines = chunk.split('\n');
        const found = lines.find((line) => line.startsWith('event: '))?.slice(7);
        const value = lines.find((line) => line.startsWith('data: '))?.slice(6);
        if (found === type && value) return JSON.parse(value);
        continue;
      }
      const result = await reader.read();
      if (result.done) throw new Error('SSE ended before event ' + type);
      pending += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');
    }
  }
  return { next, close: () => { controller.abort(); reader?.cancel().catch(() => {}); } };
}

test('解析 B站 BV 视频链接、时间与分页', () => {
  assert.deepEqual(parseVideo('BV1Lvu3zhEpr'), {
    bvid: 'BV1Lvu3zhEpr', page: 1, startTime: 0,
    url: 'https://www.bilibili.com/video/BV1Lvu3zhEpr/?p=1',
  });
  assert.equal(parseVideo('点击视频 https://www.bilibili.com/video/BV1Lvu3zhEpr/?p=4&t=1m30s 真的好看').startTime, 90);
  assert.equal(parseVideo('https://m.bilibili.com/video/BV1Lvu3zhEpr/?p=3').page, 3);
  assert.equal(parseTimestamp('2h3m04s'), 7384);
  assert.match(getEmbedUrl(parseVideo('BV1Lvu3zhEpr'), 55), /t=55/);
  assert.throws(() => parseVideo('https://evil.com/video/BV1Lvu3zhEpr/'), VideoInputError);
  assert.throws(() => parseVideo('https://www.bilibili.com/read/cv123'), VideoInputError);
});

test('短链接解析限制跳转域名', async () => {
  const result = await resolveVideo('https://b23.tv/test123', async () => ({
    headers: { get: () => 'https://www.bilibili.com/video/BV1Lvu3zhEpr/?p=4' },
  }));
  assert.equal(result.page, 4);
  await assert.rejects(() => resolveVideo('https://b23.tv/test123', async () => ({
    headers: { get: () => 'http://127.0.0.1:3000/private' },
  })), VideoInputError);
});

test('双人加入、拒绝第三人、校验身份、共享操作', async () => {
  const room = await invite();
  const url = `/api/rooms/${room}`;
  const a = await post(url + '/join', { name: '小明' });
  const b = await post(url + '/join', { name: '小红' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.data.room.video.page, 2);
  assert.equal(a.data.room.sync.baseTime, 43);
  assert.equal((await post(url + '/join', { name: '第三人' })).status, 409);
  assert.equal((await post(url + '/messages', { token: 'wrong', text: 'hello' })).status, 401);
  const message = await post(url + '/messages', { token: a.data.token, text: '我们一起看～' });
  assert.equal(message.status, 201);
  assert.equal(message.data.message.text, '我们一起看～');
  assert.equal((await post(url + '/messages', { token: a.data.token, text: ' ' })).status, 400);
  const seek = await post(url + '/sync', { token: b.data.token, action: 'seek', seconds: 85 });
  assert.equal(seek.data.sync.baseTime, 85);
  assert.equal(seek.data.sync.playing, false);
  const start = await post(url + '/sync', { token: a.data.token, action: 'start' });
  assert.equal(start.data.sync.playing, true);
  assert.equal(start.data.sync.countdownUntil, start.data.sync.updatedAt);
  const pause = await post(url + '/sync', { token: b.data.token, action: 'pause' });
  assert.equal(pause.data.sync.playing, false);
  assert.ok(pause.data.sync.baseTime >= 85);
  const newVideo = await post(url + '/video', { token: a.data.token, url: 'BV1Lvu3zhEpr' });
  assert.equal(newVideo.data.video.page, 1);
  const c = await post(url + '/join', { token: b.data.token, name: '小红' });
  assert.equal(c.status, 200);
  assert.equal(c.data.room.messages.at(-1).text, '小明 切换了视频');
  assert.equal(c.data.room.sync.baseTime, 0);
  assert.equal((await post(url + '/leave', { token: b.data.token })).status, 200);
  assert.equal((await post(url + '/join', { name: '新伙伴' })).status, 200);
});

test('SSE 实时下发聊天、成员状态和进度事件', async () => {
  const room = await invite();
  const url = `/api/rooms/${room}`;
  const a = (await post(url + '/join', { name: 'A' })).data;
  const b = (await post(url + '/join', { name: 'B' })).data;
  const subA = subscribe(url + `/events?token=${a.token}`);
  const subB = subscribe(url + `/events?token=${b.token}`);
  try {
    assert.equal((await subA.next('snapshot')).id, room);
    assert.equal((await subB.next('snapshot')).id, room);
    const ready = await post(url + '/ready', { token: a.token, ready: true });
    assert.equal(ready.status, 200);
    const presence = await subB.next('presence');
    // 第一条可能来自进入房间时；接着找到 ready 更新
    if (!presence.members.some((m) => m.name === 'A' && m.ready)) {
      const updated = await subB.next('presence');
      assert.ok(updated.members.some((m) => m.name === 'A' && m.ready));
    }
    const created = await post(url + '/messages', { token: b.token, text: '测试实时聊天' });
    assert.equal(created.status, 201);
    assert.equal((await subA.next('message')).message.text, '测试实时聊天');
    assert.equal((await post(url + '/sync', { token: a.token, action: 'seek', seconds: 110 })).status, 200);
    const sync = await subB.next('sync');
    assert.equal(sync.action, 'seek');
    assert.equal(sync.sync.baseTime, 110);
  } finally {
    subA.close(); subB.close();
  }
});

test('主页资源与健康接口', async () => {
  const page = await fetch(origin + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /B站视频链接/);
  const script = await fetch(origin + '/app.js');
  assert.equal(script.status, 200);
  const health = await fetch(origin + '/api/health');
  assert.equal((await health.json()).ok, true);
  assert.equal((await fetch(origin + '/private/secret')).status, 404);
});
