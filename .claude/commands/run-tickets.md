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
| **The run works in a disposable worktree it creates itself.** Step 0c adds `note-reader-local-run-<stamp>` beside the primary repo and removes it at the end. | Nothing the run does touches the primary checkout, so the owner can keep working in it. But the run's *records* must outlive the tree, so the lock, the state file and the archive all live in the **primary** repo, not in the lane. Step 0 resolves `$PRIMARY` before anything else. |
| **One deploy slot.** `npm run deploy` writes to one fixed folder in `~/Documents/Notes`. | Only one lane at a time may call it. Take `$PRIMARY/.claude/deploy.lock` the same atomic way as the run lock, deploy, write `.deployed-from` with the `runId` and commit, then release. **The path is resolved against `$PRIMARY` deliberately:** a lock inside the run's own fresh lane is free by construction, so it would guard nothing while the slot it protects is still a single shared folder. A lane that cannot take it skips the deploy and says so in its report rather than waiting: the vault carries merged `main` either way, and whoever deploys last wins. |
| **A deploy is not live until Obsidian restarts.** On 2026-09-28 two tickets were "passed" against a stale in-memory build after an in-app reload. | Finish deploys `main` so the owner's vault always has the latest merged build, and the end-of-run report tells them to **fully quit and relaunch** Obsidian. A deploy never counts as evidence that the code ran. |
| **Base branch is `main`.** It is the only branch; `origin/HEAD` resolves correctly here. | No special casing. Still assert it rather than assuming. |
| **Reproduced defects are listed** in `AGENTS.md` "Known state", with exact triggering inputs. | Phase 0 must not ask for a repro for one of those. It is already written down. |
| **One run per repo, enforced by a lock in the primary.** On 2026-09-29 two runs both worked in the primary repo: the second reinitialised `.claude/pipeline-state.json`, destroying the first run's six ticket entries **and** the archive it had just written to `.claude/scratch/`, then rewrote `main` and dropped an unpushed commit. | Step 0a acquires `$PRIMARY/.claude/pipeline.lock` **atomically** before touching anything, and refuses to start if a live run holds it. This is a **tightening** from the previous "one run per working tree": with a fresh lane per run, a lock inside the lane is always free, so per-tree locking would silently stop working. Two runs no longer contend on a checkout, but they do contend on `main`, on the deploy slot and on the state file, and one lock in the primary covers all three. |
| **The lock binds `/run-tickets` only.** | Interactive sessions never take it, so `/start-issue`, `/ship` and `/verify` in the primary repo or in a `note-reader-local-nrl-*` worktree still run alongside a live run. What they must not do is deploy: that is what `deploy.lock` is for. |
| **There is one state file, in the primary.** The old split between `.claude/pipeline-state.json` and `.claude/pipeline-state-local.json`, keyed on the directory name, is gone. | Isolation now comes from the lane itself, so the split has nothing left to do, and keeping the file in the primary is what lets it survive the lane's removal. `--resume` after a crash therefore works even though the checkout is gone: the branches live in the primary's git dir, and Step 0c recreates the lane. |

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
| `rm -rf "$LOCK"` | end-of-run lock release, and the `deploy.lock` release |

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
- `--resume` - re-validate `$STATE_FILE` against Linear and git before continuing, and recreate the
  recorded lane if its directory is gone. Auto-invoked if the state file has in-progress tickets and
  no flag was given.
- `--force-unlock` - replace a `$PRIMARY/.claude/pipeline.lock` held by another run. For a human who knows
  the other run is dead. It still prints the holder and archives that run's state file first, and an
  agent must never pass it to itself to get past Step 0a.

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

LOCK="$PRIMARY/.claude/pipeline.lock"
STATE_FILE="$PRIMARY/.claude/pipeline-state.json"
DEPLOY_LOCK="$PRIMARY/.claude/deploy.lock"
ARCHIVE_DIR="$PRIMARY/.claude/scratch"

echo "primary=$PRIMARY  launched-from=$REPO_ROOT"
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

### Step 0a: Take the lock, in the primary, before anything else

The lock lives in `$PRIMARY/.claude/`, and the reason is not cosmetic. Every run now creates its own
fresh lane, so a lock inside the lane is **free by construction** and would prevent nothing. Two
runs no longer contend on a checkout, but they still contend on `main`, on the single deploy slot and
on the state file, and all three are reached through the primary.

The tradeoff, stated plainly: this is now **one `/run-tickets` at a time per repo**, where it used to
be one per working tree. Interactive commands do not take this lock, so ordinary sessions in the
primary or in a `note-reader-local-nrl-*` worktree are unaffected.

```bash
RUN_ID=$(date -u +%FT%TZ)

# mkdir is atomic on POSIX: it succeeds for exactly one caller. Do not replace
# this with a -f test followed by a write, which is the race it exists to avoid.
if mkdir "$LOCK" 2>/dev/null; then
  cat > "$LOCK/owner" <<EOF
runId=$RUN_ID
pid=$$
primary=$PRIMARY
launchedFrom=$REPO_ROOT
worktree=(pending, written by Step 0c)
stateFile=$STATE_FILE
heartbeat=$(date -u +%FT%TZ)
EOF
  echo "lock acquired: $RUN_ID"
else
  echo "LOCK HELD, this run must not start:"
  cat "$LOCK/owner" 2>/dev/null || echo "(no owner file: malformed lock)"
fi
```

If the lock was **not** acquired, stop the whole run and report the holder verbatim. Do not remove
the lock, do not work around it, and do not start in a different directory to dodge it. Two
exceptions, both explicit:

- **Stale.** `heartbeat` is more than 60 minutes old, or the `owner` file is missing or unparseable.
  Say so, name the age you measured, archive any existing state file as below, then replace the lock.
  Measure it, do not eyeball it:

  ```bash
  HB=$(grep '^heartbeat=' "$LOCK/owner" | cut -d= -f2-)
  AGE=$(( ( $(date -u +%s) - $(date -u -d "$HB" +%s) ) / 60 ))
  echo "holder heartbeat is ${AGE} minutes old"
  ```

- **`--force-unlock` was passed.** Print the holder, archive its state file, then replace the lock.
  Never pass this to yourself; it exists for a human who knows the other run is dead.

Refresh `heartbeat` at every phase transition, in the same write that appends to `history`. A run
that dies mid-phase then reads as stale within the hour instead of blocking the repo forever.

Rewrite the `worktree=` line in `$LOCK/owner` as soon as Step 0c has created the lane. A run that
dies after creating a lane and before recording it leaves an orphan directory nobody can attribute,
which is the one piece of state a stale-lock takeover cannot reconstruct.

Release the lock with `rm -rf "$LOCK"` at the end-of-run report, **after** Step 8's cleanup has run,
and say in that report that it was released. A **blocked ticket does not release the lock** - the run
continues to the next ticket and only the end of the run releases it.

### Step 0b: Never destroy another run's record

Each of these was violated on 2026-09-29 and each cost real work:

- **Never reinitialise a state file you did not create.** If `$STATE_FILE` exists and its `runId` is
  not yours, you are either resuming it or archiving it. There is no third option, and "the tickets
  look done" is not a reason: that file held a `blocked` ticket with an open PR.
- **Archive before you write**, to `$ARCHIVE_DIR/pipeline-state.<their-runId>.json`, and verify
  the copy parses before the original is touched.
- **Never empty `$ARCHIVE_DIR`** (`$PRIMARY/.claude/scratch/`). It is the archive of record, it is
  gitignored, and it is where a superseded run's only copy lives.
- **Never rewrite a branch you did not create**, and never amend, rebase or reset `main`. A run on
  2026-09-29 rewrote `main` and silently dropped an unpushed commit that was not its own. Merge, or
  leave it alone. The run's own `run/<stamp>` branch is the one exception: Step 0d hard-resets it,
  and it exists solely to be reset and then deleted.
- **Never touch the primary checkout.** The run works only inside its own lane, so it never
  `checkout`s, `reset`s or commits in `$PRIMARY`. The only writes it makes there are to
  `$PRIMARY/.claude/` (lock, state file, archive) and the `git worktree add` / `remove` pair, both of
  which leave the primary's `HEAD` and index alone. This is stronger than the old rule and replaces
  it: the old one said do not checkout in a tree whose lock you do not hold, which was necessary
  only because the run used to work in a tree someone else might be in.
- **Never remove a worktree this run did not create.** Cleanup touches exactly the path recorded in
  the state file's `worktree` field. A `note-reader-local-nrl-*` directory belongs to
  `worktrees.md`'s interactive pool and a stray sibling may belong to treehouse.

Assert before starting. These are the only conditions that stop the whole run, because nothing has
been touched yet and continuing could destroy someone's work:

- **The lock was acquired** (Step 0a). Everything below is pointless if another run is live here.
- **`$PRIMARY` is clean.** `git -C "$PRIMARY" status --short` is empty. The run will not commit
  there, but a dirty primary means a human or an interactive session is mid-edit, and `origin/main`
  is about to be the base for every ticket. Stop and report what is dirty rather than branching off
  a tree somebody is working in. Do not stash or discard it.
- **`origin/main` is reachable and current.** `git -C "$PRIMARY" fetch origin` succeeds. The lane
  branches from `origin/main`, not from the primary's `HEAD`, so a primary that is behind is
  harmless and needs no fast-forward. Assert rather than assume that `origin/HEAD` resolves.
- If `$STATE_FILE` holds an in-progress run and `--resume` was not given, resume it rather than
  overwriting it, and say so in the first message. Starting fresh would orphan an in-flight branch
  and PR. Compare by `runId`, not by how finished the tickets look.

**Two mechanisms, and they do different jobs.** The lane gives the run a checkout nobody else is in.
The lock in the primary stops a second run reaching the same `main`, the same deploy slot and the same
state file. The lane cannot do the lock's job, because a fresh directory is always unlocked; the lock
cannot do the lane's, because it does not isolate a checkout from interactive sessions that never take
it. Keep both.

### Step 0c: Create the run's lane

After the lock, before Phase 0. The lane is created from `origin/main` on a throwaway branch, and the
branch exists because `main` itself is checked out in the primary and git will not check it out twice.

```bash
STAMP=$(date -u +%Y%m%d-%H%M%S)
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

Record `worktree`, `runBranch` and `primary` at the top level of the state file, and rewrite the
`worktree=` line in `$LOCK/owner`. Every phase prompt from here on gets `$RUN_WT` as its repo root,
never `$PRIMARY`.

**Under `--resume`,** do not create a new lane. Read `worktree` and `runBranch` from the state file
and use them. If the directory is gone (a crash, or a `--keep-worktree` lane the owner deleted), the
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

Then Step 8 removes the lane and releases the lock, once, for the whole run.

**Sequencing is not optional.** Tickets run one at a time, fully through phase 7, before the next
one's phase 1. Branches come off `origin/main`, and `origin/main` only carries ticket N's fix once
ticket N's Merge has landed it. A blocked ticket stops where it is; Step 0d resyncs the lane and the
next ticket starts from the new `origin/main`.

## State file: `$STATE_FILE`

Machine-local, gitignored, never committed. It is always
`$PRIMARY/.claude/pipeline-state.json` - **one file, in the primary repo**, resolved by Step 0.
Every phase must be handed that resolved absolute path.

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

`.gitignore` already covers `.claude/pipeline-state.json`, `.claude/pipeline.lock/`,
`.claude/deploy.lock/` and `.claude/scratch/` (verified at `7f20cf0`). The lane itself needs no
ignore rule: it is a sibling directory, outside the repo's own working tree. Timestamps come from
`date -u +%FT%TZ`, never from a guess.

## Phase subagent prompts

In every prompt below, substitute the literal absolute paths Step 0 resolved:

| Placeholder | Value |
|---|---|
| `<run-worktree>` | `$RUN_WT`, the lane. **This is the repo root every phase works in.** |
| `<state-file>` | `$STATE_FILE`, i.e. `$PRIMARY/.claude/pipeline-state.json` |
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

Fetch the issue and write `title`, `requirement`, `type`,
`descriptionSnapshot` and `branch` into this ticket's state entry. Set the Linear status to In
Progress: call `list_issue_statuses` first and use the id whose name is exactly `In Progress`, then
read the status back rather than trusting the write. Set `phase: \"plan\"`,
`status: \"in_progress\"`, append history. If a branch collision or anything else needs a decision
`start-issue.md` cannot make, set `status: \"blocked\"` with `blockedReason` and stop. Do not
guess."

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
you touched `src/engines/onnx/`, `esbuild.config.mjs`, `manifest.json` or `package.json`. Note
that `npm test` chains with `&&`, so an early suite failing tells you nothing about the later
ones. Write a 3 to 6 sentence `implementationSummary` that lists every deviation from the plan and
every known miss, set `phase: \"ship\"`. Do not commit, push, or open a PR."

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
   `mkdir` exactly as the run lock is taken, then deploy with `npm run deploy`, write
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

Verify the merge by content, not just by branch state: this repo squashes, so
`git branch -d` can claim 'not merged' for work that is fully in `main`. Grep the resynced lane for a
distinctive symbol the PR added before deleting, and use `-D` only once content is confirmed. Set
the Linear status to Done by reading `list_issue_statuses` rather than a remembered id, and read
the status back. Then check whether this ticket removed one of the defects listed in the
`AGENTS.md` Known state section, or moved a requirement's status in `srs.md`. If so, make the doc
edit on a `docs/<id>-finish` branch, open a PR, and squash-merge it yourself; never commit to
`main` directly. Only move a requirement to fully met with evidence, and name that evidence.
Finally, take `<deploy-lock>` atomically with `mkdir` and run `npm run deploy` from the resynced lane
so the owner's vault carries the latest merged build, then write `.deployed-from` with this lane's
path and commit, and release the lock. If the lock cannot be taken, skip the deploy and name the
holder; do not wait. Leave the lane on `<run-branch>`, clean and at `origin/main`. Set
`phase: \"finish\"`, `status: \"done\"`."

## Step 8: Clean up the lane, once, at the end of the run

Runs after the last ticket reaches `done` or `blocked`, and **before** the lock is released. Skipped
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

When every ticket is `done` or `blocked`, Step 8 has run and the lock is released, print one message:

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
- Confirmation that `$PRIMARY/.claude/pipeline.lock` was released, and the path of anything archived
  under `$PRIMARY/.claude/scratch/` during the run.
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
Continues the run recorded in `$PRIMARY/.claude/pipeline-state.json`, recreating the lane from its
`worktree` and `runBranch` fields if the directory is gone.

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
| A Linear status write appears to succeed but reads back wrong | Re-fetch `list_issue_statuses` and retry once with the fresh id. If it still reads back wrong, block the ticket and continue. Do not trust a remembered status id. |
| A permission prompt appears mid-run | The run was launched wrong; see "How to launch it, per runtime". Stop and report which command was gated. Never edit `opencode.json` or the Claude Code settings from inside a run to get past it. |
| `npm test` fails at an early suite | Remember the `&&` chain hides later suites. Re-run the remaining ones individually before concluding anything about scope. |
| `tests/engine.test.ts` fails | It shells out to real `espeak-ng` and `spd-say`. Check the binaries before assuming the code broke. |
| `origin/main` fails its gates in the fresh lane at Step 0c | Something already merged is broken. Stop the run and report it; branching tickets off a broken base compounds it. Check `which espeak-ng spd-say` first: `tests/engine.test.ts` needs the real daemon. |
| `gh` auth expires mid-run | Stop the run and report which step failed. Every later ticket would fail the same way. |
| A phase needs a decision not covered above | Decide it with a recorded default if one is defensible, otherwise block the ticket. Never wait. |
| `$PRIMARY/.claude/pipeline.lock` is held on entry | Stop the whole run before touching anything, and before creating a lane. Print the holder's `owner` file verbatim. Only a measured heartbeat over 60 minutes old, or an explicit `--force-unlock`, may replace it. **Launching from a different directory does not dodge it**, which is the point of resolving `$PRIMARY` first. |
| `$STATE_FILE` exists with a `runId` that is not yours | Resume it, or archive it to `$PRIMARY/.claude/scratch/` and verify the copy parses first. Never reinitialise it, however finished its tickets look. Check its `worktree` field before creating a lane: that run's lane may still be on disk. |
| `git worktree add` fails because `$RUN_WT` exists | A previous run left a lane, most likely under `--keep-worktree` or a kept-because-unpushed cleanup. Do not remove it and do not reuse it. Report the path, say which state file references it, and stop; the collision is one second of clock skew away from being a name you cannot attribute. |
| `git worktree add` fails because `$RUN_BRANCH` exists | Same cause, same response. Never `-D` a run branch you did not create in this run. |
| The lane's `HEAD` moved under you mid-run | Something else is working in the lane. Stop, report the branch you expected and the one you found, and do not commit: your files may already be staged into someone else's commit. |
| A stale-lock takeover finds a lane on disk | Report it as an orphan with its path and the dead run's `runId`, and create your own lane with a fresh stamp. Do not remove or reuse the orphan; the dead run may hold the only copy of a blocked ticket's reproduction. |
| An unpushed commit you did not create is on `main` | Do not amend, rebase or reset to tidy it. Push it or leave it. One was silently dropped this way on 2026-09-29. `main` is never checked out in the lane, so this can only be seen in `$PRIMARY`, which the run does not touch. |
| A PR's CI check goes red | Record it and carry on; it does not block the merge and there is no branch protection. Name it in the end-of-run report with `/test-issue <ID>` as the follow-up. **Do not run `/test-issue` from inside the run**: it waits on a conclusion and reproduces failures locally, neither of which belongs in an unattended pipeline. |

## Configuration

| Setting | Value |
|---|---|
| **Primary repo** | `git rev-parse --show-toplevel`, then strip a `-nrl-*` or `-run-*` suffix. Assert `git -C "$PRIMARY" rev-parse --git-dir` prints `.git` |
| **Run lane** | `${PRIMARY}-run-<YYYYMMDD-HHMMSS>` on branch `run/<stamp>`, created at Step 0c from `origin/main`, removed at Step 8. Deliberately outside the `note-reader-local-nrl-*` pool `worktrees.md` owns |
| **Lock, state, archive** | `$PRIMARY/.claude/{pipeline.lock,pipeline-state.json,deploy.lock,scratch/}`. All in the primary so they outlive the lane |
| **Base branch** | `main`. PRs target it; the lane never checks it out, since the primary has it |
| **Remote** | `git@github.com:JoshShearer/Note-Reader-Local.git` |
| **Tracker** | Linear workspace `note-reader-local`, MCP server `linear-nrl`, team key `NRL` |
| **Gates** | `npm test` · `npm run typecheck` · `npm run build` when the bundle moved. Run once in the fresh lane at Step 0c before any ticket |
| **CI** | `.github/workflows/ci.yml`, job `gates`, on `push` (`branches: ["**"]`) and `pull_request`, so it runs twice on a PR branch. May be read once, never waited on. No branch protection, so a red check does not block a merge. `/test-issue` is the human-invoked triage |
| **Push gate** | None. No husky, no active git hooks. |
| **Permission gate** | Four commands the pipeline needs are `ask` in `opencode.json`. Launch headless (`opencode run --auto --command run-tickets "<ids>"`) or in a Claude Code bypass session. See "How to launch it, per runtime". |
| **Human gate** | None. The owner tests by using the app and files new tickets for what they find. |
