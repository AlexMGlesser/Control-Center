package com.alexmglesser.controlcenter.mobile.data.api

import com.alexmglesser.controlcenter.mobile.data.Session
import com.alexmglesser.controlcenter.mobile.data.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, val code: String?, message: String) : Exception(message)

/** Talks to the Control Center server on the home PC, with the device token. */
class ApiClient(private val sessionStore: SessionStore) {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /** For the event stream: no read timeout (the stream has its own heartbeat watchdog). */
    val streamHttp: OkHttpClient = http.newBuilder().readTimeout(0, TimeUnit.SECONDS).build()

    /** Called when the PC rejects our token, i.e. this device was removed there. */
    var onUnauthorized: () -> Unit = {}

    suspend fun pair(baseUrl: String, code: String, deviceName: String): PairResponse {
        val body = json.encodeToString(PairRequest.serializer(), PairRequest(code, deviceName))
        val request = Request.Builder()
            .url("$baseUrl/api/devices/pair")
            .post(body.toRequestBody(JSON_TYPE))
            .build()
        return execute(request, authenticated = false) { json.decodeFromString(PairResponse.serializer(), it) }
    }

    suspend fun health(baseUrl: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            http.newCall(Request.Builder().url("$baseUrl/api/health").build()).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    suspend fun apps(): List<AppInfo> = get("/api/apps") { json.decodeFromString(AppsResponse.serializer(), it).apps }

    suspend fun system(): SystemInfo = get("/api/system") { json.decodeFromString(SystemInfo.serializer(), it) }

    suspend fun chatMessages(limit: Int = 120): List<ChatMessage> =
        get("/api/chat/messages?limit=$limit") { json.decodeFromString(ChatMessagesResponse.serializer(), it).messages }

    suspend fun sendChat(text: String): SendChatResponse {
        val body = json.encodeToString(SendChatRequest.serializer(), SendChatRequest(text))
        return send("POST", "/api/chat/messages", body) { json.decodeFromString(SendChatResponse.serializer(), it) }
    }

    suspend fun queueStatus(): QueueStatus =
        get("/api/agent/queue/status") { json.decodeFromString(QueueStatusResponse.serializer(), it).queue }

    suspend fun alarms(): List<AlarmInfo> = get("/api/alarms") { json.decodeFromString(AlarmsResponse.serializer(), it).alarms }

    /** Tells the PC this phone's alarm was stopped (so the PC stops tracking it as ringing). */
    suspend fun stopAlarm(alarmId: String) {
        send("POST", "/api/alarms/$alarmId/stop", "{}") { }
    }

    /** Unpairs this device on the PC (Settings > Sign out). */
    suspend fun signOutDevice() {
        send("DELETE", "/api/devices/self", null) { }
    }

    fun authorizedRequest(session: Session, path: String): Request.Builder =
        Request.Builder()
            .url(session.baseUrl + path)
            .header("Authorization", "Bearer ${session.token}")

    private suspend fun <T> get(path: String, parse: (String) -> T): T {
        val session = requireSession()
        return execute(authorizedRequest(session, path).get().build(), authenticated = true, parse)
    }

    private suspend fun <T> send(method: String, path: String, body: String?, parse: (String) -> T): T {
        val session = requireSession()
        val requestBody = (body ?: "").toRequestBody(JSON_TYPE)
        val request = authorizedRequest(session, path).method(method, if (method == "DELETE" && body == null) null else requestBody).build()
        return execute(request, authenticated = true, parse)
    }

    private fun requireSession(): Session =
        sessionStore.currentSession() ?: throw ApiException(401, "NOT_PAIRED", "This phone isn't paired.")

    private suspend fun <T> execute(request: okhttp3.Request, authenticated: Boolean, parse: (String) -> T): T =
        withContext(Dispatchers.IO) {
            val response = try {
                http.newCall(request).execute()
            } catch (error: IOException) {
                throw ApiException(0, "NETWORK", "Can't reach the PC: ${error.message ?: "network error"}")
            }
            response.use {
                val text = it.body?.string().orEmpty()
                if (!it.isSuccessful) {
                    val error = runCatching { json.decodeFromString(ApiErrorBody.serializer(), text) }.getOrNull()
                    if (it.code == 401 && authenticated) {
                        onUnauthorized()
                    }
                    throw ApiException(it.code, error?.code, error?.message ?: "Request failed (${it.code}).")
                }
                parse(text)
            }
        }

    companion object {
        private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

        /** Turns what a person types ("my-pc.tailnet.ts.net") into a base URL. */
        fun normalizeBaseUrl(raw: String): String? {
            val trimmed = raw.trim().trimEnd('/')
            if (trimmed.isEmpty()) return null
            val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed else "https://$trimmed"
            val url = withScheme.toHttpUrlOrNull() ?: return null
            return url.toString().trimEnd('/')
        }
    }
}
