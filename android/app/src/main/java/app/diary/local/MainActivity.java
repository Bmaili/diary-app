package app.diary.local;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 进程被系统清掉后重建：系统会把当初的分享 intent 再给一遍，那次分享已经处理过了
        if (savedInstanceState != null && getIntent() != null) getIntent().putExtra(IntakePlugin.CONSUMED, true);
        // 本工程自带的原生插件，要在 super.onCreate 之前注册
        registerPlugin(PrivacyScreenPlugin.class);
        registerPlugin(HttpStreamPlugin.class);
        registerPlugin(BiometricPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(IntakePlugin.class);
        registerPlugin(PrintPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
