---
description: Close out a merged issue - verify the merge, delete the local and remote branch, remove the worktree, sync main, set the issue Done, and update srs.md or the AGENTS.md known-state if a listed defect is now fixed.
---

Conventions: `.claude/linear.md`. Rules and gates: `AGENTS.md`. Spec: `srs.md`.

The unbreakable rule: every branch this command touches leaves both local **and** remote clean.
"Deleted local, remote still present" is a failure, not a partial success.

## Linear tool names

Operations used here: `get_issue`, `save_issue`, `save_comment`. **Do not hardcode a tool
prefix.** Resolve the real names for the `linear-nrl` server from your available tool list.
Resolving the prefix is not enough: Linear folded its create/update pairs into `save_*`, so
posting a comment is `save_comment` and there is no `create_comment` (see
`.claude/linear.md`). If Linear is unreachable, do the git work and print the status change
for manual entry.

## Input

`$ARGUMENTS` is an optional branch name, e.g. `fix/nrl-12-wikilink-brackets`. Omitted → detect
from the current branch, or scan for stale ones.

## Step 1: Identify the branch

**Argument given** → use it.
**On a `feature/*` or `fix/*` branch** → use the current branch.
**On `main`** → scan:

```bash
git fetch origin --prune
git branch -vv | grep '\[.*: gone\]' || echo "none gone"
```

Then catch merged branches whose remote still exists, which is the case here because no
auto-delete-after-merge has ever run on this repo:

```bash
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/ | grep -E '^(feature|fix)/'); do
  pr=$(gh pr list --head "$b" --state merged --json number,mergedAt --jq '.[0]' 2>/dev/null)
  [ -n "$pr" ] && echo "$b -> $pr"
done
```

Present what you found and ask before deleting anything:

```
Found N branches to clean up:

| # | Branch | Local | Remote | Merge status |
|---|--------|-------|--------|--------------|
| 1 | fix/nrl-12-wikilink-brackets | present | gone | Merged 2 days ago |
| 2 | feature/nrl-14-speechd-voices | present | present | No merged PR found |

Clean up? (y / n / select)
- y: delete branches with a verified merge only. Row 2 is excluded.
- select: give numbers, e.g. "1"
```

## Step 2: Verify the merge

```bash
gh pr list --head <branch> --state merged --json number,mergedAt,title
```

| Result | Action |
|---|---|
| Merged PR found | Proceed. Record the PR number and merge date. |
| No merged PR | Warn hard and require explicit confirmation. Check `git log origin/main --oneline \| grep nrl-N` before believing either answer. |
| `gh` unavailable | Mark the branch Unverified. Require an explicit `select`; never include it in a default `y`. |

There are no PRs on this repo yet. The first run of this command will likely find nothing, and
that is the correct answer rather than a bug.

## Step 3: Leave the branch before pulling

Order matters and getting it wrong is silent.

```bash
git config branch.<branch>.base-branch 2>/dev/null || echo main
```

Then:

```bash
git checkout <base-branch>
git pull --ff-only origin <base-branch>
```

Two reasons for that order:

- `git pull origin main` while standing on the feature branch merges main **into the feature
  branch**, which is the opposite of cleanup.
- `git branch -d` cannot delete the branch you are on. It fails with "cannot delete branch
  checked out at" and the cleanup stops half done.

Checkout failing on uncommitted changes → **stop and surface it**. Do not stash silently. The
work being cleaned up is supposed to be merged; unexpected local changes mean something is
wrong, and in this repo that is usually a build artifact or a stray test file rather than real
work.

## Step 4: Delete the remote first

Remote before local, so a partial failure leaves the local branch as a recovery anchor.

```bash
git ls-remote --heads origin <branch>
```

- Exists → `git push origin --delete <branch>`, and capture the exit code
- Already gone → record `remote: already-deleted`
- Push fails for any reason → **STOP**. Do not delete local.

## Step 5: Delete the local branch

```bash
git branch -d <branch>
```

`-d` failing because GitHub squash-merged is the dominant case. Fall back to `-D` **only** after
`gh pr list --head <branch> --state merged` has confirmed the merge. Any other failure: stop and
surface it.

## Step 6: Prune and verify both sides

```bash
git fetch origin --prune
git show-ref --verify --quiet refs/heads/<branch>   # must exit 1
git ls-remote --heads origin <branch>                # must print nothing
```

If either still resolves, that branch is a FAILED row in the summary. This command does not
report success without this pass.

## Step 7: Remove the worktree

```bash
ISSUE_NUM=$(echo "<branch>" | grep -oE 'nrl-([0-9]+)' | grep -oE '[0-9]+')
ls -d "$HOME/Documents/Dev/note-reader-local-nrl-${ISSUE_NUM}" 2>/dev/null
```

Inside that worktree right now → tell the user to `cd` to the primary repo first and re-run.
A worktree cannot remove itself.

From the primary repo:

```bash
git worktree list
git -C "$HOME/Documents/Dev/note-reader-local" status --short   # confirm you are in the primary
git worktree remove "$HOME/Documents/Dev/note-reader-local-nrl-${ISSUE_NUM}"
git worktree prune
```

`git worktree remove` refusing because the tree is dirty → show what is dirty and ask. Only use
`--force` after the user has seen the file list and said so. A dirty worktree after a merged PR
usually holds untracked build output (`main.js`, `kokoro-worker.js`, `ort/`, `tests/.build/`)
plus `node_modules`, which is safe to discard, but confirm rather than assume.

**Never touch a worktree outside the `note-reader-local-nrl-*` naming.** That pool belongs to
`treehouse` / gnhf, per the lane rule in `.claude/linear.md`.

### Deploy slot

If the removed worktree owned the deployed Obsidian build, the vault now runs a build whose
source tree no longer exists:

```bash
DEST="$HOME/Documents/Notes/.obsidian/plugins/local-tts-reader"
[ -f main.js ] && cmp -s main.js "$DEST/main.js" && echo "slot=primary" || echo "slot=elsewhere-or-stale"
```

`slot=elsewhere-or-stale` after a worktree removal → tell the user to run `npm run deploy` from
the primary repo so the vault matches merged `main` again. Do not deploy from this command.

## Step 8: Confirm sync

Step 3 already moved and pulled. Confirm, do not repeat:

```bash
git branch --show-current                              # the base branch
git rev-list --left-right --count origin/main...HEAD   # 0 0
git status --short                                     # empty
```

## Step 9: Close the issue

`save_issue` with `state: "Done"`. Check the current state first and skip only if it is already
Done.

**This step is load-bearing, not a safety net.** `Resolves NRL-XX` in a commit footer does not
close a Linear issue: that is a GitHub issue-closing keyword. Linear closes issues from branch
and PR names through its GitHub integration, which is **not connected** to this repo. Nothing
else will move the issue.

Post a `save_comment` with the merged PR link and the merge date if the PR was not already
commented by `/ship`.

## Step 10: Does the spec or the known-state need updating?

This is the step that keeps `AGENTS.md` and `srs.md` from going stale, and it is the reason this
command exists rather than just a git alias.

### 10a: Known defects in `AGENTS.md`

`AGENTS.md` carries a Known state section listing reproduced defects. Check whether this merge
fixed one:

```bash
git log origin/main --oneline -5
git show --stat HEAD
```

| If the merge touched | Check whether this entry is now false |
|---|---|
| `src/text/extract.ts` | wikilink `[` / `]` spoken; embed content lost; **zero chunks** when line 1 is `---`; `skipCode` and `skipUrls` plumbed and never read |
| `src/engines/system/speechd.ts` | malformed `-y` / `-t` voice args; `Invalid voice` on stdout with exit 0 while the guard reads stderr |
| `src/audio/player.ts` | `replayCurrent` truncating the chunk array and corrupting `n / total`; `primeBuffer` prefetching against engines where `synthesize()` speaks; pause a no-op on speechd and webspeech |

An entry that is genuinely fixed gets **removed** from the list. Do not soften it to "partially
fixed". If the fix is partial, rewrite the entry to describe exactly what remains, since a vague
entry is what makes the next agent rediscover it.

Also re-check the headline count in that section: "an audit against `srs.md` found 2 of 16 MUST
requirements fully met". If this merge closed a MUST, that number moved. Only change it if you
can point at the requirement ID that closed. Do not increment it on a guess.

### 10b: `srs.md`

```bash
grep -n "R-M08" srs.md
```

| Situation | Action |
|---|---|
| The implementation matches the requirement | No edit. `srs.md` is the contract, not a changelog. |
| The implementation deviates from the requirement | `AGENTS.md` requires an ADR in `docs/adr/` **and** an amendment to `srs.md`. There is no `docs/adr/` directory yet; create it and start at `docs/adr/0001-<slug>.md`. Deviating is allowed; doing it silently is not. |
| The requirement was ambiguous and the ticket resolved the ambiguity | Amend `srs.md` so the next reader gets the resolved version. |

### 10c: `CONTEXT.md`

Edit it only if the merge changed the architecture: a new file in the layout tree, a new term in
the vocabulary table, or a structural gap under Known structural gaps that has closed. Do not
log bug fixes there.

Any doc edit from this step is a separate commit on `main`, so the cleanup and the doc update
stay distinguishable in `git log`:

```bash
git commit -m "docs: remove fixed extract defect from AGENTS.md known state"
```

## Step 11: Summary

Every row shows local **and** remote. A row saying only "Deleted" is incomplete and forbidden.

```
Cleanup Complete

## Branches
| Branch | Local | Remote |
|--------|-------|--------|
| fix/nrl-12-wikilink-brackets | Deleted | Already deleted by GitHub |

## Worktree
- note-reader-local-nrl-12: removed
- Deploy slot: vault no longer matches any live tree. Run `npm run deploy` from the primary repo.

## Repo
- main: up to date, clean

## Linear
- NRL-12: Done

## Docs
{one of:}
- AGENTS.md: removed the wikilink bracket entry from Known state (now fixed)
- srs.md: no change, implementation matches R-M02
- Nothing to update

{if any FAILED row:}
## Action Required
<N> deletion(s) failed. Inspect with `git ls-remote --heads origin` and
`git for-each-ref refs/heads/`, clear manually, then re-run.

## Next
1. `/orient`
2. `/start-issue NRL-XX`
```

**Already clean** (on `main`, nothing stale, no worktrees): say so plainly. "No feature branch
detected. Local and remote clean, main synced." Then offer `/orient`. Do not invent work.

## Error handling

| Scenario | Action |
|---|---|
| Branch missing locally | Check `git ls-remote`. Remote present → offer a remote-only delete. |
| PR not merged | Warn hard, require explicit confirmation, log it loudly in the summary. |
| Uncommitted changes blocking checkout | Stop. Do not stash silently. |
| `git branch -d` fails, PR merged | Fall back to `-D`. |
| `git branch -d` fails, PR not merged | Stop. Surface it. |
| Remote delete fails | Stop. Do not delete local. |
| `git worktree remove` refuses on a dirty tree | Show the dirty files, ask, `--force` only on an explicit yes. |
| Running inside the worktree being removed | Stop. Tell the user to `cd` to the primary repo. |
| Pull conflicts on the base branch | Stop. That needs a decision. |
| `gh` unavailable | Skip merge verification, mark rows Unverified, require `select`. |
| Linear unreachable | Do the git work, print the Done transition as text for manual entry. |
| Step 6 finds residue | FAILED row. Do not claim success. |

## Safety invariants

1. Local and remote both clean, every time. One side only is a failure.
2. Remote is deleted before local, so the local branch remains a recovery anchor.
3. Never `-D` without `gh` confirming the merge.
4. Never delete a remote branch whose PR is not merged, even on confirmation, without logging it.
5. Never remove a worktree outside the `note-reader-local-nrl-*` pool.
6. The Step 6 verification pass is mandatory.
