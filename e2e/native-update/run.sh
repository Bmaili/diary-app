#!/usr/bin/env bash
# 应用内更新的原生下载逻辑测试（没有安卓 SDK 时用）：
# 用桩类编译 AppUpdatePlugin.java，起一个本地 HTTPS 服务器（可模拟断线、不支持分段、跳转、404），
# 用 Harness.java 直接调插件，跑断线重试、续传、换版本、sha256 不对等场景。需要 javac、python3、openssl、keytool。
# 用法：bash e2e/native-update/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'kill $SRV 2>/dev/null || true; rm -rf "$WORK"' EXIT
cd "$WORK"
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" 2>/dev/null
keytool -importcert -noprompt -alias t -file cert.pem -keystore ts.jks -storepass changeit >/dev/null 2>&1
mkdir out
javac -nowarn -encoding UTF-8 -d out $(find "$HERE/stubs" -name '*.java') "$HERE/Harness.java" \
  "$ROOT/android/app/src/main/java/app/diary/local/AppUpdatePlugin.java" 2>&1 | grep -v -E 'JAVA_TOOL|^Note:' || true
python3 "$HERE/server.py" > srv.out &
SRV=$!
for i in $(seq 1 50); do [ -s srv.out ] && break; sleep 0.1; done
read PORT SHA SIZE < srv.out
java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Djavax.net.ssl.trustStore="$WORK/ts.jks" -Djavax.net.ssl.trustStorePassword=changeit \
  -Djavax.net.ssl.trustStoreType=JKS -cp out Harness "https://127.0.0.1:$PORT" "$SHA" "$SIZE" 2>&1 | grep -v JAVA_TOOL
