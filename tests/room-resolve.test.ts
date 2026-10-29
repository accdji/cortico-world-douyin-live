import { describe, expect, it } from 'vitest';
import { parseWebRoomInput } from '../src/room-resolve.ts';

describe('parseWebRoomInput', () => {
  it('accepts bare id and live URL', () => {
    expect(parseWebRoomInput('123456789')).toBe('123456789');
    expect(parseWebRoomInput('https://live.douyin.com/123456789')).toBe('123456789');
    expect(parseWebRoomInput('https://live.douyin.com/123456789?foo=1')).toBe('123456789');
  });

  it('rejects empty', () => {
    expect(parseWebRoomInput('')).toBeNull();
    expect(parseWebRoomInput('   ')).toBeNull();
  });
});
