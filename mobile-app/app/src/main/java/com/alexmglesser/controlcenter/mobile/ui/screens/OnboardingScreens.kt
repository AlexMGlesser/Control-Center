package com.alexmglesser.controlcenter.mobile.ui.screens

import android.Manifest
import android.annotation.SuppressLint
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.ui.components.NeonButton
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape

/**
 * Two short, skippable screens after pairing (design 8.2): notifications,
 * then staying connected in the background.
 */
@SuppressLint("InlinedApi") // The permission is only requested on Android 13+ (see needsNotificationPrompt).
@Composable
fun FirstRunScreen(onDone: () -> Unit) {
    val context = LocalContext.current
    var step by rememberSaveable { mutableIntStateOf(0) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { step = 1 }

    val needsNotificationPrompt = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    if (step == 0 && !needsNotificationPrompt) step = 1

    OnboardingCard(
        icon = if (step == 0) R.drawable.ic_bell else R.drawable.ic_refresh_cw,
        title = if (step == 0) "Get notified" else "Stay connected in the background",
        body = if (step == 0) {
            "Control Center can tell you when calendar events start, when the connection to your PC has a problem, and when Jarvis replies after you've left the app."
        } else {
            "The connection to your PC stays open even with the app closed, shown by a silent status notification. Android will ask whether the app may keep running in the background."
        },
        primary = if (step == 0) "Allow notifications" else "Allow",
        onPrimary = {
            if (step == 0) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                if (!isIgnoringBatteryOptimizations(context)) requestBatteryExemption(context)
                onDone()
            }
        },
        onSkip = { if (step == 0) step = 1 else onDone() }
    )
}

/** The PC removed this device (design 5, Unauthorized). */
@Composable
fun RemovedScreen(onConnectAgain: () -> Unit) {
    OnboardingCard(
        icon = R.drawable.ic_log_out,
        title = "This device was removed from Control Center",
        body = "It was removed on the PC, or its pairing is no longer valid. Pair it again to reconnect.",
        primary = "Connect again",
        onPrimary = onConnectAgain,
        onSkip = null
    )
}

@Composable
private fun OnboardingCard(
    icon: Int,
    title: String,
    body: String,
    primary: String,
    onPrimary: () -> Unit,
    onSkip: (() -> Unit)?
) {
    Box(
        Modifier
            .fillMaxSize()
            .background(CC.bgPrimary)
            .systemBarsPadding(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            Modifier
                .widthIn(max = 560.dp)
                .padding(24.dp)
                .background(CC.bgPanel, TileShape)
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Icon(painterResource(icon), contentDescription = null, tint = CC.cyan, modifier = Modifier.size(40.dp))
            Text(title, style = MaterialTheme.typography.titleLarge, color = CC.textPrimary, textAlign = TextAlign.Center)
            Text(body, color = CC.textSecondary, textAlign = TextAlign.Center)
            NeonButton(primary, primary = true, modifier = Modifier.fillMaxWidth(), onClick = onPrimary)
            onSkip?.let {
                TextButton(onClick = it) { Text("Not now", color = CC.textSecondary) }
            }
        }
    }
}
