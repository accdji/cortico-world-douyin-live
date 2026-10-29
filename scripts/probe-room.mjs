import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Inline minimal resolve (copy logic) to avoid ts import
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

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

async function resolveDouyinRoom(webRoomId) {
  const home = await fetch('https://live.douyin.com/', {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  const cookie = joinSetCookie(home.headers.getSetCookie?.() ?? setCookieFallback(home.headers));
  const enterUrl = new URL('https://live.douyin.com/webcast/room/web/enter/');
  enterUrl.searchParams.set('aid', '6383');
  enterUrl.searchParams.set('app_name', 'douyin_web');
  enterUrl.searchParams.set('live_id', '1');
  enterUrl.searchParams.set('device_platform', 'web');
  enterUrl.searchParams.set('language', 'zh-CN');
  enterUrl.searchParams.set('enter_from', 'web_live');
  enterUrl.searchParams.set('cookie_enabled', 'true');
  enterUrl.searchParams.set('screen_width', '1920');
  enterUrl.searchParams.set('screen_height', '1080');
  enterUrl.searchParams.set('browser_language', 'zh-CN');
  enterUrl.searchParams.set('browser_platform', 'Win32');
  enterUrl.searchParams.set('browser_name', 'Chrome');
  enterUrl.searchParams.set('browser_version', '134.0.0.0');
  enterUrl.searchParams.set('web_rid', webRoomId);

  const enter = await fetch(enterUrl, {
    headers: {
      'User-Agent': UA,
      Cookie: cookie,
      Referer: `https://live.douyin.com/${webRoomId}`,
    },
  });
  const moreCookie = joinSetCookie(enter.headers.getSetCookie?.() ?? setCookieFallback(enter.headers));
  const mergedCookie = mergeCookies(cookie, moreCookie);
  const body = await enter.json();
  console.log('enter status', enter.status, 'status_code', body.status_code);
  const room = body.data?.data?.[0] ?? body.data?.room;
  const roomId = String(room?.id_str ?? room?.id ?? '');
  if (!roomId) {
    console.log('body keys', JSON.stringify(body).slice(0, 500));
    throw new Error('no room id');
  }
  return { roomId, title: room?.title, cookie: mergedCookie, status: room?.status };
}

const web = process.argv[2];
if (!web) {
  console.error('Usage: node scripts/probe-room.mjs <web_rid>');
  process.exit(2);
}
console.log('probing', web);
const r = await resolveDouyinRoom(web);
console.log('resolved', r.roomId, r.title, 'cookie', r.cookie.slice(0, 160));

const mod = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'douyin-danma', 'index.js')).href);
const Ctor = mod.default;
const c = new Ctor(r.roomId, { autoReconnect: 0, cookie: r.cookie });
c.on('error', (e) => console.log('ERR event', e?.message || e));
c.on('open', () => console.log('OPEN'));
c.on('close', () => console.log('CLOSE'));
c.on('chat', (m) => console.log('CHAT', m?.content));
c.on('init', (url) => console.log('INIT url', String(url).slice(0, 200)));

console.log('connect...');
await c.connect();
console.log('connect returned, waiting 8s');
await new Promise((r) => setTimeout(r, 8000));
try { c.close(); } catch {}
console.log('done');
