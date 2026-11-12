package app.minibot.mobile.diag

import android.content.Context
import android.os.Build
import android.os.Process
import app.minibot.mobile.BuildConfig
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 诊断层的进程内单例：日志、同意状态、上传队列。任何一步失败都不影响应用本身。
 * 收集点地址来自构建时的 BuildConfig.COLLECT_URL，空串表示上传与反馈整体关闭。
 */
object Diag {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile private var logRef: DiagLog? = null
    @Volatile private var settingsRef: DiagSettings? = null
    @Volatile private var uploaderRef: Uploader? = null

    @Volatile var appVersion: String = ""
        private set
    @Volatile var os: String = ""
        private set

    val settings: DiagSettings? get() = settingsRef
    val uploader: Uploader? get() = uploaderRef
    val available: Boolean get() = uploaderRef?.available == true

    @Synchronized
    fun init(context: Context) {
        if (logRef != null) return
        val appContext = context.applicationContext
        val appDir = appContext.filesDir.parentFile ?: appContext.filesDir
        appVersion = BuildConfig.VERSION_NAME
        os = "Android " + (Build.VERSION.RELEASE ?: "unknown")
        val log = DiagLog(
            dir = File(appContext.filesDir, "logs"),
            scrubContext = { ScrubContext(appDir.path, appDir.path) },
            cleanupOnInit = false,
        )
        val settings = DiagSettings(appContext)
        val uploader = Uploader(
            queueFile = File(appContext.filesDir, "diag-queue.jsonl"),
            diag = log,
            collectUrl = BuildConfig.COLLECT_URL,
            consent = { settings.consent },
            installId = { settings.installId },
            platform = "android",
            appVersion = appVersion,
            os = os,
            scope = scope,
        )
        logRef = log
        settingsRef = settings
        uploaderRef = uploader
        installCrashHandler(log, uploader)
        uploader.start()
        // 清旧文件与写启动日志都放到 IO 线程，不在主线程碰磁盘
        scope.launch {
            log.cleanupNow()
            log.write(
                LogLevel.INFO,
                "app",
                "app.start",
                mapOf("appVersion" to appVersion, "os" to os),
                DiagEvent("start", "app.start", mapOf("appVersion" to appVersion, "os" to os)),
            )
        }
    }

    fun write(
        level: LogLevel,
        area: String,
        msg: String,
        fields: Map<String, Any?> = emptyMap(),
        event: DiagEvent? = null,
    ) {
        logRef?.write(level, area, msg, fields, event)
    }

    fun registerSecret(value: String?) {
        logRef?.registerSecret(value)
    }

    fun recentLogs(): String = uploaderRef?.recentLogs() ?: ""

    fun setConsent(value: String) {
        uploaderRef?.setConsent(value)
    }

    /** 网页层未捕获错误：消息只进完整日志，事件只带脱敏堆栈 */
    fun reportClientError(message: String, stack: String?) {
        val log = logRef ?: return
        val scrubbed = stack?.takeIf { it.isNotEmpty() }?.let { scrubStack(it, log.context()) }
        write(
            LogLevel.ERROR,
            "app",
            "renderer.error",
            buildMap {
                put("message", message)
                scrubbed?.let { put("stack", it) }
            },
            DiagEvent(
                "crash",
                "crash/renderer",
                buildMap {
                    put("source", "renderer")
                    scrubbed?.let { put("stack", it) }
                },
            ),
        )
    }

    /** 同步写 crash 与事件，然后交回系统原来的处理器（进程照常崩溃） */
    private fun installCrashHandler(log: DiagLog, uploader: Uploader) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                val stack = scrubStack(error.stackTraceToString(), log.context())
                val event = DiagEvent("crash", "crash/app", mapOf("source" to "android", "stack" to stack))
                log.write(
                    LogLevel.ERROR,
                    "app",
                    "app.crash",
                    mapOf("thread" to thread.name, "message" to (error.message ?: ""), "stack" to stack),
                    event,
                )
                uploader.enqueue(event)
            } catch (e: Throwable) {
                // 崩溃处理本身失败也必须继续走原处理器
            }
            if (previous != null) previous.uncaughtException(thread, error) else Process.killProcess(Process.myPid())
        }
    }
}
