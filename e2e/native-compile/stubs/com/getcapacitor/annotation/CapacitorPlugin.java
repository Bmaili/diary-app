package com.getcapacitor.annotation; import java.lang.annotation.*; @Retention(RetentionPolicy.RUNTIME) public @interface CapacitorPlugin { String name() default ""; }
