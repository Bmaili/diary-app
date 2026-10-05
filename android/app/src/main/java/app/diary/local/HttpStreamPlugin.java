package app.diary.local;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 流式 HTTP（AI 问答逐字显示用）。Capacitor 自带的 HTTP 插件要等整个响应收完才返回，
 * 网页里的 fetch 又受跨域限制（很多 AI 服务不允许），所以自己写一个：
 * 原生发请求，每收到一行就通过 "line" 事件交给网页，读完后 request() 才返回。
 *
 * JS：registerPlugin('HttpStream')
 *   addListener('line', ({ id, line }) => …)
 *   request({ id, url, method, headers, body, timeoutMs }) → { status, body? }（非 2xx 时 body 是错误内容）
 *   cancel({ id }) 停止
 */
@CapacitorPlugin(name = "HttpStream")
public class HttpStreamPlugin extends Plugin {

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> active = new ConcurrentHashMap<>();

    @PluginMethod
    public void request(final PluginCall call) {
        final String id = call.getString("id", "");
        final String url = call.getString("url");
        final String method = call.getString("method", "POST");
        final JSObject headers = call.getObject("headers", new JSObject());
        final String body = call.getString("body");
        final int timeout = call.getInt("timeoutMs", 120000);
        if (url == null) {
            call.reject("缺少 url");
            return;
        }
        pool.execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                active.put(id, conn);
                conn.setRequestMethod(method);
                conn.setConnectTimeout(Math.min(timeout, 30000));
                // 两次收到数据之间最长等多久
                conn.setReadTimeout(timeout);
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    String v = headers.getString(k);
                    if (v != null) conn.setRequestProperty(k, v);
                }
                if (body != null) {
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(bytes);
                    }
                }
                int status = conn.getResponseCode();
                JSObject ret = new JSObject();
                ret.put("status", status);
                if (status < 200 || status >= 300) {
                    InputStream err = conn.getErrorStream();
                    ret.put("body", err == null ? "" : readAll(err));
                    call.resolve(ret);
                    return;
                }
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        JSObject ev = new JSObject();
                        ev.put("id", id);
                        ev.put("line", line);
                        notifyListeners("line", ev);
                    }
                }
                call.resolve(ret);
            } catch (Exception e) {
                String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                call.reject(msg, e instanceof SocketTimeoutException ? "TIMEOUT" : "NETWORK");
            } finally {
                active.remove(id);
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        final HttpURLConnection conn = active.remove(call.getString("id", ""));
        if (conn != null) pool.execute(conn::disconnect);
        call.resolve();
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        in.close();
        return new String(buf.toByteArray(), StandardCharsets.UTF_8);
    }
}
