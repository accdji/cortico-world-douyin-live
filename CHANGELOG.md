# Changelog

## 0.1.6

- 市场标签对齐官方词表：`streaming` + 自报 `unofficial-api` / `experimental`
- 补充 `cortico.locales`（zh/en）
- 更新 `describe.json`：去掉已移除的写字板工具声明

## 0.1.5

- 未开播时等待并重解析；开播后内部 `roomId` 变更会自动重连
- 修正房间状态文案：`status=2` 为开播中，`4` 为未开播/已结束
- 去掉写字板工具，提示词改为桌宠口头回复观众

## 0.1.4

- 弹幕库改走本地 `vendor/douyin-danma`（修复 protobufjs ESM）
- 连接失败日志带步骤与具体错误；导航栏状态灯

## 0.1.0

- 首版：房间号直连抖音弹幕（可选外置桥）
- 归并、重要观众准入、OBS Overlay（7796）
- 工具：`douyin_live_update_video_queue`
