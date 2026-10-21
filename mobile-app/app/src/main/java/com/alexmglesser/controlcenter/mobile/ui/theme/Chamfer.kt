package com.alexmglesser.controlcenter.mobile.ui.theme

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp

/**
 * Design section 1.2: two opposite corners (top-left, bottom-right) cut at
 * 45°, the other two slightly rounded. The cut shape always means "tappable".
 */
class ChamferShape(private val cut: Dp, private val round: Dp = 3.dp) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val c = with(density) { cut.toPx() }.coerceAtMost(minOf(size.width, size.height) / 2)
        val r = with(density) { round.toPx() }
        val w = size.width
        val h = size.height
        val path = Path().apply {
            moveTo(c, 0f)
            lineTo(w - r, 0f)
            quadraticTo(w, 0f, w, r)
            lineTo(w, h - c)
            lineTo(w - c, h)
            lineTo(r, h)
            quadraticTo(0f, h, 0f, h - r)
            lineTo(0f, c)
            close()
        }
        return Outline.Generic(path)
    }
}

val TileShape = ChamferShape(10.dp)
val ButtonShape = ChamferShape(6.dp)

/**
 * Design section 1.3 press feedback: on touch the element scales to 97%, its
 * border brightens to the full accent and a glow fades in (80 ms in, 120 ms
 * out). Primary actions add a light haptic tick. With Android's "Remove
 * animations" on, Compose skips the scale animation and the color change stays.
 */
fun Modifier.neonClickable(
    shape: Shape,
    accent: Color = CC.cyan,
    restBorder: Color = CC.line,
    haptic: Boolean = false,
    active: Boolean = false,
    role: Role = Role.Button,
    onClick: () -> Unit
): Modifier = composed {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val lit = pressed || active
    val scale by animateFloatAsState(if (pressed) 0.97f else 1f, tween(if (pressed) 80 else 120), label = "pressScale")
    val glow by animateFloatAsState(if (lit) 1f else 0f, tween(if (pressed) 80 else 120), label = "pressGlow")
    val view = LocalView.current
    this
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
        }
        .shadow(elevation = (10 * glow).dp, shape = shape, ambientColor = accent, spotColor = accent)
        .clip(shape)
        .border(1.dp, if (lit) accent else restBorder, shape)
        .clickable(interactionSource = interaction, indication = null, role = role) {
            if (haptic) view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
            onClick()
        }
}
