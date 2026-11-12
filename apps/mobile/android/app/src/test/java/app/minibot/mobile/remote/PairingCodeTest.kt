package app.minibot.mobile.remote

import java.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class PairingCodeTest {
    private fun b64(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun code(json: JSONObject) = PAIR_CODE_PREFIX + b64(json.toString().toByteArray())

    private val pk = ByteArray(32) { 7 }
    private val psk = ByteArray(32) { 9 }

    private fun valid() = JSONObject()
        .put("v", 1).put("relay", "wss://relay.example.com/v1").put("token", "tok")
        .put("pk", b64(pk)).put("psk", b64(psk)).put("name", "书房电脑")
        .put("lan", org.json.JSONArray(listOf("192.168.1.5", "10.0.0.2"))).put("port", 4590)

    @Test
    fun validCodeParsesAllFields() {
        val offer = parsePairingCode(code(valid()))
        assertEquals("书房电脑", offer.pcName)
        assertArrayEquals(pk, offer.pcPublicKey)
        assertArrayEquals(psk, offer.psk)
        assertEquals("wss://relay.example.com/v1", offer.relayUrl)
        assertEquals("tok", offer.relayToken)
        assertEquals(listOf("192.168.1.5", "10.0.0.2"), offer.lanAddresses)
        assertEquals(4590, offer.lanPort)
    }

    @Test
    fun noRelayMeansNullRelayAndToken() {
        val offer = parsePairingCode(code(valid().put("relay", JSONObject.NULL).put("token", JSONObject.NULL)))
        assertNull(offer.relayUrl)
        assertNull(offer.relayToken)
    }

    @Test
    fun missingPrefixOrBrokenJsonThrows() {
        for (bad in listOf("hello", b64(valid().toString().toByteArray()), PAIR_CODE_PREFIX + b64("{oops".toByteArray()), PAIR_CODE_PREFIX + "!!!")) {
            try {
                parsePairingCode(bad)
                fail("应当抛错: $bad")
            } catch (e: PairingCodeException) {
                // 预期
            }
        }
    }

    @Test
    fun badVersionOrKeyLengthThrows() {
        for (bad in listOf(valid().put("v", 2), valid().put("pk", b64(ByteArray(5))))) {
            try {
                parsePairingCode(code(bad))
                fail("应当抛错")
            } catch (e: PairingCodeException) {
                // 预期
            }
        }
    }
}
