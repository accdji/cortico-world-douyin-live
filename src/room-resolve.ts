/**
 * Resolve a public live.douyin.com web room id (短号) to the internal id_str
 * required by the webcast WebSocket client.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export interface ResolvedRoom {
  /** Internal webcast room id (id_str). */
  roomId: string;
  webRoomId: string;
  title: string | null;
  nickname: string | null;
  status: number | null;
  cookie: string;
}

/** Accept bare digits, full live URL, or pasted id_str. */
export function parseWebRoomInput(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const fromUrl = /live\.douyin\.com\/([A-Za-z0-9_-]+)/i.exec(s);
  if (fromUrl) return fromUrl[1];
  if (/^\d{5,}$/.test(s)) return s;
  return s;
}

export async function resolveDouyinRoom(webRoomInput: string): Promise<ResolvedRoom> {
  const webRoomId = parseWebRoomInput(webRoomInput);
  if (!webRoomId) throw new Error('请填写抖音直播间号（live.douyin.com/ 后面那串）');

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

  if (!enter.ok) {
    throw new Error(`解析直播间失败 HTTP ${enter.status}`);
  }
  const body = await enter.json() as {
    data?: {
      data?: Array<{
        id_str?: string;
        id?: string | number;
        title?: string;
        status?: number;
        owner?: { nickname?: string };
      }>;
      room?: {
        id_str?: string;
        id?: string | number;
        title?: string;
        status?: number;
        owner?: { nickname?: string };
      };
    };
    status_code?: number;
  };

  if (body.status_code && body.status_code !== 0) {
    const prompts = (body.data as { prompts?: string } | undefined)?.prompts;
    throw new Error(
      `抖音 enter 接口 status_code=${body.status_code}${prompts ? `（${prompts}）` : ''}；请确认直播间号正确、房间正在直播且可公网访问`,
    );
  }

  const room = body.data?.data?.[0] ?? body.data?.room;
  const roomId = String(room?.id_str ?? room?.id ?? '');
  if (!roomId) {
    throw new Error(
      `未能解析内部房间 id（status_code=${body.status_code ?? 'n/a'}）；请确认直播间号正确且房间正在直播`,
    );
  }

  return {
    roomId,
    webRoomId,
    title: room?.title ?? null,
    nickname: room?.owner?.nickname ?? null,
    status: room?.status ?? null,
    cookie: mergedCookie,
  };
}

function setCookieFallback(headers: Headers): string[] {
  const raw = headers.get('set-cookie');
  if (!raw) return [];
  // Node may join multiple Set-Cookie with comma; keep simple first segments
  return raw.split(/,(?=\s*[^;=]+=)/).map((s) => s.trim());
}

function joinSetCookie(parts: string[]): string {
  return parts
    .map((c) => c.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

function mergeCookies(a: string, b: string): string {
  const map = new Map<string, string>();
  for (const part of `${a}; ${b}`.split(';')) {
    const kv = part.trim();
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    map.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
