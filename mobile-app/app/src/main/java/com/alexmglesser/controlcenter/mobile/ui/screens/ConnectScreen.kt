package com.alexmglesser.controlcenter.mobile.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.alexmglesser.controlcenter.mobile.R
import com.alexmglesser.controlcenter.mobile.ui.AppViewModel
import com.alexmglesser.controlcenter.mobile.ui.PairingPayload
import com.alexmglesser.controlcenter.mobile.ui.PairingUiState
import com.alexmglesser.controlcenter.mobile.ui.components.NeonButton
import com.alexmglesser.controlcenter.mobile.ui.theme.CC
import com.alexmglesser.controlcenter.mobile.ui.theme.TileShape
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import kotlinx.serialization.json.Json
import java.util.concurrent.Executors

private enum class ConnectMode { INTRO, SCAN, MANUAL }

/** First launch: pair with the PC by QR code or by typing the code (design 3.1). */
@Composable
fun ConnectScreen(viewModel: AppViewModel, pairing: PairingUiState) {
    var mode by rememberSaveable { mutableStateOf(ConnectMode.INTRO) }
    val context = LocalContext.current
    val json = remember { Json { ignoreUnknownKeys = true } }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        mode = if (granted) ConnectMode.SCAN else ConnectMode.MANUAL
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(CC.bgPrimary)
            .systemBarsPadding()
    ) {
        when (mode) {
            ConnectMode.SCAN -> QrScanner(
                onCode = { raw ->
                    val payload = AppViewModel.parsePairingQr(raw, json)
                    if (payload != null) {
                        mode = ConnectMode.INTRO
                        viewModel.pair(payload, AppViewModel.defaultDeviceName())
                    }
                },
                onCancel = { mode = ConnectMode.INTRO }
            )

            ConnectMode.MANUAL -> ManualEntry(
                pairing = pairing,
                onPair = { address, code, name -> viewModel.pair(PairingPayload(address, code, null), name) },
                onBack = {
                    viewModel.clearPairingError()
                    mode = ConnectMode.INTRO
                }
            )

            ConnectMode.INTRO -> Column(
                modifier = Modifier
                    .align(Alignment.Center)
                    .widthIn(max = 560.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Box(
                    Modifier
                        .size(88.dp)
                        .background(CC.bgPanel, TileShape)
                        .border(1.dp, CC.cyan, TileShape),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(painterResource(R.drawable.ic_layout_grid), contentDescription = null, tint = CC.cyan, modifier = Modifier.size(40.dp))
                }
                Text("Connect to your home PC", style = MaterialTheme.typography.headlineSmall, color = CC.textPrimary)
                Text(
                    "On the PC, open Control Center > Settings > Devices > Pair a device, then scan the code it shows.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = CC.textSecondary,
                    textAlign = TextAlign.Center
                )
                Spacer(Modifier.height(8.dp))
                if (pairing.busy) {
                    CircularProgressIndicator(color = CC.cyan)
                    Text("Connecting…", color = CC.textSecondary)
                } else {
                    NeonButton(
                        "Scan QR code",
                        primary = true,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {
                            viewModel.clearPairingError()
                            val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                            if (granted) mode = ConnectMode.SCAN else cameraPermission.launch(Manifest.permission.CAMERA)
                        }
                    )
                    TextButton(onClick = {
                        viewModel.clearPairingError()
                        mode = ConnectMode.MANUAL
                    }) {
                        Text("Enter code manually", color = CC.cyan)
                    }
                }
                pairing.error?.let { Text(it, color = CC.red, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center) }
                Text(
                    "Tailscale must be on, on this phone and on the PC.",
                    style = MaterialTheme.typography.bodySmall,
                    color = CC.textSecondary,
                    textAlign = TextAlign.Center
                )
            }
        }
    }
}

@Composable
private fun ManualEntry(pairing: PairingUiState, onPair: (String, String, String) -> Unit, onBack: () -> Unit) {
    var address by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf(AppViewModel.defaultDeviceName()) }
    val fieldColors = OutlinedTextFieldDefaults.colors(
        focusedBorderColor = CC.cyan,
        unfocusedBorderColor = CC.line,
        focusedLabelColor = CC.cyan,
        cursorColor = CC.cyan
    )
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Column(Modifier.widthIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Enter the code", style = MaterialTheme.typography.headlineSmall, color = CC.textPrimary)
            Text(
                "Use the PC's address shown under the QR code (it ends in .ts.net) and the 8-character code.",
                color = CC.textSecondary,
                style = MaterialTheme.typography.bodySmall
            )
            OutlinedTextField(
                value = address,
                onValueChange = { address = it.trim() },
                label = { Text("PC address") },
                placeholder = { Text("my-pc.tailnet.ts.net") },
                singleLine = true,
                colors = fieldColors,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.uppercase().take(9) },
                label = { Text("Pairing code") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                colors = fieldColors,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(60) },
                label = { Text("This device's name") },
                singleLine = true,
                colors = fieldColors,
                modifier = Modifier.fillMaxWidth()
            )
            pairing.error?.let { Text(it, color = CC.red, style = MaterialTheme.typography.bodySmall) }
            if (pairing.busy) {
                CircularProgressIndicator(color = CC.cyan, modifier = Modifier.align(Alignment.CenterHorizontally))
            } else {
                NeonButton(
                    "Pair",
                    primary = true,
                    enabled = address.isNotBlank() && code.replace(" ", "").length >= 8,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { onPair(address, code, name) }
                )
                TextButton(onClick = onBack, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                    Text("Back", color = CC.textSecondary)
                }
            }
        }
    }
}

/** Camera preview that reports the first QR code it reads. */
@OptIn(ExperimentalGetImage::class)
@Composable
private fun QrScanner(onCode: (String) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val scanner = remember {
        BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
    }
    var delivered by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        onDispose {
            scanner.close()
            analysisExecutor.shutdown()
            runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
        }
    }

    Box(Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { viewContext ->
                val previewView = PreviewView(viewContext)
                val providerFuture = ProcessCameraProvider.getInstance(viewContext)
                providerFuture.addListener({
                    val provider = providerFuture.get()
                    val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    analysis.setAnalyzer(analysisExecutor) { proxy ->
                        val media = proxy.image
                        if (media == null || delivered) {
                            proxy.close()
                            return@setAnalyzer
                        }
                        scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
                            .addOnSuccessListener { codes ->
                                val raw = codes.firstOrNull()?.rawValue
                                if (raw != null && !delivered) {
                                    delivered = true
                                    ContextCompat.getMainExecutor(viewContext).execute { onCode(raw) }
                                }
                            }
                            .addOnCompleteListener { proxy.close() }
                    }
                    runCatching {
                        provider.unbindAll()
                        provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                    }
                }, ContextCompat.getMainExecutor(viewContext))
                previewView
            }
        )
        Box(
            Modifier
                .align(Alignment.Center)
                .size(240.dp)
                .border(2.dp, CC.cyan, TileShape)
        )
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text("Point at the QR code on the PC", color = CC.textPrimary)
            Spacer(Modifier.height(12.dp))
            NeonButton("Cancel", onClick = onCancel)
        }
    }
}
