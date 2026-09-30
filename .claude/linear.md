# Linear conventions - Local TTS Reader

Single source of truth for how the `/`-commands talk to Linear. Every command in
`.claude/commands/` refers here instead of restating it, so a status rename is one edit.

## Account

**Verified 2026-09-28** by running the discovery block below. Nothing here is assumed.

| Setting | Value |
|---|---|
| **Workspace** | `Note-Reader-Local` - <https://linear.app/note-reader-local> |
| **Workspace id** | `c6a08f34-8be8-4124-950c-a7d5aafffb69` |
| **Team** | `Note-Reader-Local` |
| **Team id** | `8e4bda9f-f4d8-443c-8ff4-a169018366cf` |
| **Team key** | `NRL` |
| **MCP server** | `linear-nrl` (see `.mcp.json` and `opencode.json`) |
| **Issue IDs** | Commands accept `NRL-12`, `nrl-12`, or bare `12`. |

The server is named `linear-nrl` rather than `linear` so it stays distinguishable from the
global `linear` server and from `linear-jr` in job-radar. MCP config is per-project, but
tool names show up in transcripts and an ambiguous `save_issue` in a log is worth avoiding.

> **On the team key.** Linear auto-derived `NOT` from the team name "Note-Reader-Local",
> which makes issues read `NOT-19` and branches read `fix/not-19-...`. It was changed to
> `NRL` in Settings > Team > General > Identifier, which rewrites existing issue ids. If a
> lookup ever fails with an unknown-identifier error, re-run discovery: someone may have
> changed it back.

### Tool names differ by runtime

The **operations** are identical; only the prefix changes. Both shapes below were observed
directly, not inferred.

| Runtime | Shape | Example |
|---|---|---|
| Claude Code | `mcp__linear-nrl__<operation>` | `mcp__linear-nrl__get_issue` |
| opencode | `mcp_Linear-nrl_<operation>` | `mcp_Linear-nrl_get_issue` |

Note the casing: opencode title-cases the server name and uses single underscores, Claude
Code lowercases it and uses double underscores. That is exactly the kind of difference that
breaks a hardcoded string.

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

**Verified 2026-09-28** via `list_issue_statuses`. These are Linear's default six, with the
team's real status ids, which are what a transition actually needs.

| Status | Type | Id |
|---|---|---|
| `Backlog` | backlog | `0332342b-8c91-4745-a764-0c78bb57d558` |
| `Todo` | unstarted | `8130d105-155a-4acb-bae2-ff6d838ff174` |
| `In Progress` | started | `1d678ae1-6980-4e89-9eb9-80a0eb1ca355` |
| `Done` | completed | `5734df62-bb4c-404a-90f2-622c5f509c76` |
| `Canceled` | canceled | `e153e1af-c8bd-42aa-9d90-02bf6e845092` |
| `Duplicate` | duplicate | `c98e6667-6c4a-4c0d-b3d4-2ff43493b7b2` |

Prefer resolving a status by name at call time over pasting an id from this table. Ids are
recorded so a mismatch is debuggable, not so they can be hardcoded.

### There is no `In Review`, confirmed

The team uses Linear's default six states, and none of them is `In Review`. This is not a
hypothetical: `/ship` would set a status that does not exist and `/verify` would filter on it
and find nothing.

**Rule for every command:** treat `In Review` as optional.

- If a status named `In Review` exists, `/ship` moves the issue there and `/verify` expects it.
- It does not exist today, so `/ship` leaves the issue **In Progress** and posts the PR link as
  a comment. The open PR is the review signal, and `/verify` accepts **In Progress with an open
  PR** as the pre-merge state.

Adding an `In Review` state in Linear restores the intended flow with no command edits. The
fallback is conditional, not hardcoded.

## Labels

**Verified 2026-09-28** via `list_issue_labels`. That is the entire set; there are no area
labels, no `Chore`, no `Documentation`.

| Label | Color | Id |
|---|---|---|
| `Bug` | `#EB5757` | `cfe31867-9a02-4d81-924e-a18853a6f6bd` |
| `Feature` | `#BB87FC` | `c892b0f2-5e7d-49d8-8842-2d2a9db81795` |
| `Improvement` | `#4EA7FC` | `8ceb69d9-2972-4375-b9a1-24e34d1b0204` |

| Issue type | Label to apply |
|---|---|
| feature | `Feature` |
| bug | `Bug` |
| tech-debt | `Improvement` |
| spec gap | `Improvement` |
| blocker | none (priority Urgent carries it) |

Apply only a label from the table above, or none. Area is carried by the commit scope
(`fix(extract): …`) and the branch name rather than by a label.

### Requirement IDs instead of area labels

This project has a written spec. An issue that closes a gap against `srs.md` should name the
requirement in its title or description: `R-M06`, `R-M12`, `R-C02`. That is more precise
than any label set, and `/spec-check` reads it.

## Re-running discovery

```
get_workspace          → workspace name, id and url
list_teams             → team name and id
get_team <id>          → the same fields again
list_issue_statuses    → statuses and their ids
list_issue_labels      → label set
list_issues            → read the KEY off an issue identifier
```

**Neither `list_teams` nor `get_team` returns the team key.** They give the name and the
UUID only. The key is only visible as the prefix of an issue identifier, so the last call is
the one that answers it:

```
list_issues → "NRL-4" → the key is NRL
```

On a brand-new workspace the only issues are Linear's four onboarding tickets, which is
enough. If the team genuinely has no issues, create one, read its identifier, and delete it.

After re-running, update the tables above and the dates on the "Verified" lines.

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
npm test          # suite list: package.json pretest and test scripts
npm run typecheck # tsc --noEmit --skipLibCheck
npm run build     # required if the bundle, worker or esbuild config moved
```

A green suite is not a claim that something works. The change must also be exercised in a
real Obsidian via `npm run deploy`. `/verify` enforces that.

## Degradation

If the `linear-nrl` server is not connected, every command still does its git work and
prints what it *would* have sent to Linear as a table for manual entry. A missing ticketing
system is never a reason to block a commit.
