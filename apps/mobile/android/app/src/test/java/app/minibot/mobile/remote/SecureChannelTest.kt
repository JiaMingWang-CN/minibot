package app.minibot.mobile.remote

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SecureChannelTest {
    private fun channels(): Triple<SecureChannel, SecureChannel, Pair<MemoryCarrier, MemoryCarrier>> {
        val a = Noise.generateKeyPair()
        val b = Noise.generateKeyPair()
        val init = Handshake(NoisePattern.KK, true, a, rs = b.publicKey)
        val resp = Handshake(NoisePattern.KK, false, b, rs = a.publicKey)
        resp.readMessage(init.writeMessage(ByteArray(0)))
        init.readMessage(resp.writeMessage(ByteArray(0)))
        val (is_, ir) = init.split()
        val (rs, rr) = resp.split()
        val carriers = memoryPair()
        return Triple(SecureChannel(carriers.first, is_, ir), SecureChannel(carriers.second, rs, rr), carriers)
    }

    @Test
    fun largeMessage30MbDeliveredWithFramesWithin65536() {
        val (sender, receiver, carriers) = channels()
        val got = mutableListOf<JSONObject>()
        receiver.onMessage = { got.add(it) }
        val text = "y".repeat(30 * 1024 * 1024)
        sender.send(JSONObject().put("text", text))
        assertEquals(1, got.size)
        assertEquals(text.length, got[0].getString("text").length)
        assertTrue(carriers.first.sent.size > 400)
        assertTrue(carriers.first.sent.all { it.size <= 65536 })
    }

    @Test
    fun tamperedByteClosesChannel() {
        val (sender, receiver, carriers) = channels()
        var closed = false
        receiver.onClose = { closed = true }
        receiver.onMessage = { error("不该收到消息") }
        // 先截下帧，翻转后再投递
        val (a, b) = carriers
        a.peer = null
        sender.send(JSONObject().put("t", "x"))
        val frame = a.sent[0].copyOf()
        frame[frame.size - 1] = (frame[frame.size - 1].toInt() xor 1).toByte()
        b.onFrame(frame)
        assertTrue(closed)
        assertTrue(b.closed)
    }

    @Test
    fun shortMessageRoundTrip() {
        val (sender, receiver, _) = channels()
        val got = mutableListOf<JSONObject>()
        receiver.onMessage = { got.add(it) }
        sender.send(JSONObject().put("t", "ping").put("n", 1))
        assertEquals("ping", got.single().getString("t"))
    }

    /** 模拟 OkHttp：已交出但未发出的字节计入积压，后台线程按速度"发出" */
    private class SlowCarrier : Carrier {
        override var onOpen: () -> Unit = {}
        override var onPeer: (Boolean) -> Unit = {}
        override var onFrame: (ByteArray) -> Unit = {}
        override var onClose: (CloseReason) -> Unit = {}
        val backlog = java.util.concurrent.atomic.AtomicLong()
        var maxBacklog = 0L
        var frames = 0
        override fun send(frame: ByteArray) {
            frames++
            maxBacklog = maxOf(maxBacklog, backlog.addAndGet(frame.size.toLong()))
        }
        override fun close() {}
        override fun bufferedAmount(): Long = backlog.get()
    }

    private fun kkCiphers(): Pair<CipherState, CipherState> {
        val a = Noise.generateKeyPair()
        val b = Noise.generateKeyPair()
        val init = Handshake(NoisePattern.KK, true, a, rs = b.publicKey)
        val resp = Handshake(NoisePattern.KK, false, b, rs = a.publicKey)
        resp.readMessage(init.writeMessage(ByteArray(0)))
        init.readMessage(resp.writeMessage(ByteArray(0)))
        return init.split()
    }

    @Test
    fun largeSendWaitsForBacklogToDrain() {
        val carrier = SlowCarrier()
        val (send, recv) = kkCiphers()
        val channel = SecureChannel(carrier, send, recv)
        val drainer = Thread {
            while (!Thread.currentThread().isInterrupted) {
                carrier.backlog.updateAndGet { maxOf(0, it - 1024 * 1024) }
                try { Thread.sleep(5) } catch (e: InterruptedException) { return@Thread }
            }
        }
        drainer.start()
        channel.send(JSONObject().put("text", "z".repeat(27 * 1024 * 1024)))
        drainer.interrupt()
        // 积压始终不超过水位加一帧，远低于 OkHttp 的 16 MiB 上限
        assertTrue(carrier.maxBacklog <= SEND_HIGH_WATER_BYTES + 65536)
        assertTrue(carrier.frames > 400)
    }

    @Test
    fun stalledCarrierClosesChannel() {
        val carrier = SlowCarrier()
        carrier.backlog.set(SEND_HIGH_WATER_BYTES + 1)
        val (send, recv) = kkCiphers()
        val channel = SecureChannel(carrier, send, recv, stallTimeoutMs = 50)
        var closed = false
        channel.onClose = { closed = true }
        channel.send(JSONObject().put("t", "x"))
        assertTrue(closed)
        assertEquals(0, carrier.frames)
    }
}
