package com.alexmglesser.controlcenter.mobile.ui.ide

import android.graphics.Paint
import android.graphics.Typeface
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.data.api.FolderEntry
import com.alexmglesser.controlcenter.mobile.ui.components.INDENT
import com.alexmglesser.controlcenter.mobile.ui.isWideLayout
import kotlinx.coroutines.delay

private val Mono = FontFamily.Monospace
private val SmallShape = RoundedCornerShape(4.dp)
private val AI_TAB_WIDTH = 40.dp

/**
 * The phone's IDE (phone only): VS Code's look, an explorer over the PC's
 * scripts folder on the left, editor tabs, and an AI panel on the right that
 * reads the open file and proposes changes as a diff.
 */
@Composable
fun IdeScreen(onExit: () -> Unit, vm: IdeViewModel = viewModel()) {
    val wide = isWideLayout()
    var explorerOpen by rememberSaveable { mutableStateOf(wide) }
    var aiOpen by rememberSaveable { mutableStateOf(false) }
    var saveAsTabId by remember { mutableStateOf<Long?>(null) }
    var closingTabId by remember { mutableStateOf<Long?>(null) }
    var newFolder by remember { mutableStateOf(false) }
    // A file or folder being renamed: (path, current name).
    var renaming by remember { mutableStateOf<Pair<String, String>?>(null) }

    BackHandler {
        when {
            aiOpen && !wide -> aiOpen = false
            explorerOpen && !wide -> explorerOpen = false
            else -> onExit()
        }
    }

    val active = vm.active
    val save: () -> Unit = {
        active?.let { tab -> if (tab.path == null) saveAsTabId = tab.id else vm.save(tab.id) }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(VS.editorBg)
            .imePadding()
    ) {
        TitleBar(
            title = active?.name ?: "Scripts",
            dirty = active?.dirty == true,
            canSave = active != null && !active.truncated && (active.dirty || active.path == null) && !vm.saving,
            saving = vm.saving,
            onBack = onExit,
            onExplorer = { explorerOpen = !explorerOpen; if (!wide && explorerOpen) aiOpen = false },
            onSave = save,
            menu = active?.let { tab ->
                { close ->
                    tab.path?.let { path ->
                        MenuItem("Rename…") { close(); renaming = path to tab.name }
                    }
                    MenuItem("Save to phone (Termux)") { close(); vm.saveToPhone(tab.path, tab.name, tab.id) }
                }
            }
        )
        if (vm.tabs.isNotEmpty()) {
            TabStrip(vm, onClose = { tab -> if (tab.dirty) closingTabId = tab.id else vm.closeTab(tab.id) })
            Breadcrumb(vm)
        }

        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            // The AI tab stays visible beside the open panel, so it closes it too.
            val panelWidth = minOf(380.dp, (maxWidth - AI_TAB_WIDTH) * 0.95f)
            Row(Modifier.fillMaxSize()) {
                if (wide && explorerOpen) {
                    Explorer(vm, Modifier.width(260.dp).fillMaxHeight(), onNewFolder = { newFolder = true }, onOpened = {}, onRename = { renaming = it })
                    VerticalLine()
                }
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    if (active == null) Welcome(onNewFile = vm::newUntitled, onOpenExplorer = { explorerOpen = true })
                    else EditorPane(vm, active)
                }
                if (wide && aiOpen) {
                    VerticalLine()
                    AiPanel(vm, Modifier.width(360.dp).fillMaxHeight(), onClose = { aiOpen = false })
                }
                AiTab(open = aiOpen, busy = vm.thinking) { aiOpen = !aiOpen; if (!wide && aiOpen) explorerOpen = false }
            }

            if (!wide) {
                Box(Modifier.fillMaxSize().padding(end = if (aiOpen) AI_TAB_WIDTH else 0.dp)) {
                    Scrim(visible = explorerOpen || aiOpen) { explorerOpen = false; aiOpen = false }
                }
                androidx.compose.animation.AnimatedVisibility(
                    visible = explorerOpen,
                    enter = slideInHorizontally(tween(200)) { -it },
                    exit = slideOutHorizontally(tween(160)) { -it }
                ) {
                    Explorer(
                        vm,
                        Modifier.width(panelWidth).fillMaxHeight().border(1.dp, VS.border, RectangleShape),
                        onNewFolder = { newFolder = true },
                        onOpened = { explorerOpen = false },
                        onRename = { renaming = it }
                    )
                }
                androidx.compose.animation.AnimatedVisibility(
                    visible = aiOpen,
                    enter = slideInHorizontally(tween(200)) { it },
                    exit = slideOutHorizontally(tween(160)) { it },
                    modifier = Modifier.align(Alignment.CenterEnd).padding(end = AI_TAB_WIDTH)
                ) {
                    AiPanel(vm, Modifier.width(panelWidth).fillMaxHeight().border(1.dp, VS.border, RectangleShape), onClose = { aiOpen = false })
                }
            }
        }

        if (active != null && !active.truncated) SymbolRow(vm)
        StatusBar(vm, active)
    }

    renaming?.let { (path, current) ->
        NameDialog(
            title = "Rename",
            hint = "Renamed on the PC. Open tabs keep their unsaved edits.",
            placeholder = current,
            confirm = "Rename",
            initial = current,
            onDismiss = { renaming = null },
            onConfirm = { name ->
                renaming = null
                if (name.trim() != current) vm.rename(path, name)
            }
        )
    }
    saveAsTabId?.let { id ->
        NameDialog(
            title = "Save As",
            hint = "Saved in ${folderLabel(vm, vm.targetFolder)} on the PC",
            placeholder = "script.py",
            confirm = "Save",
            onDismiss = { saveAsTabId = null },
            onConfirm = { name ->
                saveAsTabId = null
                vm.saveAs(id, name)
            }
        )
    }
    if (newFolder) {
        NameDialog(
            title = "New Folder",
            hint = "In ${folderLabel(vm, vm.targetFolder)}",
            placeholder = "utils",
            confirm = "Create",
            onDismiss = { newFolder = false },
            onConfirm = { name ->
                newFolder = false
                vm.newFolder(name)
            }
        )
    }
    closingTabId?.let { id ->
        val tab = vm.tab(id)
        if (tab == null) {
            closingTabId = null
            return@let
        }
        AlertDialog(
            onDismissRequest = { closingTabId = null },
            title = { Text("Save changes to ${tab.name}?", color = VS.textBright) },
            text = { Text("Your changes will be lost if you don't save them.", color = VS.text) },
            confirmButton = {
                Row {
                    TextButton(onClick = { closingTabId = null; vm.closeTab(id) }) { Text("Don't Save", color = VS.text) }
                    TextButton(onClick = {
                        closingTabId = null
                        if (tab.path == null) saveAsTabId = id else vm.save(id)
                    }) { Text("Save", color = VS.accent) }
                }
            },
            dismissButton = { TextButton(onClick = { closingTabId = null }) { Text("Cancel", color = VS.text) } },
            shape = SmallShape,
            containerColor = VS.sideBg
        )
    }
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

@Composable
private fun TitleBar(
    title: String,
    dirty: Boolean,
    canSave: Boolean,
    saving: Boolean,
    onBack: () -> Unit,
    onExplorer: () -> Unit,
    onSave: () -> Unit,
    /** The ⋮ menu's items, given a function that closes it; null hides the menu. */
    menu: (@Composable (close: () -> Unit) -> Unit)?
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .height(48.dp)
            .background(VS.sideBg)
            .bottomBorder(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        IconAction(R.drawable.ic_arrow_left, "Back", onBack)
        IconAction(R.drawable.ic_folder_tree, "Explorer", onExplorer)
        Text(
            title,
            color = VS.textBright,
            fontSize = 15.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false).padding(start = 4.dp)
        )
        if (dirty) Text("  ●", color = VS.textBright, fontSize = 12.sp)
        Spacer(Modifier.weight(1f))
        Text(
            if (saving) "Saving…" else "Save",
            color = if (canSave) Color.White else VS.textDim,
            fontSize = 13.sp,
            modifier = Modifier
                .background(if (canSave) VS.accent else VS.inputBg, SmallShape)
                .clickable(enabled = canSave, onClick = onSave)
                .padding(horizontal = 14.dp, vertical = 6.dp)
        )
        if (menu != null) {
            Box {
                Box(
                    Modifier
                        .size(40.dp)
                        .clickable { menuOpen = true },
                    contentAlignment = Alignment.Center
                ) { Text("⋮", color = VS.text, fontSize = 20.sp) }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }, containerColor = VS.inputBg) {
                    menu { menuOpen = false }
                }
            }
        } else Spacer(Modifier.width(10.dp))
    }
}

@Composable
private fun MenuItem(label: String, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(label, color = VS.textBright, fontSize = 14.sp) }, onClick = onClick)
}

@Composable
private fun IconAction(icon: Int, description: String, onClick: () -> Unit, tint: Color = VS.text) {
    Box(
        Modifier
            .size(44.dp)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Icon(painterResource(icon), contentDescription = description, tint = tint, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun TabStrip(vm: IdeViewModel, onClose: (EditorTab) -> Unit) {
    val listState = rememberLazyListState()
    LaunchedEffect(vm.activeId) {
        val index = vm.tabs.indexOfFirst { it.id == vm.activeId }
        if (index >= 0) listState.animateScrollToItem(index)
    }
    LazyRow(
        state = listState,
        modifier = Modifier
            .fillMaxWidth()
            .height(38.dp)
            .background(VS.sideBg)
            .bottomBorder()
    ) {
        items(vm.tabs, key = { it.id }) { tab ->
            val selected = tab.id == vm.activeId
            Row(
                Modifier
                    .fillMaxHeight()
                    .background(if (selected) VS.tabActive else VS.tabInactive)
                    .drawBehind {
                        if (selected) drawRect(VS.accent, size = Size(size.width, 2.dp.toPx()))
                        drawRect(VS.border, topLeft = Offset(size.width - 1.dp.toPx(), 0f), size = Size(1.dp.toPx(), size.height))
                    }
                    .clickable { vm.selectTab(tab.id) }
                    .padding(start = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                FileGlyph(tab.name)
                Text(
                    tab.name,
                    color = if (selected) VS.textBright else VS.textDim,
                    fontSize = 13.sp,
                    fontStyle = if (tab.path == null) androidx.compose.ui.text.font.FontStyle.Italic else null,
                    maxLines = 1,
                    modifier = Modifier.padding(start = 6.dp)
                )
                Box(
                    Modifier
                        .size(32.dp)
                        .clickable { onClose(tab) },
                    contentAlignment = Alignment.Center
                ) {
                    Text(if (tab.dirty) "●" else "×", color = if (selected || tab.dirty) VS.text else VS.textDim, fontSize = if (tab.dirty) 11.sp else 16.sp)
                }
            }
        }
    }
}

@Composable
private fun Breadcrumb(vm: IdeViewModel) {
    val tab = vm.active ?: return
    val root = vm.root
    val parts = buildList {
        add("scripts")
        val path = tab.path
        if (path != null && root != null && path.startsWith(root)) {
            addAll(path.removePrefix(root).trim('\\', '/').split('\\', '/').filter { it.isNotEmpty() })
        } else add(tab.name)
    }
    Text(
        parts.joinToString("  ›  "),
        color = VS.textDim,
        fontSize = 12.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .fillMaxWidth()
            .background(VS.editorBg)
            .padding(horizontal = 12.dp, vertical = 4.dp)
    )
}

@Composable
private fun StatusBar(vm: IdeViewModel, tab: EditorTab?) {
    val message = vm.message
    LaunchedEffect(message) {
        if (message != null) {
            delay(4000)
            if (vm.message == message) vm.message = null
        }
    }
    Row(
        Modifier
            .fillMaxWidth()
            .height(24.dp)
            .background(VS.statusBar)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(message ?: "scripts", color = Color.White, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (tab != null) {
            val (line, column) = cursorPosition(tab.value)
            Text("Ln $line, Col $column", color = Color.White, fontSize = 12.sp)
            Text("Spaces: ${INDENT.length}", color = Color.White, fontSize = 12.sp)
            Text(tab.language.name, color = Color.White, fontSize = 12.sp)
        }
    }
}

private fun cursorPosition(value: TextFieldValue): Pair<Int, Int> {
    val cursor = value.selection.start.coerceIn(0, value.text.length)
    var line = 1
    var lineStart = 0
    for (i in 0 until cursor) if (value.text[i] == '\n') {
        line++
        lineStart = i + 1
    }
    return line to (cursor - lineStart + 1)
}

/** The "tab on the right": a slim activity bar that opens the AI panel. */
@Composable
private fun AiTab(open: Boolean, busy: Boolean, onClick: () -> Unit) {
    Column(
        Modifier
            .width(AI_TAB_WIDTH)
            .fillMaxHeight()
            .background(VS.sideBg)
            .drawBehind { drawRect(VS.border, size = Size(1.dp.toPx(), size.height)) },
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(48.dp)
                .drawBehind { if (open) drawRect(VS.accent, topLeft = Offset(size.width - 2.dp.toPx(), 0f), size = Size(2.dp.toPx(), size.height)) }
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                painterResource(R.drawable.ic_message_circle),
                contentDescription = if (open) "Close AI panel" else "Open AI panel",
                tint = if (open) VS.textBright else VS.textDim,
                modifier = Modifier.size(22.dp)
            )
            if (busy) Box(Modifier.align(Alignment.TopEnd).padding(top = 10.dp, end = 8.dp).size(7.dp).background(VS.accent, RoundedCornerShape(50)))
        }
        Text(
            "AI",
            color = if (open) VS.textBright else VS.textDim,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.clickable(onClick = onClick).padding(4.dp)
        )
    }
}

@Composable
private fun Scrim(visible: Boolean, onClick: () -> Unit) {
    AnimatedVisibility(visible = visible, enter = fadeIn(tween(160)), exit = fadeOut(tween(160))) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.45f))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)
        )
    }
}

@Composable
private fun VerticalLine() {
    Box(Modifier.width(1.dp).fillMaxHeight().background(VS.border))
}

private fun Modifier.bottomBorder(): Modifier = drawBehind {
    drawRect(VS.border, topLeft = Offset(0f, size.height - 1.dp.toPx()), size = Size(size.width, 1.dp.toPx()))
}

/** A small colored file-type mark, standing in for VS Code's file icons. */
@Composable
private fun FileGlyph(name: String) {
    val (label, color) = when (name.substringAfterLast('.', "").lowercase()) {
        "py", "pyw" -> "py" to Color(0xFF4B8BBE)
        "js", "mjs", "cjs", "jsx" -> "JS" to Color(0xFFE8D44D)
        "ts", "tsx" -> "TS" to Color(0xFF3178C6)
        "json", "jsonc" -> "{}" to Color(0xFFCBCB41)
        "sh", "bash", "zsh" -> "$" to Color(0xFF89E051)
        "ps1", "psm1", "psd1" -> ">_" to Color(0xFF5391FE)
        "bat", "cmd" -> "⚙" to Color(0xFFC1F12E)
        "md" -> "M↓" to Color(0xFF519ABA)
        "html", "htm" -> "<>" to Color(0xFFE44D26)
        "css", "scss" -> "#" to Color(0xFF42A5F5)
        "kt", "kts" -> "K" to Color(0xFFA97BFF)
        "java" -> "J" to Color(0xFFE76F00)
        "c", "h", "cpp", "hpp", "cc", "cs" -> "C" to Color(0xFF659AD2)
        "go" -> "go" to Color(0xFF00ADD8)
        "rs" -> "rs" to Color(0xFFDEA584)
        "yml", "yaml", "toml", "ini", "cfg" -> "≡" to Color(0xFFCB171E)
        else -> "≡" to VS.textDim
    }
    Text(label, color = color, fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = Mono, maxLines = 1, modifier = Modifier.width(18.dp))
}

/* ------------------------------------------------------------------ */
/* Explorer                                                            */
/* ------------------------------------------------------------------ */

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Explorer(vm: IdeViewModel, modifier: Modifier, onNewFolder: () -> Unit, onOpened: () -> Unit, onRename: (Pair<String, String>) -> Unit) {
    val root = vm.root
    Column(modifier.background(VS.sideBg)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(36.dp)
                .padding(start = 16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("EXPLORER", color = VS.textDim, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            SmallAction("+ File") { vm.newUntitled(); onOpened() }
            SmallAction("+ Folder", onNewFolder)
            SmallAction("⟳") { vm.refreshTree() }
        }
        Text(
            "SCRIPTS",
            color = VS.textBright,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier
                .fillMaxWidth()
                .background(if (vm.targetFolder == root) VS.selectedRow.copy(alpha = 0.5f) else Color.Transparent)
                .clickable { vm.targetFolder = root }
                .padding(horizontal = 12.dp, vertical = 6.dp)
        )
        if (root == null) {
            Text("Loading…", color = VS.textDim, fontSize = 13.sp, modifier = Modifier.padding(16.dp))
            return
        }
        val rows = remember(vm.folders.toMap(), vm.expanded.toList(), vm.showHidden) { treeRows(vm, root) }
        if (rows.isEmpty()) {
            Text(
                "The scripts folder is empty. Tap + File to start one; it's saved on the PC.",
                color = VS.textDim,
                fontSize = 13.sp,
                modifier = Modifier.padding(16.dp)
            )
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
            items(rows, key = { it.entry.path }) { row ->
                val entry = row.entry
                val folder = entry.type == "folder"
                val activePath = vm.active?.path
                val selected = entry.path == activePath || (folder && entry.path == vm.targetFolder)
                var menuOpen by remember { mutableStateOf(false) }
                Box {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(30.dp)
                        .background(if (selected || menuOpen) VS.selectedRow else Color.Transparent)
                        .combinedClickable(
                            onLongClick = { menuOpen = true },
                            onClick = {
                                if (folder) vm.toggleFolder(entry.path) else {
                                    vm.openFile(entry)
                                    onOpened()
                                }
                            }
                        )
                        .padding(start = (8 + row.depth * 14).dp, end = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    if (folder) {
                        Text(if (entry.path in vm.expanded) "⌄" else "›", color = VS.text, fontSize = 15.sp, modifier = Modifier.width(18.dp))
                    } else {
                        Spacer(Modifier.width(4.dp))
                        FileGlyph(entry.name)
                    }
                    Text(
                        entry.name,
                        color = if (entry.hidden) VS.textDim else VS.text,
                        fontSize = 13.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 4.dp).weight(1f)
                    )
                    val tab = vm.tabs.firstOrNull { it.path == entry.path }
                    if (tab?.dirty == true) Text("●", color = VS.modified, fontSize = 10.sp)
                }
                // Long-press: what VS Code's right-click menu would offer.
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }, containerColor = VS.inputBg) {
                    MenuItem("Rename…") { menuOpen = false; onRename(entry.path to entry.name) }
                    if (!folder) {
                        val tab = vm.tabs.firstOrNull { it.path == entry.path }
                        MenuItem("Save to phone (Termux)") { menuOpen = false; vm.saveToPhone(entry.path, entry.name, tab?.id) }
                    }
                }
                }
            }
        }
    }
}

private data class TreeRow(val entry: FolderEntry, val depth: Int)

private fun treeRows(vm: IdeViewModel, root: String): List<TreeRow> {
    val rows = ArrayList<TreeRow>()
    fun add(folder: String, depth: Int) {
        vm.folders[folder].orEmpty().filter { vm.showHidden || !it.hidden }.forEach { entry ->
            rows += TreeRow(entry, depth)
            if (entry.type == "folder" && entry.path in vm.expanded) add(entry.path, depth + 1)
        }
    }
    add(root, 0)
    return rows
}

@Composable
private fun SmallAction(label: String, onClick: () -> Unit) {
    Text(
        label,
        color = VS.text,
        fontSize = 12.sp,
        modifier = Modifier
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 8.dp)
    )
}

private fun folderLabel(vm: IdeViewModel, folder: String?): String {
    val root = vm.root ?: return "scripts"
    if (folder == null || folder == root) return "scripts"
    return "scripts/" + folder.removePrefix(root).trim('\\', '/').replace('\\', '/')
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

@Composable
private fun Welcome(onNewFile: () -> Unit, onOpenExplorer: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center
    ) {
        Text("Scripts", color = VS.textBright, fontSize = 26.sp)
        Text("Editing evolved, on your phone", color = VS.textDim, fontSize = 14.sp, modifier = Modifier.padding(top = 4.dp, bottom = 24.dp))
        Text("Start", color = VS.textBright, fontSize = 15.sp, modifier = Modifier.padding(bottom = 8.dp))
        Text("New File…", color = Color(0xFF4DAAFC), fontSize = 14.sp, modifier = Modifier.clickable(onClick = onNewFile).padding(vertical = 6.dp))
        Text("Open from the scripts folder…", color = Color(0xFF4DAAFC), fontSize = 14.sp, modifier = Modifier.clickable(onClick = onOpenExplorer).padding(vertical = 6.dp))
        Text(
            "Files are saved in the scripts folder on your PC. Open the AI tab on the right to ask about the open file or have it make changes.",
            color = VS.textDim,
            fontSize = 13.sp,
            modifier = Modifier.padding(top = 24.dp)
        )
    }
}

@Composable
private fun EditorPane(vm: IdeViewModel, tab: EditorTab) {
    Column(Modifier.fillMaxSize()) {
        if (tab.conflict) {
            Notice("${tab.name} changed on the PC since you opened it.") {
                TextButton(onClick = { vm.reload(tab.id) }) { Text("Reload", color = Color(0xFF4DAAFC)) }
                TextButton(onClick = { vm.save(tab.id, force = true) }) { Text("Overwrite", color = VS.error) }
            }
        }
        if (tab.truncated) Notice("Only the first 512 KB is shown, so this file is read-only here.") {}
        CodeEditor(
            value = tab.value,
            onValueChange = vm::onEditorChange,
            language = tab.language,
            readOnly = tab.truncated,
            modifier = Modifier.weight(1f)
        )
    }
}

@Composable
private fun Notice(text: String, actions: @Composable () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(Color(0xFF5A1D1D))
            .padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text, color = VS.textBright, fontSize = 13.sp, modifier = Modifier.weight(1f).padding(vertical = 8.dp))
        actions()
    }
}

private val SYMBOLS = listOf("Tab", "(", ")", "{", "}", "[", "]", ":", ";", "=", "\"", "'", "#", "/", "\\", "<", ">", "-", "_", "$", "|", "&", "*", "+", "!")

@Composable
private fun SymbolRow(vm: IdeViewModel) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(VS.sideBg)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 4.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        SYMBOLS.forEach { symbol ->
            Text(
                symbol,
                color = VS.text,
                fontFamily = Mono,
                fontSize = 14.sp,
                modifier = Modifier
                    .background(VS.inputBg, SmallShape)
                    .clickable { vm.insert(if (symbol == "Tab") INDENT else symbol) }
                    .padding(horizontal = 12.dp, vertical = 7.dp)
            )
        }
    }
}

/**
 * Monospace editor with VS Code colors, soft wrap, line numbers and the
 * current line highlighted. The gutter numbers each real line at its first
 * visual row, and only draws the rows on screen.
 */
@Composable
private fun CodeEditor(value: TextFieldValue, onValueChange: (TextFieldValue) -> Unit, language: Language, readOnly: Boolean, modifier: Modifier) {
    val density = LocalDensity.current
    val scroll = rememberScrollState()
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    var viewportHeight by remember { mutableIntStateOf(0) }
    val textStyle = remember { TextStyle(fontFamily = Mono, fontSize = 13.sp, lineHeight = 19.sp, color = VS.plain) }
    val transformation = remember(language) { SyntaxTransformation(language) }

    val lineStarts = remember(value.text) {
        buildList {
            add(0)
            value.text.forEachIndexed { index, char -> if (char == '\n') add(index + 1) }
        }
    }
    val cursorLine = remember(value.text, value.selection.start) {
        lineStarts.indexOfLast { it <= value.selection.start }.coerceAtLeast(0)
    }
    val paint = remember { Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.MONOSPACE; textAlign = Paint.Align.RIGHT } }
    paint.textSize = with(density) { 12.sp.toPx() }
    val gutterWidth: Dp = with(density) { (paint.measureText("0".repeat(lineStarts.size.toString().length.coerceAtLeast(3))) + 22.dp.toPx()).toDp() }
    val topPadding = 8.dp

    Row(
        modifier
            .fillMaxWidth()
            .background(VS.editorBg)
            .onSizeChanged { viewportHeight = it.height }
            .verticalScroll(scroll)
            .drawBehind {
                // The current line, across the gutter and the text.
                val result = layout ?: return@drawBehind
                val start = lineStarts.getOrNull(cursorLine) ?: return@drawBehind
                val end = lineStarts.getOrNull(cursorLine + 1)?.minus(1) ?: result.layoutInput.text.length
                val top = result.getLineTop(result.getLineForOffset(start.coerceAtMost(result.layoutInput.text.length)))
                val bottom = result.getLineBottom(result.getLineForOffset(end.coerceAtMost(result.layoutInput.text.length)))
                drawRect(VS.currentLine, topLeft = Offset(0f, topPadding.toPx() + top), size = Size(size.width, bottom - top))
            }
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
                    val x = size.width - 12.dp.toPx()
                    val canvas = drawContext.canvas.nativeCanvas
                    lineStarts.forEachIndexed { index, start ->
                        val row = result.getLineForOffset(start.coerceAtMost(result.layoutInput.text.length))
                        val top = result.getLineTop(row)
                        if (top > visibleBottom) return@drawBehind
                        if (result.getLineBottom(row) >= visibleTop) {
                            paint.color = (if (index == cursorLine) VS.lineNumberActive else VS.lineNumber).toArgb()
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
            cursorBrush = SolidColor(VS.textBright),
            visualTransformation = transformation,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
            onTextLayout = { layout = it },
            modifier = Modifier
                .weight(1f)
                .padding(top = topPadding, bottom = topPadding, end = 12.dp)
        )
    }
}

/* ------------------------------------------------------------------ */
/* AI panel                                                            */
/* ------------------------------------------------------------------ */

private val SUGGESTIONS = listOf("Explain this file", "Find bugs", "Simplify this", "Add error handling")

@Composable
private fun AiPanel(vm: IdeViewModel, modifier: Modifier, onClose: () -> Unit) {
    var input by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    LaunchedEffect(vm.chat.size, vm.thinking) {
        val count = vm.chat.size + if (vm.thinking) 1 else 0
        if (count > 0) listState.animateScrollToItem(count - 1)
    }
    val send = {
        vm.ask(input)
        if (vm.active != null) input = ""
    }

    Column(modifier.background(VS.sideBg)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(36.dp)
                .padding(start = 16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("AI ASSISTANT", color = VS.textDim, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (vm.chat.isNotEmpty()) SmallAction("Clear") { vm.clearChat() }
            SmallAction("×", onClose)
        }
        if (vm.thinking) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = VS.accent, trackColor = VS.sideBg)
        else Spacer(Modifier.height(2.dp))

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (vm.chat.isEmpty()) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Ask about the open file, or tell me what to change.", color = VS.text, fontSize = 13.sp)
                        Text(
                            "Uses your local model on the PC. Changes come back as a diff; nothing is saved until you tap Save.",
                            color = VS.textDim,
                            fontSize = 12.sp
                        )
                        SUGGESTIONS.forEach { suggestion ->
                            Text(
                                suggestion,
                                color = VS.text,
                                fontSize = 13.sp,
                                modifier = Modifier
                                    .border(1.dp, VS.border, SmallShape)
                                    .clickable(enabled = vm.active != null && !vm.thinking) { vm.ask(suggestion) }
                                    .padding(horizontal = 10.dp, vertical = 6.dp)
                            )
                        }
                    }
                }
            }
            items(vm.chat, key = { it.id }) { turn -> ChatBubble(vm, turn) }
            if (vm.thinking) item { Text("Thinking… (a whole file can take a minute or two)", color = VS.textDim, fontSize = 12.sp) }
        }

        // Which file the model will read.
        Text(
            vm.active?.let { "Context: ${it.name}${if (it.dirty) " (unsaved edits included)" else ""}" } ?: "No file open",
            color = VS.textDim,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)
        )
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 8.dp, end = 8.dp, bottom = 8.dp)
                .background(VS.inputBg, SmallShape)
                .border(1.dp, VS.border, SmallShape),
            verticalAlignment = Alignment.Bottom
        ) {
            Box(Modifier.weight(1f).padding(10.dp)) {
                if (input.isEmpty()) Text("Ask or describe a change…", color = VS.textDim, fontSize = 14.sp)
                BasicTextField(
                    value = input,
                    onValueChange = { input = it },
                    textStyle = TextStyle(color = VS.textBright, fontSize = 14.sp),
                    cursorBrush = SolidColor(VS.textBright),
                    modifier = Modifier.fillMaxWidth().heightIn(max = 120.dp)
                )
            }
            val canSend = input.isNotBlank() && !vm.thinking && vm.active != null
            Box(
                Modifier
                    .size(40.dp)
                    .clickable(enabled = canSend, onClick = send),
                contentAlignment = Alignment.Center
            ) {
                Icon(painterResource(R.drawable.ic_send), contentDescription = "Send", tint = if (canSend) VS.accent else VS.textDim, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun ChatBubble(vm: IdeViewModel, turn: ChatTurn) {
    if (turn.role == "user") {
        Text(
            turn.text,
            color = VS.textBright,
            fontSize = 13.sp,
            modifier = Modifier
                .fillMaxWidth()
                .background(VS.inputBg, SmallShape)
                .padding(10.dp)
        )
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (turn.text.isNotBlank()) Text(turn.text, color = if (turn.error) VS.error else VS.text, fontSize = 13.sp)
        turn.proposal?.let { ProposalCard(vm, turn.id, it) }
    }
}

@Composable
private fun ProposalCard(vm: IdeViewModel, turnId: Long, proposal: Proposal) {
    val lines = remember(proposal.before, proposal.after) { diffLines(proposal.before, proposal.after) }
    val rows = remember(lines) { foldDiff(lines) }
    val added = lines.count { it.kind == DiffLine.Kind.ADDED }
    val removed = lines.count { it.kind == DiffLine.Kind.REMOVED }

    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, VS.border, SmallShape)
            .background(VS.editorBg, SmallShape)
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            FileGlyph(proposal.fileName)
            Text(proposal.fileName, color = VS.textBright, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 4.dp))
            Text("+$added", color = VS.diffAddedText, fontSize = 12.sp, fontFamily = Mono)
            Text(" −$removed", color = VS.diffRemovedText, fontSize = 12.sp, fontFamily = Mono)
        }
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 320.dp)
                .verticalScroll(rememberScrollState())
                .horizontalScroll(rememberScrollState())
        ) {
            rows.forEach { row ->
                when (row) {
                    is DiffRow.Fold -> Text(
                        "   ⋯ ${row.count} unchanged line${if (row.count == 1) "" else "s"}",
                        color = VS.textDim,
                        fontSize = 11.sp,
                        fontFamily = Mono,
                        modifier = Modifier.background(VS.sideBg).padding(vertical = 2.dp, horizontal = 4.dp)
                    )
                    is DiffRow.Line -> {
                        val line = row.line
                        val (background, sign, color) = when (line.kind) {
                            DiffLine.Kind.ADDED -> Triple(VS.diffAdded, "+", VS.diffAddedText)
                            DiffLine.Kind.REMOVED -> Triple(VS.diffRemoved, "−", VS.diffRemovedText)
                            DiffLine.Kind.SAME -> Triple(Color.Transparent, " ", VS.textDim)
                        }
                        Row(Modifier.background(background)) {
                            Text(
                                (line.newNumber ?: line.oldNumber)?.toString()?.padStart(4) ?: "    ",
                                color = VS.lineNumber,
                                fontSize = 11.sp,
                                fontFamily = Mono
                            )
                            Text(" $sign ", color = color, fontSize = 12.sp, fontFamily = Mono)
                            Text(line.text.ifEmpty { " " }, color = if (line.kind == DiffLine.Kind.SAME) VS.textDim else VS.plain, fontSize = 12.sp, fontFamily = Mono, softWrap = false)
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            when (proposal.state) {
                Proposal.State.PENDING -> {
                    PanelButton("Apply", primary = true) { vm.applyProposal(turnId) }
                    PanelButton("Discard") { vm.discardProposal(turnId) }
                }
                Proposal.State.APPLIED -> {
                    Text("Applied. Not saved yet.", color = VS.diffAddedText, fontSize = 12.sp, modifier = Modifier.weight(1f))
                    PanelButton("Undo") { vm.revertProposal(turnId) }
                }
                Proposal.State.DISCARDED -> Text("Discarded.", color = VS.textDim, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun PanelButton(label: String, primary: Boolean = false, onClick: () -> Unit) {
    Text(
        label,
        color = if (primary) Color.White else VS.text,
        fontSize = 13.sp,
        modifier = Modifier
            .background(if (primary) VS.accent else VS.inputBg, SmallShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 6.dp)
    )
}

@Composable
private fun NameDialog(
    title: String,
    hint: String,
    placeholder: String,
    confirm: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
    initial: String = ""
) {
    var name by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, color = VS.textBright) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .background(VS.inputBg, SmallShape)
                        .border(1.dp, VS.accent, SmallShape)
                        .padding(10.dp)
                ) {
                    if (name.isEmpty()) Text(placeholder, color = VS.textDim, fontSize = 14.sp, fontFamily = Mono)
                    BasicTextField(
                        value = name,
                        onValueChange = { name = it },
                        singleLine = true,
                        textStyle = TextStyle(color = VS.textBright, fontSize = 14.sp, fontFamily = Mono),
                        cursorBrush = SolidColor(VS.textBright),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                Text(hint, color = VS.textDim, fontSize = 12.sp)
            }
        },
        confirmButton = { TextButton(onClick = { onConfirm(name) }, enabled = name.isNotBlank()) { Text(confirm, color = if (name.isNotBlank()) Color(0xFF4DAAFC) else VS.textDim) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = VS.text) } },
        shape = SmallShape,
        containerColor = VS.sideBg
    )
}
