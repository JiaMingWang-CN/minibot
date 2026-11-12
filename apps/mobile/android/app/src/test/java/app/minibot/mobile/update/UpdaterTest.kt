package app.minibot.mobile.update

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test

class UpdaterTest {
    private lateinit var server: MockWebServer
    private lateinit var dir: File

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        dir = Files.createTempDirectory("minibot-update").toFile()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun releaseJson(tag: String, apkSize: Long = 1000): String {
        val json = JSONObject()
            .put("tag_name", tag)
            .put("body", "修复了一些问题")
            .put("assets", JSONArray())
        val assets = json.getJSONArray("assets")
        val version = tag.removePrefix("v")
        assets.put(
            JSONObject()
                .put("name", "minibot-$version.apk")
                .put("size", apkSize)
                .put("browser_download_url", server.url("/minibot-$version.apk").toString()),
        )
        assets.put(
            JSONObject()
                .put("name", "minibot-$version.apk.sha256")
                .put("size", 65)
                .put("browser_download_url", server.url("/minibot-$version.apk.sha256").toString()),
        )
        return json.toString()
    }

    private fun updater(currentVersionCode: Int = 100, lastCheckAt: () -> Long = { 0L }, saveLastCheckAt: (Long) -> Unit = {}): Updater =
        Updater(
            updateDir = File(dir, "update"),
            currentVersionCode = currentVersionCode,
            releaseUrl = server.url("/releases/latest").toString(),
            now = { 10_000_000L },
            lastCheckAt = lastCheckAt,
            saveLastCheckAt = saveLastCheckAt,
        )

    @Test
    fun newer() = runBlocking {
        server.enqueue(MockResponse().setBody(releaseJson("v0.2.0")))
        val update = updater().check(true)
        assertNotNull(update)
        assertEquals("0.2.0", update!!.version)
        assertEquals("修复了一些问题", update.notes)
        assertEquals(1000L, update.size)
    }

    @Test
    fun sameOrOlder() = runBlocking {
        server.enqueue(MockResponse().setBody(releaseJson("v0.1.0")))
        assertNull(updater().check(true))
        server.enqueue(MockResponse().setBody(releaseJson("nightly")))
        assertNull(updater().check(true))
    }

    @Test
    fun versionCode() {
        assertEquals(10203, versionCodeOf("v1.2.3"))
        assertEquals(100, versionCodeOf("0.1.0"))
        assertNull(versionCodeOf("nightly"))
        assertNull(versionCodeOf("v1.2"))
    }

    @Test
    fun hashMismatchRemovesApk() {
        val apk = "not a real apk".toByteArray()
        server.enqueue(MockResponse().setBody(releaseJson("v0.2.0", apk.size.toLong())))
        server.enqueue(MockResponse().setBody(Buffer().write(apk)))
        server.enqueue(MockResponse().setBody("deadbeef\n"))
        val updater = updater()
        runBlocking {
            updater.check(true)
            val error = assertThrows(UpdateException::class.java) { runBlocking { updater.downloadAndInstall() } }
            assertEquals("hash", error.kind)
        }
        val leftovers = File(dir, "update").listFiles()?.filter { it.name.endsWith(".apk") } ?: emptyList()
        assertEquals(0, leftovers.size)
    }

    @Test
    fun dailyLimit() = runBlocking {
        var saved = 0L
        val updater = updater(lastCheckAt = { saved }, saveLastCheckAt = { saved = it })
        server.enqueue(MockResponse().setBody(releaseJson("v0.2.0")))
        updater.check(false)
        assertEquals(1, server.requestCount)
        // 当天第二次自动检查：不发请求
        updater.check(false)
        assertEquals(1, server.requestCount)
        // 手动检查不受限
        server.enqueue(MockResponse().setBody(releaseJson("v0.2.0")))
        updater.check(true)
        assertEquals(2, server.requestCount)
    }
}
