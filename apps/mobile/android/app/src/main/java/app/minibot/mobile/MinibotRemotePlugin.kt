package app.minibot.mobile

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
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
        if (RemoteHub.store.load() != null && RemoteHub.background) RemoteService.start(context)
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
            .setPrompt(context.getString(R.string.scan_prompt))
            .setBeepEnabled(false)
            .setOrientationLocked(false)
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
            }
        }
    }

    @PluginMethod
    fun unpair(call: PluginCall) {
        RemoteHub.hubScope.launch {
            RemoteService.stop(context)
            RemoteHub.unpair()
            call.resolve()
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
        if (RemoteHub.store.load() != null) RemoteService.start(context)
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
}
