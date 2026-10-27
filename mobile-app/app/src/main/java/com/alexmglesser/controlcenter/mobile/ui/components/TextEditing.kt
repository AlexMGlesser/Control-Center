package com.alexmglesser.controlcenter.mobile.ui.components

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue

/**
 * Typing in the code editors (Projects and the IDE), plus auto-indent: a new
 * line starts with the previous line's indentation. With [indentAfterOpener],
 * a line ending in `:`, `{`, `(` or `[` indents the next one a level further.
 */
fun withAutoIndent(previous: TextFieldValue, next: TextFieldValue, indentAfterOpener: Boolean = false): TextFieldValue {
    val cursor = next.selection.start
    val typedNewline = next.selection.collapsed &&
        next.text.length == previous.text.length + 1 &&
        cursor > 0 && next.text[cursor - 1] == '\n' &&
        next.text.regionMatches(0, previous.text, 0, cursor - 1) &&
        next.text.regionMatches(cursor, previous.text, cursor - 1, previous.text.length - cursor + 1)
    if (!typedNewline) return next
    val lineStart = next.text.lastIndexOf('\n', cursor - 2) + 1
    val line = next.text.substring(lineStart, cursor - 1)
    var indent = line.takeWhile { it == ' ' || it == '\t' }
    if (indentAfterOpener && line.trimEnd().lastOrNull() in OPENERS) indent += INDENT
    if (indent.isEmpty()) return next
    return TextFieldValue(next.text.substring(0, cursor) + indent + next.text.substring(cursor), TextRange(cursor + indent.length))
}

/** Replaces the selection (or inserts at the cursor), for the symbol row above the keyboard. */
fun insertAtCursor(value: TextFieldValue, snippet: String): TextFieldValue {
    val start = minOf(value.selection.start, value.selection.end)
    val end = maxOf(value.selection.start, value.selection.end)
    return TextFieldValue(value.text.replaceRange(start, end, snippet), TextRange(start + snippet.length))
}

const val INDENT = "    "
private val OPENERS = setOf(':', '{', '(', '[')
