# 0027. One shared bracket-depth scan for a soft-wrapped label

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-88 (R-M09). Closes root 4 of the five ADR 0023 records as
  residual; amends ADR 0023's residual-roots section and `srs.md` R-M08's image
  bullet and R-M09's soft-wrap paragraph. Roots 1, 2, 3 and 5 are untouched.

## Context

`A ![alt` / `some [bracket] here` / `words](zdestz.png) B` spoke
`"A [alt some bracket here words](zdestz.png) B"`. The destination is spoken, in
**both** positions of `speakImageAlt`, where the same note with `some plain here`
on the middle line speaks `"A B"` and leaks nothing. ADR 0023 recorded this as
root 4 of five and named it the root "worth carrying forward", because it is not
a container problem and no amount of teaching the lookahead about container
prefixes reaches it.

`bracketClosesLater` scanned forward for the first later line bearing any `]`,
tested that one `]` for a `](` or `][` tail, and **returned** either way. So a
line carrying a bracket of its own - `[bracket]` in prose, `[^1]`, `[[wk]]`,
`[x]`, a link reference definition, `![[embed]]` - aborted the confirmation, the
label was never recognised, and the whole construct fell out as prose with its
destination in it.

ADR 0023's count for root 4, **3,584 cells, is wrong by half**. It counts the
image form only. The link twin is another 3,584 through the same code, so root
4's size on a corpus counting both kinds is **7,168**, and shapes the ticket's
seven lines do not cover (a stray and the real closer on one line, `[a][b]`, two
pairs, a nested pair) add more again. Measured in this session at `df12262` over
an 11-shape x 2-kind x 512-combination corpus: **11,264 cells, 11,264 leaking.**

## Decision

**One helper, `labelClose(line, from, depth)`, used by BOTH the confirmation and
the line that consumes a carried label, tracking bracket DEPTH.**

### 1. Depth, not a skip

The rule is CommonMark's own: a bracket may appear inside a link or image label
only as a matched pair. So a `]` is walked past **only while an inner `[` opened
after our own opener is still outstanding**, which makes a skipped `]` provably
not the label's. A `]` reached at **depth 0 is ours**: it is returned, the caller
tests it for `](` or `][` exactly as before, and on failure the confirmation
returns false. ADR 0023 clause 3's positive-evidence contract is therefore
unchanged, and an aborted confirmation still leaves the line byte-identical to
the pre-NRL-63 tree.

This is **not** "skip any `]` not followed by `(` or `[`", which is how NRL-88's
own ticket worded it. That was built and measured and it **loses real prose**:
skipping a shortcut label's own closer lets the scan run on and adopt an
unrelated later `](`, swallowing everything between.
`A ![shortcut` / `more] text` / `and [link](dest) here` went from
`"A [shortcut more] text and link here"` to `"A here"`. Depth is what stops that,
and `guard-nrl88-shortcut-not-confirmed` is the only thing in the suite that
would catch a regression to it.

### 2. Both sites, in lockstep

**Fixing the confirmation alone is not a safe subset of this fix - it is
strictly worse than changing nothing.** The consumption site in `cleanLine`
closed a carried label at the **first** `]` on the line, unconditionally, and
never applied the `](`/`][` test the confirmation applied. So a confirmation that
walks past a stray `]` hands the carry to a consumer that stops at that same
stray `]`, ends the label early, and lets the real `](dest)` fall out as prose.
Measured as its own arm against `df12262`: **all 7,168 root-4 cells still leaked
AND the alt text was silenced on top** -
`"A [alt some bracket here words](zdestz.png) B"` became
`"A here words](zdestz.png) B"`. That is prose loss plus the leak, and it is
precisely the "worse than either recognising the label or not recognising it"
failure the `opensMathBlock` comment in `extract.ts` already describes.

One question asked from two places had already drifted once here, which is the
same shape NRL-73's `opensObsidianBlock` merge fixed. Do not split it again.

### 3. The conservative early return is load-bearing

`labelClose` returns at the first step where no `]` remains on the line, carrying
the depth it holds, and does **not** count a trailing unmatched `[` into it. This
looks like an oversight and must not be "completed".

Completing it was built and measured as its own arm. It **newly leaked a
destination in 10 of 4,000 fuzz notes** -
`A [i1 [i2` / `words](zdestz.png) B` went from `"A i1 [i2 words B"` to
`"A [i1 [i2 words](zdestz.png) B"` - and it **moved the pinned fixture
`guard-nrl63-nested-label`**. The cause is a real conflict rather than a bug:
this implementation's carry takes the **first** unmatched opener (ADR 0023 clause
7, and `cleanLine`'s image and link branches say so) where CommonMark's inline
parser takes the **last**. Full depth accounting binds the outer opener and then
refuses the closer the inner opener owns. Conservative depth agrees with the
first-opener convention: 0 new leaks, 0 fixtures moved.

The cost is one named residual, and it is **one mechanism in three positions,
not one shape**. The first draft of this ADR said one shape and pinned only the
first; corrected at ship review by measuring all three, each at 1,024 of 1,024
cells in both kinds and each **identical on base and on the fix**:

- a trailing unmatched `[` on the **opener** line -
  `A ![alt [inner` / `x] words](zdestz.png) B`, pinned by
  `guard-nrl88-unbalanced-open-residual`;
- an unbalanced `[` on an **interior** line - `A ![alt` / `[a [b] c` /
  `words](zdestz.png) B`, where the `[` IS counted, so the label's real closer is
  then consumed as the inner pair's, pinned by
  `guard-nrl88-unbalanced-interior-residual`;
- a bracket pair **straddling** the break - `A ![alt` / `some [strad` /
  `dle] here` / `words](zdestz.png) B`, where the opening line's `[` is NOT
  counted because no `]` follows it on that line, pinned by
  `guard-nrl88-straddling-pair-residual`.

The first and third are the early return declining to count; the second is the
count being taken and the first-opener convention then binding the wrong
bracket. All three resolve together if the first-versus-last-opener conflict is
ever settled, and none of them can be fixed alone - that is why the three
fixtures come off together rather than one at a time.

### 4. The other residual shape, also deliberate

**A bare unmatched `]`** on an interior line keeps its destination spoken, and
that is correct rather than leftover. CommonMark ends a label at an unmatched
`]`, so `A ![alt` / `foo ] bar` / `words](zdestz.png) B` is a shortcut reference
with no definition: the image never forms, the opener is deactivated, and
`](zdestz.png)` is literal text the renderer shows. Speaking it is
renderer-faithful under ADR 0018, and silencing it would be the
silence-visible-prose trade ADR 0007 clause 6 refuses. So the ticket's "seven
such lines" is **six defects and one correct behaviour**, the same shape as
ADR 0023's ATX/setext finding. `some ]] here` is the same mechanism and behaves
the same way. Pinned as a tripwire by `guard-nrl88-bare-close-still-leaks`.

**CAVEAT, and it is the weakest premise in this ADR:** that reading is taken from
the CommonMark specification's own text ("brackets are allowed in the link text
only if backslash-escaped or as a matched pair"). It was **not** run against a
reference implementation and **not** observed in Obsidian.

The other residual is clause 3's, in its three positions above.

### 5. No `openerAt` parameter, and no `unclosedBracketAt`

NRL-88's plan specified threading the opener's offset into `bracketClosesLater`
to seed the depth from the opener line, and a matching `Cleaned.unclosedBracketAt`.
Both are omitted, because that seed is **provably always 0**: the carry is armed
only when `inlineContainerClose(raw, openerAt, "]")` is `-1`, so there is no `]`
after the opener at all, so `labelClose` seeded there would return on its first
step with the depth it was handed. It is the identical call. Threading an
argument through five sites to compute a constant is dead weight a later reader
has to re-derive, so the fact is stated in a comment at the seed instead.

The depth that IS carried is real and is between **continuation** lines: a line
like `[a [b]` inside a label leaves depth 1 outstanding, and `Cleaned` gained
`openBracketDepth` plus a tenth `cleanLine` parameter `incomingBracketDepth` to
hand it on. It travels with `openBracket` and is cleared by exactly the same
paths, being part of the same carry rather than state of its own.

### 6. What was deliberately not touched

`interruptsParagraph` (shared with `codeSpanClosesLater`, which NRL-64 depends
on, and just narrowed by NRL-73 and NRL-74), `opensMathBlock`,
`codeSpanClosesLater`, `opensHiddenComment` / `opensObsidianBlock` /
`opensHtmlBlock`, NRL-74's `lastHtmlCloser` machinery, and clause 6's
`confirmed === undefined` precedence. All eight function bodies were proven
byte-identical by hashing them out of `df12262` and out of this tree. Roots 1, 2,
3 and 5 are consequently unmoved, which was also measured directly rather than
argued: **0 of 39,936 non-root-4 cells changed a single output byte.**

The single-line image and link branches are also untouched, so the pre-existing
`![a [[N|l]] b](dest.png)` and `![alt](dest(1).png)` shapes are exactly as they
were.

## Consequences and verification

R-M09 is **NOT** recorded as met and the `2 of 16` MUST headline count does not
move. Roots 1, 2, 3 and 5 remain, root 4 leaves clause 4's bare-`]` shape plus
clause 3's residual in its three positions, and the two pre-existing image
shapes are untouched.

All evidence is **bare-Node measurement**, taken in this session by copying
`src/` out of `df12262` and out of this tree into a scratch directory and
bundling each with the repo's own esbuild, so every probe is shown able to fail.

**Destination-leak matrix**, 104 shapes x 512 combinations = 53,248 cells per
side, reported per root and never as a bare total (the absolute is
corpus-dependent and is not comparable to ADR 0023's 19,456 or 8,704):

```
root            cells   base leak   fix leak
root1            5120        5120       5120
root1u           5120        5120       5120   (NRL-74's unmasked class)
root2            6144        5632       5632
root3            1024        1024       1024
root4           11264       11264       1024
root5            1024        1024       1024
bareClose        2048        2048       2048   (clause 4, correct)
unbalOpen        1024        1024       1024   (clause 3, opener-line position)
correctAtx       1024        1024       1024   (correct: a single line)
correctSetext    1024           0          0   (already carried)
ctrl4           11264           0          0   (the stray removed)
plain            1024           0          0   (NRL-63's fixed case)
hidden           6144           0          0
TOTAL           53248       33280      23040
```

**10,240 cells closed. 0 newly leaking.** The `1024` left in the `root4` row is
clause 3's **straddling-pair** position and the `unbalOpen` row is its
**opener-line** position; its **interior-line** position was not a separate row
in this corpus and was measured at ship review on its own, at 1,024 of 1,024
cells in both kinds, base and fix alike. All three are clause 3, all three are
now pinned, and none is newly leaking. Every non-root-4 row is **byte-identical
cell for cell**, not merely equal in leak count: 0 of 39,936.

**Skip-path enumeration, re-derived rather than cited, and corrected at ship
review.** Three numbers have been claimed for this one enumeration. The settled
arithmetic, re-counted by stripping comments and attributing every `continue` to
its owning loop by brace depth: `extractChunks`' per-line loop body holds **20**
control-flow exits, all `continue` and all belonging to the outer `lineNo` loop -
**16** between the carry read and the confirmation call, **2** between that call
and the carry write-back, and **2** after the write-back, which therefore cannot
drop the carry. **18 can bypass the arm.**

The first draft of this section said 16 exits / 12 pre-arm / 14 bypass and was
**low by four**, and said NRL-88's plan was wrong when the plan's **18 was
right**. The cause is identified rather than guessed: that count matched
`^\s*continue;$` and missed the four inline `if (...) continue` forms - the
frontmatter blank/`#` line, `inComment` with no closer on the line,
`inIndentedCode` with a blank line, and `inFence` under `skipCodeBlocks`.
NRL-63's recorded 20 equals the total-exits figure, but its prose called it the
read-to-arm window, which is 16.

Over 15 mid-line shapes x 2 kinds x 512 = **15,360 cells: 0 newly leaking, and 0
prose sentinels lost.** The four paths the miscount omitted were then probed in
their own right, in both the "after the label closes" and "between opener and
closer" positions, over **4,096 further cells: 0 newly leaking and 0 prose words
lost at `speakImageAlt: true`**. The miscount therefore hid no unexamined
defect, which is why this is a corrected record rather than a reopened decision.

**Fourteen of the eighteen are unreachable with a live carry** because
`interruptsParagraph` or `opensMathBlock` already matches the line, the
fail-closed direction by construction - that covers the fence, indented-code and
`inComment` paths, a line opening any of which aborts the confirmation. The rest
each get their own argument: the two frontmatter exits `continue` before the arm
and so never arm a carry, and the `LINK_REF_DEF` drop additionally requires
`paraText === "" && !wasPara`, which a live carry makes false.

**Prose loss**, the direction the naive skip failed in. 18 shapes built around
shortcut labels, labels that never close, unbalanced brackets, reference forms
with no definition and bracket-only lines, over 512 combinations = **9,216 cells,
0 losing a prose word** - with one class run down rather than waved at. 512 cells
on `A ![sc` / `[b] more][ref] ZTAILZ.` stop speaking `ref`, and `ref` is a
reference **name** rather than prose: the fix now recognises the reference form
and consumes its `[ref]` tail, which is what the single-line branch has always
done. The stray form on the fix is byte-identical to the stray-free form on base
in both toggle positions, which is the check that settles it.

**Non-interference with all three carries**, including cells where more than one
is live: NRL-64's `outgoingCode`, NRL-63's own paragraph carry and NRL-74's
`lastHtmlCloser`. 19 shapes x 512 = 9,728 cells. **15 of the 19 are byte-identical
on both sides**, including "code+label on one line" (root 5, correctly untouched),
"all three live", "stray `]` then the code closer" and both hidden-block shapes.
The 4 that moved are root-4 fixes: re-measured with a sentinel oracle over 2,048
cells, **0 newly leaking, 0 prose sentinels lost, 2,048 destinations closed.**

**Disclosure direction**, because this diff **widens** `bracketClosesLater` and
NRL-74 required the ticket merging after it to re-measure. A genuine hidden
comment block beside a newly-armed carry, 14 shapes x 2 kinds x 512 = **12,288
cells per side: 0 spoken on base, 0 on the fix, 0 newly spoken.** ADR 0019's
deliberately-literal class (a `%%` pair inside a **spoken** code span) is kept as
its own class and is **1,024 on both sides** - collapsing the two invents leaks,
as NRL-44 measured. The probe is non-vacuous: a **disqualified** `%%` opener
(NRL-73) puts the sentinel in the displayed class and the probe sees it there.

One class worth naming because it looks like a change of kind and is not. A
**mid-line** `%%`, which NRL-68 and NRL-73 establish the renderer displays, moved
2,048 -> 1,536 spoken. The 512-cell drop is all at `speakImageAlt: false`: once
the label is recognised, that text is the image's alt text and the toggle governs
it, which is the requirement. At `speakImageAlt: true` it is spoken verbatim. The
identical 256-cell shape appears on the link-reference-definition skip path.

**`sourceIndex` lockstep** (non-negotiable 8), numeric by UTF-16 code unit, four
clauses, on both arms over 66 notes x 512 combinations: **40,448 chunks /
870,144 code units on the fix and 1,157,376 on base, 0 failures on length,
bounds, monotonicity and identity.** The checker is demonstrably non-vacuous -
every mutator fires and every clause is covered, on **both** arms:

```
                  len     bounds    mono   identity     (fix arm)
drop one entry   39936         0       0          0
shift all by +1      0     32768       0     667648
swap two entries     0         0   78848      77824
zero all entries     0         0       0     672768
```

**Both exemptions are mandatory and both are pre-existing**, shown by removing
each from a **correct** tree rather than asserted: without `text[i] === " "` the
fix reports 45,696 identity failures and **base reports 52,224**; without ADR
0004's synthetic `equation` chunk allow, both arms report **8,192**. Neither is
this diff's.

A **4,000-note fuzz** over bracket, container, code, comment and math fragments
x 4 option sets = 16,000 cells per side: **0 newly leaking, 0 losing a prose
sentinel, 0 newly speaking one, 44 destination leaks closed**, and `sourceIndex`
clean over 24,652 chunks / 459,164 code units with all four mutators firing. The
same fuzz found the 10 newly-leaking notes that killed the full-depth arm, so it
is demonstrably able to fail.

The acceptance oracle is deliberately **not** NRL-63's "the wrapped form is
byte-identical to the single-line form". Measured: that oracle agrees in **0 of
7,168 cells on base AND on the fix alike**, because the single-line form of the
same content (`A ![alt some [bracket] here words](zdestz.png) B`) hits the
pre-existing, explicitly out-of-scope "label holding another bracket construct"
defect and mis-parses on its own. Inheriting it would have made a correct fix
unfalsifiable in both directions. "Destination sentinel absent AND no prose word
lost" is used instead.

**Fixture honesty.** 9 core fixtures measured **RED** against `df12262` and green
after; 7 guards and 1 control measured green on **both** sides and are labelled
as such, none of them evidence of anything. **No pre-existing fixture moved** -
the pre-fix run's failure list held exactly the 9 new core names and nothing
else. `pin-nrl74-container-label-still-leaks-destination` deliberately did not
move, and its comment is untouched: it is root 1, and its expectation must change
when root 1 closes, not here. (AMENDED by NRL-98, ADR 0029: root 1 closed there
and that fixture DID move, replaced in place per the NRL-66/NRL-67 convention. The
comment NRL-88 left untouched also mis-attributed root 1 to NRL-88; that is
corrected at the fixture.)

## Residual risk

**NOTHING WAS OBSERVED IN OBSIDIAN.** No deploy happened and CDP port 9222 was
not attempted, so rule 11 applies to every number above. Two premises rest
entirely on reading a specification rather than on a renderer: clause 4's
bare-`]` reasoning, which is the CommonMark spec text and not a reference
implementation, and clause 1's matched-pair rule. Nobody has rendered
`A ![alt` / `some [bracket] here` / `words](zdestz.png) B` in Obsidian and
confirmed it shows an image.

Clause 4's bare-`]` shape and clause 3's residual in all three of its positions
are named, pinned and deliberate. (AMENDED by NRL-98, ADR 0029: roots 1 and 2 are
no longer simply "open". Their CONTAINER members are closed, by a peel budget on
`bracketClosesLater`'s two ends plus one relaxed conjunct of the bracket arming
guard; `interruptsParagraph` was NOT widened and its body is hashed unchanged, so
this ADR's own matrix and ADR 0019's F5 guard both stand. NRL-98 re-measured
rather than quoting, and found root 4 unmoved. What remains of roots 1 and 2 is
three non-container shapes - a TABLE_ROW opener, a TABLE_ROW interior and a setext
underline after two or more content lines - which go to one follow-up, **NRL-109**,
whose fix direction is NARROWING that predicate. Roots 3 and 5 are still open with the
reasons ADR 0023 records.) Whoever touches any of this must
re-measure this ADR's matrix rather than quoting it, for exactly the reason
NRL-74 gave NRL-88.
