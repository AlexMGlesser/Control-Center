package com.alexmglesser.controlcenter.mobile.data.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Shapes of the Control Center server's JSON (control-app/server/routes/api.js).

@Serializable
data class DeviceRef(val id: String = "", val kind: String = "", val name: String = "")

@Serializable
data class AppInfo(
    val id: String,
    val name: String,
    val description: String = "",
    val status: String = "",
    val version: String? = null,
    val icon: String? = null
)

@Serializable
data class AppsResponse(val apps: List<AppInfo> = emptyList())

@Serializable
data class ChatMessage(
    val id: Long,
    val role: String,
    val text: String,
    val timestamp: String = "",
    val device: DeviceRef? = null
)

@Serializable
data class ChatMessagesResponse(val messages: List<ChatMessage> = emptyList())

@Serializable
data class SendChatRequest(val text: String)

@Serializable
data class SendChatResponse(val ok: Boolean = false, val turnId: String? = null, val userMessage: ChatMessage? = null)

@Serializable
data class QueueTask(val task_id: String = "", val priority: String = "")

@Serializable
data class QueueStatus(val queueLength: Int = 0, val tasks: List<QueueTask> = emptyList())

@Serializable
data class QueueStatusResponse(val queue: QueueStatus = QueueStatus())

@Serializable
data class PairRequest(val code: String, val deviceName: String, val kind: String = "phone")

@Serializable
data class PairResponse(
    val ok: Boolean = false,
    val deviceId: String? = null,
    val token: String? = null,
    val serverName: String? = null,
    val code: String? = null,
    val message: String? = null
)

@Serializable
data class SystemInfo(val name: String = "", val version: String = "")

@Serializable
data class ApiErrorBody(val ok: Boolean = false, val code: String? = null, val message: String? = null)

@Serializable
data class ServerEvent(
    val id: Long = 0,
    val timestamp: String = "",
    val source: String = "",
    val appId: String = "",
    val type: String = "",
    val message: String = "",
    val meta: JsonObject? = null,
    val isAIThought: Boolean = false
) {
    fun metaString(key: String): String? = (meta?.get(key) as? JsonPrimitive)?.contentOrNull

    /** The device a chat turn came from (meta.origin.device.id), if any. */
    fun originDeviceId(): String? = runCatching {
        meta?.get("origin")?.jsonObject?.get("device")?.jsonObject?.get("id")?.jsonPrimitive?.contentOrNull
    }.getOrNull()
}

/** One `data:` line of the event stream. */
@Serializable
data class StreamMessage(
    val type: String,
    val event: ServerEvent? = null,
    val events: List<ServerEvent> = emptyList()
)
