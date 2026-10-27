package com.alexmglesser.controlcenter.mobile.ui.apps

import android.app.Application
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.NewsBriefing
import com.alexmglesser.controlcenter.mobile.data.api.NewsStory
import com.alexmglesser.controlcenter.mobile.data.api.Weather
import com.alexmglesser.controlcenter.mobile.ui.components.AppTopBar
import com.alexmglesser.controlcenter.mobile.ui.components.Note
import com.alexmglesser.controlcenter.mobile.ui.components.SectionLabel
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.roundToInt

class NewsViewModel(application: Application) : AndroidViewModel(application) {
    private val api = application.appContainer.api

    var briefing by mutableStateOf<NewsBriefing?>(null)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    init {
        refresh()
    }

    fun refresh() {
        if (refreshing) return
        viewModelScope.launch {
            refreshing = true
            runCatching { api.newsBriefing() }
                .onSuccess {
                    briefing = it
                    error = null
                }
                .onFailure { error = it.message }
            refreshing = false
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewsScreen(onExit: () -> Unit, vm: NewsViewModel = viewModel()) {
    BackHandler { onExit() }
    val context = LocalContext.current
    val open: (String) -> Unit = { link ->
        if (link.isNotBlank()) runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, link.toUri())) }
    }
    val briefing = vm.briefing

    Column(Modifier.fillMaxSize()) {
        AppTopBar("News", onBack = onExit)
        PullToRefreshBox(isRefreshing = vm.refreshing, onRefresh = vm::refresh, modifier = Modifier.fillMaxSize()) {
            if (briefing == null) {
                Box(Modifier.fillMaxSize()) {
                    Note(if (vm.refreshing) "Fetching today's briefing…" else vm.error ?: "No briefing yet.")
                }
                return@PullToRefreshBox
            }
            LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxSize()
            ) {
                item {
                    Text(
                        listOfNotNull(refreshedLabel(briefing.fetchedAt), vm.error?.let { "Couldn't refresh: $it" }).joinToString(" · "),
                        color = CC.textSecondary,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
                briefing.weather?.takeIf { it.ok }?.let { weather -> item { WeatherCard(weather) } }
                section("Headlines", briefing.headlines.take(6), open)
                section("Technology", briefing.technology.take(5), open)
                briefing.stemFeature?.takeIf { it.title.isNotBlank() }?.let { stem -> section("Science", listOf(stem), open) }
                section("More stories", briefing.moreStories.take(6), open)
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.section(title: String, stories: List<NewsStory>, open: (String) -> Unit) {
    if (stories.isEmpty()) return
    item(key = "label-$title") { SectionLabel(title) }
    items(stories, key = { "$title-${it.link}-${it.title}" }) { story -> StoryCard(story) { open(story.link) } }
}

@Composable
private fun WeatherCard(weather: Weather) {
    val current = weather.current
    Column(
        Modifier
            .widthIn(max = 640.dp)
            .fillMaxWidth()
            .background(CC.bgPanel, TileShape)
            .padding(16.dp)
    ) {
        Text(weather.location.substringBefore(","), color = CC.textSecondary, style = MaterialTheme.typography.bodySmall)
        if (current != null) {
            Row(verticalAlignment = Alignment.Bottom) {
                Text(fahrenheit(current.temperatureC), color = CC.textPrimary, style = MaterialTheme.typography.headlineSmall)
                Text("  ${current.label}", color = CC.textPrimary, modifier = Modifier.padding(bottom = 3.dp))
            }
            Text(
                "Feels like ${fahrenheit(current.apparentTemperatureC)} · Wind ${current.windSpeedKph?.let { (it * 0.621371).roundToInt() } ?: "?"} mph",
                color = CC.textSecondary,
                style = MaterialTheme.typography.bodySmall
            )
        }
        weather.forecast.forEach { day ->
            Row(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                Text(day.day, color = CC.textPrimary, modifier = Modifier.weight(1f))
                Text(day.label, color = CC.textSecondary, modifier = Modifier.weight(1.4f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                day.precipitationChance?.let { Text("${it.roundToInt()}%  ", color = CC.cyan) }
                Text("${fahrenheit(day.maxC)} / ${fahrenheit(day.minC)}", color = CC.textPrimary)
            }
        }
    }
}

@Composable
private fun StoryCard(story: NewsStory, onClick: () -> Unit) {
    Column(
        Modifier
            .widthIn(max = 640.dp)
            .fillMaxWidth()
            .neonClickable(TileShape, onClick = onClick)
            .background(CC.bgPanel, TileShape)
            .padding(16.dp)
    ) {
        Text(story.title, color = CC.textPrimary, style = MaterialTheme.typography.titleMedium)
        if (story.summary.isNotBlank()) {
            Text(story.summary, color = CC.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
        }
        if (story.source.isNotBlank()) Text(story.source, color = CC.cyan, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 6.dp))
    }
}

private fun fahrenheit(celsius: Double?): String = celsius?.let { "${(it * 9 / 5 + 32).roundToInt()}°" } ?: "–"

private fun refreshedLabel(iso: String): String? = runCatching {
    "Refreshed " + Instant.parse(iso).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT))
}.getOrNull()
