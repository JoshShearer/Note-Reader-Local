---
description: Start or resume work on a Linear issue - fetch it, create the branch, set In Progress, and surface the AGENTS.md rules that apply to the area it touches.
---

Conventions: `.claude/linear.md`. Rules and gates: `AGENTS.md`. Architecture: `CONTEXT.md`.
Spec: `srs.md`.

## Linear tool names

Operations used here: `get_issue`, `list_issues`, `save_issue`. **Do not hardcode a tool
prefix.** Resolve the real names for the `linear-nrl` server from your available tool list. If
no Linear tool is present, create the branch anyway and print the status change you would have
made, per the degradation rule in `.claude/linear.md`.

## Input

`$ARGUMENTS` is the issue identifier. Accepts `NRL-12`, `nrl-12`, or bare `12`. The team key is
still **UNVERIFIED**; `NRL` is a placeholder. If `get_issue` rejects the prefix, run
`list_teams`, use the real KEY, and say in your output that `.claude/linear.md` needs correcting.

## Step 1: Resolve the issue

**Argument given** → parse the number.

**No argument** → check the current branch:

```bash
git branch --show-current
```

Matches `feature/nrl-{N}-*` or `fix/nrl-{N}-*` → resume that issue.

Otherwise `list_issues` with `assignee: "me"` across Todo / In Progress / Backlog and present a
numbered picker. Show the requirement ID from the title or description next to each, because
that is what tells the user how big the job is:

```
No issue ID given. Your assigned issues:

In Progress:
  1. NRL-12: Read from cursor (R-M08)

Todo:
  2. NRL-14: speechd voice argument construction (R-M05)
  3. NRL-15: consume skipCode and skipUrls (R-S03)

Enter a number, or an issue ID:
```

## Step 2: Fetch the issue

`get_issue` → title, description, labels, state, assignee, parent, and `url`. Use the returned
`url` verbatim. Do not build one: Linear appends a title slug and rewrites the path when an
issue moves team.

Pull the requirement ID out of the title or description (`R-M01` through `R-M16`, `R-S01`
through `R-S06`, `R-C01` through `R-C05`). If there is one, read that requirement's text out of
`srs.md` and show it. The ticket is a pointer; `srs.md` is the acceptance criteria.

```bash
grep -n "R-M08" srs.md
```

No requirement ID and the issue looks like a spec gap → say so, and suggest adding one before
implementing. `/spec-check` reads that ID.

## Step 3: Pre-flight git checks

```bash
git status --short
git branch --show-current
git ls-remote --heads origin "feature/nrl-{N}-*" "fix/nrl-{N}-*"
```

| Finding | Action |
|---|---|
| Uncommitted changes | Stop. Offer stash or commit. Do not create a branch over a dirty tree. |
| Not on `main` and not resuming this issue | Ask whether to switch to `main` first. Default base is `main`. |
| Branch already exists locally | Offer: check out the existing branch (resume), or pick a new slug. Never delete it. |
| Branch exists on the remote only | Offer `git checkout -b <branch> origin/<branch>` to resume someone else's push. |
| Issue is In Progress and assigned to someone else | Warn, offer to proceed or pick another. Assigned to you → resume silently. |

## Step 4: Branch name

`feature/nrl-{N}-{slug}`, or `fix/nrl-{N}-{slug}` when the issue is a bug or the label is `Bug`.
Slug: lowercase title, non-alphanumerics to `-`, collapse runs, truncate near 50 chars.

```bash
git checkout main && git pull --ff-only origin main && git checkout -b <branch-name>
```

Sub-issue whose parent has a branch on the remote → offer the parent branch as the base and
record it:

```bash
git config branch.<branch-name>.base-branch <base-branch>
```

`/ship` reads that config for the PR target and `/finish` reads it to decide where to return.

## Step 5: Worktree question (primary sessions only)

If other issues are already In Progress, mention that `note-reader-local-nrl-{N}` siblings are
the pattern for parallel work, and state the constraint plainly: **only one worktree at a time
can hold the deployed Obsidian build**, because `npm run deploy` writes to the single folder
`~/Documents/Notes/.obsidian/plugins/local-tts-reader`. Whoever deploys should say so. A fresh
worktree also has no `node_modules`, so `npm ci` comes before any gate.

Do not create a worktree from this command. Report that the option exists.

## Step 6: Set the status

`save_issue` → `state: "In Progress"`, only when the current state is `Backlog` or `Todo`.
Set `assignee: "me"` if unassigned. Never move an issue backwards.

## Step 7: Area hazards

Decide the area from the issue title, description, the requirement ID, and the files it names.
Then print **only** the matching rows. Text is abbreviated; `AGENTS.md` is authoritative.

| Area | What you must know before writing code |
|---|---|
| `src/text/extract.ts` | **Non-negotiable 8.** `sourceIndex[i]` is the raw-markdown offset that produced `text[i]`, and highlighting is built on it. Every dropped span still pushes an index entry. Change stripping and the index in lockstep, or highlighting corrupts silently instead of crashing. Existing defects to expect: `[` and `]` spoken for wikilinks, embed content lost, and **zero chunks** when line 1 is `---` because a horizontal rule is read as frontmatter. Also: `ExtractOptions.skipCode` and `.skipUrls` are plumbed and rendered and never read. |
| Any engine (`kokoro`, `espeak`, `speechd`, `webspeech`) | **Non-negotiable 9.** Rate is applied exactly once. `ownsPlayback: true` means the engine is told the rate; everything else renders at natural speed and `Player` applies it. Both is 1.5x squared, which shipped once. There is a test; do not weaken it. **Non-negotiable 4**: no cloud TTS and no fallback to one. |
| `src/engines/system/*` | **Non-negotiable 2.** Speech text reaches the subprocess on stdin, never argv: argv shows up in `ps` and in spawn error messages. `spawn.ts` is the only `child_process` touch point, and per **non-negotiable 7** the import stays type-only plus dynamic `await import()` inside method bodies, behind `Platform.isMobile`. Known `speechd` defect: malformed `-y` / `-t` args, and `spd-say` prints `Invalid voice` on **stdout with exit 0** while the guard reads stderr. |
| `src/engines/onnx/*` | **Non-negotiables 5 and 6.** `kokoro.worker.ts` `isRemote` + `assertLocal` reject remote fetches at runtime because transformers.js and kokoro-js both default to CDN URLs. If a load path breaks, fix the path, not the guard. Every byte downloads on an explicit click: nothing fetches on load, on prewarm, or on first read. Weights live in `.obsidian/local-tts/kokoro`, outside the plugin folder, so an update does not discard them. |
| `src/audio/player.ts` | **Non-negotiable 9** again, plus the reproduced defects: `replayCurrent` truncates the chunk array and resets the index, corrupting `n / total`; `primeBuffer` prefetches against engines where `synthesize()` *is* the speaking, so speechd and webspeech overlap; pause is a no-op on both because it pauses an `<audio>` element they never use. `Player` is a chunk-queue player with no file identity, which is why per-note position (R-M12) cannot be bolted on (see CONTEXT.md). |
| `src/settings/index.ts`, `src/ui/settingsTab.ts` | **Non-negotiable 10.** `normaliseSettings` must preserve keys it does not recognise. Plugin data holds more than settings, including reading positions, and a whitelist rebuild erases them on the next rate nudge. |
| Anything that logs, or `src/diagnostics.ts` | **Non-negotiable 1.** `trace()` takes counts, ids and durations. The closest any existing call site gets is `${source.length} chars`. Never interpolate note, chunk, selection or spoken text, not even into an error message. **Non-negotiable 3**: no telemetry of any kind. |
| `manifest.json`, `package.json`, `esbuild.config.mjs` | **Non-negotiable 7.** `isDesktopOnly: false`. After any dependency change, check the `require()` list in the built `main.js` holds only `obsidian`, `@codemirror/view`, `@codemirror/state`. `npm run build` is mandatory for this area. |
| `src/ui/highlight.ts` | Decoration is driven by the offsets carried from `extract.ts`. Never search the editor for the spoken string. |

## Step 8: Reproduce before fixing (bug issues only)

`AGENTS.md` verification rule 12. Every defect in the known-state list was invisible to the
test suite and obvious the moment the real function ran against real input. Before writing a
fix, bundle the module and run it:

```bash
node build-tests.mjs tests/extract.test.ts && node tests/.build/extract.test.mjs
```

For a one-off reproduction, add a temporary case to the relevant suite in `tests/`, run it, and
watch it fail for the reason the ticket claims. Reasoning about the code is not reproduction.
If the bug is only visible in Obsidian, `npm run deploy` and reproduce it there, and say that
you took the shared deploy slot.

## Step 9: Output

```
{Started | Resuming} NRL-12: Read from cursor

| Property | Value |
|----------|-------|
| Branch | feature/nrl-12-read-from-cursor {(checked out) if resumed} |
| Base | main |
| Status | In Progress {(unchanged) if resumed} |
| Requirement | R-M08 |
| Issue | {url returned by the MCP} |

## Requirement text (srs.md)
> {the lines grep found}

## Description
{issue body}

## Remaining tasks {omit if none in the body}
- [ ] ...

## Hazards for this area
- ...

## Gates before you commit
npm test           # 5 suites: extract, engine, player, paths, kokoro
npm run typecheck
npm run build      # only if the bundle, worker or esbuild config moved

A green suite is not a claim that this works. `npm run deploy` and drive it in Obsidian
before saying it does.

{footer if other issues are In Progress:}
---
Also In Progress: NRL-14. Parallel work goes in ../note-reader-local-nrl-14.
Only one worktree at a time can hold the deployed Obsidian build.
```

## Error handling

| Scenario | Action |
|---|---|
| Issue not found | Show the error. Try `list_teams` in case the `NRL` placeholder prefix is wrong, and report the real KEY. |
| Branch exists locally | Offer checkout-existing or a new slug. Never delete. |
| Uncommitted changes | Stop. Stash or commit first. |
| Not on `main` | Ask before switching. Report what you would base on. |
| Linear tools absent or unauthenticated | Create the branch, print the status change as a table for manual entry, point at the first-run setup in `.claude/linear.md`. |
| `git pull --ff-only origin main` rejected | Stop. `main` has diverged locally, and that needs a decision, not a guess. |
| `node_modules` missing (fresh worktree) | `npm ci` first. Report that gates were untrustworthy until it finished. |
