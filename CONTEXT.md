# CONTEXT - Local TTS Reader

Architecture map and vocabulary. Read this before changing anything structural.
Rules and gates live in `AGENTS.md`; the contract lives in `srs.md`.

---

## The one-paragraph version

A note's raw markdown is stripped into speakable text that remembers where every
character came from. That text is split into chunks, each chunk is handed to a speech
engine, and the audio that comes back is played while the word currently being spoken
is highlighted in the editor. The mapping from spoken character back to markdown offset
is what makes highlighting possible, and it is the load-bearing idea in the codebase.

---

## Vocabulary

| Term | Meaning |
|---|---|
| **chunk** | One utterance handed to an engine. Usually a sentence. `SpeechChunk` in `src/audio/types.ts`. |
| **source offset** | A character position in the note's **raw markdown**, not in the spoken text. |
| **`sourceIndex`** | Per-character array on a chunk: `sourceIndex[i]` is the raw offset that produced `text[i]`. Survives stripping. |
| **engine** | A speech backend implementing `SpeechEngine`. Four exist: `kokoro`, `espeak`, `speechd`, `webspeech`. |
| **capabilities** | What an engine can do (`EngineCapabilities`). The UI reads these before offering a control. |
| **affordance** | What the UI does with a capability: enabled or disabled, plus a reason. `src/ui/affordances.ts`, pure so bare-Node tests can drive it. |
| **`SegmenterSource`** | Where `Intl.Segmenter` instances come from. Injected, so the no-segmenter path is a value (`noSegmenters`) rather than a deleted global. `src/text/segment.ts`. |
| **legacy boundary** | A sentence boundary the old ASCII regex found. Only these may be erased by `mergeShort`; an ICU-only one must survive or CJK folds back into one chunk. |
| **`ownsPlayback`** | The engine makes sound itself rather than returning audio. Decides who applies the playback rate. |
| **weights build** | A quantisation of the Kokoro model: `gpu` (fp32), `fast` (q4f16), `small` (q8). |
| **backend plan** | The ordered list of (device, weights) attempts Kokoro will make, with a WASM tail as fallback. |

Spec vocabulary differs from the code: `srs.md` says `TTSBackend` / `TTSCapabilities` /
`TTSVoice` / `SpeechSegment`, the code says `SpeechEngine` / `EngineCapabilities` /
`VoiceInfo` / `SpeechChunk`. They are approximate, not exact, synonyms. `SpeechChunk`
notably lacks the `id`, `sequence`, `blockType` and `filePath` that `SpeechSegment` has.

---

## Pipeline

```
note markdown
      │
      ▼
extract.ts ──────────► SpeechChunk[]   text + sourceIndex + sourceStart/End
      │                                 (block scan, then per-character inline scan,
      │                                  plus one forward lookahead for code spans)
      │   └─► segment.ts ───► sentence boundaries (ICU ∪ regex), grapheme
      │                       boundaries for the hard split, word boundaries
      ▼
Player ──────────────► orchestrates: synthesise ahead, play, advance, emit events
      │
      ├─► SpeechEngine.synthesize() ──► SynthResult
      │        kind: "buffer"   audio + word timings    (kokoro, espeak)
      │        kind: "live"     engine fires onWord     (webspeech)
      │        kind: "streamed" engine makes the sound  (speechd)
      │
      ├─► words.ts ────────────► WordTiming[]  offsets + ms, apportioned by syllables
      │
      └─► emits "word" ────────► main.ts ──► highlight.ts ──► CodeMirror decoration
```

---

## Layout

```
src/
├── main.ts                     plugin entry: commands, wiring, notices, prewarm
├── diagnostics.ts              trace() / reportError() - metadata only, never text
├── settings/index.ts           Settings type, defaults, normaliseSettings()
├── settings/data.ts            data.json container: version (v2), v0 and v1 migrations, save round trip
├── text/extract.ts             markdown → SpeechChunk[] with source offsets
├── text/segment.ts             sentence/grapheme/word boundaries, injected SegmenterSource, pure (ADR 0009)
├── audio/
│   ├── types.ts                SpeechEngine, EngineCapabilities, SpeechChunk, VoiceInfo
│   ├── player.ts               the single playback controller
│   ├── fallback.ts             playWithFallback(): tries the next engine on a load/first-chunk failure (ADR 0010)
│   ├── words.ts                word spans and timing apportionment
│   ├── wav.ts                  WAV parsing / duration
│   └── emitter.ts              tiny typed event emitter, isolates listener throws
├── engines/
│   ├── registry.ts             createEngines(), probeEngines(), findEngine()
│   ├── selection.ts            rankEngines()/selectEngine()/resolveSelection(): automatic quality-ranked pick (ADR 0010)
│   ├── webspeech.ts            browser speechSynthesis
│   ├── system/
│   │   ├── spawn.ts            ProcessRunner; the only child_process touch point
│   │   ├── espeak.ts           espeak-ng → WAV
│   │   └── speechd.ts          spd-say → speaks directly, no samples back
│   └── onnx/
│       ├── kokoro.ts           engine, weights table, GPU probe, backend plan
│       ├── kokoro.worker.ts    the worker: transformers.js + ORT, network-refusing
│       └── browser-environment.ts  hides Node from transformers.js
└── ui/
    ├── settingsTab.ts          all settings rendering
    ├── controlBar.ts           transport controls
    ├── affordances.ts          capabilities -> which controls to offer, and why not, pure
    ├── highlight.ts            CodeMirror StateField + decoration
    ├── highlightColour.ts      highlight colour setting -> CSS variable, pure (ADR 0005)
    ├── modelStore.ts           downloads, vault file IO for model assets
    └── paths.ts                vault path resolution
```

---

## Load-bearing decisions

**Offsets, not search.** Highlighting never looks for the spoken string in the editor.
It carries raw-markdown offsets end to end. This is why `extract.ts` pushes an index
entry for every dropped span, and why a stripping change that forgets to is a silent
corruption rather than a crash.

**Lines are scanned one at a time, with one deliberate exception.** `cleanLine` sees a
single source line and nothing else, which is why the same `%%` can be a comment on one
line and literal text on another. The exception is an inline code span, which CommonMark
lets cross a soft line break: `Cleaned.openCode` reports the length of a backtick run left
open, and `extractChunks` only carries it forward once `codeSpanClosesLater` has found a
run of the same length on a later line of the same paragraph. The confirmation is not an
optimisation. An unmatched run is literal text, so carrying it blindly would stop the next
line's `%%` being recognised as a block opener and would speak text the author hid, which
is the one direction ADR 0006 exists to prevent. Anything else that needs cross-line state
should follow that shape: prove the span is real before trusting it.

**The worker is a jail.** `kokoro.worker.ts` shims `fetch` to reject any cross-origin
URL and asserts locality on the ORT paths, because both transformers.js and kokoro-js
default to CDN URLs. The ONNX runtime is vendored at build time by `esbuild.config.mjs`
for the same reason.

**Blob URLs for local code.** Obsidian serves the plugin folder from `app://`, which
cannot be used as a worker origin, so `kokoro.ts` reads its own worker and ORT files out
of the vault and re-wraps them as same-origin blobs.

**Weights live outside the plugin folder** (`.obsidian/local-tts/kokoro`) so a plugin
update does not discard hundreds of megabytes, and out of the file tree so they do not
clutter the vault.

**One setting key, one option field, no negation.** Each row in the settings tab's
"Content" group writes exactly one `Settings` key, `main.ts` hands that key to the
identically named and identically polarised field on `ExtractOptions`, and every one of
those fields is **required** rather than optional. The shape is deliberate, because the
dead-toggle defect has landed twice in two different disguises: a stored key that
extraction never read at all (`speakImageAlt`, `speakEmbeds` and `skipFrontmatter` until
NRL-21) and one row quietly writing two keys (the old shared "Code" switch). An optional
field with a default is how the first kind hides; a required one makes the compiler name
every call site. Adding a tenth exclusion means a key, a field and a row, not a clever
shared control.

**One player, many engines.** `Player` holds the queue, the index and the state. It is
the only thing that decides what is spoken next. Engines do not know about each other,
about documents, or about the editor.

**Pause is routed by who is holding the sound, and resume granularity differs by
engine.** `Player.pauseRoute()` picks one of three, in this order, and `resume()` undoes
whatever `pause()` recorded rather than deciding again:

| route | chosen when | engines | what a resume does |
|---|---|---|---|
| `engine` | engine implements **both** `pause()` and `resume()` | webspeech | `speechSynthesis.resume()`: continues mid-utterance, roughly at the word |
| `element` | `!ownsPlayback`, and the default when no engine is set | kokoro, espeak | `<audio>.play()`: continues at the exact sample |
| `restart` | neither of the above | speechd | re-speaks the **current sentence from its start** |

The differences are deliberate and are `srs.md:250` verbatim: where a backend cannot pause
an active utterance, the controller may pause by stopping synthesis while retaining the
segment and position. So no ADR: this is the spec's own fallback, not a deviation from it.
Three consequences worth knowing before touching any of it:

- The route is **never** decided from `SynthResult.kind`. On an engine that owns playback
  `synthesize()` does not resolve until the utterance is over, so the kind is unknown at
  exactly the moment pause is pressed. `ownsPlayback` is all there is to go on.
- `pause()` must not touch `this.controller`. `run()` reads `this.controller?.signal` once
  on entry and returns if it is missing, so nulling it kills the run loop and leaves a
  resume nothing to restart. Only `stop()` may. For the same reason the `restart` route's
  `++runToken` is load bearing: without it the superseded `run()` iteration comes back from
  its await and advances the index, so a pause silently eats a sentence.
- On the `engine` route the loop deliberately stays parked inside `await synthesize()`. Not
  bumping the token and not aborting the chunk scope is the whole mechanism of a
  mid-utterance resume.

`EngineCapabilities.pause` therefore answers "can the player stop this engine's sound and
come back to it", not "does the engine have a pause API". All four engines now say yes, so
it is no longer the inverse of `ownsPlayback` and must not be inferred from it.

---

## Known structural gaps

These are design-level, not bugs, and they shape any new work:

- `Player` is a **chunk-queue player, not a reading session**. It holds no file path and
  no document identity, which is why per-note reading position (R-M12) cannot simply be
  bolted on.
- **Capabilities are consumed for the transport controls only.** `src/ui/affordances.ts`
  gates play/pause, the rate nudges and the highlight toggle, and the settings engine list
  reports each engine's limitations. `pitch` still gates nothing (there is no pitch control
  in the UI at all), and no engine declares `sentenceBoundary`, so the sentence-level
  features the spec imagines have nothing to switch on yet.
- **Segmentation is `Intl.Segmenter` unioned with the old regex, not either alone**
  (NRL-28, ADR 0009). `src/text/segment.ts` owns it, pure and dependency-free, and the
  segmenters arrive through an injected `SegmenterSource` so the no-segmenter path is
  exercised without mutating a global. Four things about it are load-bearing and are
  not simplifications waiting to happen. The **union**: on newline-free English prose
  ICU removes far more boundaries than it adds - measured over 4,000 generated English
  fixtures, it declines 15,523 the regex has (after `e.g.`, after an ellipsis, after
  `U.S.A.`) and supplies 1,803 the regex lacks - so replacing the regex would lengthen
  English chunks. Keep the "newline-free" clause: the ratio inverts on any corpus that
  carries hard line breaks, because ICU ends a sentence at a newline and the regex
  cannot, and a markdown corpus of the same size gives 24,000 ICU-only boundaries
  against 0, every one of them sitting immediately after a newline (ADR 0009 clause 2).
  What makes that harmless here is not the ratio: `splitSentences` is never handed a
  newline at all, since `extractChunks` splits on `\n` and `appendToParagraph` joins
  paragraph lines with a space. It does
  *not* add none; the guard below is what brings those 1,803 down to 0 admitted, and
  that is the argument, not ICU's restraint. The **ASCII guard**: an ICU-only
  boundary counts only when the *terminator* before it is at or above U+0080, because
  ICU splits `[!note] Callout body` after the `!` and that is a real Obsidian callout
  marker. Reaching that terminator takes two walks back, over whitespace *and* over
  `\p{Pf}` / `\p{Pe}`, because the legacy regex already allows a run of closers
  (`["')\]]*`) and that class is ASCII-only: with the whitespace walk alone,
  smart-punctuated `“First.” “Second.” “Third.” Tail text here now.` spoke as four
  runts where the straight-quoted form is one chunk. **Legacy-only merging**:
  `mergeShort` may erase only a
  boundary the regex also found, because ICU's CJK sentences are 6 or 7 characters, all
  below the 40-character merge floor, so an unguarded merge folds them back into one
  chunk and undoes the whole thing. And **one floor, one measurement**, in
  `splitOversized`: the space branch and the word branch are floored at half the cap,
  and they must also measure the same thing, because the space branch cuts *at* a space
  while ICU puts a word boundary one unit *past* it. Until the NRL-28 repair a space at
  exactly `cursor + 110` was rejected by one branch and re-accepted by the other, so a
  word candidate is now walked back over any space run behind it before the floor is
  applied. Exactly one offset in 220 fires that shape, which is why it survived three
  probes that sampled near the halfway mark instead of sweeping it.
- **A `"streamed"` `synthesize()` resolving does not mean the audio finished.** On speechd
  it resolves when `spd-say -w` returns, and `-w` is not an audio-end signal: for a message
  queued behind another it returns when the *preceding* message ends, and for one submitted
  just after a stop it returned in 39-62 ms while its own audio ran for seconds. (Measured
  in NRL-41 off the sink monitor with `parec`, precisely because `-w` could not be trusted;
  every number in that ticket comes from the capture, not from `-w`.) So `Player.run()`'s
  await does not pace this engine's queue: the Player runs one chunk ahead of the audio, and
  a Stop leaves that already-queued chunk to play out - about 830 ms, unchanged either side
  of NRL-41 and tracked as NRL-43. Anyone measuring speechd must capture audio rather than
  time `-w`.
