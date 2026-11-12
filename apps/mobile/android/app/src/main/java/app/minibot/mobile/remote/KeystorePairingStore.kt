package app.minibot.mobile.remote

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONException
import org.json.JSONObject

/**
 * 手机长期私钥与配对信息存在应用私有文件里，整体用 Android Keystore 里的一把 AES-GCM 密钥加密。
 * 该密钥不要求用户验证（不加应用锁，后台需要自动重连）。
 *
 * 读失败分两种：数据确实坏了 / 密钥永久失效（换不回来）→ 删掉文件，当作未配对；
 * 其余（密钥库暂时不可用等）→ 抛 StoreUnavailableException，不缓存、不覆盖，稍后再试。
 */
class KeystorePairingStore(context: Context) : PairingStore {
    private val file = File(context.filesDir, "pairing.bin")
    private var cache: JSONObject? = null

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun read(): JSONObject {
        cache?.let { return it }
        if (!file.exists()) return JSONObject().also { cache = it }
        val json = try {
            val raw = file.readBytes()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
            JSONObject(String(cipher.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8))
        } catch (e: Exception) {
            if (!isPermanent(e)) throw StoreUnavailableException("暂时无法读取配对信息，请稍后再试")
            // 永久读不出：只能重新配对
            file.delete()
            JSONObject()
        }
        cache = json
        return json
    }

    private fun isPermanent(e: Exception): Boolean =
        e is AEADBadTagException ||
            e is KeyPermanentlyInvalidatedException ||
            e is UnrecoverableKeyException ||
            e is JSONException ||
            e is IndexOutOfBoundsException ||
            e is IllegalArgumentException

    private fun write(json: JSONObject) {
        val body = try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            cipher.iv + cipher.doFinal(json.toString().toByteArray(Charsets.UTF_8))
        } catch (e: Exception) {
            throw StoreUnavailableException("暂时无法保存配对信息，请稍后再试")
        }
        val tmp = File(file.parentFile, "pairing.bin.tmp")
        tmp.writeBytes(body)
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
        cache = json
    }

    @Synchronized
    override fun load(): Pairing? = read().optJSONObject("pairing")?.let { Pairing.fromJson(it) }

    @Synchronized
    override fun identity(): KeyPair {
        val json = read()
        val stored = json.optString("identity")
        if (stored.isNotEmpty()) return Noise.keyPairOf(Base64.getUrlDecoder().decode(stored))
        val fresh = Noise.generateKeyPair()
        // 在副本上改，写盘成功后才更新缓存
        write(JSONObject(json.toString()).put("identity", Base64.getUrlEncoder().withoutPadding().encodeToString(fresh.privateKey)))
        return fresh
    }

    @Synchronized
    override fun save(pairing: Pairing) {
        write(JSONObject(read().toString()).put("pairing", pairing.toJson()))
    }

    @Synchronized
    override fun clear() {
        file.delete()
        cache = JSONObject()
    }

    private companion object {
        const val KEY_ALIAS = "minibot-pairing"
    }
}
