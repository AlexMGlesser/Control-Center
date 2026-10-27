package com.alexmglesser.controlcenter.mobile.ui.projects

import android.graphics.Paint
import android.graphics.Typeface
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.data.api.FolderEntry
import com.alexmglesser.controlcenter.mobile.data.api.ProjectInfo
import com.alexmglesser.controlcenter.mobile.ui.components.NeonButton
import com.alexmglesser.controlcenter.mobile.ui.theme.ButtonShape
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable
import kotlinx.coroutines.delay

/** The phone's Projects app (merged personal + work): browse, read, write scripts. */
@Composable
fun ProjectsScreen(onExit: () -> Unit, vm: ProjectsViewModel = viewModel()) {
    // An action waiting on "Discard unsaved changes?".
    var pendingDiscard by remember { mutableStateOf<(() -> Unit)?>(null) }
    var newEntryType by remember { mutableStateOf<String?>(null) }

    val guarded: (() -> Unit) -> Unit = { action -> if (vm.dirty) pendingDiscard = action else action() }
    val goBack = { guarded { if (!vm.back()) onExit() } }
    BackHandler { goBack() }

    val file = vm.file
    val project = vm.project
    Column(Modifier.fillMaxSize()) {
        Header(
            title = file?.name ?: project?.name ?: "Projects",
            dirty = vm.dirty,
            onBack = goBack,
            actions = {
                if (file != null && !file.binary && !file.truncated) {
                    NeonButton(
                        text = if (vm.saving) "Saving…" else "Save",
                        onClick = { vm.save() },
                        primary = true,
                        enabled = vm.dirty && !vm.saving,
                        modifier = Modifier.padding(end = 8.dp)
                    )
                }
            }
        )
        Box(Modifier.weight(1f)) {
            when {
                file != null -> EditorView(vm)
                project != null -> FolderView(vm, onNew = { newEntryType = it })
                else -> ProjectListView(vm)
            }
        }
        StatusLine(vm)
    }

    pendingDiscard?.let { action ->
        AlertDialog(
            onDismissRequest = { pendingDiscard = null },
            title = { Text("Discard changes?") },
            text = { Text("${vm.file?.name ?: "This file"} has unsaved changes.") },
            confirmButton = {
                TextButton(onClick = {
                    pendingDiscard = null
                    // Every guarded action leaves the editor, which drops the edits.
                    action()
                }) { Text("Discard", color = CC.red) }
            },
            dismissButton = { TextButton(onClick = { pendingDiscard = null }) { Text("Keep editing") } },
            shape = TileShape,
            containerColor = CC.bgPanel
        )
    }

    newEntryType?.let { type ->
        NewEntryDialog(
            type = type,
            onDismiss = { newEntryType = null },
            onCreate = { name ->
                newEntryType = null
                vm.createEntry(name, type)
            }
        )
    }
}

@Composable
private fun Header(title: String, dirty: Boolean, onBack: () -> Unit, actions: @Composable () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(56.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        IconButton(onClick = onBack) {
            Icon(painterResource(R.drawable.ic_arrow_left), contentDescription = "Back", tint = CC.textPrimary)
        }
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            color = CC.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false)
        )
        if (dirty) Text("  ●", color = CC.cyan)
        Spacer(Modifier.weight(1f))
        actions()
    }
}

@Composable
private fun StatusLine(vm: ProjectsViewModel) {
    val message = vm.message ?: return
    LaunchedEffect(message) {
        delay(4000)
        if (vm.message == message) vm.message = null
    }
    Text(
        message,
        style = MaterialTheme.typography.bodySmall,
        color = CC.textSecondary,
        modifier = Modifier
            .fillMaxWidth()
            .background(CC.bgPanel)
            .padding(horizontal = 16.dp, vertical = 10.dp)
    )
}

/* ------------------------------------------------------------------ */
/* Project list                                                        */
/* ------------------------------------------------------------------ */

@Composable
private fun ProjectListView(vm: ProjectsViewModel) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            listOf("all" to "All", "personal" to "Personal", "work" to "Work").forEach { (value, label) ->
                Chip(label, active = vm.filter == value) { vm.filter = value }
            }
        }
        val projects = vm.visibleProjects
        if (projects.isEmpty()) {
            Text(
                if (vm.loading) "Loading…" else "No projects here. Add project folders from the Projects app on the PC.",
                color = CC.textSecondary,
                modifier = Modifier.padding(24.dp)
            )
        }
        LazyColumn(
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxSize()
        ) {
            items(projects, key = { it.id }) { project -> ProjectCard(project) { vm.openProject(project) } }
        }
    }
}

@Composable
private fun ProjectCard(project: ProjectInfo, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .neonClickable(TileShape, onClick = onClick)
            .background(CC.bgPanel, TileShape)
            .padding(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(project.name, style = MaterialTheme.typography.titleMedium, color = CC.textPrimary, modifier = Modifier.weight(1f))
            val work = project.category == "work"
            Text(
                if (work) "WORK" else "PERSONAL",
                style = MaterialTheme.typography.labelSmall,
                color = if (work) CC.warn else CC.textSecondary,
                modifier = Modifier
                    .border(1.dp, (if (work) CC.warn else CC.textSecondary).copy(alpha = 0.5f), ButtonShape)
                    .padding(horizontal = 8.dp, vertical = 2.dp)
            )
        }
        Text(project.path, style = MaterialTheme.typography.bodySmall, color = CC.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (project.missing) Text("Folder is missing", style = MaterialTheme.typography.bodySmall, color = CC.red)
    }
}

@Composable
private fun Chip(label: String, active: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) CC.cyan else CC.textPrimary,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier
            .neonClickable(ButtonShape, restBorder = if (active) CC.cyan else CC.line, active = active, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp)
    )
}

/* ------------------------------------------------------------------ */
/* Folder                                                              */
/* ------------------------------------------------------------------ */

@Composable
private fun FolderView(vm: ProjectsViewModel, onNew: (String) -> Unit) {
    val listing = vm.listing
    Column(Modifier.fillMaxSize()) {
        Text(
            listOfNotNull(vm.project?.name, listing?.relativePath?.takeIf { it.isNotEmpty() }).joinToString(" › ") { it.replace("\\", " › ") },
            style = MaterialTheme.typography.bodySmall,
            color = CC.cyan,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 16.dp)
        )
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            NeonButton("New file", onClick = { onNew("file") }, enabled = listing != null)
            NeonButton("New folder", onClick = { onNew("folder") }, enabled = listing != null)
            Spacer(Modifier.weight(1f))
            Checkbox(
                checked = vm.showHidden,
                onCheckedChange = { vm.showHidden = it },
                colors = CheckboxDefaults.colors(checkedColor = CC.cyan, uncheckedColor = CC.textSecondary, checkmarkColor = CC.bgPrimary)
            )
            Text("Hidden", color = CC.textSecondary, style = MaterialTheme.typography.bodySmall)
        }
        if (listing == null) {
            Text("Loading…", color = CC.textSecondary, modifier = Modifier.padding(24.dp))
            return
        }
        val entries = vm.visibleEntries
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
            if (entries.isEmpty()) {
                item { Text("This folder is empty.", color = CC.textSecondary, modifier = Modifier.padding(16.dp)) }
            }
            items(entries, key = { it.path }) { entry ->
                EntryRow(entry) { if (entry.type == "folder") vm.openFolder(entry.path) else vm.openFile(entry) }
            }
        }
    }
}

@Composable
private fun EntryRow(entry: FolderEntry, onClick: () -> Unit) {
    val folder = entry.type == "folder"
    Row(
        Modifier
            .fillMaxWidth()
            .neonClickable(ButtonShape, restBorder = CC.line.copy(alpha = 0f), onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(if (folder) "▸" else "◇", color = CC.cyan, modifier = Modifier.width(28.dp))
        Text(
            entry.name,
            color = if (entry.hidden) CC.textSecondary else CC.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
        if (!folder) Text(formatSize(entry.size), style = MaterialTheme.typography.bodySmall, color = CC.textSecondary)
    }
}

@Composable
private fun NewEntryDialog(type: String, onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (type == "folder") "New folder" else "New file") },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                singleLine = true,
                placeholder = { Text(if (type == "folder") "scripts" else "script.py") },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)
            )
        },
        confirmButton = { TextButton(onClick = { onCreate(name) }, enabled = name.isNotBlank()) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        shape = TileShape,
        containerColor = CC.bgPanel
    )
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

private val SYMBOLS = listOf("Tab", "(", ")", "{", "}", "[", "]", ":", ";", "=", "\"", "'", "#", "/", "\\", "<", ">", "-", "_", "$", "|", "&")

@Composable
private fun EditorView(vm: ProjectsViewModel) {
    val file = vm.file ?: return
    if (file.binary) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("This isn't a text file (${formatSize(file.size)}).", color = CC.textPrimary)
            Text("Open it from the File System app to view or download it.", color = CC.textSecondary, style = MaterialTheme.typography.bodySmall)
        }
        return
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        if (vm.conflict) {
            Banner("This file changed on the PC since you opened it.") {
                TextButton(onClick = vm::reloadFile) { Text("Reload", color = CC.cyan) }
                TextButton(onClick = { vm.save(force = true) }) { Text("Save anyway", color = CC.red) }
            }
        }
        if (file.truncated) {
            Banner("Only the first 512 KB is shown, so this file can't be saved from the phone.") {}
        }
        CodeEditor(
            value = vm.editor,
            onValueChange = vm::onEditorChange,
            readOnly = file.truncated,
            modifier = Modifier.weight(1f)
        )
        if (!file.truncated) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(CC.bgPanel)
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 6.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                SYMBOLS.forEach { symbol ->
                    Text(
                        symbol,
                        color = CC.textPrimary,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier
                            .neonClickable(ButtonShape, onClick = { vm.insert(if (symbol == "Tab") "    " else symbol) })
                            .padding(horizontal = 12.dp, vertical = 8.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun Banner(text: String, actions: @Composable () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(CC.red.copy(alpha = 0.16f))
            .padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text, color = CC.textPrimary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f).padding(vertical = 8.dp))
        actions()
    }
}

/**
 * Monospace editor with soft wrap and line numbers. The gutter numbers each
 * real line at its first visual row, and only draws the rows on screen.
 */
@Composable
private fun CodeEditor(value: TextFieldValue, onValueChange: (TextFieldValue) -> Unit, readOnly: Boolean, modifier: Modifier) {
    val density = LocalDensity.current
    val scroll = rememberScrollState()
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    var viewportHeight by remember { mutableIntStateOf(0) }
    val textStyle = remember { TextStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp, lineHeight = 20.sp, color = CC.textPrimary) }

    val lineStarts = remember(value.text) {
        buildList {
            add(0)
            value.text.forEachIndexed { index, char -> if (char == '\n') add(index + 1) }
        }
    }
    val paint = remember {
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = Typeface.MONOSPACE
            color = CC.textSecondary.copy(alpha = 0.55f).toArgb()
            textAlign = Paint.Align.RIGHT
        }
    }
    paint.textSize = with(density) { 12.sp.toPx() }
    val gutterWidth = with(density) { (paint.measureText("0".repeat(lineStarts.size.toString().length.coerceAtLeast(2))) + 20.dp.toPx()).toDp() }
    val topPadding = 10.dp

    Row(
        modifier
            .fillMaxWidth()
            .onSizeChanged { viewportHeight = it.height }
            .verticalScroll(scroll)
    ) {
        Box(
            Modifier
                .width(gutterWidth)
                .height(with(density) { (layout?.size?.height ?: 0).toDp() } + topPadding * 2)
                .drawBehind {
                    val result = layout ?: return@drawBehind
                    val offsetY = topPadding.toPx()
                    val visibleTop = scroll.value - offsetY
                    val visibleBottom = visibleTop + viewportHeight
                    val x = size.width - 10.dp.toPx()
                    val canvas = drawContext.canvas.nativeCanvas
                    lineStarts.forEachIndexed { index, start ->
                        val row = result.getLineForOffset(start.coerceAtMost(result.layoutInput.text.length))
                        val top = result.getLineTop(row)
                        if (top > visibleBottom) return@drawBehind
                        if (result.getLineBottom(row) >= visibleTop) {
                            canvas.drawText((index + 1).toString(), x, offsetY + result.getLineBaseline(row), paint)
                        }
                    }
                }
        )
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            readOnly = readOnly,
            textStyle = textStyle,
            cursorBrush = SolidColor(CC.cyan),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
            onTextLayout = { layout = it },
            modifier = Modifier
                .weight(1f)
                .padding(top = topPadding, bottom = topPadding, end = 12.dp)
        )
    }
}

private fun formatSize(bytes: Long?): String = when {
    bytes == null -> ""
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "%.1f KB".format(bytes / 1024.0)
    else -> "%.1f MB".format(bytes / 1024.0 / 1024.0)
}
