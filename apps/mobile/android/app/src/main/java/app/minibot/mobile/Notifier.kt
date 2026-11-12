package app.minibot.mobile

import org.json.JSONObject

/** 通知的发出端；Android 实现见 AndroidPoster，测试里用假的 */
interface NotificationPoster {
    fun post(channel: String, key: String, title: String, text: String, publicText: String?, threadId: String?)
}

/** 通知文案（真实值来自 strings.xml） */
class NotifierText(
    val approvalTitle: (botName: String) -> String,
    val approvalPublic: String,
    val doneTitle: (botName: String) -> String,
    val fallbackBotName: String,
)

const val CHANNEL_CONNECTION = "connection"
const val CHANNEL_APPROVAL = "approval"
const val CHANNEL_DONE = "done"

/**
 * 把内核事件变成通知：审批请求 → 高优先级；一轮对话结束（running → idle）→ 普通通知。
 * 网页可见且正在看这个对话时不发。
 */
class Notifier(
    private val poster: NotificationPoster,
    private val text: NotifierText,
    private val botName: (botId: String) -> String?,
    private val threadBotId: suspend (threadId: String) -> String?,
    private val threadTitle: suspend (threadId: String) -> String?,
    /** 网页可见且当前对话等于 threadId */
    private val isViewing: (threadId: String) -> Boolean,
) {
    private val running = mutableSetOf<String>()

    suspend fun onEvent(event: JSONObject) {
        when (event.optString("type")) {
            "approval_request" -> {
                val request = event.optJSONObject("request") ?: return
                val threadId = request.optString("threadId")
                if (isViewing(threadId)) return
                val bot = botName(request.optString("botId")) ?: text.fallbackBotName
                poster.post(
                    CHANNEL_APPROVAL,
                    "approval:" + request.optString("id"),
                    text.approvalTitle(bot),
                    request.optString("summary"),
                    text.approvalPublic,
                    threadId,
                )
            }
            "turn" -> {
                val threadId = event.optString("threadId")
                if (event.optString("state") == "running") {
                    running.add(threadId)
                    return
                }
                if (!running.remove(threadId)) return
                if (isViewing(threadId)) return
                val bot = threadBotId(threadId)?.let(botName) ?: text.fallbackBotName
                poster.post(CHANNEL_DONE, "done:$threadId", text.doneTitle(bot), threadTitle(threadId) ?: "", null, threadId)
            }
        }
    }
}
