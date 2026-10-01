#!/usr/bin/env bash
# Measure native Android TTS throughput through the loopback bridge.
#
# Every row AGENTS.md records for the bridge comes from this script, run
# against one build, so the numbers and the committed source cannot drift
# apart. Put the phone in airplane mode first if the run must prove offline.
# The /speak probe at the end plays audio on the phone itself.
set -uo pipefail
PORT=8787
TOK=$(adb logcat -d 2>/dev/null | grep -o 'TOKEN=[0-9a-f]\{32\}' | tail -1 | cut -d= -f2)
if [ -z "$TOK" ]; then echo "no token in logcat; is the app running?"; exit 1; fi
echo "token: ${TOK:0:8}..."
adb forward tcp:$PORT tcp:$PORT >/dev/null
echo "=== /health ==="; curl -s --max-time 10 "http://127.0.0.1:$PORT/health"; echo
echo "=== /voices ==="
curl -s --max-time 20 -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/voices" \
 | python3 -c "
import json,sys
v=json.load(sys.stdin)
off=[x for x in v if not x['networkRequired']]
print(' total voices:',len(v),'| offline-capable:',len(off),'| network-required:',len(v)-len(off))
for x in sorted(off,key=lambda y:-y['quality'])[:6]: print('  ',x['name'],x['locale'],'q=',x['quality'])
"

# synth LABEL RATE TEXT
synth() {
  local label=$1 rate=$2 text=$3 out=/tmp/native_${1}.wav hdr=/tmp/hdr_${1}.txt
  echo "=== POST /synthesize  [$label]  rate $rate ==="
  local h; h=$(printf '%s' "$text" | curl -s --max-time 180 -X POST \
        -H "Authorization: Bearer $TOK" -H "Content-Type: text/plain" \
        --data-binary @- -D "$hdr" -o "$out" \
        -w "http=%{http_code} wall=%{time_total}s bytes=%{size_download}" \
        "http://127.0.0.1:$PORT/synthesize?rate=$rate")
  echo "  $h"
  grep -iE "^X-(Synth-Ms|Chars|Rate):" "$hdr" | tr -d '\r' | sed 's/^/  /'
  local ranges; ranges=$(grep -i "^X-Word-Ranges:" "$hdr" | tr -d '\r' | cut -d' ' -f2-)
  echo "  word ranges reported: $(python3 -c "import json,sys;print(len(json.loads(sys.argv[1])))" "$ranges" 2>/dev/null || echo 'parse failed')"
  local dur sms
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out" 2>/dev/null)
  sms=$(grep -i "^X-Synth-Ms:" "$hdr" | tr -d '\r' | awk '{print $2}')
  echo "  audio duration: ${dur}s   synth: ${sms}ms"
  python3 - "$dur" "$sms" <<'PY'
import sys
dur=float(sys.argv[1] or 0); ms=float(sys.argv[2] or 0)
if dur>0 and ms>0:
    rtf=(ms/1000)/dur
    print(f"  RTF = {rtf:.3f}  (compute seconds per audio second)")
    print(f"  headroom vs 1x: {1/rtf:.2f}x     vs 2x target: {'PASS' if rtf<=0.5 else 'FAIL'} (need <= 0.500)")
else:
    print("  cannot compute RTF")
PY
}

LONG='The measurement of synthesis throughput requires a text long enough that model load time stops dominating the result. A short sample flatters any engine, because the first sentence is paid for by the session that was already warm. Each sentence becomes roughly one chunk, and each chunk is synthesized independently before the player hands it to the audio element. If synthesis cannot keep ahead of playback, the gap shows up as silence between chunks rather than as a slower voice.'
SHORT='The quick brown fox jumps over the lazy dog near the river bank at dawn.'

synth long_1.0  1.0 "$LONG"
synth long_2.0  2.0 "$LONG"
synth short_1.0 1.0 "$SHORT"

echo "=== POST /speak  [short]  rate 1.0  (engine plays it; word-range probe) ==="
printf '%s' "$SHORT" | curl -s --max-time 120 -X POST -H "Authorization: Bearer $TOK" \
  --data-binary @- "http://127.0.0.1:$PORT/speak?rate=1.0" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  rc',d['rc'],'| finished',d['finished'],'| error',d['error'],'| wallMs',d['wallMs'],'| chars',d['chars'],'| rangeCount',d['rangeCount'])
"
