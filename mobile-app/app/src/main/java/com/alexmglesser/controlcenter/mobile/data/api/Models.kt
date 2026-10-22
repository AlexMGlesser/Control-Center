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
data class AlarmInfo(
    val id: String,
    val label: String = "Alarm",
    val kind: String = "alarm",
    val time: String = "",
    val enabled: Boolean = true,
    val nextFireAt: String? = null,
    val nextFireAtLocal: String? = null,
    /** Set when the alarm was created from a paired device: only that device rings. */
    val deviceId: String? = null
)

@Serializable
data class AlarmsResponse(val alarms: List<AlarmInfo> = emptyList())

/* Projects (control-app/server/services/projectService.js) */

@Serializable
data class ProjectInfo(
    val id: String,
    val name: String,
    val path: String = "",
    /** "personal" or "work". */
    val category: String = "personal",
    val missing: Boolean = false
)

@Serializable
data class ProjectsResponse(val projects: List<ProjectInfo> = emptyList())

@Serializable
data class FolderEntry(
    val name: String,
    val path: String,
    /** "folder" or "file". */
    val type: String = "file",
    val size: Long? = null,
    val hidden: Boolean = false
)

@Serializable
data class FolderListing(
    val project: ProjectInfo,
    val path: String,
    val relativePath: String = "",
    /** Null at the project's root folder. */
    val parent: String? = null,
    val entries: List<FolderEntry> = emptyList()
)

@Serializable
data class ProjectFile(
    val name: String,
    val path: String,
    val size: Long = 0,
    /** The file's mtime in ms; sent back on save so edits made elsewhere aren't overwritten. */
    val modified: Double = 0.0,
    /** Over 512 KB: only the start was sent, so it can't be saved from the phone. */
    val truncated: Boolean = false,
    val text: String = ""
)

@Serializable
data class SaveFileRequest(val path: String, val content: String, val expectedModified: Double? = null)

@Serializable
data class SavedFile(val name: String, val path: String, val size: Long = 0, val modified: Double = 0.0)

@Serializable
data class CreateEntryRequest(val parentPath: String, val name: String, val type: String)

@Serializable
data class CreatedEntry(val name: String, val path: String, val type: String = "file")

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
