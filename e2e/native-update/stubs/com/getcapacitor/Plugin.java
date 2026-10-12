package com.getcapacitor;
public class Plugin { public android.content.Context ctx; public long lastDone=-1, firstDone=-1;
  public android.content.Context getContext(){return ctx;}
  protected void notifyListeners(String e,JSObject d){ long v=d.optLong("done",-1); if(firstDone<0) firstDone=v; lastDone=v; } }