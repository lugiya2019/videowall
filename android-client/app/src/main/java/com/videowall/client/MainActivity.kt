package com.videowall.client

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.ui.PlayerView
import okhttp3.*
import okio.ByteString
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.*
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {
    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var statusText: TextView
    private lateinit var versionText: TextView
    private lateinit var roleBadge: TextView
    private lateinit var wsText: TextView
    private lateinit var btnRetry: Button
    private lateinit var btnCycleRole: Button

    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .build()

    private var ws: WebSocket? = null
    private var serverTimeOffset: Long = 0L
    private var currentRole = BuildConfig.ROLE
    private var serverUrl = BuildConfig.WS_URL
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
        statusText = findViewById(R.id.statusText)
        versionText = findViewById(R.id.versionText)
        roleBadge = findViewById(R.id.roleBadge)
        wsText = findViewById(R.id.wsText)
        btnRetry = findViewById(R.id.btnRetry)
        btnCycleRole = findViewById(R.id.btnCycleRole)

        player = ExoPlayer.Builder(this).build()
        playerView.player = player

        versionText.text = "v${BuildConfig.VERSION_NAME} | ${BuildConfig.ROLE}"
        wsText.text = serverUrl
        btnRetry.setOnClickListener { connectWs() }
        btnCycleRole.setOnClickListener { cycleRole() }
        updateRoleLabel()
        connectWs()
    }

    override fun onDestroy() {
        super.onDestroy()
        stopHeartbeat()
        ws?.close(1000, "bye")
        player.release()
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

    private fun connectWs() {
        statusText.text = "Connecting..."
        stopHeartbeat()
        val request = Request.Builder().url(serverUrl).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                runOnUiThread { statusText.text = "Connected" }
                sendHello()
                startHeartbeat()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // no binary messages
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
                }
                "synctime" -> {
                    serverTimeOffset = obj.optLong("serverTime") - System.currentTimeMillis()
                }
                "play" -> handlePlay(obj)
                "stop" -> runOnUiThread { player.stop() }
                "power" -> handlePower(obj)
            }
        } catch (e: Exception) {
            Log.e("WS", "parse", e)
        }
    }

    private fun handlePlay(obj: JSONObject) {
        val startAt = obj.optLong("startAtUtcMs", 0L)
        val screens = obj.getJSONObject("screens")
        val screenObj = screens.optJSONObject(currentRole) ?: return
        val url = screenObj.optString("url")
        val checksum = screenObj.optString("checksum", "")
        val audio = screenObj.optBoolean("audio", currentRole == "center")
        status("Prefetching...")
        Thread {
            val local = cacheOrDownload(url, checksum)
            val mediaItem = if (local != null) MediaItem.fromUri(local) else MediaItem.fromUri(url)
            runOnUiThread {
                player.setMediaItem(mediaItem)
                player.volume = if (audio) 1f else 0f
                player.prepare()
                val delay = startAt - (System.currentTimeMillis() + serverTimeOffset)
                if (delay > 0) {
                    handler.postDelayed({ player.playWhenReady = true }, delay)
                    statusText.text = "Buffered, will start in ${delay/1000.0}s"
                } else {
                    player.playWhenReady = true
                    statusText.text = "Playing (late start)"
                }
            }
        }.start()
    }

    private fun handlePower(obj: JSONObject) {
        val action = obj.optString("action", "sleep")
        // MVP: only blank screen by pausing video; real power control requires device admin/system perms
        if (action == "sleep") {
            runOnUiThread { player.pause(); statusText.text = "Sleep (paused)" }
        } else if (action == "wake") {
            runOnUiThread { player.playWhenReady = true; statusText.text = "Wake" }
        } else if (action == "reboot") {
            runOnUiThread { statusText.text = "Reboot requested (not implemented)" }
        }
    }

    private fun deviceId(): String {
        return android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.ANDROID_ID)
    }

    override fun dispatchKeyEvent(event: KeyEvent?): Boolean {
        // Handle DPAD center as retry
        if (event?.action == KeyEvent.ACTION_UP && event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
            connectWs();
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
}
