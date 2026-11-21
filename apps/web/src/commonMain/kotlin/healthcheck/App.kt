package healthcheck

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun App(repository: HealthRepository, navigation: BrowserNavigation) {
    var selection by remember { mutableStateOf(selectionFromQuery(navigation.readQuery())) }
    var from by remember(selection.range) { mutableStateOf(toInput(selection.range.from).replace('T', ' ')) }
    var to by remember(selection.range) { mutableStateOf(toInput(selection.range.to).replace('T', ' ')) }
    var inputError by remember { mutableStateOf(selection.error) }
    var resolutionError by remember { mutableStateOf<String?>(null) }
    var datesExpanded by remember { mutableStateOf(false) }
    var focusRequest by remember { mutableIntStateOf(0) }
    var refresh by remember { mutableIntStateOf(0) }
    var heartRetry by remember { mutableIntStateOf(0) }
    var sleepRetry by remember { mutableIntStateOf(0) }
    var activityRetry by remember { mutableIntStateOf(0) }
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()

    LaunchedEffect(navigation) { navigation.writeSelection(selection, replace = true) }
    DisposableEffect(navigation) {
        val remove = navigation.observeHistory {
            selection = selectionFromQuery(navigation.readQuery())
            inputError = selection.error
            resolutionError = null
        }
        onDispose(remove)
    }

    val heart = loadResource(repository, selection.range, selection.resolution, refresh, heartRetry) {
        repository.heart(selection.range, selection.resolution)
    }
    val sleep = loadResource(repository, selection.range, refresh, sleepRetry) { repository.sleep(selection.range) }
    val activity = loadResource(repository, selection.range, selection.activityMetric, refresh, activityRetry) {
        repository.activity(selection.range, selection.activityMetric)
    }

    fun chooseRange(range: TimeRange, requested: String = selection.resolution) {
        val resolution = runCatching { resolvedHeartResolution(requested, range); requested }.getOrDefault("auto")
        selection = selection.copy(range = range, resolution = resolution, error = null)
        inputError = null
        resolutionError = null
        navigation.writeSelection(selection)
    }

    Surface(Modifier.fillMaxSize(), color = Background) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Surface(color = Background, modifier = Modifier.fillMaxWidth()) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    Text("Healthcheck", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    listOf("期間", "心拍", "睡眠", "活動").forEachIndexed { index, label ->
                        TextButton(onClick = { scope.launch { list.scrollToItem(index) } }, contentPadding = PaddingValues(horizontal = 8.dp)) { Text(label) }
                    }
                }
            }
            BoxWithConstraints(Modifier.widthIn(max = 1180.dp).fillMaxSize()) {
                val viewportHeight = maxHeight
                LazyColumn(
                    state = list,
                    modifier = Modifier.widthIn(max = 1180.dp).fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 32.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    item(key = "period") {
                        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            if ((heart as? Load.Ready)?.data?.status?.environment == "emulator") Notice("Emulatorの架空データ — 画面と保存処理を確認するための記録です。")
                            PanelCard("表示期間", "${dateTime(selection.range.from)} ～ ${dateTime(selection.range.to)} JST") {
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    listOf(1, 7, 30, 90).forEach { days ->
                                        OutlinedButton(onClick = { chooseRange(presetRange(days), "auto") }) { Text(if (days == 1) "直近24時間" else "${days}日") }
                                    }
                                }
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(onClick = { chooseRange(moveRange(selection.range, -1)) }, enabled = millis(selection.range.from) > retentionStart(nowMillis())) { Text("前の期間") }
                                    OutlinedButton(onClick = { chooseRange(moveRange(selection.range, 1)) }, enabled = millis(selection.range.to) < floorMinute(nowMillis())) { Text("次の期間") }
                                }
                                TextButton(onClick = { datesExpanded = !datesExpanded }) { Text("日時を指定する") }
                                if (datesExpanded) {
                                    val requester = remember { FocusRequester() }
                                    OutlinedTextField(value = from, onValueChange = { from = it }, singleLine = true,
                                        label = { Text("開始日時（JST）") }, placeholder = { Text("YYYY-MM-DD HH:mm") },
                                        modifier = Modifier.fillMaxWidth().focusRequester(requester).semantics { contentDescription = "開始日時（JST）" })
                                    OutlinedTextField(value = to, onValueChange = { to = it }, singleLine = true,
                                        label = { Text("終了日時（JST）") }, placeholder = { Text("YYYY-MM-DD HH:mm") },
                                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "終了日時（JST）" })
                                    LaunchedEffect(focusRequest) { if (focusRequest > 0) requester.requestFocus() }
                                    Button(onClick = {
                                        try { chooseRange(inputRange(from, to)) }
                                        catch (error: IllegalArgumentException) { inputError = error.message }
                                    }) { Text("表示する") }
                                    Caption("直近90日以内を YYYY-MM-DD HH:mm で指定できます。")
                                }
                                inputError?.let { Notice(it) }
                            }
                        }
                    }
                    item(key = "heart") {
                        HeartPanel(heart, selection.resolution, resolutionError, onResolution = { next ->
                            try {
                                resolvedHeartResolution(next, selection.range)
                                selection = selection.copy(resolution = next)
                                resolutionError = null
                                navigation.writeSelection(selection)
                            } catch (error: IllegalArgumentException) { resolutionError = error.message }
                        }, onRefresh = { refresh++ }, retry = { heartRetry++ })
                    }
                    item(key = "sleep") {
                        SleepPanel(sleep, selection.range, retry = { sleepRetry++ }, fillPeriod = { range ->
                            from = dateTime(range.from)
                            to = dateTime(range.to)
                            datesExpanded = true
                            inputError = null
                            focusRequest++
                            scope.launch { list.scrollToItem(0) }
                        })
                    }
                    item(key = "activity") {
                        // Keep this item at the viewport's start even while earlier panels load.
                        Box(Modifier.heightIn(min = viewportHeight)) {
                            ActivityPanel(activity, selection.metric, retry = { activityRetry++ }, chooseMetric = { next ->
                                selection = selection.copy(metric = next)
                                navigation.writeSelection(selection)
                            })
                        }
                    }
                    item(key = "footer") {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("記録について", style = MaterialTheme.typography.titleMedium)
                            Caption("Googleのウェアラブルデバイスから取得した記録です。未装着や未取得の時間は欠損として表示します。測定から90日間保存し、時刻は日本時間で表示します。デバイスからの反映には時間差があります。")
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                listOf("healthcheckについて" to "/about/", "プライバシーポリシー" to "/privacy/", "利用規約" to "/terms/").forEach { (label, path) ->
                                    TextButton(onClick = { navigation.navigate(path) }) { Text(label) }
                                }
                                val query = mapOf("from" to selection.range.from, "to" to selection.range.to, "metric" to "heart-rate", "resolution" to selection.resolution)
                                    .entries.joinToString("&") { (key, value) -> "$key=${value.encodeURLParameter()}" }
                                TextButton(onClick = { navigation.navigate("/api/v1/timeseries?$query") }) { Text("この期間のJSON") }
                            }
                        }
                    }
                }
            }
        }
    }
}
