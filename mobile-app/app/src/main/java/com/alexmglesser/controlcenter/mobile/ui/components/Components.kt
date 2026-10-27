package com.alexmglesser.controlcenter.mobile.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.data.events.ConnectionState
import com.alexmglesser.controlcenter.mobile.ui.theme.ButtonShape
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable

/** Lucide icon by name (registry `icon` field), falling back to the app id, then a generic window. */
@DrawableRes
fun appIconRes(appId: String, iconName: String?): Int {
    val byName = when (iconName) {
        "calendar-days" -> R.drawable.ic_calendar_days
        "newspaper" -> R.drawable.ic_newspaper
        "briefcase" -> R.drawable.ic_briefcase
        "folder-git-2" -> R.drawable.ic_folder_git_2
        "music" -> R.drawable.ic_music
        "pen-tool" -> R.drawable.ic_pen_tool
        "clapperboard" -> R.drawable.ic_clapperboard
        "server" -> R.drawable.ic_server
        "book-open-text" -> R.drawable.ic_book_open_text
        "folder-tree" -> R.drawable.ic_folder_tree
        "terminal" -> R.drawable.ic_terminal
        "code-xml" -> R.drawable.ic_code_xml
        else -> null
    }
    return byName ?: when (appId) {
        "calendar-app" -> R.drawable.ic_calendar_days
        "news-app" -> R.drawable.ic_newspaper
        "project-app" -> R.drawable.ic_folder_git_2
        "music-app" -> R.drawable.ic_music
        "drawing-app" -> R.drawable.ic_pen_tool
        "movie-app" -> R.drawable.ic_clapperboard
        "server-manager-app" -> R.drawable.ic_server
        "wikipedia-app" -> R.drawable.ic_book_open_text
        "file-system-app" -> R.drawable.ic_folder_tree
        else -> R.drawable.ic_app_window
    }
}

/** Registry names end in " App"; the grid shows the short name. */
fun shortAppName(name: String): String = name.removeSuffix(" App").ifBlank { name }

private data class PillStyle(val label: String, val color: Color)

private fun pillStyle(state: ConnectionState): PillStyle = when (state) {
    is ConnectionState.Connected -> PillStyle("Online", CC.ok)
    is ConnectionState.Connecting, is ConnectionState.Reconnecting -> PillStyle("Reconnecting", CC.warn)
    is ConnectionState.Disconnected, ConnectionState.Idle, ConnectionState.Unauthorized -> PillStyle("Offline", CC.red)
}

/** Status is never color alone: the pill always has a word (design 7). */
@Composable
fun StatusPill(state: ConnectionState, modifier: Modifier = Modifier) {
    val style = pillStyle(state)
    Row(
        modifier = modifier
            .clip(ButtonShape)
            .background(CC.bgPanel)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(style.color)
        )
        Spacer(Modifier.width(6.dp))
        Text(style.label.uppercase(), style = MaterialTheme.typography.labelSmall, color = style.color)
    }
}

/** Thin amber bar while reconnecting; a red banner with the cause when offline (design 5). */
@Composable
fun ConnectionBanner(state: ConnectionState, serverName: String, onRetry: () -> Unit) {
    AnimatedVisibility(
        visible = state is ConnectionState.Reconnecting || state is ConnectionState.Connecting,
        enter = fadeIn(),
        exit = fadeOut()
    ) {
        LinearProgressIndicator(
            modifier = Modifier
                .fillMaxWidth()
                .height(2.dp),
            color = CC.warn,
            trackColor = Color.Transparent
        )
    }
    AnimatedVisibility(
        visible = state is ConnectionState.Disconnected,
        enter = expandVertically() + fadeIn(),
        exit = shrinkVertically() + fadeOut()
    ) {
        val cause = (state as? ConnectionState.Disconnected)?.cause?.describe(serverName) ?: ""
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(CC.red.copy(alpha = 0.15f))
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Icon(painterResource(R.drawable.ic_wifi_off), contentDescription = null, tint = CC.red, modifier = Modifier.size(20.dp))
            Text(cause, style = MaterialTheme.typography.bodySmall, color = CC.textPrimary, modifier = Modifier.weight(1f))
            NeonButton("Retry", onClick = onRetry, accent = CC.red)
        }
    }
}

/** Chamfered button with the neon press feedback. */
@Composable
fun NeonButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    accent: Color = CC.cyan,
    primary: Boolean = false,
    enabled: Boolean = true
) {
    val color = if (enabled) accent else CC.textSecondary
    Box(
        modifier = modifier
            .then(
                if (enabled) Modifier.neonClickable(ButtonShape, accent = color, restBorder = color.copy(alpha = 0.55f), haptic = primary, onClick = onClick)
                else Modifier
            )
            .background(if (primary && enabled) color.copy(alpha = 0.14f) else Color.Transparent, ButtonShape)
            .padding(horizontal = 18.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(text, color = color, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
    }
}

/** Section header in Settings-style lists. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = CC.cyan,
        modifier = modifier.padding(top = 20.dp, bottom = 6.dp)
    )
}
