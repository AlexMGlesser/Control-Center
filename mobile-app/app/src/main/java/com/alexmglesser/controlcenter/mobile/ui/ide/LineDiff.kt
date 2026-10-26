package com.alexmglesser.controlcenter.mobile.ui.ide

/** One row of a diff: unchanged, removed (old file only) or added (new file only). */
data class DiffLine(val kind: Kind, val text: String, val oldNumber: Int?, val newNumber: Int?) {
    enum class Kind { SAME, REMOVED, ADDED }
}

/** A run of rows to show, or a fold of unchanged lines between them. */
sealed interface DiffRow {
    data class Line(val line: DiffLine) : DiffRow
    data class Fold(val count: Int) : DiffRow
}

private const val MAX_LCS_CELLS = 4_000_000

/**
 * Line diff of two texts. Common lines at the start and end are matched
 * first, so a typical edit leaves a small middle for the LCS table; if the
 * middle is still huge it's shown as all-removed then all-added.
 */
fun diffLines(oldText: String, newText: String): List<DiffLine> {
    val a = oldText.removeSuffix("\n").replace("\r\n", "\n").split('\n')
    val b = newText.removeSuffix("\n").replace("\r\n", "\n").split('\n')
    var prefix = 0
    while (prefix < a.size && prefix < b.size && a[prefix] == b[prefix]) prefix++
    var suffix = 0
    while (suffix < a.size - prefix && suffix < b.size - prefix && a[a.size - 1 - suffix] == b[b.size - 1 - suffix]) suffix++

    val result = ArrayList<DiffLine>(a.size + b.size)
    for (k in 0 until prefix) result += DiffLine(DiffLine.Kind.SAME, a[k], k + 1, k + 1)

    val midA = a.subList(prefix, a.size - suffix)
    val midB = b.subList(prefix, b.size - suffix)
    if (midA.size.toLong() * midB.size > MAX_LCS_CELLS) {
        midA.forEachIndexed { k, line -> result += DiffLine(DiffLine.Kind.REMOVED, line, prefix + k + 1, null) }
        midB.forEachIndexed { k, line -> result += DiffLine(DiffLine.Kind.ADDED, line, null, prefix + k + 1) }
    } else {
        // lcs[i][j] = longest common subsequence of midA[i..] and midB[j..].
        val lcs = Array(midA.size + 1) { IntArray(midB.size + 1) }
        for (i in midA.size - 1 downTo 0) for (j in midB.size - 1 downTo 0) {
            lcs[i][j] = if (midA[i] == midB[j]) lcs[i + 1][j + 1] + 1 else maxOf(lcs[i + 1][j], lcs[i][j + 1])
        }
        var i = 0
        var j = 0
        while (i < midA.size || j < midB.size) {
            when {
                i < midA.size && j < midB.size && midA[i] == midB[j] -> {
                    result += DiffLine(DiffLine.Kind.SAME, midA[i], prefix + i + 1, prefix + j + 1); i++; j++
                }
                // Removed lines before added ones, as VS Code shows them.
                i < midA.size && (j == midB.size || lcs[i + 1][j] >= lcs[i][j + 1]) -> {
                    result += DiffLine(DiffLine.Kind.REMOVED, midA[i], prefix + i + 1, null); i++
                }
                else -> {
                    result += DiffLine(DiffLine.Kind.ADDED, midB[j], null, prefix + j + 1); j++
                }
            }
        }
    }

    for (k in 0 until suffix) {
        result += DiffLine(DiffLine.Kind.SAME, a[a.size - suffix + k], a.size - suffix + k + 1, b.size - suffix + k + 1)
    }
    return result
}

/** Changed lines with [context] unchanged lines around them; longer unchanged runs fold. */
fun foldDiff(lines: List<DiffLine>, context: Int = 2): List<DiffRow> {
    val keep = BooleanArray(lines.size)
    lines.forEachIndexed { index, line ->
        if (line.kind != DiffLine.Kind.SAME) {
            for (k in maxOf(0, index - context)..minOf(lines.size - 1, index + context)) keep[k] = true
        }
    }
    val rows = ArrayList<DiffRow>()
    var folded = 0
    lines.forEachIndexed { index, line ->
        if (keep[index]) {
            if (folded > 0) rows += DiffRow.Fold(folded)
            folded = 0
            rows += DiffRow.Line(line)
        } else folded++
    }
    if (folded > 0) rows += DiffRow.Fold(folded)
    return rows
}
