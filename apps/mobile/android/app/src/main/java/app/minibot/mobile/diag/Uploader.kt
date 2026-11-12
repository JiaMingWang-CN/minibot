package app.minibot.mobile.diag

import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.GZIPOutputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/** 反馈发送失败的原因；插件据此给出中文提示 */
class FeedbackException(val kind: String, message: String) : Exception(message)

/**
 * 诊断事件队列与上传。规则与电脑端 packages/core/src/diag/uploader.ts 一致：
 * 队列上限 1000（丢最旧）、批量 ≤ 200、积满 50 条或距上次上传 5 分钟触发、
 * 失败指数退避 1 分钟 → 1 小时；400/413 视为毒丸，删除该批。
 */
class Uploader(
    private val queueFile: File,
    private val diag: DiagLog,
    collectUrl: String?,
    private val consent: () -> String,
    private val installId: () -> String,
    private val platform: String,
    private val appVersion: String,
    private val os: String,
    private val client: OkHttpClient = OkHttpClient(),
    private val now: () -> Long = System::currentTimeMillis,
    private val scope: CoroutineScope? = null,
    private val autoStart: Boolean = true,
    private val queueMax: Int = 1000,
    private val batchMax: Int = 200,
    private val threshold: Int = 50,
    private val uploadIntervalMs: Long = 5 * 60_000L,
    private val retryBaseMs: Long = 60_000L,
    private val retryMaxMs: Long = 3_600_000L,
    private val tickMs: Long = 30_000L,
    private val logsWindowMs: Long = 24 * 3_600_000L,
    private val logsMaxBytes: Int = 1 shl 20,
) {
    private val endpoint: String? = collectUrl?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
    val available: Boolean get() = endpoint != null

    private val mutex = Mutex()
    private val lock = Any()
    private val items = mutableListOf<JSONObject>()
    private var loaded = false
    private var lastUploadAt: Long? = null
    private var nextAttemptAt = 0L
    private var failures = 0
    private var started = false
    private var unsubscribe: (() -> Unit)? = null
    private var job: Job? = null

    fun start() {
        if (started) return
        started = true
        unsubscribe = diag.addListener { enqueue(it) }
        if (autoStart && scope != null) {
            job = scope.launch {
                while (isActive) {
                    delay(tickMs)
                    runCatching { tick() }
                }
            }
        }
    }

    fun stop() {
        unsubscribe?.invoke()
        unsubscribe = null
        job?.cancel()
        job = null
        started = false
    }

    /** 入队一条事件；off 状态直接丢弃。同步写队列文件（崩溃处理器依赖这一点） */
    fun enqueue(event: DiagEvent) {
        if (consent() == "off") return
        try {
            val data = JSONObject()
            for ((key, value) in event.data) data.put(key, value ?: JSONObject.NULL)
            val row = JSONObject()
                .put("ts", event.ts)
                .put("kind", event.kind)
                .put("name", event.name)
                .put("data", data)
            synchronized(lock) {
                load()
                items.add(row)
                while (items.size > queueMax) items.removeAt(0)
                persist()
            }
        } catch (e: Throwable) {
            // 队列写不进去也不影响应用
        }
    }

    fun size(): Int = synchronized(lock) {
        load()
        items.size
    }

    fun clear() {
        synchronized(lock) {
            load()
            items.clear()
            persist()
        }
    }

    fun setConsent(value: String) {
        if (value == "off") clear()
        else if (value == "on" && scope != null) scope.launch { runCatching { tick() } }
    }

    /** 定时器与测试共用的驱动：满足条件时上传一批 */
    suspend fun tick() {
        mutex.withLock {
            val endpoint = endpoint ?: return
            if (consent() != "on") return
            val currentNow = now()
            if (currentNow < nextAttemptAt) return
            val pending = synchronized(lock) {
                load()
                items.size
            }
            if (pending == 0) return
            val last = lastUploadAt
            if (pending < threshold && last != null && currentNow - last < uploadIntervalMs) return

            val batch = synchronized(lock) {
                load()
                items.take(batchMax).toList()
            }
            if (batch.isEmpty()) return
            lastUploadAt = currentNow
            val payload = JSONObject()
                .put("installId", installId())
                .put("platform", platform)
                .put("appVersion", appVersion)
                .put("os", os)
                .put("events", JSONArray(batch))
            val status = runCatching { post("$endpoint/v1/events", payload) }.getOrNull()
            when {
                status == null -> {
                    registerFailure(currentNow)
                    diag.write(LogLevel.WARN, "diag", "upload.failed", mapOf("reason" to "network", "count" to batch.size))
                }
                status in 200..299 -> succeed(batch)
                status == 400 || status == 413 -> {
                    // 毒丸批次：删掉避免永远卡住队列
                    succeed(batch)
                    diag.write(LogLevel.WARN, "diag", "upload.rejected", mapOf("status" to status, "count" to batch.size))
                }
                else -> {
                    registerFailure(currentNow)
                    diag.write(LogLevel.WARN, "diag", "upload.failed", mapOf("status" to status, "count" to batch.size))
                }
            }
        }
    }

    /** 最近日志（已脱敏），供反馈附件与预览使用 */
    fun recentLogs(): String = diag.recent(now() - logsWindowMs, logsMaxBytes)

    suspend fun sendFeedback(description: String, contact: String?, attachLogs: Boolean) {
        val endpoint = endpoint ?: throw FeedbackException("unavailable", "未配置收集点")
        require(description.isNotBlank()) { "问题描述不能为空" }
        require(description.length <= 5000) { "问题描述不能超过 5000 字" }
        require(contact == null || contact.length <= 200) { "联系方式不能超过 200 字" }
        val payload = JSONObject()
            .put("installId", installId())
            .put("platform", platform)
            .put("appVersion", appVersion)
            .put("os", os)
            .put("description", description)
        if (!contact.isNullOrBlank()) payload.put("contact", contact)
        if (attachLogs) payload.put("logs", recentLogs())
        val status = runCatching { post("$endpoint/v1/feedback", payload) }.getOrNull()
            ?: throw FeedbackException("network", "网络连接失败")
        when (status) {
            in 200..299 -> Unit
            429 -> throw FeedbackException("rate_limited", "提交太频繁")
            400, 413 -> throw FeedbackException("rejected", "反馈内容被拒绝")
            else -> throw FeedbackException("unavailable", "反馈服务暂不可用")
        }
    }

    // —— 内部 ——

    private fun succeed(batch: List<JSONObject>) {
        synchronized(lock) {
            load()
            // 批取自队列头部；其间新增的项在尾部，删前 N 个即可
            repeat(batch.size) { if (items.isNotEmpty()) items.removeAt(0) }
            persist()
        }
        failures = 0
        nextAttemptAt = 0
    }

    private fun registerFailure(at: Long) {
        failures += 1
        val shift = minOf(failures - 1, 20)
        nextAttemptAt = at + minOf(retryBaseMs shl shift, retryMaxMs)
    }

    private suspend fun post(url: String, payload: JSONObject): Int = withContext(Dispatchers.IO) {
        val compressed = ByteArrayOutputStream().use { out ->
            GZIPOutputStream(out).use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            out.toByteArray()
        }
        val request = Request.Builder()
            .url(url)
            .header("content-encoding", "gzip")
            .post(compressed.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
        client.newCall(request).execute().use { it.code }
    }

    private fun load() {
        if (loaded) return
        loaded = true
        try {
            if (!queueFile.isFile) return
            for (line in queueFile.readLines()) {
                if (line.isBlank()) continue
                runCatching { JSONObject(line) }.getOrNull()?.let { items.add(it) }
            }
            while (items.size > queueMax) items.removeAt(0)
        } catch (e: Throwable) {
            // 损坏的队列文件按空处理
        }
    }

    private fun persist() {
        try {
            queueFile.parentFile?.mkdirs()
            queueFile.writeText(
                if (items.isEmpty()) "" else items.joinToString("\n") { it.toString() } + "\n",
                Charsets.UTF_8,
            )
        } catch (e: Throwable) {
            // 写不进去就只保留内存里的队列
        }
    }
}
