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
import java.nio.charset.StandardCharsets;
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
 *   download({ url, sha256, size, version, offset }) → { path }；partial() → { version, sha256, size, bytes }
 *   cancel()；install({ path, askPermission }) → { started, needPermission? }；clean()
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

    /** 下载到一半时的文件和它的“身份”（版本、大小、sha256），续传前用来核对是不是同一个文件 */
    private File partFile() { return new File(dir(), "download.part"); }
    private File metaFile() { return new File(dir(), "download.json"); }

    /** 断线后悄悄再试几次（2026-10-12：只试一次，主要应对 Wi-Fi 和移动网络切换） */
    private static final int RETRIES = 1;

    /** 下到一半的文件：{ version, sha256, size, bytes }；没有返回空对象 */
    @PluginMethod
    public void partial(final PluginCall call) {
        pool.execute(() -> {
            JSObject ret = new JSObject();
            try {
                File part = partFile();
                File meta = metaFile();
                if (part.exists() && meta.exists()) {
                    JSObject m = new JSObject(new String(readAll(meta), StandardCharsets.UTF_8));
                    ret.put("version", m.getString("version", ""));
                    ret.put("sha256", m.getString("sha256", ""));
                    ret.put("size", m.optLong("size", 0));
                    ret.put("bytes", part.length());
                }
            } catch (Exception ignored) {
                // 记录坏了：当作没有
            }
            call.resolve(ret);
        });
    }

    /**
     * 下载。offset > 0 时从这个位置接着下（2026-10-12 加入断点续传）：
     * 由 JS 先核对版本、大小、sha256 和上次记下的一致才会给 offset；这里再核对一遍磁盘上的文件，
     * 对不上就从头下。服务器不支持分段（返回 200）或分段对不上时也从头下。
     * 失败或取消时保留下了一半的文件，下次接着下；sha256 不对时删掉，下次从头下。
     */
    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url");
        final String sha256 = call.getString("sha256", "");
        final String version = call.getString("version", "");
        // 不用 getLong：JS 传来的整数解析成 Integer，getLong 会直接返回默认值
        final long size = call.getDouble("size", 0d).longValue();
        final long wantOffset = call.getDouble("offset", 0d).longValue();
        if (url == null || !url.startsWith("https://")) {
            call.reject("下载地址不对");
            return;
        }
        cancelled = false;
        pool.execute(() -> {
            HttpURLConnection conn = null;
            File part = partFile();
            try {
                long offset = wantOffset;
                if (offset > 0 && !(sameMeta(version, sha256, size) && part.length() == offset && offset < size)) offset = 0;
                if (offset == 0) {
                    wipe();
                    JSObject m = new JSObject();
                    m.put("version", version);
                    m.put("sha256", sha256);
                    m.put("size", size);
                    try (OutputStream o = new FileOutputStream(metaFile())) {
                        o.write(m.toString().getBytes(StandardCharsets.UTF_8));
                    }
                }
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                // 续传：先把已经下好的部分算进摘要
                if (offset > 0) digestFile(md, part);
                long total = size;
                int attempt = 0;
                while (true) {
                    try {
                        conn = open(url, offset);
                        int status = conn.getResponseCode();
                        if (offset > 0 && status == 206) {
                            long[] cr = contentRange(conn.getHeaderField("Content-Range"));
                            if (cr == null || cr[0] != offset || (size > 0 && cr[1] != size)) {
                                // 分段对不上：从头下
                                conn.disconnect();
                                offset = 0;
                                md.reset();
                                conn = open(url, 0);
                                status = conn.getResponseCode();
                            }
                        } else if (offset > 0 && status == 200) {
                            // 服务器不支持分段，给了整个文件：从头写
                            offset = 0;
                            md.reset();
                        }
                        if (status < 200 || status >= 300) throw new HttpError(status);
                        if (offset == 0 && conn.getContentLength() > 0) total = conn.getContentLength();
                        long done = offset;
                        long lastNotify = 0;
                        progress(done, total);
                        try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part, offset > 0)) {
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
                        if (size > 0 && done != size) throw new java.io.IOException("连接提前断开");
                        break;
                    } catch (java.io.IOException e) {
                        // 网络断开、30 秒收不到数据：从断开的地方再试，次数用完就报错（下好的部分留着）
                        if (cancelled) throw new InterruptedException();
                        if (attempt++ >= RETRIES) throw e;
                        if (conn != null) conn.disconnect();
                        conn = null;
                        Thread.sleep(3000);
                        if (cancelled) throw new InterruptedException();
                        offset = part.length();
                        if (offset >= size && size > 0) offset = 0;
                        if (offset == 0) md.reset();
                    }
                }
                if (sha256 != null && !sha256.isEmpty() && !hex(md.digest()).equalsIgnoreCase(sha256)) {
                    wipe();
                    throw new Exception("文件校验不通过（可能下载时损坏了），请重试");
                }
                File apk = new File(dir(), "diary-update.apk");
                if (!part.renameTo(apk)) throw new Exception("保存文件失败");
                metaFile().delete();
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
            } catch (HttpError e) {
                // 下载地址失效（例如新版发布后旧的安装包被替换）：下了一半的作废
                if (e.status == 404 || e.status == 410 || e.status == 416) wipe();
                call.reject("HTTP " + e.status, "FAILED");
            } catch (Exception e) {
                if (cancelled) call.reject("已取消", "CANCELLED");
                else call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), "FAILED");
            } finally {
                active = null;
                if (conn != null) conn.disconnect();
            }
        });
    }

    private static class HttpError extends Exception {
        final int status;
        HttpError(int status) {
            super("HTTP " + status);
            this.status = status;
        }
    }

    /**
     * 打开连接。自己跟随跳转（GitHub 会跳到一个有时效的下载地址），保证每一跳都带上 Range；
     * 每次续传都从原始地址重新拿跳转，不复用过期的临时地址。
     */
    private HttpURLConnection open(String url, long offset) throws Exception {
        String u = url;
        for (int hop = 0; hop < 6; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
            active = c;
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "diary-app");
            if (offset > 0) c.setRequestProperty("Range", "bytes=" + offset + "-");
            if (cancelled) throw new InterruptedException();
            int status = c.getResponseCode();
            if (status >= 300 && status < 400) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) throw new Exception("下载地址跳转出错");
                URL next = new URL(new URL(u), loc);
                if (!"https".equals(next.getProtocol())) throw new Exception("下载地址不是 https");
                u = next.toString();
                continue;
            }
            return c;
        }
        throw new Exception("下载地址跳转次数太多");
    }

    /** Content-Range: bytes 100-999/1000 → [100, 1000]；格式不对返回 null */
    private static long[] contentRange(String h) {
        if (h == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("bytes\\s+(\\d+)-(\\d+)/(\\d+)").matcher(h.trim());
        if (!m.find()) return null;
        return new long[] { Long.parseLong(m.group(1)), Long.parseLong(m.group(3)) };
    }

    private boolean sameMeta(String version, String sha256, long size) {
        try {
            JSObject m = new JSObject(new String(readAll(metaFile()), StandardCharsets.UTF_8));
            return version.equals(m.getString("version", "")) && sha256.equalsIgnoreCase(m.getString("sha256", ""))
                && size == m.optLong("size", -1) && !sha256.isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    private static byte[] readAll(File f) throws java.io.IOException {
        try (InputStream in = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static void digestFile(MessageDigest md, File f) throws java.io.IOException {
        try (InputStream in = new java.io.FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
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
