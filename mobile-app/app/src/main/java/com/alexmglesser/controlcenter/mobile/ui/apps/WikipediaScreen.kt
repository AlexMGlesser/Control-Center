package com.alexmglesser.controlcenter.mobile.ui.apps

import android.app.Application
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.WikiArticle
import com.alexmglesser.controlcenter.mobile.data.api.WikiSearchResult
import com.alexmglesser.controlcenter.mobile.ui.components.AppTopBar
import com.alexmglesser.controlcenter.mobile.ui.components.NeonButton
import com.alexmglesser.controlcenter.mobile.ui.components.Note
import com.alexmglesser.controlcenter.mobile.ui.components.SectionLabel
import com.alexmglesser.controlcenter.mobile.ui.theme.ButtonShape
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** An article on screen; [section] is null for the opening text. */
data class WikiPage(val article: WikiArticle, val section: String? = null, val sections: List<String> = article.sections)

class WikipediaViewModel(application: Application) : AndroidViewModel(application) {
    private val api = application.appContainer.api

    var query by mutableStateOf("")
    var results by mutableStateOf<List<WikiSearchResult>>(emptyList())
        private set
    var totalMatches by mutableStateOf(0)
        private set

    /** Articles opened, newest last; Back pops one. */
    var pages by mutableStateOf<List<WikiPage>>(emptyList())
        private set
    var busy by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)
        private set
    private var job: Job? = null

    fun search() {
        val text = query.trim()
        if (text.isEmpty()) return
        run {
            val response = api.wikiSearch(text)
            results = response.results
            totalMatches = response.totalMatches
            message = response.error ?: if (response.results.isEmpty()) "No articles match \"$text\"." else null
        }
    }

    fun open(title: String, section: String? = null) {
        run {
            val article = api.wikiArticle(title, section)
            if (article.error != null) {
                message = article.error
                return@run
            }
            message = null
            val current = pages.lastOrNull()
            pages = if (current != null && current.article.title == article.title) {
                // Jumping between sections of one article replaces the page and
                // keeps the article's full contents list.
                pages.dropLast(1) + WikiPage(article, section, current.sections)
            } else {
                pages + WikiPage(article)
            }
        }
    }

    fun random() {
        run {
            val title = api.wikiRandom()
            if (title.isNotBlank()) {
                val article = api.wikiArticle(title)
                pages = pages + WikiPage(article)
            }
        }
    }

    fun back(): Boolean {
        if (busy) {
            job?.cancel()
            busy = false
            return true
        }
        if (pages.isEmpty()) return false
        pages = pages.dropLast(1)
        message = null
        return true
    }

    private fun run(block: suspend () -> Unit) {
        job?.cancel()
        job = viewModelScope.launch {
            busy = true
            message = null
            runCatching { block() }.onFailure { if (it !is kotlinx.coroutines.CancellationException) message = it.message }
            busy = false
        }
    }
}

@Composable
fun WikipediaScreen(onExit: () -> Unit, vm: WikipediaViewModel = viewModel()) {
    BackHandler { if (!vm.back()) onExit() }
    val page = vm.pages.lastOrNull()

    Column(Modifier.fillMaxSize()) {
        AppTopBar(page?.article?.title ?: "Wikipedia", onBack = { if (!vm.back()) onExit() }) {
            if (page == null) TextButton(onClick = vm::random, enabled = !vm.busy) { Text("Random", color = CC.cyan) }
        }
        if (vm.busy) SlowNote()
        vm.message?.let { Text(it, color = CC.warn, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        if (page != null) ArticleView(page, onOpen = { title, section -> vm.open(title, section) }) else SearchView(vm)
    }
}

/** The archive can be slow while the PC's hard drive spins up (design: note after 3 s). */
@Composable
private fun SlowNote() {
    var slow by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(3000)
        slow = true
    }
    Text(
        if (slow) "Searching the archive… (this can take up to a minute)" else "Loading…",
        color = CC.textSecondary,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
    )
}

@Composable
private fun SearchView(vm: WikipediaViewModel) {
    val keyboard = LocalSoftwareKeyboardController.current
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = vm.query,
            onValueChange = { vm.query = it },
            placeholder = { Text("Search the offline Wikipedia") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = {
                keyboard?.hide()
                vm.search()
            }),
            shape = ButtonShape,
            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = CC.cyan, unfocusedBorderColor = CC.line),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp)
        )
        if (vm.results.isEmpty()) {
            if (!vm.busy && vm.message == null) Note("Search for any article. Everything comes from the archive on your PC.")
            return
        }
        LazyColumn(
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.fillMaxSize()
        ) {
            item { Text("${vm.totalMatches} matches", color = CC.textSecondary, style = MaterialTheme.typography.bodySmall) }
            items(vm.results, key = { it.title }) { result ->
                Column(
                    Modifier
                        .widthIn(max = 720.dp)
                        .fillMaxWidth()
                        .neonClickable(TileShape, onClick = { vm.open(result.title) })
                        .background(CC.bgPanel, TileShape)
                        .padding(14.dp)
                ) {
                    Text(result.title, color = CC.textPrimary, style = MaterialTheme.typography.titleMedium)
                    Text(result.snippet, color = CC.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ArticleView(page: WikiPage, onOpen: (String, String?) -> Unit) {
    var showContents by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    LaunchedEffect(page) { listState.scrollToItem(0) }
    val paragraphs = remember(page) { page.article.text.split(Regex("\n\\s*\n|\n")).map { it.trim() }.filter { it.isNotEmpty() } }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        LazyColumn(
            state = listState,
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.widthIn(max = 720.dp).fillMaxSize()
        ) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(page.section ?: "Introduction", color = CC.cyan, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                    if (page.sections.size > 1) NeonButton("Contents", onClick = { showContents = true })
                }
            }
            items(paragraphs.size) { index ->
                SelectionContainer {
                    Text(paragraphs[index], color = CC.textPrimary, style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 26.sp))
                }
            }
            if (page.article.truncated) {
                item { Text("The rest is in the sections: open Contents.", color = CC.textSecondary, style = MaterialTheme.typography.bodySmall) }
            }
            if (page.article.linksTo.isNotEmpty()) {
                item { SectionLabel("Linked articles") }
                item {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        page.article.linksTo.take(40).forEach { title ->
                            Text(
                                title,
                                color = CC.textPrimary,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier
                                    .neonClickable(ButtonShape, onClick = { onOpen(title, null) })
                                    .padding(horizontal = 10.dp, vertical = 8.dp)
                            )
                        }
                    }
                }
            }
        }
    }

    if (showContents) {
        AlertDialog(
            onDismissRequest = { showContents = false },
            title = { Text("Contents") },
            text = {
                Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                    page.sections.forEachIndexed { index, name ->
                        val current = name == (page.section ?: "Introduction") || (index == 0 && page.section == null)
                        TextButton(onClick = {
                            showContents = false
                            onOpen(page.article.title, if (index == 0) null else name)
                        }) {
                            Text(name, color = if (current) CC.cyan else CC.textPrimary, modifier = Modifier.fillMaxWidth())
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showContents = false }) { Text("Close") } },
            shape = TileShape,
            containerColor = CC.bgPanel
        )
    }
}
