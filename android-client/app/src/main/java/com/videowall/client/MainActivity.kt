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
import android.widget.Button
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.ui.PlayerView
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap
import org.java_websocket.server.WebSocketServer
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.WebSocket as JWebSocket

class MainActivity : AppCompatActivity() {
    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var imageView: ImageView
    private lateinit var statusText: TextView
    private lateinit var versionText: TextView
    private lateinit var roleBadge: TextView
    private lateinit var wsText: TextView
    private lateinit var ipText: TextView
    private lateinit var btnRetry: Button
    private lateinit var btnSetServer: Button
    private lateinit var btnCycleRole: Button
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
    private var hostExpectedRoles: Set<String> = setOf("left", "center", "right")
    private var hostReadyRoles: MutableSet<String> = mutableSetOf()
    private var hostScreensJson: JSONObject? = null
    private var hostPlannedStartAt: Long = 0L

    private var ws: WebSocket? = null
    private var serverTimeOffset: Long = 0L
    private var currentRole = BuildConfig.ROLE
    private var serverUrl = ""
    private var currentPlayId: String? = null
    private var currentMediaPath: String? = null
    private var currentIsImage = false
    private var mediaReady = false
    private var hasStarted = false
    private var expectedStartAtUtcMs: Long = 0L
    private var discoveryThread: Thread? = null
    private var discoveryRunning = false
    private val heartbeatIntervalMs = 20_000L
    private val syncIntervalMs = 2000L
    private var lastPingTs: Long = 0L
    private val syncRunnable = object : Runnable {
        override fun run() {
            syncPlayback()
            handler.postDelayed(this, syncIntervalMs)
        }
    }
    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            sendPing()
            handler.postDelayed(this, heartbeatIntervalMs)
        }
    }
    private val hostTickIntervalMs = 5000L
    private val hostSyncIntervalMs = 2000L
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
        btnRetry = findViewById(R.id.btnRetry)
        btnSetServer = findViewById(R.id.btnSetServer)
        btnCycleRole = findViewById(R.id.btnCycleRole)
        infoCard = findViewById(R.id.infoCard)
        bottomBar = findViewById(R.id.bottomBar)

        player = ExoPlayer.Builder(this).build()
        playerView.player = player

        versionText.text = "v${BuildConfig.VERSION_NAME} | ${BuildConfig.ROLE}"
        ipText.text = "IP: ${localIp()}"
        serverUrl = loadSavedServerUrl()
        updateWsLabel()
        isHost = currentRole == "center"

        btnRetry.setOnClickListener { connectWs() }
        btnSetServer.setOnClickListener { promptSetServer() }
        btnCycleRole.setOnClickListener { cycleRole() }
        updateRoleLabel()

        if (serverUrl.isNotBlank()) {
            connectWs()
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
        updateRoleLabel()
        sendHello()
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
                runOnUiThread {
                    statusText.text = "Connected"
                    Toast.makeText(this@MainActivity, "WS connected", Toast.LENGTH_SHORT).show()
                }
                sendHello()
                startHeartbeat()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // ignore binary
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                runOnUiThread { statusText.text = "Closed" }
                stopHeartbeat()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e("WS", "failure", t)
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
                val hello = JSONObject()
                hello.put("type", "hello")
                hello.put("role", currentRole)
                hello.put("deviceId", deviceId())
                webSocket.send(hello.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleHostMessage(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e("HOST", "peer ws fail", t)
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
                    expectedStartAtUtcMs = startAt
                    val slice = obj.optJSONObject("screens")?.optJSONObject(currentRole)
                    val url = slice?.optString("url", "") ?: ""
                    val checksum = slice?.optString("checksum", "") ?: ""
                    val legacyStartAt = startAt
                    status("Host prepare: buffering...")
                    Thread {
                        val local = cacheOrDownload(url, checksum)
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
                                } catch (e: Exception) {
                                    status("Load failed: ${e.message}")
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
                    Log.e("WS", "play error", e)
                    status("Play parse error")
                }

                "start" -> try {
                    handleStart(obj)
                } catch (e: Exception) {
                    Log.e("WS", "start error", e)
                    status("Start command error")
                }

                "stop" -> runOnUiThread { stopPlayback("Stopped") }
                "power" -> handlePower(obj)
            }
        } catch (e: Exception) {
            Log.e("WS", "parse", e)
        }
    }

    private fun handlePlay(obj: JSONObject) {
        val playId = obj.optString("playId", "legacy_${System.currentTimeMillis()}")
        val screens = obj.getJSONObject("screens")
        val screenObj = screens.optJSONObject(currentRole) ?: return
        val url = screenObj.optString("url")
        val checksum = screenObj.optString("checksum", "")
        val audio = screenObj.optBoolean("audio", currentRole == "center")
        if (url.isBlank()) {
            status("No playback URL received")
            return
        }

        currentPlayId = playId
        currentIsImage = isImage(url)
        mediaReady = false
        hasStarted = false
        expectedStartAtUtcMs = obj.optLong("startAtUtcMs", 0L)
        if (isHost) {
            hostScreensJson = screens
            hostExpectedRoles = screens.keys().asSequence().toSet()
            hostReadyRoles.clear()
        }
        currentMediaPath = null
        val legacyStartAt = obj.optLong("startAtUtcMs", 0L)
        status("Buffering...")

        Thread {
            val local = cacheOrDownload(url, checksum)
            if (currentIsImage && local == null) {
                runOnUiThread { statusText.text = "Image download failed" }
                return@Thread
            }
            currentMediaPath = local ?: url
            if (currentIsImage) {
                runOnUiThread {
                    mediaReady = true
                    sendReady(playId)
                    hostOnMediaReady()
                    statusText.text = "Image cached, waiting to sync start"
                    scheduleFallbackStart(playId, legacyStartAt)
                }
            } else {
                val mediaPath = currentMediaPath ?: return@Thread
                val mediaItem = MediaItem.fromUri(mediaPath)
                runOnUiThread {
                    try {
                        player.setMediaItem(mediaItem)
                        player.volume = if (audio) 1f else 0f
                        player.prepare()
                        mediaReady = true
                        sendReady(playId)
                        hostOnMediaReady()
                        statusText.text = "Video cached, waiting to sync start"
                        scheduleFallbackStart(playId, legacyStartAt)
                    } catch (e: Exception) {
                        statusText.text = "Load failed: ${e.message}"
                    }
                }
            }
        }.start()
    }

    private fun hostOnMediaReady() {
        if (!isHost) return
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
        if (playId.isNotEmpty() && playId != currentPlayId) return
        if (!mediaReady) return
        expectedStartAtUtcMs = obj.optLong("startAtUtcMs", System.currentTimeMillis())
        val delay = expectedStartAtUtcMs - (System.currentTimeMillis() + serverTimeOffset)

        if (currentIsImage) {
            val path = currentMediaPath ?: return
            val runnable = Runnable {
                val bmp = BitmapFactory.decodeFile(path)
                if (bmp != null) {
                    imageView.setImageBitmap(bmp)
                    imageView.visibility = View.VISIBLE
                    playerView.visibility = View.GONE
                    hasStarted = true
                    setUiVisible(false)
                    status("Showing image")
                } else {
                    status("Display image failed (decode null)")
                }
            }
            if (delay > 0) handler.postDelayed(runnable, delay) else runnable.run()
        } else {
            val runnable = Runnable {
                val mediaPath = currentMediaPath
                if (mediaPath == null) {
                    status("Playback failed: not cached")
                    return@Runnable
                }
                try {
                    imageView.visibility = View.GONE
                    playerView.visibility = View.VISIBLE
                    hasStarted = true
                    setUiVisible(false)
                    player.playWhenReady = true
                    scheduleSync()
                    status("Playing")
                } catch (e: Exception) {
                    Log.e("PLAY", "start runnable", e)
                    status("Playback failed: ${e.message}")
                }
            }
            if (delay > 0) handler.postDelayed(runnable, delay) else runnable.run()
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

    private fun startHeartbeat() {
        handler.removeCallbacks(heartbeatRunnable)
        handler.postDelayed(heartbeatRunnable, heartbeatIntervalMs)
    }

    private fun stopHeartbeat() {
        handler.removeCallbacks(heartbeatRunnable)
    }

    private fun cacheOrDownload(url: String, checksum: String): String? {
        if (url.isEmpty()) return null
        val resolved = resolveAbsoluteUrl(url) ?: return null
        val cacheRoot = File(cacheDir, "programs")
        if (!cacheRoot.exists()) cacheRoot.mkdirs()
        val fileName = checksum.takeIf { it.isNotEmpty() }?.take(12)?.plus("_") ?: ""
        val guessed = resolved.substringAfterLast('/', "media").substringBefore("?").ifBlank { "media" }
        val target = File(cacheRoot, fileName + guessed)
        if (target.exists() && (checksum.isEmpty() || sha256(target) == checksum)) {
            return target.absolutePath
        }

        val request = try {
            Request.Builder().url(resolved).build()
        } catch (e: IllegalArgumentException) {
            Log.e("CACHE", "bad url $resolved", e)
            return null
        }
        try {
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) throw IllegalStateException("http ${resp.code}")
                val sink = FileOutputStream(target)
                resp.body?.byteStream()?.use { input -> input.copyTo(sink) }
                sink.close()
            }
            if (checksum.isNotEmpty() && sha256(target) != checksum) {
                target.delete()
                throw IllegalStateException("checksum mismatch")
            }
            return target.absolutePath
        } catch (e: Exception) {
            Log.e("CACHE", "download failed", e)
            return null
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

    private fun scheduleSync() {
        handler.removeCallbacks(syncRunnable)
        handler.postDelayed(syncRunnable, syncIntervalMs)
    }

    private fun syncPlayback() {
        if (!hasStarted || !mediaReady || currentIsImage || expectedStartAtUtcMs == 0L) return
        val expectedPos = (System.currentTimeMillis() + serverTimeOffset) - expectedStartAtUtcMs
        if (expectedPos < 0) return
        val actual = player.currentPosition
        val drift = actual - expectedPos
        val maxSeekDrift = 150 // ms
        val adjustDrift = 40   // ms
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

    /**
     * 将控制端返回的 /media/xxx 或 media/xxx 相对路径，转换为可下载的 http(s) 绝对地址。
     */
    private fun resolveAbsoluteUrl(raw: String): String? {
        if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("file://")) return raw
        val base = (if (serverUrl.startsWith("wss://")) serverUrl.replaceFirst("wss://", "https://")
        else serverUrl.replaceFirst("ws://", "http://"))
            .removeSuffix("/ws")
        if (base.isBlank()) return null
        val trimmed = if (raw.startsWith("/")) raw else "/$raw"
        return base + trimmed
    }

    // Host functions
    private fun startHostServer() {
        if (!isHost) return
        if (hostServer == null) {
            hostServer = LocalHostServer(InetSocketAddress(HOST_PORT))
            hostServer?.start()
            handler.postDelayed(hostTickRunnable, hostTickIntervalMs)
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
        val obj = JSONObject()
        obj.put("type", "prepare")
        obj.put("id", currentPlayId ?: "")
        obj.put("startAtHostMs", startAt)
        obj.put("screens", hostScreensJson)
        hostServer?.broadcast(obj.toString())
        handler.postDelayed({ hostMaybeStart(startAt) }, 5000)
        handler.postDelayed({ hostSendStart(startAt) }, 6000)
    }

    private fun hostMaybeStart(startAt: Long) {
        if (!isHost) return
        val target = if (hostPlannedStartAt > 0) hostPlannedStartAt else startAt
        val need = hostExpectedRoles
        val readyAll = hostReadyRoles.containsAll(need)
        if (readyAll) {
            hostSendStart(target)
        }
    }

    private fun hostSendStart(startAt: Long) {
        if (!isHost) return
        val safeStart = if (startAt <= nowHost()) nowHost() + 1500 else startAt
        expectedStartAtUtcMs = safeStart
        val obj = JSONObject()
        obj.put("type", "start")
        obj.put("id", currentPlayId ?: "")
        obj.put("startAtHostMs", safeStart)
        hostServer?.broadcast(obj.toString())
        // 让本机也按同一时间启动
        val selfStart = JSONObject()
        selfStart.put("type", "start")
        selfStart.put("playId", currentPlayId ?: "")
        selfStart.put("startAtUtcMs", safeStart)
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
        }

        override fun onStart() {
            Log.i("HOST", "local host WS started on $HOST_PORT")
        }
    }

    private fun status(msg: String) {
        runOnUiThread { statusText.text = msg }
    }

    private fun setUiVisible(show: Boolean) {
        val vis = if (show) View.VISIBLE else View.GONE
        infoCard.visibility = vis
        bottomBar.visibility = vis
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
        if (reason.isNotEmpty()) status(reason)
    }

    private fun isImage(url: String): Boolean {
        val lower = url.lowercase(Locale.getDefault())
        return lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") ||
            lower.endsWith(".webp") || lower.endsWith(".bmp") || lower.endsWith(".gif")
    }

    private fun checkUpdate(manifest: JSONObject) {
        val remoteVer = manifest.optString("version", "")
        if (remoteVer.isBlank()) return
        if (compareVersion(remoteVer, BuildConfig.VERSION_NAME) <= 0) return
        val files = manifest.optJSONObject("files") ?: return
        val url = files.optString(currentRole, files.optString("universal", ""))
        if (url.isBlank()) return
        status("New version $remoteVer found, downloading...")
        Thread {
            val target = File(cacheDir, "update.apk")
            val req = Request.Builder().url(url).build()
            try {
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) throw IllegalStateException("http ${resp.code}")
                    FileOutputStream(target).use { out ->
                        resp.body?.byteStream()?.use { it.copyTo(out) }
                    }
                }
                runOnUiThread {
                    status("Downloaded, installing...")
                    installApk(target)
                }
            } catch (e: Exception) {
                Log.e("UPDATE", "download", e)
                runOnUiThread { status("Update failed: ${e.message}") }
            }
        }.start()
    }

    private fun installApk(file: File) {
        try {
            val uri = FileProvider.getUriForFile(this, "${BuildConfig.APPLICATION_ID}.provider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(intent)
        } catch (e: Exception) {
            Log.e("UPDATE", "install", e)
            status("Auto install failed: ${e.message}")
        }
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
            .show()
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
