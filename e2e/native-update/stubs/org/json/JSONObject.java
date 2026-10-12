package org.json;
import java.util.*; import java.util.regex.*;
public class JSONObject {
  protected final LinkedHashMap<String,Object> m = new LinkedHashMap<>();
  public JSONObject(){}
  public JSONObject(String s) throws JSONException {
    Matcher x = Pattern.compile("\"([^\"]+)\":(\"([^\"]*)\"|(-?\\d+)|true|false)").matcher(s);
    boolean any=false; while (x.find()) { any=true; m.put(x.group(1), x.group(3)!=null ? x.group(3) : (x.group(4)!=null ? (Object)Long.parseLong(x.group(4)) : x.group(2))); }
    if (!any && !s.trim().equals("{}")) throw new JSONException();
  }
  public long optLong(String k,long d){ Object v=m.get(k); return v instanceof Number ? ((Number)v).longValue() : d; }
  public Object opt(String k){ return m.get(k); }
  public String toString(){ StringBuilder b=new StringBuilder("{"); for (Map.Entry<String,Object> e: m.entrySet()){ if(b.length()>1)b.append(','); b.append('"').append(e.getKey()).append("\":"); Object v=e.getValue(); if (v instanceof String) b.append('"').append(v).append('"'); else b.append(v);} return b.append('}').toString(); }
}