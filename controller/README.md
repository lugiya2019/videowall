# VideoWall Controller

## 运行
```bash
npm install
npm start   # 默认 0.0.0.0:8080, WS: /ws
```
环境可选：`PORT`、`HOST`、`PUBLIC_URL`

## Docker
```bash
npm install --production
docker compose up -d --build
```
`data/`、`public/` 会通过 Compose 挂载。

## API 概览
- `GET /api/ping` 健康检查
- `GET /api/devices` 在线设备
- `POST /api/broadcast` { programId?, startAtUtcMs?, loop?, screens? }
- `POST /api/stop` 停止
- `POST /api/power` { action }
- `POST /api/upload` multipart `file`，自动裁切生成节目
- `GET /api/programs` / `GET /api/programs/:id`
- `POST /api/programs/:id/broadcast` 下发指定节目
- `GET /api/schedule` 列表
- `POST /api/schedule` 创建排期 { programId, startAtUtcMs, loop }
- `DELETE /api/schedule/:id` 删除排期

生成的媒体静态路径：`/media/<programId>/left|center|right.<ext>`，同时返回 `checksum` 供客户端校验。

## WebSocket 消息
- 控制 -> 客户端：`welcome|synctime { serverTime }`，`play { programId,startAtUtcMs,loop,screens }`，`stop`，`power { action }`
- 客户端 -> 控制：`hello { deviceId, role }`，`ping`

## 前端
`public/index.html` 提供上传、节目列表、一键下发和排期管理。
