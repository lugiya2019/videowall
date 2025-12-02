import express from "express";
import cors from "cors";
import morgan from "morgan";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import url from "url";
import crypto from "crypto";
import { spawnSync, spawn } from "child_process";
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
const EXTERNAL_MEDIA_DIR = path.resolve(__dirname, "..", "..", "media"); // repo-level media库
const PACKAGES_DIR = path.join(DATA_DIR, "packages");
const HLS_DIR = path.join(__dirname, "..", "public", "hls");
const PROGRAMS_FILE = path.join(DATA_DIR, "programs.json"); // legacy name
const PLAYLISTS_FILE = path.join(DATA_DIR, "playlists.json");
const PACKAGES_FILE = path.join(DATA_DIR, "packages.json");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedule.json");
const CLIENTS_FILE = path.join(DATA_DIR, "clients.json");
const MATERIALS_DIR = path.join(DATA_DIR, "materials");
const MATERIALS_FILE = path.join(DATA_DIR, "materials.json");
const APK_MANIFEST_FILE = path.join(__dirname, "..", "public", "apk", "manifest.json");
const APK_UPLOAD_DIR = path.join(DATA_DIR, "apk");
const PREVIEW_CACHE_DIR = path.join(DATA_DIR, "preview-cache");
const MEDIA_TAGS_FILE = path.join(DATA_DIR, "media-tags.json");
const TMP_DIR = path.join(DATA_DIR, "tmp-media");
const SNAPSHOT_DIR = path.join(__dirname, "..", "..", "snapshot");
const SNAPSHOT_LOG_DIR = path.join(SNAPSHOT_DIR, "logs");
const THUMB_DIR = path.join(DATA_DIR, "media-thumb"); // global fallback
const LOCAL_THUMB_DIR_NAME = ".thumbs"; // per-folder thumbs
const THUMB_JOBS = new Map(); // jobId -> status
const VIDEO_EXT = new Set([".mp4",".mov",".mkv",".webm",".avi",".m4v",".mpg",".mpeg"]);
const META_CACHE_LIMIT = 500;
// legacy duplicate declarations below; keep single canonical ones
const SUPPORTED_MEDIA_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg", ".webm",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic"
]);
const SAFE_MEDIA_EXT = new Set([
  ".mp4",".mov",".mkv",".webm",".avi",".m4v",".mpg",".mpeg",
  ".jpg",".jpeg",".png",".webp",".gif",".bmp",".tif",".tiff",".heic"
]);
const MEDIA_QUERY_LOG_FILE = path.join(DATA_DIR, "media-query-log.json");
const PKG = loadJson(path.join(__dirname, "..", "package.json"), {});
const SERVER_START = Date.now();
const DEVICE_STALE_MS = Number(process.env.DEVICE_STALE_MS || 120000);
const READY_TIMEOUT_MS = 12000;
const START_DELAY_MS = 2000;
const DISCOVERY_PORT = 47888;
const PREVIEW_RTSP = process.env.PREVIEW_RTSP || "rtsp://admin:Aabbcc123@192.168.12.107:554/stream1";
// 明显的彩条兜底，便于分辨拉流是否成功
const PREVIEW_FALLBACK = "testsrc=size=1920x1080:rate=25"; // ffmpeg lavfi source when 相机不可用
const HLS_TARGET = path.join(HLS_DIR, "preview.m3u8");
// Physical layout: left 1080x1920 (portrait), center 3840x1920 (4K width, cropped height), right 1080x1920
const WIDTH_LEFT = 1080;
const WIDTH_CENTER = 3840;
const WIDTH_RIGHT = 1080;
const CANVAS_W = WIDTH_LEFT + WIDTH_CENTER + WIDTH_RIGHT; // 6000
const CANVAS_H = 1920;
const CANVAS = { left: WIDTH_LEFT, center: WIDTH_CENTER, right: WIDTH_RIGHT, all: CANVAS_W };
const CENTER_H = CANVAS_H;
const EFFECTS = ["fade", "slide", "zoom", "push", "wipe"];
const VIEWPORT_MODES = new Set(["cover", "contain", "stretch", "fast"]);

ensureDir(DATA_DIR);
ensureDir(UPLOAD_DIR);
ensureDir(MEDIA_DIR);
ensureDir(EXTERNAL_MEDIA_DIR);
ensureDir(PACKAGES_DIR);
ensureDir(MATERIALS_DIR);
ensureDir(HLS_DIR);
ensureDir(TMP_DIR);
ensureDir(APK_UPLOAD_DIR);
ensureDir(PREVIEW_CACHE_DIR);
ensureDir(SNAPSHOT_DIR);
ensureDir(SNAPSHOT_LOG_DIR);
ensureDir(THUMB_DIR);
// 每个媒体目录的本地缩略图文件夹由任务按需创建
let sharpLib = null;
async function getSharp() {
  if (sharpLib !== null) return sharpLib;
  try {
    const mod = await import("sharp");
    sharpLib = mod.default || mod;
  } catch (e) {
    sharpLib = null;
  }
  return sharpLib;
}

function loadQueryLog() {
  try { return loadJson(MEDIA_QUERY_LOG_FILE, []); } catch (_) { return []; }
}
function saveQueryLog(list) {
  try { saveJson(MEDIA_QUERY_LOG_FILE, list.slice(-500)); } catch (_) {}
}

function getMetaPath(relDir = "") {
  const absDir = resolveMediaPath(relDir || "");
  ensureDir(path.join(absDir, LOCAL_THUMB_DIR_NAME));
  return path.join(absDir, LOCAL_THUMB_DIR_NAME, "meta.json");
}
function loadMeta(relDir = "") {
  try { return loadJson(getMetaPath(relDir), {}); } catch (_) { return {}; }
}
function saveMeta(relDir = "", meta = {}) {
  const pathMeta = getMetaPath(relDir);
  ensureDir(path.dirname(pathMeta));
  saveJson(pathMeta, meta);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(morgan("dev"));

// static assets
const publicDir = path.join(__dirname, "..", "public");
// 静态资源
app.use("/hls", express.static(HLS_DIR, { setHeaders: (res)=>{ res.setHeader("Cache-Control","no-store"); } }));
app.use(express.static(publicDir));
app.use("/media", express.static(MEDIA_DIR));
app.use("/ext-media", express.static(EXTERNAL_MEDIA_DIR));
app.use("/materials", express.static(MATERIALS_DIR));
app.use("/data", express.static(DATA_DIR));
app.use("/apk-upload", express.static(APK_UPLOAD_DIR));
app.use("/snapshot", express.static(SNAPSHOT_DIR));
app.use("/snapshot/logs", express.static(SNAPSHOT_LOG_DIR));
app.use("/data/preview-cache", express.static(PREVIEW_CACHE_DIR, {
  setHeaders: (res) => { res.setHeader("Cache-Control", "no-store"); }
}));
app.use("/ext-media", express.static(EXTERNAL_MEDIA_DIR, { setHeaders:(res)=>{ res.setHeader("Cache-Control","no-store"); } }));

// device registry
const devices = new Map(); // deviceId -> { ws, role, lastSeen }

// program & schedule persistence
// playlists store: { folders:[], playlists:[] }
function loadPlaylistStore() {
  const raw = loadJson(PLAYLISTS_FILE, null);
  const legacyArray = Array.isArray(raw) ? raw : null;
  let store = legacyArray ? { folders: [], playlists: legacyArray } : raw;
  if (!store || typeof store !== "object") store = { folders: [], playlists: [] };
  if (!Array.isArray(store.folders)) store.folders = [];
  if (!Array.isArray(store.playlists)) store.playlists = [];
  if (!store.folders.find((f) => f.id === "root")) {
    store.folders.unshift({ id: "root", name: "全部列表", createdAt: Date.now() });
  }
  store.playlists = store.playlists.map((p) => ({ ...p, folderId: p.folderId || "root" }));
  return store;
}
function savePlaylistStore(store) {
  saveJson(PLAYLISTS_FILE, store);
  saveJson(PROGRAMS_FILE, store.playlists); // legacy sync
}

function loadPackageStore() {
  const store = loadJson(PACKAGES_FILE, { folders: [{ id: "root", name: "全部节目包", createdAt: Date.now() }], packages: [] });
  if (!Array.isArray(store.folders)) store.folders = [{ id: "root", name: "全部节目包", createdAt: Date.now() }];
  if (!store.folders.find((f) => f.id === "root")) store.folders.unshift({ id: "root", name: "全部节目包", createdAt: Date.now() });
  if (!Array.isArray(store.packages)) store.packages = [];
  store.packages = store.packages.map((p) => ({ ...p, folderId: p.folderId || "root" }));
  return store;
}
function savePackageStore(store) {
  saveJson(PACKAGES_FILE, store);
}

let playlistStore = loadPlaylistStore();
let programs = playlistStore.playlists;
let playlistFolders = playlistStore.folders;
let packageStore = loadPackageStore();
// merge packages from filesystem on start
packageStore.packages = mergePackages(packageStore.packages, scanPackagesFromFs());
savePackageStore(packageStore);
let schedules = loadJson(SCHEDULE_FILE, []);
let clientIps = loadJson(CLIENTS_FILE, { left: "", center: "", right: "" });
let materialsDb = loadJson(MATERIALS_FILE, { folders: [], materials: [] });
let mediaTags = loadJson(MEDIA_TAGS_FILE, {});
if (!Array.isArray(materialsDb.folders)) materialsDb.folders = [];
if (!Array.isArray(materialsDb.materials)) materialsDb.materials = [];
if (!materialsDb.folders.find((f) => f.id === "root")) {
  materialsDb.folders.unshift({ id: "root", name: "全部素材", createdAt: Date.now() });
}
materialsDb.materials = materialsDb.materials.map((m) => ({
  ...m,
  folderId: m.folderId || "root",
  tags: Array.isArray(m.tags) ? m.tags : [],
}));
let apkManifest = loadJson(APK_MANIFEST_FILE, { version: PKG.version || "0.0.0", files: {} });
const scheduleTimers = new Map(); // scheduleId -> timeout
const pendingPlays = new Map(); // playId -> { screens, ready:Set, timer }
const pendingStarts = new Map(); // playId -> { timer, startAtUtcMs }

app.get("/api/ping", (_, res) => {
  res.json({ ok: true, serverTime: Date.now() });
});

// 媒体标签管理
app.get("/api/media-tags", (_req, res) => {
  res.json({ tags: mediaTags });
});

app.patch("/api/media-tags", (req, res) => {
  const { path: relPath = "", tags = [] } = req.body || {};
  let abs;
  try { abs = resolveMediaPath(relPath); } catch (e) { return res.status(400).json({ error: "invalid path" }); }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: "file not found" });
  const cleanTags = Array.isArray(tags) ? tags.map((t)=>String(t).trim()).filter(Boolean) : [];
  const key = toPosix(relPath);
  if (cleanTags.length) mediaTags[key] = cleanTags;
  else delete mediaTags[key];
  saveJson(MEDIA_TAGS_FILE, mediaTags);
  res.json({ ok: true, tags: mediaTags[key] || [] });
});

// 媒体文件管理
const mediaUpload = multer({ dest: path.join(DATA_DIR, "tmp-media") });
const snapshotUpload = multer({ dest: SNAPSHOT_DIR });
const logUpload = multer({ dest: SNAPSHOT_LOG_DIR });

app.post("/api/media/folder", (req, res) => {
  const { parent = "", name = "" } = req.body || {};
  const safeName = String(name).trim();
  if (!safeName) return res.status(400).json({ error: "name required" });
  let dir;
  try { dir = resolveMediaPath(path.join(parent || "", safeName)); } catch (_) { return res.status(400).json({ error: "invalid path" }); }
  if (fs.existsSync(dir)) return res.status(400).json({ error: "already exists" });
  fs.mkdirSync(dir, { recursive: true });
  res.json({ ok: true });
});

app.patch("/api/media/folder", (req, res) => {
  const { path: relPath = "", name = "" } = req.body || {};
  const safeName = String(name).trim();
  if (!safeName) return res.status(400).json({ error: "name required" });
  let abs;
  try { abs = resolveMediaPath(relPath); } catch (_) { return res.status(400).json({ error: "invalid path" }); }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return res.status(404).json({ error: "folder not found" });
  const target = path.join(path.dirname(abs), safeName);
  if (!isSubPath(EXTERNAL_MEDIA_DIR, target)) return res.status(400).json({ error: "invalid target" });
  if (fs.existsSync(target)) return res.status(400).json({ error: "target exists" });
  fs.renameSync(abs, target);
  res.json({ ok: true });
});

app.delete("/api/media/folder", (req, res) => {
  const { path: relPath = "" } = req.body || {};
  let abs;
  try { abs = resolveMediaPath(relPath); } catch (_) { return res.status(400).json({ error: "invalid path" }); }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return res.status(404).json({ error: "folder not found" });
  const files = fs.readdirSync(abs);
  if (files.length) return res.status(400).json({ error: "folder not empty" });
  fs.rmdirSync(abs);
  res.json({ ok: true });
});

app.delete("/api/media/file", (req, res) => {
  const { path: relPath = "" } = req.body || {};
  let abs;
  try { abs = resolveMediaPath(relPath); } catch (_) { return res.status(400).json({ error: "invalid path" }); }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: "file not found" });
  fs.unlinkSync(abs);
  delete mediaTags[toPosix(relPath)];
  saveJson(MEDIA_TAGS_FILE, mediaTags);
  res.json({ ok: true });
});

app.patch("/api/media/file", (req, res) => {
  const { path: relPath = "", name, targetDir = "" } = req.body || {};
  let abs;
  try { abs = resolveMediaPath(relPath); } catch (_) { return res.status(400).json({ error: "invalid path" }); }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: "file not found" });
  const ext = path.extname(abs);
  const origName = path.basename(abs);
  const safeName = name === undefined ? origName : String(name).trim();
  if (!safeName) return res.status(400).json({ error: "name required" });
  const base = safeName.endsWith(ext) ? safeName.slice(0, -ext.length) : safeName;
  const targetName = `${base}${ext}`;

  let destDir;
  try { destDir = targetDir ? resolveMediaPath(targetDir) : path.dirname(abs); } catch (_) { return res.status(400).json({ error: "invalid target dir" }); }
  if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) return res.status(404).json({ error: "target folder not found" });

  const target = path.join(destDir, targetName);
  if (!isSubPath(EXTERNAL_MEDIA_DIR, target)) return res.status(400).json({ error: "invalid target" });
  if (fs.existsSync(target)) return res.status(400).json({ error: "target exists" });
  fs.renameSync(abs, target);
  // move tags
  const key = toPosix(relPath);
  const newKey = toPosix(path.relative(EXTERNAL_MEDIA_DIR, target));
  if (mediaTags[key]) {
    mediaTags[newKey] = mediaTags[key];
    delete mediaTags[key];
    saveJson(MEDIA_TAGS_FILE, mediaTags);
  }
  res.json({ ok: true, path: newKey });
});

app.post("/api/media/upload", mediaUpload.single("file"), (req, res) => {
  const { dir = "" } = req.body || {};
  if (!req.file) return res.status(400).json({ error: "file missing" });
  let destDir;
  try { destDir = resolveMediaPath(dir); } catch (_) { return res.status(400).json({ error: "invalid dir" }); }
  ensureDir(destDir);
  const ext = path.extname(req.file.originalname) || "";
  if (!SUPPORTED_MEDIA_EXT.has(ext.toLowerCase())) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "unsupported type" });
  }
  const target = path.join(destDir, req.file.originalname);
  fs.renameSync(req.file.path, target);
  res.json({ ok: true, path: toPosix(path.relative(EXTERNAL_MEDIA_DIR, target)) });
});

// 媒体信息
app.get("/api/media/info", (req, res) => {
  const rel = req.query.path || "";
  try {
    const info = probeMedia(String(rel));
    if (!info.ok) {
      // 仍返回基础信息，前端可降级显示
      return res.json({ ok: true, info });
    }
    res.json({ ok: true, info });
  } catch (e) {
    res.status(400).json({ ok: false, error: "invalid path" });
  }
});

// 图片预览（用于浏览器不支持的格式，如 TIFF）
app.get("/api/media/preview", async (req, res) => {
  const relPath = req.query.path || "";
  let abs;
  try { abs = resolveMediaPath(relPath); } catch (_) { return res.status(400).json({ error: "invalid path" }); }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: "not found" });
  const stat = fs.statSync(abs);
  const sig = crypto.createHash("md5").update(`${relPath}:${stat.mtimeMs}:${stat.size}`).digest("hex").slice(0, 16);
  const outPath = path.join(TMP_DIR, `preview-${sig}.png`);
  if (fs.existsSync(outPath)) {
    return res.sendFile(outPath);
  }
  const ext = path.extname(abs).toLowerCase();
  // 优先使用 sharp（适合大尺寸/多页 tiff），若缺失则退回 ffmpeg
  const sharp = await getSharp();
  if (sharp && (ext === ".tif" || ext === ".tiff" || ext === ".heic" || ext === ".heif")) {
    try {
      await sharp(abs, { limitInputPixels: 1024 * 1024 * 512 }) // up to ~512MP
        .rotate()
        .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
        .png()
        .toFile(outPath);
      return res.sendFile(outPath);
    } catch (e) {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      // fallthrough to ffmpeg
    }
  }
  try {
    const ffmpegBin = resolveFfmpeg();
    const result = spawnSync(ffmpegBin, [
      "-y",
      "-i", abs,
      "-frames:v", "1",
      "-vf", "scale='min(1800,iw)':'min(1800,ih)'",
      "-loglevel", "error",
      outPath,
    ], { encoding: "utf-8" });
    if (result.status !== 0) {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      return res.status(500).json({ error: result.stderr || "ffmpeg failed" });
    }
    return res.sendFile(outPath);
  } catch (e) {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    return res.status(500).json({ error: e.message || "preview failed" });
  }
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

// Material library: upload / list / rename / delete
const materialUpload = multer({ dest: MATERIALS_DIR });

app.get("/api/materials", (_req, res) => {
  const folderId = _req.query.folderId || "";
  const list = materialsDb.materials.filter((m) =>
    folderId
      ? folderId === "root"
        ? true // 根视图包含全部素材
        : m.folderId === folderId
      : true
  );
  res.json({ materials: list, folders: materialsDb.folders });
});

app.post("/api/materials", materialUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file missing" });
  let { folderId = "root", tags = [] } = req.body || {};
  if (typeof tags === "string") {
    tags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  const ext = path.extname(req.file.originalname || "").toLowerCase();
  const safeName = path.basename(req.file.originalname || "material").replace(/[^\w.\-]+/g, "_");
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext || ""}`;
  const target = path.join(MATERIALS_DIR, filename);
  fs.renameSync(req.file.path, target);
  const item = {
    id: crypto.randomBytes(8).toString("hex"),
    name: safeName.replace(ext, "") || "素材",
    filename,
    size: req.file.size,
    mime: req.file.mimetype,
    url: path.posix.join("/materials", filename),
    uploadedAt: Date.now(),
    folderId: materialsDb.folders.find((f) => f.id === folderId) ? folderId : "root",
    tags: Array.isArray(tags) ? tags : [],
  };
  materialsDb.materials.unshift(item);
  saveJson(MATERIALS_FILE, materialsDb);
  res.json({ ok: true, material: item });
});

app.patch("/api/materials/:id", (req, res) => {
  const m = materialsDb.materials.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "not found" });
  let { name = "", folderId, tags } = req.body || {};
  m.name = String(name || m.name || "").trim() || m.name;
  if (folderId && materialsDb.folders.find((f) => f.id === folderId)) m.folderId = folderId;
  if (typeof tags === "string") {
    tags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (Array.isArray(tags)) m.tags = tags.map((t) => String(t).trim()).filter(Boolean);
  saveJson(MATERIALS_FILE, materialsDb);
  res.json({ ok: true, material: m });
});

app.delete("/api/materials/:id", (req, res) => {
  const idx = materialsDb.materials.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const [m] = materialsDb.materials.splice(idx, 1);
  try {
    fs.unlinkSync(path.join(MATERIALS_DIR, m.filename));
  } catch (_) {
    // ignore
  }
  saveJson(MATERIALS_FILE, materialsDb);
  res.json({ ok: true });
});

// folder management
app.post("/api/materials/folders", (req, res) => {
  const { name = "" } = req.body || {};
  const n = String(name).trim();
  if (!n) return res.status(400).json({ error: "name required" });
  const id = crypto.randomBytes(6).toString("hex");
  const folder = { id, name: n, createdAt: Date.now() };
  materialsDb.folders.push(folder);
  saveJson(MATERIALS_FILE, materialsDb);
  res.json({ ok: true, folder });
});

app.patch("/api/materials/folders/:id", (req, res) => {
  const folder = materialsDb.folders.find((f) => f.id === req.params.id);
  if (!folder) return res.status(404).json({ error: "not found" });
  if (folder.id === "root") return res.status(400).json({ error: "cannot rename root" });
  const { name = "" } = req.body || {};
  folder.name = String(name).trim() || folder.name;
  saveJson(MATERIALS_FILE, materialsDb);
  res.json({ ok: true, folder });
});

app.delete("/api/materials/folders/:id", (req, res) => {
  const { id } = req.params;
  if (id === "root") return res.status(400).json({ error: "cannot delete root" });
  const idx = materialsDb.folders.findIndex((f) => f.id === id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  materialsDb.folders.splice(idx, 1);
  // move materials to root
  materialsDb.materials = materialsDb.materials.map((m) => (m.folderId === id ? { ...m, folderId: "root" } : m));
  saveJson(MATERIALS_FILE, materialsDb);
  res.json({ ok: true });
});

// broadcast simple or program-based play command
app.post("/api/stop", (_, res) => {
  broadcast({ type: "stop" });
  res.json({ ok: true });
});

app.post("/api/power", (req, res) => {
  const { action = "sleep" } = req.body || {};
  broadcast({ type: "power", action });
  res.json({ ok: true, action });
});

// simple control panel actions
app.post("/api/control", (req, res) => {
  const action = String(req.body?.action || "").toLowerCase();
  const now = Date.now();
  const send = (obj) => broadcast(obj);
  switch (action) {
    case "pause":
      send({ type: "power", action: "sleep" });
      break;
    case "resume":
      send({ type: "power", action: "wake" });
      break;
    case "stop":
      send({ type: "stop" });
      break;
    case "sync":
      send({ type: "synctime", serverTime: now });
      break;
    case "next-program":
      send({ type: "control", action: "next-program" });
      break;
    case "prev-program":
      send({ type: "control", action: "prev-program" });
      break;
    case "next-item":
      send({ type: "control", action: "next-item" });
      break;
    case "prev-item":
      send({ type: "control", action: "prev-item" });
      break;
    case "snapshot":
      send({ type: "snapshot" });
      break;
    case "upload-log":
    case "logs":
      send({ type: "upload-log" });
      break;
    default:
      return res.status(400).json({ error: "unknown action" });
  }
  res.json({ ok: true, action, serverTime: now });
});

// quick play a program immediately (used by push upload)
app.post("/api/play-now", (req, res) => {
  const { programId, startAtUtcMs = Date.now() + 4000, loop = true } = req.body || {};
  if (!programId) return res.status(400).json({ error: "programId required" });
  const program = programs.find((p) => p.id === programId);
  if (!program) return res.status(404).json({ error: "program not found" });
  let screens = applyUnifiedEffect(program.slices);
  if (program.target && program.target !== "all") {
    screens = { __noFallback: true, [program.target]: screens[program.target] || { url: "" } };
  }
  const playId = queuePlay({ programId, startAtUtcMs, loop, screens });
  res.json({ ok: true, startAtUtcMs, playId });
});

// RTSP snapshot for live preview (single frame, jpeg)
app.get("/api/preview.jpg", (req, res) => {
  const ffmpegBin = resolveFfmpeg();
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "no-store");
  const args = [
    "-rtsp_transport", "tcp",
    "-i", PREVIEW_RTSP,
    "-frames:v", "1",
    "-vf", "scale=1280:-1",
    "-f", "mjpeg",
    "-",
  ];
  const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "inherit"] });
  const timeout = setTimeout(() => {
    proc.kill("SIGKILL");
  }, 8000);
  proc.stdout.pipe(res);
  proc.on("close", (code) => {
    clearTimeout(timeout);
    if (code !== 0 && !res.headersSent) {
      res.status(500).end();
    }
  });
  proc.on("error", () => {
    clearTimeout(timeout);
    if (!res.headersSent) res.status(500).end();
  });
});

// upload & auto-crop into 1080x1920 (L/R) + 3840x1920 (C) slices
const upload = multer({ dest: UPLOAD_DIR });
const uploadApk = multer({ dest: APK_UPLOAD_DIR });
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file missing" });
  const mode = (req.body?.mode || "cover").toLowerCase(); // cover|stretch
  const gap1 = req.body?.gap1 !== undefined ? Number(req.body.gap1) : 20;
  const gap2 = req.body?.gap2 !== undefined ? Number(req.body.gap2) : 20;
  const focusX = clamp01(Number(req.body?.focusX ?? 0.5));
  const focusY = clamp01(Number(req.body?.focusY ?? 0.5));
  const target = (req.body?.target || "all").toLowerCase(); // all|left|center|right
  try {
    const isImage = req.file.mimetype?.startsWith("image/");
    const program = (mode === "fast" && !isImage)
      ? await processUploadFast(req.file, mode, gap1, gap2, focusX, focusY, target)
      : await processUpload(req.file, mode === "fast" && isImage ? "cover" : mode, gap1, gap2, focusX, focusY, target);
    programs = upsertProgram(programs, program);
    playlistStore.playlists = programs;
    savePlaylistStore({ folders: playlistFolders, playlists: programs });
    res.json({ ok: true, program });
  } catch (err) {
    console.error("upload error", err);
    res.status(500).json({ error: err.message || "process failed" });
  }
});

app.get("/api/programs", (_, res) => {
  res.json({ programs, folders: playlistFolders });
});

// media tree for EXTERNAL_MEDIA_DIR (./media)
app.get("/api/media-tree", (req, res) => {
  try {
    const rel = req.query.path ? String(req.query.path) : "";
    const data = listMediaTree(rel);
    const tree = buildMediaTree(EXTERNAL_MEDIA_DIR);
    res.json({ ok: true, ...data, tree });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message || "list failed" });
  }
});

// 启动当前目录缩略图批量生成（后台任务）
app.post("/api/media/thumbs", (req, res) => {
  try {
    const rel = req.body?.path ? String(req.body.path) : "";
    const abs = resolveMediaPath(rel || "");
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) return res.status(400).json({ ok:false, error:"path is not a directory" });
    const entries = fs.readdirSync(abs, { withFileTypes:true }).filter(e => !e.name.startsWith(".") && e.isFile());
    const files = entries
      .filter(e => SUPPORTED_MEDIA_EXT.has(path.extname(e.name).toLowerCase()))
      .map(e => ({ name: e.name, rel: toPosix(path.join(rel || "", e.name)) }));
    const total = files.length;
    const folder = toPosix(rel || "");
    // 如果同一路径已有运行中的任务，直接复用
    const existing = [...THUMB_JOBS.values()].find(j => j.folder === folder && j.status === "running");
    if (existing) return res.json({ ok:true, jobId: existing.id, folder, total: existing.total, reused:true });
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const job = {
      id: jobId,
      folder,
      total,
      processed: 0,
      ready: 0,
      failed: 0,
      status: "running",
      startedAt: Date.now(),
      current: ""
    };
    THUMB_JOBS.set(jobId, job);
    res.json({ ok:true, jobId, folder, total });
    // 异步跑任务
    process.nextTick(async () => {
      for (const f of files) {
        job.current = f.name;
        try {
          const { thumbPath } = await ensureThumbnail(f.rel, { preferLocal: true, fallbackGlobal: false });
          if (thumbPath) job.ready++; else job.failed++;
        } catch (err) {
          console.error("batch thumb error", err);
          job.failed++;
        } finally {
          job.processed++;
        }
      }
      job.status = "done";
      job.finishedAt = Date.now();
      job.current = "";
      setTimeout(() => THUMB_JOBS.delete(jobId), 5 * 60 * 1000);
    });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message || "generate failed" });
  }
});

// 查询缩略图批量任务进度
app.get("/api/media/thumbs/status", (req, res) => {
  const id = req.query?.id ? String(req.query.id) : "";
  if (!id || !THUMB_JOBS.has(id)) return res.status(404).json({ ok:false, error:"job not found" });
  const job = THUMB_JOBS.get(id);
  res.json({ ok:true, ...job });
});

// media thumbnail (cache on disk)
app.get("/api/media/thumb", async (req, res) => {
  try {
    const rel = req.query.path ? String(req.query.path) : "";
    if (!rel) return res.status(400).json({ error: "path required" });
    const { thumbPath, type } = await ensureThumbnail(rel, { preferLocal: true, fallbackGlobal: true });
    if (!thumbPath) return res.status(404).json({ error: "cannot build thumb" });
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(thumbPath);
  } catch (e) {
    console.error("thumb error", e);
    res.status(400).json({ error: e.message || "thumb failed" });
  }
});

// 同步当前目录的缩略图（生成缺失、清理多余）
app.post("/api/media/thumbs/sync", async (req, res) => {
  try {
    const rel = req.body?.path ? String(req.body.path) : "";
    const result = await syncFolderThumbs(rel);
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message || "sync failed" });
  }
});

// 记录“查询”动作
app.post("/api/media/query-log", (req, res) => {
  try {
    const { path: rel = "", searchUrl = "", note = "" } = req.body || {};
    if (!rel) return res.status(400).json({ ok:false, error:"path required" });
    const list = loadQueryLog();
    list.push({
      path: toPosix(rel),
      searchUrl: String(searchUrl || ""),
      note: String(note || ""),
      at: Date.now()
    });
    saveQueryLog(list);
    res.json({ ok:true });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message || "log failed" });
  }
});

// 以图搜图（基于文件名的无 Key 查询）并写入目录 meta
app.post("/api/media/describe", async (req, res) => {
  try {
    const rel = req.body?.path ? String(req.body.path) : "";
    const limit = Math.max(1, Math.min(Number(req.body?.limit ?? 8), 50));
    const result = await describeFolder(rel, limit);
    res.json({ ok:true, ...result });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message || "describe failed" });
  }
});

// 读取目录 meta
app.get("/api/media/meta", (req, res) => {
  try {
    const rel = req.query?.path ? String(req.query.path) : "";
    res.json({ ok:true, meta: loadMeta(rel) });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message || "meta failed" });
  }
});

app.delete("/api/media", express.json(), (req, res) => {
  try {
    const rel = req.body?.path;
    if (!rel) return res.status(400).json({ ok:false, error:"path required" });
    const abs = resolveMediaPath(rel);
    if (fs.statSync(abs).isDirectory()) {
      fs.rmSync(abs, { recursive:true, force:true });
    } else {
      fs.unlinkSync(abs);
    }
    res.json({ ok:true });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message || "delete failed" });
  }
});

app.get("/api/programs/:id", (req, res) => {
  const program = programs.find((p) => p.id === req.params.id);
  if (!program) return res.status(404).json({ error: "not found" });
  res.json({ program });
});

// rename / retag program
app.patch("/api/programs/:id", (req, res) => {
  const program = programs.find((p) => p.id === req.params.id);
  if (!program) return res.status(404).json({ error: "not found" });
  const { title, tags, totalDurationSec, folderId } = req.body || {};
  if (title) program.title = String(title).trim() || program.title;
  if (Array.isArray(tags)) program.tags = tags;
  if (totalDurationSec !== undefined) program.totalDurationSec = totalDurationSec;
  if (folderId && playlistFolders.find((f) => f.id === folderId)) program.folderId = folderId;
  savePlaylistStore({ folders: playlistFolders, playlists: programs });
  res.json({ ok: true, program });
});

app.delete("/api/programs/:id", (req, res) => {
  const before = programs.length;
  programs = programs.filter((p) => p.id !== req.params.id);
  if (programs.length === before) return res.status(404).json({ error: "not found" });
  playlistStore.playlists = programs;
  savePlaylistStore({ folders: playlistFolders, playlists: programs });
  res.json({ ok: true });
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

// upload apk and broadcast update command
app.post("/api/apk/push", uploadApk.single("apk"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "apk missing" });
  const filename = req.file.originalname.replace(/[^\w.\-]/g, "_");
  const target = path.join(APK_UPLOAD_DIR, `${Date.now()}_${filename}`);
  fs.renameSync(req.file.path, target);
  const relPath = `/apk-upload/${path.basename(target)}`;
  const url = BASE_URL ? `${BASE_URL}${relPath}` : relPath;
  const checksum = sha256File(target);
  const roles = Array.isArray(req.body?.roles) ? req.body.roles.filter(Boolean) : (req.body?.roles ? [req.body.roles] : []);
  broadcast({ type: "updateApk", url, checksum }, roles.length ? roles : undefined);
  res.json({ ok: true, url, checksum, roles: roles.length ? roles : "all" });
});

// produce final show file from playlist with cropping
app.post("/api/programs/:id/produce", async (req, res) => {
  const program = programs.find((p) => p.id === req.params.id);
  if (!program) return res.status(404).json({ error: "not found" });
  const crop = req.body?.crop || { x: 0, y: 0, width: 1, height: 1 };
  try {
    const pkg = await producePlaylist(program, crop);
    program.produced = { at: Date.now(), crop };
    upsertPackageStore({
      id: `${program.id}-produce`,
      title: program.title || program.id,
      folderId: "root",
      createdAt: Date.now(),
      manifest: `/data/packages/${program.id}-produce/manifest.json`,
      bundle: `/data/packages/${program.id}-produce.tar.gz`,
    });
    savePlaylistStore({ folders: playlistFolders, playlists: programs });
    res.json({ ok: true, package: pkg });
  } catch (e) {
    console.error("produce error", e);
    res.status(500).json({ error: e.message || "produce failed" });
  }
});

// package store APIs
app.get("/api/packages", (_req, res) => {
  // refresh from FS to include newly dropped bundles
  packageStore.packages = mergePackages(packageStore.packages, scanPackagesFromFs());
  savePackageStore(packageStore);
  res.json({ packages: packageStore.packages, folders: packageStore.folders });
});

app.get("/api/packages/:id", (req, res) => {
  const pkg = packageStore.packages.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: "not found" });
  // attach manifest content if exists
  const manifestPath = path.join(DATA_DIR, pkg.manifest.replace("/data/", ""));
  let manifest = null;
  try { manifest = loadJson(manifestPath, null); } catch(_) {}
  res.json({ package: pkg, manifest });
});

// play a packaged program with per-screen slices
app.post("/api/packages/:id/play", (req, res) => {
  const { segmentIndex = 0, startAtUtcMs = Date.now() + 5000, loop = true } = req.body || {};
  const pkg = packageStore.packages.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: "not found" });
  const manifestPath = path.join(DATA_DIR, pkg.manifest.replace("/data/", ""));
  const manifest = loadJson(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.sequence) || !manifest.sequence.length) {
    return res.status(400).json({ error: "manifest missing sequence" });
  }
  const screens = resolvePackageScreens(manifest, pkg, segmentIndex);
  if (!screens) return res.status(400).json({ error: "sequence missing media" });
  const playId = queuePlay({ programId: pkg.id, startAtUtcMs, loop, screens });
  res.json({ ok: true, playId, startAtUtcMs, segmentIndex, programId: pkg.id });
});

// broadcast a package (sequence or single slices) to screens
app.patch("/api/packages/:id", (req, res) => {
  const pkg = packageStore.packages.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: "not found" });
  const { title, folderId } = req.body || {};
  if (title) pkg.title = String(title).trim() || pkg.title;
  if (folderId && packageStore.folders.find((f)=>f.id===folderId)) pkg.folderId = folderId;
  savePackageStore(packageStore);
  res.json({ ok: true, package: pkg });
});

app.delete("/api/packages/:id", (req, res) => {
  const pkg = packageStore.packages.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: "not found" });
  // remove files
  try {
    const baseDir = path.join(DATA_DIR, "packages");
    const dir = path.join(baseDir, pkg.id.replace(/-produce$/, "-produce"));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    const bundle = path.join(DATA_DIR, pkg.bundle.replace("/data/",""));
    if (fs.existsSync(bundle)) fs.unlinkSync(bundle);
  } catch(_e){}
  packageStore.packages = packageStore.packages.filter((p)=>p.id !== pkg.id);
  savePackageStore(packageStore);
  res.json({ ok: true });
});

app.post("/api/packages/folders", (req, res) => {
  const { name="" } = req.body || {};
  const n = String(name).trim();
  if (!n) return res.status(400).json({ error: "name required" });
  const id = crypto.randomBytes(6).toString("hex");
  const folder = { id, name:n, createdAt: Date.now() };
  packageStore.folders.push(folder);
  savePackageStore(packageStore);
  res.json({ ok:true, folder });
});

app.patch("/api/packages/folders/:id", (req, res) => {
  const f = packageStore.folders.find((x)=>x.id===req.params.id);
  if (!f) return res.status(404).json({ error:"not found" });
  if (f.id === "root") return res.status(400).json({ error:"cannot rename root"});
  const { name="" } = req.body || {};
  f.name = String(name).trim() || f.name;
  savePackageStore(packageStore);
  res.json({ ok:true, folder:f });
});

app.delete("/api/packages/folders/:id", (req, res) => {
  const { id } = req.params;
  if (id === "root") return res.status(400).json({ error:"cannot delete root"});
  const idx = packageStore.folders.findIndex((f)=>f.id===id);
  if (idx===-1) return res.status(404).json({ error:"not found"});
  packageStore.folders.splice(idx,1);
  packageStore.packages = packageStore.packages.map(p=>p.folderId===id ? { ...p, folderId:"root" }: p);
  savePackageStore(packageStore);
  res.json({ ok:true });
});

// save custom program (manual editor)
app.post("/api/programs/custom", (req, res) => {
  const { id, title, slices, sequence = [], tags = [], totalDurationSec = 0 } = req.body || {};
  if (!id || !slices) return res.status(400).json({ error: "id and slices required" });
  const program = {
    id,
    title: title || id,
    createdAt: Date.now(),
    sourceFile: "custom",
    slices,
    sequence,
    tags,
    totalDurationSec,
    folderId: req.body.folderId && playlistFolders.find((f)=>f.id===req.body.folderId) ? req.body.folderId : "root",
  };
  programs = upsertProgram(programs, program);
  playlistStore.playlists = programs;
  savePlaylistStore({ folders: playlistFolders, playlists: programs });
  res.json({ ok: true, program });
});

app.post("/api/programs/reload", (_req, res) => {
  playlistStore = loadPlaylistStore();
  programs = playlistStore.playlists;
  playlistFolders = playlistStore.folders;
  res.json({ ok: true, count: programs.length });
});

app.get("/api/apk-manifest", (_, res) => {
  res.json({ apk: apkManifest });
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
      const resp = { type: "pong", serverTime: Date.now() };
      if (msg.ts) resp.echo = msg.ts;
      ws.send(JSON.stringify(resp));
    }

    if (msg.type === "ready") {
      const { playId, role } = msg;
      if (playId && role) markReady(playId, role);
    }

    if (msg.type === "start-confirm") {
      const { playId, startAtUtcMs } = msg;
      if (!playId) return;
      sendStartBroadcast(playId, startAtUtcMs || Date.now() + START_DELAY_MS);
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

function broadcast(obj, roles) {
  const str = JSON.stringify(obj);
  for (const [id, info] of devices.entries()) {
    if (roles && roles.length && !roles.includes(info.role)) continue;
    if (info.ws.readyState === 1) {
      info.ws.send(str);
    }
  }
}

function queuePlay({ programId = "manual", startAtUtcMs = Date.now() + 5000, loop = true, screens = {}, roles = [] }) {
  const noFallback = Boolean(screens.__noFallback);
  screens = normalizeScreens(screens);
  const playId = `play_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payload = { type: "play", playId, programId, startAtUtcMs, loop, screens };
  const ready = new Set();
  const timer = setTimeout(() => forceStart(playId), READY_TIMEOUT_MS);
  // limit waiting roles to those actually targeted (when provided)
  const waitRoles = roles && roles.length ? roles : ["left","center","right"];
  pendingPlays.set(playId, { screens, ready, timer, roles: waitRoles, noFallback });
  broadcast(payload, roles && roles.length ? roles : undefined);
  return playId;
}

function normalizeScreens(input = {}) {
  const roles = ["left", "center", "right"];
  const out = {};
  const noFallback = Boolean(input.__noFallback);
  // prefer center as source fallback
  const center = input.center || input.middle || null;
  for (const r of roles) {
    const src = input[r] || (noFallback ? {} : (center || input.left || input.right || {}));
    const url = src.url || (noFallback ? "" : (center?.url || input.left?.url || input.right?.url || ""));
    // if viewport missing, fallback to full frame
    const viewport = src.viewport && typeof src.viewport === "object"
      ? src.viewport
      : undefined;
    out[r] = {
      ...src,
      url,
      viewport,
      effect: src.effect || input.left?.effect || input.center?.effect || input.right?.effect || "fade",
      audio: src.audio ?? (r === "center"), // only center carries audio by default
    };
  }
  return out;
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

function clamp01(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function thumbFileName(relPath) {
  const ext = path.extname(relPath) || "";
  const base = path.basename(relPath, ext);
  return `${base}.jpg`;
}

function isSubPath(parent, target) {
  const rel = path.relative(parent, target);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isSafeMediaExt(file) {
  const ext = (path.extname(file) || "").toLowerCase();
  return SAFE_MEDIA_EXT.has(ext);
}

function resolveMediaPath(relPath = "") {
  const norm = path.normalize(relPath || "").replace(/^(\.\.(\/|\\|$))+/, "");
  const abs = path.resolve(EXTERNAL_MEDIA_DIR, norm);
  if (abs === EXTERNAL_MEDIA_DIR || isSubPath(EXTERNAL_MEDIA_DIR, abs)) return abs;
  throw new Error("invalid path");
}

function listMediaTree(relPath = "") {
  const abs = resolveMediaPath(relPath);
  const entries = fs.readdirSync(abs, { withFileTypes: true }).filter(e=>!e.name.startsWith("."));
  const folders = [];
  const files = [];
  for (const e of entries) {
    const full = path.join(abs, e.name);
    const rel = toPosix(path.relative(EXTERNAL_MEDIA_DIR, full));
    const stat = fs.statSync(full);
    if (e.isDirectory()) {
      folders.push({ name: e.name, path: rel, mtime: stat.mtimeMs });
    } else {
      const extOk = isSafeMediaExt(e.name);
      files.push({ name: e.name, path: rel, size: stat.size, mtime: stat.mtimeMs, isMedia: extOk });
    }
  }
  return { path: toPosix(relPath), folders, files };
}

async function ensureThumbnail(relPath, opts = {}) {
  const { preferLocal = true, fallbackGlobal = true } = opts;
  const abs = resolveMediaPath(relPath);
  if (!fs.existsSync(abs)) throw new Error("file not found");
  const srcStat = fs.statSync(abs);
  const ext = (path.extname(relPath) || "").toLowerCase();
  const isVideo = VIDEO_EXT.has(ext);
  const isImg = SAFE_MEDIA_EXT.has(ext) && !isVideo;
  const safeRel = toPosix(relPath);
  const relDir = path.posix.dirname(safeRel || "");
  const type = isImg ? "image" : isVideo ? "video" : "other";
  const localThumb = path.join(path.dirname(abs), LOCAL_THUMB_DIR_NAME, thumbFileName(relPath));
  const globalThumb = path.join(THUMB_DIR, relDir === "." ? "" : relDir, thumbFileName(relPath));
  const hasFresh = (p) => fs.existsSync(p) && fs.statSync(p).mtimeMs >= srcStat.mtimeMs;
  const generateTo = async (dest) => {
    try {
      ensureDir(path.dirname(dest));
      if (isImg) {
        const sharp = await getSharp();
        if (!sharp) return null;
        await sharp(abs, { limitInputPixels: false })
          .resize(480, 360, { fit: "inside" })
          .jpeg({ quality: 78 })
          .toFile(dest);
        return dest;
      }
      if (isVideo) {
        const ffmpegBin = resolveFfmpeg();
        const tmpOut = dest + ".tmp.jpg";
        const args = ["-y", "-ss", "1", "-i", abs, "-frames:v", "1", "-vf", "scale=480:-1", tmpOut];
        const proc = spawnSync(ffmpegBin, args, { windowsHide: true });
        if (proc.status === 0 && fs.existsSync(tmpOut)) {
          fs.renameSync(tmpOut, dest);
          return dest;
        }
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
        return null;
      }
      return null;
    } catch (e) {
      console.error("generate thumb fail", e);
      return null;
    }
  };
  if (preferLocal) {
    if (hasFresh(localThumb)) return { thumbPath: localThumb, type };
    const builtLocal = await generateTo(localThumb);
    if (builtLocal) return { thumbPath: builtLocal, type };
    if (fallbackGlobal) {
      if (hasFresh(globalThumb)) return { thumbPath: globalThumb, type };
      const builtGlobal = await generateTo(globalThumb);
      if (builtGlobal) return { thumbPath: builtGlobal, type };
    }
  } else {
    if (hasFresh(globalThumb)) return { thumbPath: globalThumb, type };
    const builtGlobal = await generateTo(globalThumb);
    if (builtGlobal) return { thumbPath: builtGlobal, type };
  }
  return { thumbPath: null, type };
}

async function describeFolder(relPath = "", limit = 8) {
  const absDir = resolveMediaPath(relPath || "");
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory()) throw new Error("path is not directory");
  const entries = fs.readdirSync(absDir, { withFileTypes:true }).filter(e => !e.name.startsWith(".") && e.isFile());
  const files = entries
    .filter(e => {
      const ext = path.extname(e.name).toLowerCase();
      return SAFE_MEDIA_EXT.has(ext) && !VIDEO_EXT.has(ext);
    })
    .map(e => e.name);
  const meta = loadMeta(relPath);
  // 清理不存在文件的 meta
  Object.keys(meta).forEach(k=>{
    if (!files.includes(k)) delete meta[k];
  });
  const targets = files.filter(f => !meta[f]).slice(0, limit);
  let processed = 0, success = 0, failed = 0;
  for (const name of targets) {
    processed++;
    try {
      const guess = await searchByName(name);
      meta[name] = {
        title: guess.title || "",
        artist: guess.artist || "",
        summary: guess.summary || "",
        source: guess.source || "",
        url: guess.url || "",
        at: Date.now()
      };
      success++;
    } catch (e) {
      failed++;
    }
  }
  saveMeta(relPath, meta);
  // 控制大小
  const keys = Object.keys(meta);
  if (keys.length > META_CACHE_LIMIT) {
    const sorted = keys.sort((a,b)=>(meta[a]?.at||0)-(meta[b]?.at||0));
    for (let i=0;i<sorted.length-META_CACHE_LIMIT;i++) delete meta[sorted[i]];
    saveMeta(relPath, meta);
  }
  return { folder: toPosix(relPath||""), total: files.length, added: success, skipped: files.length - targets.length, failed };
}

async function searchByName(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  const query = `${base} painting artist`;
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.8,zh-CN;q=0.6"
    }
  });
  if (!res.ok) throw new Error("search failed");
  const html = await res.text();
  const titleMatch = html.match(/result__a[^>]*>([^<]+)<\/a>/i);
  const snippetMatch = html.match(/result__snippet[^>]*>([^<]+)<\/div>/i);
  const hrefMatch = html.match(/class="result__a"[^>]*href="([^"]+)"/i);
  const title = titleMatch ? decodeHtml(titleMatch[1]) : base;
  const summary = snippetMatch ? decodeHtml(snippetMatch[1]) : "";
  const source = hrefMatch ? decodeURIComponent(hrefMatch[1]) : "";
  const artist = title.includes("-") ? title.split("-").slice(1).join("-").trim() : "";
  return { title, artist, summary, source, url };
}

function decodeHtml(str = "") {
  return str.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

// 同步某目录下的本地缩略图：缺失则生成，多余则删除
async function syncFolderThumbs(relPath = "") {
  const absDir = resolveMediaPath(relPath || "");
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory()) throw new Error("path is not directory");
  const entries = fs.readdirSync(absDir, { withFileTypes:true }).filter(e => !e.name.startsWith("."));
  const targets = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!SUPPORTED_MEDIA_EXT.has(ext)) continue;
    targets.push(e.name);
  }
  const thumbDir = path.join(absDir, LOCAL_THUMB_DIR_NAME);
  ensureDir(thumbDir);
  const expectedThumbs = new Set(targets.map(name => thumbFileName(name)));
  let generated = 0, reused = 0, removed = 0, failed = 0;
  for (const name of targets) {
    const relFile = toPosix(path.join(relPath || "", name));
    const thumbPath = path.join(thumbDir, thumbFileName(name));
    try {
      if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).mtimeMs >= fs.statSync(path.join(absDir, name)).mtimeMs) {
        reused++; continue;
      }
      const { thumbPath: built } = await ensureThumbnail(relFile, { preferLocal: true, fallbackGlobal: false });
      if (built) generated++; else failed++;
    } catch (e) {
      failed++;
    }
  }
  // remove extra thumbs
  const thumbEntries = fs.existsSync(thumbDir) ? fs.readdirSync(thumbDir, { withFileTypes:true }) : [];
  thumbEntries.filter(e=>e.isFile()).forEach(e=>{
    if (!expectedThumbs.has(e.name)) {
      fs.unlinkSync(path.join(thumbDir, e.name));
      removed++;
    }
  });
  // 清理 meta 中不存在的项
  const meta = loadMeta(relPath);
  let metaChanged = false;
  Object.keys(meta).forEach(k=>{
    if (!expectedThumbs.has(thumbFileName(k)) && !expectedThumbs.has(k)) {
      delete meta[k];
      metaChanged = true;
    }
  });
  if (metaChanged) saveMeta(relPath, meta);
  return {
    ok: true,
    folder: toPosix(relPath || ""),
    total: targets.length,
    generated,
    reused,
    removed,
    failed,
    changed: generated + removed > 0,
  };
}

function probeMedia(relPath) {
  const abs = resolveMediaPath(relPath);
  const ffprobe = resolveFfprobe();
  try {
    const result = spawnSync(ffprobe, [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      abs,
    ], { encoding: "utf-8" });
    if (result.status !== 0) throw new Error(result.stderr || "ffprobe failed");
    const data = JSON.parse(result.stdout || "{}");
    const streams = data.streams || [];
    const format = data.format || {};
    const vid = streams.find(s => s.codec_type === "video") || streams.find(s=>s.codec_type==="image") || streams[0];
    const width = Number(vid?.width || 0);
    const height = Number(vid?.height || 0);
    const codec = vid?.codec_name || format.format_name || "";
    const bitrate = Number(format.bit_rate || vid?.bit_rate || 0);
    const duration = Number(format.duration || vid?.duration || 0);
    return {
      ok: true,
      width,
      height,
      codec,
      bitrate,
      duration,
      format: format.format_long_name || format.format_name || "",
      size: Number(format.size || fs.statSync(abs).size || 0),
      mtime: fs.statSync(abs).mtimeMs,
    };
  } catch (e) {
    const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
    return {
      ok: false,
      error: e.message || String(e),
      size: stat?.size,
      mtime: stat?.mtimeMs,
    };
  }
}

function buildMediaTree(baseDir, tagsMap = {}) {
  if (!fs.existsSync(baseDir)) return [];
  const walk = (rel) => {
    const abs = path.join(baseDir, rel);
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_) {
      return [];
    }
    const children = [];
    // deterministic order: folders first then files
    entries
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN"))
      .forEach((e) => {
        const relPath = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) {
          const nested = walk(relPath);
          children.push({ type: "dir", name: e.name, path: toPosix(relPath), children: nested });
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (!SUPPORTED_MEDIA_EXT.has(ext)) return;
          const stat = fs.statSync(path.join(baseDir, relPath));
          const posixPath = toPosix(relPath);
          children.push({
            type: "file",
            name: e.name,
            path: posixPath,
            url: `/ext-media/${posixPath}`,
            size: stat.size,
            mtime: stat.mtimeMs,
            tags: tagsMap[posixPath] || [],
          });
        }
      });
    return children;
  };
  return walk("");
}

function resolvePackageScreens(manifest, pkg, segmentIndex = 0) {
  if (!manifest?.sequence?.length) return null;
  const idx = Math.min(Math.max(segmentIndex, 0), manifest.sequence.length - 1);
  const seg = manifest.sequence[idx] || {};
  const baseUrl = pkg?.manifest ? path.posix.dirname(pkg.manifest) : `/data/packages/${pkg?.id || ""}`;
  const makeUrl = (val = "") => {
    if (!val) return "";
    if (/^https?:\/\//i.test(val)) return val;
    const trimmed = val.replace(/^\.?\/*/, "");
    return `${baseUrl}/${toPosix(trimmed)}`;
  };
  const center = seg.files?.center || seg.urlCenter || seg.url || seg.file || "";
  const left = seg.files?.left || seg.urlLeft || seg.url || center;
  const right = seg.files?.right || seg.urlRight || seg.url || center;
  const screens = {
    left: { url: makeUrl(left), audio: false, effect: seg.effect },
    center: { url: makeUrl(center), audio: true, effect: seg.effect },
    right: { url: makeUrl(right), audio: false, effect: seg.effect },
  };
  // 若任一角色缺少 url，将使用中心源兜底
  if (!screens.left.url) screens.left.url = screens.center.url;
  if (!screens.right.url) screens.right.url = screens.center.url;
  if (!screens.center.url) return null;
  return applyUnifiedEffect(screens);
}

function forceStart(playId) {
  const entry = pendingPlays.get(playId);
  if (!entry) return;
  sendStartBroadcast(playId);
}

function markReady(playId, role) {
  const entry = pendingPlays.get(playId);
  if (!entry) return;
  entry.ready.add(role);
  const needed = entry.roles && entry.roles.length ? entry.roles : Object.keys(entry.screens || {});
  if (needed.length && needed.every((r) => entry.ready.has(r))) {
    requestCenterStart(playId);
  }
}

function requestCenterStart(playId) {
  const entry = pendingPlays.get(playId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingPlays.delete(playId);
  // 找在线的中屏
  let centerWs = null;
  for (const [, info] of devices.entries()) {
    if (info.role === "center" && info.ws.readyState === 1) {
      centerWs = info.ws;
      break;
    }
  }
  const startAtUtcMs = Date.now() + START_DELAY_MS;
  if (centerWs && entry.roles && entry.roles.includes("center")) {
    // 让中屏确认后再统一播
    const timer = setTimeout(() => {
      sendStartBroadcast(playId, startAtUtcMs);
    }, START_DELAY_MS + 4000);
    pendingStarts.set(playId, { timer, startAtUtcMs });
    centerWs.send(JSON.stringify({ type: "await-start", playId, startAtUtcMs }));
  } else {
    sendStartBroadcast(playId, startAtUtcMs);
  }
}

function sendStartBroadcast(playId, startAtUtcMs = Date.now() + START_DELAY_MS) {
  const start = pendingStarts.get(playId);
  if (start?.timer) clearTimeout(start.timer);
  pendingStarts.delete(playId);
  broadcast({ type: "start", playId, startAtUtcMs });
}

// backward-safe alias to avoid ReferenceError if旧定时器仍引用 sendStart
function sendStart(playId) {
  sendStartBroadcast(playId);
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

async function processUpload(file, mode = "cover", gap1 = 0, gap2 = 0, focusX = 0.5, focusY = 0.5, target = "all") {
  const programId = path.parse(file.originalname).name.replace(/\W+/g, "_") + "_" + Date.now();
  const isImage = file.mimetype?.startsWith("image/");
  const origExt = (path.extname(file.originalname) || "").toLowerCase();
  const normExt = isImage ? ".png" : ".mp4";
  const sliceExt = isImage ? ".png" : (origExt || ".mp4");
  const destDir = path.join(MEDIA_DIR, programId);
  ensureDir(destDir);

  const canvasW = target === "center" ? WIDTH_CENTER : target === "left" || target === "right" ? WIDTH_LEFT : CANVAS_W + gap1 + gap2;
  const canvasH = CANVAS_H;

  const normalized = path.join(destDir, `normalized${normExt}`);
  buildNormalized(file.path, normalized, mode, isImage, focusX, focusY, canvasW, canvasH);

  const { slicesMeta, outputs } = cropWithBezels(normalized, destDir, sliceExt, gap1, gap2, isImage, target, canvasW, canvasH);

  const previews = {
    left: target === "all" || target === "left" ? path.join(destDir, "preview-left.png") : null,
    center: target === "all" || target === "center" ? path.join(destDir, "preview-center.png") : null,
    right: target === "all" || target === "right" ? path.join(destDir, "preview-right.png") : null,
  };
  if (previews.left) createPreview(outputs.left, previews.left, isImage);
  if (previews.center) createPreview(outputs.center, previews.center, isImage);
  if (previews.right) createPreview(outputs.right, previews.right, isImage);

  const slices = {};
  for (const role of ["left", "center", "right"]) {
    if (target !== "all" && role !== target) {
      slices[role] = { url: "", checksum: "", size: 0, effect: "fade", audio: false, preview: "" };
      continue;
    }
    const fp = outputs[role];
    const checksum = sha256File(fp);
    const size = fs.statSync(fp).size;
    const urlPath = `/media/${programId}/${role}${sliceExt}`;
    const prevPath = previews[role] ? `/media/${programId}/preview-${role}.png` : "";
    const fullUrl = BASE_URL ? `${BASE_URL}${urlPath}` : urlPath;
    const prevUrl = prevPath ? (BASE_URL ? `${BASE_URL}${prevPath}` : prevPath) : "";
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
    bezels: { gap1, gap2 },
    slices,
    target,
  };
}

function cropWithBezels(input, destDir, sliceExt, gap1Raw, gap2Raw, isImage, target = "all", canvasW = CANVAS_W, canvasH = CANVAS_H) {
  const gap1 = Number(gap1Raw) || 0;
  const gap2 = Number(gap2Raw) || 0;
  const outputs = {
    left: path.join(destDir, `left${sliceExt}`),
    center: path.join(destDir, `center${sliceExt}`),
    right: path.join(destDir, `right${sliceExt}`),
  };

  if (target !== "all") {
    const roleW = target === "center" ? WIDTH_CENTER : WIDTH_LEFT;
    const w = roleW;
    runFfmpeg(input, outputs[target], `crop=${w}:${canvasH}:0:0`, isImage);
    return { slicesMeta: { wL: w, wC: 0, wR: 0 }, outputs };
  }

  const virtualWidth = CANVAS_W + gap1 + gap2;
  const scale = CANVAS_W / virtualWidth;
  const wL = Math.round(WIDTH_LEFT * scale);
  const wC = Math.round(WIDTH_CENTER * scale);
  const wR = Math.round(WIDTH_RIGHT * scale);
  const xL = 0;
  const xC = Math.round((WIDTH_LEFT + gap1) * scale);
  const xR = Math.round((WIDTH_LEFT + gap1 + WIDTH_CENTER + gap2) * scale);

  // clamp crops to avoid overflow beyond the 6000px canvas, which would yield empty/black slices
  const clampCrop = (w, x) => {
    const safeW = Math.max(1, Math.min(w, CANVAS_W - x));
    const safeX = Math.max(0, Math.min(x, CANVAS_W - safeW));
    return { w: safeW, x: safeX };
  };
  const leftCrop = clampCrop(wL, xL);
  const centerCrop = clampCrop(wC, xC);
  const rightCrop = clampCrop(wR, xR);

  runFfmpeg(input, outputs.left, `crop=${leftCrop.w}:${canvasH}:${leftCrop.x}:0`, isImage);
  runFfmpeg(input, outputs.center, `crop=${centerCrop.w}:${CENTER_H}:${centerCrop.x}:0`, isImage);
  runFfmpeg(input, outputs.right, `crop=${rightCrop.w}:${canvasH}:${rightCrop.x}:0`, isImage);

  return { slicesMeta: { wL, wC, wR, xL, xC, xR }, outputs };
}

function buildNormalized(input, output, mode, isImage, focusX = 0.5, focusY = 0.5, canvasW = CANVAS_W, canvasH = CANVAS_H) {
  const filters = [];
  if (mode === "stretch") {
    filters.push(`scale=${canvasW}:${canvasH}`);
  } else if (mode === "contain") {
    filters.push(`scale=${canvasW}:${canvasH}:force_original_aspect_ratio=decrease`);
    filters.push(`pad=${canvasW}:${canvasH}:(ow-iw)/2:(oh-ih)/2:black`);
  } else {
    // cover (crop)
    const fx = clamp01(Number(focusX));
    const fy = clamp01(Number(focusY));
    filters.push(`scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase`);
    filters.push(`crop=${canvasW}:${canvasH}:(iw-${canvasW})*${fx}:(ih-${canvasH})*${fy}`);
  }
  runFfmpeg(input, output, filters.join(","), isImage);
}

function runFfmpeg(input, output, filter, isImage) {
  const ffmpegBin = resolveFfmpeg();
  const args = ["-i", input, "-y", "-vf", filter];
  if (isImage) {
    args.push("-frames:v", "1");
  }
  args.push(output);
  const res = spawnSync(ffmpegBin, args, { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error("ffmpeg failed for " + output);
  }
}

function createPreview(input, output, isImage) {
  if (isImage) {
    fs.copyFileSync(input, output);
    return;
  }
  const ffmpegBin = resolveFfmpeg();
  const args = ["-i", input, "-y", "-vframes", "1", "-q:v", "2", output];
  const res = spawnSync(ffmpegBin, args, { stdio: "inherit" });
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

async function processUploadFast(file, mode = "cover", gap1 = 0, gap2 = 0, focusX = 0.5, focusY = 0.5, target = "all") {
  const programId = path.parse(file.originalname).name.replace(/\W+/g, "_") + "_" + Date.now();
  const isImage = file.mimetype?.startsWith("image/");
  const origExt = (path.extname(file.originalname) || "").toLowerCase();
  const destDir = path.join(MEDIA_DIR, programId);
  ensureDir(destDir);

  // move original
  const origPath = path.join(destDir, `original${origExt || (isImage ? ".png" : ".mp4")}`);
  fs.renameSync(file.path, origPath);

  // probe media size
  const { width = CANVAS_W, height = CANVAS_H } = probeFile(origPath);

  // viewport fractions based on virtual width (account bezels)
  const gap1n = Number(gap1) || 0;
  const gap2n = Number(gap2) || 0;
  const virtualWidth = CANVAS_W + gap1n + gap2n;
  const leftW = WIDTH_LEFT / virtualWidth;
  const centerW = WIDTH_CENTER / virtualWidth;
  const rightW = WIDTH_RIGHT / virtualWidth;
  const gap1Frac = gap1n / virtualWidth;
  const gap2Frac = gap2n / virtualWidth;
  // 侧屏显示区域缩窄 10%（仅取源画面更小的区域，再由客户端放满屏幕）
  const shrinkSide = 0.9;
  const leftCropW = leftW * shrinkSide;
  const rightCropW = rightW * shrinkSide;
  const leftX = (leftW - leftCropW) / 2;
  const centerX = leftW + gap1Frac;
  const rightX = leftW + gap1Frac + centerW + gap2Frac + (rightW - rightCropW) / 2;

  // preview (single center snapshot)
  const previewPath = path.join(destDir, "preview.png");
  try { createPreview(origPath, previewPath, isImage); } catch (_) {}
  const prevUrl = `${BASE_URL || ""}/media/${programId}/preview.png`;
  const urlPath = `/media/${programId}/original${origExt || (isImage ? ".png" : ".mp4")}`;
  const fullUrl = BASE_URL ? `${BASE_URL}${urlPath}` : urlPath;

  const slices = {
    left:   target === "all" || target === "left"   ? { url: fullUrl, viewport: { x: leftX, y: 0, w: leftCropW, h: 1 }, effect: "fade", audio: false, preview: prevUrl, mode } : { url:"", audio:false, effect:"fade", preview:"", viewport: null },
    center: target === "all" || target === "center" ? { url: fullUrl, viewport: { x: centerX, y: 0, w: centerW, h: 1 }, effect: "fade", audio: !isImage, preview: prevUrl, mode } : { url:"", audio:false, effect:"fade", preview:"", viewport: null },
    right:  target === "all" || target === "right"  ? { url: fullUrl, viewport: { x: rightX, y: 0, w: rightCropW, h: 1 }, effect: "fade", audio: false, preview: prevUrl, mode } : { url:"", audio:false, effect:"fade", preview:"", viewport: null },
  };

  return {
    id: programId,
    title: file.originalname,
    createdAt: Date.now(),
    sourceFile: file.originalname,
    mode,
    fastViewport: true,
    bezels: { gap1, gap2 },
    media: { width, height, url: fullUrl },
    slices,
    target,
  };
}

function probeFile(absPath) {
  const ffprobe = resolveFfprobe();
  try {
    const result = spawnSync(ffprobe, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "default=noprint_wrappers=1:nokey=1",
      absPath,
    ], { encoding: "utf-8" });
    const parts = result.stdout.trim().split("\n").map(Number);
    return { width: parts[0] || CANVAS_W, height: parts[1] || CANVAS_H };
  } catch (e) {
    return { width: CANVAS_W, height: CANVAS_H };
  }
}

function fileFromUrl(urlStr) {
  try {
    // Absolute http(s) url that points back to our /media paths
    if (urlStr.startsWith("http://") || urlStr.startsWith("https://")) {
      const u = new URL(urlStr);
      if (u.pathname.startsWith("/media/")) return path.join(DATA_DIR, u.pathname.replace("/media/", "media/"));
      if (u.pathname.startsWith("/materials/")) return path.join(DATA_DIR, u.pathname.replace("/materials/", "materials/"));
      return null;
    }
    // Already a server path
    if (urlStr.startsWith("/media/")) return path.join(DATA_DIR, urlStr.replace("/media/", "media/"));
    if (urlStr.startsWith("/materials/")) return path.join(DATA_DIR, urlStr.replace("/materials/", "materials/"));
    // Raw media path stored without leading slash
    if (urlStr.startsWith("media/")) return path.join(DATA_DIR, urlStr);
    if (urlStr.startsWith("materials/")) return path.join(DATA_DIR, urlStr);
  } catch (_e) {
    // ignore malformed URL
  }
  return null;
}

function createTarGz(srcDir, outFile) {
  // prefer system tar for speed
  const tarRes = spawnSync("tar", ["-czf", outFile, "-C", srcDir, "."], { stdio: "inherit" });
  if (tarRes.status !== 0) {
    throw new Error("tar failed to create bundle");
  }
}

async function producePlaylist(program, crop) {
  const dir = path.join(PACKAGES_DIR, `${program.id}-produce`);
  ensureDir(dir);
  const manifest = {
    id: program.id,
    title: program.title,
    createdAt: program.createdAt,
    producedAt: Date.now(),
    crop,
    sequence: [],
  };
  for (let i = 0; i < (program.sequence || []).length; i++) {
    const s = program.sequence[i] || {};
    const roles = {
      left: s.urlLeft || "",
      center: s.urlCenter || s.url || "",
      right: s.urlRight || "",
    };
    const singleSrc = roles.center || s.url || s.urlLeft || s.urlRight || "";
    const files = {};

    // 判断是否仅有单源（或三路同源），需要按三屏切分
    const distinctSources = Array.from(new Set([roles.left, roles.center, roles.right].filter(Boolean)));
    const hasMulti = distinctSources.length > 1;
    const baseCrop = {
      w: crop?.width ?? 1,
      h: crop?.height ?? 1,
      x: crop?.x ?? 0,
      y: crop?.y ?? 0,
    };
    const TARGETS = {
      left: { w: WIDTH_LEFT, h: CANVAS_H },
      center: { w: WIDTH_CENTER, h: CENTER_H },
      right: { w: WIDTH_RIGHT, h: CANVAS_H },
    };
    const SLICE = {
      left: { w: WIDTH_LEFT / CANVAS_W, x: 0 },
      center: { w: WIDTH_CENTER / CANVAS_W, x: WIDTH_LEFT / CANVAS_W },
      right: { w: WIDTH_RIGHT / CANVAS_W, x: (WIDTH_LEFT + WIDTH_CENTER) / CANVAS_W },
    };
    const buildFilterSingle = (role) => {
      const seg = SLICE[role];
      const t = TARGETS[role];
      // user crop -> segment slice -> scale cover -> crop exact
      return [
        `crop=iw*${baseCrop.w}:ih*${baseCrop.h}:iw*${baseCrop.x}:ih*${baseCrop.y}`,
        `crop=iw*${seg.w}:ih:iw*${seg.x}:0`,
        `scale=${t.w}:${t.h}:force_original_aspect_ratio=increase`,
        `crop=${t.w}:${t.h}`
      ].join(",");
    };
    const buildFilterMulti = (role) => {
      const t = TARGETS[role];
      return [
        `crop=iw*${baseCrop.w}:ih*${baseCrop.h}:iw*${baseCrop.x}:ih*${baseCrop.y}`,
        `scale=${t.w}:${t.h}:force_original_aspect_ratio=increase`,
        `crop=${t.w}:${t.h}`
      ].join(",");
    };

    if (!hasMulti && singleSrc) {
      const src = fileFromUrl(singleSrc);
      if (!src || !fs.existsSync(src)) throw new Error(`source missing for item ${i}`);
      const isImage = (s.type === "image") || (s.mime || "").startsWith("image");
      const ffmpegBin = resolveFfmpeg();
      for (const role of ["left","center","right"]) {
        const ext = path.extname(src) || ".bin";
        const out = path.join(dir, `item-${i}-${role}${ext}`);
        const vf = buildFilterSingle(role);
        const args = ["-i", src, "-y", "-vf", vf];
        if (isImage) args.push("-frames:v","1");
        args.push(out);
        const res = spawnSync(ffmpegBin, args, { stdio: "inherit" });
        if (res.status !== 0) throw new Error(`ffmpeg slice failed on item ${i} role ${role}`);
        files[role] = path.basename(out);
      }
    } else {
      // 已有三路或部分路源：逐路裁剪（可选裁剪框）
      for (const role of ["left", "center", "right"]) {
        const src = fileFromUrl(roles[role]) || fileFromUrl(singleSrc);
        if (!src || !fs.existsSync(src)) continue;
        const ext = path.extname(src) || ".bin";
        const out = path.join(dir, `item-${i}-${role}${ext}`);
        const isImage = (s.type === "image") || (s.mime || "").startsWith("image");
        const vf = buildFilterMulti(role);
        const ffmpegBin = resolveFfmpeg();
        const args = ["-i", src, "-y", "-vf", vf];
        if (isImage) args.push("-frames:v","1");
        args.push(out);
        const res = spawnSync(ffmpegBin, args, { stdio: "inherit" });
        if (res.status !== 0) throw new Error(`ffmpeg failed on item ${i} role ${role}`);
        files[role] = path.basename(out);
      }
    }
    const duration = s.duration || 0;
    // center file retained for兼容
    manifest.sequence.push({
      title: s.title,
      duration,
      file: files.center || files.left || files.right || "",
      files,
      type: s.type,
    });
  }
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const bundlePath = path.join(PACKAGES_DIR, `${program.id}-produce.tar.gz`);
  createTarGz(dir, bundlePath);
  return { path: dir, manifest: manifestPath, bundle: bundlePath };
}

function upsertPackageStore(pkg) {
  const idx = packageStore.packages.findIndex((p)=>p.id===pkg.id);
  if (idx>=0) packageStore.packages[idx] = { ...packageStore.packages[idx], ...pkg };
  else packageStore.packages.unshift(pkg);
  savePackageStore(packageStore);
}

function scanPackagesFromFs() {
  const list = [];
  if (!fs.existsSync(PACKAGES_DIR)) return list;
  const entries = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      const manifestPath = path.join(PACKAGES_DIR, e.name, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const m = loadJson(manifestPath, null);
          if (m?.id) {
            list.push({
              id: e.name,
              title: m.title || e.name,
              folderId: "root",
              createdAt: m.producedAt || m.createdAt || Date.now(),
              manifest: `/data/packages/${e.name}/manifest.json`,
              bundle: `/data/packages/${e.name}.tar.gz`,
            });
          }
        } catch(_e){}
      }
    } else if (e.isFile() && e.name.endsWith(".tar.gz")) {
      const id = e.name.replace(".tar.gz","");
      list.push({
        id,
        title: id,
        folderId: "root",
        createdAt: fs.statSync(path.join(PACKAGES_DIR,e.name)).mtimeMs,
        manifest: `/data/packages/${id}/manifest.json`,
        bundle: `/data/packages/${e.name}`,
      });
    }
  }
  return list;
}

function mergePackages(existing, scanned) {
  const map = new Map();
  [...existing, ...scanned].forEach(p=>{ map.set(p.id, { ...map.get(p.id), ...p }); });
  return Array.from(map.values());
}

function resolveFfmpeg() {
  const candidates = [
    path.join(__dirname, "..", "bin", "ffmpeg.exe"),
    path.resolve(__dirname, "..", "ffmpeg-8.0.1-essentials_build", "bin", "ffmpeg.exe"),
    path.resolve(__dirname, "..", "ffmpeg-8.0.1-essentials_build", "bin", "ffmpeg"),
    "ffmpeg",
  ];
  for (const c of candidates) {
    if (c === "ffmpeg") return c;
    if (fs.existsSync(c)) return c;
  }
  return "ffmpeg";
}

function resolveFfprobe() {
  const candidates = [
    path.join(__dirname, "..", "bin", "ffprobe.exe"),
    path.join(__dirname, "..", "bin", "ffprobe"),
    path.resolve(__dirname, "..", "ffmpeg-8.0.1-essentials_build", "bin", "ffprobe.exe"),
    path.resolve(__dirname, "..", "ffmpeg-8.0.1-essentials_build", "bin", "ffprobe"),
    "ffprobe",
  ];
  for (const c of candidates) {
    if (c === "ffprobe") return c;
    if (fs.existsSync(c)) return c;
  }
  return "ffprobe";
}

function sha256File(fp) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(fp));
  return hash.digest("hex");
}

function listImagesRecursive(dir, base = dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results = results.concat(listImagesRecursive(full, base));
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (SAFE_MEDIA_EXT.has(ext)) {
        const rel = path.relative(base, full);
        results.push(rel);
      }
    }
  }
  return results;
}

function scheduleEntry(entry) {
  const delay = entry.startAtUtcMs - Date.now();
  if (delay < 0) {
    // remove expired entry to avoid lingering stale schedules
    schedules = schedules.filter((s) => s.id !== entry.id);
    saveJson(SCHEDULE_FILE, schedules);
    return;
  }
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

// Spawn ffmpeg to produce HLS preview from RTSP camera
let previewProc = null;
let previewWanted = false; // 默认不拉流，需用户点击“开始预览”后再启动

function startPreviewHls(force = false) {
  previewWanted = true;
  if (!force && previewProc && !previewProc.killed) return;
  ensureDir(HLS_DIR);
  cleanupPreviewFiles();
  spawnPreviewPipeline(PREVIEW_RTSP, false);
}

function spawnPreviewPipeline(source, isFallback) {
  if (!previewWanted) return;
  const ffmpegBin = resolveFfmpeg();
  const args = buildPreviewArgs(source);
  try {
    console.log("Starting preview ffmpeg:", ffmpegBin, args.join(" "));
    previewProc = spawn(ffmpegBin, args, { stdio: "inherit" });
  } catch (e) {
    console.error("spawn preview ffmpeg failed", e);
    previewProc = null;
    if (!isFallback) return spawnPreviewPipeline(PREVIEW_FALLBACK, true);
    return;
  }
  previewProc.on("close", (code, signal) => {
    previewProc = null;
    if (!previewWanted) return;
    if (!isFallback) {
      console.error("preview pipeline failed, switching to fallback color. code:", code, "signal:", signal);
      return spawnPreviewPipeline(PREVIEW_FALLBACK, true);
    }
    setTimeout(() => startPreviewHls(true), 3000);
  });
  previewProc.on("error", (err) => {
    console.error("preview ffmpeg error", err);
    previewProc = null;
    if (!previewWanted) return;
    if (!isFallback) return spawnPreviewPipeline(PREVIEW_FALLBACK, true);
    setTimeout(() => startPreviewHls(true), 3000);
  });
}

function buildPreviewArgs(source) {
  const isColor = source.startsWith("color=");
  const isLavfi = (!source.includes("://")) && /^[a-z0-9]+=[^:]+/i.test(source);
  const isRtsp = source.toLowerCase().startsWith("rtsp://");
  const inputArgs = (isColor || isLavfi)
    ? ["-f", "lavfi", "-re", "-i", source]
    : isRtsp
      ? ["-rtsp_transport", "tcp", "-i", source] // 部分打包版 FFmpeg 不支持 -stimeout
      : ["-i", source];
  const filters = ["scale=1280:-1", "format=yuv420p"]; // 强制 4:2:0 以兼容浏览器硬解
  return [
    ...inputArgs,
    "-vf", filters.join(","),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p", // 双保险：输出 4:2:0
    "-g", "25",
    "-keyint_min", "25",
    "-sc_threshold", "0",
    "-c:a", "aac",
    "-ac", "1",
    "-ar", "44100",
    "-b:a", "96k",
    "-f", "hls",
    "-hls_time", "1",
    "-hls_list_size", "10",
    "-hls_flags", "delete_segments+append_list",
    "-hls_segment_filename", path.join(HLS_DIR, "preview%03d.ts"),
    "-y",
    HLS_TARGET,
  ];
}

function cleanupPreviewFiles() {
  try {
    for (const file of fs.readdirSync(HLS_DIR)) {
      if (file.startsWith("preview") && (file.endsWith(".ts") || file.endsWith(".m3u8"))) {
        fs.unlinkSync(path.join(HLS_DIR, file));
      }
    }
  } catch (_) {}
}

function stopPreviewHls() {
  previewWanted = false;
  if (previewProc && !previewProc.killed) {
    try { previewProc.kill("SIGKILL"); } catch (_) {}
  }
  previewProc = null;
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

// preview control
app.post("/api/preview/start", (_req, res) => {
  previewWanted = true;
  startPreviewHls(true);
  res.json({ ok: true });
});

app.post("/api/preview/stop", (_req, res) => {
  stopPreviewHls();
  res.json({ ok: true });
});

// playlist folders
app.get("/api/programs/folders", (_req, res) => {
  res.json({ folders: playlistFolders });
});

app.post("/api/programs/folders", (req, res) => {
  const { name = "" } = req.body || {};
  const n = String(name).trim();
  if (!n) return res.status(400).json({ error: "name required" });
  const id = crypto.randomBytes(6).toString("hex");
  const folder = { id, name: n, createdAt: Date.now() };
  playlistFolders.push(folder);
  savePlaylistStore({ folders: playlistFolders, playlists: programs });
  res.json({ ok: true, folder });
});

app.patch("/api/programs/folders/:id", (req, res) => {
  const folder = playlistFolders.find((f) => f.id === req.params.id);
  if (!folder) return res.status(404).json({ error: "not found" });
  if (folder.id === "root") return res.status(400).json({ error: "cannot rename root" });
  const { name = "" } = req.body || {};
  folder.name = String(name).trim() || folder.name;
  savePlaylistStore({ folders: playlistFolders, playlists: programs });
  res.json({ ok: true, folder });
});

app.delete("/api/programs/folders/:id", (req, res) => {
  const { id } = req.params;
  if (id === "root") return res.status(400).json({ error: "cannot delete root" });
  const idx = playlistFolders.findIndex((f) => f.id === id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  playlistFolders.splice(idx, 1);
  programs = programs.map((p) => (p.folderId === id ? { ...p, folderId: "root" } : p));
  savePlaylistStore({ folders: playlistFolders, playlists: programs });
  res.json({ ok: true });
});
// 接收客户端截图
app.post("/api/snapshot", snapshotUpload.single("snap"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:"snapshot missing" });
    const role = (req.body?.role || "unknown").toLowerCase();
    const ts = Date.now();
    const ext = path.extname(req.file.originalname || ".png") || ".png";
    const safeExt = ext.toLowerCase().startsWith(".") ? ext : ".png";
    const filename = `${ts}_${role || "unknown"}${safeExt}`;
    const target = path.join(SNAPSHOT_DIR, filename);
    fs.renameSync(req.file.path, target);
    const urlPath = `/snapshot/${filename}`;
    res.json({ ok:true, file:urlPath, role });
  } catch (e) {
    console.error("save snapshot error", e);
    res.status(500).json({ ok:false, error: e.message || "save failed" });
  }
});

// 查询最新截图（按角色）
app.get("/api/snapshot/latest", (_req, res) => {
  try {
    const files = fs.readdirSync(SNAPSHOT_DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
    const pickLatest = (role) => {
      const matches = files
        .filter(f => f.toLowerCase().includes(`_${role}.`))
        .map(f => ({ f, mtime: fs.statSync(path.join(SNAPSHOT_DIR, f)).mtimeMs }));
      if (!matches.length) return null;
      const latest = matches.sort((a,b)=>b.mtime - a.mtime)[0];
      return { file: `/snapshot/${latest.f}`, mtime: latest.mtime };
    };
    res.json({
      ok: true,
      left: pickLatest("left"),
      center: pickLatest("center"),
      right: pickLatest("right"),
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || "list failed" });
  }
});

// 接收客户端上传的截屏错误
app.post("/api/snapshot-error", express.json(), (req, res) => {
  const role = req.body?.role || "unknown";
  const error = req.body?.error || "unknown";
  console.error("snapshot error from", role, ":", error);
  res.json({ ok:true });
});

// 预览切片缓存：保存 / 读取三屏 PNG
app.get("/api/preview-cache", (_req, res) => {
  const files = ["left.png","center.png","right.png"];
  const result = {};
  files.forEach(f=>{
    const p = path.join(PREVIEW_CACHE_DIR, f);
    if (fs.existsSync(p)) {
      result[f.replace(".png","")] = `/data/preview-cache/${f}?t=${fs.statSync(p).mtimeMs}`;
    }
  });
  res.json({ ok:true, ...result });
});

app.post("/api/preview-cache", express.json({ limit:"25mb" }), (req, res) => {
  try {
    const roles = ["left","center","right"];
    roles.forEach(r=>{
      const dataUrl = req.body?.[r];
      if (!dataUrl || !dataUrl.startsWith("data:image")) return;
      const base64 = dataUrl.split(",")[1];
      const buf = Buffer.from(base64, "base64");
      fs.writeFileSync(path.join(PREVIEW_CACHE_DIR, `${r}.png`), buf);
    });
    res.json({ ok:true, savedAt: Date.now() });
  } catch (e) {
    console.error("save preview cache error", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// 随机选取 media 库一张图片
app.get("/api/media/random-image", (_req, res) => {
  try {
    const images = listImagesRecursive(EXTERNAL_MEDIA_DIR);
    if (!images.length) return res.status(404).json({ ok:false, error:"no images in media" });
    const pick = images[Math.floor(Math.random() * images.length)];
    const url = `/ext-media/${toPosix(pick)}`;
    res.json({ ok:true, url });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || "random failed" });
  }
});

// 接收客户端上传的日志文件
app.post("/api/logs", logUpload.single("log"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:"log missing" });
    const role = (req.body?.role || "unknown").toLowerCase();
    const ts = Date.now();
    const ext = path.extname(req.file.originalname || ".log") || ".log";
    const safeExt = ext.toLowerCase().startsWith(".") ? ext : ".log";
    const filename = `${ts}_${role || "unknown"}${safeExt}`;
    const target = path.join(SNAPSHOT_LOG_DIR, filename);
    fs.renameSync(req.file.path, target);
    res.json({ ok:true, file:`/snapshot/logs/${filename}`, role });
  } catch (e) {
    console.error("save log error", e);
    res.status(500).json({ ok:false, error: e.message || "save failed" });
  }
});

// 查询最新日志（按角色）
app.get("/api/logs/latest", (_req, res) => {
  try {
    const files = fs.readdirSync(SNAPSHOT_LOG_DIR).filter(f => /\.log$/i.test(f));
    const pickLatest = (role) => {
      const matches = files
        .filter(f => f.toLowerCase().includes(`_${role}.`))
        .map(f => ({ f, mtime: fs.statSync(path.join(SNAPSHOT_LOG_DIR, f)).mtimeMs }));
      if (!matches.length) return null;
      const latest = matches.sort((a,b)=>b.mtime - a.mtime)[0];
      return { file: `/snapshot/logs/${latest.f}`, mtime: latest.mtime };
    };
    res.json({
      ok: true,
      left: pickLatest("left"),
      center: pickLatest("center"),
      right: pickLatest("right"),
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || "list failed" });
  }
});

// 删除过旧的截图（保留最近 50 个）
setInterval(() => {
  try {
    const files = fs.readdirSync(SNAPSHOT_DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
    if (files.length <= 50) return;
    const sorted = files.map(f => ({ f, mtime: fs.statSync(path.join(SNAPSHOT_DIR, f)).mtimeMs }))
      .sort((a,b)=>b.mtime - a.mtime);
    const toDelete = sorted.slice(50);
    toDelete.forEach(({f}) => fs.unlink(path.join(SNAPSHOT_DIR, f), ()=>{}));
  } catch (_) {}
}, 60_000);

// 删除过旧的日志（保留最近 50 个）
setInterval(() => {
  try {
    const files = fs.readdirSync(SNAPSHOT_LOG_DIR).filter(f => /\.log$/i.test(f));
    if (files.length <= 50) return;
    const sorted = files.map(f => ({ f, mtime: fs.statSync(path.join(SNAPSHOT_LOG_DIR, f)).mtimeMs }))
      .sort((a,b)=>b.mtime - a.mtime);
    const toDelete = sorted.slice(50);
    toDelete.forEach(({f}) => fs.unlink(path.join(SNAPSHOT_LOG_DIR, f), ()=>{}));
  } catch (_) {}
}, 60_000);
