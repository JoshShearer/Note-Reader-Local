#!/usr/bin/env bash
# Build the TTS Bridge APK without gradle: aapt2 link, javac, d8, zipalign,
# apksigner. Output: build/ttsbridge.apk, signed with a local debug key.
#
# Needs an Android SDK with build-tools 34.0.0 and platform android-34, and a
# JDK (javac), not just a JRE. Override any of these from the environment:
#   ANDROID_HOME  default $HOME/Android/Sdk
#   JAVA_HOME     default: the path in $HOME/Android/tools/jdk-path.txt, else
#                 whatever `javac` on PATH belongs to
set -euo pipefail
cd "$(dirname "$0")"

SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
BT=$SDK/build-tools/34.0.0
AJ=$SDK/platforms/android-34/android.jar
if [ -z "${JAVA_HOME:-}" ]; then
  if [ -f "$HOME/Android/tools/jdk-path.txt" ]; then
    JAVA_HOME=$(cat "$HOME/Android/tools/jdk-path.txt")
  elif command -v javac >/dev/null; then
    JAVA_HOME=$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")
  fi
fi
for f in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$AJ" "${JAVA_HOME:-/nonexistent}/bin/javac"; do
  [ -e "$f" ] || { echo "missing: $f (see README.md)" >&2; exit 1; }
done

rm -rf build && mkdir -p build/classes build/dex
[ -f debug.keystore ] || "$JAVA_HOME/bin/keytool" -genkeypair -keystore debug.keystore \
  -storepass android -keypass android -alias d -keyalg RSA -keysize 2048 \
  -validity 10000 -dname "CN=debug" >/dev/null 2>&1

echo "aapt2 link"
"$BT/aapt2" link -o build/base.apk -I "$AJ" --manifest AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 34
echo "javac"
"$JAVA_HOME/bin/javac" -source 17 -target 17 -nowarn -Xlint:-options -classpath "$AJ" \
  -d build/classes src/io/loopstring/ttsbridge/*.java
echo "d8"
"$BT/d8" --release --lib "$AJ" --min-api 26 --output build/dex \
  $(find build/classes -name '*.class')
echo "package, align, sign"
( cd build && zip -qj base.apk dex/classes.dex && "$BT/zipalign" -f 4 base.apk aligned.apk )
"$BT/apksigner" sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias d --out build/ttsbridge.apk build/aligned.apk
"$BT/apksigner" verify build/ttsbridge.apk
ls -l build/ttsbridge.apk
