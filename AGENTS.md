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
npm test          # 13 suites: extract, engine, player, paths, kokoro, settings, highlightColour, affordances, engineSelection, webspeechVoices, fallback, espeak, types
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
One confirmed move: R-M14 (backend capability detection) is met as of NRL-22, because
every capability that differs across the four engines now gates the control it affects,
and the ones that gate nothing have no control to gate.

R-M09 (configurable content exclusions) did **not** move, and the reason matters because
NRL-21's title invites the opposite conclusion. Its *configurability* half is met: all six
exclusions the requirement names have a live toggle at the spec's default, each toggle
demonstrably moves extraction in both positions, and inline code is separable from fenced
code. (Measured at `ad1027d` by bundling the real `extract.ts` and sweeping all 512
combinations of the nine content keys.) Its *reduction* half is not. `srs.md:307` promises
that an image's "destination and any quoted title are never spoken", and two shapes still
speak one, in **both** positions of `speakImageAlt`: a label holding another bracket
construct (`![a [[N|l]] b](dest.png)`) and an alt text crossing a soft line break (NRL-44
F9). A third speaks a fragment of one, `![alt](dest(1).png)` saying `.png)`. All three are
pre-existing, all are tracked, and none was opened by NRL-21. Do not record R-M09 as met
until they close.

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

Two things R-M10 does *not* cover, both recorded so they are not mistaken for it. Word
granularity inside a run of Han: `findWords` has no separator there, so a whole CJK sentence
is one word span and the highlight covers it for its full duration - measured at `c29e7af`
as 1 span per Chinese sentence against 15 for a comparable English one. That is NRL-47, and
`srs.md:352` names it under R-M10 as explicitly not met by that requirement. And the
grapheme snap is on the hard split only: `splitOversized` snaps every cut back to a cluster
boundary and `splitSentences` does not, so a non-ASCII terminator followed directly by a
combining mark can still end a chunk inside a combining sequence. Degenerate text only, no
natural prose reaches it, and it is already written down in three places - `srs.md:347`,
ADR 0009's grapheme-safety consequence, and the comment on `splitSentences` itself.

The remaining gaps are tracked in Linear. Notable reproduced defects, so you do not
rediscover them:

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
  reasoning lives on `stopDaemon()`. What remains is the one chunk already queued behind the
  spoken one, about 830 ms, which `-S` cannot reach; NRL-43 tracks it, and `CONTEXT.md`
  explains why the Player runs a chunk ahead on this engine.
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
