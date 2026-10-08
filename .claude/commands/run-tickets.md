---
description: Run a set of Linear tickets end to end without waiting on a human, in a disposable worktree it creates and removes - pre-flight triage, then per ticket a scripted start, one Build agent (plan + implement), scripted ship, a critic, automated verify, a Fix loop, and a scripted merge into main and finish. Anything that needs the owner blocks that ticket and is reported at the end.
argument-hint: "[NRL-NNN[,NRL-NNN,...]|all] [--no-merge] [--keep-worktree] [--resume [<stamp>]]"
---

Conventions: `.claude/linear.md`. Rules and gates: `AGENTS.md`.

**This file is read by the orchestrator only.** Subagents get the self-contained prompts under
"Phase prompts" and never read this file or the interactive commands (`/start-issue`, `/ship`,
`/finish`, `/verify`, `/test-issue`): those stop to ask, deploy, or wait on CI, and from a lane they
would act on the wrong tree. Their essential steps live in `scripts/run-tickets/ticket-ops.mjs`.

**Per clean ticket: three agents** (Build, Critic, Verify), plus one per Fix round. Everything with no
judgement in it - branching, pushing, opening and merging the PR, cleanup, and every write to the
state file - is the script, run by the orchestrator with one Bash call. Linear is MCP-only, so
tracker reads and writes stay with the orchestrator, which records each outcome through the script.

## Facts that decide behaviour

| Fact | Consequence |
|---|---|
| **The run does not wait on a human.** The owner tests by using the app and files tickets for what they find. | Open questions get a recorded default; Verify and merge are automated. Anything needing the owner blocks **that ticket** and the run moves on. Only these stop the whole run: the Fix cap, `main is red`, a failed Step 0c, expired `gh` auth, and a refused permission. A failed Verify, a critic BLOCK and a merge conflict are **not** blocks: they go through the Fix loop (2026-10-02 skipped two tickets whose Verify had handed over exact repros, and the owner had to direct the fix by hand). |
| **Base and merge target is `main`**, the only branch. | The run never pushes a tag: a bare-semver tag cuts a public Release (`release.yml`). Pushes are one explicit branch refspec with `--no-follow-tags`. |
| **The community installer reads `versions.json` from `main`'s HEAD**, not from a Release (`release.yml`, NRL-105). | A diff touching it is a release decision: `merge` blocks it and the owner merges. |
| **The merge gate is the commit Verify graded, against the base it graded on.** | Merge needs critic `pass`/`concerns` and Verify `pass`, each recorded with the sha it graded, both equal to the pushed `commitSha` (`null` is not a pass), and `origin/main` still equal to the `verifiedBaseSha` Verify recorded - parallel runs move it. Merge passes `--match-head-commit`. |
| **The critic is its own phase**, against the pushed head. It never reads `.claude/last-critique.md` (`/ship` reuses that file when its hash matches HEAD, which leaks one ticket's verdict to the next). | Every pushed head is critiqued exactly once, by an agent that wrote none of it, and it writes no file: the orchestrator records its `VERDICT:` line. |
| **A green suite is not a working feature** (`AGENTS.md` rule 11). The suites run in bare Node against fakes. | Verify also runs the real bundled module against every acceptance input. Nothing is described as verified in Obsidian: PRs carry `NOT VERIFIED IN OBSIDIAN`, Linear comments say "Not verified in Obsidian by a human." |
| **Bugs are reproduced before they are fixed** (`AGENTS.md` rule 12). | Build reproduces first; a bug it cannot reproduce blocks. |
| **The vault is the owner's real one**, and **one deploy slot**: `npm run deploy` writes one plugin folder in `~/Documents/Notes`, beside `data.json` (settings and every reading position). | No agent deploys. The run deploys **once**, at Step 8, merged `main` only, holding `$PRIMARY/.claude/deploy.lock` (in the primary: a lock in a fresh lane is free by construction). **Guarded mechanically**: Step 0c marks the lane in its own git dir, and `deploy.mjs` refuses from a marked lane unless the lock's `holder` names that lane and HEAD is a clean `origin/main`. Lock held -> skip and say so; never wait. |
| **A deploy is not live until Obsidian is fully restarted** (2026-09-28: two tickets "passed" against a stale build after an in-app reload). | The run never drives the owner's Obsidian (CDP on :9222 reaches their live vault, and without a restart a smoke test grades the old build). The end-of-run report tells the owner to quit and relaunch. |
| **The engine suite speaks through the real speech-dispatcher** (`spd-say` and its daemon, never `espeak-ng`). CI sets `NRL_SKIP_REAL_SPEECHD=1` because its runner has no daemon. | The lane never sets it: Step 0c refuses if it is exported, and `ticket-ops` strips it from the gates. A skipped engine check is partial coverage, never a pass. Before blaming code for an engine failure, check `spd-say --version` and `spd-say -O`. |
| **Build strictly before test.** `tests/release.test.ts` reads the built `main.js` (`ci.yml`; `release.yml` once had them reversed). | Gate order everywhere is CI's: `typecheck`, `lint`, `build`, `test`. A `release` `ENOENT` on `main.js` means the build did not run, not that `main` is broken. |
| **CI** (`ci.yml`, workflow `CI`, job `gates`) runs on `push` and `pull_request`; no branch protection. | Verify runs the gates itself; CI is a backstop. Read it **once** with the snippet in "Reading a CI conclusion" (NRL-86); never wait or poll. |
| **A PR can be merged by hand while the run is live** (PR #219, 13 s after Verify recorded a fail). | Every phase checks the PR's state first. A PR merged outside the run before Verify passed gets a **follow-up** branch and PR off `origin/main`, and the report names it. |
| **Parallel runs are supported**, each with its own lane and stamped state file; no run-wide lock (2026-09-29: two runs sharing one `pipeline-state.json` destroyed six ticket entries and an archive, then rewrote `main`). | Overlapping tickets are blocked in your own run. Shared things have narrow guards: the deploy slot by its lock, `main` by git. |
| **Interactive worktrees are `note-reader-local-nrl-*`** (`worktrees.md`'s pool; `finish.md` removes them by name). | The lane is `<primary>-run-<stamp>`, never `-nrl-*`, and the run never removes a worktree it did not create. |
| **Reproduced defects are listed** in the "Known state" section of `docs/agent-history.md` (moved out of `AGENTS.md` on 2026-10-04, `e2afbfe`). | Triage copies a listed repro rather than asking for one. Never re-create that section in `AGENTS.md`. |

## Token budget

Measured on NRL-166: **cached-context re-read was ~97% of cost**; output was ~86k tokens for the whole
ticket. Every tool call re-sends the agent's whole context, so cost is _calls x context size_. Half the
ticket was Fix round 1 running three `/critique` cycles in one context that grew to 390k; ~60 small
`sed -n` reads paged through `src/text/extract.ts` (7,258 lines) and `tests/extract.test.ts` (7,594
lines); and ADR 0025, `docs/agent-history.md` and `srs.md` were rewritten every round.

1. **One critique per pushed head, by its own agent.** No agent critiques, fixes and critiques again.
2. **Per agent: ~150k tokens or ~60 tool calls**, whichever first. The always-loaded instructions
   count first (Claude Code loads `AGENTS.md`, ~2k tokens; opencode also loads `CONTEXT.md` and
   `.claude/linear.md`, ~13k). At the budget the agent commits **locally** (`wip:` if its gates have
   not passed; never pushed), returns `handoff` (done / next / open, under 15 lines), and the
   orchestrator spawns a fresh agent for the **same** phase. A handoff is not a Fix round.
3. **Batch reads.** One `grep -n` for every symbol, then one call with several `sed -n 'a,bp;c,dp'`
   ranges. Index any file over ~1,500 lines with grep first - `extract.ts` and `extract.test.ts` above
   all - and read only the ranges you will change.
4. **Bulk output goes to a log**: `npm ci`, the suite, lint, builds. Read the tail and grepped
   failures; capture the exit code separately (`cmd > "$LOG" 2>&1; echo "exit=$?"`) - a pipe into
   `tail` hides it.
5. **Docs once.** Fix rounds do not edit `docs/`, `srs.md`, `AGENTS.md` or `CONTEXT.md`; they return a
   one-line `roundNote` that Ship appends to the PR body. A doc the ticket itself requires (an ADR for
   an `srs.md` amendment) is written once, in Build. Known-state and requirement-status updates are
   collected as `docsCandidate` and written once per run, in Step 7b.
6. **Structured returns, one writer.** Agents return one fenced JSON object and never write the state
   file. The orchestrator saves it to a file (the Write tool, or a **quoted** `<<'EOF'` heredoc - never
   `echo '...' |`, which a `'` in a PR body breaks, and never an unquoted heredoc, which runs `$(...)`
   from agent text in your shell) and runs `$OPS record <KEY> --phase <phase> --input <file>`.
7. **Every agent runs on the session's default model.** The cheap phases are now the script; each
   remaining agent makes a judgement that flows into merged code, Triage's on the owner's behalf.
8. **Mechanical steps are not agents.** Plan and Implement are one Build agent (a separate Plan agent
   re-read the same code for an artifact only Implement used).

## How to launch it

Unattended is a property of the launch. `opencode.json` sets `git push *`, `git reset --hard*`,
`git branch -D *`, `git clean *` and `rm -rf *` to `ask`; the run itself issues `gh pr merge`,
`gh api -X DELETE`, `git worktree remove`, `git branch -D` (its run branch), `git reset --hard` and
`rm -rf` (the deploy lock) as plain Bash calls, and `ticket-ops` pushes and resets inside `node` -
only ever the run's own branches and lane.

- **opencode**: `opencode run --auto --command run-tickets "NRL-19,NRL-20"` (headless auto-approves
  everything not denied; `npm publish*` stays denied).
- **Claude Code**: `/run-tickets NRL-19,NRL-20` in a bypass-permissions session.

If a command is refused or prompts mid-run, the run was launched wrong: stop and report which one.
Never loosen `opencode.json` or the Claude Code settings from inside a run, and never self-approve a PR.

## Tracker: Linear

MCP server `linear-nrl`, team `NRL`. Resolve the real tool names from your tool list (the prefix
differs between runtimes). Operations: `get_issue`, `list_issues`, `save_issue` (status via `state`,
never `status`), `save_comment` (there is no `create_comment`), `list_issue_statuses`. Statuses are
Linear's default six; there is **no In Review**, so a ticket stays In Progress with its PR open.

- **Every write is read back** (`get_issue`) and recorded: `$OPS record <KEY> --phase orchestrator`
  with `{"trackerWrite": {"op": "state:In Progress", "ok": true}}`. A failed read or write **blocks
  that ticket**, never the run. The report names every write with `ok: false`.
- **Ownership is checked fail-closed.** Before Start (and in Phase 0) `get_issue` must show: status
  not `Done`, `Canceled` or `Duplicate`; not `In Progress` unless this ticket's `trackerWrites` already
  holds this run's own `state:In Progress` attempt; no assignee, or the authenticated user (resolve
  "me" once at Step 0 through your tool list, e.g. `list_issues` filtered to assignee `me`). Anything
  else - including a read that errors, or a "me" you could not resolve - blocks the ticket with
  `noTracker: true`. The run never comments on or moves a `noTracker` ticket; the flag only goes
  false -> true.
- **No Linear tool at all** means ownership cannot be checked, so every ticket blocks. (The
  interactive commands' git-only degradation does not apply to an unattended run.)

## Input

`$ARGUMENTS`: comma- or space-separated keys (`NRL-12`, `nrl-12`, `12`) or `all`, plus `--no-merge`
(stop each ticket after Verify with its PR open; later tickets then branch from a `main` without
earlier fixes, so use it for one ticket or unrelated ones), `--keep-worktree` (skip Step 8's removal),
or `--resume [<stamp>]`. `--build` is accepted and has no effect: every gate run builds, because the
suite needs `main.js`. Keys are validated against `^NRL-[1-9][0-9]*$` by `ticket-ops init` - they
reach branch names and shell commands. No argument -> ask which tickets; that is the only question.

`all` = `list_issues` for team `NRL`, assignee `me`, not in a completed or canceled state, priority
order; each key then goes through `$OPS add`, which validates it.

## Step 0: Establish facts

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
PRIMARY="$REPO_ROOT"
[[ "$(basename "$PRIMARY")" =~ -run-[0-9]+-[0-9]+$ ]] && PRIMARY="${PRIMARY%-run-*}"
[[ "$(basename "$PRIMARY")" =~ -nrl-[0-9].*$ ]] && PRIMARY="${PRIMARY%-nrl-*}"
git -C "$PRIMARY" rev-parse --git-dir          # must print ".git"; otherwise stop and report both paths
STAMP=$(date -u +%Y%m%d-%H%M%S)
STATE_FILE="$PRIMARY/.claude/pipeline-state.${STAMP}.json"
DEPLOY_LOCK="$PRIMARY/.claude/deploy.lock"
RUN_WT="${PRIMARY}-run-${STAMP}"
RUN_BRANCH="run/${STAMP}"
git -C "$PRIMARY" fetch origin && git -C "$PRIMARY" rev-parse --verify origin/main
git -C "$PRIMARY" status --short -- src tests docs     # must be empty
gh auth status
```

Stop the run if: `--git-dir` is not `.git`; `fetch` fails; `src`/`tests`/`docs` is dirty in the
primary (a human mid-edit: report, never stash or discard - a dirty `.claude/` or `README` is fine,
the lane is cut from `origin/main`); `gh auth status` fails.

### Step 0a: Freeze the script, claim the state file

```bash
OPS_DIR="$PRIMARY/.claude/scratch/ops-$STAMP"
mkdir -p "$OPS_DIR/scripts/run-tickets" && git -C "$PRIMARY" show origin/main:scripts/run-tickets/ticket-ops.mjs \
  > "$OPS_DIR/scripts/run-tickets/ticket-ops.mjs" || { echo "origin/main has no ticket-ops - stop"; exit 1; }
OPS="node $OPS_DIR/scripts/run-tickets/ticket-ops.mjs --state $STATE_FILE"
ARGS=$(cat <<'EOF'
$ARGUMENTS
EOF
)
$OPS init --args "$ARGS" --stamp "$STAMP" --primary "$PRIMARY" --worktree "$RUN_WT" --run-branch "$RUN_BRANCH"
ls -1 "$PRIMARY"/.claude/pipeline-state.*.json | command grep -vxF "$STATE_FILE" || true
```

The frozen copy comes from `origin/main`, before any ticket branch exists: a ticket that edits
`ticket-ops` cannot change the gate that merges it. `init` derives `noMerge` from the arguments (never
edit it by hand), refuses an invalid key, and creates the state file exclusively (a stamp collision
stops: re-run, never reuse the file). `command grep`: in the Claude Code Bash tool `grep` can be a
function wrapping ugrep with `--ignore-files`, which honours `.gitignore` - and `.gitignore` lists
these files. Name any other run's state file in the first message; reading its `tickets`, read-only,
is the only access allowed - block your own copy of any ticket it holds
(`blockedReason: "also held by run <runId>"`).

**Never**: write, move or delete a state file you did not create (an unstamped `pipeline-state.json`
is a pre-stamp run's: leave it); empty `.claude/scratch/`; rewrite a branch you did not create; amend,
rebase or reset `main`; checkout, reset or commit in `$PRIMARY`; remove a worktree other than `$RUN_WT`.
The run's only writes in the primary are `.claude/` (state, scratch, deploy lock) and the worktree
add/remove pair.

### Step 0c: Create and prove the lane

```bash
git -C "$PRIMARY" worktree add --no-track -b "$RUN_BRANCH" "$RUN_WT" origin/main
cd "$RUN_WT"
[ -z "${NRL_SKIP_REAL_SPEECHD+x}" ] || { echo "NRL_SKIP_REAL_SPEECHD is exported: unset it and relaunch - stop"; exit 1; }
# deploy.mjs refuses to deploy from a directory carrying this marker unless the slot names it.
printf '{"lock":"%s","base":"origin/main"}\n' "$DEPLOY_LOCK" > "$(git rev-parse --absolute-git-dir)/run-tickets-lane"
LOG=$(mktemp -d)
npm ci > "$LOG/ci" 2>&1; echo "ci exit=$?"
for s in typecheck lint build test; do npm run "$s" > "$LOG/$s" 2>&1; echo "$s exit=$?"; done
tail -3 "$LOG/test"; command grep -n "FAILING SUITES\|SKIP" "$LOG/test" | head
```

`--no-track`: the run branch has no upstream, so a stray bare `git push` cannot target `main`. The
marker lives in the lane's git admin dir, so it never dirties the tree and `git worktree remove`
deletes it. **Any non-zero exit stops the run**: `origin/main` is broken (or this host is - check
`spd-say -O` first), and branching tickets off it compounds the problem. Lint warnings are tolerated;
lint errors fail, as in CI.

`--resume`: no new stamp or lane. Read `worktree`, `runBranch` and `stamp` from the state file and set
the Step 0 variables from them; set `OPS_DIR`/`OPS` as above, and if `OPS_DIR` is missing recreate it
from `origin/main`, never from the lane. If the directory is gone, `git -C "$PRIMARY" worktree add
"$RUN_WT" "$RUN_BRANCH"`; if `$RUN_BRANCH` is gone too, stop. **Then move to a clean base before
proving anything**: if `git status --porcelain` is not empty, commit the leftovers on the current
ticket branch as `wip: left before resume` (never pushed); `git checkout --detach origin/main`; rerun
Step 0c from the `NRL_SKIP_REAL_SPEECHD` line on (a half-edited ticket branch must not fail the proof
and be blamed on `main`). Then check out the in-progress ticket's `branch` and continue from its
`phase` (and `handoff`). `noMerge` comes from the state file, never from the resume command. A run with
a top-level `halted` resumes by re-reading that ticket from Linear (the owner's decision is expected
there), `$OPS unhalt <KEY>`, and continuing. With no stamp: resume the one state file holding an
`in_progress` ticket or `halted`; if several, list them and stop.

### Step 0d: Resync between tickets

```bash
git -C "$RUN_WT" status --porcelain     # must be empty
git -C "$RUN_WT" checkout "$RUN_BRANCH" && git -C "$RUN_WT" fetch origin && git -C "$RUN_WT" reset --hard origin/main
```

Not empty -> **do not reset**. Commit the leftovers on the previous ticket's branch as
`wip: left in lane after <phase>` (never pushed), record it, then resync. Step 8 keeps the lane for it.

## Phase 0: Triage, before any ticket starts

`$OPS add <KEY>` for each key. Run the ownership check (Tracker section) on each; record each block
with `{"result": "blocked", "blockedReason", "noTracker": true}` via `--phase orchestrator` **before**
anything else for that ticket. Fetch the rest with `get_issue` and spawn **one** read-only Triage agent
for the batch with their full text in the prompt; await it (every phase is awaited before the next is
spawned). Then, without waiting:

- Each ticket's slice of its return -> `$OPS record <KEY> --phase triage`. `record` lists in `toPost`
  the pipeline decisions not yet posted: post each with `save_comment` as "Decided by /run-tickets
  (owner may override): <question> -> <answer>, because <reason>.", then record
  `{"postedQuestions": [...], "trackerWrite": {...}}`.
- `unresolvable` -> `result: "blocked"`; post the reason.
- Print the triage table and decisions in **one** message, then start the first ticket.

## The phases

| # | Phase | Runs as | Job |
|---|---|---|---|
| 1 | Start | ownership check, `$OPS start`, Linear -> In Progress | Snapshot the issue, branch off the run branch |
| 2 | Build | agent | Plan, reproduce bugs first, red tests, fix, all four gates, one clean commit, PR text |
| 3 | Ship | `$OPS ship` | Gates (skipped only when `HEAD` = `gatedSha` and no gate-defining file changed), leased push, read-back, PR create/adopt or Round line |
| 4 | Critic | agent | `/check-constraints` + `/critique` checks once, at the depth `$OPS risk` gives, writing nothing |
| 5 | Verify | agent | Head and base assertion, the four gates + require() check, every acceptance probe, one CI read |
| 5a | Fix | agent | Findings -> red tests -> root-cause fix -> clean commit (Ship pushes it) |
| 6 | Merge | `$OPS merge` / `merged` | Squash-merge pinned to the graded head and base |
| 7 | Finish | `$OPS finish`, Linear -> Done | Lane resynced, local branch deleted by head equality |
| 7b | Docs | Build-shaped agent, once per run | Known-state / requirement-status updates collected as `docsCandidate` |

Strictly one ticket at a time through phase 7.

### `scripts/run-tickets/ticket-ops.mjs`

Run from the lane as `$OPS <cmd> <KEY>` (`start`/`finish` take `--run-branch "$RUN_BRANCH"`; `record`
and `start` take `--input <file>`). One JSON line out; exit **0** ok, **1** usage or malformed input
(nothing was written; re-run that agent once, then block), **2** infrastructure (stop the run), **3**
blocked (already recorded), **4** fail (route to Fix; `verifyFindings` is set). What each step
guarantees is enforced there, and pinned by `tests/runTickets.test.ts`:

- **record** - validates the return's shape (object, `result` in the phase's set, every field's type)
  before writing anything; keeps only the fields that phase may set (`dropped` lists the rest); only
  onto a ticket in that phase, never onto a `done` one; refuses a verdict whose sha is not the pushed
  `commitSha`, and a critic/Verify `result` without its matching verdict; lets a Fix change `branch`
  only to `<branch>-followup` together with `prNumber: null`; routes `phase` (Build/Fix `done` ->
  ship; critic `pass`/`concerns` -> verify, `block` -> fix; Verify `pass` -> merge, `fail` -> fix;
  `handoff` stays; `blocked` blocks). A new `commitSha` clears both verdicts.
- **start** - input `{title, description, type}` from `get_issue`; resyncs the lane if `origin/main`
  moved; names `fix/nrl-<n>-<slug>` or `feature/...`; blocks on a branch collision; records the branch
  and leaves `phase: build`. The orchestrator then sets In Progress and reads it back: In Progress on
  read-back after our own attempt is success, whatever the write call returned.
- **ship** - refuses a dirty tree or a `wip:` commit; fetches, and if `origin/main` is not in `HEAD`
  rebases onto it itself (a conflict aborts and fails to Fix) - whether the base moved is decided from
  git, never from an agent's note; runs `npm run typecheck/lint/build/test` (with
  `NRL_SKIP_REAL_SPEECHD` removed) unless `HEAD` is the agent's `gatedSha` **and** no gate-defining
  file changed; blocks if origin holds a commit the run did not push; pushes one branch refspec with a
  lease and `--no-follow-tags` (plain push for a new branch), reads it back, records `commitSha`;
  adopts an existing open PR for the branch, else opens one against `main` with a literal
  `NOT VERIFIED IN OBSIDIAN` line; or appends `Round <n>: <roundNote>` via `gh api` (this repo's
  `gh pr edit` has failed silently) and reads it back. A PR merged outside the run, or based elsewhere,
  is a fail; one closed unmerged blocks.
- **risk** - `critique.md` Step 3's factors over `origin/main...commitSha`. Every file list here is
  `--no-renames` with deletions included (a rename lists only its new path, so moving a workflow out
  of `.github/` would otherwise read as no gate change). A **gate-defining file** (`package.json`, the
  lockfile, `.npmrc`/`.nvmrc`, any `tsconfig*.json`, `eslint.config.*`, `esbuild.config.mjs`,
  `run-tests.mjs`, `build-tests.mjs`, `tests/suiteRegistry.test.ts`, `deploy.mjs`, `opencode.json`,
  `.claude/settings*.json`, anything under `.github/` or `scripts/run-tickets/`, this file,
  `critique.md`, `check-constraints.md`; the suite derives the import closure of the gate scripts in
  `package.json` and fails if the list misses a file) scores +4 and sets `gatesChanged`; 0-1 `L1`, 2-3
  `L2`, 4+ `L2+Double`; any `.claude/` change is at least `L2`.
- **pr-append** - appends a text file to the PR body and reads it back.
- **merge** - preflight only. Refuses unless `noMerge` is explicitly `false` (blocks), both verdicts
  are on `commitSha`, `origin/main` (fetched now) still equals `verifiedBaseSha` (else `route: "ship"`:
  Ship rebases, and the new head is critiqued and verified again - not a Fix round), a gate change
  carries `gateReviews` from at least two critics, every one `justified` (blocks), the diff does not
  touch `versions.json` (blocks), and the PR head is that commit (blocks - including a PR someone
  merged by hand at another head). Two attempts per head.
  Prints `run: ["gh pr merge <pr> --squash --match-head-commit <sha>"]` for you to run as plain Bash.
  No `--delete-branch` (it checks out `main`, which the primary holds, so it fails from a lane), and no
  pre-gate on `mergeable` (GitHub computes it lazily; a fresh PR reads `UNKNOWN`).
- **merged** - reads the PR back rather than trusting `gh`'s exit code: not merged and `CONFLICTING`
  -> fail to Fix; head moved -> block; otherwise `retry` (run `merge` again). Merged at the graded head
  -> records `mergeCommit`, then prints `gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/<branch>"`
  only if the remote branch is exactly that commit (if it moved after the merge: block, "merged; branch
  kept").
- **finish** - requires `phase: finish` and a recorded `mergeCommit`; leftovers are committed as `wip:`
  and block (never reset over); resets the lane to `origin/main` on the run branch; deletes the local
  branch only when it equals `commitSha` (squash-merge makes `git branch -d` lie); returns
  `tracker: "Done"`, or `"skip"` for a `noTracker` ticket.
- **halt** / **unhalt** - the Fix cap, and resuming from it.

### Routing, per ticket

Run or spawn the phase and await it. For an agent, record its JSON (token rule 6). For the critic,
build the JSON from its first lines: `{"result": v, "criticVerdict": v, "criticSha": "<sha>",
"verifyFindings": <its findings, on block>, "gateReviews": [{"justified", "reason"} per critic]}` -
one `gateReviews` entry from **every** critic that reviewed the head when `gatesChanged`, and a
`GATES: unjustified` line makes that critic's verdict `block`. With two critics, record once: the
lower verdict, both findings, both gate reviews. No parseable JSON or `VERDICT:` line, or `record` exit 1:
re-run that agent once, then block the ticket.

| Result | Next |
|---|---|
| `handoff` (any agent) | A fresh agent for the **same** phase, given the `handoff` note. `fixRound` unchanged. |
| `start` ok | Linear In Progress (read back, record), then **Build**. |
| Build or Fix `done` | **Ship**. |
| `ship` ok | `$OPS risk`, then **Critic** at that depth. `L2+Double`: two critics, neither sees the other; the lower verdict wins. |
| `ship` exit 4 | **Fix** (findings in `verifyFindings`). |
| Critic `pass` / `concerns` | **Verify**. On `concerns`, `$OPS pr-append` the findings under "Critic concerns (known leftovers)". |
| Critic `block` | **Fix** - never straight to Verify. |
| Verify `pass` | **Merge**. Under `noMerge`: record `{"status": "done"}` via orchestrator, PR left open. Either way, one Linear comment: gates and suites, critic verdict, probes and results, CI read, and "Not verified in Obsidian by a human." |
| Verify `fail` | **Fix**. |
| `merge` ok | Run its `run` commands (plain Bash), then `$OPS merged`. `route: "ship"` (the base moved) -> **Ship**. |
| `merged` ok | Run its `run` commands, then **Finish**. `retry` -> `merge` again. Exit 4 -> **Fix**. |
| `finish` ok | `tracker: "Done"` -> Linear Done, read back, record. Then Step 0d, next ticket. |
| Exit 3 or `blocked` | `save_comment` the `blockedReason` (not on a `noTracker` ticket); Step 0d; next ticket. Verify blocked on `main is red` also stops the run. |
| Exit 2 | Stop the run and report the step. |

**`fixRound`**: before every Fix spawn that is not a `handoff` continuation, record `fixRound + 1` via
orchestrator - whatever routed there, so Ship -> Fix -> Ship cannot loop uncounted. When a ticket needs
a Fix with `fixRound` already 3, **the run halts**: post every round's findings to Linear,
`$OPS halt <KEY>`, skip Step 8's removal (the lane stays for `--resume`), write the report, stop.

## State file

`$PRIMARY/.claude/pipeline-state.<stamp>.json`, one per run, in the primary so it outlives the lane,
gitignored. Ticket entries are written only by `ticket-ops`. Read one with `$OPS show <KEY> [fields]`.
Per ticket: `id title type requirement knownDefect descriptionSnapshot branch phase status
clarification[] reproduction reproConfirmed planNote implementationSummary docsCandidate gatedSha
prTitle prBody roundNote prNumber prUrl commitSha mergeCommit criticVerdict criticSha gateReviews verifyVerdict
verifiedSha verifiedBaseSha verifyNotes ciStatus fixRound verifyFindings handoff noTracker
trackerWrites[] blockedReason history[]`. Top level: `runId stamp primary worktree runBranch
baseBranch noMerge keepWorktree halted heartbeat tickets[]`.

## Phase prompts

Substitute **literal** values - subagents do not inherit your shell, and one that re-derives the repo
root can land in `$PRIMARY` and commit into the owner's tree: `<lane>` = `$RUN_WT`, `<ops>` = `$OPS`
(the whole command string), plus `<KEY>`, `<branch>`, `<pr>`, `<sha>` (`commitSha`). Spawn
`general-purpose` (Claude Code) or `general` (opencode).

**Every prompt starts with this preamble, verbatim:**

> Work only in `<lane>` (a disposable worktree). Never `cd` elsewhere, never check out `main`, never
> push, never tag, never deploy, never connect to Obsidian (CDP on port 9222 is the owner's live
> vault), and do not follow `/start-issue`, `/ship`, `/finish`, `/verify` or `/test-issue`. Never set
> `NRL_SKIP_REAL_SPEECHD`; the engine suite needs the real `spd-say` and daemon, not `espeak-ng`. Read
> your ticket with `<ops> show <KEY> [field,...]`; **never write the state file or to Linear** - your
> return is recorded for you. Probes and scratch files go in a `mktemp -d` directory, never the repo.
> No note text in any log (`AGENTS.md` rule 1). Budget: stop at ~150k context or ~60 tool calls -
> commit locally on the ticket branch (`wip:` prefix if your gates have not passed) and return
> `result: "handoff"` with a `handoff` note (done / next / open, under 15 lines). If you block after
> editing, commit the same way so the lane is clean. Batch reads: one `grep -n` for every symbol, then
> one call with several `sed -n` ranges; index any file over 1,500 lines with grep first
> (`src/text/extract.ts` and `tests/extract.test.ts` are over 7,000). Send `npm ci`, suites, lint and
> builds to a log, capture the exit code separately (`cmd > "$LOG" 2>&1; echo "exit=$?"`), read only
> the tail and grepped failures. **Return only one fenced JSON object**: your phase's fields plus
> `result`, `note` (under 3 lines) and, when blocked, `blockedReason`.

**Triage** - "For each ticket below [keys + full text, including any Decisions section - the owner's
recorded answers]: grep and read the files it names; do not judge by title. Return a JSON object keyed
by ticket, each value `{result: done|blocked, type: bug|feature|chore, requirement, knownDefect,
reproduction, clarificationAdd, blockedReason, note}`, with the judgment (simple / complex /
needs-decomposition), dependencies and file overlap in the given order in `note`. `requirement` is the
`srs.md` ID it closes, if any. `knownDefect`: it is in the Known state list of
`docs/agent-history.md` - then copy that repro into `reproduction`. `clarificationAdd`: for each open
question the text does not answer, `{question, answer, reason}` - your recommended answer, preferring
the ticket's own principles, `srs.md`, `AGENTS.md` and how Obsidian itself behaves; a ticket that
amends `srs.md` gets a decision that an ADR in `docs/adr/` ships in its PR. `blocked` only when no
defensible default exists: no requirement and no clear acceptance criteria; the ticket contradicts
itself or an `AGENTS.md` non-negotiable; it needs product intent with nothing to infer it from; it
cannot be finished inside this repo; it needs hardware this machine lacks (an Android phone for R-M03,
a non-Linux desktop); or it edits `versions.json` or cuts a release. Change nothing."

**2. Build** - "On `<branch>`. Read `descriptionSnapshot`, `clarification`, `reproduction`, `handoff`.
1. **Plan.** Read the current code (ticket line numbers may be stale). Settle an ordered `planNote`
   naming real files and functions, and the `AGENTS.md` non-negotiable for each area touched:
   `extract.ts` = the `sourceIndex` lockstep rule, engines = the `ownsPlayback` rate rule, settings =
   the normalisation rule, anything logging = no note text. Search `docs/agent-history.md` for the
   function or ticket and read the matching entries. A new ambiguity: decide it as Triage would and
   return it in `clarificationAdd`; no defensible default -> `blocked`, `blockedReason: Unanticipated
   by pre-flight: <question>`.
2. **Reproduce** if `type` is `bug`, before editing: bundle the real module from your scratch dir
   (`npx esbuild <probe>.ts --bundle --platform=node --format=esm --outfile=<scratch>/probe.mjs && node
   <scratch>/probe.mjs`) and run it on the real input. Record command and observed output as
   `reproduction`; `reproConfirmed: true` only when you saw it fail. Cannot reproduce -> blocked.
3. **Implement** exactly the acceptance criteria, honouring Out of Scope. Tests first, and **confirm
   the core cases fail against the unfixed code** (guards for already-correct behaviour may pass both
   ways); if they do not, block. Drive from the real entry point; never weaken a test. An `srs.md`
   amendment needs its ADR (`docs/adr/NNNN-kebab-title.md`, next free number) - written now, once.
4. **Gates**, in order, each to a log: `npm run typecheck`, `npm run lint` (errors fail, warnings are
   tolerated), `npm run build`, `npm test` (read its per-suite table and `FAILING SUITES:` line).
5. **Commit** everything as one conventional commit referencing `<KEY>` (squash any `wip:`), then
   `gatedSha` = `git rev-parse HEAD` - only if all four passed on that exact tree. Return `planNote`,
   `reproduction`, `reproConfirmed`, `implementationSummary` (3-6 sentences: deviations and known
   misses), `prTitle`, `prBody` (summary, the pipeline's decisions, and a manual test plan with exact
   note contents to paste and the expected speech and highlighting for each), and `docsCandidate` (one
   line with evidence, or null: a Known-state defect this removes, or a requirement whose status
   moves). Do not push."

**4. Critic** - run `$OPS risk <KEY>` first, then spawn (twice, independently, for `L2+Double`):
"Depth `<depth>`, factors `<factors>`. Adversarially review PR `<pr>` for `<KEY>` in `<lane>`: the diff
`origin/main...<sha>`. Intent: `<ops> show <KEY> descriptionSnapshot,clarification`. Apply every check
in `.claude/commands/check-constraints.md`, then `.claude/commands/critique.md` Step 4 at that depth
(and its 'What to attack' section). **Do not run critique's Step 5, write no file at all, and ignore
any existing `.claude/last-critique.md`.** [If `gatesChanged`, add: **This diff changes the gates
that grade it**: check that every gate still runs, still fails when it should, and still runs in CI's
order; a weakened gate is a BLOCK. Your second line is exactly `GATES: justified - <reason>` or
`GATES: unjustified - <reason>`.] Reproduce rather than infer where you can (bundle and run the
module). BLOCK any finding where prose is silently lost, private text reaches a log or argv,
`sourceIndex` drifts, a network or download guard weakens, rate is applied twice, unknown settings keys
are dropped, a node builtin can evaluate on mobile, a test does not verify what it claims, or an
`AGENTS.md` non-negotiable breaks; otherwise CONCERNS or PASS. Return at most 40 lines: first line
exactly `VERDICT: pass`, `VERDICT: concerns` or `VERDICT: block`, then findings (file:line, failing
input or scenario), most severe first."

**5. Verify** - give it the "Reading a CI conclusion" snippet inline. "You did not write this code;
find out whether it meets the acceptance criteria. Read `descriptionSnapshot`, `clarification`,
`planNote`, `implementationSummary`, `reproduction`. Edit no tracked file. If `gh pr view <pr> --json
state,baseRefName` shows it merged, closed, or based on anything but `main`, return `fail` saying so.
1. **Head and base**: `git fetch origin`; `git status --porcelain` empty; `git rev-parse HEAD`,
   `gh pr view <pr> --json headRefOid -q .headRefOid` and `<sha>` all equal - else `fail`,
   `verifyFindings: head mismatch` with the three values. Record `verifiedBaseSha` =
   `git rev-parse origin/main` (`record` checks it is an `origin/main` commit the head contains).
2. `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, each to a log with its exit code;
   then the require() check exactly as `ci.yml`'s 'Assert main.js require() list' step runs it (copy
   its heredoc into your scratch dir): only `obsidian`, `@codemirror/view`, `@codemirror/state` and
   call-time `child_process`, and no `import()` of a node builtin (ADR 0033). There is no
   known-failures baseline: attribute every failing suite - `git checkout --detach origin/main`,
   `npm ci` if `package-lock.json` differs, `npm run build`, rerun that one suite (`node
   build-tests.mjs tests/<s>.test.ts && node tests/.build/<s>.test.mjs`), then back to `<branch>` (and
   `npm ci` again if needed). Fails on base too -> `blocked`, `blockedReason: main is red: <suite>`;
   only on the branch -> `fail`. Any `SKIP ... (NRL_SKIP_REAL_SPEECHD=1)` line is a fail.
3. Probe **every input the acceptance criteria and the PR's test plan name**, and the original
   `reproduction`, against the real bundled changed module from your scratch dir. Compare actual to
   expected. For `extract.ts`, also check `sourceIndex` lockstep on every probe: equal length to the
   text, and every non-space character maps to the same raw character.
4. Read CI once with the snippet, as `ciStatus`. Never wait.
`pass` only with the head assertion holding, no failure attributable to the branch, and every probe
matching. Return `result` and `verifyVerdict` (`pass`/`fail`), `verifiedSha` (= `<sha>`),
`verifiedBaseSha`, `ciStatus`, a short `verifyNotes`, and on fail `verifyFindings`: minimised failing
inputs, expected vs actual, root-cause hypothesis, path of any generator you built. Do not fix."

**5a. Fix** - never the agent that wrote the code, the critic, or the Verify that failed it. "Fix round
`<n>` on `<branch>`, PR `<pr>` (may be null). Read `descriptionSnapshot`, `planNote`, `clarification`,
`implementationSummary`, `verifyFindings`, `handoff`. Fix what `verifyFindings` records; dispute a
finding only with evidence from the same oracle that produced it.
1. Ship rebases onto a moved `origin/main` itself; rebase here only to resolve a conflict Ship or the
   merge reported, keeping `main`'s content plus this branch's change. If the PR was merged outside
   the run, carry the unmerged remainder onto
   `<branch>-followup` (`git checkout --no-track -b <branch>-followup origin/main`) and return `branch`
   set to it with `prNumber: null` (Ship opens the new PR).
2. Reproduce every failing input on the branch tip and add each, with close siblings, as a test that
   **fails first**.
3. Fix the root cause. If an earlier round patched this finding in another shape, a per-shape patch is
   not acceptable - fix the model. Re-run Verify's generator from `verifyFindings`.
4. Build's four gates. **Do not edit `docs/`, `srs.md`, `AGENTS.md` or `CONTEXT.md`** unless this round
   finishes a doc the ticket itself requires. Commit (no `wip:` left); return `gatedSha`,
   `verifyFindings: null`, an updated `implementationSummary`, `roundNote` (one line), and
   `docsCandidate` if it changed. Do not push and do not run a critic.
A finding that needs an owner decision -> blocked, naming the decision."

**7b. Docs, once per run** - after the last ticket, if any **merged** ticket has a `docsCandidate`:
`$OPS add DOCS-$STAMP`, record `{"noTracker": true}` via orchestrator, `$OPS start DOCS-$STAMP` with
`{"title": "record run $STAMP", "type": "docs", "description": "<every candidate, with its ticket and
PR>"}`, then spawn a Build-shaped agent: "On `<branch>`, apply these candidates: edit the Known state
section of `docs/agent-history.md` (never re-create it in `AGENTS.md`) and requirement statuses in
`srs.md`. Move a requirement to met only with named evidence; bare-Node tests alone never move one
(`AGENTS.md`). Run Build's four gates (`suiteRegistry` and `adrNumbers` read these files), one commit,
return `gatedSha`, `prTitle`, `prBody`." It then flows through Ship, Critic, Verify, Merge and Finish
like a ticket, with no Linear writes.

## Blocking

Each blocks only its ticket: `blockedReason`, a Linear comment (status stays), Step 0d, next ticket.
No defensible default; a failed prerequisite or missing hardware; a bug that cannot be reproduced; core
tests that pass against the unfixed code; a finding that needs an owner decision; a branch collision;
an ownership check that fails or errors; a Linear write that does not read back; a merge that fails
twice for a reason other than a conflict, a moved base or a moved head; `versions.json` in the diff;
the ticket held by another live run. The run-stoppers in the first fact row halt the run instead.

A blocked ticket keeps its branch, its `wip:` commit and any open PR. Never push a blocked ticket's
half-finished work to make cleanup pass: a lane on disk is a better artifact than a half-fix on origin.

## Step 8: Deploy, then remove the lane if nothing would be lost

**Deploy** merged `main` once, if any ticket merged this run:

```bash
cd "$RUN_WT" && git checkout -q "$RUN_BRANCH" && git fetch -q origin
[ -z "$(git status --porcelain)" ] && git reset -q --hard origin/main
if mkdir "$DEPLOY_LOCK" 2>/dev/null; then
  printf '%s\nrun %s\n' "$(pwd -P)" "$STAMP" > "$DEPLOY_LOCK/holder"
  LOG=$(mktemp); npm run deploy > "$LOG" 2>&1; RC=$?; echo "deploy exit=$RC"; tail -3 "$LOG"
  [ "$RC" = 0 ] && printf '%s\nbranch=main commit=%s at=%s run=%s\n' "$(pwd)" "$(git rev-parse --short HEAD)" \
    "$(date -u +%FT%TZ)" "$STAMP" > "$HOME/Documents/Notes/.obsidian/plugins/local-tts-reader/.deployed-from"
  rm -rf "$DEPLOY_LOCK"
else echo "deploy skipped: slot held by $(head -1 "$DEPLOY_LOCK/holder" 2>/dev/null)"; fi
```

`deploy.mjs` itself refuses unless the holder names this lane and HEAD is a clean `origin/main`. A
lock naming **this** lane after a crash is ours: release it. One naming another or a dead lane: skip
and report; never remove it.

**Remove the lane** - skipped under `--keep-worktree` and after a Fix-cap halt. Measure, in the lane:

```bash
git status --short; git stash list                  # both must be empty
git worktree list --porcelain                       # confirm $RUN_WT is the tree to remove
for B in <ticket branches>; do
  git rev-parse --verify "$B" >/dev/null 2>&1 || continue
  if git rev-parse --verify "origin/$B" >/dev/null 2>&1; then echo "$B unpushed=$(git rev-list --count "origin/$B..$B")"
  else echo "$B no-remote ancestor=$(git merge-base --is-ancestor "$B" origin/main && echo yes || echo no)"; fi
done
```

Clean = empty status and stash, and every remaining branch at `unpushed=0` or `ancestor=yes` (a
squash-merged branch with no tracking ref prints `ancestor=no`: indistinguishable from unpushed work,
so the lane is kept). Clean ->
`cd "$PRIMARY" && git worktree remove "$RUN_WT" && git branch -D "$RUN_BRANCH" && git worktree prune`.
Never `--force`: a refusal after a clean measurement means something changed - keep the lane. Not
clean -> keep it and report the path, dirty files, stashes and each branch's unpushed commits, with
`To discard: git -C <primary> worktree remove --force <lane> && git -C <primary> branch -D run/<stamp>`.
Never run that yourself.

## End-of-run report

One message:

- Table: ticket, PR, merge commit, critic verdict, Verify result, fix rounds, one line on what changed.
- Blocked tickets with reason, branch and PR. Pipeline decisions taken for the owner, with their Linear
  comments. Critic CONCERNS left as known leftovers.
- PRs whose one-shot CI read was red or pending -> `/test-issue <KEY>` (human-invoked; never run here).
- PRs merged **outside** the run, and any follow-up PR that created.
- The docs PR from Step 7b, or the candidates if it blocked.
- The lane: removed, or kept and why (a Fix-cap halt names the `--resume` stamp).
- **The vault now has `main` at `<sha>` - fully quit and relaunch Obsidian to load it**; an in-app
  reload has proven unreliable. Or: the deploy was skipped, and why. Nothing was verified in Obsidian by
  a human; each PR's manual test plan says what to check.
- Every `trackerWrites` entry with `ok: false`. A run whose writes failed must not read like a clean one.
- Cost signals: per ticket, fix rounds and `handoff` continuations; any phase that hit the budget twice
  and any file an agent kept paging through (a split candidate).
- This run's state file, and any other run's that was live alongside it.

## Error handling

| Scenario | Action |
|---|---|
| A command is refused or prompts | Stop and report it; the run was launched wrong. Never edit settings or self-approve. |
| A Linear operation does not resolve | Check the name against your tool list first (`save_comment`, not `create_comment`). Then it is a failed tracker call: block that ticket, record it. |
| Step 0c exits non-zero | `origin/main` (or this host) is broken: stop the run. Check `spd-say --version` and `spd-say -O` before blaming code; a `release` `ENOENT` on `main.js` means the build did not run. |
| Verify reports `main is red` | Block the ticket and stop the run: every later ticket would hit it. |
| Verify reports `head mismatch` | The push did not land, or something committed after it. A PR head the run did not make -> block; otherwise Fix re-pushes. Never merge. |
| `merge` reports the base moved | Ship rebases; the new head goes through Critic and Verify again. Not a Fix round, unless the rebase conflicts. |
| The lane's `HEAD` moved unexpectedly | Something else is in the lane. Stop and report; do not commit. |
| `$RUN_WT` or `$RUN_BRANCH` already exists | A previous run left it. Report and stop; never reuse or `-D` it. |
| An orphan `-run-*` lane, or a `deploy.lock` naming a dead lane | Report it; do not remove it. It may hold the only copy of a blocked repro. |
| An unpushed commit you did not create is on `main` in the primary | Leave it. The run never touches the primary's `main` (2026-09-29 dropped one this way). |
| A decision not covered here | Default it with a recorded reason if defensible; otherwise block the ticket. Never wait. |

## Reading a CI conclusion

`ci.yml` is the workflow named `CI` with one job named `gates`. **`gh run list` reports the workflow
name and never the job name**, and has no `jobs` field, so `select(.name == "gates")` matches nothing,
prints nothing and exits 0 - a loop built on it never breaks (NRL-86). A PR branch also runs CI twice
(`push` and `pull_request`), and the two do not conclude together, so every matching row is printed
and the verdict aggregates them. One-shot; needs `jq` (gh's `--jq` takes no `--arg`).

```bash
SHA="$(git rev-parse HEAD)"
gh run list --branch "$(git branch --show-current)" --limit 20 \
  --json headSha,workflowName,event,status,conclusion,databaseId \
| jq -r --arg sha "$SHA" '
    [ .[] | select(.headSha == $sha and .workflowName == "CI") ] as $runs
    | if ($runs | length) == 0
      then "CI: no run recorded yet for \($sha)"
      else ($runs | map("\(.event) \(.status) \(.conclusion // "-") \(.databaseId)") | join("  |  "))
           + (if ($runs | all(.status == "completed"))
              then "  -> all concluded" else "  -> still running; do NOT wait" end)
      end'
```

`headSha` stops an older push answering for this one; `workflowName` separates CI from `release.yml`.
The job's own conclusion is reachable only per run: `gh run view <id> --json jobs`. The one sanctioned
bounded wait in this repo is in `/test-issue`, which is human-invoked for exactly that reason.
