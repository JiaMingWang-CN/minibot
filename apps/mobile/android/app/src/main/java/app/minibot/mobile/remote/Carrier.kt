package app.minibot.mobile.remote

/** 承载关闭的原因 */
sealed class CloseReason {
    /** 对端正常关闭（WebSocket 关闭帧） */
    object Normal : CloseReason()
    object PcOffline : CloseReason()
    /** 握手被拒 / 设备已撤销（由 Connector 在握手阶段判定） */
    object Rejected : CloseReason()
    data class Network(val message: String) : CloseReason()
}

/** 一条能收发二进制帧的连接：局域网 WebSocket 或中继会话 */
interface Carrier {
    fun send(frame: ByteArray)

    /** 承载本身可用：局域网 WebSocket 已建立 / 中继已回 welcome */
    var onOpen: () -> Unit

    /** 仅中继：电脑上线 / 下线 */
    var onPeer: (online: Boolean) -> Unit
    var onFrame: (ByteArray) -> Unit
    var onClose: (CloseReason) -> Unit
    fun close()

    /** 已交给承载但还没真正发出去的字节数 */
    fun bufferedAmount(): Long = 0
}

interface CarrierFactory {
    fun lan(address: String, port: Int): Carrier
    fun relay(url: String, routeId: String, token: String?): Carrier
}
