import express from "express";
import cors from "cors";
import morgan from "morgan";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(morgan("dev"));

// simple in-memory device registry
const devices = new Map(); // deviceId -> { ws, role, lastSeen }

// serve static files (front-end will be in public)
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

app.get("/api/ping", (_, res) => {
  res.json({ ok: true, serverTime: Date.now() });
});

app.get("/api/devices", (_, res) => {
  const list = Array.from(devices.entries()).map(([id, info]) => ({
    id,
    role: info.role,
    lastSeen: info.lastSeen,
    online: info.ws.readyState === 1,
  }));
  res.json({ devices: list, serverTime: Date.now() });
});

// broadcast simple play command
app.post("/api/broadcast", (req, res) => {
  const { programId = "manual", startAtUtcMs = Date.now() + 5000, loop = true, screens } = req.body || {};
  if (!screens) return res.status(400).json({ error: "screens missing" });
  const payload = {
    type: "play",
    programId,
    startAtUtcMs,
    loop,
    screens,
  };
  broadcast(payload);
  res.json({ ok: true, sentTo: devices.size, startAtUtcMs });
});

app.post("/api/stop", (_, res) => {
  broadcast({ type: "stop" });
  res.json({ ok: true });
});

app.post("/api/power", (req, res) => {
  const { action = "sleep" } = req.body || {};
  broadcast({ type: "power", action });
  res.json({ ok: true, action });
});

// WebSocket setup
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "welcome", serverTime: Date.now() }));

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      console.error("WS parse error", err);
      return;
    }

    if (msg.type === "hello") {
      const { deviceId, role = "center" } = msg;
      if (!deviceId) return;
      devices.set(deviceId, { ws, role, lastSeen: Date.now() });
      console.log(`device online: ${deviceId} (${role})`);
      ws.send(JSON.stringify({ type: "synctime", serverTime: Date.now() }));
    }

    if (msg.type === "ping") {
      if (msg.deviceId && devices.has(msg.deviceId)) {
        const info = devices.get(msg.deviceId);
        info.lastSeen = Date.now();
      }
      ws.send(JSON.stringify({ type: "pong", serverTime: Date.now() }));
    }
  });

  ws.on("close", () => {
    // cleanup disconnected devices
    for (const [id, info] of devices.entries()) {
      if (info.ws === ws) devices.delete(id);
    }
  });
});

function broadcast(obj) {
  const str = JSON.stringify(obj);
  for (const [id, info] of devices.entries()) {
    if (info.ws.readyState === 1) {
      info.ws.send(str);
    }
  }
}

server.listen(PORT, () => {
  console.log(`Controller listening on http://0.0.0.0:${PORT}`);
});
