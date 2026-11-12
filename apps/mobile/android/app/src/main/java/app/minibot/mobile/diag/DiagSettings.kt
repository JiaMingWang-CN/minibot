package app.minibot.mobile.diag

import android.content.Context
import java.util.UUID

/** 诊断上传的同意状态与本机标识（存在应用私有 SharedPreferences，与身份无关） */
class DiagSettings(context: Context) {
    private val prefs = context.getSharedPreferences("diag", Context.MODE_PRIVATE)

    /** unset：只入队不上传；on：上传；off：不入队并清空队列 */
    var consent: String
        get() = prefs.getString(KEY_CONSENT, "unset")?.takeIf { it == "on" || it == "off" } ?: "unset"
        set(value) {
            val next = if (value == "on" || value == "off") value else "unset"
            prefs.edit().putString(KEY_CONSENT, next).apply()
        }

    /** 首次访问生成随机 UUID，之后保持不变 */
    val installId: String
        get() {
            prefs.getString(KEY_INSTALL_ID, null)?.takeIf { it.isNotEmpty() }?.let { return it }
            val generated = UUID.randomUUID().toString()
            prefs.edit().putString(KEY_INSTALL_ID, generated).apply()
            return generated
        }

    private companion object {
        const val KEY_CONSENT = "consent"
        const val KEY_INSTALL_ID = "installId"
    }
}
