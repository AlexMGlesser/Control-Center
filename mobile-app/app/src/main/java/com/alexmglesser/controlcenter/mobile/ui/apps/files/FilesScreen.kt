package com.alexmglesser.controlcenter.mobile.ui.apps.files

import android.app.Application
import android.app.KeyguardManager
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.ApiException
import com.alexmglesser.controlcenter.mobile.data.api.FileRoot
import com.alexmglesser.controlcenter.mobile.data.api.FileRoots
import com.alexmglesser.controlcenter.mobile.data.api.PcFile
import com.alexmglesser.controlcenter.mobile.data.api.PcFolder
import com.alexmglesser.controlcenter.mobile.ui.components.AppTopBar
import com.alexmglesser.controlcenter.mobile.ui.components.NeonButton
import com.alexmglesser.controlcenter.mobile.ui.components.Note
import com.alexmglesser.controlcenter.mobile.ui.components.SectionLabel
import com.alexmglesser.controlcenter.mobile.ui.components.formatBytes
import com.alexmglesser.controlcenter.mobile.ui.theme.ButtonShape
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** File System on the phone: the whole PC, view and download only (design: File System). */
class FilesViewModel(application: Application) : AndroidViewModel(application) {
    private val container = application.appContainer
    private val api = container.api

    /** Unlocked with fingerprint / screen lock; locks again when the app leaves the screen. */
    var unlocked by mutableStateOf(false)
    var roots by mutableStateOf<FileRoots?>(null)
        private set
    var folder by mutableStateOf<PcFolder?>(null)
        private set
    var preview by mutableStateOf<PcFile?>(null)
    var details by mutableStateOf<PcFile?>(null)
    var actionsFor by mutableStateOf<PcFile?>(null)
    var filter by mutableStateOf("")
    var showHidden by mutableStateOf(false)
        private set
    var loading by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)

    init {
        viewModelScope.launch {
            container.inForeground.collect { visible -> if (!visible) unlocked = false }
        }
    }

    fun loadRoots() {
        if (roots != null) return
        viewModelScope.launch {
            loading = true
            runCatching { api.fileRoots() }.onSuccess { roots = it }.onFailure(::report)
            loading = false
        }
    }

    fun openFolder(path: String) {
        viewModelScope.launch {
            loading = true
            runCatching { api.fileFolder(path, showHidden) }
                .onSuccess {
                    folder = it
                    filter = ""
                    message = null
                }
                .onFailure(::report)
            loading = false
        }
    }

    fun toggleHidden() {
        showHidden = !showHidden
        folder?.let { openFolder(it.path) }
    }

    fun showDetails(file: PcFile) {
        viewModelScope.launch {
            details = runCatching { api.fileInfo(file.path) }.getOrDefault(file)
        }
    }

    /** Preview -> folder -> parent folder -> drives. False at the drives list. */
    fun back(): Boolean {
        val current = folder
        when {
            preview != null -> preview = null
            current?.parent != null -> openFolder(current.parent)
            current != null -> folder = null
            else -> return false
        }
        return true
    }

    fun visibleEntries(): List<PcFile> {
        val text = filter.trim()
        return folder?.entries.orEmpty().filter { text.isEmpty() || it.name.contains(text, ignoreCase = true) }
    }

    private fun report(error: Throwable) {
        message = if (error is ApiException && error.code == "PHONE_FILE_ACCESS_OFF") {
            "File access from the phone is switched off on the PC (Settings > Devices)."
        } else {
            error.message
        }
    }
}

@Composable
fun FilesScreen(onExit: () -> Unit, vm: FilesViewModel = viewModel()) {
    val context = LocalContext.current
    val settings by context.appContainer.sessionStore.settings.collectAsState(initial = null)
    val goBack = { if (!vm.back()) onExit() }
    BackHandler { goBack() }

    val current = settings ?: return
    if (current.lockFileSystem && !vm.unlocked) {
        LockGate(onUnlocked = { vm.unlocked = true }, onExit = onExit)
        return
    }
    LaunchedEffect(Unit) { vm.loadRoots() }

    val preview = vm.preview
    if (preview != null) {
        FilePreview(preview, onBack = { vm.preview = null })
        return
    }

    Column(Modifier.fillMaxSize()) {
        AppTopBar(vm.folder?.path?.substringAfterLast('\\')?.ifEmpty { vm.folder?.path } ?: "File System", onBack = goBack) {
            TextButton(onClick = vm::toggleHidden) { Text(if (vm.showHidden) "Hide hidden" else "Show hidden", color = CC.cyan) }
        }
        vm.message?.let { Text(it, color = CC.warn, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        val folder = vm.folder
        if (folder == null) RootsView(vm) else FolderView(vm, folder)
    }

    vm.actionsFor?.let { file -> FileActionsDialog(file, vm, context) }
    vm.details?.let { file -> DetailsDialog(file) { vm.details = null } }
}

/* ------------------------------------------------------------------ */
/* Lock                                                                */
/* ------------------------------------------------------------------ */

@Composable
private fun LockGate(onUnlocked: () -> Unit, onExit: () -> Unit) {
    val context = LocalContext.current
    var error by androidx.compose.runtime.remember { mutableStateOf<String?>(null) }
    val ask = { authenticate(context, onUnlocked) { error = it } }
    LaunchedEffect(Unit) { ask() }
    Column(Modifier.fillMaxSize()) {
        AppTopBar("File System", onBack = onExit)
        Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("File System shows everything on your PC, so it's locked.", color = CC.textPrimary)
            error?.let { Text(it, color = CC.warn, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp)) }
            NeonButton("Unlock", onClick = ask, primary = true, modifier = Modifier.padding(top = 20.dp))
            Text(
                "You can turn this lock off in Settings > Security.",
                color = CC.textSecondary,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 16.dp)
            )
        }
    }
}

/** Fingerprint, face or the screen lock. A phone with no screen lock has nothing to check. */
private fun authenticate(context: Context, onSuccess: () -> Unit, onError: (String) -> Unit) {
    if (!context.getSystemService(KeyguardManager::class.java).isDeviceSecure) {
        onSuccess()
        return
    }
    val builder = BiometricPrompt.Builder(context)
        .setTitle("Unlock File System")
        .setSubtitle("Your PC's files")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        builder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
    } else {
        @Suppress("DEPRECATION")
        builder.setDeviceCredentialAllowed(true)
    }
    builder.build().authenticate(
        CancellationSignal(),
        context.mainExecutor,
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) = onSuccess()
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) = onError(errString?.toString() ?: "Not unlocked.")
        }
    )
}

/* ------------------------------------------------------------------ */
/* Drives and folders                                                  */
/* ------------------------------------------------------------------ */

@Composable
private fun RootsView(vm: FilesViewModel) {
    val roots = vm.roots
    if (roots == null) {
        if (vm.loading) Note("Loading…")
        return
    }
    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { SectionLabel("Quick locations") }
        items(roots.quick, key = { "q-${it.path}" }) { root -> RootRow(root) { vm.openFolder(root.path) } }
        item { SectionLabel("Drives") }
        items(roots.drives, key = { "d-${it.path}" }) { root -> RootRow(root) { vm.openFolder(root.path) } }
    }
}

@Composable
private fun RootRow(root: FileRoot, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .neonClickable(TileShape, onClick = onClick)
            .background(CC.bgPanel, TileShape)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(if (root.type == "drive") "◆" else "▸", color = CC.cyan, modifier = Modifier.width(28.dp))
        Text(root.name, color = CC.textPrimary, modifier = Modifier.weight(1f))
        if (root.freeBytes != null && root.totalBytes != null) {
            Text("${formatBytes(root.freeBytes)} free of ${formatBytes(root.totalBytes)}", color = CC.textSecondary, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun FolderView(vm: FilesViewModel, folder: PcFolder) {
    Column(Modifier.fillMaxSize()) {
        Breadcrumb(folder.path, onJump = vm::openFolder)
        OutlinedTextField(
            value = vm.filter,
            onValueChange = { vm.filter = it },
            placeholder = { Text("Filter this folder…") },
            singleLine = true,
            shape = ButtonShape,
            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = CC.cyan, unfocusedBorderColor = CC.line),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp)
        )
        val entries = vm.visibleEntries()
        if (entries.isEmpty()) {
            Note(if (vm.loading) "Loading…" else if (vm.filter.isNotBlank()) "Nothing matches." else "This folder is empty.")
            return
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
            items(entries, key = { it.path }) { entry ->
                EntryRow(
                    entry,
                    onClick = {
                        when {
                            entry.noAccess -> vm.message = "Windows won't let Control Center open ${entry.name}."
                            entry.type == "folder" -> vm.openFolder(entry.path)
                            else -> vm.preview = entry
                        }
                    },
                    onLongClick = { if (entry.type == "file" && !entry.noAccess) vm.actionsFor = entry }
                )
            }
        }
    }
}

@Composable
private fun Breadcrumb(path: String, onJump: (String) -> Unit) {
    val parts = path.trimEnd('\\').split('\\').filter { it.isNotEmpty() }
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        parts.forEachIndexed { index, part ->
            val target = parts.take(index + 1).joinToString("\\").let { if (index == 0) "$it\\" else it }
            val last = index == parts.lastIndex
            Text(
                part,
                color = if (last) CC.textPrimary else CC.cyan,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier
                    .then(if (last) Modifier else Modifier.neonClickable(ButtonShape, restBorder = CC.line.copy(alpha = 0f), onClick = { onJump(target) }))
                    .padding(horizontal = 6.dp, vertical = 8.dp)
            )
            if (!last) Text("›", color = CC.textSecondary)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun EntryRow(entry: PcFile, onClick: () -> Unit, onLongClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 12.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(kindGlyph(entry), color = if (entry.noAccess) CC.textSecondary else CC.cyan, modifier = Modifier.width(28.dp))
        Text(
            entry.name,
            color = if (entry.hidden || entry.noAccess) CC.textSecondary else CC.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
        Text(
            when {
                entry.noAccess -> "No access"
                entry.type == "file" -> listOf(formatBytes(entry.size), shortDate(entry.modified)).filter { it.isNotEmpty() }.joinToString("  ")
                else -> shortDate(entry.modified)
            },
            color = CC.textSecondary,
            style = MaterialTheme.typography.bodySmall
        )
    }
}

/* ------------------------------------------------------------------ */
/* Actions and details                                                 */
/* ------------------------------------------------------------------ */

@Composable
private fun FileActionsDialog(file: PcFile, vm: FilesViewModel, context: Context) {
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { vm.actionsFor = null },
        title = { Text(file.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Column {
                TextButton(onClick = {
                    vm.actionsFor = null
                    FileTransfers.download(context, file) { vm.message = it }
                }) { Text("Download to this phone", modifier = Modifier.fillMaxWidth()) }
                TextButton(onClick = {
                    vm.actionsFor = null
                    vm.message = "Preparing ${file.name}…"
                    scope.launch {
                        runCatching { FileTransfers.share(context, file) }
                            .onSuccess { vm.message = null }
                            .onFailure { vm.message = "Couldn't share: ${it.message}" }
                    }
                }) { Text("Share", modifier = Modifier.fillMaxWidth()) }
                TextButton(onClick = {
                    vm.actionsFor = null
                    vm.showDetails(file)
                }) { Text("Details", modifier = Modifier.fillMaxWidth()) }
            }
        },
        confirmButton = { TextButton(onClick = { vm.actionsFor = null }) { Text("Close") } },
        shape = TileShape,
        containerColor = CC.bgPanel
    )
}

@Composable
private fun DetailsDialog(file: PcFile, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(file.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                DetailLine("Location", file.path)
                if (file.size != null) DetailLine("Size", "${formatBytes(file.size)} (${"%,d".format(file.size)} bytes)")
                DetailLine("Type", file.name.substringAfterLast('.', "").uppercase().ifEmpty { file.kind })
                file.created?.let { DetailLine("Created", longDate(it)) }
                file.modified?.let { DetailLine("Modified", longDate(it)) }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        shape = TileShape,
        containerColor = CC.bgPanel
    )
}

@Composable
private fun DetailLine(label: String, value: String) {
    Column {
        Text(label, color = CC.textSecondary, style = MaterialTheme.typography.labelSmall)
        Text(value, color = CC.textPrimary, style = MaterialTheme.typography.bodySmall)
    }
}

private fun kindGlyph(entry: PcFile): String = when {
    entry.noAccess -> "⊘"
    entry.type == "folder" -> "▸"
    entry.kind == "image" -> "▣"
    entry.kind == "video" -> "▶"
    entry.kind == "audio" -> "♪"
    entry.kind == "pdf" -> "▤"
    entry.kind == "text" -> "≡"
    else -> "◇"
}

private fun shortDate(iso: String?): String = iso?.let {
    runCatching {
        val date = Instant.parse(it).atZone(ZoneId.systemDefault()).toLocalDate()
        date.format(DateTimeFormatter.ofPattern(if (date.year == LocalDate.now().year) "MMM d" else "MMM d, yyyy"))
    }.getOrNull()
} ?: ""

internal fun longDate(iso: String): String = runCatching {
    Instant.parse(iso).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT))
}.getOrDefault(iso)
