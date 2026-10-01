---
description: Adversarially review the current changes against this codebase's real failure modes, score the risk, and record a verdict that /ship can read.
---

Rules and gates: `AGENTS.md`. Architecture: `CONTEXT.md`. Spec: `srs.md`.

Runs standalone, and `/ship` invokes it as its adversarial gate (Step 6). `/ship` reads the
verdict from `.claude/last-critique.md` and reuses it only when the recorded commit matches
`HEAD` and the recorded mode is a code review. Step 5 below writes that file; keep its shape.

**This command is read-only.** It reports. It does not fix, does not stage, does not commit.
The only file it writes is `.claude/last-critique.md`.

## Usage

| Invocation | Scope |
|---|---|
| `/critique` | Uncommitted, staged and branch commits (depth auto-detected) |
| `/critique workflow` | All of `.claude/` (always L2) |
| `/critique architecture` | `CONTEXT.md`, `srs.md`, `src/audio/types.ts`, `src/audio/player.ts`, `src/text/extract.ts`, `src/engines/registry.ts`, `src/settings/index.ts` (always L2) |
| `/critique "<question>"` | Adversarial evaluation of one decision (always L2) |

`$ARGUMENTS` selects the mode. Empty means the diff.

## Your stance

You are not approving. You are finding what is wrong, what could break, and what was
overlooked. You succeed when you find a real issue. You fail when you rubber-stamp.

**Evidence requirement.** Every criticism cites one of:

- A specific code path that breaks, as `file:line` you actually opened
- A concrete input that produces the wrong output, runnable
- A test that is missing, or one that was weakened
- A measurable risk: an unhandled rejection, a race on `runToken`, an unbounded log, a leaked
  object URL, a worker that never settles
- A contradiction between `srs.md`, `CONTEXT.md` or `AGENTS.md` and the implementation

No evidence means it is a **question** ("Have you verified that...?"), not a finding, and it
does not move the score.

**This repo punishes reasoning-from-reading.** Every defect in the `AGENTS.md` Known state list
was invisible to the test suite and obvious the moment the function was run on real input.
When a finding is about `extract.ts`, `words.ts` or `player.ts`, bundle the module and run it:

```bash
node build-tests.mjs tests/extract.test.ts && node tests/.build/extract.test.mjs
```

A finding you reproduced outranks three you inferred.

## Step 1: Identify changes

```bash
BASE="$(git merge-base origin/main HEAD)"
git diff --stat "$BASE"
git diff --name-only "$BASE"
git log origin/main..HEAD --oneline
```

The merge base, not `HEAD`. `git diff HEAD` shows only uncommitted work, and `/ship` calls this
after committing, so with `HEAD` as the base every check below inspects an empty diff and
reports clean on code it never read. If `git diff --name-only "$BASE"` prints nothing on a
branch with commits, the range is wrong, not the code.

`workflow` and `architecture` use their own file lists instead.

## Step 2: Auto-pass check

Skip the review only when **every** changed file is `*.md`, `package-lock.json`, or
whitespace-only. Then report `Auto-pass: docs only, no code changes to review.` and stop.

`srs.md` is **not** auto-pass. An edit to `srs.md` is a change to the acceptance criteria, and
`AGENTS.md` requires an ADR in `docs/adr/` alongside it. Review it as a change.

`workflow` and `architecture` bypass auto-pass.

## Step 3: Risk assessment

Score the diff. These are the areas where a mistake in this repo is silent rather than loud.

| Factor | Points | Condition |
|---|---|---|
| Source-offset mapping touched | +2 | `src/text/extract.ts` or `src/audio/words.ts` changed. `sourceIndex` is the highlighting mechanism and a break in it corrupts rather than crashes. |
| A log or error call site touched | +2 | `src/diagnostics.ts` changed, or a new `trace(`, `reportError(`, `new Notice(`, `console.` or `new Error(` added anywhere under `src/`. `trace()` stringifies whatever it is handed. |
| Kokoro network guards touched | +2 | `isRemote`, `assertLocal`, `installFetchShim`, `resolveLocal`, `allowRemoteModels`, `useFS` or `wasmPaths` changed in `src/engines/onnx/`. |
| Rate handling touched | +2 | `ownsPlayback`, `playbackRate`, `req.rate`, `setRate` or `speed` changed in `src/audio/` or `src/engines/`. 2.25x shipped once. |
| Settings normalisation touched | +2 | `normaliseSettings` or `DEFAULT_SETTINGS` in `src/settings/index.ts` changed, or a new `saveData` call added. |
| Node builtin import moved | +2 | `child_process`, `fs`, `path`, `os` or `node:` appears on an added line, or `src/engines/system/spawn.ts` / `src/engines/registry.ts` changed. `isDesktopOnly: false` is a promise. |
| Worker or bundle boundary touched | +1 | `esbuild.config.mjs`, `kokoro.worker.ts`, `browser-environment.ts`, or `manifest.json`. |
| Engine contract changed | +1 | `src/audio/types.ts` changed, or a capability flag flipped on any engine. |
| No test changes alongside code | +1 | Nothing under `tests/` modified while `src/` was. |
| New dependency | +1 | `package.json` `dependencies` or `devDependencies` gained an entry. |
| Deletes more than it adds | +1 | Net negative diff. |
| Files changed > 8 | +1 | |

**Depth:**

- 0-1 → **L1** (Quick Challenge, roughly 500 tokens)
- 2-3 → **L2** (Full Protocol, roughly 2000 tokens)
- 4+ → **L2+Double** (two independent runs, lower score wins)

Report the score and every contributing factor **before** reviewing, so the depth is not chosen
after you know what you found.

## Step 4: Review

### L1 - Quick Challenge

Three questions, answered against the diff:

1. **Most likely failure mode.** What breaks first on a real note in a real Obsidian? Name the
   input.
2. **The untested path.** Which branch has no coverage in the suites `npm test` runs?
   (`AGENTS.md`'s quality-gates block is the one place that names them.)
3. **The implicit assumption.** What does this assume without validating? Check it against the
   four structural gaps in `CONTEXT.md`: `Player` has no file identity, capabilities are
   advertised and not consumed, there is no engine fallback chain, segmentation is one regex.

Verdict: PASS / CONCERNS / BLOCK with brief reasoning.

### L2 - Full Protocol

Five phases, sequential, no skipping.

1. **Claim extraction.** List every explicit and implicit claim the change makes. Read the
   changed files whole, not just the hunks. State the intent, the scope and the blast radius.

2. **Adversarial verification.** For each claim, seek counter-evidence. **At least half the
   investigation must seek disconfirmation.** Trace the real call chain; do not trust the
   comments, which are house-style explanations of intent and can outlive the code. Check the
   inputs this repo actually breaks on: a note whose line 1 is `---`, a wikilink, an `![[embed]]`,
   a fenced block, a bare URL, a table, CJK text with no `.!?`, a single-word note, an empty
   note, a note with no trailing newline.

3. **Belief gap analysis.** What the author wishes were true versus what the code does. Does the
   change respect the layering in `CONTEXT.md`: engines know nothing about documents or the
   editor, `Player` is the only thing that decides what is spoken next, `spawn.ts` is the only
   `child_process` touch point?

4. **Pre-mortem.** "Two weeks after shipping, this caused a report. What happened?" Three
   scenarios, each tied to a `file:line`. Useful shapes here: the highlight drifted by one
   character on notes containing a certain construct; the plugin failed to load on Android; the
   diagnostics log contained a sentence from a private note; two sentences spoke over each other;
   a reading position was silently erased.

5. **Verdict.** Score 0-100. PASS (80+), CONCERNS (50-79), BLOCK (<50).

Number findings `F1`, `F2`, ... with severity `HIGH` (will break, or violates a non-negotiable),
`MEDIUM` (likely rework), `LOW` (worth fixing, not blocking).

### L2+Double

Two independent L2 reviews. The second must not reference the first. Then:

- Scores diverge by more than 10 → the lower wins
- Both PASS → PASS
- Either BLOCK → BLOCK
- Otherwise → CONCERNS

## What to attack in this codebase

Generic review misses everything that matters here. Work through these. Each is checkable, and
an answer of "probably fine" is not an answer.

### Privacy: can any log line now carry note text

`trace()` (`src/diagnostics.ts:7`) does `String(detail ?? "")` for a non-Error detail and
`detail.stack ?? detail.message` for an Error, and appends the result to
`local-tts-diagnostics.log` in the vault. It sanitises nothing. So the question is never "does
`trace` leak", it is "what did the call site hand it".

```bash
rg -n 'trace\(|reportError\(|new Notice\(|console\.(log|warn|error)' src/
```

For every added or changed call site, answer: is the detail a count, an id, a duration or a
fixed string? The ceiling in this repo is `${source.length} chars` in `src/main.ts`. Anything
carrying `chunk.text`, `req.chunk.text`, `source`, a selection, or `msg.text` is a **BLOCK**.

The non-obvious path: an `Error` whose *message* was built from note text. `reportError` puts
that message in a user-facing `Notice` **and** in the log. An engine that throws
`new Error(\`could not speak "${req.chunk.text}"\`)` leaks through both. Check every added
`throw` in `src/engines/`.

Also check the log stays bounded: `diagnostics.ts:18` slices to the last 256KB. A change that
removes the slice turns a reading session into unbounded vault growth.

### Privacy: can speech text reach a process argv

`ProcessRunner.run(bin, args, stdin, signal)` writes the third parameter to `stdin`
(`src/engines/system/spawn.ts`). `espeak.ts` and `speechd.ts` both pass `req.chunk.text` there,
and `speechd.ts:121` is the pattern to match. A command line is visible in `ps` and is echoed
in spawn error messages.

```bash
rg -n 'runner\.run\(|runner\.spawn\(' src/engines/
```

For each: is `chunk.text` the third argument, or did it get pushed into the `args` array? Any
`args.push(req.chunk.text)`, template-literal argument, or shell invocation is a **BLOCK**. Also
check `spawn.ts` still uses `spawn` with an args array and never `exec`, `execSync` or
`shell: true`.

### Network: can anything fetch a remote URL

There is exactly one sanctioned outbound fetch in this plugin: the Hugging Face download in
`src/ui/modelStore.ts`, reachable only from the Download button in the settings tab.

```bash
rg -n 'fetch\(|XMLHttpRequest|requestUrl|https?://' src/
```

Three questions:

1. **Is the new fetch user-initiated?** A fetch reachable from `onload`, `onLayoutReady`,
   `warmUpEngine`, `prepare()`, `isAvailable()` or the settings tab's render path violates
   non-negotiable 6 even if the URL is legitimate. `main.ts` prewarms on layout ready; anything
   it can reach must be local.
2. **Do the worker guards still hold?** `isRemote` (`kokoro.worker.ts:171`) returns false for
   any non-http(s) scheme and otherwise compares origin against `self.location.origin`.
   `assertLocal` (`:152`) is called three times in `initInner` (`:232-234`) for the model base,
   the ORT glue module and the ORT WASM binary. The fetch shim (`:135`) throws on a remote URL
   that did not resolve to a local model file. Check: all three `assertLocal` calls present, the
   shim's `isRemote` branch present, no host allowlist added, and the comparison not inverted.
   `env.allowRemoteModels = false`, `env.useFS = false`, `env.useFSCache = false`,
   `env.useBrowserCache = false` (`:244-253`) all still set. Weakening any of these to fix a
   load path is the exact failure `AGENTS.md` 5 names: fix the path, not the guard.
3. **Is there anything telemetry-shaped?** `sendBeacon`, an analytics import, a crash reporter,
   a "share diagnostics" button that posts anywhere. Any of these is a BLOCK.

### Offsets: does sourceIndex stay in lockstep with every dropped span

`cleanLine` (`src/text/extract.ts:28`) maintains `chars` and `index` in parallel through a
dozen early `continue`s. The invariant is `chars.length === index.length` at every exit, and
every dropped span records exactly one synthetic space via `pushSpace`.

Read every `continue` added or moved by the diff and answer whether it emitted. Note the two
existing shapes that already differ: the emphasis-marker branch (`:142-145`) drops `*`, `_`,
`~` with **no** `pushSpace`, which is deliberate because the characters are inside a word; the
image branch (`:68`) and the fence branch (`:60`) do push. A new branch has to pick one on
purpose.

Two joins insert a space that exists in neither input and each pushes a `gap` entry:
`mergeShort` (`:205-207`) and the paragraph accumulator (`:379-384`). A third join site that
forgets shifts every offset after it by one, forever, with no error.

The cheap proof, which is stronger than reading:

```bash
node build-tests.mjs tests/extract.test.ts && node tests/.build/extract.test.mjs
```

Then assert directly, over a real note from the vault, that `chunk.sourceIndex.length ===
chunk.text.length` for every chunk and that `source.slice(t.sourceStart, t.sourceEnd)` for each
word timing is that word. If `tests/extract.test.ts` does not already assert the length
equality, that is a finding in itself.

And separately: is highlighting still offset-driven? `src/ui/highlight.ts` takes `from`/`to`
from `timing.sourceStart`/`sourceEnd`. Any `indexOf`, `search`, or `doc.toString().indexOf` of
spoken text against the editor document is a BLOCK, regardless of whether it happens to work.

### Rate: is it still applied exactly once

Two lines carry this. `player.ts:183` passes
`rate: engine.capabilities.ownsPlayback ? this.rate : 1`, and `playBuffer` sets
`this.audio.playbackRate = this.rate` (`:224`). So a buffer engine renders at natural speed and
the element applies the rate; an `ownsPlayback` engine is told the rate and the element is not
involved.

Check all four of these:

- The ternary at `player.ts:183` is intact and not simplified to `this.rate`.
- No engine both declares `ownsPlayback: true` and returns `kind: "buffer"`. Today: `espeak`
  and `kokoro` are `ownsPlayback: false` + `buffer`; `speechd` is `true` + `streamed`;
  `webspeech` is `true` + `live`. A new engine or a flipped flag breaks the invariant.
- `setRate` (`:360`) still sets both `this.rate` and `audio.playbackRate`, and does not also
  re-synthesise.
- The tests still assert the values. In `tests/player.test.ts`, under the heading
  `rate is applied once, not twice`: `buffer engine asked to render at natural speed` expects
  `seen[0] === 1`, `player still plays it faster` expects `playbackRate === 1.5`, and
  `engine that owns playback is given the rate` expects `seen[0] === 1.5`. If any of those
  three numbers changed, the test was weakened, and that is a BLOCK rather than a concern.

`words.ts` receives the rate too (`allocateWordTimings(chunk, duration, rate)`), which affects
the lead-in only. Confirm a rate change there does not also scale the per-word durations, or
the highlight drifts at non-1x speeds while the audio is correct.

### Mobile: does main.js still require only the three allowed modules

The esbuild `external` list contains a dozen CodeMirror packages plus every node builtin, so
the config is not the check. The emitted bundle is.

```bash
npm run build
grep -oE 'require\("[^"]+"\)' main.js | sort -u
```

The result must be exactly `obsidian`, `@codemirror/view`, `@codemirror/state`. Anything else,
and especially `child_process`, `fs`, `path` or `os`, means a node builtin now evaluates at
module scope on Android, where the plugin is loaded because `manifest.json` says
`isDesktopOnly: false`.

Then confirm the shape that keeps it that way: `spawn.ts` reaches `child_process` only through
`await import("child_process")` inside method bodies, and `kokoro.worker.ts` is a separate
bundle. `registry.ts`'s `createEngines` constructs `EspeakEngine` and `SpeechDispatcherEngine`
only when `shouldConstructLinuxDesktopEngines` (`src/engines/platform.ts`) passes, which is Linux
desktop specifically and narrower than not-mobile: a macOS or Windows desktop is not mobile and
still gets neither. A top-level `import { spawn } from "child_process"` typechecks, builds, passes
every test, and breaks the plugin on a phone.

### Settings: does normaliseSettings preserve unknown keys

Read `src/settings/index.ts:107` and `src/main.ts:371`. Today `normaliseSettings` returns a
fresh object literal containing only the keys in `Settings`, and `saveSettings()` writes
`this.settings` straight to `saveData`. Nothing else currently writes plugin data, so no key is
being lost today. That makes this latent rather than live, and it makes any change that adds
persisted state the moment it becomes live.

So the finding to look for is not "normalisation is a whitelist". It is:

- Does the diff add a `saveData` call, or a new key written through plugin data (a reading
  position for R-M12, a per-note config for R-C04, a queue for R-C03)? If yes, and
  `normaliseSettings` still rebuilds from a literal without carrying the rest of `raw` forward,
  then the next rate nudge erases it. That is a BLOCK, and the fix belongs in the same change.
- Did the diff add a `delete`, an `Object.keys` filter, or a `saveData(normaliseSettings(...))`
  round trip that discards what it did not recognise?

### Player and session: what does the change assume away

`CONTEXT.md` lists four structural gaps. A change that quietly depends on one of them being
absent is worth a finding:

- `Player` holds chunks, an index and a rate, and no file path or document identity. Anything
  resembling per-note state bolted onto `Player` needs saying out loud.
- Capabilities are advertised and consumed at three call sites, one of which is a label. If the
  change adds a control, does it read the active engine's capability first? `speechd` has
  `timing: "none"`, so highlighting cannot work there at all.
- There is no fallback chain. A failing engine produces a notice telling the user to change a
  dropdown. A change that assumes a retry exists is wrong.
- Segmentation is `/[.!?…]+["')\]]*\s+/g` with no `Intl.Segmenter`, so CJK is never split and
  lands in `splitOversized` at 220 characters.

And the reproduced defects in `AGENTS.md` Known state are live in the tree. A change in their
neighbourhood that neither fixes nor accounts for them is worth naming: `replayCurrent`
(`player.ts:370`) truncates `chunks` and restarts, corrupting `n / total`; `primeBuffer`
(`:201`) prefetches against engines where `synthesize()` *is* speaking, so speechd and webspeech
overlap; `pause()` (`:333`) pauses an `<audio>` element those two engines never use;
`ExtractOptions.skipCode` and `.skipUrls` are rendered as toggles and never read.

### Concurrency and lifetime

`Player` guards against superseded runs with `runToken` and an `AbortController`. The worker
guards with `currentGeneration`. Both are easy to break.

- Does every `await` in `run()` and `playBuffer()` still re-check `token === this.runToken` and
  `signal.aborted` afterwards? An added await without a recheck lets an abandoned chunk advance
  `this.index`.
- Does `stop()` still clear `pending`, revoke every object URL, and call
  `engine.cancelPending?.()`? Dropping the last one leaves the Kokoro worker grinding through
  sentences nobody is waiting for; that was measured at 45s once, per the comment at
  `kokoro.worker.ts:411-422`.
- In the worker, does `drain()` still `await yieldToMessages()` before each job? Without it a
  `cancel` message is not seen until the queue has been fully synthesised.
- Does anything added inside the worker post a message without checking
  `generation !== currentGeneration`?

### Spec alignment

If the change claims a requirement, open that requirement in `srs.md` and read it. The headings
are `### R-M01` through `### R-C05`. Does the code satisfy the text, or only resemble it?

Note the deliberate vocabulary mismatch recorded in `CONTEXT.md`: the spec says `TTSBackend` /
`TTSCapabilities` / `TTSVoice` / `SpeechSegment`, the code says `SpeechEngine` /
`EngineCapabilities` / `VoiceInfo` / `SpeechChunk`, and `SpeechChunk` lacks the `id`, `sequence`,
`blockType` and `filePath` that `SpeechSegment` has. Renaming toward the spec is a real change
with a real blast radius, not a tidy-up.

If the change deviates from `srs.md`, `AGENTS.md` requires an ADR in `docs/adr/` and an
amendment to `srs.md`. That directory does not exist yet. A deviation with no ADR is a finding.

### Claims in the diff itself

`AGENTS.md` 13: never assert a measurement you did not take. Scan added comments, added `srs.md`
prose and the commit messages for a number with a unit: ms, MB, x faster, a ratio, a thread
count. For each, was it measured this session, or is it cited? An unsourced number is a finding
at LOW unless it is load-bearing for a decision, in which case MEDIUM.

## Step 5: Record the verdict

Write `.claude/last-critique.md`, overwriting it:

```markdown
## Last Critic Verdict
- **Date:** <ISO 8601 timestamp>
- **Commit:** <full HEAD hash at review time>
- **Mode:** Code Review
- **Depth:** L1 | L2 | L2+Double
- **Score:** <0-100>
- **Verdict:** PASS | CONCERNS | BLOCK
- **Risk Score:** <N> (<contributing factors>)
- **Files Reviewed:** <count>
- **Reproduced:** <what you actually ran, or "nothing run">

### Summary
<one line>

### Findings
- **F1** HIGH `src/text/extract.ts:142` - <what it does, the input, the wrong result>
```

Get the hash from `git rev-parse HEAD`. Emit `**Mode:**`, `**Depth:**`, `**Score:**` and
`**Verdict:**` verbatim on their own lines: `/ship` parses them and will discard the file if the
commit does not match `HEAD` or the mode is not a code review.

For `/critique workflow`, `architecture` or a bare question, still record it, but set
`**Mode:** Architecture Review`, `Workflow Review` or `Question` and omit `Commit:`. None of
those read the shipping diff, so `/ship` must not be able to reuse them in place of its gate.

## Step 6: Report

Show the verdict, the risk score with its factors, and every finding with a `file:line` you
actually opened. For CONCERNS or BLOCK, each finding gets a concrete remediation. Say plainly
what you did not check and what you could not reproduce.

## Rules

1. **Be specific.** "This could have bugs" is worthless. A finding reads
   "`<file>:<line>` does X, so input Y produces Z". Name the function you traced:
   `cleanLine` and `splitSentences` are in `src/text/extract.ts`, `allocateWordTimings` and
   `wordAt` are in `src/audio/words.ts`, `isRemote` and `assertLocal` are in
   `src/engines/onnx/kokoro.worker.ts`.
2. **Run it rather than reason about it** whenever the module can be bundled and run. This repo
   has a track record of defects that survived careful reading.
3. **A green suite is not evidence.** The suites run in bare Node against fakes, with a
   `FakeAudio` standing in for the browser. If the change is user-visible and was not exercised
   in a real Obsidian via `npm run deploy`, say so in the verdict.
4. **Do not nitpick style.** There is no linter here and style is not your job. House style is
   the comments in `player.ts` and `kokoro.ts`; matching it is not a finding either way.
5. **Score honestly.** A 95 means you traced the paths and found almost nothing. If you did not
   trace them, you have not earned it. A non-negotiable violation caps the score below 50, no
   matter how good the rest is.
6. **Report, do not fix.** No edits to `src/`, no staging, no commits. Fixes happen after the
   verdict, in a separate pass.
