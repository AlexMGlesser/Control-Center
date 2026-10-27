package com.alexmglesser.controlcenter.mobile.ui.apps

import android.app.Application
import android.content.ComponentName
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.MusicPlaylist
import com.alexmglesser.controlcenter.mobile.data.api.MusicTrack
import com.alexmglesser.controlcenter.mobile.media.AuthMedia
import com.alexmglesser.controlcenter.mobile.media.MusicService
import com.alexmglesser.controlcenter.mobile.ui.components.AppTopBar
import com.alexmglesser.controlcenter.mobile.ui.components.Note
import com.alexmglesser.controlcenter.mobile.ui.theme.ButtonShape
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable
import kotlinx.coroutines.launch

/** Formats Android's player can't decode (architecture 5.9): shown greyed out. */
private val UNPLAYABLE = setOf("wma", "ape", "aif", "aiff")

private fun MusicTrack.extension(): String = (sourcePath ?: name).substringAfterLast('.', "").lowercase()

private fun MusicTrack.playable(): Boolean = sourcePath != null && extension() !in UNPLAYABLE

/** The tag's title, or a tidied file name ("[SITE.COM] Song.mp3" -> "Song"). */
private fun MusicTrack.displayTitle(): String =
    title?.takeIf { it.isNotBlank() }
        ?: name.substringBeforeLast('.').replace(Regex("^\\[[^\\]]*\\]\\s*"), "").replace('_', ' ')

class MusicViewModel(application: Application) : AndroidViewModel(application) {
    private val container = application.appContainer

    var playlists by mutableStateOf<List<MusicPlaylist>>(emptyList())
        private set
    var open by mutableStateOf<MusicPlaylist?>(null)
    var loading by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)

    // The phone's player, through the background service's session.
    private var controller: MediaController? = null
    var nowTitle by mutableStateOf<String?>(null)
        private set
    var nowSubtitle by mutableStateOf<String?>(null)
        private set
    var isPlaying by mutableStateOf(false)
        private set

    /** What the PC was last told to play, for the mini player in PC mode. */
    var pcPlaylist by mutableStateOf<String?>(null)
        private set

    init {
        val token = SessionToken(application, ComponentName(application, MusicService::class.java))
        val future = MediaController.Builder(application, token).buildAsync()
        future.addListener({
            val connected = runCatching { future.get() }.getOrNull() ?: return@addListener
            controller = connected
            connected.addListener(object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) = syncFromPlayer(player)
            })
            syncFromPlayer(connected)
        }, ContextCompat.getMainExecutor(application))
    }

    private fun syncFromPlayer(player: Player) {
        val metadata = player.mediaMetadata
        nowTitle = metadata.title?.toString()?.takeIf { player.mediaItemCount > 0 }
        nowSubtitle = listOfNotNull(metadata.artist?.toString(), metadata.albumTitle?.toString()).joinToString(" · ").ifEmpty { null }
        isPlaying = player.isPlaying
    }

    fun refresh() {
        viewModelScope.launch {
            loading = true
            runCatching { container.api.musicPlaylists() }
                .onSuccess { list ->
                    playlists = list.filter { it.tracks.isNotEmpty() }
                    open = open?.let { current -> playlists.firstOrNull { it.name == current.name } }
                }
                .onFailure { message = it.message }
            loading = false
        }
    }

    fun setOnPc(onPc: Boolean) {
        viewModelScope.launch { container.sessionStore.updateSettings { it.copy(musicOnPc = onPc) } }
        if (onPc) controller?.pause()
    }

    /** Phone: play from this track. PC: playlists start from the top there. */
    fun play(playlist: MusicPlaylist, index: Int, onPc: Boolean) {
        if (onPc) {
            pcCommand("play-playlist", playlist.name)
            pcPlaylist = playlist.name
            return
        }
        val player = controller ?: run {
            message = "The player is still starting. Try again in a moment."
            return
        }
        val playable = playlist.tracks.withIndex().filter { it.value.playable() }
        val items = playable.mapNotNull { (_, track) ->
            val url = AuthMedia.url(getApplication(), container.api.musicTrackPath(track.sourcePath!!)) ?: return@mapNotNull null
            MediaItem.Builder()
                .setUri(url)
                .setMediaId(track.sourcePath)
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(track.displayTitle())
                        .setArtist(track.artist ?: playlist.name)
                        .setAlbumTitle(track.album)
                        .build()
                )
                .build()
        }
        if (items.isEmpty()) {
            message = "None of these tracks can play on the phone."
            return
        }
        val start = playable.indexOfFirst { it.index == index }.coerceAtLeast(0)
        player.setMediaItems(items, start, 0)
        player.prepare()
        player.play()
    }

    fun playPause(onPc: Boolean) {
        if (onPc) return pcCommand("play-pause")
        controller?.let { if (it.isPlaying) it.pause() else it.play() }
    }

    fun next(onPc: Boolean) {
        if (onPc) return pcCommand("next")
        controller?.seekToNext()
    }

    fun previous(onPc: Boolean) {
        if (onPc) return pcCommand("prev")
        controller?.seekToPrevious()
    }

    private fun pcCommand(action: String, playlistName: String? = null) {
        viewModelScope.launch {
            runCatching { container.api.musicCommand(action, playlistName) }
                .onSuccess { message = null }
                .onFailure { message = "The PC didn't take that: ${it.message}" }
        }
    }

    override fun onCleared() {
        // Playback carries on in the service; only this connection to it ends.
        controller?.release()
        super.onCleared()
    }
}

@Composable
fun MusicScreen(onExit: () -> Unit, vm: MusicViewModel = viewModel()) {
    val context = LocalContext.current
    val settings by context.appContainer.sessionStore.settings.collectAsState(initial = null)
    val onPc = settings?.musicOnPc ?: false
    val goBack = { if (vm.open != null) vm.open = null else onExit() }
    BackHandler { goBack() }
    // Playlists are edited on the PC: pick up changes each time the screen opens.
    LaunchedEffect(Unit) { vm.refresh() }

    Column(Modifier.fillMaxSize()) {
        AppTopBar(vm.open?.name ?: "Music", onBack = goBack)
        vm.message?.let { Text(it, color = CC.warn, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        Column(Modifier.weight(1f)) {
            val playlist = vm.open
            if (playlist == null) PlaylistList(vm) else TrackList(playlist, onPc) { index -> vm.play(playlist, index, onPc) }
        }
        MiniPlayer(vm, onPc)
    }
}

@Composable
private fun PlaylistList(vm: MusicViewModel) {
    if (vm.playlists.isEmpty()) {
        Note(if (vm.loading) "Loading…" else "No playlists yet. Make one in the Music app on the PC.")
        return
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        itemsIndexed(vm.playlists, key = { _, playlist -> playlist.name }) { _, playlist ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .neonClickable(TileShape, onClick = { vm.open = playlist })
                    .background(CC.bgPanel, TileShape)
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("♪", color = CC.magenta, modifier = Modifier.width(28.dp))
                Text(playlist.name, color = CC.textPrimary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${playlist.tracks.size} tracks", color = CC.textSecondary, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun TrackList(playlist: MusicPlaylist, onPc: Boolean, onPlay: (Int) -> Unit) {
    LazyColumn(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
        if (onPc) {
            item {
                Text(
                    "Playing on the PC: a playlist starts from its first track.",
                    color = CC.textSecondary,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(8.dp)
                )
            }
        }
        itemsIndexed(playlist.tracks) { index, track ->
            val playable = onPc || track.playable()
            Row(
                Modifier
                    .fillMaxWidth()
                    .then(if (playable) Modifier.neonClickable(ButtonShape, restBorder = CC.line.copy(alpha = 0f), onClick = { onPlay(index) }) else Modifier)
                    .padding(horizontal = 12.dp, vertical = 13.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("${index + 1}", color = CC.textSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(32.dp))
                Column(Modifier.weight(1f)) {
                    Text(track.displayTitle(), color = if (playable) CC.textPrimary else CC.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val byline = listOfNotNull(track.artist, track.album).joinToString(" · ")
                    if (playable && byline.isNotEmpty()) {
                        Text(byline, color = CC.textSecondary, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (!playable) {
                        Text(
                            "${track.extension().uppercase()} files don't play on Android. Play it on the PC instead.",
                            color = CC.textSecondary,
                            style = MaterialTheme.typography.labelSmall
                        )
                    }
                }
            }
        }
    }
}

/** Track, play/pause, next, and the target chip: "♪ on Phone" / "♪ on PC" (design: Music). */
@Composable
private fun MiniPlayer(vm: MusicViewModel, onPc: Boolean) {
    val title = if (onPc) vm.pcPlaylist?.let { "Playlist: $it" } ?: "Controlling the PC's player" else vm.nowTitle ?: "Nothing playing"
    Column(
        Modifier
            .fillMaxWidth()
            .background(CC.bgPanel)
            .padding(start = 16.dp, end = 12.dp, top = 10.dp, bottom = 4.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, color = CC.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!onPc) vm.nowSubtitle?.let { Text(it, color = CC.textSecondary, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            Text(
                if (onPc) "♪ on PC" else "♪ on Phone",
                color = CC.magenta,
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier
                    .padding(start = 8.dp)
                    .neonClickable(ButtonShape, accent = CC.magenta, restBorder = CC.magenta.copy(alpha = 0.5f), onClick = { vm.setOnPc(!onPc) })
                    .padding(horizontal = 10.dp, vertical = 8.dp)
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.previous(onPc) }) {
                Icon(painterResource(R.drawable.ic_skip_back), contentDescription = "Previous", tint = CC.textPrimary)
            }
            IconButton(onClick = { vm.playPause(onPc) }, modifier = Modifier.padding(horizontal = 20.dp)) {
                Icon(
                    painterResource(if (!onPc && vm.isPlaying) R.drawable.ic_pause else R.drawable.ic_play),
                    contentDescription = if (!onPc && vm.isPlaying) "Pause" else "Play",
                    tint = CC.cyan,
                    modifier = Modifier.size(32.dp)
                )
            }
            IconButton(onClick = { vm.next(onPc) }) {
                Icon(painterResource(R.drawable.ic_skip_forward), contentDescription = "Next", tint = CC.textPrimary)
            }
        }
    }
}
