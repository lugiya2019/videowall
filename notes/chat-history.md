# VideoWall 简要决策与上下文

## 需求摘要
- 硬件：3 个 Android 7.1 屏幕，左右 32" 竖（1080×1920），中间 55" 横（3840×2160），组成拼接墙。
- 内容：支持 1080p/4K 图片与视频；三屏时间线严格同步；转场动画；中屏有声，侧屏可静音。
- 控制：主控端运行在群晖 NAS（Docker/SPK 均可），网页前端控制；可下发节目、定时播放、息屏/唤醒；客户端开机自启、无触摸、遥控可操作。
- 节目：预裁切整幅画面成三份并打包（含 manifest）；指定播放顺序/时间；可发送待机/关机指令。

## 分辨率与裁切规范
- 统一画布：6000×1920。
- 裁切：
  - 左：crop 1080:1920:0:0
  - 中：crop 3840:1920:1080:0 （播放时上下各 120px 黑边以适配 4K 2160 高度）
  - 右：crop 1080:1920:4920:0

## 当前代码状态（MVP）
- `controller/`: Express + WebSocket；`/ws` 管理设备；`/api/broadcast` 下发 `play`；`/api/stop`、`/api/power`；`public/index.html` 为简易控制台（手填三条 URL，同步播放）。
- `android-client/`: Kotlin + ExoPlayer + OkHttp；flavor `left|center|right`；开机自启；WS_URL 在 `app/build.gradle`；收到 `play` 按 `startAtUtcMs` 准点播放；音量仅 center 开启；power 指令当前只做暂停/恢复提示。

## WebSocket 消息（现有）
- 上行：`hello {deviceId, role}`，`ping`
- 下行：`welcome|synctime { serverTime }`；`play { programId, startAtUtcMs, loop, screens{ left|center|right{ url,effect,audio }}}`；`stop`；`power { action }`

## 运行/部署要点
- 控制端本地：`cd controller && npm install && npm start`（默认 8080）。
- 群晖：`docker compose up -d --build`（路径 `/volume1/videowall/controller`；端口 8080:8080）。
- 安卓：修改 `WS_URL` 指向 NAS；在 Android Studio 选 `leftDebug|centerDebug|rightDebug` 编译并装到对应屏幕。

## 待办/限制
- 真实关机/重启需系统签名或 MDM，当前只有暂停/恢复。
- 无素材上传与自动裁切 UI；无缓存/断点续传/校验；无排期日历；未做鉴权/HTTPS。

## 参考指令
- 同步播放示例（控制台填）：左/中/右 url，延时 5 秒，programId=demo。
- 裁切 FFmpeg 示例：`ffmpeg -i full.mp4 -vf "crop=1080:1920:0:0" left.mp4` 等三条。

