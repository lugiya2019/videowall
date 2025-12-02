# VideoWall Hand-off (2025-11-27, v0.6.2)

## 项目结构
- `controller/`: Node.js 控制端（Express + WebSocket），静态控制台在 `public/`，运行时数据在 `data/`。
- `android-client/`: Kotlin + ExoPlayer 客户端，flavor `left|center|right`。
- `notes/`: 方案背景与决策记录。

## 快速运行
- 控制端本机：
  ```bash
  cd controller
  npm install
  npm start   # http://<IP>:8088 ，WS: ws://<IP>:8088/ws
  ```
- Docker（NAS/服务器）：
  ```bash
  cd controller
  npm install --production
  docker compose up -d --build
  ```
- Android：打开 `android-client/`，或 `./gradlew assembleLeftDebug assembleCenterDebug assembleRightDebug`，APK 输出在 `app/build/outputs/apk/<flavor>/debug/`。

## 亮点（v0.6.2）
- 可视化裁切 + 缝隙补偿：上传页可填写 Gap1/Gap2，实时查看 5 段预览（左 | 缝 | 中 | 缝 | 右），FFmpeg 按比例裁切并压缩缝隙。
- 主从同步 + 缓存：中屏为主机，开机即对时并下发 `play/start`；左右屏只需连主机即可同步，离线时依赖本地缓存。
- 播放列表制作 → 节目制作 → 节目包：素材库/时间线编辑后可一键生成节目包（manifest+媒体），用于计划下发与预览。
- UDP 自动发现 + APK 输出：控制端周期广播 WS 地址；客户端可自动发现；APK 可直接从 `public/apk/` 下载。

## 控制台使用
- 访问 `http://<IP>:8088`。
- 页面：概览/设备、素材库、播放列表制作、节目制作、播放计划、电源；“广播”页面已移除。
- 概览页右侧为“直接控制”：暂停、停止、节目跳转、片段跳转、三屏截图、手动同步（需客户端支持相应指令）。
- 上传页：支持 Gap1/Gap2，可视化裁切预览；生成的播放列表会写入库并可继续编辑时间线。
- 节目制作页：基于播放列表生成节目包并预览切片/皮肤效果。
- 播放计划：通过未来 `startAtUtcMs` 下发播放列表，客户端按计划同步播放。

## Smoke 测试
1. `curl http://localhost:8088/api/ping` 确认控制端存活。
2. 上传 6000x1920 素材（含 Gap1/Gap2），检查预览与生成的播放列表条目。
3. 在“播放计划”页或 `POST /api/schedule`（startAtUtcMs = Date.now()+5000）下发计划，确认三端起播偏移 <100ms。
4. 断网重启仅保留客户端：主机应自动读取缓存并协同播放（左右屏需能访问缓存或原 URL）。

## 已知限制
- 无认证/HTTPS（建议反代保护）。
- FFmpeg 必须可执行；转码失败仅返回 500。
- ExoPlayer 仍有弃用警告；无断点续传/多重重试。
- 假设左右屏可访问素材 URL 或已缓存；纯离线需预装三路文件。
- 直接控制中的“节目跳转/片段跳转/截图”依赖客户端实现 `control|snapshot` 指令，如未实现则不会生效。

## 配置
- 控制端：`PORT`、`HOST`、`PUBLIC_URL`。数据目录：`controller/data/`。
- 客户端：`app/build.gradle` 中 `WS_URL` 指向控制端；若未配置，从机会按控制端 IP 推断 47999 端口，可在 App 内手动覆盖。

## 打包
- 控制端 Docker：`cd controller && npm install --production && docker compose up -d --build`。
- Android：`cd android-client && ./gradlew assembleLeftRelease assembleCenterRelease assembleRightRelease`。
