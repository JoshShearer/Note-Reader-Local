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
npm test          # 6 suites: extract, engine, player, paths, kokoro, settings
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
does not call the `espeak-ng` binary, which is not installed on this machine, so the
`espeak.ts` engine has no real-binary coverage. It is a Linux desktop test and will fail
elsewhere.

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

The working tree passes its gates, and an audit against `srs.md` found 2 of 16 MUST
requirements fully met. The gap is tracked in Linear. Notable reproduced defects, so you
do not rediscover them:

- `speakImageAlt`, `speakEmbeds` and `skipFrontmatter` are stored in plugin data v1 but
  never read by `extract.ts`; they have no toggle by design (`docs/adr/0001`). Making
  those exclusions configurable is NRL-21.
- Pause is a no-op on speechd and webspeech: it pauses an `<audio>` element they never use.

## Style

- No em-dashes. A plain hyphen or a rephrase.
- Comments explain *why*, and are worth writing when the reason is not reconstructable
  from the code. The existing comments in `player.ts` and `kokoro.ts` are the house style.
- Say what is true, including when something failed, is unverified, or you are guessing.
