@file:OptIn(ExperimentalSharedTransitionApi::class, ExperimentalMaterial3Api::class)

package com.alexmglesser.controlcenter.mobile.ui.screens

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import com.alexmglesser.controlcenter.mobile.ui.isWideLayout
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.data.api.AppInfo
import com.alexmglesser.controlcenter.mobile.ui.components.appIconRes
import com.alexmglesser.controlcenter.mobile.ui.components.shortAppName
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.alexmglesser.controlcenter.mobile.ui.theme.neonClickable

/** The app grid (design 3.2), built from the PC's app registry. */
@Composable
fun HomeScreen(
    apps: List<AppInfo>,
    loading: Boolean,
    online: Boolean,
    onRefresh: () -> Unit,
    onOpen: (AppInfo) -> Unit,
    sharedScope: SharedTransitionScope,
    animatedScope: AnimatedVisibilityScope
) {
    val wide = isWideLayout()
    PullToRefreshBox(isRefreshing = loading, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
        if (apps.isEmpty() && !loading) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    if (online) "No apps yet. Pull down to refresh." else "Can't load your apps while offline.",
                    color = CC.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(24.dp)
                )
            }
            return@PullToRefreshBox
        }
        LazyVerticalGrid(
            columns = GridCells.Fixed(if (wide) 6 else 3),
            contentPadding = PaddingValues(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier
                .fillMaxSize()
                .alpha(if (online) 1f else 0.55f)
        ) {
            items(apps, key = { it.id }) { app ->
                with(sharedScope) {
                    AppTile(
                        app = app,
                        onClick = { onOpen(app) },
                        modifier = Modifier.sharedBounds(
                            rememberSharedContentState(key = "app-${app.id}"),
                            animatedVisibilityScope = animatedScope
                        )
                    )
                }
            }
        }
    }
}

@Composable
private fun AppTile(app: AppInfo, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .aspectRatio(1f)
            .neonClickable(TileShape, haptic = true, onClick = onClick)
            .background(CC.bgPanel, TileShape)
            .padding(8.dp)
            .semantics { contentDescription = "Open ${app.name}" },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            painterResource(appIconRes(app.id, app.icon)),
            contentDescription = null,
            tint = CC.cyan,
            modifier = Modifier.size(28.dp)
        )
        Spacer(Modifier.height(8.dp))
        Text(
            shortAppName(app.name),
            style = MaterialTheme.typography.bodySmall,
            color = CC.textPrimary,
            textAlign = TextAlign.Center,
            maxLines = 2
        )
    }
}

/**
 * An app's screen. Phone views for each app arrive in later phases; until
 * then this is the generic card (design 3.6), which also covers new apps.
 */
@Composable
fun AppScreen(app: AppInfo?, onBack: () -> Unit, sharedScope: SharedTransitionScope, animatedScope: AnimatedVisibilityScope) {
    if (app == null) {
        onBack()
        return
    }
    with(sharedScope) {
        Column(
            Modifier
                .fillMaxSize()
                .sharedBounds(rememberSharedContentState(key = "app-${app.id}"), animatedVisibilityScope = animatedScope)
                .background(CC.bgPrimary)
        ) {
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
                Text(shortAppName(app.name), style = MaterialTheme.typography.titleMedium, color = CC.textPrimary)
            }
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Box(
                    Modifier
                        .size(96.dp)
                        .background(CC.bgPanel, TileShape),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(painterResource(appIconRes(app.id, app.icon)), contentDescription = null, tint = CC.cyan, modifier = Modifier.size(44.dp))
                }
                Text(app.name, style = MaterialTheme.typography.titleLarge, color = CC.textPrimary)
                if (app.description.isNotBlank()) {
                    Text(app.description, color = CC.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 520.dp))
                }
                Text(
                    "The phone view for this app is coming in a later update. Open it on the PC to use it for now.",
                    style = MaterialTheme.typography.bodySmall,
                    color = CC.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.widthIn(max = 520.dp)
                )
            }
        }
    }
}
