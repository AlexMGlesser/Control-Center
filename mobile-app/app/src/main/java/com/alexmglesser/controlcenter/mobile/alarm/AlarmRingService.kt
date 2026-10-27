package com.alexmglesser.controlcenter.mobile.alarm

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.notify.Notifications
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Rings a phone alarm: the alarm sound on loop at alarm volume, vibration,
 * and a full-screen alarm over the lock screen, until Stop or 10 minutes.
 */
class AlarmRingService : Service() {
    private var player: MediaPlayer? = null
    private val handler = Handler(Looper.getMainLooper())
    private val autoStop = Runnable { stopRinging(reportToPc = true) }
    private var alarmId: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopRinging(reportToPc = intent.getBooleanExtra(EXTRA_REPORT, true))
                return START_NOT_STICKY
            }
            ACTION_RING -> {
                val id = intent.getStringExtra(PhoneAlarms.EXTRA_ALARM_ID) ?: return START_NOT_STICKY
                val label = intent.getStringExtra(PhoneAlarms.EXTRA_LABEL) ?: "Alarm"
                val fireAt = intent.getLongExtra(PhoneAlarms.EXTRA_FIRE_AT, System.currentTimeMillis())
                ring(id, label, fireAt)
            }
        }
        return START_NOT_STICKY
    }

    private fun ring(id: String, label: String, fireAt: Long) {
        val notification = buildNotification(id, label)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        // The same occurrence can arrive twice (local alarm clock + the PC's
        // event): ring once; if it already rang and was stopped, go away.
        if (!PhoneAlarms.claimRing(this, id, fireAt)) {
            if (alarmId == null) {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            return
        }

        alarmId = id
        _ringing.value = RingingAlarm(id, label)
        startSound()
        startVibration()
        handler.removeCallbacks(autoStop)
        handler.postDelayed(autoStop, AUTO_STOP_MS)
        runCatching { startActivity(AlarmActivity.intent(this, id, label)) }
    }

    private fun buildNotification(id: String, label: String) =
        NotificationCompat.Builder(this, Notifications.CHANNEL_ALARMS)
            .setSmallIcon(R.drawable.ic_bell)
            .setColor(0xFF00F0FF.toInt())
            .setContentTitle(label)
            .setContentText("Alarm")
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setSilent(true) // the service plays the alarm sound itself, on loop
            .setFullScreenIntent(
                PendingIntent.getActivity(this, 10, AlarmActivity.intent(this, id, label), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
                true
            )
            .addAction(
                R.drawable.ic_bell,
                "Stop",
                PendingIntent.getService(this, 11, stopIntent(this), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            )
            .build()

    private fun startSound() {
        if (player != null) return
        val uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        player = runCatching {
            MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                setDataSource(this@AlarmRingService, uri)
                isLooping = true
                prepare()
                start()
            }
        }.getOrNull()
    }

    @Suppress("DEPRECATION") // Vibrator service and the AudioAttributes overload, for Android 10–12.
    private fun vibrator(): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) getSystemService(VibratorManager::class.java)?.defaultVibrator
        else getSystemService(Vibrator::class.java)

    @Suppress("DEPRECATION")
    private fun startVibration() {
        val vibrator = vibrator() ?: return
        val pattern = VibrationEffect.createWaveform(longArrayOf(0, 800, 600), 0)
        // Alarm usage keeps it vibrating in Do Not Disturb, like the sound.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            vibrator.vibrate(pattern, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
        } else {
            vibrator.vibrate(pattern, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build())
        }
    }

    private fun stopRinging(reportToPc: Boolean) {
        handler.removeCallbacks(autoStop)
        player?.runCatching { stop(); release() }
        player = null
        vibrator()?.cancel()
        val id = alarmId
        alarmId = null
        _ringing.value = null
        if (reportToPc && id != null) {
            val container = applicationContext.appContainer
            CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
                runCatching { container.api.stopAlarm(id) }
            }
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacks(autoStop)
        player?.runCatching { release() }
        player = null
        super.onDestroy()
    }

    data class RingingAlarm(val id: String, val label: String)

    companion object {
        private const val ACTION_RING = "ring"
        private const val ACTION_STOP = "stop"
        private const val EXTRA_REPORT = "report"
        private const val NOTIFICATION_ID = 3
        private const val AUTO_STOP_MS = 10 * 60_000L

        private val _ringing = MutableStateFlow<RingingAlarm?>(null)
        /** The alarm ringing right now, for AlarmActivity. */
        val ringing: StateFlow<RingingAlarm?> = _ringing

        fun start(context: Context, alarmId: String, label: String, fireAtMs: Long) {
            startRingService(
                context,
                Intent(context, AlarmRingService::class.java)
                    .setAction(ACTION_RING)
                    .putExtra(PhoneAlarms.EXTRA_ALARM_ID, alarmId)
                    .putExtra(PhoneAlarms.EXTRA_LABEL, label)
                    .putExtra(PhoneAlarms.EXTRA_FIRE_AT, fireAtMs)
            )
        }

        fun stopIntent(context: Context, reportToPc: Boolean = true): Intent =
            Intent(context, AlarmRingService::class.java).setAction(ACTION_STOP).putExtra(EXTRA_REPORT, reportToPc)

        /** Stopped elsewhere (e.g. on the PC): silence it without reporting back. */
        fun stopFromElsewhere(context: Context, alarmId: String) {
            if (ringing.value?.id == alarmId) context.startService(stopIntent(context, reportToPc = false))
        }
    }
}
