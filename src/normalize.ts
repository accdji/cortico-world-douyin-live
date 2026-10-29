import type { BridgeMessage, Normalized } from './types.ts';

export interface NormalizeOptions {
  giftFlushYuan: number;
  warn?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Douyin diamond roughly maps to yuan at ~10 diamonds ≈ 1 yuan for many gifts.
 * When price looks like diamonds (>= 10 and not fractional yuan-like), convert.
 */
export function giftYuan(price: number | undefined): number | null {
  if (price == null || !Number.isFinite(price) || price < 0) return null;
  if (price === 0) return 0;
  // Heuristic: integer >= 10 treated as diamonds
  if (Number.isInteger(price) && price >= 10) return price / 10;
  return price;
}

export function normalizeBridgeMessage(msg: BridgeMessage, opts: NormalizeOptions): Normalized | null {
  const method = msg.method;
  const uname = msg.user?.name || '某位观众';
  const uid = msg.user?.id;
  const senderKey = uid ? `douyin:${uid}` : undefined;

  switch (method) {
    case 'WebcastChatMessage':
    case 'WebcastEmojiChatMessage': {
      const body = (msg.content ?? '').trim();
      if (!body) return null;
      const key = senderKey ? `${senderKey}|${body}` : `anon|${body}`;
      return {
        kind: 'event',
        type: 'douyin-live.danmaku',
        trigger: 'debounce',
        text: `[弹幕|${uname}] ${body}`,
        senderKey,
        meta: { uid, uname, body },
        coalesce: { kind: 'danmaku', key, body },
      };
    }

    case 'WebcastGiftMessage': {
      const giftName = msg.gift?.name || '礼物';
      const num = Math.max(1, msg.gift?.count ?? 1);
      const yuan = giftYuan(msg.gift?.price);
      const isFree = yuan === 0;
      if (isFree) {
        return { kind: 'count', field: 'freeGift', by: num };
      }
      const flush = yuan != null && yuan >= opts.giftFlushYuan;
      const amountText = yuan == null ? '' : ` ¥${formatYuan(yuan)}`;
      const key = senderKey
        ? `${senderKey}|${giftName}|${yuan ?? 'x'}`
        : `anon|${giftName}|${Date.now()}`;
      return {
        kind: 'event',
        type: 'douyin-live.gift',
        trigger: flush ? 'flush' : 'debounce',
        text: `[礼物${amountText}|${uname}] ${giftName}×${num}`,
        senderKey,
        meta: { uid, uname, gift: giftName, num, yuan },
        coalesce: flush ? undefined : { kind: 'gift', key, gift: giftName, num, yuan },
      };
    }

    case 'WebcastMemberMessage':
      return { kind: 'count', field: 'enter', by: 1 };

    case 'WebcastLikeMessage': {
      const likeTotal = toNum(msg.room?.likeCount);
      const out: Normalized[] = [{ kind: 'count', field: 'like', by: 1 }];
      // Caller only accepts one — return count; gauge handled if room present via room stats methods
      if (likeTotal != null) {
        // Prefer gauge when room carries total
        return { kind: 'gauge', field: 'likeTotal', value: likeTotal };
      }
      return out[0];
    }

    case 'WebcastSocialMessage':
      return { kind: 'count', field: 'follow', by: 1 };

    case 'WebcastFansclubMessage': {
      const body = (msg.content ?? '粉丝团互动').trim();
      return {
        kind: 'event',
        type: 'douyin-live.fansclub',
        trigger: 'flush',
        text: `[粉丝团|${uname}] ${body}`,
        senderKey,
        meta: { uid, uname, body },
      };
    }

    case 'WebcastRoomUserSeqMessage':
    case 'WebcastRoomStatsMessage':
    case 'WebcastRoomRankMessage': {
      const online = toNum(msg.room?.audienceCount);
      const total = toNum(msg.room?.totalUserCount);
      const likeTotal = toNum(msg.room?.likeCount);
      // Return online gauge preferentially; world will also see other gauges if we emit one at a time
      if (online != null) return { kind: 'gauge', field: 'online', value: online };
      if (total != null) return { kind: 'gauge', field: 'totalUser', value: total };
      if (likeTotal != null) return { kind: 'gauge', field: 'likeTotal', value: likeTotal };
      return null;
    }

    case 'WebcastControlMessage':
    case 'DyLiveInfo': {
      const title = msg.room?.title || msg.content;
      const status = msg.room?.status;
      const parts: string[] = [];
      // Douyin: status 2 = 直播中, 4 = 已结束（勿与 B 站状态码混用）
      if (status === 2) parts.push('开播中');
      else if (status === 4) parts.push('未开播或已结束');
      else if (status != null) parts.push(`房间状态 ${status}`);
      if (title) parts.push(`标题：${title}`);
      if (!parts.length && method === 'DyLiveInfo') {
        parts.push(title ? `已连接直播间：${title}` : '已连接直播间');
      }
      if (!parts.length) return null;
      return {
        kind: 'event',
        type: 'douyin-live.room',
        trigger: 'flush',
        text: `[直播间] ${parts.join(' · ')}`,
        meta: {
          title: title ?? null,
          status: status ?? null,
          roomId: msg.id ?? null,
        },
      };
    }

    default:
      opts.warn?.('未识别的桥消息类型', { method });
      return null;
  }
}

/** Expand room stats into multiple gauge updates. */
export function expandGauges(msg: BridgeMessage): Normalized[] {
  const out: Normalized[] = [];
  const online = toNum(msg.room?.audienceCount);
  const total = toNum(msg.room?.totalUserCount);
  const likeTotal = toNum(msg.room?.likeCount);
  if (online != null) out.push({ kind: 'gauge', field: 'online', value: online });
  if (total != null) out.push({ kind: 'gauge', field: 'totalUser', value: total });
  if (likeTotal != null) out.push({ kind: 'gauge', field: 'likeTotal', value: likeTotal });
  return out;
}

export function shouldExpandRoomStats(method: string): boolean {
  return method === 'WebcastRoomUserSeqMessage'
    || method === 'WebcastRoomStatsMessage'
    || method === 'WebcastRoomRankMessage';
}

function toNum(v: number | string | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function formatYuan(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
