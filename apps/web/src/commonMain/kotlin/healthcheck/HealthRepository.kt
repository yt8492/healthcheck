package healthcheck

import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.statement.bodyAsText
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

interface HealthRepository {
    suspend fun heart(range: TimeRange, resolution: String): HeartResponse
    suspend fun sleep(range: TimeRange): SleepResponse
    suspend fun activity(range: TimeRange, metric: String): ActivityResponse
}

class ReadFailure(message: String) : Exception(message)

class HttpHealthRepository(private val client: HttpClient, private val origin: String) : HealthRepository {
    private val json = Json { ignoreUnknownKeys = true }

    private suspend inline fun <reified T> read(
        path: String,
        range: TimeRange,
        label: String,
        params: Map<String, String> = emptyMap(),
    ): T {
        try {
            val response = client.get("$origin/api/v1/$path") {
                parameter("from", range.from)
                parameter("to", range.to)
                params.forEach { (key, value) -> parameter(key, value) }
                header("Cache-Control", "no-cache")
            }
            if (response.status.value == 400) throw ReadFailure("${label}の表示期間を確認してください。保存対象は直近90日です。")
            if (response.status.value !in 200..299) throw ReadFailure("${label}の記録を読み取れません。再試行してください。")
            return json.decodeFromString<T>(response.bodyAsText())
        } catch (error: CancellationException) {
            throw error
        } catch (error: ReadFailure) {
            throw error
        } catch (_: SerializationException) {
            throw ReadFailure("${label}のデータ形式を確認できません。再試行してください。")
        } catch (_: Exception) {
            throw ReadFailure("${label}の記録を読み取れません。再試行してください。")
        }
    }

    override suspend fun heart(range: TimeRange, resolution: String): HeartResponse =
        read("timeseries", range, "心拍", mapOf("metric" to "heart-rate", "resolution" to resolution))

    override suspend fun activity(range: TimeRange, metric: String): ActivityResponse =
        read("timeseries", range, "活動", mapOf("metric" to metric, "resolution" to "auto"))

    override suspend fun sleep(range: TimeRange): SleepResponse {
        val sessions = linkedMapOf<String, SleepSession>()
        val seen = mutableSetOf<String>()
        var cursor: String? = null
        var page: SleepResponse
        do {
            page = read("sleep", range, "睡眠", cursor?.let { mapOf("cursor" to it) } ?: emptyMap())
            page.sessions.forEach { sessions[it.id] = it }
            cursor = page.nextCursor
            if (cursor != null && (!seen.add(cursor) || seen.size > 1000)) {
                throw ReadFailure("睡眠の全ページを取得できませんでした。再試行してください。")
            }
        } while (cursor != null)
        // Publish only after every page succeeds; never present a partial list as a complete total.
        return page.copy(sessions = sessions.values.sortedBy { it.startTime })
    }
}

interface BrowserNavigation {
    fun readQuery(): Map<String, String>
    fun writeSelection(selection: Selection, replace: Boolean = false)
    fun observeHistory(onChange: () -> Unit): () -> Unit
    fun navigate(path: String)
}
