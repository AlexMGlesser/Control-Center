package com.alexmglesser.controlcenter.mobile.ui.screens

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.alexmglesser.controlcenter.mobile.BuildConfigInfo
import com.alexmglesser.controlcenter.mobile.data.AppSettings
import com.alexmglesser.controlcenter.mobile.data.Session
import com.alexmglesser.controlcenter.mobile.data.events.ConnectionState
import com.alexmglesser.controlcenter.mobile.ui.components.NeonButton
import com.alexmglesser.controlcenter.mobile.ui.components.SectionLabel
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import java.text.DateFormat
import java.util.Date

/** Settings (design 3.4). */
@Composable
fun SettingsScreen(
    session: Session,
    connection: ConnectionState,
    settings: AppSettings,
    onUpdate: ((AppSettings) -> AppSettings) -> Unit,
    onSignOut: () -> Unit
) {
    val context = LocalContext.current
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    var batteryExempt by remember { mutableStateOf(isIgnoringBatteryOptimizations(context)) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { batteryExempt = isIgnoringBatteryOptimizations(context) }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier
                .widthIn(max = 560.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp)
        ) {
            SectionLabel("Connection")
            InfoRow("Home PC", session.serverName)
            InfoRow("Address", session.baseUrl.removePrefix("https://"))
            InfoRow(
                "Status",
                when (connection) {
                    is ConnectionState.Connected -> "Online"
                    is ConnectionState.Reconnecting, ConnectionState.Connecting -> "Reconnecting…"
                    is ConnectionState.Disconnected -> "Offline: ${connection.cause.describe(session.serverName)}"
                    else -> "Offline"
                }
            )
            ToggleRow(
                "Stay connected",
                "Keeps the connection open in the background, with a silent status notification.",
                settings.stayConnected
            ) { checked -> onUpdate { it.copy(stayConnected = checked) } }

            SectionLabel("This device")
            InfoRow("Name", session.deviceName)
            InfoRow("Paired", DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(session.pairedAt)))

            SectionLabel("Notifications")
            ToggleRow("Connection alerts", "When the connection to the PC is lost or comes back.", settings.connectionAlerts) { checked ->
                onUpdate { it.copy(connectionAlerts = checked) }
            }
            ToggleRow("Jarvis replies", "When Jarvis answers after you've left the app.", settings.jarvisReplies) { checked ->
                onUpdate { it.copy(jarvisReplies = checked) }
            }
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Battery optimization", color = CC.textPrimary)
                    Text(
                        if (batteryExempt) "Off, so the connection survives sleep." else "On: Android may drop the connection when the phone sleeps.",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (batteryExempt) CC.ok else CC.warn
                    )
                }
                if (!batteryExempt) {
                    NeonButton("Turn off", onClick = { requestBatteryExemption(context) })
                }
            }

            SectionLabel("About")
            InfoRow("App", BuildConfigInfo.versionName(context))

            Spacer(Modifier.height(24.dp))
            NeonButton("Sign out of this device", accent = CC.red, modifier = Modifier.fillMaxWidth(), onClick = { confirmSignOut = true })
            Spacer(Modifier.height(24.dp))
        }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Sign out?") },
            text = { Text("This phone will be removed from Control Center and will need to pair again.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmSignOut = false
                    onSignOut()
                }) { Text("Sign out", color = CC.red) }
            },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
            containerColor = CC.bgPanel
        )
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, color = CC.textSecondary)
        Spacer(Modifier.padding(horizontal = 8.dp))
        Text(value, color = CC.textPrimary, maxLines = 2)
    }
}

@Composable
private fun ToggleRow(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = CC.textPrimary)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = CC.textSecondary)
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(checkedThumbColor = CC.bgPrimary, checkedTrackColor = CC.cyan)
        )
    }
}

fun isIgnoringBatteryOptimizations(context: Context): Boolean =
    context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

/** Opens Android's "let this app run in the background" prompt. */
@SuppressLint("BatteryLife") // Sideloaded app whose job is a persistent connection.
fun requestBatteryExemption(context: Context) {
    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, "package:${context.packageName}".toUri())
    runCatching { context.startActivity(intent) }
        .onFailure { context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
}
