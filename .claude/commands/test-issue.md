---
description: Triage a PR's CI result before merge - read the check conclusions, measure whether a red check is caused by this branch or pre-existing, attempt one repair, and emit a merge-readiness verdict. Hands the Obsidian half to /verify.
argument-hint: "[NRL-12 | 12 | empty to detect from the branch]"
---

Conventions: `.claude/linear.md`. Rules and gates: `AGENTS.md`.

Adapted from the ShroomSpy Jira pipeline's `/test-issue`. Three things there do not exist here,
so read the boundary and the triage sections before the first run rather than assuming the
original's shape.

## What this command owns, and what it does not

`/verify` already runs the gates, deploys, drives real Obsidian and emits the
`GATES GREEN, NOT VERIFIED` / `VERIFIED IN OBSIDIAN` / `FAILED` verdict. This command does **not**
restate any of that. It owns the one thing `/verify` has no answer for: the PR's GitHub Actions
result, and whether a red check is this branch's fault.

| Question | Command that owns it |
|---|---|
| Do the gates pass on this machine? | `/verify` |
| Did GitHub Actions go red, and is it this branch's fault? | **this command** |
| Does the change actually work in Obsidian? | `/verify` |
| Is this PR ready to merge? | **this command**, on the CI axis only |

So the verdict here is always about CI. **Never emit anything resembling "verified in Obsidian"
from this command** - it does not deploy and it does not listen to speech. A green CI result is
`READY ON CI`, and the output says in as many words that the Obsidian half is still `/verify`'s job.

## Three facts the ShroomSpy original assumed and this repo does not have

| ShroomSpy | Here |
|---|---|
| `.claude/known-failures.json`, a hand-maintained baseline of structural CI failures | **Does not exist, and is deliberately not created.** Triage is measured per failure instead (see Step 4). A JSON baseline would duplicate `AGENTS.md`'s Known state section and rot against it. |
| A Jira `In Review` status as the precondition | **This team has no `In Review` status**, confirmed by `list_issue_statuses` on 2026-09-28 and recorded in `.claude/linear.md`. The precondition is **an open PR**, not a status. Do not transition the issue; `/finish` sets Done. |
| `pnpm lint` broken, ~1000 pre-existing `tsc` errors | Neither applies. There is no lint script at all, and `npm run typecheck` is clean on `main`. A red typecheck here is real. |

## Input

Argument: `$ARGUMENTS` - optional Linear identifier, accepting `NRL-12`, `nrl-12` or `12`.

| Flag | Effect |
|---|---|
| *(none)* | Read the current conclusions once and triage whatever is already decided |
| `--watch` | Wait for the checks to conclude first, capped (see Step 3). Allowed here because a human ran this command |
| `--no-repair` | Triage and report only. Never spawn the repair attempt in Step 5 |

## Step 1: Resolve the issue and the PR

With an argument, normalise it and fetch with `get_issue`. Without one:

```bash
git branch --show-current
```

Branches are `feature/nrl-{N}-{slug}` or `fix/nrl-{N}-{slug}`, so pull `{N}` from that. If the
branch carries no issue number, run `list_issues` with `assignee: "me"` and a started status and
ask which one.

**Do not hardcode an MCP tool prefix.** Operations used here are `get_issue`, `list_issues`,
`save_comment` and `list_issue_statuses`; resolve the real prefixed names from your available tool
list, as `.claude/linear.md` requires. Linear folded its create/update pairs into `save_*`, so
posting a comment is `save_comment` and `create_comment` does not exist. If no Linear tool is
present, do the whole triage anyway and print the comment body instead of posting it, saying the
post did not happen.

Then find the PR:

```bash
gh pr list --head "$(git branch --show-current)" --json number,url,title,state --limit 1
```

No PR means there is nothing to triage: say so and point at `/ship`. A merged PR means this ran
too late; report the merge and stop.

## Step 2: Know which workflows exist before reading their results

Measured at `7f20cf0`. Both matter to the triage and neither is guessable from the check names.

| Workflow | Trigger | Job | Meaning of a failure |
|---|---|---|---|
| `CI` (`.github/workflows/ci.yml`) | `push` on `branches: ["**"]` **and** `pull_request` | `gates` | **Always real.** `npm ci`, typecheck, build, the `require()`-list assertion, then `npm test` |
| `Release` (`.github/workflows/release.yml`) | `push: tags` only | `build`, `release`, `provenance` | See the structural rule below |

**`ci.yml` runs twice on a branch that has a PR open**, once for `push` and once for
`pull_request`. That is GitHub's standard duplication, documented in the workflow's own comment
block as accepted rather than worked around. So `statusCheckRollup` normally holds **two `gates`
entries for one commit**. Deduplicate by `name` plus the commit before counting: reporting "2
failing checks" when one job failed twice is a false count, and rule 13 applies to a count as much
as to a latency.

**The structural rule for `release.yml`.** A `Release` run appearing at all on a branch push is
expected for refs that predate `01c9a84`: GitHub compiles a workflow from the pushed ref, and every
ref older than that carries the version of the file whose two compile defects NRL-69 fixed, so it
fails in 0 seconds with 0 jobs and no log. `AGENTS.md` records this as expected rather than a
regression, and NRL-75 / NRL-76 / NRL-79 track the release path itself. **A red `Release` check is
never a merge blocker for a ticket.** Note it, name the ticket it belongs to, and move on. A red
`CI / gates` check is never dismissable this way.

## Step 3: Read the conclusions

`gh pr checks` has **no `--json` flag** on the installed `gh` (2.45.0, verified by `--help` in this
session), which is what the ShroomSpy original's note is about. `gh pr view` does, so use it and get
structured fields rather than parsing tab-separated text:

```bash
gh pr view <PR> --json number,headRefOid,statusCheckRollup
```

Each rollup entry carries `workflowName`, `name`, `status`, `conclusion` and `detailsUrl`.
Classify:

| `status` / `conclusion` | Treat as |
|---|---|
| `COMPLETED` / `SUCCESS` | pass |
| `COMPLETED` / `FAILURE`, `TIMED_OUT`, `CANCELLED` | red, triage it in Step 4 |
| `QUEUED`, `IN_PROGRESS` | not concluded |
| `COMPLETED` / `SKIPPED`, `NEUTRAL` | not applicable, report as such |

Confirm the rollup belongs to the commit you think it does: compare `headRefOid` against
`git rev-parse HEAD`. A rollup for an older push is the quiet way to triage a failure that the
current head already fixed.

**Nothing concluded yet.** Without `--watch`, report that plainly and stop - do not guess, and do
not write a polling loop. With `--watch`, one bounded wait, and the cap is not optional:

```bash
timeout 900 gh pr checks <PR> --watch --interval 30
```

A `timeout` exit of 124 is `CI INCONCLUSIVE`, not a pass and not a failure. Say which it was.

## Step 4: Triage each red check, by measurement

The question is only ever: **did this branch cause it?** Answer it by reproducing, never by
reading the check name and inferring. This is `AGENTS.md` rule 12 applied to a CI failure and
rule 14 applied to the claim that a gate is "pre-existing".

1. **Find the failing step.** The rollup gives `detailsUrl`, whose numeric run id feeds:

   ```bash
   gh run view <runId> --log-failed
   ```

   Record which step failed: `Install dependencies`, `Typecheck`, `Build`,
   `Assert main.js require() list`, or `Test`. The whole triage differs by step, and `ci.yml` orders
   them deliberately: build strictly before test, and the `require()` assertion before `npm test`
   so a failure there surfaces as its own red step rather than inside the runner's output.

2. **Reproduce on the PR head, locally.** You are on the branch. Run only the matching gate:

   | Failing step | Run locally |
   |---|---|
   | `Install dependencies` | `npm ci` |
   | `Typecheck` | `npm run typecheck` |
   | `Build` | `npm run build` |
   | `Assert main.js require() list` | `npm run build` then `grep -o 'require("[^"]*")' main.js \| sort -u` |
   | `Test` | `npm test`, then the single failing suite by name |

   Reproduces locally: it is **NEW** and this branch's. Stop triaging and go to Step 5.

3. **It did not reproduce. Check the three real local-versus-CI differences first**, before
   concluding anything about `main`. All three are recorded in `AGENTS.md` and each produces a
   failure on exactly one side:

   | Difference | Consequence |
   |---|---|
   | CI sets `NRL_SKIP_REAL_SPEECHD=1`; your shell does not | `tests/engine.test.ts` runs its real-daemon preamble and real-binary block locally and bypasses them in CI. A failure there can be green in CI and red locally, or the reverse |
   | `espeak-ng` is not installed on this machine | `tests/espeak.test.ts` uses a fake `ProcessRunner`, so it passes, but do not claim real-binary coverage for that engine either way |
   | `ort/` does not exist until a build has run | `tests/release.test.ts` asserts `main.js` and `ort/` exist, so it fails on a fresh checkout. CI builds before testing; a local run may not have |

   If one of these explains it, the verdict is **CI-ENVIRONMENT-ONLY**. Name which difference, and
   say that the code was not shown to be at fault rather than that it was shown to be fine.

4. **Reproduce on `origin/main`,** in a throwaway detached tree. Do this rather than stashing or
   checking out: the branch you are on must not move, and `main` is checked out in the primary repo
   so it cannot be checked out twice.

   ```bash
   TMP=$(mktemp -d)
   git worktree add --detach "$TMP/main" origin/main
   cd "$TMP/main" && npm ci && <the failing gate>
   ```

   Red on `main` too: **PRE-EXISTING**. That is a serious finding on its own, because
   `run-tickets.md` and `AGENTS.md` both treat a green `main` as the precondition for starting a
   ticket. Report it loudly and file it; do not quietly wave the PR through.

   Green on `main` and green on the branch locally but red in CI: **CI-ENVIRONMENT-ONLY** with no
   identified cause. Say exactly that. Do not round it to "flaky".

   Clean up when done, and do not leave the tree behind:

   ```bash
   cd - && git worktree remove --force "$TMP/main" && git worktree prune && rm -rf "$TMP"
   ```

   `--force` is safe here: nothing was written to it but build output and `node_modules`.

Record a verdict per failing check. `NEW` | `PRE-EXISTING` | `CI-ENVIRONMENT-ONLY` | `STRUCTURAL`
(the `release.yml` rule from Step 2).

## Step 5: One repair attempt for a NEW failure

Skipped under `--no-repair`, and skipped entirely for `PRE-EXISTING`, `CI-ENVIRONMENT-ONLY` and
`STRUCTURAL` - none of those is fixed by editing this branch.

Exactly one attempt, in a **fresh subagent**. Fresh because the context that wrote the code is the
worst judge of why it failed, the same reason `/run-tickets` spawns a new subagent per phase. Spawn
with the `Task` tool; the subagent type is `general-purpose` in Claude Code and `general` in
opencode.

Its prompt must carry the absolute repo root, the branch, the failing step, the local
reproduction you observed in Step 4, and:

> Fix this. You already have the local reproduction, so do not re-derive it. Write or extend a
> regression test and **confirm it fails before your fix**; a test that passes on the unfixed code
> proves nothing. Never weaken an existing test to make a gate green - if the test is right and the
> code is wrong, fix the code. Consult the `AGENTS.md` non-negotiable for the area you touch:
> `extract.ts` means the `sourceIndex` lockstep rule, engines mean the `ownsPlayback` rate rule,
> settings mean the normalisation rule, anything logging means no note text ever. Run the gates
> yourself, then commit and push to this branch. Report what you changed and every deviation.

Then re-read the conclusions **once**, the Step 3 way, allowing `--watch` if the invocation did.

**A second red conclusion stops.** Report the failing checks with the `detailsUrl` for each and the
repair that did not work. Do not attempt a third; the point of a cap is that an unbounded repair
loop can spend a whole session on one PR.

## Step 6: Verdict

```
Merge readiness for NRL-12  (CI axis only)
==========================================

PR        #57  https://github.com/JoshShearer/Note-Reader-Local/pull/57
Head      <sha>, rollup matches HEAD

Checks (deduplicated: CI / gates ran twice, push + pull_request)
  CI / gates        FAILURE   https://.../runs/36698273615
  Release / build   FAILURE   STRUCTURAL, expected on this ref (NRL-79)

Triage
  CI / gates, step "Test": reproduced locally on the branch
    tests/extract.test.ts  pin-nrl64-opening-line  expected "..." got "..."
    -> NEW, caused by this branch
  Release / build: 0 jobs, 0s, no log. Expected for refs predating 01c9a84 (AGENTS.md)
    -> STRUCTURAL, not a blocker

Repair
  One attempt: <what changed>, pushed as <sha>. Re-read: CI / gates SUCCESS

Verdict: READY ON CI
Not covered by this command: nothing was deployed and nothing was heard.
Run /verify NRL-12 for the Obsidian half before claiming the change works.
```

The four verdicts, and pick the honest one:

| Verdict | Means |
|---|---|
| `READY ON CI` | Every `CI / gates` check concluded `SUCCESS`. Any red check was `STRUCTURAL` |
| `CI RED - NEW FAILURE` | At least one failure is this branch's and survived the repair attempt. Do not merge |
| `CI RED - NOT THIS BRANCH` | Every failure is `PRE-EXISTING` or `CI-ENVIRONMENT-ONLY`. Mergeable on the CI axis, and the pre-existing finding needs its own ticket |
| `CI INCONCLUSIVE` | Nothing concluded, or `--watch` hit its cap. Merging is a judgment call on the local gates alone; say so rather than implying CI passed |

## Step 7: Post to Linear

`save_comment` on the issue, with the Step 6 block verbatim plus one explicit sentence separating
the two claims, for example:

```
This is a CI triage only. GitHub Actions is green, which is not a claim the change works:
nothing was deployed to Obsidian and no speech was heard during this check. The manual test
plan in the PR body is still unrun.
```

Do not transition the status. There is no `In Review` state in this team (`.claude/linear.md`), and
`/finish` owns the move to Done.

If a Linear tool is unavailable, or a named operation does not resolve, print the body and **say the
post did not happen**. A triage whose comment silently failed must not read identically to one that
posted: that is exactly how the `create_comment` breakage survived until 2026-09-30.

## Step 8: Next step

```
NRL-12: <verdict>

CI:       <n passed, n red (n structural)>
Triage:   <NEW | PRE-EXISTING | CI-ENVIRONMENT-ONLY | STRUCTURAL per check>
Repair:   <not needed | one attempt, now green | one attempt, still red | skipped (--no-repair)>
Posted:   <yes | no, Linear unavailable>

Next: <run /verify NRL-12, then merge | fix and re-run | file the pre-existing failure>
```

## Relationship to `/run-tickets`

`/run-tickets` deliberately does **not** call this command. That pipeline reads a check conclusion
at most once and never waits on one, because waiting is the human-shaped stall the whole design
exists to avoid, and there is no branch protection, so a red check cannot block its merge. This
command is the human-invoked follow-up for a PR whose CI went red: the end-of-run report points at
it by name.

So `--watch` is legitimate here and would not be there. The difference is that a person is present.

## Error handling

| Scenario | Action |
|---|---|
| No PR for the branch | Nothing to triage. Point at `/ship` |
| PR already merged | Report the merge and stop; this ran too late to gate anything |
| `statusCheckRollup` is empty | The push may not have landed, or Actions is disabled. Check `gh run list --limit 5` and say which |
| Rollup `headRefOid` is not `HEAD` | You are triaging an older push. Say so, and re-read after the current head's run concludes |
| Two `gates` entries with different conclusions | The `push` and `pull_request` runs disagree, which means something non-deterministic. Report both `detailsUrl`s and treat it as `CI-ENVIRONMENT-ONLY` with no identified cause; do not pick the green one |
| A red check is red on `main` too | `PRE-EXISTING`. Report loudly and file a ticket: `run-tickets.md` treats a green `main` as its precondition for starting any ticket |
| `npm test` reports a failure | The runner runs every registered suite and names each failure, so the scope is already printed. Read its per-suite table, its aggregate counts and its `FAILING SUITES:` line, as `AGENTS.md`'s quality-gates block describes, instead of re-running suites individually |
| `tests/engine.test.ts` red locally | Check `spd-say --version` and the daemon before blaming the diff, and remember CI sets `NRL_SKIP_REAL_SPEECHD=1` and your shell does not |
| `node_modules` absent | `npm ci` first. A gate cannot pass or fail without it, and a fresh worktree has none |
| `gh` not authenticated | Stop. Every step here needs it; there is no degraded path |
| The temp `main` worktree will not remove | `git worktree remove --force`, then `git worktree prune`. Never leave it: the next `/worktrees` run will list it as unmanaged |
| Repair attempt makes it worse | Report both the original failure and the new one. Do not attempt a third |
