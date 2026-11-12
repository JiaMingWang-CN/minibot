package app.minibot.mobile.diag

import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.concurrent.CopyOnWriteArrayList
import org.json.JSONObject

enum class LogLevel(val value: String) { INFO("info"), WARN("warn"), ERROR("error") }

/** 白名单事件：名字、类别与 data 的键值都由内核/客户端校验后才会进队列 */
data class DiagEvent(
    val kind: String,
    val name: String,
    val data: Map<String, Any?>,
    val ts: Long = System.currentTimeMillis(),
)

private val KINDS = setOf("start", "error", "crash", "metric", "update")
private val EVENT_NAME = Regex("""^[a-z0-9._/-]{1,64}$""")
private val DATA_KEY = Regex("""^[A-Za-z0-9._-]{1,64}$""")
private val CONTROL = Regex("""[\u0000-\u001f\u007f-\u009f]""")
private val STACK_CONTROL = Regex("""[\u0000-\u0009\u000b-\u001f\u007f-\u009f]""")
private val FILE_RE = Regex("""minibot-(\d{4}-\d{2}-\d{2})\.log""")
private const val VALUE_MAX = 64
private const val STACK_MAX = 4096
private const val DATA_MAX = 4096
private const val MAX_DEPTH = 4
private const val MAX_ITEMS = 100
private const val CLEANUP_EVERY_BYTES = 1L * 1024 * 1024

/**
 * 本地日志：JSON Lines，按本地日期切文件；保留 maxDays 天、总量不超过 maxBytes，超出删最旧。
 * 写盘在调用线程同步完成（崩溃处理器要在进程退出前写完），任何失败都静默丢弃。
 * 每行写盘前过已登记密钥与形态过滤；事件按白名单校验后通知订阅者。
 */
class DiagLog(
    private val dir: File,
    private val now: () -> Long = System::currentTimeMillis,
    private val maxDays: Int = 7,
    private val maxBytes: Long = 20L * 1024 * 1024,
    private val scrubContext: () -> ScrubContext = { ScrubContext("", "") },
    /** 构造时清理旧文件；主线程创建时传 false，再在 IO 线程调 cleanupNow() */
    cleanupOnInit: Boolean = true,
) {
    private val secrets = CopyOnWriteArrayList<String>()
    private val listeners = CopyOnWriteArrayList<(DiagEvent) -> Unit>()
    private var currentDay: String? = null
    private var sinceCleanup = 0L

    init {
        if (cleanupOnInit) cleanupNow()
    }

    fun cleanupNow() {
        runCatching { cleanup(now()) }
    }

    /** 登记一个已知密钥（API Key、中继口令），之后写日志时替换成 [REDACTED] */
    fun registerSecret(value: String?) {
        if (value != null && value.length >= 8) secrets.addIfAbsent(value)
    }

    /** 订阅通过白名单校验的事件；返回取消订阅函数 */
    fun addListener(listener: (DiagEvent) -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    fun context(): ScrubContext = scrubContext()

    fun write(
        level: LogLevel,
        area: String,
        msg: String,
        fields: Map<String, Any?> = emptyMap(),
        event: DiagEvent? = null,
    ) {
        try {
            val ts = now()
            val row = JSONObject()
            row.put("ts", ts)
            row.put("level", level.value)
            row.put("area", clean(area))
            row.put("msg", clean(msg))
            for ((key, value) in fields) {
                if (key in RESERVED) continue
                val cleaned = sanitize(value, 0)
                row.put(clean(key), if (cleaned == null) JSONObject.NULL else JSONObject.wrap(cleaned))
            }
            append(ts, row.toString() + "\n")
        } catch (e: Throwable) {
            // 目录不可写、磁盘满：丢弃这条，不影响应用
        }
        if (event != null) runCatching { emitEvent(event) }
    }

    /** 取 sinceMs 之后的日志行（已做路径脱敏），总量不超过 maxBytes，保留最新部分 */
    fun recent(sinceMs: Long, maxBytes: Int): String {
        return try {
            val sinceDay = localDay(sinceMs)
            val files = listFiles().filter { !it.first.isBefore(sinceDay) }.sortedBy { it.first }
            val lines = mutableListOf<String>()
            for ((_, file) in files) {
                for (line in file.readLines()) {
                    if (line.isEmpty()) continue
                    val ts = runCatching { JSONObject(line).optLong("ts", 0) }.getOrDefault(0)
                    if (ts >= sinceMs) lines.add(line)
                }
            }
            val kept = mutableListOf<String>()
            var bytes = 0
            for (i in lines.indices.reversed()) {
                val line = scrubPaths(lines[i], scrubContext())
                val size = line.toByteArray(Charsets.UTF_8).size + 1
                if (bytes + size > maxBytes) break
                bytes += size
                kept.add(line)
            }
            kept.asReversed().joinToString("\n", postfix = if (kept.isEmpty()) "" else "\n")
        } catch (e: Throwable) {
            ""
        }
    }

    // —— 脱敏与校验 ——

    private fun clean(text: String): String {
        var out = text
        for (secret in secrets) out = out.replace(secret, "[REDACTED]")
        return redactLike(out)
    }

    private fun scrub(text: String): String = scrubPaths(text, scrubContext())

    private fun sanitize(value: Any?, depth: Int): Any? = when {
        value == null -> null
        value is String -> clean(value)
        value is Boolean -> value
        value is Number -> value
        value is Throwable -> linkedMapOf(
            "name" to clean(value.javaClass.simpleName),
            "message" to clean(value.message ?: ""),
            "stack" to clean(value.stackTraceToString()),
        )
        depth >= MAX_DEPTH -> "[Object]"
        value is Map<*, *> -> linkedMapOf<Any?, Any?>().also { out ->
            value.entries.take(MAX_ITEMS).forEach { (k, v) -> out[clean(k.toString())] = sanitize(v, depth + 1) }
        }
        value is Iterable<*> -> value.take(MAX_ITEMS).map { sanitize(it, depth + 1) }
        value is Array<*> -> value.take(MAX_ITEMS).map { sanitize(it, depth + 1) }
        else -> clean(value.toString())
    }

    /** 白名单校验：不合规字段丢弃；整个事件不合规时返回 null。上传队列也用同一规则。 */
    fun validate(event: DiagEvent): DiagEvent? {
        if (event.kind !in KINDS || !EVENT_NAME.matches(event.name)) {
            dropped(event.name, null, "name")
            return null
        }
        val data = linkedMapOf<String, Any?>()
        val measured = linkedMapOf<String, Any?>()
        for ((key, value) in event.data) {
            if (!DATA_KEY.matches(key)) {
                dropped(event.name, key, "key")
                continue
            }
            when (value) {
                is String -> if (key == "stack") {
                    val cleaned = clean(value)
                    if (cleaned.length > STACK_MAX || STACK_CONTROL.containsMatchIn(cleaned)) dropped(event.name, key, "stack")
                    else data[key] = cleaned
                } else {
                    val text = scrub(clean(value))
                    if (text.length > VALUE_MAX || CONTROL.containsMatchIn(text)) dropped(event.name, key, "string")
                    else {
                        data[key] = text
                        measured[key] = text
                    }
                }
                is Number -> if ((value is Double && !value.isFinite()) || (value is Float && !value.isFinite())) {
                    dropped(event.name, key, "number")
                } else {
                    data[key] = value
                    measured[key] = value
                }
                is Boolean, null -> {
                    data[key] = value
                    measured[key] = value
                }
                else -> dropped(event.name, key, "type")
            }
        }
        if ((JSONObject.wrap(measured)?.toString()?.length ?: 0) > DATA_MAX) {
            dropped(event.name, null, "size")
            return null
        }
        return DiagEvent(event.kind, event.name, data, event.ts)
    }

    private fun emitEvent(event: DiagEvent) {
        val clean = validate(event) ?: return
        val timed = clean.copy(ts = now())
        for (listener in listeners) runCatching { listener(timed) }
    }

    private fun dropped(event: String, field: String?, reason: String) {
        write(LogLevel.WARN, "diag", "事件字段被丢弃", mapOf("event" to event.take(64), "field" to field?.take(64), "reason" to reason))
    }

    // —— 磁盘 ——

    private fun append(ts: Long, line: String) {
        synchronized(this) {
            dir.mkdirs()
            val day = localDay(ts).toString()
            File(dir, "minibot-$day.log").appendText(line, Charsets.UTF_8)
            val switched = currentDay != day
            currentDay = day
            sinceCleanup += line.toByteArray(Charsets.UTF_8).size
            if (switched || sinceCleanup >= CLEANUP_EVERY_BYTES) cleanup(ts)
        }
    }

    private fun listFiles(): List<Pair<LocalDate, File>> {
        val files = dir.listFiles() ?: return emptyList()
        return files.mapNotNull { file ->
            val match = FILE_RE.matchEntire(file.name) ?: return@mapNotNull null
            if (!file.isFile) return@mapNotNull null
            runCatching { LocalDate.parse(match.groupValues[1]) to file }.getOrNull()
        }
    }

    /** 先删超过保留天数的，再从最旧删起直到总量不超过上限 */
    private fun cleanup(nowMs: Long) {
        val today = localDay(nowMs)
        for ((day, file) in listFiles()) {
            if (ChronoUnit.DAYS.between(day, today) >= maxDays) file.delete()
        }
        val kept = listFiles().sortedBy { it.first }
        var total = kept.sumOf { it.second.length() }
        for ((_, file) in kept) {
            if (total <= maxBytes) break
            val size = file.length()
            if (file.delete()) total -= size
        }
        sinceCleanup = 0
    }

    private fun localDay(ms: Long): LocalDate =
        Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).toLocalDate()

    private companion object {
        val RESERVED = setOf("ts", "level", "area", "msg")
    }
}
