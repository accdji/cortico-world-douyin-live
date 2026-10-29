import { describe, expect, it } from 'vitest';
import { giftYuan, normalizeBridgeMessage } from '../src/normalize.ts';
import type { BridgeMessage } from '../src/types.ts';

describe('giftYuan', () => {
  it('treats integer diamonds as /10 yuan', () => {
    expect(giftYuan(10)).toBe(1);
    expect(giftYuan(1000)).toBe(100);
    expect(giftYuan(0)).toBe(0);
  });
});

describe('normalizeBridgeMessage', () => {
  it('maps chat to danmaku with coalesce key', () => {
    const msg: BridgeMessage = {
      method: 'WebcastChatMessage',
      content: '哈喽',
      user: { id: '1', name: '甲' },
    };
    const n = normalizeBridgeMessage(msg, { giftFlushYuan: 1 });
    expect(n?.kind).toBe('event');
    if (n?.kind === 'event') {
      expect(n.type).toBe('douyin-live.danmaku');
      expect(n.coalesce?.kind).toBe('danmaku');
      expect(n.senderKey).toBe('douyin:1');
    }
  });

  it('flushes expensive gifts and counts free gifts', () => {
    const paid = normalizeBridgeMessage({
      method: 'WebcastGiftMessage',
      user: { id: '2', name: '乙' },
      gift: { name: '嘉年华', price: 1000, count: 1 },
    }, { giftFlushYuan: 1 });
    expect(paid?.kind).toBe('event');
    if (paid?.kind === 'event') {
      expect(paid.trigger).toBe('flush');
      expect(paid.type).toBe('douyin-live.gift');
    }

    const free = normalizeBridgeMessage({
      method: 'WebcastGiftMessage',
      user: { id: '3', name: '丙' },
      gift: { name: '小心心', price: 0, count: 1 },
    }, { giftFlushYuan: 1 });
    expect(free).toEqual({ kind: 'count', field: 'freeGift', by: 1 });
  });

  it('maps member/follow to counts and control to room', () => {
    expect(normalizeBridgeMessage({ method: 'WebcastMemberMessage' }, { giftFlushYuan: 1 }))
      .toEqual({ kind: 'count', field: 'enter', by: 1 });
    expect(normalizeBridgeMessage({ method: 'WebcastSocialMessage' }, { giftFlushYuan: 1 }))
      .toEqual({ kind: 'count', field: 'follow', by: 1 });
    const room = normalizeBridgeMessage({
      method: 'WebcastControlMessage',
      room: { status: 4, title: '再见' },
    }, { giftFlushYuan: 1 });
    expect(room?.kind).toBe('event');
    if (room?.kind === 'event') expect(room.type).toBe('douyin-live.room');
  });
});
