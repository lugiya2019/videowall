# VideoWall (Controller + Android clients)

Three-screen LAN video wall MVP. Controller is Node.js (Express + WebSocket); clients are Android (Kotlin + ExoPlayer). Version 0.3.1.

## What's new (0.3.1)
- 局域网自动发现：控制端 UDP 广播，客户端开机即自动找到并连接，无需手输 IP。
- 自动更新：控制端发布 APK 清单，客户端落后版本自动下载并触发安装。
- 节目预制与本地打包：手动播发内容可一键保存为节目，支持 `/api/programs/:id/package` 打包为本地 tar.gz，所有素材保持局域网存储。
- 统一转场：三屏播放时统一随机转场，保持整屏一体感。

## Structure
- `controller/` – server, static console in `public/`, runtime data in `data/`
- `android-client/` – Android app with flavors `left|center|right`
- `notes/` – background notes

## Quick start
```bash
cd controller
npm install
npm start   # serves http://<host>:8088 , WS path /ws
```
Health: `GET /api/ping`, status: `GET /api/status`.

### Docker (recommended for NAS/servers)
```bash
cd controller
npm install --production
docker compose up -d --build   # mounts ./data and ./public
```
Manual build/run:
```bash
docker build -t videowall/controller:0.3.1 .
docker run -d --name videowall-controller -p 8088:8088 ^
  -v %cd%/data:/app/data -v %cd%/public:/app/public videowall/controller:0.3.1
```

### Android client
1) Open `android-client/` in Android Studio (accept Gradle wrapper download).  
2) Set `WS_URL` in `app/build.gradle` to your controller WS address.  
3) Build flavors: `./gradlew assembleLeftRelease`, `assembleCenterRelease`, `assembleRightRelease`.  
4) APKs output to `android-client/app/build/outputs/apk/<flavor>/release/`.

## Protocol (MVP)
- Client -> server: `hello { deviceId, role }`, `ping` (JSON; also WS ping frames)
- Server -> client: `welcome|synctime { serverTime }`, `play { startAtUtcMs, screens }`, `stop`, `power { action }`

Each program slice carries `checksum` so clients can cache and verify.

## Known limits
- No auth/HTTPS (LAN-only).  
- Power control is soft (pause/resume).  
- Upload auto-crops into left 1080x1920 / center 3840x1920 / right 1080x1920; no transcoding beyond cropping.

See `AGENTS.md` for contribution notes and `README-hand-off.md` for ops tips.
