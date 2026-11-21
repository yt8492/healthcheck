package healthcheck

import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.FixedOffsetTimeZone
import kotlinx.datetime.TimeZone
import kotlinx.datetime.UtcOffset
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime
import kotlin.math.round
import kotlin.time.Clock
import kotlin.time.Instant

const val MINUTE = 60_000L
const val HOUR = 60 * MINUTE
const val DAY = 24 * HOUR
// The retained data uses JST (UTC+09:00); a fixed offset avoids a separate Wasm timezone database.
val jst: TimeZone = FixedOffsetTimeZone(UtcOffset(hours = 9))

fun nowMillis() = Clock.System.now().toEpochMilliseconds()
fun millis(time: String) = Instant.parse(time).toEpochMilliseconds()
fun iso(ms: Long): String = Instant.fromEpochMilliseconds(ms).toString().let {
    if ('.' !in it) it.removeSuffix("Z") + ".000Z" else it
}
fun floorMinute(now: Long) = now / MINUTE * MINUTE
fun retentionStart(now: Long) = (now - 90 * DAY + MINUTE - 1) / MINUTE * MINUTE

fun validateRange(from: String?, to: String?, now: Long = nowMillis()): TimeRange {
    val start = runCatching { millis(requireNotNull(from)) }.getOrNull()
    val end = runCatching { millis(requireNotNull(to)) }.getOrNull()
    require(start != null && end != null) { "日時はタイムゾーン付きRFC 3339形式で指定してください。" }
    require(start % MINUTE == 0L && end % MINUTE == 0L) { "日時は1分の境界で指定してください。" }
    require(start < end) { "開始日時は終了日時より前に指定してください。" }
    require(start >= retentionStart(now)) { "保存対象は測定時刻から直近90日です。" }
    require(end <= floorMinute(now)) { "終了日時は現在の完了した分までを指定してください。" }
    return TimeRange(iso(start), iso(end))
}

fun presetRange(days: Int, now: Long = nowMillis()): TimeRange {
    val to = floorMinute(now)
    return TimeRange(iso(maxOf(retentionStart(now), to - days * DAY)), iso(to))
}

fun moveRange(range: TimeRange, direction: Int, now: Long = nowMillis()): TimeRange {
    val duration = millis(range.to) - millis(range.from)
    val start = maxOf(retentionStart(now), minOf(floorMinute(now) - duration, millis(range.from) + duration * direction))
    return TimeRange(iso(start), iso(minOf(start + duration, floorMinute(now))))
}

fun resolvedHeartResolution(selected: String, range: TimeRange): String {
    val start = millis(range.from)
    val end = millis(range.to)
    val resolution = if (selected == "auto") when {
        end - start <= DAY -> "1m"
        end - start <= 7 * DAY -> "5m"
        end - start <= 30 * DAY -> "1h"
        else -> "1d"
    } else selected
    val duration = when (resolution) {
        "1m" -> MINUTE
        "5m" -> 5 * MINUTE
        "1h" -> HOUR
        "1d" -> DAY
        else -> throw IllegalArgumentException("心拍の表示粒度が不正です。")
    }
    val offset = if (resolution == "1d") 9 * HOUR else 0L
    val count = (end - 1 + offset) / duration - (start + offset) / duration + 1
    require(count <= 4096) { "返却区間は最大4096件です。期間を短くするか、粗い粒度を指定してください。" }
    return resolution
}

data class Selection(
    val range: TimeRange,
    val resolution: String = "auto",
    val metric: String = "steps",
    val error: String? = null,
) {
    val activityMetric: String get() = metric.takeIf { it in activitySpecs } ?: "steps"
}

fun selectionFromQuery(params: Map<String, String>, now: Long = nowMillis()): Selection {
    val metric = params["activityMetric"] ?: "steps"
    return try {
        val keys = listOf("from" to "to", "sleepFrom" to "sleepTo", "activityFrom" to "activityTo")
            .firstOrNull { (from, to) -> from in params || to in params }
        val range = if (keys == null) presetRange(1, now) else validateRange(params[keys.first], params[keys.second], now)
        val resolution = params["resolution"] ?: "auto"
        resolvedHeartResolution(resolution, range)
        Selection(range, resolution, metric)
    } catch (error: IllegalArgumentException) {
        Selection(presetRange(1, now), metric = metric, error = error.message ?: "URLの日時が不正です。")
    }
}

fun toInput(time: String): String = Instant.parse(time).toLocalDateTime(jst).toString().take(16)
fun inputRange(from: String, to: String, now: Long = nowMillis()): TimeRange {
    fun parse(value: String): String = try {
        val local = LocalDateTime.parse(value.trim().replace(' ', 'T'))
        local.toInstant(jst).toString()
    } catch (_: IllegalArgumentException) {
        throw IllegalArgumentException("日時は YYYY-MM-DD HH:mm の形式で入力してください。")
    }
    return validateRange(parse(from), parse(to), now)
}

fun dateTime(time: String): String = toInput(time).replace('T', ' ')
fun shortDate(time: String): String = toInput(time).substring(5, 10).replace('-', '/')
fun timeOnly(time: String): String = toInput(time).substring(11, 16)

fun number(value: Double?, decimals: Int = 1, trimZeros: Boolean = false): String {
    if (value == null || !value.isFinite()) return "—"
    val scale = when (decimals) { 0 -> 1L; 1 -> 10L; 2 -> 100L; else -> 1000L }
    val rounded = round(value * scale).toLong()
    val integer = rounded / scale
    if (decimals == 0) return integer.toString()
    val fraction = (kotlin.math.abs(rounded) % scale).toString().padStart(decimals, '0')
    return "$integer.$fraction".let { if (trimZeros) it.trimEnd('0').trimEnd('.') else it }
}

fun durationText(minutes: Double?): String {
    if (minutes == null) return "不明"
    val tenths = round(minutes * 10).toLong()
    val hours = tenths / 600
    val remainder = (tenths % 600) / 10.0
    return (if (hours > 0) "${hours}時間" else "") + "${number(remainder, trimZeros = true)}分"
}

fun sleepContext(session: SleepSession, now: Long = nowMillis()): TimeRange {
    val to = minOf(floorMinute(now), floorMinute(millis(session.endTime)) + HOUR)
    val from = maxOf(retentionStart(now), maxOf(to - DAY, floorMinute(millis(session.startTime)) - HOUR))
    return TimeRange(iso(from), iso(to))
}
