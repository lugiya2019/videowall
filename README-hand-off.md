# VideoWall Hand-off (2025-11-23, v0.4.0)

## 项目结构
- `controller/` Node.js 控制端（Express + WebSocket，静态控制台在 `public/`，媒体/节目存储在 `data/`）。
- `android-client/` Kotlin + ExoPlayer 客户端，flavor: `left|center|right`。
- `notes/` 记录上下文与决策。

## 快速运行
- 控制端本机：
  ```bash
  cd controller
  npm install
  npm start  # http://<IP>:8088 ，WS: ws://<IP>:8088/ws
  ```
- Docker（群晖/NAS）：
  ```bash
  cd controller
  npm install --production
  docker compose up -d --build
  ```

## 亮点（v0.4.0）
- **可视化裁切 + 缝隙补偿**：上传页可输入 Gap1/Gap2，实时可视化五段（左屏 | 缝1 | 中屏 | 缝2 | 右屏），FFmpeg 按缩放后位置裁切并压缩缝隙，适配有边框的实体拼缝。
- **客户端主机/从机同步**：默认中屏为主机，开启本地 WS(47999) 对时并下发 prepare/start/sync；左右屏仅需连主机即可同步播放，脱离控制端时钟。
- **缓存 + 开机自播**：节目下载后缓存并持久化；主机重启会读取上次节目并自动协调播放。运行中每 2s 漂移检测，>150ms 直接 seek，40~150ms 微调倍速。
- **APK 输出**：`android-client/app/build/outputs/apk/<role>/release/videowall-<role>-release-v0.4.0-*.apk`。

## 控制台使用
- 访问 `http://<IP>:8088`。
- “上传/发布”页：选择适配模式、填写缝隙 Gap1/Gap2（像素），查看可视化示意后上传；生成节目可一键发布，预览为“左竖-中横-右竖”。
- 手动广播、节目列表、排程、电源控制均有独立页面，导航切换。

## Smoke 测试
1. `curl http://localhost:8088/api/ping` 确认控制端存活。
2. 上传 6000x1920 素材（含 Gap1/Gap2），检查预览与生成节目。
3. 发布节目，三端（1 主 + 2 从）应在 5s 内同步播放，偏移 <50ms。
4. 断网重启仅保留客户端：主机应自动读缓存并协调播放（左右屏需能访问缓存或原 URL）。

## 已知限制
- 未加鉴权/HTTPS（建议反代）。
- FFmpeg 必须可执行；转码失败仅返回 500。
- ExoPlayer 仍有弃用警告；未做断点续传/多重重试。
- 主机假设左右屏能访问素材 URL 或已有缓存；纯离线需预装三路文件。

## 配置
- 控制端：`PORT`、`HOST`、`PUBLIC_URL`。
  - 缓存/节目目录：`controller/data/`
- 客户端：`app/build.gradle` 中 `WS_URL`（控制端地址）；从机的主机 WS 若未设置，会以控制端 IP 推断 47999 端口，可在 App 内手动修改后保存。

## 打包
- 控制端 Docker：`cd controller && npm install --production && docker compose up -d --build`
- Android：`cd android-client && ./gradlew assembleLeftRelease assembleCenterRelease assembleRightRelease`
