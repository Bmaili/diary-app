package com.getcapacitor;
import java.util.*; import java.util.concurrent.*;
public class PluginCall {
  public final Map<String,Object> args = new HashMap<>(); public final CountDownLatch latch = new CountDownLatch(1);
  public volatile String error, code; public volatile JSObject result;
  public String getString(String k){ Object v=args.get(k); return v==null?null:v.toString(); }
  public String getString(String k,String d){ String v=getString(k); return v==null?d:v; }
  public Double getDouble(String k,Double d){ Object v=args.get(k); return v==null?d:((Number)v).doubleValue(); }
  public Boolean getBoolean(String k,Boolean d){ Object v=args.get(k); return v==null?d:(Boolean)v; }
  public void reject(String m){ reject(m,null); }
  public void reject(String m,String c){ error=m; code=c; latch.countDown(); }
  public void resolve(){ result=new JSObject(); latch.countDown(); }
  public void resolve(JSObject o){ result=o; latch.countDown(); }
}