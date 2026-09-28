# Linear conventions - Local TTS Reader

Single source of truth for how the `/`-commands talk to Linear. Every command in
`.claude/commands/` refers here instead of restating it, so a status rename is one edit.

## Account

| Setting | Value |
|---|---|
| **Workspace** | `note-reader-local` - <https://linear.app/note-reader-local> |
| **Team** | **UNVERIFIED** - run the discovery block below before trusting anything here |
| **MCP server** | `linear-nrl` (see `.mcp.json` and `opencode.json`) |
| **Issue IDs** | Commands accept `NRL-12`, `nrl-12`, or bare `12`. Replace the prefix once discovery confirms the real team key. |

The server is named `linear-nrl` rather than `linear` so it stays distinguishable from the
global `linear` server and from `linear-jr` in job-radar. MCP config is per-project, but
tool names show up in transcripts and an ambiguous `save_issue` in a log is worth avoiding.

### Tool names differ by runtime

The **operations** are identical; only the prefix changes.

| Runtime | Shape | Example |
|---|---|---|
| Claude Code | `mcp__linear-nrl__<operation>` | `mcp__linear-nrl__get_issue` |
| opencode | opencode's own MCP naming for the `linear-nrl` server | check your tool list |

**Do not hardcode a prefix.** Look up the actual name in your available tools and use the
operation names below (`get_issue`, `list_issues`, `save_issue`, `create_comment`,
`list_teams`, `list_issue_statuses`, `list_issue_labels`, `get_workspace`). If no Linear
tool is present at all, follow the degradation rule at the bottom of this file.

## First-run setup

The remote server uses OAuth. Before any Linear-touching command works:

- **Claude Code** - run `/mcp`, pick `linear-nrl`, complete the browser flow.
- **opencode** - restart opencode so it picks up `opencode.json`, then authenticate the
  `linear-nrl` server when prompted.

Until that is done every command degrades to git-only and prints what it would have sent.

## Statuses

**UNVERIFIED.** The table below is Linear's default set, not a reading of this workspace.
Run the discovery block and correct it - everything downstream reads from here.

| Status | Type |
|---|---|
| `Backlog` | backlog |
| `Todo` | unstarted |
| `In Progress` | started |
| `Done` | completed |
| `Canceled` | canceled |
| `Duplicate` | duplicate |

### Treat `In Review` as optional

Linear's default six states do not include one, and a command that sets a status which does
not exist will fail.

- If a status named `In Review` exists, `/ship` moves the issue there and `/verify` expects it.
- If it does not, `/ship` leaves the issue **In Progress** and posts the PR link as a comment.
  The open PR is the review signal, and `/verify` accepts **In Progress with an open PR** as
  the pre-merge state.

## Labels

**UNVERIFIED.** Defaults assumed until discovery says otherwise.

| Issue type | Label to apply |
|---|---|
| feature | `Feature` |
| bug | `Bug` |
| tech-debt | `Improvement` |
| spec gap | `Improvement` |
| blocker | none (priority Urgent carries it) |

Apply only a label confirmed to exist, or none. Area is carried by the commit scope
(`fix(extract): …`) and the branch name rather than by a label.

### Requirement IDs instead of area labels

This project has a written spec. An issue that closes a gap against `srs.md` should name the
requirement in its title or description: `R-M06`, `R-M12`, `R-C02`. That is more precise
than any label set, and `/spec-check` reads it.

## Re-running discovery

```
get_workspace          → workspace name and url
list_teams             → team id, name and KEY        ← the missing piece
list_issue_statuses    → statuses for the team
list_issue_labels      → label set
```

Update the tables above and the issue-ID prefix, then delete the UNVERIFIED markers.

## Issue URLs

**Use the `url` field the MCP returns** on `get_issue` / `save_issue` rather than building
one. Linear appends a title slug and rewrites the path when an issue moves team, so a
hand-built URL is correct only until it isn't.

## Branch naming

| Kind | Pattern | Example |
|---|---|---|
| Feature | `feature/nrl-{N}-{slug}` | `feature/nrl-12-read-from-cursor` |
| Fix | `fix/nrl-{N}-{slug}` | `fix/nrl-19-wikilink-brackets` |

Slug: lowercase issue title, non-alphanumerics to `-`, truncated near 50 chars.

## Worktrees

Worktrees are siblings of the primary repo, named `note-reader-local-nrl-{N}`:

```
~/Documents/Dev/
├── note-reader-local/          ← primary workspace
├── note-reader-local-nrl-12/   ← worktree for NRL-12
└── note-reader-local-nrl-19/   ← worktree for NRL-19
```

**Lane rule (from the global CLAUDE.md):** this pool is for interactive feature work only.
`treehouse` owns the gnhf / parallel-agent pool. Never point both at the same directory.

A fresh worktree has no `node_modules`; run `npm ci` before the gates mean anything.

**A worktree cannot be deployed into Obsidian at the same time as another.** `npm run deploy`
writes to one fixed plugin folder in `~/Documents/Notes`. Only one worktree at a time may
hold the deployed build, and whoever deploys should say so.

## Quality gates

No CI, no lint script. Full detail in `AGENTS.md`; the short version:

```bash
npm test          # 5 suites
npm run typecheck # tsc --noEmit --skipLibCheck
npm run build     # required if the bundle, worker or esbuild config moved
```

A green suite is not a claim that something works. The change must also be exercised in a
real Obsidian via `npm run deploy`. `/verify` enforces that.

## Degradation

If the `linear-nrl` server is not connected, every command still does its git work and
prints what it *would* have sent to Linear as a table for manual entry. A missing ticketing
system is never a reason to block a commit.
