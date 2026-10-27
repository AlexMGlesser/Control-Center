package com.alexmglesser.controlcenter.mobile.data.events

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.SystemClock
import com.alexmglesser.controlcenter.mobile.data.Session
import com.alexmglesser.controlcenter.mobile.data.SessionStore
import com.alexmglesser.controlcenter.mobile.data.api.ApiClient
import com.alexmglesser.controlcenter.mobile.data.api.ServerEvent
import com.alexmglesser.controlcenter.mobile.data.api.StreamMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.coroutines.resume

/**
 * Owns the one live event stream to the PC for the whole app. The UI and the
 * background service both read [state] and [events] from here. Started and
 * stopped by ConnectionService, which keeps it alive in the background.
 */
class ConnectionManager(
    private val context: Context,
    private val sessionStore: SessionStore,
    private val api: ApiClient,
    private val scope: CoroutineScope
) {
    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
    val state: StateFlow<ConnectionState> = _state

    private val _events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<ServerEvent> = _events

    private var job: Job? = null
    private val retryNow = Channel<Unit>(Channel.CONFLATED)
    @Volatile private var lastDataAt = 0L
    @Volatile private var lastServerStoppingAt = 0L

    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            reconnectNow()
        }
    }
    private var callbackRegistered = false

    fun start() {
        if (job?.isActive == true) return
        if (!callbackRegistered) {
            runCatching { connectivity.registerDefaultNetworkCallback(networkCallback) }
            callbackRegistered = true
        }
        job = scope.launch(Dispatchers.IO) { runLoop() }
    }

    fun stop() {
        job?.cancel()
        job = null
        if (callbackRegistered) {
            runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
            callbackRegistered = false
        }
        _state.value = ConnectionState.Idle
    }

    /** Retry immediately instead of waiting out the backoff (Retry button, network back). */
    fun reconnectNow() {
        retryNow.trySend(Unit)
    }

    private fun now() = SystemClock.elapsedRealtime()

    private suspend fun runLoop() {
        var attempt = 0
        var failingSince = 0L
        while (currentCoroutineContext().isActive) {
            val session = sessionStore.currentSession() ?: run {
                _state.value = ConnectionState.Idle
                return
            }
            if (_state.value !is ConnectionState.Reconnecting && _state.value !is ConnectionState.Disconnected) {
                _state.value = ConnectionState.Connecting
            }

            when (val result = streamOnce(session)) {
                StreamResult.Unauthorized -> {
                    _state.value = ConnectionState.Unauthorized
                    sessionStore.markRemoved()
                    return
                }
                is StreamResult.Ended -> {
                    if (result.wasConnected || failingSince == 0L) {
                        failingSince = now()
                        attempt = 0
                    }
                }
            }

            if (_state.value !is ConnectionState.Disconnected) {
                _state.value = ConnectionState.Reconnecting(failingSince, attempt)
            }

            // Wait out the backoff, but declare an outage as soon as the
            // grace period passes, and retry at once if asked to.
            val waitUntil = now() + ReconnectPolicy.delayMs(attempt)
            attempt += 1
            while (now() < waitUntil) {
                if (_state.value !is ConnectionState.Disconnected && ReconnectPolicy.isOutage(failingSince, now())) {
                    _state.value = ConnectionState.Disconnected(now(), diagnose(session))
                }
                val retried = withTimeoutOrNull(minOf(1000L, waitUntil - now()).coerceAtLeast(1L)) { retryNow.receive() }
                if (retried != null) break
            }
        }
    }

    private sealed interface StreamResult {
        data object Unauthorized : StreamResult
        data class Ended(val wasConnected: Boolean) : StreamResult
    }

    /** Opens the stream and suspends until it ends, for whatever reason. */
    private suspend fun streamOnce(session: Session): StreamResult = suspendCancellableCoroutine { cont ->
        var connected = false
        var watchdog: Job? = null
        var source: EventSource? = null

        // The watchdog and OkHttp's callbacks run on different threads and can
        // both end the stream at once; only the first may resume. (Checking
        // cont.isActive first wasn't enough: two threads could both pass it,
        // and the second resume crashed the app.)
        val finished = AtomicBoolean(false)
        fun finish(result: StreamResult) {
            if (!finished.compareAndSet(false, true)) return
            watchdog?.cancel()
            source?.cancel()
            cont.resume(result)
        }

        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                connected = true
                lastDataAt = now()
                _state.value = ConnectionState.Connected(System.currentTimeMillis())
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                lastDataAt = now()
                if (type == "ping") return
                val message = runCatching { api.json.decodeFromString(StreamMessage.serializer(), data) }.getOrNull() ?: return
                // "snapshot" is recent history; only live events matter here.
                val event = message.event?.takeIf { message.type == "event" } ?: return
                if (event.type == "server-stopping") {
                    lastServerStoppingAt = now()
                }
                _events.tryEmit(event)
            }

            override fun onClosed(eventSource: EventSource) = finish(StreamResult.Ended(connected))

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                finish(if (response?.code == 401) StreamResult.Unauthorized else StreamResult.Ended(connected))
            }
        }

        val request = api.authorizedRequest(session, "/api/events/stream")
            .header("Accept", "text/event-stream")
            .build()
        source = EventSources.createFactory(api.streamHttp).newEventSource(request, listener)

        // A stream that goes quiet past the heartbeat interval is dead even if
        // the socket hasn't noticed yet (e.g. the PC lost power). One that
        // never opens (stuck connecting or queued) is given up on too, so the
        // retry loop can't wait forever.
        val startedAt = now()
        watchdog = scope.launch {
            while (isActive) {
                delay(5_000)
                if (connected && now() - lastDataAt > ReconnectPolicy.HEARTBEAT_TIMEOUT_MS) {
                    finish(StreamResult.Ended(true))
                    break
                }
                if (!connected && now() - startedAt > ReconnectPolicy.OPEN_TIMEOUT_MS) {
                    finish(StreamResult.Ended(false))
                    break
                }
            }
        }

        cont.invokeOnCancellation {
            watchdog?.cancel()
            source?.cancel()
        }
    }

    /** Works out why the PC can't be reached (architecture 7.2). */
    private suspend fun diagnose(session: Session): DisconnectCause = withContext(Dispatchers.IO) {
        if (now() - lastServerStoppingAt < ReconnectPolicy.GRACE_MS * 2 && lastServerStoppingAt != 0L) {
            return@withContext DisconnectCause.SERVER_STOPPED
        }

        val networks = runCatching { connectivity.allNetworks.mapNotNull { connectivity.getNetworkCapabilities(it) } }
            .getOrDefault(emptyList())
        val hasInternet = networks.any {
            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                it.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) &&
                !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        }
        if (!hasInternet) return@withContext DisconnectCause.PHONE_OFFLINE

        val url = session.baseUrl.toHttpUrlOrNull() ?: return@withContext DisconnectCause.UNKNOWN
        val viaTailscale = url.host.endsWith(".ts.net") || url.host.startsWith("100.")
        val vpnActive = networks.any { it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) }
        if (viaTailscale && !vpnActive) return@withContext DisconnectCause.TAILSCALE_OFF

        val reachable = runCatching {
            Socket().use { socket -> socket.connect(InetSocketAddress(url.host, url.port), 4_000) }
        }.isSuccess
        if (!reachable) return@withContext DisconnectCause.PC_UNREACHABLE

        if (!api.health(session.baseUrl)) DisconnectCause.CONTROL_CENTER_DOWN else DisconnectCause.UNKNOWN
    }
}
