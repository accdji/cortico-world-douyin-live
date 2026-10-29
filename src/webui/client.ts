/**
 * Douyin live World browser panels — same contract as bilibili:
 * default export `{ panels: { [id]: { mount(ctx) } } }`.
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const POLL_MS = 2000;

interface BridgePanelState {
  status: {
    phase: string;
    url: string;
    adapter: string;
    lastMessageAt: number | null;
    lastError: string | null;
    messages: number;
    reconnects: number;
    roomTitle: string | null;
    roomId: string | null;
  } | null;
  bridgeUrl: string;
  adapter: string;
  overlay: {
    port: number;
    overlayUrl: string;
    editorUrl: string;
  } | null;
  announcement: string;
  videoQueue: { items: Array<{ id: string; note: string }> };
}

interface LogPanelState {
  total: number;
  recent: Array<{ ts: string; level: string; message: string; data?: Record<string, unknown> }>;
  coalescing?: Record<string, unknown>;
  admission?: Record<string, unknown>;
  unknownMethods?: Record<string, number>;
}

const phaseLabel: Record<string, string> = {
  idle: '空闲',
  connecting: '等待桥连入 / 连接中',
  connected: '已连接',
  retrying: '重连中',
  stopped: '已停止',
};

const bridgePanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const card = ui.sheet({
      title: '弹幕接入',
      en: 'danmaku ingest',
      desc: '默认直连抖音直播间（填房间号即可）。直播伴侣只负责推流，不必另装 Dycast/Grabber。',
    });
    root.appendChild(card.el);

    const err = ui.msgline();
    const info = ui.h('div');
    const help = ui.h('div');
    help.style.fontSize = '12px';
    help.style.opacity = '0.85';
    help.style.lineHeight = '1.5';
    card.body.append(err, info, help);

    const setError = (text: string | null): void => {
      err.textContent = text ?? '';
      err.className = text ? 'msgline bad' : 'msgline';
      err.hidden = !text;
    };
    setError(null);

    const draw = (st: BridgePanelState & { ingestMode?: string; roomId?: string }): void => {
      const s = st.status;
      const phase = s?.phase ?? 'idle';
      const mode = st.ingestMode || 'room';
      info.replaceChildren(ui.kv([
        { k: '接入方式', v: mode === 'bridge' ? '外置桥（进阶）' : '直连房间（推荐）' },
        { k: '状态', v: ui.pill(phaseLabel[phase] ?? phase, phase === 'connected' ? 'on' : 'off') },
        { k: '直播间号', v: st.roomId || '—' },
        { k: '内部地址', v: s?.url || st.bridgeUrl || '—' },
        { k: '协议', v: s?.adapter || st.adapter || '—' },
        { k: '消息数', v: String(s?.messages ?? 0) },
        { k: '重连次数', v: String(s?.reconnects ?? 0) },
        { k: '房间', v: s?.roomTitle || s?.roomId || '—' },
        ...(s?.lastError ? [{ k: '最近错误', v: s.lastError }] : []),
        ...(st.overlay
          ? [
            { k: 'Overlay', v: st.overlay.overlayUrl },
            { k: '说明页', v: st.overlay.editorUrl },
          ]
          : [{ k: 'Overlay', v: '未启用' }]),
        { k: '公告', v: st.announcement?.trim() ? st.announcement : '（空）' },
        {
          k: '视频排队',
          v: st.videoQueue?.items?.length
            ? st.videoQueue.items.map((it, i) => `${i + 1}. ${it.id}`).join('\n')
            : '（空）',
        },
      ]));

      if (mode !== 'bridge' && !(st.roomId || '').trim()) {
        help.textContent = '请在配置里填写「直播间号」（live.douyin.com/ 后面的数字），保存后重开本 World。';
      } else if (phase === 'connecting') {
        help.textContent = mode === 'bridge'
          ? '外置桥等待连入：Dycast 转发到桥地址，或 Grabber client 模式。'
          : '正在解析/连接抖音直播间，请稍候；失败时看「最近错误」。';
      } else if (phase === 'connected') {
        help.textContent = '已连通。消息数上涨即表示在收弹幕。';
      } else if (phase === 'idle') {
        help.textContent = '未开始接入。确认已启用 World 并填写直播间号。';
      } else {
        help.textContent = '';
      }
    };

    let polling = false;
    const poll = (): void => {
      if (polling) return;
      polling = true;
      void ctx.invoke<BridgePanelState>('state').then(
        (st) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(null);
          draw(st);
        },
        (e: unknown) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(`读取桥状态失败: ${errText(e)}`);
        },
      );
    };

    ctx.interval(poll, POLL_MS);
    poll();
  },
};

const logPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const card = ui.sheet({
      title: '接入日志',
      en: 'ingest log',
      desc: '归一化、归并与筛选诊断。',
    });
    root.appendChild(card.el);

    const err = ui.msgline();
    const view = ui.log({ max: 200, maxHeight: '360px', empty: '（暂无日志）' });
    const meta = ui.h('pre');
    meta.style.whiteSpace = 'pre-wrap';
    meta.style.fontSize = '12px';
    meta.style.margin = '8px 0 0';
    card.body.append(err, view.el, meta);

    const setError = (text: string | null): void => {
      err.textContent = text ?? '';
      err.className = text ? 'msgline bad' : 'msgline';
      err.hidden = !text;
    };
    setError(null);

    let shown = 0;
    let polling = false;
    const poll = (): void => {
      if (polling) return;
      polling = true;
      void ctx.invoke<LogPanelState>('state').then(
        (st) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(null);
          const fresh = Math.min(st.total - shown, st.recent.length);
          if (fresh > 0) {
            const chronological = [...st.recent].reverse();
            for (const line of chronological.slice(chronological.length - fresh)) {
              const extra = line.data
                ? ` ${JSON.stringify(line.data)}`
                : '';
              view.append(`${line.ts} [${line.level}] ${line.message}${extra}`);
            }
          }
          shown = st.total;
          meta.textContent = JSON.stringify({
            coalescing: st.coalescing,
            admission: st.admission,
            unknownMethods: st.unknownMethods,
          }, null, 2);
        },
        (e: unknown) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(`读取日志失败: ${errText(e)}`);
        },
      );
    };

    ctx.interval(poll, POLL_MS);
    poll();
  },
};

const bundle: WebUiClientBundle = {
  panels: {
    bridge: bridgePanel,
    log: logPanel,
  },
};

export default bundle;
