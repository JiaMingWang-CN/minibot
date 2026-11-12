package app.minibot.mobile.diag

import java.io.File
import java.nio.file.Files
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DiagLogTest {
    private fun tmpDir(): File = Files.createTempDirectory("minibot-diag").toFile()

    private fun dayFile(dir: File, day: LocalDate): File = File(dir, "minibot-$day.log")

    @Test
    fun retention() {
        val dir = tmpDir()
        val today = LocalDate.now()
        for (i in 0 until 9) {
            dayFile(dir, today.minusDays(i.toLong())).writeText(
                """{"ts":1,"level":"info","area":"app","msg":"x"}""" + "\n",
            )
        }
        DiagLog(dir, now = { System.currentTimeMillis() })
        val names = dir.listFiles()!!.map { it.name }.sorted()
        assertEquals(7, names.size)
        assertFalse(names.contains("minibot-${today.minusDays(8)}.log"))
        assertTrue(names.contains("minibot-$today.log"))
    }

    @Test
    fun maxBytesDeletesOldest() {
        val dir = tmpDir()
        val today = LocalDate.now()
        for (i in 0 until 3) {
            dayFile(dir, today.minusDays(2L - i)).writeText("x".repeat(1000))
        }
        DiagLog(dir, maxBytes = 1500)
        val total = dir.listFiles()!!.sumOf { it.length() }
        assertTrue(total <= 1500)
        assertTrue(dir.listFiles()!!.any { it.name == "minibot-$today.log" })
    }

    @Test
    fun secretAndShapeRedaction() {
        val dir = tmpDir()
        val log = DiagLog(dir)
        log.registerSecret("sk-test-1234567890abcdef")
        log.write(
            LogLevel.INFO,
            "app",
            "key sk-test-1234567890abcdef and Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        )
        val text = dir.listFiles()!!.single().readText()
        assertFalse(text.contains("sk-test-1234567890abcdef"))
        assertFalse(text.contains("abcdefghijklmnopqrstuvwxyz0123456789"))
        assertTrue(text.contains("[REDACTED]"))
    }

    @Test
    fun eventWhitelistDropsBadFields() {
        val dir = tmpDir()
        val log = DiagLog(dir)
        val events = mutableListOf<DiagEvent>()
        log.addListener { events.add(it) }
        log.write(
            LogLevel.ERROR,
            "app",
            "x",
            event = DiagEvent(
                "crash",
                "crash/app",
                mapOf(
                    "stack" to "at a (x.kt:1)",
                    "source" to "android",
                    "object" to mapOf("a" to 1),
                    "long" to "y".repeat(200),
                ),
            ),
        )
        assertEquals(1, events.size)
        val data = events[0].data
        assertEquals("at a (x.kt:1)", data["stack"])
        assertEquals("android", data["source"])
        assertFalse(data.containsKey("object"))
        assertFalse(data.containsKey("long"))
    }

    @Test
    fun recentKeepsNewestLines() {
        val dir = tmpDir()
        val now = System.currentTimeMillis()
        val log = DiagLog(dir, now = { now })
        log.write(LogLevel.INFO, "app", "first")
        log.write(LogLevel.INFO, "app", "second")
        val text = log.recent(now - 60_000, 1024 * 1024)
        assertTrue(text.contains("first"))
        assertTrue(text.contains("second"))
        val tiny = log.recent(now - 60_000, 20)
        assertTrue(tiny.length <= 21)
        assertFalse(tiny.contains("first"))
    }
}
