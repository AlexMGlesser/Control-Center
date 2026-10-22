package com.alexmglesser.controlcenter.mobile.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.ServerEvent
import com.alexmglesser.controlcenter.mobile.alarm.AlarmRingService
import com.alexmglesser.controlcenter.mobile.alarm.PhoneAlarms
import com.alexmglesser.controlcenter.mobile.data.events.ConnectionState
import com.alexmglesser.controlcenter.mobile.data.events.OutageNotifier
import java.time.Instant
import com.alexmglesser.controlcenter.mobile.notify.CalendarReminders
import com.alexmglesser.controlcenter.mobile.notify.Notifications
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Foreground service that keeps the connection to the PC open in the
 * background (architecture 7.1) and turns connection changes and Jarvis
 * replies into notifications. The connection lives exactly as long as this
 * service does.
 */
class ConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val outages = OutageNotifier()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val container = appContainer
        val initial = Notifications.status(this, container.connection.state.value, serverName())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(this, Notifications.STATUS_ID, initial, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(Notifications.STATUS_ID, initial)
        }

        scope.launch {
            container.connection.state.collect { state ->
                Notifications.post(
                    this@ConnectionService,
                    Notifications.STATUS_ID,
                    Notifications.status(this@ConnectionService, state, serverName())
                )
                val settings = container.sessionStore.currentSettings()
                when (val action = outages.onState(state)) {
                    is OutageNotifier.Action.Lost -> if (settings.connectionAlerts) {
                        Notifications.connectionLost(this@ConnectionService, action.cause, serverName())
                    }
                    OutageNotifier.Action.Reconnected -> if (settings.connectionAlerts) {
                        Notifications.reconnected(this@ConnectionService, serverName())
                    }
                    null -> Unit
                }
            }
        }

        scope.launch {
            container.connection.events.collect { event -> handleEvent(event) }
        }
        scope.launch {
            var wasConnected = false
            container.connection.state.collect { state ->
                val connected = state is ConnectionState.Connected
                if (connected && !wasConnected) {
                    syncAlarms()
                    CalendarReminders.refresh(this@ConnectionService)
                }
                wasConnected = connected
            }
        }
        // Catch calendar changes missed while offline (architecture 7.3).
        scope.launch {
            while (true) {
                delay(REMINDER_REFRESH_MS)
                CalendarReminders.refresh(this@ConnectionService)
            }
        }

        container.connection.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        scope.cancel()
        appContainer.connection.stop()
        super.onDestroy()
    }

    private companion object {
        const val REMINDER_REFRESH_MS = 6 * 60 * 60 * 1000L
    }

    private fun serverName(): String = appContainer.sessionStore.currentSession()?.serverName ?: "your PC"

    /** Mirror this phone's alarms into Android's alarm clock (PhoneAlarms). */
    private suspend fun syncAlarms() {
        val session = appContainer.sessionStore.currentSession() ?: return
        runCatching { appContainer.api.alarms() }.onSuccess { PhoneAlarms.sync(this, it, session.deviceId) }
    }

    private suspend fun handleEvent(event: ServerEvent) {
        val myDeviceId = appContainer.sessionStore.currentSession()?.deviceId ?: return
        when (event.type) {
            "data-changed" -> when (event.appId) {
                "alarms" -> syncAlarms()
                "calendar-app" -> CalendarReminders.refresh(this)
            }
            // Backup path: the PC fired this phone's alarm. Rings only if the
            // local alarm clock hasn't already rung this occurrence.
            "alarm-fired" -> if (event.metaString("targetDeviceId") == myDeviceId) {
                val alarmId = event.metaString("alarmId") ?: return
                val firedFor = event.metaString("firedFor")?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
                AlarmRingService.start(this, alarmId, event.metaString("label") ?: "Alarm", firedFor ?: System.currentTimeMillis())
            }
            "alarm-stopped" -> if (event.metaString("targetDeviceId") == myDeviceId) {
                event.metaString("alarmId")?.let { AlarmRingService.stopFromElsewhere(this, it) }
            }
            "chat" -> handleChatReply(event)
        }
    }

    /** A reply to a message sent from this phone, arriving while the app isn't on screen. */
    private suspend fun handleChatReply(event: ServerEvent) {
        val container = appContainer
        val session = container.sessionStore.currentSession() ?: return
        if (event.originDeviceId() != session.deviceId) return
        if (container.inForeground.value) return
        if (!container.sessionStore.currentSettings().jarvisReplies) return

        val messageId = event.metaString("agentMessageId")?.toLongOrNull()
        val reply = runCatching { container.api.chatMessages(limit = 10) }.getOrNull()
            ?.lastOrNull { it.role == "agent" && (messageId == null || it.id == messageId) }
            ?: return
        Notifications.jarvisReply(this, reply.id, reply.text)
    }
}

/** Starts and stops ConnectionService. */
object ConnectionServiceController {
    fun start(context: Context) {
        ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java))
    }

    fun stop(context: Context) {
        context.stopService(Intent(context, ConnectionService::class.java))
    }
}
