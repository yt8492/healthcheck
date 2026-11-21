package healthcheck

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DomainTest {
    private val now = millis("2026-10-18T06:02:30Z")

    @Test fun retentionAndPeriodMovement() {
        val all = presetRange(90, now)
        assertEquals(retentionStart(now), millis(all.from))
        assertEquals(floorMinute(now), millis(all.to))
        assertEquals(all, moveRange(all, -1, now))
        assertEquals(all, moveRange(all, 1, now))
        val week = presetRange(7, now)
        val previous = moveRange(week, -1, now)
        assertEquals(millis(week.from) - 7 * DAY, millis(previous.from))
        assertEquals(week, moveRange(previous, 1, now))
    }

    @Test fun jstInputDoesNotDependOnBrowserTimezone() {
        val range = inputRange("2026-10-01 09:03", "2026-10-15T09:07", now)
        assertEquals(TimeRange("2026-10-01T00:03:00.000Z", "2026-10-15T00:07:00.000Z"), range)
        assertEquals("2026-10-01T09:03", toInput(range.from))
        assertFailsWith<IllegalArgumentException> { inputRange("2026-10-01 09:03", "2026-10-19 09:07", now) }
        assertFailsWith<IllegalArgumentException> { inputRange("2026-10-32 09:03", "2026-10-15 09:07", now) }
        assertFailsWith<IllegalArgumentException> { validateRange(iso(retentionStart(now) - MINUTE), iso(floorMinute(now)), now) }
        assertFailsWith<IllegalArgumentException> { validateRange("2026-10-01T00:03:01Z", "2026-10-15T00:07:00Z", now) }
    }

    @Test fun urlsRestoreResolutionMetricAndLegacyRanges() {
        val month = presetRange(30, now)
        val params = mapOf("from" to month.from, "to" to month.to, "resolution" to "1h", "activityMetric" to "distance")
        assertEquals(Selection(month, "1h", "distance"), selectionFromQuery(params, now))
        val invalid = selectionFromQuery(params + ("resolution" to "1m"), now)
        assertEquals("auto", invalid.resolution)
        assertTrue(invalid.error!!.contains("4096"))
        for (prefix in listOf("sleep", "activity")) {
            val old = mapOf("${prefix}From" to month.from, "${prefix}To" to month.to)
            assertEquals(month, selectionFromQuery(old, now).range)
            val day = presetRange(1, now)
            assertEquals(day, selectionFromQuery(old + mapOf("from" to day.from, "to" to day.to), now).range)
        }
        val invalidMetric = selectionFromQuery(mapOf("activityMetric" to "unknown"), now)
        assertEquals("unknown", invalidMetric.metric)
        assertEquals("steps", invalidMetric.activityMetric)
    }

    @Test fun resolutionCountsPartialBuckets() {
        for ((days, expected) in listOf(1 to "1m", 7 to "5m", 30 to "1h", 90 to "1d")) {
            assertEquals(expected, resolvedHeartResolution("auto", presetRange(days, now)))
        }
        val start = millis("2026-10-01T00:01:00Z")
        val partial = TimeRange(iso(start), iso(start + 4096 * 5 * MINUTE))
        assertFailsWith<IllegalArgumentException> { resolvedHeartResolution("5m", partial) }
        assertEquals("5m", resolvedHeartResolution("5m", partial.copy(to = iso(start + 4095 * 5 * MINUTE))))
    }

    @Test fun sleepClipsTotalsButKeepsFullSessionDetailsAndWakeDate() {
        val session = sampleSleep()
        val range = TimeRange("2026-10-01T15:30:00Z", "2026-10-01T16:30:00Z")
        val summary = summarizeSleep(listOf(session), range)
        assertEquals(60.0, summary.totals.durationMinutes)
        assertEquals(30.0, summary.totals.asleepMinutes)
        assertEquals(30.0, summary.totals.stageMinutes["unknown"])
        assertEquals("2026-10-02", summary.days.single().date)
        assertEquals(session, summary.days.single().sessions.single())
        assertEquals("2026-10-01T15:00:00Z", summary.days.single().sessions.single().startTime)
    }

    @Test fun unknownSleepIsNotZeroAndAwakeIsKnownZero() {
        val unknown = SleepStage("2026-10-01T15:00:00Z", "2026-10-01T16:00:00Z", "unknown")
        val range = TimeRange(unknown.startTime, unknown.endTime)
        assertNull(sleepTotals(listOf(unknown), range).asleepMinutes)
        assertEquals(0.0, sleepTotals(listOf(unknown.copy(type = "awake")), range).asleepMinutes)
        assertNull(summarizeSleep(emptyList(), range).totals.asleepMinutes)
    }

    @Test fun graphDoesNotConnectAcrossMissingBuckets() {
        fun point(minute: Int, value: HeartValue?) = HeartBucket(iso(minute * MINUTE), iso((minute + 1) * MINUTE), value, if (value == null) 0 else 1, 1)
        val value = HeartValue(70.0, 65.0, 80.0)
        val points = listOf(point(0, value), point(1, value), point(2, null), point(3, value), point(4, null))
        assertEquals(listOf(points.take(2), listOf(points[3])), heartSegments(points))
        assertTrue(heartSegments(listOf(point(0, null))).isEmpty())
    }

    @Test fun valuesPreserveZeroUnknownAndDurationRounding() {
        assertEquals("0", number(0.0, 3, true))
        assertEquals("—", number(null, 3, true))
        assertEquals("不明", durationText(null))
        assertEquals("1時間0分", durationText(59.99))
        assertEquals("1時間0.1分", durationText(60.1))
        assertEquals("1234.567", number(1234.567, 3, true))
    }
}

fun sampleSleep(id: String = "sleep-1") = SleepSession(
    id, "2026-10-01T15:00:00Z", "2026-10-01T17:00:00Z", "2026-10-02", "stages", false,
    listOf(SleepStage("2026-10-01T15:00:00Z", "2026-10-01T16:00:00Z", "light"),
        SleepStage("2026-10-01T16:00:00Z", "2026-10-01T17:00:00Z", "unknown")),
    120.0, 60.0, mapOf("light" to 60.0, "unknown" to 60.0),
)
