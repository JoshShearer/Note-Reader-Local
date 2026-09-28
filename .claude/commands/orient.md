---
description: Start a session - report git state, sync with origin, check whether the deployed Obsidian build is stale, pull Linear issues, and name the next action.
---

Conventions: `.claude/linear.md`. Rules and gates: `AGENTS.md`. Architecture: `CONTEXT.md`.

This command reads and reports. The only things it is allowed to change are: a fast-forward
pull, a stash/pop around a pull on `main`, and `npm ci` in a worktree with no `node_modules`.
It never rebases, never deploys, and never touches Linear state.

## Linear tool names

Operations used here: `list_issues`, `get_issue`. **Do not hardcode a tool prefix.** Find the
real names for the `linear-nrl` server in your available tool list and call those. If no Linear
tool is present, follow the degradation rule in `.claude/linear.md`: give a git-only
orientation and say Linear was unreachable.

## Parallelism

Two independent lanes. Start them together, then synthesize in Step 7.

1. **Bash lane**: Steps 0, 1, 2, 4, 5
2. **Linear lane**: Step 3

## Step 0: Detect where you are

```bash
CURRENT_DIR="$(basename "$(pwd)")"
if [[ "$CURRENT_DIR" =~ ^note-reader-local-nrl-([0-9]+)$ ]]; then
  echo "SESSION_TYPE=worktree"
  echo "ISSUE_NUM=${BASH_REMATCH[1]}"
else
  echo "SESSION_TYPE=primary"
fi
ls node_modules/.package-lock.json >/dev/null 2>&1 || echo "NODE_MODULES=missing"
```

**worktree**: condensed report. Skip Step 2 (sibling scan). In Step 3 fetch only `NRL-{ISSUE_NUM}`.
If `NODE_MODULES=missing`, say so loudly and run `npm ci` before claiming any gate result: a
fresh worktree cannot run `npm test`, and a failure there means nothing.

**primary**: full report.

## Step 1: Git state

```bash
git fetch origin --prune && \
echo "BRANCH=$(git branch --show-current)" && \
git status --short && \
echo "SYNC(behind ahead)=$(git rev-list --left-right --count origin/main...HEAD 2>/dev/null || echo '? ?')" && \
git log --oneline -5 && \
echo "=== UNPUSHED ===" && \
(git log --oneline @{u}..HEAD 2>/dev/null || echo "no upstream") && \
echo "=== STALE ===" && \
(git branch -vv | grep '\[.*: gone\]' || echo "none")
```

Baseline for sanity: this repo started life as a single commit on `main`, remote `origin` is
`git@github.com:JoshShearer/Note-Reader-Local.git`. If `git log` shows one commit and no
branches, that is the expected starting state, not a broken clone.

Open PRs, if `gh` is available:

```bash
gh pr list --state open --json number,title,headRefName,isDraft 2>/dev/null || echo "gh unavailable"
```

`gh` failing is not an error worth stopping for. Report "PR state unknown" and continue.

## Step 2: Sibling worktrees (primary session only)

```bash
ROOT="$HOME/Documents/Dev/note-reader-local"
shopt -s nullglob
for dir in "${ROOT}"-nrl-*/; do
  [ -d "$dir/.git" ] || continue
  NUM=$(basename "$dir" | grep -oE '[0-9]+$')
  BRANCH=$(git -C "$dir" branch --show-current 2>/dev/null || echo detached)
  DIRTY=$(git -C "$dir" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  AHEAD=$(git -C "$dir" rev-list --count origin/main..HEAD 2>/dev/null || echo '?')
  DEPS=$([ -d "$dir/node_modules" ] && echo ok || echo MISSING)
  echo "NRL-$NUM branch=$BRANCH ahead=$AHEAD dirty=$DIRTY deps=$DEPS"
done
echo "=== END WORKTREES ==="
```

Only `note-reader-local-nrl-*` siblings belong to this pool. A worktree with any other name is
`treehouse` / gnhf territory: report it if you see it, do not read into it and never touch it.

## Step 3: Linear issues (parallel with the bash lane)

`list_issues` with `assignee: "me"`:

1. `state: "In Progress"`
2. `state: "Todo"`, limit 5

The team's status set is marked **UNVERIFIED** in `.claude/linear.md`, and `In Review` may not
exist. Do not query it blind. Instead, split the In Progress results by whether an open PR
exists for the branch (`gh pr list --head feature/nrl-{N}-* --state open`) and report those
under an **In Review** heading. If `list_issue_statuses` shows a real `In Review`, query it
directly and say so, so the conventions file can be corrected.

**Worktree variant**: `get_issue` with `id: "NRL-{ISSUE_NUM}"` only.

If a returned issue title or description carries a requirement ID (`R-M06`, `R-S02`, `R-C04`),
carry it into the report. That ID is the acceptance criteria and it lives in `srs.md`.

## Step 4: Is the deployed Obsidian build stale?

This is the check that stops the most wasted time in this repo. `npm run deploy` writes to one
fixed folder, `~/Documents/Notes/.obsidian/plugins/local-tts-reader`, so the build a running
Obsidian is executing may belong to a different branch or a different worktree entirely.

```bash
DEST="$HOME/Documents/Notes/.obsidian/plugins/local-tts-reader"
if [ ! -f "$DEST/main.js" ]; then
  echo "DEPLOY=none (plugin never deployed to this vault)"
else
  echo "DEPLOY_MTIME=$(stat -c '%y' "$DEST/main.js")"
  if [ -f main.js ] && cmp -s main.js "$DEST/main.js"; then
    echo "DEPLOY_OWNER=this-tree"
  else
    echo "DEPLOY_OWNER=other-tree-or-older-build"
  fi
  NEWER=$(find src manifest.json styles.css esbuild.config.mjs -newer "$DEST/main.js" 2>/dev/null | head -5)
  [ -n "$NEWER" ] && { echo "DEPLOY=STALE, newer sources:"; echo "$NEWER"; } || echo "DEPLOY=current vs this tree"
fi
```

| Result | What to report |
|---|---|
| `DEPLOY=none` | Nothing has been deployed. Any claim that a change works is unverified. |
| `DEPLOY_OWNER=other-tree-or-older-build` | Obsidian is running someone else's build. Whoever deploys next takes the single slot; say which issue currently holds it. |
| `DEPLOY=STALE` | The vault build predates the working tree. `npm run deploy` and reload Obsidian before testing anything. |
| `DEPLOY=current vs this tree` | The vault matches this tree's last build. Still not proof it works. |

Do **not** run `npm run deploy` from `/orient`. Deploying takes the shared slot from whatever
worktree currently holds it, and that is the user's call.

## Step 5: Sync

| Branch | Tree | vs upstream | Action |
|---|---|---|---|
| main | clean | behind | `git pull --ff-only` |
| main | dirty | behind | `git stash push -u -m orient-autostash-<ts>` then `git pull --ff-only` then `git stash pop`. On pop conflict, leave the stash and surface its name. |
| feature/* or fix/* | clean | behind its own upstream | `git pull --ff-only` |
| feature/* or fix/* | dirty | behind | Skip with a warning. WIP is not worth the risk. |
| any | any | no upstream | Skip silently |
| any | any | up to date | Report "up to date" |

**Never auto-rebase a feature branch onto main.** Report the `behind main` count and let the
user ask for it.

If the lockfile moved under you, deps are stale and the gates are meaningless:

```bash
git diff HEAD@{1} HEAD -- package-lock.json package.json 2>/dev/null | head -1
```

Non-empty → run `npm ci` and report the tail of its output. Failure there is worth reporting
but not worth stopping the orientation.

## Step 6: Hazards for what the user is about to touch

Work out the likely target area from the branch name, the In Progress issue, and any
uncommitted files in `git status`. Then surface **only** the matching rows. `AGENTS.md` holds
the authoritative text; these are pointers, not replacements.

| If the area is | Surface |
|---|---|
| `src/text/extract.ts` | **Known defects**: speaks `[` and `]` for wikilinks, loses embed content, returns **zero chunks** when line 1 is `---` because a horizontal rule is parsed as frontmatter. `ExtractOptions.skipCode` and `.skipUrls` are wired from settings and rendered as toggles but never read. **Non-negotiable 8**: every dropped span still pushes a `sourceIndex` entry, or highlighting silently corrupts. |
| `src/audio/player.ts` | **Known defects**: `replayCurrent` truncates the chunk array and resets the index, corrupting `n / total`. `primeBuffer` prefetches against engines where `synthesize()` *is* speaking, so speechd and webspeech overlap. Pause is a no-op on both: it pauses an `<audio>` element they never use. **Non-negotiable 9**: rate is applied exactly once, by the player or by an `ownsPlayback` engine, never both. |
| `src/engines/system/speechd.ts` | **Known defect**: malformed `-y` / `-t` voice args, and `spd-say` prints `Invalid voice` on **stdout with exit 0** while the guard reads stderr, so it fails silently. **Non-negotiable 2**: text goes in on stdin, never argv. |
| `src/engines/system/espeak.ts`, `spawn.ts` | **Non-negotiable 2** (stdin, not argv) and **7** (`child_process` stays type-only plus dynamic `await import()` inside method bodies). |
| `src/engines/onnx/kokoro.worker.ts` | **Non-negotiables 5 and 6**: `isRemote` + `assertLocal` stay. If a load path breaks, fix the path, not the guard. Nothing fetches on load or prewarm. |
| `src/settings/index.ts`, `src/ui/settingsTab.ts` | **Non-negotiable 10**: `normaliseSettings` must not drop keys it does not recognise. Plugin data holds reading positions too, and a whitelist rebuild erases them on the next rate nudge. |
| `src/diagnostics.ts` or any new logging | **Non-negotiable 1**: counts, ids and durations only. Never interpolate note, chunk or selection text, not even into an error message. |
| `manifest.json`, `package.json`, `esbuild.config.mjs` | **Non-negotiable 7**: after any dependency change, check `main.js`'s `require()` list contains only `obsidian`, `@codemirror/view`, `@codemirror/state`. |

## Step 7: Output

```
## Session Orientation

Context: {primary | worktree NRL-N}

### Repo State
| Branch | Clean | Sync vs origin/main | Unpushed | Deps |
|--------|-------|---------------------|----------|------|
| main | Yes | up to date | 0 | ok |

{if uncommitted changes, list them here, before anything else:}
### Uncommitted changes
| File | Status |
|------|--------|
| src/text/extract.ts | M |

### Deployed Obsidian Build
| Vault | Owner | Freshness |
|-------|-------|-----------|
| ~/Documents/Notes | this tree | STALE - 3 sources newer than the deploy |

> Deploy slot is single. Run `npm run deploy` then reload Obsidian before trusting a manual test.

### Linear
**In Progress:**
- NRL-12: Read from cursor (R-M08) <- this branch

**In Review (open PR, no In Review status on this team):**
- NRL-9: Wikilink brackets (R-M02) - PR #3

**Todo:**
- NRL-14: speechd voice args (R-M05)

### Active Worktrees {omit if none}
| Issue | Branch | Ahead | Dirty | Deps |
|-------|--------|-------|-------|------|
| NRL-12 | fix/nrl-12-wikilinks | 2 | No | ok |

### Hazards for this work {omit if no area is identifiable}
- extract.ts: sourceIndex lockstep (AGENTS.md non-negotiable 8)
- extract.ts: known defect, `---` on line 1 yields zero chunks

### Housekeeping {omit if nothing found}
| Stale branch | Action |
|--------------|--------|
| fix/nrl-9-wikilinks | `/finish fix/nrl-9-wikilinks` |

### Next action
{one sentence, one command}
```

The next action is one line and one command. Candidates, in priority order:

1. Merge conflicts or a dirty tree blocking work → resolve that first, nothing else.
2. On a `feature/nrl-N-*` or `fix/nrl-N-*` branch → `/start-issue NRL-N` to resume.
3. An open PR with green gates → review it, merge, then `/finish`.
4. Clean `main` with Todo issues → `/start-issue NRL-N` for the top one.
5. Clean `main`, nothing assigned → report that, and point at the `srs.md` gap (an audit found
   2 of 16 MUST requirements fully met; the rest is tracked in Linear).

## Error handling

| Scenario | Action |
|---|---|
| `git fetch` fails | Warn about the network, orient from local state |
| `git pull --ff-only` rejected | Skip, report `behind`, let the user rebase explicitly |
| `git stash pop` conflicts | Leave the stash, print its name |
| Merge conflicts in the tree | Stop. That is the whole report. |
| Linear tools absent or unauthenticated | Git-only orientation, say so, point at the first-run setup in `.claude/linear.md` |
| `gh` missing or unauthenticated | Report "PR state unknown", skip the In Review split |
| `npm ci` fails | Report the error, flag every gate result as untrustworthy |
| Vault folder missing | Report `DEPLOY=none`; do not create it |
