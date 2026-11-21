package healthcheck

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import kotlinx.datetime.toLocalDateTime
import kotlin.time.Instant

@Composable
fun HeartPanel(
    state: Load<HeartResponse>,
    resolution: String,
    resolutionError: String?,
    onResolution: (String) -> Unit,
    onRefresh: () -> Unit,
    retry: () -> Unit,
) {
    PanelCard("心拍の記録") {
        HeartResolutionDropdown(resolution, onResolution)
        resolutionError?.let { Notice(it) }
        OutlinedButton(onClick = onRefresh, enabled = state !is Load.Loading) { Text("記録を更新") }
        when (state) {
            Load.Loading -> Loading("心拍の記録を読み込んでいます")
            is Load.Failed -> {
                Text("記録を表示できません", style = MaterialTheme.typography.titleMedium)
                Notice(state.message, "心拍を再試行", retry)
            }
            is Load.Ready -> {
                val data = state.data
                SyncInfo(data.status, "心拍")
                val stats = listOf(
                    "期間の平均" to number(data.summary.avg), "最小心拍" to number(data.summary.min),
                    "最大心拍" to number(data.summary.max), "期間内の最新測定" to number(data.summary.latest?.avg),
                )
                BoxWithConstraints {
                    val columnCount = if (maxWidth < 650.dp) 2 else 4
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        stats.chunked(columnCount).forEach { row ->
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                row.forEach { (label, value) ->
                                    Surface(Modifier.weight(1f), color = Raised, shape = RoundedCornerShape(10.dp)) {
                                        Column(Modifier.padding(12.dp)) {
                                            Caption(label)
                                            Text(value, style = MaterialTheme.typography.headlineMedium)
                                            Caption("bpm")
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                data.summary.latest?.let { Caption("期間内の最新測定：${dateTime(it.time)} JST") }
                val coverage = if (data.summary.totalMinutes > 0) data.summary.availableMinutes * 100 / data.summary.totalMinutes else 0
                Caption("取得できた分 ${data.summary.availableMinutes} / ${data.summary.totalMinutes}（$coverage%）")
                if (data.summary.availableMinutes > 0) {
                    Text("${heartResolutionLabels[data.resolution]}平均・最小〜最大", style = MaterialTheme.typography.titleMedium)
                    HeartChart(data)
                    Fold("最後の60区間を表で確認する") {
                        data.points.takeLast(60).forEach { point ->
                            DataRow("${dateTime(point.time)} ～ ${dateTime(point.to)} JST",
                                "平均 ${number(point.value?.avg)} / 最小 ${number(point.value?.min)} / 最大 ${number(point.value?.max)} bpm",
                                "取得できた分 ${point.availableMinutes} / ${point.totalMinutes}")
                        }
                    }
                } else {
                    Text(if (data.status.state == "not-synced") "まだ記録がありません" else "この期間のデータはありません")
                }
                Caption("全欠損の区間は線をつなぎません。一部欠損は取得できた分だけの平均です。帯は各区間の最小〜最大です。")
                Caption("平均は有効な1分平均の合計 ÷ 有効な分数。元の秒単位サンプル数による平均ではありません。期間端の端数は指定範囲だけを集計します。")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HeartResolutionDropdown(resolution: String, onResolution: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Caption("心拍の表示粒度")
    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = it },
        modifier = Modifier.widthIn(max = 240.dp).fillMaxWidth(),
    ) {
        OutlinedTextField(
            value = heartResolutionLabels.getValue(resolution),
            onValueChange = {},
            readOnly = true,
            singleLine = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth().semantics { contentDescription = "心拍の表示粒度" },
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            heartResolutionLabels.forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        expanded = false
                        onResolution(value)
                    },
                    modifier = Modifier.semantics { selected = resolution == value },
                )
            }
        }
    }
}

@Composable
fun SleepPanel(state: Load<SleepResponse>, range: TimeRange, retry: () -> Unit, fillPeriod: (TimeRange) -> Unit) {
    PanelCard("睡眠の記録", "起床日で集計（JST）") {
        when (state) {
            Load.Loading -> Loading("睡眠の全ページを読み込んでいます")
            is Load.Failed -> Notice(state.message, "睡眠を再試行", retry)
            is Load.Ready -> {
                val data = state.data
                val summary = remember(data.sessions, range) { summarizeSleep(data.sessions, range) }
                Fold("睡眠の同期状況を確認") { SyncInfo(data.status, "睡眠") }
                if (data.status.error != null) Notice("睡眠の取得に失敗しています。${syncErrorMessage(data.status.error.code)} 保存済みの記録を表示しています。")
                else if (data.status.state == "delayed") Notice("睡眠の最終同期から1時間以上経過しています。保存済みの記録です。")
                if (data.status.lastSuccessAt != null && data.coverage != "fetched") Notice("この期間の取得は完了していません。取得済みの記録だけを表示しています。")
                if (data.sessions.isEmpty()) {
                    Text(when {
                        data.status.state == "not-synced" -> "睡眠は未取得です。本人の睡眠読み取りへの同意と同期後に表示されます。"
                        data.status.state == "error" -> "睡眠の取得に失敗しています。データがないとは判断できません。"
                        data.coverage != "fetched" -> "この期間の睡眠は未取得、または一部だけ取得済みです。"
                        else -> "この期間に取得できた睡眠はありません。未装着・未提供・記録なしの区別はできません。"
                    })
                } else {
                    Text("表示期間内の合計：睡眠 ${durationText(summary.totals.asleepMinutes)} · ${summary.sessionCount}セッション")
                    if (millis(range.to) - millis(range.from) > 2 * DAY) {
                        val maxDuration = summary.days.maxOfOrNull { it.totals.durationMinutes }?.coerceAtLeast(1.0) ?: 1.0
                        summary.days.forEach { day ->
                            Column {
                                Canvas(Modifier.fillMaxWidth().height(12.dp)) {
                                    var x = 0f
                                    sleepLabels.keys.forEach { type ->
                                        val width = ((day.totals.stageMinutes[type] ?: 0.0) / maxDuration * size.width).toFloat()
                                        drawRect(sleepColor(type), Offset(x, 0f), Size(width, size.height))
                                        x += width
                                    }
                                }
                                Fold("${day.date} · 睡眠 ${durationText(day.totals.asleepMinutes)} · ${day.sessions.size}セッション") {
                                    Caption(sleepLabels.entries.joinToString(" / ") { (type, label) -> "$label ${durationText(day.totals.stageMinutes[type])}" })
                                    day.sessions.forEach { session -> SleepDetails(session, fillPeriod) }
                                }
                            }
                        }
                    } else {
                        SleepSessionView(data.sessions, range, fillPeriod)
                    }
                }
            }
        }
        Caption("内訳は表示期間と重なる部分だけを集計。詳細にはセッション全体を表示します。段階未提供を睡眠0とは扱いません。")
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SleepSessionView(sessions: List<SleepSession>, range: TimeRange, fillPeriod: (TimeRange) -> Unit) {
    var selectedId by remember(sessions) { mutableStateOf<String?>(null) }
    val session = sessions.find { it.id == selectedId } ?: sessions.lastOrNull { it.nap != true } ?: sessions.last()
    if (sessions.size > 1) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            sessions.forEachIndexed { index, entry ->
                FilterChip(selected = session.id == entry.id, onClick = { selectedId = entry.id },
                    label = { Text("${if (entry.nap == true) "昼寝" else "睡眠${index + 1}"} ${shortDate(entry.startTime)} ${timeOnly(entry.startTime)}") })
            }
        }
    }
    Text("睡眠時間", style = MaterialTheme.typography.titleMedium)
    Text(durationText(session.asleepMinutes), style = MaterialTheme.typography.displaySmall)
    Caption("${dateTime(session.startTime)} ～ ${dateTime(session.endTime)} JST\n記録の長さ ${durationText(session.durationMinutes)} · 覚醒・離床 ${durationText(session.stageMinutes["awake"])}")
    if (millis(session.startTime) < millis(range.from) || millis(session.endTime) > millis(range.to)) Caption("表示期間には睡眠の一部が含まれます。下のグラフと詳細はセッション全体です。")
    SleepTimeline(session)
    SleepDetails(session, fillPeriod)
}

@Composable
private fun SleepDetails(session: SleepSession, fillPeriod: (TimeRange) -> Unit) {
    Fold("詳細を見る · ${dateTime(session.startTime)} ～ ${dateTime(session.endTime)}${if (session.nap == true) " · 昼寝" else ""}") {
        val precise: (String) -> String = { Instant.parse(it).toLocalDateTime(jst).toString().replace('T', ' ') }
        Text("実際の開始：${precise(session.startTime)} JST")
        Text("実際の終了：${precise(session.endTime)} JST")
        Caption("JSTの起床日：${session.wakeDate} · セッション全体 ${durationText(session.durationMinutes)}")
        OutlinedButton(onClick = { fillPeriod(sleepContext(session)) }) { Text("この睡眠前後の日時を入力") }
        session.stages.forEach { stage ->
            DataRow("${dateTime(stage.startTime)} ～ ${dateTime(stage.endTime)} JST",
                "${sleepLabels[stage.type] ?: "段階未提供"} · ${durationText((millis(stage.endTime) - millis(stage.startTime)) / MINUTE.toDouble())}")
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ActivityPanel(state: Load<ActivityResponse>, metricParam: String, retry: () -> Unit, chooseMetric: (String) -> Unit) {
    val metric = metricParam.takeIf { it in activitySpecs } ?: "steps"
    val spec = activitySpecs.getValue(metric)
    PanelCard("活動の記録", "歩数・距離・総消費カロリー・アクティブゾーン時間") {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            activitySpecs.forEach { (value, item) ->
                FilterChip(selected = metric == value, onClick = { chooseMetric(value) }, label = { Text(item.label) })
            }
        }
        if (metricParam !in activitySpecs) Notice("活動の指標が不正です。")
        when (state) {
            Load.Loading -> Loading("活動の記録を読み込んでいます")
            is Load.Failed -> Notice(state.message, "活動を再試行", retry)
            is Load.Ready -> {
                val data = state.data
                SyncInfo(data.status, spec.label)
                if (data.coverage != "fetched") Notice("この期間の活動は${if (data.coverage == "not-fetched") "未取得" else "一部だけ取得済み"}です。合計は取得できた値だけの集計です。")
                Text("${spec.label}：${number(data.summary.total, 3, trimZeros = true)} ${spec.unit}", style = MaterialTheme.typography.headlineMedium)
                Caption("値あり ${data.summary.availableMinutes} / ${data.summary.totalMinutes}分 · 値の省略 ${data.summary.omittedMinutes}分 · レコードなし ${data.summary.missingMinutes}分")
                if (data.summary.availableMinutes > 0) ActivityChart(data)
                else Text(if (data.coverage == "not-fetched") "この期間の活動はまだ取得していません。" else "この期間に数値のある活動データはありません。")
                val resolution = when (data.resolution) { "1m" -> "1分"; "1h" -> "1時間"; else -> "JSTの1日" }
                Caption("${resolution}ごとの既知値の合計。0は数値として表示し、値の省略・レコードなしは補完しません。欠けた分がある合計は一部の値です。")
                if (metric == "total-calories") Caption("基礎代謝を含む総消費カロリーです。運動分だけのカロリーではありません。")
                if (metric == "active-zone-minutes") Caption("強度を反映したポイント数です。実際に運動した時間とは異なり、上流で加重された値を再加重しません。")
                Fold("活動の日別合計を確認する") {
                    data.summary.days.forEach { day ->
                        DataRow(day.date, "${number(day.total, 3, trimZeros = true)} ${spec.unit}",
                            "値あり ${day.availableMinutes} / ${day.totalMinutes}分 · ${if (day.partialDay) "途中集計" else "1日"}${if (day.availableMinutes < day.totalMinutes) "・欠損あり" else ""}")
                    }
                }
            }
        }
    }
}
