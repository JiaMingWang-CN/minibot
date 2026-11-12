package app.minibot.mobile

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotifierTest {
    private class Posted(val channel: String, val title: String, val text: String, val publicText: String?, val threadId: String?)

    private class FakePoster : NotificationPoster {
        val posted = mutableListOf<Posted>()
        override fun post(channel: String, key: String, title: String, text: String, publicText: String?, threadId: String?) {
            posted.add(Posted(channel, title, text, publicText, threadId))
        }
    }

    private fun notifier(poster: FakePoster, viewing: String? = null) = Notifier(
        poster = poster,
        text = NotifierText({ "$it 请求批准" }, "打开 minibot 查看", { "$it 已完成" }, "minibot"),
        botName = { if (it == "b1") "小助" else null },
        threadBotId = { "b1" },
        threadTitle = { "整理日报" },
        isViewing = { it == viewing },
    )

    private fun approval(thread: String) = JSONObject(
        """{"type":"approval_request","request":{"id":"a1","botId":"b1","threadId":"$thread","tool":"run_command","summary":"运行 rm -rf build","command":"rm -rf build"}}""",
    )

    private fun turn(thread: String, state: String) = JSONObject("""{"type":"turn","threadId":"$thread","state":"$state"}""")

    @Test
    fun approvalPostsHighPriorityWithPublicVersionWithoutCommand() = runBlocking {
        val poster = FakePoster()
        notifier(poster).onEvent(approval("t1"))
        val n = poster.posted.single()
        assertEquals(CHANNEL_APPROVAL, n.channel)
        assertEquals("小助 请求批准", n.title)
        assertEquals("运行 rm -rf build", n.text)
        assertEquals("打开 minibot 查看", n.publicText)
        assertEquals("t1", n.threadId)
    }

    @Test
    fun noNotificationWhenViewingThatThreadButOtherThreadStillNotifies() = runBlocking {
        val poster = FakePoster()
        val n = notifier(poster, viewing = "t1")
        n.onEvent(approval("t1"))
        assertTrue(poster.posted.isEmpty())
        n.onEvent(approval("t2"))
        assertEquals(1, poster.posted.size)
    }

    @Test
    fun doneOnlyAfterRunningThenIdle() = runBlocking {
        val poster = FakePoster()
        val n = notifier(poster)
        n.onEvent(turn("t1", "idle"))
        assertTrue(poster.posted.isEmpty())
        n.onEvent(turn("t1", "running"))
        n.onEvent(turn("t1", "idle"))
        val done = poster.posted.single()
        assertEquals(CHANNEL_DONE, done.channel)
        assertEquals("小助 已完成", done.title)
        assertEquals("整理日报", done.text)
        assertNull(done.publicText)
        n.onEvent(turn("t1", "idle"))
        assertEquals(1, poster.posted.size)
    }
}
