import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDouyinRoom } from './room-resolve.ts';
import type { BridgeMessage, BridgePhase, BridgeStatus } from './types.ts';

const PKG_VERSION = '0.1.6';

/** Douyin enter API: 2 = live, 4 = ended. */
const DOUYIN_STATUS_LIVE = 2;

type DanmaClient = {
  on(event: string, listener: (...args: any[]) => void): void;
  once?(event: string, listener: (...args: any[]) => void): void;
  connect(): Promise<void>;
  close(): void;
};

type DanmaClientCtor = new (roomId: string, options?: {
  autoStart?: boolean;
  autoReconnect?: number;
  heartbeatInterval?: number;
  timeoutInterval?: number;
  reconnectInterval?: number;
  cookie?: string;
}) => DanmaClient;

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: string; cause?: unknown };
    const parts = [
      anyErr.message || err.name || 'Error',
      anyErr.code ? `code=${anyErr.code}` : null,
      anyErr.cause ? `cause=${formatErr(anyErr.cause)}` : null,
    ].filter(Boolean);
    return parts.join(' | ');
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function errStack(err: unknown): string | undefined {
  return err instanceof Error && err.stack ? err.stack : undefined;
}

async function loadDanmaClient(): Promise<{ Ctor: DanmaClientCtor; libEntry: string }> {
  // Vendored copy of douyin-danma-listener with protobufjs ESM fix.
  const root = packageRoot();
  const libEntry = join(root, 'vendor', 'douyin-danma', 'index.js');
  if (!existsSync(libEntry)) {
    throw new Error(
      `弹幕库文件不存在: ${libEntry}。请确认本扩展目录含 vendor/douyin-danma，并在 Coopanion 里重新「本地安装/链接」后重启（当前包 ${PKG_VERSION}）。`,
    );
  }

  // Preflight: protobufjs must resolve from the vendor file's location.
  try {
    createRequire(libEntry).resolve('protobufjs/minimal.js');
  } catch (e) {
    throw new Error(
      `找不到依赖 protobufjs（从 ${libEntry} 解析失败）: ${formatErr(e)}。请在扩展目录执行依赖安装后重启。`,
    );
  }

  try {
    const mod = await import(pathToFileURL(libEntry).href) as { default: DanmaClientCtor };
    if (!mod?.default) throw new Error('模块无 default 导出');
    return { Ctor: mod.default, libEntry };
  } catch (e) {
    throw new Error(`弹幕库 import 失败 (${libEntry}): ${formatErr(e)}`);
  }
}

export interface NativeClientHandlers {
  onMessages(messages: BridgeMessage[], adapter: string): void;
  onStatus(status: BridgeStatus): void;
  onLog?(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void;
}

export interface NativeClientOptions {
  roomId: () => string;
  handlers: NativeClientHandlers;
}

/**
 * Built-in Douyin live ingest. The upstream listener may briefly drop on noisy frames;
 * we treat that as auto-reconnect, not a hard failure.
 */
export class NativeLiveClient {
  private client: DanmaClient | null = null;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private roomWatchTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private boundRoomId: string | null = null;
  private status: BridgeStatus = {
    phase: 'idle',
    url: '',
    adapter: 'native',
    lastMessageAt: null,
    lastError: null,
    messages: 0,
    reconnects: 0,
    roomTitle: null,
    roomId: null,
  };

  constructor(private readonly opts: NativeClientOptions) {}

  current(): BridgeStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.opts.handlers.onLog?.('info', `抖音直连客户端启动 v${PKG_VERSION}`, {
      packageRoot: packageRoot(),
    });
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopRoomWatch();
    this.teardownClient();
    this.setPhase('stopped');
  }

  private stopRoomWatch(): void {
    if (this.roomWatchTimer) {
      clearInterval(this.roomWatchTimer);
      this.roomWatchTimer = null;
    }
  }

  /** 开播场次切换时内部 roomId 会变；定期核对，变了就重连。 */
  private startRoomWatch(webRoomInput: string, gen: number): void {
    this.stopRoomWatch();
    this.roomWatchTimer = setInterval(() => {
      if (this.stopped || gen !== this.generation) return;
      void (async () => {
        try {
          const latest = await resolveDouyinRoom(webRoomInput);
          if (this.stopped || gen !== this.generation) return;
          if (latest.status != null && latest.status !== DOUYIN_STATUS_LIVE) {
            this.opts.handlers.onLog?.('warn', '检测到直播已结束，等待下一场', {
              status: latest.status,
              roomId: latest.roomId,
            });
            this.teardownClient();
            this.scheduleRetry(15_000);
            return;
          }
          if (this.boundRoomId && latest.roomId !== this.boundRoomId) {
            this.opts.handlers.onLog?.('info', '检测到新开播场次，切换 roomId 重连', {
              from: this.boundRoomId,
              to: latest.roomId,
            });
            this.teardownClient();
            this.scheduleRetry(1_000);
          }
        } catch {
          // ignore transient resolve errors while watching
        }
      })();
    }, 45_000);
  }

  private teardownClient(): void {
    if (!this.client) return;
    try {
      this.client.close();
    } catch {
      // ignore
    }
    this.client = null;
  }

  private scheduleRetry(ms = 5000): void {
    if (this.stopped) return;
    this.stopRoomWatch();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, ms);
  }

  private fail(step: string, err: unknown): void {
    const detail = formatErr(err);
    this.status.lastError = `${step}: ${detail}`;
    this.setPhase('retrying');
    this.opts.handlers.onLog?.('error', `连接直播间失败 [${step}] ${detail}`, {
      step,
      error: detail,
      stack: errStack(err),
      packageRoot: packageRoot(),
      version: PKG_VERSION,
    });
    this.scheduleRetry(8_000);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    const input = this.opts.roomId().trim();
    if (!input) {
      this.status.lastError = '未填写直播间号';
      this.setPhase('idle');
      this.opts.handlers.onLog?.('error', '未填写直播间号（worlds.douyin-live.roomId）');
      return;
    }

    this.teardownClient();
    this.stopRoomWatch();
    this.setPhase('connecting');

    let resolved;
    try {
      resolved = await resolveDouyinRoom(input);
    } catch (err) {
      if (this.stopped || gen !== this.generation) return;
      this.fail('解析房间', err);
      return;
    }
    if (this.stopped || gen !== this.generation) return;

    this.status.roomId = resolved.roomId;
    this.status.roomTitle = resolved.title;
    this.status.url = `native://${resolved.webRoomId}→${resolved.roomId}`;
    this.opts.handlers.onLog?.('info', '已解析直播间', {
      webRoomId: resolved.webRoomId,
      roomId: resolved.roomId,
      title: resolved.title,
      status: resolved.status,
      hasCookie: Boolean(resolved.cookie),
      version: PKG_VERSION,
    });

    this.safeEmit([{
      method: 'DyLiveInfo',
      id: resolved.roomId,
      content: resolved.title ?? undefined,
      user: { name: resolved.nickname ?? undefined },
      room: {
        title: resolved.title ?? undefined,
        status: resolved.status ?? undefined,
      },
    }]);

    // 每次开播会换新的内部 roomId；连到「已结束」场次收不到当前弹幕。
    if (resolved.status != null && resolved.status !== DOUYIN_STATUS_LIVE) {
      this.status.lastError = `房间未开播(status=${resolved.status})，等待开播后自动换新 roomId`;
      this.setPhase('retrying');
      this.opts.handlers.onLog?.('warn', '房间未开播，15 秒后重新解析（开播后内部房间号会变）', {
        status: resolved.status,
        roomId: resolved.roomId,
        title: resolved.title,
      });
      this.scheduleRetry(15_000);
      return;
    }

    let Ctor: DanmaClientCtor;
    let libEntry: string;
    try {
      ({ Ctor, libEntry } = await loadDanmaClient());
      this.opts.handlers.onLog?.('info', '弹幕库已加载', { libEntry, version: PKG_VERSION });
    } catch (err) {
      if (this.stopped || gen !== this.generation) return;
      this.fail('加载弹幕库', err);
      return;
    }
    if (this.stopped || gen !== this.generation) return;

    let client: DanmaClient;
    try {
      client = new Ctor(resolved.roomId, {
        autoReconnect: 50,
        heartbeatInterval: 8_000,
        timeoutInterval: 300_000,
        reconnectInterval: 3_000,
        cookie: resolved.cookie || undefined,
      });
      this.client = client;
      this.boundRoomId = resolved.roomId;
    } catch (err) {
      if (this.stopped || gen !== this.generation) return;
      this.fail('创建弹幕客户端', err);
      return;
    }

    client.on('open', () => {
      if (gen !== this.generation) return;
      this.status.lastError = null;
      this.setPhase('connected');
      this.opts.handlers.onLog?.('info', '已连接抖音直播弹幕');
      this.startRoomWatch(input, gen);
    });
    client.on('close', () => {
      if (this.stopped || gen !== this.generation) return;
      this.setPhase('retrying');
      this.status.reconnects += 1;
      this.opts.handlers.onLog?.('warn', '弹幕连接短暂断开，正在自动重连');
    });
    client.on('reconnect', (n: number) => {
      if (gen !== this.generation) return;
      this.status.reconnects = n;
      this.setPhase('connecting');
      this.opts.handlers.onLog?.('info', '弹幕自动重连', { attempt: n });
    });
    client.on('error', (err: unknown) => {
      if (gen !== this.generation) return;
      const message = formatErr(err);
      const soft = /gzip|protobuf|decode|incorrect header|invalid/i.test(message);
      this.status.lastError = message;
      this.opts.handlers.onLog?.(soft ? 'warn' : 'error', soft ? '弹幕帧解析告警（连接保持）' : '弹幕连接错误', {
        error: message,
      });
    });

    const bind = (event: string, map: (msg: any) => BridgeMessage | null): void => {
      client.on(event, (msg: any) => {
        try {
          const mapped = map(msg);
          if (mapped) this.safeEmit([mapped]);
        } catch (e) {
          this.opts.handlers.onLog?.('warn', `处理 ${event} 失败`, {
            error: formatErr(e),
          });
        }
      });
    };

    bind('chat', chatToBridge);
    bind('gift', giftToBridge);
    bind('member', memberToBridge);
    bind('like', likeToBridge);
    bind('social', socialToBridge);
    bind('roomUserSeq', seqToBridge);
    bind('roomStats', statsToBridge);

    try {
      await openWithin(client, 20_000);
    } catch (err) {
      if (this.stopped || gen !== this.generation) return;
      this.fail('WebSocket握手', err);
    }
  }

  private safeEmit(messages: BridgeMessage[]): void {
    if (!messages.length) return;
    this.status.messages += messages.length;
    this.status.lastMessageAt = Date.now();
    if (this.status.phase === 'retrying' || this.status.phase === 'connecting') {
      this.status.phase = 'connected';
    }
    try {
      this.opts.handlers.onMessages(messages, 'native');
    } catch (e) {
      this.opts.handlers.onLog?.('error', '投递弹幕到 World 失败', {
        error: formatErr(e),
      });
    }
    this.opts.handlers.onStatus(this.current());
  }

  private setPhase(phase: BridgePhase): void {
    this.status.phase = phase;
    this.opts.handlers.onStatus(this.current());
  }
}

/** connect() may resolve before the socket is open; wait for open/error/timeout. */
function openWithin(client: DanmaClient, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`连接超时：${ms}ms 内未收到 open`));
    }, ms);

    const onOpen = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const onError = (err: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(formatErr(err)));
    };

    client.on('open', onOpen);
    client.on('error', onError);
    void Promise.resolve()
      .then(() => client.connect())
      .catch(onError);
  });
}

function userOf(msg: any): BridgeMessage['user'] {
  const u = msg?.user ?? {};
  const id = u.id ?? u.idStr ?? u.uid;
  const name = u.nickName ?? u.nickname ?? u.name;
  return {
    id: id != null ? String(id) : undefined,
    name: name != null ? String(name) : undefined,
  };
}

function chatToBridge(msg: any): BridgeMessage {
  return {
    method: 'WebcastChatMessage',
    id: msg?.common?.msgId != null ? String(msg.common.msgId) : undefined,
    content: msg?.content != null ? String(msg.content) : undefined,
    user: userOf(msg),
    raw: msg,
  };
}

function giftToBridge(msg: any): BridgeMessage {
  const count = Number(msg?.totalCount ?? msg?.repeatCount ?? 1) || 1;
  const diamond = Number(msg?.gift?.diamondCount ?? msg?.gift?.diamond_count ?? 0);
  return {
    method: 'WebcastGiftMessage',
    id: msg?.common?.msgId != null ? String(msg.common.msgId) : undefined,
    user: userOf(msg),
    gift: {
      id: msg?.gift?.id != null ? String(msg.gift.id) : undefined,
      name: msg?.gift?.name != null ? String(msg.gift.name) : undefined,
      price: Number.isFinite(diamond) ? diamond : undefined,
      count,
    },
    raw: msg,
  };
}

function memberToBridge(msg: any): BridgeMessage {
  return {
    method: 'WebcastMemberMessage',
    id: msg?.common?.msgId != null ? String(msg.common.msgId) : undefined,
    user: userOf(msg),
    room: { audienceCount: msg?.memberCount },
    raw: msg,
  };
}

function likeToBridge(msg: any): BridgeMessage {
  return {
    method: 'WebcastLikeMessage',
    id: msg?.common?.msgId != null ? String(msg.common.msgId) : undefined,
    user: userOf(msg),
    room: { likeCount: msg?.total },
    raw: msg,
  };
}

function socialToBridge(msg: any): BridgeMessage {
  return {
    method: 'WebcastSocialMessage',
    id: msg?.common?.msgId != null ? String(msg.common.msgId) : undefined,
    user: userOf(msg),
    content: '关注了主播',
    raw: msg,
  };
}

function seqToBridge(msg: any): BridgeMessage {
  return {
    method: 'WebcastRoomUserSeqMessage',
    id: msg?.common?.msgId != null ? String(msg.common.msgId) : undefined,
    room: {
      audienceCount: msg?.total,
      totalUserCount: msg?.totalUser,
    },
    raw: msg,
  };
}

function statsToBridge(msg: any): BridgeMessage {
  return {
    method: 'WebcastRoomStatsMessage',
    id: msg?.common?.msgId != null ? String(msg.common.msgId) : undefined,
    room: {
      audienceCount: msg?.displayValue ?? msg?.total,
    },
    raw: msg,
  };
}
