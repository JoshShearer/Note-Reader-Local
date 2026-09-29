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
├── audio/
│   ├── types.ts                SpeechEngine, EngineCapabilities, SpeechChunk, VoiceInfo
│   ├── player.ts               the single playback controller
│   ├── words.ts                word spans and timing apportionment
│   ├── wav.ts                  WAV parsing / duration
│   └── emitter.ts              tiny typed event emitter, isolates listener throws
├── engines/
│   ├── registry.ts             createEngines(), probeEngines(), findEngine()
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

**One player, many engines.** `Player` holds the queue, the index and the state. It is
the only thing that decides what is spoken next. Engines do not know about each other,
about documents, or about the editor.

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
- **There is no engine fallback chain.** Selection is a stored id; if it fails, the user
  gets a notice telling them to change a dropdown.
- **Segmentation is a single regex** (`/[.!?…]+["')\]]*\s+/g`) with no `Intl.Segmenter`,
  so CJK text is never split.
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
