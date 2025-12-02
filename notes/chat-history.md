# VideoWall 简要决策与上下文

## 需求摘要
- 硬件：3 台 Android 7.1 屏幕；左/右 32" 1080×1920 竖屏，中屏 55" 3840×2160 横屏，拼成一块视频墙。
- 内容：支持 1080p/4K 图片与视频；三屏时间线严格同步；支持转场；仅中屏出声，侧屏可静音。
- 控制：主控端跑在 NAS/Docker，Web 前端控制；可推送节目、设置播放计划、熄屏/唤醒；客户端开机自启、无触控、可远程操作。
- 节目：事先按 6000×1920 画布裁切成三路并打包（含 manifest）；可指定顺序/时长；预留待机/关机指令。

## 分辨率与裁切规范
- 统一画布：6000×1920（中屏 3840×1920，左右 1080×1920）。
- 裁切：左 crop 1080:1920:0:0；中 crop 3840:1920:1080:0；右 crop 1080:1920:4920:0。

## 当前代码状态（2025-11-26）
- `controller/`：Express + WebSocket；静态控制台在 `public/`，API 包含 ping/status/devices/stop/power/control、materials CRUD、upload->playlist、playlist CRUD/produce、package CRUD、schedule 等。手动广播相关接口已删除，播放下发需通过排程。
- `android-client/`：Kotlin + ExoPlayer + OkHttp；flavor `left|center|right`；开机自启并连 WS；接收 `play` 按 `startAtUtcMs` 精准起播，音频仅中屏；power 指令当前只做暂停/恢复提示；`control|snapshot` 指令待客户端实现。

## WebSocket 消息（现有）
- 上行：`hello {deviceId, role}`，`ping`。
- 下行：`welcome|synctime { serverTime }`，`play { programId, startAtUtcMs, loop, screens{ left|center|right{ url,effect,audio }}}`，`stop`，`power { action }`，`control { action }`（新），`snapshot`（新）。

## 运行/部署要点
- 控制端本地：`cd controller && npm install && npm start`（默认 8088）。
- Docker：`cd controller && npm install --production && docker compose up -d --build`（挂载 ./data、./public）。
- Android：`WS_URL` 在 `android-client/app/build.gradle`；可 `./gradlew assembleLeftDebug`（替换 flavor）打包，APK 输出 `app/build/outputs/apk/<flavor>/debug/`。

## 待办/限制
- 真正关机/重启需系统签名或 MDM，目前仅软停/唤醒提示。
- 上传/裁切 UI 无断点续传与校验；无缓存/断网续播策略；排程未做日历视图。
- 左右屏需能访问素材 URL 或已缓存；纯离线需预装三路文件。
- “节目/片段跳转、截图”需客户端实现对应指令；当前仅控制端发送消息。

## 参考指令
- 同步播放示例：`POST /api/schedule`，body `{ "programId":"<playlistId>", "startAtUtcMs": Date.now()+5000 }`。
- 裁切示例：`ffmpeg -i full.mp4 -vf "crop=1080:1920:0:0" left.mp4`（中/右同理）。

## 更新记录
- 2025-11-26：移除手动广播页面与接口；概览页新增“直接控制”按钮区，对应 `/api/control` 指令（pause/stop/跳转/同步/截图）。
- 2025-11-25：曾添加 `/api/packages/:id/broadcast` 用于按 manifest 顺序下发节目包；安卓端开启硬件加速并循环当前节目包。
- 2025-11-28：UI 规则追加——所有弹窗/模态去掉半透明蒙层，背景透明；点击弹窗外区域需自动关闭（但阻止刚打开时的立即关闭）。
