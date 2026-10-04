package app.diary.local;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 本工程自带的原生插件，要在 super.onCreate 之前注册
        registerPlugin(PrivacyScreenPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
