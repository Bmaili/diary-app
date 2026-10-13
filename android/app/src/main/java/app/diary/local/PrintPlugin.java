package app.diary.local;

import android.app.Activity;
import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

/**
 * 年度日记本（2026-10-13 加入）：把排好的网页交给安卓系统打印，用户在打印界面选“另存为 PDF”或连打印机。
 * 安卓的 WebView 不支持 window.print()，所以另开一个不显示的 WebView 载入这份网页，
 * 加载完后用 createPrintDocumentAdapter 交给 PrintManager。
 *
 * 网页里的图片用相对 diary/ 的路径（attachments/2026/…），基准地址是 app 私有目录里的 diary/，
 * 所以要允许这个 WebView 读本地文件；它不跑脚本，只用来排版打印。
 *
 * JS：registerPlugin('Print').print({ html, title }) → { started }
 */
@CapacitorPlugin(name = "Print")
public class PrintPlugin extends Plugin {

    /** 打印期间要一直持有这个 WebView，否则被回收后打印界面会是空白 */
    private WebView printing;

    @PluginMethod
    public void print(final PluginCall call) {
        final String html = call.getString("html");
        final String title = call.getString("title", "浮生记");
        final Activity activity = getActivity();
        if (html == null || html.isEmpty() || activity == null) {
            call.reject("没有要打印的内容");
            return;
        }
        final String base = "file://" + new File(getContext().getFilesDir(), "diary").getAbsolutePath() + "/";
        activity.runOnUiThread(() -> {
            try {
                if (printing != null) printing.destroy();
                final WebView wv = new WebView(activity);
                WebSettings s = wv.getSettings();
                s.setJavaScriptEnabled(false);
                s.setAllowFileAccess(true);
                s.setBlockNetworkLoads(true);
                wv.setWebViewClient(new WebViewClient() {
                    private boolean started = false;

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        if (started) return;
                        started = true;
                        try {
                            PrintManager pm = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                            PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(title);
                            PrintAttributes attrs = new PrintAttributes.Builder()
                                .setMediaSize(PrintAttributes.MediaSize.ISO_A5)
                                .build();
                            pm.print(title, adapter, attrs);
                            JSObject ret = new JSObject();
                            ret.put("started", true);
                            call.resolve(ret);
                        } catch (Exception e) {
                            call.reject("打不开打印界面：" + e.getMessage());
                        }
                    }
                });
                printing = wv;
                wv.loadDataWithBaseURL(base, html, "text/html", "UTF-8", null);
            } catch (Exception e) {
                call.reject("排版失败：" + e.getMessage());
            }
        });
    }
}
