package app.minibot.mobile

import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import app.minibot.mobile.remote.ConnectionState
import app.minibot.mobile.remote.Connector
import app.minibot.mobile.remote.KeystorePairingStore
import app.minibot.mobile.remote.OkHttpCarrierFactory
import app.minibot.mobile.remote.PairingStore
import app.minibot.mobile.remote.Via
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

class OfflineException : Exception()

/** 网页层看到的事件出口，由插件实现 */
interface HubSink {
    fun kernelEvent(event: JSONObject)
    fun ready(pcName: String)
    fun status()
    fun openThread(threadId: String)
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
    private lateinit var notifier: Notifier
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var initialized = false

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
        prefs = appContext.getSharedPreferences("remote", Context.MODE_PRIVATE)
        store = KeystorePairingStore(appContext)
        poster = AndroidPoster(appContext)
        connector = Connector(scope, store, OkHttpCarrierFactory())
        connector.onMessage = { message -> scope.launch { handle(message) } }
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
        if (store.load() != null) connector.start()
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
            connector.send(message)
            return withTimeout(REQUEST_TIMEOUT_MS) { deferred.await() }
        } finally {
            pending.remove(id)
        }
    }

    fun sendControl(msg: Any) {
        connector.send(JSONObject().put("t", "ctl").put("msg", msg))
    }

    private fun rejectAll() {
        for (deferred in pending.values) deferred.completeExceptionally(OfflineException())
        pending.clear()
    }

    private suspend fun handle(message: JSONObject) {
        when (message.optString("t")) {
            "res" -> pending[message.optString("id")]?.complete(message)
            "evt" -> {
                val event = message.optJSONObject("event") ?: return
                notifier.onEvent(event)
                sink?.kernelEvent(event)
            }
            "ready" -> {
                sink?.ready(message.optString("pcName"))
                refreshBots()
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
        val pairing = store.load()
        val state = connector.state.value
        val connection = when (state) {
            ConnectionState.Idle -> "idle"
            ConnectionState.Connecting -> "connecting"
            is ConnectionState.Connected -> if (state.via == Via.LAN) "lan" else "relay"
            ConnectionState.PcOffline -> "pc_offline"
            ConnectionState.Revoked -> "revoked"
            is ConnectionState.Error -> "error"
        }
        val power = appContext.getSystemService(PowerManager::class.java)
        return JSONObject()
            .put("paired", pairing != null)
            .put("deviceModel", Build.MODEL)
            .put("pcName", pairing?.pcName ?: JSONObject.NULL)
            .put("connection", connection)
            .put("error", (state as? ConnectionState.Error)?.message ?: JSONObject.NULL)
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
