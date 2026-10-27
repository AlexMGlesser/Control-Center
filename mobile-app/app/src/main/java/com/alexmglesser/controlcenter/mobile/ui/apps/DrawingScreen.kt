package com.alexmglesser.controlcenter.mobile.ui.apps

import android.app.Application
import android.graphics.Bitmap
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.DrawingSummary
import com.alexmglesser.controlcenter.mobile.ui.components.AppTopBar
import com.alexmglesser.controlcenter.mobile.ui.components.Note
import com.alexmglesser.controlcenter.mobile.ui.components.RemoteImages
import com.alexmglesser.controlcenter.mobile.ui.components.ZoomableBitmap
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

class DrawingViewModel(application: Application) : AndroidViewModel(application) {
    private val container = application.appContainer

    var drawings by mutableStateOf<List<DrawingSummary>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)
        private set
    var open by mutableStateOf<DrawingSummary?>(null)

    /** Called each time the screen opens: drawings are made on the PC. */
    fun refresh() {
        viewModelScope.launch {
            loading = true
            runCatching { container.api.drawings() }
                .onSuccess {
                    drawings = it
                    message = null
                }
                .onFailure { message = it.message }
            loading = false
        }
    }

    /** A 2D drawing's picture. 3D scenes have none: they're only viewable on the PC. */
    suspend fun image(drawing: DrawingSummary): Bitmap? {
        if (drawing.mode != "2d") return null
        val key = "drawing:${drawing.id}:${drawing.updatedAt}"
        RemoteImages.cached(key)?.let { return it }
        val file = runCatching { container.api.drawing(drawing.id) }.getOrNull() ?: return null
        return file.content.imageDataUrl?.let { RemoteImages.dataUrl(key, it) }
    }
}

/** View-only drawings (design: Drawing). */
@Composable
fun DrawingScreen(onExit: () -> Unit, vm: DrawingViewModel = viewModel()) {
    val goBack = { if (vm.open != null) vm.open = null else onExit() }
    BackHandler { goBack() }
    LaunchedEffect(Unit) { vm.refresh() }

    val open = vm.open
    Column(Modifier.fillMaxSize()) {
        AppTopBar(open?.name ?: "Drawing", onBack = goBack)
        if (open != null) {
            val bitmap by produceState<Bitmap?>(null, open.id) { value = vm.image(open) }
            val image = bitmap
            if (image == null) Note("Loading…") else ZoomableBitmap(image, open.name, Modifier.background(Color.White))
            return@Column
        }
        vm.message?.let { Text(it, color = CC.warn, modifier = Modifier.padding(horizontal = 16.dp)) }
        if (vm.drawings.isEmpty()) {
            Note(if (vm.loading) "Loading…" else "No drawings yet. Make one in the Drawing app on the PC.")
            return@Column
        }
        LazyVerticalGrid(
            columns = GridCells.Adaptive(160.dp),
            contentPadding = PaddingValues(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            items(vm.drawings, key = { it.id }) { drawing -> DrawingCard(drawing, vm) }
        }
    }
}

@Composable
private fun DrawingCard(drawing: DrawingSummary, vm: DrawingViewModel) {
    val is2d = drawing.mode == "2d"
    val thumbnail by produceState<Bitmap?>(null, drawing.id, drawing.updatedAt) { value = vm.image(drawing) }
    Column(Modifier.then(if (is2d) Modifier.neonClickable(TileShape, onClick = { vm.open = drawing }) else Modifier)) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(4f / 3f)
                .clip(TileShape)
                .background(if (is2d) Color.White else CC.bgPanel),
            contentAlignment = Alignment.Center
        ) {
            val image = thumbnail
            when {
                image != null -> Image(image.asImageBitmap(), contentDescription = drawing.name, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                !is2d -> Text("3D scene\nOpen it on the PC", color = CC.textSecondary, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall)
            }
        }
        Text(drawing.name, color = CC.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp, top = 6.dp))
        Text(updated(drawing.updatedAt), color = CC.textSecondary, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(start = 6.dp))
    }
}

private fun updated(iso: String): String = runCatching {
    Instant.parse(iso).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
}.getOrDefault("")
