package com.alexmglesser.controlcenter.mobile.ui.apps

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.CalendarEvent
import com.alexmglesser.controlcenter.mobile.data.api.CalendarMonth
import com.alexmglesser.controlcenter.mobile.data.api.CreateEventRequest
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.YearMonth
import java.time.ZoneId
import java.time.ZonedDateTime

/** The phone's Calendar (design: agenda by default, month grid on a toggle). */
class CalendarViewModel(application: Application) : AndroidViewModel(application) {
    private val container = application.appContainer
    private val api = container.api
    private val zone: ZoneId get() = ZoneId.systemDefault()

    var showMonth by mutableStateOf(false)
    var agenda by mutableStateOf<List<CalendarEvent>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)

    var visibleMonth by mutableStateOf(YearMonth.now())
        private set
    var month by mutableStateOf<CalendarMonth?>(null)
        private set
    var selectedDay by mutableStateOf(LocalDate.now().toString())

    /** Swiped away, waiting 5 seconds for Undo before it's deleted on the PC. */
    var pendingDelete by mutableStateOf<CalendarEvent?>(null)
        private set
    private var deleteJob: Job? = null

    init {
        refresh()
        viewModelScope.launch {
            container.connection.events.collect { event ->
                if (event.appId == "calendar-app" && event.type == "data-changed") refresh()
            }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            loading = true
            val todayStart = LocalDate.now().atStartOfDay(zone).toInstant()
            val end = todayStart.plusMillis(15L * 24 * 60 * 60 * 1000)
            runCatching { api.calendarEvents(todayStart.toString(), end.toString()) }
                .onSuccess { agenda = it }
                .onFailure { message = it.message }
            loadMonth()
            loading = false
        }
    }

    fun moveMonth(by: Long) {
        visibleMonth = visibleMonth.plusMonths(by)
        viewModelScope.launch { loadMonth() }
    }

    private suspend fun loadMonth() {
        val target = visibleMonth
        runCatching { api.calendarMonth(target.year, target.monthValue) }
            .onSuccess { if (visibleMonth == target) month = it }
            .onFailure { message = it.message }
    }

    fun visibleAgenda(): List<CalendarEvent> = agenda.filter { it.id != pendingDelete?.id }

    fun eventsOn(day: String): List<CalendarEvent> =
        month?.days?.firstOrNull { it.date == day }?.events.orEmpty().filter { it.id != pendingDelete?.id }

    /** Swipe left: hide now, delete on the PC after 5 seconds unless Undo is tapped. */
    fun delete(event: CalendarEvent) {
        commitPendingDelete()
        pendingDelete = event
        deleteJob = viewModelScope.launch {
            delay(5_000)
            runDelete(event)
        }
    }

    fun undoDelete() {
        deleteJob?.cancel()
        deleteJob = null
        pendingDelete = null
    }

    /** A second swipe (or leaving the screen) shouldn't wait for the first one's timer. */
    private fun commitPendingDelete() {
        val event = pendingDelete ?: return
        deleteJob?.cancel()
        viewModelScope.launch { runDelete(event) }
    }

    private suspend fun runDelete(event: CalendarEvent) {
        runCatching { api.deleteCalendarEvent(event.id) }
            .onSuccess { agenda = agenda.filter { it.id != event.id } }
            .onFailure { message = "Couldn't delete ${event.title}: ${it.message}" }
        if (pendingDelete?.id == event.id) pendingDelete = null
        loadMonth()
    }

    fun create(title: String, date: LocalDate, start: LocalTime, end: LocalTime?, onDone: () -> Unit) {
        val startAt = ZonedDateTime.of(date, start, zone)
        // An end before the start means it runs past midnight.
        val endAt = end?.let { ZonedDateTime.of(date, it, zone) }?.let { if (it.isAfter(startAt)) it else it.plusDays(1) }
        viewModelScope.launch {
            runCatching {
                api.createCalendarEvent(
                    CreateEventRequest(title.trim(), startAt.toOffsetDateTime().toString(), endAt?.toOffsetDateTime()?.toString())
                )
            }
                .onSuccess {
                    message = "Added ${title.trim()}."
                    onDone()
                    refresh()
                }
                .onFailure { message = it.message }
        }
    }

    override fun onCleared() {
        pendingDelete?.let { event ->
            // Swiped away just before the app closed: still delete it.
            container.appScope.launch { runCatching { api.deleteCalendarEvent(event.id) } }
        }
        super.onCleared()
    }

    fun localDate(event: CalendarEvent): LocalDate =
        runCatching { Instant.parse(event.startAt).atZone(zone).toLocalDate() }.getOrDefault(LocalDate.now())
}
