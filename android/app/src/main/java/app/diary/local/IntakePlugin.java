package app.diary.local;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 把别处的内容收进 app（2026-10-13 加入）。两件事共用“把 content:// 文件复制到缓存目录”的代码：
 *
 * 1. 选图：pickImages({ multiple }) 用 ACTION_PICK 调起手机自带的相册（能看到所有文件夹，可以多选，
 *    不需要存储权限：相册把选中的图临时授权给我们读）。没有相册可用时报 UNAVAILABLE，
 *    读不了（相册没给授权）时报 DENIED，JS 退回系统的选择器。
 *    → { files: [{ path, name, mime, size }], cancelled? }
 *
 * 2. 分享进来：别的 app 用“分享”发来文字、链接、图片或 zip（AndroidManifest 里 SEND / SEND_MULTIPLE）。
 *    冷启动时在 load() 里取，app 已经开着时在 handleOnNewIntent 里取。复制好之后发 'share' 事件，
 *    retainUntilConsumed：JS 还没开始监听（冷启动）时先留着，监听上了再发。
 *    → { text, subject, files: [...], skipped }
 *    处理过的分享在 intent 上做个记号；从最近任务重新打开、或进程被杀后重建时不再重复处理。
 *
 * 缓存文件在 cacheDir/intake/ 下，JS 用完后调 clean()；启动时也会清掉上次留下的。
 */
@CapacitorPlugin(name = "Intake")
public class IntakePlugin extends Plugin {

    static final String CONSUMED = "app.diary.local.SHARE_CONSUMED";
    private static final String DIR = "intake";
    /** 分享进来的文字文件最多读这么多（再长的不像是要贴进日记的） */
    private static final int MAX_TEXT = 512 * 1024;
    /** 一次最多收这么多个文件 */
    private static final int MAX_FILES = 30;

    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        pool.execute(this::wipe);
        Activity a = getActivity();
        if (a != null) take(a.getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        take(intent);
    }

    private File dir() {
        File d = new File(getContext().getCacheDir(), DIR);
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private void wipe() {
        File[] files = dir().listFiles();
        if (files != null) for (File f : files) f.delete();
    }

    /** 删掉用完的缓存文件：给了 paths 只删这几个（之后又分享进来的不受影响），没给就全删 */
    @PluginMethod
    public void clean(final PluginCall call) {
        final JSArray paths = call.getArray("paths");
        pool.execute(() -> {
            if (paths == null) wipe();
            else {
                File d = dir();
                for (int i = 0; i < paths.length(); i++) {
                    File f = new File(paths.optString(i, ""));
                    if (d.equals(f.getParentFile())) f.delete();
                }
            }
            call.resolve();
        });
    }

    // ---------- 选图 ----------

    @PluginMethod
    public void pickImages(final PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_PICK);
        intent.setDataAndType(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "image/*");
        if (call.getBoolean("multiple", true)) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(call, intent, "picked");
        } catch (ActivityNotFoundException e) {
            call.reject("手机上没有找到相册", "UNAVAILABLE");
        } catch (Exception e) {
            call.reject("打不开相册：" + e.getMessage(), "UNAVAILABLE");
        }
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            JSObject ret = new JSObject();
            ret.put("files", new JSArray());
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        final List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        }
        if (uris.isEmpty() && data.getData() != null) uris.add(data.getData());
        pool.execute(() -> {
            JSArray files = new JSArray();
            int denied = 0;
            String lastError = "";
            for (int i = 0; i < uris.size() && i < MAX_FILES; i++) {
                try {
                    files.put(copy(uris.get(i), "pick", i, null));
                } catch (SecurityException e) {
                    denied++;
                    lastError = e.getMessage();
                } catch (Exception e) {
                    lastError = e.getMessage();
                }
            }
            if (files.length() == 0 && !uris.isEmpty()) {
                if (denied > 0) call.reject("相册没有允许读取这张图", "DENIED");
                else call.reject("读取图片失败：" + lastError, "FAILED");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("files", files);
            ret.put("skipped", Math.max(0, uris.size() - files.length()));
            call.resolve(ret);
        });
    }

    // ---------- 分享进来 ----------

    private static boolean isShare(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        if (intent.getBooleanExtra(CONSUMED, false)) return false;
        return (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0;
    }

    @SuppressWarnings("deprecation")
    private void take(Intent intent) {
        if (!isShare(intent)) return;
        intent.putExtra(CONSUMED, true);
        final String type = intent.getType();
        CharSequence cs = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        final String text = cs == null ? "" : cs.toString();
        final String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        final List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) for (Uri u : list) if (u != null) uris.add(u);
        } else {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        }
        ClipData clip = intent.getClipData();
        if (uris.isEmpty() && clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        }
        pool.execute(() -> {
            JSObject ret = new JSObject();
            JSArray files = new JSArray();
            StringBuilder body = new StringBuilder(text);
            int skipped = 0;
            for (int i = 0; i < uris.size(); i++) {
                Uri u = uris.get(i);
                try {
                    String mime = mimeOf(u, type);
                    if (mime.startsWith("text/") && body.length() == 0) {
                        // 分享来的是文字文件（备忘录导出的 .txt、.md）：读出来当文字
                        body.append(readText(u));
                    } else if (files.length() < MAX_FILES) {
                        files.put(copy(u, "share", i, type));
                    } else skipped++;
                } catch (Exception e) {
                    skipped++;
                }
            }
            ret.put("text", body.toString());
            ret.put("subject", subject == null ? "" : subject);
            ret.put("files", files);
            ret.put("skipped", skipped);
            notifyListeners("share", ret, true);
        });
    }

    // ---------- 复制 ----------

    private String mimeOf(Uri uri, String fallback) {
        String mime = null;
        try {
            mime = getContext().getContentResolver().getType(uri);
        } catch (Exception ignored) {
            // 有的提供方不支持 getType
        }
        if (mime == null || mime.isEmpty()) mime = fallback;
        return mime == null ? "" : mime;
    }

    private String nameOf(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
                // 拿不到名字就用路径的最后一段
            }
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment();
        return name == null ? "" : name;
    }

    private static String extOf(String name, String mime) {
        int dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length() - 1) {
            String e = name.substring(dot + 1).toLowerCase().replaceAll("[^a-z0-9]", "");
            if (!e.isEmpty() && e.length() <= 5) return e;
        }
        if (mime.endsWith("/jpeg")) return "jpg";
        if (mime.endsWith("/png")) return "png";
        if (mime.endsWith("/webp")) return "webp";
        if (mime.endsWith("/gif")) return "gif";
        if (mime.endsWith("/heic") || mime.endsWith("/heif")) return "heic";
        if (mime.endsWith("/zip") || mime.endsWith("x-zip-compressed")) return "zip";
        return "bin";
    }

    /** 把一个 content:// 文件复制到缓存目录，返回 { path, name, mime, size } */
    private JSObject copy(Uri uri, String prefix, int i, String fallbackMime) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        String mime = mimeOf(uri, fallbackMime);
        String name = nameOf(uri);
        File out = new File(dir(), prefix + "_" + System.currentTimeMillis() + "_" + i + "." + extOf(name, mime));
        long size = 0;
        try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (in == null) throw new Exception("读不到文件");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                size += n;
            }
        } catch (Exception e) {
            out.delete();
            throw e;
        }
        if (isHeif(mime, name)) {
            // WebView 解不了 HEIC / HEIF（不少手机拍照默认存这种格式），在这里转成 JPEG
            File jpg = heifToJpeg(out);
            if (jpg != null) {
                out.delete();
                out = jpg;
                mime = "image/jpeg";
                size = jpg.length();
            }
        }
        JSObject f = new JSObject();
        f.put("path", out.getAbsolutePath());
        f.put("name", name);
        f.put("mime", mime);
        f.put("size", size);
        return f;
    }

    private static boolean isHeif(String mime, String name) {
        String n = name.toLowerCase();
        return mime.endsWith("/heic") || mime.endsWith("/heif") || n.endsWith(".heic") || n.endsWith(".heif");
    }

    /** 解码时长边先缩到这么大（日记里存的图长边 2560），省内存 */
    private static final int MAX_EDGE = 4096;

    /** 用系统的 ImageDecoder（安卓 9 起，会按 EXIF 转正方向）解 HEIF 再存成 JPEG；失败返回 null */
    private File heifToJpeg(File src) {
        if (Build.VERSION.SDK_INT < 28) return null;
        File out = new File(src.getPath().replaceAll("\\.[^.]+$", "") + ".jpg");
        try {
            Bitmap bmp = ImageDecoder.decodeBitmap(ImageDecoder.createSource(src), (decoder, info, source) -> {
                int w = info.getSize().getWidth();
                int h = info.getSize().getHeight();
                int edge = Math.max(w, h);
                if (edge > MAX_EDGE) decoder.setTargetSize(Math.max(1, w * MAX_EDGE / edge), Math.max(1, h * MAX_EDGE / edge));
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            });
            try (OutputStream os = new FileOutputStream(out)) {
                bmp.compress(Bitmap.CompressFormat.JPEG, 92, os);
            } finally {
                bmp.recycle();
            }
            return out;
        } catch (Throwable e) {
            out.delete();
            return null;
        }
    }

    private String readText(Uri uri) throws Exception {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) return "";
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0 && bos.size() < MAX_TEXT) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
