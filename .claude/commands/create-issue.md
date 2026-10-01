---
description: Create a Linear issue for Local TTS Reader from the current conversation, carrying the srs.md requirement ID and, for bugs, a real reproduction.
---

Create a Linear issue from what we have been working on.

Conventions: `.claude/linear.md`.

Argument: `$ARGUMENTS` (optional) - one of `bug`, `feature`, `tech-debt`, `spec-gap`, or omitted to infer from the conversation.

## Linear tool naming

Do not hardcode an MCP tool prefix. The operations are `get_issue`, `list_issues`,
`save_issue`, `save_comment`, `list_teams`, `list_issue_statuses`, `list_issue_labels`,
`get_workspace`. Find the real prefixed names in your available tool list and call those.
If no Linear tool is present, skip to the Degradation section at the bottom and print the
issue instead of creating it.

The team key is `NRL`, verified on 2026-09-28. If a lookup rejects that prefix the team was
renamed: run `list_issues`, read the key off an identifier, and say so in your output so
`.claude/linear.md` can be corrected.

## Step 1: Type

| `$ARGUMENTS` | Meaning | Label (see `.claude/linear.md`) | Default priority |
|---|---|---|---|
| `bug` | Shipped behaviour is wrong | `Bug` | High (2) |
| `feature` | Capability that does not exist | `Feature` | Normal (3) |
| `tech-debt` | Works, but the structure is wrong | `Improvement` | Low (4) |
| `spec-gap` | `srs.md` demands it and the code does not do it | `Improvement` | Normal (3) |
| omitted | Infer, then state which you chose and why | varies | varies |

Verified on 2026-09-28, the label set is exactly `Bug`, `Feature` and `Improvement`. There
are no area labels. Apply one from that set or none. Never create a label; that is a change
to a shared workspace and is the user's call.

`spec-gap` is the type this repo will use most. The `srs.md` audit found 2 of 16 MUST
requirements fully met, so the majority of open work is a gap against the written spec
rather than a regression.

## Step 2: Requirement ID

**Ask for or infer the `srs.md` requirement ID.** IDs run `R-M01` through `R-M16`,
`R-S01` through `R-S06`, `R-C01` through `R-C05`. The Requirements section of `srs.md`
starts at line 94.

- If the work closes a gap against a requirement, put the ID in the **title** as a
  trailing tag and in the `## Requirement` body section: `Read from cursor (R-M06)`.
- If it maps to more than one, list all of them in the body and put the primary one in
  the title.
- If it maps to none, write `None` in the `## Requirement` section and say in one line why
  the work is worth doing anyway. Do not invent an ID, and do not stretch a requirement to
  cover unrelated work.
- If the work **contradicts** `srs.md`, that is allowed but not silently. Say so in the
  issue and note that closing it requires an ADR in `docs/adr/` plus an amendment to
  `srs.md`. Note that `docs/` does not currently exist, so the first ADR creates it.

`/spec-check` reads these IDs. An issue without one is invisible to it.

## Step 3: Reproduction (bugs only, and it is mandatory)

`AGENTS.md` rule 12 requires a bug be reproduced end to end before it is fixed. The issue
must therefore carry the repro, so the next session does not have to rediscover it.

A reproduction in this repo is one of:

- **A markdown input plus observed output.** Bundle the module and run it against real
  input rather than reasoning about it. Example shape:

  ```bash
  node build-tests.mjs tests/extract.test.ts   # bundles src/ into tests/.build/
  ```

  Then drive the bundled module from a small node script and paste the actual output.

- **A real Obsidian session.** `npm run deploy` writes the build into
  `~/Documents/Notes/.obsidian/plugins/local-tts-reader`. Reload the plugin, run the
  command, record what happened. Obsidian here is the Flatpak `md.obsidian.Obsidian` (`flatpak list --app`; `which obsidian` finds nothing, checked 2026-10-01 under NRL-138).

- **A real binary.** `spd-say` is on this machine and a speech-dispatcher daemon is running;
  `tests/engine.test.ts` shells out to that binary. `espeak-ng` is **not** installed here - it
  exists only as a speech-dispatcher output module plus its library and data (`which espeak-ng`
  finds nothing) - so there is no real-binary path for that engine, and `AGENTS.md`'s
  quality-gates block is the one place that detail lives. Paste the
  exact command and its exact output, including which stream it appeared on. That detail
  matters: `spd-say` reports `Invalid voice` on **stdout with exit 0**, which is why one
  existing defect is silent.

If the conversation never actually ran the failing path, write that sentence verbatim into
the issue under `## Reproduction`:

```
NOT REPRODUCED. Suspected from code reading only, at <file>:<line>. Reproduce before fixing.
```

Do not invent plausible steps. A fabricated repro is worse than an honest gap, because the
next session will trust it.

Check the **Known state** list in `AGENTS.md` before filing. Six defects are already
reproduced and documented there (wikilink brackets, lost embeds, zero chunks when line 1 is
`---`, unread `skipCode`/`skipUrls`, malformed speechd voice args, `replayCurrent`
truncation, `primeBuffer` overlap, pause being a no-op on speechd and webspeech). If this
is one of them, link the existing Linear issue instead of filing a duplicate. Use
`list_issues` to look first.

## Step 4: Constraints that must travel with the ticket

Add a `## Constraints` section naming any non-negotiable from `AGENTS.md` the work touches.
Breaking one of these is a BLOCK, not a concern, and the constraint is far cheaper to state
now than to catch in review.

| Area touched | Constraint to name in the issue |
|---|---|
| `src/text/extract.ts` | `sourceIndex` stays in lockstep; every dropped span still pushes an index entry (rule 8) |
| `src/audio/player.ts` | Playback rate is applied exactly once; `ownsPlayback` engines get the rate, everything else does not (rule 9) |
| `src/diagnostics.ts` or any `trace()` call site | No note text in any log, ever. Counts, ids and durations only (rule 1) |
| `src/engines/system/` | Speech text goes to subprocesses on stdin, never argv (rule 2) |
| `src/engines/onnx/kokoro.worker.ts` | `isRemote` and `assertLocal` stay. Fix the path, not the guard (rule 5) |
| `src/settings/index.ts` | `normaliseSettings()` must not drop unrecognised keys; plugin data holds reading positions too (rule 10) |
| Any new import, or a dependency change | `manifest.json` is `isDesktopOnly: false`. Re-check `main.js`'s `require()` list: only `obsidian`, `@codemirror/view`, `@codemirror/state`, plus `child_process` as a call-time `require` in `src/engines/system/spawn.ts` only (ADR 0033), and no `import()` of any builtin (rule 7) |
| Anything that downloads | Every byte is user-initiated. No fetch on load, on prewarm, or on first read (rule 6) |
| Any performance claim in the issue | Rule 13: you measured it this session, or you cite where it was measured |

## Step 5: Body template

```markdown
## Context

What prompted this, in two or three sentences. Where it was noticed. Which engine
(`kokoro`, `espeak`, `speechd`, `webspeech`) and which platform, if that matters.

## Reproduction

(Bugs only. Mandatory. Exact commands and exact observed output, or the literal
"NOT REPRODUCED" line from Step 3.)

## Requirement

R-Mxx - one-line restatement of what srs.md line NNN actually demands.
Or: None. <why this is worth doing anyway>

## Acceptance criteria

- [ ] Observable outcome, not an implementation step
- [ ] Which gate proves it: `npm test`, `npm run typecheck`, `npm run build`
- [ ] What must be seen in real Obsidian after `npm run deploy`, if the change is
      user-facing. A green unit suite is not proof (AGENTS.md rule 11)

## Constraints

(From the Step 4 table. Omit the section only if genuinely nothing applies.)

## Out of scope

What this issue deliberately does not do, so it does not grow. Name the follow-up
requirement IDs that stay open.
```

## Step 6: Confirm

Print title, type, label, priority, requirement ID, and whether a reproduction is
attached. Wait for a yes before calling `save_issue`.

If the type is `bug` and there is no reproduction and no explicit NOT REPRODUCED line,
say so and ask whether to reproduce it first. Do not file it quietly.

## Step 7: Create and report

Call `save_issue`. Use the `url` field from the response; do not construct a URL, because
Linear appends a title slug and rewrites the path when an issue moves team.

```
Issue created: NRL-{id}
Title:         {title}
Type:          {bug|feature|tech-debt|spec-gap}
Requirement:   {R-Mxx | none}
Reproduced:    {yes | no, NOT REPRODUCED noted in body}

URL: {url from the response}

Branch: fix/nrl-{id}-{slug}      (or feature/nrl-{id}-{slug})
Worktree, if you want one: ~/Documents/Dev/note-reader-local-nrl-{id}
```

Remind the user that a fresh worktree has no `node_modules`, so `npm ci` runs before any
gate means anything, and that only one worktree at a time may hold the deployed build,
since `npm run deploy` writes to one fixed plugin folder.

## Degradation

If no Linear tool is available, print the full issue body exactly as it would have been
sent, plus a table of title, type, label, priority, requirement ID, assignee. Suggest the
branch name anyway. A missing ticket system is never a reason to block work.
