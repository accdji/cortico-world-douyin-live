import type { ConfigGroup } from 'cortico/core/types.ts';

export interface OverlayConfigSection {
  enabled: boolean;
  port: number;
  agentNoticeMaxChars: number;
  maxQueuedVideos: number;
}

export interface DouyinLiveConfigSection {
  enabled: boolean;
  /**
   * room: 扩展内直连抖音直播弹幕（推荐，只需填房间号，对齐 B 站用法）;
   * bridge: 外置 Dycast / Grabber（进阶，需另装工具）.
   */
  ingestMode: 'room' | 'bridge';
  /** 抖音直播间号（live.douyin.com/ 后的数字），或完整直播间链接。ingestMode=room 时必填。 */
  roomId: string;
  /** Local bridge WebSocket URL, e.g. ws://127.0.0.1:8765 */
  bridgeUrl: string;
  /**
   * server: listen and accept forwarders (Dycast);
   * client: connect outbound (DouyinBarrageGrab).
   */
  bridgeMode: 'server' | 'client';
  /** auto | dycast | grabber */
  bridgeAdapter: 'auto' | 'dycast' | 'grabber';
  giftFlushYuan: number;
  coalesceWindowMs: number;
  coalesceMaxItems: number;
  audienceOnlineRankOn: number;
  audienceOnlineRankOff: number;
  audienceReleaseHoldSec: number;
  audienceSignalFreshSec: number;
  audienceActiveStaleHoldSec: number;
  audienceEventLineBudget: number;
  audienceEventTokenBudget: number;
  audienceImportantShare: number;
  overlay: OverlayConfigSection;
}

export const DOUYIN_LIVE_DEFAULTS: DouyinLiveConfigSection = {
  enabled: false,
  ingestMode: 'room',
  roomId: '',
  bridgeUrl: 'ws://127.0.0.1:8765',
  bridgeMode: 'server',
  bridgeAdapter: 'auto',
  giftFlushYuan: 1,
  coalesceWindowMs: 300,
  coalesceMaxItems: 64,
  audienceOnlineRankOn: 200,
  audienceOnlineRankOff: 170,
  audienceReleaseHoldSec: 120,
  audienceSignalFreshSec: 90,
  audienceActiveStaleHoldSec: 300,
  audienceEventLineBudget: 114,
  audienceEventTokenBudget: 1061,
  audienceImportantShare: 0.5,
  overlay: {
    enabled: true,
    port: 7796,
    agentNoticeMaxChars: 200,
    maxQueuedVideos: 20,
  },
};

export const DOUYIN_LIVE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:douyin-live',
  owner: 'world:douyin-live',
  schema: {
    type: 'object',
    title: '抖音直播间',
    description: '只读接入抖音直播间弹幕。默认填房间号即可，无需另装 Dycast/Grabber；直播伴侣只负责推流画面。',
    properties: {
      'worlds.douyin-live.ingestMode': {
        type: 'string',
        title: '接入方式',
        description: 'room=扩展内直连（推荐）；bridge=外置弹幕桥（进阶）。',
        enum: ['room', 'bridge'],
        'x-hot': false,
      },
      'worlds.douyin-live.roomId': {
        type: 'string',
        title: '直播间号',
        description: 'live.douyin.com/ 后面的数字，或整段直播间链接。接入方式为 room 时必填。',
        'x-hot': false,
      },
      'worlds.douyin-live.bridgeUrl': {
        type: 'string',
        title: '桥地址（进阶）',
        description: '仅 bridge 模式：server 为监听地址；client 为 Grabber 地址。',
        'x-hot': false,
      },
      'worlds.douyin-live.bridgeMode': {
        type: 'string',
        title: '桥模式（进阶）',
        description: '仅 bridge 模式：server / client。',
        enum: ['server', 'client'],
        'x-hot': false,
      },
      'worlds.douyin-live.bridgeAdapter': {
        type: 'string',
        title: '桥协议（进阶）',
        description: '仅 bridge 模式：auto / dycast / grabber。',
        enum: ['auto', 'dycast', 'grabber'],
        'x-hot': false,
      },
      'worlds.douyin-live.giftFlushYuan': {
        type: 'number',
        title: '礼物即时投递门槛',
        minimum: 0,
        maximum: 1000,
        'x-suffix': '元',
        'x-hot': true,
        description: '达到此金额的付费礼物立即 flush；低于此值先归并再合批。',
      },
      'worlds.douyin-live.coalesceWindowMs': {
        type: 'integer',
        title: '归并窗',
        minimum: 0,
        maximum: 2000,
        multipleOf: 50,
        'x-scale': 1000,
        'x-suffix': 's',
        'x-hot': true,
        description: '相同弹幕与常规礼物进入总线前的固定归并窗；0 关闭。',
      },
      'worlds.douyin-live.coalesceMaxItems': {
        type: 'integer',
        title: '归并容量',
        minimum: 1,
        maximum: 1000,
        'x-hot': true,
        description: '归并池硬上限，达到后立即冲刷。',
      },
      'worlds.douyin-live.audienceOnlineRankOn': {
        type: 'integer',
        title: '拥挤开启水位',
        minimum: 1,
        maximum: 100000,
        'x-hot': true,
        description: '在线读数达到此值进入拥挤态，开始筛选普通观众事件。',
      },
      'worlds.douyin-live.audienceOnlineRankOff': {
        type: 'integer',
        title: '拥挤退出水位',
        minimum: 0,
        maximum: 100000,
        'x-hot': true,
        description: '在线读数持续不高于此值后解除拥挤态。',
      },
      'worlds.douyin-live.audienceReleaseHoldSec': {
        type: 'integer',
        title: '拥挤解除保持',
        minimum: 1,
        maximum: 1800,
        'x-suffix': 's',
        'x-hot': true,
      },
      'worlds.douyin-live.audienceSignalFreshSec': {
        type: 'integer',
        title: '人数信号新鲜度',
        minimum: 1,
        maximum: 3600,
        'x-suffix': 's',
        'x-hot': true,
      },
      'worlds.douyin-live.audienceActiveStaleHoldSec': {
        type: 'integer',
        title: '拥挤最长陈旧保持',
        minimum: 1,
        maximum: 3600,
        'x-suffix': 's',
        'x-hot': true,
      },
      'worlds.douyin-live.audienceEventLineBudget': {
        type: 'integer',
        title: '批次行预算',
        minimum: 1,
        maximum: 5000,
        'x-hot': true,
      },
      'worlds.douyin-live.audienceEventTokenBudget': {
        type: 'integer',
        title: '批次 token 预算',
        minimum: 1,
        maximum: 100000,
        'x-hot': true,
      },
      'worlds.douyin-live.audienceImportantShare': {
        type: 'number',
        title: '重要观众份额',
        minimum: 0.01,
        maximum: 1,
        'x-scale': 100,
        'x-suffix': '%',
        'x-hot': true,
      },
      'worlds.douyin-live.overlay.enabled': {
        type: 'boolean',
        title: '启用 Overlay',
        'x-hot': false,
        description: '在本机启动 OBS 浏览器源页面。',
      },
      'worlds.douyin-live.overlay.port': {
        type: 'integer',
        title: 'Overlay 端口',
        minimum: 0,
        maximum: 65535,
        'x-hot': false,
        description: '默认 7796，避免与 B 站 Overlay 7795 冲突。',
      },
      'worlds.douyin-live.overlay.agentNoticeMaxChars': {
        type: 'integer',
        title: '公告字数上限',
        minimum: 1,
        maximum: 5000,
        'x-hot': true,
      },
      'worlds.douyin-live.overlay.maxQueuedVideos': {
        type: 'integer',
        title: '视频排队上限',
        minimum: 1,
        maximum: 100,
        'x-hot': true,
      },
    },
  },
};
