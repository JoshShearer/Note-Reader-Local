---
description: Write a session handoff that carries the objective, the decisions and their rationale, real measurements taken, and an explicit list of claims that are still unverified.
---

Compact this session into a handoff a fresh agent can act on without re-deriving anything.

Conventions: `.claude/linear.md`.

Argument: `$ARGUMENTS` (optional) - a topic slug or a Linear id to name the file. Omitted:
infer from the branch or the work.

## What makes a handoff fail here

Two specific failure modes, both of which this repo is unusually exposed to:

1. **A claim arrives without its evidence.** The next session reads "highlighting works",
   trusts it, and builds on a defect. `AGENTS.md` rule 11 says a green suite is not a claim
   that something works. If you did not drive it in Obsidian, the handoff must say so in
   those words.
2. **A number arrives without its measurement.** Rule 13 forbids asserting a measurement
   you did not take. If this session measured something real, that number is one of the
   most valuable things in the handoff, because otherwise the next session cannot quote it
   either and will have to re-measure. Carry it with its method.

Detail over brevity. Nothing that took a command to discover should need that command run
again.

## Capture

### 1. Objective

What was actually asked for at the start, not the scope that accreted. One paragraph. Name
the Linear issue and its current status if there is one. Use `get_issue` to confirm the
status rather than recalling it; resolve the real prefixed Linear tool name from your
available tool list, and skip this if no Linear tool is connected.

### 2. Decisions and rationale

For each decision: what was chosen, what the alternatives were, and why. The reason is the
part that does not survive without writing it down; the choice is visible in the diff.

Call out explicitly any decision that touches a non-negotiable in `AGENTS.md` (privacy,
network, mobile safety, source offsets, single rate application, settings normalisation),
and any deliberate divergence from `srs.md`, which needs an ADR in `docs/adr/` plus an
amendment to `srs.md`. `docs/` does not exist yet, so the first ADR creates it.

### 3. Done

Files changed with line references, and what each change does. Commands run, with their
real output, not a paraphrase. Which requirement IDs from `srs.md` moved, if any.

Committed or uncommitted? Run and record:

```bash
git status --short
git log --oneline -5
git branch --show-current
```

### 4. In flight

Work started and not finished. Where exactly it stopped, in `file:line` terms, and what the
next edit was going to be. If there is a half-applied change that leaves the tree
inconsistent, say so at the top of this section.

### 5. Blocked, and why

What cannot proceed, and what would unblock it. Distinguish:

- blocked on a decision from the user
- blocked on a machine capability (Obsidian not running, WebGPU flag absent, a binary
  missing)
- blocked on another issue

### 6. Measurements taken this session

**The section this repo needs most.** List every real number produced, with how it was
produced, so the next session may quote it and cite where it was measured.

| Capture | How it was obtained |
|---|---|
| Suite results | exact `npm test` output, which of the 7 suites ran, which stopped the chain |
| Typecheck | `npm run typecheck` clean or the errors |
| Build artefacts | if `npm run build` ran, real byte sizes: `ls -l main.js kokoro-worker.js` and `du -sh ort/` |
| `main.js` require list | `grep -o 'require("[^"]*")' main.js \| sort -u` output verbatim (rule 7) |
| Extraction timings | from `tests/perf/`, with the input word count; compare against `srs.md:2092` only if you ran it |
| Latency | command to first audible sound, and how it was timed. A stopwatch is a legitimate method as long as you say it was a stopwatch |
| Binary versions | `espeak-ng --version`, `spd-say --version` if `tests/engine.test.ts` behaviour mattered |
| Engine and device | which of `kokoro`, `espeak`, `speechd`, `webspeech`; for Kokoro, which weights build (`gpu` fp32, `fast` q4f16, `small` q8) and whether it landed on WebGPU or WASM |

If a number was estimated rather than measured, label it ESTIMATE. If no measurement was
taken, write "no measurements taken this session" rather than leaving the section out.

### 7. Unverified claims

An explicit list. For each: the claim, and what would settle it.

Default to listing a thing here. Anything not exercised against the deployed build in the
Flatpak `md.obsidian.Obsidian` belongs here, including changes whose unit tests are green.

Also record:

- Whether `npm run deploy` ran this session, and from which worktree. Only one worktree may
  hold the deployed build at a time, since `deploy` writes to the single fixed folder
  `~/Documents/Notes/.obsidian/plugins/local-tts-reader`.
- Whether the plugin was reloaded in Obsidian after deploying. A deploy without a reload
  proves nothing.
- Whether `--enable-features=Vulkan` is present in
  `~/.var/app/md.obsidian.Obsidian/config/obsidian/user-flags.conf`, if anything Kokoro or
  GPU related was touched. Without it a run says nothing about the WebGPU path.
- Whether `npm run test:obsidian` ran and whether the CDP port was actually listening.

### 8. Next concrete action

One action, specific enough to start on without re-reading the session. "Add the
`Intl.Segmenter` path to `src/text/extract.ts:88`, behind the existing sentence split, and
extend `tests/extract.test.ts` with a CJK case" rather than "improve segmentation".

Then the two or three actions after it, in order.

### 9. Files that matter

Only the ones a fresh session must open, each with one line on why. Include untouched files
that constrain the work, for example `src/audio/types.ts` when the change is about
capabilities. Do not paste the repo layout; `CONTEXT.md` already has it.

### 10. Dead ends

What was tried and did not work, and why, so it is not retried. Include approaches
considered and rejected, with the reason.

## Where it goes

Write to `.claude/scratch/YYYY-MM-DD-<slug>-handoff.md`, using `nrl-{N}` as the slug when
the work maps to a Linear issue.

`.claude/scratch/` is **not currently in `.gitignore`**. Check, and add it before writing
if it is still absent:

```bash
grep -q '.claude/scratch/' .gitignore || printf '\n# Session handoffs\n.claude/scratch/\n' >> .gitignore
```

Handoffs are working notes. Anything that is durable project knowledge belongs in
`AGENTS.md` ("Known state" for a reproduced defect), `CONTEXT.md` (structure), `srs.md`
(the contract), or `docs/adr/` (a decision), not in a scratch file.

## Template

```markdown
# Handoff: <topic> - YYYY-MM-DD

Issue: NRL-{N} (<status>) | Branch: <branch> | Worktree: <path>

## Objective

## Decisions
- **<decision>** - chose X over Y because Z. Touches AGENTS.md non-negotiable <n>: <how it is respected>.

## Done
- `src/...:NN` - <what and why>
- Committed: <yes/no>. `git status --short`: <output>

## In flight
- Stopped at `src/...:NN`. Next edit was going to be <...>.

## Blocked
- <what> - blocked on <decision | machine capability | issue>. Unblocks when <...>.

## Measurements taken
| What | Value | How |
|---|---|---|
| npm test | 7/7 suites | full run, output below |
| main.js requires | obsidian, @codemirror/view, @codemirror/state | grep on the built bundle |
| (none) | | say so rather than omitting |

## Unverified
- <claim> - would be settled by <...>
- Deployed: <yes, from <worktree> | no>. Plugin reloaded: <yes/no>.
- Engines exercised: <list>. Engines not exercised: <list>.

## Next action
1. <one concrete action with a file:line>
2. <...>

## Files that matter
- `path` - why

## Dead ends
- <approach> - failed because <...>
```

## Optional: leave a trail in Linear

If there is an issue and a Linear tool is connected, offer to post the Objective, Done,
Blocked and Next action sections as a comment via `create_comment`. Resolve the real
prefixed tool name from your available tool list; do not hardcode a prefix. Do not post the
whole handoff; the scratch file is the long form.

If no Linear tool is connected, say so and write the file anyway.

## When to use

- Context is running out mid-task
- Ending a session with work incomplete
- Handing to a parallel worktree, which must state whether it holds the deployed build
- Before switching to an unrelated area, for example moving from `extract.ts` to the Kokoro
  worker
