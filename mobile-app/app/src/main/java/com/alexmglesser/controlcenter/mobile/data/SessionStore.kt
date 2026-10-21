package com.alexmglesser.controlcenter.mobile.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.alexmglesser.controlcenter.mobile.data.auth.TokenCipher
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "control_center")

/** A paired connection to the home PC. */
data class Session(
    val baseUrl: String,
    val deviceId: String,
    val deviceName: String,
    val serverName: String,
    val token: String,
    val pairedAt: Long
)

data class AppSettings(
    val stayConnected: Boolean = true,
    val connectionAlerts: Boolean = true,
    val jarvisReplies: Boolean = true,
    val firstRunDone: Boolean = false
)

sealed interface SessionState {
    data object Loading : SessionState
    data object NotPaired : SessionState
    data class Paired(val session: Session) : SessionState
    /** The PC rejected our token: the device was removed there. */
    data object Removed : SessionState
}

/**
 * Pairing details and settings, in DataStore. The device token is stored
 * encrypted (TokenCipher); the decrypted session is kept in memory for the
 * HTTP client.
 */
class SessionStore(private val context: Context) {
    private val cipher = TokenCipher()
    private val _state = MutableStateFlow<SessionState>(SessionState.Loading)
    val state: StateFlow<SessionState> = _state

    val settings: Flow<AppSettings> = context.dataStore.data.map { prefs ->
        AppSettings(
            stayConnected = prefs[STAY_CONNECTED] ?: true,
            connectionAlerts = prefs[CONNECTION_ALERTS] ?: true,
            jarvisReplies = prefs[JARVIS_REPLIES] ?: true,
            firstRunDone = prefs[FIRST_RUN_DONE] ?: false
        )
    }

    /** The current session, if paired. Safe to call from any thread. */
    fun currentSession(): Session? = (_state.value as? SessionState.Paired)?.session

    suspend fun load() {
        val prefs = context.dataStore.data.first()
        _state.value = readSession(prefs)?.let { SessionState.Paired(it) } ?: SessionState.NotPaired
    }

    suspend fun save(session: Session) {
        context.dataStore.edit { prefs ->
            prefs[BASE_URL] = session.baseUrl
            prefs[DEVICE_ID] = session.deviceId
            prefs[DEVICE_NAME] = session.deviceName
            prefs[SERVER_NAME] = session.serverName
            prefs[TOKEN] = cipher.encrypt(session.token)
            prefs[PAIRED_AT] = session.pairedAt
            prefs[FIRST_RUN_DONE] = false
        }
        _state.value = SessionState.Paired(session)
    }

    /** Forget the pairing (sign out, or after the PC removed this device). */
    suspend fun clear() {
        context.dataStore.edit { prefs ->
            listOf(BASE_URL, DEVICE_ID, DEVICE_NAME, SERVER_NAME, TOKEN).forEach { prefs.remove(it) }
            prefs.remove(PAIRED_AT)
        }
        _state.value = SessionState.NotPaired
    }

    fun markRemoved() {
        if (_state.value is SessionState.Paired) {
            _state.value = SessionState.Removed
        }
    }

    suspend fun updateSettings(transform: (AppSettings) -> AppSettings) {
        val updated = transform(settings.first())
        context.dataStore.edit { prefs ->
            prefs[STAY_CONNECTED] = updated.stayConnected
            prefs[CONNECTION_ALERTS] = updated.connectionAlerts
            prefs[JARVIS_REPLIES] = updated.jarvisReplies
            prefs[FIRST_RUN_DONE] = updated.firstRunDone
        }
    }

    suspend fun currentSettings(): AppSettings = settings.first()

    private fun readSession(prefs: Preferences): Session? {
        val token = prefs[TOKEN]?.let(cipher::decrypt) ?: return null
        return Session(
            baseUrl = prefs[BASE_URL] ?: return null,
            deviceId = prefs[DEVICE_ID] ?: return null,
            deviceName = prefs[DEVICE_NAME] ?: "Phone",
            serverName = prefs[SERVER_NAME] ?: "PC",
            token = token,
            pairedAt = prefs[PAIRED_AT] ?: 0L
        )
    }

    private companion object {
        val BASE_URL = stringPreferencesKey("base_url")
        val DEVICE_ID = stringPreferencesKey("device_id")
        val DEVICE_NAME = stringPreferencesKey("device_name")
        val SERVER_NAME = stringPreferencesKey("server_name")
        val TOKEN = stringPreferencesKey("token_encrypted")
        val PAIRED_AT = longPreferencesKey("paired_at")
        val STAY_CONNECTED = booleanPreferencesKey("stay_connected")
        val CONNECTION_ALERTS = booleanPreferencesKey("connection_alerts")
        val JARVIS_REPLIES = booleanPreferencesKey("jarvis_replies")
        val FIRST_RUN_DONE = booleanPreferencesKey("first_run_done")
    }
}
