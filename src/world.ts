import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ToolDef,
  World,
  WorldHost,
  WorldWebUiDecl,
  WorldPanelDecl,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { AudienceAdmission, type AudienceAdmissionCandidate } from './audience-admission.ts';
import { BridgeClient } from './client.ts';
import { CoalescingBuffer, type CoalescingGroup } from './coalescing-buffer.ts';
import { DOUYIN_LIVE_CONFIG_GROUP, DOUYIN_LIVE_DEFAULTS, type DouyinLiveConfigSection } from './config.ts';
import { NativeLiveClient } from './native-client.ts';
import { expandGauges, normalizeBridgeMessage, shouldExpandRoomStats } from './normalize.ts';
import { OverlayServer } from './overlay/server.ts';
import { AgentAnnouncementStore, parseVideoId, VideoQueueStore } from './overlay/store.ts';
import type { BridgeMessage, BridgeStatus, LiveEvent, LogLine } from './types.ts';

type IngestClient = {
  start(): Promise<void>;
  stop(): Promise<void>;
  current(): BridgeStatus;
};

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const RECENT_CAP = 200;
const FEED_OUTAGE_MS = 60_000;
const ARM_STALE_MS = 300_000;

export interface DouyinLiveWorldOptions {
  cfg: DouyinLiveConfigSection;
  dataDir: string;
  timezone: string;
  persist: (patch: Partial<DouyinLiveConfigSection>) => void;
}

interface Aggregate {
  enter: number;
  like: number;
  freeGift: number;
  follow: number;
  online: number | null;
  likeTotal: number | null;
  totalUser: number | null;
}

interface PendingLiveEvent {
  item: LiveEvent;
  ts: string;
}

type LiveCandidate = AudienceAdmissionCandidate & { pending: PendingLiveEvent };

function emptyAggregate(): Aggregate {
  return {
    enter: 0,
    like: 0,
    freeGift: 0,
    follow: 0,
    online: null,
    likeTotal: null,
    totalUser: null,
  };
}

function videoQueueLines(store: VideoQueueStore): string {
  const items = store.get().items;
  return items.map((item, index) => `${index + 1}. ${item.id}${item.note ? ` ${item.note}` : ''}`).join('\n');
}

export function douyinLiveToolDecls(
  _agentNoticeMaxChars: number,
  maxQueuedVideos: number,
): Array<Omit<ToolDef, 'handler'>> {
  // 不暴露写字板工具：观众互动由桌宠口头回答。
  return [
    {
      name: 'douyin_live_update_video_queue',
      description: `Edit the local overlay video queue (max ${maxQueuedVideos} items): add, remove, move or clear. Accepts Douyin video links or ids.`,
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['add', 'remove', 'move', 'clear'] },
          id: { type: 'string', description: 'Video id or Douyin link (add/remove/move).' },
          note: { type: 'string', description: 'Optional note when adding.' },
          position: { type: 'integer', minimum: 1, description: '1-based position for add/move.' },
        },
        required: ['action'],
      },
    },
  ];
}

export class DouyinLiveWorld implements World {
  readonly id = 'douyin-live';

  private host: WorldHost | null = null;
  private client: IngestClient | null = null;
  private overlay: OverlayServer | null = null;
  private overlayError: string | null = null;
  private announcement: AgentAnnouncementStore;
  private videoQueue: VideoQueueStore;
  private admission: AudienceAdmission;
  private coalesce = new CoalescingBuffer<PendingLiveEvent>((groups) => this.emitCoalesced(groups));
  private aggregate = emptyAggregate();
  private aggregateArmedAt: number | null = null;
  private logs: LogLine[] = [];
  private logTotal = 0;
  private bridgeStatus: BridgeStatus | null = null;
  private lastMsgAt: number | null = null;
  private feedOutageSince: number | null = null;
  private feedOutageReported = false;
  private feedWatch: ReturnType<typeof setInterval> | null = null;
  private unknownMethods = new Map<string, number>();

  constructor(private readonly opts: DouyinLiveWorldOptions) {
    const data = opts.dataDir;
    this.announcement = new AgentAnnouncementStore(join(data, 'douyin-live-overlay', 'agent-notice.json'));
    this.videoQueue = new VideoQueueStore(join(data, 'douyin-live-overlay', 'video-queue.json'));
    this.admission = new AudienceAdmission(
      join(data, 'douyin-live-audience', 'ledger.json'),
      () => ({
        onlineRankOn: this.cfg.audienceOnlineRankOn,
        onlineRankOff: this.cfg.audienceOnlineRankOff,
        releaseHoldSec: this.cfg.audienceReleaseHoldSec,
        signalFreshSec: this.cfg.audienceSignalFreshSec,
        activeStaleHoldSec: this.cfg.audienceActiveStaleHoldSec,
        eventLineBudget: this.cfg.audienceEventLineBudget,
        eventTokenBudget: this.cfg.audienceEventTokenBudget,
        importantShare: this.cfg.audienceImportantShare,
      }),
      (err) => this.log('warn', '观众准入账本落盘失败', { error: String(err) }),
    );
  }

  private get cfg(): DouyinLiveConfigSection {
    return this.opts.cfg;
  }

  envPromptVars(): Record<string, string> {
    return {
      'douyin-live.videoQueueLimit': String(this.cfg.overlay.maxQueuedVideos),
      'douyin-live.videoQueue': videoQueueLines(this.videoQueue),
      'douyin-live.bridgeUrl': this.cfg.bridgeUrl,
      'douyin-live.roomId': this.cfg.roomId,
      'douyin-live.ingestMode': this.cfg.ingestMode,
    };
  }

  tools(): ToolDef[] {
    const decls = douyinLiveToolDecls(
      this.cfg.overlay.agentNoticeMaxChars,
      this.cfg.overlay.maxQueuedVideos,
    );
    return [
      {
        ...decls[0],
        handler: async (args) => this.updateVideoQueue(args as Record<string, unknown>),
      },
    ];
  }

  webUi(_language?: string): WorldWebUiDecl {
    const overlayPort = this.overlay?.getPort();
    const s = this.bridgeStatus ?? this.client?.current() ?? null;
    const phase = s?.phase ?? 'idle';
    const phaseLabel: Record<string, string> = {
      idle: '未启动',
      connecting: '连接中',
      connected: '已连接',
      retrying: '重试中',
      stopped: '已停止',
    };
    const roomConfigured = this.cfg.ingestMode === 'bridge'
      ? Boolean(this.cfg.bridgeUrl.trim())
      : Boolean(this.cfg.roomId.trim());

    return {
      config: [DOUYIN_LIVE_CONFIG_GROUP],
      panels: [...this.panelDecls()],
      // 导航栏状态灯（与 bilibili / 桌宠同机制）：online=绿，loading=黄，error=红，offline=灰
      lamps: [
        {
          label: '弹幕',
          ...(phase === 'connected'
            ? { state: 'online' as const, hint: s?.roomTitle || s?.roomId || '弹幕已接入' }
            : phase === 'stopped' || phase === 'idle'
              ? {
                  state: 'offline' as const,
                  hint: !roomConfigured
                    ? (this.cfg.ingestMode === 'bridge' ? '未填桥地址' : '未填直播间号')
                    : (s?.lastError ?? phaseLabel[phase] ?? phase),
                }
              : this.feedOutageReported && this.feedOutageSince !== null
                ? {
                    state: 'error' as const,
                    hint: `弹幕中断约 ${Math.round((Date.now() - this.feedOutageSince) / 1000)} 秒${s?.lastError ? `：${s.lastError}` : ''}`,
                  }
                : phase === 'retrying' && s?.lastError
                  ? { state: 'error' as const, hint: s.lastError }
                  : { state: 'loading' as const, hint: s?.lastError ?? phaseLabel[phase] ?? phase }),
        },
        {
          label: '房间',
          ...(s?.roomId
            ? {
                state: phase === 'connected' ? 'online' as const : 'loading' as const,
                hint: s.roomTitle ? `${s.roomTitle}（${s.roomId}）` : s.roomId,
              }
            : {
                state: 'offline' as const,
                hint: this.cfg.ingestMode === 'bridge'
                  ? (this.cfg.bridgeUrl.trim() || '未填桥地址')
                  : (this.cfg.roomId.trim() || '未填直播间号'),
              }),
        },
        {
          label: 'Overlay',
          ...(this.overlayError
            ? { state: 'error' as const, hint: this.overlayError }
            : this.overlay
              ? { state: 'online' as const, hint: `http://127.0.0.1:${overlayPort}/overlay` }
              : {
                  state: 'offline' as const,
                  hint: this.cfg.overlay.enabled ? 'Overlay 未启动' : 'Overlay 已关闭',
                }),
        },
      ],
      badges: [
        {
          label: '弹幕',
          value: !roomConfigured
            ? (this.cfg.ingestMode === 'bridge' ? '未填桥地址' : '未填房间号')
            : (phaseLabel[phase] ?? phase),
          tone: phase === 'connected' ? 'on' : phase === 'stopped' || phase === 'idle' ? 'off' : 'plain',
        },
        {
          label: '房间',
          value: s?.roomId
            ? (s.roomTitle || s.roomId)
            : (this.cfg.roomId.trim() || '—'),
          tone: s?.roomId && phase === 'connected' ? 'on' : 'plain',
        },
        {
          label: 'Overlay',
          value: this.overlay
            ? `:${overlayPort}`
            : this.cfg.overlay.enabled
              ? (this.overlayError ?? '未启动')
              : '已关闭',
          tone: this.overlay ? 'on' : 'plain',
        },
      ],
      links: overlayPort
        ? [
          { label: '打开 Overlay', href: `http://127.0.0.1:${overlayPort}/overlay` },
          { label: 'Overlay 说明', href: `http://127.0.0.1:${overlayPort}/editor` },
        ]
        : undefined,
      promptDocs: [
        {
          key: 'worlds.douyin-live.envPrompt',
          title: '抖音直播间 · 环境提示词',
          description: '抖音直播 World 进 system 前缀的那一段。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'douyin-live.videoQueueLimit', description: '视频排队上限' },
            { name: 'douyin-live.videoQueue', description: '当前排队列表' },
            { name: 'douyin-live.bridgeUrl', description: '本机弹幕桥地址（进阶）' },
            { name: 'douyin-live.roomId', description: '直播间号' },
            { name: 'douyin-live.ingestMode', description: '接入方式 room|bridge' },
          ],
        },
      ],
      invoke: async (panel, method) => {
        if (method !== 'state' && method !== 'get') return null;
        if (panel === 'log') return this.logState();
        if (panel === 'bridge') return this.bridgePanelState();
        return null;
      },
    };
  }

  panelDecls(): readonly WorldPanelDecl[] {
    return [
      {
        id: 'bridge',
        title: '弹幕接入',
        description: '直播间直连或外置桥的连接状态。',
      },
      {
        id: 'log',
        title: '接入日志',
        description: '归一化、归并与筛选诊断。',
      },
    ];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const handlers = {
      onMessages: (messages: BridgeMessage[], adapter: string) => this.onMessages(messages, adapter),
      onStatus: (status: BridgeStatus) => {
        this.bridgeStatus = status;
      },
      onLog: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) =>
        this.log(level, message, data),
    };

    if (this.cfg.ingestMode === 'bridge') {
      this.client = new BridgeClient({
        mode: () => this.cfg.bridgeMode,
        url: () => this.cfg.bridgeUrl,
        adapter: () => this.cfg.bridgeAdapter,
        handlers,
      });
    } else {
      this.client = new NativeLiveClient({
        roomId: () => this.cfg.roomId,
        handlers,
      });
    }

    this.overlayError = null;
    if (this.cfg.overlay.enabled) {
      this.overlay = new OverlayServer({
        port: this.cfg.overlay.port,
        announcement: this.announcement,
        videoQueue: this.videoQueue,
        onLog: (level, message, data) => this.log(level, message, data),
      });
      try {
        const port = await this.overlay.start();
        this.log('info', 'Overlay 已启动', { url: `http://127.0.0.1:${port}/overlay` });
      } catch (err) {
        this.overlayError = err instanceof Error ? err.message : String(err);
        this.log('error', 'Overlay 启动失败', { error: this.overlayError });
        this.overlay = null;
      }
    }

    await this.client.start();
    this.feedWatch = setInterval(() => this.checkFeed(), 5_000);

    const boot = this.cfg.ingestMode === 'bridge'
      ? `外置桥 ${this.cfg.bridgeMode} ${this.cfg.bridgeUrl}`
      : `直连房间 ${this.cfg.roomId || '（未填房间号）'}`;
    await host.pushEvent({
      type: 'douyin-live.room',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: `[直播间] 抖音直播 World 已挂载，${boot}`,
    }, { trigger: 'debounce' });
  }

  async stop(): Promise<void> {
    if (this.feedWatch) {
      clearInterval(this.feedWatch);
      this.feedWatch = null;
    }
    this.coalesce.flush('stop');
    await this.admission.flush();
    await this.client?.stop();
    this.client = null;
    await this.overlay?.stop();
    this.overlay = null;
    this.overlayError = null;
    this.host = null;
  }

  private onMessages(messages: BridgeMessage[], adapter: string): void {
    try {
      this.lastMsgAt = Date.now();
      if (this.feedOutageReported) {
        const lasted = this.feedOutageSince != null
          ? Math.round((Date.now() - this.feedOutageSince) / 1000)
          : 0;
        this.feedOutageReported = false;
        this.feedOutageSince = null;
        void this.pushLiveEvent({
          kind: 'event',
          type: 'douyin-live.feed',
          trigger: 'debounce',
          text: `[弹幕] 已恢复（中断约 ${lasted} 秒，${adapter}）`,
        });
      }
      this.feedOutageSince = null;

      for (const msg of messages) {
        try {
          if (shouldExpandRoomStats(msg.method)) {
            for (const g of expandGauges(msg)) this.applyNormalized(g);
            continue;
          }
          const normalized = normalizeBridgeMessage(msg, {
            giftFlushYuan: this.cfg.giftFlushYuan,
            warn: (message, data) => {
              if (data?.method) {
                const m = String(data.method);
                this.unknownMethods.set(m, (this.unknownMethods.get(m) ?? 0) + 1);
              }
              this.log('warn', message, data);
            },
          });
          if (normalized) this.applyNormalized(normalized);

          if (msg.method === 'WebcastChatMessage' || msg.method === 'WebcastEmojiChatMessage') {
            this.overlay?.pushEvent({
              kind: 'danmaku',
              text: `${msg.user?.name ?? '观众'}: ${msg.content ?? ''}`,
              uname: msg.user?.name,
              ts: Date.now(),
            });
          } else if (msg.method === 'WebcastGiftMessage') {
            this.overlay?.pushEvent({
              kind: 'gift',
              text: `${msg.user?.name ?? '观众'} 送出 ${msg.gift?.name ?? '礼物'}×${msg.gift?.count ?? 1}`,
              uname: msg.user?.name,
              ts: Date.now(),
            });
          } else if (msg.method === 'WebcastFansclubMessage') {
            this.overlay?.pushEvent({
              kind: 'fansclub',
              text: msg.content ?? '粉丝团',
              uname: msg.user?.name,
              ts: Date.now(),
            });
          }
        } catch (e) {
          this.log('warn', '单条弹幕处理失败', {
            method: msg.method,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } catch (e) {
      this.log('error', '弹幕批处理失败', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private applyNormalized(n: import('./types.ts').Normalized): void {
    if (n.kind === 'count') {
      this.aggregate[n.field] += n.by;
      this.armAggregate();
      return;
    }
    if (n.kind === 'gauge') {
      this.aggregate[n.field] = n.value;
      if (n.field === 'online') this.admission.setOnline(n.value);
      this.armAggregate();
      return;
    }
    // event
    if (n.type === 'douyin-live.gift') {
      const yuan = typeof n.meta?.yuan === 'number' ? n.meta.yuan : null;
      this.admission.noteGift(n.senderKey, yuan);
    } else if (n.type === 'douyin-live.fansclub') {
      this.admission.noteFansclub(n.senderKey);
    } else if (n.senderKey) {
      this.admission.noteInteraction(n.senderKey);
    }

    if (n.trigger === 'flush' || !n.coalesce) {
      this.coalesce.flush('barrier');
      void this.pushLiveEvent(n);
      return;
    }

    const pending: PendingLiveEvent = { item: n, ts: nowIso(this.opts.timezone) };
    if (n.coalesce.kind === 'danmaku') {
      this.coalesce.add(n.coalesce.key, pending, {
        windowMs: this.cfg.coalesceWindowMs,
        maxItems: this.cfg.coalesceMaxItems,
      });
    } else {
      this.coalesce.add(n.coalesce.key, pending, {
        windowMs: this.cfg.coalesceWindowMs,
        maxItems: this.cfg.coalesceMaxItems,
        runScope: 'gift',
      });
    }
  }

  private emitCoalesced(groups: readonly CoalescingGroup<PendingLiveEvent>[]): void {
    for (const group of groups) {
      if (group.items.length === 1) {
        void this.pushLiveEvent(group.items[0].item, group.items[0].ts);
        continue;
      }
      const first = group.items[0].item;
      if (first.coalesce?.kind === 'danmaku') {
        const uname = String(first.meta?.uname ?? '观众');
        const body = first.coalesce.body;
        const merged: LiveEvent = {
          ...first,
          text: `[弹幕×${group.items.length}|${uname}] ${body}`,
          meta: {
            ...first.meta,
            coalesceCount: group.items.length,
            participants: group.items.map((it) => ({
              senderKey: it.item.senderKey,
              uname: it.item.meta?.uname,
              count: 1,
            })),
          },
        };
        void this.pushLiveEvent(merged, group.items[0].ts);
      } else if (first.coalesce?.kind === 'gift') {
        const uname = String(first.meta?.uname ?? '观众');
        let totalNum = 0;
        let totalYuan = 0;
        let yuanKnown = true;
        for (const it of group.items) {
          const c = it.item.coalesce;
          if (c?.kind !== 'gift') continue;
          totalNum += c.num;
          if (c.yuan == null) yuanKnown = false;
          else totalYuan += c.yuan;
        }
        const amount = yuanKnown ? ` ¥${totalYuan}` : '';
        const merged: LiveEvent = {
          ...first,
          text: `[礼物×${group.items.length}笔${amount}|${uname}] ${first.coalesce.gift}×${totalNum}`,
          meta: {
            ...first.meta,
            coalesceCount: group.items.length,
            num: totalNum,
            yuan: yuanKnown ? totalYuan : null,
          },
        };
        void this.pushLiveEvent(merged, group.items[0].ts);
      } else {
        for (const it of group.items) void this.pushLiveEvent(it.item, it.ts);
      }
    }
  }

  private async pushLiveEvent(item: LiveEvent, ts?: string): Promise<void> {
    const host = this.host;
    if (!host) return;

    const pending: PendingLiveEvent = { item, ts: ts ?? nowIso(this.opts.timezone) };
    const critical = item.trigger === 'flush'
      || item.type === 'douyin-live.fansclub'
      || item.type === 'douyin-live.room'
      || item.type === 'douyin-live.feed'
      || item.type === 'douyin-live.warning';

    const participants = participantsOf(item);
    const candidate: LiveCandidate = {
      id: `${item.type}:${pending.ts}:${Math.random().toString(36).slice(2, 8)}`,
      text: item.text,
      critical,
      participants,
      pending,
    };

    const { accepted, dropped } = this.admission.filter([candidate]);
    if (dropped) this.log('warn', '直播间准入筛除', { dropped, ...this.admission.state() });
    if (!accepted.length) {
      // Still archive-only conceptually — we skip agent context
      return;
    }

    this.flushAggregateIfNeeded(false);

    await host.pushEvent({
      type: item.type,
      ts: pending.ts,
      source: this.id,
      origin: 'external',
      senderKey: item.senderKey ?? this.id,
      text: item.text,
      meta: item.meta,
    }, { trigger: item.trigger });
  }

  private armAggregate(): void {
    const now = Date.now();
    if (this.aggregateArmedAt != null && now - this.aggregateArmedAt > ARM_STALE_MS) {
      this.aggregateArmedAt = now;
    }
    if (this.aggregateArmedAt == null) this.aggregateArmedAt = now;
    // Audience gauges ride with the next delivered batch via onEventsSettled.
  }

  onEventsSettled(_events: readonly unknown[], outcome: 'delivered' | 'discarded'): void {
    if (outcome === 'delivered') this.flushAggregateIfNeeded(true);
  }

  private flushAggregateIfNeeded(force: boolean): void {
    const host = this.host;
    if (!host) return;
    const a = this.aggregate;
    const has = a.enter || a.like || a.freeGift || a.follow
      || a.online != null || a.likeTotal != null || a.totalUser != null;
    if (!has) return;
    if (!force && this.aggregateArmedAt == null) return;

    const parts: string[] = [];
    if (a.enter) parts.push(`进场 ${a.enter}`);
    if (a.like) parts.push(`点赞 ${a.like}`);
    if (a.follow) parts.push(`关注 ${a.follow}`);
    if (a.freeGift) parts.push(`免费礼物 ${a.freeGift}`);
    if (a.online != null) parts.push(`在线 ${a.online}`);
    if (a.totalUser != null) parts.push(`看过 ${a.totalUser}`);
    if (a.likeTotal != null) parts.push(`赞总数 ${a.likeTotal}`);

    const snapshot = { ...a };
    this.aggregate = emptyAggregate();
    this.aggregateArmedAt = null;

    void host.pushEvent({
      type: 'douyin-live.audience',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'external',
      senderKey: this.id,
      text: `[人流] ${parts.join(' · ')}`,
      meta: snapshot,
    }, { trigger: 'piggyback' });
  }

  private checkFeed(): void {
    if (!this.lastMsgAt) {
      // never received — don't alarm until we had traffic
      if (this.bridgeStatus?.phase === 'connected' || this.bridgeStatus?.phase === 'retrying') {
        const sinceConnect = this.bridgeStatus.lastMessageAt;
        if (!sinceConnect && this.bridgeStatus.phase === 'retrying') {
          if (!this.feedOutageSince) this.feedOutageSince = Date.now();
        }
      }
      return;
    }
    const gap = Date.now() - this.lastMsgAt;
    if (gap < FEED_OUTAGE_MS) return;
    if (!this.feedOutageSince) this.feedOutageSince = this.lastMsgAt;
    if (this.feedOutageReported) return;
    this.feedOutageReported = true;
    void this.pushLiveEvent({
      kind: 'event',
      type: 'douyin-live.feed',
      trigger: 'flush',
      text: `[弹幕] 超过 ${Math.round(gap / 1000)} 秒未收到消息（可能在自动重连）`,
    });
  }

  private setAnnouncement(text: string): string {
    const max = this.cfg.overlay.agentNoticeMaxChars;
    const clipped = [...text].slice(0, max).join('');
    this.announcement.set(clipped);
    this.overlay?.pushAnnouncement(clipped);
    return clipped ? `公告已更新（${[...clipped].length}/${max} 字）` : '公告已清空';
  }

  private updateVideoQueue(args: Record<string, unknown>): string {
    const action = String(args.action ?? '');
    const max = this.cfg.overlay.maxQueuedVideos;
    const state = this.videoQueue.get();

    if (action === 'clear') {
      this.videoQueue.set({ items: [] });
      this.overlay?.pushVideoQueue();
      return '排队已清空';
    }

    const rawId = String(args.id ?? '');
    const id = parseVideoId(rawId);
    if (!id && action !== 'clear') return '缺少有效的视频 id 或链接';

    if (action === 'add') {
      if (state.items.length >= max) return `排队已满（上限 ${max}）`;
      const note = String(args.note ?? '');
      const pos = Math.max(1, Number(args.position) || state.items.length + 1);
      const item = { id: id!, note };
      const next = [...state.items];
      next.splice(Math.min(pos - 1, next.length), 0, item);
      this.videoQueue.set({ items: next });
      this.overlay?.pushVideoQueue();
      return `已加入排队：\n${videoQueueLines(this.videoQueue)}`;
    }

    if (action === 'remove') {
      const idx = state.items.findIndex((it) => it.id === id);
      if (idx < 0) return `未找到 ${id}`;
      const next = [...state.items];
      next.splice(idx, 1);
      this.videoQueue.set({ items: next });
      this.overlay?.pushVideoQueue();
      return `已移除。当前排队：\n${videoQueueLines(this.videoQueue) || '（空）'}`;
    }

    if (action === 'move') {
      const idx = state.items.findIndex((it) => it.id === id);
      if (idx < 0) return `未找到 ${id}`;
      const pos = Math.max(1, Number(args.position) || 1);
      const next = [...state.items];
      const [item] = next.splice(idx, 1);
      next.splice(Math.min(pos - 1, next.length), 0, item);
      this.videoQueue.set({ items: next });
      this.overlay?.pushVideoQueue();
      return `已调整。当前排队：\n${videoQueueLines(this.videoQueue)}`;
    }

    return `未知 action: ${action}`;
  }

  private log(level: LogLine['level'], message: string, data?: Record<string, unknown>): void {
    const line: LogLine = {
      ts: nowIso(this.opts.timezone),
      level,
      message,
      data,
    };
    this.logs.push(line);
    if (this.logs.length > RECENT_CAP) this.logs.shift();
    this.logTotal += 1;
    const logger = this.host?.log;
    if (level === 'error') logger?.error?.(message, data);
    else if (level === 'warn') logger?.warn?.(message, data);
    else logger?.info?.(message, data);
  }

  private logState() {
    return {
      total: this.logTotal,
      recent: this.logs.slice(-80),
      coalescing: this.coalesce.state(),
      admission: this.admission.state(),
      unknownMethods: Object.fromEntries(this.unknownMethods),
    };
  }

  private bridgePanelState() {
    const overlayPort = this.overlay?.getPort() ?? null;
    return {
      ingestMode: this.cfg.ingestMode,
      roomId: this.cfg.roomId,
      status: this.bridgeStatus ?? this.client?.current() ?? null,
      bridgeUrl: this.cfg.bridgeUrl,
      adapter: this.cfg.ingestMode === 'room' ? 'native' : this.cfg.bridgeAdapter,
      overlay: overlayPort
        ? {
          port: overlayPort,
          overlayUrl: `http://127.0.0.1:${overlayPort}/overlay`,
          editorUrl: `http://127.0.0.1:${overlayPort}/editor`,
        }
        : null,
      announcement: this.announcement.get(),
      videoQueue: this.videoQueue.get(),
    };
  }
}

function participantsOf(item: LiveEvent): { senderKey: string; uname?: string; count: number }[] {
  const metaParts = item.meta?.participants;
  if (Array.isArray(metaParts) && metaParts.length) {
    return metaParts.map((p) => {
      const row = p as { senderKey?: string; uname?: string; count?: number };
      return {
        senderKey: String(row.senderKey ?? item.senderKey ?? ''),
        uname: row.uname != null ? String(row.uname) : undefined,
        count: Number(row.count) || 1,
      };
    }).filter((p) => p.senderKey);
  }
  if (item.senderKey) {
    return [{
      senderKey: item.senderKey,
      uname: item.meta?.uname != null ? String(item.meta.uname) : undefined,
      count: 1,
    }];
  }
  return [];
}

// silence unused default import reference for docs
void DOUYIN_LIVE_DEFAULTS;
