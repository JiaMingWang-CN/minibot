package app.minibot.mobile

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import app.minibot.mobile.diag.Diag
import app.minibot.mobile.diag.FeedbackException
import app.minibot.mobile.remote.PairingCodeException
import app.minibot.mobile.remote.PairingFailedException
import app.minibot.mobile.remote.parsePairingCode
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.journeyapps.barcodescanner.ScanOptions
import com.journeyapps.barcodescanner.ScanContract
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 网页与原生之间的薄壳。只暴露下面这些方法，不提供读取私钥、psk、中继口令的途径；
 * 扫码配对全程在原生完成。
 */
@CapacitorPlugin(
    name = "MinibotRemote",
    permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")],
)
class MinibotRemotePlugin : Plugin(), HubSink {
    override fun load() {
        RemoteHub.init(context)
        RemoteHub.sink = this
        RemoteHub.startConnection()
        if (RemoteHub.isPaired() && RemoteHub.background) RemoteService.start(context)
    }

    override fun handleOnDestroy() {
        if (RemoteHub.sink === this) RemoteHub.sink = null
    }

    // —— 原生 → 网页 ——

    override fun kernelEvent(event: JSONObject) = notifyListeners("kernelEvent", JSObject().put("event", event))

    override fun ready(pcName: String) = notifyListeners("ready", JSObject().put("pcName", pcName))

    override fun status() = notifyListeners("status", JSObject(RemoteHub.statusJson().toString()))

    override fun openThread(threadId: String) = notifyListeners("openThread", JSObject().put("threadId", threadId))

    // —— 网页 → 原生 ——

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(JSObject(RemoteHub.statusJson().toString()))
    }

    @PluginMethod
    fun scanAndPair(call: PluginCall) {
        val options = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setBeepEnabled(false)
            .setCaptureActivity(ScanActivity::class.java)
        val intent = ScanContract().createIntent(context, options)
        startActivityForResult(call, intent, "scanResult")
    }

    @ActivityCallback
    private fun scanResult(call: PluginCall, result: ActivityResult) {
        val contents = ScanContract().parseResult(result.resultCode, result.data).contents
        if (contents == null) {
            call.resolve(JSObject().put("cancelled", true))
            return
        }
        pairWith(call, contents) { call.resolve(JSObject().put("cancelled", false)) }
    }

    @PluginMethod
    fun pair(call: PluginCall) {
        val code = call.getString("code") ?: return call.reject("缺少配对码")
        pairWith(call, code) { call.resolve() }
    }

    private fun pairWith(call: PluginCall, code: String, done: () -> Unit) {
        val deviceName = call.getString("deviceName") ?: Build.MODEL
        RemoteHub.hubScope.launch {
            try {
                RemoteHub.connector.pair(parsePairingCode(code), deviceName)
                done()
            } catch (e: PairingCodeException) {
                call.reject(e.message ?: "配对码无效")
            } catch (e: PairingFailedException) {
                call.reject(e.message ?: "配对失败")
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                // 其他意外（如系统密钥库异常）也要回给网页，不能让协程带着异常崩掉 App
                call.reject(e.message ?: "配对失败")
            }
        }
    }

    @PluginMethod
    fun unpair(call: PluginCall) {
        RemoteHub.hubScope.launch {
            try {
                RemoteService.stop(context)
                RemoteHub.unpair()
                call.resolve()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                call.reject(e.message ?: "取消配对失败")
            }
        }
    }

    @PluginMethod
    fun request(call: PluginCall) {
        val method = call.getString("method") ?: return call.reject("缺少 method")
        val path = call.getString("path") ?: return call.reject("缺少 path")
        val body = call.data.opt("body")?.takeIf { it != JSONObject.NULL }
        RemoteHub.hubScope.launch {
            try {
                val res = RemoteHub.request(method, path, body)
                val out = JSObject().put("status", res.optInt("status"))
                for (key in listOf("body", "bytes", "contentType")) if (res.has(key)) out.put(key, res.get(key))
                call.resolve(out)
            } catch (e: Exception) {
                val (code, message) = RemoteHub.requestFailure(e)
                call.reject(message, code)
            }
        }
    }

    @PluginMethod
    fun sendControl(call: PluginCall) {
        val msg = call.data.opt("msg") ?: return call.reject("缺少 msg")
        RemoteHub.sendControl(msg)
        call.resolve()
    }

    @PluginMethod
    fun setActiveThread(call: PluginCall) {
        RemoteHub.activeThread = call.getString("threadId")
        call.resolve()
    }

    @PluginMethod
    fun startBackground(call: PluginCall) {
        RemoteHub.background = true
        if (RemoteHub.isPaired()) RemoteService.start(context)
        status()
        call.resolve()
    }

    @PluginMethod
    fun stopBackground(call: PluginCall) {
        RemoteHub.background = false
        RemoteService.stop(context)
        status()
        call.resolve()
    }

    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == com.getcapacitor.PermissionState.GRANTED) {
            call.resolve()
            return
        }
        requestPermissionForAlias("notifications", call, "notificationsResult")
    }

    @PermissionCallback
    private fun notificationsResult(call: PluginCall) {
        status()
        call.resolve()
    }

    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + context.packageName))
        try {
            activity.startActivity(direct)
        } catch (e: Exception) {
            activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
        call.resolve()
    }

    @PluginMethod
    fun takeLaunchThread(call: PluginCall) {
        val id = RemoteHub.launchThread
        RemoteHub.launchThread = null
        call.resolve(JSObject().put("threadId", id ?: JSONObject.NULL))
    }

    // —— 诊断与反馈（本机功能，不经电脑端） ——

    @PluginMethod
    fun getDiagnostics(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("consent", Diag.settings?.consent ?: "unset")
                .put("available", Diag.available)
                .put("appVersion", Diag.appVersion),
        )
    }

    @PluginMethod
    fun setDiagnostics(call: PluginCall) {
        val consent = call.getString("consent") ?: return call.reject("缺少 consent")
        if (consent != "on" && consent != "off") return call.reject("consent 必须是 on 或 off")
        RemoteHub.hubScope.launch(Dispatchers.IO) {
            Diag.settings?.consent = consent
            Diag.setConsent(consent)
            call.resolve()
        }
    }

    @PluginMethod
    fun logsPreview(call: PluginCall) {
        RemoteHub.hubScope.launch(Dispatchers.IO) {
            try {
                call.resolve(JSObject().put("text", Diag.recentLogs()))
            } catch (e: Exception) {
                call.reject(e.message ?: "读取日志失败")
            }
        }
    }

    @PluginMethod
    fun sendFeedback(call: PluginCall) {
        val description = call.getString("description") ?: return call.reject("缺少问题描述")
        val contact = call.getString("contact")
        val attachLogs = call.getBoolean("attachLogs") ?: false
        val uploader = Diag.uploader ?: return call.reject("反馈功能未开启", "unavailable")
        RemoteHub.hubScope.launch(Dispatchers.IO) {
            try {
                uploader.sendFeedback(description, contact, attachLogs)
                call.resolve()
            } catch (e: FeedbackException) {
                call.reject(feedbackMessage(e.kind), e.kind)
            } catch (e: IllegalArgumentException) {
                call.reject(e.message ?: "参数无效", "invalid")
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                call.reject(e.message ?: "发送失败", "error")
            }
        }
    }

    @PluginMethod
    fun reportClientError(call: PluginCall) {
        val message = call.getString("message") ?: return call.reject("缺少 message")
        val stack = call.getString("stack")
        RemoteHub.hubScope.launch(Dispatchers.IO) {
            Diag.reportClientError(message, stack)
            call.resolve()
        }
    }

    private fun feedbackMessage(kind: String): String = when (kind) {
        "network" -> "网络连接失败，请检查网络后重试"
        "rate_limited" -> "提交太频繁，请稍后再试"
        "rejected" -> "反馈内容未被接受，请修改后重试"
        else -> "反馈服务暂不可用，请稍后再试"
    }
}
