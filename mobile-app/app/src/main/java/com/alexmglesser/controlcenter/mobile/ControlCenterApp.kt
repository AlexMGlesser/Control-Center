package com.alexmglesser.controlcenter.mobile

import android.app.Application
import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.alexmglesser.controlcenter.mobile.data.SessionStore
import com.alexmglesser.controlcenter.mobile.data.api.ApiClient
import com.alexmglesser.controlcenter.mobile.data.events.ConnectionManager
import com.alexmglesser.controlcenter.mobile.notify.Notifications
import com.alexmglesser.controlcenter.mobile.service.ConnectionServiceController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** App-wide singletons. Kept deliberately small: no DI framework. */
class AppContainer(context: Context) {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val sessionStore = SessionStore(context)
    val api = ApiClient(sessionStore)
    val connection = ConnectionManager(context, sessionStore, api, appScope)

    private val _inForeground = MutableStateFlow(false)
    /** True while any of the app's screens is visible. */
    val inForeground: StateFlow<Boolean> = _inForeground

    internal fun setForeground(value: Boolean) {
        _inForeground.value = value
    }

    init {
        api.onUnauthorized = { sessionStore.markRemoved() }
    }
}

class ControlCenterApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        Notifications.createChannels(this)
        container.appScope.launch { container.sessionStore.load() }

        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                container.setForeground(true)
            }

            override fun onStop(owner: LifecycleOwner) {
                container.setForeground(false)
                // Without "Stay connected", the connection only lives while the app is open.
                container.appScope.launch {
                    if (!container.sessionStore.currentSettings().stayConnected) {
                        ConnectionServiceController.stop(this@ControlCenterApp)
                    }
                }
            }
        })
    }
}

val Context.appContainer: AppContainer
    get() = (applicationContext as ControlCenterApp).container
