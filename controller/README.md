# VideoWall Controller

Node.js (Express + WebSocket) server that drives the three-screen wall. This folder builds into the Docker image.

## Run locally
```bash
npm install
npm start   # defaults HOST=0.0.0.0 PORT=8088 WS path /ws
```
Environment overrides: `PORT`, `HOST`, `PUBLIC_URL`, `DEVICE_STALE_MS` (ms before a device is considered offline).

## Docker
```bash
npm install --production
docker compose up -d --build    # uses docker-compose.yml, mounts ./data and ./public
```

## APIs
- `GET /api/ping` simple health
- `GET /api/status` version + uptime + counts
- `GET /api/devices` list online devices
- `POST /api/broadcast` { programId?, startAtUtcMs?, loop?, screens? }
- `POST /api/stop` stop playback
- `POST /api/power` { action }
- `POST /api/upload` multipart `file` -> auto-slice 6000x1920 into L/C/R
- `GET /api/programs` / `GET /api/programs/:id`
- `POST /api/programs/:id/broadcast` broadcast a program
- `GET /api/schedule` list entries
- `POST /api/schedule` create { programId, startAtUtcMs, loop }
- `DELETE /api/schedule/:id` remove entry

Media is exposed at `/media/<programId>/left|center|right.<ext>` and includes `checksum` for client-side cache verification.

## WebSocket messages
- server -> client: `welcome|synctime { serverTime }`, `play { programId,startAtUtcMs,loop,screens }`, `stop`, `power { action }`
- client -> server: `hello { deviceId, role }`, `ping` (JSON) or WebSocket ping frame

## Frontend
`public/index.html` provides upload, program list, and manual broadcast tooling.
