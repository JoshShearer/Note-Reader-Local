# Commands - Local TTS Reader

Adapted from the job-radar workspace, with `/run-tickets` from ShroomSpy. Linear conventions
live in `linear.md`; every command reads from there rather than restating the team key,
statuses, or branch patterns.

**These files work in both Claude Code and opencode.** The canonical copies are in
`.claude/commands/`. `.opencode/command/` holds per-file symlinks to them, so there is one
source of truth and an edit lands in both runtimes at once.

This index lives at `.claude/COMMANDS.md`, not inside `commands/`, so it does not get exposed
as a `/COMMANDS` command.

---

## Workflow (8)

| Command | Purpose | Linear status |
|---|---|---|
| `/orient` | **Start of session** - git state, sync, stale branches, deploy-slot staleness, open issues, next action | - |
| `/create-issue` | Create an issue from conversation, carrying the `srs.md` requirement ID and a real repro | to Todo |
| `/start-issue` | Start work - branch, context, the AGENTS.md rules for the area being touched | to In Progress |
| `/ship` | Gates, constraint audit, adversarial pass, commit, push, PR with an Obsidian test plan | stays In Progress + PR comment |
| `/test-issue` | Triage the PR's CI result - measure whether a red check is this branch's fault, one repair attempt, merge-readiness verdict | - (comments) |
| `/verify` | Run the real gates, deploy, drive Obsidian, post what was actually observed | - (comments) |
| `/finish` | **End of cycle** - delete branch, sync, close, correct any doc the fix invalidated | to Done |
| `/whats-next` | **Session handoff** - decisions, measurements taken, claims still unverified | - |

`/test-issue` and `/verify` are two axes, not two attempts at the same check. `/test-issue` answers
"did GitHub Actions go red, and is it this branch's fault"; `/verify` answers "does it work in
Obsidian" and owns the `VERIFIED IN OBSIDIAN` verdict. `/test-issue` never claims that verdict and
never deploys.

## Quality (4)

| Command | Purpose |
|---|---|
| `/critique` | Adversarial review scored against this codebase's real failure modes; writes a verdict `/ship` reads |
| `/check-constraints` | Mechanical pass over the 14 non-negotiables in `AGENTS.md`; a BLOCK stops `/ship` |
| `/spec-check` | Map the tree against `srs.md` and report what moved from the recorded baseline |
| `/update-docs` | Diff `AGENTS.md`, `srs.md` and `CONTEXT.md` against reality after a merge |

## Orchestration (2)

| Command | Purpose |
|---|---|
| `/worktrees` | Parallel sessions - list, inspect, create, remove; file-overlap and deploy-slot ownership. Owns the `note-reader-local-nrl-*` pool only |
| `/run-tickets` | Run a batch of tickets end to end in fresh subagents, fully autonomously, in a disposable `note-reader-local-run-*` lane it creates and removes; anything needing a human blocks that ticket and is reported at the end |

---

## The normal cycle

```
/orient -> /create-issue -> /start-issue -> ...work... -> /ship -> /verify -> merge -> /finish -> /update-docs
                                                                \
                                                                 -> /test-issue, if the PR's CI went red
```

`/run-tickets` drives that whole loop for a list of issues without you typing each step, minus
`/test-issue`: an unattended run reads a CI conclusion at most once and never waits on one, so it
names any red PR in its end-of-run report and leaves the triage to you.

---

## What differs from the originals

| Difference | Why |
|---|---|
| `/verify` runs the gates itself | `.github/workflows/ci.yml` runs them on `push` and `pull_request`, but there is no git hook and no branch protection, so the check is a backstop. `/verify` may read its conclusion once; it must not wait on it. |
| Every shipping command demands an Obsidian check | `AGENTS.md` rule 11. The suites run in bare Node against fakes, so green says nothing about whether speech works. |
| `/run-tickets` never waits for a human | The owner tests by using the app and files new tickets for what they find. Verify is automated (gates, bundled probes of every acceptance input, CDP smoke when reachable) and merge is automatic. Nothing is ever described as verified in Obsidian unless a human saw it; interactive `/verify` still exists for that. |
| `/run-tickets` works in a worktree it creates and removes | The owner keeps the primary checkout. The lane is `note-reader-local-run-<stamp>` on a throwaway `run/<stamp>` branch cut from `origin/main`, and it is removed at the end **only if nothing would be lost** - a ticket blocked before Ship leaves unpushed commits, and those are kept rather than force-removed. The state file and the archive live in the **primary**, because a state file inside the lane would be deleted by the run's own cleanup. Runs are **parallel**: each has its own lane and its own `pipeline-state.<stamp>.json`, there is no repo-wide lock, and only the single Obsidian deploy slot is serialised, by `deploy.lock`. Give parallel runs disjoint ticket sets. |
| `/test-issue` has no `known-failures.json` | ShroomSpy triages CI against a hand-maintained baseline file. Here the triage is measured: reproduce the failing gate locally, then on `origin/main` in a throwaway tree. The one structural exception is already written down - a red `release.yml` on a branch push is expected for refs predating `01c9a84` (`AGENTS.md`, NRL-79). |
| `/spec-check` is new | This project has a written spec with MoSCoW IDs. Compliance drift is the main risk, and no other repo in the portfolio has that shape. |
| `/critique` risk factors are rewritten | Scored on source-offset edits, log call sites, the worker's network guards, rate handling, settings normalisation and node-builtin imports, not on generic churn. |
| Bugs must be reproduced before they are fixed | `AGENTS.md` rule 12, enforced in `/create-issue` and in `/run-tickets` Phase 3. |
| No `deslop`, no `update-packages` | `deslop` is 3279 lines of React and Firebase patterns that do not apply. Dependency updates here are rare enough to do by hand. |

## Setup

The Linear MCP server is declared twice, once per runtime, both named **`linear-nrl`** and both
pointing at <https://linear.app/note-reader-local>:

- `.mcp.json` for Claude Code
- `opencode.json` for opencode

Authenticate once per runtime before any Linear-touching command works. In Claude Code run
`/mcp`; in opencode restart first so the config is picked up. Until then every command degrades
to git-only and prints what it would have sent.

The workspace, team, statuses and labels were verified on 2026-09-28 and are recorded in
`linear.md`. Two findings from that pass are worth knowing:

- **This team has no `In Review` status.** The conditional fallback in `/ship` and `/verify`
  is load-bearing, not defensive.
- **The team key is `NRL`.** Linear auto-derived `NOT` from the team name; it was renamed.

Tool names are never hardcoded in a command, because the prefix genuinely differs:
`mcp__linear-nrl__get_issue` in Claude Code, `mcp_Linear-nrl_get_issue` in opencode. Commands
name the bare operation and resolve the real tool from the available list at runtime.

Resolving the prefix is not sufficient, and this bit everything: Linear folded its create/update
pairs into `save_*`, so **posting a comment is `save_comment` and `create_comment` no longer
exists**. Every command here named the dead one until 2026-09-30, and because a missing tracker
never blocks a commit, each call failed silently and the run reported success with nothing posted.
When a Linear call will not resolve, check the operation name before blaming the server.

## Running the pipeline without a human

`/run-tickets` promises it never waits. That is a property of how it is launched, not of the file.
`opencode.json` sets `git push *`, `git branch -D *`, `git reset --hard*` and `rm -rf *` to `ask`, and
the pipeline runs all four: Ship pushes, Finish deletes the squash-merged branch with `-D`, the lane is
resynced between tickets with `reset --hard origin/main`, and the deploy lock is released with `rm -rf`.
`git worktree add` and `git worktree remove` match no rule and are not gated, so the lane itself adds
no prompt. Those rules protect every other session in this repo, so the fix is the launch, not the
config:

```bash
opencode run --auto --command run-tickets "NRL-19,NRL-20,NRL-21"
```

In Claude Code the equivalent is a bypass-mode session; the project has no `.claude/settings.json`
and the global one allows only `Bash(npm install:*)`, so an ordinary session prompts the same way.
`--command` and the symlink resolution were verified on opencode 1.18.32.
