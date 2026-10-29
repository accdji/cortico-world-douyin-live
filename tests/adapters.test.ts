import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adaptBridgePayload, adaptDycast, adaptGrabber } from '../src/adapters/index.ts';

const fixtures = join(import.meta.dirname, 'fixtures');

function loadJsonl(name: string): unknown[] {
  return readFileSync(join(fixtures, name), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('Dycast adapter', () => {
  it('parses live info and chat/gift batches', () => {
    const rows = loadJsonl('dycast-sample.jsonl');
    const info = adaptDycast(rows[0]);
    expect(info[0]?.method).toBe('DyLiveInfo');
    expect(info[0]?.room?.title).toBe('今晚一起聊天');

    const chat = adaptDycast(rows[1]);
    expect(chat[0]?.method).toBe('WebcastChatMessage');
    expect(chat[0]?.content).toBe('你好啊');
    expect(chat[0]?.user?.id).toBe('u1');

    const gift = adaptDycast(rows[3]);
    expect(gift[0]?.method).toBe('WebcastGiftMessage');
    expect(gift[0]?.gift?.name).toBe('玫瑰');
  });

  it('auto-detects dycast arrays', () => {
    const rows = loadJsonl('dycast-sample.jsonl');
    const { adapter, messages } = adaptBridgePayload(rows[1], 'auto');
    expect(adapter).toBe('dycast');
    expect(messages).toHaveLength(1);
  });
});

describe('Grabber adapter', () => {
  it('parses Type/Data and flat gift frames', () => {
    const rows = loadJsonl('grabber-sample.jsonl');
    const chat = adaptGrabber(rows[0]);
    expect(chat[0]?.method).toBe('WebcastChatMessage');
    expect(chat[0]?.content).toBe('来了来了');
    expect(chat[0]?.user?.id).toBe('9001');

    const big = adaptGrabber(rows[2]);
    expect(big[0]?.method).toBe('WebcastGiftMessage');
    expect(big[0]?.gift?.name).toBe('嘉年华');
    expect(big[0]?.gift?.price).toBe(1000);
  });
});
