package app.minibot.mobile.remote

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NoiseTest {
    private fun pairOf(priv: String) = Noise.keyPairOf(hexToBytes(priv))

    private fun runVector(v: JSONObject, pattern: NoisePattern, handshakeMessages: Int) {
        val init = Handshake(
            pattern, true, pairOf(v.getString("init_static")),
            rs = v.optString("init_remote_static").takeIf { it.isNotEmpty() }?.let(::hexToBytes),
            psk = v.optJSONArray("init_psks")?.getString(0)?.let(::hexToBytes),
            e = pairOf(v.getString("init_ephemeral")),
            prologue = hexToBytes(v.getString("init_prologue")),
        )
        val resp = Handshake(
            pattern, false, pairOf(v.getString("resp_static")),
            rs = v.optString("resp_remote_static").takeIf { it.isNotEmpty() }?.let(::hexToBytes),
            psk = v.optJSONArray("resp_psks")?.getString(0)?.let(::hexToBytes),
            e = pairOf(v.getString("resp_ephemeral")),
            prologue = hexToBytes(v.getString("resp_prologue")),
        )
        val messages = v.getJSONArray("messages")
        for (i in 0 until handshakeMessages) {
            val (writer, reader) = if (i % 2 == 0) init to resp else resp to init
            val msg = messages.getJSONObject(i)
            val out = writer.writeMessage(hexToBytes(msg.getString("payload")))
            assertEquals("握手消息 $i", msg.getString("ciphertext"), out.toHex())
            assertEquals(msg.getString("payload"), reader.readMessage(out).toHex())
        }
        assertTrue(init.isComplete() && resp.isComplete())
        assertEquals(v.getString("handshake_hash"), init.handshakeHash().toHex())
        assertEquals(v.getString("handshake_hash"), resp.handshakeHash().toHex())

        val (aSend, aRecv) = init.split()
        val (bSend, bRecv) = resp.split()
        for (i in handshakeMessages until messages.length()) {
            val msg = messages.getJSONObject(i)
            val (sender, receiver) = if (i % 2 == 0) aSend to bRecv else bSend to aRecv
            val out = sender.encrypt(hexToBytes(msg.getString("payload")))
            assertEquals("传输消息 $i", msg.getString("ciphertext"), out.toHex())
            assertEquals(msg.getString("payload"), receiver.decrypt(out).toHex())
        }
    }

    private fun vectors(): JSONArray = fixture("noise-vectors.json").getJSONArray("vectors")

    private fun vector(name: String): JSONObject =
        (0 until vectors().length()).map { vectors().getJSONObject(it) }.first { it.getString("protocol_name") == name }

    @Test
    fun officialVectorXXpsk3() = runVector(vector("Noise_XXpsk3_25519_ChaChaPoly_SHA256"), NoisePattern.XXpsk3, 3)

    @Test
    fun officialVectorKK() = runVector(vector("Noise_KK_25519_ChaChaPoly_SHA256"), NoisePattern.KK, 2)

    @Test
    fun interopPlaysPhoneWithFixtureKeys() {
        val f = fixture("remote-interop.json")
        val pairing = f.getJSONObject("pairing")
        val phoneKeys = pairing.getJSONObject("phone")
        val frames = pairing.getJSONArray("frames")

        val hs = Handshake(
            NoisePattern.XXpsk3, true, pairOf(phoneKeys.getString("s")),
            psk = hexToBytes(pairing.getString("psk")), e = pairOf(phoneKeys.getString("e")),
        )
        assertEquals(frames.getString(0), (byteArrayOf(FRAME_PAIR) + hs.writeMessage(ByteArray(0))).toHex())
        val payload = hs.readMessage(hexToBytes(frames.getString(1)).copyOfRange(1, hexToBytes(frames.getString(1)).size))
        assertEquals(pairing.getString("pcPayload"), payload.toHex())
        val msg3 = byteArrayOf(FRAME_PAIR) + hs.writeMessage(hexToBytes(pairing.getString("phonePayload")))
        assertEquals(frames.getString(2), msg3.toHex())

        val kk = f.getJSONObject("kk")
        val kkFrames = kk.getJSONArray("frames")
        val kkKeys = kk.getJSONObject("phone")
        val pcPublic = Noise.keyPairOf(hexToBytes(kk.getJSONObject("pc").getString("s"))).publicKey
        val phone = Handshake(
            NoisePattern.KK, true, pairOf(kkKeys.getString("s")), rs = pcPublic, e = pairOf(kkKeys.getString("e")),
        )
        val first = byteArrayOf(FRAME_KK) + hexToBytes(kk.getString("deviceId")) + phone.writeMessage(ByteArray(0))
        assertEquals(kkFrames.getString(0), first.toHex())
        val reply = hexToBytes(kkFrames.getString(1))
        phone.readMessage(reply.copyOfRange(1, reply.size))
        assertTrue(phone.isComplete())

        // 信道：JSON 序列化的键序 / 数字写法各语言不同，所以不比字节，改比解出来的消息：
        // 手机发出的帧能被电脑一端（夹具里的电脑密钥）解开，夹具里手机方向的帧也能解开，且两者消息一致
        val (send, recv) = phone.split()
        val channelFixture = f.getJSONObject("channel")
        val pcKeys = kk.getJSONObject("pc")
        val pc = Handshake(
            NoisePattern.KK, false, pairOf(pcKeys.getString("s")), rs = pairOf(kkKeys.getString("s")).publicKey,
            e = pairOf(pcKeys.getString("e")),
        )
        pc.readMessage(hexToBytes(kkFrames.getString(0)).copyOfRange(17, hexToBytes(kkFrames.getString(0)).size))
        assertEquals(kkFrames.getString(1), (byteArrayOf(FRAME_KK) + pc.writeMessage(ByteArray(0))).toHex())
        val (pcSend, pcRecv) = pc.split()

        fun decode(frames: List<ByteArray>, cipherSend: CipherState, cipherRecv: CipherState): List<JSONObject> {
            val (carrier, _) = memoryPair()
            val channel = SecureChannel(carrier, cipherSend, cipherRecv)
            val got = mutableListOf<JSONObject>()
            channel.onMessage = { got.add(it) }
            frames.forEach { carrier.onFrame(it) }
            return got
        }

        val phoneMessages = channelFixture.getJSONArray("phoneMessages")
        val (outCarrier, _) = memoryPair()
        val outChannel = SecureChannel(outCarrier, send, recv)
        for (i in 0 until phoneMessages.length()) outChannel.send(phoneMessages.getJSONObject(i))
        val fromKotlin = decode(outCarrier.sent, pcSend, pcRecv)
        assertEquals(phoneMessages.length(), fromKotlin.size)
        for (i in fromKotlin.indices) assertTrue("手机消息 $i", fromKotlin[i].similar(phoneMessages.getJSONObject(i)))

        // 夹具里电脑发的帧，手机能解开（用新的手机侧状态，nonce 从 0 开始）
        val phone2 = Handshake(NoisePattern.KK, true, pairOf(kkKeys.getString("s")), rs = pcPublic, e = pairOf(kkKeys.getString("e")))
        phone2.writeMessage(ByteArray(0))
        phone2.readMessage(reply.copyOfRange(1, reply.size))
        val (send2, recv2) = phone2.split()
        val pcFrames = channelFixture.getJSONArray("frames")
        val got = decode(List(pcFrames.length()) { hexToBytes(pcFrames.getString(it)) }, send2, recv2)
        val pcMessages = channelFixture.getJSONArray("messages")
        assertEquals(pcMessages.length(), got.size)
        for (i in got.indices) assertTrue("电脑消息 $i", got[i].similar(pcMessages.getJSONObject(i)))
    }

    @Test
    fun wrongPskFailsThirdMessage() {
        val a = Noise.generateKeyPair()
        val b = Noise.generateKeyPair()
        val init = Handshake(NoisePattern.XXpsk3, true, a, psk = ByteArray(32) { 1 })
        val resp = Handshake(NoisePattern.XXpsk3, false, b, psk = ByteArray(32) { 2 })
        resp.readMessage(init.writeMessage(ByteArray(0)))
        init.readMessage(resp.writeMessage(ByteArray(0)))
        val third = init.writeMessage(ByteArray(0))
        try {
            resp.readMessage(third)
            error("应当失败")
        } catch (e: NoiseException) {
            assertArrayEquals(ByteArray(0), ByteArray(0))
        }
    }
}
