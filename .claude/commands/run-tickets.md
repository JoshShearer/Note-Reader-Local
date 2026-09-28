---
description: Run a set of Linear tickets end to end - pre-flight triage for clarifying questions, then start, plan, implement, ship, verify, merge and finish per ticket in fresh subagents, pausing only where a human is genuinely required.
---

Conventions: `.claude/linear.md`. Rules and gates: `AGENTS.md`.

Adapted from the ShroomSpy Jira pipeline. What differs here is not cosmetic, so read the fact
table before the first run.

## Read this before the first run

| Fact | Consequence |
|---|---|
| **There is no CI.** No `.github/`, no workflow, no hook. `.git/hooks` holds only samples. | The Verify phase has nothing to poll. It runs the gates itself and then drives real Obsidian. Do not write a `gh pr checks` loop; it will wait forever on a PR that no runner ever touches. |
| **Only a human can confirm speech.** Whether a voice sounds right, whether highlighting tracks the words, whether a pause actually pauses - none of it is observable from a test runner. | **Every ticket pauses once, at Verify.** This is structural, not a flag. It is the analogue of ShroomSpy's merge gate. |
| **A green suite is not a working feature** (`AGENTS.md` rule 11). The 5 suites run in bare Node against fakes. | No phase may report a user-facing change as done on `npm test` alone. Ship marks it `NOT VERIFIED IN OBSIDIAN`; Verify is what clears that. |
| **Bugs must be reproduced before they are fixed** (`AGENTS.md` rule 12). | Implement begins by reproducing, not by editing. If the repro fails, the ticket pauses rather than proceeding on a guess. |
| **One deploy slot.** `npm run deploy` writes to one fixed folder in `~/Documents/Notes`. | Tickets run strictly one at a time. Never parallelise this command, and do not start a second run in a worktree while one is live. |
| **Base branch is `main`.** It is the only branch; `origin/HEAD` resolves correctly here. | Unlike ShroomSpy, no special casing. Still assert it rather than assuming. |
| **Nine defects are already reproduced** and listed in `AGENTS.md` "Known state", with exact triggering inputs. | Phase 0 must not ask for a repro for one of those. It is already written down. |

`gh` is installed and authenticated as `JoshShearer`. There is no permission classifier blocking
`gh pr merge` in this repo, so merge automation is available, but it is **off by default** - see
`--auto-merge`.

## Tracker: Linear

Workspace `note-reader-local`, MCP server `linear-nrl`. Operations used: `get_issue`,
`list_issues`, `save_issue`, `create_comment`, `list_issue_statuses`.

**Resolve the real tool names from your own available-tool list.** The prefix differs between
Claude Code and opencode and must never be hardcoded. If no Linear tool is present, the run still
works: every phase does its git work and prints what it would have sent, and the state file
carries it. A missing tracker never blocks a commit.

The team key is **UNVERIFIED**; `NRL` is a placeholder. Run the discovery block in
`.claude/linear.md` before the first real run, or every issue lookup will miss.

## Why phases run in fresh subagents

Quality, not speed. The subagent that just spent its context writing a fix is the worst possible
judge of whether that fix is sound. Fresh context per phase means each phase reads only the state
file and the repo, the way a different person picking the work up would.

This orchestrating conversation stays alive for the whole run and never does the work: read state
-> spawn one subagent for exactly one phase of one ticket -> receive a short summary -> write it to
the state file -> spawn the next. Its context grows from summaries, not transcripts.

Spawn with the `Task` tool. **The subagent type name differs by runtime:** use
`general-purpose` in Claude Code and `general` in opencode. Pick whichever your runtime exposes.

Every prompt must carry the literal absolute repo root (subagents do not inherit your shell), the
ticket id, and an instruction to read `.claude/pipeline-state.json` for context.

## Input

Argument: `$ARGUMENTS`

- A comma-separated list of ids, e.g. `NRL-12,NRL-14,NRL-19`.
- `all` - auto-discover assigned, not-done issues via `list_issues`, priority order. Drop anything
  in a blocked or cancelled state.
- `--build` - run `npm run build` in every Ship phase. Default is to build only when the diff
  touches `src/engines/onnx/`, `esbuild.config.mjs`, `manifest.json`, or `package.json`.
- `--auto-merge` - squash-merge a PR once its Verify phase recorded a PASS **in Obsidian**. Without
  this flag, merge is a pause. The flag never skips the Verify pause, only the merge one.
- `--resume` - re-validate `.claude/pipeline-state.json` against Linear and git before continuing.
  Auto-invoked if the state file has in-progress tickets and no flag was given; ask before
  overwriting an incomplete run.

If no argument is given, ask which tickets to run rather than guessing.

## Step 0: Establish facts, every run

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
git status --short
git rev-parse --abbrev-ref HEAD
node --version
```

Assert before starting:

- The working tree is clean. A dirty tree means a previous run or a manual edit is in flight; ask.
- You are on `main` and it is synced with `origin/main`.
- `node_modules` exists. If not, `npm ci`.
- The cwd is the primary repo, not a `note-reader-local-nrl-*` worktree. This command owns the
  deploy slot for its whole run and should hold it from one place.

Then read, in this order: `AGENTS.md` (the 14 non-negotiables and the Known-state defect list),
`.claude/linear.md`, and the commands this pipeline delegates to - `start-issue.md`, `ship.md`,
`verify.md`, `finish.md`, `check-constraints.md`, `critique.md`. Do not reimplement their
contents here; call them.

## Phase 0: Pre-flight triage, before any ticket's Phase 1

Without this, "needs a human decision" is discovered after a branch exists and Linear already
says In Progress. Churn for a ticket that then sits blocked.

1. Fetch every ticket in scope with `get_issue`.
2. Spawn **one** fresh subagent for the whole batch. Read-only, no reason to isolate per ticket.
   Its prompt:

   > For each of these tickets [list with full descriptions], in `<repo-root>`: grep and read the
   > files each ticket actually names, do not judge by title. Return a table with ticket id,
   > judgment (simple / complex / needs-decomposition), the `srs.md` requirement ID it closes if
   > any, and whether it is one of the nine already-reproduced defects in the `AGENTS.md` Known
   > state list. For anything not simple, give one crisp clarifying question whose answer resolves
   > the ambiguity: "sentence highlight in addition to word, or instead of it?", not "what should
   > we do about highlighting?". Flag any ticket that cannot be finished inside this repo, or that
   > needs a device this machine does not have - an Android phone for R-M03, a second GPU, a
   > non-Linux desktop. Make no changes of any kind.

3. Present the batch result in **one** message: which tickets are clear, and, grouped up front,
   every clarifying question for the rest.
4. Wait for the reply. This is an ordinary turn, not `--resume`; nothing is on disk yet.
5. Write each answer into that ticket's `clarification` field in `.claude/pipeline-state.json`
   (create it now, every in-scope ticket `pending` at phase `start`). Unanswered becomes
   `blocked` with the question as `blockedReason`, excluded from the run, holding nothing up.
6. Begin Phase 1 for the first non-blocked ticket.

Special cases Phase 0 must handle:

- **A ticket with no requirement ID and no clear acceptance criteria** is not ready. Ask.
- **A ticket for a known defect** already has its repro in `AGENTS.md`. Do not ask for one; copy it
  into `reproduction` in the state file.
- **A ticket that would touch `srs.md`** is a spec amendment and needs an ADR per `AGENTS.md`. Flag
  it so Plan expects one.

## The 7 phases

| # | Phase | Delegates to | What the fresh subagent does |
|---|---|---|---|
| 1 | Start | `start-issue.md` | Branch off `main`, Linear to In Progress, snapshot the issue into state |
| 2 | Plan | this file | Judge complexity using Phase 0's answer if present; genuinely new complexity pauses |
| 3 | Implement | this file | Reproduce first for bugs, then fix, then run the gates itself |
| 4 | Ship | `ship.md` | Gates, `check-constraints`, `critique`, commit, push, PR against `main` |
| 5 | Verify | `verify.md` | **Always a pause.** Deploy, drive real Obsidian, record what was observed |
| 6 | Merge | this file | Pause by default; squash-merge if `--auto-merge` and Verify passed |
| 7 | Finish | `finish.md` | Cleanup, Linear to Done, `main` synced, docs corrected if a defect is gone |

**Sequencing is not optional.** Tickets run one at a time, fully through phase 7, before the next
one's phase 1. Branches come off `main`, and `main` only carries ticket N's fix once ticket N's
Finish has pulled it.

## State file: `.claude/pipeline-state.json`

Machine-local, gitignored, never committed.

```json
{
  "runId": "2026-09-28T14:00:00Z",
  "baseBranch": "main",
  "buildGate": false,
  "autoMerge": false,
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
      "clarification": { "question": null, "answer": null },
      "planNote": null,
      "reproConfirmed": false,
      "implementationSummary": null,
      "prNumber": null, "prUrl": null, "commitSha": null,
      "obsidianVerdict": null, "obsidianNotes": null,
      "blockedReason": null,
      "history": [{ "phase": "start", "at": "2026-09-28T14:01:00Z", "result": "branch created" }]
    }
  ]
}
```

`status`: `pending` | `in_progress` | `awaiting_verify` | `awaiting_merge` | `blocked` | `done`.
`phase`: `start` | `plan` | `implement` | `ship` | `verify` | `merge` | `finish`.
`obsidianVerdict`: `null` | `pass` | `fail`.

Add `.claude/pipeline-state.json` to `.gitignore` if it is not already there.

## Phase subagent prompts

**1. Start** - "Read `.claude/commands/start-issue.md` and follow it for `<ID>` in `<repo-root>`,
non-interactively; the ticket is already chosen. Branch from `main`. Fetch the issue and write
`title`, `requirement`, `type`, `descriptionSnapshot` and `branch` into this ticket's state entry.
Set the Linear status to In Progress: call `list_issue_statuses` first and use the id whose name is
exactly `In Progress`, then read the status back rather than trusting the write. Set
`phase: \"plan\"`, `status: \"in_progress\"`, append history. If a branch collision or anything
else needs a decision `start-issue.md` cannot make, set `status: \"blocked\"` with
`blockedReason` and stop. Do not guess."

**2. Plan** - "Read `<ID>`'s `descriptionSnapshot` from `.claude/pipeline-state.json`. If a
`clarification.answer` is recorded, use it: write `planNote` incorporating that decision, set
`phase: \"implement\"`, done, do not re-judge. Otherwise judge complexity from the files the
ticket names, not the title. Simple, meaning clear and under three files, gets
`planNote: \"Straightforward, proceeding directly\"` and `phase: \"implement\"`. Complex or
needing decomposition should have been caught by Phase 0; do not guess now. Write one crisp line
into `clarification.question`, leave `answer` null, set `status: \"blocked\"`,
`blockedReason: \"Unanticipated by pre-flight\"`, stop. If this ticket amends `srs.md`, say in
`planNote` that an ADR under `docs/adr/` is required."

**3. Implement** - "You are on `<branch>` in `<repo-root>`. Read `<ID>`'s `descriptionSnapshot`,
`planNote` and `reproduction`.

**If `type` is `bug`, reproduce it before changing anything.** `AGENTS.md` rule 12 requires this,
and most defects in this codebase were invisible to the test suite and obvious the moment the real
function ran against real input. Bundle the module and run it, for example
`npx esbuild <probe>.ts --bundle --platform=node --format=esm --outfile=/tmp/probe.mjs && node /tmp/probe.mjs`.
Record the actual observed output. Set `reproConfirmed: true` only when you have seen the failure
yourself. If you cannot reproduce it, set `status: \"blocked\"` with what you tried and stop; do
not fix a bug you have not seen.

Then implement exactly what the acceptance criteria describe, honouring any Out of Scope section.
Add a regression test, and **confirm it fails against the unfixed code** before claiming it
verifies anything. Consult the `AGENTS.md` non-negotiable that matches the area you are touching:
`extract.ts` means the `sourceIndex` lockstep rule, engines mean the `ownsPlayback` rate rule,
settings mean the normalisation whitelist rule, anything logging means no note text ever.

Run the gates yourself before finishing: `npm test`, `npm run typecheck`, and `npm run build` if
you touched `src/engines/onnx/`, `esbuild.config.mjs`, `manifest.json` or `package.json`. Note
that `npm test` chains with `&&`, so an early suite failing tells you nothing about the later
ones. Write a 3 to 6 sentence `implementationSummary`, set `phase: \"ship\"`. Do not commit, push,
or open a PR."

**4. Ship** - "Read `.claude/commands/ship.md` and follow it for the current branch in
`<repo-root>`. PR base is `main`. Use `implementationSummary` for the PR body's approach section,
and include a manual test plan naming what to click in Obsidian, because the next phase is a human
walking it. `<--build if the run passed it, otherwise: build only if the diff touches the bundle>`.

There is no pre-push hook and no CI in this repo, so the push is instant and the PR will sit with
no checks. That is expected; do not wait for any.

Run `/check-constraints`. A BLOCK is not overridable: set `status: \"blocked\"` with the findings
and stop. Same for a `/critique` BLOCK verdict. The PR body must carry a literal
`NOT VERIFIED IN OBSIDIAN` line, since nothing has driven the real plugin yet. Record `prNumber`,
`prUrl`, `commitSha`, set `phase: \"verify\"`, `status: \"awaiting_verify\"`."

**5. Verify** - **this phase is always a pause.** Do not spawn a subagent to decide it.

The orchestrating conversation does this itself:

```bash
npm run deploy
```

Then tell the user precisely what to do in Obsidian and wait. Derive the steps from the ticket's
acceptance criteria, and always include the baseline: open a note, trigger `Read this note aloud`,
confirm speech starts, confirm the highlight follows the words, confirm pause and stop behave.
Remind them to reload the plugin, since `npm run deploy` does not.

Record their answer verbatim into `obsidianNotes` and set `obsidianVerdict` to `pass` or `fail`.
On `fail`, set `status: \"blocked\"` with their description and stop the ticket; do not attempt a
second fix inside the same phase without asking. On `pass`, post a Linear comment through
`create_comment` that states separately that the suites passed and that the change was observed
working in Obsidian, then set `phase: \"merge\"`.

**6. Merge** - default is a pause. Print the PR URL and wait for the user to merge, then confirm
with `gh pr view <prNumber> --json state,mergedAt`.

With `--auto-merge`, and only when `obsidianVerdict` is `pass`:

```bash
gh pr merge <prNumber> --squash --delete-branch
```

Never auto-merge a ticket whose Verify phase did not record a pass, and never self-approve a PR to
get around a review requirement. Set `phase: \"finish\"`.

**7. Finish** - "Read `.claude/commands/finish.md` and follow it for the merged branch `<branch>`
in `<repo-root>`. Verify the merge by content, not just by branch state: this repo may squash, so
`git branch -d` can claim 'not merged' for work that is fully in `main`. Grep `main` for a
distinctive symbol the PR added before deleting, and use `-D` only once content is confirmed. Set
the Linear status to Done by reading `list_issue_statuses` rather than a remembered id, and read
the status back. Then check whether this ticket removed one of the nine defects listed in the
`AGENTS.md` Known state section, or moved a requirement's status in `srs.md`; if so, update that
document in the same pass. Set `phase: \"finish\"`, `status: \"done\"`."

## Pauses - ask and wait, never guess past these

A pause is not a failure. Stop before the next phase, ask here, wait, record the answer, continue.
The run stays parked on the current ticket.

- Phase 0, or Plan as fallback, judges a ticket complex or needing decomposition
- **The Verify gate on every single ticket.** Structural, not a flag
- The merge gate, unless `--auto-merge` was passed and Verify recorded a pass
- A bug that cannot be reproduced
- A `check-constraints` BLOCK or a `critique` BLOCK
- A regression test that passes against the unfixed code, meaning it proves nothing
- A ticket needing hardware this machine lacks, most likely an Android device for R-M03
- A ticket that turns out to require amending `srs.md`, which needs an ADR and your agreement
- A branch or issue collision that `start-issue.md` flags

`--resume` is for the session ending, not for any of the above. While the conversation is live,
every pause resolves by answering in the next message.

## Example usage

```
/run-tickets NRL-19,NRL-20,NRL-21
```
Three reproduced markdown defects in `extract.ts`. Phase 0 skips the repro questions because all
three are in the Known state list; each ticket then runs 1 to 7, pausing at its Verify gate.

```
/run-tickets NRL-30 --build
```
A ticket touching the Kokoro worker, so the bundle gate runs every Ship phase.

```
/run-tickets all --auto-merge
```
Everything assigned and open. Still pauses once per ticket to listen to Obsidian; merges itself
afterwards.

```
/run-tickets --resume
```
Continues the run recorded in `.claude/pipeline-state.json`.

## Error handling

| Scenario | Action |
|---|---|
| No Linear tool in the available list | Continue git-only. Print the status transitions and comments that would have been sent, and record them in the state file. Never block a commit on a missing tracker. |
| A Linear status write appears to succeed but reads back wrong | Stop. Re-fetch `list_issue_statuses` and report before retrying. Do not trust a remembered status id. |
| `npm test` fails at an early suite | Remember the `&&` chain hides later suites. Re-run the remaining ones individually before concluding anything about scope. |
| `tests/engine.test.ts` fails | It shells out to real `espeak-ng` and `spd-say`. Check the binaries before assuming the code broke. |
| Deploy succeeds but Obsidian shows no change | The plugin was probably not reloaded. Ask before investigating further. |
| State file has an `in_progress` ticket and no `--resume` | Ask before overwriting: resume, or start fresh, which orphans the in-flight branch and PR. Say that explicitly. |
| `gh` auth expires mid-run | Report which step failed. Do not silently skip the ticket. |
| A phase needs a decision not covered above | Pause, ask, wait. |

## Configuration

| Setting | Value |
|---|---|
| **Repo root** | `git rev-parse --show-toplevel` |
| **Base branch** | `main` (only branch; PRs target it) |
| **Remote** | `git@github.com:JoshShearer/Note-Reader-Local.git` |
| **Tracker** | Linear workspace `note-reader-local`, MCP server `linear-nrl`, team key UNVERIFIED |
| **Gates** | `npm test` · `npm run typecheck` · `npm run build` when the bundle moved |
| **CI** | None. Nothing to poll. |
| **Push gate** | None. No husky, no active git hooks. |
| **Human gate** | Obsidian verification, once per ticket, always |
