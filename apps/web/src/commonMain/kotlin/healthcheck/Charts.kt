package healthcheck

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import kotlin.math.ceil
import kotlin.math.floor

private data class PlotArea(
    val left: Float, val top: Float, val width: Float, val height: Float,
    val start: Long, val end: Long, val minimum: Double, val maximum: Double,
) {
    fun x(time: Long) = left + ((time - start).toDouble() / (end - start).coerceAtLeast(1) * width).toFloat()
    fun y(value: Double) = top + ((maximum - value) / (maximum - minimum) * height).toFloat()
}

private fun Modifier.chartInteraction(start: Long, end: Long, onTime: (Long) -> Unit): Modifier =
    pointerInput(start, end) {
        fun select(x: Float) {
            val fraction = ((x - 46.dp.toPx()) / (size.width - 58.dp.toPx()).coerceAtLeast(1f)).coerceIn(0f, 1f)
            onTime(start + ((end - start) * fraction.toDouble()).toLong())
        }
        detectTapGestures { select(it.x) }
    }.pointerInput(start, end) {
        awaitPointerEventScope {
            while (true) {
                val event = awaitPointerEvent()
                if (event.type == PointerEventType.Move && event.changes.none { it.pressed }) {
                    val fraction = ((event.changes.first().position.x - 46.dp.toPx()) / (size.width - 58.dp.toPx()).coerceAtLeast(1f)).coerceIn(0f, 1f)
                    onTime(start + ((end - start) * fraction.toDouble()).toLong())
                }
            }
        }
    }

@Composable
private fun Plot(
    from: String, to: String, minimum: Double, maximum: Double,
    label: String, selectionTime: Long?, onTime: (Long) -> Unit,
    content: DrawScope.(PlotArea) -> Unit,
) {
    val measurer = rememberTextMeasurer()
    val textStyle = MaterialTheme.typography.labelSmall.copy(color = Muted)
    val start = millis(from)
    val end = millis(to)
    val select by rememberUpdatedState(onTime)
    Canvas(Modifier.fillMaxWidth().height(260.dp)
        .semantics { contentDescription = label; role = Role.Image }
        .chartInteraction(start, end) { select(it) }) {
        val plot = PlotArea(46.dp.toPx(), 12.dp.toPx(), (size.width - 58.dp.toPx()).coerceAtLeast(1f), size.height - 48.dp.toPx(), start, end, minimum, maximum)
        for (step in 0..4) {
            val value = minimum + (maximum - minimum) * step / 4
            val y = plot.y(value)
            drawLine(Border, Offset(plot.left, y), Offset(plot.left + plot.width, y), 1.dp.toPx())
            drawText(measurer, number(value, 0), Offset(0f, y - 8.dp.toPx()), style = textStyle)
        }
        for (step in 0..3) {
            val time = start + (end - start) * step / 3
            val text = if (end - start > DAY) shortDate(iso(time)) else timeOnly(iso(time))
            val measured = measurer.measure(text, textStyle)
            val x = (plot.x(time) - measured.size.width / 2).coerceIn(0f, (size.width - measured.size.width).coerceAtLeast(0f))
            drawText(measured, topLeft = Offset(x, plot.top + plot.height + 10.dp.toPx()))
        }
        content(plot)
        selectionTime?.let {
            drawLine(Muted, Offset(plot.x(it), plot.top), Offset(plot.x(it), plot.top + plot.height), 1.dp.toPx())
        }
    }
}

private fun bucketIndex(starts: List<Long>, time: Long): Int {
    if (starts.isEmpty()) return -1
    val found = starts.binarySearch(time)
    return (if (found >= 0) found else -found - 2).coerceIn(starts.indices)
}

@Composable
fun HeartChart(data: HeartResponse) {
    var selected by remember(data) { mutableStateOf<Int?>(null) }
    val starts = remember(data) { data.points.map { millis(it.time) } }
    val segments = remember(data) { heartSegments(data.points) }
    val values = remember(data) { data.points.mapNotNull { it.value } }
    val min = maxOf(0.0, floor((values.minOfOrNull { it.min } ?: 0.0) / 10) * 10 - 10)
    val max = maxOf(min + 20, ceil((values.maxOfOrNull { it.max } ?: 100.0) / 10) * 10 + 10)
    Plot(data.from, data.to, min, max,
        "心拍の${heartResolutionLabels[data.resolution]}平均と最小・最大のグラフ", selected?.let { starts.getOrNull(it) },
        onTime = { selected = bucketIndex(starts, it).takeIf { index -> index >= 0 } }) { plot ->
        segments.forEach { segment ->
            val band = Path()
            segment.forEachIndexed { index, p ->
                val x = plot.x(millis(p.time)); val y = plot.y(p.value!!.max)
                if (index == 0) band.moveTo(x, y) else band.lineTo(x, y)
            }
            segment.asReversed().forEach { p -> band.lineTo(plot.x(millis(p.time)), plot.y(p.value!!.min)) }
            band.close()
            drawPath(band, Accent.copy(alpha = 0.25f))
            val line = Path()
            segment.forEachIndexed { index, p ->
                val point = Offset(plot.x(millis(p.time)), plot.y(p.value!!.avg))
                if (index == 0) line.moveTo(point.x, point.y) else line.lineTo(point.x, point.y)
                if (segment.size == 1) {
                    drawLine(Accent.copy(alpha = 0.4f), Offset(point.x, plot.y(p.value.min)), Offset(point.x, plot.y(p.value.max)), 3.dp.toPx())
                    drawCircle(Accent, 3.dp.toPx(), point)
                }
            }
            drawPath(line, Accent, style = Stroke(1.8.dp.toPx()))
        }
    }
    val point = selected?.let { data.points.getOrNull(it) }
    if (point != null) {
        Text("${dateTime(point.time)} ～ ${dateTime(point.to)} JST")
        Caption(if (point.value == null) "データなし · 取得できた分 ${point.availableMinutes} / ${point.totalMinutes}"
        else "平均 ${number(point.value.avg)} bpm · 最小 ${number(point.value.min)} / 最大 ${number(point.value.max)} · 取得できた分 ${point.availableMinutes} / ${point.totalMinutes}")
    } else Caption("グラフをタップするか、ポインターを合わせると値を確認できます。")
}

@Composable
fun ActivityChart(data: ActivityResponse) {
    var selected by remember(data) { mutableStateOf<Int?>(null) }
    val starts = remember(data) { data.points.map { millis(it.from) } }
    val spec = activitySpecs.getValue(data.metric)
    val max = maxOf(1.0, (data.points.mapNotNull { it.total }.maxOrNull() ?: 1.0) * 1.15)
    Plot(data.from, data.to, 0.0, max, "${spec.label}の合計グラフ", selected?.let { starts.getOrNull(it) },
        onTime = { selected = bucketIndex(starts, it).takeIf { index -> index >= 0 } }) { plot ->
        data.points.forEach { point ->
            point.total?.let { total ->
                val x = plot.x(millis(point.from))
                val interval = plot.x(millis(point.to)) - x
                val width = maxOf(0.5f, interval * 0.8f)
                val height = maxOf(1f, plot.y(0.0) - plot.y(total))
                drawRect(Accent, Offset(x + (interval - width) / 2, plot.y(0.0) - height), Size(width, height))
            }
        }
    }
    val point = selected?.let { data.points.getOrNull(it) }
    if (point != null) {
        Text("${dateTime(point.from)} ～ ${dateTime(point.to)} JST")
        Caption("${number(point.total, 3, trimZeros = true)} ${spec.unit} · 値あり ${point.availableMinutes} / ${point.totalMinutes}分")
    } else Caption("単位：${spec.unit} · タップまたはポインターで値を確認できます。")
}

fun sleepColor(type: String): Color = when (type) {
    "awake" -> Color(0xFFE78BAA)
    "restless" -> Color(0xFFE2BD70)
    "rem" -> Color(0xFF75CDE1)
    "light" -> Color(0xFF7FAFFF)
    "deep" -> Color(0xFFB38CDB)
    "asleep" -> Color(0xFF94C5B0)
    else -> Color(0xFFA8B3BF)
}

@Composable
fun SleepTimeline(session: SleepSession) {
    var selected by remember(session) { mutableStateOf<SleepStage?>(null) }
    val rows = remember(session) {
        val standard = when (session.type) { "stages" -> listOf("awake", "rem", "light", "deep"); "classic" -> listOf("awake", "restless", "asleep"); else -> emptyList() }
        sleepLabels.keys.filter { it in standard || (session.stageMinutes[it] ?: 0.0) > 0 }
    }
    val measurer = rememberTextMeasurer()
    val style = MaterialTheme.typography.labelSmall
    val start = millis(session.startTime)
    val end = millis(session.endTime)
    Canvas(Modifier.fillMaxWidth().height((rows.size * 56 + 34).dp)
        .semantics { contentDescription = "睡眠段階のタイムライン"; role = Role.Image }
        .pointerInput(session) {
            detectTapGestures { position ->
                val time = start + ((position.x / size.width).coerceIn(0f, 1f) * (end - start).toDouble()).toLong()
                selected = session.stages.find { millis(it.startTime) <= time && time < millis(it.endTime) }
            }
        }) {
        fun x(time: Long) = ((time - start).toDouble() / (end - start).coerceAtLeast(1) * size.width).toFloat()
        rows.forEachIndexed { index, type ->
            val top = index * 56.dp.toPx()
            drawText(measurer, "${sleepLabels[type]}  ${durationText(session.stageMinutes[type])}", Offset(0f, top), style.copy(color = sleepColor(type)))
            drawRoundRect(Raised, Offset(0f, top + 24.dp.toPx()), Size(size.width, 16.dp.toPx()), cornerRadius = androidx.compose.ui.geometry.CornerRadius(4.dp.toPx()))
        }
        session.stages.forEach { stage ->
            val index = rows.indexOf(stage.type)
            if (index >= 0) {
                val left = x(millis(stage.startTime))
                drawRect(sleepColor(stage.type), Offset(left, index * 56.dp.toPx() + 24.dp.toPx()),
                    Size(maxOf(1f, x(millis(stage.endTime)) - left), 16.dp.toPx()))
            }
        }
        val y = rows.size * 56.dp.toPx()
        drawText(measurer, timeOnly(session.startTime), Offset(0f, y), style.copy(color = Muted))
        val ending = measurer.measure(timeOnly(session.endTime), style.copy(color = Muted))
        drawText(ending, topLeft = Offset((size.width - ending.size.width).coerceAtLeast(0f), y))
    }
    selected?.let { stage ->
        Caption("${sleepLabels[stage.type]} · ${dateTime(stage.startTime)} ～ ${dateTime(stage.endTime)} · ${durationText((millis(stage.endTime) - millis(stage.startTime)) / MINUTE.toDouble())}")
    } ?: Caption("タイムラインをタップすると段階の詳細を確認できます。")
}
