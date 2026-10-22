package com.alexmglesser.controlcenter.mobile.ui.projects

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.ApiException
import com.alexmglesser.controlcenter.mobile.data.api.FolderEntry
import com.alexmglesser.controlcenter.mobile.data.api.FolderListing
import com.alexmglesser.controlcenter.mobile.data.api.ProjectInfo
import com.alexmglesser.controlcenter.mobile.data.api.ServerEvent
import kotlinx.coroutines.launch

/** A file open in the editor. [savedText] is what's on the PC, to tell if there are unsaved edits. */
data class OpenFile(
    val path: String,
    val name: String,
    val modified: Double? = null,
    val savedText: String = "",
    val truncated: Boolean = false,
    /** Not a text file: shown as info only. */
    val binary: Boolean = false,
    val size: Long? = null
)

/**
 * The phone's Projects app: project list -> folder -> text editor. Activity
 * scoped, so an unsaved edit survives rotation, switching tabs, and leaving
 * the app screen.
 */
class ProjectsViewModel(application: Application) : AndroidViewModel(application) {
    private val container = application.appContainer
    private val api = container.api

    var projects by mutableStateOf<List<ProjectInfo>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var filter by mutableStateOf("all")
    var showHidden by mutableStateOf(false)

    /** A short note for the status line (saved, errors). */
    var message by mutableStateOf<String?>(null)

    var project by mutableStateOf<ProjectInfo?>(null)
        private set
    var listing by mutableStateOf<FolderListing?>(null)
        private set
    var file by mutableStateOf<OpenFile?>(null)
        private set
    var editor by mutableStateOf(TextFieldValue(""))
        private set

    /** The save was refused because the file changed on the PC since it was opened. */
    var conflict by mutableStateOf(false)
        private set
    var saving by mutableStateOf(false)
        private set

    val dirty: Boolean
        get() = file?.let { !it.binary && editor.text != it.savedText } ?: false

    val visibleProjects: List<ProjectInfo>
        get() = projects.filter { filter == "all" || it.category == filter }

    val visibleEntries: List<FolderEntry>
        get() = listing?.entries.orEmpty().filter { showHidden || !it.hidden }

    init {
        refreshProjects()
        viewModelScope.launch { container.connection.events.collect(::onServerEvent) }
    }

    fun refreshProjects() {
        viewModelScope.launch {
            loading = true
            runCatching { api.projects() }
                .onSuccess { list ->
                    projects = list
                    val current = project
                    if (current != null && list.none { it.id == current.id }) {
                        project = null
                        listing = null
                        file = null
                    }
                }
                .onFailure(::report)
            loading = false
        }
    }

    fun openProject(target: ProjectInfo) {
        project = target
        listing = null
        openFolder(null)
    }

    fun openFolder(folderPath: String?) {
        val projectId = project?.id ?: return
        viewModelScope.launch {
            runCatching { api.projectFolder(projectId, folderPath) }
                .onSuccess { listing = it }
                .onFailure(::report)
        }
    }

    fun openFile(entry: FolderEntry) {
        val projectId = project?.id ?: return
        viewModelScope.launch {
            runCatching { api.projectFile(projectId, entry.path) }
                .onSuccess { loaded ->
                    file = OpenFile(loaded.path, loaded.name, loaded.modified, loaded.text, loaded.truncated, size = loaded.size)
                    editor = TextFieldValue(loaded.text)
                    conflict = false
                }
                .onFailure { error ->
                    if (error is ApiException && error.code == "BINARY_FILE") {
                        file = OpenFile(entry.path, entry.name, binary = true, size = entry.size)
                        conflict = false
                    } else {
                        report(error)
                    }
                }
        }
    }

    /** Typing, plus auto-indent: a new line starts with the previous line's indentation. */
    fun onEditorChange(next: TextFieldValue) {
        val previous = editor
        val cursor = next.selection.start
        val typedNewline = next.selection.collapsed &&
            next.text.length == previous.text.length + 1 &&
            cursor > 0 && next.text[cursor - 1] == '\n' &&
            next.text.regionMatches(0, previous.text, 0, cursor - 1) &&
            next.text.regionMatches(cursor, previous.text, cursor - 1, previous.text.length - cursor + 1)
        if (typedNewline) {
            val lineStart = next.text.lastIndexOf('\n', cursor - 2) + 1
            val indent = next.text.substring(lineStart, cursor - 1).takeWhile { it == ' ' || it == '\t' }
            if (indent.isNotEmpty()) {
                editor = TextFieldValue(next.text.substring(0, cursor) + indent + next.text.substring(cursor), TextRange(cursor + indent.length))
                return
            }
        }
        editor = next
    }

    /** The symbol row above the keyboard. */
    fun insert(snippet: String) {
        val value = editor
        val start = minOf(value.selection.start, value.selection.end)
        val end = maxOf(value.selection.start, value.selection.end)
        editor = TextFieldValue(value.text.replaceRange(start, end, snippet), TextRange(start + snippet.length))
    }

    /** Saves to the PC. With [force], overwrites even if the file changed there. */
    fun save(force: Boolean = false) {
        val projectId = project?.id ?: return
        val current = file ?: return
        if (current.binary || current.truncated || saving) return
        val text = editor.text
        viewModelScope.launch {
            saving = true
            runCatching { api.saveProjectFile(projectId, current.path, text, if (force) null else current.modified) }
                .onSuccess { saved ->
                    if (file?.path == current.path) file = current.copy(modified = saved.modified, savedText = text)
                    conflict = false
                    message = "Saved ${saved.name}."
                }
                .onFailure { error ->
                    if (error is ApiException && error.code == "FILE_CHANGED") conflict = true else report(error)
                }
            saving = false
        }
    }

    /** Throws away local edits and loads the PC's copy. */
    fun reloadFile() {
        val current = file ?: return
        file = null
        openFile(FolderEntry(current.name, current.path))
    }

    fun createEntry(name: String, type: String) {
        val projectId = project?.id ?: return
        val folder = listing ?: return
        viewModelScope.launch {
            runCatching { api.createProjectEntry(projectId, folder.path, name.trim(), type) }
                .onSuccess { created ->
                    openFolder(folder.path)
                    if (created.type == "file") openFile(FolderEntry(created.name, created.path))
                }
                .onFailure(::report)
        }
    }

    /** Back inside the app: editor -> folder -> parent folder -> project list. False at the list. */
    fun back(): Boolean {
        when {
            file != null -> {
                file = null
                conflict = false
                listing?.let { openFolder(it.path) }
            }
            listing?.parent != null -> openFolder(listing?.parent)
            project != null -> {
                project = null
                listing = null
            }
            else -> return false
        }
        return true
    }

    private fun onServerEvent(event: ServerEvent) {
        if (event.appId != "project-app" || event.type != "data-changed") return
        if (event.metaString("entity") == "project") {
            refreshProjects()
            return
        }
        listing?.let { openFolder(it.path) }
        // Saved on the PC while open here with no local edits: show the new text.
        val current = file
        val projectId = project?.id
        if (current != null && projectId != null && !current.binary && event.metaString("path") == current.path && !dirty && !saving) {
            viewModelScope.launch {
                val latest = runCatching { api.projectFile(projectId, current.path) }.getOrNull() ?: return@launch
                if (latest.modified != current.modified && file?.path == current.path && !dirty) {
                    file = current.copy(modified = latest.modified, savedText = latest.text, truncated = latest.truncated)
                    editor = TextFieldValue(latest.text)
                    message = "${latest.name} changed on the PC and was reloaded."
                }
            }
        }
    }

    private fun report(error: Throwable) {
        message = error.message ?: "Something went wrong."
    }
}
