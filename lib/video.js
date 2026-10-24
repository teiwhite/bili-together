/**
 * 只解析 Bilibili 视频的合法 BV 号及分页/时间参数，不请求视频流。
 * 官方外链播放器文档：https://player.bilibili.com/
 */
const BV_RE = /^BV[0-9A-Za-z]{10}$/;
const BILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'player.bilibili.com']);
const SHORT_HOSTS = new Set(['b23.tv', 'www.b23.tv']);

export class VideoInputError extends Error {
  constructor(message) { super(message); this.name = 'VideoInputError'; }
}

function boundedInteger(value, defaultValue, max) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.min(Math.floor(num), max) : defaultValue;
}

export function parseTimestamp(raw) {
  if (raw == null || raw === '') return 0;
  const input = String(raw).trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(input)) return boundedInteger(input, 0, 86400);
  if (!/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.test(input)) return 0;
  const match = input.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return Math.min(86400, Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
}

export function parseVideo(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) {
    throw new VideoInputError('请粘贴 B站视频链接或 BV号（最多2048字）。');
  }
  const value = input.trim();
  let bvid, page = 1, time = 0;
  if (BV_RE.test(value)) {
    bvid = value;
  } else {
    const candidate = value.match(/https?:\/\/[^\s<>"'，。；）】]+/i)?.[0];
    if (!candidate) throw new VideoInputError('请输入完整的 B站视频链接或 BV号。');
    let url;
    try { url = new URL(candidate); } catch { throw new VideoInputError('视频链接格式不正确。'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new VideoInputError('链接协议不支持。');
    if (SHORT_HOSTS.has(url.hostname.toLowerCase())) {
      throw new VideoInputError('这是 b23.tv 短链接，需要先解析。');
    }
    if (!BILI_HOSTS.has(url.hostname.toLowerCase())) {
      throw new VideoInputError('目前只支持 bilibili.com 的 B站视频链接。');
    }
    const match = url.pathname.match(/\/(?:video\/)?(BV[0-9A-Za-z]{10})(?:\/|$)/i) || url.searchParams.get('bvid')?.match(/^(BV[0-9A-Za-z]{10})$/i);
    if (!match) throw new VideoInputError('没有在链接中找到 BV号，请确认是普通视频页链接。');
    bvid = match[1];
    page = Math.max(1, boundedInteger(url.searchParams.get('p'), 1, 100));
    time = parseTimestamp(url.searchParams.get('t') || url.searchParams.get('start_progress'));
  }
  return {
    bvid,
    page,
    startTime: time,
    url: `https://www.bilibili.com/video/${bvid}/?p=${page}`,
  };
}

/**
 * 短链接只能请求指定 B站域名。手动处理跳转以阻止 SSRF 到其他域名/IP。
 */
export async function resolveVideo(input, fetchImpl = fetch) {
  if (typeof input !== 'string') throw new VideoInputError('请输入 B站链接。');
  const candidate = input.match(/https?:\/\/[^\s<>"'，。；）】]+/i)?.[0];
  if (!candidate) return parseVideo(input);
  let url;
  try { url = new URL(candidate); } catch { throw new VideoInputError('视频链接格式不正确。'); }
  if (!SHORT_HOSTS.has(url.hostname.toLowerCase())) return parseVideo(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new VideoInputError('链接协议不支持。');
  let current = new URL(url.pathname + url.search, 'https://b23.tv');
  for (let i = 0; i < 5; i++) {
    let response;
    try {
      response = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'BiliTogether/1.0' } });
    } catch {
      throw new VideoInputError('短链接解析失败，请复制 B站视频页面的完整网址。');
    }
    const location = response.headers.get('location');
    if (!location) throw new VideoInputError('未能解析短链接，请粘贴完整的 B站视频网址。');
    let next;
    try { next = new URL(location, current); } catch { throw new VideoInputError('短链接跳转异常。'); }
    const host = next.hostname.toLowerCase();
    if (next.protocol !== 'https:' || !(BILI_HOSTS.has(host) || SHORT_HOSTS.has(host))) {
      throw new VideoInputError('短链接跳转到非 B站地址，已拒绝。');
    }
    if (BILI_HOSTS.has(host)) return parseVideo(next.href);
    current = next;
  }
  throw new VideoInputError('短链接跳转次数过多，请粘贴完整网址。');
}

export function getEmbedUrl(video, seconds = 0) {
  const url = new URL('https://player.bilibili.com/player.html');
  url.searchParams.set('bvid', video.bvid);
  url.searchParams.set('p', String(video.page || 1));
  url.searchParams.set('t', String(boundedInteger(seconds, 0, 86400)));
  url.searchParams.set('autoplay', '0');
  url.searchParams.set('danmaku', '0');
  return url.href;
}
