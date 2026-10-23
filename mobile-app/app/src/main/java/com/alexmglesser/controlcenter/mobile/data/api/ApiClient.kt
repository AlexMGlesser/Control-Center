package com.alexmglesser.controlcenter.mobile.data.api

import com.alexmglesser.controlcenter.mobile.data.Session
import com.alexmglesser.controlcenter.mobile.data.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Dispatcher
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody
import java.io.File
import java.io.IOException
import java.net.URLEncoder
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

    /** For calls the PC may take minutes on, and whole-file downloads. */
    val slowHttp: OkHttpClient = http.newBuilder().readTimeout(160, TimeUnit.SECONDS).build()

    /**
     * For music and movies. Media3 queues its requests on an OkHttp
     * dispatcher, which allows only 5 per host at once, and a loaded song or
     * movie keeps its request open. On a dispatcher of their own they can't
     * use up the slots the event stream needs.
     */
    val mediaHttp: OkHttpClient = slowHttp.newBuilder()
        .dispatcher(Dispatcher().apply { maxRequestsPerHost = 16 })
        .build()

    /**
     * For the event stream: its own dispatcher, so nothing else can leave it
     * waiting in a queue, and no read timeout (it has its own heartbeat watchdog).
     */
    val streamHttp: OkHttpClient = http.newBuilder()
        .dispatcher(Dispatcher())
        .readTimeout(0, TimeUnit.SECONDS)
        .build()

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

    /* Music */

    suspend fun musicPlaylists(): List<MusicPlaylist> =
        get("/api/apps/music-app/playlists") { json.decodeFromString(MusicPlaylistsResponse.serializer(), it).playlists }

    /** "Play on PC": play-pause, next, prev or play-playlist. */
    suspend fun musicCommand(action: String, playlistName: String? = null) {
        val body = json.encodeToString(MusicCommandRequest.serializer(), MusicCommandRequest(action, playlistName))
        send("POST", "/api/apps/music-app/command", body) { }
    }

    fun musicTrackPath(sourcePath: String): String = "/api/apps/music-app/local-file?path=${encode(sourcePath)}"

    /* Movies */

    suspend fun movieLibrary(): MovieLibrary = get("/api/apps/movie-app/library") { json.decodeFromString(MovieLibrary.serializer(), it) }

    fun movieStreamPath(id: String): String = "/api/apps/movie-app/stream/${encode(id)}"

    fun movieSubtitlesPath(id: String, index: Int): String = "/api/apps/movie-app/subtitles/${encode(id)}?index=$index"

    /* Server Manager */

    suspend fun servers(): List<ServerInfo> =
        get("/api/apps/server-manager-app/servers") { json.decodeFromString(ServersResponse.serializer(), it).servers }

    /* Drawing */

    suspend fun drawings(): List<DrawingSummary> =
        get("/api/apps/drawing-app/files") { json.decodeFromString(DrawingsResponse.serializer(), it).files }

    suspend fun drawing(id: Long): DrawingFile =
        get("/api/apps/drawing-app/files/$id") { json.decodeFromString(DrawingResponse.serializer(), it).file }

    /** Raw bytes of any authorized GET (posters and the like). */
    suspend fun bytes(path: String): ByteArray = withContext(Dispatchers.IO) {
        callForBody(authorizedRequest(requireSession(), path).get().build()) { it.bytes() }
    }

    /* Calendar */

    suspend fun calendarEvents(startIso: String, endIso: String): List<CalendarEvent> =
        get("/api/apps/calendar-app/events?start=${encode(startIso)}&end=${encode(endIso)}&limit=500") {
            json.decodeFromString(CalendarEventsResponse.serializer(), it).events
        }

    suspend fun calendarMonth(year: Int, month: Int): CalendarMonth =
        get("/api/apps/calendar-app/month?year=$year&month=$month") { json.decodeFromString(CalendarMonth.serializer(), it) }

    suspend fun createCalendarEvent(request: CreateEventRequest): CalendarEvent? {
        val body = json.encodeToString(CreateEventRequest.serializer(), request)
        return send("POST", "/api/apps/calendar-app/events", body) { json.decodeFromString(CreateEventResponse.serializer(), it).event }
    }

    suspend fun deleteCalendarEvent(eventId: String) {
        send("DELETE", "/api/apps/calendar-app/events/${encode(eventId)}", null) { }
    }

    /* News */

    suspend fun newsBriefing(): NewsBriefing =
        get("/api/apps/news-app/briefing", slow = true) { json.decodeFromString(NewsBriefing.serializer(), it) }

    /* Wikipedia: cold searches on the PC's hard drive can take over a minute. */

    suspend fun wikiSearch(query: String): WikiSearchResponse =
        get("/api/apps/wikipedia-app/proxy/search?q=${encode(query)}", slow = true, allowError = true) {
            json.decodeFromString(WikiSearchResponse.serializer(), it)
        }

    suspend fun wikiArticle(title: String, section: String? = null): WikiArticle {
        val sectionQuery = section?.let { "&section=${encode(it)}" }.orEmpty()
        return get("/api/apps/wikipedia-app/proxy/article?title=${encode(title)}$sectionQuery&max_chars=20000", slow = true, allowError = true) {
            json.decodeFromString(WikiArticle.serializer(), it)
        }
    }

    suspend fun wikiRandom(): String =
        get("/api/apps/wikipedia-app/proxy/random", slow = true) { json.decodeFromString(WikiRandom.serializer(), it).title }

    /* File System (read-only) */

    suspend fun fileRoots(): FileRoots = get("/api/files/roots") { json.decodeFromString(FileRoots.serializer(), it) }

    suspend fun fileFolder(path: String, showHidden: Boolean): PcFolder =
        get("/api/files/list?path=${encode(path)}${if (showHidden) "&hidden=1" else ""}", slow = true) {
            json.decodeFromString(PcFolder.serializer(), it)
        }

    suspend fun fileInfo(path: String): PcFile = get("/api/files/info?path=${encode(path)}") { json.decodeFromString(PcFile.serializer(), it) }

    /** Where a file's bytes are served (supports Range). Needs [authorizedRequest]'s header. */
    fun fileContentPath(path: String, download: Boolean = false): String =
        "/api/files/content?path=${encode(path)}${if (download) "&download=1" else ""}"

    /** The first [maxBytes] of a file, for previews. */
    suspend fun fileHead(path: String, maxBytes: Int): ByteArray = withContext(Dispatchers.IO) {
        val session = requireSession()
        val request = authorizedRequest(session, fileContentPath(path)).header("Range", "bytes=0-${maxBytes - 1}").get().build()
        callForBody(request) { it.bytes() }
    }

    /** Streams a whole file to [destination]. */
    suspend fun downloadFile(path: String, destination: File) = withContext(Dispatchers.IO) {
        val session = requireSession()
        val request = authorizedRequest(session, fileContentPath(path, download = true)).get().build()
        callForBody(request, slowHttp) { body ->
            destination.outputStream().use { out -> body.byteStream().use { it.copyTo(out) } }
        }
    }

    private fun <T> callForBody(request: Request, client: OkHttpClient = http, read: (ResponseBody) -> T): T {
        val response = try {
            client.newCall(request).execute()
        } catch (error: IOException) {
            throw ApiException(0, "NETWORK", "Can't reach the PC: ${error.message ?: "network error"}")
        }
        return response.use {
            if (!it.isSuccessful) {
                val text = it.body?.string().orEmpty()
                val error = runCatching { json.decodeFromString(ApiErrorBody.serializer(), text) }.getOrNull()
                if (it.code == 401) onUnauthorized()
                throw ApiException(it.code, error?.code, error?.message ?: "Request failed (${it.code}).")
            }
            read(it.body ?: throw ApiException(it.code, null, "Empty response."))
        }
    }

    /* Projects: browse, read, save and create. Rename, move and delete stay on the PC. */

    suspend fun projects(): List<ProjectInfo> =
        get("/api/apps/project-app/projects") { json.decodeFromString(ProjectsResponse.serializer(), it).projects }

    suspend fun projectFolder(projectId: String, folderPath: String?): FolderListing {
        val query = folderPath?.let { "?path=${encode(it)}" }.orEmpty()
        return get("/api/apps/project-app/projects/${encode(projectId)}/list$query") { json.decodeFromString(FolderListing.serializer(), it) }
    }

    /** Throws ApiException with code BINARY_FILE (415) for files that aren't text. */
    suspend fun projectFile(projectId: String, filePath: String): ProjectFile =
        get("/api/apps/project-app/projects/${encode(projectId)}/file?path=${encode(filePath)}") {
            json.decodeFromString(ProjectFile.serializer(), it)
        }

    /** Throws ApiException with code FILE_CHANGED (409) if the file changed since [expectedModified]. */
    suspend fun saveProjectFile(projectId: String, filePath: String, content: String, expectedModified: Double?): SavedFile {
        val body = json.encodeToString(SaveFileRequest.serializer(), SaveFileRequest(filePath, content, expectedModified))
        return send("PUT", "/api/apps/project-app/projects/${encode(projectId)}/file", body) { json.decodeFromString(SavedFile.serializer(), it) }
    }

    suspend fun createProjectEntry(projectId: String, parentPath: String, name: String, type: String): CreatedEntry {
        val body = json.encodeToString(CreateEntryRequest.serializer(), CreateEntryRequest(parentPath, name, type))
        return send("POST", "/api/apps/project-app/projects/${encode(projectId)}/entries", body) { json.decodeFromString(CreatedEntry.serializer(), it) }
    }

    /** Unpairs this device on the PC (Settings > Sign out). */
    suspend fun signOutDevice() {
        send("DELETE", "/api/devices/self", null) { }
    }

    fun authorizedRequest(session: Session, path: String): Request.Builder =
        Request.Builder()
            .url(session.baseUrl + path)
            .header("Authorization", "Bearer ${session.token}")

    /**
     * [slow]: for calls the PC may take minutes on (archive searches, news
     * fetches). [allowError]: parse the body even on a 4xx (the Wikipedia
     * archive answers "not found" as JSON with an `error` field).
     */
    private suspend fun <T> get(path: String, slow: Boolean = false, allowError: Boolean = false, parse: (String) -> T): T {
        val session = requireSession()
        return execute(authorizedRequest(session, path).get().build(), authenticated = true, if (slow) slowHttp else http, allowError, parse)
    }

    private suspend fun <T> send(method: String, path: String, body: String?, parse: (String) -> T): T {
        val session = requireSession()
        val requestBody = (body ?: "").toRequestBody(JSON_TYPE)
        val request = authorizedRequest(session, path).method(method, if (method == "DELETE" && body == null) null else requestBody).build()
        return execute(request, authenticated = true, parse = parse)
    }

    private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

    private fun requireSession(): Session =
        sessionStore.currentSession() ?: throw ApiException(401, "NOT_PAIRED", "This phone isn't paired.")

    private suspend fun <T> execute(
        request: Request,
        authenticated: Boolean,
        client: OkHttpClient = http,
        allowError: Boolean = false,
        parse: (String) -> T
    ): T =
        withContext(Dispatchers.IO) {
            val response = try {
                client.newCall(request).execute()
            } catch (error: IOException) {
                throw ApiException(0, "NETWORK", "Can't reach the PC: ${error.message ?: "network error"}")
            }
            response.use {
                val text = it.body?.string().orEmpty()
                val parseAnyway = allowError && it.code in 400..499 && it.code != 401 && it.code != 403
                if (!it.isSuccessful && !parseAnyway) {
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
