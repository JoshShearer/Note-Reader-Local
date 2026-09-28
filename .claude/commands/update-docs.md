---
description: After a merge, diff AGENTS.md, srs.md and CONTEXT.md against the actual code and correct whichever one has drifted.
---

Conventions: `.claude/linear.md`. Rules: `AGENTS.md`. Architecture: `CONTEXT.md`. Spec: `srs.md`.

## Purpose

This repo's documentation is load-bearing in a way that README prose usually is not. `AGENTS.md`
is the instruction set every agent session reads, `srs.md` is the acceptance criteria, and
`CONTEXT.md` is the map a session uses to decide where a change belongs. Each drifts in its own
direction:

| Doc | How it goes wrong |
|---|---|
| `AGENTS.md` "Known state" | Lists reproduced defects. A merged fix leaves a stale entry, and the next session either re-fixes it or works around a bug that no longer exists |
| `srs.md` | Requirement text and its implied status. A merged change satisfies part of `R-M08` and nothing records it, so `/spec-check` keeps reporting the same gap |
| `CONTEXT.md` | Layout, pipeline and the "Known structural gaps" list. A new file, a new engine or a closed gap makes the map wrong |
| README / LICENSE | Both absent. That is an `R-M01` gap and it stays true until someone writes them |

**Diff the docs against reality. Do not trust either one.** A doc that says a defect exists is a
claim to verify, not a fact to preserve, and the same is true in reverse.

## When to run

After a merge, after `/finish`, or when `/orient` reports undocumented merges.

## Input

`$ARGUMENTS`: optional `NRL-XX` identifiers to limit scope. Omitted means every merge into `main`
in the last 7 days that has no matching docs commit.

## Step 1: Find what merged and is undocumented

```bash
git checkout main && git pull
git log main --oneline --since='7 days ago'
git log main --since='7 days ago' --format='%h %s' --merges
gh pr list --state merged --limit 20 --json number,title,headRefName,mergedAt,body
```

`gh` failing is not a blocker; the `git log` output is enough. This repo may have no PRs at all
if work was merged locally.

For each merged change:

1. Extract the identifier from the PR title, then the branch name (`feature/nrl-(\d+)-`,
   `fix/nrl-(\d+)-`), then the commit body (`Resolves NRL-(\d+)`).
2. Skip if the subject starts with `docs:`, or no `NRL-XX` was found (note it as skipped).
3. Match against existing docs commits with a **word-boundary** check on `NRL-{number}` followed
   by a non-digit, so `NRL-1` does not match `NRL-12`:

```bash
git log main --oneline --since='14 days ago' --grep='^docs'
```

4. Apply the `$ARGUMENTS` filter if given.

Also pull the requirement ID out of each issue, via the `get_issue` operation. **Do not hardcode
a tool prefix.** It differs between Claude Code and opencode; resolve the real name for the
`linear-nrl` server from your available tool list, as `.claude/linear.md` requires. Linear
unreachable means git-only: print what you would have read.

Report the scan, then proceed. Nothing to do:

```
All merges from the last 7 days are already documented.
Docs drift can still exist without a merge. Run the Step 2 checks anyway if it has been a while.
```

## Step 2: Diff the docs against the code

Run these regardless of what merged. They are cheap, and drift arrives without a PR.

### 2a. Has a Known state defect been fixed

`AGENTS.md` lists six reproduced defects. For each, the check is a run or a read, not a memory:

| Claim in `AGENTS.md` | How to test it now |
|---|---|
| `extract.ts` speaks `[` and `]` for wikilinks | `cleanLine` handles `[` at `src/text/extract.ts:85`. Wikilinks are `[[x]]`, so the inner `[` becomes the label. Run `extractChunks` on `See [[Some Note]] here.` and read the text |
| `extract.ts` loses embed content | Same run, with `![[Some Note]]`. The image branch at `:68` drops it |
| Zero chunks when line 1 is `---` | `:307` treats a line-1 `---` as frontmatter open. Run `extractChunks` on a note starting `---\n\nHello.\n` and count the chunks |
| `skipCode` / `skipUrls` never read | `rg -n 'skipCode\|skipUrls' src/` - are they read in `extract.ts`, or only declared in `ExtractOptions` and passed from `main.ts`? |
| `speechd` malformed `-y`/`-t`, silent failure | `src/engines/system/speechd.ts:109-110` builds the args, `:122` guards on `code !== 0 && stderr.trim()`. Does the guard now check stdout for `Invalid voice`? |
| `replayCurrent` truncates the array | `src/audio/player.ts:370-379`. Does it still `chunks.slice(this.index)` and replay from 0? |
| `primeBuffer` prefetches against speaking engines | `src/audio/player.ts:201`. Is it still unconditional, or does it now check `capabilities.ownsPlayback` / the result kind? |
| Pause is a no-op on speechd and webspeech | `src/audio/player.ts:333`. Does `pause()` still only touch `this.audio`? |

The runnable ones are worth running rather than reading:

```bash
node build-tests.mjs tests/extract.test.ts && node tests/.build/extract.test.mjs
```

A fixed defect gets its bullet **removed** from `AGENTS.md`. A partially fixed one gets its
bullet **narrowed** to what is still true, not deleted. Deleting a bullet whose bug survives is
the single most damaging edit this command can make: the next session will trust the absence.

Also re-check the count in that section: "an audit against `srs.md` found 2 of 16 MUST
requirements fully met". If the merged work closed a MUST, that number is wrong. Do **not**
increment it by assumption. Either run `/spec-check` and use its result, or leave the number and
add the date it was measured. An audit number nobody re-ran is worse than no number.

### 2b. Has a requirement's status changed in srs.md

```bash
rg -n '^### R-[MSCW][0-9]+' srs.md
```

Requirements are `### R-M01` through `### R-C05`. Open the one the merged issue named and read it
against the code. Two outcomes:

- **The code now satisfies it.** `srs.md` is a contract, not a tracker, so the requirement text
  usually does not change. What changes is whatever records status: the `AGENTS.md` count, the
  Linear issue, and `/spec-check`'s output. Close the Linear issue rather than editing the
  requirement.
- **The code deliberately does something else.** This is the case that needs care. `AGENTS.md`
  says deviating is allowed and deviating **silently** is not: record an ADR in `docs/adr/` and
  amend `srs.md`. That directory does not exist yet, so the first deviation creates it:

```bash
ls docs/adr/ 2>/dev/null || echo "no ADR directory yet"
mkdir -p docs/adr
```

  The ADR names the requirement, what the code does instead, why, and what was given up. Only
  then amend `srs.md`, and have the amendment point at the ADR filename. **Never edit `srs.md` to
  match code without writing the ADR in the same commit.** An unexplained amendment converts a
  deviation into an invisible requirement change, and `srs.md` stops being acceptance criteria.

Known permanent divergence, already recorded in `CONTEXT.md` and not drift: the spec's
`TTSBackend` / `TTSCapabilities` / `TTSVoice` / `SpeechSegment` versus the code's `SpeechEngine` /
`EngineCapabilities` / `VoiceInfo` / `SpeechChunk`. Do not "fix" either side here.

### 2c. Does CONTEXT.md still describe the real architecture

Three things to diff:

**The layout tree.** `CONTEXT.md` lists every file under `src/` with a one-line description.

```bash
find src -name '*.ts' | sort
```

Compare against the tree in the Layout section. A new file that is not listed, or a listed file
that no longer exists, is drift. Correct it, keeping the one-line-purpose style.

**The pipeline diagram.** It asserts the three `SynthResult` kinds and which engines produce
them: `buffer` for kokoro and espeak, `live` for webspeech, `streamed` for speechd. Verify
against `src/audio/types.ts` and each engine's `CAPABILITIES`. A new engine, or a changed
`ownsPlayback`, invalidates the diagram and matters because non-negotiable 9 depends on it.

**The Known structural gaps list.** Four entries. Each is checkable:

```bash
rg -n 'capabilities\.' src/ | grep -v 'audio/types.ts'
rg -n 'Intl\.Segmenter' src/
rg -n 'filePath|notePath' src/audio/player.ts
```

- "`Player` holds no file path" - true while that last grep is empty.
- "Capabilities are consumed at three call sites, one of which is a label" - count the first
  grep. If the count moved, update the number rather than the prose.
- "No engine fallback chain" - does `main.ts` still just show a notice when
  `isAvailable()` is false?
- "Segmentation is a single regex with no `Intl.Segmenter`" - true while the second grep is empty.

A closed gap gets removed. A gap the merge made *worse* or narrower gets rewritten.

### 2d. Do the README and LICENSE gaps still stand

```bash
ls README.md LICENSE LICENSE.md 2>/dev/null || echo "both still absent"
rg -n 'license' package.json manifest.json
```

Both are absent today, and `package.json` declares `"license": "MIT"` with no file to back it.
That is an `R-M01` gap (standard Obsidian community plugin), and it is a real submission blocker,
not a nicety.

This command's job is to **report the gap accurately, not to fabricate the files**. A README is a
product description with real behaviour in it and a LICENSE is a legal choice; neither should be
generated as a side effect of a docs sweep. If no Linear issue tracks it, offer to create one via
`/create-issue` naming `R-M01`. If one exists, confirm it is still open.

Never write a README containing a performance claim, a supported-platform list or a feature list
you did not verify. `AGENTS.md` 13 applies to documentation.

## Step 3: Make the edits

Only touch the doc that is actually wrong. Editing all three because one drifted produces a
diff nobody can review.

House rules that apply to every edit:

- No em-dashes. A plain hyphen or a rephrase.
- Match the surrounding voice. `AGENTS.md` bullets state a defect and where it lives, in one or
  two lines. `CONTEXT.md` explains why a decision is the way it is.
- **Never relax a rule to match code that broke it.** If the code contradicts a non-negotiable in
  `AGENTS.md`, the code is wrong. Open an issue; do not edit the rule.
- Never assert a measurement you did not take. `CONTEXT.md` and `srs.md` contain real numbers
  from real runs. If a change invalidated one, either re-measure it this session or leave it and
  note the date it came from.

## Step 4: Verify the docs still match after editing

The claims you just wrote are checkable, so check them:

```bash
rg -n 'src/[a-z/]+\.ts' CONTEXT.md AGENTS.md | while read -r l; do echo "$l"; done
```

Every `src/...` path named in either doc must exist. Then confirm nothing structural broke:

```bash
npm test && npm run typecheck
```

A docs-only change cannot break these, so a red result means the branch was not clean when you
started. Say so rather than committing on top of it.

## Step 5: Commit

```bash
git add AGENTS.md CONTEXT.md srs.md docs/
git commit -m "docs: remove fixed wikilink defect after NRL-19 merge

extract.ts no longer emits bracket characters for wikilinks, verified by
running extractChunks on a note containing [[Some Note]]. The embed and
line-1 --- entries are unchanged and still reproduce.

Refs NRL-19"
```

Every `NRL-XX` documented must appear in the **subject line**: Step 1's cross-reference scan reads
subjects, so a number only in the body will be re-documented next week.

Docs-only changes may go straight to `main`. That is the documented exception to the
branch-and-PR flow in `/ship`. An ADR under `docs/adr/` is not docs-only in spirit, because it
records a spec deviation: mention it in the commit body and post the ADR path as a Linear comment
on the issue that caused it.

```bash
git push origin main
```

## Step 6: Report

```
Documentation Updated

## Scan
| Merge | Issue | Status | Requirement |
|---|---|---|---|
| a1b2c3d | NRL-19 | documented now | R-M08 |
| e4f5g6h | NRL-12 | already documented (commit 9z8y7x6) | R-M11 |
| i7j8k9l | (none) | skipped, no NRL id | - |

## Doc diffs found
- AGENTS.md Known state: wikilink bracket entry removed (verified by running extractChunks).
  Embed loss and the line-1 `---` bug both still reproduce; entries kept.
- AGENTS.md: the "2 of 16 MUST" count is now stale. Left unchanged and dated rather than
  incremented; run /spec-check to get a real number.
- CONTEXT.md: no drift. Layout matches `find src -name '*.ts'`, all four structural gaps still
  hold, capability call-site count still 3.
- srs.md: untouched. NRL-19 satisfied R-M08 as written, no deviation, so no ADR.
- README.md / LICENSE: still absent. R-M01 gap stands, tracked by NRL-7.

## Not verified
- The speechd `Invalid voice` entry. Checking it needs a misconfigured voice on this machine;
  read the guard at speechd.ts:122 and it is unchanged, so the entry was kept.

## Committed
<hash> - docs: remove fixed wikilink defect after NRL-19 merge
Pushed to origin/main
```

## Error handling

| Scenario | Action |
|---|---|
| No recent merges | Still run Step 2; drift arrives without a PR |
| `gh` fails or is unauthenticated | Use the `git log main` fallback, say `gh` was skipped |
| A defect claim cannot be tested on this machine | Keep the entry, report it under "Not verified". Never delete an unverified claim |
| The code contradicts a rule in `AGENTS.md` | Do not edit the rule. Open an issue and say so in the report |
| A merged change deviates from `srs.md` | Write the ADR in `docs/adr/` first, then amend `srs.md` in the same commit, then link both from Linear |
| Linear tool absent | Do the doc work; print what you would have sent |
| `srs.md` requirement status is ambiguous | Do not guess. Run `/spec-check` for that requirement, or report it as unresolved |
