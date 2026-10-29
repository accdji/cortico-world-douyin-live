import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { adaptBridgePayload, type AdapterKind } from './adapters/index.ts';
import type { BridgeMessage, BridgePhase, BridgeStatus } from './types.ts';

export interface BridgeClientHandlers {
  onMessages(messages: BridgeMessage[], adapter: string): void;
  onStatus(status: BridgeStatus): void;
  onLog?(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void;
}

export type BridgeMode = 'client' | 'server';

export interface BridgeClientOptions {
  /** client: connect outbound; server: listen and accept forwarders (Dycast). */
  mode: () => BridgeMode;
  /** client URL like ws://127.0.0.1:8888, or server listen URL ws://127.0.0.1:8765 */
  url: () => string;
  adapter: () => AdapterKind;
  handlers: BridgeClientHandlers;
}

const MIN_RETRY_MS = 2000;
const MAX_RETRY_MS = 60000;

function parseListen(url: string): { host: string; port: number } {
  const u = new URL(url);
  const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
  const host = u.hostname || '127.0.0.1';
  if (!Number.isFinite(port) || port <= 0) throw new Error(`无效监听端口: ${url}`);
  return { host, port };
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private inbound = new Set<WebSocket>();
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = MIN_RETRY_MS;
  private status: BridgeStatus = {
    phase: 'idle',
    url: '',
    adapter: 'auto',
    lastMessageAt: null,
    lastError: null,
    messages: 0,
    reconnects: 0,
    roomTitle: null,
    roomId: null,
  };

  constructor(private readonly opts: BridgeClientOptions) {}

  current(): BridgeStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.opts.mode() === 'server') this.listen();
    else this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.closeAll();
    this.setPhase('stopped');
  }

  private listen(): void {
    if (this.stopped) return;
    const url = this.opts.url().trim();
    this.status.url = url;
    this.status.adapter = this.opts.adapter();
    let host: string;
    let port: number;
    try {
      ({ host, port } = parseListen(url));
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
      this.setPhase('idle');
      this.opts.handlers.onLog?.('error', '桥监听地址无效', { url });
      return;
    }

    this.closeAll();
    this.setPhase('connecting');
    const httpServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('cortico-world-douyin-live bridge server\n');
    });
    const wss = new WebSocketServer({ server: httpServer });
    this.httpServer = httpServer;
    this.wss = wss;

    wss.on('connection', (socket) => {
      this.inbound.add(socket);
      this.status.lastError = null;
      this.setPhase('connected');
      this.opts.handlers.onLog?.('info', '弹幕桥客户端已连入', {
        peers: this.inbound.size,
      });
      socket.on('message', (data) => this.handleRaw(data.toString()));
      socket.on('close', () => {
        this.inbound.delete(socket);
        if (!this.stopped && this.inbound.size === 0) {
          this.setPhase('connecting');
          this.opts.handlers.onLog?.('warn', '弹幕桥客户端已断开，等待重连');
        }
      });
      socket.on('error', (err) => {
        this.status.lastError = err.message;
      });
    });

    httpServer.once('error', (err) => {
      this.status.lastError = err.message;
      this.opts.handlers.onLog?.('error', '桥监听失败', { error: err.message, url });
      this.scheduleRetry();
    });

    httpServer.listen(port, host, () => {
      this.retryMs = MIN_RETRY_MS;
      this.status.lastError = null;
      // Stay in connecting until a peer connects; still mark ready to accept
      this.setPhase('connecting');
      this.opts.handlers.onLog?.('info', '已开始监听弹幕桥', { url, host, port });
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.opts.url().trim();
    if (!url) {
      this.status.lastError = '桥地址为空';
      this.setPhase('idle');
      this.opts.handlers.onLog?.('error', '桥地址为空');
      return;
    }
    this.status.url = url;
    this.status.adapter = this.opts.adapter();
    this.setPhase('connecting');
    this.closeAll();

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.retryMs = MIN_RETRY_MS;
      this.status.lastError = null;
      this.setPhase('connected');
      this.opts.handlers.onLog?.('info', '已连接弹幕桥', { url });
    });

    ws.on('message', (data) => {
      this.handleRaw(data.toString());
    });

    ws.on('close', () => {
      if (this.stopped) return;
      this.opts.handlers.onLog?.('warn', '弹幕桥连接关闭');
      this.scheduleRetry();
    });

    ws.on('error', (err) => {
      this.status.lastError = err.message;
      this.opts.handlers.onLog?.('error', '弹幕桥错误', { error: err.message });
    });
  }

  private handleRaw(text: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      this.opts.handlers.onLog?.('warn', '桥消息不是 JSON', { preview: text.slice(0, 120) });
      return;
    }
    const preferred = this.opts.adapter();
    const { messages, adapter } = adaptBridgePayload(payload, preferred);
    if (!messages.length) return;

    this.status.messages += messages.length;
    this.status.lastMessageAt = Date.now();
    this.status.adapter = adapter;

    for (const msg of messages) {
      if (msg.method === 'DyLiveInfo') {
        this.status.roomId = msg.id ?? this.status.roomId;
        this.status.roomTitle = msg.room?.title || msg.content || this.status.roomTitle;
      }
      if (msg.room?.title) this.status.roomTitle = msg.room.title;
    }

    this.opts.handlers.onMessages(messages, adapter);
    this.opts.handlers.onStatus(this.current());
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.status.reconnects += 1;
    this.setPhase('retrying');
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const wait = this.retryMs;
    this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.opts.mode() === 'server') this.listen();
      else this.connect();
    }, wait);
  }

  private closeAll(): void {
    for (const s of this.inbound) {
      try { s.close(); } catch { /* ignore */ }
    }
    this.inbound.clear();
    if (this.wss) {
      try { this.wss.close(); } catch { /* ignore */ }
      this.wss = null;
    }
    if (this.httpServer) {
      try { this.httpServer.close(); } catch { /* ignore */ }
      this.httpServer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private setPhase(phase: BridgePhase): void {
    this.status.phase = phase;
    this.opts.handlers.onStatus(this.current());
  }
}
