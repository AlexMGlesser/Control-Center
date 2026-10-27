package com.alexmglesser.controlcenter.mobile.notify

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.alexmglesser.controlcenter.mobile.MainActivity
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.data.events.ConnectionState
import com.alexmglesser.controlcenter.mobile.data.events.DisconnectCause
import com.alexmglesser.controlcenter.mobile.service.ReplyReceiver

/** Notification channels and builders (architecture 7.5, design 8). */
object Notifications {
    const val CHANNEL_STATUS = "connection_status"
    const val CHANNEL_ALERTS = "connection_alerts"
    const val CHANNEL_CALENDAR = "calendar"
    const val CHANNEL_JARVIS = "jarvis"
    const val CHANNEL_ALARMS = "alarms"
    const val CHANNEL_DOWNLOADS = "downloads"

    const val STATUS_ID = 1
    const val CONNECTION_ALERT_ID = 2
    private const val JARVIS_ID_BASE = 1000

    const val EXTRA_NAVIGATE = "navigate"
    const val NAVIGATE_CHAT = "chat"
    const val NAVIGATE_SETTINGS = "settings"
    const val NAVIGATE_CALENDAR = "app:calendar-app"
    const val NAVIGATE_MUSIC = "app:music-app"
    const val REPLY_KEY = "jarvis_reply"

    private val ACCENT = 0xFF00F0FF.toInt()

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_STATUS, "Connection status", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "The permanent notification shown while the app stays connected to your PC."
                    setShowBadge(false)
                },
                NotificationChannel(CHANNEL_ALERTS, "Connection alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "When the connection to your PC is lost or comes back."
                },
                NotificationChannel(CHANNEL_CALENDAR, "Calendar", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Reminders when calendar events start."
                },
                NotificationChannel(CHANNEL_DOWNLOADS, "Downloads", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Files downloaded from your PC."
                },
                NotificationChannel(CHANNEL_JARVIS, "Jarvis", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Jarvis's replies when you've left the app."
                },
                // Silent channel: the alarm service plays the sound itself, on loop.
                NotificationChannel(CHANNEL_ALARMS, "Alarms", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Alarms you set from this phone."
                    setSound(null, null)
                    enableVibration(false)
                    setBypassDnd(true)
                }
            )
        )
    }

    private fun openAppIntent(context: Context, navigate: String?, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            navigate?.let { putExtra(EXTRA_NAVIGATE, it) }
        }
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun status(context: Context, state: ConnectionState, serverName: String): Notification {
        val text = when (state) {
            is ConnectionState.Connected -> "● Connected to $serverName"
            is ConnectionState.Reconnecting, ConnectionState.Connecting -> "Reconnecting…"
            is ConnectionState.Disconnected -> "Disconnected"
            ConnectionState.Unauthorized -> "This phone was removed from Control Center"
            ConnectionState.Idle -> "Not connected"
        }
        return NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_layout_grid)
            .setColor(ACCENT)
            .setContentTitle("Control Center")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openAppIntent(context, NAVIGATE_SETTINGS, 1))
            .build()
    }

    fun connectionLost(context: Context, cause: DisconnectCause, serverName: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_wifi_off)
            .setColor(ACCENT)
            .setContentTitle("Lost connection to $serverName")
            .setContentText(cause.describe(serverName))
            .setStyle(NotificationCompat.BigTextStyle().bigText(cause.describe(serverName)))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(context, NAVIGATE_SETTINGS, 2))
            .build()
        post(context, CONNECTION_ALERT_ID, notification)
    }

    fun reconnected(context: Context, serverName: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_layout_grid)
            .setColor(ACCENT)
            .setContentTitle("Reconnected to $serverName")
            .setSilent(true)
            .setAutoCancel(true)
            .setTimeoutAfter(10_000)
            .setContentIntent(openAppIntent(context, null, 3))
            .build()
        post(context, CONNECTION_ALERT_ID, notification)
    }

    fun jarvisReply(context: Context, messageId: Long, text: String) {
        val notificationId = JARVIS_ID_BASE + (messageId % 1000).toInt()
        val replyIntent = Intent(context, ReplyReceiver::class.java).putExtra(ReplyReceiver.EXTRA_NOTIFICATION_ID, notificationId)
        val replyPending = PendingIntent.getBroadcast(
            context,
            notificationId,
            replyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )
        val replyAction = NotificationCompat.Action.Builder(R.drawable.ic_send, "Reply", replyPending)
            .addRemoteInput(RemoteInput.Builder(REPLY_KEY).setLabel("Message Jarvis…").build())
            .setAllowGeneratedReplies(false)
            .build()

        val notification = NotificationCompat.Builder(context, CHANNEL_JARVIS)
            .setSmallIcon(R.drawable.ic_message_circle)
            .setColor(ACCENT)
            .setContentTitle("Jarvis")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(context, NAVIGATE_CHAT, 4))
            .addAction(replyAction)
            .build()
        post(context, notificationId, notification)
    }

    fun replySent(context: Context, notificationId: Int, text: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_JARVIS)
            .setSmallIcon(R.drawable.ic_message_circle)
            .setColor(ACCENT)
            .setContentTitle("Sent to Jarvis")
            .setContentText(text)
            .setSilent(true)
            .setTimeoutAfter(5_000)
            .build()
        post(context, notificationId, notification)
    }

    /**
     * POST_NOTIFICATIONS is a runtime permission only on Android 13+; before
     * that, checking it always reports "denied", so only ask there. On every
     * version the user can also switch the app's notifications off.
     */
    fun canPost(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    fun cancel(context: Context, id: Int) {
        NotificationManagerCompat.from(context).cancel(id)
    }

    /** The one place notifications are posted, always behind [canPost]. */
    @SuppressLint("MissingPermission") // Checked by canPost; a revoke between check and post is caught below.
    fun post(context: Context, id: Int, notification: Notification) {
        if (!canPost(context)) return
        try {
            NotificationManagerCompat.from(context).notify(id, notification)
        } catch (_: SecurityException) {
            // Permission revoked between the check and the post: drop it.
        }
    }
}
