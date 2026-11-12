package app.minibot.mobile

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach

/** 前台服务（remoteMessaging）：让进程在后台活着，持续持有到电脑的连接；常驻通知显示连接状态 */
class RemoteService : Service() {
    private var watcher: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        RemoteHub.init(this)
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, RemoteHub.poster.connection(RemoteHub.connectionText()), type)
        RemoteHub.startConnection()
        watcher?.cancel()
        watcher = RemoteHub.connector.state.onEach {
            val manager = getSystemService(android.app.NotificationManager::class.java)
            manager.notify(NOTIFICATION_ID, RemoteHub.poster.connection(RemoteHub.connectionText()))
        }.launchIn(RemoteHub.hubScope)
        return START_STICKY
    }

    override fun onDestroy() {
        watcher?.cancel()
        super.onDestroy()
    }

    companion object {
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            context.startForegroundService(Intent(context, RemoteService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RemoteService::class.java))
        }
    }
}
