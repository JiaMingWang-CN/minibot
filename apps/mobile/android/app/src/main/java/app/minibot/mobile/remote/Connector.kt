package app.minibot.mobile.remote

import app.minibot.mobile.BuildConfig
import app.minibot.mobile.diag.Diag
import app.minibot.mobile.diag.DiagEvent
import app.minibot.mobile.diag.LogLevel
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONException
import org.json.JSONObject

enum class Via { LAN, RELAY }

sealed class ConnectionState {
    object Idle : ConnectionState()
    object Connecting : ConnectionState()
    data class Connected(val via: Via, val pcName: String) : ConnectionState()
    object PcOffline : ConnectionState()
    object Revoked : ConnectionState()
    data class Error(val message: String) : ConnectionState()
}

class PairingFailedException(message: String) : Exception(message)

/** 远程协议版本：消息格式有不兼容改动时 +1 */
const val REMOTE_PROTOCOL = 1
/** 电脑端要求的最低手机协议（随 version 的 minPeer 发出） */
const val MIN_PHONE_PROTOCOL = 1
/** 手机端要求的最低电脑协议（我们发出的 minPeer） */
const val MIN_PC_PROTOCOL = 1

const val HANDSHAKE_TIMEOUT_MS = 10_000L
const val LAN_RACE_MS = 1_500L
/** 连续这么多次"承载连通但握手被电脑关闭"才判定为已撤销，避免电脑重启、超时等偶发情况误判 */
const val REVOKE_AFTER_REJECTIONS = 3
val BACKOFF_SECONDS = longArrayOf(1, 2, 4, 8, 16, 32, 60)

private sealed interface Ev {
    object Opened : Ev
    data class Peer(val online: Boolean) : Ev
    data class Closed(val reason: CloseReason) : Ev
    object Ready : Ev
    object Paired : Ev
    object Kick : Ev
    /** 电脑的 version 消息：与 Ready 走同一个队列，按到达顺序处理 */
    data class Version(val message: JSONObject) : Ev
}

private sealed interface Outcome {
    object Revoked : Outcome
    /** 连接结束；connected 表示期间曾握手成功（用来重置退避） */
    data class Ended(val connected: Boolean, val message: String) : Outcome
    object Paired : Outcome
}

private class Link(val carrier: Carrier, val via: Via) {
    val events = Channel<Ev>(Channel.UNLIMITED)
    @Volatile var channel: SecureChannel? = null
    /** 配对：第二条握手消息已验过，认领这条线路后调用它发出第三条消息 */
    @Volatile var completePairing: (() -> Unit)? = null

    init {
        carrier.onOpen = { events.trySend(Ev.Opened) }
        carrier.onPeer = { events.trySend(Ev.Peer(it)) }
        carrier.onClose = { events.trySend(Ev.Closed(it)) }
    }

    fun close() = carrier.close()
}

/**
 * 持有到电脑的加密连接：局域网优先、中继兜底，断线退避重连。
 * 握手与收帧都在承载回调线程里同步完成（换处理函数不丢帧），回调只往事件队列投递，状态机跑在 scope 里。
 */
class Connector(
    private val scope: CoroutineScope,
    private val store: PairingStore,
    private val carriers: CarrierFactory,
) {
    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
    val state: StateFlow<ConnectionState> = _state

    /** 电脑发来的应用消息（不含配对确认） */
    @Volatile var onMessage: (JSONObject) -> Unit = {}

    /** 与电脑的协议兼容状态：从未报告版本（旧版电脑）时保持 unknown */
    @Volatile var compat: String = "unknown"
        private set

    /** 兼容状态变化时通知外层（界面要显示版本不兼容提示） */
    @Volatile var onCompatChanged: () -> Unit = {}

    @Volatile private var activeChannel: SecureChannel? = null
    private val links = CopyOnWriteArrayList<Link>()
    private val kick = Channel<Unit>(Channel.CONFLATED)
    private var job: Job? = null

    fun start() {
        if (job?.isActive == true) return
        // 读存储要解密：放到协程（IO 线程）里做，别阻塞调用方（通常是主线程）
        job = scope.launch {
            val paired = try {
                store.load() != null
            } catch (e: StoreUnavailableException) {
                // 读不出也启动：循环里会退避重试
                true
            }
            if (paired) loop()
        }
    }

    suspend fun stop() {
        job?.cancelAndJoin()
        job = null
        closeAll()
        _state.value = ConnectionState.Idle
    }

    fun send(message: JSONObject) {
        activeChannel?.send(message)
    }

    /** 系统网络变化：立即放弃当前连接 / 退避等待，重新选择线路 */
    fun networkChanged() {
        kick.trySend(Unit)
        for (link in links) link.events.trySend(Ev.Kick)
    }

    // —— 日常连接 ——

    private suspend fun loop() {
        var attempt = 0
        var rejections = 0
        while (true) {
            val loaded = try {
                val pairing = store.load() ?: run { _state.value = ConnectionState.Idle; return }
                pairing to store.identity()
            } catch (e: StoreUnavailableException) {
                _state.value = ConnectionState.Error(e.message ?: "暂时无法读取配对信息")
                null
            }
            if (loaded != null) {
                val (pairing, identity) = loaded
                _state.value = ConnectionState.Connecting
                val start: (Link) -> Unit = { startKk(it, pairing, identity) }
                val outcome = connectOnce(pairing, pairing.lanAddresses, pairing.lanPort, pairing.relayUrl, pairing.relayToken, pairing.routeId, start, pair = false)
                activeChannel = null
                if (outcome is Outcome.Revoked) {
                    Diag.write(
                        LogLevel.WARN, "remote", "connect.revoked", mapOf("attempt" to attempt),
                        DiagEvent("error", "remote.connect", mapOf("reason" to "revoked")),
                    )
                    rejections += 1
                    if (rejections >= REVOKE_AFTER_REJECTIONS) {
                        // 电脑已撤销这台手机：清掉配对，回到配对页，不再重连
                        store.clear()
                        _state.value = ConnectionState.Revoked
                        return
                    }
                } else {
                    rejections = 0
                }
                if (outcome is Outcome.Ended) {
                    val reason = reasonCategory(outcome.message)
                    Diag.write(
                        LogLevel.WARN, "remote", "connect.ended",
                        mapOf("connected" to outcome.connected, "reason" to reason, "attempt" to attempt),
                        DiagEvent("error", "remote.connect", mapOf("reason" to reason, "connected" to outcome.connected)),
                    )
                }
                if (outcome is Outcome.Ended && outcome.connected) attempt = 0
                _state.value = ConnectionState.Connecting
            }
            val wait = BACKOFF_SECONDS[minOf(attempt, BACKOFF_SECONDS.size - 1)] * 1000
            attempt += 1
            if (withTimeoutOrNull(wait) { kick.receive() } != null) attempt = 0
        }
    }

    private suspend fun connectOnce(
        pairing: Pairing?,
        lan: List<String>,
        lanPort: Int,
        relayUrl: String?,
        relayToken: String?,
        routeId: String,
        start: (Link) -> Unit,
        pair: Boolean,
    ): Outcome {
        val pcName = pairing?.pcName ?: ""
        var lanRejected = false
        if (lan.isNotEmpty()) {
            val result = lanRace(lan, lanPort, start, pair, pcName)
            if (result is Outcome.Revoked) lanRejected = true
            else if (result != null) return result
        }
        if (relayUrl == null) return if (lanRejected) Outcome.Revoked else Outcome.Ended(false, "没有可用的线路")
        val link = newLink(carriers.relay(relayUrl, routeId, relayToken), Via.RELAY)
        try {
            return drive(link, start, pair, pcName) { true }
        } finally {
            dropLink(link)
        }
    }

    /** 并发尝试所有局域网地址，LAN_RACE_MS 内先握手成功者胜；返回 null 表示都没成功 */
    private suspend fun lanRace(
        addresses: List<String>,
        port: Int,
        start: (Link) -> Unit,
        pair: Boolean,
        pcName: String,
    ): Outcome? {
        val connected = CompletableDeferred<Link>()
        val lanLinks = addresses.map { newLink(carriers.lan(it, port), Via.LAN) }
        // 只有第一个握手成功的承载能成为当前连接；后到的直接关掉，不碰 activeChannel
        val drives = lanLinks.map { link -> scope.async { drive(link, start, pair, pcName) { connected.complete(link) } } }
        val allDone = scope.async { drives.awaitAll(); null as Link? }
        val winner = withTimeoutOrNull(LAN_RACE_MS) {
            select<Link?> {
                connected.onAwait { it }
                allDone.onAwait { it }
            }
        }
        allDone.cancel()
        if (winner == null) {
            val rejected = drives.any { it.isCompleted && !it.isCancelled && it.await() is Outcome.Revoked }
            lanLinks.forEach { it.close() }
            drives.forEach { it.cancelAndJoin() }
            lanLinks.forEach { dropLink(it) }
            return if (rejected) Outcome.Revoked else null
        }
        lanLinks.forEachIndexed { i, link ->
            if (link !== winner) {
                link.close()
                drives[i].cancelAndJoin()
                dropLink(link)
            }
        }
        val winning = drives[lanLinks.indexOf(winner)]
        return try {
            winning.await()
        } finally {
            dropLink(winner)
        }
    }

    private fun newLink(carrier: Carrier, via: Via): Link = Link(carrier, via).also { links.add(it) }

    private fun dropLink(link: Link) {
        links.remove(link)
        link.close()
    }

    private fun closeAll() {
        activeChannel = null
        for (link in links) link.close()
        links.clear()
    }

    private enum class Phase { OPEN, WAIT_PEER, HANDSHAKE, CONNECTED, PAIRED }

    /**
     * 单条承载的状态机：打开 → 等电脑在线 → 握手 → 连通，中继上电脑下线再上线会在同一承载上重新握手。
     * claim：首次握手成功时调用，返回 false 表示另一条承载已胜出，本条应放弃。
     */
    private suspend fun drive(link: Link, start: (Link) -> Unit, pair: Boolean, pcName: String, claim: () -> Boolean): Outcome {
        var claimed = false
        var phase = Phase.OPEN
        var connectedOnce = false
        // 握手完成（Ready）之前到达的 version 先暂存，胜出后再应用
        var pendingVersion: JSONObject? = null
        while (true) {
            val timed = phase == Phase.OPEN || phase == Phase.HANDSHAKE || phase == Phase.PAIRED
            val ev = if (timed) {
                withTimeoutOrNull(HANDSHAKE_TIMEOUT_MS) { link.events.receive() }
                    ?: run { link.close(); return Outcome.Ended(connectedOnce, "连接超时") }
            } else {
                link.events.receive()
            }
            when (ev) {
                Ev.Opened -> if (phase == Phase.OPEN) {
                    if (link.via == Via.LAN) {
                        phase = Phase.HANDSHAKE
                        start(link)
                    } else {
                        phase = Phase.WAIT_PEER
                    }
                }
                is Ev.Peer -> {
                    if (ev.online) {
                        if (phase == Phase.WAIT_PEER || phase == Phase.OPEN) {
                            phase = Phase.HANDSHAKE
                            start(link)
                        }
                    } else {
                        if (pair) {
                            link.close()
                            return Outcome.Ended(false, "电脑不在线")
                        }
                        activeChannel = null
                        link.channel = null
                        phase = Phase.WAIT_PEER
                        _state.value = ConnectionState.PcOffline
                    }
                }
                Ev.Ready -> if (phase == Phase.HANDSHAKE) {
                    // 中继上电脑下线再上线会在同一承载上再次握手，那时已经认领过
                    if (!claimed) {
                        if (!claim()) {
                            link.close()
                            return Outcome.Ended(false, "另一条线路已连上")
                        }
                        claimed = true
                    }
                    // 只有胜出的线路能改兼容状态：落选线路的握手完成不能把它重置掉
                    compat = "unknown"
                    runCatching { onCompatChanged() }
                    pendingVersion?.let { handlePeerVersion(it) }
                    pendingVersion = null
                    if (pair) {
                        phase = Phase.PAIRED
                        try {
                            link.completePairing?.invoke()
                        } catch (e: NoiseException) {
                            link.close()
                            return Outcome.Ended(false, "配对握手失败")
                        }
                    } else {
                        phase = Phase.CONNECTED
                        connectedOnce = true
                        activeChannel = link.channel
                        _state.value = ConnectionState.Connected(link.via, pcName)
                        Diag.write(LogLevel.INFO, "remote", "connect.ok", mapOf("via" to link.via.name.lowercase()))
                    }
                }
                is Ev.Version -> {
                    // 只有认领后的线路在握手完成状态下才改兼容状态；其余时刻暂存
                    if (claimed && (phase == Phase.CONNECTED || phase == Phase.PAIRED)) handlePeerVersion(ev.message)
                    else pendingVersion = ev.message
                }
                Ev.Paired -> if (phase == Phase.PAIRED) return Outcome.Paired
                Ev.Kick -> {
                    link.close()
                    return Outcome.Ended(connectedOnce, "网络变化")
                }
                is Ev.Closed -> {
                    // 承载已连通、握手中被对端正常关闭：电脑不认这台手机
                    if (phase == Phase.HANDSHAKE && ev.reason == CloseReason.Normal) return Outcome.Revoked
                    return Outcome.Ended(connectedOnce, (ev.reason as? CloseReason.Network)?.message ?: "连接已关闭")
                }
            }
        }
    }

    // —— 握手（在承载回调线程里同步完成，之后立刻换成信道的处理函数） ——

    private fun finishHandshake(link: Link, hs: Handshake, pairing: Boolean = false) {
        val (send, recv) = hs.split()
        val channel = SecureChannel(link.carrier, send, recv)
        link.channel = channel
        channel.onClose = { link.events.trySend(Ev.Closed(CloseReason.Network("信道已关闭"))) }
        channel.onMessage = { message ->
            when (message.optString("t")) {
                "paired" -> link.events.trySend(Ev.Paired)
                "version" -> link.events.trySend(Ev.Version(message))
                else -> {
                    // 配对中的地址刚从配对码里拿到，不需要再更新
                    if (!pairing && message.optString("t") == "ready") {
                        applyReady(message)
                        // ready 之后紧接着告知协议版本；旧版电脑不认识会忽略
                        channel.send(
                            JSONObject()
                                .put("t", "version")
                                .put("app", BuildConfig.VERSION_NAME)
                                .put("protocol", REMOTE_PROTOCOL)
                                .put("minPeer", MIN_PC_PROTOCOL),
                        )
                    }
                    onMessage(message)
                }
            }
        }
        link.events.trySend(Ev.Ready)
    }

    /**
     * ready 里带电脑当前的局域网地址与端口；与已保存的不同就更新，电脑换 IP 后不必重新配对。
     * 字段缺失（旧版电脑）或地址列表为空（电脑关了局域网）时保持原值。
     */
    private fun applyReady(message: JSONObject) {
        try {
            val current = store.load() ?: return
            val array = message.optJSONArray("lan")
            val addresses = if (array == null) emptyList() else List(array.length()) { array.getString(it) }
            val lan = if (addresses.isEmpty()) current.lanAddresses else addresses
            val port = message.optInt("port", current.lanPort).takeIf { it in 1..65535 } ?: current.lanPort
            if (lan != current.lanAddresses || port != current.lanPort) {
                store.save(current.copy(lanAddresses = lan, lanPort = port))
            }
        } catch (e: StoreUnavailableException) {
            // 下次 ready 再更新
        } catch (e: JSONException) {
            // 格式不对就当没带
        }
    }

    /** 电脑的 version：协议号不兼容时记录 compat，界面据此提示更新 */
    private fun handlePeerVersion(message: JSONObject) {
        // 与电脑端一致：字段缺失或不是数字就忽略这条消息
        val protocol = (message.opt("protocol") as? Number)?.toInt() ?: return
        val minPeer = (message.opt("minPeer") as? Number)?.toInt() ?: return
        val app = message.optString("app").take(64)
        compat = when {
            protocol < MIN_PC_PROTOCOL -> "pc_outdated"
            REMOTE_PROTOCOL < minPeer -> "phone_outdated"
            else -> "ok"
        }
        if (compat == "ok") {
            Diag.write(LogLevel.INFO, "remote", "version.ok", mapOf("app" to app, "pcProtocol" to protocol))
        } else {
            Diag.write(
                LogLevel.WARN, "remote", "version.mismatch",
                mapOf("result" to compat, "pcProtocol" to protocol, "pcApp" to app, "phoneProtocol" to REMOTE_PROTOCOL),
                DiagEvent(
                    "error", "remote.version_mismatch",
                    mapOf("result" to compat, "pcProtocol" to protocol, "phoneProtocol" to REMOTE_PROTOCOL),
                ),
            )
        }
        runCatching { onCompatChanged() }
    }

    private fun failHandshake(link: Link, message: String) {
        link.events.trySend(Ev.Closed(CloseReason.Network(message)))
        link.close()
    }

    private fun startKk(link: Link, pairing: Pairing, identity: KeyPair) {
        val hs = Handshake(NoisePattern.KK, initiator = true, s = identity, rs = pairing.pcPublicKey)
        link.carrier.onFrame = { frame ->
            try {
                if (frame.isEmpty() || frame[0] != FRAME_KK) throw NoiseException("意外的帧")
                hs.readMessage(frame.copyOfRange(1, frame.size))
                finishHandshake(link, hs)
            } catch (e: NoiseException) {
                failHandshake(link, "握手失败")
            }
        }
        link.carrier.send(byteArrayOf(FRAME_KK) + hexToBytes(pairing.deviceId) + hs.writeMessage(ByteArray(0)))
    }

    private fun startPair(link: Link, offer: PairingOffer, deviceName: String, identity: KeyPair) {
        val hs = Handshake(NoisePattern.XXpsk3, initiator = true, s = identity, psk = offer.psk)
        link.carrier.onFrame = { frame ->
            try {
                if (frame.isEmpty() || frame[0] != FRAME_PAIR) throw NoiseException("意外的帧")
                hs.readMessage(frame.copyOfRange(1, frame.size))
                // 配对码里的电脑公钥必须与握手里电脑出示的一致
                if (!hs.remoteStatic().contentEquals(offer.pcPublicKey)) throw NoiseException("电脑身份不符")
                // 第三条消息会让电脑作废邀请：几条局域网地址可能通到同一台电脑，
                // 只有被认领的那条线路才能发，否则电脑接受的可能是手机随后关掉的那条
                link.completePairing = {
                    val hello = JSONObject().put("deviceName", deviceName).toString().toByteArray(Charsets.UTF_8)
                    val message = byteArrayOf(FRAME_PAIR) + hs.writeMessage(hello)
                    // 先装好信道再发：电脑收到后立刻回 paired / ready
                    finishHandshake(link, hs, pairing = true)
                    link.carrier.send(message)
                }
                link.events.trySend(Ev.Ready)
            } catch (e: NoiseException) {
                failHandshake(link, "配对握手失败")
            }
        }
        link.carrier.send(byteArrayOf(FRAME_PAIR) + hs.writeMessage(ByteArray(0)))
    }

    // —— 配对 ——

    /** 用配对码走 XXpsk3；成功后保存配对信息并转入日常连接 */
    suspend fun pair(offer: PairingOffer, deviceName: String) {
        val name = deviceName.trim()
        if (name.isEmpty() || name.length > 40) throw PairingFailedException("设备名需要 1–40 个字符")
        Diag.write(LogLevel.INFO, "remote", "pair.start", mapOf("lan" to offer.lanAddresses.size, "relay" to (offer.relayUrl != null)))
        stop()
        val identity = try {
            store.identity()
        } catch (e: StoreUnavailableException) {
            resumeIfPaired()
            throw PairingFailedException(e.message ?: "暂时无法读取配对信息")
        }
        val routeId = routeIdOf(offer.pcPublicKey)
        _state.value = ConnectionState.Connecting
        val outcome = connectOnce(
            null, offer.lanAddresses, offer.lanPort, offer.relayUrl, offer.relayToken, routeId,
            { startPair(it, offer, name, identity) }, pair = true,
        )
        closeAll()
        if (outcome !is Outcome.Paired) {
            // 原来已配对（例如重新配对失败）就恢复原连接，不能停在未连接
            resumeIfPaired()
            val message = (outcome as? Outcome.Ended)?.message ?: "电脑拒绝了配对"
            val reason = reasonCategory(message)
            Diag.write(
                LogLevel.WARN, "remote", "pair.failed", mapOf("reason" to reason),
                DiagEvent("error", "remote.pair", mapOf("reason" to reason)),
            )
            throw PairingFailedException(message)
        }
        try {
            savePairing(offer, routeId, identity)
        } catch (e: StoreUnavailableException) {
            resumeIfPaired()
            throw PairingFailedException(e.message ?: "暂时无法保存配对信息")
        }
        Diag.write(LogLevel.INFO, "remote", "pair.ok")
        start()
    }

    private fun savePairing(offer: PairingOffer, routeId: String, identity: KeyPair) {
        store.save(
            Pairing(
                pcName = offer.pcName,
                pcPublicKey = offer.pcPublicKey,
                routeId = routeId,
                relayUrl = offer.relayUrl,
                relayToken = offer.relayToken,
                lanAddresses = offer.lanAddresses,
                lanPort = offer.lanPort,
                deviceId = deviceIdOf(identity.publicKey),
            ),
        )
    }

    private fun resumeIfPaired() {
        _state.value = ConnectionState.Idle
        start()
    }
}

/** 断线原因归成固定枚举，避免把自由文本写进事件 */
private fun reasonCategory(message: String): String = when {
    message.contains("超时") -> "timeout"
    message.contains("没有可用") -> "no_route"
    message.contains("另一条") -> "other_route"
    message.contains("电脑不在线") -> "pc_offline"
    message.contains("网络") -> "network"
    else -> "closed"
}
