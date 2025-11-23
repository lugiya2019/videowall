# VideoWall Hand-off (2025-11-23, v1.0.0)

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

## 新增能力（v1.0.0）
- **可视化裁切 + 屏缝补偿**：控制台上传页新增 Gap1/Gap2，FFmpeg 会按“左竖-中横-右竖”裁切，并压缩两段可配置缝隙，适配物理边框。
- **客户端内建主机/从机同步**：默认中屏为主机，开启本地 WS(47999) 对时并下发 prepare/start/sync；左右屏只需连主机即可同步播放，脱离控制端时钟。
- **本地缓存与开机自播**：节目下载后写入缓存并持久化清单；主机重启自动读取上次节目并再次协调三屏播放。运行时每 2s 漂移检测，>150ms 直接 seek，40~150ms 轻微调速。
- **版本号提升**：后端 1.0.0，Android 1.0.0 (versionCode 10)，新增依赖 `org.java-websocket` 作为主机 WS。
- **APK 输出**：`android-client/app/build/outputs/apk/<role>/release/videowall-<role>-release-v1.0.0-*.apk`（自动签名，便于直装）。

## 控制台使用
- 访问 `http://<IP>:8088`。
- 上传素材：可填 Gap1/Gap2（像素），预览按“左竖-中横-右竖”排布；生成节目后可一键发布。
- 手动广播/排程与旧版一致。

## Smoke 测试
1. `curl http://localhost:8088/api/ping` 确认控制端存活。
2. 上传 6000x1920 素材（含 Gap1/Gap2），看到三路预览；`GET /api/programs` 有新节目且包含 checksum。
3. 发布节目，三端（1 主 + 2 从）应在 5s 内同步播放，偏移 <50ms。
4. 断网重启：关闭控制端，仅保留客户端，主机应自动读缓存并协调播放（左右屏需有缓存或能访问原 URL）。

## 已知限制
- 未添加鉴权/HTTPS（建议反代）。
- FFmpeg 必须可执行；转码失败仅返回 500。
- ExoPlayer 仍有弃用警告；未做断点续传/多次重试。
- 主机假设左右屏能访问素材 URL 或已有缓存；纯离线环境需预装三路文件。

## 需要调整的配置
- 控制端：`PORT`、`HOST`、`PUBLIC_URL`。
- 客户端：`app/build.gradle` 中的 `WS_URL`；从机如需自填主机 IP，可在首次运行后输入并保存（默认推断与控制端同一 IP，端口 47999）。

## 打包
- 控制端 Docker 镜像：`cd controller && npm install --production && docker compose up -d --build`
- Android：`cd android-client && ./gradlew assembleLeftRelease assembleCenterRelease assembleRightRelease`
