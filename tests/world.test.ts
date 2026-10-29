import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { DOUYIN_LIVE } from '../src/definition.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'douyin-live-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

describe('Douyin Live World', () => {
  it('干装载不报失败', async () => {
    const report = await dryMountWorld(DOUYIN_LIVE, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('挂载时投一条 room 事件', async () => {
    const world = DOUYIN_LIVE.create(fakeWorldContext(DOUYIN_LIVE, { scratchDir }));
    const host = new FakeHost();
    await world.start(host);
    expect(host.events.some((e) => e.type === 'douyin-live.room')).toBe(true);
    await world.stop();
  });

  it('公告与视频排队工具只改本机状态', async () => {
    const ctx = fakeWorldContext(DOUYIN_LIVE, { scratchDir });
    const world = DOUYIN_LIVE.create(ctx);
    const host = new FakeHost();
    await world.start(host);

    const tools = world.tools();
    const announce = tools.find((t) => t.name === 'douyin_live_set_announcement')!;
    const queue = tools.find((t) => t.name === 'douyin_live_update_video_queue')!;
    const call = {} as ToolCallContext;

    expect(await announce.handler({ text: '今晚主题：点歌' }, call)).toContain('已更新');
    const vars1 = await world.envPromptVars();
    expect(vars1?.['douyin-live.agentAnnouncement']).toBe('今晚主题：点歌');

    expect(await queue.handler({ action: 'add', id: 'https://www.douyin.com/video/7123456789', note: '点这个' }, call))
      .toContain('已加入');
    const vars2 = await world.envPromptVars();
    expect(vars2?.['douyin-live.videoQueue']).toContain('7123456789');

    await world.stop();
  });
});
