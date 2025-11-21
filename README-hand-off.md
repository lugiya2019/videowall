# VideoWall Hand-off

Quick reference so a new machine/teammate can继续开发并验证当前 MVP。

## 项目结构
- `controller/` Node.js 控制端（Express + WebSocket，简易 Web 控制台在 `public/`）。
- `android-client/` 安卓客户端（Kotlin + ExoPlayer + OkHttp，多 flavor：left/center/right）。
- `notes/` 自述与决策记录（可补充）。

## 环境要求
- Node.js ≥ 18，npm。
- Android Studio (Koala/Iguana)，Android SDK 34，JDK 17。
- Git 可选；群晖 NAS 需 Docker 套件。

## 控制端本机运行
```bash
cd controller
npm install
npm start
# 默认 http://<本机IP>:8080 ，WS: ws://<本机IP>:8080/ws
```

## 控制端（群晖 Docker）
```bash
cd /volume1/videowall/controller
npm install --production
docker compose up -d --build
# 端口 8080:8080，挂载 data/ 与 public/
```

## Web 控制台用法
- 浏览器打开 `http://<NAS-IP>:8080`
- “在线设备”可刷新查看心跳。
- 下发播放：填左/中/右的媒体 URL（视频或图片），设置延时秒数与 programId，点击“下发并同步播放”。
- “电源”按钮当前仅做暂停/恢复提示（未做真实关机）。

## 安卓客户端构建
1) 打开 `android-client/`（允许生成 Gradle Wrapper）。
2) 编辑 `app/build.gradle` 的 `WS_URL`：`"ws://<NAS-IP>:8080/ws"`。
3) 在 Build Variants 选择 `leftDebug` / `centerDebug` / `rightDebug` 对应三块屏，或运行单个变种安装。
4) 运行或 Build APK(s) 获取输出：`app/build/outputs/apk/<flavor>/`.
5) App 特性：开机自启（需系统允许自启动）；遥控/按键“OK”可重连；右下角按钮可切换角色并重新发送 hello。

## 分辨率与裁切规范
- 屏幕：左 1080×1920 竖；中 3840×2160 横（展示 3840×1920，顶部/底部各 120px 黑边以保持一致高度）；右 1080×1920 竖。
- 制作统一画布：6000×1920。
- 裁切坐标（x,y 原点左上）：
  - Left:   `crop 1080:1920:0:0`
  - Center: `crop 3840:1920:1080:0`
  - Right:  `crop 1080:1920:4920:0`

## WebSocket 协议（MVP）
- 客户端 → 控制端
  - `hello { deviceId, role }`
  - `ping`
- 控制端 → 客户端
  - `welcome|synctime { serverTime }`
  - `play { programId, startAtUtcMs, loop, screens: { left|center|right: { url, effect, audio } } }`
  - `stop`
  - `power { action: sleep|wake|reboot }` （当前仅暂停/恢复）
- 同步：服务器时间戳下发；客户端按 `startAtUtcMs` 预加载并准点播放；目标误差 <100ms。
- 音频：默认仅 center 音量 1.0，左右 0.0。

## 关键依赖版本
- express 4.18, ws 8.13, multer 1.4, morgan 1.10
- ExoPlayer 2.20.0, OkHttp 4.12.0, Kotlin 1.9.10, AGP 8.1.2

## 已知限制 / 待办
- 未实现真实关机/重启（需设备管理/系统签名或 MDM）。
- 未做节目包上传/自动裁切 UI；当前控制台需填写三条 URL。
- 无断点续传与本地缓存；无素材校验/版本号。
- 暂无排期日历、多节目循环编辑器。
- 安全性：未加鉴权/HTTPS。

## 下一步建议
1) 在控制端加入素材上传 + FFmpeg 自动裁切 6000×1920 → 三份并生成 manifest。
2) 增加节目包缓存与 SHA 校验，失败重试。
3) 增加排期（cron/日历）和节目列表管理。
4) 电源控制适配厂商 API / MDM，或提供息屏亮屏的系统签名方案。
5) 加入 PTP/局域网时间源或帧级探针，提升同步精度。

