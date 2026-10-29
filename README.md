# cortico-world-douyin-live

Cortico / Coopanion 的**抖音直播间** World：默认像官方 B 站扩展一样，**只填房间号**即可只读接入弹幕、礼物与人流；带归并、重要观众限流和本机 OBS Overlay。

**你需要装的：** 本扩展 +（推流用的）抖音直播伴侣 / OBS。  
**不必再装：** Dycast、DouyinBarrageGrab 等弹幕工具。

## 最短上手（读弹幕）

1. Coopanion 扩展页安装本目录或 npm 包 → **重启进程**
2. World 总览启用「抖音直播间」
3. 配置里填 **直播间号**（`https://live.douyin.com/123456789` 里的 `123456789`）
4. 接入方式保持默认 **`room`（直连房间）**
5. 面板「弹幕接入」应变为 **connected**，消息数开始涨

直播伴侣只负责摄像头/画面推流；弹幕由本扩展直连抖音网页直播协议，与伴侣是否开着无关。

## 和 B 站官方扩展的对照

| | B 站 `cortico-world-bilibili` | 本包（默认） |
|---|---|---|
| 用户要填的 | 房间号 | 房间号 |
| 弹幕从哪来 | 扩展内连 B 站 WSS | 扩展内连抖音 WSS |
| 另装弹幕工具 | 不需要 | **不需要** |
| 直播软件 | OBS / 直播姬推流 | 直播伴侣 / OBS 推流 |

## 配置（`worlds.douyin-live`）

| 键 | 默认 | 说明 |
|---|---|---|
| `ingestMode` | `room` | `room` 直连；`bridge` 外置桥（进阶） |
| `roomId` | 空 | 直播间号或链接（`room` 模式必填） |
| `giftFlushYuan` | `1` | 付费礼物即时投递门槛（元） |
| `overlay.port` | `7796` | OBS 浏览器源端口 |

进阶 `bridge` 模式仍支持 Dycast / Grabber，见源码与面板说明；日常直播不用开。

## Overlay / 桌宠上镜

- Overlay：OBS 浏览器源 `http://127.0.0.1:7796/overlay`
- 桌宠形象：OBS **窗口捕获** Coopanion，再色键抠底
- 观众弹幕进桌宠上下文后由桌宠口头回复（不依赖写字板工具）

## 工具与事件

- 工具：`douyin_live_update_video_queue`（可选 Overlay 视频排队）
- 事件：`douyin-live.danmaku` / `gift` / `fansclub` / `room` / `audience` / `feed` …

## 合规

与官方 B 站扩展同级：非开放平台只读接入，协议可能变更。直连依赖网页直播协议库（GPL-3.0 传递）；扩展本体以包内 LICENSE 为准。不做刷赞、群发。

## 开发

```powershell
corepack pnpm install
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build:webui
```

## 许可

见 [LICENSE](./LICENSE)。弹幕直连基于 [`douyin-danma-listener`](https://www.npmjs.com/package/douyin-danma-listener)（GPL-3.0）的本地补丁副本（`vendor/douyin-danma`，已适配 protobufjs ESM）。
