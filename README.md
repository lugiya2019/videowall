# 视频拼墙 (VideoWall)

简洁的三屏拼墙 MVP，包括 Node.js 控制端和 Kotlin 安卓客户端（左/中/右三个角色）。本项目旨在在局域网内同步下发媒体并准点播放。

## 仓库结构
- `controller/`：Express + WebSocket 服务器，静态控制台在 `public/`，上传/运行时数据在 `data/`。
- `android-client/`：Android 应用，使用 ExoPlayer/OkHttp，flavor `left|center|right`。
- `notes/`：背景说明与决策记录。
- `AGENTS.md`：贡献者指南；`README-hand-off.md`：运维速查。

## 环境要求
- Node.js 18+，npm；可选 Docker / Docker Compose。
- Android Studio Koala/Iguana，JDK 17，Android SDK 34。

## 快速开始
### 本地运行控制端
```bash
cd controller
npm install
npm start   # 默认端口 8080，WS 路径 /ws
```
健康检查：`curl http://localhost:8080/api/ping`

### Docker 运行（如 NAS）
```bash
cd controller
npm install --production
docker compose up -d --build
```
会挂载 `data/` 与 `public/`。

### Android 客户端
1. 在 Android Studio 打开 `android-client/`（允许生成 Gradle Wrapper）。
2. 修改 `app/build.gradle` 中的 `WS_URL` 指向控制端，例如 `"ws://<NAS-IP>:8080/ws"`。
3. 选择 `leftDebug` / `centerDebug` / `rightDebug` 并运行或构建 APK（输出在 `app/build/outputs/apk/<flavor>/debug/`）。
4. 运行后看到 `Connected` 表示 WS 连接成功。

## 控制台与下发
- 浏览器访问 `http://<控制端IP>:8080`。
- “在线设备”显示心跳；“下发并同步播放”中填三屏 URL（或至少一个屏），可设定延时秒数/`programId`。
- 日志在服务器控制台；可用 `adb logcat | findstr videowall` 观察客户端。

## 开发常用命令
- 控制端：`npm start`、`npm run dev`（同上）。
- 打包 Android（示例）：`./gradlew assembleLeftDebug`，其他角色替换 flavor 名。

## 同步与协议要点（MVP）
- 客户端上报：`hello { deviceId, role }`，`ping`。
- 服务器下发：`welcome|synctime { serverTime }`，`play { programId, startAtUtcMs, loop, screens{...} }`，`stop`，`power { action }`（当前仅暂停/恢复提示）。
- 同步目标：各屏误差 <100ms，`startAtUtcMs` 使用服务器时间戳。

## 已知限制
- 无鉴权/HTTPS，仅适用于内网环境。
- 电源控制未真正关机/重启；需要厂商 API 或 MDM。
- 没有素材上传与自动裁切，需手填三条 URL；无缓存与校验。

## 打包与部署
- 控制端 Docker 镜像（NAS/后台）：  
  ```bash
  cd controller
  docker build -t videowall/controller:0.1 .
  # 测试运行
  docker run -d --name videowall-controller -p 8080:8080 -v ${PWD}/data:/app/data -v ${PWD}/public:/app/public videowall/controller:0.1
  ```  
  如在群晖，先构建镜像或 `docker save` 导入，再用已有 `docker-compose.yml` 启动。
- 安卓 APK：  
  1) 在 `android-client/app/build.gradle` 调整 `WS_URL` 为控制端 IP。  
  2) 首次用 Android Studio 打开项目以生成 Gradle Wrapper。  
  3) 命令行打包（示例 Debug）：`cd android-client && ./gradlew assembleLeftDebug`（其他屏幕替换 flavor）。  
  4) 产物：`android-client/app/build/outputs/apk/<flavor>/debug/*.apk`。

## 更多
贡献与开发规范见 `AGENTS.md`，运维细节见 `README-hand-off.md`。若推送到 GitHub，请确保 `.gitignore` 中的运行时数据与密钥未被提交。
