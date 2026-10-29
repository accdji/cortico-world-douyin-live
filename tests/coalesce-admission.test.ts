import { describe, expect, it, vi } from 'vitest';
import { AudienceAdmission } from '../src/audience-admission.ts';
import { CoalescingBuffer } from '../src/coalescing-buffer.ts';

describe('CoalescingBuffer', () => {
  it('merges same key within the window', async () => {
    const emitted: unknown[] = [];
    const buf = new CoalescingBuffer<string>((groups) => {
      emitted.push(...groups.map((g) => ({ key: g.key, n: g.items.length })));
    });
    buf.add('a|hi', '1', { windowMs: 50, maxItems: 64 });
    buf.add('a|hi', '2', { windowMs: 50, maxItems: 64 });
    buf.add('b|yo', '3', { windowMs: 50, maxItems: 64 });
    await new Promise((r) => setTimeout(r, 80));
    expect(emitted).toEqual([
      { key: 'a|hi', n: 2 },
      { key: 'b|yo', n: 1 },
    ]);
  });
});

describe('AudienceAdmission', () => {
  it('keeps critical events when crowded and over budget', () => {
    const adm = new AudienceAdmission(undefined, () => ({
      onlineRankOn: 10,
      onlineRankOff: 5,
      releaseHoldSec: 1,
      signalFreshSec: 90,
      activeStaleHoldSec: 300,
      eventLineBudget: 2,
      eventTokenBudget: 20,
      importantShare: 0.5,
    }));
    adm.setOnline(100);
    const result = adm.filter([
      { id: '1', text: 'critical-one', critical: true, participants: [] },
      { id: '2', text: 'ordinary-aaaaaaaaaaaaaaaaaaaaaaaa', critical: false, participants: [{ senderKey: 'douyin:x', count: 1 }] },
      { id: '3', text: 'ordinary-bbbbbbbbbbbbbbbbbbbbbbbb', critical: false, participants: [{ senderKey: 'douyin:y', count: 1 }] },
      { id: '4', text: 'ordinary-cccccccccccccccccccccccc', critical: false, participants: [{ senderKey: 'douyin:z', count: 1 }] },
    ]);
    expect(result.crowded).toBe(true);
    expect(result.accepted.some((c) => c.id === '1')).toBe(true);
    expect(result.accepted.length).toBeLessThanOrEqual(2);
    expect(result.dropped).toBeGreaterThan(0);
  });

  it('marks fansclub senders important', () => {
    const adm = new AudienceAdmission(undefined, () => ({
      onlineRankOn: 1,
      onlineRankOff: 0,
      releaseHoldSec: 1,
      signalFreshSec: 90,
      activeStaleHoldSec: 300,
      eventLineBudget: 1,
      eventTokenBudget: 100,
      importantShare: 1,
    }));
    adm.setOnline(50);
    adm.noteFansclub('douyin:vip');
    const result = adm.filter([
      {
        id: 'imp',
        text: 'vip hi',
        critical: false,
        participants: [{ senderKey: 'douyin:vip', count: 1 }],
      },
      {
        id: 'ord',
        text: 'ord hi',
        critical: false,
        participants: [{ senderKey: 'douyin:nope', count: 1 }],
      },
    ]);
    expect(result.accepted.map((c) => c.id)).toEqual(['imp']);
  });
});

void vi;
