import { join } from 'node:path';
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { DOUYIN_LIVE_DEFAULTS, type DouyinLiveConfigSection } from './config.ts';
import { DouyinLiveWorld, douyinLiveToolDecls } from './world.ts';

export const DOUYIN_LIVE: WorldDefinition<DouyinLiveConfigSection> = {
  id: 'douyin-live',
  label: '抖音直播间',
  defaults: () => structuredClone(DOUYIN_LIVE_DEFAULTS),
  create: (ctx) => new DouyinLiveWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
    persist: (patch) => ctx.persist(patch),
  }),
  describe: {
    tools: describeTools(douyinLiveToolDecls(
      DOUYIN_LIVE_DEFAULTS.overlay.agentNoticeMaxChars,
      DOUYIN_LIVE_DEFAULTS.overlay.maxQueuedVideos,
    ), {
      douyin_live_update_video_queue: {
        zh: '改写直播画面上的视频排队列表:加入、移除、调整顺序或清空。',
        en: 'Edits the video queue list on the stream overlay: add, remove, reorder or clear.',
      },
    }),
    events: [
      {
        type: 'douyin-live.danmaku',
        description: { zh: '观众发的弹幕;短时间内的相同弹幕合成一条。', en: 'A viewer chat message; identical messages within a short window are merged.' },
        trigger: 'debounce',
      },
      {
        type: 'douyin-live.gift',
        description: {
          zh: '观众送了付费礼物;金额达到配置的门槛时立即投递,否则合批。',
          en: 'A viewer sent a paid gift; delivered at once when the amount reaches the configured threshold, otherwise batched.',
        },
      },
      {
        type: 'douyin-live.fansclub',
        description: { zh: '粉丝团相关互动。', en: 'A fans-club related interaction.' },
        trigger: 'flush',
      },
      {
        type: 'douyin-live.superchat',
        description: { zh: '付费留言(若桥提供等价物)。', en: 'A paid highlight message when the bridge provides one.' },
        trigger: 'flush',
      },
      {
        type: 'douyin-live.room',
        description: { zh: '开播、下播、标题变更或 World 挂载状态。', en: 'Live/offline, title change, or World mount status.' },
      },
      {
        type: 'douyin-live.feed',
        description: { zh: '弹幕桥中断了一段时间,或中断后恢复。', en: 'The chat bridge has been down for a while, or came back after an outage.' },
      },
      {
        type: 'douyin-live.warning',
        description: { zh: '平台警告类消息(若桥提供)。', en: 'A platform warning when the bridge provides one.' },
        trigger: 'flush',
      },
      {
        type: 'douyin-live.audience',
        description: {
          zh: '进场、点赞、关注、免费礼物的计数与在线人数等读数的汇总,随下一批事件送达。',
          en: 'Counts of entries, likes, follows and free gifts plus audience gauges, sent with the next batch.',
        },
        trigger: 'piggyback',
        tags: ['snapshot'],
      },
    ],
  },
};

// dataDir path helper kept for callers that mirror bilibili layout
export function audienceLedgerPath(dataDir: string): string {
  return join(dataDir, 'douyin-live-audience', 'ledger.json');
}
