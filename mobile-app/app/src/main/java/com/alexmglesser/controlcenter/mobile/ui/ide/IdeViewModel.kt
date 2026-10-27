package com.alexmglesser.controlcenter.mobile.ui.ide

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.ApiException
import com.alexmglesser.controlcenter.mobile.data.api.AssistRequest
import com.alexmglesser.controlcenter.mobile.data.api.AssistTurn
import com.alexmglesser.controlcenter.mobile.data.api.FolderEntry
import com.alexmglesser.controlcenter.mobile.data.api.ServerEvent
import com.alexmglesser.controlcenter.mobile.ui.components.insertAtCursor
import com.alexmglesser.controlcenter.mobile.ui.components.withAutoIndent
import kotlinx.coroutines.launch

/** An editor tab. [path] is null for an untitled file that hasn't been saved yet. */
data class EditorTab(
    val id: Long,
    val name: String,
    val path: String?,
    val value: TextFieldValue,
    /** What's on the PC, to tell if there are unsaved edits. */
    val savedText: String = "",
    val modified: Double? = null,
    /** Over 512 KB: only the start was loaded, so it's read-only. */
    val truncated: Boolean = false,
    /** Saving was refused because the file changed on the PC since it was opened. */
    val conflict: Boolean = false
) {
    val dirty: Boolean get() = value.text != savedText
    val language: Language get() = languageFor(name)
}

/** A proposed new version of a file from the AI panel. */
data class Proposal(val tabId: Long, val fileName: String, val before: String, val after: String, val state: State = State.PENDING) {
    enum class State { PENDING, APPLIED, DISCARDED }
}

data class ChatTurn(val id: Long, val role: String, val text: String, val proposal: Proposal? = null, val error: Boolean = false)

/**
 * The phone's IDE: an explorer over the PC's scripts folder, editor tabs, and
 * the AI panel. Activity scoped, so open tabs and unsaved edits survive
 * rotation, switching tabs, and leaving the app screen.
 */
class IdeViewModel(application: Application) : AndroidViewModel(application) {
    private val container = application.appContainer
    private val api = container.api
    private var nextId = 1L

    /** The scripts folder on the PC. */
    var root by mutableStateOf<String?>(null)
        private set
    /** Folder path -> its entries, for every folder loaded so far. */
    val folders = mutableStateMapOf<String, List<FolderEntry>>()
    val expanded = mutableStateListOf<String>()
    var showHidden by mutableStateOf(false)
    /** Where New File / New Folder / Save As put things: the last folder tapped. */
    var targetFolder by mutableStateOf<String?>(null)

    val tabs = mutableStateListOf<EditorTab>()
    var activeId by mutableStateOf<Long?>(null)
        private set
    var saving by mutableStateOf(false)
        private set

    /** A short note for the status bar (saved, errors). */
    var message by mutableStateOf<String?>(null)

    val chat = mutableStateListOf<ChatTurn>()
    var thinking by mutableStateOf(false)
        private set

    val active: EditorTab? get() = tabs.firstOrNull { it.id == activeId }

    init {
        refreshTree()
        viewModelScope.launch { container.connection.events.collect(::onServerEvent) }
    }

    /* Explorer */

    fun refreshTree() {
        viewModelScope.launch {
            runCatching { api.ideFolder(null) }
                .onSuccess { listing ->
                    root = listing.root.ifEmpty { listing.path }
                    folders[listing.path] = listing.entries
                    if (targetFolder == null) targetFolder = listing.path
                    expanded.toList().forEach(::loadFolder)
                }
                .onFailure(::report)
        }
    }

    private fun loadFolder(path: String) {
        viewModelScope.launch {
            runCatching { api.ideFolder(path) }
                .onSuccess { folders[path] = it.entries }
                .onFailure {
                    // Deleted on the PC: forget it.
                    folders.remove(path)
                    expanded.remove(path)
                }
        }
    }

    fun toggleFolder(path: String) {
        targetFolder = path
        if (path in expanded) expanded.remove(path) else {
            expanded.add(path)
            loadFolder(path)
        }
    }

    /* Tabs */

    fun openFile(entry: FolderEntry) {
        targetFolder = entry.path.substringBeforeLast('\\').substringBeforeLast('/').takeIf { it.isNotEmpty() && it in folders } ?: root
        tabs.firstOrNull { it.path == entry.path }?.let {
            activeId = it.id
            return
        }
        viewModelScope.launch {
            runCatching { api.ideFile(entry.path) }
                .onSuccess { loaded ->
                    val tab = EditorTab(nextId++, loaded.name, loaded.path, TextFieldValue(loaded.text), loaded.text, loaded.modified, loaded.truncated)
                    tabs.add(tab)
                    activeId = tab.id
                }
                .onFailure { error ->
                    if (error is ApiException && error.code == "BINARY_FILE") message = "${entry.name} isn't a text file." else report(error)
                }
        }
    }

    fun newUntitled() {
        val used = tabs.mapNotNull { Regex("""^Untitled-(\d+)$""").find(it.name)?.groupValues?.get(1)?.toIntOrNull() }.toSet()
        val number = generateSequence(1) { it + 1 }.first { it !in used }
        val tab = EditorTab(nextId++, "Untitled-$number", null, TextFieldValue(""))
        tabs.add(tab)
        activeId = tab.id
    }

    fun selectTab(id: Long) {
        activeId = id
    }

    fun closeTab(id: Long) {
        val index = tabs.indexOfFirst { it.id == id }
        if (index < 0) return
        tabs.removeAt(index)
        if (activeId == id) activeId = tabs.getOrNull(index)?.id ?: tabs.getOrNull(index - 1)?.id
    }

    fun tab(id: Long): EditorTab? = tabs.firstOrNull { it.id == id }

    private fun updateTab(id: Long, change: (EditorTab) -> EditorTab) {
        val index = tabs.indexOfFirst { it.id == id }
        if (index >= 0) tabs[index] = change(tabs[index])
    }

    /* Editing */

    fun onEditorChange(next: TextFieldValue) {
        val id = activeId ?: return
        updateTab(id) { it.copy(value = withAutoIndent(it.value, next, indentAfterOpener = true)) }
    }

    fun insert(snippet: String) {
        val id = activeId ?: return
        updateTab(id) { it.copy(value = insertAtCursor(it.value, snippet)) }
    }

    /** Saves an existing file. With [force], overwrites even if it changed on the PC. Untitled files go through [saveAs]. */
    fun save(id: Long = activeId ?: -1, force: Boolean = false) {
        val tab = tab(id) ?: return
        val path = tab.path ?: return
        if (tab.truncated || saving) return
        val text = tab.value.text
        viewModelScope.launch {
            saving = true
            runCatching { api.saveIdeFile(path, text, if (force) null else tab.modified) }
                .onSuccess { saved ->
                    updateTab(id) { it.copy(savedText = text, modified = saved.modified, conflict = false) }
                    message = "Saved ${saved.name}."
                }
                .onFailure { error ->
                    if (error is ApiException && error.code == "FILE_CHANGED") updateTab(id) { it.copy(conflict = true) } else report(error)
                }
            saving = false
        }
    }

    /** Saves an untitled tab as a new file in [folder] (the scripts folder by default). */
    fun saveAs(id: Long, name: String, folder: String? = targetFolder ?: root) {
        val tab = tab(id) ?: return
        val parent = folder ?: return
        val text = tab.value.text
        viewModelScope.launch {
            saving = true
            runCatching { api.createIdeEntry(parent, name.trim(), "file", text) }
                .onSuccess { created ->
                    updateTab(id) { it.copy(name = created.name, path = created.path, savedText = text, modified = created.modified) }
                    message = "Saved ${created.name}."
                    loadFolder(parent)
                }
                .onFailure(::report)
            saving = false
        }
    }

    fun newFolder(name: String) {
        val parent = targetFolder ?: root ?: return
        viewModelScope.launch {
            runCatching { api.createIdeEntry(parent, name.trim(), "folder") }
                .onSuccess {
                    loadFolder(parent)
                    if (parent !in expanded && parent != root) expanded.add(parent)
                }
                .onFailure(::report)
        }
    }

    /** Renames a file or folder on the PC; open tabs follow it (unsaved edits are kept). */
    fun rename(path: String, newName: String) {
        val name = newName.trim()
        if (name.isEmpty()) return
        viewModelScope.launch {
            runCatching { api.renameIdeEntry(path, name) }
                .onSuccess { renamed ->
                    tabs.toList().forEach { tab ->
                        val old = tab.path ?: return@forEach
                        when {
                            old == path -> updateTab(tab.id) { it.copy(path = renamed.path, name = renamed.name) }
                            old.startsWith(path + "\\") || old.startsWith("$path/") ->
                                updateTab(tab.id) { it.copy(path = renamed.path + old.substring(path.length)) }
                        }
                    }
                    if (expanded.remove(path)) expanded.add(renamed.path)
                    folders.remove(path)
                    if (targetFolder == path) targetFolder = renamed.path
                    message = "Renamed to ${renamed.name}."
                    refreshTree()
                }
                .onFailure(::report)
        }
    }

    /**
     * Copies a script into the phone's Download/scripts folder for Termux.
     * An open file is saved as it is in the editor; one that isn't open is
     * fetched from the PC.
     */
    fun saveToPhone(path: String?, name: String, tabId: Long? = null) {
        val context = getApplication<Application>()
        viewModelScope.launch {
            runCatching {
                val text = tabId?.let { tab(it)?.value?.text } ?: api.ideFile(path ?: error("Save the file first.")).text
                PhoneScripts.save(context, name, text)
            }
                .onSuccess { saved -> message = "Saved to phone: ${PhoneScripts.TERMUX_PATH}/$saved" }
                .onFailure { message = "Couldn't save to the phone: ${it.message}" }
        }
    }

    /** Throws away local edits and loads the PC's copy. */
    fun reload(id: Long) {
        val tab = tab(id) ?: return
        val path = tab.path ?: return
        viewModelScope.launch {
            runCatching { api.ideFile(path) }
                .onSuccess { loaded ->
                    updateTab(id) { it.copy(value = TextFieldValue(loaded.text), savedText = loaded.text, modified = loaded.modified, truncated = loaded.truncated, conflict = false) }
                }
                .onFailure(::report)
        }
    }

    /* AI panel */

    fun ask(instruction: String) {
        val tab = active
        val request = instruction.trim()
        if (request.isEmpty() || thinking) return
        if (tab == null) {
            message = "Open a file first, so there's something to look at."
            return
        }
        val history = chat.filter { !it.error }.map { AssistTurn(it.role, it.text) }
        chat.add(ChatTurn(nextId++, "user", request))
        val before = tab.value.text
        viewModelScope.launch {
            thinking = true
            runCatching { api.ideAssist(AssistRequest(tab.name, before, request, history)) }
                .onSuccess { response ->
                    val proposal = response.content?.let { Proposal(tab.id, tab.name, before, it) }
                    chat.add(ChatTurn(nextId++, "assistant", response.reply, proposal))
                }
                .onFailure { error -> chat.add(ChatTurn(nextId++, "assistant", error.message ?: "Something went wrong.", error = true)) }
            thinking = false
        }
    }

    /** Puts the proposed file in the editor (unsaved, so Save or Undo is still up to you). */
    fun applyProposal(turnId: Long) {
        val turn = chat.firstOrNull { it.id == turnId } ?: return
        val proposal = turn.proposal ?: return
        if (tab(proposal.tabId) == null) {
            message = "${proposal.fileName} isn't open anymore."
            return
        }
        updateTab(proposal.tabId) { it.copy(value = TextFieldValue(proposal.after, TextRange(0))) }
        activeId = proposal.tabId
        setProposalState(turnId, Proposal.State.APPLIED)
    }

    /** Undo an applied proposal: back to the text it was made from. */
    fun revertProposal(turnId: Long) {
        val proposal = chat.firstOrNull { it.id == turnId }?.proposal ?: return
        if (tab(proposal.tabId) == null) return
        updateTab(proposal.tabId) { it.copy(value = TextFieldValue(proposal.before, TextRange(0))) }
        setProposalState(turnId, Proposal.State.PENDING)
    }

    fun discardProposal(turnId: Long) = setProposalState(turnId, Proposal.State.DISCARDED)

    private fun setProposalState(turnId: Long, state: Proposal.State) {
        val index = chat.indexOfFirst { it.id == turnId }
        if (index >= 0) chat[index] = chat[index].let { it.copy(proposal = it.proposal?.copy(state = state)) }
    }

    fun clearChat() {
        if (!thinking) chat.clear()
    }

    /* Changes made elsewhere */

    private fun onServerEvent(event: ServerEvent) {
        if (event.appId != "ide" || event.type != "data-changed") return
        refreshTree()
        val path = event.metaString("path") ?: return
        // Saved somewhere else while open here with no local edits: show the new text.
        val tab = tabs.firstOrNull { it.path == path } ?: return
        if (tab.dirty || saving) return
        viewModelScope.launch {
            val latest = runCatching { api.ideFile(path) }.getOrNull() ?: return@launch
            val current = tab(tab.id) ?: return@launch
            if (latest.modified != current.modified && !current.dirty) {
                updateTab(tab.id) { it.copy(value = TextFieldValue(latest.text), savedText = latest.text, modified = latest.modified, truncated = latest.truncated) }
            }
        }
    }

    private fun report(error: Throwable) {
        message = error.message ?: "Something went wrong."
    }
}
