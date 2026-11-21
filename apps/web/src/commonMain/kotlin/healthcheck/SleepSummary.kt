package healthcheck

data class SleepTotals(
    val durationMinutes: Double,
    val asleepMinutes: Double?,
    val stageMinutes: Map<String, Double>,
)
data class SleepDay(val date: String, val sessions: List<SleepSession>, val totals: SleepTotals)
data class SleepSummary(val totals: SleepTotals, val days: List<SleepDay>) {
    val sessionCount: Int get() = days.sumOf { it.sessions.size }
}

fun sleepTotals(stages: List<SleepStage>, range: TimeRange): SleepTotals {
    val minutes = sleepLabels.keys.associateWith { 0.0 }.toMutableMap()
    var known = false
    val start = millis(range.from)
    val end = millis(range.to)
    for (stage in stages) {
        val overlap = maxOf(0L, minOf(end, millis(stage.endTime)) - maxOf(start, millis(stage.startTime))) / MINUTE.toDouble()
        minutes[stage.type] = minutes.getOrElse(stage.type) { 0.0 } + overlap
        if (overlap > 0 && stage.type != "unknown") known = true
    }
    val asleep = if (known) listOf("light", "deep", "rem", "asleep").sumOf { minutes.getValue(it) } else null
    return SleepTotals(minutes.values.sum(), asleep, minutes)
}

private fun mergeSleepTotals(totals: List<SleepTotals>): SleepTotals = SleepTotals(
    durationMinutes = totals.sumOf { it.durationMinutes },
    asleepMinutes = totals.mapNotNull { it.asleepMinutes }.takeIf { it.isNotEmpty() }?.sum(),
    stageMinutes = sleepLabels.keys.associateWith { type -> totals.sumOf { it.stageMinutes.getOrElse(type) { 0.0 } } },
)

fun summarizeSleep(sessions: List<SleepSession>, range: TimeRange): SleepSummary {
    val included = sessions.map { it to sleepTotals(it.stages, range) }.filter { it.second.durationMinutes > 0 }
    val days = included.groupBy { it.first.wakeDate }.entries.sortedBy { it.key }.map { (date, values) ->
        SleepDay(date, values.map { it.first }, mergeSleepTotals(values.map { it.second }))
    }
    return SleepSummary(mergeSleepTotals(days.map { it.totals }), days)
}

/** Split at missing buckets so the line and the min/max band never bridge a gap. */
fun heartSegments(points: List<HeartBucket>): List<List<HeartBucket>> {
    val result = mutableListOf<List<HeartBucket>>()
    var current = mutableListOf<HeartBucket>()
    for (point in points) {
        if (point.value == null) {
            if (current.isNotEmpty()) result.add(current)
            current = mutableListOf()
        } else current.add(point)
    }
    if (current.isNotEmpty()) result.add(current)
    return result
}
