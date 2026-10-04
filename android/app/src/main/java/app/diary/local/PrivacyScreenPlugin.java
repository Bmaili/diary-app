package app.diary.local;

import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 隐私屏幕：开启后，最近任务列表里看不到 app 的内容，也不能截屏（规格第 8 节，二期）。
 * 用法（JS）：registerPlugin('PrivacyScreen').set({ on: true })
 */
@CapacitorPlugin(name = "PrivacyScreen")
public class PrivacyScreenPlugin extends Plugin {

    @PluginMethod
    public void set(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) {
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            } else {
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }
            call.resolve();
        });
    }
}
