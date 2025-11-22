package com.videowall.client

import android.app.AlertDialog
import android.content.Context
import android.graphics.BitmapFactory
import android.content.Intent
import android.net.Uri
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
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.TimeUnit

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

    private var ws: WebSocket? = null
    private var serverTimeOffset: Long = 0L
    private var currentRole = BuildConfig.ROLE
    private var serverUrl = ""
    private var currentPlayId: String? = null
    private var currentMediaPath: String? = null
    private var currentIsImage = false
    private var mediaReady = false
    private var hasStarted = false
    private var discoveryThread: Thread? = null
    private var discoveryRunning = false
    private val heartbeatIntervalMs = 20_000L
    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            sendPing()
            handler.postDelayed(this, heartbeatIntervalMs)
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

        btnRetry.setOnClickListener { connectWs() }
        btnSetServer.setOnClickListener { promptSetServer() }
        btnCycleRole.setOnClickListener { cycleRole() }
        updateRoleLabel()

        if (serverUrl.isNotBlank()) {
            connectWs()
        } else {
            status("未配置服务器，点“设置服务器”输入 ws://x.x.x.x:8088/ws")
            startDiscovery()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        stopHeartbeat()
        ws?.close(1000, "bye")
        player.release()
        stopDiscovery()
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
        wsText.text = if (serverUrl.isBlank()) "WS: 待配置" else serverUrl
    }

    private fun connectWs() {
        if (serverUrl.isBlank()) {
            status("未配置服务器")
            Toast.makeText(this, "请先设置服务器地址", Toast.LENGTH_SHORT).show()
            return
        }
        statusText.text = "Connecting..."
        stopHeartbeat()
        val request = Request.Builder().url(serverUrl).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                runOnUiThread {
                    statusText.text = "Connected"
                    Toast.makeText(this@MainActivity, "WS 已连接", Toast.LENGTH_SHORT).show()
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
                                    Toast.makeText(this, "发现控制端并已设置", Toast.LENGTH_SHORT).show()
                                }
                            }
                        }
                    } catch (_: Exception) { }
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
        ws?.send(ping.toString())
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
                "play" -> handlePlay(obj)
                "start" -> handleStart(obj)
                "stop" -> runOnUiThread { stopPlayback("Stop command") }
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

        currentPlayId = playId
        currentIsImage = isImage(url)
        mediaReady = false
        hasStarted = false
        currentMediaPath = null
        val legacyStartAt = obj.optLong("startAtUtcMs", 0L)
        status("缓存中...")

        Thread {
            val local = cacheOrDownload(url, checksum)
            if (currentIsImage && local == null) {
                runOnUiThread { statusText.text = "图片下载失败" }
                return@Thread
            }
            currentMediaPath = local ?: url
            if (currentIsImage) {
                runOnUiThread {
                    mediaReady = true
                    sendReady(playId)
                    statusText.text = "图片缓存完成，等待同步开始"
                    scheduleFallbackStart(playId, legacyStartAt)
                }
            } else {
                val mediaItem = MediaItem.fromUri(currentMediaPath!!)
                runOnUiThread {
                    try {
                        player.setMediaItem(mediaItem)
                        player.volume = if (audio) 1f else 0f
                        player.prepare()
                        mediaReady = true
                        sendReady(playId)
                        statusText.text = "视频缓存完成，等待同步开始"
                        scheduleFallbackStart(playId, legacyStartAt)
                    } catch (e: Exception) {
                        statusText.text = "加载失败: ${e.message}"
                    }
                }
            }
        }.start()
    }

    private fun handleStart(obj: JSONObject) {
        val playId = obj.optString("playId", "")
        if (playId.isNotEmpty() && playId != currentPlayId) return
        if (!mediaReady) return
        val startAt = obj.optLong("startAtUtcMs", System.currentTimeMillis())
        val delay = startAt - (System.currentTimeMillis() + serverTimeOffset)

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
                    status("图片展示中")
                } else {
                    status("显示图片失败")
                }
            }
            if (delay > 0) handler.postDelayed(runnable, delay) else runnable.run()
        } else {
            val runnable = Runnable {
                imageView.visibility = View.GONE
                playerView.visibility = View.VISIBLE
                hasStarted = true
                setUiVisible(false)
                player.playWhenReady = true
                status("播放中")
            }
            if (delay > 0) handler.postDelayed(runnable, delay) else runnable.run()
        }
    }

    private fun handlePower(obj: JSONObject) {
        val action = obj.optString("action", "sleep")
        if (action == "sleep") {
            runOnUiThread {
                player.pause()
                statusText.text = "Sleep (paused)"
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
        val cacheRoot = File(cacheDir, "programs")
        if (!cacheRoot.exists()) cacheRoot.mkdirs()
        val fileName = checksum.takeIf { it.isNotEmpty() }?.take(12)?.plus("_") ?: ""
        val guessed = url.substringAfterLast('/', "media")
        val target = File(cacheRoot, fileName + guessed)
        if (target.exists() && (checksum.isEmpty() || sha256(target) == checksum)) {
            return target.absolutePath
        }

        val request = Request.Builder().url(url).build()
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
        status("发现新版本 $remoteVer，下载中...")
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
                    status("下载完成，安装中...")
                    installApk(target)
                }
            } catch (e: Exception) {
                Log.e("UPDATE", "download", e)
                runOnUiThread { status("更新失败: ${e.message}") }
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
            status("自动安装失败: ${e.message}")
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
            .setTitle("设置控制端 WS 地址")
            .setView(edit)
            .setPositiveButton("保存") { _, _ ->
                val input = edit.text.toString().trim()
                if (input.startsWith("ws://") || input.startsWith("wss://")) {
                    serverUrl = input
                    saveServerUrl(input)
                    updateWsLabel()
                    connectWs()
                } else {
                    Toast.makeText(this, "地址需以 ws:// 或 wss:// 开头", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun prefs() = getSharedPreferences("vw_prefs", Context.MODE_PRIVATE)

    private fun saveServerUrl(url: String) {
        prefs().edit().putString("server_url", url).apply()
    }

    private fun loadSavedServerUrl(): String {
        return prefs().getString("server_url", "") ?: ""
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
        return "未知"
    }
}
