@file:OptIn(ExperimentalSharedTransitionApi::class)

package com.alexmglesser.controlcenter.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.data.Session
import com.alexmglesser.controlcenter.mobile.data.SessionState
import com.alexmglesser.controlcenter.mobile.data.events.ConnectionState
import com.alexmglesser.controlcenter.mobile.ui.components.ConnectionBanner
import com.alexmglesser.controlcenter.mobile.ui.components.StatusPill
import com.alexmglesser.controlcenter.mobile.ui.screens.AppScreen
import com.alexmglesser.controlcenter.mobile.ui.screens.ChatScreen
import com.alexmglesser.controlcenter.mobile.ui.screens.ConnectScreen
import com.alexmglesser.controlcenter.mobile.ui.screens.FirstRunScreen
import com.alexmglesser.controlcenter.mobile.ui.screens.HomeScreen
import com.alexmglesser.controlcenter.mobile.ui.screens.PHONE_APPS
import com.alexmglesser.controlcenter.mobile.ui.screens.RemovedScreen
import com.alexmglesser.controlcenter.mobile.ui.screens.SettingsScreen
import com.alexmglesser.controlcenter.mobile.ui.theme.CC

/** Top of the UI: pairing, first run, or the main app (design 2). */
@Composable
fun AppRoot(viewModel: AppViewModel) {
    val sessionState by viewModel.sessionState.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val pairing by viewModel.pairing.collectAsStateWithLifecycle()

    when (val state = sessionState) {
        SessionState.Loading -> Box(Modifier.fillMaxSize().background(CC.bgPrimary))
        SessionState.NotPaired -> ConnectScreen(viewModel, pairing)
        SessionState.Removed -> RemovedScreen(onConnectAgain = viewModel::forgetPairing)
        is SessionState.Paired ->
            if (!settings.firstRunDone) FirstRunScreen(onDone = viewModel::completeFirstRun)
            else MainScaffold(viewModel, state.session)
    }
}

private data class TabItem(val tab: Tab, val label: String, val icon: Int)

private val TAB_ITEMS = listOf(
    TabItem(Tab.APPS, "Apps", R.drawable.ic_layout_grid),
    TabItem(Tab.JARVIS, "Jarvis", R.drawable.ic_message_circle),
    TabItem(Tab.SETTINGS, "Settings", R.drawable.ic_settings)
)

/**
 * Bottom tabs in portrait; a navigation rail from 600 dp wide, which covers a
 * phone in landscape (design 4.1).
 */
@Composable
private fun MainScaffold(viewModel: AppViewModel, session: Session) {
    val tab by viewModel.tab.collectAsStateWithLifecycle()
    val openAppId by viewModel.openAppId.collectAsStateWithLifecycle()
    val apps by viewModel.apps.collectAsStateWithLifecycle()
    val appsLoading by viewModel.appsLoading.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val chat by viewModel.chat.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val openedChip by viewModel.openedByJarvis.collectAsStateWithLifecycle()
    val wide = isWideLayout()
    val inApp = openAppId != null && tab == Tab.APPS
    val online = connection is ConnectionState.Connected

    BackHandler(enabled = openAppId != null || tab != Tab.APPS) { viewModel.handleBack() }

    Row(
        Modifier
            .fillMaxSize()
            .background(CC.bgPrimary)
            .systemBarsPadding()
    ) {
        if (wide && !inApp) {
            NavigationRail(containerColor = CC.bgPanel, modifier = Modifier.fillMaxHeight()) {
                TAB_ITEMS.forEach { item ->
                    NavigationRailItem(
                        selected = tab == item.tab,
                        onClick = { viewModel.selectTab(item.tab) },
                        icon = { Icon(painterResource(item.icon), contentDescription = null) },
                        label = { Text(item.label) },
                        colors = NavigationRailItemDefaults.colors(
                            selectedIconColor = CC.cyan,
                            selectedTextColor = CC.cyan,
                            indicatorColor = CC.cyan.copy(alpha = 0.12f),
                            unselectedIconColor = CC.textSecondary,
                            unselectedTextColor = CC.textSecondary
                        )
                    )
                }
            }
        }
        Column(Modifier.weight(1f)) {
            if (!inApp) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(if (wide) 48.dp else 56.dp)
                        .padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        when (tab) {
                            Tab.APPS -> "Control Center"
                            Tab.JARVIS -> "Jarvis"
                            Tab.SETTINGS -> "Settings"
                        },
                        style = MaterialTheme.typography.titleLarge,
                        color = CC.textPrimary,
                        modifier = Modifier.weight(1f)
                    )
                    StatusPill(connection)
                }
            }
            ConnectionBanner(connection, session.serverName, onRetry = viewModel::reconnectNow)

            Box(Modifier.weight(1f)) {
                // Tab switches: a short slide toward the new tab with a cross-fade (180 ms).
                AnimatedContent(
                    targetState = tab,
                    transitionSpec = {
                        val direction = if (targetState.ordinal > initialState.ordinal) 1 else -1
                        (slideInHorizontally(tween(180)) { it / 12 * direction } + fadeIn(tween(180))) togetherWith
                            (slideOutHorizontally(tween(180)) { -it / 12 * direction } + fadeOut(tween(120)))
                    },
                    label = "tabs"
                ) { currentTab ->
                    when (currentTab) {
                        Tab.APPS -> AppsTab(viewModel, apps, appsLoading, online, openAppId)
                        Tab.JARVIS -> ChatScreen(
                            state = chat,
                            myDeviceId = session.deviceId,
                            online = online,
                            openedChip = openedChip,
                            onSend = viewModel::sendChat,
                            onChipTap = viewModel::openChipApp
                        )
                        Tab.SETTINGS -> SettingsScreen(
                            session = session,
                            connection = connection,
                            settings = settings,
                            onUpdate = viewModel::updateSettings,
                            onSignOut = viewModel::signOut
                        )
                    }
                }
            }

            if (!wide && !inApp) {
                NavigationBar(containerColor = CC.bgPanel) {
                    TAB_ITEMS.forEach { item ->
                        NavigationBarItem(
                            selected = tab == item.tab,
                            onClick = { viewModel.selectTab(item.tab) },
                            icon = { Icon(painterResource(item.icon), contentDescription = null) },
                            label = { Text(item.label) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = CC.cyan,
                                selectedTextColor = CC.cyan,
                                indicatorColor = CC.cyan.copy(alpha = 0.12f),
                                unselectedIconColor = CC.textSecondary,
                                unselectedTextColor = CC.textSecondary
                            )
                        )
                    }
                }
            }
        }
    }
}

/**
 * The grid and the open app share a transition: the tile grows into the app
 * screen (260 ms) and shrinks back on Back (design 1.3).
 */
@Composable
private fun AppsTab(
    viewModel: AppViewModel,
    apps: List<com.alexmglesser.controlcenter.mobile.data.api.AppInfo>,
    loading: Boolean,
    online: Boolean,
    openAppId: String?
) {
    SharedTransitionLayout {
        AnimatedContent(
            targetState = openAppId,
            transitionSpec = { fadeIn(tween(120, delayMillis = 140)) togetherWith fadeOut(tween(120)) },
            label = "appOpen"
        ) { appId ->
            if (appId == null) {
                HomeScreen(
                    apps = apps,
                    loading = loading,
                    online = online,
                    onRefresh = viewModel::refreshApps,
                    onOpen = { viewModel.openApp(it.id) },
                    sharedScope = this@SharedTransitionLayout,
                    animatedScope = this@AnimatedContent
                )
            } else {
                AppScreen(
                    app = (apps + PHONE_APPS).firstOrNull { it.id == appId },
                    onBack = viewModel::closeApp,
                    sharedScope = this@SharedTransitionLayout,
                    animatedScope = this@AnimatedContent
                )
            }
        }
    }
}
