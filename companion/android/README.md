# TTS Bridge (Android companion, prototype)

A small Android app that exposes the phone's own text-to-speech engine to the
plugin over loopback HTTP. **Prototype.** It is not wired into the plugin, it is
signed with a throwaway debug key, and it is not distributed anywhere.

## Why it exists

Obsidian's Android WebView gives a plugin no speech API at all:
`window.speechSynthesis` is undefined and its Capacitor bridge compiles in no
TextToSpeech plugin (re-measured on Chromium 154). Kokoro in the WebView works,
but it is capped at one WASM thread there, because the page is not
cross-origin isolated and so has no `SharedArrayBuffer`. Measured on a Pixel 9
Pro XL, that misses 2x playback by 8.2x.

What the WebView *can* do is reach `http://127.0.0.1`, since Obsidian serves its
page from `http://localhost`. This app sits on the other end of that.

Measured offline through this app on the same phone, native TTS runs at RTF
0.108 to 0.120 (8 to 9 times faster than real time) and passes 2x with 4.6x of
margin. Full numbers, method and caveats are in `AGENTS.md` under "Android
playback throughput, and the native-TTS bridge".

## What it does

| route | method | auth | purpose |
|---|---|---|---|
| `/health` | GET | none | `{ok, ttsReady, engine, port}` |
| `/voices` | GET | token | every voice, with `networkRequired` and `quality` |
| `/engines` | GET | token | engines visible to the app, and the current one |
| `/setengine?engine=<pkg>` | GET | token | rebind to a named engine (untested: one engine on the test device) |
| `/synthesize?rate=<f>` | POST | token | text in the body, returns `audio/wav` |
| `/speak?rate=<f>` | POST | token | probe only: the engine plays audio itself |

`/synthesize` also returns `X-Synth-Ms`, `X-Chars`, `X-Rate` and
`X-Word-Ranges` headers.

Three choices are load-bearing, so do not "simplify" them away:

- **The `TTS_SERVICE` query in the manifest.** On Android 11+ an app that
  targets API 30 or later cannot see or bind a TTS engine without it. A
  prebuilt bridge (`it.eja.ttsserver`) omits it and fails every request with
  `not bound to TTS engine`.
- **Loopback only.** The socket binds `127.0.0.1`, never `0.0.0.0`, so nothing
  on the LAN can reach it.
- **Text in the POST body, never the URL.** A URL lands in logs the way argv
  lands in `ps`, which is the reason behind the plugin's own non-negotiable 2.

Every route except `/health` requires `Authorization: Bearer <token>`. The token
is 32 random hex characters, made fresh at each launch and shown on screen.
**This prototype also writes it to logcat** so the measurement script can read
it. A shipped build must not.

## Engine facts that shape the plugin side

- **Rate is applied at synthesis.** At rate 2.0 the WAV itself is half as long.
  An engine built on this must own its rate, and the plugin's Player must not
  apply rate a second time (non-negotiable 9).
- **No word timings** from GrapheneOS Speech Services, by `synthesizeToFile`
  or by `speak()`. The plugin already has the slot for that: declare
  `timing: "none"`, as `speechd.ts` does, and keep the sentence highlight.

## Known gaps

- **No `OPTIONS` handler.** A WebView `fetch` that sends `Authorization` will
  fail its CORS preflight. `CapacitorHttp` would not hit this.
- **No foreground service.** It serves only while its screen is alive.
  Whether the plugin can launch it from the WebView is untested.
- **The plugin-to-bridge path has never run end to end.** The WebView reached a
  loopback socket, and the bridge was reached from a host over `adb forward`,
  but the two were never joined.
- Not built with gradle, so it is not ready for F-Droid or Play as-is.

## Build

Needs an Android SDK with `build-tools;34.0.0` and `platforms;android-34`, and a
JDK with `javac` (a JRE is not enough).

```bash
./build.sh          # -> build/ttsbridge.apk
adb install -r build/ttsbridge.apk
```

Override `ANDROID_HOME` and `JAVA_HOME` from the environment if the defaults in
`build.sh` do not match your machine.

**d8 trap:** d8 8.2.2 fails to dex an *anonymous* `UtteranceProgressListener`
here, with `NullPointerException: Cannot invoke "String.length()"`. Neither
`-g:none` nor `--release 11` fixes it, but a named nested class does, which is
why `Tap` and `Init` are named.

## Measure

With the app open on a phone connected over adb:

```bash
./measure.sh
```

This reads the token from logcat, forwards port 8787, lists voices, then
synthesizes the same passage at rate 1.0 and 2.0 and prints the real-time factor
(RTF) for each. Put the phone in airplane mode first if the run has to prove the
speech is offline.
