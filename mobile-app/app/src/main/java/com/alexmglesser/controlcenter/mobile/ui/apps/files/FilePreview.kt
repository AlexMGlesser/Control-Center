package com.alexmglesser.controlcenter.mobile.ui.apps.files

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.graphics.createBitmap
import androidx.core.net.toUri
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.PcFile
import com.alexmglesser.controlcenter.mobile.ui.components.AppTopBar
import com.alexmglesser.controlcenter.mobile.ui.components.NeonButton
import com.alexmglesser.controlcenter.mobile.ui.components.Note
import com.alexmglesser.controlcenter.mobile.ui.components.formatBytes
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

private const val TEXT_PREVIEW_BYTES = 512 * 1024
private const val IMAGE_MAX_BYTES = 40 * 1024 * 1024

/** A file opened from File System: the right viewer for its kind, plus Download and Share. */
@Composable
fun FilePreview(file: PcFile, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var note by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxSize()) {
        AppTopBar(file.name, onBack = onBack) {
            TextButton(onClick = {
                FileTransfers.download(context, file) { note = it }
                note = "Downloading ${file.name}…"
            }) { Text("Download", color = CC.cyan) }
            TextButton(onClick = {
                note = "Preparing ${file.name}…"
                scope.launch {
                    runCatching { FileTransfers.share(context, file) }
                        .onSuccess { note = null }
                        .onFailure { note = "Couldn't share: ${it.message}" }
                }
            }) { Text("Share", color = CC.cyan) }
        }
        note?.let { Text(it, color = CC.textSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (file.kind) {
                "text" -> TextPreview(file)
                "image" -> ImagePreview(file)
                "pdf" -> PdfPreview(file)
                "audio", "video" -> MediaPreview(file)
                else -> InfoPreview(file) { FileTransfers.download(context, file) { note = it } }
            }
        }
    }
}

@Composable
private fun TextPreview(file: PcFile) {
    val context = LocalContext.current
    val lines by produceState<List<String>?>(null, file.path) {
        value = runCatching {
            val bytes = context.appContainer.api.fileHead(file.path, TEXT_PREVIEW_BYTES)
            if (bytes.take(8192).any { it == 0.toByte() }) listOf("This file isn't text. Use Download to open it in another app.")
            else bytes.toString(Charsets.UTF_8).lines()
        }.getOrElse { listOf("Couldn't load: ${it.message}") }
    }
    val loaded = lines ?: return Note("Loading…")
    val truncated = (file.size ?: 0) > TEXT_PREVIEW_BYTES
    SelectionContainer {
        LazyColumn(
            Modifier
                .fillMaxSize()
                .horizontalScroll(rememberScrollState()),
            contentPadding = PaddingValues(12.dp)
        ) {
            if (truncated) item { Text("Showing the first 512 KB.", color = CC.warn, style = MaterialTheme.typography.bodySmall) }
            items(loaded.size) { index ->
                Text(loaded[index], color = CC.textPrimary, fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 19.sp, softWrap = false)
            }
        }
    }
}

@Composable
private fun ImagePreview(file: PcFile) {
    val context = LocalContext.current
    val maxSide = LocalWindowInfo.current.containerSize.let { maxOf(it.width, it.height) }
    val bitmap by produceState<Result<Bitmap>?>(null, file.path) {
        value = runCatching {
            if ((file.size ?: 0) > IMAGE_MAX_BYTES) error("This image is too big to preview. Use Download.")
            val bytes = context.appContainer.api.fileHead(file.path, IMAGE_MAX_BYTES)
            withContext(Dispatchers.Default) { decodeSampled(bytes, maxSide * 2) } ?: error("Android can't show this image type. Use Download.")
        }
    }
    val result = bitmap ?: return Note("Loading…")
    val image = result.getOrElse { return Note(it.message ?: "Couldn't load the image.") }

    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Image(
        bitmap = image.asImageBitmap(),
        contentDescription = file.name,
        contentScale = ContentScale.Fit,
        modifier = Modifier
            .fillMaxSize()
            .background(CC.bgPrimary)
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 8f)
                    offset = if (scale == 1f) Offset.Zero else offset + pan
                }
            }
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationX = offset.x
                translationY = offset.y
            }
    )
}

private fun decodeSampled(bytes: ByteArray, maxSide: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
}

/** Android's own PDF renderer, one page at a time as they scroll into view. */
@Composable
private fun PdfPreview(file: PcFile) {
    val context = LocalContext.current
    val widthPx = LocalWindowInfo.current.containerSize.width
    val renderer by produceState<Result<PdfRenderer>?>(null, file.path) {
        value = runCatching {
            val copy: File = FileTransfers.cacheCopy(context, file)
            PdfRenderer(ParcelFileDescriptor.open(copy, ParcelFileDescriptor.MODE_READ_ONLY))
        }
    }
    val result = renderer ?: return Note("Loading…")
    val pdf = result.getOrElse { return Note("Couldn't open this PDF: ${it.message}") }
    DisposableEffect(pdf) { onDispose { runCatching { pdf.close() } } }
    // PdfRenderer allows one open page at a time.
    val lock = remember(pdf) { Mutex() }

    LazyColumn(
        Modifier.fillMaxSize().background(CC.bgPrimary),
        contentPadding = PaddingValues(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        items(pdf.pageCount) { index ->
            val page by produceState<Bitmap?>(null, pdf, index) {
                value = withContext(Dispatchers.IO) {
                    lock.withLock {
                        runCatching {
                            pdf.openPage(index).use { p ->
                                val width = widthPx.coerceAtMost(2000)
                                val bitmap = createBitmap(width, (width * p.height.toFloat() / p.width).toInt())
                                bitmap.eraseColor(AndroidColor.WHITE)
                                p.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                                bitmap
                            }
                        }.getOrNull()
                    }
                }
            }
            val bitmap = page
            if (bitmap == null) {
                Box(Modifier.fillMaxWidth().aspectRatio(0.77f).background(CC.bgPanel))
            } else {
                Image(bitmap.asImageBitmap(), contentDescription = "Page ${index + 1}", modifier = Modifier.fillMaxWidth(), contentScale = ContentScale.FillWidth)
            }
        }
    }
}

/** Streams audio or video straight from the PC (Range requests, so seeking works). */
@Composable
private fun MediaPreview(file: PcFile) {
    val context = LocalContext.current
    val container = context.appContainer
    val session = container.sessionStore.currentSession() ?: return Note("Not paired.")
    val uri = (session.baseUrl + container.api.fileContentPath(file.path)).toUri()
    val headers = mapOf("Authorization" to "Bearer ${session.token}")
    var error by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxSize().background(CC.bgPrimary), horizontalAlignment = Alignment.CenterHorizontally) {
        error?.let { Text(it, color = CC.warn, modifier = Modifier.padding(16.dp)) }
        if (file.kind == "audio") Text("♪  ${file.name}", color = CC.textPrimary, modifier = Modifier.padding(24.dp))
        AndroidView(
            factory = { ctx ->
                VideoView(ctx).apply {
                    val controls = MediaController(ctx)
                    controls.setAnchorView(this)
                    setMediaController(controls)
                    setOnPreparedListener {
                        start()
                        controls.show(3000)
                    }
                    setOnErrorListener { _, _, _ ->
                        error = "The phone can't play this format. Use Download and open it in another player."
                        true
                    }
                    setVideoURI(uri, headers)
                }
            },
            onRelease = { it.stopPlayback() },
            modifier = if (file.kind == "audio") Modifier.fillMaxWidth().height(120.dp) else Modifier.fillMaxSize()
        )
    }
}

@Composable
private fun InfoPreview(file: PcFile, onDownload: () -> Unit) {
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("No preview for this kind of file.", color = CC.textPrimary)
        Text(listOfNotNull(formatBytes(file.size).ifEmpty { null }, file.modified?.let { "Modified ${longDate(it)}" }).joinToString(" · "), color = CC.textSecondary)
        Text(file.path, color = CC.textSecondary, style = MaterialTheme.typography.bodySmall)
        NeonButton("Download", onClick = onDownload, primary = true, modifier = Modifier.padding(top = 12.dp))
    }
}
