package com.alexmglesser.controlcenter.mobile.ui.screens

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.data.api.ChatMessage
import com.alexmglesser.controlcenter.mobile.ui.ChatUiState
import com.alexmglesser.controlcenter.mobile.ui.PendingTurn
import com.alexmglesser.controlcenter.mobile.ui.theme.ButtonShape
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable

private val BubbleShape = RoundedCornerShape(14.dp)

/** Jarvis text chat, the same history as the desktop chatbot tab (design 3.3). */
@Composable
fun ChatScreen(
    state: ChatUiState,
    myDeviceId: String,
    online: Boolean,
    openedChip: String?,
    onSend: (String) -> Unit,
    onChipTap: () -> Unit
) {
    var draft by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    val itemCount = state.messages.size + state.pending.size
    LaunchedEffect(itemCount, state.pending.sumOf { it.toolLines.size }) {
        if (itemCount > 0) listState.animateScrollToItem(itemCount - 1)
    }

    Column(
        Modifier
            .fillMaxSize()
            .imePadding()
    ) {
        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentAlignment = Alignment.TopCenter
        ) {
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxSize()
                    .widthIn(max = 640.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp)
            ) {
                if (state.messages.isEmpty() && state.pending.isEmpty()) {
                    item {
                        Text("Ask Jarvis anything. This is the same conversation as on the PC.", color = CC.textSecondary)
                    }
                }
                items(state.messages, key = { "m${it.id}" }) { message -> MessageBubble(message, myDeviceId) }
                items(state.pending, key = { "p${it.turnId}" }) { pending -> PendingBubble(pending, state.queuedAhead) }
                openedChip?.let { name ->
                    item {
                        Text(
                            "Opened $name ›",
                            color = CC.cyan,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .border(1.dp, CC.line, ButtonShape)
                                .clickable(onClick = onChipTap)
                                .padding(horizontal = 12.dp, vertical = 6.dp)
                        )
                    }
                }
            }
        }
        state.error?.let { Text(it, color = CC.red, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp)) }
        Row(
            Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text("Message Jarvis…") },
                maxLines = 4,
                modifier = Modifier.weight(1f),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = CC.cyan,
                    unfocusedBorderColor = CC.line,
                    cursorColor = CC.cyan
                )
            )
            val canSend = draft.isNotBlank() && online && !state.sending
            Box(
                Modifier
                    .size(52.dp)
                    .then(
                        if (canSend) Modifier.neonClickable(ButtonShape, haptic = true) {
                            onSend(draft)
                            draft = ""
                        } else Modifier
                    )
                    .background(if (canSend) CC.cyan.copy(alpha = 0.14f) else Color.Transparent, ButtonShape)
                    .alpha(if (canSend) 1f else 0.4f),
                contentAlignment = Alignment.Center
            ) {
                Icon(painterResource(R.drawable.ic_send), contentDescription = "Send", tint = CC.cyan)
            }
        }
    }
}

@Composable
private fun MessageBubble(message: ChatMessage, myDeviceId: String) {
    val fromUser = message.role == "user"
    val accent = if (fromUser) CC.cyan else CC.magenta
    val label = when {
        !fromUser -> "Jarvis"
        message.device?.id == myDeviceId -> "from this phone"
        message.device?.kind == "phone" || message.device?.kind == "laptop" -> "from ${message.device.name.ifBlank { "another device" }}"
        else -> "from PC"
    }
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = if (fromUser) Alignment.End else Alignment.Start
    ) {
        Box(
            Modifier
                .widthIn(max = 520.dp)
                .border(1.dp, accent.copy(alpha = 0.6f), BubbleShape)
                .background(CC.bgPanel, BubbleShape)
                .padding(horizontal = 14.dp, vertical = 10.dp)
        ) {
            Text(message.text, color = CC.textPrimary)
        }
        Text(label, style = MaterialTheme.typography.labelSmall, color = CC.textSecondary, modifier = Modifier.padding(top = 2.dp, start = 4.dp, end = 4.dp))
    }
}

@Composable
private fun PendingBubble(pending: PendingTurn, queuedAhead: Int) {
    var expanded by rememberSaveable(pending.turnId) { mutableStateOf(false) }
    val pulse = rememberInfiniteTransition(label = "thinking")
    val dotAlpha by pulse.animateFloat(0.3f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "dots")
    Column(
        Modifier
            .widthIn(max = 520.dp)
            .border(1.dp, CC.magenta.copy(alpha = 0.4f), BubbleShape)
            .background(CC.bgPanel, BubbleShape)
            .clickable(enabled = pending.toolLines.isNotEmpty()) { expanded = !expanded }
            .padding(horizontal = 14.dp, vertical = 10.dp)
            .animateContentSize()
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("● ● ●", color = CC.magenta, modifier = Modifier.alpha(dotAlpha))
            Spacer(Modifier.width(8.dp))
            Text(
                if (queuedAhead > 0 && pending.toolLines.isEmpty()) "Queued ($queuedAhead ahead)" else "thinking",
                color = CC.textSecondary,
                style = MaterialTheme.typography.bodySmall
            )
        }
        if (pending.toolLines.isNotEmpty()) {
            val lines = if (expanded) pending.toolLines else listOf(pending.toolLines.last())
            lines.forEach { tool ->
                Text("· used $tool", style = MaterialTheme.typography.labelSmall, color = CC.textSecondary)
            }
        }
    }
}
