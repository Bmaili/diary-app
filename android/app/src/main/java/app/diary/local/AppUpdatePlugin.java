package app.diary.local;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 应用内更新：下载新版安装包 → 核对 → 调起系统安装界面（用户点一下“安装”）。
 * 只用系统自带的接口。核对四项，任何一项不对都删掉文件并报错：
 *   sha256（GitHub 给的摘要）、包名、签名证书（必须和手机上这版相同）、版本号（必须更新）。
 * 签名不同的包系统本来也装不上（不会删数据），在这里先拦下是为了给出看得懂的提示。
 *
 * JS：registerPlugin('AppUpdate')
 *   addListener('progress', ({ done, total }) => …)
 *   download({ url, sha256, size }) → { path }；cancel()；install({ path, askPermission }) → { started, needPermission? }；clean()
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    private static final String DIR = "update";

    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private volatile boolean cancelled = false;
    private volatile HttpURLConnection active;

    private File dir() {
        File d = new File(getContext().getCacheDir(), DIR);
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private void wipe() {
        File[] files = dir().listFiles();
        if (files != null) for (File f : files) f.delete();
    }

    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url");
        final String sha256 = call.getString("sha256", "");
        // 不用 getLong：JS 传来的整数解析成 Integer，getLong 会直接返回默认值
        final long size = call.getDouble("size", 0d).longValue();
        if (url == null || !url.startsWith("https://")) {
            call.reject("下载地址不对");
            return;
        }
        cancelled = false;
        pool.execute(() -> {
            File tmp = null;
            HttpURLConnection conn = null;
            try {
                wipe();
                tmp = new File(dir(), "download.tmp");
                conn = (HttpURLConnection) new URL(url).openConnection();
                active = conn;
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(30000);
                conn.setRequestProperty("User-Agent", "diary-app");
                int status = conn.getResponseCode();
                if (status < 200 || status >= 300) throw new Exception("HTTP " + status);
                long total = conn.getContentLength() > 0 ? conn.getContentLength() : size;
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                long done = 0;
                long lastNotify = 0;
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (cancelled) throw new InterruptedException();
                        out.write(buf, 0, n);
                        md.update(buf, 0, n);
                        done += n;
                        long now = System.currentTimeMillis();
                        if (now - lastNotify > 200) {
                            lastNotify = now;
                            progress(done, total);
                        }
                    }
                }
                if (cancelled) throw new InterruptedException();
                progress(done, total);
                if (size > 0 && done != size) throw new Exception("文件不完整（" + done + " / " + size + " 字节），请重试");
                if (sha256 != null && !sha256.isEmpty() && !hex(md.digest()).equalsIgnoreCase(sha256)) {
                    throw new Exception("文件校验不通过（可能下载时损坏了），请重试");
                }
                File apk = new File(dir(), "diary-update.apk");
                if (!tmp.renameTo(apk)) throw new Exception("保存文件失败");
                tmp = null;
                String problem = verify(apk);
                if (problem != null) {
                    apk.delete();
                    throw new Exception(problem);
                }
                JSObject ret = new JSObject();
                ret.put("path", apk.getAbsolutePath());
                call.resolve(ret);
            } catch (InterruptedException e) {
                call.reject("已取消", "CANCELLED");
            } catch (Exception e) {
                if (cancelled) call.reject("已取消", "CANCELLED");
                else call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), "FAILED");
            } finally {
                active = null;
                if (conn != null) conn.disconnect();
                if (tmp != null) tmp.delete();
            }
        });
    }

    private void progress(long done, long total) {
        JSObject ev = new JSObject();
        ev.put("done", done);
        ev.put("total", total);
        notifyListeners("progress", ev);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        final HttpURLConnection c = active;
        if (c != null) new Thread(c::disconnect).start();
        call.resolve();
    }

    @PluginMethod
    public void clean(PluginCall call) {
        pool.execute(() -> {
            wipe();
            call.resolve();
        });
    }

    /** 核对包名、签名和版本号；没问题返回 null，否则返回原因 */
    private String verify(File apk) {
        Context ctx = getContext();
        PackageManager pm = ctx.getPackageManager();
        String path = apk.getAbsolutePath();
        PackageInfo mine;
        PackageInfo theirs;
        try {
            mine = pm.getPackageInfo(ctx.getPackageName(), sigFlag());
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
        theirs = pm.getPackageArchiveInfo(path, sigFlag());
        if (theirs == null) return "下载的文件不是有效的安装包";
        if (!ctx.getPackageName().equals(theirs.packageName)) return "安装包不是浮生记";
        if (versionCode(theirs) <= versionCode(mine)) return "下载的版本不比现在的新";
        Set<String> a = certs(mine);
        Set<String> b = certs(theirs);
        // 个别系统读不出安装包的签名：交给系统安装器核对（签名不同它会拒绝安装，不会删数据）
        if (a.isEmpty() || b.isEmpty()) return null;
        if (!a.equals(b)) return "安装包的签名和现在的不一样，为了日记安全没有安装。请到 GitHub 页面确认后再手动下载";
        return null;
    }

    @SuppressWarnings("deprecation")
    private static int sigFlag() {
        return Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    }

    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo p) {
        return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
    }

    @SuppressWarnings("deprecation")
    private static Set<String> certs(PackageInfo p) {
        Set<String> out = new HashSet<>();
        Signature[] sigs = null;
        if (Build.VERSION.SDK_INT >= 28) {
            if (p.signingInfo != null) sigs = p.signingInfo.getApkContentsSigners();
        } else {
            sigs = p.signatures;
        }
        if (sigs == null) return out;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (Signature s : sigs) out.add(hex(md.digest(s.toByteArray())));
        } catch (Exception ignored) {
            out.clear();
        }
        return out;
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte x : bytes) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    @PluginMethod
    public void install(PluginCall call) {
        final String path = call.getString("path");
        final boolean ask = Boolean.TRUE.equals(call.getBoolean("askPermission", true));
        File apk = path == null ? null : new File(path);
        if (apk == null || !apk.exists() || !apk.getParentFile().equals(dir())) {
            call.reject("找不到下载好的安装包，请重新下载");
            return;
        }
        Context ctx = getContext();
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT >= 26 && !ctx.getPackageManager().canRequestPackageInstalls()) {
            if (ask) {
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(s);
                } catch (Exception e) {
                    // 个别系统没有这个设置页：直接调安装界面，由系统自己提示
                    startInstaller(call, ctx, apk);
                    return;
                }
            }
            ret.put("started", false);
            ret.put("needPermission", true);
            call.resolve(ret);
            return;
        }
        startInstaller(call, ctx, apk);
    }

    private void startInstaller(PluginCall call, Context ctx, File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            JSObject ret = new JSObject();
            ret.put("started", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
    }
}
