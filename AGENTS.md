# Local TTS Reader - agent instructions

An Obsidian community plugin that reads notes aloud entirely on-device. Four speech
engines behind one interface, with word-level highlighting driven by source offsets.

This file is the canonical instruction set. `CLAUDE.md` is a symlink to it, so Claude
Code and opencode read the same rules.

- **Spec / contract:** `srs.md` (MoSCoW requirement IDs `R-M01`…`R-C05`). It is the
  acceptance criteria, not a wishlist. Deviating from it is allowed; doing so silently
  is not - record an ADR in `docs/adr/` and amend `srs.md`.
- **Architecture map:** `CONTEXT.md`.
- **Linear conventions:** `.claude/linear.md`.

---

## Quality gates

There is **no CI** in this repo. No `.github/`, no workflow, no lint script. The gates
are local and nothing runs them for you.

```bash
npm test          # 18 suites: extract, engine, player, paths, kokoro, settings, positionThrottle, highlightColour, affordances, engineSelection, webspeechVoices, fallback, espeak, types, release, voiceChoice, platform, readSelection
npm run typecheck # tsc --noEmit --skipLibCheck
npm run build     # typecheck + esbuild production (main.js, kokoro-worker.js, ort/)
```

Both must pass before any commit. `npm run build` before anything that touches the
bundle, the worker, or the esbuild config.

```bash
npm run deploy         # build + copy into ~/Documents/Notes/.obsidian/plugins/
npm run test:obsidian  # CDP smoke test; needs Obsidian on --remote-debugging-port=9222
```

`tests/engine.test.ts` shells out to the real `spd-say` binary and needs a running
speech-dispatcher daemon (here with the `speech-dispatcher-espeak-ng` output module). It
is a Linux desktop test and will fail elsewhere. `tests/espeak.test.ts` covers `espeak.ts`
with a fake `ProcessRunner` only: the `espeak-ng` binary itself is not installed on this
machine (confirmed via `which espeak-ng`), so there is still no real-binary coverage for
that engine, only for speech-dispatcher.

---

## Non-negotiables

Each of these is a promise the product makes. Breaking one is a BLOCK, not a concern.

### Privacy

1. **No note text in any log, ever.** `trace()` takes counts, ids and durations. The
   closest any call site gets is `${source.length} chars`. Never interpolate chunk text,
   selection text, or spoken text - not even into an error message.
2. **Speech text reaches subprocesses on stdin, never argv.** A command line shows up in
   `ps` and in spawn error messages. `espeak.ts` and `speechd.ts` both pipe; keep it that
   way.
3. **No telemetry.** No analytics, no beacon, no crash reporting, no "anonymous usage".

### Network

4. **No cloud TTS, ever, and no automatic fallback to one.** No API keys, no accounts.
5. **The Kokoro worker refuses remote fetches at runtime** (`kokoro.worker.ts`
   `isRemote` + `assertLocal`). Those guards exist because transformers.js and kokoro-js
   both default to CDN URLs. Do not remove them; if a load path breaks, fix the path, not
   the guard.
6. **Every byte downloaded is user-initiated.** Model weights and voices download on an
   explicit click. Nothing fetches on load, on prewarm, or on first read.

### Mobile safety

7. **`manifest.json` declares `isDesktopOnly: false`.** No node builtin may be imported
   in a way that evaluates on mobile. `child_process` is type-only plus two dynamic
   `await import()` calls inside method bodies, behind `Platform.isMobile`. Keep it that
   way, and check `main.js`'s `require()` list after any dependency change - it should
   contain only `obsidian`, `@codemirror/view`, `@codemirror/state`.

### Correctness

8. **Source offsets are the highlighting mechanism.** `SpeechChunk.sourceIndex[i]` maps
   each character of spoken text back to its offset in the raw markdown. Never highlight
   by searching the editor for the spoken string. If you change the stripping logic in
   `extract.ts`, the index must stay in lockstep - every dropped span still pushes an
   index entry.
9. **Playback rate is applied exactly once.** An engine with `ownsPlayback: true` is told
   the rate; everything else renders at natural speed and the player applies it. Both at
   1.5x is 2.25x, which shipped once already. There is a test; do not weaken it.
10. **Settings normalisation must not destroy keys it does not recognise.** Plugin data
    holds more than settings. A whitelist-rebuild erases reading positions on the next
    rate nudge.

---

## Verification rules

11. **A green test suite is not a claim that something works.** Unit tests here run in
    bare Node against fakes. Before saying a user-facing change works, exercise it the
    way a user would: `npm run deploy`, then drive the real plugin in Obsidian.
12. **Reproduce a bug end-to-end before fixing it.** Most of the defects in this codebase
    were invisible to the test suite and obvious the moment the real function was run
    against real input. Bundle the module and run it rather than reasoning about it.
13. **Never assert a measurement you did not take.** Performance claims in comments and
    in `srs.md` are real numbers from real runs. If you quote a ratio, a size, or a
    latency, you measured it in this session or you cite where it was measured.
14. **Repo existence is not install-path existence.** Verify a command or a file on this
    machine (`--help`, `ls`, `curl | head`) before depending on it.

---

## Known state

The working tree passes its gates. The audit against `srs.md` that opened this repo found
2 of 16 MUST requirements fully met. That count has not been re-run since, and several
tickets have closed gaps against it, so treat it as a floor rather than as current state.
Two confirmed moves: R-M01 (standard Obsidian Community Plugin) is met as of NRL-16, with
all release infrastructure in place (README.md, LICENSE, versions.json, SLSA Level 3 workflow,
and ORT runtime checksum validation). R-M14 (backend capability detection) is met as of NRL-22,
because every capability that differs across the four engines now gates the control it affects,
and the ones that gate nothing have no control to gate. R-M03's spike (SPIKE-ANDROID-001) is
resolved as of NRL-35, and this one did need a real device, not bare-Node reasoning:
`window.speechSynthesis` does not exist at all in Obsidian's Android WebView (Chrome/88 WebView
on Android 10, a Huawei P30 Pro), Obsidian's Capacitor bridge has no TextToSpeech plugin compiled
in (`Capacitor.isPluginAvailable('TextToSpeech')` is `false`), and Obsidian itself exposes no TTS
facility to plugins. All three were measured directly against the live page over CDP, and the
`TTS: Test Android native TTS` command this added was then built, deployed into that device's real
vault, enabled, and run through `executeCommandById` exactly as the command palette would, landing
the same `BLOCKED_BY_HOST` result in the plugin's own diagnostics log. Result: BLOCKED_BY_HOST,
demonstrated rather than assumed, which is the valid terminal state the spec's Spike Failure clause
describes and is why Kokoro-in-WebView is the Android backend rather than a native bridge.

R-M09 (configurable content exclusions) did **not** move, and the reason matters because
NRL-21's title invites the opposite conclusion. Its *configurability* half is met: all six
exclusions the requirement names have a live toggle at the spec's default, each toggle
demonstrably moves extraction in both positions, and inline code is separable from fenced
code. (Measured at `ad1027d` by bundling the real `extract.ts` and sweeping all 512
combinations of the nine content keys.) Its *reduction* half is split in two, and only one
of the two halves has moved.

The **path** half moved with NRL-46 (`docs/adr/0017`, `srs.md:309` and `:366`). A
`[[wikilink]]` or `![[embed]]` whose target had no dot in its final segment used to speak the
whole target, so a note filed under a private folder read the folder structure aloud. The
label is now the target's final path segment only, in **both** branches - the separator set is
`/` and `\`, a trailing separator falls back to the last non-empty segment, and a target of
only separators speaks nothing - and a target that is itself a bare URL is reduced to its host
with any userinfo stripped, in either position of `speakUrls`. Evidence, from bundling the real
`src/text/extract.ts` from the tree and from base `789d3c2` side by side with the repo's own
esbuild: **0 newly-spoken folder, drive or credential sentinels across 731,136 probe cells**
(645,120 in the sentinel privacy matrix plus 86,016 in the adversarial-context matrix), with
sentinel-bearing cells falling from 263,680 on base to 6,144 and every shape that still speaks
one also speaking it on base; and `sourceIndex` clean over **747,008 cells**, checked
numerically by UTF-16 code-unit index for length, monotonicity, bounds and character identity.
**Nothing was observed in Obsidian.** CDP port 9222 was unreachable during that ticket, so what
Obsidian itself displays for a folder-qualified wikilink is still unknown.

Two residual leaks on that same path half, recorded so the paragraph above is not read as
finishing it. `[[folder/Note\]]` still speaks its folder: the trailing backslash is consumed as
an escape, so the construct is never recognised as a wikilink at all, no reduction runs, and the
raw text falls through to prose. 10 cells, byte-identical on both sides of NRL-46, pre-existing,
tracked as **NRL-66**. And `[[a/b%%SECRET%%]]` speaks `b%%SECRET%%`: a wikilink label is emitted
raw so `sourceIndex` can map every character to its exact offset, which is also why `cleanLine`'s
comment branch never runs on it. Strictly better than the base, which spoke the folder as well,
but it discloses hidden text and is filed High as **NRL-67**. Both are pinned in
`tests/extract.test.ts` (`pin-unterminated-by-escape`, `pin-comment-inside-target`) so they can
only change deliberately.

The **image** half has not moved. `srs.md:365` promises that an image's "destination and any
quoted title are never spoken", and two shapes still speak one, in **both** positions of
`speakImageAlt`: a label holding another bracket construct (`![a [[N|l]] b](dest.png)`) and an
alt text crossing a soft line break (NRL-44 F9, also filed on its own as **NRL-63** because it
is the privacy item). A third speaks a fragment of one, `![alt](dest(1).png)` saying `.png)`.
All three are pre-existing, all are tracked, and none was opened by NRL-21. **Do not record
R-M09 as met until they close**, and the headline count stays at 2 of 16: NRL-46 closed a
leftover, not the requirement.

R-M10 (speech segmentation) did not move the count either, and the reason is different
from R-M09's. Its acceptance criteria are met on the automated evidence and the evidence
is strong: NRL-28 shipped `src/text/segment.ts`, CJK splits at its full-width terminators,
the hard cap never cuts a grapheme, English is byte-identical over 4,000 generated prose
fixtures, and verification confirmed all of it against ICU and against the merge base over
corpora in the hundreds of thousands, in both segmenter positions. What is missing is not a
gap in the code, it is that **nothing was observed in Obsidian**. Two things follow, and
either alone is enough to stop the count moving. Whether `Intl.Segmenter` exists on the
Obsidian WebView at all is unknown, and the no-segmenter branch collapses CJK straight back
to one chunk, so the requirement's central behaviour may not happen on the target runtime;
calling a MUST met on bare-Node probes in that situation is exactly what rule 11 above
forbids. And the audible consequence is unheard: a 360-unit Chinese paragraph now produces
60 utterances where `main` produced 2, and a 1,200-unit one produces 200 where it produced
6. That is correct by design and `mergeShort` deliberately will not fold it, but nobody has
heard whether sixty six-character utterances sound like speech or like a stutter. So the
headline count stays at 2 of 16. Move it when someone has read a CJK note aloud in a real
Obsidian and confirmed the segmenter is there.

One thing R-M10 does *not* cover, recorded so it is not mistaken for it. The grapheme snap
is on the hard split only: `splitOversized` snaps every cut back to a cluster boundary and
`splitSentences` does not, so a non-ASCII terminator followed directly by a combining mark
can still end a chunk inside a combining sequence. Degenerate text only, no natural prose
reaches it, and it is already written down in three places - `srs.md:376`, ADR 0009's
grapheme-safety consequence, and the comment on `splitSentences` itself.

Word granularity inside a run of Han used to sit beside that one. It no longer does. NRL-47
(`docs/adr/0014-cjk-word-granularity.md`, `srs.md:689` under R-S03) made `findWords`
subdivide a regex span containing Han, Kana or Hangul instead of leaving a whole CJK sentence
as one span, so the word highlight advances inside a CJK sentence. The evidence is bare-Node
measurement at `02cd72f` against base `d7e64df`, bundling the real modules: Chinese went from
3 chunks of 1 span to 3 of 4, Japanese from 1 span to 6, unspaced Korean from 1 to 12, English
unchanged at 15, Latin/Cyrillic/Greek/Arabic byte-identical across 15,000 comparisons, and
`sourceIndex` lockstep held with 0 failures over 65 hand-built chunks plus 4,000 fuzz strings.
R-S03 is a SHOULD, so the headline count above does not move, and that count is not what this
paragraph is about.

**Nothing was observed in Obsidian**, so do not read the numbers above as a claim that a
reader sees the fix. CDP port 9222 was refused, so no deploy-and-smoke happened, and rule 11
applies exactly as it does to R-M10. Two things specifically remain unheard or unseen. Whether
the Obsidian WebView has a word segmenter at all is the same open question R-M10 carries, and
it matters more here: the no-segmenter fallback deliberately keeps the old one-span-per-sentence
behaviour, so on a runtime without `Intl.Segmenter` the fix does not happen. And nobody has
watched a 4-span Chinese sentence or a 12-span Korean one highlight in a real editor, so
whether that granularity reads as speech or as flicker is unknown.

Two leftovers from NRL-47 itself, from the PR rather than rediscovered later. `hasCjkScript`
covers Han, Kana and Hangul only, so Thai, Lao, Khmer, Myanmar and Tibetan still get one span
per run - they write no spaces either, and they were out of scope, not overlooked. And Korean
extraction measured 1.82x slower, 10.2 ms to 18.7 ms over 9,200 units, which is the per-syllable
grapheme cut doing its work.

The remaining gaps are tracked in Linear. Notable reproduced defects, so you do not
rediscover them:

- Rename and delete handlers exist as of NRL-51: `this.app.vault.on("rename")` and
  `("delete")` in `onload`, both through `registerEvent`. One path-boundary-safe prefix
  sweep covers stored positions for files and folders with no type branch. Repeated events
  for an already-moved or dropped prefix are no-ops. The sweep lives in `src/settings/data.ts` as
  `moveReadingPositions` / `dropReadingPositions`, not in main.ts, because main.ts cannot
  run in the suite at all. Both handlers assign a new map to the `positions` *field*; the
  root container is never rebuilt.
  **A rename or a delete stops an in-flight reading of that note, and the comparison is
  against `oldPath` / the deleted path, not the new one.** Both halves are load-bearing.
  The queue is not retargeted - `SpeechChunk.id` hashes `filePath`, so rewriting it without
  recomputing the id would desynchronise the field from its own definition - and the queue
  therefore keeps reporting the *old* path until the next `play()`. So a handler that
  compared `newPath === player.getFilePath()` would never fire, and one that skipped the
  stop would let the next progress event write the old key back, recreating the orphan the
  handler just cleaned. The cost is user-visible: the audio stops on an exact-path match.
  **Folder playback is a remaining limit:** the stop comparisons use exact equality, not
  the helpers' prefix predicate. A folder-only event does not stop a descendant's queue;
  later progress can recreate its old key. Whether Obsidian also emits descendant events
  is unverified, so helper coverage does not establish end-to-end folder correctness.
  A stop that flushes a pending position can also overlap the handler's `saveData()` call.
  These writes are not serialised; their completion order and durable result have not been
  verified in Obsidian. An older write could restore an old or deleted key on disk. There is
  no measured bound on the race and no guaranteed later save before shutdown, so it is not
  established as harmless or self-healing. A serialised save queue remains unimplemented.
- Reading positions are throttled with a leading edge and a trailing flush, in
  `src/settings/positionThrottle.ts`, not in main.ts, and the window is flushed from the
  player's `state` subscription on `paused` / `idle` / `finished` rather than from
  `stopReading()` or the `toggle()` call sites. The captured pending index is written, never
  `getIndex()`, because on natural completion `getIndex()` is `chunks.length` and resolves to
  no chunk. The pre-change gate recorded nothing inside its window and its timer only
  nulled the handle, so the last position of a read was simply never persisted; measured
  with a replica of it, 5 progress events produced 2 saves and index 4 was dropped. A second
  in-flight save race exists on a rate nudge and is pre-existing. The `registerEvent` wiring
  and the state-subscription flush are **not covered by the committed suite**: `obsidian`
  has no runtime in bare Node. Prior scratch probes used a stub, not a real vault. R-M12
  remains unverified in Obsidian, including stop, quit, reopen and resume; this merge does
  not raise the MUST audit floor.

- `DEFAULT_SETTINGS.engine` became `"auto"` in NRL-24 (docs/adr/0010), the same shape as
  `speakImageAlt`'s default flip in NRL-21/ADR 0008: a genuinely fresh install, or any
  `data.json` predating this build, now speaks via automatic quality-ranked selection
  instead of the old default of unavailable Kokoro. `Settings.engine` widened to
  `EngineSelection = "auto" | EngineId`; a saved manual pin round-trips unchanged through
  `normaliseSettings()`'s new validation, never coerced to `"auto"`. Unverified as of NRL-24
  Implement: whether `SpeechSynthesisVoice.localService` (the fail-closed gate that keeps
  Web Speech out of the automatic chain unless a voice is confirmed local) reports anything
  meaningful inside Obsidian's own Electron/Chromium on Linux, and real GPU detection
  end-to-end in that same build - both only checkable in a real Obsidian, not bare Node.
- `speakImageAlt`, `speakEmbeds` and `skipFrontmatter` became live `ExtractOptions` fields in
  NRL-21 (`docs/adr/0008`), and all nine content keys now have one toggle each in the
  settings tab's "Content" group. `offlinePreferred` is the only reserved key left, and
  still has no toggle by design (`docs/adr/0001` clause 6). Two consequences worth knowing:
  `speakImageAlt` defaults to `true`, so this is the one upgrade that changes what an
  existing user hears; and spoken frontmatter runs its lines through `cleanLine` with
  `blockComments` false and discards the returned `openComment`/`openCode`, which is what
  stops a YAML value opening a comment or code span that silences the note body. Do not
  "simplify" either half of that.
- Stop and Repeat on speechd do reach the daemon as of NRL-41: `synthesize()` subscribes to
  the `AbortSignal` the player already hands it and issues `spd-say -S`. Do not "simplify"
  either half of that. `-S` is SSIP `STOP ALL`, which is **not** connection-scoped, and that
  is the only reason it works at all, since our own client has been SIGKILLed by the time it
  runs; the cost is that it also cuts off whatever another client sharing the daemon (a
  screen reader) is saying at that instant. So it must never fire unless one of our own
  utterances is in flight, which is why an abort seen on entry, a successful utterance and an
  idle `dispose()` all deliberately send nothing. `-C` (`CANCEL ALL`) stays banned: it would
  flush the other client's whole queue. `tests/engine.test.ts` pins all five cases and the
  reasoning lives on `stopDaemon()`. What remains is about 800 ms of speech after a Stop, and
  as of NRL-43 that is **accepted, not outstanding** (`docs/adr/0016`). Do not attempt to fix
  it by reaching for a better cancel verb, because that was tried and measured: a full SSIP
  socket client using `CANCEL self`, which the daemon acknowledges with `703 CANCELED` for the
  queued message *and* the speaking one, leaves the tail at 810/800 ms against the same
  810/800 ms for `-S`. A single-utterance probe had audio *starting* ~700 ms after the cancel
  was acknowledged, and `701 BEGIN` fires 3-10 ms after queueing, so SSIP never reports when
  sound really starts or stops. The speech is already committed to the daemon's output module
  and PulseAudio by the time any stop arrives. Two costs therefore stand, both deliberate and
  neither a latency problem: `-S` still cuts off another client sharing the daemon, and the
  Player can still run a chunk ahead after a stop because `-w` is not an audio-end signal
  (`CONTEXT.md` explains that part).
- Stop now aborts a read that is still in its load phase, as of NRL-48 (`docs/adr/0013`).
  Before it, `main.ts` held no `AbortController` at all and `Player`'s own one is created
  inside `play()`, so during `beforeAttempt`'s `await engine.prepare()` a Stop was
  unobservable by any route and the note started speaking once the model finished loading.
  `main.ts` now owns a per-read `readScope` controller, superseded at the top of all three
  read paths and aborted in `stopReading()` and `onunload()`, and `playWithFallback()` takes
  an 8th optional positional `signal` which it checks at the top of each iteration and again
  between a finished load and `play()`. Two halves are deliberate and must not be
  "simplified". An abort resolves `null` and never fires `onFallback`, because a user Stop is
  not a candidate failure - the callers disambiguate the two `null`s with
  `scope.signal.aborted` before the "no speech engine is available" Notice and before arming
  the sleep timer. And `raceAbort()` converts the load's rejection into a *value* at
  race-setup time rather than catching it later, which is what stops a post-abort rejection
  becoming either an unhandled rejection or a fallback trigger; the abort arm resolves rather
  than rejects, so no rejecting arm exists. The load is abandoned, not cancelled: bytes keep
  downloading and a finished model is kept for the next read, so Stop does not free work in
  flight. Evidence is **bare-Node only** - `tests/fallback.test.ts` T1-T4 plus an independent
  probe bundling the real `fallback.ts` against the real `Player`, both showing 8 FAILURE(S)
  at the pre-fix base `d7e64df` and green at the fix. **Nothing was observed in Obsidian**,
  and one known leftover is on-screen rather than audible: the `Loading X...` Notice is built
  with duration 0 and hidden only in the abandoned `prepare()`'s `finally`, so after a Stop
  during a cold Kokoro load it lingers until the load finishes on its own (measured in a
  transcribed harness as HIDE at +352 ms for a Stop at +51 ms of a 350 ms load). NRL-65
  tracks that. So R-M07 is **not** recorded as fully met, and the `2 of 16` MUST headline
  count above does not move.
- `cleanLine` is called once per source line, but since NRL-42 that is no longer the whole
  story: an inline code span may cross a soft line break, so `Cleaned.openCode` carries the
  length of a run left open and `codeSpanClosesLater` confirms a later line closes it. The
  confirmation is load-bearing, not an optimisation. An unmatched backtick run is literal
  text, so arming the carry without it stops the next line's `%%` being seen as a block
  opener and reads hidden text aloud - which is exactly what happened to six fixtures
  during NRL-42's review. Do not weaken that lookahead or the `interruptsParagraph` rule
  that stops it at a comment-opening line.
- NRL-42 fixed only the spoken half of ADR 0006 clause 4. With inline code *skipped* a
  soft-wrapped span is still neither silenced nor kept literal, and four related shapes
  (N1, N2, F4, F5 in that ticket) remain. All were observed against the pinned merge base
  and are pre-existing rather than merge drift; `tests/extract.test.ts` pins the current
  behaviour with `pin-skipped-code` so it can only change deliberately. NRL-44 tracks it.
- NRL-39 handed NRL-44 a second shape, on the *spoken* side this time. An autolink inside a
  confirmed soft-wrapped code span is dropped rather than kept literal: a paragraph whose
  backtick span opens on line 1, carries `<https://x.com>` on line 2 and closes on line 3
  speaks `Before first X last after.` with inline code spoken, where the pre-NRL-39 base
  spoke `Before first X < last after.` (measured on merged main at d4de134 and on base
  1b1afe1 by bundling both extractors). So the merge removed the stray `<` without making
  the span literal, and `srs.md` only ever promised literalness for `%%` and `<!--`, never
  for URLs. Do **not** "fix" it by guarding the autolink branch alone: the bare-URL branch
  would then fire on the same text and put the spoken `<` back. Literalness needs the
  bare-URL branch guarded by `literalCodeEnd` too, which the autolink branch is not.

## Style

- No em-dashes. A plain hyphen or a rephrase.
- Comments explain *why*, and are worth writing when the reason is not reconstructable
  from the code. The existing comments in `player.ts` and `kokoro.ts` are the house style.
- Say what is true, including when something failed, is unverified, or you are guessing.
