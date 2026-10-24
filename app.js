'use strict';

const $ = (selector) => document.querySelector(selector);
const elements = {
  home: $('#home'), join: $('#join'), room: $('#room'),
  createForm: $('#create-form'), createButton: $('#create-button'),
  joinForm: $('#join-form'), joinButton: $('#join-button'),
  createName: $('#create-name'), joinName: $('#join-name'), videoUrl: $('#video-url'),
  connection: $('#connection-status'), members: $('#member-list'), messages: $('#chat-messages'),
  chatForm: $('#chat-form'), chatInput: $('#chat-input'),
  player: $('#bili-player'), playerLoading: $('#player-loading'), currentBvid: $('#current-bvid'),
  partLabel: $('#part-label'), openBili: $('#open-bili'), vipOpen: $('#vip-open'), reload: $('#reload-player'),
  roomTime: $('#room-time'), syncMode: $('#sync-mode'), syncActionAlert: $('#sync-action-alert'),
  syncActionText: $('#sync-action-text'), syncActionDone: $('#sync-action-done'), countdown: $('#countdown-banner'),
  countdownNumber: $('#countdown-number'), syncStart: $('#sync-start'), syncPause: $('#sync-pause'),
  readyButton: $('#ready-button'), seekForm: $('#seek-form'), seekInput: $('#seek-input'),
  changeForm: $('#change-form'), changeUrl: $('#change-url'), changeButton: $('#change-button'),
  share: $('#share-button'), leave: $('#leave-button'), toast: $('#toast'),
};

let roomId = new URLSearchParams(location.search).get('room');
let token = null;
let myId = null;
let roomData = null;
let stream = null;
let currentVideoKey = '';
let clockOffset = 0;
let toastTimer = null;
let playerTimer = null;
let finishedCountdownVersion = null;
const shownMessages = new Set();

function showScreen(id) {
  for (const key of ['home', 'join', 'room']) elements[key].classList.toggle('hidden', key !== id);
}
function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 4300);
}
function setConnection(text, variant = '') {
  elements.connection.textContent = text;
  elements.connection.className = `online-status ${variant}`;
}
async function api(path, body, method = 'POST') {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('无法连接服务器，请检查网络或服务器是否仍在运行。');
  }
  let value;
  try { value = await response.json(); } catch { throw new Error('服务器返回了无法识别的内容。'); }
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value;
}
async function busy(button, work) {
  button.disabled = true;
  try { await work(); } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}
function getName(input) { return input.value.trim().slice(0, 18) || '观影伙伴'; }
function rememberName(name) { localStorage.setItem('bili-together:nickname', name); }
function storageKey() { return `bili-together:room:${roomId}`; }
function setServerClock(serverNow) {
  if (typeof serverNow === 'number' && Number.isFinite(serverNow)) clockOffset = serverNow - Date.now();
}
function serverTime() { return Date.now() + clockOffset; }
function roomPosition() {
  const sync = roomData?.sync;
  if (!sync) return 0;
  const elapsed = sync.playing ? Math.max(0, (serverTime() - sync.updatedAt) / 1000) : 0;
  return Math.min(86400, Math.max(0, sync.baseTime + elapsed));
}
function asTime(seconds) {
  let n = Math.max(0, Math.floor(seconds));
  const s = String(n % 60).padStart(2, '0');
  const m = String(Math.floor(n / 60) % 60).padStart(2, '0');
  const h = Math.floor(n / 3600);
  return h ? `${String(h).padStart(2, '0')}:${m}:${s}` : `${m}:${s}`;
}
function parseTime(input) {
  const raw = input.trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!/^\d{1,3}:[0-5]\d(?::[0-5]\d)?$/.test(raw)) return NaN;
  return raw.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}
function embedUrl(video, seconds = 0) {
  const p = new URLSearchParams({ bvid: video.bvid, p: String(video.page), t: String(Math.floor(seconds)), autoplay: '0', danmaku: '0' });
  return `https://player.bilibili.com/player.html?${p.toString()}`;
}
// 大会员观看必须跳转 B站官方页面，才能由 B站核验各自的登录/画质权益。
// 此链接只传 BV、分P、时间，不携带账号、Cookie 或任何鉴权信息。
function officialWatchUrl(video, seconds = 0) {
  const url = new URL(`https://www.bilibili.com/video/${encodeURIComponent(video.bvid)}/`);
  url.searchParams.set('p', String(video.page));
  url.searchParams.set('t', String(Math.max(0, Math.floor(seconds))));
  return url.href;
}
function updateOfficialLinks() {
  if (!roomData?.video) return;
  const url = officialWatchUrl(roomData.video, roomPosition());
  elements.openBili.href = url;
  elements.vipOpen.href = url;
}
function showActionAlert(message) {
  elements.syncActionText.textContent = message;
  elements.syncActionAlert.classList.remove('hidden');
}
function loadPlayer(seconds = 0) {
  if (!roomData?.video) return;
  clearTimeout(playerTimer);
  const pos = Math.max(0, Math.floor(seconds));
  elements.playerLoading.textContent = `正在加载播放器 · ${asTime(pos)}`;
  elements.playerLoading.classList.remove('hidden');
  elements.player.src = embedUrl(roomData.video, pos);
  // 如果外站没有触发 load，过一段时间仍显示提醒，不伪装成播放成功
  playerTimer = setTimeout(() => {
    if (!elements.playerLoading.classList.contains('hidden')) {
      elements.playerLoading.textContent = '播放器加载较慢，请检查 B站能否在当前网络访问';
    }
  }, 9000);
}
elements.player.addEventListener('load', () => {
  clearTimeout(playerTimer);
  elements.playerLoading.classList.add('hidden');
});
function setVideo(video, force = false) {
  if (!video) return;
  const key = `${video.bvid}:${video.page}`;
  roomData.video = video;
  elements.currentBvid.textContent = video.bvid;
  elements.partLabel.textContent = `P${video.page}`;
  updateOfficialLinks();
  if (force || currentVideoKey !== key) {
    currentVideoKey = key;
    loadPlayer(roomPosition());
  }
}
function renderMembers() {
  elements.members.replaceChildren();
  const members = roomData?.members || [];
  for (const member of members) {
    const holder = document.createElement('div');
    holder.className = 'member' + (member.online ? '' : ' offline');
    const avatar = document.createElement('div');
    avatar.className = 'member-avatar';
    avatar.textContent = member.name.slice(0, 1) || '?';
    const label = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = member.name + (member.id === myId ? '（我）' : '');
    const info = document.createElement('small');
    info.textContent = member.online ? (member.ready ? '● 在线 · 已准备' : '● 在线') : '○ 离线';
    label.append(name, info);
    holder.append(avatar, label);
    elements.members.append(holder);
  }
  if (members.length < 2) {
    const waiting = document.createElement('span');
    waiting.className = 'soft-tag';
    waiting.textContent = '等待另一位加入…';
    elements.members.append(waiting);
  }
  const me = members.find((m) => m.id === myId);
  elements.readyButton.textContent = me?.ready ? '✓ 已准备（点击取消）' : '♡ 我准备好了';
}
function renderMessages(messages) {
  elements.messages.replaceChildren();
  shownMessages.clear();
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-chat';
    empty.textContent = '今天的悄悄话，从这里开始 ♡';
    elements.messages.append(empty);
  }
  for (const message of messages) appendMessage(message);
}
function appendMessage(message) {
  if (!message || shownMessages.has(message.id)) return;
  if (shownMessages.size === 0) elements.messages.querySelector('.empty-chat')?.remove();
  shownMessages.add(message.id);
  if (shownMessages.size > 120) shownMessages.clear();
  const root = document.createElement('div');
  if (message.system) {
    root.className = 'system-message';
    root.textContent = message.text;
  } else {
    const mine = message.userId === myId;
    root.className = `chat-message${mine ? ' mine' : ''}`;
    const avatar = document.createElement('div');
    avatar.className = 'bubble-avatar';
    avatar.textContent = (message.name || '?').slice(0, 1);
    const body = document.createElement('div');
    const meta = document.createElement('div');
    meta.className = 'bubble-meta';
    const name = document.createElement('span');
    name.textContent = mine ? '我' : message.name;
    const time = document.createElement('span');
    time.textContent = new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    meta.append(name, time);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = message.text; // 不使用 innerHTML，避免聊天 XSS
    body.append(meta, bubble);
    root.append(avatar, body);
  }
  elements.messages.append(root);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}
function updateClock() {
  if (!roomData) return;
  const sync = roomData.sync;
  elements.roomTime.textContent = asTime(roomPosition());
  // 会员高清入口在点击时更新到房间共享时间，避免原站从头播放。
  const remain = sync.countdownUntil ? sync.countdownUntil - serverTime() : 0;
  const counting = sync.playing && remain > 0;
  elements.countdown.classList.toggle('hidden', !counting);
  if (counting) elements.countdownNumber.textContent = String(Math.ceil(remain / 1000));
  elements.syncMode.textContent = counting ? '准备一起点播放…' : (sync.playing ? '共享计时进行中（请手动播放视频）' : '共享计时已暂停');
  // 倒数归零时明确提醒双方操作。该提示不声称能够远程控制 B站 iframe。
  if (sync.playing && sync.countdownUntil && remain <= 0 && finishedCountdownVersion !== sync.version) {
    finishedCountdownVersion = sync.version;
    if (serverTime() - sync.countdownUntil < 10000) {
      showActionAlert('倒计时结束：现在请点各自 B站播放器内的 ▶ 播放！');
    }
  }
}
function syncUpdated(payload) {
  if (!roomData) return;
  setServerClock(payload.serverNow);
  if (payload.sync.version < roomData.sync.version) return;
  roomData.sync = payload.sync;
  updateClock();
  if (payload.action === 'seek') {
    loadPlayer(roomPosition());
    toast(`${payload.actorName} 设置了同步时间 ${asTime(roomPosition())}，播放器已重载，请手动播放。`);
    showActionAlert(`${payload.actorName} 跳转到了 ${asTime(roomPosition())}。嵌入播放器已重载；原站高清请重新点击上面的「打开 B站高清观看」，然后各自播放。`);
  } else if (payload.action === 'start') {
    toast('已发出 5 秒同步倒计时！到 0 时请同时点击 B站播放器播放键。');
    showActionAlert(`${payload.actorName} 发出了共同播放指令。请准备好，倒计时归零时各自按 ▶ 播放。`);
  } else if (payload.action === 'pause') {
    toast('共享计时已暂停；请手动暂停 B站播放器。');
    showActionAlert(`${payload.actorName} 已暂停共享计时！请立刻在你自己的 B站播放器中点 ⏸ 暂停。`);
  }
}
function onEvent(type, handler) {
  stream.addEventListener(type, (event) => {
    try { handler(JSON.parse(event.data)); }
    catch (e) { console.error('无法处理房间消息', e); }
  });
}
function connectEvents() {
  stream?.close();
  stream = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/events?token=${encodeURIComponent(token)}`);
  setConnection('● 正在连接');
  stream.onopen = () => setConnection('● 已连接', 'good');
  stream.onerror = () => setConnection('● 已断线，自动重连中', 'bad');
  onEvent('snapshot', (data) => {
    setServerClock(data.serverNow);
    roomData = data;
    renderMembers();
    renderMessages(data.messages || []);
    setVideo(data.video);
    updateClock();
  });
  onEvent('presence', (data) => {
    if (!roomData) return;
    setServerClock(data.serverNow);
    roomData.members = data.members;
    renderMembers();
  });
  onEvent('message', (data) => {
    setServerClock(data.serverNow);
    appendMessage(data.message);
  });
  onEvent('video', (data) => {
    if (!roomData) return;
    setServerClock(data.serverNow);
    roomData.sync = data.sync;
    setVideo(data.video, true);
    toast(`${data.actorName} 换了新视频，已为双方载入。`);
    showActionAlert(`${data.actorName} 切换了视频。请确认新视频已加载，双方再准备一起播放。`);
  });
  onEvent('sync', syncUpdated);
}
async function joinRoom(name) {
  if (!roomId) throw new Error('房间号码无效。');
  const savedToken = sessionStorage.getItem(storageKey());
  const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, { name, token: savedToken || undefined });
  token = data.token;
  myId = data.memberId;
  sessionStorage.setItem(storageKey(), token);
  rememberName(name);
  setServerClock(data.room.serverNow);
  roomData = data.room;
  showScreen('room');
  renderMembers();
  renderMessages(data.room.messages);
  setVideo(data.room.video);
  updateClock();
  connectEvents();
}
async function operation(name, payload = {}) {
  if (!roomId || !token) throw new Error('请先加入房间。');
  return api(`/api/rooms/${encodeURIComponent(roomId)}/${name}`, { token, ...payload });
}

// 创建房间
 elements.createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  busy(elements.createButton, async () => {
    const name = getName(elements.createName);
    const { id } = await api('/api/rooms', { url: elements.videoUrl.value.trim() });
    roomId = id;
    history.replaceState({}, '', `/?room=${encodeURIComponent(roomId)}`);
    await joinRoom(name);
    toast('观影室创建成功！点击右上角复制邀请链接。');
  });
});
 elements.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  busy(elements.joinButton, () => joinRoom(getName(elements.joinName)));
});
 elements.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = elements.chatInput.value.trim();
  if (!value) return;
  busy(elements.chatForm.querySelector('button'), async () => {
    await operation('messages', { text: value });
    if (elements.chatInput.value.trim() === value) elements.chatInput.value = '';
    elements.chatInput.focus();
  });
});
 elements.changeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = elements.changeUrl.value.trim();
  if (!url) return toast('请先粘贴新视频链接。');
  busy(elements.changeButton, async () => {
    await operation('video', { url });
    elements.changeUrl.value = '';
  });
});
 elements.syncStart.addEventListener('click', () => busy(elements.syncStart, () => operation('sync', { action: 'start' })));
 elements.syncPause.addEventListener('click', () => busy(elements.syncPause, () => operation('sync', { action: 'pause' })));
 elements.readyButton.addEventListener('click', () => busy(elements.readyButton, () => {
  const me = roomData?.members?.find((m) => m.id === myId);
  return operation('ready', { ready: !me?.ready });
}));
 elements.seekForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const seconds = parseTime(elements.seekInput.value);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) return toast('请输入秒数或 01:25 这样的时间（不超过24小时）。');
  busy(elements.seekForm.querySelector('button'), async () => {
    await operation('sync', { action: 'seek', seconds });
    elements.seekInput.value = '';
  });
});
// 这两个外链都在点击的瞬间生成，使用房间当前进度。
for (const link of [elements.openBili, elements.vipOpen]) {
  link.addEventListener('click', updateOfficialLinks);
}
elements.syncActionDone.addEventListener('click', () => {
  elements.syncActionAlert.classList.add('hidden');
});
 elements.reload.addEventListener('click', () => {
  loadPlayer(roomPosition());
  toast('已按共享进度重新载入播放器。请手动点击 B站播放键。');
});
 elements.share.addEventListener('click', async () => {
  const url = `${location.origin}/?room=${encodeURIComponent(roomId)}`;
  // 手机或平板优先使用系统分享面板；不支持时复制链接。
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: '一起看 B站吧', text: '邀请你加入我们的双人观影室', url });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // 主动取消分享
    }
  }
  try { await navigator.clipboard.writeText(url); toast('邀请链接已复制，发给 TA 就能加入。'); }
  catch { window.prompt('复制邀请链接发送给 TA：', url); }
});
 elements.leave.addEventListener('click', async () => {
  try { await operation('leave'); } catch { /* best effort */ }
  stream?.close();
  sessionStorage.removeItem(storageKey());
  location.href = '/';
});

// 根据邀请链接决定入口；同标签页刷新会自动恢复用户身份。
const previousName = localStorage.getItem('bili-together:nickname') || '';
elements.createName.value = previousName;
elements.joinName.value = previousName;
if (roomId) {
  showScreen('join');
  if (sessionStorage.getItem(storageKey())) {
    joinRoom(previousName || '观影伙伴').catch((error) => { showScreen('join'); toast(error.message); });
  }
} else {
  showScreen('home');
}
setInterval(updateClock, 150);

// 移动端用户在房间里观影时低频确认服务仍在线；隐藏标签页不打扰。
// Render 免费托管基于入站请求判断空闲，观影过程中也可能长期没有聊天请求。
setInterval(() => {
  if (token && roomId && roomData && document.visibilityState === 'visible') {
    fetch('/api/health', { cache: 'no-store' }).catch(() => {});
  }
}, 4 * 60 * 1000);
