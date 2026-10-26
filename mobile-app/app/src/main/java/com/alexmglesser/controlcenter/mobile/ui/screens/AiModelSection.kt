package com.alexmglesser.controlcenter.mobile.ui.screens

import android.app.Application
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.OllamaModel
import com.alexmglesser.controlcenter.mobile.ui.components.NeonButton
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import kotlinx.coroutines.launch

/** The PC's installed Ollama models and the one Jarvis and the IDE use. */
class AiModelViewModel(application: Application) : AndroidViewModel(application) {
    private val container = application.appContainer
    private val api = container.api

    var active by mutableStateOf<String?>(null)
        private set
    var defaultModel by mutableStateOf<String?>(null)
        private set
    var models by mutableStateOf<List<OllamaModel>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var switching by mutableStateOf<String?>(null)
        private set
    var message by mutableStateOf<String?>(null)
        private set
    /** A refresh clears a failure, but not the "Now using…" confirmation. */
    private var messageIsError = false

    init {
        // Switched on the PC (or another device): show the new one.
        viewModelScope.launch {
            container.connection.events.collect { event ->
                if (event.appId == "control-center" && event.type == "ollama") refresh()
            }
        }
    }

    /** Asks the PC which models are installed right now. */
    fun refresh() {
        viewModelScope.launch {
            loading = true
            runCatching { api.ollamaModels() }
                .onSuccess {
                    active = it.active
                    defaultModel = it.default
                    models = it.models
                    when {
                        it.models.isEmpty() -> showError("No models are installed in Ollama on the PC.")
                        messageIsError -> message = null
                    }
                }
                .onFailure { showError(it.message ?: "Couldn't load the models.") }
            loading = false
        }
    }

    fun switchTo(model: String) {
        if (model == active || switching != null) return
        viewModelScope.launch {
            switching = model
            runCatching { api.setOllamaModel(model) }
                .onSuccess {
                    active = it.model
                    messageIsError = false
                    message = "Now using ${it.model}. It loads on the next request, which takes a few seconds."
                }
                .onFailure { showError(it.message ?: "Couldn't switch models.") }
            switching = null
        }
    }

    private fun showError(text: String) {
        messageIsError = true
        message = text
    }
}

/** Settings > AI model: which local model answers Jarvis and the IDE's AI panel. */
@Composable
fun AiModelSection(vm: AiModelViewModel = viewModel()) {
    var picking by rememberSaveable { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }

    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text("AI model", color = CC.textPrimary)
            Text(
                vm.switching?.let { "Switching to $it…" } ?: vm.active ?: if (vm.loading) "Loading…" else "Unknown",
                style = MaterialTheme.typography.bodySmall,
                color = CC.textSecondary
            )
        }
        NeonButton("Change", enabled = vm.switching == null, onClick = {
            // Check what's installed before showing the list.
            vm.refresh()
            picking = true
        })
    }
    vm.message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = CC.textSecondary, modifier = Modifier.padding(bottom = 6.dp)) }

    if (picking) {
        AlertDialog(
            onDismissRequest = { picking = false },
            title = { Text("AI model") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(
                        "Installed on the PC. Used by Jarvis and the IDE.",
                        style = MaterialTheme.typography.bodySmall,
                        color = CC.textSecondary,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )
                    if (vm.models.isEmpty()) {
                        Text(if (vm.loading) "Checking the PC…" else vm.message ?: "No models found.", color = CC.textSecondary)
                    }
                    vm.models.forEach { model ->
                        val current = model.name == vm.active
                        TextButton(
                            onClick = {
                                picking = false
                                vm.switchTo(model.name)
                            },
                            enabled = !current
                        ) {
                            Column(Modifier.fillMaxWidth()) {
                                Text(
                                    model.name + if (model.name == vm.defaultModel) " (default)" else "",
                                    color = if (current) CC.cyan else CC.textPrimary
                                )
                                val details = listOfNotNull(
                                    model.parameterSize,
                                    model.quantization,
                                    model.size?.let { "%.1f GB".format(it / 1024.0 / 1024.0 / 1024.0) },
                                    if (current) "in use" else null
                                ).joinToString(" · ")
                                if (details.isNotEmpty()) Text(details, style = MaterialTheme.typography.bodySmall, color = CC.textSecondary)
                            }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { picking = false }) { Text("Cancel") } },
            containerColor = CC.bgPanel
        )
    }
}
