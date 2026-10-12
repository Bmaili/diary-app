// 应用内更新原生下载逻辑的测试程序，见 run.sh。直接调用 AppUpdatePlugin，模拟各种网络情况。

import app.diary.local.AppUpdatePlugin; import com.getcapacitor.*; import java.io.*; import java.nio.file.*; import java.util.concurrent.*;
public class Harness {
  static String base; static File cache; static int fails=0;
  static AppUpdatePlugin plugin() {
    AppUpdatePlugin p = new AppUpdatePlugin();
    p.ctx = new android.content.Context(){ public File getCacheDir(){return cache;} public String getPackageName(){return "app.diary.local";}
      public android.content.pm.PackageManager getPackageManager(){ return new android.content.pm.PackageManager(){
        public android.content.pm.PackageInfo getPackageInfo(String n,int f) throws NameNotFoundException { throw new NameNotFoundException(); }
        public android.content.pm.PackageInfo getPackageArchiveInfo(String a,int f){return null;} public boolean canRequestPackageInstalls(){return true;} }; }
      public void startActivity(android.content.Intent i){} };
    return p;
  }
  static PluginCall call(String method, Object... kv) throws Exception {
    AppUpdatePlugin p = plugin(); PluginCall c = new PluginCall();
    for (int i=0;i<kv.length;i+=2) c.args.put((String)kv[i], kv[i+1]);
    AppUpdatePlugin.class.getMethod(method, PluginCall.class).invoke(p, c);
    if (!c.latch.await(60, TimeUnit.SECONDS)) throw new RuntimeException("timeout");
    lastPlugin = p; return c;
  }
  static AppUpdatePlugin lastPlugin;
  static void check(String name, boolean ok, String detail){ System.out.println((ok?"PASS  ":"FAIL  ")+name+(detail.isEmpty()?"":"  ("+detail+")")); if(!ok) fails++; }
  static void mode(String m) throws Exception { new java.net.URL(base+"/mode?"+m).openStream().close(); }
  static long reqs() throws Exception { try (InputStream in=new java.net.URL(base+"/stats").openStream()){ return Long.parseLong(new String(in.readAllBytes()).trim()); } }
  public static void main(String[] a) throws Exception {
    base=a[0]; cache=Files.createTempDirectory("upd").toFile(); String sha=a[1]; long size=Long.parseLong(a[2]); String url=base+"/apk";
    Object[] args = { "url", url, "sha256", sha, "size", (double)size, "version", "1.0.20" };
    // 1. 正常下载（经过一次跳转）
    mode("ok"); PluginCall c = call("download", concat(args, "offset", 0d));
    check("正常下载（带跳转）", c.error==null && new File(cache,"update/diary-update.apk").length()==size, String.valueOf(c.error));
    // 2. 第一次在 40% 断线：悄悄重试一次，从断点接着下，最终 sha256 正确
    mode("drop1"); c = call("download", concat(args, "offset", 0d));
    check("断一次线：自动重试并续传成功", c.error==null, String.valueOf(c.error));
    check("  重试时带了 Range", lastRange().startsWith("bytes="), lastRange());
    // 3. 一直断线：重试一次后报错，半截文件保留；partial() 报出已下载的字节
    mode("dropAll"); c = call("download", concat(args, "offset", 0d));
    PluginCall pc = call("partial"); long bytes = pc.result.optLong("bytes",-1);
    check("一直断线：报错并保留半截文件", c.error!=null && bytes>0 && bytes<size, c.error+" bytes="+bytes);
    check("  partial() 记下了版本和 sha256", "1.0.20".equals(pc.result.getString("version","")) && sha.equals(pc.result.getString("sha256","")), pc.result.toString());
    // 4. 网络恢复后带 offset 续传：只下剩下的部分，进度从断点开始
    mode("ok"); c = call("download", concat(args, "offset", (double)bytes));
    check("恢复后续传成功", c.error==null && new File(cache,"update/diary-update.apk").length()==size, String.valueOf(c.error));
    check("  从断点开始（进度起点 = 已下载字节）", lastPlugin.firstDone==bytes, "first="+lastPlugin.firstDone+" bytes="+bytes);
    check("  续传请求带 Range: bytes="+bytes+"-", lastRange().equals("bytes="+bytes+"-"), lastRange());
    check("  完成后不再有半截文件", call("partial").result.optLong("bytes",-1)==-1, "");
    // 5. 版本变了（11 下了一半，12 上了）：即使 JS 给了 offset，也从头下
    mode("dropAll"); call("download", concat(args, "offset", 0d)); long b5 = call("partial").result.optLong("bytes",-1);
    mode("ok"); c = call("download", "url", url, "sha256", sha, "size", (double)size, "version", "1.0.21", "offset", (double)b5);
    check("版本不同：从头下，不续传", c.error==null && lastPlugin.firstDone==0 && lastRange().equals("-"), "first="+lastPlugin.firstDone+" range="+lastRange());
    // 6. 服务器不支持分段（返回 200 整个文件）：从头写，结果仍正确
    mode("dropAll"); call("download", concat(args, "offset", 0d)); long b6 = call("partial").result.optLong("bytes",-1);
    mode("noRange"); c = call("download", concat(args, "offset", (double)b6));
    check("服务器忽略 Range：从头写，校验通过", c.error==null && new File(cache,"update/diary-update.apk").length()==size, String.valueOf(c.error));
    // 7. 半截文件比记录的短（磁盘上的对不上）：从头下
    mode("dropAll"); call("download", concat(args, "offset", 0d)); long b7 = call("partial").result.optLong("bytes",-1);
    mode("ok"); c = call("download", concat(args, "offset", (double)(b7+1000)));
    check("磁盘上的文件长度对不上：从头下", c.error==null && lastPlugin.firstDone==0, "first="+lastPlugin.firstDone);
    // 8. sha256 不对：报错，并删掉半截文件（下次从头下）
    mode("ok"); c = call("download", "url", url, "sha256", "00"+sha.substring(2), "size", (double)size, "version", "1.0.20", "offset", 0d);
    check("sha256 不对：报错并清掉", c.error!=null && c.error.contains("校验") && call("partial").result.optLong("bytes",-1)==-1 && !new File(cache,"update/diary-update.apk").exists(), String.valueOf(c.error));
    // 9. 下载地址 404：报错，半截文件作废
    mode("dropAll"); call("download", concat(args, "offset", 0d));
    mode("gone"); c = call("download", concat(args, "offset", (double)call("partial").result.optLong("bytes",-1)));
    check("地址失效（404）：报错并清掉半截文件", c.error!=null && call("partial").result.optLong("bytes",-1)==-1, String.valueOf(c.error));
    System.out.println(fails==0 ? "ALL PASS" : fails+" FAILED");
    System.exit(fails==0?0:1);
  }
  static String lastRange() throws Exception { try (InputStream in=new java.net.URL(base+"/lastrange").openStream()){ return new String(in.readAllBytes()).trim(); } }
  static Object[] concat(Object[] a, Object... b){ Object[] r=java.util.Arrays.copyOf(a,a.length+b.length); System.arraycopy(b,0,r,a.length,b.length); return r; }
}
