package com.videowall.client

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.SurfaceView
import android.view.TextureView
import android.widget.Button
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import android.view.Surface
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import okhttp3.HttpUrl
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.app.DownloadManager
import android.net.Uri
import android.media.MediaMetadataRetriever
import java.text.SimpleDateFormat
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.ui.PlayerView
import com.google.android.exoplayer2.ui.AspectRatioFrameLayout
import com.google.android.exoplayer2.Player
import com.google.android.exoplayer2.PlaybackException
import android.view.animation.AccelerateDecelerateInterpolator
import okhttp3.OkHttpClient
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import org.java_websocket.server.WebSocketServer
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.WebSocket as JWebSocket
import com.google.android.exoplayer2.C
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.PixelCopy

class MainActivity : AppCompatActivity() {
    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var imageView: ImageView
    private lateinit var statusText: TextView
    private lateinit var versionText: TextView
    private lateinit var roleBadge: TextView
    private lateinit var wsText: TextView
    private lateinit var ipText: TextView
    private lateinit var cacheProgressWrap: View
    private lateinit var cacheProgressBar: ProgressBar
    private lateinit var cacheProgressText: TextView
    private lateinit var syncBadge: TextView
    private lateinit var idleOverlay: TextView
    private lateinit var btnRetry: Button
    private lateinit var btnSetServer: Button
    private lateinit var btnCycleRole: Button
    private lateinit var btnDownloadApk: Button
    private lateinit var infoCard: View
    private lateinit var bottomBar: View

    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .build()

    private val HOST_PORT = 47999
    private var isHost = false
    private var hostServer: LocalHostServer? = null
    private var peerWs: WebSocket? = null
    private var hostPeerConnected: Boolean = false
    private var hostExpectedRoles: Set<String> = setOf("left", "center", "right")
    private var hostReadyRoles: MutableSet<String> = mutableSetOf()
    private var hostScreensJson: JSONObject? = null
    private var hostPlannedStartAt: Long = 0L
    private var hostPrepareDeadline: Long = 0L

    private var ws: WebSocket? = null
    private var serverTimeOffset: Long = 0L
    private var currentRole = BuildConfig.ROLE
    private var serverUrl = ""
    private var currentPlayId: String? = null
    private var currentMediaPath: String? = null
    private var currentIsImage = false
    private var currentEffect = "fade"
    private var currentViewport: JSONObject? = null
    private var currentFitMode: String = "cover"
    private var loopPlayback = true
    private var mediaReady = false
    private var hasStarted = false
    private var expectedStartAtUtcMs: Long = 0L
    private var discoveryThread: Thread? = null
    private var discoveryRunning = false
    private val heartbeatIntervalMs = 20_000L
    private val syncFastIntervalMs = 1_000L     // first second after start
    private val syncSlowIntervalMs = 60_000L    // thereafter
    private var nextSyncIntervalMs = syncSlowIntervalMs
    private var syncPhaseFastDone = false
    private val useControllerSync = true // 始终由控制端+中屏统一发令
    private var lastPingTs: Long = 0L
    private var lastProgramId: String? = null
    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
    private var updateChecked = false
    private val disableUpdateCheck = false
    private val syncRunnable = object : Runnable {
        override fun run() {
            syncPlayback()
            if (!hasStarted || currentIsImage) return
            // after the first post-start sync, switch to slow interval
            if (!syncPhaseFastDone) {
                syncPhaseFastDone = true
                nextSyncIntervalMs = syncSlowIntervalMs
            }
            handler.postDelayed(this, nextSyncIntervalMs)
        }
    }
    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            sendPing()
            handler.postDelayed(this, heartbeatIntervalMs)
        }
    }
    private val hostTickIntervalMs = 1000L
    private val hostSyncIntervalMs = 800L
    private val hostTickRunnable = object : Runnable {
        override fun run() {
            sendHostTick()
            handler.postDelayed(this, hostTickIntervalMs)
        }
    }
    private val hostSyncRunnable = object : Runnable {
        override fun run() {
            sendHostSync()
            handler.postDelayed(this, hostSyncIntervalMs)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        playerView = findViewById(R.id.playerView)
        imageView = findViewById(R.id.imageView)
        statusText = findViewById(R.id.statusText)
        versionText = findViewById(R.id.versionText)
        roleBadge = findViewById(R.id.roleBadge)
        wsText = findViewById(R.id.wsText)
        ipText = findViewById(R.id.ipText)
        cacheProgressWrap = findViewById(R.id.cacheProgressWrap)
        cacheProgressBar = findViewById(R.id.cacheProgressBar)
        cacheProgressText = findViewById(R.id.cacheProgressText)
        syncBadge = findViewById(R.id.syncBadge)
        idleOverlay = findViewById(R.id.idleOverlay)
        btnRetry = findViewById(R.id.btnRetry)
        btnSetServer = findViewById(R.id.btnSetServer)
        btnCycleRole = findViewById(R.id.btnCycleRole)
        btnDownloadApk = findViewById(R.id.btnDownloadApk)
        infoCard = findViewById(R.id.infoCard)
        bottomBar = findViewById(R.id.bottomBar)

        // Ensure window-level hardware acceleration (defensive; also set in manifest)
        window.setFlags(
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        )

        player = ExoPlayer.Builder(this).build()
        playerView.player = player
        playerView.useController = false
        playerView.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM
        player.videoScalingMode = C.VIDEO_SCALING_MODE_SCALE_TO_FIT
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED && loopPlayback && !currentIsImage) {
                    expectedStartAtUtcMs = System.currentTimeMillis() + serverTimeOffset
                    player.seekTo(0)
                    player.playWhenReady = true
                    applyRepeatMode()
                    scheduleSyncPattern()
                }
            }

            override fun onVideoSizeChanged(videoSize: com.google.android.exoplayer2.video.VideoSize) {
                runOnUiThread {
                    applyViewportToVideo(videoSize.width, videoSize.height)
                }
                logLine("Video size changed w=${videoSize.width} h=${videoSize.height}")
            }

            override fun onPlayerError(error: PlaybackException) {
                logLine("Player error: ${error.errorCodeName} message=${error.message}")
                status("播放错误：${error.errorCodeName}")
            }

            override fun onRenderedFirstFrame() {
                logLine("First frame rendered. role=$currentRole url=$currentMediaPath")
            }
        })

        versionText.text = "v${BuildConfig.VERSION_NAME} | ${BuildConfig.ROLE}"
        ipText.text = "IP: ${localIp()}"
        serverUrl = loadSavedServerUrl()
        updateWsLabel()
        isHost = currentRole == "left"
        logLine("Launch v${BuildConfig.VERSION_NAME} role=$currentRole serverUrl=${if (serverUrl.isBlank()) "unset" else serverUrl}")

        btnRetry.setOnClickListener { connectWs() }
        btnSetServer.setOnClickListener { promptSetServer() }
        btnCycleRole.setOnClickListener { cycleRole() }
        btnDownloadApk.setOnClickListener { downloadApkManual() }
        updateRoleLabel()
        idleOverlay.visibility = View.VISIBLE

        if (serverUrl.isNotBlank()) {
            connectWs()
            checkUpdateByHttp()
        } else {
            status("Server not configured. Tap 'Set Server' and enter ws://x.x.x.x:8088/ws")
            startDiscovery()
        }

        if (isHost) {
            startHostServer()
            attemptAutoResume()
        } else {
            connectToHostPeer()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        stopHeartbeat()
        ws?.close(1000, "bye")
        player.release()
        stopDiscovery()
        hostServer?.stop()
        handler.removeCallbacks(hostTickRunnable)
        handler.removeCallbacks(hostSyncRunnable)
    }

    private fun cycleRole() {
        currentRole = when (currentRole) {
            "left" -> "center"
            "center" -> "right"
            else -> "left"
        }
        isHost = currentRole == "left"
        updateRoleLabel()
        sendHello()
        // 切换角色后，切换主机/从机同步通道
        if (isHost) {
            // 成为主机：关闭从机通道，启动本地主机同步
            peerWs?.cancel()
            hostPeerConnected = false
            startHostServer()
        } else {
            // 成为从机：停止本地主机同步，转而连接主机
            hostServer?.stop()
            hostServer = null
            handler.removeCallbacks(hostTickRunnable)
            handler.removeCallbacks(hostSyncRunnable)
            hostPeerConnected = false
            connectToHostPeer()
        }
    }

    private fun updateRoleLabel() {
        btnCycleRole.text = "Role: $currentRole"
        roleBadge.text = currentRole.uppercase(Locale.getDefault())
    }

    private fun updateWsLabel() {
        wsText.text = if (serverUrl.isBlank()) "WS: not set" else "WS: $serverUrl"
    }

    private fun connectWs() {
        if (serverUrl.isBlank()) {
            status("Server not configured")
            Toast.makeText(this, "Please set server address first", Toast.LENGTH_SHORT).show()
            return
        }
        statusText.text = "Connecting..."
        stopHeartbeat()
        val request = Request.Builder().url(serverUrl).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                logLine("WS connected")
                runOnUiThread {
                    statusText.text = "Connected"
                    Toast.makeText(this@MainActivity, "WS connected", Toast.LENGTH_SHORT).show()
                }
                sendHello()
                startHeartbeat()
                checkUpdateByHttp()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // ignore binary
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                logLine("WS closed code=$code reason=$reason")
                runOnUiThread { statusText.text = "Closed" }
                stopHeartbeat()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                logLine("WS failure: ${t.message}")
                runOnUiThread { statusText.text = "WS error: ${t.message}" }
                stopHeartbeat()
                reconnectLater()
            }
        })
    }

    private fun reconnectLater() {
        handler.postDelayed({ connectWs() }, 5000)
    }

    private fun startDiscovery() {
        if (discoveryRunning) return
        discoveryRunning = true
        discoveryThread = Thread {
            try {
                val socket = DatagramSocket(47888)
                socket.broadcast = true
                val buf = ByteArray(1024)
                while (discoveryRunning && serverUrl.isBlank()) {
                    val packet = DatagramPacket(buf, buf.size)
                    socket.receive(packet)
                    val msg = String(packet.data, 0, packet.length)
                    try {
                        val obj = JSONObject(msg)
                        if (obj.optString("type") == "vw-advertise") {
                            val ws = obj.optString("ws", "")
                            if (ws.startsWith("ws://") || ws.startsWith("wss://")) {
                                serverUrl = ws
                                saveServerUrl(ws)
                                runOnUiThread {
                                    updateWsLabel()
                                    connectWs()
                                    Toast.makeText(this, "Controller found and set", Toast.LENGTH_SHORT).show()
                                }
                            }
                        }
                    } catch (_: Exception) {
                    }
                }
                socket.close()
            } catch (e: Exception) {
                Log.e("DISCOVERY", "udp listen", e)
            }
        }
        discoveryThread?.start()
    }

    private fun stopDiscovery() {
        discoveryRunning = false
        discoveryThread?.interrupt()
        discoveryThread = null
    }

    private fun sendHello() {
        val hello = JSONObject()
        hello.put("type", "hello")
        hello.put("deviceId", deviceId())
        hello.put("role", currentRole)
        ws?.send(hello.toString())
    }

    private fun sendPing() {
        val ping = JSONObject()
        ping.put("type", "ping")
        ping.put("deviceId", deviceId())
        val now = System.currentTimeMillis()
        ping.put("ts", now)
        lastPingTs = now
        ws?.send(ping.toString())
    }

    private fun httpBase(): String? {
        if (serverUrl.isBlank()) return null
        val protoFixed = serverUrl.replaceFirst("ws://", "http://").replaceFirst("wss://", "https://")
        return protoFixed.removeSuffix("/ws")
    }

    private fun logLine(msg: String) {
        val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.getDefault()).format(java.util.Date())
        val line = "$ts [${BuildConfig.ROLE}] $msg\n"
        Log.d("VW", line)
        try {
            val dir = File(filesDir, "logs")
            if (!dir.exists()) dir.mkdirs()
            val f = File(dir, "videowall.log")
            FileOutputStream(f, true).use { it.write(line.toByteArray()) }
            if (f.length() > 800_000) {
                val rotated = File(dir, "videowall-${System.currentTimeMillis()}.log")
                f.renameTo(rotated)
                f.createNewFile()
            }
        } catch (_: Exception) { }
    }

    private fun uploadLogFile() {
        Thread {
            try {
                val dir = File(filesDir, "logs")
                val f = File(dir, "videowall.log")
                if (!f.exists()) {
                    logLine("No log file yet, nothing to upload")
                    return@Thread
                }
                val base = httpBase() ?: run {
                    logLine("Upload log failed: server not set")
                    return@Thread
                }
                val data = f.readBytes()
                val reqBody = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("role", currentRole)
                    .addFormDataPart(
                        "log",
                        "${currentRole}_${System.currentTimeMillis()}.log",
                        data.toRequestBody("text/plain".toMediaType())
                    )
                    .build()
                val req = Request.Builder().url("$base/api/logs").post(reqBody).build()
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
                }
                logLine("Uploaded log file (${data.size} bytes)")
            } catch (e: Exception) {
                logLine("Upload log failed: ${e.message}")
            }
        }.start()
    }

    private fun captureAndUploadSnapshot() {
        Thread {
            try {
                // 捕获必须在主线程访问视图
                var captured: Bitmap? = null
                val latch = CountDownLatch(1)
                runOnUiThread {
                    captured = captureBitmap()
                    latch.countDown()
                }
                latch.await(800, TimeUnit.MILLISECONDS)
                var bmp = captured ?: run {
                    status("Snapshot failed: no surface")
                    logLine("Snapshot failed: no surface")
                    return@Thread
                }
                // 降采样，避免大分辨率 OOM，目标最长边不超过 1920
                val maxSide = maxOf(bmp.width, bmp.height)
                if (maxSide > 1920) {
                    val scale = 1920f / maxSide.toFloat()
                    val w = (bmp.width * scale).toInt().coerceAtLeast(2)
                    val h = (bmp.height * scale).toInt().coerceAtLeast(2)
                    bmp = Bitmap.createScaledBitmap(bmp, w, h, true)
                    logLine("Snapshot downscale to ${w}x${h}")
                }
                val bos = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.PNG, 100, bos)
                val data = bos.toByteArray()
                val base = httpBase() ?: run {
                    status("Snapshot failed: server not set")
                    logLine("Snapshot failed: server not set")
                    return@Thread
                }
                val reqBody = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("role", currentRole)
                    .addFormDataPart(
                        "snap",
                        "${currentRole}_${System.currentTimeMillis()}.png",
                        data.toRequestBody("image/png".toMediaType())
                    )
                    .build()
                val req = Request.Builder()
                    .url("$base/api/snapshot")
                    .post(reqBody)
                    .build()
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
                }
                runOnUiThread { status("Snapshot uploaded") }
                logLine("Snapshot uploaded (${data.size} bytes)")
            } catch (e: Exception) {
                runOnUiThread { status("Snapshot failed: ${e.message}") }
                logLine("Snapshot failed: ${e.message}")
                try {
                    val base = httpBase()
                    if (base != null) {
                        val json = "{\"role\":\"$currentRole\",\"error\":\"${e.message}\"}"
                        val body = json.toRequestBody("application/json".toMediaType())
                        val req = Request.Builder()
                            .url("$base/api/snapshot-error")
                            .post(body)
                            .build()
                        client.newCall(req).execute().close()
                    }
                } catch (_: Exception) { }
            }
        }.start()
    }

    private fun captureBitmap(): Bitmap? {
        fun isMostlyBlank(bmp: Bitmap): Boolean {
            val stepX = (bmp.width / 24).coerceAtLeast(1)
            val stepY = (bmp.height / 24).coerceAtLeast(1)
            var total = 0
            var meaningful = 0
            var y = 0
            while (y < bmp.height) {
                var x = 0
                while (x < bmp.width) {
                    val px = bmp.getPixel(x, y)
                    val a = (px ushr 24) and 0xFF
                    val r = (px ushr 16) and 0xFF
                    val g = (px ushr 8) and 0xFF
                    val b = px and 0xFF
                    val lum = (r * 299 + g * 587 + b * 114) / 1000
                    if (a > 16 && lum > 8) meaningful++
                    total++
                    x += stepX
                }
                y += stepY
            }
            return meaningful * 1.0 / total < 0.02 // 少于 2% 有亮度的像素，视为黑/透明空图
        }

        fun grabTexturePixelCopy(): Bitmap? {
            val tex = playerView.videoSurfaceView as? TextureView ?: return null
            if (!tex.isAvailable || tex.width <= 10 || tex.height <= 10) return null
            if (android.os.Build.VERSION.SDK_INT < 24) return null
            val st = tex.surfaceTexture ?: return null
            val bmp = Bitmap.createBitmap(tex.width, tex.height, Bitmap.Config.ARGB_8888)
            val latch = CountDownLatch(1)
            var ok = false
            try {
                val surf = Surface(st)
                PixelCopy.request(surf, bmp, { res ->
                    ok = res == PixelCopy.SUCCESS
                    latch.countDown()
                }, handler)
                surf.release()
                latch.await(400, TimeUnit.MILLISECONDS)
            } catch (e: Exception) {
                logLine("Snapshot pixelCopy tex failed: ${e.message}")
            }
            return if (ok) bmp else null
        }

        fun grabTexture(): Bitmap? {
            val tex = playerView.videoSurfaceView as? TextureView ?: return null
            if (!tex.isAvailable || tex.width <= 10 || tex.height <= 10) return null
            return tex.getBitmap(tex.width, tex.height)
        }

        fun grabImageView(): Bitmap? {
            if (imageView.visibility != View.VISIBLE || imageView.drawable == null) return null
            val w = imageView.width
            val h = imageView.height
            if (w <= 10 || h <= 10) return null
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bmp)
            imageView.draw(canvas)
            return bmp
        }

        fun grabPlayerView(): Bitmap? {
            val w = playerView.width
            val h = playerView.height
            if (w <= 10 || h <= 10) return null
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bmp)
            playerView.draw(canvas)
            return bmp
        }

        fun grabRoot(): Bitmap? {
            val root = window?.decorView?.rootView ?: return null
            val w = root.width.takeIf { it > 0 } ?: root.measuredWidth
            val h = root.height.takeIf { it > 0 } ?: root.measuredHeight
            if (w <= 10 || h <= 10) return null
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bmp)
            root.draw(canvas)
            return bmp
        }

        // 1) 首选视频纹理 / 视图
        val attempts = listOf(::grabTexturePixelCopy, ::grabTexture, ::grabImageView, ::grabPlayerView)
        for (fn in attempts) {
            try {
                var bmp = fn.invoke()
                if (bmp != null && isMostlyBlank(bmp)) {
                    logLine("Snapshot ${fn.name} blank, fallback...")
                    bmp = null
                }
                if (bmp != null) {
                    logLine("Snapshot source=${fn.name} size=${bmp.width}x${bmp.height}")
                    return bmp
                }
            } catch (e: Exception) {
                logLine("Snapshot ${fn.name} failed: ${e.message}")
            }
        }

        // 2) 媒体文件解码（视频取当前帧，图片直接读），避免视图为空
        val mediaPath = currentMediaPath
        if (mediaPath != null && File(mediaPath).exists()) {
            try {
                if (currentIsImage) {
                    BitmapFactory.decodeFile(mediaPath)?.let { bmp ->
                        if (!isMostlyBlank(bmp)) {
                            logLine("Snapshot source=fileImage size=${bmp.width}x${bmp.height}")
                            return bmp
                        }
                    }
                } else {
                    val retriever = MediaMetadataRetriever()
                    retriever.setDataSource(mediaPath)
                    val posUs = (player.currentPosition.coerceAtLeast(0) * 1000)
                    val bmp = retriever.getFrameAtTime(posUs, MediaMetadataRetriever.OPTION_CLOSEST) ?:
                        retriever.getFrameAtTime(-1)
                    retriever.release()
                    if (bmp != null && !isMostlyBlank(bmp)) {
                        logLine("Snapshot source=retriever size=${bmp.width}x${bmp.height} posMs=${player.currentPosition}")
                        return bmp
                    } else {
                        logLine("Snapshot retriever returned blank/null")
                    }
                }
            } catch (e: Exception) {
                logLine("Snapshot file decode failed: ${e.message}")
            }
        }

        // 3) 最后兜底整个 root 视图（包含 UI）
        try {
            val bmp = grabRoot()
            if (bmp != null && !isMostlyBlank(bmp)) {
                logLine("Snapshot source=root size=${bmp.width}x${bmp.height}")
                return bmp
            }
        } catch (e: Exception) {
            logLine("Snapshot root failed: ${e.message}")
        }

        logLine("Snapshot all sources failed")
        return null
    }

    /**
     * 从机连接主机（中心屏）的小型 WS 服务，做对时与同步。
     */
    private fun connectToHostPeer() {
        val hostUrl = loadHostUrl()
        if (hostUrl.isBlank()) {
            status("Host WS not set")
            return
        }
        val req = Request.Builder().url(hostUrl).build()
        peerWs?.cancel()
        peerWs = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                hostPeerConnected = true
                val hello = JSONObject()
                hello.put("type", "hello")
                hello.put("role", currentRole)
                hello.put("deviceId", deviceId())
                webSocket.send(hello.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleHostMessage(text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                hostPeerConnected = false
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e("HOST", "peer ws fail", t)
                hostPeerConnected = false
                handler.postDelayed({ connectToHostPeer() }, 5000)
            }
        })
    }

    private fun handleHostMessage(text: String) {
        try {
            val obj = JSONObject(text)
            when (obj.getString("type")) {
                "tick" -> {
                    val hostNow = obj.optLong("hostNow", 0L)
                    val echo = obj.optLong("echo", 0L)
                    if (hostNow > 0 && echo > 0) {
                        val now = System.currentTimeMillis()
                        val rtt = (now - echo).coerceAtLeast(1L)
                        val offset = hostNow - (echo + rtt / 2)
                        serverTimeOffset = ((serverTimeOffset * 0.3) + (offset * 0.7)).toLong()
                    }
                }
                "prepare" -> {
                    val id = obj.optString("id", "")
                    val startAt = obj.optLong("startAtHostMs", 0L)
                    loopPlayback = obj.optBoolean("loop", true)
                    expectedStartAtUtcMs = startAt
                    val slice = obj.optJSONObject("screens")?.optJSONObject(currentRole)
                    val url = slice?.optString("url", "") ?: ""
                    val checksum = slice?.optString("checksum", "") ?: ""
                    val legacyStartAt = startAt
                    status("Host prepare: buffering...")
                    showCacheProgress(0)
                    Thread {
                        val local = cacheOrDownload(url, checksum) { pct -> showCacheProgress(pct) }
                        currentMediaPath = local ?: url
                        currentPlayId = id
                        currentIsImage = isImage(url)
                        val audio = slice?.optBoolean("audio", currentRole == "center") ?: (currentRole == "center")
                        if (currentIsImage && local == null) {
                            runOnUiThread { status("Image download failed") }
                            return@Thread
                        }
                        runOnUiThread {
                            if (currentIsImage) {
                                mediaReady = true
                                sendHostReady(id)
                                status("Image cached, waiting start")
                            } else {
                                try {
                                    val mediaItem = MediaItem.fromUri(currentMediaPath ?: url)
                                    player.setMediaItem(mediaItem)
                                    player.volume = if (audio) 1f else 0f
                                    player.prepare()
                                    mediaReady = true
                                    sendHostReady(id)
                                    status("Video cached, waiting start")
                                    hideCacheProgress()
                                } catch (e: Exception) {
                                    status("Load failed: ${e.message}")
                                    hideCacheProgress()
                                }
                            }
                        }
                    }.start()
                }
                "start" -> {
                    expectedStartAtUtcMs = obj.optLong("startAtHostMs", System.currentTimeMillis())
                    val startObj = JSONObject()
                    startObj.put("type", "start")
                    startObj.put("playId", obj.optString("id", ""))
                    startObj.put("startAtUtcMs", expectedStartAtUtcMs)
                    startObj.put("fromHost", true)
                    handleStart(startObj)
                }
                "sync" -> {
                    val expectedPos = obj.optLong("expectedPosMs", -1)
                    if (!hasStarted || currentIsImage || expectedPos < 0) return
                    val actual = player.currentPosition
                    val drift = actual - expectedPos
                    val maxSeekDrift = 150
                    val adjustDrift = 40
                    when {
                        kotlin.math.abs(drift) > maxSeekDrift -> {
                            player.seekTo(expectedPos.coerceAtLeast(0))
                            player.playbackParameters = player.playbackParameters.withSpeed(1f)
                        }
                        kotlin.math.abs(drift) > adjustDrift -> {
                            val speed = if (drift > 0) 0.97f else 1.03f
                            player.playbackParameters = player.playbackParameters.withSpeed(speed)
                        }
                        else -> {
                            if (player.playbackParameters.speed != 1f) {
                                player.playbackParameters = player.playbackParameters.withSpeed(1f)
                            }
                        }
                    }
                }
                "stop" -> stopPlayback("Host stopped")
            }
        } catch (e: Exception) {
            Log.e("HOST", "parse host msg", e)
        }
    }

    private fun handleMessage(text: String) {
        try {
            val obj = JSONObject(text)
            when (obj.getString("type")) {
                "welcome" -> {
                    serverTimeOffset = obj.optLong("serverTime") - System.currentTimeMillis()
                    obj.optJSONObject("apk")?.let { checkUpdate(it) }
                }

                "synctime" -> serverTimeOffset = obj.optLong("serverTime") - System.currentTimeMillis()
                "pong" -> handlePong(obj)
                "play" -> try {
                    handlePlay(obj)
                } catch (e: Exception) {
                    Log.e("WS", "play error payload=$text", e)
                    status("Play parse error: ${e.message ?: e.javaClass.simpleName}")
                }

                "start" -> try {
                    handleStart(obj)
                } catch (e: Exception) {
                    Log.e("WS", "start error", e)
                    status("Start command error")
                }

                "stop" -> runOnUiThread { stopPlayback("Stopped") }
                "snapshot" -> captureAndUploadSnapshot()
                "upload-log" -> uploadLogFile()
                "power" -> handlePower(obj)
                "updateApk" -> handleUpdateApk(obj)
                "await-start" -> handleAwaitStart(obj)
                else -> {
                    logLine("Unknown WS msg: $text")
                }
            }
        } catch (e: Exception) {
            logLine("WS parse error: ${e.message}")
        }
    }

    private fun handlePlay(obj: JSONObject) {
        val playId = obj.optString("playId", "legacy_${System.currentTimeMillis()}")
        val programId = obj.optString("programId", "")
        val screens = obj.optJSONObject("screens")
        if (screens == null) {
            status("Play payload missing screens")
            Log.e("WS", "play missing screens: $obj")
            return
        }
        val screenObj = screens.optJSONObject(currentRole)
        if (screenObj == null) {
            status("No slice for role $currentRole")
            Log.e("WS", "play missing slice for $currentRole: $obj")
            return
        }
        val url = screenObj.optString("url")
        val checksum = screenObj.optString("checksum", "")
        val audio = screenObj.optBoolean("audio", currentRole == "center")
        currentEffect = screenObj.optString("effect", "fade")
        // 客户端不再做本地裁剪，始终全屏铺放
        currentViewport = null
        currentFitMode = "fill"
        resetVideoTransform()
        if (url.isBlank()) {
            status("No playback URL received")
            logLine("Play command missing url")
            return
        }

        if (programId.isNotEmpty() && programId != lastProgramId) {
            clearProgramCache()
            lastProgramId = programId
        }

        currentPlayId = playId
        loopPlayback = obj.optBoolean("loop", true)
        applyRepeatMode()
        currentIsImage = isImage(url)
        mediaReady = false
        hasStarted = false
        expectedStartAtUtcMs = obj.optLong("startAtUtcMs", 0L)
        if (isHost) {
            if (!useControllerSync) {
                hostScreensJson = screens
                hostExpectedRoles = screens.keys().asSequence().toSet()
                hostReadyRoles.clear()
            }
        }
        currentMediaPath = null
        logLine("Play command programId=$programId playId=$playId url=$url isImage=$currentIsImage audio=$audio")
        val legacyStartAt = obj.optLong("startAtUtcMs", 0L)
        status("Buffering... (等待统一开始)")
        resetVideoTransform()

       Thread {
           showCacheProgress(0)
            val local = cacheOrDownload(url, checksum) { pct -> showCacheProgress(pct) }
            if (currentIsImage && local == null) {
                runOnUiThread { statusText.text = "Image download failed" }
                logLine("Image download failed, url=$url")
                hideCacheProgress()
                return@Thread
            }
            currentMediaPath = local ?: url
            if (currentIsImage) {
                runOnUiThread {
                    mediaReady = true
                    sendReady(playId)
                    if (!useControllerSync) hostOnMediaReady()
                    statusText.text = "Image cached, waiting to sync start"
                    scheduleFallbackStart(playId, legacyStartAt)
                    hideCacheProgress()
                    logLine("Image ready path=$currentMediaPath playId=$playId")
                }
            } else {
                val mediaPath = currentMediaPath ?: return@Thread
                val mediaItem = MediaItem.fromUri(mediaPath)
                runOnUiThread {
                    try {
                        player.setMediaItem(mediaItem)
                        player.volume = if (audio) 1f else 0f
                        player.prepare()
                        val vs = player.videoSize
                        applyViewportToVideo(vs.width, vs.height)
                        applyRepeatMode()
                        mediaReady = true
                        sendReady(playId)
                        if (!useControllerSync) hostOnMediaReady()
                        statusText.text = "Video cached, waiting to sync start"
                        scheduleFallbackStart(playId, legacyStartAt)
                        hideCacheProgress()
                        logLine("Video ready path=$mediaPath audio=$audio playId=$playId")
                    } catch (e: Exception) {
                        statusText.text = "Load failed: ${e.message}"
                        logLine("Video prepare failed: ${e.message}")
                        hideCacheProgress()
                    }
                }
            }
        }.start()
    }

    private fun hostOnMediaReady() {
        if (!isHost || useControllerSync) return
        hostReadyRoles.add(currentRole)
        val startAt = nowHost() + 6000
        hostBroadcastPrepare(startAt)
        // 记录最近节目以便开机自播
        hostScreensJson?.let {
            prefs().edit()
                .putString("last_program_id", currentPlayId ?: "")
                .putString("last_screens_json", it.toString())
                .apply()
        }
    }

    private fun handleStart(obj: JSONObject) {
        val playId = obj.optString("playId", "")
        val fromHost = obj.optBoolean("fromHost", false)
        if (isHost && !fromHost) return  // 主机仅接受自身下发的同步指令
        if (!isHost && hostPeerConnected && !fromHost) return // 从机等待左屏的同步指令
        if (playId.isNotEmpty() && playId != currentPlayId) return
        if (!mediaReady) return
        loopPlayback = obj.optBoolean("loop", loopPlayback)
        applyRepeatMode()
        expectedStartAtUtcMs = obj.optLong("startAtUtcMs", System.currentTimeMillis())
        val delay = expectedStartAtUtcMs - (System.currentTimeMillis() + serverTimeOffset)
        logLine("Start playback delay=${delay}ms playId=$playId loop=$loopPlayback fromHost=$fromHost")

        if (currentIsImage) {
            val path = currentMediaPath ?: return
            val runnable = Runnable {
                val bmp = BitmapFactory.decodeFile(path)
                if (bmp != null) {
                    imageView.setImageBitmap(bmp)
                    handler.post { applyViewportToImage(bmp.width, bmp.height) }
                    imageView.visibility = View.VISIBLE
                    playerView.visibility = View.GONE
                    hasStarted = true
                    setUiVisible(false)
                    idleOverlay.visibility = View.GONE
                    status("Showing image")
                    showSyncNotice("同步开始 " + timeFmt.format(System.currentTimeMillis()))
                    applyEffect(currentEffect)
                    logLine("Showing image path=$path w=${bmp.width} h=${bmp.height}")
                } else {
                    status("Display image failed (decode null)")
                    logLine("Display image failed decode null path=$path")
                }
            }
            if (delay > 0) handler.postDelayed(runnable, delay) else runnable.run()
        } else {
            val runnable = Runnable {
                val mediaPath = currentMediaPath
                if (mediaPath == null) {
                    status("Playback failed: not cached")
                    logLine("Playback failed: not cached")
                    return@Runnable
                }
                try {
                    imageView.visibility = View.GONE
                    playerView.visibility = View.VISIBLE
                    hasStarted = true
                    setUiVisible(false)
                    idleOverlay.visibility = View.GONE
                    player.playWhenReady = true
                    scheduleSyncPattern()
                    showSyncNotice("同步开始 " + timeFmt.format(System.currentTimeMillis()))
                    applyEffect(currentEffect)
                    status("Playing")
                    logLine("Start playing video path=$mediaPath time=${System.currentTimeMillis()}")
                } catch (e: Exception) {
                    Log.e("PLAY", "start runnable", e)
                    logLine("Start runnable failed: ${e.message}")
                    status("Playback failed: ${e.message}")
                }
            }
            if (delay > 0) handler.postDelayed(runnable, delay) else runnable.run()
        }
    }

    private fun handleAwaitStart(obj: JSONObject) {
        val playId = obj.optString("playId", "")
        val startAt = obj.optLong("startAtUtcMs", System.currentTimeMillis() + 2000)
        status("等待中屏统一开始...")
        logLine("Await-start received playId=$playId startAt=$startAt")
        if (currentRole == "center") {
            try {
                val msg = JSONObject()
                msg.put("type", "start-confirm")
                msg.put("playId", playId)
                msg.put("startAtUtcMs", startAt)
                ws?.send(msg.toString())
                logLine("start-confirm sent playId=$playId startAt=$startAt")
            } catch (e: Exception) {
                logLine("start-confirm send failed: ${e.message}")
            }
        }
    }

    private fun handlePower(obj: JSONObject) {
        val action = obj.optString("action", "sleep")
        if (action == "sleep") {
            runOnUiThread {
                player.pause()
                statusText.text = "Sleep/Pause"
            }
        } else if (action == "wake") {
            runOnUiThread {
                player.playWhenReady = true
                statusText.text = "Wake"
            }
        } else if (action == "reboot") {
            runOnUiThread { statusText.text = "Reboot requested (not implemented)" }
        }
    }

    private fun deviceId(): String {
        return android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.ANDROID_ID)
    }

    override fun dispatchKeyEvent(event: KeyEvent?): Boolean {
        if (event?.action == KeyEvent.ACTION_UP && event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
            connectWs()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun applyEffect(effect: String) {
        val target: View = if (currentIsImage) imageView else playerView
        target.clearAnimation()
        target.alpha = 0f
        target.translationX = 0f
        target.translationY = 0f
        target.scaleX = 1f
        target.scaleY = 1f

        val dur = 320L
        val interp = AccelerateDecelerateInterpolator()
        when (effect.lowercase(Locale.getDefault())) {
            "slide", "push" -> {
                target.translationX = if (currentRole == "left") 80f else if (currentRole == "right") -80f else 60f
                target.alpha = 0.6f
                target.animate().translationX(0f).alpha(1f).setDuration(dur).setInterpolator(interp).start()
            }
            "zoom" -> {
                target.scaleX = 1.08f
                target.scaleY = 1.08f
                target.alpha = 0.6f
                target.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(dur).setInterpolator(interp).start()
            }
            "wipe" -> {
                target.translationX = if (currentRole == "left") -120f else 120f
                target.alpha = 0f
                target.animate().translationX(0f).alpha(1f).setDuration(dur).setInterpolator(interp).start()
            }
            else -> { // fade / default
                target.alpha = 0f
                target.animate().alpha(1f).setDuration(dur).setInterpolator(interp).start()
            }
        }
    }

    private fun showSyncNotice(msg: String) {
        runOnUiThread {
            syncBadge.text = msg
            syncBadge.alpha = 0f
            syncBadge.visibility = View.VISIBLE
            syncBadge.animate().alpha(1f).setDuration(150).withEndAction {
                syncBadge.animate().alpha(0f).setStartDelay(1500).setDuration(300).withEndAction {
                    syncBadge.visibility = View.GONE
                }.start()
            }.start()
        }
    }

    private fun clearProgramCache() {
        try {
            val root = File(cacheDir, "programs")
            if (root.exists()) root.deleteRecursively()
        } catch (e: Exception) {
            Log.e("CACHE", "clear cache", e)
        }
    }

    private fun handleUpdateApk(obj: JSONObject) {
        val url = obj.optString("url", "")
        val checksum = obj.optString("checksum", "")
        if (url.isBlank()) {
            status("Update APK missing url")
            return
        }
        status("Downloading update...")
        Thread {
            val local = cacheOrDownload(url, checksum) { pct -> showCacheProgress(pct) }
            if (local == null) {
                runOnUiThread { statusText.text = "Download apk failed" }
                hideCacheProgress()
                return@Thread
            }
            runOnUiThread {
                hideCacheProgress()
                statusText.text = "Ready to install update"
                installApk(File(local))
            }
        }.start()
    }

    private fun installApk(file: File) {
        try {
            val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.provider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(intent)
        } catch (e: Exception) {
            status("Install failed: ${e.message}")
        }
    }

    private fun applyViewportToVideo(videoW: Int, videoH: Int) {
        val viewport = currentViewport ?: return resetVideoTransform()
        val tv = playerView.videoSurfaceView as? android.view.TextureView ?: return
        val vw = viewport.optDouble("w", 1.0).toFloat().coerceIn(0.05f, 1f)
        val vh = viewport.optDouble("h", 1.0).toFloat().coerceIn(0.05f, 1f)
        val vx = viewport.optDouble("x", 0.0).toFloat().coerceIn(0f, 1f - vw)
        val vy = viewport.optDouble("y", 0.0).toFloat().coerceIn(0f, 1f - vh)

        val matrix = android.graphics.Matrix()
        val scaleX = 1f / vw
        val scaleY = 1f / vh
        matrix.setScale(scaleX, scaleY, 0f, 0f)
        matrix.postTranslate(-vx * scaleX, -vy * scaleY)
        tv.setTransform(matrix)
    }

    private fun resetVideoTransform() {
        val action = fun() {
            val tv = playerView.videoSurfaceView as? android.view.TextureView ?: return
            tv.setTransform(null)
        }
        if (Looper.myLooper() == Looper.getMainLooper()) action() else runOnUiThread { action() }
    }

    private fun applyViewportToImage(bitmapW: Int, bitmapH: Int) {
        val viewport = currentViewport ?: run {
            // 无裁剪时，整图居中裁切铺满
            imageView.scaleType = ImageView.ScaleType.CENTER_CROP
            imageView.imageMatrix = android.graphics.Matrix()
            imageView.invalidate()
            return
        }
        val vw = viewport.optDouble("w", 1.0).toFloat().coerceIn(0.05f, 1f)
        val vh = viewport.optDouble("h", 1.0).toFloat().coerceIn(0.05f, 1f)
        val vx = viewport.optDouble("x", 0.0).toFloat().coerceIn(0f, 1f - vw)
        val vy = viewport.optDouble("y", 0.0).toFloat().coerceIn(0f, 1f - vh)

        val viewW = imageView.width.toFloat().takeIf { it > 0 } ?: return
        val viewH = imageView.height.toFloat().takeIf { it > 0 } ?: return

        val scaleX = viewW / (bitmapW * vw)
        val scaleY = viewH / (bitmapH * vh)
        val scale = maxOf(scaleX, scaleY)
        val matrix = android.graphics.Matrix()
        matrix.setScale(scale, scale)
        val tx = -vx * bitmapW * scale
        val ty = -vy * bitmapH * scale
        matrix.postTranslate(tx, ty)
        imageView.imageMatrix = matrix
        imageView.invalidate()
    }

    private fun startHeartbeat() {
        handler.removeCallbacks(heartbeatRunnable)
        handler.postDelayed(heartbeatRunnable, heartbeatIntervalMs)
    }

    private fun stopHeartbeat() {
        handler.removeCallbacks(heartbeatRunnable)
    }

    private fun cacheOrDownload(url: String, checksum: String, onProgress: (Int) -> Unit = {}): String? {
        if (url.isEmpty()) return null
        val resolved = resolveAbsoluteUrl(url) ?: run {
            logLine("cacheOrDownload resolve failed url=$url")
            return null
        }
        val cacheRoot = File(cacheDir, "programs")
        if (!cacheRoot.exists()) cacheRoot.mkdirs()
        val fileName = checksum.takeIf { it.isNotEmpty() }?.take(12)?.plus("_") ?: ""
        val guessed = resolved.substringAfterLast('/', "media").substringBefore("?").ifBlank { "media" }
        val target = File(cacheRoot, fileName + guessed)
        if (target.exists() && (checksum.isEmpty() || sha256(target) == checksum)) {
            logLine("cache hit $target checksum=${if (checksum.isEmpty()) "skip" else "ok"}")
            return target.absolutePath
        }

        val request = try {
            Request.Builder().url(resolved).build()
        } catch (e: IllegalArgumentException) {
            logLine("cacheOrDownload bad url $resolved : ${e.message}")
            return null
        }
        try {
            logLine("download start url=$resolved target=${target.absolutePath} checksum=${checksum.take(8)}")
            showCacheProgress(0)
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) throw IllegalStateException("http ${resp.code}")
                val body = resp.body ?: throw IllegalStateException("empty body")
                val total = body.contentLength().coerceAtLeast(0L)
                val sink = FileOutputStream(target)
                body.byteStream().use { input ->
                    val buf = ByteArray(16_384)
                    var read: Int
                    var copied = 0L
                    while (true) {
                        read = input.read(buf)
                        if (read <= 0) break
                        sink.write(buf, 0, read)
                        copied += read
                        if (total > 0) {
                            val pct = ((copied * 100) / total).toInt().coerceIn(0, 100)
                            onProgress(pct)
                        } else {
                            onProgress(-1)
                        }
                    }
                }
                sink.flush()
                sink.close()
                onProgress(100)
            }
            if (checksum.isNotEmpty() && sha256(target) != checksum) {
                target.delete()
                throw IllegalStateException("checksum mismatch")
            }
            logLine("download ok -> ${target.absolutePath} size=${target.length()}")
            return target.absolutePath
        } catch (e: Exception) {
            logLine("download failed: ${e.message}")
            return null
        } finally {
            hideCacheProgress()
        }
    }

    private fun showCacheProgress(pct: Int) {
        runOnUiThread {
            cacheProgressWrap.visibility = View.VISIBLE
            if (pct >= 0) {
                cacheProgressBar.isIndeterminate = false
                cacheProgressBar.progress = pct
                cacheProgressText.text = "${pct}%"
            } else {
                cacheProgressBar.isIndeterminate = true
                cacheProgressText.text = "--%"
            }
        }
    }

    private fun hideCacheProgress() {
        runOnUiThread {
            cacheProgressWrap.visibility = View.GONE
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { fis ->
            val buffer = ByteArray(8_192)
            while (true) {
                val read = fis.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun handlePong(obj: JSONObject) {
        val serverTs = obj.optLong("serverTime", 0L)
        val echo = obj.optLong("echo", 0L)
        if (serverTs == 0L || echo == 0L) return
        val now = System.currentTimeMillis()
        val rtt = (now - echo).coerceAtLeast(1L)
        val offsetEstimate = serverTs - (echo + rtt / 2)
        // 平滑更新，突出最新测量
        serverTimeOffset = ((serverTimeOffset * 0.3) + (offsetEstimate * 0.7)).toLong()
    }

    private fun applyRepeatMode() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            handler.post { applyRepeatMode() }
            return
        }
        player.repeatMode = if (loopPlayback && !currentIsImage) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    }

    private fun scheduleSyncPattern() {
        if (currentIsImage) return
        handler.removeCallbacks(syncRunnable)
        // immediate sync once
        syncPlayback()
        // first follow-up after 1s, then 60s cadence
        syncPhaseFastDone = false
        nextSyncIntervalMs = syncFastIntervalMs
        handler.postDelayed(syncRunnable, nextSyncIntervalMs)
    }

    private fun syncPlayback() {
        if (!hasStarted || !mediaReady || currentIsImage || expectedStartAtUtcMs == 0L) return
        val expectedPos = (System.currentTimeMillis() + serverTimeOffset) - expectedStartAtUtcMs
        if (expectedPos < 0) return
        val actual = player.currentPosition
        val drift = actual - expectedPos
        val maxSeekDrift = 100 // ms
        val adjustDrift = 25   // ms
        when {
            kotlin.math.abs(drift) > maxSeekDrift -> {
                player.seekTo(expectedPos.coerceAtLeast(0))
                player.playbackParameters = player.playbackParameters.withSpeed(1f)
            }
            kotlin.math.abs(drift) > adjustDrift -> {
                val speed = if (drift > 0) 0.985f else 1.015f
                player.playbackParameters = player.playbackParameters.withSpeed(speed)
            }
            else -> {
                if (player.playbackParameters.speed != 1f) {
                    player.playbackParameters = player.playbackParameters.withSpeed(1f)
                }
            }
        }
    }

    /**
     * 将控制端返回的 /media/xxx 或 media/xxx 相对路径，转换为可下载的 http(s) 绝对地址。
     */
    private fun resolveAbsoluteUrl(raw: String): String? {
        if (raw.isBlank()) return null
        if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("file://")) return raw
        if (raw.startsWith("//")) return "http:${raw}"
        var baseSrc = if (serverUrl.isNotBlank()) serverUrl else BuildConfig.WS_URL
        baseSrc = when {
            baseSrc.startsWith("wss://") -> baseSrc.replaceFirst("wss://", "https://")
            baseSrc.startsWith("ws://") -> baseSrc.replaceFirst("ws://", "http://")
            baseSrc.startsWith("http://") || baseSrc.startsWith("https://") -> baseSrc
            else -> "http://${baseSrc.removePrefix("//")}"
        }
        baseSrc = baseSrc.removeSuffix("/ws").removeSuffix("/")
        if (baseSrc.isBlank()) return null
        val trimmed = if (raw.startsWith("/")) raw else "/$raw"
        return baseSrc + trimmed
    }

    // Host functions
    private fun startHostServer() {
        if (!isHost) return
        if (hostServer == null) {
            try {
                hostServer = LocalHostServer(InetSocketAddress(HOST_PORT))
                hostServer?.start()
                handler.postDelayed(hostTickRunnable, hostTickIntervalMs)
            } catch (e: Exception) {
                Log.e("HOST", "start host ws failed", e)
                runOnUiThread { status("主机同步服务启动失败: ${e.message}") }
                hostServer = null
            }
        }
    }

    private fun sendHostTick() {
        if (!isHost) return
        val obj = JSONObject()
        obj.put("type", "tick")
        obj.put("hostNow", System.currentTimeMillis())
        obj.put("echo", System.currentTimeMillis())
        hostServer?.broadcast(obj.toString())
    }

    private fun sendHostSync() {
        if (!isHost || !hasStarted || currentIsImage) return
        val obj = JSONObject()
        obj.put("type", "sync")
        obj.put("id", currentPlayId ?: "")
        obj.put("hostNow", System.currentTimeMillis())
        obj.put("expectedPosMs", player.currentPosition)
        hostServer?.broadcast(obj.toString())
    }

    private fun hostBroadcastPrepare(startAt: Long) {
        if (!isHost || hostScreensJson == null) return
        hostPlannedStartAt = startAt
        hostPrepareDeadline = nowHost() + 30_000 // 最多等待 30 秒
        val obj = JSONObject()
        obj.put("type", "prepare")
        obj.put("id", currentPlayId ?: "")
        obj.put("startAtHostMs", startAt)
        obj.put("screens", hostScreensJson)
        obj.put("loop", loopPlayback)
        hostServer?.broadcast(obj.toString())
        hostMaybeStart(startAt)
    }

    private fun hostMaybeStart(startAt: Long) {
        if (!isHost) return
        val target = if (hostPlannedStartAt > 0) hostPlannedStartAt else startAt
        val need = hostExpectedRoles
        val readyAll = hostReadyRoles.containsAll(need)
        val now = nowHost()
        val expired = hostPrepareDeadline > 0 && now >= hostPrepareDeadline
        if (readyAll || expired) {
            hostSendStart(target)
        } else {
            handler.postDelayed({ hostMaybeStart(target) }, 800)
        }
    }

    private fun hostSendStart(startAt: Long) {
        if (!isHost) return
        val safeStart = if (startAt <= nowHost()) nowHost() + 1500 else startAt
        expectedStartAtUtcMs = safeStart
        hostPrepareDeadline = 0L
        val obj = JSONObject()
        obj.put("type", "start")
        obj.put("id", currentPlayId ?: "")
        obj.put("startAtHostMs", safeStart)
        obj.put("loop", loopPlayback)
        obj.put("fromHost", true)
        hostServer?.broadcast(obj.toString())
        // 让本机也按同一时间启动
        val selfStart = JSONObject()
        selfStart.put("type", "start")
        selfStart.put("playId", currentPlayId ?: "")
        selfStart.put("startAtUtcMs", safeStart)
        selfStart.put("loop", loopPlayback)
        selfStart.put("fromHost", true)
        handleStart(selfStart)
        handler.removeCallbacks(hostSyncRunnable)
        handler.postDelayed(hostSyncRunnable, hostSyncIntervalMs)
    }

    private fun nowHost(): Long = System.currentTimeMillis()

    private fun attemptAutoResume() {
        if (!isHost) return
        val lastId = prefs().getString("last_program_id", "") ?: ""
        val screensStr = prefs().getString("last_screens_json", "") ?: ""
        if (lastId.isBlank() || screensStr.isBlank()) return
        try {
            val screens = JSONObject(screensStr)
            val fake = JSONObject()
            fake.put("playId", lastId)
            fake.put("screens", screens)
            fake.put("startAtUtcMs", System.currentTimeMillis() + 8000)
            handlePlay(fake)
        } catch (e: Exception) {
            Log.e("HOST", "auto resume parse", e)
        }
    }

    inner class LocalHostServer(addr: InetSocketAddress) : WebSocketServer(addr) {
        private val roleMap = ConcurrentHashMap<JWebSocket, String>()

        override fun onOpen(conn: JWebSocket?, handshake: ClientHandshake?) {
            Log.i("HOST", "peer connected ${conn?.remoteSocketAddress}")
        }

        override fun onClose(conn: JWebSocket?, code: Int, reason: String?, remote: Boolean) {
            conn?.let { roleMap.remove(it) }
            Log.i("HOST", "peer closed $reason")
        }

        override fun onMessage(conn: JWebSocket?, message: String?) {
            if (message == null || conn == null) return
            try {
                val obj = JSONObject(message)
                when (obj.optString("type")) {
                    "hello" -> {
                        val role = obj.optString("role", "unknown")
                        roleMap[conn] = role
                    }
                    "ready" -> {
                        val role = obj.optString("role", "")
                        if (role.isNotBlank()) {
                            hostReadyRoles.add(role)
                            hostMaybeStart(nowHost() + 1500)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("HOST", "handle peer msg", e)
            }
        }

        override fun onError(conn: JWebSocket?, ex: Exception?) {
            Log.e("HOST", "ws error", ex)
            runOnUiThread { status("主机同步 ws.error: ${ex?.message ?: "unknown"}") }
        }

        override fun onStart() {
            Log.i("HOST", "local host WS started on $HOST_PORT")
        }
    }

    private fun status(msg: String) {
        val trimmed = if (msg.length > 120) msg.take(117) + "..." else msg
        runOnUiThread { statusText.text = trimmed }
    }

    private fun setUiVisible(show: Boolean) {
        val action = {
            val vis = if (show) View.VISIBLE else View.GONE
            infoCard.visibility = vis
            bottomBar.visibility = vis
        }
        if (Looper.myLooper() == Looper.getMainLooper()) action() else runOnUiThread { action() }
    }

    private fun sendReady(playId: String) {
        val ready = JSONObject()
        ready.put("type", "ready")
        ready.put("deviceId", deviceId())
        ready.put("role", currentRole)
        ready.put("playId", playId)
        ws?.send(ready.toString())
    }

    private fun sendHostReady(id: String) {
        if (isHost) return
        val obj = JSONObject()
        obj.put("type", "ready")
        obj.put("id", id)
        obj.put("role", currentRole)
        obj.put("deviceId", deviceId())
        peerWs?.send(obj.toString())
    }

    private fun scheduleFallbackStart(playId: String, startAt: Long) {
        if (useControllerSync) return // 统一由控制端/中屏调度
        if (isHost) return // 主机自行调度 start，不做兜底
        if (hostPeerConnected) return // 已连接主机，等待主机下发 start
        handler.postDelayed({
            if (hasStarted || !mediaReady || currentPlayId != playId) return@postDelayed
            val fallbackStart = if (startAt > 0) startAt else System.currentTimeMillis() + 800
            val obj = JSONObject()
            obj.put("type", "start")
            obj.put("playId", playId)
            obj.put("startAtUtcMs", fallbackStart)
            handleStart(obj)
        }, 5000)
    }

    private fun stopPlayback(reason: String = "") {
        val action = {
            hasStarted = false
            mediaReady = false
            currentPlayId = null
            player.stop()
            handler.removeCallbacks(syncRunnable)
            handler.removeCallbacks(hostSyncRunnable)
            player.playbackParameters = player.playbackParameters.withSpeed(1f)
            imageView.setImageDrawable(null)
            imageView.visibility = View.GONE
            playerView.visibility = View.VISIBLE
            setUiVisible(true)
            idleOverlay.visibility = View.VISIBLE
            if (reason.isNotEmpty()) status(reason)
        }
        if (Looper.myLooper() == Looper.getMainLooper()) action() else runOnUiThread { action() }
    }

    private fun isImage(url: String): Boolean {
        val lower = url.lowercase(Locale.getDefault())
        return lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") ||
            lower.endsWith(".webp") || lower.endsWith(".bmp") || lower.endsWith(".gif")
    }

    private fun checkUpdate(manifest: JSONObject) {
        try {
            val remoteVer = manifest.optString("version", "")
            if (remoteVer.isBlank()) {
                runOnUiThread { status("Update manifest empty") }
                return
            }
            if (compareVersion(remoteVer, BuildConfig.VERSION_NAME) <= 0) {
                runOnUiThread { status("已是最新版本 v${BuildConfig.VERSION_NAME}") }
                return
            }
            val files = manifest.optJSONObject("files") ?: run {
                runOnUiThread { status("Update manifest missing files") }
                return
            }
            var url = files.optString(currentRole, files.optString("universal", ""))
            if (url.isBlank()) {
                runOnUiThread { status("Update url missing") }
                return
            }
            if (url.startsWith("/")) {
                url = wsToHttp(serverUrl) + url
            }
            status("发现新版本 $remoteVer，自动下载中...")
            enqueueDownload(url, "update-${currentRole}.apk")
        } catch (e: Exception) {
            Log.e("UPDATE", "check", e)
            runOnUiThread { status("更新检查失败") }
        }
    }

    private fun downloadApkManual() {
        if (serverUrl.isBlank()) {
            status("请先配置服务器地址")
            return
        }
        Thread {
            try {
                val httpUrl = wsToHttp(serverUrl) + "/apk/manifest.json"
                val req = Request.Builder().url(httpUrl).build()
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) throw IllegalStateException("http ${resp.code}")
                    val body = resp.body?.string() ?: throw IllegalStateException("empty body")
                    val manifest = JSONObject(body)
                    val files = manifest.optJSONObject("files") ?: throw IllegalStateException("missing files")
                    var url = files.optString(currentRole, files.optString("universal", ""))
                    if (url.isBlank()) throw IllegalStateException("url missing for role $currentRole")
                    if (url.startsWith("/")) {
                        url = wsToHttp(serverUrl) + url
                    }
                    val remoteVer = manifest.optString("version", "unknown")
                    val msg = "当前版本 v${BuildConfig.VERSION_NAME}\n可用版本 v${remoteVer}\n角色: $currentRole\n是否下载更新？"
                    runOnUiThread {
                        AlertDialog.Builder(this)
                            .setTitle("下载APK")
                            .setMessage(msg)
                            .setPositiveButton("下载") { _, _ ->
                                enqueueDownload(url, "update-${currentRole}.apk")
                            }
                            .setNegativeButton("取消", null)
                            .create()
                            .also { it.show(); it.window?.setGravity(android.view.Gravity.CENTER) }
                    }
                }
            } catch (e: Exception) {
                Log.e("UPDATE", "manual download", e)
                runOnUiThread { status("下载失败: ${e.message}") }
            }
        }.start()
    }

    private fun enqueueDownload(url: String, fileName: String) {
        try {
            val mgr = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
            val req = DownloadManager.Request(Uri.parse(url))
                .setTitle(fileName)
                .setDescription("VideoWall APK")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverMetered(true)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            mgr.enqueue(req)
            runOnUiThread {
                status("下载已开始，保存到系统下载目录")
                Toast.makeText(this, "开始下载到下载文件夹: $fileName", Toast.LENGTH_LONG).show()
            }
        } catch (e: Exception) {
            Log.e("UPDATE", "DownloadManager failed, fallback", e)
            // fallback to app私有目录
            try {
                val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
                val target = File(dir, fileName)
                val dlReq = Request.Builder().url(url).build()
                client.newCall(dlReq).execute().use { dl ->
                    if (!dl.isSuccessful) throw IllegalStateException("download http ${dl.code}")
                    FileOutputStream(target).use { out ->
                        dl.body?.byteStream()?.use { it.copyTo(out) } ?: throw IllegalStateException("no content")
                    }
                }
                runOnUiThread {
                    status("已下载到: ${target.absolutePath}")
                    Toast.makeText(this, "下载完成: ${target.absolutePath}", Toast.LENGTH_LONG).show()
                }
            } catch (ex: Exception) {
                Log.e("UPDATE", "fallback download failed", ex)
                runOnUiThread { status("下载失败: ${ex.message}") }
            }
        }
    }

    // install helpers retained for future use but not auto-invoked
    private fun installApkSafe(file: File, fallbackUrl: String) { /* no-op: manual install only */ }
    private fun canInstallPackages(): Boolean = true
    private fun openUrl(url: String) { /* no-op */ }

    private fun checkUpdateByHttp() {
        if (disableUpdateCheck) return
        if (updateChecked) return
        if (serverUrl.isBlank()) return
        Thread {
            try {
                val httpUrl = wsToHttp(serverUrl) + "/apk/manifest.json"
                val req = Request.Builder().url(httpUrl).build()
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return@use
                    val body = resp.body?.string() ?: return@use
                    val manifest = JSONObject(body)
                    updateChecked = true
                    checkUpdate(manifest)
                }
            } catch (e: Exception) {
                Log.e("UPDATE", "http check", e)
                runOnUiThread { status("更新检查失败") }
            }
        }.start()
    }

    private fun wsToHttp(ws: String): String {
        return ws.replaceFirst("^ws://".toRegex(), "http://")
            .replaceFirst("^wss://".toRegex(), "https://")
            .removeSuffix("/ws")
    }

    private fun compareVersion(a: String, b: String): Int {
        val pa = a.split(".")
        val pb = b.split(".")
        val len = maxOf(pa.size, pb.size)
        for (i in 0 until len) {
            val va = pa.getOrNull(i)?.toIntOrNull() ?: 0
            val vb = pb.getOrNull(i)?.toIntOrNull() ?: 0
            if (va != vb) return va - vb
        }
        return 0
    }

    private fun promptSetServer() {
        val edit = android.widget.EditText(this)
        edit.hint = "ws://<controller-ip>:8088/ws"
        edit.setText(if (serverUrl.isBlank()) BuildConfig.WS_URL else serverUrl)
        AlertDialog.Builder(this)
            .setTitle("Set controller WS address")
            .setView(edit)
            .setPositiveButton("Save") { _, _ ->
                val input = edit.text.toString().trim()
                if (input.startsWith("ws://") || input.startsWith("wss://")) {
                    serverUrl = input
                    saveServerUrl(input)
                    updateWsLabel()
                    connectWs()
                } else {
                    Toast.makeText(this, "Address must start with ws:// or wss://", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Cancel", null)
            .create()
            .also { it.show(); it.window?.setGravity(android.view.Gravity.CENTER) }
    }

    private fun prefs() = getSharedPreferences("vw_prefs", Context.MODE_PRIVATE)

    private fun saveServerUrl(url: String) {
        prefs().edit().putString("server_url", url).apply()
    }

    private fun loadSavedServerUrl(): String {
        return prefs().getString("server_url", "") ?: ""
    }

    private fun saveHostUrl(url: String) {
        prefs().edit().putString("host_url", url).apply()
    }

    private fun loadHostUrl(): String {
        val saved = prefs().getString("host_url", "") ?: ""
        if (saved.isNotBlank()) return saved
        // 推断：用控制端 WS 主机替换为 47999
        val baseSrc = if (serverUrl.isNotBlank()) serverUrl else BuildConfig.WS_URL
        val base = if (baseSrc.contains("://")) baseSrc.substringAfter("://").substringBefore("/") else baseSrc
        if (base.isNotBlank()) {
            return "ws://${base.substringBefore(':')}:$HOST_PORT"
        }
        return ""
    }

    private fun localIp(): String {
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces().toList()
            interfaces.forEach { intf ->
                intf.inetAddresses.toList().forEach { addr ->
                    if (!addr.isLoopbackAddress && addr is Inet4Address) {
                        return addr.hostAddress ?: ""
                    }
                }
            }
        } catch (_: Exception) {
        }
        return "unknown"
    }
}
