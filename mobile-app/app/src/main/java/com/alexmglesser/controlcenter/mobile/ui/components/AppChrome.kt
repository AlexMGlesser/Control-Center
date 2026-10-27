package com.alexmglesser.controlcenter.mobile.ui.components

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.ui.theme.CC

/** The top bar every app screen uses: back arrow, title, actions on the right. */
@Composable
fun AppTopBar(title: String, onBack: () -> Unit, actions: @Composable RowScope.() -> Unit = {}) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(56.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        IconButton(onClick = onBack) {
            Icon(painterResource(R.drawable.ic_arrow_left), contentDescription = "Back", tint = CC.textPrimary)
        }
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            color = CC.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
        actions()
    }
}

/** A one-line note in place of content: loading, empty, or an error. */
@Composable
fun Note(text: String, modifier: Modifier = Modifier, color: Color = CC.textSecondary) {
    Text(text, color = color, style = MaterialTheme.typography.bodyMedium, modifier = modifier.padding(24.dp))
}

/** Bytes as "212 KB". */
fun formatBytes(bytes: Long?): String = when {
    bytes == null -> ""
    bytes < 1024 -> "$bytes B"
    bytes < 1024L * 1024 -> "%.0f KB".format(bytes / 1024.0)
    bytes < 1024L * 1024 * 1024 -> "%.1f MB".format(bytes / 1024.0 / 1024.0)
    else -> "%.1f GB".format(bytes / 1024.0 / 1024.0 / 1024.0)
}
