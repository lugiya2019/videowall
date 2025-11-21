# VideoWall Hand-off (2025-11-22)

## 项目结构
- `controller/` Node.js 控制端（Express + WebSocket，静态控制台在 `public/`，媒体/节目存储在 `data/`）。
- `android-client/` Kotlin + ExoPlayer 客户端，flavor: `left|center|right`。
- `notes/` 记录上下文与决策。

## 快速运行
- 控制端本机：
  ```bash
  cd controller
  npm install
  npm start  # http://<IP>:8080 ，WS: ws://<IP>:8080/ws
  ```
- Docker（群晖/NAS）：
  ```bash
  cd controller
  npm install --production
  docker compose up -d --build
  ```

## 新增能力（v0.1.0+full-stack 分支）
- **素材上传/自动裁切**：`POST /api/upload` 表单字段 `file`，假定 6000x1920，FFmpeg 自动裁三份存到 `controller/data/media/<programId>/`，生成节目清单与 sha256。
- **节目管理**：`GET /api/programs` 列表；`POST /api/programs/:id/broadcast` 直接下发；静态媒体通过 `/media/<programId>/left|center|right.<ext>` 访问。
- **排期**：`POST /api/schedule` {programId,startAtUtcMs,loop}；`GET/DELETE /api/schedule`。服务启动会恢复未来排期并定时下发。
- **客户端缓存/校验**：WS 下发的 `screens.{role}` 包含 `url`+`checksum`，Android 先下载到本地缓存并校验 sha256，校验通过后按 `startAtUtcMs` 同步播放；失败时回退为在线播放。
- **APK 可直接安装**：release 构建复用 debug keystore 自动签名，输出：`android-client/app/build/outputs/apk/<role>/release/app-<role>-release.apk`。

## 控制台使用
- 访问 `http://<IP>:8080`。
- 上传 6000x1920 素材，生成节目；列表中可一键下发；排期可设定开始时间（UTC 毫秒）。
- 手动下发仍可直接输入三路 URL。

## Smoke 测试
1. `curl http://localhost:8080/api/ping` 得到 serverTime。
2. 上传任意 6000x1920 文件，确认返回节目 ID；`GET /api/programs` 能看到 slices 带 checksum。
3. `POST /api/programs/<id>/broadcast` 并设置 5s 后 startAtUtcMs；在三台客户端观察同步播放，中心有声，左右静音。
4. `POST /api/schedule` 设定未来时间，等待自动下发；`GET /api/schedule` 倒计时应减少，触发后从列表移除。

## 已知限制
- 未添加鉴权/HTTPS（可用反代或自设 Basic/Auth Token）。
- FFmpeg 需在服务器 PATH 中可用；未做尺寸校验/转码失败兜底。
- 客户端仍使用旧 ExoPlayer API，存在弃用警告；未做断点续传。
- 电源控制仍为暂停/恢复提示，未接入设备管理接口。

## 需要调整的配置
- 控制端：可设 `PORT`、`HOST`、`PUBLIC_URL` 环境变量（静态 URL 生成时生效）。
- 客户端：`app/build.gradle` 中的 `WS_URL` 与默认角色。

## 打包
- 控制端 Docker 镜像：在 `controller/` 运行 `npm install --production && docker compose up -d --build`。
- Android：`cd android-client && ./gradlew assembleLeftRelease assembleCenterRelease assembleRightRelease`，APK 输出见上。
