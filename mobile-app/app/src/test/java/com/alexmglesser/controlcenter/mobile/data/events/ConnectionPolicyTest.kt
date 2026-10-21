package com.alexmglesser.controlcenter.mobile.data.events

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionPolicyTest {
    @Test
    fun backoffSteps_thenSteadyEveryMinute() {
        assertEquals(listOf(1_000L, 2_000L, 5_000L, 10_000L, 30_000L, 60_000L, 60_000L), (0..6).map(ReconnectPolicy::delayMs))
    }

    @Test
    fun blipsUnderAMinuteAreNotAnOutage() {
        assertFalse(ReconnectPolicy.isOutage(failingSince = 0, now = 59_999))
        assertTrue(ReconnectPolicy.isOutage(failingSince = 0, now = 60_000))
    }

    @Test
    fun exactlyOneLostAlertPerOutage_andReconnectedWhenItEnds() {
        val notifier = OutageNotifier()
        assertNull(notifier.onState(ConnectionState.Connected(0)))
        assertNull(notifier.onState(ConnectionState.Reconnecting(0, 0)))
        assertEquals(
            OutageNotifier.Action.Lost(DisconnectCause.PC_UNREACHABLE),
            notifier.onState(ConnectionState.Disconnected(1, DisconnectCause.PC_UNREACHABLE))
        )
        // Further retries during the same outage stay quiet.
        assertNull(notifier.onState(ConnectionState.Disconnected(2, DisconnectCause.PC_UNREACHABLE)))
        assertNull(notifier.onState(ConnectionState.Reconnecting(0, 5)))
        assertEquals(OutageNotifier.Action.Reconnected, notifier.onState(ConnectionState.Connected(3)))
        assertNull(notifier.onState(ConnectionState.Connected(4)))
    }

    @Test
    fun aBlipThatRecoversSendsNothing() {
        val notifier = OutageNotifier()
        notifier.onState(ConnectionState.Connected(0))
        assertNull(notifier.onState(ConnectionState.Reconnecting(0, 0)))
        assertNull(notifier.onState(ConnectionState.Connected(1)))
    }

    @Test
    fun causeMessagesNameThePc() {
        assertEquals("Can't reach alex-desktop. It may be asleep or off.", DisconnectCause.PC_UNREACHABLE.describe("alex-desktop"))
    }
}
