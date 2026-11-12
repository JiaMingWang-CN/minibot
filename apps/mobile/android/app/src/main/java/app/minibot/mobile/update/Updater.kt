package app.minibot.mobile.update

import app.minibot.mobile.diag.Diag
import app.minibot.mobile.diag.DiagEvent
import app.minibot.mobile.diag.LogLevel
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

const val RELEASE_API_URL = "https://api.github.com/repos/JiaMingWang-CN/minibot/releases/latest"
private const val DAY_MS = 24 * 3_600_000L

class UpdateException(val kind: String, message: String) : Exception(message)

/** GitHub Release 里一个可用的新版本 */
data class AvailableUpdate(
    val version: String,
    val notes: String,
    val apkUrl: String,
    val sha256Url: String,
    val size: Long,
)

/** v1.2.3 → 10203；不含 v 前缀也接受；不合格式返回 null（视为无更新） */
fun versionCodeOf(tag: String): Int? {
    val match = Regex("""^v?(\d+)\.(\d+)\.(\d+)$""").matchEntire(tag.trim()) ?: return null
    val major = match.groupValues[1].toIntOrNull() ?: return null
    val minor = match.groupValues[2].toIntOrNull() ?: return null
    val patch = match.groupValues[3].toIntOrNull() ?: return null
    return major * 10000 + minor * 100 + patch
}

/**
 * 应用内更新：查 GitHub Release、下载 APK、校验大小与 SHA-256 后调起系统安装。
 * 自动检查每天最多一次，手动检查不受限；失败删除半成品。
 */
class Updater(
    private val updateDir: File,
    private val currentVersionCode: Int,
    private val client: OkHttpClient = OkHttpClient(),
    private val releaseUrl: String = RELEASE_API_URL,
    private val now: () -> Long = System::currentTimeMillis,
    private val lastCheckAt: () -> Long = { 0L },
    private val saveLastCheckAt: (Long) -> Unit = {},
    private val onProgress: (Int) -> Unit = {},
    private val installer: ((File) -> Unit)? = null,
) {
    private var cached: AvailableUpdate? = null

    /** 查一次 Release；自动检查在 24 小时内只发一次请求，手动始终请求 */
    suspend fun check(manual: Boolean): AvailableUpdate? {
        val last = lastCheckAt()
        if (!manual && last > 0 && now() - last < DAY_MS) return cached
        val update = try {
            requestRelease()
        } catch (e: UpdateException) {
            logCheck("error", e.kind)
            throw e
        }
        saveLastCheckAt(now())
        cached = update
        logCheck(if (update == null) "none" else "available", null, update?.version)
        return update
    }

    /** 下载并校验已存在的新版本，然后交给 installer 调起安装 */
    suspend fun downloadAndInstall() {
        val update = cached ?: throw UpdateException("no_update", "没有可用的更新")
        updateDir.mkdirs()
        val part = File(updateDir, "minibot-${update.version}.apk.part")
        val target = File(updateDir, "minibot-${update.version}.apk")
        try {
            part.delete()
            target.delete()
            download(update.apkUrl, part, update.size)
            if (update.size > 0 && part.length() != update.size) throw UpdateException("size", "下载不完整")
            val expected = fetchText(update.sha256Url).trim().lowercase()
            val actual = sha256(part)
            if (expected.isEmpty() || expected != actual) throw UpdateException("hash", "安装包校验失败")
            if (!part.renameTo(target)) {
                part.copyTo(target, overwrite = true)
                part.delete()
            }
            Diag.write(LogLevel.INFO, "update", "update.downloaded", mapOf("version" to update.version), updateEvent("update/update.download", "ok", update.version))
            installer?.invoke(target)
            Diag.write(LogLevel.INFO, "update", "update.install", mapOf("version" to update.version), updateEvent("update/update.install", "ok", update.version))
        } catch (e: UpdateException) {
            part.delete()
            target.delete()
            Diag.write(LogLevel.WARN, "update", "update.failed", mapOf("errorKind" to e.kind), updateEvent("update/update.download", "error", null, e.kind))
            throw e
        } catch (e: Throwable) {
            part.delete()
            target.delete()
            Diag.write(LogLevel.WARN, "update", "update.failed", mapOf("errorKind" to "io"), updateEvent("update/update.download", "error", null, "io"))
            throw UpdateException("io", e.message ?: "下载失败")
        }
    }

    // —— 内部 ——

    private suspend fun requestRelease(): AvailableUpdate? {
        val request = Request.Builder()
            .url(releaseUrl)
            .header("Accept", "application/vnd.github+json")
            .build()
        val text = withContext(Dispatchers.IO) {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw UpdateException("http", "检查更新失败（${response.code}）")
                response.body?.string() ?: throw UpdateException("http", "检查更新失败")
            }
        }
        return parseRelease(text)
    }

    private fun parseRelease(text: String): AvailableUpdate? {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: throw UpdateException("bad_response", "检查更新失败")
        val tag = json.optString("tag_name")
        val code = versionCodeOf(tag) ?: return null
        if (code <= currentVersionCode) return null
        var apk: JSONObject? = null
        var sha: JSONObject? = null
        // 只认本次发版约定的资产名，避免 Release 里其他 APK 被选中
        val version = tag.removePrefix("v")
        val apkName = "minibot-$version.apk"
        val shaName = "$apkName.sha256"
        val assets = json.optJSONArray("assets") ?: JSONArray()
        for (i in 0 until assets.length()) {
            val asset = assets.optJSONObject(i) ?: continue
            when (asset.optString("name")) {
                shaName -> sha = asset
                apkName -> apk = asset
            }
        }
        val apkAsset = apk ?: return null
        val shaAsset = sha ?: return null
        return AvailableUpdate(
            version = tag.removePrefix("v"),
            notes = json.optString("body"),
            apkUrl = apkAsset.optString("browser_download_url"),
            sha256Url = shaAsset.optString("browser_download_url"),
            size = apkAsset.optLong("size", 0L),
        )
    }

    private suspend fun download(url: String, target: File, expectedSize: Long) = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw UpdateException("http", "下载失败（${response.code}）")
            val body = response.body ?: throw UpdateException("io", "下载失败")
            val total = if (expectedSize > 0) expectedSize else body.contentLength()
            var written = 0L
            var lastPercent = -1
            body.byteStream().use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        output.write(buffer, 0, read)
                        written += read
                        if (total > 0) {
                            val percent = ((written * 100) / total).toInt().coerceIn(0, 100)
                            if (percent != lastPercent) {
                                lastPercent = percent
                                onProgress(percent)
                            }
                        }
                    }
                }
            }
        }
    }

    private suspend fun fetchText(url: String): String = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw UpdateException("http", "读取校验值失败（${response.code}）")
            response.body?.string() ?: throw IOException("空响应")
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun logCheck(result: String, errorKind: String?, version: String? = null) {
        Diag.write(
            if (result == "error") LogLevel.WARN else LogLevel.INFO,
            "update",
            "update.check",
            buildMap {
                put("result", result)
                errorKind?.let { put("errorKind", it) }
                version?.let { put("version", it) }
            },
            updateEvent("update/update.check", result, version, errorKind),
        )
    }

    private fun updateEvent(name: String, result: String, version: String?, errorKind: String? = null): DiagEvent =
        DiagEvent(
            "update",
            name,
            buildMap {
                put("result", result)
                version?.let { put("version", it.take(64)) }
                errorKind?.let { put("errorKind", it) }
            },
        )
}
