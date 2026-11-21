package healthcheck

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class RepositoryTest {
    private val range = TimeRange("2026-10-01T00:00:00.000Z", "2026-10-03T00:00:00.000Z")
    private val status = PublicStatus("ok", "emulator", lastSuccessAt = range.to)
    private val jsonHeaders = headersOf("Content-Type", "application/json")

    @Test fun sleepFollowsAllPagesAndDeduplicatesBeforePublishing() = runTest {
        var calls = 0
        val client = HttpClient(MockEngine { request ->
            assertEquals(range.from, request.url.parameters["from"])
            assertEquals(range.to, request.url.parameters["to"])
            calls++
            val body = if (calls == 1) {
                assertEquals(null, request.url.parameters["cursor"])
                SleepResponse(listOf(sampleSleep()), "next-page", status, "fetched")
            } else {
                assertEquals("next-page", request.url.parameters["cursor"])
                SleepResponse(listOf(sampleSleep(), sampleSleep("sleep-2")), null, status, "fetched")
            }
            respond(Json.encodeToString(body), headers = jsonHeaders)
        })
        try {
            val response = HttpHealthRepository(client, "https://example.test").sleep(range)
            assertEquals(2, calls)
            assertEquals(listOf("sleep-1", "sleep-2"), response.sessions.map { it.id })
            assertEquals("fetched", response.coverage)
        } finally { client.close() }
    }

    @Test fun failedLaterPageDoesNotReturnPartialSleep() = runTest {
        var calls = 0
        val client = HttpClient(MockEngine {
            if (++calls == 1) respond(Json.encodeToString(SleepResponse(listOf(sampleSleep()), "next", status, "fetched")), headers = jsonHeaders)
            else respond("{}", HttpStatusCode.ServiceUnavailable, jsonHeaders)
        })
        try {
            assertFailsWith<ReadFailure> { HttpHealthRepository(client, "https://example.test").sleep(range) }
            assertEquals(2, calls)
        } finally { client.close() }
    }

    @Test fun repeatedCursorCannotLoopForever() = runTest {
        var calls = 0
        val client = HttpClient(MockEngine {
            calls++
            respond(Json.encodeToString(SleepResponse(listOf(sampleSleep()), "same", status, "fetched")), headers = jsonHeaders)
        })
        try {
            assertTrue(assertFailsWith<ReadFailure> { HttpHealthRepository(client, "https://example.test").sleep(range) }.message!!.contains("全ページ"))
            assertEquals(2, calls)
        } finally { client.close() }
    }

    @Test fun cancellationIsNotReportedAsAReadError() = runTest {
        val client = HttpClient(MockEngine { throw CancellationException("period changed") })
        try {
            assertFailsWith<CancellationException> { HttpHealthRepository(client, "https://example.test").heart(range, "auto") }
        } finally { client.close() }
    }

    @Test fun jsonContractKeepsZeroAndNullAndIgnoresNewFields() = runTest {
        val client = HttpClient(MockEngine { request ->
            assertEquals("steps", request.url.parameters["metric"])
            assertEquals("auto", request.url.parameters["resolution"])
            respond("""{"from":"${range.from}","to":"${range.to}","metric":"steps","resolution":"1h","futureField":true,
                "points":[{"from":"${range.from}","to":"${range.to}","total":0,"availableMinutes":1,"totalMinutes":2,"omittedMinutes":0,"missingMinutes":1}],
                "summary":{"total":0,"availableMinutes":1,"totalMinutes":2,"omittedMinutes":0,"missingMinutes":1,"days":[{"date":"2026-10-01","total":null,"availableMinutes":0,"totalMinutes":1,"partialDay":true}]},
                "status":{"state":"ok","environment":"emulator"},"coverage":"partial"}""", headers = jsonHeaders)
        })
        try {
            val result = HttpHealthRepository(client, "https://example.test").activity(range, "steps")
            assertEquals(0.0, result.summary.total)
            assertEquals(null, result.summary.days.single().total)
            assertEquals("partial", result.coverage)
        } finally { client.close() }
    }
}
