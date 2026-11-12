package app.minibot.mobile

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import app.minibot.mobile.diag.Diag
import app.minibot.mobile.remote.ConnectionState
import app.minibot.mobile.remote.Connector
import app.minibot.mobile.remote.KeystorePairingStore
import app.minibot.mobile.remote.OkHttpCarrierFactory
import app.minibot.mobile.remote.PairingStore
import app.minibot.mobile.remote.StoreUnavailableException
import app.minibot.mobile.remote.Via
import app.minibot.mobile.update.Updater
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

class OfflineException : Exception()

/** 网页层看到的事件出口，由插件实现 */
interface HubSink {
    fun kernelEvent(event: JSONObject)
    fun ready(pcName: String)
    fun status()
    fun openThread(threadId: String)
    fun updateProgress(percent: Int)
    fun updateError(message: String)
}

/** 进程内唯一的远程连接中枢：Connector + 请求应答 + 通知；前台服务只负责让进程活着 */
object RemoteHub {
    private const val REQUEST_TIMEOUT_MS = 60_000L

    private lateinit var appContext: Context
    private lateinit var prefs: SharedPreferences
    lateinit var store: PairingStore
        private set
    lateinit var connector: Connector
        private set
    lateinit var poster: AndroidPoster
        private set
    lateinit var updater: Updater
        private set
    private lateinit var notifier: Notifier
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var initialized = false

    /** 电脑发来的非应答消息：单个协程按到达顺序处理（delta 必须按序拼接） */
    private val inbox = Channel<JSONObject>(Channel.UNLIMITED)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()
    private val nextId = AtomicInteger(1)
    private val botNames = ConcurrentHashMap<String, String>()
    private val threadBots = ConcurrentHashMap<String, String>()
    private val threadTitles = ConcurrentHashMap<String, String>()

    @Volatile var sink: HubSink? = null
    @Volatile var webVisible = false
    @Volatile var activeThread: String? = null
    @Volatile var launchThread: String? = null

    var background: Boolean
        get() = prefs.getBoolean("background", true)
        set(value) = prefs.edit().putBoolean("background", value).apply()

    @Synchronized
    fun init(context: Context) {
        if (initialized) return
        initialized = true
        appContext = context.applicationContext
        Diag.init(appContext)
        prefs = appContext.getSharedPreferences("remote", Context.MODE_PRIVATE)
        store = KeystorePairingStore(appContext)
        // 中继口令登记为密钥：日志里万一出现也会被替换。读存储要解密，放到 IO 线程
        scope.launch(Dispatchers.IO) {
            try {
                store.load()?.relayToken?.let { Diag.registerSecret(it) }
            } catch (e: Exception) {
                // 存储暂时读不出时下次连接再登记
            }
        }
        poster = AndroidPoster(appContext)
        updater = Updater(
            updateDir = File(appContext.cacheDir, "update"),
            currentVersionCode = BuildConfig.VERSION_CODE,
            lastCheckAt = { prefs.getLong("updateCheckedAt", 0L) },
            saveLastCheckAt = { prefs.edit().putLong("updateCheckedAt", it).apply() },
            onProgress = { percent -> sink?.updateProgress(percent) },
            installer = { file -> installUpdate(file) },
        )
        connector = Connector(scope, store, OkHttpCarrierFactory())
        connector.onCompatChanged = { sink?.status() }
        connector.onMessage = { message ->
            // 应答直接交给等待者：处理事件时可能要发请求并等应答，放进同一队列会互相等死
            if (message.optString("t") == "res") pending[message.optString("id")]?.complete(message)
            else inbox.trySend(message)
        }
        scope.launch { for (message in inbox) handle(message) }
        notifier = Notifier(
            poster = poster,
            text = NotifierText(
                approvalTitle = { appContext.getString(R.string.approval_title, it) },
                approvalPublic = appContext.getString(R.string.approval_public),
                doneTitle = { appContext.getString(R.string.done_title, it) },
                fallbackBotName = appContext.getString(R.string.app_name),
            ),
            botName = { botNames[it] },
            threadBotId = { id -> threadBots[id] ?: fetchThread(id)?.let { threadBots[id] } },
            threadTitle = { id -> threadTitles[id] ?: fetchThread(id)?.let { threadTitles[id] } },
            isViewing = { id -> webVisible && activeThread == id },
        )
        connector.state.onEach { state ->
            if (state !is ConnectionState.Connected) rejectAll()
            // 被电脑撤销：配对已清除，不必再保持后台连接
            if (state is ConnectionState.Revoked) RemoteService.stop(appContext)
            sink?.status()
        }.launchIn(scope)
        watchNetwork()
    }

    private fun watchNetwork() {
        val cm = appContext.getSystemService(ConnectivityManager::class.java)
        var first = true
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // 注册时会立刻回调一次，那不是网络变化
                if (first) first = false else connector.networkChanged()
            }

            override fun onLost(network: Network) {
                connector.networkChanged()
            }
        })
    }

    fun startConnection() {
        connector.start()
    }

    /** 是否已配对；存储暂时读不出时按已配对处理（数据还在） */
    fun isPaired(): Boolean = try {
        store.load() != null
    } catch (e: StoreUnavailableException) {
        true
    }

    // —— 请求 / 应答 ——

    suspend fun request(method: String, path: String, body: Any?): JSONObject {
        if (connector.state.value !is ConnectionState.Connected) throw OfflineException()
        val id = nextId.getAndIncrement().toString()
        val deferred = CompletableDeferred<JSONObject>()
        pending[id] = deferred
        try {
            val message = JSONObject().put("t", "req").put("id", id).put("method", method).put("path", path)
            if (body != null) message.put("body", body)
            // 大消息会按承载积压阻塞分批发送，放到 IO 线程；超时从全部送出后开始算
            withContext(Dispatchers.IO) { connector.send(message) }
            return withTimeout(REQUEST_TIMEOUT_MS) { deferred.await() }
        } finally {
            pending.remove(id)
        }
    }

    fun sendControl(msg: Any) {
        scope.launch(Dispatchers.IO) { connector.send(JSONObject().put("t", "ctl").put("msg", msg)) }
    }

    private fun rejectAll() {
        for (deferred in pending.values) deferred.completeExceptionally(OfflineException())
        pending.clear()
    }

    private suspend fun handle(message: JSONObject) {
        when (message.optString("t")) {
            "evt" -> {
                val event = message.optJSONObject("event") ?: return
                notifier.onEvent(event)
                sink?.kernelEvent(event)
            }
            "ready" -> {
                sink?.ready(message.optString("pcName"))
                refreshBots()
                refreshRunning()
            }
        }
    }

    /** 收到 ready 后取一次 bot 列表，通知标题要用 bot 名 */
    private suspend fun refreshBots() {
        try {
            // ready 与"已连接"状态几乎同时到，先等状态就位
            withTimeout(5_000) { connector.state.first { it is ConnectionState.Connected } }
            val res = request("GET", "/api/state", null)
            val bots = res.optJSONObject("body")?.optJSONArray("bots") ?: return
            for (i in 0 until bots.length()) {
                val bot = bots.getJSONObject(i)
                botNames[bot.getString("id")] = bot.optString("name")
            }
        } catch (e: Exception) {
            // 取不到就用默认名
        }
    }

    /** 连上时已在运行的对话：之后它结束也要发完成通知 */
    private suspend fun refreshRunning() {
        try {
            val ids = request("GET", "/api/running", null).optJSONArray("body") ?: return
            notifier.seedRunning(List(ids.length()) { ids.getString(it) })
        } catch (e: Exception) {
            // 取不到就只按之后收到的事件判断
        }
    }

    private suspend fun fetchThread(id: String): JSONObject? = try {
        val body = request("GET", "/api/threads/$id", null).optJSONObject("body")
        if (body != null) {
            threadBots[id] = body.optString("botId")
            threadTitles[id] = body.optString("title")
        }
        body
    } catch (e: Exception) {
        null
    }

    fun requestFailure(e: Throwable): Pair<String, String> = when (e) {
        is OfflineException -> "offline" to appContext.getString(R.string.error_offline)
        is TimeoutCancellationException -> "timeout" to appContext.getString(R.string.error_timeout)
        else -> "error" to (e.message ?: "请求失败")
    }

    // —— 状态 ——

    fun statusJson(): JSONObject {
        val pairing = try {
            store.load()
        } catch (e: StoreUnavailableException) {
            return baseStatus(paired = true, pcName = null, connection = "error", error = e.message)
        }
        val state = connector.state.value
        val connection = when (state) {
            ConnectionState.Idle -> "idle"
            ConnectionState.Connecting -> "connecting"
            is ConnectionState.Connected -> if (state.via == Via.LAN) "lan" else "relay"
            ConnectionState.PcOffline -> "pc_offline"
            ConnectionState.Revoked -> "revoked"
            is ConnectionState.Error -> "error"
        }
        return baseStatus(pairing != null, pairing?.pcName, connection, (state as? ConnectionState.Error)?.message)
    }

    private fun baseStatus(paired: Boolean, pcName: String?, connection: String, error: String?): JSONObject {
        val power = appContext.getSystemService(PowerManager::class.java)
        return JSONObject()
            .put("paired", paired)
            .put("deviceModel", Build.MODEL)
            .put("pcName", pcName ?: JSONObject.NULL)
            .put("connection", connection)
            .put("error", error ?: JSONObject.NULL)
            .put("compat", connector.compat)
            .put("background", background)
            .put("notificationsAllowed", NotificationManagerCompat.from(appContext).areNotificationsEnabled())
            .put("batteryOptimized", !power.isIgnoringBatteryOptimizations(appContext.packageName))
    }

    fun connectionText(): String {
        val state = connector.state.value
        return when (state) {
            is ConnectionState.Connected -> appContext.getString(
                if (state.via == Via.LAN) R.string.conn_lan else R.string.conn_relay, state.pcName,
            )
            ConnectionState.PcOffline -> appContext.getString(R.string.conn_pc_offline)
            ConnectionState.Revoked -> appContext.getString(R.string.conn_revoked)
            ConnectionState.Idle -> appContext.getString(R.string.conn_idle)
            else -> appContext.getString(R.string.conn_reconnecting)
        }
    }

    /** 校验过的 APK 交给系统安装器（FileProvider 只暴露缓存目录） */
    private fun installUpdate(file: File) {
        val uri = FileProvider.getUriForFile(appContext, appContext.packageName + ".fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        appContext.startActivity(intent)
    }

    fun openThread(threadId: String) {
        val s = sink
        if (s != null) s.openThread(threadId) else launchThread = threadId
    }

    suspend fun unpair() {
        connector.stop()
        rejectAll()
        store.clear()
        sink?.status()
    }

    val hubScope: CoroutineScope get() = scope
}
