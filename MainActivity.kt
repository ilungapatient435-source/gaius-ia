package com.example

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.example.ui.theme.MyApplicationTheme
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream
import org.json.JSONObject

class MainActivity : ComponentActivity() {
  private var webViewRef: WebView? = null
  private var filePathCallback: ValueCallback<Array<Uri>>? = null
  private var pendingWebPermissionRequest: PermissionRequest? = null
  private var pendingOAuthToken: String? = null
  private var pageLoaded by mutableStateOf(false)

  private val sanitizedServerUrl: String by lazy {
    BuildConfig.APP_SERVER_URL.trim().trim('"').trim('\'').trimEnd('/')
  }

  private val audioPermissionLauncher =
      registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val req = pendingWebPermissionRequest
        pendingWebPermissionRequest = null
        if (req != null) {
          if (granted) {
            req.grant(req.resources)
          } else {
            req.deny()
          }
        }
      }

  private val fileChooserLauncher =
      registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val cb = filePathCallback
        filePathCallback = null
        if (cb != null) {
          cb.onReceiveValue(if (uris.isNullOrEmpty()) null else uris.toTypedArray())
        }
      }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    extractOAuthToken(intent)

    setContent {
      MyApplicationTheme {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background,
        ) {
          Box(
              modifier =
                  Modifier.fillMaxSize()
                      .windowInsetsPadding(WindowInsets.safeDrawing.union(WindowInsets.ime)),
          ) {
            BackHandler(enabled = true) {
              val wv = webViewRef
              if (wv != null && wv.canGoBack()) {
                wv.goBack()
              } else {
                finish()
              }
            }

            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx -> createConfiguredWebView(ctx) },
            )
          }
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    extractOAuthToken(intent)
    flushPendingOAuthToken()
  }

  override fun onDestroy() {
    webViewRef?.destroy()
    webViewRef = null
    super.onDestroy()
  }

  private fun extractOAuthToken(intent: Intent?) {
    val data = intent?.data ?: return
    if (data.scheme == "gaiusia" && data.host == "auth") {
      val token = data.getQueryParameter("token")
      if (!token.isNullOrBlank()) {
        pendingOAuthToken = token
      }
    }
  }

  private fun flushPendingOAuthToken() {
    val token = pendingOAuthToken ?: return
    val wv = webViewRef ?: return
    if (!pageLoaded) return
    pendingOAuthToken = null
    val js = "window.__handleApkOAuthCallback__ && window.__handleApkOAuthCallback__(${JSONObject.quote(token)});"
    wv.post { wv.evaluateJavascript(js, null) }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun createConfiguredWebView(context: android.content.Context): WebView {
    val webView =
        WebView(context).apply {
          layoutParams =
              ViewGroup.LayoutParams(
                  ViewGroup.LayoutParams.MATCH_PARENT,
                  ViewGroup.LayoutParams.MATCH_PARENT,
              )
          settings.javaScriptEnabled = true
          settings.domStorageEnabled = true
          settings.mediaPlaybackRequiresUserGesture = false
          settings.allowContentAccess = true
          settings.allowFileAccess = false
          settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
          settings.useWideViewPort = true
          settings.loadWithOverviewMode = true
          isFocusable = true
          isFocusableInTouchMode = true

          addJavascriptInterface(AndroidBridge(), "AndroidBridge")

          webViewClient =
              object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?,
                ): WebResourceResponse? {
                  val uri = request?.url ?: return super.shouldInterceptRequest(view, request)
                  if (uri.scheme == "https" && uri.host == APP_ASSET_HOST) {
                    return serveLocalAsset(uri.path ?: "/")
                  }
                  return super.shouldInterceptRequest(view, request)
                }

                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                  super.onPageStarted(view, url, favicon)
                  injectRuntimeConfig(view)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                  super.onPageFinished(view, url)
                  pageLoaded = true
                  injectRuntimeConfig(view)
                  flushPendingOAuthToken()
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?,
                ): Boolean {
                  val uri = request?.url ?: return false
                  if (uri.host == APP_ASSET_HOST) {
                    return false
                  }
                  openUriExternally(uri.toString())
                  return true
                }
              }

          webChromeClient =
              object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest?) {
                  if (request == null) return
                  val needsAudio =
                      request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                  if (!needsAudio) {
                    request.grant(request.resources)
                    return
                  }
                  val granted =
                      ContextCompat.checkSelfPermission(
                          this@MainActivity,
                          Manifest.permission.RECORD_AUDIO,
                      ) == PackageManager.PERMISSION_GRANTED
                  if (granted) {
                    request.grant(request.resources)
                  } else {
                    pendingWebPermissionRequest?.deny()
                    pendingWebPermissionRequest = request
                    audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                  }
                }

                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?,
                ): Boolean {
                  this@MainActivity.filePathCallback?.onReceiveValue(null)
                  this@MainActivity.filePathCallback = filePathCallback
                  val acceptTypes =
                      fileChooserParams?.acceptTypes?.filter { it.isNotBlank() }?.toTypedArray()
                          ?: arrayOf("*/*")
                  return try {
                    fileChooserLauncher.launch(
                        if (acceptTypes.isNotEmpty()) acceptTypes else arrayOf("*/*"),
                    )
                    true
                  } catch (_: Exception) {
                    this@MainActivity.filePathCallback = null
                    false
                  }
                }
              }

          loadUrl("https://$APP_ASSET_HOST/index.html")
        }

    webViewRef = webView
    return webView
  }

  private fun injectRuntimeConfig(view: WebView?) {
    if (view == null) return
    val js =
        """
        window.__GAIUS_IS_APK__ = true;
        window.__GAIUS_APP_SERVER_URL__ = ${JSONObject.quote(sanitizedServerUrl)};
        window.__GAIUS_CONFIG__ = { isApk: true, serverUrl: ${JSONObject.quote(sanitizedServerUrl)} };
        """
            .trimIndent()
    view.evaluateJavascript(js, null)
  }

  private fun serveLocalAsset(rawPath: String): WebResourceResponse {
    var relPath = rawPath.trimStart('/')
    if (relPath.isEmpty()) relPath = "index.html"

    val assetPath = "www/$relPath"
    return try {
      val stream = assets.open(assetPath)
      WebResourceResponse(guessMimeType(relPath), "UTF-8", stream)
    } catch (_: Exception) {
      if (!relPath.contains('.')) {
        try {
          val fallback = assets.open("www/index.html")
          return WebResourceResponse("text/html", "UTF-8", fallback)
        } catch (_: Exception) {
          // Fall through to 404
        }
      }
      WebResourceResponse(
          "text/plain",
          "UTF-8",
          404,
          "Not Found",
          emptyMap(),
          ByteArrayInputStream(ByteArray(0)),
      )
    }
  }

  private fun guessMimeType(path: String): String {
    val clean = path.substringBefore('?').substringBefore('#').lowercase()
    return when {
      clean.endsWith(".html") -> "text/html"
      clean.endsWith(".js") || clean.endsWith(".mjs") -> "application/javascript"
      clean.endsWith(".css") -> "text/css"
      clean.endsWith(".json") -> "application/json"
      clean.endsWith(".png") -> "image/png"
      clean.endsWith(".jpg") || clean.endsWith(".jpeg") -> "image/jpeg"
      clean.endsWith(".svg") -> "image/svg+xml"
      clean.endsWith(".webp") -> "image/webp"
      clean.endsWith(".ico") -> "image/x-icon"
      clean.endsWith(".woff2") -> "font/woff2"
      clean.endsWith(".woff") -> "font/woff"
      clean.endsWith(".ttf") -> "font/ttf"
      clean.endsWith(".wav") -> "audio/wav"
      clean.endsWith(".mp3") -> "audio/mpeg"
      else -> "application/octet-stream"
    }
  }

  private fun openUriExternally(url: String) {
    try {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
      startActivity(intent)
    } catch (_: Exception) {
      runOnUiThread {
        Toast.makeText(this, "Impossible d'ouvrir le lien externe.", Toast.LENGTH_SHORT).show()
      }
    }
  }

  inner class AndroidBridge {
    @JavascriptInterface fun isApk(): Boolean = true

    @JavascriptInterface fun getServerUrl(): String = sanitizedServerUrl

    @JavascriptInterface
    fun openExternalUrl(url: String) {
      if (url.isNotBlank()) {
        runOnUiThread { openUriExternally(url) }
      }
    }

    @JavascriptInterface
    fun downloadFile(filename: String, mimeType: String, base64Data: String) {
      try {
        val pureBase64 =
            if (base64Data.contains(",")) base64Data.substringAfter(",") else base64Data
        val bytes = Base64.decode(pureBase64, Base64.DEFAULT)
        val safeName =
            filename.replace(Regex("[^a-zA-Z0-9._-]"), "_").ifBlank { "document_gaius.bin" }
        val safeMime = mimeType.ifBlank { "application/octet-stream" }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          val values =
              ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                put(MediaStore.Downloads.MIME_TYPE, safeMime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
              }
          val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
          if (uri != null) {
            contentResolver.openOutputStream(uri)?.use { out -> out.write(bytes) }
          }
        } else {
          @Suppress("DEPRECATION")
          val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
          if (!dir.exists()) dir.mkdirs()
          val file = File(dir, safeName)
          FileOutputStream(file).use { out -> out.write(bytes) }
        }

        runOnUiThread {
          Toast.makeText(
                  this@MainActivity,
                  "Enregistré dans Téléchargements : $safeName",
                  Toast.LENGTH_LONG,
              )
              .show()
        }
      } catch (_: Exception) {
        runOnUiThread {
          Toast.makeText(
                  this@MainActivity,
                  "Impossible d'enregistrer le fichier sur l'appareil.",
                  Toast.LENGTH_LONG,
              )
              .show()
        }
      }
    }
  }

  companion object {
    private const val APP_ASSET_HOST = "appassets.androidplatform.net"
  }
}
