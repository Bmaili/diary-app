package app.diary.local;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 指纹解锁（应用锁的可选项）。用系统的 BiometricPrompt 弹出指纹框，
 * 只告诉网页“认证成功 / 失败”，不接触任何指纹数据。PIN 始终可以作为备用。
 *
 * JS：registerPlugin('Biometric')
 *   status() → { available, reason }   reason: ok | none-enrolled | no-hardware | unavailable
 *   authenticate({ title, subtitle, cancel }) → { ok, code?, message? }
 */
@CapacitorPlugin(name = "Biometric")
public class BiometricPlugin extends Plugin {

    /** 第 2 类及以上的生物识别：指纹，以及部分手机的人脸 */
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_WEAK;

    @PluginMethod
    public void status(PluginCall call) {
        int r = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        String reason;
        if (r == BiometricManager.BIOMETRIC_SUCCESS) reason = "ok";
        else if (r == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) reason = "none-enrolled";
        else if (r == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE || r == BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE) reason = "no-hardware";
        else reason = "unavailable";
        JSObject ret = new JSObject();
        ret.put("available", r == BiometricManager.BIOMETRIC_SUCCESS);
        ret.put("reason", reason);
        call.resolve(ret);
    }

    @PluginMethod
    public void authenticate(final PluginCall call) {
        final String title = call.getString("title", "解锁");
        final String subtitle = call.getString("subtitle", "");
        final String cancel = call.getString("cancel", "取消");
        getActivity().runOnUiThread(() -> {
            try {
                FragmentActivity activity = (FragmentActivity) getActivity();
                BiometricPrompt prompt = new BiometricPrompt(
                    activity,
                    ContextCompat.getMainExecutor(activity),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            JSObject ret = new JSObject();
                            ret.put("ok", true);
                            call.resolve(ret);
                        }

                        @Override
                        public void onAuthenticationError(int code, CharSequence message) {
                            JSObject ret = new JSObject();
                            ret.put("ok", false);
                            ret.put("code", code);
                            ret.put("message", message == null ? "" : message.toString());
                            call.resolve(ret);
                        }
                        // onAuthenticationFailed：单次没认出来，系统框会提示再试，这里不用处理
                    }
                );
                BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setNegativeButtonText(cancel)
                    .setAllowedAuthenticators(AUTHENTICATORS)
                    .setConfirmationRequired(false);
                if (!subtitle.isEmpty()) info.setSubtitle(subtitle);
                prompt.authenticate(info.build());
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            }
        });
    }
}
