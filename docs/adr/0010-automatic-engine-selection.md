# 0010. Automatic, quality-ranked engine selection

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-24

## Context

There was no selection algorithm. `main.ts`'s old `readActiveNote()` looked
up whatever `settings.engine` named and, if that engine was unavailable,
showed a Notice telling the user to pick another from a dropdown.
`probeEngines()` already existed, but its only consumer was the settings
tab's status list; nothing used it to choose an engine.

`DEFAULT_SETTINGS.engine` was `"kokoro"`, which on a fresh install has no
model weights downloaded, so `isAvailable()` returns false and the very
first read a new user ever tries fails outright - with a working
speech-dispatcher sitting unused on the same Linux machine.

This deliberately does not follow `srs.md`. Two lines say a fixed order:

- `srs.md:86`: "Native/system TTS is preferred."
- `srs.md:1068`: "Linux desktop SHALL preferentially use Speech Dispatcher."

Both are amended by this ADR (see Consequences).

The user has already decided, before this ticket reached Implement, what
"quality-ranked" means on real numbers measured on this machine:

| Backend | wall/audio |
| -- | -- |
| Kokoro q8, WASM, 1 thread | 3.6x |
| Kokoro q4f16, WASM, 4-6 threads | 1.0-1.3x |
| Kokoro fp32, WebGPU | 0.10-0.13x |

A GPU adapter plus fp32 weights is clearly the best available voice when it
is real. The marginal CPU-only case is a judgment call the user made
explicitly: "Automatic picks Kokoro only when the GPU/fp32 path is live;
any CPU Kokoro path ranks below speech-dispatcher. A smooth worse voice
beats a better voice with gaps."

## Decision

Automatic, quality-ranked selection, fixed order, gated by real probes and
never re-derived from them:

1. **Kokoro, GPU/fp32.** Only when `KokoroEngine.plannedBackend()` - a real
   `navigator.gpu.requestAdapter()` call plus a vault stat, never a fetch or
   a model load - returns `{device: "webgpu", path: KOKORO_WEIGHTS.gpu.path}`
   right now. "Confirmed live", not "the settings say GPU" and not "a GPU
   adapter merely exists": a software (SwiftShader/llvmpipe) adapter is
   already rejected by `probeGpu()`, and a GPU with only CPU-loadable
   weights on disk is already excluded by `plannedBackend()` itself.
2. **Speech Dispatcher**, when its probe reports available.
3. **espeak-ng**, when its probe reports available.
4. **Kokoro again, CPU-only** (any WASM plan, or a GPU/fp16 plan that is not
   the fp32 build) - ranked below both native engines per the recorded
   clarification, never above them, and never in the same list entry as
   rank 1 (`kokoroGpuFp32Live` is one boolean; a given probe can only ever
   satisfy one of the two).
5. **Web Speech**, and only when the engine's own probe already confirms
   every voice it offers is local: `hasLocalVoice()` - `.localService ===
   true` on at least one `SpeechSynthesisVoice`, fail-closed. An `undefined`
   `.localService` (which the DOM lib types as possible, and which is what
   this engine returned for everything before this ticket) counts as NOT
   local, not as "unknown, assume fine". Automatic selection never re-uses
   the full voice list to substitute a voice either: `voicesForSelection()`
   restricts the substitute-voice search itself to `listLocalVoices()` in
   automatic mode, so a webspeech candidate that was ranked because SOME
   voice is local cannot still end up speaking through a different, network
   one.

A manual pin (`Settings.engine` set to a concrete `EngineId` rather than
`"auto"`) is respected exactly as stored, unconditionally. It is never
re-ranked, never gated by these probes, and a pin to Web Speech sees every
voice via `listVoices()`, unaffected by the local-voice gate above - that
gate exists only for the *automatic* chain's decision-making, not as a new
restriction on what a user can deliberately choose.

On a load or first-synthesis failure, `playWithFallback()` (`src/audio/
fallback.ts`) tries the next candidate automatically, with a Notice naming
both engines, rather than sending the user to a dropdown. The fallback only
ever applies to the first candidate of a given read: once any chunk has
genuinely started playing (`Player`'s own `"playing"` state), a later
failure is a normal error notice, not a silent mid-read engine swap - matching
this ticket's own "per-engine failure wording is a separate ticket, NRL-25"
scope line, and avoiding any risk of re-speaking text the user already
heard.

`DEFAULT_SETTINGS.engine` changes from `"kokoro"` to `"auto"`. This is a
deliberate first-run behaviour change, the same shape as `speakImageAlt`'s
default flip in NRL-21 (ADR 0008): anyone who has never touched the engine
dropdown - a genuinely fresh install, or `data.json` predating this build -
now gets Automatic instead of a doomed default of unavailable Kokoro. A
saved manual pin (any value already present in `data.json`) round-trips
through the widened `normaliseSettings()` validation unchanged; it is never
coerced to `"auto"` (AGENTS.md non-negotiable 10).

## Justification for the deviation

`srs.md:86` and `srs.md:1068`'s native-first rule exists to guarantee
zero-download, zero-cloud operation - not because native TTS is
categorically the best-sounding voice. Automatic ranked selection preserves
that property exactly:

- Nothing in the ranking or the fallback chain ever downloads anything or
  loads a model as a side effect of *deciding*. `plannedBackend()`,
  `isAvailable()` and `hasLocalVoice()` are all read-only probes (vault
  stats, a GPU adapter query, a voice list query) - AGENTS.md non-negotiable
  6 is untouched.
- The Web Speech gate keeps automatic selection off any voice that might be
  network-backed, which is the specific thing `srs.md`'s neighbouring "There
  MUST NOT be a silent cloud fallback" line protects. This ADR does not
  reopen that rule; it extends the same guarantee to a new decision point.
- A better local voice is only ever chosen when it is proven, in real time,
  to actually keep up (rank 1's live GPU/fp32 check) - never as a default
  guess the way `"kokoro"` used to be the default with no such proof.

## Consequences

- `srs.md:86` and `srs.md:1068` are amended with a note that automatic
  selection may rank a confirmed-live GPU/fp32 Kokoro ahead of native/system
  TTS and ahead of Speech Dispatcher respectively; native/system TTS (and,
  on Linux, Speech Dispatcher) remains the default whenever that GPU path is
  not confirmed live, and a manual pin still overrides all of this.
- `DEFAULT_SETTINGS.engine` is `"auto"`, a disclosed first-run behaviour
  change (see Decision).
- `Settings.engine` widens from `EngineId` to `EngineSelection = "auto" |
  EngineId` (`src/engines/selection.ts`). `EngineId` itself is unchanged and
  keeps meaning exactly "a concrete engine in the registry" everywhere else
  - `SpeechEngine.id`, `VoiceInfo.engineId`, `findEngine()`. Nothing outside
  `main.ts` and `settingsTab.ts` ever sees the string `"auto"`.
- `webspeech.ts` gains `hasLocalVoice()`/`listLocalVoices()`, read from
  `SpeechSynthesisVoice.localService`. This is a narrow, automatic-selection
  -only signal, not a general "which voices need the network" answer -
  `EngineCapabilities.offlineStatus` stays `false` for this engine, honestly:
  a per-voice offline/network label in the UI is a separate, larger ticket
  (NRL-26).
- Whether `.localService` reports anything meaningful inside Obsidian's own
  Electron/Chromium build on Linux (where its `speechSynthesis` is backed by
  libspeechd/espeak under the hood) is unverified as of Implement. If every
  voice reports `false` or `undefined` there regardless of the underlying
  truth, the fail-closed design still keeps the non-negotiable intact -
  webspeech simply never wins automatic selection, which is safe - but Web
  Speech would then be dead weight in the automatic chain on this platform.
  Worth confirming by ear, not assumed either direction.

## Amendment: NRL-141, the no-voices probe is paid once per engine

On a host where `speechSynthesis` exists but reports zero voices (measured on
a Flatpak Obsidian 1.13.7 on Linux, `getVoices().length` 0), every
`isAvailable()`/`hasLocalVoice()`/`listLocalVoices()` call polled to
`VOICE_TIMEOUT_MS` with nothing remembered, and because `buildProbes()` waits
for all probes, every Auto read waited too: `buildProbes()` measured 4,909 ms
on each of two consecutive calls there, and NRL-141's reproduction in native
Obsidian measured an Auto read reaching `playing` at +5,133 ms.

Decision. The voice wait moves onto `WebSpeechEngine` as instance state:

- one in-flight poll, shared by every concurrent caller;
- a poll that runs to its timeout with no voices records a confirmed-empty
  outcome, which later calls return without polling;
- invalidation is by any `voiceschanged` event, through one persistent
  listener registered lazily and removed by `dispose()` (replacing the
  per-call `{ once: true }` listeners that leaked when the event never came),
  **and** by a synchronous `getVoices()` read that every call makes before
  consulting the cache, so a host that fills its list without the event is
  still seen on the next call; `listVoices()` no longer memoises an empty list
  either.

The local-voice gate above is unchanged and still fails closed: the cache can
hold only "no voices", never a voice list, so it cannot turn unknown into
available, and `hasLocalVoice()` is still true only for a voice it has read
with `localService === true`. Both `isAvailable()` reason strings are
byte-identical.

Measured, bare Node against the real module with real timers and 0 voices:
before, each call 4,910-4,918 ms and 49 poll timers, a concurrent pair 98;
after, the first call 4,911 ms and 49 timers, every later call 0 ms and 0
timers; a `voiceschanged` carrying a voice 1,000 ms into a poll settles it at
1,000 ms. Costs that remain: the first probe after load still pays up to
`VOICE_TIMEOUT_MS` if no voices ever arrive (an Auto read inside that window
waits out the remainder), and whether any real Linux Electron fires
`voiceschanged` late is unobserved. The Obsidian-side Auto latency after this
change is unmeasured.

