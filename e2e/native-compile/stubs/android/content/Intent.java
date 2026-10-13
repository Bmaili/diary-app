package android.content; public class Intent {
 public static final String ACTION_PICK="p", ACTION_SEND="s", ACTION_SEND_MULTIPLE="m", EXTRA_ALLOW_MULTIPLE="a", EXTRA_TEXT="t", EXTRA_SUBJECT="j", EXTRA_STREAM="st";
 public static final int FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY=0x100000;
 public Intent(String a){} public Intent setDataAndType(android.net.Uri u,String t){return this;} public Intent putExtra(String k,boolean v){return this;}
 public String getAction(){return null;} public String getType(){return null;} public CharSequence getCharSequenceExtra(String k){return null;} public String getStringExtra(String k){return null;}
 public <T extends android.os.Parcelable> java.util.ArrayList<T> getParcelableArrayListExtra(String k){return null;}
 @Deprecated public <T extends android.os.Parcelable> T getParcelableExtra(String k){return null;}
 public ClipData getClipData(){return null;} public android.net.Uri getData(){return null;} public int getFlags(){return 0;} public boolean getBooleanExtra(String k,boolean d){return d;} }
