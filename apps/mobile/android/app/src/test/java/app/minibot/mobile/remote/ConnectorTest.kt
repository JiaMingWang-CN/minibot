package app.minibot.mobile.remote

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectorTest {
    private val pc = Noise.generateKeyPair()
    private val phone = Noise.generateKeyPair()

    private fun pairing(lan: List<String> = emptyList(), relay: String? = null) = Pairing(
        pcName = "测试电脑",
        pcPublicKey = pc.publicKey,
        routeId = routeIdOf(pc.publicKey),
        relayUrl = relay,
        relayToken = relay?.let { "tok" },
        lanAddresses = lan,
        lanPort = 4590,
        deviceId = deviceIdOf(phone.publicKey),
    )

    private enum class Behavior { PC_OK, REJECT, FAIL }

    /** 脚本化承载：openAfterMs 为 null 表示永远打不开；peer 事件按时间点触发 */
    private class Script(
        val openAfterMs: Long?,
        val behavior: Behavior = Behavior.PC_OK,
        val peerEvents: List<Pair<Long, Boolean>> = emptyList(),
        val startOnline: Boolean = true,
        /** 电脑 ready 消息里额外带的字段（lan / port） */
        val readyExtra: Map<String, Any> = emptyMap(),
        /** 电脑 ready 之后紧接着发的 version；为 null 表示旧版电脑（不发版本） */
        val pcVersion: Map<String, Any>? = null,
    )

    /** 电脑一端：把手机发来的帧当作电脑网关来应答 */
    private inner class PcEnd(private val phoneEnd: ScriptedCarrier) : Carrier {
        val received = mutableListOf<JSONObject>()
        override var onOpen: () -> Unit = {}
        override var onPeer: (Boolean) -> Unit = {}
        override var onFrame: (ByteArray) -> Unit = {}
        override var onClose: (CloseReason) -> Unit = {}
        override fun send(frame: ByteArray) = phoneEnd.onFrame(frame)
        override fun close() {}

        fun accept(frame: ByteArray) {
            if (frame[0] != FRAME_KK) return
            val hs = Handshake(NoisePattern.KK, false, pc, rs = phone.publicKey)
            hs.readMessage(frame.copyOfRange(17, frame.size))
            phoneEnd.onFrame(byteArrayOf(FRAME_KK) + hs.writeMessage(ByteArray(0)))
            val (send, recv) = hs.split()
            val channel = SecureChannel(this, send, recv)
            channel.onMessage = { received.add(it) }
            val ready = JSONObject().put("t", "ready").put("pcName", "测试电脑")
            for ((key, value) in phoneEnd.script.readyExtra) ready.put(key, value)
            channel.send(ready)
            phoneEnd.script.pcVersion?.let { extra ->
                val version = JSONObject().put("t", "version")
                for ((key, value) in extra) version.put(key, value)
                channel.send(version)
            }
        }
    }

    private inner class ScriptedCarrier(val script: Script, scope: CoroutineScope, val isRelay: Boolean) : Carrier {
        override var onOpen: () -> Unit = {}
        override var onPeer: (Boolean) -> Unit = {}
        override var onFrame: (ByteArray) -> Unit = {}
        override var onClose: (CloseReason) -> Unit = {}
        var closed = false
        val pcEnd = PcEnd(this)

        init {
            val open = script.openAfterMs
            if (open != null) {
                scope.launch {
                    delay(open)
                    if (script.behavior == Behavior.FAIL) {
                        onClose(CloseReason.Network("连不上"))
                        return@launch
                    }
                    onOpen()
                    if (isRelay) {
                        onPeer(script.startOnline)
                        var last = 0L
                        for ((at, online) in script.peerEvents) {
                            delay(at - last)
                            last = at
                            onPeer(online)
                        }
                    }
                }
            }
        }

        override fun send(frame: ByteArray) {
            if (closed) return
            when (script.behavior) {
                Behavior.REJECT -> onClose(CloseReason.Normal)
                else -> if (frame[0] == FRAME_KK && frame.size > 17) pcEnd.accept(frame) else pcEnd.onFrame(frame)
            }
        }

        override fun close() {
            closed = true
        }
    }

    private inner class Factory(
        private val scope: CoroutineScope,
        private val lan: Script? = null,
        private val relay: Script? = null,
        /** 依次用于每次新建的中继承载，用完后重复最后一个；为空时用 relay */
        private val relaySeq: List<Script> = emptyList(),
    ) : CarrierFactory {
        val lanCarriers = mutableListOf<ScriptedCarrier>()
        val relayCarriers = mutableListOf<ScriptedCarrier>()
        var lanCreated = 0
        var relayCreated = 0
        val relayTimes = mutableListOf<Long>()
        var now: () -> Long = { 0 }

        override fun lan(address: String, port: Int): Carrier {
            lanCreated++
            return ScriptedCarrier(lan ?: Script(null), scope, false).also { lanCarriers.add(it) }
        }

        override fun relay(url: String, routeId: String, token: String?): Carrier {
            relayCreated++
            relayTimes.add(now())
            val script = if (relaySeq.isEmpty()) relay ?: Script(null) else relaySeq[minOf(relayCreated - 1, relaySeq.size - 1)]
            return ScriptedCarrier(script, scope, true).also { relayCarriers.add(it) }
        }
    }

    private fun TestScope.connector(p: Pairing, factory: Factory, store: MemoryPairingStore = MemoryPairingStore(p, phone)): Connector {
        factory.now = { currentTime }
        return Connector(backgroundScope, store, factory)
    }

    @Test
    fun lanFirstDoesNotTouchRelay() = runTest {
        val factory = Factory(backgroundScope, lan = Script(200), relay = Script(0))
        val c = connector(pairing(lan = listOf("192.168.1.5"), relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(300)
        assertEquals(ConnectionState.Connected(Via.LAN, "测试电脑"), c.state.value)
        assertEquals(0, factory.relayCreated)
    }

    @Test
    fun lanTimeoutFallsBackToRelay() = runTest {
        val factory = Factory(backgroundScope, lan = Script(null), relay = Script(0))
        val c = connector(pairing(lan = listOf("192.168.1.5"), relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(2000)
        assertEquals(ConnectionState.Connected(Via.RELAY, "测试电脑"), c.state.value)
    }

    @Test
    fun pcOfflineThenOnlineRehandshakesOnSameRelay() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0, peerEvents = listOf(1000L to false, 5000L to true)))
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(100)
        assertEquals(ConnectionState.Connected(Via.RELAY, "测试电脑"), c.state.value)
        advanceTimeBy(1500)
        assertEquals(ConnectionState.PcOffline, c.state.value)
        advanceTimeBy(4000)
        assertEquals(ConnectionState.Connected(Via.RELAY, "测试电脑"), c.state.value)
        assertEquals(1, factory.relayCreated)
    }

    @Test
    fun pcOfflineFromStart() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0, peerEvents = listOf(3000L to true), startOnline = false))
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(1000)
        assertEquals(ConnectionState.PcOffline, c.state.value)
        advanceTimeBy(3000)
        assertEquals(ConnectionState.Connected(Via.RELAY, "测试电脑"), c.state.value)
    }

    @Test
    fun closedDuringHandshakeIsRevokedClearsPairingAndStopsRetrying() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0, Behavior.REJECT))
        val store = MemoryPairingStore(pairing(relay = "wss://r/v1"), phone)
        val c = connector(pairing(relay = "wss://r/v1"), factory, store)
        c.start()
        advanceTimeBy(10_000)
        assertEquals(ConnectionState.Revoked, c.state.value)
        assertEquals(REVOKE_AFTER_REJECTIONS, factory.relayCreated)
        assertNull(store.load())
        advanceTimeBy(120_000)
        assertEquals(REVOKE_AFTER_REJECTIONS, factory.relayCreated)
        assertEquals(ConnectionState.Revoked, c.state.value)
    }

    @Test
    fun singleRejectionIsNotRevocation() = runTest {
        val factory = Factory(backgroundScope, relaySeq = listOf(Script(0, Behavior.REJECT), Script(0)))
        val store = MemoryPairingStore(pairing(relay = "wss://r/v1"), phone)
        val c = connector(pairing(relay = "wss://r/v1"), factory, store)
        c.start()
        advanceTimeBy(5_000)
        assertEquals(ConnectionState.Connected(Via.RELAY, "测试电脑"), c.state.value)
        assertTrue(store.load() != null)
    }

    @Test
    fun twoLanAddressesBothReachablePicksOneLiveChannel() = runTest {
        val factory = Factory(backgroundScope, lan = Script(100))
        val c = connector(pairing(lan = listOf("192.168.1.5", "10.0.0.5")), factory)
        c.start()
        advanceTimeBy(500)
        assertEquals(ConnectionState.Connected(Via.LAN, "测试电脑"), c.state.value)
        c.send(JSONObject().put("t", "req").put("id", "1"))
        // 消息必须落到仍然打开的那条承载上，而不是被关掉的落选者
        val live = factory.lanCarriers.filter { !it.closed }
        assertEquals(1, live.size)
        assertEquals("1", live.single().pcEnd.received.first { it.optString("t") == "req" }.getString("id"))
    }

    @Test
    fun relayFailuresBackOff1To60Seconds() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0, Behavior.FAIL))
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(200_000)
        val gaps = factory.relayTimes.zipWithNext { a, b -> (b - a) / 1000 }.take(7)
        assertEquals(listOf(1L, 2L, 4L, 8L, 16L, 32L, 60L), gaps)
    }

    @Test
    fun readyRightAfterHandshakeIsNotLost() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0))
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        val got = mutableListOf<JSONObject>()
        c.onMessage = { got.add(it) }
        c.start()
        advanceTimeBy(100)
        // PcEnd 在握手完成后立刻发了 ready：与握手最后一帧几乎同时到达，不能丢
        assertEquals("ready", got.single().getString("t"))
    }

    @Test
    fun sendsVersionAfterReady() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0))
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(200)
        val received = factory.relayCarriers.single().pcEnd.received
        val version = received.first { it.optString("t") == "version" }
        assertEquals(REMOTE_PROTOCOL, version.getInt("protocol"))
        assertEquals(MIN_PC_PROTOCOL, version.getInt("minPeer"))
    }

    @Test
    fun pcOutdated() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0, pcVersion = mapOf("app" to "0.0.9", "protocol" to 0, "minPeer" to 1)))
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(200)
        assertEquals("pc_outdated", c.compat)
    }

    @Test
    fun phoneOutdated() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0, pcVersion = mapOf("app" to "0.2.0", "protocol" to 1, "minPeer" to 2)))
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(200)
        assertEquals("phone_outdated", c.compat)
    }

    @Test
    fun rehandshakeOnSameRelayKeepsNewVersionResult() = runTest {
        // 中继上电脑下线再上线：同一承载上重新握手，version 紧跟 ready 到达，结果不能被重置回 unknown
        val factory = Factory(
            backgroundScope,
            relay = Script(0, peerEvents = listOf(1000L to false, 5000L to true), pcVersion = mapOf("app" to "0.2.0", "protocol" to 1, "minPeer" to 2)),
        )
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(200)
        assertEquals("phone_outdated", c.compat)
        advanceTimeBy(5500)
        assertEquals(ConnectionState.Connected(Via.RELAY, "测试电脑"), c.state.value)
        assertEquals("phone_outdated", c.compat)
    }

    @Test
    fun nonNumericVersionFieldsAreIgnored() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0, pcVersion = mapOf("app" to "0.2.0", "protocol" to "x", "minPeer" to 1)))
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(200)
        assertEquals("unknown", c.compat)
    }

    @Test
    fun compatibleVersionIsOk() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0, pcVersion = mapOf("app" to "0.2.0", "protocol" to 1, "minPeer" to 1)))
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(200)
        assertEquals("ok", c.compat)
    }

    @Test
    fun readyWithNewAddressUpdatesSavedPairing() = runTest {
        val extra = mapOf("lan" to org.json.JSONArray(listOf("192.168.9.9")), "port" to 4591)
        val factory = Factory(backgroundScope, relay = Script(0, readyExtra = extra))
        val store = MemoryPairingStore(pairing(lan = listOf("192.168.1.5"), relay = "wss://r/v1"), phone)
        val c = connector(pairing(), factory, store)
        c.start()
        advanceTimeBy(2000)
        assertEquals(listOf("192.168.9.9"), store.load()!!.lanAddresses)
        assertEquals(4591, store.load()!!.lanPort)
    }

    @Test
    fun readyWithoutOrWithEmptyAddressKeepsSavedPairing() = runTest {
        for (extra in listOf(emptyMap(), mapOf("lan" to org.json.JSONArray(), "port" to 4591))) {
            val factory = Factory(backgroundScope, relay = Script(0, readyExtra = extra))
            val store = MemoryPairingStore(pairing(lan = listOf("192.168.1.5"), relay = "wss://r/v1"), phone)
            val c = connector(pairing(), factory, store)
            c.start()
            advanceTimeBy(2000)
            assertEquals(listOf("192.168.1.5"), store.load()!!.lanAddresses)
            c.stop()
        }
    }

    /** 一台电脑、一次配对邀请：第一条有效的第三条握手消息作废邀请，之后的一律正常关闭（同电脑端网关） */
    private inner class SharedPc(val psk: ByteArray) {
        var offerValid = true
        val pairedOn = mutableListOf<PairLink>()
    }

    /** 通到 SharedPc 的一条局域网承载；up 是手机发出的第 i 帧到达电脑的延迟，down 是电脑到手机的延迟 */
    private inner class PairLink(
        private val pc: SharedPc,
        private val scope: CoroutineScope,
        private val up: List<Long>,
        private val down: Long,
    ) : Carrier {
        override var onOpen: () -> Unit = {}
        override var onPeer: (Boolean) -> Unit = {}
        override var onFrame: (ByteArray) -> Unit = {}
        override var onClose: (CloseReason) -> Unit = {}
        private var closed = false
        private var sent = 0
        private var hs: Handshake? = null
        private var pcChannel: SecureChannel? = null
        private val pcSide = object : Carrier {
            override var onOpen: () -> Unit = {}
            override var onPeer: (Boolean) -> Unit = {}
            override var onFrame: (ByteArray) -> Unit = {}
            override var onClose: (CloseReason) -> Unit = {}
            override fun send(frame: ByteArray) = toPhone(frame)
            override fun close() {}
        }

        init {
            scope.launch { onOpen() }
        }

        private fun toPhone(frame: ByteArray) {
            scope.launch {
                delay(down)
                if (!closed) onFrame(frame)
            }
        }

        override fun send(frame: ByteArray) {
            if (closed) return
            val wait = up[minOf(sent++, up.size - 1)]
            // 已经发出去的帧照样到达电脑，之后手机再关连接也撤不回
            scope.launch {
                delay(wait)
                atPc(frame)
            }
        }

        private fun atPc(frame: ByteArray) {
            if (pcChannel != null) return pcSide.onFrame(frame)
            val current = hs
            if (current == null) {
                val h = Handshake(NoisePattern.XXpsk3, false, this@ConnectorTest.pc, psk = pc.psk)
                hs = h
                h.readMessage(frame.copyOfRange(1, frame.size))
                toPhone(byteArrayOf(FRAME_PAIR) + h.writeMessage(ByteArray(0)))
                return
            }
            if (!pc.offerValid) {
                scope.launch {
                    delay(down)
                    closed = true
                    onClose(CloseReason.Normal)
                }
                return
            }
            current.readMessage(frame.copyOfRange(1, frame.size))
            pc.offerValid = false
            pc.pairedOn.add(this)
            val (send, recv) = current.split()
            val channel = SecureChannel(pcSide, send, recv)
            pcChannel = channel
            channel.send(JSONObject().put("t", "paired"))
            channel.send(JSONObject().put("t", "ready").put("pcName", "测试电脑"))
        }

        override fun close() {
            closed = true
        }
    }

    @Test
    fun pairingOverTwoLanPathsToSamePcUsesTheClaimedPath() = runTest {
        val psk = Noise.generateKeyPair().privateKey
        val shared = SharedPc(psk)
        // 两条线路的第二条握手消息同时到：A 先被手机选中，但 A 的上行慢，B 的第三条消息先到电脑
        val links = listOf(
            PairLink(shared, backgroundScope, up = listOf(0, 50), down = 1),
            PairLink(shared, backgroundScope, up = listOf(0, 0), down = 1),
        )
        var next = 0
        val factory = object : CarrierFactory {
            // 配对之后转入日常连接：后续承载永远打不开即可
            override fun lan(address: String, port: Int): Carrier =
                links.getOrNull(next++) ?: ScriptedCarrier(Script(null), backgroundScope, false)
            override fun relay(url: String, routeId: String, token: String?): Carrier = error("不应走中继")
        }
        val store = MemoryPairingStore(null, phone)
        val c = Connector(backgroundScope, store, factory)
        val offer = PairingOffer("测试电脑", pc.publicKey, psk, null, null, listOf("198.18.0.1", "192.168.1.5"), 4590)
        // 失败时抛 PairingFailedException（修复前："连接已关闭"）
        c.pair(offer, "测试手机")
        assertTrue(store.load() != null)
        assertEquals(1, shared.pairedOn.size)
        c.stop()
    }

    @Test
    fun stopReturnsToIdle() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0))
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(100)
        c.stop()
        advanceUntilIdle()
        assertTrue(c.state.value == ConnectionState.Idle)
    }
}
