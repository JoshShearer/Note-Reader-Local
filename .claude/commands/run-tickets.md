---
description: Run a set of Linear tickets end to end, fully autonomously - pre-flight triage, then start, plan, implement, ship, automated verify, merge and finish per ticket in fresh subagents. Never waits on a human; anything that needs one blocks that ticket and is reported at the end.
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
| **One deploy slot.** `npm run deploy` writes to one fixed folder in `~/Documents/Notes`. | Multiple worktrees can run phases concurrently (each with its own state file), but only one lane at a time may call `npm run deploy`. Take `.claude/deploy.lock` the same atomic way as the run lock, deploy, write `.deployed-from` with the `runId` and commit, then release. A lane that cannot take it skips the deploy and says so in its report rather than waiting: the vault carries merged `main` either way, and whoever deploys last wins. |
| **A deploy is not live until Obsidian restarts.** On 2026-09-28 two tickets were "passed" against a stale in-memory build after an in-app reload. | Finish deploys `main` so the owner's vault always has the latest merged build, and the end-of-run report tells them to **fully quit and relaunch** Obsidian. A deploy never counts as evidence that the code ran. |
| **Base branch is `main`.** It is the only branch; `origin/HEAD` resolves correctly here. | No special casing. Still assert it rather than assuming. |
| **Reproduced defects are listed** in `AGENTS.md` "Known state", with exact triggering inputs. | Phase 0 must not ask for a repro for one of those. It is already written down. |
| **Worktree parallelism.** Multiple worktrees can run phases concurrently. | Each worktree uses its own `.claude/pipeline-state-local.json` for isolation. Main repo uses `.claude/pipeline-state.json`. Only one lane may deploy at a time. |
| **One run per working tree, enforced by a lock.** On 2026-09-29 two runs both worked in the primary repo: the second reinitialised `.claude/pipeline-state.json`, destroying the first run's six ticket entries **and** the archive it had just written to `.claude/scratch/`, then rewrote `main` and dropped an unpushed commit. | Step 0 acquires `.claude/pipeline.lock` **atomically** before touching anything, and refuses to start if a live run holds it. Isolation keyed on the directory name is not enough: both of those runs were in the same directory, so both resolved to the same state file. See Step 0. |

`gh` is installed and authenticated as `JoshShearer`. There is no permission classifier blocking
`gh pr merge` in this repo, and no required review, so merge automation works. Never self-approve a
PR to get around a review requirement if one is ever added; block the ticket instead.

## Tracker: Linear

Workspace `note-reader-local`, MCP server `linear-nrl`. Operations used: `get_issue`,
`list_issues`, `save_issue`, `create_comment`, `list_issue_statuses`.

**Resolve the real tool names from your own available-tool list.** The prefix differs between
Claude Code and opencode and must never be hardcoded. If no Linear tool is present, the run still
works: every phase does its git work and prints what it would have sent, and the state file
carries it. A missing tracker never blocks a commit.

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

Every prompt must carry the literal absolute repo root (subagents do not inherit your shell), the
ticket id, and an instruction to read `.claude/pipeline-state.json` for context.

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
- `--resume` - re-validate `.claude/pipeline-state.json` against Linear and git before continuing.
  Auto-invoked if the state file has in-progress tickets and no flag was given.
- `--force-unlock` - replace a `.claude/pipeline.lock` held by another run. For a human who knows
  the other run is dead. It still prints the holder and archives that run's state file first, and an
  agent must never pass it to itself to get past Step 0a.

If no argument is given, ask which tickets to run. That is the only question this command asks
before its work starts.

## Step 0: Establish facts, every run

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
WORKTREE_NAME=$(basename "$REPO_ROOT")

# Detect worktree context for state file isolation
if [[ "$WORKTREE_NAME" == note-reader-local-nrl-* ]]; then
  STATE_FILE=".claude/pipeline-state-local.json"  # Per-worktree state
else
  STATE_FILE=".claude/pipeline-state.json"        # Main repo state
fi

git status --short
git rev-parse --abbrev-ref HEAD
node --version
```

### Step 0a: Take the lock, before anything else

The state-file split above isolates one **worktree** from another. It does not isolate two runs in
the **same** working tree, which is the collision that actually happened: both runs were in the
primary repo, so both computed the same `STATE_FILE`. The lock is what makes "one run per working
tree" true rather than hoped for.

`.claude/` is per-working-tree, so a lock inside it is automatically keyed on the tree, which is the
resource being contended: the checkout, the state file and `node_modules`.

```bash
RUN_ID=$(date -u +%FT%TZ)
LOCK=".claude/pipeline.lock"

# mkdir is atomic on POSIX: it succeeds for exactly one caller. Do not replace
# this with a -f test followed by a write, which is the race it exists to avoid.
if mkdir "$LOCK" 2>/dev/null; then
  cat > "$LOCK/owner" <<EOF
runId=$RUN_ID
pid=$$
repo=$REPO_ROOT
branch=$(git rev-parse --abbrev-ref HEAD)
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
that dies mid-phase then reads as stale within the hour instead of blocking the tree forever.

Release the lock with `rm -rf "$LOCK"` when the run reaches its end-of-run report, and say in that
report that it was released. A **blocked ticket does not release the lock** - the run continues to
the next ticket and only the end of the run releases it.

### Step 0b: Never destroy another run's record

Each of these was violated on 2026-09-29 and each cost real work:

- **Never reinitialise a state file you did not create.** If `$STATE_FILE` exists and its `runId` is
  not yours, you are either resuming it or archiving it. There is no third option, and "the tickets
  look done" is not a reason: that file held a `blocked` ticket with an open PR.
- **Archive before you write**, to `.claude/scratch/pipeline-state.<their-runId>.json`, and verify
  the copy parses before the original is touched.
- **Never empty `.claude/scratch/`.** It is the archive of record, it is gitignored, and it is where
  a superseded run's only copy lives.
- **Never rewrite a branch you did not create**, and never amend, rebase or reset `main`. A run on
  2026-09-29 rewrote `main` and silently dropped an unpushed commit that was not its own. Merge, or
  leave it alone.
- **Never `git checkout` in a working tree whose lock you do not hold.** That includes the primary
  repo while a worktree lane is running, and it is why the lock is keyed on the tree rather than on
  the run.

Assert before starting. These are the only conditions that stop the whole run, because nothing has
been touched yet and continuing could destroy someone's work:

- **The lock was acquired** (Step 0a). Everything below is pointless if another run is live here.
- The working tree is clean. A dirty tree means a previous run or a manual edit is in flight: stop
  and report what is dirty. Do not stash or discard it. This one is not negotiable just because a
  worktree is "agent-managed": a dirty tree plus a second run is precisely how one run's edit gets
  swept into another's `git add -A`.
- On `main`: synced with `origin/main`, and fast-forward if only behind. In a worktree on its own
  feature branch: record the branch and assert it is the one this run's state file names, so a
  half-finished lane is resumed rather than silently re-based.
- `node_modules` exists in this context (main repo or worktree). If not, `npm ci`.
- If `$STATE_FILE` holds an in-progress run and `--resume` was not given, resume it rather than
  overwriting it, and say so in the first message. Starting fresh would orphan an in-flight branch
  and PR. Compare by `runId`, not by how finished the tickets look.

**Two layers, and they do different jobs.** The state-file split keyed on directory name isolates
worktree lanes from each other. The lock isolates two runs that resolve to the *same* state file,
which the split cannot see. Keep both; neither is redundant.

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

   > For each of these tickets, in `<repo-root>`: fetch the full description with `get_issue`,
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

3. Create the state file now, every in-scope ticket `pending` at phase `start`. For each question
   with a recommendation, write it into that ticket's `clarification` with `decidedBy: "pipeline"`,
   and post it to the Linear issue with `create_comment` as "Decided by /run-tickets (owner may
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
| 1 | Start | `start-issue.md` | Branch off `main`, Linear to In Progress, snapshot the issue into state |
| 2 | Plan | this file | Write the plan using Phase 0's decisions; genuinely new ambiguity is decided or blocks |
| 3 | Implement | this file | Reproduce first for bugs, then fix, then run the gates itself |
| 4 | Ship | `ship.md` | Gates, `check-constraints`, `critique`, commit, push, PR against `main` |
| 5 | Verify | this file | Automated: gates on the PR head, bundled probes of every acceptance input, CDP smoke if reachable |
| 6 | Merge | this file | Squash-merge once Verify recorded `pass` (skipped with `--no-merge`) |
| 7 | Finish | `finish.md` | Cleanup, Linear to Done, `main` synced and deployed, docs corrected if a defect is gone |

**Sequencing is not optional.** Tickets run one at a time, fully through phase 7, before the next
one's phase 1. Branches come off `main`, and `main` only carries ticket N's fix once ticket N's
Finish has pulled it. A blocked ticket stops where it is; the next ticket starts from `main`.

## State file: `.claude/pipeline-state.json`

Machine-local, gitignored, never committed.

```json
{
  "runId": "2026-09-28T14:00:00Z",
  "baseBranch": "main",
  "buildGate": false,
  "merge": true,
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

Add both `.claude/pipeline-state.json` and `.claude/pipeline-state-local.json` to `.gitignore` if
they are not already there (the latter is used by worktree instances). Timestamps come from
`date -u +%FT%TZ`, never from a guess.

## Phase subagent prompts

**1. Start** - "Read `.claude/commands/start-issue.md` and follow it for `<ID>` in `<repo-root>`,
non-interactively; the ticket is already chosen. Worktree context: if REPO_ROOT ends with
`note-reader-local-nrl-*`, use state file `.claude/pipeline-state-local.json`; otherwise use
`.claude/pipeline-state.json`.

`git checkout main && git pull --ff-only` first (if in main repo; skip if in worktree feature branch).
Branch from `main`. Fetch the issue and write `title`, `requirement`, `type`,
`descriptionSnapshot` and `branch` into this ticket's state entry. Set the Linear status to In
Progress: call `list_issue_statuses` first and use the id whose name is exactly `In Progress`, then
read the status back rather than trusting the write. Set `phase: \"plan\"`,
`status: \"in_progress\"`, append history. If a branch collision or anything else needs a decision
`start-issue.md` cannot make, set `status: \"blocked\"` with `blockedReason` and stop. Do not
guess."

**2. Plan** - "Read `<ID>`'s `descriptionSnapshot`, `clarification` and `reproduction` from
`.claude/pipeline-state.json`. Line numbers in the ticket may be stale if earlier tickets in this
run touched the same files: read the current code on `main`. Write a concise ordered `planNote`
naming real functions, incorporating every recorded decision. If a genuinely new ambiguity appears
that Phase 0 missed, decide it the way Phase 0 would (recommendation plus one line of reasoning),
record it in `clarification` with `decidedBy: \"pipeline\"`, and post it to Linear as a
'Decided by /run-tickets' comment. Only if no defensible default exists, set
`status: \"blocked\"`, `blockedReason: \"Unanticipated by pre-flight: <question>\"`, and stop. If
this ticket amends `srs.md`, the plan must include an ADR under `docs/adr/` in the existing
`NNNN-kebab-title.md` format. Set `phase: \"implement\"`."

**3. Implement** - "You are on `<branch>` in `<repo-root>`. Read `<ID>`'s `descriptionSnapshot`,
`planNote` and `reproduction`. Do not deploy and do not touch `~/Documents/Notes`.

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
`<repo-root>`, skipping any deploy step. PR base is `main`. Use `implementationSummary` for the PR
body's approach section. `<--build if the run passed it, otherwise: build only if the diff touches
the bundle>`.

There is no pre-push hook, so the push is instant. `.github/workflows/ci.yml` runs on `push` and
on `pull_request`, so the PR will pick up a check. You **may** read its conclusion once for the
report; you **must not** wait on it, and never write a polling loop. Branch protection is out of
scope, so a red check does not block a merge.

Run `/check-constraints`. A BLOCK is not overridable: set `status: \"blocked\"` with the findings
and stop without committing. Same for a `/critique` BLOCK verdict. With no human reviewing the
diff, treat any critique finding where **prose is silently lost, private text is spoken, or
`sourceIndex` drifts** as must-fix: fix it with a test that fails first, re-run the gates, then
commit. Lower findings are listed in the PR body as known leftovers.

The PR body must carry a literal `NOT VERIFIED IN OBSIDIAN` line, and a manual test plan with exact
note contents to paste and the expected speech for each, so the owner can check it later while
using the app. Record `prNumber`, `prUrl`, `commitSha`, set `phase: \"verify\"`."

**5. Verify** - automated, in a fresh subagent. It must not be the subagent that wrote the fix.

"You are verifying PR `<prNumber>` for `<ID>` in `<repo-root>`, on branch `<branch>`. Read the
ticket's `descriptionSnapshot`, `planNote`, `implementationSummary` and `reproduction`. You did not
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
   (`curl -s --max-time 2 http://127.0.0.1:9222/json/version`), deploy with `npm run deploy` and run
   `npm run test:obsidian`, and record the result. The running plugin only picks up a deploy after
   Obsidian restarts, so a smoke test against an un-restarted instance proves nothing; say which
   build was loaded if you can tell. If the port is not reachable, record `CDP smoke: not run`. Do
   not start, stop or restart Obsidian.

Set `verifyVerdict: \"pass\"` only if the gates pass and every probe matches. Otherwise set
`verifyVerdict: \"fail\"`, `status: \"blocked\"`, and put the failing inputs with actual versus
expected output in `blockedReason`. Do not attempt a fix. Write a short `verifyNotes`, append
history, and on pass set `phase: \"merge\"`."

On pass, the orchestrator posts a Linear comment with `create_comment` stating, as separate
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
in `<repo-root>`. Verify the merge by content, not just by branch state: this repo squashes, so
`git branch -d` can claim 'not merged' for work that is fully in `main`. Grep `main` for a
distinctive symbol the PR added before deleting, and use `-D` only once content is confirmed. Set
the Linear status to Done by reading `list_issue_statuses` rather than a remembered id, and read
the status back. Then check whether this ticket removed one of the defects listed in the
`AGENTS.md` Known state section, or moved a requirement's status in `srs.md`. If so, make the doc
edit on a `docs/<id>-finish` branch, open a PR, and squash-merge it yourself; never commit to
`main` directly. Only move a requirement to fully met with evidence, and name that evidence.
Finally, on an up-to-date `main`, run `npm run deploy` so the owner's vault carries the latest
merged build. Finish on `main`, clean, synced. Set `phase: \"finish\"`, `status: \"done\"`."

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

A decision the pipeline took on the owner's behalf is **not** a block. It is recorded in state,
posted to Linear, and listed in the end-of-run report so it can be overridden later.

## End-of-run report

When every ticket is `done` or `blocked`, print one message:

- A table: ticket, PR, merge commit, automated verify result, one line on what changed.
- Every decision taken with `decidedBy: "pipeline"`, with a link to its Linear comment.
- Every blocked ticket with its reason, branch and PR.
- New follow-up tickets filed during the run, and known leftovers from each PR.
- Requirement status changes, with the evidence for each.
- The reminder: **the vault now has `main` at `<sha>`. Fully quit and relaunch Obsidian to load
  it;** an in-app reload has proven unreliable. Nothing in this run was verified in Obsidian by a
  human, and each PR's manual test plan says what to look at. If this lane could not take
  `.claude/deploy.lock`, say that it skipped the deploy and name the lane that holds it.
- Confirmation that `.claude/pipeline.lock` was released, and the path of anything archived under
  `.claude/scratch/` during the run.

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
Continues the run recorded in `.claude/pipeline-state.json`.

## Error handling

| Scenario | Action |
|---|---|
| No Linear tool in the available list | Continue git-only. Print the status transitions and comments that would have been sent, and record them in the state file. Never block a commit on a missing tracker. |
| A Linear status write appears to succeed but reads back wrong | Re-fetch `list_issue_statuses` and retry once with the fresh id. If it still reads back wrong, block the ticket and continue. Do not trust a remembered status id. |
| `npm test` fails at an early suite | Remember the `&&` chain hides later suites. Re-run the remaining ones individually before concluding anything about scope. |
| `tests/engine.test.ts` fails | It shells out to real `espeak-ng` and `spd-say`. Check the binaries before assuming the code broke. |
| `main` fails its gates at the start of a ticket | Something already merged is broken. Stop the run and report it; branching further tickets off a broken `main` compounds it. |
| `gh` auth expires mid-run | Stop the run and report which step failed. Every later ticket would fail the same way. |
| A phase needs a decision not covered above | Decide it with a recorded default if one is defensible, otherwise block the ticket. Never wait. |
| `.claude/pipeline.lock` is held on entry | Stop the whole run before touching anything. Print the holder's `owner` file verbatim. Only a measured heartbeat over 60 minutes old, or an explicit `--force-unlock`, may replace it. Never work around it by changing directory. |
| `$STATE_FILE` exists with a `runId` that is not yours | Resume it, or archive it to `.claude/scratch/` and verify the copy parses first. Never reinitialise it, however finished its tickets look. |
| The working tree changed branch under you mid-run | Another run is in this tree despite the lock. Stop, report both the branch you expected and the one you found, and do not commit: your files may already be staged into someone else's commit. |
| An unpushed commit you did not create is on `main` | Do not amend, rebase or reset to tidy it. Push it or leave it. One was silently dropped this way on 2026-09-29. |

## Configuration

| Setting | Value |
|---|---|
| **Repo root** | `git rev-parse --show-toplevel` |
| **Base branch** | `main` (only branch; PRs target it) |
| **Remote** | `git@github.com:JoshShearer/Note-Reader-Local.git` |
| **Tracker** | Linear workspace `note-reader-local`, MCP server `linear-nrl`, team key `NRL` |
| **Gates** | `npm test` · `npm run typecheck` · `npm run build` when the bundle moved |
| **CI** | `.github/workflows/ci.yml` on `push` and `pull_request`. May be read once, never waited on. No branch protection, so a red check does not block a merge. |
| **Push gate** | None. No husky, no active git hooks. |
| **Human gate** | None. The owner tests by using the app and files new tickets for what they find. |
