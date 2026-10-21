package com.alexmglesser.controlcenter.mobile.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import com.alexmglesser.controlcenter.mobile.MainActivity
import com.alexmglesser.controlcenter.mobile.data.api.AlarmInfo
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.time.Instant

/** An alarm this phone has scheduled with Android's alarm clock. */
@Serializable
data class ScheduledAlarm(val id: String, val label: String, val fireAtMs: Long)

/**
 * Alarms set from this phone ring on this phone. The PC is the source of
 * truth; this mirrors this phone's alarms into Android's AlarmManager
 * (setAlarmClock: exact, wakes the phone, shows in the status bar), so they
 * ring on time even if the phone is asleep or can't reach the PC. The
 * schedule is also kept locally so a reboot can restore it offline.
 */
object PhoneAlarms {
    private const val PREFS = "phone_alarms"
    private const val KEY_SCHEDULED = "scheduled"
    private const val KEY_RUNG = "rung"
    private val json = Json { ignoreUnknownKeys = true }

    /** Mirror the PC's list: schedule this phone's enabled alarms, cancel the rest. */
    fun sync(context: Context, alarms: List<AlarmInfo>, myDeviceId: String) {
        val now = System.currentTimeMillis()
        val wanted = alarms
            .filter { it.deviceId == myDeviceId && it.enabled }
            .mapNotNull { alarm ->
                val fireAt = alarm.nextFireAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
                fireAt?.takeIf { it > now - 60_000 }?.let { ScheduledAlarm(alarm.id, alarm.label, it) }
            }
        val previous = loadScheduled(context)
        previous.filter { old -> wanted.none { it.id == old.id } }.forEach { cancel(context, it) }
        wanted.forEach { schedule(context, it) }
        saveScheduled(context, wanted)
    }

    /** After a reboot: put back what was scheduled, without needing the PC. */
    fun restore(context: Context) {
        val now = System.currentTimeMillis()
        loadScheduled(context).filter { it.fireAtMs > now - 60_000 }.forEach { schedule(context, it) }
    }

    fun cancelAll(context: Context) {
        loadScheduled(context).forEach { cancel(context, it) }
        saveScheduled(context, emptyList())
    }

    /**
     * Each occurrence rings once, whether it's triggered by the local alarm
     * clock or by the PC's "alarm-fired" event (the backup path).
     */
    fun claimRing(context: Context, alarmId: String, fireAtMs: Long): Boolean {
        val key = "$alarmId@${fireAtMs / 60_000}"
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val rung = prefs.getStringSet(KEY_RUNG, emptySet()).orEmpty()
        if (key in rung) return false
        prefs.edit { putStringSet(KEY_RUNG, (rung + key).toList().takeLast(50).toSet()) }
        return true
    }

    private fun schedule(context: Context, alarm: ScheduledAlarm) {
        val manager = context.getSystemService(AlarmManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !manager.canScheduleExactAlarms()) return
        val showIntent = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        manager.setAlarmClock(AlarmManager.AlarmClockInfo(alarm.fireAtMs, showIntent), firePendingIntent(context, alarm))
    }

    private fun cancel(context: Context, alarm: ScheduledAlarm) {
        context.getSystemService(AlarmManager::class.java).cancel(firePendingIntent(context, alarm))
    }

    private fun firePendingIntent(context: Context, alarm: ScheduledAlarm): PendingIntent {
        val intent = Intent(context, AlarmFireReceiver::class.java)
            .setAction("com.alexmglesser.controlcenter.mobile.ALARM_FIRE.${alarm.id}")
            .putExtra(EXTRA_ALARM_ID, alarm.id)
            .putExtra(EXTRA_LABEL, alarm.label)
            .putExtra(EXTRA_FIRE_AT, alarm.fireAtMs)
        return PendingIntent.getBroadcast(context, alarm.id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun loadScheduled(context: Context): List<ScheduledAlarm> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SCHEDULED, null) ?: return emptyList()
        return runCatching { json.decodeFromString(ListSerializer(ScheduledAlarm.serializer()), raw) }.getOrDefault(emptyList())
    }

    private fun saveScheduled(context: Context, alarms: List<ScheduledAlarm>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
            putString(KEY_SCHEDULED, json.encodeToString(ListSerializer(ScheduledAlarm.serializer()), alarms))
        }
    }

    const val EXTRA_ALARM_ID = "alarm_id"
    const val EXTRA_LABEL = "label"
    const val EXTRA_FIRE_AT = "fire_at"
}

/** The alarm clock went off: start ringing. */
class AlarmFireReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val alarmId = intent.getStringExtra(PhoneAlarms.EXTRA_ALARM_ID) ?: return
        val label = intent.getStringExtra(PhoneAlarms.EXTRA_LABEL) ?: "Alarm"
        val fireAt = intent.getLongExtra(PhoneAlarms.EXTRA_FIRE_AT, System.currentTimeMillis())
        AlarmRingService.start(context, alarmId, label, fireAt)
    }
}

/** Starting the ring service is allowed from an exact-alarm broadcast or a foreground service. */
internal fun startRingService(context: Context, intent: Intent) {
    ContextCompat.startForegroundService(context, intent)
}
