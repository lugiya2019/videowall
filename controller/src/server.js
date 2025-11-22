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
import dgram from "dgram";
import os from "os";
// (optional) compression uses system tar; no extra deps

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8088;
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.PUBLIC_URL || ""; // optional override for generated URLs
const DATA_DIR = path.join(__dirname, "..", "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const PACKAGES_DIR = path.join(DATA_DIR, "packages");
const PROGRAMS_FILE = path.join(DATA_DIR, "programs.json");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedule.json");
const CLIENTS_FILE = path.join(DATA_DIR, "clients.json");
const APK_MANIFEST_FILE = path.join(__dirname, "..", "public", "apk", "manifest.json");
const PKG = loadJson(path.join(__dirname, "..", "package.json"), {});
const SERVER_START = Date.now();
const DEVICE_STALE_MS = Number(process.env.DEVICE_STALE_MS || 120000);
const READY_TIMEOUT_MS = 12000;
const START_DELAY_MS = 2000;
const DISCOVERY_PORT = 47888;
const CANVAS_W = 6000;
const CANVAS_H = 1920;
const EFFECTS = ["fade", "slide", "zoom", "push", "wipe"];

ensureDir(DATA_DIR);
ensureDir(UPLOAD_DIR);
ensureDir(MEDIA_DIR);
ensureDir(PACKAGES_DIR);

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(morgan("dev"));

// static assets
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));
app.use("/media", express.static(MEDIA_DIR));
app.use("/data", express.static(DATA_DIR));

// device registry
const devices = new Map(); // deviceId -> { ws, role, lastSeen }

// program & schedule persistence
let programs = loadJson(PROGRAMS_FILE, []);
let schedules = loadJson(SCHEDULE_FILE, []);
let clientIps = loadJson(CLIENTS_FILE, { left: "", center: "", right: "" });
let apkManifest = loadJson(APK_MANIFEST_FILE, { version: PKG.version || "0.0.0", files: {} });
const scheduleTimers = new Map(); // scheduleId -> timeout
const pendingPlays = new Map(); // playId -> { screens, ready:Set, timer }

app.get("/api/ping", (_, res) => {
  res.json({ ok: true, serverTime: Date.now() });
});

app.get("/api/status", (_, res) => {
  const onlineDevices = Array.from(devices.values()).filter((d) => d.ws.readyState === 1).length;
  res.json({
    ok: true,
    name: PKG.name || "videowall-controller",
    version: PKG.version || "dev",
    serverTime: Date.now(),
    uptimeMs: Date.now() - SERVER_START,
    devices: { total: devices.size, online: onlineDevices },
    programs: programs.length,
    schedules: schedules.length,
    apk: apkManifest,
  });
});

app.get("/api/devices", (_, res) => {
  const list = Array.from(devices.entries()).map(([id, info]) => ({
    id,
    role: info.role,
    lastSeen: info.lastSeen,
    ip: info.ip,
    online: info.ws.readyState === 1,
  }));
  res.json({ devices: list, serverTime: Date.now() });
});

// client ip config
app.get("/api/client-ips", (_, res) => {
  res.json({ clientIps });
});

app.post("/api/client-ips", (req, res) => {
  const { left = "", center = "", right = "" } = req.body || {};
  clientIps = {
    left: String(left || "").trim(),
    center: String(center || "").trim(),
    right: String(right || "").trim(),
  };
  saveJson(CLIENTS_FILE, clientIps);
  res.json({ ok: true, clientIps });
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
  screens = applyUnifiedEffect(screens);
  const playId = queuePlay({ programId, startAtUtcMs, loop, screens });
  res.json({ ok: true, sentTo: devices.size, startAtUtcMs, playId });
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
  const mode = (req.body?.mode || "cover").toLowerCase(); // cover|contain|stretch
  try {
    const program = await processUpload(req.file, mode);
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

// package program to local bundle (all slices copied under data/packages/<id>)
app.get("/api/programs/:id/package", (req, res) => {
  const program = programs.find((p) => p.id === req.params.id);
  if (!program) return res.status(404).json({ error: "not found" });
  try {
    const pkg = buildLocalPackage(program);
    res.json({ ok: true, package: pkg });
  } catch (e) {
    console.error("package error", e);
    res.status(500).json({ error: e.message || "package failed" });
  }
});

// save custom program (manual editor)
app.post("/api/programs/custom", (req, res) => {
  const { id, title, slices } = req.body || {};
  if (!id || !slices) return res.status(400).json({ error: "id and slices required" });
  const program = {
    id,
    title: title || id,
    createdAt: Date.now(),
    sourceFile: "custom",
    slices,
  };
  programs = upsertProgram(programs, program);
  saveJson(PROGRAMS_FILE, programs);
  res.json({ ok: true, program });
});

app.post("/api/programs/reload", (_req, res) => {
  programs = loadJson(PROGRAMS_FILE, []);
  res.json({ ok: true, count: programs.length });
});

app.get("/api/apk-manifest", (_, res) => {
  res.json({ apk: apkManifest });
});

app.post("/api/programs/:id/broadcast", (req, res) => {
  const program = programs.find((p) => p.id === req.params.id);
  if (!program) return res.status(404).json({ error: "not found" });
  const startAtUtcMs = req.body.startAtUtcMs || Date.now() + 5000;
  const loop = req.body.loop ?? true;
  const playId = queuePlay({ type: "play", programId: program.id, startAtUtcMs, loop, screens: applyUnifiedEffect(program.slices) });
  res.json({ ok: true, startAtUtcMs, playId });
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
wss.on("connection", (ws, req) => {
  const ip = (req?.socket?.remoteAddress || req?.connection?.remoteAddress || "").replace("::ffff:", "");

  ws.send(JSON.stringify({ type: "welcome", serverTime: Date.now(), apk: apkManifest }));

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
      devices.set(deviceId, { ws, role, lastSeen: Date.now(), ip });
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

    if (msg.type === "ready") {
      const { playId, role } = msg;
      if (playId && role) markReady(playId, role);
    }
  });

  ws.on("ping", () => touchDevice(ws));

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

function queuePlay({ programId = "manual", startAtUtcMs = Date.now() + 5000, loop = true, screens = {} }) {
  const playId = `play_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payload = { type: "play", playId, programId, startAtUtcMs, loop, screens };
  const ready = new Set();
  const timer = setTimeout(() => forceStart(playId), READY_TIMEOUT_MS);
  pendingPlays.set(playId, { screens, ready, timer });
  broadcast(payload);
  return playId;
}

function applyUnifiedEffect(screens) {
  const effect = Object.values(screens)[0]?.effect || randomEffect();
  const unified = {};
  for (const role of Object.keys(screens)) {
    unified[role] = { ...screens[role], effect: screens[role].effect || effect };
  }
  return unified;
}

function randomEffect() {
  return EFFECTS[Math.floor(Math.random() * EFFECTS.length)] || "fade";
}

function forceStart(playId) {
  const entry = pendingPlays.get(playId);
  if (!entry) return;
  sendStart(playId);
}

function markReady(playId, role) {
  const entry = pendingPlays.get(playId);
  if (!entry) return;
  entry.ready.add(role);
  const needed = Object.keys(entry.screens || {});
  if (needed.length && needed.every((r) => entry.ready.has(r))) {
    sendStart(playId);
  }
}

function sendStart(playId) {
  const entry = pendingPlays.get(playId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingPlays.delete(playId);
  const startAtUtcMs = Date.now() + START_DELAY_MS;
  broadcast({ type: "start", playId, startAtUtcMs });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function touchDevice(ws) {
  for (const info of devices.values()) {
    if (info.ws === ws) {
      info.lastSeen = Date.now();
      break;
    }
  }
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

async function processUpload(file, mode = "cover") {
  const programId = path.parse(file.originalname).name.replace(/\W+/g, "_") + "_" + Date.now();
  const isImage = file.mimetype?.startsWith("image/");
  const origExt = (path.extname(file.originalname) || "").toLowerCase();
  const normExt = isImage ? ".png" : ".mp4";
  const sliceExt = isImage ? ".png" : (origExt || ".mp4");
  const destDir = path.join(MEDIA_DIR, programId);
  ensureDir(destDir);

  const normalized = path.join(destDir, `normalized${normExt}`);
  buildNormalized(file.path, normalized, mode, isImage);

  const outputs = {
    left: path.join(destDir, `left${sliceExt}`),
    center: path.join(destDir, `center${sliceExt}`),
    right: path.join(destDir, `right${sliceExt}`),
  };

  runFfmpeg(normalized, outputs.left, "crop=1080:1920:0:0", isImage);
  runFfmpeg(normalized, outputs.center, "crop=3840:1920:1080:0", isImage);
  runFfmpeg(normalized, outputs.right, "crop=1080:1920:4920:0", isImage);

  const previews = {
    left: path.join(destDir, "preview-left.png"),
    center: path.join(destDir, "preview-center.png"),
    right: path.join(destDir, "preview-right.png"),
  };
  createPreview(outputs.left, previews.left, isImage);
  createPreview(outputs.center, previews.center, isImage);
  createPreview(outputs.right, previews.right, isImage);

  const slices = {};
  for (const role of ["left", "center", "right"]) {
    const fp = outputs[role];
    const checksum = sha256File(fp);
    const size = fs.statSync(fp).size;
    const urlPath = `/media/${programId}/${role}${sliceExt}`;
    const prevPath = `/media/${programId}/preview-${role}.png`;
    const fullUrl = BASE_URL ? `${BASE_URL}${urlPath}` : urlPath;
    const prevUrl = BASE_URL ? `${BASE_URL}${prevPath}` : prevPath;
    slices[role] = { url: fullUrl, checksum, size, effect: "fade", audio: !isImage && role === "center", preview: prevUrl };
  }

  // cleanup temp upload
  fs.unlink(file.path, () => {});

  return {
    id: programId,
    title: file.originalname,
    createdAt: Date.now(),
    sourceFile: file.originalname,
    mode,
    slices,
  };
}

function buildNormalized(input, output, mode, isImage) {
  const filters = [];
  if (mode === "stretch") {
    filters.push(`scale=${CANVAS_W}:${CANVAS_H}`);
  } else if (mode === "contain") {
    filters.push(`scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease`);
    filters.push(`pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:black`);
  } else {
    // cover (crop)
    filters.push(`scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase`);
    filters.push(`crop=${CANVAS_W}:${CANVAS_H}`);
  }
  runFfmpeg(input, output, filters.join(","), isImage);
}

function runFfmpeg(input, output, filter, isImage) {
  const args = ["-i", input, "-y", "-vf", filter];
  if (isImage) {
    args.push("-frames:v", "1");
  }
  args.push(output);
  const res = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error("ffmpeg failed for " + output);
  }
}

function createPreview(input, output, isImage) {
  if (isImage) {
    fs.copyFileSync(input, output);
    return;
  }
  const args = ["-i", input, "-y", "-vframes", "1", "-q:v", "2", output];
  const res = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error("ffmpeg preview failed for " + output);
  }
}

function buildLocalPackage(program) {
  const dir = path.join(PACKAGES_DIR, program.id);
  ensureDir(dir);
  const manifest = { id: program.id, title: program.title, createdAt: program.createdAt, slices: {} };
  for (const role of Object.keys(program.slices || {})) {
    const slice = program.slices[role];
    const src = fileFromUrl(slice.url);
    if (!src || !fs.existsSync(src)) throw new Error(`slice missing for ${role}`);
    const ext = path.extname(src) || ".bin";
    const dest = path.join(dir, `${role}${ext}`);
    fs.copyFileSync(src, dest);
    manifest.slices[role] = {
      file: path.basename(dest),
      checksum: slice.checksum,
      size: fs.statSync(dest).size,
      effect: slice.effect,
      audio: slice.audio,
    };
  }
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const bundlePath = path.join(PACKAGES_DIR, `${program.id}.tar.gz`);
  createTarGz(dir, bundlePath);
  return { path: dir, manifest: manifestPath, bundle: bundlePath };
}

function fileFromUrl(urlStr) {
  if (!urlStr.startsWith("/media/")) return null;
  return path.join(DATA_DIR, urlStr.replace("/media/", "media/"));
}

function createTarGz(srcDir, outFile) {
  // prefer system tar for speed
  const tarRes = spawnSync("tar", ["-czf", outFile, "-C", srcDir, "."], { stdio: "inherit" });
  if (tarRes.status !== 0) {
    throw new Error("tar failed to create bundle");
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
      queuePlay({ programId: program.id, startAtUtcMs: entry.startAtUtcMs, loop: entry.loop, screens: program.slices });
    }
    cancelSchedule(entry.id);
    schedules = schedules.filter((s) => s.id !== entry.id);
    saveJson(SCHEDULE_FILE, schedules);
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

function startDiscoveryBeacon() {
  const socket = dgram.createSocket("udp4");
  socket.bind(() => {
    socket.setBroadcast(true);
    setInterval(() => {
      const wsHost = getLocalIp() || HOST;
      const msg = Buffer.from(JSON.stringify({ type: "vw-advertise", ws: `ws://${wsHost}:${PORT}/ws` }));
      socket.send(msg, 0, msg.length, DISCOVERY_PORT, "255.255.255.255", () => {});
    }, 5000);
  });
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === "IPv4" && !n.internal) return n.address;
    }
  }
  return null;
}

setInterval(cleanStaleDevices, Math.min(DEVICE_STALE_MS / 2, 30000));
function cleanStaleDevices() {
  const now = Date.now();
  for (const [id, info] of devices.entries()) {
    const stale = info.lastSeen && now - info.lastSeen > DEVICE_STALE_MS;
    const closed = info.ws.readyState !== 1;
    if (stale || closed) {
      try {
        info.ws.terminate();
      } catch (e) {
        // ignore
      }
      devices.delete(id);
    }
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Controller listening on http://${HOST}:${PORT}`);
  startDiscoveryBeacon();
});
