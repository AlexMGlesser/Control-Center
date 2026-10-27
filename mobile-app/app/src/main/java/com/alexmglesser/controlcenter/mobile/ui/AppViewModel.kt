package com.alexmglesser.controlcenter.mobile.ui

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.alexmglesser.controlcenter.mobile.alarm.PhoneAlarms
import com.alexmglesser.controlcenter.mobile.notify.CalendarReminders
import com.alexmglesser.controlcenter.mobile.ui.hack.HackActivity
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.AppSettings
import com.alexmglesser.controlcenter.mobile.data.Session
import com.alexmglesser.controlcenter.mobile.data.SessionState
import com.alexmglesser.controlcenter.mobile.data.api.ApiClient
import com.alexmglesser.controlcenter.mobile.data.api.ApiException
import com.alexmglesser.controlcenter.mobile.data.api.AppInfo
import com.alexmglesser.controlcenter.mobile.data.api.ChatMessage
import com.alexmglesser.controlcenter.mobile.data.api.ServerEvent
import com.alexmglesser.controlcenter.mobile.data.events.ConnectionState
import com.alexmglesser.controlcenter.mobile.service.ConnectionServiceController
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

enum class Tab { APPS, JARVIS, SETTINGS }

/** A message this phone sent that Jarvis hasn't answered yet. */
data class PendingTurn(val turnId: String, val toolLines: List<String> = emptyList())

data class ChatUiState(
    val messages: List<ChatMessage> = emptyList(),
    val pending: List<PendingTurn> = emptyList(),
    val queuedAhead: Int = 0,
    val sending: Boolean = false,
    val error: String? = null
)

data class PairingUiState(val busy: Boolean = false, val error: String? = null)

/** Payload of the pairing QR code shown on the PC. */
data class PairingPayload(val url: String?, val code: String, val name: String?)

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val container = application.appContainer
    val sessionState: StateFlow<SessionState> = container.sessionStore.state
    val connection: StateFlow<ConnectionState> = container.connection.state
    val settings: StateFlow<AppSettings> = container.sessionStore.settings
        .stateIn(viewModelScope, SharingStarted.Eagerly, AppSettings(firstRunDone = true))

    private val _tab = MutableStateFlow(Tab.APPS)
    val tab: StateFlow<Tab> = _tab.asStateFlow()

    /** The app open on screen, or null for the grid. */
    private val _openAppId = MutableStateFlow<String?>(null)
    val openAppId: StateFlow<String?> = _openAppId.asStateFlow()

    private val _apps = MutableStateFlow<List<AppInfo>>(emptyList())
    val apps: StateFlow<List<AppInfo>> = _apps.asStateFlow()

    private val _appsLoading = MutableStateFlow(false)
    val appsLoading: StateFlow<Boolean> = _appsLoading.asStateFlow()

    private val _chat = MutableStateFlow(ChatUiState())
    val chat: StateFlow<ChatUiState> = _chat.asStateFlow()

    private val _pairing = MutableStateFlow(PairingUiState())
    val pairing: StateFlow<PairingUiState> = _pairing.asStateFlow()

    /** A chip in the chat after Jarvis opens an app for this phone: tap it to go there. */
    private val _openedByJarvis = MutableStateFlow<AppInfo?>(null)
    val openedByJarvis: StateFlow<AppInfo?> = _openedByJarvis.asStateFlow()

    init {
        viewModelScope.launch {
            container.connection.events.collect(::onServerEvent)
        }
        viewModelScope.launch {
            var wasConnected = false
            container.connection.state.collect { state ->
                val connected = state is ConnectionState.Connected
                if (connected && !wasConnected) {
                    refreshApps()
                    refreshChat()
                }
                wasConnected = connected
            }
        }
        viewModelScope.launch {
            sessionState.collect { if (it is SessionState.Paired) refreshApps() }
        }
    }

    /* Navigation */

    fun selectTab(tab: Tab) {
        _tab.value = tab
        if (tab == Tab.JARVIS) refreshChat()
    }

    fun openApp(appId: String) {
        _tab.value = Tab.APPS
        _openAppId.value = appId
    }

    fun closeApp() {
        _openAppId.value = null
    }

    /** Back gesture: leave the app, then go back to the grid. Returns false at the top. */
    fun handleBack(): Boolean = when {
        _openAppId.value != null -> {
            closeApp(); true
        }
        _tab.value != Tab.APPS -> {
            _tab.value = Tab.APPS; true
        }
        else -> false
    }

    /* Data */

    fun refreshApps() {
        if (container.sessionStore.currentSession() == null) return
        viewModelScope.launch {
            _appsLoading.value = true
            runCatching { container.api.apps() }.onSuccess { _apps.value = it }
            _appsLoading.value = false
        }
    }

    fun refreshChat() {
        if (container.sessionStore.currentSession() == null) return
        viewModelScope.launch {
            runCatching { container.api.chatMessages() }.onSuccess { messages ->
                _chat.update { it.copy(messages = messages) }
            }
            runCatching { container.api.queueStatus() }.onSuccess { queue ->
                _chat.update { it.copy(queuedAhead = (queue.queueLength - 1).coerceAtLeast(0)) }
            }
        }
    }

    fun sendChat(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch {
            _chat.update { it.copy(sending = true, error = null) }
            try {
                val result = container.api.sendChat(trimmed)
                _chat.update { state ->
                    state.copy(
                        sending = false,
                        messages = result.userMessage?.let { state.messages + it } ?: state.messages,
                        pending = result.turnId?.let { state.pending + PendingTurn(it) } ?: state.pending
                    )
                }
            } catch (error: ApiException) {
                _chat.update { it.copy(sending = false, error = error.message) }
            }
        }
    }

    /** Tapping the "Opened …" chip in the chat goes to that app. */
    fun openChipApp() {
        val app = _openedByJarvis.value ?: return
        _openedByJarvis.value = null
        openApp(app.id)
    }

    private fun onServerEvent(event: ServerEvent) {
        val myDeviceId = container.sessionStore.currentSession()?.deviceId ?: return
        when (event.type) {
            "chat" -> {
                val turnId = event.metaString("turnId")
                _chat.update { state -> state.copy(pending = state.pending.filterNot { it.turnId == turnId }) }
                refreshChat()
            }
            "chat-queued" -> refreshChat()
            "thought" -> {
                val turnId = event.metaString("turnId") ?: return
                val tool = event.metaString("tool") ?: return
                _chat.update { state ->
                    state.copy(pending = state.pending.map { if (it.turnId == turnId) it.copy(toolLines = it.toolLines + tool) else it })
                }
            }
            "open-app" -> if (event.metaString("targetDeviceId") == myDeviceId) {
                // The phone's own just-for-fun screen, not one of the PC's apps.
                if (event.metaString("target") == "hack-mainframe") {
                    HackActivity.start(getApplication<Application>(), newTask = true)
                    return
                }
                val app = _apps.value.firstOrNull { it.id == event.metaString("target") } ?: return
                // In the chat, don't jump away: the reply is about to arrive there.
                // A chip under it opens the app with one tap instead.
                if (_tab.value == Tab.JARVIS) _openedByJarvis.value = app else openApp(app.id)
            }
            "close-app" -> if (event.metaString("targetDeviceId") == myDeviceId) closeApp()
            "device-revoked" -> if (event.metaString("deviceId") == myDeviceId) container.sessionStore.markRemoved()
        }
    }

    /* Pairing and settings */

    fun pair(payload: PairingPayload, deviceName: String) {
        val baseUrl = payload.url?.let(ApiClient::normalizeBaseUrl)
        if (baseUrl == null) {
            _pairing.value = PairingUiState(error = "The PC's remote access isn't set up yet. Finish the checklist in Settings > Devices on the PC.")
            return
        }
        viewModelScope.launch {
            _pairing.value = PairingUiState(busy = true)
            try {
                val response = container.api.pair(baseUrl, payload.code, deviceName.ifBlank { defaultDeviceName() })
                val token = response.token
                val deviceId = response.deviceId
                if (!response.ok || token == null || deviceId == null) {
                    _pairing.value = PairingUiState(error = response.message ?: "Pairing failed.")
                    return@launch
                }
                container.sessionStore.save(
                    Session(
                        baseUrl = baseUrl,
                        deviceId = deviceId,
                        deviceName = deviceName.ifBlank { defaultDeviceName() },
                        serverName = response.serverName ?: payload.name ?: "PC",
                        token = token,
                        pairedAt = System.currentTimeMillis()
                    )
                )
                _pairing.value = PairingUiState()
                ConnectionServiceController.start(getApplication())
            } catch (error: ApiException) {
                _pairing.value = PairingUiState(error = friendlyPairingError(error))
            }
        }
    }

    fun clearPairingError() {
        _pairing.update { it.copy(error = null) }
    }

    fun completeFirstRun() {
        viewModelScope.launch { container.sessionStore.updateSettings { it.copy(firstRunDone = true) } }
    }

    fun updateSettings(transform: (AppSettings) -> AppSettings) {
        viewModelScope.launch {
            container.sessionStore.updateSettings(transform)
            // Reminder on/off or lead time changed: reschedule from the saved events.
            CalendarReminders.reschedule(getApplication(), container.sessionStore.currentSettings())
            if (!container.inForeground.value && !container.sessionStore.currentSettings().stayConnected) {
                ConnectionServiceController.stop(getApplication())
            }
        }
    }

    fun reconnectNow() = container.connection.reconnectNow()

    /** Sign out: unpair on the PC if it's reachable, then forget the pairing here. */
    fun signOut() {
        viewModelScope.launch {
            runCatching { container.api.signOutDevice() }
            forgetPairing()
        }
    }

    /** After the PC removed this device: forget it and go back to the Connect screen. */
    fun forgetPairing() {
        viewModelScope.launch {
            ConnectionServiceController.stop(getApplication())
            container.connection.stop()
            PhoneAlarms.cancelAll(getApplication())
            CalendarReminders.cancelAll(getApplication())
            container.sessionStore.clear()
            _apps.value = emptyList()
            _chat.value = ChatUiState()
            _openAppId.value = null
            _tab.value = Tab.APPS
        }
    }

    fun ensureConnectionService() {
        if (container.sessionStore.currentSession() != null) {
            ConnectionServiceController.start(getApplication())
        }
    }

    companion object {
        fun defaultDeviceName(): String = Build.MODEL?.takeIf { it.isNotBlank() } ?: "Phone"

        /** Parses the QR payload: {"v":1,"url":"https://…","code":"K7M2Q9TX","name":"alex-desktop"}. */
        fun parsePairingQr(raw: String, json: kotlinx.serialization.json.Json): PairingPayload? = runCatching {
            val obj = json.parseToJsonElement(raw) as JsonObject
            val code = obj["code"]?.jsonPrimitive?.contentOrNull ?: return null
            PairingPayload(
                url = obj["url"]?.jsonPrimitive?.contentOrNull,
                code = code,
                name = obj["name"]?.jsonPrimitive?.contentOrNull
            )
        }.getOrNull()

        private fun friendlyPairingError(error: ApiException): String = when (error.code) {
            "INVALID_PAIRING_CODE" -> "That code isn't right. Check it on the PC and try again."
            "PAIRING_CODE_EXPIRED" -> "That code has expired. Press Pair a device on the PC again."
            "TOO_MANY_PAIRING_ATTEMPTS" -> "Too many attempts. Wait a few minutes, then try again."
            "NETWORK" -> "Can't reach the PC. Is Tailscale on, and is Control Center running?"
            else -> error.message ?: "Pairing failed."
        }
    }
}
