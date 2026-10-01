---
description: List, inspect, create and remove the interactive worktree pool, including file-overlap checks and ownership of the single Obsidian deploy slot.
---

Conventions: `.claude/linear.md`. Gates: `AGENTS.md`.

## Lane rule

This command owns the **interactive** pool only: siblings of the primary repo named
`note-reader-local-nrl-{N}`.

`treehouse` owns the gnhf / parallel-agent pool. Never point both at the same directory, and
never create a worktree here for a gnhf run. A sibling directory that does not match
`note-reader-local-nrl-*` is left alone, listed only as "unmanaged".

**`note-reader-local-run-<stamp>` is a `/run-tickets` lane, not unmanaged.** That command creates one
per run and removes it itself at the end, so list it as `run lane` with its branch and whether it is
dirty, and **refuse to remove it**: if a run is live, removing its checkout destroys the tickets in
flight, and if the lane outlived its run, it is on disk precisely because cleanup found unpushed
commits or a dirty tree there. Point at the `$PRIMARY/.claude/pipeline-state.<stamp>.json` whose stamp
matches the lane's, and whose `worktree` field
names the lane and whose ticket entries say why it was kept. Never take the deploy slot from a live
run lane without saying so: `/run-tickets` Phase 7 deploys merged `main` from it.

Per the global rules, a gnhf run belongs on a throwaway worktree on a scratch branch with no
push credentials. If someone asks for that here, say no and point at treehouse.

## The single deploy slot

`npm run deploy` builds and copies into one fixed folder:

```
~/Documents/Notes/.obsidian/plugins/local-tts-reader
```

`deploy.mjs` takes an optional vault path argument but defaults to that one, and `npm run deploy`
passes no argument. So **exactly one worktree at a time can hold the build that Obsidian is
actually running.** Two sessions deploying in turn produces the worst possible failure mode: a
manual test that passes or fails against someone else's code, with no error anywhere.

`AGENTS.md` verification rule 11 means every worktree needs that slot before it can claim a
change works. This command's job is to make the current owner visible and make a handover
explicit.

**Ownership marker.** The slot records its owner in a file the plugin ignores:

```
~/Documents/Notes/.obsidian/plugins/local-tts-reader/.deployed-from
```

Two lines: the absolute worktree path, and `branch=<name> commit=<short hash> at=<ISO time>`.
It lives beside the artifacts rather than in the repo because the slot is the shared resource
and `.claude/` is per-worktree. `deploy.mjs` copies only `main.js`, `manifest.json` and
`styles.css` - ADR 0028 inlines the ONNX runtime and the worker into `main.js`, so there is no
`ort/` and no `kokoro-worker.js` to copy - and since NRL-122 it also **deletes** every other
top-level entry in the destination, including a stale `kokoro-worker.js` or `ort/` an older build
left there. The marker survives that prune because the prune keeps anything dot-prefixed by name,
not because nothing is deleted; do not rename it to a non-dot name. Obsidian reads only
`manifest.json`, `main.js`, `styles.css` and `data.json`, so a dotfile is inert.

**The marker is a declaration, not proof.** A `/ship` run in another worktree may have deployed
without writing it. The check that does not require cooperation is a byte comparison, since
`main.js` is gitignored and each worktree builds its own:

```bash
PRIMARY="$(pwd)"
[[ "$(basename "$PRIMARY")" =~ -nrl-[0-9].*$ ]] && PRIMARY="${PRIMARY%-nrl-*}"
[[ "$(basename "$PRIMARY")" =~ -run-[0-9]+-[0-9]+$ ]] && PRIMARY="${PRIMARY%-run-*}"
SLOT="$HOME/Documents/Notes/.obsidian/plugins/local-tts-reader/main.js"
for d in "$PRIMARY" "${PRIMARY}"-nrl-* "${PRIMARY}"-run-*; do
  [ -f "$d/main.js" ] || continue
  if cmp -s "$d/main.js" "$SLOT"; then echo "OWNS SLOT: $d"; else echo "stale:    $d"; fi
done
```

The `-run-*` glob is in the loop because `/run-tickets` Phase 7 deploys merged `main` from its lane,
so a run lane is a real candidate for owning the slot. Leaving it out is how the slot ends up
attributed to nobody: every interactive tree reads `stale` and the marker names a directory the loop
never looked at.

The `-nrl-` pattern is `-nrl-[0-9].*$` and **not** `-nrl-[0-9]+$`, which is what it used to be. A
worktree covering several issues is named for all of them - `note-reader-local-nrl-57-58-65-72` is on
disk now - and `+$` does not match that, so the strip silently did nothing and `$PRIMARY` stayed
pointing at the worktree. Every glob below then expanded against the wrong parent. Measured with both
patterns against that real directory name before the change.

Report the marker and the byte comparison separately. When they disagree, the byte comparison
wins and the marker is stale; say both.

## Input

`$ARGUMENTS` selects the subcommand.

| Subcommand | Purpose |
|---|---|
| *(none)* | List worktrees, with deploy-slot ownership |
| `NRL-12`, `nrl-12`, `12` | Inspect one in detail |
| `conflicts` | File overlap between active branches |
| `slot` | Who owns the deploy slot, and nothing else |
| `create NRL-12` | Create a worktree and make it usable |
| `deploy NRL-12` | Hand the deploy slot over to that worktree |
| `remove NRL-12` | Remove one, with safety checks |

Parse: empty → List. `NRL-\d+` / `nrl-\d+` / bare `\d+` → Inspect. Otherwise match the keyword.

## Naming

```
~/Documents/Dev/
├── note-reader-local/          ← primary workspace
├── note-reader-local-nrl-12/   ← worktree for NRL-12
└── note-reader-local-nrl-19/   ← worktree for NRL-19
```

Resolve the primary from wherever you are:

```bash
PRIMARY="$(pwd)"
[[ "$(basename "$PRIMARY")" =~ -nrl-[0-9].*$ ]] && PRIMARY="${PRIMARY%-nrl-*}"
[[ "$(basename "$PRIMARY")" =~ -run-[0-9]+-[0-9]+$ ]] && PRIMARY="${PRIMARY%-run-*}"
echo "primary=$PRIMARY"
```

## Mode: List

```bash
shopt -s nullglob
for dir in "${PRIMARY}"-nrl-*/; do
  NUM=$(basename "$dir" | grep -oE '[0-9]+$')
  echo "=== NRL-$NUM ==="
  [ -f "$dir/.worktree-meta.json" ] && cat "$dir/.worktree-meta.json"
  BRANCH=$(git -C "$dir" branch --show-current 2>/dev/null || echo detached)
  DIRTY=$(git -C "$dir" status --short 2>/dev/null | wc -l | tr -d ' ')
  AHEAD=$(git -C "$dir" rev-list --count origin/main..HEAD 2>/dev/null || echo '?')
  DEPS=$([ -d "$dir/node_modules" ] && echo installed || echo MISSING)
  echo "  branch=$BRANCH ahead=$AHEAD dirty=$DIRTY deps=$DEPS"
done
for dir in "${PRIMARY}"-run-*/; do
  echo "=== run lane: $(basename "$dir") ==="
  echo "  branch=$(git -C "$dir" branch --show-current 2>/dev/null || echo detached)" \
       "dirty=$(git -C "$dir" status --short 2>/dev/null | wc -l | tr -d ' ')"
done
BRANCH=$(git -C "$PRIMARY" branch --show-current)
[[ "$BRANCH" == feature/* || "$BRANCH" == fix/* ]] && echo "PRIMARY: $BRANCH"
```

Then run the deploy-slot block from the top of this file, and check for stale references:

```bash
git worktree list --porcelain
```

Any listed path missing from disk → tell the user to run `git worktree prune`.

Format as a table. `deps=MISSING` is worth flagging loudly: the gates in that worktree will fail
for a reason that has nothing to do with the code.

```
| Issue | Branch | Ahead | Dirty | Deps | Deploy slot |
|---|---|---|---|---|---|
| NRL-12 | fix/nrl-12-wikilink-brackets | 3 | 0 | installed | OWNS |
| NRL-19 | feature/nrl-19-reading-position | 1 | 4 | MISSING | stale |
| primary | main | - | 0 | installed | stale |
```

None found:

```
No active worktrees. To create one:
  /worktrees create NRL-12
```

## Mode: Inspect

```bash
D="${PRIMARY}-nrl-<NUM>"
ls -d "$D" && cat "$D/.worktree-meta.json" 2>/dev/null
git -C "$D" branch --show-current
git -C "$D" diff --name-only "$(git -C "$D" merge-base origin/main HEAD)"
git -C "$D" log --oneline "$(git -C "$D" merge-base origin/main HEAD)"..HEAD
gh pr list --head "$(git -C "$D" branch --show-current)" --json number,title,state,url --limit 1
```

Linear status via the `get_issue` operation. **Do not hardcode a tool prefix.** The prefix differs
between Claude Code and opencode; resolve the real name for the `linear-nrl` server from your
available tool list, as `.claude/linear.md` requires. Linear unreachable is never a blocker: show
the git data and say Linear was skipped.

Report path, branch, created time, Linear status and requirement ID, open PR, changed files,
whether `node_modules` exists, and whether this worktree owns the deploy slot. Finish with:

```
Actions
  Work here:    cd <path> && claude     then /start-issue NRL-<NUM>
  Take slot:    /worktrees deploy NRL-<NUM>
  Remove:       /worktrees remove NRL-<NUM>
```

## Mode: Conflicts

```bash
shopt -s nullglob
for dir in "$PRIMARY/" "${PRIMARY}"-nrl-*/; do
  NAME=$(basename "$dir")
  B=$(git -C "$dir" branch --show-current 2>/dev/null)
  [[ "$NAME" == "$(basename "$PRIMARY")" && ! "$B" =~ ^(feature|fix)/ ]] && continue
  echo "--- $NAME ($B)"
  git -C "$dir" diff --name-only "$(git -C "$dir" merge-base origin/main HEAD)" 2>/dev/null
done
```

Build a file → branches map and report any file appearing in two or more. Include uncommitted
work: the range above covers committed, staged and unstaged in one pass, which is the point.

**High-collision files here.** Flag these loudly when they appear in two or more branches,
because a conflict in them is a correctness problem rather than a merge inconvenience:

| File | Why it collides |
|---|---|
| `src/text/extract.ts` | Every stripping change lands here, and two edits to `cleanLine` merge cleanly while breaking the `sourceIndex` invariant |
| `src/audio/player.ts` | The single playback controller. `replayCurrent`, `primeBuffer` and `pause` are all known-defective, so two branches are likely fixing the same lines |
| `src/audio/types.ts` | The engine contract. A capability added on one branch is invisible to engines written on another |
| `src/settings/index.ts` | `Settings`, `DEFAULT_SETTINGS` and `normaliseSettings` all in one file; two new keys conflict every time |
| `src/main.ts` | Every command, ribbon action and wiring change lands here |
| `src/ui/settingsTab.ts` | Every new setting renders here |
| `srs.md` | The contract. Two branches editing requirement status will silently pick one |
| `AGENTS.md` | The Known state list shrinks from both sides |

Also report, separately: two branches that both changed `src/text/extract.ts` or
`src/audio/words.ts` are jointly touching the offset invariant, and whichever merges second must
re-run `tests/extract.test.ts` and re-check `sourceIndex.length === text.length` rather than
trusting a clean merge.

No overlap → `All clear - no file overlap between active branches.`

## Mode: Slot

Run the marker read and the byte comparison, print both, and stop. Cheap, so it is safe to run
before any manual test.

```bash
cat "$HOME/Documents/Notes/.obsidian/plugins/local-tts-reader/.deployed-from" 2>/dev/null \
  || echo "no marker; slot owner unknown"
```

## Mode: Create

1. Parse the number. Refuse if the directory already exists:

```bash
ls -d "${PRIMARY}-nrl-<NUM>" 2>/dev/null
```

2. If you are currently inside a worktree, say so and create from the primary instead. Nested
   worktree siblings break the `${PRIMARY}-nrl-*` glob everything here depends on.

3. Create it:

```bash
git -C "$PRIMARY" fetch origin
git -C "$PRIMARY" worktree add "${PRIMARY}-nrl-<NUM>" -b <feature|fix>/nrl-<NUM>-<slug>
```

Branch kind and slug per `.claude/linear.md`: `feature/nrl-{N}-{slug}` or `fix/nrl-{N}-{slug}`,
slug lowercased from the issue title, non-alphanumerics to `-`, near 50 chars. Slug unknown →
use `feature/nrl-<NUM>` and let `/start-issue NRL-<NUM>` rename it in the new worktree.

4. Metadata:

```bash
printf '{\n  "issue": "NRL-%s",\n  "created": "%s"\n}\n' "<NUM>" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "${PRIMARY}-nrl-<NUM>/.worktree-meta.json"
```

5. **Install dependencies.** A fresh worktree has no `node_modules`, and until it does, `npm test`
   and `npm run typecheck` fail for reasons unrelated to any change. Use `npm ci`, not
   `npm install`: `package-lock.json` is committed and `ci` reproduces it exactly rather than
   resolving fresh versions in a throwaway tree.

```bash
cd "${PRIMARY}-nrl-<NUM>" && npm ci
```

This is not fast. `onnxruntime-web` alone is large, and `esbuild.config.mjs` copies 32MB of WASM
out of `node_modules` at build time, so the `ort/` directory does not exist until a build runs.
If `npm ci` fails, report it: the worktree exists but is unusable, and say that plainly rather
than letting the next command fail confusingly.

6. Prove the worktree is usable before handing it over. Anything less and the first failure the
   user sees will look like their own change:

```bash
cd "${PRIMARY}-nrl-<NUM>" && npm test && npm run typecheck
```

`tests/engine.test.ts` shells out to the real `spd-say` binary and needs a running
speech-dispatcher daemon, not `espeak-ng`; see `AGENTS.md`'s quality-gates block. If it fails,
check `spd-say --version` and `spd-say -O` before blaming the worktree.

7. Do **not** deploy. Creating a worktree never takes the deploy slot. Report who currently owns
   it and require `/worktrees deploy NRL-<NUM>` as a separate, deliberate act.

8. Run the conflicts check if other worktrees exist.

9. Report:

```
Worktree created: ../note-reader-local-nrl-<NUM>/
Branch: fix/nrl-<NUM>-<slug>
npm ci: ok        npm test: <the runner's "N suites: ..." line>        typecheck: clean

Deploy slot: currently held by ../note-reader-local-nrl-12 (NRL-12).
  This worktree cannot claim an Obsidian test until it takes the slot:
  /worktrees deploy NRL-<NUM>

To start working:
  cd ../note-reader-local-nrl-<NUM> && claude
  # then: /start-issue NRL-<NUM>
```

Nothing to link or symlink. Unlike other repos in this pool, this one keeps no gitignored config
that a worktree needs. `data.json` is per-vault and lives in the deploy slot, and the Kokoro
weights live in the vault at `.obsidian/local-tts/kokoro`, shared by every worktree because they
are outside the plugin folder by design (`CONTEXT.md`).

## Mode: Deploy (handover)

This is the only path that may take the slot, and it refuses to do it silently.

1. Determine the current owner: read `.deployed-from`, then run the byte comparison. If the
   requested worktree already owns it, say so and stop.

2. If another worktree owns it, **stop and ask** using `AskUserQuestion`. Show:
   - the current owner's path, branch and whether it has uncommitted work
   - whether that owner has an open PR, and its Linear status
   - that taking the slot invalidates any in-flight manual test there

   A worktree with uncommitted changes and no PR is mid-test. Recommend waiting.

3. On explicit approval:

```bash
cd "${PRIMARY}-nrl-<NUM>" && npm run deploy
printf '%s\nbranch=%s commit=%s at=%s\n' \
  "$(pwd)" "$(git branch --show-current)" "$(git rev-parse --short HEAD)" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$HOME/Documents/Notes/.obsidian/plugins/local-tts-reader/.deployed-from"
```

4. Tell the user to reload Obsidian (Ctrl+P → `Reload app without saving`). A copied `main.js`
   does nothing until the plugin is reloaded, and forgetting this produces a "fix did not work"
   report against the previous build.

5. Say out loud which worktree lost the slot, so the report in that session is not trusted.

## Mode: Remove

0. **Refuse a `note-reader-local-run-*` lane.** It belongs to `/run-tickets`. Say so, read
   the matching `$PRIMARY/.claude/pipeline-state.<stamp>.json` for the ticket that kept it and its `blockedReason`, and
   print the lane's unpushed commits. If the owner still wants it gone, they run the discard command
   `/run-tickets` Step 8 printed; this command does not do it for them.

1. Confirm the directory exists.

2. Safety checks:

```bash
D="${PRIMARY}-nrl-<NUM>"
git -C "$D" status --short
git -C "$D" log --oneline @{u}..HEAD 2>/dev/null || git -C "$D" log --oneline "$(git -C "$D" merge-base origin/main HEAD)"..HEAD
git -C "$D" stash list
gh pr list --head "$(git -C "$D" branch --show-current)" --json number,state,mergedAt --limit 1
```

Plus the `get_issue` operation for Linear status (resolve the tool name; do not hardcode a
prefix).

3. Present the findings and use `AskUserQuestion`. Warn on: uncommitted changes, stashes,
   unpushed commits, no merged PR, an issue not Done, and **this worktree owning the deploy
   slot**. The last one matters because removing it leaves Obsidian running a build whose source
   no longer exists on disk, which is the hardest state to debug. Offer to hand the slot back to
   the primary first.

4. If the shell is inside the worktree being removed, tell the user to `cd` out first rather than
   forcing it.

```bash
git -C "$PRIMARY" worktree remove "${PRIMARY}-nrl-<NUM>" --force
git -C "$PRIMARY" worktree prune
```

`--force` also deletes `node_modules` and any built `main.js`, `kokoro-worker.js` and `ort/`.
That is fine: all four are gitignored build output. Nothing in this repo's worktrees holds data
that exists nowhere else, which is why there is no symlink caveat here.

5. If that worktree held the slot, say so and say what the slot now contains: a build from a
   deleted tree. Recommend a redeploy from the primary.

## Error handling

| Scenario | Action |
|---|---|
| Directory not found | Show the error, list what exists |
| `git worktree add` fails, branch exists | Offer to check out the existing branch in a new worktree with `worktree add <dir> <branch>` |
| `npm ci` fails | Report it; the worktree exists but is unusable. Do not proceed to the gates |
| Gates fail in a fresh worktree | Check `spd-say --version` and `spd-say -O` first; `tests/engine.test.ts` shells out to the real `spd-say` binary and needs a running speech-dispatcher daemon |
| Deploy slot marker missing | Fall back to the byte comparison; if no worktree matches, say the slot holds an unknown build |
| Linear tool absent | Do the git work, print what you would have asked Linear |
| `gh` not authenticated | Skip the PR lookup, say it was skipped |
| Inside the worktree being removed | Tell the user to exit; do not force |
| A sibling matching `note-reader-local-run-*` | List as `run lane`, touch nothing. It belongs to `/run-tickets`, which creates and removes its own. Refuse `remove`; read the `$PRIMARY/.claude/pipeline-state.<stamp>.json` with the matching stamp to say why it is still there |
| A sibling directory matching neither pattern | List as unmanaged, touch nothing. It may belong to treehouse |

Every worktree branch still passes `/critique` and `/check-constraints` through `/ship` before
merge. A worktree is a place to work, not an exemption from the gates.
