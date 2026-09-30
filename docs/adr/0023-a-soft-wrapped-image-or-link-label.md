# 0023. A soft-wrapped image or link label

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-63 (R-M09, R-M08)

## Context

`srs.md` R-M09 promises that an image's "destination and any quoted title are
never spoken", in either position of `speakImageAlt`. A markdown image whose alt
text crossed a soft line break broke that promise outright, and it was the only
one of NRL-44's six sub-shapes that spoke a destination aloud by default.

Measured before any change, by bundling the real `src/text/extract.ts` from this
tree at `d1fff6e` with the repo's own esbuild and running it in bare Node:

```
A ![alt
words](zdestz.png) B

  speakImageAlt true   -> A [alt words](zdestz.png) B
  speakImageAlt false  -> A [alt words](zdestz.png) B
  single-line control  -> A alt words B   /   A B
```

The mechanism is per-line scanning, not a rule about images. `cleanLine` sees
one line at a time and `inlineContainerClose` therefore cannot find a `]` that is
on the next one. With no `]`, the image branch drops the `!` and falls through,
the link branch emits a literal `[`, and `words](zdestz.png) B` reaches the next
line as ordinary prose. The destination is spoken because nothing ever
recognised it as a destination. `speakImageAlt` cannot govern a construct the
scanner never sees, so R-M09's *configurability* half was broken on this shape
as well as its *reduction* half.

NRL-64 had just built the machinery this needs. It made the per-line loop two
pass - learn a fact the line cannot know alone, confirm it with a lookahead,
then re-clean the line knowing the answer - and routed the result through one
`emitLiteralRegion(from, to)` helper whose comment says in as many words that it
is "where a third confirmed-carry kind would attach".

## Decision

A markdown image or link label is carried across a soft line break, by a second
confirmed carry attached at NRL-64's site and consumed through a mirror of its
emitter. Seven clauses.

**1. A lookahead, not a dangling-tail drop.** The cheaper alternative this
ticket allowed - silence a `](...)` tail that has no `[` on its line - was
rejected before implementation, and the reason is that it cannot satisfy the
requirement it is aimed at. The opening line already drops the `!` and emits a
literal `[`, and the alt text already reaches prose unconditionally, so
silencing only the tail still speaks `[alt words` with `speakImageAlt: false`.
R-M09's configurability half would stay broken and a stray `[` would newly be
spoken, which is exactly the mistake ADR 0019 clause 1 was written against.

**2. Confirmation is mandatory, and it demands a destination.**
`bracketClosesLater` refuses unless a later line of the *same paragraph* closes
the label, and unless that line's first `]` is immediately followed by `(` or
`[`. The paragraph bound is `interruptsParagraph`, the identical predicate
`codeSpanClosesLater` uses at both ends, so the two carries can never disagree
about where a paragraph ends; a label cannot leave its own block any more than a
code span can.

The `](` / `][` requirement is the one place this deliberately does *not* copy
the code carry, and it is what keeps the change on the safe side of the
prose-loss axis. The defect is a spoken destination, and only the inline and
reference forms carry one. A shortcut `![alt\nwords]` with nothing defining the
reference renders literally, so confirming it would silence visible prose to
close a leak that is not there - the trade ADR 0007 clause 6 refuses. The cost
is stated rather than hidden: a soft-wrapped shortcut image keeps speaking its
brackets.

**3. A label that never closes changes nothing.** No confirmation means no
carry, and the line is cleaned exactly as it was before this ticket. This is the
direction that could have swallowed a note, and the design forecloses it rather
than bounding it: an unrecognised `![` cannot consume anything, because it is
still just a dropped `!` and a spoken `[`.

**4. One scanner covers both constructs.** An image label and a link label
differ in exactly one way - `speakImageAlt` governs the first and the second is
always spoken - and in nothing else, so `BracketKind` is a two-value flag on one
carry rather than two carries. A soft-wrapped link therefore speaks its label
and drops its destination in **both** positions of `speakUrls`, which is what a
single-line markdown link already does: that setting governs bare URLs and
autolinks, not link destinations (ADR 0003).

**5. Label content is re-cleaned, never emitted raw.** `emitLabelRegion(from,
to, kind)` is the mirror of `emitLiteralRegion`, called from the label's opening
line and from every continuation line, so the two halves are provably the same
rule. It recurses through `cleanLine` exactly as the single-line image and link
branches already do, which is why nested markup, escapes and complete comment
spans inside a soft-wrapped label need no second implementation. The recursion
is line-local and its `openComment` / `openCode` are discarded, so a label still
cannot open a document-level comment.

**6. The two carries are mutually exclusive for any one line, and whichever
opened first keeps the carry.** A code span binds tighter than a label in
CommonMark, so a line that opens both arms the code carry and no label carry;
and while a label carry is live no code carry is armed inside it. This is the
trip-wire clause the ticket asked for, and it is recorded as a residual rather
than as a success: **an image whose label contains a soft-wrapped code span
still speaks its destination.** `A ![alt \`x` / `y\` words](zdestz.png) B` is
byte-identical on both sides of this diff in all 512 content-key combinations.
The alternative - nesting the code region inside the label region, with the
lookahead modelling the code carry so a `]` inside the span cannot confirm - was
not taken, because it would have meant `bracketClosesLater` re-implementing part
of `codeSpanClosesLater` and would have put NRL-64's path at risk for a shape
that is unchanged either way. A label whose code span is entirely on one line is
handled correctly, and the both-open-on-the-opening-line case is excluded.

A **third** case was claimed handled here and is not, corrected on the
adversarial review's measurement rather than left standing: a code span opening
on a *continuation* line inside a live label is not recognised as a code span at
all, so with `skipInlineCode: true` its content is spoken although the user asked
for inline code to be skipped. `PA ![alt` / `` PB `x HIDE1 `` / `` PC` words](zdestz.png) PD ``
reads `PA alt PB x HIDE1 PC words PD` where the base read
`PA [alt PB words](zdestz.png) PD`. It is the direct consequence of the same
"while a label carry is live no code carry is armed inside it" rule, it loses no
prose and discloses no comment, and it is a setting violation rather than a
privacy one - but it is a real cost of clause 6 and is named as one.

**7a. A display-math block also stops the lookahead,** and it is the one stop
`interruptsParagraph` does not supply. `extractChunks` consumes a `$$` block with
a `continue` that never reaches the carry site, so a carry armed on the line
before one is read into `carriedBracket` and then dropped: the label's words are
silenced and the destination is still spoken, which is strictly worse than either
recognising the label or not recognising it, and is the single direction clause 3
exists to foreclose. `bracketClosesLater` therefore calls `opensMathBlock` at both
ends, and the shape is byte-identical to the pre-NRL-63 tree in both
`speakImageAlt` positions.

Three things about it are deliberate. The stop mirrors `extractChunks`'s own test
including its search for a later closer, because a stray `$$` with no closer is
not a block, is not consumed, and carries correctly - stopping there would give up
a destination for nothing. `interruptsParagraph` is **not** widened to cover this,
because it is shared with `codeSpanClosesLater` and widening it would move
NRL-64's just-landed carry; the identical gap exists for that carry, is
pre-existing, and is neither opened nor closed here. (Amended by NRL-74: that
predicate has since been **narrowed** - the opposite direction to the widening
this paragraph refuses - and given a second, document-scoped parameter, so a
reader checking "not widened" against the code will find a changed signature.
This paragraph's conclusion is unchanged and `opensMathBlock` is untouched;
`bracketClosesLater`'s body was proven byte-identical to base modulo the threaded
argument. NRL-74 also changed `interruptsParagraph`'s answer set, so whichever of
NRL-74 and NRL-88 merges second must re-measure the five roots below. See ADR
0025.) And this was found by the
adversarial review of this branch rather than by the fixtures, which is why the
guard is pinned by its own check with the invariant that actually applies: the
table's fixture harness asserts `src[sourceIndex[i]] === text[i]`, and the
synthetic `equation` chunk maps all seven letters to the `$` offsets (ADR 0004),
so it fails that clause on any math fixture - measured on base `d1fff6e` too, and
with no label anywhere in the note.

**7. The carry takes the first unmatched opener,** exactly as the code carry
takes the first unmatched run. Nested bracket constructs in a label are
therefore still the open R-M09 shape they already were: in
`A [![alt` / `words](zdestz.png)](zouterz.png) B` the outer `[` claims the inner
image's `](`, and the outer destination is still spoken. This is not a
regression - the pre-fix tree spoke *both* destinations - but it is not a fix
either, and `AGENTS.md` already tracks the same family under
`![a [[N|l]] b](dest.png)`.

## Consequences and verification

R-M09 is **not** recorded as met. Two image shapes `AGENTS.md` already names
stay open (`![a [[N|l]] b](dest.png)` and `![alt](dest(1).png)` speaking
`.png)`), and clauses 6 and 7 above add named residuals of their own. The MUST
audit headline count does not move.

All evidence below is bare-Node measurement, taken in this session from the
session scratchpad, bundling the real `src/text/extract.ts` with the repo's own
esbuild on both sides of the diff so each probe is shown able to fail. The merge
base is `d1fff6e`.

**Destination silence.** All 512 combinations of the nine content keys, which
covers both `speakImageAlt` positions and both `speakUrls` positions, against
sentinels that occur only in a destination, a title, a reference name or
userinfo:

```
paragraph image   base 512/512 leaking   fix   0/512
paragraph link    base 512/512 leaking   fix   0/512
blockquote        base 512/512 leaking   fix 512/512   (clause 2, parity with the code carry)
list item         base 512/512 leaking   fix 512/512   (clause 2)
heading           base 512/512 leaking   fix 512/512   (correct: the renderer shows that text)
```

Over the wider shape set: **6,656 leaking cells of 7,168 on the base, 1,536 on
the fix**, and every remaining one is a shape clause 2 excludes on purpose.

"Container or heading" is **too narrow a name for that remainder**, and the
adversarial review of this branch measured the real extent over an independent
36-shape x 512 matrix: **16,640 leaking of 18,432 on base, 8,704 on the fix**,
with the fix still speaking a destination in a blockquote, a lazy blockquote
continuation, a nested blockquote, a list item, an ordered list, a lazy list
continuation and an ATX heading - **and also** in a table row, a single-cell table
row, across a setext underline, across a 4-space indented code block, with the
closer inside a fence, with the opener inside a fence, in frontmatter, and across
a `$$` math block. The narrower phrase is wrong and is corrected here rather than
left standing.

An earlier draft of this section said the remainder "is one mechanism, not
several". **That was also wrong**, and the independent verification of this
branch measured **five** distinct roots over a 38-shape x 512 matrix (11,520
leaking of 19,456 on the fix against 16,384 on base; the absolute is
matrix-dependent and is not comparable to the 36-shape figure above):

1. `interruptsParagraph` matching on the **opener** line, 2,048 of 2,048 cells;
2. `interruptsParagraph` matching on a line **between** opener and closer, 1,792
   of 2,048;
3. `opensMathBlock`, clause 7a's separate stop, 512 of 512;
4. **a root neither this ADR nor `srs.md` named before now:** `bracketClosesLater`
   returns at the **first line bearing any `]`**, so a line that does not
   interrupt the paragraph but carries a non-closing `]` aborts the confirmation.
   Measured on seven such lines - `[bracket]` prose, `[^1]`, `[[wk]]`, `[x]`, a
   link reference definition, `![[embed]]` and a bare `]` - each leaking 512 of
   512 where the same shape without the stray bracket leaks 0 of 512, so 3,584
   cells;
5. clause 6 and 7's precedence rules, 1,024 of 1,024.

Root 4 is the one worth carrying forward, because it is not a container problem
at all and no amount of teaching the lookahead about container prefixes would
reach it. All five are destination-only, fail-closed and prose-safe: an aborted
confirmation leaves the line exactly as the pre-NRL-63 tree had it. A **setext** heading is
the one member that is in fact carried, so clause 2's "not carried inside a
heading" is true of the ATX form only; that direction silences the destination and
is safe.

**Prose loss**, the direction that bites. 18 sources built around labels that
never close, labels closed only by a shortcut `]`, unbalanced brackets in
ordinary prose, an opener at EOF, a closer with no opener, and openers split
from their closers by each kind of block boundary, each with visible sentinels,
swept over all 512 combinations: **9,216 cells, 0 visible words lost with
`speakImageAlt` on.** The only silencing anywhere is 256 cells where
`speakImageAlt` is **off** and the words are genuinely the alt text of an image
the renderer shows as an image, which is the requirement rather than a
regression.

That sweep did **not** cover the display-math shape, and the adversarial review
of this branch found it: it was the one real prose-loss instance in this diff, of
35 mid-line kinds swept, and it is closed by clause 7a above with its own pinned
check. Independently re-measured after that guard: **0 differing cells of 860,160**
across 6 line heads x 4 label openers x 14 mid-line kinds x 5 tails x all 512
content-key combinations, so the guard is surgical and touches nothing but the
shape it names. The review also confirmed **0 prose loss at `speakImageAlt: true`**
over 16,128 corpus cells plus a 16,000-cell fuzz, and that **clause 3 holds
exactly**: 13,312 cells over 27 never-confirmed shapes, **0 differing** from base.

**`sourceIndex` lockstep**, checked numerically by UTF-16 code-unit index for
length, integrality, bounds, monotonicity and character identity: 1,304
generated sources x 512 combinations = **667,648 cells and 9,965,184 UTF-16 code
units, 0 failures**, with the base as a control at 0 as well. The checker was
mutation-tested rather than trusted: dropping one index entry, shifting one
non-space entry, reversing the tail and writing an out-of-bounds offset were each
reported.

**Non-interference.** Seven groups covering NRL-64's `outgoingCode` carry and
its guards, NRL-67's comment spans in a target, NRL-66's backslash target close,
ADR 0017's final path segment, NRL-45's link reference definitions, single-line
images and links, and ordinary prose with stray brackets: **0 differing cells of
27,648**. The eighth group is the one designed to move, cells where a label and
a code span are both live: **2,048 differing of 3,584**, every difference a
destination going silent, and the 1,536 unchanged cells are clause 6's residual
measured rather than assumed.

**Nothing was observed in Obsidian.** No deploy was made and CDP was not
attempted from this worktree, so what Obsidian itself renders for a
soft-wrapped image is still unobserved; the oracle here is CommonMark plus the
single-line behaviour of this same code, which the fixtures pin as controls
beside every new row.

## Alternatives considered

**Drop a dangling `](...)` tail.** Rejected before implementation; see clause 1.

**Make the lookahead scan to the next block boundary rather than using
`interruptsParagraph`.** Rejected: it would be a second definition of "where a
paragraph ends" sitting beside the one `codeSpanClosesLater` already has, and
the two drifting apart is a worse failure than the container residual clause 2
accepts.

**Take the last unmatched opener instead of the first** (clause 7). Measured on
`A [![alt` / `words](zdestz.png)](zouterz.png) B` with `speakImageAlt: false`:
first-wins says `A [alt words ](zouterz.png) B`, last-wins says
`A [ ](zouterz.png) B`. Both still speak the outer destination, so neither
closes the nested family, and first-wins keeps the carry's rule identical to the
code carry's. Taken on that ground rather than on the output.
