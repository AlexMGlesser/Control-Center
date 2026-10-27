package com.alexmglesser.controlcenter.mobile.ui.apps.files

import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.PcFile
import com.alexmglesser.controlcenter.mobile.notify.Notifications
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Getting PC files onto the phone (design: File System > Download / Share).
 * The token stays inside this app: files are fetched here, not handed to
 * Android's download manager.
 */
object FileTransfers {
    private var nextId = 30_000

    fun mimeType(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    /** Copies the file into the phone's Downloads folder, with a notification. Runs on after leaving the screen. */
    fun download(context: Context, file: PcFile, onDone: (String) -> Unit) {
        val app = context.applicationContext
        val container = app.appContainer
        val notificationId = nextId++
        Notifications.post(
            app,
            notificationId,
            NotificationCompat.Builder(app, Notifications.CHANNEL_DOWNLOADS)
                .setSmallIcon(R.drawable.ic_folder_tree)
                .setContentTitle("Downloading ${file.name}")
                .setProgress(0, 0, true)
                .setOngoing(true)
                .setSilent(true)
                .build()
        )
        container.appScope.launch {
            val result = runCatching { saveToDownloads(app, file) }
            val done = NotificationCompat.Builder(app, Notifications.CHANNEL_DOWNLOADS)
                .setSmallIcon(R.drawable.ic_folder_tree)
                .setAutoCancel(true)
            result.onSuccess { uri ->
                val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mimeType(file.name)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                done.setContentTitle("Downloaded ${file.name}")
                    .setContentText("In Downloads. Tap to open.")
                    .setContentIntent(PendingIntent.getActivity(app, notificationId, view, PendingIntent.FLAG_IMMUTABLE))
                onDone("Saved ${file.name} to Downloads.")
            }.onFailure { error ->
                done.setContentTitle("Couldn't download ${file.name}").setContentText(error.message)
                onDone("Couldn't download ${file.name}: ${error.message}")
            }
            Notifications.post(app, notificationId, done.build())
        }
    }

    private suspend fun saveToDownloads(context: Context, file: PcFile): Uri = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, file.name)
            put(MediaStore.Downloads.MIME_TYPE, mimeType(file.name))
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("Android refused to create the file.")
        try {
            val temp = File.createTempFile("download", null, context.cacheDir)
            try {
                context.appContainer.api.downloadFile(file.path, temp)
                resolver.openOutputStream(uri)?.use { out -> temp.inputStream().use { it.copyTo(out) } } ?: error("Couldn't write the file.")
            } finally {
                temp.delete()
            }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            uri
        } catch (error: Throwable) {
            resolver.delete(uri, null, null)
            throw error
        }
    }

    /** A copy in the app's cache, for previews (PDF) and sharing. */
    suspend fun cacheCopy(context: Context, file: PcFile): File {
        val folder = File(context.cacheDir, "shared").apply { mkdirs() }
        val target = File(folder, file.name.replace(Regex("[\\\\/:*?\"<>|]"), "_"))
        context.appContainer.api.downloadFile(file.path, target)
        return target
    }

    /** Downloads into the cache, then opens Android's share sheet. */
    suspend fun share(context: Context, file: PcFile) {
        val copy = cacheCopy(context, file)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", copy)
        val send = Intent(Intent.ACTION_SEND)
            .setType(mimeType(file.name))
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(send, "Share ${file.name}").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
