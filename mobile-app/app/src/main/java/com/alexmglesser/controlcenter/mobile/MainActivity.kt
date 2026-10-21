package com.alexmglesser.controlcenter.mobile

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.alexmglesser.controlcenter.mobile.notify.Notifications
import com.alexmglesser.controlcenter.mobile.ui.AppRoot
import com.alexmglesser.controlcenter.mobile.ui.AppViewModel
import com.alexmglesser.controlcenter.mobile.ui.Tab
import com.alexmglesser.controlcenter.mobile.ui.theme.ControlCenterTheme

class MainActivity : ComponentActivity() {
    private val viewModel: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleNavigationIntent(intent)
        setContent {
            ControlCenterTheme {
                AppRoot(viewModel)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // The connection lives in ConnectionService; make sure it runs while the app is open.
        viewModel.ensureConnectionService()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleNavigationIntent(intent)
    }

    /** Notifications open a specific tab (design 8.1). */
    private fun handleNavigationIntent(intent: Intent?) {
        when (intent?.getStringExtra(Notifications.EXTRA_NAVIGATE)) {
            Notifications.NAVIGATE_CHAT -> viewModel.selectTab(Tab.JARVIS)
            Notifications.NAVIGATE_SETTINGS -> viewModel.selectTab(Tab.SETTINGS)
        }
    }
}

/** The app's version, without enabling BuildConfig generation. */
object BuildConfigInfo {
    fun versionName(context: Context): String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "?"
}
