package com.alexmglesser.controlcenter.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Design section 1.1: the desktop's token names with the phone's cyberpunk
 * values. Neon is for accents only; text never glows.
 */
object CC {
    val bgPrimary = Color(0xFF07070D)
    val bgPanel = Color(0xFF10111F)
    val bgPanelSoft = Color(0xFF181A30)
    val line = Color(0x3800F0FF) // rgba(0, 240, 255, 0.22)
    val textPrimary = Color(0xFFE8F1FF)
    val textSecondary = Color(0xFF8E96BD)
    val cyan = Color(0xFF00F0FF)
    val magenta = Color(0xFFFF2BD6)
    val ok = Color(0xFF39FF9C)
    val warn = Color(0xFFF5E642)
    val red = Color(0xFFFF3355)
}

private val colorScheme = darkColorScheme(
    primary = CC.cyan,
    onPrimary = CC.bgPrimary,
    secondary = CC.magenta,
    onSecondary = CC.bgPrimary,
    background = CC.bgPrimary,
    onBackground = CC.textPrimary,
    surface = CC.bgPanel,
    onSurface = CC.textPrimary,
    surfaceVariant = CC.bgPanelSoft,
    onSurfaceVariant = CC.textSecondary,
    surfaceContainer = CC.bgPanel,
    surfaceContainerHigh = CC.bgPanelSoft,
    outline = CC.line,
    error = CC.red,
    onError = CC.bgPrimary
)

// Design: 16 sp body, 13 sp secondary, nothing under 12 sp.
private val typography = Typography(
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 13.sp),
    labelSmall = TextStyle(fontSize = 12.sp),
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
    headlineSmall = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
)

@Composable
fun ControlCenterTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colorScheme, typography = typography, content = content)
}
