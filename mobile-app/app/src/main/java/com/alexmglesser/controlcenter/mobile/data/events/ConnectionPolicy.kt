package com.alexmglesser.controlcenter.mobile.data.events

/** Connection to the PC's event stream, as the UI and notifications see it. */
sealed interface ConnectionState {
    data object Idle : ConnectionState
    data object Connecting : ConnectionState
    data class Connected(val since: Long) : ConnectionState
    data class Reconnecting(val failingSince: Long, val attempt: Int) : ConnectionState
    data class Disconnected(val since: Long, val cause: DisconnectCause) : ConnectionState
    data object Unauthorized : ConnectionState
}

/** Why the PC can't be reached, checked in this order (architecture 7.2). */
enum class DisconnectCause {
    PHONE_OFFLINE,
    TAILSCALE_OFF,
    SERVER_STOPPED,
    PC_UNREACHABLE,
    CONTROL_CENTER_DOWN,
    UNKNOWN;

    fun describe(serverName: String): String = when (this) {
        PHONE_OFFLINE -> "Your phone is offline."
        TAILSCALE_OFF -> "Tailscale is off on your phone."
        SERVER_STOPPED -> "Control Center was shut down on the PC."
        PC_UNREACHABLE -> "Can't reach $serverName. It may be asleep or off."
        CONTROL_CENTER_DOWN -> "Control Center isn't running on the PC."
        UNKNOWN -> "Can't connect to $serverName."
    }
}

/** Timing rules for reconnecting. Pure, so it can be unit tested. */
object ReconnectPolicy {
    /** No data (not even a heartbeat) for this long means the stream is dead. */
    const val HEARTBEAT_TIMEOUT_MS = 45_000L

    /** Failures shorter than this are a blip: no alert. */
    const val GRACE_MS = 60_000L

    private val BACKOFF_SECONDS = listOf(1L, 2L, 5L, 10L, 30L)
    private const val STEADY_RETRY_SECONDS = 60L

    fun delayMs(attempt: Int): Long = (BACKOFF_SECONDS.getOrNull(attempt) ?: STEADY_RETRY_SECONDS) * 1000

    fun isOutage(failingSince: Long, now: Long): Boolean = now - failingSince >= GRACE_MS
}

/**
 * Turns connection states into alert decisions: exactly one "lost" alert per
 * outage and one "reconnected" notice when it ends. Pure, for unit tests.
 */
class OutageNotifier {
    sealed interface Action {
        data class Lost(val cause: DisconnectCause) : Action
        data object Reconnected : Action
    }

    private var alerted = false

    fun onState(state: ConnectionState): Action? = when (state) {
        is ConnectionState.Disconnected -> if (alerted) null else {
            alerted = true
            Action.Lost(state.cause)
        }
        is ConnectionState.Connected -> if (alerted) {
            alerted = false
            Action.Reconnected
        } else null
        is ConnectionState.Idle, is ConnectionState.Unauthorized -> {
            alerted = false
            null
        }
        else -> null
    }
}
