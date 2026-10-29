/**
 * Standalone Douyin live auth/connect diagnostic (no Coopanion).
 * Usage: node scripts/diag-auth.mjs [web_rid或完整URL]
 * Optional: DOUYIN_COOKIE="ttwid=...; sessionid=..." node scripts/diag-auth.mjs <rid>
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const input = process.argv[2] || '';
const envCookie = (process.env.DOUYIN_COOKIE || '').trim();

function parseWebRid(s) {
  const t = s.trim();
  if (!t) return null;
  const m = /live\.douyin\.com\/([A-Za-z0-9_-]+)/i.exec(t);
  if (m) return m[1];
  return t;
}

function joinSetCookie(parts) {
  return parts.map((c) => c.split(';')[0]?.trim()).filter(Boolean).join('; ');
}
function setCookieFallback(headers) {
  const raw = headers.get('set-cookie');
  if (!raw) return [];
  return raw.split(/,(?=\s*[^;=]+=)/).map((s) => s.trim());
}
function mergeCookies(a, b) {
  const map = new Map();
  for (const part of `${a}; ${b}`.split(';')) {
    const kv = part.trim();
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    map.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function cookieNames(c) {
  return [...new Set(c.split(';').map((p) => p.trim().split('=')[0]).filter(Boolean))];
}
function hasLoginHints(c) {
  const names = new Set(cookieNames(c).map((n) => n.toLowerCase()));
  return ['sessionid', 'sid_tt', 'uid_tt', 'sid_guard', 'passport_csrf_token'].some((n) => names.has(n));
}

async function step(title, fn) {
  console.log(`\n=== ${title} ===`);
  try {
    return await fn();
  } catch (e) {
    console.log('FAIL', e instanceof Error ? e.message : e);
    return null;
  }
}

async function fetchHomeCookie() {
  const home = await fetch('https://live.douyin.com/', {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  const raw = home.headers.getSetCookie?.() ?? setCookieFallback(home.headers);
  const cookie = joinSetCookie(raw);
  console.log('HTTP', home.status);
  console.log('Set-Cookie names:', cookieNames(cookie).join(', ') || '(none)');
  console.log('has ttwid:', /\bttwid=/.test(cookie));
  console.log('looks logged-in:', hasLoginHints(cookie));
  console.log('cookie preview:', cookie.slice(0, 180) || '(empty)');
  return cookie;
}

async function enterRoom(webRid, cookie, label) {
  const enterUrl = new URL('https://live.douyin.com/webcast/room/web/enter/');
  const params = {
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    enter_from: 'web_live',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '134.0.0.0',
    web_rid: webRid,
  };
  for (const [k, v] of Object.entries(params)) enterUrl.searchParams.set(k, v);

  const enter = await fetch(enterUrl, {
    headers: {
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
      Referer: `https://live.douyin.com/${webRid}`,
    },
  });
  const more = joinSetCookie(enter.headers.getSetCookie?.() ?? setCookieFallback(enter.headers));
  const merged = mergeCookies(cookie || '', more);
  const body = await enter.json();
  const room = body.data?.data?.[0] ?? body.data?.room;
  const roomId = room ? String(room.id_str ?? room.id ?? '') : '';
  console.log(`[${label}] HTTP`, enter.status, 'status_code', body.status_code);
  if (body.data?.prompts) console.log(`[${label}] prompts:`, body.data.prompts);
  console.log(`[${label}] roomId:`, roomId || '(empty)', 'title:', room?.title ?? '-', 'status:', room?.status ?? '-');
  if (!roomId) console.log(`[${label}] body:`, JSON.stringify(body).slice(0, 400));
  return { body, room, roomId, cookie: merged, ok: Boolean(roomId) && (!body.status_code || body.status_code === 0) };
}

async function scrapeRoomPage(webRid, cookie) {
  const res = await fetch(`https://live.douyin.com/${webRid}`, {
    headers: {
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
      Referer: 'https://live.douyin.com/',
    },
    redirect: 'follow',
  });
  const html = await res.text();
  const more = joinSetCookie(res.headers.getSetCookie?.() ?? setCookieFallback(res.headers));
  const merged = mergeCookies(cookie || '', more);
  console.log('page HTTP', res.status, 'html length', html.length);
  const patterns = [
    /\\"roomId\\":\\"(\d+)\\"/,
    /"roomId":"(\d+)"/,
    /\\"room_id\\":\\"(\d+)\\"/,
    /"room_id_str":"(\d+)"/,
    /\\"id_str\\":\\"(\d+)\\"/,
    /roomId\\u0022:\\u0022(\d+)/,
  ];
  const found = new Set();
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) found.add(m[1]);
  }
  // RENDER_DATA / __INIT_PROPS__ blobs
  const render = /<script id="RENDER_DATA"[^>]*>([^<]+)<\/script>/.exec(html);
  if (render) {
    try {
      const decoded = decodeURIComponent(render[1]);
      const ids = [...decoded.matchAll(/"id_str":"(\d{8,})"/g)].map((x) => x[1]);
      ids.forEach((id) => found.add(id));
      console.log('RENDER_DATA id_str samples:', ids.slice(0, 5));
    } catch (e) {
      console.log('RENDER_DATA decode fail', e.message);
    }
  }
  console.log('scraped room ids:', [...found].slice(0, 8));
  const blocked = /验证|captcha|登录后查看|暂时无法无法查看|forbid/i.test(html);
  console.log('page looks blocked/login-walled:', blocked);
  return { cookie: merged, ids: [...found], htmlLen: html.length, blocked };
}

async function tryLiveList(cookie) {
  // Public-ish partition feed; may be empty / geo limited.
  const url = new URL('https://live.douyin.com/webcast/web/partition/detail/room/2024/');
  url.searchParams.set('aid', '6383');
  url.searchParams.set('app_name', 'douyin_web');
  url.searchParams.set('live_id', '1');
  url.searchParams.set('device_platform', 'web');
  url.searchParams.set('count', '10');
  url.searchParams.set('offset', '0');
  url.searchParams.set('partition', '720');
  url.searchParams.set('partition_type', '1');
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
      Referer: 'https://live.douyin.com/',
    },
  });
  const body = await res.json().catch(() => ({}));
  console.log('list HTTP', res.status, 'status_code', body.status_code);
  const data = body.data?.data ?? body.data ?? [];
  const rooms = Array.isArray(data) ? data : [];
  const samples = rooms.slice(0, 5).map((r) => ({
    web_rid: r.web_rid ?? r.webRid ?? r.owner?.web_rid,
    room_id: r.room_id ?? r.id_str ?? r.id,
    title: r.title,
    status: r.status,
  }));
  console.log('list samples:', JSON.stringify(samples, null, 2));
  return samples;
}

async function wsConnect(roomId, cookie, label) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const mod = await import(pathToFileURL(join(root, 'vendor', 'douyin-danma', 'index.js')).href);
  const Ctor = mod.default;
  const c = new Ctor(roomId, { autoReconnect: 0, cookie: cookie || undefined });
  const events = [];
  const push = (k, v) => {
    events.push({ k, v });
    console.log(`[${label}]`, k, v ?? '');
  };
  c.on('init', (url) => push('init', String(url).slice(0, 160)));
  c.on('open', () => push('open'));
  c.on('close', () => push('close'));
  c.on('error', (e) => push('error', e?.message || String(e)));
  c.on('chat', (m) => push('chat', m?.content));
  c.on('member', (m) => push('member', m?.user?.nickName || m?.user?.nickname));
  await c.connect();
  await new Promise((r) => setTimeout(r, 8000));
  try { c.close(); } catch {}
  const opened = events.some((e) => e.k === 'open');
  const chats = events.filter((e) => e.k === 'chat' || e.k === 'member').length;
  console.log(`[${label}] result: open=${opened} interactive=${chats}`);
  return { opened, chats, events };
}

// ── main ──
console.log('Douyin auth diagnostic');
console.log('input:', input || '(none — will try discover live room)');
console.log('DOUYIN_COOKIE set:', Boolean(envCookie), envCookie ? `names=${cookieNames(envCookie).join(',')}` : '');

const anonCookie = await step('1) anonymous home cookie (ttwid)', fetchHomeCookie);
const cookieA = envCookie || anonCookie || '';

let webRid = parseWebRid(input);

if (!webRid) {
  const list = await step('2) discover live rooms (partition list)', () => tryLiveList(cookieA));
  webRid = list?.find((x) => x.web_rid)?.web_rid || list?.find((x) => x.room_id)?.room_id || null;
  if (webRid) console.log('picked web_rid/room:', webRid);
}

if (!webRid) {
  console.log('\n没有可用房间号。请传入正在直播的 web_rid，例如:');
  console.log('  node scripts/diag-auth.mjs 123456789');
  console.log('  DOUYIN_COOKIE="ttwid=...; sessionid=..." node scripts/diag-auth.mjs 123456789');
  process.exit(2);
}

await step('3) enter API without cookie', () => enterRoom(webRid, '', 'no-cookie'));
const enterAnon = await step('4) enter API with anonymous ttwid', () => enterRoom(webRid, anonCookie || '', 'anon'));
let enterUser = null;
if (envCookie) {
  enterUser = await step('5) enter API with DOUYIN_COOKIE', () => enterRoom(webRid, envCookie, 'user-cookie'));
}

const page = await step('6) scrape live page HTML for roomId', () => scrapeRoomPage(webRid, cookieA));

const roomId =
  enterUser?.roomId ||
  enterAnon?.roomId ||
  page?.ids?.[0] ||
  null;

const cookieForWs = enterUser?.cookie || enterAnon?.cookie || page?.cookie || cookieA;

if (!roomId) {
  console.log('\n--- 结论 ---');
  console.log('未能拿到内部 roomId。常见原因:');
  console.log('  1) 房间未开播 / 号错误 → enter status_code=4001038');
  console.log('  2) 风控要登录或验证码 → 页面 blocked / prompts 提示无法查看');
  console.log('  3) 纯匿名 ttwid 不够 → 用浏览器登录后导出 Cookie 再测:');
  console.log('     DOUYIN_COOKIE="..." node scripts/diag-auth.mjs <web_rid>');
  process.exit(1);
}

console.log('\nusing roomId', roomId);

await step('7) WSS connect WITH cookie', () => wsConnect(roomId, cookieForWs, 'with-cookie'));
await step('8) WSS connect WITHOUT cookie (lib will fetch its own)', () => wsConnect(roomId, '', 'lib-cookie'));

console.log('\n--- 结论提示 ---');
console.log('若 4 失败而 5 成功 → 需要登录 Cookie（凭证问题）');
console.log('若 4/5 都能解析但 7 失败 → 签名/WS 问题，不是登录');
console.log('若 7 open 成功 → 插件侧多半是加载路径/旧代码，不是凭证');
process.exit(0);
