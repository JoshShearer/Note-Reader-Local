#!/usr/bin/env bash
# Measure native Android TTS throughput through the loopback bridge.
set -uo pipefail
PORT=8787
TOK=$(adb logcat -d 2>/dev/null | grep -o 'TOKEN=[0-9a-f]\{32\}' | tail -1 | cut -d= -f2)
if [ -z "$TOK" ]; then echo "no token in logcat; is the app running?"; exit 1; fi
echo "token: ${TOK:0:8}..."
adb forward tcp:$PORT tcp:$PORT >/dev/null
echo "=== /health ==="; curl -s --max-time 10 "http://127.0.0.1:$PORT/health"; echo
echo "=== /voices (offline-capable only shown) ==="
curl -s --max-time 20 -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/voices" \
 | python3 -c "
import json,sys
v=json.load(sys.stdin)
print(' total voices:',len(v))
off=[x for x in v if not x['networkRequired']]
print(' offline-capable:',len(off))
print(' network-required:',len(v)-len(off))
for x in sorted(off,key=lambda y:-y['quality'])[:6]: print('  ',x['name'],x['locale'],'q=',x['quality'])
"
SENT='The measurement of synthesis throughput requires a text long enough that model load time stops dominating the result. A short sample flatters any engine, because the first sentence is paid for by the session that was already warm. Each sentence becomes roughly one chunk, and each chunk is synthesized independently before the player hands it to the audio element. If synthesis cannot keep ahead of playback, the gap shows up as silence between chunks rather than as a slower voice.'
for RATE in 1.0 2.0; do
  echo "=== POST /synthesize at rate $RATE ==="
  OUT=/tmp/native_${RATE}.wav
  H=$(printf '%s' "$SENT" | curl -s --max-time 180 -X POST \
        -H "Authorization: Bearer $TOK" -H "Content-Type: text/plain" \
        --data-binary @- -D /tmp/hdr_$RATE.txt -o "$OUT" \
        -w "http=%{http_code} wall=%{time_total}s bytes=%{size_download}" \
        "http://127.0.0.1:$PORT/synthesize?rate=$RATE")
  echo "  $H"
  grep -iE "^X-(Synth-Ms|Chars|Rate):" /tmp/hdr_$RATE.txt | tr -d '\r' | sed 's/^/  /'
  RANGES=$(grep -i "^X-Word-Ranges:" /tmp/hdr_$RATE.txt | tr -d '\r' | cut -d' ' -f2-)
  echo "  word ranges reported: $(python3 -c "import json,sys;print(len(json.loads(sys.argv[1])))" "$RANGES" 2>/dev/null || echo 'parse failed')"
  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null)
  SMS=$(grep -i "^X-Synth-Ms:" /tmp/hdr_$RATE.txt | tr -d '\r' | awk '{print $2}')
  echo "  audio duration: ${DUR}s   synth: ${SMS}ms"
  python3 - "$DUR" "$SMS" "$RATE" <<'PY'
import sys
dur=float(sys.argv[1] or 0); ms=float(sys.argv[2] or 0); rate=float(sys.argv[3])
if dur>0 and ms>0:
    rtf=(ms/1000)/dur
    print(f"  RTF = {rtf:.3f}  (compute seconds per audio second)")
    print(f"  headroom vs 1x: {1/rtf:.2f}x     vs 2x target: {'PASS' if rtf<=0.5 else 'FAIL'} (need <= 0.500)")
else:
    print("  cannot compute RTF")
PY
done
