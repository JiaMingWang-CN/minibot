package app.minibot.mobile

import android.view.View
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView

/** 配对扫码页：竖屏（清单里锁定），全屏取景 + 居中取景框 + 顶部关闭按钮与底部说明 */
class ScanActivity : CaptureActivity() {
    override fun initializeContent(): DecoratedBarcodeView {
        setContentView(R.layout.activity_scan)
        findViewById<View>(R.id.scan_close).setOnClickListener { finish() }
        return findViewById(R.id.zxing_barcode_scanner)
    }
}
