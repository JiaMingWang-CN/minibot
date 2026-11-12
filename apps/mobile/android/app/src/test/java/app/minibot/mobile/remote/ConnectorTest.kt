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
    )

    /** 电脑一端：把手机发来的帧当作电脑网关来应答 */
    private inner class PcEnd(private val phoneEnd: ScriptedCarrier) : Carrier {
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
            channel.send(JSONObject().put("t", "ready").put("pcName", "测试电脑"))
        }
    }

    private inner class ScriptedCarrier(val script: Script, scope: CoroutineScope, val isRelay: Boolean) : Carrier {
        override var onOpen: () -> Unit = {}
        override var onPeer: (Boolean) -> Unit = {}
        override var onFrame: (ByteArray) -> Unit = {}
        override var onClose: (CloseReason) -> Unit = {}
        var closed = false
        private val pcEnd = PcEnd(this)

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
    ) : CarrierFactory {
        var lanCreated = 0
        var relayCreated = 0
        val relayTimes = mutableListOf<Long>()
        var now: () -> Long = { 0 }

        override fun lan(address: String, port: Int): Carrier {
            lanCreated++
            return ScriptedCarrier(lan ?: Script(null), scope, false)
        }

        override fun relay(url: String, routeId: String, token: String?): Carrier {
            relayCreated++
            relayTimes.add(now())
            return ScriptedCarrier(relay ?: Script(null), scope, true)
        }
    }

    private fun TestScope.connector(p: Pairing, factory: Factory): Connector {
        factory.now = { currentTime }
        return Connector(backgroundScope, MemoryPairingStore(p, phone), factory)
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
    fun closedDuringHandshakeIsRevokedAndStopsRetrying() = runTest {
        val factory = Factory(backgroundScope, relay = Script(0, Behavior.REJECT))
        val c = connector(pairing(relay = "wss://r/v1"), factory)
        c.start()
        advanceTimeBy(1000)
        assertEquals(ConnectionState.Revoked, c.state.value)
        val created = factory.relayCreated
        advanceTimeBy(120_000)
        assertEquals(created, factory.relayCreated)
        assertEquals(ConnectionState.Revoked, c.state.value)
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
