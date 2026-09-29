---
description: Run the local gates, deploy into real Obsidian, walk a manual test plan, and post what was actually observed to the Linear issue.
---

Verify a change. There is no CI in this repo, so nothing has already run the gates. This
command runs them, then does the part the gates cannot do.

Conventions: `.claude/linear.md`.

Argument: `$ARGUMENTS` (optional Linear identifier such as `NRL-12`, `nrl-12`, or `12`).

## The distinction this command exists to enforce

**Tests pass** and **verified working** are different claims. The unit suites run in bare
Node against fakes. `AGENTS.md` rule 11 is explicit: a green test suite is not a claim that
something works. Every defect in the **Known state** list was invisible to the suite and
obvious the moment the real thing was run.

So the verdict this command emits has three levels, and you must pick the honest one:

| Verdict | Means |
|---|---|
| `GATES GREEN, NOT VERIFIED` | Suites and typecheck pass. The change was not exercised in Obsidian. |
| `VERIFIED IN OBSIDIAN` | Gates green **and** a human-observable check was run against the deployed build, and the observation is recorded below. |
| `FAILED` | A gate is red, or the Obsidian check did not do what the issue said it would. |

Never emit `VERIFIED IN OBSIDIAN` on the strength of the test suite. If Obsidian was not
driven, the verdict is `GATES GREEN, NOT VERIFIED` and the comment says so in those words.

## Linear tool naming

Do not hardcode an MCP tool prefix. Operations used here: `get_issue`, `list_issues`,
`create_comment`. Resolve the real prefixed names from your available tool list. If no
Linear tool is present, print the comment body instead of posting it.

## Step 1: Resolve the issue

With an argument: normalise it (accepts `NRL-12`, `nrl-12`, `12`) and fetch it with
`get_issue`.

Without an argument:

```bash
git branch --show-current
```

Branches are `feature/nrl-{N}-{slug}` or `fix/nrl-{N}-{slug}`. Pull `{N}` from that. If the
branch carries no issue number, run `list_issues` with `assignee: "me"` and a started
status, and ask which one. If there is no Linear at all, verify anyway and report locally.

Read the issue's **Acceptance criteria** section. That is the manual test plan for Step 5.
If the issue has none, build one from the diff and say in the comment that the plan was
inferred rather than taken from the issue.

## Step 2: Work out which gates are relevant

```bash
git status --short
git diff --name-only
```

Compare against the merge base if you are on a branch:

```bash
git diff --name-only $(git merge-base HEAD main)...HEAD
```

| Changed | Gate required |
|---|---|
| Anything under `src/` or `tests/` | `npm test` and `npm run typecheck` |
| `src/engines/onnx/kokoro.worker.ts`, `esbuild.config.mjs`, `package.json` deps | plus `npm run build`, and inspect the bundle (Step 4) |
| Only `*.md` | Gates optional. Say which you skipped and why. |

If you are in a fresh worktree, `node_modules` does not exist and the gates are meaningless
until you run `npm ci`. Check before trusting a pass.

## Step 3: Run the gates

```bash
npm test
```

Seven suites run in sequence: `extract`, `engine`, `player`, `paths`, `kokoro`, `settings`, `highlightColour`. The `test`
script chains them with `&&`, so the first failure stops the rest. If `extract` fails you
have learned nothing about the other six. Say that rather than reporting them as passing.

`tests/engine.test.ts` shells out to real `espeak-ng` and `spd-say` on this machine. It is
a Linux desktop test. A failure there can mean a missing or misconfigured binary rather than
a code defect. If it fails, check the binary directly before blaming the diff:

```bash
espeak-ng --version
spd-say --version
```

```bash
npm run typecheck
```

`tsc --noEmit --skipLibCheck`.

```bash
npm run build
```

Only when Step 2 says so. This is `typecheck` plus a production esbuild producing `main.js`,
`kokoro-worker.js` and `ort/`.

**Stop here if any gate is red.** Report the failing output verbatim and do not proceed to
deploy. Do not summarise a failure into a guess about its cause unless you checked.

## Step 4: Bundle checks, when the build ran

Mobile safety is rule 7 and it is not covered by any test.

```bash
grep -o 'require("[^"]*")' main.js | sort -u
```

The list must contain only `obsidian`, `@codemirror/view`, `@codemirror/state`. Anything
else, especially a node builtin such as `child_process`, `fs` or `path`, is a BLOCK: it
breaks `isDesktopOnly: false`.

If `kokoro.worker.ts` moved, confirm `isRemote` and `assertLocal` still exist in the built
worker:

```bash
grep -c 'assertLocal' kokoro-worker.js
```

Record the numbers you actually saw. Rule 13: do not quote a size, a ratio or a latency you
did not measure in this session.

## Step 5: Deploy and drive the real plugin

```bash
npm run deploy
```

This builds and copies into `~/Documents/Notes/.obsidian/plugins/local-tts-reader`.

Only one worktree at a time may hold the deployed build, because the destination is a single
fixed folder. Say in the Linear comment which worktree deployed.

Obsidian on this machine is the Flatpak `md.obsidian.Obsidian`. After deploying, reload the
plugin (toggle it off and on in Community Plugins, or run Obsidian's reload command).
WebGPU needs `--enable-features=Vulkan`, which lives in
`~/.var/app/md.obsidian.Obsidian/config/obsidian/user-flags.conf`. If the change touches
Kokoro on GPU and that flag is absent, the run tells you nothing about the GPU path; note
that rather than reporting a WASM result as a GPU result.

Now walk the plan. Baseline checks, in addition to whatever the issue's acceptance criteria
say:

| Check | What to actually do | Watch for |
|---|---|---|
| Reading starts | Run the `Read note aloud` command on a real note | Audible speech, first sound within roughly a second |
| Highlighting tracks | Watch the editor while it speaks | The highlighted word is the spoken word, and does not drift. Drift means `sourceIndex` is out of lockstep |
| Pause and resume | `Pause or resume reading` | Known defect: pause is a no-op on `speechd` and `webspeech`. Confirm which engine you tested |
| Stop | `Stop reading` | Speech stops, no orphan subprocess, no overlapping audio on restart |
| Rate | Change rate mid-read | Applied once, not squared. 1.5x that sounds like 2.25x is rule 9 broken |
| Engine under test | Settings tab | Name which of `kokoro`, `espeak`, `speechd`, `webspeech` you used. A pass on one is not a pass on four |

**Record what you observed, not what you expected.** Write the observation in the past
tense and in concrete terms: "highlight lagged the audio by roughly two words after the
third sentence" beats "highlighting works". If a step could not be run, mark it `NOT RUN`
with the reason. Never mark an unrun step as passed.

### Optional: CDP smoke test

```bash
npm run test:obsidian
```

This needs Obsidian already running with `--remote-debugging-port=9222`. For the Flatpak:

```bash
flatpak run md.obsidian.Obsidian --remote-debugging-port=9222
```

Confirm the port is actually listening before trusting a result:

```bash
curl -s http://127.0.0.1:9222/json/version | head -5
```

The smoke test is a supplement, not a substitute for watching and listening. It cannot tell
you that the highlight tracked the audio, or that the rate was not applied twice.

## Step 6: Summary

```
Verification for NRL-12
=======================

Gates
  npm test         7/7 suites (extract, engine, player, paths, kokoro, settings, highlightColour)
  npm run typecheck clean
  npm run build    ran / not needed
  main.js requires obsidian, @codemirror/view, @codemirror/state

Deployed
  npm run deploy from <worktree path>, Obsidian plugin reloaded

Observed in Obsidian (engine: espeak)
  1. Read note aloud on a 400-word note   OBSERVED: spoke from the first heading,
     first audio at roughly 1s by stopwatch, not instrumented
  2. Highlight tracked the spoken word    OBSERVED: stayed aligned through 12 sentences
  3. Pause                                NOT RUN: espeak path only, speechd untested

Not verified
  - speechd and webspeech engines
  - Kokoro GPU path: user-flags.conf not checked this session

Verdict: VERIFIED IN OBSIDIAN (espeak only)
```

## Step 7: Post to Linear

`create_comment` on the issue with the Step 6 summary verbatim.

The comment **must** contain an explicit sentence separating the two claims, for example:

```
Unit suites pass. That is not a claim the change works. What was exercised in real
Obsidian is listed under "Observed"; everything under "Not verified" was not tested.
```

If a Linear tool is unavailable, print the comment body for manual pasting and say the
post did not happen.

## Step 8: Final output

```
NRL-12: <verdict>

Gates:    <pass/fail per gate>
Obsidian: <n observed, n not run>
Posted:   <yes | no, Linear unavailable>

Next: <merge | fix and re-run /verify | run the untested engine>
```

## Error handling

| Scenario | Action |
|---|---|
| No issue id and no branch match | Verify locally, report, skip the Linear post |
| `npm test` red | Print failing output, stop before deploy |
| `engine.test.ts` red | Check `espeak-ng` and `spd-say` directly before attributing it to the diff |
| `node_modules` absent | `npm ci` first; a gate cannot pass or fail without it |
| Obsidian not running or not reloadable | Verdict is `GATES GREEN, NOT VERIFIED`, never `VERIFIED` |
| CDP port not listening | Report the smoke test as NOT RUN, not as skipped-because-passing |
| Linear post fails | Warn, print the comment, keep the verdict |
