package com.alexmglesser.controlcenter.mobile.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.dp

/**
 * Medium width and up (600 dp): a phone in landscape, a foldable or a tablet.
 * Uses the window's size, not the screen's, so split-screen works (design 4.1).
 */
@Composable
fun isWideLayout(): Boolean {
    val widthPx = LocalWindowInfo.current.containerSize.width
    return with(LocalDensity.current) { widthPx.toDp() } >= 600.dp
}
