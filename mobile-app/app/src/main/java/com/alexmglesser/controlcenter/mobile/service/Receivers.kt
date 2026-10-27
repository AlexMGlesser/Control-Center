package com.alexmglesser.controlcenter.mobile.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import com.alexmglesser.controlcenter.mobile.alarm.PhoneAlarms
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.notify.CalendarReminders
import com.alexmglesser.controlcenter.mobile.notify.Notifications
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Reconnects in the background after a reboot or app update, if "Stay connected" is on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                // Phone alarms come back first, without waiting for the PC.
                PhoneAlarms.restore(context)
                val store = context.appContainer.sessionStore
                store.load()
                // Reboots clear scheduled alarms: put the saved reminders back.
                CalendarReminders.reschedule(context, store.currentSettings())
                if (store.currentSession() != null && store.currentSettings().stayConnected) {
                    ConnectionServiceController.start(context)
                }
            } finally {
                pending.finish()
            }
        }
    }
}

/** "Reply" typed straight into a Jarvis notification. */
class ReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifications.REPLY_KEY)?.toString()?.trim()
        if (text.isNullOrEmpty()) return
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                context.appContainer.api.sendChat(text)
                Notifications.replySent(context, notificationId, text)
            } catch (_: Exception) {
                Notifications.replySent(context, notificationId, "Couldn't send. Open the app to try again.")
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val EXTRA_NOTIFICATION_ID = "notification_id"
    }
}
