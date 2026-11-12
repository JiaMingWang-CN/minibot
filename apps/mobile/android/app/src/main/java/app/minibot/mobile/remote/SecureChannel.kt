package app.minibot.mobile.remote

import java.io.ByteArrayOutputStream
import org.json.JSONObject

const val FRAME_PAIR: Byte = 0x01
const val FRAME_KK: Byte = 0x02
const val FRAME_DATA: Byte = 0x03

/** 每块明文：1 字节标志 + 至多 65518 字节数据（加 16 字节标签后正好 65535） */
const val CHUNK_DATA_BYTES = 65518
const val MAX_APP_MESSAGE_BYTES = 37748736
const val MAX_SEND_BACKLOG_BYTES = 16L * 1024 * 1024

private const val FLAG_MORE: Byte = 0
private const val FLAG_LAST: Byte = 1

/** 握手之后的加密信道；与 packages/core/src/remote/channel.ts 对应 */
class SecureChannel(
    private val carrier: Carrier,
    private val sendState: CipherState,
    private val recvState: CipherState,
) {
    var onMessage: (JSONObject) -> Unit = {}
    var onClose: () -> Unit = {}

    private val pending = ByteArrayOutputStream()
    private var pendingBytes = 0
    @Volatile
    private var closed = false

    init {
        // 换处理函数必须同步完成：握手最后一帧之后紧跟的 ready 帧不能丢
        carrier.onFrame = { frame -> handleFrame(frame) }
        val previous = carrier.onClose
        carrier.onClose = { reason ->
            previous(reason)
            finish()
        }
    }

    @Synchronized
    fun send(message: JSONObject) {
        if (closed) return
        if (carrier.bufferedAmount() > MAX_SEND_BACKLOG_BYTES) {
            close()
            return
        }
        val data = message.toString().toByteArray(Charsets.UTF_8)
        var offset = 0
        do {
            val end = minOf(offset + CHUNK_DATA_BYTES, data.size)
            val flag = if (end >= data.size) FLAG_LAST else FLAG_MORE
            val plain = ByteArray(1 + end - offset)
            plain[0] = flag
            System.arraycopy(data, offset, plain, 1, end - offset)
            val cipher = sendState.encrypt(plain)
            val frame = ByteArray(1 + cipher.size)
            frame[0] = FRAME_DATA
            System.arraycopy(cipher, 0, frame, 1, cipher.size)
            carrier.send(frame)
            offset = end
        } while (offset < data.size)
    }

    fun close() {
        if (closed) return
        finish()
        carrier.close()
    }

    private fun finish() {
        if (closed) return
        closed = true
        pending.reset()
        pendingBytes = 0
        onClose()
    }

    private fun handleFrame(frame: ByteArray) {
        if (closed) return
        if (frame.isEmpty() || frame[0] != FRAME_DATA) return close()
        val plain = try {
            recvState.decrypt(frame.copyOfRange(1, frame.size))
        } catch (e: NoiseException) {
            return close()
        }
        if (plain.isEmpty()) return close()
        val flag = plain[0]
        if ((flag != FLAG_MORE && flag != FLAG_LAST) || plain.size - 1 > CHUNK_DATA_BYTES) return close()
        pendingBytes += plain.size - 1
        if (pendingBytes > MAX_APP_MESSAGE_BYTES) return close()
        pending.write(plain, 1, plain.size - 1)
        if (flag == FLAG_MORE) return

        val whole = pending.toByteArray()
        pending.reset()
        pendingBytes = 0
        val message = try {
            JSONObject(String(whole, Charsets.UTF_8))
        } catch (e: org.json.JSONException) {
            return close()
        }
        onMessage(message)
    }
}
