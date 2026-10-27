package com.alexmglesser.controlcenter.mobile.ui.ide

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import com.alexmglesser.controlcenter.mobile.ui.apps.files.FileTransfers
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Copies scripts onto the phone, into Download/scripts. Termux reaches that
 * folder as ~/storage/downloads/scripts once `termux-setup-storage` has been
 * run there, so a downloaded script runs with e.g. `python ~/storage/downloads/scripts/x.py`.
 */
object PhoneScripts {
    val RELATIVE_PATH = "${Environment.DIRECTORY_DOWNLOADS}/scripts/"
    const val TERMUX_PATH = "~/storage/downloads/scripts"

    /**
     * Writes [text] as [name], replacing this app's earlier copy of the same
     * script. A file of that name left by something else (or by a previous
     * install) can't be overwritten, so Android adds a number instead; the
     * returned name says which it was.
     */
    suspend fun save(context: Context, name: String, text: String): String = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val existing: Uri? = resolver.query(
            collection,
            arrayOf(MediaStore.Downloads._ID),
            "${MediaStore.Downloads.DISPLAY_NAME} = ? AND ${MediaStore.Downloads.RELATIVE_PATH} = ?",
            arrayOf(name, RELATIVE_PATH),
            null
        )?.use { cursor -> if (cursor.moveToFirst()) Uri.withAppendedPath(collection, cursor.getLong(0).toString()) else null }

        val uri = existing ?: resolver.insert(collection, ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            // The extension's own type (octet-stream if unknown), so Android keeps the name as given.
            put(MediaStore.Downloads.MIME_TYPE, FileTransfers.mimeType(name))
            put(MediaStore.Downloads.RELATIVE_PATH, RELATIVE_PATH)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }) ?: error("Android refused to create the file.")

        try {
            resolver.openOutputStream(uri, "wt")?.use { it.write(text.toByteArray(Charsets.UTF_8)) } ?: error("Couldn't write the file.")
            if (existing == null) resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        } catch (error: Throwable) {
            if (existing == null) resolver.delete(uri, null, null)
            throw error
        }
        resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)
            ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null } ?: name
    }
}
