package healthcheck

import kotlinx.serialization.Serializable

@Serializable
data class TimeRange(val from: String, val to: String)

@Serializable
data class SyncError(val code: String, val at: String)

@Serializable
data class PublicStatus(
    val state: String,
    val environment: String,
    val lastSuccessAt: String? = null,
    val lastAttemptAt: String? = null,
    val dataThrough: String? = null,
    val error: SyncError? = null,
)

@Serializable
data class HeartValue(val avg: Double, val min: Double, val max: Double)

@Serializable
data class LatestHeart(val time: String, val avg: Double)

@Serializable
data class HeartBucket(
    val time: String,
    val to: String,
    val value: HeartValue?,
    val availableMinutes: Int,
    val totalMinutes: Int,
)

@Serializable
data class HeartSummary(
    val avg: Double?,
    val min: Double?,
    val max: Double?,
    val availableMinutes: Int,
    val totalMinutes: Int,
    val latest: LatestHeart?,
)

@Serializable
data class HeartResponse(
    val from: String,
    val to: String,
    val resolution: String,
    val points: List<HeartBucket>,
    val summary: HeartSummary,
    val status: PublicStatus,
)

@Serializable
data class SleepStage(val startTime: String, val endTime: String, val type: String)

@Serializable
data class SleepSession(
    val id: String,
    val startTime: String,
    val endTime: String,
    val wakeDate: String,
    val type: String,
    val nap: Boolean?,
    val stages: List<SleepStage>,
    val durationMinutes: Double,
    val asleepMinutes: Double?,
    val stageMinutes: Map<String, Double>,
)

@Serializable
data class SleepResponse(
    val sessions: List<SleepSession>,
    val nextCursor: String?,
    val status: PublicStatus,
    val coverage: String,
)

@Serializable
data class ActivityBucket(
    val from: String,
    val to: String,
    val total: Double?,
    val availableMinutes: Int,
    val omittedMinutes: Int,
    val missingMinutes: Int,
    val totalMinutes: Int,
)

@Serializable
data class ActivityDay(
    val date: String,
    val total: Double?,
    val availableMinutes: Int,
    val totalMinutes: Int,
    val partialDay: Boolean,
)

@Serializable
data class ActivitySummary(
    val total: Double?,
    val availableMinutes: Int,
    val omittedMinutes: Int,
    val missingMinutes: Int,
    val totalMinutes: Int,
    val days: List<ActivityDay>,
)

@Serializable
data class ActivityResponse(
    val from: String,
    val to: String,
    val metric: String,
    val resolution: String,
    val points: List<ActivityBucket>,
    val summary: ActivitySummary,
    val status: PublicStatus,
    val coverage: String,
)

data class ActivitySpec(val label: String, val unit: String)

val activitySpecs = linkedMapOf(
    "steps" to ActivitySpec("歩数", "歩"),
    "distance" to ActivitySpec("距離", "m"),
    "total-calories" to ActivitySpec("総消費カロリー", "kcal"),
    "active-zone-minutes" to ActivitySpec("アクティブゾーン時間", "ポイント"),
)

val heartResolutionLabels = linkedMapOf("auto" to "自動", "1m" to "1分", "5m" to "5分", "1h" to "1時間", "1d" to "1日（JST）")
val sleepLabels = linkedMapOf(
    "awake" to "覚醒・離床", "restless" to "落ち着かない", "rem" to "レム睡眠",
    "light" to "浅い睡眠", "deep" to "深い睡眠", "asleep" to "睡眠（段階なし）", "unknown" to "段階未提供",
)

fun syncErrorMessage(code: String): String = when (code) {
    "reauth-required" -> "本人のGoogle連携を更新する必要があります。"
    "access-denied" -> "Google Health APIの利用権限を確認する必要があります。"
    "upstream-unavailable" -> "Google Health APIとの通信に失敗しました。"
    "invalid-upstream-data" -> "取得データの整合性を確認できませんでした。"
    "storage-error" -> "データの保存に失敗しました。"
    else -> "同期に失敗しました。"
}
