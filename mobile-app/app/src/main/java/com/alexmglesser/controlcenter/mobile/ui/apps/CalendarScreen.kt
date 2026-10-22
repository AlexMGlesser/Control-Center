package com.alexmglesser.controlcenter.mobile.ui.apps

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.text.format.DateFormat as AndroidDateFormat
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.alexmglesser.controlcenter.mobile.data.api.CalendarEvent
import com.alexmglesser.controlcenter.mobile.ui.components.AppTopBar
import com.alexmglesser.controlcenter.mobile.ui.components.NeonButton
import com.alexmglesser.controlcenter.mobile.ui.components.Note
import com.alexmglesser.controlcenter.mobile.ui.theme.ButtonShape
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable
import kotlinx.coroutines.delay
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@Composable
fun CalendarScreen(onExit: () -> Unit, vm: CalendarViewModel = viewModel()) {
    var creating by remember { mutableStateOf(false) }
    BackHandler { onExit() }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            AppTopBar("Calendar", onBack = onExit) {
                ModeChip("Agenda", active = !vm.showMonth) { vm.showMonth = false }
                Spacer(Modifier.width(6.dp))
                ModeChip("Month", active = vm.showMonth) { vm.showMonth = true }
                Spacer(Modifier.width(8.dp))
            }
            if (vm.showMonth) MonthView(vm) else AgendaView(vm)
        }

        NeonButton(
            "+  New event",
            onClick = {
                vm.message = null
                creating = true
            },
            primary = true,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(20.dp)
                .background(CC.bgPrimary, ButtonShape)
        )

        Column(Modifier.align(Alignment.BottomStart).fillMaxWidth()) {
            vm.pendingDelete?.let { event ->
                UndoBar("Deleted ${event.title}", onUndo = vm::undoDelete)
            }
            vm.message?.let { text ->
                LaunchedEffect(text) {
                    delay(4000)
                    if (vm.message == text) vm.message = null
                }
                if (!creating) UndoBar(text, onUndo = null)
            }
        }
    }

    if (creating) NewEventDialog(onDismiss = { creating = false }, onCreate = { title, date, start, end ->
        vm.create(title, date, start, end) { creating = false }
    }, error = vm.message)
}

@Composable
private fun ModeChip(label: String, active: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) CC.cyan else CC.textSecondary,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier
            .neonClickable(ButtonShape, restBorder = if (active) CC.cyan else CC.line, active = active, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp)
    )
}

/* ------------------------------------------------------------------ */
/* Agenda                                                              */
/* ------------------------------------------------------------------ */

@Composable
private fun AgendaView(vm: CalendarViewModel) {
    val events = vm.visibleAgenda()
    if (events.isEmpty()) {
        Note(if (vm.loading) "Loading…" else vm.message ?: "Nothing in the next two weeks.")
        return
    }
    val today = LocalDate.now()
    val grouped = events.groupBy { vm.localDate(it) }.toSortedMap()
    LazyColumn(
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxSize()
    ) {
        grouped.forEach { (date, dayEvents) ->
            item(key = "day-$date") {
                Text(
                    dayLabel(date, today),
                    color = CC.cyan,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.padding(top = 14.dp, bottom = 2.dp)
                )
            }
            items(dayEvents, key = { it.id }) { event -> SwipeableEvent(event, onDelete = { vm.delete(event) }) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeableEvent(event: CalendarEvent, onDelete: () -> Unit) {
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) onDelete()
            value == SwipeToDismissBoxValue.EndToStart
        }
    )
    SwipeToDismissBox(
        state = state,
        enableDismissFromStartToEnd = false,
        backgroundContent = {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(CC.red.copy(alpha = 0.25f), TileShape)
                    .padding(horizontal = 20.dp),
                contentAlignment = Alignment.CenterEnd
            ) { Text("Delete", color = CC.red, fontWeight = FontWeight.SemiBold) }
        }
    ) {
        EventCard(event)
    }
}

@Composable
private fun EventCard(event: CalendarEvent) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(CC.bgPanel, TileShape)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.width(92.dp)) {
            Text(event.startLabel, color = CC.textPrimary, style = MaterialTheme.typography.labelLarge)
            Text(event.endLabel, color = CC.textSecondary, style = MaterialTheme.typography.bodySmall)
        }
        Column(Modifier.weight(1f)) {
            Text(event.title, color = CC.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val details = listOfNotNull(duration(event), event.location.takeIf { it.isNotBlank() }).joinToString(" · ")
            if (details.isNotEmpty()) Text(details, color = CC.textSecondary, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun UndoBar(text: String, onUndo: (() -> Unit)?) {
    Row(
        Modifier
            .padding(16.dp)
            .widthIn(max = 520.dp)
            .fillMaxWidth()
            .background(CC.bgPanelSoft, TileShape)
            .padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text, color = CC.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(vertical = 12.dp))
        if (onUndo != null) TextButton(onClick = onUndo) { Text("Undo", color = CC.cyan, fontWeight = FontWeight.SemiBold) }
    }
}

/* ------------------------------------------------------------------ */
/* Month                                                               */
/* ------------------------------------------------------------------ */

@Composable
private fun MonthView(vm: CalendarViewModel) {
    val month = vm.month
    LazyColumn(contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 96.dp), modifier = Modifier.fillMaxSize()) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                TextButton(onClick = { vm.moveMonth(-1) }) { Text("‹", color = CC.cyan, style = MaterialTheme.typography.titleLarge) }
                Text(
                    month?.monthLabel ?: "",
                    color = CC.textPrimary,
                    style = MaterialTheme.typography.titleMedium,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f)
                )
                TextButton(onClick = { vm.moveMonth(1) }) { Text("›", color = CC.cyan, style = MaterialTheme.typography.titleLarge) }
            }
            Row(Modifier.fillMaxWidth()) {
                listOf("S", "M", "T", "W", "T", "F", "S").forEach {
                    Text(it, color = CC.textSecondary, style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
                }
            }
            Spacer(Modifier.height(4.dp))
            month?.days?.chunked(7)?.forEach { week ->
                Row(Modifier.fillMaxWidth()) {
                    week.forEach { day ->
                        val selected = day.date == vm.selectedDay
                        Column(
                            Modifier
                                .weight(1f)
                                .aspectRatio(1f)
                                .padding(2.dp)
                                .neonClickable(
                                    ButtonShape,
                                    restBorder = if (day.isToday) CC.cyan.copy(alpha = 0.6f) else CC.line.copy(alpha = 0f),
                                    active = selected,
                                    onClick = { vm.selectedDay = day.date }
                                )
                                .background(if (selected) CC.cyan.copy(alpha = 0.12f) else CC.bgPanel.copy(alpha = if (day.inMonth) 1f else 0.4f)),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center
                        ) {
                            Text(
                                day.dayNumber.toString(),
                                color = when {
                                    !day.inMonth -> CC.textSecondary.copy(alpha = 0.5f)
                                    day.isToday -> CC.cyan
                                    else -> CC.textPrimary
                                }
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(3.dp), modifier = Modifier.height(8.dp).padding(top = 3.dp)) {
                                repeat(day.eventCount.coerceAtMost(3)) {
                                    Box(Modifier.size(5.dp).background(CC.magenta, CircleShape))
                                }
                            }
                        }
                    }
                }
            }
            Text(
                runCatching { dayLabel(LocalDate.parse(vm.selectedDay), LocalDate.now()) }.getOrDefault(vm.selectedDay),
                color = CC.cyan,
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.padding(start = 4.dp, top = 16.dp, bottom = 6.dp)
            )
        }
        val dayEvents = vm.eventsOn(vm.selectedDay)
        if (dayEvents.isEmpty()) {
            item { Text("Nothing on this day.", color = CC.textSecondary, modifier = Modifier.padding(4.dp)) }
        }
        items(dayEvents, key = { it.id }) { event ->
            Box(Modifier.padding(vertical = 4.dp)) { SwipeableEvent(event, onDelete = { vm.delete(event) }) }
        }
    }
}

/* ------------------------------------------------------------------ */
/* New event                                                           */
/* ------------------------------------------------------------------ */

@Composable
private fun NewEventDialog(onDismiss: () -> Unit, onCreate: (String, LocalDate, LocalTime, LocalTime?) -> Unit, error: String?) {
    val context = LocalContext.current
    val is24 = AndroidDateFormat.is24HourFormat(context)
    var title by remember { mutableStateOf("") }
    var date by remember { mutableStateOf(LocalDate.now()) }
    var start by remember { mutableStateOf(LocalTime.now().plusHours(1).withMinute(0).withSecond(0).withNano(0)) }
    var end by remember { mutableStateOf<LocalTime?>(null) }
    val timeFormat = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New event") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Title") }, singleLine = true)
                PickerRow("Date", date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))) {
                    DatePickerDialog(context, { _, y, m, d -> date = LocalDate.of(y, m + 1, d) }, date.year, date.monthValue - 1, date.dayOfMonth).show()
                }
                PickerRow("Starts", start.format(timeFormat)) {
                    TimePickerDialog(context, { _, h, min -> start = LocalTime.of(h, min) }, start.hour, start.minute, is24).show()
                }
                PickerRow("Ends", end?.format(timeFormat) ?: "1 hour later") {
                    val initial = end ?: start.plusHours(1)
                    TimePickerDialog(context, { _, h, min -> end = LocalTime.of(h, min) }, initial.hour, initial.minute, is24).show()
                }
                if (error != null) Text(error, color = CC.red, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = { TextButton(onClick = { onCreate(title, date, start, end) }, enabled = title.isNotBlank()) { Text("Add") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        shape = TileShape,
        containerColor = CC.bgPanel
    )
}

@Composable
private fun PickerRow(label: String, value: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .neonClickable(ButtonShape, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, color = CC.textSecondary, modifier = Modifier.weight(1f))
        Text(value, color = CC.textPrimary)
    }
}

private fun dayLabel(date: LocalDate, today: LocalDate): String = when (date) {
    today -> "Today"
    today.plusDays(1) -> "Tomorrow"
    else -> date.format(DateTimeFormatter.ofPattern("EEE, MMM d"))
}

private fun duration(event: CalendarEvent): String? {
    val minutes = runCatching { Duration.between(Instant.parse(event.startAt), Instant.parse(event.endAt)).toMinutes() }.getOrNull() ?: return null
    if (minutes <= 0) return null
    val hours = minutes / 60
    val rest = minutes % 60
    return when {
        hours == 0L -> "$rest min"
        rest == 0L -> "$hours h"
        else -> "$hours h $rest min"
    }
}
