# VideoWall Controller (MVP)

## 快速运行
```bash
# 安装依赖
npm install
# 启动
npm start
```
默认端口 8080，浏览器访问 `http://<NAS-IP>:8080`。

## Docker Compose (群晖)
```bash
cd /volume1/videowall/controller
npm install --production
node src/server.js
```
或自行写 `Dockerfile` 挂载 `/data` 与 `public`。

## API 简述
- `GET /api/devices` 设备列表
- `POST /api/broadcast` 下发播放
- `POST /api/stop` 停止
- `POST /api/power` { action: sleep|wake|reboot }

## WebSocket 消息
- 控制端 → 客户端：`play`, `stop`, `power`
- 客户端 → 控制端：`hello {deviceId, role}`, `ping`

## 自带前端
`public/index.html` 为最小控制面板。
