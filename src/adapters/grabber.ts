import type { BridgeMessage } from '../types.ts';

/**
 * DouyinBarrageGrab-style payloads.
 * Common shapes: { Type, Data } where Data is a JSON string or object,
 * or flat objects with MsgType / type fields.
 */
const TYPE_TO_METHOD: Record<number | string, string> = {
  1: 'WebcastChatMessage',
  2: 'WebcastLikeMessage',
  3: 'WebcastMemberMessage',
  4: 'WebcastSocialMessage',
  5: 'WebcastGiftMessage',
  6: 'WebcastRoomUserSeqMessage',
  7: 'WebcastFansclubMessage',
  8: 'WebcastSocialMessage',
  9: 'WebcastControlMessage',
  chat: 'WebcastChatMessage',
  danmu: 'WebcastChatMessage',
  danmaku: 'WebcastChatMessage',
  like: 'WebcastLikeMessage',
  member: 'WebcastMemberMessage',
  enter: 'WebcastMemberMessage',
  follow: 'WebcastSocialMessage',
  gift: 'WebcastGiftMessage',
  stats: 'WebcastRoomUserSeqMessage',
  fansclub: 'WebcastFansclubMessage',
  control: 'WebcastControlMessage',
};

export function looksLikeGrabber(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload.Type != null || payload.type != null || payload.MsgType != null) return true;
  if (typeof payload.Data === 'string' || isRecord(payload.Data)) return true;
  // Owner/WebRoomid style from BarrageGrab
  if (payload.Owner != null || payload.WebRoomid != null || payload.RoomId != null) {
    return payload.Content != null || payload.User != null || payload.Gift != null;
  }
  return false;
}

export function adaptGrabber(payload: unknown): BridgeMessage[] {
  if (!isRecord(payload)) return [];

  let data: Record<string, unknown> = payload;
  if (typeof payload.Data === 'string') {
    try {
      const parsed = JSON.parse(payload.Data);
      if (isRecord(parsed)) data = { ...payload, ...parsed };
    } catch {
      data = payload;
    }
  } else if (isRecord(payload.Data)) {
    data = { ...payload, ...payload.Data };
  }

  const typeKey = data.Type ?? data.type ?? data.MsgType ?? data.msg_type;
  const method = TYPE_TO_METHOD[typeKey as string | number]
    ?? (typeof typeKey === 'string' && typeKey.startsWith('Webcast') ? typeKey : 'Unknown');

  const userObj = isRecord(data.User) ? data.User
    : isRecord(data.user) ? data.user
    : undefined;
  const giftObj = isRecord(data.Gift) ? data.Gift
    : isRecord(data.gift) ? data.gift
    : undefined;

  const user = userObj ? {
    id: str(userObj.Id ?? userObj.id ?? userObj.Uid ?? userObj.uid ?? userObj.ShortId),
    name: str(userObj.Nickname ?? userObj.nickname ?? userObj.Name ?? userObj.name),
    avatar: str(userObj.HeadImgUrl ?? userObj.avatar ?? userObj.Avatar),
  } : {
    id: str(data.UserId ?? data.uid),
    name: str(data.Nickname ?? data.UserName ?? data.uname),
  };

  const gift = giftObj || data.GiftName || data.giftName ? {
    id: str(giftObj?.Id ?? giftObj?.id ?? data.GiftId),
    name: str(giftObj?.Name ?? giftObj?.name ?? data.GiftName ?? data.giftName),
    price: num(giftObj?.DiamondCount ?? giftObj?.price ?? data.DiamondCount ?? data.Price ?? data.price),
    count: num(giftObj?.Count ?? giftObj?.count ?? data.GiftCount ?? data.RepeatCount) ?? 1,
  } : undefined;

  const room = {
    audienceCount: asCount(data.AudienceCount ?? data.OnlineUserCount ?? data.MemberCount),
    likeCount: asCount(data.LikeCount ?? data.TotalLikeCount),
    totalUserCount: asCount(data.TotalUserCount ?? data.Total),
    status: num(data.Status ?? data.status),
    title: str(data.Title ?? data.title),
  };

  return [{
    method,
    id: str(data.MsgId ?? data.msg_id ?? data.Id),
    content: str(data.Content ?? data.content ?? data.Text ?? data.text),
    user: user.id || user.name ? user : undefined,
    gift,
    room: hasRoomFields(room) ? room : undefined,
    raw: payload,
  }];
}

function asCount(v: unknown): number | string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return undefined;
}

function hasRoomFields(room: {
  audienceCount?: number | string;
  likeCount?: number | string;
  totalUserCount?: number | string;
  status?: number;
  title?: string;
}): boolean {
  return room.audienceCount != null
    || room.likeCount != null
    || room.totalUserCount != null
    || room.status != null
    || room.title != null;
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
