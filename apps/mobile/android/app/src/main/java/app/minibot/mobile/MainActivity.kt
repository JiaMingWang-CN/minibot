package app.minibot.mobile

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(MinibotRemotePlugin::class.java)
        super.onCreate(savedInstanceState)
        RemoteHub.init(this)
        handleIntent(intent, cold = true)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent, cold = false)
    }

    override fun onStart() {
        super.onStart()
        RemoteHub.webVisible = true
        RemoteHub.onForeground()
    }

    override fun onStop() {
        RemoteHub.webVisible = false
        super.onStop()
    }

    private fun handleIntent(intent: Intent?, cold: Boolean) {
        val threadId = intent?.getStringExtra(EXTRA_THREAD_ID) ?: return
        intent.removeExtra(EXTRA_THREAD_ID)
        // 冷启动：网页还没起来，存着等它调 takeLaunchThread；否则直接发事件
        if (cold) RemoteHub.launchThread = threadId else RemoteHub.openThread(threadId)
    }

    companion object {
        const val EXTRA_THREAD_ID = "threadId"
    }
}
