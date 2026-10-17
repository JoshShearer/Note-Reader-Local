# /critique - Local TTS Reader additions

Rules are `AGENTS.md` "Non-negotiables" 1-10 and "Verification rules" 11-15; numbers in brackets
are those rules. Mechanical greps are in `overrides/check-constraints.md`; this file adds the
adversarial checks a grep cannot do. Before judging a change to extraction, playback, engines,
highlighting, settings or persistence, search `docs/agent-history.md` for the function or ticket:
it records prior regression traps.

## Usage: `architecture` mode (adds to the file list)

`src/audio/types.ts`, `src/audio/player.ts`, `src/text/extract.ts`, `src/text/segment.ts`,
`src/engines/registry.ts`, `src/engines/platform.ts`, `src/settings/index.ts`.

## Your stance: how to reproduce here

This repo punishes reasoning-from-reading: the defects in `docs/agent-history.md` "Known state"
were invisible to the suites and obvious on real input. For `extract.ts`, `segment.ts`,
`words.ts` or `player.ts`, bundle and run: `node build-tests.mjs tests/<suite>.test.ts && node
tests/.build/<suite>.test.mjs`, or drive the bundled module from a scratch script with a real note.

## Step 2: auto-pass

`package-lock.json` counts as a lockfile. `srs.md` is never auto-pass (it needs an ADR alongside).

## Step 4: failure-shaped inputs (L1 q1, L2 phase 2)

A note whose line 1 is `---`, a wikilink, an `![[embed]]`, a fenced block, a bare URL, a table, a
callout, a `%%` comment, a list item holding a quote, CJK with no `.!?`, a one-word note, an empty
note, no trailing newline, a selection that starts mid-word.

Pre-mortem shapes: the highlight drifted by one character after a certain construct; the plugin
failed to load on Android; the diagnostics log held a sentence from a private note; two sentences
spoke over each other; a reading position was silently erased; 1.5x played at 2.25x; the Kokoro
worker fetched from a CDN.

L1 q3 and L2 phase 3: check against `CONTEXT.md` "Known structural gaps" and its layering:
engines know nothing about documents or the editor, `Player` alone decides what is spoken next,
`spawn.ts` is the only `child_process` touch point.

## What to attack: per risk area

- **Logs [1].** `trace()` stringifies whatever it is handed and appends to a vault file, so ask
  what the call site handed it. An engine `throw new Error(\`... ${req.chunk.text}\`)` leaks through
  `reportError` into a `Notice` and the log. Check every added `throw` in `src/engines/`, and that
  the log stays bounded.
- **Argv [2].** For each `runner.run(`/`runner.spawn(`: is the text the stdin argument? `spawn.ts`
  uses `spawn` with an args array, never `exec`/`shell: true`.
- **Network [4-6].** Two sanctioned fetch sites: the Hugging Face download in `modelStore.ts`
  (Download button only) and the bridge transport in `src/engines/bridge/readMe.ts` (loopback,
  Android only). Anything reachable from layout-ready prewarm must be local. In the worker: all
  `assertLocal` calls, the shim's `isRemote` branch and the `env` flags intact.
- **Bridge [1, 4].** Host stays `BRIDGE_HOST` (`127.0.0.1`, not `localhost`); text in the POST
  body, never a URL; the token only in the `Authorization` header and never in a log, notice or
  error; construction gated by `shouldConstructBridgeEngine`. ADR 0036; contract owned by the
  Read-Me repo.
- **Offsets [8].** `cleanLine` keeps `chars` and `index` in parallel through many early
  `continue`s; each dropped span records one synthetic space via `pushSpace`, except deliberate
  in-word drops (emphasis markers). A third join site that forgets its gap entry shifts every later
  offset forever. Prove `chunk.sourceIndex.length === chunk.text.length` and that
  `source.slice(t.sourceStart, t.sourceEnd)` is the word, on a real note.
- **Rate [9].** The `ownsPlayback ? this.rate : 1` ternary in `Player`, the engine
  ownsPlayback/kind matrix, `setRate` not re-synthesising, `allocateWordTimings` using rate only for
  the lead-in, and the three pinned values under `rate is applied once, not twice`. A changed
  value is a BLOCK, not a concern.
- **Mobile [7].** The built bundle is the check, not the esbuild `external` list. A top-level
  `import { spawn } from "child_process"` typechecks, builds, passes every test and breaks Android.
  `shouldConstructLinuxDesktopEngines` is Linux desktop, narrower than not-mobile.
- **Settings [10].** Does the diff add a persisted key (positions, per-note config, a queue)
  through plugin data? Then normalisation must carry unrecognised keys forward in the same change.
- **Lifetime.** Every `await` in `Player.run()`/`playBuffer()` rechecks `runToken` and the abort
  signal; `stop()` clears pending, revokes object URLs and calls `engine.cancelPending?.()`; the
  worker's `drain()` yields before each job and checks `currentGeneration` before posting.

## Extraction findings: what may BLOCK (rule 15, ADR 0039)

Generated inputs are how you test an extraction change, and you should still write your own
generator. But a mismatch only a generated input reaches is a **residual**: list it in your
verdict under "Residuals (generated inputs)" with the shape and the cell count, and do not
BLOCK on it or ask for a ticket. BLOCK only on a regression against base that the vault check,
the suite or a shape a person plausibly types shows, or on a spoken hidden comment body
(`%%`, `<!-- -->`) in such a shape. Run the vault check before and after the change
(`~/.local/share/note-reader-local/vault-check/run.sh <checkout> <out dir outside the repo>`)
and report both totals; a note that newly flags is a real regression.

## Spec alignment

Headings are `### R-M01` to `### R-C05`. The spec says `TTSBackend` / `TTSCapabilities` /
`TTSVoice` / `SpeechSegment`, the code `SpeechEngine` / `EngineCapabilities` / `VoiceInfo` /
`SpeechChunk` (`CONTEXT.md` "Vocabulary"). A rename toward the spec is a real change with a blast
radius, not a tidy-up.

## Rules: green suite

The suites run in bare Node against fakes (`FakeAudio`). "Exercised" means `npm run deploy`, a
reload and real use in Obsidian per `overrides/verify.md`.
