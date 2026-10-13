package android.graphics; public final class ImageDecoder { public static final int ALLOCATOR_SOFTWARE=1;
 public static abstract class Source {} public static class ImageInfo { public android.util.Size getSize(){return null;} }
 public interface OnHeaderDecodedListener { void onHeaderDecoded(ImageDecoder d, ImageInfo i, Source s); }
 public static Source createSource(java.io.File f){return null;}
 public static Bitmap decodeBitmap(Source s, OnHeaderDecodedListener l) throws java.io.IOException {return null;}
 public void setTargetSize(int w,int h){} public void setAllocator(int a){} }
