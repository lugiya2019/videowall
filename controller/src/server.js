import express from "express";
import cors from "cors";
import morgan from "morgan";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import url from "url";
import crypto from "crypto";
import { spawnSync } from "child_process";
import multer from "multer";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.PUBLIC_URL || ""; // optional override for generated URLs
const DATA_DIR = path.join(__dirname, "..", "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const PROGRAMS_FILE = path.join(DATA_DIR, "programs.json");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedule.json");

ensureDir(DATA_DIR);
ensureDir(UPLOAD_DIR);
ensureDir(MEDIA_DIR);

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(morgan("dev"));

// static assets
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.use("/media", express.static(MEDIA_DIR));
app.use("/data", express.static(DATA_DIR));

// device registry
const devices = new Map(); // deviceId -> { ws, role, lastSeen }

// program & schedule persistence
let programs = loadJson(PROGRAMS_FILE, []);
let schedules = loadJson(SCHEDULE_FILE, []);
const scheduleTimers = new Map(); // scheduleId -> timeout

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

// broadcast simple or program-based play command
app.post("/api/broadcast", (req, res) => {
  const { programId = "manual", startAtUtcMs = Date.now() + 5000, loop = true } = req.body || {};
  let { screens } = req.body || {};
  if (!screens && programId) {
    const program = programs.find((p) => p.id === programId);
    if (!program) return res.status(404).json({ error: "program not found" });
    screens = program.slices;
  }
  if (!screens) return res.status(400).json({ error: "screens missing" });
  const payload = { type: "play", programId, startAtUtcMs, loop, screens };
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

// upload & auto-crop 6000x1920 -> three slices
const upload = multer({ dest: UPLOAD_DIR });
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file missing" });
  try {
    const program = await processUpload(req.file);
    programs = upsertProgram(programs, program);
    saveJson(PROGRAMS_FILE, programs);
    res.json({ ok: true, program });
  } catch (err) {
    console.error("upload error", err);
    res.status(500).json({ error: err.message || "process failed" });
  }
});

app.get("/api/programs", (_, res) => {
  res.json({ programs });
});

app.get("/api/programs/:id", (req, res) => {
  const program = programs.find((p) => p.id === req.params.id);
  if (!program) return res.status(404).json({ error: "not found" });
  res.json({ program });
});

app.post("/api/programs/:id/broadcast", (req, res) => {
  const program = programs.find((p) => p.id === req.params.id);
  if (!program) return res.status(404).json({ error: "not found" });
  const startAtUtcMs = req.body.startAtUtcMs || Date.now() + 5000;
  const loop = req.body.loop ?? true;
  const payload = { type: "play", programId: program.id, startAtUtcMs, loop, screens: program.slices };
  broadcast(payload);
  res.json({ ok: true, startAtUtcMs });
});

// simple schedule queue
app.get("/api/schedule", (_, res) => res.json({ schedules, serverTime: Date.now() }));

app.post("/api/schedule", (req, res) => {
  const { programId, startAtUtcMs, loop = true } = req.body || {};
  if (!programId || !startAtUtcMs) return res.status(400).json({ error: "programId and startAtUtcMs required" });
  if (!programs.find((p) => p.id === programId)) return res.status(404).json({ error: "program not found" });
  const id = `sch_${Date.now()}`;
  const entry = { id, programId, startAtUtcMs, loop, createdAt: Date.now() };
  schedules.push(entry);
  saveJson(SCHEDULE_FILE, schedules);
  scheduleEntry(entry);
  res.json({ ok: true, entry });
});

app.delete("/api/schedule/:id", (req, res) => {
  schedules = schedules.filter((s) => s.id !== req.params.id);
  cancelSchedule(req.params.id);
  saveJson(SCHEDULE_FILE, schedules);
  res.json({ ok: true });
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

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function upsertProgram(list, program) {
  const i = list.findIndex((p) => p.id === program.id);
  if (i >= 0) {
    const copy = [...list];
    copy[i] = program;
    return copy;
  }
  return [...list, program];
}

async function processUpload(file) {
  const programId = path.parse(file.originalname).name.replace(/\W+/g, "_") + "_" + Date.now();
  const ext = path.extname(file.originalname).toLowerCase() || ".mp4";
  const destDir = path.join(MEDIA_DIR, programId);
  ensureDir(destDir);

  const outputs = {
    left: path.join(destDir, `left${ext}`),
    center: path.join(destDir, `center${ext}`),
    right: path.join(destDir, `right${ext}`),
  };

  // crop using ffmpeg
  runFfmpeg(file.path, outputs.left, "crop=1080:1920:0:0");
  runFfmpeg(file.path, outputs.center, "crop=3840:1920:1080:0");
  runFfmpeg(file.path, outputs.right, "crop=1080:1920:4920:0");

  const slices = {};
  for (const role of ["left", "center", "right"]) {
    const fp = outputs[role];
    const checksum = sha256File(fp);
    const size = fs.statSync(fp).size;
    const urlPath = `/media/${programId}/${role}${ext}`;
    const fullUrl = BASE_URL ? `${BASE_URL}${urlPath}` : urlPath;
    slices[role] = { url: fullUrl, checksum, size, effect: "fade", audio: role === "center" };
  }

  // cleanup upload temp
  fs.unlink(file.path, () => {});

  return {
    id: programId,
    title: file.originalname,
    createdAt: Date.now(),
    sourceFile: file.originalname,
    slices,
  };
}

function runFfmpeg(input, output, filter) {
  const args = ["-i", input, "-y", "-vf", filter, output];
  const res = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error("ffmpeg failed for " + output);
  }
}

function sha256File(fp) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(fp));
  return hash.digest("hex");
}

function scheduleEntry(entry) {
  const delay = entry.startAtUtcMs - Date.now();
  if (delay < 0) return; // expired
  const timer = setTimeout(() => {
    const program = programs.find((p) => p.id === entry.programId);
    if (program) {
      broadcast({ type: "play", programId: program.id, startAtUtcMs: entry.startAtUtcMs, loop: entry.loop, screens: program.slices });
    }
    cancelSchedule(entry.id);
  }, delay);
  scheduleTimers.set(entry.id, timer);
}

function cancelSchedule(id) {
  if (scheduleTimers.has(id)) {
    clearTimeout(scheduleTimers.get(id));
    scheduleTimers.delete(id);
  }
}

function resumeSchedule() {
  schedules.forEach((entry) => scheduleEntry(entry));
}

resumeSchedule();

server.listen(PORT, HOST, () => {
  console.log(`Controller listening on http://${HOST}:${PORT}`);
});
