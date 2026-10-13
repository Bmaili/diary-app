#!/usr/bin/env bash
# 没有安卓 SDK 时的编译检查（2026-10-13 加入）：用桩类编译 IntakePlugin（选图、分享进来）、
# PrintPlugin（年度日记本）和 MainActivity，查出拼写、类型、漏 import 这类错误。
# 桩类只声明用到的接口，不代表真实行为；最终以 CI 的安卓构建为准。
# 用法：bash e2e/native-compile/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$ROOT/android/app/src/main/java/app/diary/local"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
# 其他插件的桩：MainActivity 只需要它们是 Plugin 的子类
for p in PrivacyScreenPlugin HttpStreamPlugin BiometricPlugin AppUpdatePlugin; do
  printf 'package app.diary.local; public class %s extends com.getcapacitor.Plugin {}\n' "$p" > "$OUT/$p.java"
done
javac -Xlint:unchecked -encoding UTF-8 -d "$OUT/classes" $(find "$HERE/stubs" -name '*.java') "$OUT"/*.java \
  "$SRC/IntakePlugin.java" "$SRC/PrintPlugin.java" "$SRC/MainActivity.java" 2>&1 | grep -v -E 'JAVA_TOOL|^Note:' || true
test -f "$OUT/classes/app/diary/local/IntakePlugin.class" && test -f "$OUT/classes/app/diary/local/PrintPlugin.class" \
  && test -f "$OUT/classes/app/diary/local/MainActivity.class" && echo "编译通过"
