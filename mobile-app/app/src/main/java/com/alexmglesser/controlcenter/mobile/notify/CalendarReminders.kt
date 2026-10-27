package com.alexmglesser.controlcenter.mobile.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.edit
import com.alexmglesser.controlcenter.mobile.MainActivity
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.AppSettings
import com.alexmglesser.controlcenter.mobile.data.api.CalendarEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.text.DateFormat
import java.time.Instant
import java.util.Date

/** An upcoming event, kept on the phone so reminders survive a reboot without the PC. */
@Serializable
data class ReminderEvent(val id: String, val title: String, val startMs: Long, val endMs: Long)

/**
 * Calendar reminders (architecture 7.3). The phone schedules them itself
 * with exact alarms, so they arrive on time in Doze and when the PC is
 * unreachable. The PC never sends reminders, so there are no duplicates.
 */
object CalendarReminders {
    const val WINDOW_MS = 14L * 24 * 60 * 60 * 1000
    private const val PREFS = "calendar_reminders"
    private const val KEY_EVENTS = "events"
    private const val SNOOZE_MS = 5 * 60 * 1000L
    private val json = Json { ignoreUnknownKeys = true }

    /** Fetches the next 14 days from the PC and reschedules. Quietly does nothing offline. */
    suspend fun refresh(context: Context) {
        val container = context.appContainer
        if (container.sessionStore.currentSession() == null) return
        val now = System.currentTimeMillis()
        val events = runCatching {
            container.api.calendarEvents(Instant.ofEpochMilli(now).toString(), Instant.ofEpochMilli(now + WINDOW_MS).toString())
        }.getOrNull() ?: return
        save(context, events.mapNotNull(::toReminder))
        reschedule(context, container.sessionStore.currentSettings())
    }

    /** Re-applies the saved events with the current settings (after a reboot, or a settings change). */
    fun reschedule(context: Context, settings: AppSettings) {
        val events = load(context)
        events.forEach { cancel(context, it) }
        if (!settings.calendarReminders) return
        val now = System.currentTimeMillis()
        val leadMs = settings.remindMinutes * 60_000L
        events.forEach { event ->
            val fireAt = event.startMs - leadMs
            if (fireAt > now) schedule(context, event, fireAt, settings.remindMinutes)
        }
    }

    fun cancelAll(context: Context) {
        load(context).forEach { cancel(context, it) }
        save(context, emptyList())
    }

    private fun toReminder(event: CalendarEvent): ReminderEvent? {
        val start = runCatching { Instant.parse(event.startAt).toEpochMilli() }.getOrNull() ?: return null
        val end = runCatching { Instant.parse(event.endAt).toEpochMilli() }.getOrNull() ?: start
        return ReminderEvent(event.id, event.title, start, end)
    }

    internal fun schedule(context: Context, event: ReminderEvent, fireAt: Long, leadMinutes: Int, snoozed: Boolean = false) {
        val manager = context.getSystemService(AlarmManager::class.java)
        val intent = reminderIntent(context, event, leadMinutes, snoozed)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !manager.canScheduleExactAlarms()) {
            // Without exact-alarm access the reminder may arrive a few minutes late.
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, intent)
        } else {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, intent)
        }
    }

    private fun cancel(context: Context, event: ReminderEvent) {
        val manager = context.getSystemService(AlarmManager::class.java)
        manager.cancel(reminderIntent(context, event, 0, snoozed = false))
    }

    /** One pending intent per event (the ID comes from the event), so rescheduling replaces it. */
    private fun reminderIntent(context: Context, event: ReminderEvent, leadMinutes: Int, snoozed: Boolean): PendingIntent {
        val intent = Intent(context, CalendarReminderReceiver::class.java)
            .setAction("com.alexmglesser.controlcenter.mobile.REMIND.${event.id}${if (snoozed) ".snooze" else ""}")
            .putExtra(EXTRA_EVENT, json.encodeToString(ReminderEvent.serializer(), event))
            .putExtra(EXTRA_LEAD, leadMinutes)
        return PendingIntent.getBroadcast(context, event.id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Posts the "starts now" / "in 10 min" notification (design 8.1). */
    internal fun notify(context: Context, event: ReminderEvent) {
        val minutesAway = ((event.startMs - System.currentTimeMillis()) / 60_000.0).let { kotlin.math.round(it).toLong() }
        val whenText = if (minutesAway <= 0) "starts now" else "in $minutesAway min"
        val time = DateFormat.getTimeInstance(DateFormat.SHORT)
        val range = "${time.format(Date(event.startMs))} – ${time.format(Date(event.endMs))}"
        val notificationId = NOTIFICATION_BASE + (event.id.hashCode() and 0xFFFF)

        val open = PendingIntent.getActivity(
            context,
            notificationId,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(Notifications.EXTRA_NAVIGATE, Notifications.NAVIGATE_CALENDAR),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val snooze = PendingIntent.getBroadcast(
            context,
            notificationId,
            Intent(context, CalendarReminderReceiver::class.java)
                .setAction(ACTION_SNOOZE)
                .putExtra(EXTRA_EVENT, json.encodeToString(ReminderEvent.serializer(), event))
                .putExtra(EXTRA_NOTIFICATION_ID, notificationId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, Notifications.CHANNEL_CALENDAR)
            .setSmallIcon(R.drawable.ic_calendar_days)
            .setColor(0xFF00F0FF.toInt())
            .setContentTitle("${event.title}  ·  $whenText")
            .setContentText(range)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setGroup(GROUP)
            .setAutoCancel(true)
            .setContentIntent(open)
            .addAction(R.drawable.ic_bell, "Snooze 5 min", snooze)
            .addAction(R.drawable.ic_calendar_days, "Open", open)
            .build()
        Notifications.post(context, notificationId, notification)
    }

    internal fun snooze(context: Context, event: ReminderEvent, notificationId: Int) {
        Notifications.cancel(context, notificationId)
        schedule(context, event, System.currentTimeMillis() + SNOOZE_MS, 0, snoozed = true)
    }

    internal fun decode(raw: String?): ReminderEvent? =
        raw?.let { runCatching { json.decodeFromString(ReminderEvent.serializer(), it) }.getOrNull() }

    private fun load(context: Context): List<ReminderEvent> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_EVENTS, null) ?: return emptyList()
        return runCatching { json.decodeFromString(ListSerializer(ReminderEvent.serializer()), raw) }.getOrDefault(emptyList())
    }

    private fun save(context: Context, events: List<ReminderEvent>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
            putString(KEY_EVENTS, json.encodeToString(ListSerializer(ReminderEvent.serializer()), events))
        }
    }

    internal const val EXTRA_EVENT = "event"
    internal const val EXTRA_LEAD = "lead_minutes"
    internal const val EXTRA_NOTIFICATION_ID = "notification_id"
    internal const val ACTION_SNOOZE = "com.alexmglesser.controlcenter.mobile.REMIND_SNOOZE"
    private const val GROUP = "calendar"
    private const val NOTIFICATION_BASE = 20_000
}

/** A reminder's alarm went off, or Snooze was tapped. */
class CalendarReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val event = CalendarReminders.decode(intent.getStringExtra(CalendarReminders.EXTRA_EVENT)) ?: return
        if (intent.action == CalendarReminders.ACTION_SNOOZE) {
            CalendarReminders.snooze(context, event, intent.getIntExtra(CalendarReminders.EXTRA_NOTIFICATION_ID, 0))
            return
        }
        // Reminders switched off since this was scheduled: drop it.
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                if (context.appContainer.sessionStore.currentSettings().calendarReminders) {
                    CalendarReminders.notify(context, event)
                }
            } finally {
                pending.finish()
            }
        }
    }
}
