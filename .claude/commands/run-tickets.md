---
description: Run a set of Linear tickets end to end, fully autonomously, in a disposable worktree it creates and removes - pre-flight triage, then start, plan, implement, ship, automated verify, merge and finish per ticket in fresh subagents. Never waits on a human; anything that needs one blocks that ticket and is reported at the end.
---

Conventions: `.claude/linear.md`. Rules and gates: `AGENTS.md`.

Adapted from the ShroomSpy Jira pipeline. What differs here is not cosmetic, so read the fact
table before the first run.

## Read this before the first run

| Fact | Consequence |
|---|---|
| **The run is fully autonomous.** The owner tests features by using the app and files new tickets for what they find. | No phase waits for a reply. Verify is automated, merge is automatic. Anything that would have needed a human blocks **that ticket only**, and the run moves on to the next one. Everything blocked or decided on the owner's behalf is listed in the end-of-run report. |
| **CI runs the gates on `push` and `pull_request`** (`.github/workflows/ci.yml`), but there is still no hook: `.git/hooks` holds only samples. | Verify still runs the gates and the probes itself; the check is a backstop, not the source of truth. Verify **may** read the conclusion (`gh pr checks <n>` once, or `gh run list`) and report it, and **must not wait on it**. Never write a polling loop. Branch protection is out of scope, so a red check does not block a merge. |
| **A green suite is not a working feature** (`AGENTS.md` rule 11). The suites run in bare Node against fakes. | Automated Verify also runs the real bundled module against the ticket's acceptance inputs, and drives real Obsidian over CDP when it is reachable. Nothing a human did not observe is ever described as "verified in Obsidian". PRs carry `NOT VERIFIED IN OBSIDIAN`, and Linear comments say so plainly. |
| **Bugs must be reproduced before they are fixed** (`AGENTS.md` rule 12). | Implement begins by reproducing, not by editing. If the repro fails, the ticket blocks rather than proceeding on a guess. |
| **The run works in a disposable worktree it creates itself.** Step 0c adds `note-reader-local-run-<stamp>` beside the primary repo and removes it at the end. | Nothing the run does touches the primary checkout, so the owner can keep working in it. But the run's *records* must outlive the tree, so the state file and the archive live in the **primary** repo, not in the lane. Step 0 resolves `$PRIMARY` before anything else. |
| **One deploy slot.** `npm run deploy` writes to one fixed folder in `~/Documents/Notes`. | Only one lane at a time may call it. Take `$PRIMARY/.claude/deploy.lock` atomically with `mkdir`, deploy, write `.deployed-from` with the `runId` and commit, then release. **The path is resolved against `$PRIMARY` deliberately:** a lock inside the run's own fresh lane is free by construction, so it would guard nothing while the slot it protects is still a single shared folder. A lane that cannot take it skips the deploy and says so in its report rather than waiting: the vault carries merged `main` either way, and whoever deploys last wins. |
| **A deploy is not live until Obsidian restarts.** On 2026-09-28 two tickets were "passed" against a stale in-memory build after an in-app reload. | Finish deploys `main` so the owner's vault always has the latest merged build, and the end-of-run report tells them to **fully quit and relaunch** Obsidian. A deploy never counts as evidence that the code ran. |
| **Base branch is `main`.** It is the only branch; `origin/HEAD` resolves correctly here. | No special casing. Still assert it rather than assuming. |
| **Reproduced defects are listed** in `AGENTS.md` "Known state", with exact triggering inputs. | Phase 0 must not ask for a repro for one of those. It is already written down. |
| **Parallel runs are supported.** Several `/run-tickets` may be in flight on this repo at once, each in its own lane, each with its own state file. | Nothing serialises a run as a whole. The two things that really are shared are guarded individually: the single deploy slot by `$PRIMARY/.claude/deploy.lock`, and `main` by git itself, where a conflict blocks one ticket and nothing else. **Give parallel runs disjoint ticket sets.** Two runs holding the same ticket is not a data-safety problem, it is duplicated work and two PRs for one fix. |
| **Every run's state file is its own**, `$PRIMARY/.claude/pipeline-state.<stamp>.json`, sharing the lane's stamp. | This is what makes parallelism safe, and it is the fix for 2026-09-29, when two runs shared one hardcoded `pipeline-state.json`: the second reinitialised it, destroying the first run's six ticket entries **and** the archive it had just written to `.claude/scratch/`, then rewrote `main` and dropped an unpushed commit. A run now writes exactly one path that no other run can name. **Never write another run's state file**, and never "tidy" one away. |
| **The lock binds `/run-tickets` only.** | Interactive sessions never take it, so `/start-issue`, `/ship` and `/verify` in the primary repo or in a `note-reader-local-nrl-*` worktree still run alongside a live run. What they must not do is deploy: that is what `deploy.lock` is for. |
| **The state file lives in the primary, never in the lane.** | Step 8 removes the lane, so a state file inside it would be deleted by the run's own cleanup. Keeping it in the primary is what lets `--resume` work after a crash even though the checkout is gone: the branches live in the primary's git dir, and Step 0c recreates the lane. |

`gh` is installed and authenticated as `JoshShearer`. There is no permission classifier blocking
`gh pr merge` in this repo, and no required review, so merge automation works. Never self-approve a
PR to get around a review requirement if one is ever added; block the ticket instead.

## How to launch it, per runtime

"Fully autonomous" is a property of **how the run is launched**, not of this file. Four commands
the pipeline must run are permission-gated by default, and a gated command is a prompt, which is
the human wait the whole design exists to avoid. Launch it wrong and it stalls at the first Ship.

| Gated command | Where the pipeline runs it |
|---|---|
| `git push -u origin <branch>` | `ship.md:243`, every Ship phase |
| `git branch -D <branch>` | Phase 7 and `finish.md`, every Finish phase; also the run branch at Step 8 cleanup |
| `git reset --hard origin/main` | Step 0d, resyncing the lane between tickets |
| `rm -rf "$DEPLOY_LOCK"` | releasing the deploy slot, in Verify and in Finish |

`git worktree add` and `git worktree remove` are **not** gated (`opencode.json` allows `*` by
default and neither matches a listed rule), so lane creation and cleanup add no new prompt.

`git branch -d` is not gated, but it is not the path taken: this repo squash-merges, so `-d`
reports "not merged" for work that is fully in `main` (Phase 7 says so itself), and `-D` after a
content check is the normal case rather than the exception. Every ticket reaches it.

- **opencode.** `opencode.json` sets `git push *`, `git branch -D *` and `rm -rf *` to `ask`.
  Those rules fire in the TUI regardless of anything written here, so an interactive
  `/run-tickets` **will** stop and wait. Run it headless instead, which auto-approves everything
  not explicitly denied (`npm publish*` stays denied):

  ```bash
  opencode run --auto --command run-tickets "NRL-19,NRL-20,NRL-21"
  ```

  `--command` takes the command name and passes the message through as `$ARGUMENTS`. Verified
  on opencode 1.18.32, including that it resolves the `.opencode/command/` symlink.

- **Claude Code.** There is no project `.claude/settings.json`, and the global one allows only
  `Bash(npm install:*)`, so an ordinary session prompts on the same three commands. The owner's
  global settings carry `skipDangerousModePermissionPrompt: true`, i.e. bypass mode is the
  intended way to run this. `/run-tickets NRL-19,NRL-20,NRL-21` inside a bypass-mode session.

**Do not "fix" a stall by loosening `opencode.json`.** Those three rules are the guardrails for
every other session in this repo, and two of them (`git push`, `rm -rf`) guard exactly the
destruction the 2026-09-29 incident in the fact table caused. The launch flag is scoped to one
run; the config change is not. If you find yourself prompted mid-run, the run was launched
wrong: stop, report it, and relaunch with the flag rather than editing the config from inside.

## Tracker: Linear

Workspace `note-reader-local`, MCP server `linear-nrl`. Operations used: `get_issue`,
`list_issues`, `save_issue`, `save_comment`, `list_issue_statuses`.

**Resolve the real tool names from your own available-tool list.** The prefix differs between
Claude Code and opencode and must never be hardcoded. If no Linear tool is present, the run still
works: every phase does its git work and prints what it would have sent, and the state file
carries it. A missing tracker never blocks a commit.

**The operation name can be stale too, not just the prefix**, and that failure mode is worse here
than anywhere else. Linear folded its create/update pairs into `save_*`: posting a comment is
`save_comment` and `create_comment` does not exist. Because a missing tracker never blocks a
commit, an unresolvable operation looks exactly like an unauthenticated server, so the run
carries on and reports success with nothing posted - which is what happened to every comment this
pipeline tried to write before 2026-09-30. If a Linear operation does not resolve, check the name
against your tool list before concluding the server is down, and say in the end-of-run report
that the comments were not posted.

The team key is `NRL`, verified on 2026-09-28. If an issue lookup fails with an unknown
identifier, re-run the discovery block in `.claude/linear.md`: someone renamed the team.

## Why phases run in fresh subagents

Quality, not speed. The subagent that just spent its context writing a fix is the worst possible
judge of whether that fix is sound. Fresh context per phase means each phase reads only the state
file and the repo, the way a different person picking the work up would. With no human gate, this
separation is the main defence against a plausible-looking wrong fix, so do not merge phases to
save time.

This orchestrating conversation stays alive for the whole run and never does the work: read state
-> spawn one subagent for exactly one phase of one ticket -> receive a short summary -> write it to
the state file -> spawn the next. Its context grows from summaries, not transcripts.

Spawn with the `Task` tool. **The subagent type name differs by runtime:** use
`general-purpose` in Claude Code and `general` in opencode. Pick whichever your runtime exposes.

Every prompt must carry, as literal strings and not as rules for deriving them: **the lane's absolute
path** as the repo root the phase works in, the ticket id, and **the resolved `$STATE_FILE` path**.
Subagents do not inherit your shell, and a subagent that re-derives either one can get a different
answer. The costly direction is the repo root: a phase that resolves to `$PRIMARY` commits into the
owner's working tree instead of the lane.

## Input

Argument: `$ARGUMENTS`

- A comma-separated list of ids, e.g. `NRL-12,NRL-14,NRL-19`. Bare numbers mean `NRL-<n>`.
- `all` - auto-discover assigned, not-done issues via `list_issues`, priority order. Drop anything
  in a blocked or cancelled state.
- `--build` - run `npm run build` in every Ship phase. Default is to build only when the diff
  touches `src/engines/onnx/`, `esbuild.config.mjs`, `manifest.json`, or `package.json`.
- `--no-merge` - stop each ticket after automated Verify with its PR open, instead of merging.
  Later tickets then branch from a `main` that lacks earlier fixes, so use it for a single ticket
  or for unrelated tickets only.
- `--keep-worktree` - skip Step 8's cleanup unconditionally and print the lane's path. For
  debugging a run after the fact. The lane is then the next run's problem, not this one's.
- `--resume [<stamp>]` - re-validate a state file against Linear and git before continuing, and
  recreate the recorded lane if its directory is gone. With no stamp it picks the **most recently
  modified** `$PRIMARY/.claude/pipeline-state.*.json` that still holds an in-progress ticket, prints
  which one it chose and its `runId`, and stops rather than guessing if two are in-progress. Pass the
  stamp to name one exactly. Unlike every other flag this is not auto-invoked: with per-run state
  files there is no single file to detect, so a bare `/run-tickets <ids>` always starts a new run.

If no argument is given, ask which tickets to run. That is the only question this command asks
before its work starts.

## Step 0: Establish facts, every run

**Resolve the primary repo first.** Every path this run records is relative to it, and the lane the
run works in does not exist yet. Deriving `$PRIMARY` by stripping a suffix is what makes the run
idempotent about where it was launched from: the primary, an interactive `-nrl-*` worktree, or a
previous run's own `-run-*` lane.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
PRIMARY="$REPO_ROOT"
[[ "$(basename "$PRIMARY")" =~ -nrl-[0-9].*$ ]] && PRIMARY="${PRIMARY%-nrl-*}"
[[ "$(basename "$PRIMARY")" =~ -run-[0-9]+-[0-9]+$ ]] && PRIMARY="${PRIMARY%-run-*}"

# One stamp for the whole run: it names the lane, the run branch and the state file, so the
# three can always be matched up by eye and no two runs can collide on any of them.
STAMP=$(date -u +%Y%m%d-%H%M%S)
STATE_FILE="$PRIMARY/.claude/pipeline-state.${STAMP}.json"
DEPLOY_LOCK="$PRIMARY/.claude/deploy.lock"
ARCHIVE_DIR="$PRIMARY/.claude/scratch"

echo "primary=$PRIMARY  launched-from=$REPO_ROOT  stamp=$STAMP"
git -C "$PRIMARY" status --short
git -C "$PRIMARY" rev-parse --abbrev-ref HEAD
node --version
```

Assert `$PRIMARY` is a real git repo and is the **main** working tree, not a linked one:

```bash
git -C "$PRIMARY" rev-parse --git-dir   # must print ".git", not a worktrees/ path
```

If it prints a path under `.git/worktrees/`, the suffix strip did not find the primary. Stop and
report both paths rather than guessing; creating a lane from a linked worktree nests the
`${PRIMARY}-*` glob that `worktrees.md` depends on.

### Step 0a: Claim this run's own state file

There is no run-wide lock, and that is deliberate. Every run creates its own lane, so two runs
already share no checkout; giving each one its own state file removes the last thing they shared.
What is left genuinely single - the deploy slot - has its own narrower lock, and `main` is guarded
by git.

`$STATE_FILE` carries `$STAMP`, so no other run can name it. Assert that, cheaply, before anything
else writes:

```bash
RUN_ID=$(date -u +%FT%TZ)

if [ -e "$STATE_FILE" ]; then
  echo "STATE FILE ALREADY EXISTS, this run must not start: $STATE_FILE"
  echo "A second-resolution stamp collided, which means another run started in the same second."
  echo "Re-run; a fresh $STAMP resolves it. Do not delete or reuse the existing file."
  exit 1
fi

printf '{"runId":"%s","stamp":"%s","primary":"%s","tickets":[]}\n' \
  "$RUN_ID" "$STAMP" "$PRIMARY" > "$STATE_FILE"
echo "state file claimed: $STATE_FILE"

# Other runs that may be live right now. Never wait on them and never write them;
# reading one to compare ticket sets is allowed. Named in the end-of-run report.
ls -1 "$PRIMARY"/.claude/pipeline-state.*.json 2>/dev/null | grep -vF "$STATE_FILE" || true
```

If another run's state file is listed, **say so in the first message and name it**, then carry on.
The one hazard parallelism does leave is two runs holding the same ticket: not a data-safety
problem, but duplicated work and two PRs for one fix. If you can read the other file's `tickets`
array to check for overlap, read it - that is the single exception to not touching another run's
state file, and it is read-only. If the ticket sets overlap, **block the overlapping tickets in
your own run** with `blockedReason: "also held by run <their runId>"` and run the rest.

Refresh a `heartbeat` field at every phase transition, in the same write that appends to `history`,
so a human reading a state file can tell a live run from a dead one. Nothing blocks on it.

### Step 0b: Never destroy another run's record

Each of these was violated on 2026-09-29 and each cost real work:

- **Never write, move, archive or delete a state file you did not create.** Your own is the one
  carrying your `$STAMP`; every other `pipeline-state.*.json` belongs to another run, live or
  finished, and "the tickets look done" is not a reason to touch it - one such file held a
  `blocked` ticket with an open PR. Reading another run's file to check for ticket overlap
  (Step 0a) is the only permitted access, and it is read-only.
- **A pre-existing `pipeline-state.json` with no stamp** is from a run that predates per-run state
  files. Leave it alone. Do not migrate it, and do not adopt it as yours.
- **Never empty `$ARCHIVE_DIR`** (`$PRIMARY/.claude/scratch/`). It is the archive of record, it is
  gitignored, and it is where a superseded run's only copy lives.
- **Never rewrite a branch you did not create**, and never amend, rebase or reset `main`. A run on
  2026-09-29 rewrote `main` and silently dropped an unpushed commit that was not its own. Merge, or
  leave it alone. The run's own `run/<stamp>` branch is the one exception: Step 0d hard-resets it,
  and it exists solely to be reset and then deleted.
- **Never touch the primary checkout.** The run works only inside its own lane, so it never
  `checkout`s, `reset`s or commits in `$PRIMARY`. The only writes it makes there are to
  `$PRIMARY/.claude/` (its own state file, the deploy lock while held, the archive) and the
  `git worktree add` / `remove` pair, both of which leave the primary's `HEAD` and index alone.
- **Never remove a worktree this run did not create.** Cleanup touches exactly the path recorded in
  the state file's `worktree` field. A `note-reader-local-nrl-*` directory belongs to
  `worktrees.md`'s interactive pool and a stray sibling may belong to treehouse.

Assert before starting. These are the only conditions that stop the whole run, because nothing has
been touched yet and continuing could destroy someone's work:

- **`$STATE_FILE` was claimed** (Step 0a), i.e. it did not already exist.
- **`$PRIMARY` has no uncommitted changes under `src/`, `tests/` or `docs/`.** Check with
  `git -C "$PRIMARY" status --short -- src tests docs`. Those are the paths a ticket branch will
  touch, and a human mid-edit in them is a real hazard. Stop and report if any are dirty; do not
  stash or discard. A dirty `.claude/`, `README`, or an untracked `.deployed-from` is **not** a
  reason to stop: the lane is cut from `origin/main` and the run never commits in the primary, so
  the primary's working tree cannot reach a ticket branch. Say what is dirty and carry on.
- **`origin/main` is reachable and current.** `git -C "$PRIMARY" fetch origin` succeeds. The lane
  branches from `origin/main`, not from the primary's `HEAD`, so a primary that is behind is
  harmless and needs no fast-forward. Assert rather than assume that `origin/HEAD` resolves.
**What isolates what.** The lane gives the run a checkout nobody else is in. The stamped state
file gives it a record no other run can name. Between them a run shares nothing with a sibling run
except `main` and the deploy slot, and each of those has its own narrower guard: git, and
`deploy.lock`. There is deliberately no lock over the run as a whole - one would serialise eight
tickets behind another run's eight for no safety the two mechanisms above do not already give.

### Step 0c: Create the run's lane

After Step 0a, before Phase 0. The lane is created from `origin/main` on a throwaway branch, and the
branch exists because `main` itself is checked out in the primary and git will not check it out twice.
`$STAMP` is the one resolved in Step 0, so the lane, the run branch and the state file all match.

```bash
RUN_WT="${PRIMARY}-run-${STAMP}"
RUN_BRANCH="run/${STAMP}"

git -C "$PRIMARY" fetch origin
git -C "$PRIMARY" worktree add --no-track -b "$RUN_BRANCH" "$RUN_WT" origin/main
cd "$RUN_WT"
```

**`--no-track` is load-bearing.** Without it, `worktree add -b <branch> <dir> origin/main` sets the new
branch's upstream to `origin/main` (measured: `rev-parse --abbrev-ref @{u}` prints `origin/main`), so a
bare `git push` from the lane would target `main` directly. Nothing in the pipeline issues one - Ship
pushes the ticket branch with an explicit `-u origin <branch>` - but this branch is hard-reset every
ticket and exists only to be thrown away, and an accidental push from it goes straight at the base
branch. With `--no-track` it has no upstream at all (measured: `fatal: no upstream configured`).

**The name is deliberately outside `note-reader-local-nrl-*`.** That glob is the interactive pool
`worktrees.md` owns, and `finish.md` step 7 removes `note-reader-local-nrl-${ISSUE_NUM}` by name. A
lane called `-nrl-<n>` would be listed as an interactive worktree and could be removed out from under
a running ticket by its own Finish phase. `worktrees.md` lists a `-run-*` sibling as the run lane and
refuses to remove it.

Then make the lane usable, and **prove it before any ticket touches it**:

```bash
npm ci
npm test && npm run typecheck
```

`npm ci` rather than `npm install`: `package-lock.json` is committed and `ci` reproduces it exactly.
This is not fast - `onnxruntime-web` is large, and `ort/` does not exist until a build has run.

**A gate failing here stops the whole run.** It is `origin/main` that is broken, not any ticket, and
branching further tickets off it compounds the problem. That is the existing "main fails its gates"
error-handling row, just detected earlier than it used to be. Check `which espeak-ng spd-say` before
blaming the code: `tests/engine.test.ts` shells out to the real daemon.

Record `worktree`, `runBranch` and `primary` at the top level of the state file. Every phase prompt
from here on gets `$RUN_WT` as its repo root, never `$PRIMARY`.

**Under `--resume`,** do not create a new lane and do not mint a new `$STAMP`. Read `worktree`,
`runBranch` and `stamp` from the chosen state file and use them, so the run keeps writing the file
it is resuming. If the directory is gone (a crash, or a `--keep-worktree` lane the owner deleted), the
branches still exist in the primary's git dir, so recreate the checkout over the existing branch and
reinstall:

```bash
git -C "$PRIMARY" worktree add "$RUN_WT" "$RUN_BRANCH"
cd "$RUN_WT" && npm ci
```

`worktree add` without `-b`, because the branch already exists. Then check out the in-progress
ticket's own `branch` from the state file rather than starting it over, and continue from its
recorded `phase`. If `$RUN_BRANCH` no longer exists either, the run cannot be resumed: say so and
stop rather than inventing a new base, because the ticket branches were cut from it.

### Step 0d: Resyncing the lane between tickets

`run/<stamp>` plays the role `main` played before. It is not a branch anyone reviews and nothing is
ever pushed from it; it is the base each ticket branches off, and it is deleted at cleanup.

After each ticket's Finish has merged, bring the lane forward before the next ticket's Phase 1:

```bash
git -C "$RUN_WT" checkout "$RUN_BRANCH"
git -C "$RUN_WT" fetch origin
git -C "$RUN_WT" reset --hard origin/main
```

`reset --hard` is safe here and only here: the lane is clean at that point (Ship committed and pushed,
Merge squashed), and this branch is the run's own. It is permission-gated, which is why the launch
section lists it. If `status --short` is not empty at this point, something in the previous ticket did
not finish cleanly: block rather than resetting over it, because that reset would destroy work.

Then read, in this order: `AGENTS.md` (the non-negotiables and the Known-state defect list),
`.claude/linear.md`, and the commands this pipeline delegates to - `start-issue.md`, `ship.md`,
`finish.md`, `check-constraints.md`, `critique.md`. Do not reimplement their contents here; call
them. `verify.md` is the interactive, human-driven check and is **not** used by this command.

## Phase 0: Pre-flight triage, before any ticket's Phase 1

Without this, "needs a decision" is discovered after a branch exists and Linear already says In
Progress.

1. Fetch every ticket in scope with `get_issue`.
2. Spawn **one** fresh subagent for the whole batch. Read-only, no reason to isolate per ticket.
   Its prompt:

   > For each of these tickets, in `<run-worktree>`: fetch the full description with `get_issue`,
   > including any "Decisions" section, which records answers the owner already gave. Grep and
   > read the files each ticket actually names; do not judge by title. Return a table with ticket
   > id, judgment (simple / complex / needs-decomposition), the `srs.md` requirement ID it closes
   > if any, whether it is one of the `AGENTS.md` Known-state defects, and whether it would amend
   > `srs.md`. Flag inter-ticket dependencies and file overlap for the given run order.
   >
   > For every open question the Decisions section does not answer, give the question, **your
   > recommended answer, and one line of reasoning**. Prefer the answer that matches the ticket's
   > stated principles, `srs.md`, and how Obsidian itself behaves. Mark a question `unresolvable`
   > only if no defensible default exists: the ticket contradicts itself, it needs the owner's
   > product intent with nothing to infer it from, it cannot be finished inside this repo, or it
   > needs hardware this machine lacks (an Android phone for R-M03, a second GPU, a non-Linux
   > desktop). Make no changes of any kind.

3. Fill in the `tickets` array now, every in-scope ticket `pending` at phase `start`. Step 0c already
   created the file with its top-level fields, including `worktree` and `runBranch`; do not
   reinitialise it and lose them. For each question
   with a recommendation, write it into that ticket's `clarification` with `decidedBy: "pipeline"`,
   and post it to the Linear issue with `save_comment` as "Decided by /run-tickets (owner may
   override): <question> -> <answer>, because <reason>." For each `unresolvable` ticket, set
   `status: "blocked"` with the question as `blockedReason`. It is excluded from the run and holds
   nothing up.
4. Print the triage table and the decisions taken in **one** message, then continue immediately
   with Phase 1 for the first non-blocked ticket. Do not wait for a reply.

Special cases Phase 0 must handle:

- **A ticket with no requirement ID and no clear acceptance criteria** cannot be finished safely.
  Block it.
- **A ticket for a known defect** already has its repro in `AGENTS.md`. Copy it into
  `reproduction` in the state file.
- **A ticket that would amend `srs.md`** needs an ADR per `AGENTS.md`. Record that in
  `clarification` so Plan requires one; the ADR and the `srs.md` edit ship in the ticket's own PR.

## The 7 phases

| # | Phase | Delegates to | What the fresh subagent does |
|---|---|---|---|
| 1 | Start | `start-issue.md` | Branch off `origin/main` inside the lane, Linear to In Progress, snapshot the issue into state |
| 2 | Plan | this file | Write the plan using Phase 0's decisions; genuinely new ambiguity is decided or blocks |
| 3 | Implement | this file | Reproduce first for bugs, then fix, then run the gates itself |
| 4 | Ship | `ship.md` | Gates, `check-constraints`, `critique`, commit, push, PR against `main` |
| 5 | Verify | this file | Automated: gates on the PR head, bundled probes of every acceptance input, CDP smoke if reachable |
| 6 | Merge | this file | Squash-merge once Verify recorded `pass` (skipped with `--no-merge`) |
| 7 | Finish | `finish.md` | Linear to Done, lane resynced and deployed, docs corrected if a defect is gone. **Not** the lane's removal, which is Step 8 |

Then Step 8 removes the lane, once, for the whole run.

**Sequencing is not optional.** Tickets run one at a time, fully through phase 7, before the next
one's phase 1. Branches come off `origin/main`, and `origin/main` only carries ticket N's fix once
ticket N's Merge has landed it. A blocked ticket stops where it is; Step 0d resyncs the lane and the
next ticket starts from the new `origin/main`.

## State file: `$STATE_FILE`

Machine-local, gitignored, never committed. It is always
`$PRIMARY/.claude/pipeline-state.<stamp>.json` - **one file per run, in the primary repo**, resolved
by Step 0 from the same `$STAMP` that names the lane and the run branch. Every phase must be handed
that resolved absolute path, and a phase that re-derives it can land on another run's file.

It lives in the primary and not in the lane on purpose: the lane is removed at Step 8, and the state
file is the run's record. A state file inside the lane would be deleted by the run's own cleanup,
taking the blocked-ticket reasons and the decision log with it. The old
`.claude/pipeline-state-local.json` split, keyed on the directory name, is **gone**: the lane already
provides the isolation it existed for. `.gitignore` still lists the `-local` name, harmlessly; nothing
writes it.

```json
{
  "runId": "2026-09-28T14:00:00Z",
  "primary": "/home/joshshearer/Documents/Dev/note-reader-local",
  "worktree": "/home/joshshearer/Documents/Dev/note-reader-local-run-20260928-140000",
  "runBranch": "run/20260928-140000",
  "worktreeRemoved": false,
  "baseBranch": "main",
  "buildGate": false,
  "merge": true,
  "keepWorktree": false,
  "tickets": [
    {
      "id": "NRL-19",
      "title": "Wikilinks are spoken as bracket characters",
      "requirement": "R-M08",
      "type": "bug",
      "knownDefect": true,
      "reproduction": "extractChunks(\"See [[Some Note]] today please.\", DEFAULTS) returns [\"See [Some Note ] today please.\"]",
      "descriptionSnapshot": "<full issue body, captured once in phase 1>",
      "branch": "fix/nrl-19-wikilink-brackets",
      "phase": "implement",
      "status": "in_progress",
      "clarification": { "question": null, "answer": null, "decidedBy": null },
      "planNote": null,
      "reproConfirmed": false,
      "implementationSummary": null,
      "prNumber": null, "prUrl": null, "commitSha": null,
      "verifyVerdict": null, "verifyNotes": null,
      "blockedReason": null,
      "history": [{ "phase": "start", "at": "2026-09-28T14:01:00Z", "result": "branch created" }]
    }
  ]
}
```

`status`: `pending` | `in_progress` | `blocked` | `done`.
`phase`: `start` | `plan` | `implement` | `ship` | `verify` | `merge` | `finish`.
`verifyVerdict`: `null` | `pass` | `fail`. It records the **automated** Verify only.
`clarification.decidedBy`: `null` | `"owner"` (from the ticket's Decisions section) | `"pipeline"`.
`worktree`, `runBranch`, `primary`: written by Step 0c, read by Step 8 and by `--resume`. `worktree`
is the **only** path cleanup is allowed to remove.

`.gitignore` covers `.claude/pipeline-state*.json`, `.claude/deploy.lock/` and
`.claude/scratch/`. The lane itself needs no
ignore rule: it is a sibling directory, outside the repo's own working tree. Timestamps come from
`date -u +%FT%TZ`, never from a guess.

## Phase subagent prompts

In every prompt below, substitute the literal absolute paths Step 0 resolved:

| Placeholder | Value |
|---|---|
| `<run-worktree>` | `$RUN_WT`, the lane. **This is the repo root every phase works in.** |
| `<state-file>` | `$STATE_FILE`, i.e. `$PRIMARY/.claude/pipeline-state.<stamp>.json` |
| `<run-branch>` | `$RUN_BRANCH`, the lane's throwaway base branch |
| `<deploy-lock>` | `$DEPLOY_LOCK`, i.e. `$PRIMARY/.claude/deploy.lock` |

Substitute the paths, never the rule for deriving them. A subagent does not inherit your shell and a
re-derived path can differ: a phase handed `$PRIMARY` instead of `$RUN_WT` would commit into the
owner's working tree, which is the whole thing the lane exists to prevent.

**1. Start** - "Read `.claude/commands/start-issue.md` and follow it for `<ID>` in `<run-worktree>`,
non-interactively; the ticket is already chosen. The state file is `<state-file>`.

You are in a disposable run lane, not the primary repo. `main` is checked out elsewhere and you must
not try to check it out here; `<run-branch>` is the base and it already sits at `origin/main`.
Confirm that (`git fetch origin && git rev-parse HEAD origin/main` agree) and branch from it.
`start-issue.md`'s worktree step (step 5, which offers to create a worktree) does not apply: you are
already in one. Do not create another, and do not deploy.

Fetch the issue and write `title`, `requirement`, `type`, `descriptionSnapshot` and `branch` into
this ticket's state entry. Set the Linear status to In Progress with `save_issue`, passing `id` and
`state: \"In Progress\"`: the parameter is `state`, never `status`, and unknown fields are rejected,
so no id lookup is needed. Read the status back afterwards rather than trusting the write. Set
`phase: \"plan\"`, `status: \"in_progress\"`, append history. If a branch collision or anything else
needs a decision `start-issue.md` cannot make, set `status: \"blocked\"` with `blockedReason` and
stop. Do not guess."

**2. Plan** - "You are in `<run-worktree>`. Read `<ID>`'s `descriptionSnapshot`, `clarification` and
`reproduction` from `<state-file>`. Line numbers in the ticket may be stale if earlier tickets in this
run touched the same files: read the current code in this lane, which is at `origin/main` plus this
ticket's branch. Write a concise ordered `planNote`
naming real functions, incorporating every recorded decision. If a genuinely new ambiguity appears
that Phase 0 missed, decide it the way Phase 0 would (recommendation plus one line of reasoning),
record it in `clarification` with `decidedBy: \"pipeline\"`, and post it to Linear as a
'Decided by /run-tickets' comment. Only if no defensible default exists, set
`status: \"blocked\"`, `blockedReason: \"Unanticipated by pre-flight: <question>\"`, and stop. If
this ticket amends `srs.md`, the plan must include an ADR under `docs/adr/` in the existing
`NNNN-kebab-title.md` format. Set `phase: \"implement\"`."

**3. Implement** - "You are on `<branch>` in `<run-worktree>`. Read `<ID>`'s `descriptionSnapshot`,
`planNote` and `reproduction` from `<state-file>`. Do not deploy, do not touch
`~/Documents/Notes`, and do not touch any directory outside this lane.

**If `type` is `bug`, reproduce it before changing anything.** `AGENTS.md` rule 12 requires this,
and most defects in this codebase were invisible to the test suite and obvious the moment the real
function ran against real input. Bundle the module and run it from the session scratchpad, never
the repo, for example
`npx esbuild <probe>.ts --bundle --platform=node --format=esm --outfile=<scratch>/probe.mjs && node <scratch>/probe.mjs`.
Record the actual observed output. Set `reproConfirmed: true` only when you have seen the failure
yourself. If you cannot reproduce it, set `status: \"blocked\"` with what you tried and stop; do
not fix a bug you have not seen.

Then implement exactly what the acceptance criteria describe, honouring any Out of Scope section.
Write the regression tests first and **confirm they fail against the unfixed code** before claiming
they verify anything. Guard tests that pin already-correct behaviour are expected to pass both
before and after; the core cases must fail first, or set `status: \"blocked\"` and stop. Never
weaken an existing test. Consult the `AGENTS.md` non-negotiable that matches the area you are
touching: `extract.ts` means the `sourceIndex` lockstep rule, engines mean the `ownsPlayback` rate
rule, settings mean the normalisation rule, anything logging means no note text ever.

Run the gates yourself before finishing: `npm test`, `npm run typecheck`, and `npm run build` if
you touched `src/engines/onnx/`, `esbuild.config.mjs`, `manifest.json` or `package.json`. Every
registered suite runs and is reported; read the runner's output as `AGENTS.md`'s quality-gates
block describes it. Write a 3 to 6 sentence `implementationSummary` that lists every deviation
from the plan and every known miss, set `phase: \"ship\"`. Do not commit, push, or open a PR."

**4. Ship** - "Read `.claude/commands/ship.md` and follow it for the current branch in
`<run-worktree>`, skipping any deploy step. PR base is `main`. Use `implementationSummary` for the PR
body's approach section. `<--build if the run passed it, otherwise: build only if the diff touches
the bundle>`.

There is no pre-push hook, so the push is instant. `.github/workflows/ci.yml` runs on `push` and
on `pull_request`, so the PR will pick up a check. You **may** read its conclusion once for the
report; you **must not** wait on it, and never write a polling loop. Branch protection is out of
scope, so a red check does not block a merge. Record whatever you saw, including "not concluded", in
`verifyNotes` so the end-of-run report can point the owner at `/test-issue <ID>` for any PR whose
check went red. Do not run `/test-issue` yourself: it triages by reproducing a failure locally and by
waiting on a conclusion, and neither belongs in an unattended run.

Run `/check-constraints`. A BLOCK is not overridable: set `status: \"blocked\"` with the findings
and stop without committing. Same for a `/critique` BLOCK verdict. With no human reviewing the
diff, treat any critique finding where **prose is silently lost, private text is spoken, or
`sourceIndex` drifts** as must-fix: fix it with a test that fails first, re-run the gates, then
commit. Lower findings are listed in the PR body as known leftovers.

The PR body must carry a literal `NOT VERIFIED IN OBSIDIAN` line, and a manual test plan with exact
note contents to paste and the expected speech for each, so the owner can check it later while
using the app. Record `prNumber`, `prUrl`, `commitSha`, set `phase: \"verify\"`."

**5. Verify** - automated, in a fresh subagent. It must not be the subagent that wrote the fix.

"You are verifying PR `<prNumber>` for `<ID>` in `<run-worktree>`, on branch `<branch>`. Read the
ticket's `descriptionSnapshot`, `planNote`, `implementationSummary` and `reproduction` from
`<state-file>`. You did not
write this code; your job is to find out whether it does what the acceptance criteria say. Do not
edit tracked files.

1. Confirm the working tree is clean and `HEAD` equals `commitSha`. Run `npm test`,
   `npm run typecheck` and `npm run build`. Check that `main.js`'s `require()` list is only
   `obsidian`, `@codemirror/view` and `@codemirror/state`.
2. End-to-end probes: bundle the real changed module from the scratchpad and run **every input the
   acceptance criteria and the PR's manual test plan name**, including the original reproduction.
   Compare the actual output to the expected output. For `extract.ts` changes, also check
   `sourceIndex` lockstep on every probe: equal length to the text, and every non-space character
   maps to the same raw character.
3. If Obsidian is reachable on `--remote-debugging-port=9222`
   (`curl -s --max-time 2 http://127.0.0.1:9222/json/version`), take `<deploy-lock>` atomically with
   `mkdir`, then deploy with `npm run deploy`, write
   `.deployed-from` with this lane's path and commit, run `npm run test:obsidian`, record the result,
   and release the lock. **If the deploy lock cannot be taken, skip the deploy and record
   `CDP smoke: not run, deploy lock held by <holder>`** rather than waiting or deploying anyway: the
   slot is one shared folder and a smoke test against another lane's build proves nothing. The
   running plugin only picks up a deploy after
   Obsidian restarts, so a smoke test against an un-restarted instance proves nothing; say which
   build was loaded if you can tell. If the port is not reachable, record `CDP smoke: not run`. Do
   not start, stop or restart Obsidian.

Set `verifyVerdict: \"pass\"` only if the gates pass and every probe matches. Otherwise set
`verifyVerdict: \"fail\"`, `status: \"blocked\"`, and put the failing inputs with actual versus
expected output in `blockedReason`. Do not attempt a fix. Write a short `verifyNotes`, append
history, and on pass set `phase: \"merge\"`."

On pass, the orchestrator posts a Linear comment with `save_comment` stating, as separate
points: the suites and gates passed; the automated probes run and their results; whether the CDP
smoke ran; and the literal line **"Not verified in Obsidian by a human."**

On fail, the ticket is blocked with its PR left open. Continue with the next ticket.

**6. Merge** - done by the orchestrator. Skipped entirely under `--no-merge`, which leaves the
ticket `done` at phase `verify` with its PR open.

Only when `verifyVerdict` is `pass`:

```bash
gh pr view <prNumber> --json state,mergeable
gh pr merge <prNumber> --squash --delete-branch
gh pr view <prNumber> --json state,mergedAt,mergeCommit
```

If the PR is already merged, record that and move on. If it is not mergeable (a conflict with
`main`), block the ticket with the reason; do not resolve conflicts inside this phase. Never merge
a ticket whose Verify did not record a pass, and never self-approve. Record the merge commit and
set `phase: \"finish\"`.

**7. Finish** - "Read `.claude/commands/finish.md` and follow it for the merged branch `<branch>`
in `<run-worktree>`. Two of its steps do not apply in a run lane and must be skipped; everything else
does.

**Skip `finish.md` step 7 entirely** (worktree removal). It removes
`note-reader-local-nrl-${ISSUE_NUM}`, which does not exist in a run lane, and the lane you are in is
removed once for the whole run by Step 8, not per ticket. A phase that removed its own lane would
delete the checkout the next ticket needs.

**Do not check out `main`.** It is checked out in the primary repo and git will refuse. Where
`finish.md` says to finish on an up-to-date `main`, finish on `<run-branch>` reset to `origin/main`:

```bash
git checkout <run-branch> && git fetch origin && git reset --hard origin/main
```

Verify the merge by content, not just by branch state: this repo squashes, so `git branch -d` can
claim 'not merged' for work that is fully in `main`. Grep the resynced lane for a distinctive symbol
the PR added before deleting, and use `-D` only once content is confirmed. Set the Linear status to
Done with `save_issue`, passing `id` and `state: \"Done\"`: the parameter is `state`, never
`status`, and unknown fields are rejected, so no id lookup is needed. Read the status back. Then
check whether this ticket removed one of the defects listed in the `AGENTS.md` Known state section,
or moved a requirement's status in `srs.md`. If so, make the doc edit on a `docs/<id>-finish`
branch, open a PR, and squash-merge it yourself; never commit to `main` directly. Only move a
requirement to fully met with evidence, and name that evidence. Finally, take `<deploy-lock>`
atomically with `mkdir` and run `npm run deploy` from the resynced lane so the owner's vault carries
the latest merged build, then write `.deployed-from` with this lane's path and commit, and release
the lock. If the lock cannot be taken, skip the deploy and name the holder; do not wait. Leave the
lane on `<run-branch>`, clean and at `origin/main`. Set `phase: \"finish\"`, `status: \"done\"`."

## Step 8: Clean up the lane, once, at the end of the run

Runs after the last ticket reaches `done` or `blocked`. Skipped
entirely under `--keep-worktree`, which prints the path and says cleanup was skipped on purpose.

**Cleanup is conditional, and the condition is that nothing would be lost.** A blocked ticket can
leave work that never reached origin - Implement blocks after reproducing a bug and before any commit,
and that reproduction is exactly the thing `AGENTS.md` rule 12 says is expensive to obtain. Removing
the lane would destroy it with no record anywhere, which is the same class of loss as the 2026-09-29
incident in the fact table.

Measure all four, in the lane, and print what you measured:

```bash
cd "$RUN_WT"
git status --short                       # must be empty
git stash list                           # must be empty
git worktree list --porcelain            # confirm $RUN_WT is the tree you are about to remove

# For every branch this run created (the state file's ticket `branch` fields):
for B in <ticket branches>; do
  git rev-parse --verify "$B" >/dev/null 2>&1 || continue
  if git rev-parse --verify "origin/$B" >/dev/null 2>&1; then
    echo "$B unpushed=$(git rev-list --count "origin/$B..$B")"
  else
    echo "$B unpushed=NO-REMOTE merged=$(git merge-base --is-ancestor "$B" origin/main && echo yes || echo no)"
  fi
done
```

A branch with no remote is fine **only** if it is an ancestor of `origin/main`, which is the normal
end state: Merge squash-merged it and `--delete-branch` removed the remote copy. A branch with no
remote that is not an ancestor of `origin/main` is unpushed work. Do not use `git branch -d`'s opinion
here for the same reason Phase 7 does not: a squash merge makes it report "not merged" for work that is
fully in `main`.

**All four clean** - `status` empty, `stash list` empty, every ticket branch either zero commits ahead
of its remote or an ancestor of `origin/main`:

```bash
cd "$PRIMARY"
git worktree remove "$RUN_WT"
git branch -D "$RUN_BRANCH"
git worktree prune
```

`worktree remove` without `--force`, deliberately: it refuses on a dirty tree, so it is a second
independent check on the condition you just measured rather than a way past it. If it refuses after
you measured clean, believe the refusal and keep the lane - something changed under you. `--force` is
never correct in this step.

Deleting `node_modules`, `main.js`, `kokoro-worker.js` and `ort/` with the lane is expected: all four
are gitignored build output, and the next run rebuilds them. Set `worktreeRemoved: true`.

**Anything not clean** - keep the lane, and report, per item: the lane's absolute path, the dirty
files verbatim, the stash entries, and every branch with its unpushed commit count and subject lines.
Say cleanup was skipped and why, in those terms. Then say what the owner can do with it:

```
Lane kept: /home/joshshearer/Documents/Dev/note-reader-local-run-20260928-140000
  branch fix/nrl-88-... has 2 unpushed commits:
    abc1234 fix(extract): ...
    def5678 test(extract): ...
Reason: NRL-88 blocked at implement; the work is not on origin.
To inspect:  cd <lane> && git log --oneline origin/main..
To discard:  git -C <primary> worktree remove --force <lane> && git -C <primary> branch -D run/<stamp>
```

Never run that discard command yourself. Offering it is the point; deciding is the owner's.

A kept lane is not a failure of the run and does not change any ticket's status. It is one line in the
end-of-run report.

## When something needs a human

Nothing waits. Each of these blocks the ticket it happens in, records why in `blockedReason`, and
the run continues with the next ticket:

- Phase 0 or Plan finds a question with no defensible default
- A bug that cannot be reproduced
- A `check-constraints` BLOCK or a `critique` BLOCK
- A regression test whose core cases pass against the unfixed code, meaning it proves nothing
- Automated Verify fails
- A merge conflict with `main`
- A ticket needing hardware this machine lacks, most likely an Android device for R-M03
- A branch or issue collision that `start-issue.md` flags

A blocked ticket keeps its branch and any open PR, so the work is not lost. Its Linear status stays
In Progress, and the orchestrator posts a comment with the `blockedReason`.

**A ticket blocked before Ship pushed anything is the case Step 8 exists for.** Its branch is local to
the lane, so "the work is not lost" is true only because cleanup refuses to remove a lane holding
unpushed commits or a dirty tree. Do not resolve that by pushing a blocked ticket's work to make
cleanup unconditional: a half-finished branch on origin is a worse artifact than a lane on disk, and
the end-of-run report names the lane either way.

A decision the pipeline took on the owner's behalf is **not** a block. It is recorded in state,
posted to Linear, and listed in the end-of-run report so it can be overridden later.

## End-of-run report

When every ticket is `done` or `blocked` and Step 8 has run, print one message:

- A table: ticket, PR, merge commit, automated verify result, one line on what changed.
- **Any PR whose CI check went red or never concluded**, with the check name and its run URL, and the
  line: run `/test-issue <ID>` to triage it. This run deliberately did not: it reads a conclusion at
  most once and never waits on one. `/test-issue` measures whether the failure is this branch's, by
  reproducing it locally and on `origin/main`, and it is a human-invoked command.
- **The lane**: its path, and whether Step 8 removed it. If it was kept, the reason and the unpushed
  or dirty items, verbatim. If `--keep-worktree` was passed, say that is why.
- Every decision taken with `decidedBy: "pipeline"`, with a link to its Linear comment.
- Every blocked ticket with its reason, branch and PR.
- New follow-up tickets filed during the run, and known leftovers from each PR.
- Requirement status changes, with the evidence for each.
- The reminder: **the vault now has `main` at `<sha>`. Fully quit and relaunch Obsidian to load
  it;** an in-app reload has proven unreliable. Nothing in this run was verified in Obsidian by a
  human, and each PR's manual test plan says what to look at. If this run could not take
  `$PRIMARY/.claude/deploy.lock`, say that it skipped the deploy and name the lane that holds it.
- This run's state file path, left in place as the run's record, and **any other run's state file
  that was live alongside it**, named so overlapping work is visible.
- **Whether every Linear write actually landed.** Name any comment or status change that was
  printed instead of posted, and why (no tracker, or an operation that would not resolve). A run
  whose comments all silently failed must not close with a report that looks identical to one
  where they all succeeded - that is precisely how the `create_comment` breakage survived.

## Example usage

```
/run-tickets NRL-19,NRL-20,NRL-21
```
Three reproduced markdown defects in `extract.ts`. Phase 0 skips the repro questions because all
three are in the Known state list; each ticket then runs 1 to 7 without stopping.

```
/run-tickets NRL-30 --build
```
A ticket touching the Kokoro worker, so the bundle gate runs every Ship phase.

```
/run-tickets all
```
Everything assigned and open, merged as each one passes automated Verify.

```
/run-tickets NRL-38 --no-merge
```
One ticket, left as an open PR for the owner to read before merging.

```
/run-tickets --resume
```
Continues the most recently modified in-progress run, recreating the lane from its `worktree` and
`runBranch` fields. Add a stamp (`--resume 20260930-143755`) to name one exactly, which is required
when two are in progress.

```
/run-tickets NRL-88 --keep-worktree
```
One ticket, and the lane is left on disk afterwards to be inspected. Remember to remove it, or the
next run leaves a second sibling beside it.

## Error handling

| Scenario | Action |
|---|---|
| No Linear tool in the available list | Continue git-only. Print the status transitions and comments that would have been sent, and record them in the state file. Never block a commit on a missing tracker. **Say it in the end-of-run report**; a degraded run must not read as a clean one. |
| A named Linear operation is not in the tool list, but others are | The server is fine and the operation was renamed. Find the equivalent (`save_comment`, not `create_comment`) and use it. Do not fall through to the git-only path: that row is for an absent tracker, and taking it here hides a fixable typo behind a success report. |
| A Linear status write appears to succeed but reads back wrong | The write is `save_issue` with `id` and `state`, and `state` takes a state name; there is no `status` parameter and unknown fields are rejected, so a call naming `status` fails input validation rather than writing. Confirm the name exists on this team with `list_issue_statuses`, retry once, and if it still reads back wrong, block the ticket and continue. |
| A permission prompt appears mid-run | The run was launched wrong; see "How to launch it, per runtime". Stop and report which command was gated. Never edit `opencode.json` or the Claude Code settings from inside a run to get past it. |
| `npm test` reports a failure | Nothing is hidden: the runner runs every registered suite and names each failure. Read its per-suite table, its aggregate counts and its `FAILING SUITES:` line, as `AGENTS.md`'s quality-gates block describes, rather than re-running suites individually. |
| `tests/engine.test.ts` fails | It shells out to real `espeak-ng` and `spd-say`. Check the binaries before assuming the code broke. |
| `origin/main` fails its gates in the fresh lane at Step 0c | Something already merged is broken. Stop the run and report it; branching tickets off a broken base compounds it. Check `which espeak-ng spd-say` first: `tests/engine.test.ts` needs the real daemon. |
| `gh` auth expires mid-run | Stop the run and report which step failed. Every later ticket would fail the same way. |
| A phase needs a decision not covered above | Decide it with a recorded default if one is defensible, otherwise block the ticket. Never wait. |
| Another run's `pipeline-state.*.json` is present and in progress | Expected: runs are parallel. Name it in the first message and carry on. Read it once to compare ticket sets, and block only the tickets both runs hold. Never write it. |
| `$STATE_FILE` already exists at Step 0a | Two runs minted the same second-resolution `$STAMP`. Stop and re-run; a fresh stamp resolves it. Never delete or adopt the existing file - it is the other run's record, and its lane and run branch carry the same colliding stamp. |
| `$STATE_FILE` exists with a `runId` that is not yours | Resume it, or archive it to `$PRIMARY/.claude/scratch/` and verify the copy parses first. Never reinitialise it, however finished its tickets look. Check its `worktree` field before creating a lane: that run's lane may still be on disk. |
| `git worktree add` fails because `$RUN_WT` exists | A previous run left a lane, most likely under `--keep-worktree` or a kept-because-unpushed cleanup. Do not remove it and do not reuse it. Report the path, say which state file references it, and stop; the collision is one second of clock skew away from being a name you cannot attribute. |
| `git worktree add` fails because `$RUN_BRANCH` exists | Same cause, same response. Never `-D` a run branch you did not create in this run. |
| The lane's `HEAD` moved under you mid-run | Something else is working in the lane. Stop, report the branch you expected and the one you found, and do not commit: your files may already be staged into someone else's commit. |
| A `-run-*` lane on disk belongs to no live run | Report it as an orphan with its path, and the `runId` of the state file whose stamp matches. Do not remove or reuse it: a dead run may hold the only copy of a blocked ticket's reproduction, and `--resume <stamp>` can still pick it up. |
| An unpushed commit you did not create is on `main` | Do not amend, rebase or reset to tidy it. Push it or leave it. One was silently dropped this way on 2026-09-29. `main` is never checked out in the lane, so this can only be seen in `$PRIMARY`, which the run does not touch. |
| A PR's CI check goes red | Record it and carry on; it does not block the merge and there is no branch protection. Name it in the end-of-run report with `/test-issue <ID>` as the follow-up. **Do not run `/test-issue` from inside the run**: it waits on a conclusion and reproduces failures locally, neither of which belongs in an unattended pipeline. |

## Configuration

| Setting | Value |
|---|---|
| **Primary repo** | `git rev-parse --show-toplevel`, then strip a `-nrl-*` or `-run-*` suffix. Assert `git -C "$PRIMARY" rev-parse --git-dir` prints `.git` |
| **Run lane** | `${PRIMARY}-run-<YYYYMMDD-HHMMSS>` on branch `run/<stamp>`, created at Step 0c from `origin/main`, removed at Step 8. Deliberately outside the `note-reader-local-nrl-*` pool `worktrees.md` owns |
| **State, deploy lock, archive** | `$PRIMARY/.claude/{pipeline-state.<stamp>.json,deploy.lock,scratch/}`. All in the primary so they outlive the lane. No run-wide lock: runs are parallel |
| **Base branch** | `main`. PRs target it; the lane never checks it out, since the primary has it |
| **Remote** | `git@github.com:JoshShearer/Note-Reader-Local.git` |
| **Tracker** | Linear workspace `note-reader-local`, MCP server `linear-nrl`, team key `NRL` |
| **Gates** | `npm test` · `npm run typecheck` · `npm run build` when the bundle moved. Run once in the fresh lane at Step 0c before any ticket |
| **CI** | `.github/workflows/ci.yml`, job `gates`, on `push` (`branches: ["**"]`) and `pull_request`, so it runs twice on a PR branch. May be read once, never waited on. No branch protection, so a red check does not block a merge. `/test-issue` is the human-invoked triage |
| **Push gate** | None. No husky, no active git hooks. |
| **Permission gate** | Four commands the pipeline needs are `ask` in `opencode.json`. Launch headless (`opencode run --auto --command run-tickets "<ids>"`) or in a Claude Code bypass session. See "How to launch it, per runtime". |
| **Human gate** | None. The owner tests by using the app and files new tickets for what they find. |
