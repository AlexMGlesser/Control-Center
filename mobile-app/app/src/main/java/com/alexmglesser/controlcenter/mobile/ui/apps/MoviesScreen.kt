package com.alexmglesser.controlcenter.mobile.ui.apps

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.MovieInfo
import com.alexmglesser.controlcenter.mobile.media.AuthMedia
import com.alexmglesser.controlcenter.mobile.media.MoviePlayerActivity
import com.alexmglesser.controlcenter.mobile.ui.components.AppTopBar
import com.alexmglesser.controlcenter.mobile.ui.components.Note
import com.alexmglesser.controlcenter.mobile.ui.components.RemoteImages
import com.alexmglesser.controlcenter.mobile.ui.components.formatBytes
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable
import kotlinx.coroutines.launch

class MoviesViewModel(application: Application) : AndroidViewModel(application) {
    private val container = application.appContainer

    var movies by mutableStateOf<List<MovieInfo>>(emptyList())
        private set
    var hasFolders by mutableStateOf(true)
        private set
    var loading by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)
        private set

    init {
        refresh()
        viewModelScope.launch {
            container.connection.events.collect { event ->
                if (event.appId == "movie-app" && event.type == "data-changed") refresh()
            }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            loading = true
            runCatching { container.api.movieLibrary() }
                .onSuccess {
                    movies = it.movies
                    hasFolders = it.folders.isNotEmpty()
                    message = null
                }
                .onFailure { message = it.message }
            loading = false
        }
    }

    fun dontWarnAgain() {
        viewModelScope.launch { container.sessionStore.updateSettings { it.copy(warnMobileData = false) } }
    }
}

@Composable
fun MoviesScreen(onExit: () -> Unit, vm: MoviesViewModel = viewModel()) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf<MovieInfo?>(null) }
    BackHandler { onExit() }

    val play: (MovieInfo) -> Unit = { movie ->
        scope.launch {
            val warn = context.appContainer.sessionStore.currentSettings().warnMobileData
            if (warn && onMobileData(context)) confirm = movie else MoviePlayerActivity.start(context, movie)
        }
    }

    Column(Modifier.fillMaxSize()) {
        AppTopBar("Movies", onBack = onExit)
        vm.message?.let { Text(it, color = CC.warn, modifier = Modifier.padding(horizontal = 16.dp)) }
        when {
            vm.movies.isEmpty() && vm.loading -> Note("Loading…")
            vm.movies.isEmpty() && !vm.hasFolders -> Note("Pick a movie folder in the desktop Movie app to make it available here.")
            vm.movies.isEmpty() -> Note("No movies found in your movie folders. Rescan in the desktop Movie app after adding some.")
            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(150.dp),
                contentPadding = PaddingValues(12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                modifier = Modifier.fillMaxSize()
            ) {
                items(vm.movies, key = { it.id }) { movie -> MovieCard(movie) { play(movie) } }
            }
        }
    }

    confirm?.let { movie ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("Stream on mobile data?") },
            text = { Text("About ${formatBytes(movie.size)} for this movie.") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    MoviePlayerActivity.start(context, movie)
                }) { Text("Play") }
            },
            dismissButton = {
                Column(horizontalAlignment = Alignment.End) {
                    TextButton(onClick = {
                        confirm = null
                        vm.dontWarnAgain()
                        MoviePlayerActivity.start(context, movie)
                    }) { Text("Play, don't ask again") }
                    TextButton(onClick = { confirm = null }) { Text("Cancel") }
                }
            },
            shape = TileShape,
            containerColor = CC.bgPanel
        )
    }
}

@Composable
private fun MovieCard(movie: MovieInfo, onClick: () -> Unit) {
    val context = LocalContext.current
    val poster by produceState(RemoteImages.cached(posterKey(movie)), movie.id) {
        if (value != null) return@produceState
        value = if (movie.hasPoster) {
            RemoteImages.poster(context, "/api/apps/movie-app/poster/${movie.id}", posterKey(movie))
        } else {
            val session = context.appContainer.sessionStore.currentSession()
            val url = AuthMedia.url(context, context.appContainer.api.movieStreamPath(movie.id))
            if (session != null && url != null) RemoteImages.movieFrame(context, movie.id, url, session.token) else null
        }
    }
    Column(Modifier.neonClickable(TileShape, onClick = onClick)) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(if (movie.hasPoster) 2f / 3f else 16f / 9f)
                .clip(TileShape)
                .background(CC.bgPanel),
            contentAlignment = Alignment.Center
        ) {
            val bitmap = poster
            if (bitmap != null) {
                Image(bitmap.asImageBitmap(), contentDescription = movie.title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            } else {
                Text("▶", color = CC.cyan, style = MaterialTheme.typography.headlineSmall)
            }
        }
        Text(
            movie.title,
            color = CC.textPrimary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Start,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 6.dp)
        )
    }
}

private fun posterKey(movie: MovieInfo) = if (movie.hasPoster) "poster:${movie.id}" else "frame:${movie.id}"

private fun onMobileData(context: Context): Boolean =
    context.getSystemService(ConnectivityManager::class.java).isActiveNetworkMetered
