package app.minibot.mobile.remote

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

const val HANDSHAKE_TIMEOUT_MS = 10_000L
const val LAN_RACE_MS = 1_500L
val BACKOFF_SECONDS = longArrayOf(1, 2, 4, 8, 16, 32, 60)

private sealed interface Ev {
    object Opened : Ev
    data class Peer(val online: Boolean) : Ev
    data class Closed(val reason: CloseReason) : Ev
    object Ready : Ev
    object Paired : Ev
    object Kick : Ev
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

    @Volatile private var activeChannel: SecureChannel? = null
    private val links = CopyOnWriteArrayList<Link>()
    private val kick = Channel<Unit>(Channel.CONFLATED)
    private var job: Job? = null

    fun start() {
        if (job?.isActive == true) return
        if (store.load() == null) return
        job = scope.launch { loop() }
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
        while (true) {
            val pairing = store.load() ?: run { _state.value = ConnectionState.Idle; return }
            val identity = store.identity()
            _state.value = ConnectionState.Connecting
            val start: (Link) -> Unit = { startKk(it, pairing, identity) }
            val outcome = connectOnce(pairing, pairing.lanAddresses, pairing.lanPort, pairing.relayUrl, pairing.relayToken, pairing.routeId, start, pair = false)
            activeChannel = null
            if (outcome is Outcome.Revoked) {
                _state.value = ConnectionState.Revoked
                return
            }
            if (outcome is Outcome.Ended && outcome.connected) attempt = 0
            _state.value = ConnectionState.Connecting
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
            return drive(link, start, pair, pcName) {}
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

    /** 单条承载的状态机：打开 → 等电脑在线 → 握手 → 连通，中继上电脑下线再上线会在同一承载上重新握手 */
    private suspend fun drive(link: Link, start: (Link) -> Unit, pair: Boolean, pcName: String, onConnected: () -> Unit): Outcome {
        var phase = Phase.OPEN
        var connectedOnce = false
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
                    if (pair) {
                        phase = Phase.PAIRED
                    } else {
                        phase = Phase.CONNECTED
                        connectedOnce = true
                        activeChannel = link.channel
                        _state.value = ConnectionState.Connected(link.via, pcName)
                        onConnected()
                    }
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

    private fun finishHandshake(link: Link, hs: Handshake) {
        val (send, recv) = hs.split()
        val channel = SecureChannel(link.carrier, send, recv)
        link.channel = channel
        channel.onClose = { link.events.trySend(Ev.Closed(CloseReason.Network("信道已关闭"))) }
        channel.onMessage = { message ->
            if (message.optString("t") == "paired") link.events.trySend(Ev.Paired)
            else onMessage(message)
        }
        link.events.trySend(Ev.Ready)
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
                val hello = JSONObject().put("deviceName", deviceName).toString().toByteArray(Charsets.UTF_8)
                link.carrier.send(byteArrayOf(FRAME_PAIR) + hs.writeMessage(hello))
                finishHandshake(link, hs)
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
        stop()
        val identity = store.identity()
        val routeId = routeIdOf(offer.pcPublicKey)
        _state.value = ConnectionState.Connecting
        val outcome = connectOnce(
            null, offer.lanAddresses, offer.lanPort, offer.relayUrl, offer.relayToken, routeId,
            { startPair(it, offer, name, identity) }, pair = true,
        )
        closeAll()
        if (outcome !is Outcome.Paired) {
            _state.value = ConnectionState.Idle
            val reason = (outcome as? Outcome.Ended)?.message ?: "电脑拒绝了配对"
            throw PairingFailedException("配对失败：$reason")
        }
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
        start()
    }
}
