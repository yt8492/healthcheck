package healthcheck

import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.platform.LocalFontFamilyResolver
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.platform.Font
import androidx.compose.ui.window.ComposeViewport
import healthcheck.resources.Res
import healthcheck.resources.noto_sans_jp
import io.ktor.client.HttpClient
import io.ktor.client.engine.js.Js
import io.ktor.client.plugins.HttpTimeout
import kotlinx.coroutines.CancellationException
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.getFontResourceBytes
import org.jetbrains.compose.resources.rememberResourceEnvironment

@OptIn(ExperimentalComposeUiApi::class, ExperimentalResourceApi::class)
fun main() {
    val client = HttpClient(Js) {
        expectSuccess = false
        install(HttpTimeout) { requestTimeoutMillis = 30_000 }
    }
    val repository = HttpHealthRepository(client, browserOrigin())
    ComposeViewport("app") {
        val environment = rememberResourceEnvironment()
        val resolver = LocalFontFamilyResolver.current
        var family by remember { mutableStateOf<FontFamily?>(null) }
        LaunchedEffect(environment, resolver) {
            try {
                // One bundled variable font supplies all weights; no external font service is needed.
                val bytes = getFontResourceBytes(environment, Res.font.noto_sans_jp)
                val loaded = FontFamily(listOf(FontWeight.Normal, FontWeight.Medium, FontWeight.Bold).map { weight ->
                    Font("NotoSansJP-${weight.weight}", bytes, weight, FontStyle.Normal, FontVariation.Settings(weight, FontStyle.Normal))
                })
                resolver.preload(loaded)
                family = loaded
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                showFontLoadError()
            }
        }
        family?.let { font ->
            HealthTheme(font) { App(repository, WebNavigation) }
            SideEffect { hideBootScreen() }
        }
    }
}
