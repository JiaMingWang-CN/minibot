package app.minibot.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

class AndroidPoster(private val context: Context) : NotificationPoster {
    init {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_CONNECTION, context.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_LOW),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_APPROVAL, context.getString(R.string.channel_approval), NotificationManager.IMPORTANCE_HIGH),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_DONE, context.getString(R.string.channel_done), NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    fun openIntent(threadId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (threadId != null) putExtra(MainActivity.EXTRA_THREAD_ID, threadId)
        }
        return PendingIntent.getActivity(
            context, (threadId ?: "").hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** 常驻的连接状态通知 */
    fun connection(text: String) = NotificationCompat.Builder(context, CHANNEL_CONNECTION)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle(context.getString(R.string.app_name))
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(openIntent(null))
        .build()

    override fun post(channel: String, key: String, title: String, text: String, publicText: String?, threadId: String?) {
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(openIntent(threadId))
        if (publicText != null) {
            // 锁屏上只露出固定文案，命令原文不出现
            builder.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            builder.setPublicVersion(
                NotificationCompat.Builder(context, channel)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle(title)
                    .setContentText(publicText)
                    .build(),
            )
        }
        try {
            NotificationManagerCompat.from(context).notify(key.hashCode(), builder.build())
        } catch (e: SecurityException) {
            // 没有通知权限：静默放弃
        }
    }
}
