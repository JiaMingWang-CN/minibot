package app.minibot.mobile.remote

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters

// Noise_XXpsk3_25519_ChaChaPoly_SHA256（配对）与 Noise_KK_25519_ChaChaPoly_SHA256（日常），
// 与 packages/core/src/remote/noise.ts 逐条对应。

class KeyPair(val privateKey: ByteArray, val publicKey: ByteArray)

enum class NoisePattern { XXpsk3, KK }

interface CipherState {
    fun encrypt(plain: ByteArray): ByteArray
    fun decrypt(cipher: ByteArray): ByteArray
}

class NoiseException(message: String) : Exception(message)

object Noise {
    val PROLOGUE: ByteArray = "minibot-remote/1".toByteArray(Charsets.UTF_8)
    const val MAX_NOISE_MESSAGE = 65535
    internal const val DH_LEN = 32
    internal const val TAG_LEN = 16
    internal const val HASH_LEN = 32

    private val random = SecureRandom()

    fun generateKeyPair(): KeyPair {
        val priv = X25519PrivateKeyParameters(random)
        return KeyPair(priv.encoded, priv.generatePublicKey().encoded)
    }

    fun keyPairOf(privateKey: ByteArray): KeyPair =
        KeyPair(privateKey, X25519PrivateKeyParameters(privateKey, 0).generatePublicKey().encoded)

    internal fun dh(priv: ByteArray, pub: ByteArray): ByteArray {
        val agreement = X25519Agreement()
        agreement.init(X25519PrivateKeyParameters(priv, 0))
        val out = ByteArray(agreement.agreementSize)
        agreement.calculateAgreement(X25519PublicKeyParameters(pub, 0), out, 0)
        return out
    }

    internal fun hash(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /** Noise HKDF：输出 2 或 3 段 */
    internal fun hkdf(chainingKey: ByteArray, ikm: ByteArray, outputs: Int): List<ByteArray> {
        val temp = hmac(chainingKey, ikm)
        val out1 = hmac(temp, byteArrayOf(1))
        val out2 = hmac(temp, out1 + byteArrayOf(2))
        if (outputs == 2) return listOf(out1, out2)
        val out3 = hmac(temp, out2 + byteArrayOf(3))
        return listOf(out1, out2, out3)
    }

    internal fun nonceBytes(n: Long): ByteArray {
        val nonce = ByteArray(12)
        for (i in 0 until 8) nonce[4 + i] = (n ushr (8 * i)).toByte()
        return nonce
    }
}

internal class Cipher : CipherState {
    private var key: ByteArray? = null
    private var n = 0L

    fun initializeKey(k: ByteArray?) {
        key = k
        n = 0L
    }

    fun hasKey(): Boolean = key != null

    fun encryptWithAd(ad: ByteArray, plain: ByteArray): ByteArray {
        val k = key ?: return plain
        val aead = ChaCha20Poly1305()
        aead.init(true, AEADParameters(KeyParameter(k), Noise.TAG_LEN * 8, Noise.nonceBytes(n), ad))
        val out = ByteArray(aead.getOutputSize(plain.size))
        var len = aead.processBytes(plain, 0, plain.size, out, 0)
        len += aead.doFinal(out, len)
        n += 1
        return if (len == out.size) out else out.copyOf(len)
    }

    fun decryptWithAd(ad: ByteArray, data: ByteArray): ByteArray {
        val k = key ?: return data
        if (data.size < Noise.TAG_LEN) throw NoiseException("密文过短")
        val aead = ChaCha20Poly1305()
        aead.init(false, AEADParameters(KeyParameter(k), Noise.TAG_LEN * 8, Noise.nonceBytes(n), ad))
        val out = ByteArray(aead.getOutputSize(data.size))
        try {
            var len = aead.processBytes(data, 0, data.size, out, 0)
            len += aead.doFinal(out, len)
            n += 1
            return if (len == out.size) out else out.copyOf(len)
        } catch (e: org.bouncycastle.crypto.InvalidCipherTextException) {
            throw NoiseException("解密失败")
        }
    }

    override fun encrypt(plain: ByteArray): ByteArray {
        if (key == null) throw NoiseException("密钥未就绪")
        return encryptWithAd(ByteArray(0), plain)
    }

    override fun decrypt(cipher: ByteArray): ByteArray {
        if (key == null) throw NoiseException("密钥未就绪")
        return decryptWithAd(ByteArray(0), cipher)
    }
}

private class PatternDef(
    val name: String,
    val psk: Boolean,
    val preInitiator: Boolean,
    val preResponder: Boolean,
    val messages: List<List<String>>,
)

private val PATTERNS = mapOf(
    NoisePattern.XXpsk3 to PatternDef(
        "Noise_XXpsk3_25519_ChaChaPoly_SHA256", true, false, false,
        listOf(listOf("e"), listOf("e", "ee", "s", "es"), listOf("s", "se", "psk")),
    ),
    NoisePattern.KK to PatternDef(
        "Noise_KK_25519_ChaChaPoly_SHA256", false, true, true,
        listOf(listOf("e", "es", "ss"), listOf("e", "ee", "se")),
    ),
)

class Handshake(
    pattern: NoisePattern,
    private val initiator: Boolean,
    private val s: KeyPair,
    rs: ByteArray? = null,
    private val psk: ByteArray? = null,
    /** 仅供测试向量注入固定的临时密钥 */
    e: KeyPair? = null,
    prologue: ByteArray = Noise.PROLOGUE,
) {
    private val def = PATTERNS.getValue(pattern)
    private var rs: ByteArray? = rs
    private var e: KeyPair? = e
    private var re: ByteArray? = null
    private val cipher = Cipher()
    private var ck: ByteArray
    private var h: ByteArray
    private var index = 0
    private var complete = false

    init {
        if (def.psk && (psk == null || psk.size != 32)) throw NoiseException("需要 32 字节 psk")
        if ((def.preInitiator || def.preResponder) && this.rs == null) throw NoiseException("需要对方的静态公钥")
        val name = def.name.toByteArray(Charsets.UTF_8)
        h = if (name.size <= Noise.HASH_LEN) name.copyOf(Noise.HASH_LEN) else Noise.hash(name)
        ck = h
        mixHash(prologue)
        if (def.preInitiator) mixHash(if (initiator) s.publicKey else this.rs!!)
        if (def.preResponder) mixHash(if (initiator) this.rs!! else s.publicKey)
    }

    private fun mixHash(data: ByteArray) {
        h = Noise.hash(h + data)
    }

    private fun mixKey(ikm: ByteArray) {
        val (nextCk, k) = Noise.hkdf(ck, ikm, 2)
        ck = nextCk
        cipher.initializeKey(k)
    }

    private fun mixKeyAndHash(ikm: ByteArray) {
        val (nextCk, tempH, tempK) = Noise.hkdf(ck, ikm, 3)
        ck = nextCk
        mixHash(tempH)
        cipher.initializeKey(tempK)
    }

    private fun encryptAndHash(plain: ByteArray): ByteArray {
        val out = cipher.encryptWithAd(h, plain)
        mixHash(out)
        return out
    }

    private fun decryptAndHash(data: ByteArray): ByteArray {
        val out = cipher.decryptWithAd(h, data)
        mixHash(data)
        return out
    }

    private fun myTurn(): Boolean = initiator == (index % 2 == 0)

    private fun need(v: ByteArray?): ByteArray = v ?: throw NoiseException("握手状态不完整")

    private fun doDh(token: String): ByteArray {
        val ePriv = { need(e?.privateKey) }
        return when (token) {
            "ee" -> Noise.dh(ePriv(), need(re))
            "ss" -> Noise.dh(s.privateKey, need(rs))
            "es" -> if (initiator) Noise.dh(ePriv(), need(rs)) else Noise.dh(s.privateKey, need(re))
            else -> if (initiator) Noise.dh(s.privateKey, need(re)) else Noise.dh(ePriv(), need(rs))
        }
    }

    fun writeMessage(payload: ByteArray): ByteArray {
        if (complete || !myTurn()) throw NoiseException("现在不该写握手消息")
        var out = ByteArray(0)
        for (token in def.messages[index]) {
            when (token) {
                "e" -> {
                    val pair = e ?: Noise.generateKeyPair().also { e = it }
                    out += pair.publicKey
                    mixHash(pair.publicKey)
                    if (def.psk) mixKey(pair.publicKey)
                }
                "s" -> out += encryptAndHash(s.publicKey)
                "psk" -> mixKeyAndHash(psk!!)
                else -> mixKey(doDh(token))
            }
        }
        out += encryptAndHash(payload)
        if (out.size > Noise.MAX_NOISE_MESSAGE) throw NoiseException("握手消息过长")
        advance()
        return out
    }

    fun readMessage(message: ByteArray): ByteArray {
        if (complete || myTurn()) throw NoiseException("现在不该读握手消息")
        if (message.size > Noise.MAX_NOISE_MESSAGE) throw NoiseException("握手消息过长")
        var offset = 0
        fun take(n: Int): ByteArray {
            if (offset + n > message.size) throw NoiseException("握手消息过短")
            return message.copyOfRange(offset, offset + n).also { offset += n }
        }
        for (token in def.messages[index]) {
            when (token) {
                "e" -> {
                    val remote = take(Noise.DH_LEN)
                    re = remote
                    mixHash(remote)
                    if (def.psk) mixKey(remote)
                }
                "s" -> {
                    val len = if (cipher.hasKey()) Noise.DH_LEN + Noise.TAG_LEN else Noise.DH_LEN
                    rs = decryptAndHash(take(len))
                }
                "psk" -> mixKeyAndHash(psk!!)
                else -> mixKey(doDh(token))
            }
        }
        val payload = decryptAndHash(message.copyOfRange(offset, message.size))
        advance()
        return payload
    }

    private fun advance() {
        index += 1
        if (index == def.messages.size) complete = true
    }

    fun isComplete(): Boolean = complete

    fun remoteStatic(): ByteArray? = rs

    fun handshakeHash(): ByteArray = h

    /** 返回 (send, recv) */
    fun split(): Pair<CipherState, CipherState> {
        if (!complete) throw NoiseException("握手尚未完成")
        val (k1, k2) = Noise.hkdf(ck, ByteArray(0), 2)
        val c1 = Cipher().also { it.initializeKey(k1) }
        val c2 = Cipher().also { it.initializeKey(k2) }
        return if (initiator) c1 to c2 else c2 to c1
    }
}
