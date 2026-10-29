// src/webui/client.ts
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}
var POLL_MS = 2e3;
var phaseLabel = {
  idle: "\u7A7A\u95F2",
  connecting: "\u7B49\u5F85\u6865\u8FDE\u5165 / \u8FDE\u63A5\u4E2D",
  connected: "\u5DF2\u8FDE\u63A5",
  retrying: "\u91CD\u8FDE\u4E2D",
  stopped: "\u5DF2\u505C\u6B62"
};
var bridgePanel = {
  mount(ctx) {
    const { ui, root } = ctx;
    const card = ui.sheet({
      title: "\u5F39\u5E55\u63A5\u5165",
      en: "danmaku ingest",
      desc: "\u9ED8\u8BA4\u76F4\u8FDE\u6296\u97F3\u76F4\u64AD\u95F4\uFF08\u586B\u623F\u95F4\u53F7\u5373\u53EF\uFF09\u3002\u76F4\u64AD\u4F34\u4FA3\u53EA\u8D1F\u8D23\u63A8\u6D41\uFF0C\u4E0D\u5FC5\u53E6\u88C5 Dycast/Grabber\u3002"
    });
    root.appendChild(card.el);
    const err = ui.msgline();
    const info = ui.h("div");
    const help = ui.h("div");
    help.style.fontSize = "12px";
    help.style.opacity = "0.85";
    help.style.lineHeight = "1.5";
    card.body.append(err, info, help);
    const setError = (text) => {
      err.textContent = text ?? "";
      err.className = text ? "msgline bad" : "msgline";
      err.hidden = !text;
    };
    setError(null);
    const draw = (st) => {
      const s = st.status;
      const phase = s?.phase ?? "idle";
      const mode = st.ingestMode || "room";
      info.replaceChildren(ui.kv([
        { k: "\u63A5\u5165\u65B9\u5F0F", v: mode === "bridge" ? "\u5916\u7F6E\u6865\uFF08\u8FDB\u9636\uFF09" : "\u76F4\u8FDE\u623F\u95F4\uFF08\u63A8\u8350\uFF09" },
        { k: "\u72B6\u6001", v: ui.pill(phaseLabel[phase] ?? phase, phase === "connected" ? "on" : "off") },
        { k: "\u76F4\u64AD\u95F4\u53F7", v: st.roomId || "\u2014" },
        { k: "\u5185\u90E8\u5730\u5740", v: s?.url || st.bridgeUrl || "\u2014" },
        { k: "\u534F\u8BAE", v: s?.adapter || st.adapter || "\u2014" },
        { k: "\u6D88\u606F\u6570", v: String(s?.messages ?? 0) },
        { k: "\u91CD\u8FDE\u6B21\u6570", v: String(s?.reconnects ?? 0) },
        { k: "\u623F\u95F4", v: s?.roomTitle || s?.roomId || "\u2014" },
        ...s?.lastError ? [{ k: "\u6700\u8FD1\u9519\u8BEF", v: s.lastError }] : [],
        ...st.overlay ? [
          { k: "Overlay", v: st.overlay.overlayUrl },
          { k: "\u8BF4\u660E\u9875", v: st.overlay.editorUrl }
        ] : [{ k: "Overlay", v: "\u672A\u542F\u7528" }],
        { k: "\u516C\u544A", v: st.announcement?.trim() ? st.announcement : "\uFF08\u7A7A\uFF09" },
        {
          k: "\u89C6\u9891\u6392\u961F",
          v: st.videoQueue?.items?.length ? st.videoQueue.items.map((it, i) => `${i + 1}. ${it.id}`).join("\n") : "\uFF08\u7A7A\uFF09"
        }
      ]));
      if (mode !== "bridge" && !(st.roomId || "").trim()) {
        help.textContent = "\u8BF7\u5728\u914D\u7F6E\u91CC\u586B\u5199\u300C\u76F4\u64AD\u95F4\u53F7\u300D\uFF08live.douyin.com/ \u540E\u9762\u7684\u6570\u5B57\uFF09\uFF0C\u4FDD\u5B58\u540E\u91CD\u5F00\u672C World\u3002";
      } else if (phase === "connecting") {
        help.textContent = mode === "bridge" ? "\u5916\u7F6E\u6865\u7B49\u5F85\u8FDE\u5165\uFF1ADycast \u8F6C\u53D1\u5230\u6865\u5730\u5740\uFF0C\u6216 Grabber client \u6A21\u5F0F\u3002" : "\u6B63\u5728\u89E3\u6790/\u8FDE\u63A5\u6296\u97F3\u76F4\u64AD\u95F4\uFF0C\u8BF7\u7A0D\u5019\uFF1B\u5931\u8D25\u65F6\u770B\u300C\u6700\u8FD1\u9519\u8BEF\u300D\u3002";
      } else if (phase === "connected") {
        help.textContent = "\u5DF2\u8FDE\u901A\u3002\u6D88\u606F\u6570\u4E0A\u6DA8\u5373\u8868\u793A\u5728\u6536\u5F39\u5E55\u3002";
      } else if (phase === "idle") {
        help.textContent = "\u672A\u5F00\u59CB\u63A5\u5165\u3002\u786E\u8BA4\u5DF2\u542F\u7528 World \u5E76\u586B\u5199\u76F4\u64AD\u95F4\u53F7\u3002";
      } else {
        help.textContent = "";
      }
    };
    let polling = false;
    const poll = () => {
      if (polling) return;
      polling = true;
      void ctx.invoke("state").then(
        (st) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(null);
          draw(st);
        },
        (e) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(`\u8BFB\u53D6\u6865\u72B6\u6001\u5931\u8D25: ${errText(e)}`);
        }
      );
    };
    ctx.interval(poll, POLL_MS);
    poll();
  }
};
var logPanel = {
  mount(ctx) {
    const { ui, root } = ctx;
    const card = ui.sheet({
      title: "\u63A5\u5165\u65E5\u5FD7",
      en: "ingest log",
      desc: "\u5F52\u4E00\u5316\u3001\u5F52\u5E76\u4E0E\u7B5B\u9009\u8BCA\u65AD\u3002"
    });
    root.appendChild(card.el);
    const err = ui.msgline();
    const view = ui.log({ max: 200, maxHeight: "360px", empty: "\uFF08\u6682\u65E0\u65E5\u5FD7\uFF09" });
    const meta = ui.h("pre");
    meta.style.whiteSpace = "pre-wrap";
    meta.style.fontSize = "12px";
    meta.style.margin = "8px 0 0";
    card.body.append(err, view.el, meta);
    const setError = (text) => {
      err.textContent = text ?? "";
      err.className = text ? "msgline bad" : "msgline";
      err.hidden = !text;
    };
    setError(null);
    let shown = 0;
    let polling = false;
    const poll = () => {
      if (polling) return;
      polling = true;
      void ctx.invoke("state").then(
        (st) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(null);
          const fresh = Math.min(st.total - shown, st.recent.length);
          if (fresh > 0) {
            const chronological = [...st.recent].reverse();
            for (const line of chronological.slice(chronological.length - fresh)) {
              const extra = line.data ? ` ${JSON.stringify(line.data)}` : "";
              view.append(`${line.ts} [${line.level}] ${line.message}${extra}`);
            }
          }
          shown = st.total;
          meta.textContent = JSON.stringify({
            coalescing: st.coalescing,
            admission: st.admission,
            unknownMethods: st.unknownMethods
          }, null, 2);
        },
        (e) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(`\u8BFB\u53D6\u65E5\u5FD7\u5931\u8D25: ${errText(e)}`);
        }
      );
    };
    ctx.interval(poll, POLL_MS);
    poll();
  }
};
var bundle = {
  panels: {
    bridge: bridgePanel,
    log: logPanel
  }
};
var client_default = bundle;
export {
  client_default as default
};
