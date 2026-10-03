# 0036. An optional Read Me Offline bridge engine on Android

- Status: accepted
- Date: 2026-10-02
- Ticket: NRL-130
- Requirements: R-M03 (primary), R-M01 and "Won't Have - MVP" (amended), R-S01, R-S03
- Contract owner: the Read Me repo (`github.com/JoshShearer/Read-Me`), its `srs.md`
  R-M12 and "Bridge contract (v1)", and its ADR 0004 (busy) and ADR 0008 (`maxChars`)

## Context

`srs.md` promises no companion application (the product promise, R-M01's "MUST NOT
require a companion Android APK", and "Won't Have - MVP"). Two measured facts make
that promise leave Android without usable speech.

1. **Kokoro cannot meet the owner's bar on Android, and on some devices cannot start.**
   On a Pixel 9 Pro XL, offline, on the fast q4f16 build, a 41-chunk read at rate 2.0
   delivered 86.0 s of audio over a 351.9 s window, 8.2x too slow. The cause is the
   host: no `SharedArrayBuffer`, so one WASM thread, and no WebGPU adapter. A plugin can
   change neither (AGENTS.md, "Android playback throughput, and the native-TTS bridge").
   On a Huawei MatePad (VRD-W09, `com.huawei.webview`), Kokoro cannot start at all:
   `WebAssembly SIMD is not supported in the current environment`, which NRL-62
   recorded as an out-of-support tier.
2. **There is no other route inside Obsidian.** NRL-35's BLOCKED_BY_HOST holds on
   Chromium 154: no `speechSynthesis`, no Capacitor TextToSpeech plugin, and Obsidian's
   manifest declares no `TTS_SERVICE` query.

Native Android TTS through a loopback bridge measured RTF 0.116 to 0.169 at rate 1.0,
offline, and a `CapacitorHttp` POST from inside Obsidian returned audio (same AGENTS.md
section). The owner decided on 2026-10-01 that the companion is **Read Me Offline**, a
standalone Android reader in its own repo, which serves the bridge as a second job.

## Decision

1. **A new engine, `readme` (`src/engines/bridge/readMe.ts`), speaks through Read Me
   Offline's bridge.** It is **optional**: the plugin installs and runs without Read Me,
   every other engine is unchanged, and this one reports itself unavailable, with where
   to get Read Me, when nothing answers.
2. **Constructed on the Android app only** (`shouldConstructBridgeEngine`,
   `Platform.isAndroidApp`). Read Me is an Android app, so nothing can be listening
   anywhere else, and desktop behaviour is unchanged by construction.
3. **Loopback only, host not configurable.** The engine talks to `127.0.0.1` and nothing
   else. Only the port is a setting (`bridgePort`, default 8787). A configurable host
   would make this engine a way to send note text off the device (non-negotiable 4).
   `127.0.0.1` rather than `localhost` or `[::1]`: the bridge binds the IPv4 loopback
   explicitly, because `getLoopbackAddress()` returned `::1` on Android 17.
4. **Rate is applied once, by the Player.** The engine always asks for
   `/synthesize?rate=1.0` and returns the WAV as a buffer (`ownsPlayback: false`). The
   bridge applies whatever rate it is asked for, and the Player applies the user's rate
   to every buffer, so forwarding the rate would give 4x at a 2x setting
   (non-negotiable 9). RTF at 1.0 already clears 2x playback.
5. **Text in the POST body, never the URL**, and the token in an `Authorization`
   header. A URL lands in logs the way argv lands in `ps` (non-negotiable 2's reasoning).
   No error message carries the text or the token (non-negotiable 1).
6. **The pairing token is stored in this device's local storage, not `data.json`.**
   Plugin data is vault-synced (LiveSync, Obsidian Sync, a git vault). A token belongs
   to one phone's bridge: synced, it would be wrong on every other device, and it would
   sit in whatever the vault syncs to. `App.loadLocalStorage` / `saveLocalStorage` are
   scoped to this vault on this device. The cost: a user re-pastes the token on each
   device, which they would have to do anyway, since each device's Read Me has its own.
   The token is a loopback-only credential, so the exposure if it did leak is to other
   apps on the same phone, which is what it exists to keep out.
7. **Availability is one `GET /health`, bounded at 1,500 ms**, re-asked every time, never
   cached: whether the bridge runs is the user's switch in another app. It requires
   `ok`, `ttsReady`, contract `version` 1, and a token.
8. **Automatic selection ranks the bridge first** (ADR 0010's rank order gains slot 0).
   It is the only engine measured to sustain 2x offline on Android. On desktop the slot
   can never fill.
9. **A `503 busy` ends the read instead of falling back.** Read Me answers busy while it
   is reading aloud itself (its ADR 0004). Falling back would mean Kokoro, a 72 s cold
   load on the measured phone, to work around a pause button. The error carries
   `noFallback: true` and `playWithFallback` stops on it (`stopsFallback`), with a notice
   saying to pause Read Me. Every other bridge error still falls back normally.
10. **No word timings** (`timing: "none"`). The bridge promises none, and the measured
    engine fires no `onRangeStart`. The sentence layer and NRL-72's scroll still work;
    the owner accepted losing the word highlight on Android on 2026-10-01.
11. **The voice is Read Me's setting** (its R-S01). The plugin displays what `/health`
    reports and marks it `local: "unknown"`, because filtering network voices is Read
    Me's job (its R-M06) and this plugin does not vouch for another app's claim.
12. **HTTP goes through `fetch`**, since Read Me answers the CORS preflight and puts
    `Access-Control-Allow-Origin: http://localhost` on every response (its R-M12). If
    that fails on a device, the transport is one injectable function and `CapacitorHttp`
    can replace it.

Kokoro also stops claiming to be available where it cannot run: `isAvailable()` now
checks WebAssembly SIMD first (`wasmSimdSupported`). Every packed ORT build, including
the WebGPU one, is a SIMD build, so without SIMD there is no backend at all. Before this,
the MatePad reported Kokoro available and failed every read after a ~2.5 s load.

## Consequences

- `srs.md` is amended: the product promise, R-M01 and "Won't Have - MVP" now permit an
  optional companion app, and R-M03 describes the loopback bridge. The plugin still MUST
  NOT *require* one.
- `companion/android/`, the prototype bridge, is retired in favour of Read Me, so two
  bridge implementations cannot drift. Its README points there. AGENTS.md's measurement
  history stays as history.
- One more thing can break the Android read path: another app's contract. It is
  versioned, and a version mismatch reports itself rather than misbehaving.
- The bridge probe adds up to 1.5 s to automatic selection on Android when Read Me is
  installed but unresponsive. A refused connection (Read Me not running) returns at once.

## What is NOT established by this ADR

Everything above about the engine was verified in bare Node against a fake transport
(`tests/bridge.test.ts`), and through the real `Player` and the real `playWithFallback`.
On-device acceptance is NRL-130's own checklist and is recorded on that issue, not
assumed here: whether `fetch` reaches the bridge from each WebView, sustained 2x reads,
and the sentence highlight. Directory precedent for a plugin that depends on a
separately installed local app: matching names and descriptions in the live
`community-plugins.json` give 51 mentioning Ollama, 32 Zotero, 12 LM Studio and 5
AnkiConnect (regex hits on listing text, not audited dependency counts).
