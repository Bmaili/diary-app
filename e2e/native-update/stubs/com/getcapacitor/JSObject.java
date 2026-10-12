package com.getcapacitor;
public class JSObject extends org.json.JSONObject {
  public JSObject(){} public JSObject(String s) throws org.json.JSONException { super(s); }
  public JSObject put(String k,Object v){ m.put(k, v instanceof Integer ? (Object)((Integer)v).longValue() : v); return this; }
  public JSObject put(String k,long v){ m.put(k,v); return this; }
  public JSObject put(String k,boolean v){ m.put(k,v); return this; }
  public String getString(String k,String d){ Object v=m.get(k); return v==null? d : String.valueOf(v); }
}