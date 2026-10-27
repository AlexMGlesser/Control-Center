package com.alexmglesser.controlcenter.mobile.media

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.alexmglesser.controlcenter.mobile.MainActivity
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.notify.Notifications

/**
 * Media from the PC: every request carries this phone's token (architecture
 * 5.9), so media URLs need no tokens of their own. Range requests make
 * seeking work.
 */
object AuthMedia {
    @OptIn(UnstableApi::class)
    fun dataSourceFactory(context: Context): DataSource.Factory {
        val container = context.applicationContext.appContainer
        val upstream = OkHttpDataSource.Factory(container.api.mediaHttp)
        return ResolvingDataSource.Factory(upstream) { spec ->
            val token = container.sessionStore.currentSession()?.token
            if (token == null) spec else spec.withAdditionalHeaders(mapOf("Authorization" to "Bearer $token"))
        }
    }

    @OptIn(UnstableApi::class)
    fun player(context: Context, music: Boolean): ExoPlayer =
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory(context)))
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(if (music) C.AUDIO_CONTENT_TYPE_MUSIC else C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                true
            )
            .setHandleAudioBecomingNoisy(true)
            .build()

    /** Absolute URL for a server path, or null when not paired. */
    fun url(context: Context, path: String): String? =
        context.applicationContext.appContainer.sessionStore.currentSession()?.let { it.baseUrl + path }
}

/**
 * The service has to be exported for the lock screen, notification and
 * Bluetooth controls, so other apps could also try to connect. Only the
 * system and this app are let in.
 */
@OptIn(UnstableApi::class)
private class TrustedControllersOnly(private val ownPackage: String) : MediaSession.Callback {
    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
        if (controller.isTrusted || controller.packageName == ownPackage) {
            super.onConnect(session, controller)
        } else {
            MediaSession.ConnectionResult.reject()
        }
}

/**
 * Music playing on the phone: keeps going with the screen off, with controls
 * in the notification shade and on the lock screen (Media3 session service).
 */
class MusicService : MediaSessionService() {
    private var session: MediaSession? = null

    @OptIn(UnstableApi::class)
    override fun onCreate() {
        super.onCreate()
        val player = AuthMedia.player(this, music = true)
        val openMusic = PendingIntent.getActivity(
            this,
            40,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(Notifications.EXTRA_NAVIGATE, Notifications.NAVIGATE_MUSIC),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        session = MediaSession.Builder(this, player)
            .setSessionActivity(openMusic)
            .setCallback(TrustedControllersOnly(packageName))
            .build()
        setMediaNotificationProvider(DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.ic_music) })
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** Swiped away from recents while paused: nothing to keep alive. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }
}
