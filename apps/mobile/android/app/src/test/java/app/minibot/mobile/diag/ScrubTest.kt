package app.minibot.mobile.diag

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScrubTest {
    @Test
    fun redact() {
        assertEquals("[REDACTED]", redactLike("Bearer abcdefghijklmnopqrstuvwxyz0123456789"))
        assertTrue(redactLike("key sk-test-1234567890abcdef").contains("[REDACTED]"))
        assertTrue(redactLike("token abcdefghijklmnopqrstuvwxyz0123456789").contains("[REDACTED]"))
        assertEquals("普通文字 look fine", redactLike("普通文字 look fine"))
    }

    @Test
    fun pathsAndStack() {
        val ctx = ScrubContext("/data/user/0/app.minibot.mobile", "/data/user/0/app.minibot.mobile")
        assertEquals(
            "<app>/files/x",
            scrubPaths("/data/user/0/app.minibot.mobile/files/x", ctx),
        )
        val stack = "java.lang.IllegalStateException: boom\n" +
            "\tat app.minibot.mobile.diag.DiagLog.write(DiagLog.kt:42)\n" +
            "\tat java.lang.Thread.run(Thread.java:1012)"
        val scrubbed = scrubStack(stack, ctx)
        assertTrue(scrubbed.contains("app.minibot.mobile.diag.DiagLog.write(DiagLog.kt:42)"))
        assertTrue(scrubbed.contains("java.lang.Thread.run(Thread.java:1012)"))
        assertFalse(scrubbed.contains("boom"))
    }
}
