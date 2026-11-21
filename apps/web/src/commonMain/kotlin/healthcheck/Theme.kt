package healthcheck

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException

val Background = Color(0xFF16202C)
val Panel = Color(0xFF1C2938)
val Raised = Color(0xFF263648)
val Muted = Color(0xFFA8B3BF)
val Accent = Color(0xFF8AB4D8)
val Border = Color(0xFF3B4D61)
val Warning = Color(0xFFE2BD83)

@Composable
fun HealthTheme(fontFamily: FontFamily, content: @Composable () -> Unit) {
    val base = TextStyle(fontFamily = fontFamily, fontSize = 14.sp, lineHeight = 23.sp)
    val typography = Typography(
        displayLarge = base.copy(fontSize = 48.sp, lineHeight = 60.sp),
        displayMedium = base.copy(fontSize = 40.sp, lineHeight = 50.sp),
        displaySmall = base.copy(fontSize = 32.sp, lineHeight = 42.sp),
        headlineLarge = base.copy(fontSize = 28.sp, lineHeight = 38.sp),
        headlineMedium = base.copy(fontSize = 24.sp, lineHeight = 34.sp),
        headlineSmall = base.copy(fontSize = 20.sp, lineHeight = 30.sp, fontWeight = FontWeight.Bold),
        titleLarge = base.copy(fontSize = 18.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
        titleMedium = base.copy(fontSize = 15.sp, fontWeight = FontWeight.Bold),
        titleSmall = base.copy(fontWeight = FontWeight.Bold),
        bodyLarge = base.copy(fontSize = 16.sp, lineHeight = 26.sp),
        bodyMedium = base,
        bodySmall = base.copy(fontSize = 12.sp, lineHeight = 20.sp),
        labelLarge = base.copy(fontWeight = FontWeight.Medium),
        labelMedium = base.copy(fontSize = 12.sp, lineHeight = 20.sp),
        labelSmall = base.copy(fontSize = 11.sp, lineHeight = 18.sp),
    )
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Accent, onPrimary = Background, secondary = Color(0xFFB38CDB),
            background = Background, surface = Panel, surfaceVariant = Raised,
            onBackground = Color(0xFFD0D3D5), onSurface = Color(0xFFD0D3D5), onSurfaceVariant = Muted,
            outline = Border, error = Warning,
        ),
        typography = typography,
        content = content,
    )
}

@Composable
fun PanelCard(title: String, subtitle: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), color = Panel) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(title, style = MaterialTheme.typography.headlineSmall)
            subtitle?.let { Caption(it) }
            content()
        }
    }
}

@Composable
fun Caption(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, style = MaterialTheme.typography.bodySmall, color = Muted)
}

@Composable
fun Notice(message: String, retryLabel: String? = null, retry: () -> Unit = {}) {
    Surface(color = Color(0xFF392F24), shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(message, color = Warning, style = MaterialTheme.typography.bodyMedium)
            if (retryLabel != null) Button(onClick = retry) { Text(retryLabel) }
        }
    }
}

@Composable
fun Loading(message: String) {
    Row(Modifier.padding(vertical = 28.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        Text(message)
    }
}

@Composable
fun Fold(title: String, content: @Composable ColumnScope.() -> Unit) {
    var expanded by remember(title) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        TextButton(onClick = { expanded = !expanded }) { Text("${if (expanded) "−" else "+"} $title") }
        if (expanded) {
            Spacer(Modifier.height(6.dp))
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
        }
    }
}

@Composable
fun SyncInfo(status: PublicStatus, label: String) {
    val state = when (status.state) {
        "ok" -> "同期済み"
        "not-synced" -> "接続待ち"
        "delayed" -> "同期が遅れています"
        else -> "同期に失敗"
    }
    Caption("$label · $state\n最終同期：${status.lastSuccessAt?.let(::dateTime) ?: "未同期"} JST\n最新測定：${status.dataThrough?.let(::dateTime) ?: "値なし"}")
    if (status.error != null) Notice("${syncErrorMessage(status.error.code)} 保存済みの記録を表示しています。最終試行：${dateTime(status.error.at)} JST")
    else if (status.state == "delayed") Notice("最終同期から1時間以上経過しています。表示されている値は保存済みの記録です。")
}

@Composable
fun DataRow(title: String, value: String, note: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Caption(title)
        Text(value)
        note?.let { Caption(it) }
        HorizontalDivider(color = Border)
    }
}

sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Ready<T>(val data: T) : Load<T>
    data class Failed(val message: String) : Load<Nothing>
}

@Composable
fun <T> loadResource(vararg keys: Any?, read: suspend () -> T): Load<T> {
    var state by remember(*keys) { mutableStateOf<Load<T>>(Load.Loading) }
    LaunchedEffect(*keys) {
        state = try {
            Load.Ready(read())
        } catch (error: CancellationException) {
            throw error
        } catch (error: ReadFailure) {
            Load.Failed(error.message ?: "記録を読み取れません。")
        } catch (_: Exception) {
            Load.Failed("記録を読み取れません。再試行してください。")
        }
    }
    return state
}
