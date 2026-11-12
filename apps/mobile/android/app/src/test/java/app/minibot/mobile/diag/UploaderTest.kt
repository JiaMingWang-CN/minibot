package app.minibot.mobile.diag

import java.io.File
import java.nio.file.Files
import java.util.zip.GZIPInputStream
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class UploaderTest {
    private lateinit var server: MockWebServer
    private lateinit var dir: File
    private var consent = "unset"
    private var nowValue = 1_000_000L

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        dir = Files.createTempDirectory("minibot-upload").toFile()
        consent = "unset"
        nowValue = 1_000_000L
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun uploader(collectUrl: String? = server.url("/collect").toString().trimEnd('/')): Pair<Uploader, DiagLog> {
        val log = DiagLog(File(dir, "logs"), now = { nowValue })
        val uploader = Uploader(
            queueFile = File(dir, "diag-queue.jsonl"),
            diag = log,
            collectUrl = collectUrl,
            consent = { consent },
            installId = { "install-1" },
            platform = "android",
            appVersion = "0.1.0",
            os = "Android 15",
            now = { nowValue },
            autoStart = false,
        )
        uploader.start()
        return uploader to log
    }

    private fun event(n: Int) = DiagEvent("error", "err.e$n", mapOf("n" to n), nowValue)

    private fun gunzip(bytes: ByteArray): String =
        GZIPInputStream(bytes.inputStream()).use { it.readBytes().toString(Charsets.UTF_8) }

    @Test
    fun unsetDoesNotUpload() = runBlocking {
        val (uploader, _) = uploader()
        repeat(60) { uploader.enqueue(event(it)) }
        nowValue += 10 * 60_000
        uploader.tick()
        assertEquals(0, server.requestCount)
        assertEquals(60, uploader.size())
    }

    @Test
    fun onUploadsOneBatch() = runBlocking {
        val (uploader, _) = uploader()
        consent = "on"
        repeat(60) { uploader.enqueue(event(it)) }
        server.enqueue(MockResponse().setResponseCode(204))
        uploader.tick()
        assertEquals(1, server.requestCount)
        val recorded = server.takeRequest()
        assertEquals("/collect/v1/events", recorded.path)
        val body = JSONObject(gunzip(recorded.body.readByteArray()))
        assertEquals("install-1", body.getString("installId"))
        assertEquals("android", body.getString("platform"))
        assertEquals(60, body.getJSONArray("events").length())
        assertEquals(0, uploader.size())
    }

    @Test
    fun offClearsQueue() {
        val (uploader, _) = uploader()
        consent = "on"
        repeat(10) { uploader.enqueue(event(it)) }
        assertEquals(10, uploader.size())
        consent = "off"
        uploader.setConsent("off")
        assertEquals(0, uploader.size())
        uploader.enqueue(event(11))
        assertEquals(0, uploader.size())
    }

    @Test
    fun feedbackAttachesLogs() = runBlocking {
        val (uploader, log) = uploader()
        log.write(LogLevel.INFO, "app", "first line")
        log.write(LogLevel.INFO, "app", "second line")
        server.enqueue(MockResponse().setResponseCode(204))
        uploader.sendFeedback("有问题", null, true)
        val body = JSONObject(gunzip(server.takeRequest().body.readByteArray()))
        assertEquals("有问题", body.getString("description"))
        val logs = body.getString("logs")
        assertTrue(logs.contains("first line"))
        assertTrue(logs.contains("second line"))
        assertTrue(logs.toByteArray(Charsets.UTF_8).size <= 1 shl 20)
    }

    @Test
    fun feedbackUploadsPreviewedLogs() = runBlocking {
        val (uploader, log) = uploader()
        log.write(LogLevel.INFO, "app", "before preview")
        val preview = uploader.previewLogs()
        log.write(LogLevel.INFO, "app", "after preview")
        server.enqueue(MockResponse().setResponseCode(204))
        uploader.sendFeedback("x", null, true)
        val body = JSONObject(gunzip(server.takeRequest().body.readByteArray()))
        assertEquals(preview, body.getString("logs"))
        assertTrue(!preview.contains("after preview"))
    }

    @Test
    fun feedbackWithoutLogs() = runBlocking {
        val (uploader, _) = uploader()
        server.enqueue(MockResponse().setResponseCode(204))
        uploader.sendFeedback("没日志", "a@b.c", false)
        val body = JSONObject(gunzip(server.takeRequest().body.readByteArray()))
        assertEquals("a@b.c", body.getString("contact"))
        assertTrue(!body.has("logs"))
    }

    @Test
    fun enqueueValidatesFields() {
        val (uploader, _) = uploader()
        consent = "unset"
        uploader.enqueue(DiagEvent("metric", "metric/model.latency", mapOf("model" to "bad\nname", "count" to 3)))
        val line = File(dir, "diag-queue.jsonl").readLines().filter { it.isNotBlank() }.single()
        val data = JSONObject(line).getJSONObject("data")
        assertEquals(3, data.getInt("count"))
        assertTrue(!data.has("model"))
    }

    @Test
    fun queueCappedAt1000() {
        val (uploader, _) = uploader()
        repeat(1005) { uploader.enqueue(event(it)) }
        assertEquals(1000, uploader.size())
        val lines = File(dir, "diag-queue.jsonl").readLines().filter { it.isNotBlank() }
        assertEquals(1000, lines.size)
        assertEquals("err.e5", JSONObject(lines.first()).getString("name"))
        assertEquals("err.e1004", JSONObject(lines.last()).getString("name"))
    }
}
