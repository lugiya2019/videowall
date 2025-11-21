package com.videowall.client

import android.app.Service
import android.content.Intent
import android.os.IBinder

class WallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
}
