# VideoWall (Controller + Android clients)

Three-screen LAN video wall MVP. Controller is Node.js (Express + WebSocket); clients are Android (Kotlin + ExoPlayer). Version 0.2.0.

## Structure
- `controller/` – server, static console in `public/`, runtime data in `data/`
- `android-client/` – Android app with flavors `left|center|right`
- `notes/` – background notes

## Quick start
```bash
cd controller
npm install
npm start   # serves http://<host>:8080 , WS path /ws
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
docker build -t videowall/controller:0.2 .
docker run -d --name videowall-controller -p 8080:8080 ^
  -v %cd%/data:/app/data -v %cd%/public:/app/public videowall/controller:0.2
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
- Upload auto-crops 6000x1920 into L/C/R; no transcoding beyond cropping.

See `AGENTS.md` for contribution notes and `README-hand-off.md` for ops tips.
