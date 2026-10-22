package com.alexmglesser.controlcenter.mobile.media

import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.annotation.OptIn
import androidx.core.net.toUri
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.alexmglesser.controlcenter.mobile.appContainer
import com.alexmglesser.controlcenter.mobile.data.api.MovieInfo

/**
 * Full-screen movie playback streamed from the PC (design: Movie). Seek,
 * pause, and audio / subtitle track choice come from Media3's player
 * controls. A widescreen video turns the screen to landscape; leaving
 * restores the previous orientation (design 4).
 */
class MoviePlayerActivity : ComponentActivity() {
    private var player: ExoPlayer? = null
    private var turnedToLandscape = false

    @OptIn(UnstableApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val movieId = intent.getStringExtra(EXTRA_ID) ?: return finish()
        val title = intent.getStringExtra(EXTRA_TITLE) ?: "Movie"
        val subtitleLabels = intent.getStringArrayExtra(EXTRA_SUBTITLES).orEmpty()
        val api = appContainer.api
        val streamUrl = AuthMedia.url(this, api.movieStreamPath(movieId)) ?: return finish()

        val subtitles = subtitleLabels.mapIndexedNotNull { index, label ->
            AuthMedia.url(this, api.movieSubtitlesPath(movieId, index))?.let { url ->
                MediaItem.SubtitleConfiguration.Builder(url.toUri())
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLabel(label)
                    .setSelectionFlags(0)
                    .build()
            }
        }
        val item = MediaItem.Builder()
            .setUri(streamUrl)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
            .setSubtitleConfigurations(subtitles)
            .build()

        val exo = AuthMedia.player(this, music = false)
        player = exo
        exo.addListener(object : Player.Listener {
            override fun onVideoSizeChanged(videoSize: VideoSize) {
                if (!turnedToLandscape && videoSize.width > videoSize.height && videoSize.height > 0) {
                    turnedToLandscape = true
                    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                val why = when (error.errorCode) {
                    PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
                    PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
                    PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES -> "This phone can't decode this movie's video or audio format."
                    PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
                    PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "Lost the connection to the PC."
                    PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> "The PC couldn't stream this file. Try a rescan in the desktop Movie app."
                    else -> "Can't play this movie: ${error.errorCodeName}"
                }
                Toast.makeText(this@MoviePlayerActivity, why, Toast.LENGTH_LONG).show()
            }
        })
        exo.setMediaItem(item)
        exo.prepare()
        exo.playWhenReady = true

        val view = PlayerView(this).apply {
            setBackgroundColor(Color.BLACK)
            this.player = exo
            setShowSubtitleButton(true)
            keepScreenOn = true
        }
        setContentView(view)
        hideSystemBars()
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onStop() {
        super.onStop()
        player?.pause()
    }

    override fun onDestroy() {
        player?.release()
        player = null
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_ID = "movie_id"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_SUBTITLES = "subtitles"

        fun start(context: Context, movie: MovieInfo) {
            context.startActivity(
                Intent(context, MoviePlayerActivity::class.java)
                    .putExtra(EXTRA_ID, movie.id)
                    .putExtra(EXTRA_TITLE, movie.title)
                    .putExtra(EXTRA_SUBTITLES, movie.subtitles.sortedBy { it.index }.map { it.label }.toTypedArray())
            )
        }
    }
}
