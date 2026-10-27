package com.alexmglesser.controlcenter.mobile.alarm

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.ControlCenterTheme
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable
import java.text.DateFormat
import java.util.Date

/** Full-screen alarm over the lock screen with one big Stop button. */
class AlarmActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        enableEdgeToEdge()
        val label = intent.getStringExtra(PhoneAlarms.EXTRA_LABEL) ?: "Alarm"
        setContent {
            ControlCenterTheme {
                val ringing by AlarmRingService.ringing.collectAsStateWithLifecycle()
                // Closes itself once the alarm stops, from here or anywhere else.
                LaunchedEffect(ringing) { if (ringing == null) finish() }
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(CC.bgPrimary)
                        .systemBarsPadding(),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
                        Icon(painterResource(R.drawable.ic_bell), contentDescription = null, tint = CC.cyan, modifier = Modifier.size(64.dp))
                        Text(
                            DateFormat.getTimeInstance(DateFormat.SHORT).format(Date()),
                            fontSize = 56.sp,
                            fontWeight = FontWeight.Light,
                            color = CC.textPrimary
                        )
                        Text(ringing?.label ?: label, style = MaterialTheme.typography.headlineSmall, color = CC.textSecondary)
                        Box(
                            Modifier
                                .padding(top = 32.dp)
                                .widthIn(max = 360.dp)
                                .fillMaxWidth()
                                .height(88.dp)
                                .neonClickable(TileShape, accent = CC.cyan, restBorder = CC.cyan, haptic = true) {
                                    startService(AlarmRingService.stopIntent(this@AlarmActivity))
                                    finish()
                                }
                                .background(CC.cyan.copy(alpha = 0.14f), TileShape),
                            contentAlignment = Alignment.Center
                        ) {
                            Text("STOP", fontSize = 28.sp, fontWeight = FontWeight.SemiBold, color = CC.cyan)
                        }
                    }
                }
            }
        }
    }

    companion object {
        fun intent(context: Context, alarmId: String, label: String): Intent =
            Intent(context, AlarmActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
                .putExtra(PhoneAlarms.EXTRA_ALARM_ID, alarmId)
                .putExtra(PhoneAlarms.EXTRA_LABEL, label)
    }
}
