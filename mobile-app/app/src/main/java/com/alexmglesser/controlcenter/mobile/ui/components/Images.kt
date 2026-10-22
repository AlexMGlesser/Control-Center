package com.alexmglesser.controlcenter.mobile.ui.components

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

/** Pinch to zoom, drag to pan; back to fit at 1x. */
@Composable
fun ZoomableBitmap(bitmap: Bitmap, description: String, modifier: Modifier = Modifier) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Image(
        bitmap = bitmap.asImageBitmap(),
        contentDescription = description,
        contentScale = ContentScale.Fit,
        modifier = modifier
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

/**
 * Small images from the PC (movie posters and frames, drawing thumbnails),
 * kept in memory and, for movie frames, on disk: grabbing a frame streams
 * part of the movie, so it's done once.
 */
object RemoteImages {
    private val memory = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    // One frame grab at a time: each one opens a stream to the PC.
    private val frameLock = Mutex()

    fun cached(key: String): Bitmap? = memory.get(key)

    suspend fun poster(context: Context, path: String, key: String): Bitmap? = load(key) {
        val bytes = context.appContainer.api.bytes(path)
        decodeSampled(bytes, 600)
    }

    /** A frame about a minute in, for movies without a poster image. */
    suspend fun movieFrame(context: Context, movieId: String, streamUrl: String, token: String): Bitmap? = load("frame:$movieId") {
        val file = File(context.cacheDir, "movie-frames/$movieId.jpg")
        if (file.exists()) return@load BitmapFactory.decodeFile(file.absolutePath)
        frameLock.withLock {
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(streamUrl, mapOf("Authorization" to "Bearer $token"))
                val frame = retriever.getScaledFrameAtTime(60_000_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 480, 270)
                    ?: retriever.getFrameAtTime(0)
                frame?.also { bitmap ->
                    file.parentFile?.mkdirs()
                    file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 82, it) }
                }
            } finally {
                runCatching { retriever.release() }
            }
        }
    }

    /** A drawing saved by the desktop app: a PNG data URL. */
    suspend fun dataUrl(key: String, dataUrl: String): Bitmap? = load(key) {
        val base64 = dataUrl.substringAfter("base64,", "")
        if (base64.isEmpty()) null else {
            val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            decodeSampled(bytes, 2048)
        }
    }

    private suspend fun load(key: String, block: suspend () -> Bitmap?): Bitmap? {
        memory.get(key)?.let { return it }
        val bitmap = withContext(Dispatchers.IO) { runCatching { block() }.getOrNull() } ?: return null
        memory.put(key, bitmap)
        return bitmap
    }

    fun decodeSampled(bytes: ByteArray, maxSide: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }
}
