import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentAnnouncementStore, VideoQueueStore } from './store.ts';

export interface OverlayEvent {
  kind: 'danmaku' | 'gift' | 'fansclub' | 'room' | 'system';
  text: string;
  uname?: string;
  ts: number;
}

export interface OverlayServerOptions {
  port: number;
  announcement: AgentAnnouncementStore;
  videoQueue: VideoQueueStore;
  onLog?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
}

export class OverlayServer {
  private server: Server | null = null;
  private port = 0;
  private clients = new Set<ServerResponse>();
  private recent: OverlayEvent[] = [];

  constructor(private readonly opts: OverlayServerOptions) {}

  getPort(): number {
    return this.port;
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    const base = this.opts.port || 7796;
    let lastErr: unknown;
    for (let i = 0; i < 5; i++) {
      const tryPort = base + i;
      try {
        await this.listen(tryPort);
        this.port = tryPort;
        if (i > 0) this.opts.onLog?.('warn', 'Overlay 端口被占用，已顺延', { port: tryPort });
        return tryPort;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async stop(): Promise<void> {
    for (const res of this.clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  pushEvent(ev: OverlayEvent): void {
    this.recent.push(ev);
    if (this.recent.length > 100) this.recent.shift();
    this.broadcast({ type: 'event', event: ev });
  }

  pushAnnouncement(text: string): void {
    this.broadcast({ type: 'announcement', text });
  }

  pushVideoQueue(): void {
    this.broadcast({ type: 'video-queue', queue: this.opts.videoQueue.get() });
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/overlay') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(overlayHtml());
      return;
    }
    if (url.pathname === '/editor') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(editorHtml(this.port));
      return;
    }
    if (url.pathname === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({
        type: 'hello',
        announcement: this.opts.announcement.get(),
        queue: this.opts.videoQueue.get(),
        recent: this.recent.slice(-40),
      })}\n\n`);
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: this.port, clients: this.clients.size }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  }

  private broadcast(payload: unknown): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) {
      try { res.write(data); } catch { this.clients.delete(res); }
    }
  }
}

function overlayHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/><title>抖音直播 Overlay</title>
<style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;font-family:system-ui,sans-serif;color:#fff}
#root{display:flex;flex-direction:column;gap:12px;padding:16px;box-sizing:border-box;height:100vh}
#notice{min-height:48px;padding:12px 16px;background:rgba(0,0,0,.55);border-left:4px solid #FE2C55;font-size:20px;white-space:pre-wrap}
#queue{padding:10px 14px;background:rgba(0,0,0,.45);font-size:14px}
#queue li{margin:4px 0}
#feed{flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:6px}
.row{padding:8px 12px;background:rgba(0,0,0,.5);border-radius:4px;font-size:16px;max-width:520px}
.row.gift{border-left:3px solid #ffd666}
.row.fansclub{border-left:3px solid #25F4EE}
.uname{color:#25F4EE;margin-right:8px}
</style></head><body>
<div id="root">
  <div id="notice">（暂无公告）</div>
  <div id="queue"><strong>视频排队</strong><ol id="queue-list"><li>（空）</li></ol></div>
  <div id="feed"></div>
</div>
<script>
const feed=document.getElementById('feed');
const notice=document.getElementById('notice');
const queueList=document.getElementById('queue-list');
function setNotice(t){notice.textContent=t&&t.trim()?t:'（暂无公告）';}
function setQueue(q){
  const items=(q&&q.items)||[];
  queueList.innerHTML='';
  if(!items.length){queueList.innerHTML='<li>（空）</li>';return;}
  for(const [i,it] of items.entries()){
    const li=document.createElement('li');
    li.textContent=(i+1)+'. '+it.id+(it.note?' '+it.note:'');
    queueList.appendChild(li);
  }
}
function addEvent(ev){
  const row=document.createElement('div');
  row.className='row '+(ev.kind||'');
  row.textContent=ev.text||'';
  feed.appendChild(row);
  while(feed.children.length>30)feed.removeChild(feed.firstChild);
}
const es=new EventSource('/stream');
es.onmessage=(e)=>{
  try{
    const msg=JSON.parse(e.data);
    if(msg.type==='hello'){setNotice(msg.announcement);setQueue(msg.queue);(msg.recent||[]).forEach(addEvent);}
    else if(msg.type==='announcement')setNotice(msg.text);
    else if(msg.type==='video-queue')setQueue(msg.queue);
    else if(msg.type==='event')addEvent(msg.event);
  }catch(err){}
};
</script></body></html>`;
}

function editorHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>Overlay 编辑入口</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6}
code{background:#f4f4f5;padding:2px 6px;border-radius:4px}</style></head>
<body>
<h1>抖音直播 Overlay</h1>
<p>OBS 浏览器源地址：</p>
<p><code>http://127.0.0.1:${port}/overlay</code></p>
<p>建议宽度 480–640，高度与画面等高，关闭「重启时刷新浏览器」以外的缓存限制即可。</p>
<p>公告与视频排队由 Agent 工具改写；本页仅作入口说明。复杂可视化编辑器可后续迭代。</p>
</body></html>`;
}
