import type { BridgeMessage } from '../types.ts';

/** Detect Dycast Desktop forward payloads (live info object or DyMessage[]). */
export function looksLikeDycast(payload: unknown): boolean {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return true;
    const first = payload[0];
    return isRecord(first) && typeof first.method === 'string' && String(first.method).startsWith('Webcast');
  }
  if (!isRecord(payload)) return false;
  if (typeof payload.roomId === 'string' || typeof payload.roomNum === 'string') return true;
  return typeof payload.method === 'string' && String(payload.method).startsWith('Webcast');
}

export function adaptDycast(payload: unknown): BridgeMessage[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => adaptOne(item));
  }
  if (!isRecord(payload)) return [];
  // Live info object (sent once)
  if (payload.roomId != null || payload.roomNum != null) {
    return [{
      method: 'DyLiveInfo',
      id: str(payload.roomId) || str(payload.roomNum),
      content: str(payload.title),
      user: {
        id: str(payload.uniqueId),
        name: str(payload.nickname),
        avatar: str(payload.avatar),
      },
      room: {
        status: num(payload.status),
        title: str(payload.title),
      },
      raw: payload,
    }];
  }
  return adaptOne(payload);
}

function adaptOne(item: unknown): BridgeMessage[] {
  if (!isRecord(item)) return [];
  const method = str(item.method) || 'Unknown';
  const user = isRecord(item.user) ? {
    id: str(item.user.id),
    name: str(item.user.name),
    avatar: str(item.user.avatar),
  } : undefined;
  const giftRaw = isRecord(item.gift) ? item.gift : undefined;
  const gift = giftRaw ? {
    id: str(giftRaw.id),
    name: str(giftRaw.name) || str(giftRaw.desc),
    price: num(giftRaw.price),
    count: num(giftRaw.count) ?? 1,
  } : undefined;
  const roomRaw = isRecord(item.room) ? item.room : undefined;
  const room = roomRaw ? {
    audienceCount: roomRaw.audienceCount as number | string | undefined,
    likeCount: roomRaw.likeCount as number | string | undefined,
    followCount: roomRaw.followCount as number | string | undefined,
    totalUserCount: roomRaw.totalUserCount as number | string | undefined,
    status: num(roomRaw.status),
  } : undefined;

  return [{
    method,
    id: str(item.id),
    content: str(item.content),
    user,
    gift,
    room,
    raw: item,
  }];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s || undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
