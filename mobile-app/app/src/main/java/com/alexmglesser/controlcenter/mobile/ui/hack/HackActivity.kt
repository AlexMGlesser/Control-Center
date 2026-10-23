package com.alexmglesser.controlcenter.mobile.ui.hack

import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.ChamferShape
import com.alexmglesser.controlcenter.mobile.ui.theme.ControlCenterTheme
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/**
 * "Hack the mainframe": a full screen of movie-style hacker panels. Purely
 * for show; it does nothing and talks to nothing. Tap or Back to leave.
 */
class HackActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        setContent { ControlCenterTheme { HackScreen(onExit = ::finish) } }
    }

    companion object {
        /** [newTask]: when started from outside an activity (Jarvis's "open it" event). */
        fun start(context: Context, newTask: Boolean = false) {
            val intent = Intent(context, HackActivity::class.java)
            if (newTask) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
    }
}

private val GREEN = Color(0xFF39FF9C)
private val PanelShape = ChamferShape(8.dp)

@Composable
private fun HackScreen(onExit: () -> Unit) {
    // One clock for every panel. Panels read it while drawing, so each frame
    // only redraws; nothing is rebuilt.
    var now by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) {
        while (true) withFrameMillis { now = it }
    }
    val clock = { now }

    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .background(Color(0xFF020306))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onExit)
            .padding(8.dp)
    ) {
        val landscape = maxWidth > maxHeight
        val panels: List<Pair<String, @Composable (Modifier) -> Unit>> = listOf(
            "DECRYPT//STREAM" to { m -> MatrixRain(clock, m) },
            "PAYLOAD.C" to { m -> CodeTyper(clock, m) },
            "MEM 0x7FFA0000" to { m -> HexDump(clock, m) },
            "NODE TRACE" to { m -> Radar(clock, m) },
            "INTRUSION" to { m -> Progress(clock, m) },
            "SIGNAL" to { m -> Scope(clock, m) }
        )
        Column(Modifier.fillMaxSize()) {
            Header(clock)
            val columns = if (landscape) 3 else 2
            panels.chunked(columns).forEach { row ->
                Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { (title, content) -> Panel(title, Modifier.weight(1f)) { content(Modifier.fillMaxSize()) } }
                }
                Box(Modifier.padding(top = 8.dp))
            }
        }
        AccessGranted(clock, Modifier.align(Alignment.Center))
    }
}

/* ------------------------------------------------------------------ */
/* Frame and text helpers                                              */
/* ------------------------------------------------------------------ */

@Composable
private fun Panel(title: String, modifier: Modifier, content: @Composable () -> Unit) {
    Column(
        modifier
            .fillMaxSize()
            .border(1.dp, CC.cyan.copy(alpha = 0.45f), PanelShape)
            .background(Color(0xFF05080F), PanelShape)
            .padding(6.dp)
    ) {
        Text("▌$title", color = CC.magenta, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
        Box(Modifier.weight(1f).fillMaxWidth().clipToBounds()) { content() }
    }
}

/** A monospace paint for fast canvas text. */
@Composable
private fun monoPaint(sizeSp: Float, color: Color): Paint {
    val density = LocalDensity.current
    return remember(sizeSp, color) {
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = Typeface.MONOSPACE
            textSize = with(density) { sizeSp.sp.toPx() }
            this.color = color.toArgb()
        }
    }
}

private fun DrawScope.text(paint: Paint, value: String, x: Float, y: Float, alpha: Float = 1f) {
    val base = paint.alpha
    paint.alpha = (alpha.coerceIn(0f, 1f) * 255).toInt()
    drawIntoCanvas { it.nativeCanvas.drawText(value, x, y, paint) }
    paint.alpha = base
}

/* ------------------------------------------------------------------ */
/* Header and the "ACCESS GRANTED" moment                              */
/* ------------------------------------------------------------------ */

@Composable
private fun Header(clock: () -> Long) {
    val paint = monoPaint(13f, CC.cyan)
    val dim = monoPaint(10f, CC.textSecondary)
    Canvas(Modifier.fillMaxWidth().padding(bottom = 6.dp).height(34.dp)) {
        val t = clock()
        val dots = ".".repeat(((t / 400) % 4).toInt())
        val stage = listOf("ACCESSING MAINFRAME", "ROUTING THROUGH 7 PROXIES", "ESCALATING PRIVILEGES", "OVERRIDING SECURITY GRID")[((t / 4000) % 4).toInt()]
        text(paint, "> $stage$dots${if ((t / 500) % 2 == 0L) "_" else ""}", 0f, size.height * 0.55f)
        val rnd = Random(t / 250)
        text(dim, "UPLINK ${rnd.nextInt(10, 99)}.${rnd.nextInt(100, 255)}.${rnd.nextInt(1, 255)}.${rnd.nextInt(1, 255)}  LAT ${rnd.nextInt(3, 40)}ms  ENTROPY ${"%.3f".format(rnd.nextDouble())}", 0f, size.height * 0.95f)
    }
}

@Composable
private fun AccessGranted(clock: () -> Long, modifier: Modifier) {
    val big = monoPaint(26f, GREEN)
    Canvas(modifier.fillMaxWidth().height(110.dp)) {
        // Every 20 seconds, for 3 seconds, flashing.
        val phase = clock() % 20_000
        if (phase < 15_000 || phase > 18_000 || (clock() / 180) % 2 == 0L) return@Canvas
        val label = "ACCESS GRANTED"
        val width = big.measureText(label)
        val boxWidth = width + 64f
        val left = (size.width - boxWidth) / 2
        drawRect(Color(0xEE020306), Offset(left, 0f), Size(boxWidth, size.height))
        drawRect(GREEN, Offset(left, 0f), Size(boxWidth, size.height), style = Stroke(4f))
        text(big, label, (size.width - width) / 2, size.height / 2 + big.textSize / 3)
    }
}

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */

private const val GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ABCDEF<>/\\|=+*#"

/** Falling columns of glyphs, brightest at the head. */
@Composable
private fun MatrixRain(clock: () -> Long, modifier: Modifier) {
    val paint = monoPaint(12f, GREEN)
    val head = monoPaint(12f, Color.White)
    val drops = remember { FloatArray(64) { Random.nextFloat() * -30f } }
    val speeds = remember { FloatArray(64) { 6f + Random.nextFloat() * 14f } }
    val last = remember { LongArray(1) }
    Canvas(modifier) {
        val t = clock()
        val dt = if (last[0] == 0L) 0f else ((t - last[0]).coerceAtMost(100)) / 1000f
        last[0] = t
        val cell = paint.textSize
        val columns = min((size.width / (cell * 0.75f)).toInt(), drops.size)
        val rows = (size.height / cell).toInt() + 1
        for (c in 0 until columns) {
            drops[c] += speeds[c] * dt
            if (drops[c] - 18 > rows) drops[c] = Random.nextFloat() * -10f
            val x = c * cell * 0.75f
            for (k in 0 until 18) {
                val row = drops[c].toInt() - k
                if (row < 0 || row > rows) continue
                val glyph = GLYPHS[((row * 31 + c * 17 + (t / 120) * (if (k == 0) 7 else 1)) % GLYPHS.length).toInt()].toString()
                text(if (k == 0) head else paint, glyph, x, (row + 1) * cell, 1f - k / 18f)
            }
        }
    }
}

private val CODE = listOf(
    "#include <sys/mainframe.h>",
    "int breach(node_t *target) {",
    "    uint8_t key[256] = {0};",
    "    if (!handshake(target, PORT_31337)) {",
    "        spoof_mac(target->iface);",
    "        return reroute(target, &proxy_chain);",
    "    }",
    "    for (int i = 0; i < 0xFFFF; i++) {",
    "        key[i & 0xFF] ^= sbox[target->salt[i % 64]];",
    "        if (crc32(key) == target->hash) goto inject;",
    "    }",
    "inject:",
    "    payload_t *p = mmap_exec(SHELLCODE, sizeof SHELLCODE);",
    "    p->ret = &kernel_ring0;",
    "    disable_ids(target, IDS_SILENT);",
    "    return p->run(target) ? GRANTED : DENIED;",
    "}",
    "",
    "void cover_tracks(void) {",
    "    wipe_logs(\"/var/log/auth.log\");",
    "    for (proxy_t *p = chain; p; p = p->next) p->burn();",
    "}"
)

/** Code that types itself out, scrolling up as it goes. */
@Composable
private fun CodeTyper(clock: () -> Long, modifier: Modifier) {
    val paint = monoPaint(10.5f, CC.cyan)
    val keyword = monoPaint(10.5f, CC.magenta)
    Canvas(modifier) {
        val t = clock()
        val typed = (t / 28).toInt() // characters typed so far, across all lines
        val lineHeight = paint.textSize * 1.35f
        val visible = (size.height / lineHeight).toInt()
        var remaining = typed
        var index = 0
        val lines = ArrayList<String>()
        while (remaining > 0) {
            val line = CODE[index % CODE.size]
            lines.add(line.take(remaining))
            remaining -= line.length + 4
            index++
        }
        val shown = lines.takeLast(visible)
        shown.forEachIndexed { i, line ->
            val isKeyword = line.trimStart().let { it.startsWith("int ") || it.startsWith("void ") || it.startsWith("return") || it.startsWith("#") || it.startsWith("for ") || it.startsWith("if ") }
            val cursor = if (i == shown.lastIndex && (t / 300) % 2 == 0L) "█" else ""
            text(if (isKeyword) keyword else paint, line + cursor, 0f, (i + 1) * lineHeight)
        }
    }
}

/** A memory dump scrolling past. */
@Composable
private fun HexDump(clock: () -> Long, modifier: Modifier) {
    val paint = monoPaint(9.5f, GREEN.copy(alpha = 0.85f))
    val address = monoPaint(9.5f, CC.textSecondary)
    Canvas(modifier) {
        val t = clock()
        val lineHeight = paint.textSize * 1.3f
        val scroll = t / 90f
        val first = scroll.toInt()
        val offset = (scroll - first) * lineHeight
        val rows = (size.height / lineHeight).toInt() + 2
        val bytesPerRow = ((size.width - address.measureText("7FFA0000  ")) / paint.measureText("00 ")).toInt().coerceIn(2, 8)
        for (r in 0 until rows) {
            val line = first + r
            val rnd = Random(line * 7919L)
            val y = (r + 1) * lineHeight - offset
            text(address, "%08X".format(0x7FFA0000 + line * 16), 0f, y)
            val bytes = (0 until bytesPerRow).joinToString(" ") { "%02X".format(rnd.nextInt(256)) }
            text(paint, bytes, address.measureText("7FFA0000  "), y, if (rnd.nextInt(9) == 0) 1f else 0.7f)
        }
    }
}

/** A radar sweep with targets lighting up as it passes. */
@Composable
private fun Radar(clock: () -> Long, modifier: Modifier) {
    val label = monoPaint(9f, GREEN)
    val blips = remember { List(9) { Pair(Random.nextFloat() * 2 * PI.toFloat(), 0.2f + Random.nextFloat() * 0.75f) } }
    Canvas(modifier) {
        val t = clock()
        val center = Offset(size.width / 2, size.height / 2)
        val radius = min(size.width, size.height) / 2 - 4
        for (ring in 1..4) drawCircle(GREEN.copy(alpha = 0.25f), radius * ring / 4, center, style = Stroke(1.5f))
        drawLine(GREEN.copy(alpha = 0.2f), Offset(center.x - radius, center.y), Offset(center.x + radius, center.y))
        drawLine(GREEN.copy(alpha = 0.2f), Offset(center.x, center.y - radius), Offset(center.x, center.y + radius))
        val sweep = (t % 3000) / 3000f * 2 * PI.toFloat()
        // The fading wedge behind the sweep line.
        for (i in 0 until 24) {
            val angle = sweep - i * 0.03f
            drawLine(
                GREEN.copy(alpha = 0.5f * (1f - i / 24f)),
                center,
                Offset(center.x + cos(angle) * radius, center.y + sin(angle) * radius),
                strokeWidth = 3f
            )
        }
        blips.forEachIndexed { index, (angle, distance) ->
            val since = ((sweep - angle) % (2 * PI.toFloat()) + 2 * PI.toFloat()) % (2 * PI.toFloat())
            val glow = (1f - since / (2 * PI.toFloat())).let { it * it }
            val point = Offset(center.x + cos(angle) * radius * distance, center.y + sin(angle) * radius * distance)
            drawCircle(GREEN.copy(alpha = glow), 5f, point)
            if (glow > 0.6f) text(label, "TGT-${100 + index * 37}", point.x + 8, point.y - 6, glow)
        }
    }
}

private val TASKS = listOf(
    "BYPASSING FIREWALL",
    "DECRYPTING RSA-4096",
    "INJECTING PAYLOAD",
    "SPOOFING MAC ADDRESS",
    "TRACING PROXY CHAIN",
    "CRACKING HASHES",
    "DISABLING ICE",
    "UPLOADING VIRUS.EXE",
    "DOWNLOADING MORE RAM",
    "REROUTING SATELLITE"
)

/** Progress bars that fill, finish, and start on the next job. */
@Composable
private fun Progress(clock: () -> Long, modifier: Modifier) {
    val paint = monoPaint(9.5f, CC.textPrimary)
    val done = monoPaint(9.5f, GREEN)
    Canvas(modifier) {
        val t = clock()
        val rowHeight = size.height / 5
        for (row in 0 until 5) {
            val period = 5000L + row * 1700L
            val cycle = (t + row * 911L) / period
            val progress = ((t + row * 911L) % period) / period.toFloat()
            val task = TASKS[((cycle * 3 + row) % TASKS.size).toInt()]
            val finished = progress > 0.88f
            val shown = if (finished) 1f else (progress / 0.88f).let { it * it * (3 - 2 * it) }
            val y = row * rowHeight
            text(if (finished) done else paint, "$task ${if (finished) "DONE" else "${(shown * 100).toInt()}%"}", 0f, y + paint.textSize)
            val barTop = y + paint.textSize * 1.5f
            val barHeight = rowHeight * 0.28f
            drawRect(CC.cyan.copy(alpha = 0.15f), Offset(0f, barTop), Size(size.width, barHeight))
            drawRect(
                Brush.horizontalGradient(listOf(CC.magenta, CC.cyan)),
                Offset(0f, barTop),
                Size(size.width * shown, barHeight)
            )
        }
    }
}

/** Three noisy traces scrolling across. */
@Composable
private fun Scope(clock: () -> Long, modifier: Modifier) {
    Canvas(modifier) {
        val t = clock() / 1000f
        for (x in 0..8) drawLine(CC.cyan.copy(alpha = 0.08f), Offset(size.width * x / 8, 0f), Offset(size.width * x / 8, size.height))
        for (y in 0..4) drawLine(CC.cyan.copy(alpha = 0.08f), Offset(0f, size.height * y / 4), Offset(size.width, size.height * y / 4))
        listOf(Triple(CC.cyan, 3f, 0.7f), Triple(CC.magenta, 7f, 0.4f), Triple(GREEN, 1.3f, 0.55f)).forEachIndexed { index, (color, frequency, amplitude) ->
            val path = Path()
            val steps = 80
            for (i in 0..steps) {
                val x = size.width * i / steps
                val phase = i / steps.toFloat() * frequency * 2 * PI.toFloat() + t * (2f + index)
                val noise = sin(phase * 3.7f + t * 9f) * 0.25f
                val y = size.height / 2 + (sin(phase) + noise) * size.height / 2 * amplitude * 0.8f
                if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            drawPath(path, color.copy(alpha = 0.85f), style = Stroke(2f))
        }
    }
}
