# 0017. The Final Path Segment as a Link Label

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-46 (amended by NRL-66, clause 8 and the amendment section below)

## Context

A `[[wikilink]]` or `![[embed]]` whose target has no dot in its final path
segment is classified as a note name, and the **whole target** became the spoken
label. A link to a note filed under a private folder therefore read that folder
structure aloud.

Measured before any change, by bundling the real `src/text/extract.ts` from
`git archive 789d3c2` with the repo's own esbuild and sweeping all 512
combinations of the nine content keys:

```
A [[private/folder/Secret Note]] B     -> A private/folder/Secret Note B
  1 distinct output across 512 combinations; keys that move it: NONE
A ![[private/folder/Secret Note]] B    -> A private/folder/Secret Note B  (256, speakEmbeds on)
                                       -> A B                            (256, speakEmbeds off)
A ![[private/folder/Secret.png]] B     -> A B  (all 512; isFileTarget silences it)
A [[C:\Users\me\Secret Note]] B        -> A C:\Users\me\Secret Note B     (all 512)
A ![[C:\v1.2\Note]] B                  -> A B                            (all 512)
A [[https://user:pw@example.com/a/b]] B-> A https://user:pw@example.com/a/b B (all 512)
A [[folder/]] B                        -> A folder/ B
```

Two of those are worse than the ticket framed them. A backslash inside `[[...]]`
reaches `emitWikiLabel` intact - the escape branch is in the per-line scan and
the label loop emits target characters without re-entering it - so a Windows path
was read out in full. And a URL target spoke its **userinfo**, `user:pw`, in
both positions of `speakUrls`, which the bare-URL branch in prose has never done
(ADR 0003).

The written contract matched the code: `srs.md` promised that an embed's label is
"the target reduced exactly as a wikilink target is", and `docs/adr/0008` clause
5a stated the folder case explicitly and deferred it, because narrowing it is a
change to **wikilink** speech, which is default-on and a different promise from
the opt-in embed one. So this is a decision about whether the contract is right,
not a bug against it.

What could not be measured here: what Obsidian itself displays for a
folder-qualified wikilink. That is the strongest input to the decision and it was
not available in this lane.

## Decision

**A link label is the target's final path segment only, in both constructs.**

1. **Final segment, both branches.** `[[private/folder/Secret Note]]` and
   `![[private/folder/Secret Note]]` both read `Secret Note`. `emitWikiLabel` is
   shared by the two call sites, so applying it once delivers the parity `srs.md`
   promises; nothing at either call site changes.

2. **Both separators.** The segment ends at the last `/` **or** `\`, so
   `[[C:\Users\me\Secret Note]]` reads `Secret Note` and a mixed
   `[[a/b\c/Secret Note]]` does too. A backslash path is folder structure for
   exactly the same reason a forward-slash one is.

3. **A URL target reduces to its host, unconditionally.** Recognised with the
   repo's own bare-URL detector, now the single `BARE_URL_START` constant shared
   with the prose branch so the two cannot drift into disagreeing about what a
   URL is, and reduced by the existing `hostSpan()` - the one
   destination-reduction rule this repo already wrote down (ADR 0003). It is
   **not** gated on `speakUrls`, because `srs.md` says a wikilink's label is
   spoken regardless of that setting; gating it would put the path and the
   userinfo back. Any `#fragment` is suppressed rather than read as a pause, for
   the same reason the path is dropped.

4. **`isFileTarget` splits on both separators too**, and classifies exactly what
   will be spoken, via one shared `finalSegment()` helper.

5. **A trailing separator falls back to the last non-empty segment.**
   `[[folder/]]` reads `folder` and `[[folder/subfolder/]]` reads `subfolder`. A
   target that is nothing but separators speaks nothing.

6. **`#` handling is untouched.** The reduction applies only to the part before
   the first `#`, exactly as `isFileTarget` already split. `#Section` stays a
   pause and `#^blockid` is still dropped.

7. **The `isFileTarget` guard stays ahead of the URL rule.** An embed of a URL
   with a dotted final segment (`![[https://x.com/a.png]]`) stays silent, because
   ADR 0008 clause 5 says to err towards silence and the existing guard already
   does.

8. **Inside a wikilink or embed target, `\` is a path separator, not a
   CommonMark escape** (added by NRL-66). The two branches find their closing
   `]]` with `wikiTargetClose`, a local scan that skips code spans and complete
   comment spans exactly as the shared `inlineContainerClose` does but does not
   honour `\`. Clause 2 had already decided that a backslash in a target is
   folder structure; this is the tokeniser being made to agree with it. See the
   amendment section below for why the scan is local and what it costs.

The reasoning rests on stated project priorities rather than on an Obsidian
observation that was unavailable: `srs.md` forbids speaking a destination, ADR
0008 clause 5 says silence on a filename is recoverable while reading out a path
is the thing R-M09 asks us not to do, and ADR 0003 already makes the identical
trade for URLs by keeping only the host.

## Consequences

- **Genuine disambiguation is lost.** Two notes with the same title in different
  folders now sound identical. An explicit alias overrides the label entirely in
  both constructs and is the workaround; it was already the workaround this
  ticket's predecessor pointed at.

- **`isFileTarget` moves in the DISCLOSING direction for one shape**, which is
  the direction ADR 0008 clause 5 says it must not fail in, so it is evidenced
  rather than argued. `![[C:\v1.2\Note]]` used to have `C:\v1.2\Note` as its
  whole "final segment"; the last dot put `2\Note` after it, so the target was a
  file and silent. Splitting on `\` makes the leaf `Note`, which has no dot, so
  it is a note and IS spoken. It is only acceptable because clause 1 reduces the
  label to that same leaf in the same change: `Note` becomes audible, never the
  drive or the folder. The two halves must land together.

- **Probed, not asserted.** Base and new extractors were bundled side by side and
  diffed over a 440-target matrix (16 folder shapes x 5 leaf shapes x 5 tails,
  plus 8 URL forms x 5 tails) x 2 constructs x all 512 key combinations = 450,560
  cells, with `FOLDERSENTINEL`, `DRIVESENTINEL` and `CREDSENTINEL` in every part
  that must stay silent. Results: **0** cells where the new build speaks a
  sentinel the base did not; **386** entries where it fixes one the base spoke;
  newly-spoken tokens deduped to `LEAFOK`, `LEAFOK.md`, `LEAFOK.markdown`,
  `LEAFOK.png`, `LEAFOK.tar-gz`, `example.com`, `b`, `Section`, `Two` - every one
  a leaf or a host, none containing a sentinel. Of the nine content keys, only
  `speakEmbeds` moves any output. The `sourceIndex` invariant (equal length,
  monotonic, in bounds, character-identical) held in every one of the 450,560
  cells.

  The probe earned its keep. Its first run caught the two functions disagreeing:
  `isFileTarget` classified the empty segment after a trailing `\` while the label
  fell back to the last non-empty one, so `![[f\pic.png\#Head]]` newly spoke
  `pic.png` where the base was silent. That is why clause 4 routes both through
  one `finalSegment()` helper rather than splitting in two places.

- **A schemeless host target is not a URL.** `[[example.com/folder/b]]` reads `b`,
  not `example.com`, because clause 3 reuses the prose detector verbatim rather
  than inventing a second, looser one. The folder is still dropped, so the
  privacy outcome is the same; only the label differs.

- **`sourceIndex` stays in lockstep by construction.** Every emitted character
  keeps its own raw offset - `emit(ch, rawStart + k)`, never a synthesised one -
  and the dropped prefix needs no space of its own because both call sites
  `pushSpace` before the label. The invariant is
  `sourceIndex.length === text.length` with one mapped space per dropped span,
  not one entry per dropped character; NRL-46's acceptance criterion stated the
  latter and was wrong.

- **NOT VERIFIED IN OBSIDIAN.** Every measurement above is bare Node against the
  real extractor. What Obsidian itself displays for a folder-qualified wikilink
  was not observed, and per AGENTS.md rule 11 that limitation ships with the
  change rather than being papered over. The extractor is the only thing touched,
  so the only Obsidian-observable difference is what a read aloud says.

- **R-M09 is still not met.** The three NRL-44 image shapes continue to block it
  (AGENTS.md known state). This closes one of R-M09's reduction gaps, not the
  requirement.

- **One pre-existing defect found and not fixed here.** A target ending in a
  backslash immediately before the closer puts `\]]` on the line,
  `inlineContainerClose` never finds a `]]`, the `[[` is treated as unterminated,
  and the target is read as prose through the escape branch - folder segment, one
  literal `]`, and no reduction, because the wikilink branch never fires.
  Byte-identical on the merge base and on the NRL-46 tree. It was pinned as
  `pin-unterminated-by-escape` in `tests/extract.test.ts`, and **NRL-66 closed
  it**; the amendment below records how.

## Amendment (NRL-66): the tokeniser agrees with clause 2

Clause 2 decided that a `\` in a target is folder structure. The tokeniser did
not agree: the shared `inlineContainerClose` consumed `\]` as a CommonMark
escape, so `[[private/folder/Note\]]` never closed, was treated as unterminated,
and fell through to prose with its folder path intact. Reproduced before any
change by bundling the real `src/text/extract.ts` at `a8f45db`:
`Before [[FOLDERSENTINEL/LEAFOK\]] after.` spoke
`Before FOLDERSENTINEL/LEAFOK]] after.`, identically in `[[ ]]` and `![[ ]]` and
in both positions of `speakEmbeds`.

**Decision.** Treat it as a wikilink. `wikiTargetClose` is a near-copy of
`inlineContainerClose` with the escape branch removed and `]]` fixed as the
delimiter; the embed and wikilink branches call it and nothing else changes.

1. **No new reduction logic, and that was traced and then measured rather than
   assumed.** With the target recognised as `folder/Note\`, `finalSegment` takes
   its existing trailing-separator branch (clause 5) and returns `Note`, and the
   emission loop's existing `k >= segEnd && k < pathEnd` skip drops the trailing
   `\` itself. `isFileTarget` needed no change either; it already splits on `\`.

2. **The scan is local to these two branches, deliberately.** For a markdown
   image, link or highlight, `\]` failing to close the label is
   CommonMark-correct, and their destination sits after the `]` and is already
   dropped, so changing the shared helper would diverge from the renderer for no
   privacy gain. Only a wikilink or embed target is a vault path, so only it
   earns the exception. Keeping it local is also what keeps this independent of
   the two branches NRL-63 rewrites. Five guard cases pin that the image, link,
   highlight, non-trailing-escape and code-span shapes are byte-identical.

3. **Composition with ADR 0021.** A target like `[[a/b%%SECRET%%\]]` was
   previously unrecognised; now that it is, it routes through `emitWikiLabel` and
   NRL-67's comment-span exclusion applies to it. Measured, not reasoned: it
   speaks `b` - folder and hidden text both silent - where the base spoke `a/b`.

**Evidence, all bare Node, base `a8f45db` and the fix bundled side by side.**
Sentinel sweep over 15 trailing-backslash targets x 2 constructs x all 512
content-key combinations = **15,360 cells: 13,312 leaking on base, 0 on the
fix**. A wider direction sweep that inserts a backslash at **every** position of
8 sentinel-bearing targets (242 targets x 2 constructs x 512 = **247,808
cells**) found **0** cells where a sentinel is audible on the fix and silent on
the base, and **7,168** where the fix silences one. That **0** is scoped to this
corpus and must be read with the first cost below: none of those 242 targets
contains a literal `]]`, which is the one shape that does newly speak. A sweep
whose corpus includes it finds the 3,072 base-parity cells recorded there, so the
two numbers are consistent rather than contradictory - but the 0 is not a
universal claim and must not be quoted as one. `sourceIndex` checked
numerically by UTF-16 code-unit index for length, monotonicity, bounds and
character identity: **0 failures over 571,904 units**. Twelve assertions were red
against the unfixed extractor and green after.

**Costs, measured and accepted.**

- **One family is not only-removes, and it lands on base parity rather than on a
  new leak.** A target holding a literal `]]` after a backslash
  (`[[a\]]FOLDERSENTINEL/Leaf]]`) now closes at that `]]`, so the tail becomes
  prose instead of being swallowed into the target and reduced away. Measured:
  **3,072 of 3,072 cells** where the fix newly speaks a sentinel are cells where
  the **backslash-free** shape `[[a]]FOLDERSENTINEL/Leaf]]` **already** speaks it
  on the base. The fix makes the backslash variant behave as the same text
  without the backslash always has; it does not open a class of leak the base did
  not have. A bare path in prose is outside R-M09, which is about link
  destinations.

- **A dangling backslash can be spoken as itself.** `[[a/b#Head\]]` says
  `b Head\` and `[[a/b|x\]]` says `x\`, because the trailing-separator skip only
  covers the path part and `cleanLine` has always emitted a backslash with
  nothing to escape literally. Markup in the speech, not a destination, and no
  new reduction rule was invented for it.

- **A URL target with a trailing backslash now speaks its host.**
  `[[https://user:pw@example.com/private/x\]]` said nothing on the base (it fell
  to prose and `speakUrls` could drop it) and now says `example.com`. That is
  clause 3 reaching a shape it could not reach before; the credentials and the
  path stay silent.

- **NOT VERIFIED IN OBSIDIAN, and the decision does not rest on the renderer.** A
  targeted grep of the installed `obsidian.asar` did not yield the internal-link
  tokenizer. The one suggestive hit, a non-greedy `/\[\[.+?\]\]|\[.+?\]/` with no
  escape clause, is consistent with escape-insensitivity but is not conclusive.
  The decision rests on silence-on-the-path - clause 1 of this ADR and
  `srs.md`'s wikilink and embed bullets - not on renderer fidelity. If Obsidian
  turns out to render `[[folder/Note\]]` as literal text, what changes is the
  spec sentence, not the privacy outcome.

## Alternatives considered

- **Keep the full target.** What NRL-21 chose, on the ground that narrowing it
  changes default-on wikilink speech. Rejected here because the thing it protects
  is the reading-aloud of a vault folder path, which is what R-M09 exists to
  prevent; the disambiguation it preserves is recoverable with an alias and the
  disclosure is not recoverable at all.

- **Narrow the embed branch only.** Rejected: it would diverge the two branches,
  need two spec amendments, and break the parity assertions in
  `tests/extract.test.ts` that exist precisely to stop that drift.

- **Treat a URL target as a note name and read its final segment.** Arguably more
  faithful, since Obsidian does not resolve such a target as a link at all. But
  the final segment of a URL is a meaningless path element and, for
  `[[https://user:pw@example.com]]`, the "final segment" is the whole credentialed
  authority. Rejected: it reads a destination aloud.

- **Gate the host reduction on `speakUrls`.** Rejected: with the setting off the
  label would have to be either silent, which breaks the promise that a wikilink
  label is always spoken, or the full target, which is the disclosure being fixed.

- **Add an `ExtractOptions` key for the reduction.** Rejected: it would be a tenth
  content key whose "off" position is a privacy regression, and ADR 0001 clause 6
  is the standing reason not to add a setting for something that has one right
  answer.
