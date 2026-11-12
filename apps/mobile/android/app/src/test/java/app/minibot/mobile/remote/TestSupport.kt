package app.minibot.mobile.remote

import java.io.InputStream
import org.json.JSONArray
import org.json.JSONObject

fun resourceText(name: String): String {
    val stream: InputStream = object {}.javaClass.classLoader!!.getResourceAsStream(name)
        ?: error("缺少测试资源 $name（应来自 packages/core/test/fixtures）")
    return stream.readBytes().toString(Charsets.UTF_8)
}

fun fixture(name: String): JSONObject = JSONObject(resourceText(name))

/**
 * JSON 结构相等（忽略键顺序，数字按数值比较）。
 * 不用 JSONObject.similar：编译期解析到 android.jar 里的 org.json，没有这个方法。
 */
fun jsonEquals(a: Any?, b: Any?): Boolean = when {
    a is JSONObject && b is JSONObject ->
        a.length() == b.length() && a.keys().asSequence().all { b.has(it) && jsonEquals(a.get(it), b.get(it)) }
    a is JSONArray && b is JSONArray ->
        a.length() == b.length() && (0 until a.length()).all { jsonEquals(a.get(it), b.get(it)) }
    a is Number && b is Number -> a.toDouble() == b.toDouble()
    else -> a == b
}

/** 两个互相连接的内存承载，帧同步投递 */
class MemoryCarrier : Carrier {
    var peer: MemoryCarrier? = null
    val sent = mutableListOf<ByteArray>()
    var closed = false
    override var onOpen: () -> Unit = {}
    override var onPeer: (Boolean) -> Unit = {}
    override var onFrame: (ByteArray) -> Unit = {}
    override var onClose: (CloseReason) -> Unit = {}

    override fun send(frame: ByteArray) {
        if (closed) return
        sent.add(frame)
        peer?.takeIf { !it.closed }?.onFrame?.invoke(frame)
    }

    override fun close() {
        if (closed) return
        closed = true
        onClose(CloseReason.Normal)
        peer?.let { if (!it.closed) it.close() }
    }
}

fun memoryPair(): Pair<MemoryCarrier, MemoryCarrier> {
    val a = MemoryCarrier()
    val b = MemoryCarrier()
    a.peer = b
    b.peer = a
    return a to b
}

class MemoryPairingStore(private var pairing: Pairing? = null, private val keys: KeyPair = Noise.generateKeyPair()) : PairingStore {
    override fun load(): Pairing? = pairing
    override fun identity(): KeyPair = keys
    override fun save(pairing: Pairing) {
        this.pairing = pairing
    }
    override fun clear() {
        pairing = null
    }
}
