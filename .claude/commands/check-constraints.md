---
description: Fast mechanical pass over the 14 numbered non-negotiables and verification rules in AGENTS.md, reporting PASS, BLOCK or N-A for each.
---

Rules: `AGENTS.md`, the numbered list under Non-negotiables (1-10) and Verification rules
(11-14). This command does not restate them, it checks them.

Any **BLOCK** stops `/ship`. There is no override flag and one should not be added.

Keep the output small. Around 1k tokens: a table, then only the rows that are BLOCK or UNKNOWN,
with a `file:line` each. Do not narrate the greps.

## The diff range

Every check diffs against the **merge base**, not `HEAD`:

```bash
BASE="$(git merge-base origin/main HEAD)"
git diff --name-only "$BASE"
```

This is load-bearing. `git diff HEAD` shows only uncommitted work and `/ship` runs this gate
after committing, so with `HEAD` as the base every grep returns empty and the command reports
PASS on code it never looked at. If `git diff --name-only "$BASE"` prints nothing on a branch
with commits, the range is wrong. Fix the range before believing any result.

A grep that returns nothing is evidence only when the diff plausibly could have matched. If the
diff clearly touches `src/text/extract.ts` and the offsets grep is empty, treat the check as
wrong, not the code as clean.

## Verdicts

| Verdict | Meaning |
|---|---|
| **PASS** | The check ran and found no violation. |
| **BLOCK** | A violation, with a `file:line` you read. |
| **N-A** | The diff cannot touch this constraint. Say why in one clause. |
| **UNKNOWN** | Not mechanically decidable, or the check could not be run. Never round this to PASS. |

## The checks

Run these. Each block is one constraint. Read a window around every hit before judging it;
a hit is a candidate, not a verdict.

### 1. No note text in any log

```bash
git diff "$BASE" -- src/ | grep -nE '^\+.*(trace\(|reportError\(|new Notice\(|console\.(log|warn|error)|new Error\()'
```

For each added call site, is the payload a count, an id, a duration or a fixed string? The
ceiling in this repo is `${source.length} chars` in `src/main.ts`. `trace()`
(`src/diagnostics.ts:7`) does `String(detail ?? "")` and appends to a vault file, so it
sanitises nothing.

BLOCK on `chunk.text`, `req.chunk.text`, `msg.text`, `source`, `selection` or `cleaned.text`
reaching any of them, **including inside an error message**: `reportError` puts that message in
a `Notice` and in the log. Also BLOCK if the 256KB slice at `diagnostics.ts:18` was removed.

False positives: a `new Error` in a test file; `new Notice` with a fixed string; `${e.message}`
from a `which` failure.

### 2. Speech text on stdin, never argv

```bash
git diff "$BASE" -- src/engines/ | grep -nE '^\+.*(args\.push|runner\.run\(|runner\.spawn\(|exec|execSync|shell:)'
```

`ProcessRunner.run(bin, args, stdin, signal)` writes the third parameter to stdin
(`src/engines/system/spawn.ts`). `speechd.ts:121` is the correct shape. BLOCK if chunk text
appears inside an `args` array, in a template-literal argument, or if `exec`, `execSync` or
`shell: true` appears at all.

### 3. No telemetry

```bash
git diff "$BASE" | grep -niE '^\+.*(sendBeacon|analytics|telemetry|sentry|posthog|mixpanel|amplitude|crashReport|navigator\.connection)'
```

BLOCK on any hit that is not a comment saying there is none.

### 4. No cloud TTS and no automatic fallback to one

```bash
git diff "$BASE" | grep -niE '^\+.*(api[_-]?key|apiKey|Authorization|Bearer |elevenlabs|azure|polly|openai|speechify|googleapis|deepgram)'
```

BLOCK on an added endpoint, credential or account concept. Note the one legitimate remote host
in the tree is `huggingface.co` in `src/ui/modelStore.ts`, which is a model download, not TTS.

### 5. The Kokoro worker still refuses remote fetches

```bash
git diff "$BASE" -- src/engines/onnx/ | grep -nE '^[-+].*(isRemote|assertLocal|installFetchShim|allowRemoteModels|allowLocalModels|useFS|useBrowserCache|wasmPaths|localModelPath)'
```

If that is empty, PASS. If not, read `kokoro.worker.ts` and confirm all of:

- `isRemote` (`:171`) still returns true for a cross-origin http(s) URL, comparison not inverted,
  no host allowlist added.
- `assertLocal` (`:152`) still called three times in `initInner` (`:232-234`): model base, ORT
  glue module, ORT WASM binary.
- The fetch shim still throws on a remote URL that did not resolve locally (`:135`).
- `env.allowRemoteModels = false`, `env.useFS = false`, `env.useFSCache = false`,
  `env.useBrowserCache = false` (`:244-253`) all still present.

BLOCK on any of those weakened. Per `AGENTS.md` 5, the remediation is always to fix the load
path, never to loosen the guard.

### 6. Every byte downloaded is user-initiated

```bash
git diff "$BASE" -- src/ | grep -nE '^\+.*(fetch\(|XMLHttpRequest|requestUrl|https?://)'
```

For each hit, trace whether it is reachable from `onload`, `onLayoutReady`, `warmUpEngine`,
`prepare()`, `isAvailable()`, or a settings-tab render path. `main.ts` prewarms on layout ready,
so anything reachable from there must be local. BLOCK on a fetch that fires without a click,
even to a legitimate host.

### 7. Mobile safety: no node builtin evaluating on mobile

```bash
git diff "$BASE" -- src/ | grep -nE '^\+.*(from |require\()["'"'"'](child_process|fs|path|os|node:)'
git diff "$BASE" -- manifest.json | grep -nE '^[-+].*isDesktopOnly'
```

If either matched, or the diff added a dependency, the only real check is the built bundle:

```bash
npm run build
grep -oE 'require\("[^"]+"\)' main.js | sort -u
```

Must be exactly `obsidian`, `@codemirror/view`, `@codemirror/state`. The esbuild `external` list
names a dozen more packages plus every node builtin, so it is not the check. BLOCK on any other
entry, on `isDesktopOnly` flipped to true, or on a static `child_process` import replacing the
`await import()` inside a method body in `spawn.ts`.

If the diff touches no import and adds no dependency, N-A and say the bundle was not rebuilt.

### 8. Source offsets stay in lockstep

```bash
git diff "$BASE" -- src/text/extract.ts src/audio/words.ts src/ui/highlight.ts | grep -nE '^[-+].*(sourceIndex|pushSpace|emit\(|continue|indexOf|\.search\()'
```

Empty means PASS. Otherwise: for every added or moved `continue` in `cleanLine`, did the branch
`emit` or `pushSpace`? For every new join that inserts a synthetic space, does it push a gap
entry the way `mergeShort` (`:205-207`) and the paragraph accumulator (`:379-384`) do?

Then prove it rather than reading it:

```bash
node build-tests.mjs tests/extract.test.ts && node tests/.build/extract.test.mjs
```

BLOCK if `sourceIndex.length !== text.length` for any chunk, or if highlighting now searches the
document for the spoken string (`indexOf` / `search` against the editor doc) instead of using
`timing.sourceStart` / `sourceEnd`.

### 9. Playback rate applied exactly once

```bash
git diff "$BASE" -- src/audio/ src/engines/ | grep -nE '^[-+].*(ownsPlayback|playbackRate|\bspeed\b|req\.rate|setRate)'
git diff "$BASE" -- tests/player.test.ts | grep -nE '^[-+].*(1\.5|seen\[0\]|playbackRate)'
```

Confirm `player.ts:183` still reads `rate: engine.capabilities.ownsPlayback ? this.rate : 1`,
and that no engine both declares `ownsPlayback: true` and returns `kind: "buffer"`. Current
matrix: espeak and kokoro are `false` + `buffer`; speechd is `true` + `streamed`; webspeech is
`true` + `live`.

Then run the suite and confirm these three checks still pass with these values, under the
heading `rate is applied once, not twice` in `tests/player.test.ts`:

- `buffer engine asked to render at natural speed` expects `seen[0] === 1`
- `player still plays it faster` expects `playbackRate === 1.5`
- `engine that owns playback is given the rate` expects `seen[0] === 1.5`

BLOCK if any of those numbers changed. Weakening that test is itself the violation; 2.25x
shipped once.

### 10. Settings normalisation preserves unknown keys

```bash
git diff "$BASE" -- src/settings/ src/main.ts | grep -nE '^[-+].*(normaliseSettings|DEFAULT_SETTINGS|saveData|loadData|Object\.keys|delete )'
```

Read the current state before judging: `normaliseSettings` (`src/settings/index.ts:107`) returns
a fresh literal with only the keys in `Settings`, and `saveSettings()` (`src/main.ts:371`) writes
`this.settings` directly. Nothing else writes plugin data today, so nothing is currently lost.
This is latent, not live.

BLOCK if the diff adds persisted state (a reading position for R-M12, per-note config for
R-C04, a queue for R-C03) through `saveData` **without** making `normaliseSettings` carry the
unrecognised part of `raw` forward. That is the change that makes the latent gap live, and the
fix belongs in the same commit. Also BLOCK on an added `delete` or `Object.keys` filter over
stored data.

### 11. A green suite is not a claim that something works

Mechanical proxy: is the deployed build newer than the newest source file?

```bash
ls -la --time-style=+%s ~/Documents/Notes/.obsidian/plugins/local-tts-reader/main.js
find src -newer ~/Documents/Notes/.obsidian/plugins/local-tts-reader/main.js -name '*.ts'
```

If `find` lists files, the deployed build predates the change: report **UNKNOWN** with
"not exercised in Obsidian since <files> changed". If the diff is docs-only, N-A.

This proves only that a build was deployed, never that a human drove it. Whether the change was
actually exercised is not mechanically checkable; say so rather than upgrading it to PASS.

### 12. Reproduce a bug end-to-end before fixing it

Not mechanically checkable. The available signal:

```bash
git log "$BASE"..HEAD --format='%s%n%b' | grep -niE 'reproduc|repro|verified|observed|before/after'
git diff --name-only "$BASE" -- tests/
```

A `fix(...)` commit with no test change and no reproduction note in the body is **UNKNOWN**, and
worth one line in the report. A non-fix change is N-A.

### 13. Never assert a measurement you did not take

```bash
git diff "$BASE" | grep -nE '^\+.*[0-9]+ *(ms|s|MB|GB|x faster|%|threads?|chars/s)'
```

For each added number with a unit in a comment, in `srs.md`, or in a commit message: was it
measured this session, or does it cite where it was measured? BLOCK on an unsourced number that
justifies a decision. UNKNOWN on a decorative one. Numbers inside code (a clamp bound, a
constant, a test expectation) are N-A.

### 14. Repo existence is not install-path existence

```bash
git diff "$BASE" | grep -nE '^\+.*(which\(|spawn\(|"[a-z0-9-]+ --?(version|help)"|npm run |npx )'
```

For each new binary, script or npm script the change depends on, verify it on this machine:

```bash
which espeak-ng spd-say
node -e "console.log(Object.keys(require('./package.json').scripts).join(' '))"
```

BLOCK on a dependency on something absent here - and note that `espeak-ng` is one of those
absent things: the `which` above returns nothing for it. `tests/engine.test.ts` shells out to
the real `spd-say` binary and needs a running speech-dispatcher daemon, not `espeak-ng`, so a
red engine suite can mean a missing binary or a dead daemon rather than a regression; check
`spd-say --version` and `spd-say -O` before blaming the diff. `AGENTS.md`'s quality-gates
block is the one place that detail lives.

## Output

```markdown
## Constraint Check

Branch: <branch>   Range: <base short hash>..working tree   Files changed: <n>

| # | Constraint | Status |
|---|---|---|
| 1 | No note text in logs | PASS |
| ... | | |

Constraints <list> are N-A: <one clause why>.

### Blocks
- **`src/engines/system/speechd.ts:121`** - <what the code now does, and the input that makes it
  violate the constraint>
  - Constraint: #2
  - Fix: <remediation>

### Unknown
- **#11** - `npm run deploy` predates `src/audio/player.ts`; not exercised in Obsidian.

### All clear
No violations found in the current changes. <n> constraints checked, <n> N-A, <n> unknown.
```

Collapse untouched rows to a single line. Do not print a grep that returned nothing.

One honesty rule: a constraint you could not check is **UNKNOWN**, not PASS. Reporting PASS on
something you did not check is the failure this command exists to prevent, and it is worse than
reporting nothing, because `/ship` believes it.
