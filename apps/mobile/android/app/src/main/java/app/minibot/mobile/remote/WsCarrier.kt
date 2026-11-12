package app.minibot.mobile.remote

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

/** 基于 OkHttp WebSocket 的承载；relayHello 非空时按中继协议握手（hello → welcome → pc_online / pc_offline） */
class WsCarrier(client: OkHttpClient, url: String, private val relayHello: JSONObject?) : Carrier {
    override var onOpen: () -> Unit = {}
    override var onPeer: (Boolean) -> Unit = {}
    override var onFrame: (ByteArray) -> Unit = {}
    override var onClose: (CloseReason) -> Unit = {}

    private val closedNotified = AtomicBoolean(false)
    private val socket: WebSocket

    init {
        socket = client.newWebSocket(Request.Builder().url(url).build(), Listener())
    }

    override fun send(frame: ByteArray) {
        socket.send(frame.toByteString())
    }

    override fun close() {
        socket.close(1000, null)
    }

    override fun bufferedAmount(): Long = socket.queueSize()

    private fun notifyClosed(reason: CloseReason) {
        if (closedNotified.compareAndSet(false, true)) onClose(reason)
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (relayHello != null) webSocket.send(relayHello.toString()) else this@WsCarrier.onOpen()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (relayHello == null) return
            when (JSONObject(text).optString("type")) {
                "welcome" -> this@WsCarrier.onOpen()
                "pc_online" -> onPeer(true)
                "pc_offline" -> onPeer(false)
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            onFrame(bytes.toByteArray())
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code.takeIf { it != 1005 } ?: 1000, null)
            // 1000 / 1005 是对端正常关闭；中继的 44xx 是拒绝（口令错误、被限流等），按网络错误处理
            notifyClosed(if (code == 1000 || code == 1005) CloseReason.Normal else CloseReason.Network("中继关闭连接（$code）"))
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            notifyClosed(if (code == 1000 || code == 1005) CloseReason.Normal else CloseReason.Network("连接已关闭（$code）"))
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            notifyClosed(CloseReason.Network(t.message ?: "网络错误"))
        }
    }
}

class OkHttpCarrierFactory : CarrierFactory {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    override fun lan(address: String, port: Int): Carrier {
        val host = if (address.contains(':')) "[$address]" else address
        return WsCarrier(client, "ws://$host:$port/v1", null)
    }

    override fun relay(url: String, routeId: String, token: String?): Carrier {
        val hello = JSONObject().put("type", "hello").put("role", "phone").put("routeId", routeId).put("token", token ?: "")
        return WsCarrier(client, url, hello)
    }
}
