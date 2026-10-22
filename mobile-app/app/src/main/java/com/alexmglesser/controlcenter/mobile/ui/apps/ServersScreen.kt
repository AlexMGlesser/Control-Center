package com.alexmglesser.controlcenter.mobile.ui.apps

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.ServerInfo
import com.alexmglesser.controlcenter.mobile.ui.components.AppTopBar
import com.alexmglesser.controlcenter.mobile.ui.components.NeonButton
import com.alexmglesser.controlcenter.mobile.ui.components.Note
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable
import kotlinx.coroutines.launch

class ServersViewModel(application: Application) : AndroidViewModel(application) {
    private val container = application.appContainer

    var servers by mutableStateOf<List<ServerInfo>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)
        private set

    init {
        refresh()
        viewModelScope.launch {
            container.connection.events.collect { event ->
                if (event.appId == "server-manager-app" && event.type == "data-changed") refresh()
            }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            loading = true
            runCatching { container.api.servers() }.onSuccess { servers = it }.onFailure { message = it.message }
            loading = false
        }
    }
}

/** Server Manager on the phone: the list, details, and Open SSH in an Android SSH app (design). */
@Composable
fun ServersScreen(onExit: () -> Unit, vm: ServersViewModel = viewModel()) {
    val context = LocalContext.current
    var selected by remember { mutableStateOf<ServerInfo?>(null) }
    var needsSshApp by remember { mutableStateOf(false) }
    BackHandler { onExit() }

    Column(Modifier.fillMaxSize()) {
        AppTopBar("Servers", onBack = onExit)
        vm.message?.let { Text(it, color = CC.warn, modifier = Modifier.padding(horizontal = 16.dp)) }
        if (vm.servers.isEmpty()) {
            Note(if (vm.loading) "Loading…" else "No servers yet. Add them in Server Manager on the PC.")
        } else {
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(vm.servers, key = { it.id }) { server ->
                    Column(
                        Modifier
                            .widthIn(max = 640.dp)
                            .fillMaxWidth()
                            .neonClickable(TileShape, onClick = { selected = server })
                            .background(CC.bgPanel, TileShape)
                            .padding(16.dp)
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(server.name, color = CC.textPrimary, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                            if (server.environment.isNotBlank()) Text(server.environment, color = CC.cyan, style = MaterialTheme.typography.labelSmall)
                        }
                        Text(address(server), color = CC.textSecondary, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }

    selected?.let { server ->
        AlertDialog(
            onDismissRequest = { selected = null },
            title = { Text(server.name) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Host: ${server.ssh.host.ifBlank { "not set" }}", color = CC.textPrimary)
                    Text("User: ${server.ssh.username.ifBlank { "not set" }}", color = CC.textPrimary)
                    Text("Port: ${server.ssh.port}", color = CC.textPrimary)
                    Text(
                        "SSH keys stay on the PC. Your SSH app uses its own key or a password.",
                        color = CC.textSecondary,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            },
            confirmButton = {
                NeonButton("Open SSH", primary = true, enabled = server.ssh.host.isNotBlank(), onClick = {
                    selected = null
                    if (!openSsh(context, server)) needsSshApp = true
                })
            },
            dismissButton = { TextButton(onClick = { selected = null }) { Text("Close") } },
            shape = TileShape,
            containerColor = CC.bgPanel
        )
    }

    if (needsSshApp) {
        AlertDialog(
            onDismissRequest = { needsSshApp = false },
            title = { Text("No SSH app") },
            text = { Text("Install an SSH app such as JuiceSSH or Termux, then try again.") },
            confirmButton = {
                TextButton(onClick = {
                    needsSshApp = false
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, "market://details?id=com.sonelli.juicessh".toUri()))
                    }
                }) { Text("Get JuiceSSH") }
            },
            dismissButton = { TextButton(onClick = { needsSshApp = false }) { Text("Cancel") } },
            shape = TileShape,
            containerColor = CC.bgPanel
        )
    }
}

private fun address(server: ServerInfo): String {
    val user = server.ssh.username.ifBlank { "(user)" }
    val host = server.ssh.host.ifBlank { "(host)" }
    return if (server.ssh.port == 22) "$user@$host" else "$user@$host:${server.ssh.port}"
}

/** Hands ssh://user@host:port to whichever SSH app is installed. */
private fun openSsh(context: Context, server: ServerInfo): Boolean {
    val user = server.ssh.username.takeIf { it.isNotBlank() }?.let { "${Uri.encode(it)}@" }.orEmpty()
    val uri = "ssh://$user${server.ssh.host}:${server.ssh.port}".toUri()
    return try {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri))
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}
