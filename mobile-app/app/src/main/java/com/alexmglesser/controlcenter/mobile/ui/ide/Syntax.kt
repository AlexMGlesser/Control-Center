package com.alexmglesser.controlcenter.mobile.ui.ide

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation

/**
 * VS Code's look: the Dark Modern workbench with Dark+ syntax colors. The
 * IDE uses these instead of the app's neon theme, on purpose.
 */
object VS {
    val editorBg = Color(0xFF1F1F1F)
    val sideBg = Color(0xFF181818)
    val panelBg = Color(0xFF181818)
    val border = Color(0xFF2B2B2B)
    val tabInactive = Color(0xFF181818)
    val tabActive = Color(0xFF1F1F1F)
    val hover = Color(0xFF2A2D2E)
    val selectedRow = Color(0xFF37373D)
    val currentLine = Color(0xFF282828)
    val text = Color(0xFFCCCCCC)
    val textBright = Color(0xFFE7E7E7)
    val textDim = Color(0xFF9D9D9D)
    val lineNumber = Color(0xFF6E7681)
    val lineNumberActive = Color(0xFFCCCCCC)
    val accent = Color(0xFF0078D4)
    val statusBar = Color(0xFF007ACC)
    val inputBg = Color(0xFF313131)
    val modified = Color(0xFFE2C08D)
    val error = Color(0xFFF85149)
    val diffAdded = Color(0x3328A745)
    val diffRemoved = Color(0x33F85149)
    val diffAddedText = Color(0xFF81B88B)
    val diffRemovedText = Color(0xFFF14C4C)

    // Dark+ token colors.
    val keyword = Color(0xFF569CD6)
    val control = Color(0xFFC586C0)
    val string = Color(0xFFCE9178)
    val comment = Color(0xFF6A9955)
    val number = Color(0xFFB5CEA8)
    val function = Color(0xFFDCDCAA)
    val type = Color(0xFF4EC9B0)
    val variable = Color(0xFF9CDCFE)
    val plain = Color(0xFFD4D4D4)
}

/** What the highlighter needs to know about a language. */
class Language(
    val name: String,
    val lineComment: String? = null,
    val blockComment: Pair<String, String>? = null,
    val keywords: Set<String> = emptySet(),
    val controlKeywords: Set<String> = emptySet(),
    val constants: Set<String> = emptySet(),
    val tripleQuotes: Boolean = false,
    /** `$name` variables (shell, PowerShell). */
    val dollarVariables: Boolean = false,
    /** JSON: keys (strings before `:`) get the variable color. */
    val jsonKeys: Boolean = false,
    val caseInsensitive: Boolean = false
)

private val C_CONTROL = setOf("if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "try", "catch", "finally", "throw", "goto")

private val PYTHON = Language(
    "Python", lineComment = "#", tripleQuotes = true,
    keywords = setOf("def", "class", "lambda", "global", "nonlocal", "and", "or", "not", "in", "is", "as", "async", "await", "del", "pass", "assert"),
    controlKeywords = setOf("if", "elif", "else", "for", "while", "break", "continue", "return", "try", "except", "finally", "raise", "with", "yield", "import", "from", "match", "case"),
    constants = setOf("True", "False", "None", "self", "cls")
)
private val JAVASCRIPT = Language(
    "JavaScript", lineComment = "//", blockComment = "/*" to "*/",
    keywords = setOf("var", "let", "const", "function", "class", "extends", "new", "typeof", "instanceof", "in", "of", "async", "await", "delete", "void", "this", "super", "static", "get", "set", "interface", "type", "enum", "implements", "public", "private", "protected", "readonly", "declare", "namespace"),
    controlKeywords = C_CONTROL + setOf("import", "export", "from", "as", "yield"),
    constants = setOf("true", "false", "null", "undefined", "NaN", "Infinity")
)
private val C_LIKE = Language(
    "C", lineComment = "//", blockComment = "/*" to "*/",
    keywords = setOf("int", "long", "short", "char", "float", "double", "void", "bool", "boolean", "byte", "unsigned", "signed", "struct", "union", "enum", "const", "static", "extern", "class", "interface", "public", "private", "protected", "internal", "new", "this", "super", "virtual", "override", "abstract", "final", "sealed", "namespace", "using", "package", "fun", "val", "var", "object", "data", "func", "go", "chan", "map", "fn", "let", "mut", "impl", "trait", "pub", "use", "mod", "crate", "string", "auto", "sizeof", "typedef", "template", "typename", "in", "is", "as"),
    controlKeywords = C_CONTROL + setOf("import", "include", "when", "match", "defer", "select", "loop", "yield"),
    constants = setOf("true", "false", "null", "nullptr", "nil", "NULL")
)
private val SHELL = Language(
    "Shell", lineComment = "#", dollarVariables = true,
    keywords = setOf("function", "local", "export", "readonly", "declare", "echo", "cd", "source", "set", "unset"),
    controlKeywords = setOf("if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "return", "exit", "break", "continue"),
    constants = setOf("true", "false")
)
private val POWERSHELL = Language(
    "PowerShell", lineComment = "#", blockComment = "<#" to "#>", dollarVariables = true, caseInsensitive = true,
    keywords = setOf("function", "param", "begin", "process", "end", "filter", "class", "enum", "using", "-eq", "-ne", "-gt", "-lt", "-ge", "-le", "-like", "-match", "-and", "-or", "-not"),
    controlKeywords = setOf("if", "elseif", "else", "foreach", "for", "while", "do", "until", "switch", "return", "break", "continue", "try", "catch", "finally", "throw", "exit", "in"),
    constants = setOf("\$true", "\$false", "\$null")
)
private val JSON_LANG = Language("JSON", jsonKeys = true, constants = setOf("true", "false", "null"))
private val CSS = Language("CSS", blockComment = "/*" to "*/", keywords = setOf("important", "media", "import", "keyframes", "root"))
private val HTML = Language("HTML", blockComment = "<!--" to "-->")
private val YAML = Language("YAML", lineComment = "#", constants = setOf("true", "false", "null", "yes", "no", "on", "off"))
private val BATCH = Language("Batch", lineComment = "::", keywords = setOf("echo", "set", "call", "goto", "setlocal", "endlocal", "rem", "pause"), controlKeywords = setOf("if", "else", "for", "do", "in", "exit", "not", "exist"), caseInsensitive = true)
val PLAIN_TEXT = Language("Plain Text")

fun languageFor(fileName: String): Language = when (fileName.substringAfterLast('.', "").lowercase()) {
    "py", "pyw" -> PYTHON
    "js", "mjs", "cjs", "jsx", "ts", "tsx" -> JAVASCRIPT.copyNamed(if (fileName.endsWith("ts") || fileName.endsWith("tsx")) "TypeScript" else "JavaScript")
    "c", "h", "cpp", "hpp", "cc", "cs", "java", "kt", "kts", "go", "rs", "swift", "dart", "scala" -> C_LIKE.copyNamed(languageName(fileName))
    "sh", "bash", "zsh" -> SHELL
    "ps1", "psm1", "psd1" -> POWERSHELL
    "json", "jsonc" -> JSON_LANG
    "css", "scss" -> CSS
    "html", "htm", "xml", "svg" -> HTML.copyNamed(if (fileName.endsWith("ml") && !fileName.endsWith("html")) "XML" else "HTML")
    "yml", "yaml", "toml", "ini", "cfg" -> YAML.copyNamed(if (fileName.endsWith("toml")) "TOML" else if (fileName.endsWith("yml") || fileName.endsWith("yaml")) "YAML" else "Ini")
    "bat", "cmd" -> BATCH
    "md" -> PLAIN_TEXT.copyNamed("Markdown")
    else -> PLAIN_TEXT
}

private fun languageName(fileName: String): String = when (fileName.substringAfterLast('.').lowercase()) {
    "c", "h" -> "C"
    "cpp", "hpp", "cc" -> "C++"
    "cs" -> "C#"
    "java" -> "Java"
    "kt", "kts" -> "Kotlin"
    "go" -> "Go"
    "rs" -> "Rust"
    "swift" -> "Swift"
    "dart" -> "Dart"
    else -> "Scala"
}

private fun Language.copyNamed(newName: String) = Language(
    newName, lineComment, blockComment, keywords, controlKeywords, constants, tripleQuotes, dollarVariables, jsonKeys, caseInsensitive
)

/**
 * A small one-pass tokenizer: comments, strings, numbers, keywords, function
 * calls and capitalized type names. Not a parser, but enough to read code
 * the way VS Code colors it.
 */
fun highlight(text: String, language: Language): AnnotatedString {
    val builder = AnnotatedString.Builder(text)
    if (language === PLAIN_TEXT || language.name == "Markdown") return builder.toAnnotatedString()
    fun span(color: Color, start: Int, end: Int, italic: Boolean = false) {
        if (end > start) builder.addStyle(SpanStyle(color = color, fontStyle = if (italic) FontStyle.Italic else null), start, end)
    }
    val n = text.length
    var i = 0
    while (i < n) {
        val c = text[i]
        val block = language.blockComment
        when {
            block != null && text.startsWith(block.first, i) -> {
                val end = text.indexOf(block.second, i + block.first.length).let { if (it < 0) n else it + block.second.length }
                span(VS.comment, i, end)
                i = end
            }
            language.lineComment != null && text.startsWith(language.lineComment, i) &&
                (language.lineComment != "#" || !language.dollarVariables || i == 0 || text[i - 1] != '$') -> {
                val end = text.indexOf('\n', i).let { if (it < 0) n else it }
                span(VS.comment, i, end)
                i = end
            }
            language.name == "HTML" || language.name == "XML" -> {
                if (c == '<') {
                    var j = i + 1
                    if (j < n && (text[j] == '/' || text[j] == '!' || text[j] == '?')) j++
                    val nameEnd = scanWhile(text, j) { it.isLetterOrDigit() || it == '-' || it == ':' }
                    span(VS.keyword, j, nameEnd)
                    i = maxOf(nameEnd, i + 1)
                } else if (c == '"' || c == '\'') {
                    val end = scanString(text, i, c.toString())
                    span(VS.string, i, end)
                    i = end
                } else if (c.isLetter() && i > 0 && isInsideTag(text, i)) {
                    val end = scanWhile(text, i) { it.isLetterOrDigit() || it == '-' || it == ':' }
                    span(VS.variable, i, end)
                    i = end
                } else i++
            }
            language.tripleQuotes && (text.startsWith("\"\"\"", i) || text.startsWith("'''", i)) -> {
                val quote = text.substring(i, i + 3)
                val end = text.indexOf(quote, i + 3).let { if (it < 0) n else it + 3 }
                span(VS.string, i, end)
                i = end
            }
            c == '"' || c == '\'' || (c == '`' && language.name in setOf("JavaScript", "TypeScript", "Go", "Kotlin")) -> {
                // Shell and YAML apostrophes inside words (don't) aren't strings.
                if (c == '\'' && i > 0 && text[i - 1].isLetterOrDigit()) { i++; continue }
                val end = scanString(text, i, c.toString())
                val isKey = language.jsonKeys && text.substring(end).trimStart(' ', '\t').startsWith(":")
                span(if (isKey) VS.variable else VS.string, i, end)
                i = end
            }
            c.isDigit() && (i == 0 || !isWordChar(text[i - 1])) -> {
                val end = scanWhile(text, i) { it.isLetterOrDigit() || it == '.' || it == '_' }
                span(VS.number, i, end)
                i = end
            }
            c == '$' && language.dollarVariables -> {
                val end = scanWhile(text, i + 1) { isWordChar(it) || it == ':' }.let { if (it == i + 1 && it < n && text[it] == '{') text.indexOf('}', it).let { b -> if (b < 0) n else b + 1 } else it }
                val word = text.substring(i, end)
                span(if (language.constants.any { it.equals(word, ignoreCase = true) }) VS.keyword else VS.variable, i, end)
                i = maxOf(end, i + 1)
            }
            isWordStart(c) || (c == '-' && language.caseInsensitive && i + 1 < n && text[i + 1].isLetter()) -> {
                val end = scanWhile(text, i + 1) { isWordChar(it) || (language.caseInsensitive && it == '-') }
                val word = text.substring(i, end)
                val key = if (language.caseInsensitive) word.lowercase() else word
                val next = text.indexOfFirstNonSpace(end)
                when {
                    key in language.controlKeywords -> span(VS.control, i, end)
                    key in language.keywords -> span(VS.keyword, i, end)
                    word in language.constants -> span(VS.keyword, i, end)
                    language.name == "CSS" && next < n && text[next] == ':' -> span(VS.variable, i, end)
                    language.name == "YAML" || language.name == "TOML" || language.name == "Ini" ->
                        if (next < n && (text[next] == ':' || text[next] == '=') && lineStartsAt(text, i)) span(VS.variable, i, end)
                    next < n && text[next] == '(' -> span(VS.function, i, end)
                    word[0].isUpperCase() && word.any { it.isLowerCase() } -> span(VS.type, i, end)
                }
                i = end
            }
            else -> i++
        }
    }
    return builder.toAnnotatedString()
}

private inline fun scanWhile(text: String, from: Int, predicate: (Char) -> Boolean): Int {
    var j = from
    while (j < text.length && predicate(text[j])) j++
    return j
}

/** To the closing quote on the same line (backslash escapes), or the line's end. */
private fun scanString(text: String, start: Int, quote: String): Int {
    var j = start + 1
    val multiline = quote == "`"
    while (j < text.length) {
        val ch = text[j]
        if (ch == '\\') { j += 2; continue }
        if (text.startsWith(quote, j)) return j + quote.length
        if (ch == '\n' && !multiline) return j
        j++
    }
    return text.length
}

private fun isWordStart(c: Char) = c.isLetter() || c == '_' || c == '@'
private fun isWordChar(c: Char) = c.isLetterOrDigit() || c == '_'

private fun String.indexOfFirstNonSpace(from: Int): Int {
    var j = from
    while (j < length && (this[j] == ' ' || this[j] == '\t')) j++
    return j
}

private fun lineStartsAt(text: String, index: Int): Boolean {
    var j = index - 1
    while (j >= 0 && (text[j] == ' ' || text[j] == '\t' || text[j] == '-')) j--
    return j < 0 || text[j] == '\n'
}

private fun isInsideTag(text: String, index: Int): Boolean {
    val open = text.lastIndexOf('<', index)
    return open >= 0 && text.lastIndexOf('>', index - 1) < open
}

/** Colors the editor without changing its text, so offsets map one to one. */
class SyntaxTransformation(private val language: Language) : VisualTransformation {
    private var lastText: String? = null
    private var lastResult: AnnotatedString? = null

    override fun filter(text: AnnotatedString): TransformedText {
        val raw = text.text
        val colored = if (raw == lastText) lastResult!! else highlight(raw, language).also {
            lastText = raw
            lastResult = it
        }
        return TransformedText(colored, OffsetMapping.Identity)
    }

    override fun equals(other: Any?): Boolean = other is SyntaxTransformation && other.language === language
    override fun hashCode(): Int = language.hashCode()
}
