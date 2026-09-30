---
description: Run the gates, take an adversarial pass over the diff, commit, push, and open a PR with implementation notes and an Obsidian manual test plan.
---

Conventions: `.claude/linear.md`. Rules and gates: `AGENTS.md`. Architecture: `CONTEXT.md`.
Spec: `srs.md`.

`.github/workflows/ci.yml` runs the gates on `push` and `pull_request`, and
`.github/workflows/release.yml` runs on tags. There is still no lint script and no git hook,
so nothing runs the gates for you at the moment you commit. Run the gates below yourself. You
**may** read a check conclusion once and report it; you **must not** wait on it. Branch
protection is deliberately out of scope, so a red check does not block a merge.

## Linear tool names

Operations used here: `get_issue`, `save_issue`, `save_comment`, `list_issue_statuses`.
**Do not hardcode a tool prefix.** Resolve the real names for the `linear-nrl` server from your
available tool list. Resolving the prefix is not enough: Linear folded its create/update pairs
into `save_*`, so posting a comment is `save_comment` and there is no `create_comment` (see
`.claude/linear.md`). Linear being unreachable never blocks a commit: do the git work and print
what you would have sent.

## Hard refusals

These are not advisory. Each is a promise the product makes, and `AGENTS.md` calls breaking one
a BLOCK.

1. **Never claim a change works on the strength of `npm test`.** The suites run in bare Node
   against fakes. If the diff changes user-visible behaviour and it has not been exercised in a
   real Obsidian, the PR says `Not verified in Obsidian` and the report says it out loud.
2. **Never ship past a non-negotiable violation** found in Step 5. There is no override flag.
3. **Never weaken a test to make a gate pass.** If `npm test` fails, the code is wrong until
   proven otherwise. The rate-doubling test in particular exists because 2.25x shipped once.
4. **Never assert a measurement you did not take** in the PR body. No latency, size or ratio
   unless you measured it this session or you cite where it was measured.

## Step 1: Branch and base

```bash
git branch --show-current
git status --short
git config branch."$(git branch --show-current)".base-branch 2>/dev/null || echo "base=main"
```

**STOP if on `main`.** This repo has no branch protection, which
makes a direct push to `main` easy and wrong. Ask for a `feature/nrl-N-*` or `fix/nrl-N-*`
branch, or offer to move the work onto one.

## Step 2: Identify the issue

Parse `nrl-(\d+)` out of the branch name. Found → `get_issue`, then confirm:
`Detected NRL-12: {title}. Link this PR?`

Read the requirement ID out of the issue (`R-M08`, `R-S02`, `R-C04`) and pull that
requirement's text from `srs.md`. The PR body has to show that the change actually satisfies
it, not merely that it compiles.

## Step 3: Read the diff

```bash
git diff --stat "$(git merge-base origin/main HEAD)"
git diff "$(git merge-base origin/main HEAD)"
```

Diffing from the merge base covers committed, staged and unstaged work in one range, so
re-running `/ship` after a mid-implementation commit still reviews everything. Summarise what
changed and confirm with the user before going further.

Note which of these the diff touches, because it decides Step 4:

| Touched | Consequence |
|---|---|
| `esbuild.config.mjs`, `src/engines/onnx/kokoro.worker.ts`, `package.json` | `npm run build` is mandatory |
| `manifest.json`, any new dependency | `npm run build` mandatory, plus the `require()` audit in Step 5 |
| Anything under `src/` | `npm run deploy` and a real Obsidian run before you may claim it works |
| docs, `srs.md`, `.claude/` only | Gates still run; the Obsidian requirement does not apply |

## Step 4: Gates

Mandatory, both of them:

```bash
npm test
```

```bash
npm run typecheck
```

`npm test` runs every suite `package.json`'s `pretest` registers, and reports all of them: read
the runner's per-suite table and, on a failure, the `FAILING SUITES:` line it prints last,
rather than assuming the first failure was the only one. Do not repeat the count or the suite
names here or in your report - `AGENTS.md`'s quality-gates block is the one place they live.

`tests/engine.test.ts` shells out to the real `spd-say` binary and needs a running
speech-dispatcher daemon, so a failure there can mean a missing binary or a dead daemon rather
than a regression. It does not spawn `espeak-ng`. `AGENTS.md`'s quality-gates block is the one
place that detail lives; do not restate it here or in your report. Check before you blame the
diff:

```bash
spd-say --version
spd-say -O
```

If the diff touched the bundle, the worker, or the esbuild config:

```bash
npm run build
```

Any gate red → stop and fix. Do not commit around it.

### Step 4b: Exercise it in Obsidian

`AGENTS.md` verification rule 11. Skip only for a docs-only diff.

```bash
npm run deploy
```

That builds and copies into `~/Documents/Notes/.obsidian/plugins/local-tts-reader`. It is a
**single shared slot**: any other `note-reader-local-nrl-*` worktree that had deployed no longer
owns it. Say in your report that you took the slot.

Then reload Obsidian (Ctrl+P → `Reload app without saving`) and drive the change by hand. What
to touch, by area:

| Changed | Do this in Obsidian |
|---|---|
| `src/text/extract.ts` | Open a note with a wikilink, an embed, a code fence, a URL and a `---` on line 1. Click the ribbon `Read this note aloud`. Listen for spoken bracket characters, confirm the highlight lands on the right word, and confirm you got chunks at all. |
| `src/audio/player.ts` | `Read note aloud`, then `Pause or resume reading` twice, then `Repeat current sentence`, then `Stop reading`. Watch the `n / total` in the control bar and listen for overlapping speech. |
| Any engine | Switch the engine dropdown in Settings → Local TTS Reader, read the same note on each engine you touched, and confirm the playback rate is right at 1x and at 1.5x. Rate applied twice is audible. |
| `src/engines/onnx/*` | Read a note with Kokoro cold, watch for a first-utterance stall, and confirm no network request fires (DevTools Network, filter all). |
| `src/ui/settingsTab.ts`, `src/settings/index.ts` | Change the rate, reload Obsidian, and confirm the setting survived **and** that nothing else in `data.json` was lost. |
| `src/ui/highlight.ts` | Read a long note and watch the highlight track the spoken word through a heading, a list and a code fence. |

The CDP smoke test is a supplement, not a substitute, and it has prerequisites:

```bash
npm run test:obsidian
```

It needs Obsidian already running with `--remote-debugging-port=9222`, the plugin enabled, and
a Kokoro model already installed. If those are not true, say it did not run rather than
reporting it as passing.

Record exactly what you did and what happened. It goes in the PR under Testing verbatim.

## Step 5: Non-negotiable audit (BLOCK gate)

Read the Step 3 diff against each row. Any hit is a BLOCK: stop, show the line, do not offer an
override.

```bash
BASE="$(git merge-base origin/main HEAD)"
git diff "$BASE" -- src/ | grep -nE '^\+.*(trace|console\.(log|warn|error)|reportError)\(' 
git diff "$BASE" -- src/ | grep -nE '^\+.*(fetch|XMLHttpRequest|https?://)'
git diff "$BASE" -- src/ | grep -nE '^\+.*(require|from) *[("'"'"']child_process'
git diff "$BASE" -- src/ | grep -nE '^\+.*(isRemote|assertLocal)'
git diff "$BASE" -- src/audio/ src/engines/ | grep -nE '^\+.*(ownsPlayback|playbackRate|\.rate)'
git diff "$BASE" -- src/settings/ | grep -nE '^\+.*(normaliseSettings|Object\.keys|DEFAULT_SETTINGS)'
git diff "$BASE" -- src/text/extract.ts | grep -cE '^\+.*sourceIndex'
```

| Rule | BLOCK when |
|---|---|
| 1, privacy | A new log or error message interpolates note, chunk, selection or spoken text. A count, an id or a duration is fine; `${source.length} chars` is the ceiling. |
| 2, privacy | Speech text appears in an argv array rather than being written to stdin. |
| 3, privacy | Anything resembling telemetry, analytics, a beacon or crash reporting. |
| 4, network | A cloud TTS endpoint, an API key, an account, or an automatic fallback to one. |
| 5, network | `isRemote` or `assertLocal` weakened or removed in `kokoro.worker.ts`. Fix the load path, not the guard. |
| 6, network | A fetch on load, on prewarm, or on first read. Downloads are user-initiated only. |
| 7, mobile | A node builtin imported so it evaluates on mobile, or `isDesktopOnly` flipped. Verify after build: the `require()` list in `main.js` must hold only `obsidian`, `@codemirror/view`, `@codemirror/state`. |
| 8, offsets | Stripping changed in `extract.ts` without a matching `sourceIndex` push for every dropped span, or highlighting done by searching the editor for the spoken string. |
| 9, rate | The rate applied both by an `ownsPlayback` engine and by `Player`. Check the player test still asserts it and was not softened. |
| 10, settings | `normaliseSettings` rebuilding from a whitelist and dropping unrecognised keys. |

The `require()` audit, after a build:

```bash
grep -oE 'require\("[^"]+"\)' main.js | sort -u
```

A grep returning nothing is not proof of cleanliness when the diff clearly touches `src/`.
Treat that as the check being wrong and widen the range before you believe it.

## Step 6: Adversarial pass

If a `/critique` command exists in `.claude/commands/`, run it and read the verdict from
`.claude/last-critique.md`. Reuse a recorded verdict only when its commit matches `HEAD` **and**
it was a code review rather than a plan review. Otherwise it is stale: discard it.

This repo currently has no `/critique` command. Until it does, do the pass inline and keep it
short. Five questions, answered against the diff, not from memory:

1. What input makes this wrong? Name one concretely. `extract.ts` bugs in this repo were all
   found by a specific input, not by reading.
2. Which `CONTEXT.md` structural gap does this change assume away? `Player` has no file
   identity, capabilities are advertised and not consumed, there is no engine fallback chain,
   segmentation is one regex with no `Intl.Segmenter`.
3. Does this satisfy the requirement in `srs.md` or only look like it does? If it deviates,
   `AGENTS.md` requires an ADR in `docs/adr/` and an amendment to `srs.md`. Deviating is
   allowed; doing it silently is not.
4. Does it fix a defect listed under Known state in `AGENTS.md`? If yes, that entry needs
   removing, and `/finish` will ask about it.
5. What did you not test, and what would break first if you are wrong?

Record the answers. Concerns go in the PR under Review Notes. A finding that is actually a
Step 5 violation goes back to Step 5 and blocks.

## Step 7: Commit

Already committed while implementing → verify the messages and skip to Step 8. Do not create an
empty commit, and do not amend anything already pushed.

```bash
git log origin/main..HEAD --oneline
```

```bash
git add -A
git commit -m "<type>(<scope>): <description>

<why, and what the reader cannot reconstruct from the diff>

Resolves NRL-XX"
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
Scopes mirror the layout in `CONTEXT.md`: `extract`, `player`, `words`, `wav`, `engines`,
`espeak`, `speechd`, `webspeech`, `kokoro`, `settings`, `ui`, `highlight`, `paths`,
`diagnostics`, `build`.
Description: imperative, lowercase, no trailing period. No em-dashes anywhere in the message.

The existing commit on `main` is the style reference: a subject line, then a body that explains
why and what is load-bearing. It carries no `Co-Authored-By` trailer, so do not add one.

> `Resolves NRL-XX` is for a human reading `git log`. It does **not** close the Linear issue.
> That is a GitHub keyword, and Linear's GitHub integration is not connected to this repo.
> `/finish` closes the issue.

Never stage the built artifacts or the vault. Check before committing:

```bash
git status --short | grep -E '(^|/)(main\.js|kokoro-worker\.js)$|(^|[ /])ort/|tests/\.build' || echo "no build artifacts staged or untracked"
```

`main.js`, `kokoro-worker.js`, `ort/` and `tests/.build/` are build output. If any shows up as
tracked or staged, stop and check `.gitignore` rather than committing them.

## Step 8: Push

```bash
git push -u origin "$(git branch --show-current)"
```

## Step 9: Open the PR

There are no PRs on this repo yet, so verify `gh` works rather than assuming:

```bash
gh auth status
```

```bash
gh pr create --base <base-branch> --title "<type>(<scope>): <description>" --body "<body>"
```

Body template. Every section is filled or explicitly marked `none`:

```markdown
## Summary
- <what changed and why, in the user's terms>

## Requirement
`R-M08` - <the srs.md text, quoted>
<how this change satisfies it, or what part of it remains open>

## Implementation Notes

### Files Changed
- `src/text/extract.ts` - <purpose>

### Approach
<strategy, and the alternative you rejected>

### Key Decisions
- <decision + why>

### Source Offsets {omit unless extract.ts or highlight.ts changed}
<every dropped span still pushes a sourceIndex entry: say how you confirmed it>

### Dependencies
<added, or none. If added: the require() list in main.js after build>

## Testing

### Gates
- `npm test` - <the runner's `N suites: ... checks ok ...` line, verbatim, plus its
  `FAILING SUITES:` line if there is one>
- `npm run typecheck` - <result>
- `npm run build` - <result, or "not required, bundle untouched">

### Exercised in Obsidian
- Deployed with `npm run deploy`, reloaded, then: <exactly what you clicked and what happened>
<or, if not done:>
- NOT VERIFIED IN OBSIDIAN. Unit tests run in bare Node against fakes and are not evidence
  this works.

### Not tested
- <what you did not cover>

## Manual Test Plan
- [ ] `npm run deploy`, then reload Obsidian (Ctrl+P, `Reload app without saving`)
- [ ] <named UI action, e.g. "click the ribbon icon `Read this note aloud` on a note whose
      first line is `---` and confirm speech starts">
- [ ] <named UI action, e.g. "Ctrl+P, `Repeat current sentence`, and confirm `n / total` in the
      control bar is unchanged">
- [ ] <named UI action, e.g. "Settings, Local TTS Reader, set rate to 1.5x and confirm it is
      not doubled">

## Review Notes {omit if the adversarial pass was clean}
- <concern + why it is acceptable to ship>

## Non-negotiables
- [ ] No note text in any log
- [ ] Speech text on stdin, not argv
- [ ] No network added; Kokoro worker guards intact
- [ ] `main.js` require() list unchanged: `obsidian`, `@codemirror/view`, `@codemirror/state`
- [ ] sourceIndex in lockstep with stripping
- [ ] Playback rate applied exactly once
- [ ] Settings normalisation preserves unknown keys

Resolves NRL-XX
```

The Manual Test Plan must name real UI surfaces. The plugin exposes a ribbon icon
`Read this note aloud` and four commands: `Read note aloud`, `Pause or resume reading`,
`Stop reading`, `Repeat current sentence`. Settings live under Settings → Local TTS Reader.
`Test the plugin` is not a test plan.

## Step 10: Update Linear

`In Review` optionality, per `.claude/linear.md`. Verified on 2026-09-28: this team has only
Linear's default six states and **`In Review` is not one of them**. Setting a status that does
not exist fails, so check rather than assume.

1. `list_issue_statuses` for the team, and look for `In Review`.
2. Exists → `save_issue` with `state: "In Review"`.
3. Does not exist → leave the issue **In Progress**. The open PR is the review signal. Do not
   invent a status, and do not move it to Done: it is not done.
4. Either way, `save_comment` with the PR link and the implementation summary. When there is
   no `In Review` status, that comment is what carries the review state.
5. Attach the PR URL to the issue links if the MCP supports it.

## Step 11: Report

```
Shipped.

Commit: abc1234 fix(extract): keep wikilink text and drop the brackets
PR: <url from gh>

Gates:
- npm test: <the runner's `N suites: ... checks ok ...` line, verbatim, plus `FAILING SUITES:` if any>
- npm run typecheck: clean
- npm run build: <result or not required>

Obsidian: deployed and exercised. <what you clicked, what happened>
          This tree now owns the single deploy slot in ~/Documents/Notes.
{or}
Obsidian: NOT VERIFIED. This change is unproven.

Non-negotiable audit: clean
Adversarial pass: <verdict, concerns listed in the PR>

Linear NRL-12: In Review {or: In Progress, no In Review status on this team, PR is the signal}

CI: `.github/workflows/ci.yml` will run the same gates on this push and on the PR. Its
conclusion may be read once, never waited on, and it does not block a merge.

Next:
1. Review the PR
2. Merge
3. `/finish` to clean up and close the issue
```

## Error handling

| Scenario | Action |
|---|---|
| On `main` | Stop. Ask for a feature or fix branch. |
| `npm test` fails | Stop. Fix the code. Never soften the test. |
| `npm run typecheck` fails | Stop. |
| `npm run build` fails | Stop. A broken bundle means the plugin does not load at all. |
| `engine.test.ts` fails on a missing `spd-say` or a dead speech-dispatcher daemon | Report it as an environment failure, name what was missing, and do not present the suite as green. |
| Non-negotiable violation | Stop. No override exists. |
| `npm run deploy` fails on a missing vault | Report it, mark the change NOT VERIFIED, and let the user decide whether to ship unproven. |
| `test:obsidian` cannot reach port 9222 | Report "did not run". Never report it as passing. |
| Push rejected | Show the remote state. Surface the force-push decision to the user; never force-push unasked. |
| `gh` unauthenticated or `gh pr create` fails | Show the error, print the PR body so it can be pasted, and report the branch as pushed but unreviewed. |
| Linear unreachable | Warn and continue. Print the status change and the comment as text for manual entry. |
