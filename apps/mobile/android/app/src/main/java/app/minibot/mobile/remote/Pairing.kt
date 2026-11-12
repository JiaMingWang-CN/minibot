package app.minibot.mobile.remote

import java.util.Base64
import org.json.JSONException
import org.json.JSONObject

const val PAIR_CODE_PREFIX = "minibot-pair:"

/** 配对码里的内容；psk 只在配对握手用一次，不入库 */
class PairingOffer(
    val pcName: String,
    val pcPublicKey: ByteArray,
    val psk: ByteArray,
    val relayUrl: String?,
    val relayToken: String?,
    val lanAddresses: List<String>,
    val lanPort: Int,
)

class PairingCodeException(message: String) : Exception(message)

fun parsePairingCode(code: String): PairingOffer {
    val trimmed = code.trim()
    if (!trimmed.startsWith(PAIR_CODE_PREFIX)) throw PairingCodeException("不是 minibot 配对码")
    try {
        val json = JSONObject(String(Base64.getUrlDecoder().decode(trimmed.removePrefix(PAIR_CODE_PREFIX)), Charsets.UTF_8))
        if (json.optInt("v") != 1) throw PairingCodeException("配对码版本不支持")
        val pk = Base64.getUrlDecoder().decode(json.getString("pk"))
        val psk = Base64.getUrlDecoder().decode(json.getString("psk"))
        if (pk.size != 32 || psk.size != 32) throw PairingCodeException("配对码已损坏")
        val lan = json.optJSONArray("lan")
        return PairingOffer(
            pcName = json.getString("name"),
            pcPublicKey = pk,
            psk = psk,
            relayUrl = if (json.isNull("relay")) null else json.getString("relay"),
            relayToken = if (json.isNull("token")) null else json.getString("token"),
            lanAddresses = List(lan?.length() ?: 0) { lan!!.getString(it) },
            lanPort = json.getInt("port"),
        )
    } catch (e: JSONException) {
        throw PairingCodeException("配对码已损坏")
    } catch (e: IllegalArgumentException) {
        throw PairingCodeException("配对码已损坏")
    }
}

/** 配对完成后持久化的内容（含手机身份之外的全部字段，不含 psk） */
data class Pairing(
    val pcName: String,
    val pcPublicKey: ByteArray,
    val routeId: String,
    val relayUrl: String?,
    val relayToken: String?,
    val lanAddresses: List<String>,
    val lanPort: Int,
    val deviceId: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("pcName", pcName)
        .put("pk", Base64.getUrlEncoder().withoutPadding().encodeToString(pcPublicKey))
        .put("routeId", routeId)
        .put("relayUrl", relayUrl ?: JSONObject.NULL)
        .put("relayToken", relayToken ?: JSONObject.NULL)
        .put("lan", org.json.JSONArray(lanAddresses))
        .put("lanPort", lanPort)
        .put("deviceId", deviceId)

    companion object {
        fun fromJson(json: JSONObject): Pairing {
            val lan = json.getJSONArray("lan")
            return Pairing(
                pcName = json.getString("pcName"),
                pcPublicKey = Base64.getUrlDecoder().decode(json.getString("pk")),
                routeId = json.getString("routeId"),
                relayUrl = if (json.isNull("relayUrl")) null else json.getString("relayUrl"),
                relayToken = if (json.isNull("relayToken")) null else json.getString("relayToken"),
                lanAddresses = List(lan.length()) { lan.getString(it) },
                lanPort = json.getInt("lanPort"),
                deviceId = json.getString("deviceId"),
            )
        }
    }
}

/** 路由号 = SHA-256(电脑公钥) 前 16 字节（hex），与电脑端 / 中继一致 */
fun routeIdOf(pcPublicKey: ByteArray): String = Noise.hash(pcPublicKey).copyOf(16).toHex()

/** 设备号 = SHA-256(手机公钥) 前 16 字节（hex），与电脑端 deviceIdOf 一致 */
fun deviceIdOf(publicKey: ByteArray): String = routeIdOf(publicKey)

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

fun hexToBytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

/** 存储暂时不可用（如系统密钥库暂时取不到）；数据还在，稍后重试，不能当作未配对去覆盖 */
class StoreUnavailableException(message: String) : Exception(message)

/** 手机长期身份与配对信息的持久化；Android 实现见 KeystorePairingStore。读写失败抛 StoreUnavailableException */
interface PairingStore {
    fun load(): Pairing?
    fun identity(): KeyPair
    fun save(pairing: Pairing)
    fun clear()
}
