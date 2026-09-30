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
`VoiceInfo` / `SpeechChunk`. They are approximate, not exact, synonyms. All four of
`id`, `sequence`, `blockType` and `filePath` now exist on `SpeechChunk`; what still
differs is shape. `SpeechSegment` nests the location as `source: { filePath, from, to }`
(`srs.md:392-396`) where `SpeechChunk` flattens it to a `filePath` plus flat
`sourceStart`/`sourceEnd` (`src/audio/types.ts:139-152`).

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
      ├─► emits "chunk" ───────► main.ts ──► highlight.ts ──► sentence decoration + viewport scroll
      └─► emits "word" ────────► main.ts ──► highlight.ts ──► word decoration, over it
```

---

## Layout

```
src/
├── main.ts                     plugin entry: commands, wiring, notices, prewarm
├── diagnostics.ts              trace() / reportError() - metadata only, never text
├── settings/index.ts           Settings type, defaults, normaliseSettings()
├── settings/data.ts            data.json container: version (v2), v0 and v1 migrations, save round trip
├── settings/positionThrottle.ts leading/trailing position saves, injected timers and queue-path guard (NRL-51)
├── settings/vaultEvents.ts     rename/delete orchestration behind a narrow port, obsidian-free (NRL-58)
├── settings/saveQueue.ts       single-flight coalescing saveData queue, obsidian-free (NRL-58)
├── text/extract.ts             markdown → SpeechChunk[] with source offsets; two
│                               confirmed carries plus one document scalar (ADR 0025)
├── text/segment.ts             sentence/grapheme/word boundaries, injected SegmenterSource, pure (ADR 0009)
├── audio/
│   ├── types.ts                SpeechEngine, EngineCapabilities, SpeechChunk, VoiceInfo
│   ├── player.ts               the single playback controller
│   ├── fallback.ts             playWithFallback(): tries the next engine on a load/first-chunk failure (ADR 0010)
│   ├── clip.ts                 clipChunksToSelection(): narrows a queue to a selection by scanning sourceIndex (NRL-57)
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
    ├── highlight.ts             two CodeMirror StateFields (sentence, word) + highlightPlan (ADR 0020) + viewport scroll on the chunk event (ADR 0022) + shouldHighlightLeaf gating both on active-leaf-change (NRL-89)
    ├── highlightColour.ts      highlight colour setting -> CSS variable, pure (ADR 0005)
    ├── loadingNotice.ts        dismissal policy for the "Loading X..." Notice, obsidian-free (NRL-65)
    ├── modelStore.ts           downloads, vault file IO for model assets
    └── paths.ts                vault path resolution
```

---

## Load-bearing decisions

**Offsets, not search.** Highlighting never looks for the spoken string in the editor.
It carries raw-markdown offsets end to end. This is why `extract.ts` pushes an index
entry for every dropped span, and why a stripping change that forgets to is a silent
corruption rather than a crash. Three consumers turn a raw offset into a position in
spoken text, not one: the highlight, the stored-position resume, and since NRL-57 the
selection clip in `audio/clip.ts`. All three must **read** `sourceIndex` to find that
position. The clip is the one that got it wrong, by subtracting `chunk.sourceStart`
from the selection's `from`, which assumes one raw character produced one spoken
character. Stripping is exactly what makes that false, so the paragraph above was
already true when the defect was written under it: say "read the index" rather than
"carry offsets", because arithmetic on an offset also looks like carrying one.

**Lines are scanned one at a time, with three deliberate cross-line facts, and the loop
is a two-pass.** `cleanLine` sees a single source line and nothing else, which is why the
same `%%` can be a comment on one line and literal text on another. Two of the three are
constructs CommonMark lets cross a soft line break: an inline code span, and an image or
link label. **The third is not shaped like them and must not be filed with them**: it is a
whole-document scalar, `lastHtmlCloser`, read once before the first pass, and it adds no
pass (NRL-74, ADR 0025). See below.

For a code span, `Cleaned.openCode` reports the length of a backtick run left open and
`extractChunks` only carries it forward once `codeSpanClosesLater` has found a run of the
same length on a later line of the same paragraph. The confirmation is not an optimisation.
An unmatched run is literal text, so carrying it blindly would stop the next line's `%%`
being recognised as a block opener and would speak text the author hid, which is the one
direction ADR 0006 exists to prevent.

**The per-line loop cleans a paragraph line twice** (NRL-64, ADR 0006 clause 4 and ADR 0019
clause 3 as amended). The first pass exists only to learn the unmatched run length;
`codeSpanClosesLater` is then called with the identical arguments; and only then is the line
cleaned again, with `cleanLine`'s 6th parameter `outgoingCode` set, so the tail after the
opener goes through the **same region emitter** as a carried-in span. Confirming before
committing the line's output is the whole point: it is what makes the opening line's tail
literal too, and it is why `codeSpanClosesLater` and `interruptsParagraph` could stay
byte-identical while the behaviour changed.

A soft-wrapped image or link label uses the same shape through `bracketClosesLater`
(NRL-63, ADR 0023), which mirrors `codeSpanClosesLater` including its `interruptsParagraph`
stops and adds one requirement of its own: the label's own `]` must be followed by
`(` or `[`, so a shortcut label with no destination is never confirmed and no visible prose
is silenced. The two carries are mutually exclusive on any one line and a code span binds
tighter, so a line opening both arms the code carry only. The label carry is a **partial**
fix: four distinct roots still leave a destination spoken, tracked as NRL-88 and enumerated
in `AGENTS.md`.

**Which `]` is "the label's own" is decided by one shared scan, and the sharing is the
load-bearing part** (NRL-88, ADR 0027). `labelClose(line, from, depth)` tracks bracket
**depth** and is called by `bracketClosesLater` *and* by the block in `cleanLine` that
consumes a carried label. Before it, the confirmation tested the first `]` on the line and
the consumer closed the label at that same `]` unconditionally, without the test - so
teaching only the confirmation to walk past an inner bracket pair measured **strictly worse
than changing nothing**: the destination still leaked and the alt text was silenced too. One
question, one helper.

Depth rather than "skip any `]` that is not a closer" is also measured rather than
preferred: the naive skip lets a shortcut label's own closer be skipped and an unrelated
later `](` adopted, swallowing the prose between. A `]` reached at **depth 0 is ours**, is
tested, and on failure the confirmation returns false - the fail-closed direction ADR 0023
clause 3 takes everywhere. And `labelClose` deliberately **stops counting** at the first
step with no `]` left on the line, so a trailing unmatched `[` is not counted: completing
that accounting newly leaked a destination and moved a pinned fixture, because this
codebase's carry takes the **first** unmatched opener where CommonMark takes the **last**.
The residual depth travels with `openBracket` as `Cleaned.openBracketDepth` and
`cleanLine`'s tenth parameter, cleared by exactly the same paths, because it is part of that
one carry rather than state of its own.

The third cross-line fact is the HTML-comment block rule (NRL-74, ADR 0025), and it is
deliberately a different shape. A `<!--` opens a block only if it begins its line **or**
some later line carries `-->`, and the second term cannot be answered by any line about
itself. `extractChunks` therefore computes ONE scalar, `lastHtmlCloser` - the highest index
of a line containing `-->` - immediately after `source.split("\n")`, and `lastHtmlCloser > n`
answers the question in O(1). It is threaded as a **required** parameter through `cleanLine`,
`opensHiddenComment`, `interruptsParagraph`, `codeSpanClosesLater` and `bracketClosesLater`;
required, so `tsc` names every call site rather than letting one silently keep the old
answer. Three things follow. It is **not** a confirm-then-commit carry - it asks nothing
about the current line, so it is known before pass 1 and is passed identically to all three
passes; do not add a fourth. Its scan runs to **EOF**, not to the end of the paragraph,
deliberately unlike the two carries above, because an HTML comment legitimately spans
blocks. And `interruptsParagraph` is consequently **no longer a pure line predicate**; the
in-file precedent for that is `opensMathBlock`, already document-aware and already called
beside it.

Anything else that needs cross-line state should follow one of those two shapes: a
confirm-then-commit carry when the question is about this line, or a precomputed scalar
when it is about the document. Never a lookahead callback into `cleanLine`.

**The worker is a jail.** `kokoro.worker.ts` shims `fetch` to reject any cross-origin
URL and asserts locality on the ORT paths, because both transformers.js and kokoro-js
default to CDN URLs. `esbuild.config.mjs` still computes the ORT files' SHA-256 checksums
at build time and compiles them into `main.js`, but as of NRL-37 (ADR 0024) the runtime
files themselves are no longer vendored into the shipped plugin bundle: Obsidian's
community-plugin installer only ever fetches `main.js`, `manifest.json` and `styles.css`,
so a real directory install never had the old build-output `ort/` folder in the first
place. The runtime is instead fetched on explicit user action from this plugin's own
tagged GitHub Release, into the vault-adjacent model directory, and verified against
those same compiled-in digests before use - the download is the one place this jail's
network ban is deliberately not absolute, and it stays narrow: pinned version, this
plugin's own release, nothing executed before the checksum matches.

**Blob URLs for local code.** Obsidian serves the plugin folder from `app://`, which
cannot be used as a worker origin, so `kokoro.ts` reads its own worker and ORT files out
of the vault and re-wraps them as same-origin blobs.

**Weights live outside the plugin folder** (`.obsidian/local-tts/kokoro`) so a plugin
update does not discard hundreds of megabytes, and out of the file tree so they do not
clutter the vault. The ORT runtime files live in the same directory, under `ort/`, for
the identical reason (NRL-37): a plugin update must not force a 31 MB re-download any
more than it should for the weights.

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
| `element` | no engine set at all, then `!ownsPlayback` whatever the engine declares | kokoro, espeak | `<audio>.play()`: continues at the exact sample |
| `engine` | `ownsPlayback` **and** both `pause()` and `resume()` declared | webspeech | `speechSynthesis.resume()`: continues mid-utterance, roughly at the word |
| `restart` | neither of the above | speechd | re-speaks the **current sentence from its start** |

The row order is the check order, and `element` is first for the reason bullet 5 below
gives: testing `!ownsPlayback` before the pair is what makes the `engine` route's premise
an invariant rather than a coincidence.

The differences are deliberate and are `srs.md:250` verbatim: where a backend cannot pause
an active utterance, the controller may pause by stopping synthesis while retaining the
segment and position. So no ADR: this is the spec's own fallback, not a deviation from it.
Five consequences worth knowing before touching any of it:

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
- On the `element` route both of `audio.play()`'s callbacks **outlive their own run**, so
  both re-check the `runToken` captured before the call. A real `HTMLAudioElement` settles
  that promise asynchronously, and `pause()` on this route does not bump the token, so a
  `stop()` or a fresh `play()` can land in between. The success half would otherwise revive
  a dead run's state and prime a queue `stop()` has already cleared, on a signal nothing
  can abort; the failure half would report a notice about a reading the user had abandoned
  and then `stop()` the playback that replaced it. A superseded rejection is therefore
  swallowed on purpose: nothing awaits it, and whoever started the replacement owns its own
  failures. Only this route needs the guard, and only this route primes - the other two both
  imply `ownsPlayback`, which `primeBuffer` refuses outright, and `restart`'s `restartCurrent`
  re-enters `run()`'s own priming.
- **That "both imply `ownsPlayback`" is an invariant, and the check order is what makes it
  one** (NRL-49). `pauseRoute` runs its three tests in this order: no engine at all is
  `element`; then `!ownsPlayback` is `element`, *whatever the engine declares*; only then is a
  declared `pause()`/`resume()` pair the `engine` route, a half-declared pair the reported
  fallback, and everything remaining `restart`. A buffer engine that declares either method is
  reported **once per pause press, and one error rather than two**, through the same `"error"`
  channel as the half-pair notice, and still
  paused by its element. One error and not two, because on a buffer engine neither method can
  ever be called, so which half is missing is not the actionable fact - and the half-pair
  message ends "Pausing by stopping the sentence instead", which is only true of `restart`.
  Before NRL-49 the pair was tested first, so such an engine took the `engine` route: the
  element was never paused (the player reported `paused` over sound that kept playing) and
  `resume()`'s engine branch returned before the element route's `primeBuffer`, so a Look
  ahead raise stored while paused was never spent. That was latent, not reachable - webspeech
  provides the only `pause()`/`resume()` in `src/engines/` and it owns playback - and it was
  inherited rather than introduced by the resume guard above, identical on `b04d8fa` and
  `4a9ecd0`. The trailing `return "restart"` is now a literal rather than a ternary so the
  invariant is visible where it is relied on, and the edit to refuse is weakening, narrowing or
  moving the guard itself - not inserting a return between it and that line, which no buffer
  engine could reach anyway, since the guard returns for every one of them. A buffer engine that
  did reach `restart` would have its chunk torn down and re-read instead of paused.

`EngineCapabilities.pause` therefore answers "can the player stop this engine's sound and
come back to it", not "does the engine have a pause API". All four engines now say yes, so
it is no longer the inverse of `ownsPlayback` and must not be inferred from it.

---

## Known structural gaps

These are design-level, not bugs, and they shape any new work:

- `Player` is a **chunk-queue player, not a reading session**. It knows its file path
  and hands it out (`getFilePath()`, `getChunk()`), which is what lets `main.ts` record
  a position against the note it is actually reading rather than whichever note is in
  front. What it still does not hold is a document, a revision or a vault handle.
  `readActiveNote()` extracts `current.source` and looks up the saved position using
  that same captured `current.filePath`; extracting from the active view is not itself
  a mismatched-key defect. NRL-51 passes that offset to the player. Durable save ordering
  and real-vault resume remain unverified (see `AGENTS.md`, Known state).
- **A stored offset is resolved by `Player`, not by the caller.** `main.ts` passes
  `storedPosition.sourceOffset` straight through as `play()`'s `startAtSource`; it does not
  pre-resolve it to a chunk. This is not tidiness, it is the whole of R-M12's nearest-valid
  rule. `Player.play` matches on `sourceEnd > off`, so an offset sitting in a span nothing was
  spoken from - a skipped code block, a skipped table - resolves forward to the chunk after
  it, and an offset past the end falls back to the last chunk. A caller that requires
  `sourceStart <= off < sourceEnd` first cannot express either case: it finds no chunk, passes
  -1, and `-1` means "the top of the note". That is how a reading position from inside a code
  block silently restarted the note, and it is why the pre-filter is gone rather than patched.
  The empty-queue guard in `play()` is what makes the `chunks.length - 1` expression safe, and
  it must stay between the `start` computation and `this.index = start`.
- **The `positions` map is re-keyed on vault rename and pruned on delete, in
  `settings/data.ts`, not in `main.ts`.** `moveReadingPositions` / `dropReadingPositions` are
  pure and obsidian-free, which is what keeps them in the bare-Node suite; main.ts cannot run
  there without a stub. One predicate, `key === path || key.startsWith(path + "/")`, covers
  a file (exact key only) and a folder (the subtree), with no type branch. Both return the
  input *unchanged* when nothing matched, so repeating an already-applied event is a no-op.
  That predicate is `covers`, and since NRL-58 it is **exported and serves two callers**: the
  sweeps here and the playback stop in `settings/vaultEvents.ts`, which is the whole of
  "the same path-boundary-safe relation". The orchestration - stop, then sweep, then save -
  lives in `settings/vaultEvents.ts` behind a narrow port, not in main.ts, for the same
  reason the sweeps live here. `covers(candidate, eventPath)` is **not symmetric and the
  argument order is load-bearing**: the queue's file path is the candidate and the event's
  path is the prefix, so a folder event covers a descendant read while a file event covers
  neither its folder nor a sibling. Reversed, renaming one note would stop a read of every
  sibling under its parent. The stop sits **ahead** of the identity early-out, so a folder
  holding no stored position still stops a descendant read. The queue is not retargeted (its
  `id` hashes `filePath`), so `getFilePath()` keeps answering with the pre-rename name until
  the next `play()` - which is why the comparison is against `oldPath` and why a repeated
  descendant event matches again and calls `stop()` a second time. That is harmless rather
  than merely tolerated: `Player.stop()` ends in `setState("idle")`, which early-returns on
  an unchanged state, and the module is stateless by design so there is nowhere to dedupe.
  **Write ordering is no longer unresolved.** Every durable write goes through
  `settings/saveQueue.ts`, which `saveSettings()` now enqueues instead of calling `saveData`
  directly: single-flight with coalescing, newest wins, one write in flight and one payload
  pending, a replaced payload never written, a rejection reported exactly once and never
  wedging the queue, and no retry of the failed payload. The reversal is not corrected so
  much as made unexpressible, since the second write is not issued until the first settles.
  In-memory container mutation is deliberately **not** serialised, only the write:
  `savePosition` relies on its synchronous mutation so a Stop has recorded its position
  before returning. The residual is `onunload`, which is synchronous and cannot await
  `drain()`, so an unload mid-flight can lose the newest snapshot - unchanged in kind from
  the pre-existing un-awaited `void this.saveSettings()`. Real-vault event sequencing and
  durable resume are still unverified; nothing here was observed in Obsidian.
- **Capabilities are consumed for the transport controls only.** `src/ui/affordances.ts`
  gates play/pause, the rate nudges and the highlight toggle, and the settings engine list
  reports each engine's limitations. `pitch` still gates nothing (there is no pitch control
  in the UI at all), and no engine declares `sentenceBoundary`, so the sentence-level
  features the spec imagines have nothing to switch on yet.
- **The viewport follows the sentence, and `highlight.ts` is no longer decoration-only**
  (NRL-72, ADR 0022). `applyHighlightLayers` takes a third optional `scrollTo` offset and
  pushes `EditorView.scrollIntoView` onto the effects array it already dispatches, so the
  scroll rides in the **same transaction** as the two decoration effects. A second dispatch
  would reintroduce exactly the one-frame disagreement ADR 0020 exists to prevent. The
  scroll is per **sentence**, not per word: `main.ts`'s `chunk` handler passes
  `chunk.sourceStart` and the word handler passes nothing, so a manual mid-read scroll is
  overridden at most once a sentence. Neither the three clears nor `applySentenceHighlight`
  takes an offset, so ending a reading and flipping a settings toggle both leave the
  viewport alone. "No jump when already visible" is CodeMirror's `y: "nearest"` default and
  not arithmetic of ours; a `coordsAtPos` visibility test must not be added, because it
  needs a DOM the bare-Node suite cannot build and duplicates what `nearest` does. What
  survives of the old decoration-only guarantee is the cursor, the text selection, the
  focused element and the undo history. What does not is the user's scroll position, by
  design. **Nothing was observed in Obsidian:** whether Obsidian's own editor extensions
  intercept the scroll effect, and whether Live Preview's folds put `sourceStart` at the
  screen position a plain-text offset implies, are both unknown.
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
  await does not pace this engine's queue: after a stop the Player runs one chunk ahead of the
  audio, and a Stop leaves about 800 ms of speech to play out. NRL-43 accepted that rather than
  fixing it (`docs/adr/0016`), having built and measured the fix the model implied: an SSIP
  socket client whose `CANCEL self` flushes our own queue leaves the tail exactly where `-S`
  does, 810/800 ms either way, because the speech is already inside the daemon's output module.
  Anyone measuring speechd must capture audio rather than time `-w`, and must be more careful
  than that as well - `701 BEGIN` fires 3-10 ms after queueing rather than at audio start, a
  single-stop read does not overlap chunks at all so it cannot reproduce the tail, and `parec`
  on a cold sink starts ~2 s late and then bursts earlier audio, which will manufacture a
  reproduction that is not there. ADR 0016 records all four traps.
