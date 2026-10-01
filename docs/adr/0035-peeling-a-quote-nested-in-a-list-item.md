# 0035. Peeling a quote nested in a list item

- Status: accepted
- Date: 2026-10-01
- Ticket: NRL-131 (R-M08 and R-M09; `srs.md:317`, `:328` and `:370` amended)

## Context

`containerPrefix` tried `BLOCKQUOTE` first, then `CALLOUT`, then `LIST_BULLET`,
and never went round again. `BLOCKQUOTE` is anchored, so on `- > x` it failed at
the `-`, the list marker was peeled, and the `>` stayed in the line body. Three
consequences, all reproduced at `079cf0c` by bundling the real extractor with all
nine content keys false, before anything was edited:

| note | base speaks |
|---|---|
| `- > Before x.` | `> Before x.` |
| `> - > Before x.` | `> Before x.` |
| `- - > Before x.` | `- > Before x.` (the inner `-` **and** the `>`) |
| `- >   \t<!-- ZHIDEZ` / `more` | `> <!-- ZHIDEZ` / `more` |
| `- > Before ![alt` / `  > \tplain x` / `  > more](zdestz.png) after.` | `> Before [alt` / `plain x` / `more](zdestz.png) after.` |

So the marker was spoken; a `<!--` on such a line was never line-start for
`opensHtmlBlock`'s first term, and a comment Obsidian hides was spoken; and a
soft-wrapped label inside the nested quote was never confirmed, so its
destination was spoken. Every un-nested control is correct on base: the plain
`>` forms of rows 4 and 5 speak nothing and `Before` / `after.` respectively.

This is pre-existing. NRL-115 *unmasked* it rather than introducing it.

## Decision

### 1. A LOOP inside `containerPrefix`, not an extra arm

The peel is a loop: quote levels, then a callout marker, or else a list marker
and its task checkbox, then round again. `HEADING` keeps its early return before
the loop.

Not an extra `BLOCKQUOTE` retry bolted on after `LIST_BULLET`, and not a fix
anywhere else. The comment on `containerPrefix` exists because there must be ONE
definition of "the prefix": `cleanLine` is handed `raw.slice(prefixChars)` and
`bracketClosesLater` evaluates its paragraph bound on a peeled line, so a second
reading of where the prefix ends is free to disagree with the first. `peelQuotes`
additionally derives its compatibility budget from the returned `quotes`, so
peeling in a second place splits exactly the definition this function exists to
hold.

### 2. The SECOND LIST MARKER, which is a widening past the ticket's headline

A single `BLOCKQUOTE` retry fixes `- > x` and leaves `- - > x` still saying its
inner `-`, so the loop must peel a second list marker too. That makes `- - x`
speak `x` where it used to say `- x`, which is a change the ticket's own shapes
do not name and which is recorded here as a widening rather than folded in.

Both are renderer-faithful, and that is MEASURED rather than reasoned, out of
Obsidian 1.13.7's own parser and HTML renderer run in bare Node by the harness at
`~/.local/share/note-reader-local/obsidian-parser-harness` (`app.js` sha256
`8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898`, re-extracted
from the installed flatpak this session and re-hashed, `node selftest.cjs` 6 ok,
`node oracle-selftest.cjs` 9 ok):

```
- > Before x.          <ul><li><blockquote><p>Before x.</p></blockquote></li></ul>
- - > Before x.        <ul><li><ul><li><blockquote><p>Before x.</p>...
> - > Before x.        <blockquote><ul><li><blockquote><p>Before x.</p>...
- > - > Before x.      <ul><li><blockquote><ul><li><blockquote><p>Before x.</p>...
- - nested item text   <ul><li><ul><li>nested item text</li></ul></li></ul>
- - [x] done           <ul><li><ul class="contains-task-list"><li ... data-task="x">...done</li>
```

No `>` and no inner `-` appears in any of them.

### 3. The nested `>` MUST be COUNTED in `quotes`, not merely consumed

`peelQuotes` spends `quotes` as NRL-98's same-or-shallower compatibility budget.
A peel that grew `chars` without growing the budget would leave a continuation
line bearing that `>` rejected by the UNCHANGED `BLOCKQUOTE` arm of
`interruptsParagraph`, so `bracketClosesLater` would abort, no carry would be
armed, and the destination would still be spoken. The fix would be half a fix,
closing the spoken-marker face and leaving the R-M09 face open.

Measured: with the count in place the soft-wrapped destination class falls from
9,216 of 9,216 cells to 0 for images and the same for links (section
"Evidence", axis 4).

### 4. `blockType: "quote"` is a CONSISTENCY call, not a correctness one

`- > x` now reports `blockType: "quote"`, consistent with the un-nested `> - x`,
which has always reported "quote" because `BLOCKQUOTE` is peeled before
`LIST_BULLET` is tried. Either value would pass NRL-98's BRACKET arming guard,
which accepts the disjunction `paragraph || quote || list`, so nothing about the
label carry turns on it.

**It has one real consequence, and the remedy is a fifth returned field.**
`blockType` also drove `inList` at the call site, and `inList` gates the
indented-code opener (`!blank && !inList && wasBlank && INDENTED_CODE.test(raw)`).
With "quote" the call site would stop setting it, and a four-space continuation
of `- > x` would newly be read as indented code: NEW PROSE LOSS, in the one
direction this change must not move. So `containerPrefix` returns
`outerList: boolean` - "a list marker was consumed while `quotes` was still 0",
i.e. the OUTERMOST container is a list - and the call site drives `inList` off
that. `prevContainer` stays driven off `blockType`, unchanged for every shape.
`containerPrefix` stays PURE and stays the one definition of the prefix;
`outerList` is read at exactly one site.

This is not reasoned. A DIAGNOSTIC arm was built with the call site reading
`blockType` instead, and over 60 opener-and-continuation shapes x 512 content-key
combinations it loses prose the renderer displays in **12 shapes, 256 cells each,
3,072 cells**, where the shipped `outerList` form loses more than base in **0**
shapes.

### 5. The CALLOUT arm is EXTENDED past a nested quote

The callout marker is tested if and only if quote levels were consumed in THAT
round of the loop - not on `quotes` overall, and not only on the first round.
Gating on the round is what keeps `- [!note] x` a plain list item. Measured:

```
- > [!note] Title   <div class="callout" data-callout="note" ...><div class="callout-title-inner">Title</div>
> [!note] Title     the same callout div (control)
- [!note] x         <ul><li>[!note] x</li></ul>      <- the marker IS shown
```

So Obsidian really does make a callout inside a list item, and leaving the arm
first-round-only would keep speaking `> [!note] Title` verbatim.

### 6. Termination by strict `chars` increase: NO iteration cap, NO sticky regexes

Every matcher that can fire consumes a non-empty string - `BLOCKQUOTE` needs at
least one `>`, `LIST_BULLET` a marker plus `\s+`, `TASK` a bracketed status char,
and `CALLOUT` returns - so any round that does not break strictly increases
`chars`, and `chars <= line.length` bounds the loop at `line.length` rounds.
Tighter: `BLOCKQUOTE` is an all-levels `(?:...)+` match, so a second quote peel
is only reachable after a list marker has been consumed, which bounds the count
at (number of list markers) + 1.

**No iteration cap**, deliberately: a cap is a silent truncation of the prefix,
which re-creates the two-disagreeing-readings problem decision 1 exists to
prevent. **No sticky regexes**, deliberately: `BLOCKQUOTE` and `LIST_BULLET` are
read by `interruptsParagraph` and by the `listDedented` pass as well, so a
`lastIndex` on either would be a live bug there.

The plan predicted O(prefix x length) from the per-round slice. **Measured, it is
LINEAR**, because V8's `String.prototype.slice` is an O(1) view rather than a
copy. `containerPrefix` alone, mean of 200 calls:

```
"- ".repeat(5000)            10,000 chars   0.9994 ms   (HR-shaped: never reaches containerPrefix)
"- * ".repeat(2500)          10,000 chars   1.0059 ms   (non-HR: does reach it)
"1. ".repeat(5000)           15,000 chars   1.0365 ms
"- > item text"                  13 chars   0.0005 ms
"Plain prose line."              17 chars   0.0001 ms
doubling sweep (non-HR):  2,500 0.2592 | 5,000 0.5085 | 10,000 1.0066 | 20,000 1.9818 | 40,000 4.1170 ms
```

Base is 0.0008 ms on the first row, so the worst case grew by about 1 ms on a
10,000-character line of nothing but list markers, and by 0.0003 ms on a typical
container line. Read "linear" precisely: the cost is linear in the number of peel
ROUNDS, each round's slice being an O(1) view, and base paid one round. Measured
independently at Ship on `"- > ".repeat(n) + "tail"`: n=5,000 base 0.4 ms against
7.8 ms, n=50,000 (a 200 KB single line) base 0.3 ms against 42.5 ms. Ten times the
rounds for 5.4 times the time, so the two measurements agree that nothing
quadratic is present; the 132x is base paying for one round and the loop paying
for 50,000, on an input no note contains. Note the row the brief asked for: `"- ".repeat(5000)` is HR-shaped,
so `HR.test(raw)` flushes and continues 35 lines above the `containerPrefix` call
and that line never reaches the loop in production at all; the non-HR twins are
the honest worst case.

## The replacement equivalence property

**NRL-98's property is INVALIDATED by this rewrite and is not inherited.** It was
"`containerPrefix` is an exact refactor of the inline peel, 20,782 corpus lines,
0 mismatches". A loop rewrite voids it, that corpus is **not reconstructable**,
and it **must not be re-quoted**. Four computed properties take its place,
measured against OLD = `containerPrefix` as built from the merge base, with the
difference set reported as a per-shape-class table and never as one total.

Corpus: every string and template literal in all 25 `tests/*.test.ts`, split into
lines; every line of a 4,000-note deterministic fuzz; and a hand-built nested
matrix (the eleven shapes above crossed with bullet, ordered and task markers,
0-6 leading spaces, a tab after `>`, and 2-4 nesting levels). **25,055 distinct
lines.** Per part: 5,481 test-file literals (1 differing), 9,354 fuzz lines
(1,238 differing), 10,220 matrix lines (6,950 differing).

| property | statement | failures |
|---|---|---|
| (a) FIXED POINT | `NEW(L)` equals `iterate(OLD)(L)` for every line, where `iterate` applies OLD to the remaining body until it consumes nothing, summing `chars` and `quotes`, taking `callout` from the round that returned early, `blockType` = quote if any round said quote else list if any said list else paragraph, and honouring HEADING on round 1 only. This makes the loop definitionally "OLD, iterated", which is the honest successor to "an exact refactor". | **0** |
| (b) MONOTONE EXTENSION | `NEW.chars >= OLD.chars` and `NEW.quotes >= OLD.quotes` on every line, and all four old fields are EQUAL wherever `NEW.chars === OLD.chars`. The peel can only grow. | **0** |
| (c) SIDE-EFFECT PRESERVATION | wherever the four old fields agree, `NEW.outerList === (OLD.blockType === "list")`. Computed, because this is the whole argument that decision 4's fifth field changes nothing on a non-nested line. | **0** |
| (d) THE DIRECTION | every differing line is one where OLD's own peeled body still begins with a container marker, or is a callout reached after a nested quote; and every differing line falls in a NAMED shape class. A differing line in no named class FAILS. | **0**, 0 unclassified |

Difference set, 8,189 lines:

| shape class | lines |
|---|---|
| quote-in-list | 4,203 |
| quote-in-list +callout | 161 |
| quote-in-list +task | 70 |
| quote-in-list-in-quote | 920 |
| quote-in-list-in-quote +callout | 40 |
| quote-in-list-in-quote +task | 40 |
| list-in-list | 1,712 |
| list-in-list +ordered | 938 |
| list-in-list +callout | 42 |
| list-in-list +callout+ordered | 28 |
| list-in-list +task | 21 |
| list-in-list +ordered+task | 14 |
| UNCLASSIFIED | **0** |

The classifier is shown able to fail rather than assumed to be: with its
`quote-in-list` arm removed the UNCLASSIFIED bucket fills and the property
reports FAILURE.

## Evidence

Everything below is bare Node plus the harness. **NOTHING WAS OBSERVED IN
OBSIDIAN** - no deploy happened and CDP was not used - and the harness is the
READING-VIEW parser and renderer, not the application; Live Preview's
CodeMirror/Lezer path was not read at all. Rule 11 applies to every number.

### Four sentinels, graded per shape against the renderer

A token-level word diff cannot grade this change: the tokens it calls "lost" are
`>`, `-` and `](zdestz.png)`, i.e. the fix removing markup. So `ZHIDEZ` is
author-hidden text, `ZPROSEZ` displayed prose, `zdestz` a destination and `ZLITZ`
ADR 0019's deliberately-literal `%%` pair inside a SPOKEN code span, and each
axis is graded against the renderer's verdict for that axis only.

**A DESTINATION is an ATTRIBUTE** - `<span class="internal-embed" src="zdestz.png">`
- so it sits in NEITHER the renderer's hide class nor its display class and a
two-class oracle cannot see it. That exact scope limit let NRL-74's 5,120-cell
class through, so it is enumerated DIRECTLY as its own axis and split by the
renderer's own verdict into DEST-LEAK (the renderer hides it) and DEST-LITERAL
(the renderer displays it, so speaking it is faithful). ADR 0019's bucket is kept
separate for the same reason: folded in it scores as a leak.

239 shapes x 512 content-key combinations = **122,368 cells**, 86 rows,
**31 better, 53 unchanged, 2 worse**. The large movements:

| axis | shape class | cells | base | fix |
|---|---|---|---|---|
| DISCLOSURE | nested `<!--` opener | 4,096 | 4,096 | **0** |
| DISCLOSURE | nested `%%` opener | 3,584 | 3,584 | **0** |
| DISCLOSURE | soft-wrapped + mid-line `<!--` interior | 9,216 | 9,216 | 4,608 |
| DEST-LEAK | soft-wrapped destination image | 9,216 | 9,216 | **0** |
| DEST-LEAK | soft-wrapped destination link | 9,216 | 9,216 | **0** |
| DEST-LEAK | soft-wrapped + mid-line `<!--` interior | 9,216 | 9,216 | **0** |
| DEST-LEAK | soft-wrapped + tab interior | 8,704 | 8,704 | 3,584 |
| DEST-LEAK | deep nest, 2/4/6-space continuation | 512 each | 512 each | **0** each |
| MARKER-SPOKEN | (18 nested classes) | 4,608-10,240 | 4,352-9,728 | 256-2,560 |
| ADR0019-LITERAL | `%%` pair in a spoken code span | 4,608 | 2,304 | 2,304 |
| PROSELOSS | all 20 rows | 512-10,240 | unchanged | unchanged |

Every `-` plain control row is 0 on both arms.

### The two rows that move the WRONG way, signed

| row | cells | base | fix |
|---|---|---|---|
| nested prefix + TAB + `<!--`, renderer DISPLAYS it | 4,096 | 0 | **3,584** |
| nested prefix + 4+ SPACES + `<!--`, renderer DISPLAYS it | 4,096 | 0 | **3,584** |

7,168 cells of prose loss, one mechanism. Obsidian's `indentedCode` tokenizer
sits at `blockMethods` index 2 and `html` at index 11, so a tab- or four-space-
indented line inside the quote is CODE and is DISPLAYED (`<pre><code>&#x3C;!--
ZHIDEZ</code></pre>`), while `opensHtmlBlock`'s line-start term accepts that
whitespace and we open a comment block.

**It is a PRE-EXISTING class the peel brings the nested form into, not a new
one**, and that is measured by the un-nested controls rather than argued:

| control | cells | base | fix |
|---|---|---|---|
| UN-NESTED tab `<!--` (`> `, `> > `, `>`, `  > `, `- `, ``) | 3,072 | 2,560 | 2,560 |
| UN-NESTED 4-space `<!--` | 2,560 | 2,048 | 2,048 |
| UN-NESTED tab `%%` | 3,072 | 1,024 | 1,024 |
| nested tab `%%` | 4,608 | 0 | **0** |
| nested tab `<!--` WITH a closer present | 4,096 | 3,584 | 3,584 |

So `> \t<!-- ...` already spoke nothing on base, identical on both arms, and the
fix makes `- > \t<!-- ...` agree with it. The class belongs to
NRL-93 and NRL-115 - NRL-115 is the ticket that fixes an over-hidden indented
`<!--` line - and `opensHtmlBlock` is byte-identical here. Pinned as
`pin-nrl131-nested-tab-comment-overhides`.

**One sentence that used to sit here was WRONG and is corrected rather than
deleted, because it is the reason the defect below got as far as Ship.** It read
"`%%` does NOT regress, because `opensObsidianBlock`'s `dedentedByList` term is
untouched". The reasoning is right for whitespace AFTER the `>` and **false for
whitespace INSIDE the marker's own lead**, and the `nested tab %% | 4,608 | 0 | 0`
row above is a corpus artefact of the same blind spot: every shape in it puts the
lead after the `>`.

### Decision 7, added at Ship: the peel STOPS at indented-code depth

Found by `/critique`'s lead-position sweep, which varied the whitespace position
where every corpus above held it fixed. `LIST_BULLET`'s `\s+` is greedy, so it
swallows the item's whole lead; the renderer instead puts the item's content into
`<pre><code>` once that lead passes the threshold, which makes a `>` or a second
`-` after it ORDINARY TEXT THE READER SEES. Measured out of the real renderer, for
`-`, `*` and `1.` alike:

```
-    > ZMARKZ x     <li><blockquote><p>ZMARKZ x</p>        the > IS structural
-     > ZMARKZ x    <li><pre><code>> ZMARKZ x</code></pre> the > is DISPLAYED
- \t> ZMARKZ x      <li><pre><code>> ZMARKZ x</code></pre> the > is DISPLAYED
-     - ZMARKZ x    <li><pre><code>- ZMARKZ x</code></pre> the - is DISPLAYED
```

Peeling there drops a visible marker, and worse, it leaves a following `%%` at
offset 0 of the body, where `opensObsidianBlock`'s plain line-start rule fires and
`dedentedByList` is never consulted. The exact inversion, with the real renderer
showing `> %% VISIBLE_IN_OBSIDIAN` and hiding line 4:

```
- \t> %%                        base -> ["> %%","VISIBLE_IN_OBSIDIAN"]   correct
VISIBLE_IN_OBSIDIAN             pre-guard -> ["SECRET_HIDDEN_BY_OBSIDIAN."]
%%                              both directions wrong at once
SECRET_HIDDEN_BY_OBSIDIAN.
```

So the loop now **breaks** after a list marker whose consumed run past the
marker's one separating space satisfies `INDENTED_CODE`. `INDENTED_CODE` is reused
deliberately rather than a hand-rolled "five or more, or a tab": it is this file's
one definition of the threshold, and reusing it keeps the two from drifting. The
same test is applied to `TASK`'s own run. Breaking is **fail-closed** - it leaves
the line exactly as the pre-NRL-131 tree had it - which is why what it cannot
model is a leftover rather than a regression.

Measured, 4 outer markers x 512 content-key combinations:

| row | cells | base | pre-guard | shipped |
|---|---|---|---|---|
| over-threshold lead, displayed marker NOT spoken (6 leads x 4 inner markers) | 49,152 | 0 | 12,288 reported by `/critique` on its own corpus | **0** |
| under-threshold lead, structural marker WRONGLY spoken (3 leads x 4 inner markers) | 24,576 | **24,576** | 0 | **0** |
| `- \t> %%` family: displayed prose silenced (4 outer x 4 leads) | 2,048 | 0 | 2,048 | **0** |
| `- \t> %%` family: author-hidden text SPOKEN | 2,048 | 0 | 2,048 | **0** |

The second row is the point: a guard that simply refused to peel past any extra
whitespace would have put 24,576 cells of the original defect back. Eight
fixtures pin both sides of the boundary, six of which were red before the guard.

**Residual, fail-closed and accepted.** The wider `- [x] ` marker has a different
threshold - measured, `- [x]   \t> x` is a real blockquote where `- [x] \t> x` is
code - and the guard keys on the consumed run rather than on a column, so
`- [x]   \t> x` stops and keeps speaking its `>`. Identical to base, so a leftover
of the original defect rather than a regression. Modelling it needs the column
arithmetic NRL-113 and NRL-116 own.

### 4,000-note fuzz, a floor and not the evidence

16,000 cells. DISCLOSURE 294 -> 142; PROSE LOSS 382 -> 434; DEST-LEAK 47 -> 19
with **0 newly leaking**.

**NRL-118's class is LARGER than this fuzz shows, and the fuzz figure must not be
quoted as its size.** Measured structurally at Ship, 512 content-key combinations
per prefix: a `%%` opener repeated per list item at a nested prefix silences
displayed text in 512 of 512 cells for each of `- > `, `- - > `, `> - > ` and
`- - ` against 0 on base, while the un-nested twins `- ` and `> ` already silence
it in 512 of 512 on BOTH arms. So the nested forms join that already-wrong path;
`/critique` measured the same class at 3,072 cells on its own corpus. Pinned as a
third tripwire. The fuzz numbers below are a floor on a corpus with no renderer
oracle, not the class size.

**4 cells newly leak, and they are ONE distinct note**, run down rather than
waved at. Minimally reduced to `- > %%` / `ZHIDEZ a %% ZHIDEZ b`: the peel makes
`%%` line-start, `opensObsidianBlock` recognises it, and a later `%%` at a
different container depth closes a block Obsidian keeps open. That is **NRL-118**,
whose note-scope is container-blind for us, and the three un-nested twins `%%`,
`- %%` and `> %%` all already speak exactly `ZHIDEZ b` on BASE. Pinned as
`pin-nrl131-nested-percent-note-scope`.

52 cells newly lose prose, 13 distinct notes, **0 unclassified**: 4 are the
tab-or-four-space row above, 9 are NRL-118's note scope.

### Structural coverage, not a cell count

Every skip path the per-line loop can take before the `containerPrefix` call,
driven with a nested container prefix in play - frontmatter blank and key lines,
`inComment` with and without a closer, the list-end check, `inIndentedCode` and
its opener, the fence line and fence interior, the setext underline, the HR line,
a math block outside and inside the nest, an empty body after the peel, an
HR-shaped body, `LINK_REF_DEF`, a table row, a heading, a blank line and a lazy
continuation: 20 paths x 512 = **10,240 cells, 0 newly leaking, 0 newly lost,
0 newly destination-leaking, and 0 on both arms in every axis**.

### `sourceIndex` lockstep (non-negotiable 8)

`containerPrefix.chars` IS the offset `cleanLine` is handed, so growing the peel
moves every downstream offset on the line. Checked NUMERICALLY by UTF-16
code-unit index - equal length, in bounds, non-decreasing (not strictly:
`mergeShort`'s synthesised join space can repeat the previous offset), and
`src[sourceIndex[i]] === text[i]` - over 15,683 notes x 8 content-key masks =
**125,464 cells**, 144,767 chunks and 1,783,384 code units on the fix arm.

**0 failures in all four columns on BOTH arms.**

Both exemptions are MANDATORY and PRE-EXISTING, shown by removing each from a
correct tree and reporting both arms. ADR 0004's exemption keys on the synthetic
TEXT and not on `blockType`, which `extractChunks` sets to "other" for that chunk
- and keying on `text === "equation"` is not enough either, because `mergeShort`
folds the synthetic chunk into a longer one: measured, that under-keying reported
64 identity failures on BOTH arms of a correct tree. The canonical form, taken
verbatim from `tests/extract.test.ts`, is
`text.lastIndexOf("equation", i) !== -1 && i < word + 8 && src.charCodeAt(at) === 36`.

| row | base | fix |
|---|---|---|
| clean, all four columns | 0 | 0 |
| drop-one-entry -> length | 165,159 | 144,767 |
| shift-all-by-one -> bounds | 87,064 | 74,316 |
| shift-all-by-one -> identity | 1,784,030 | 1,506,209 |
| swap-two -> monotonic | 155,683 | 132,994 |
| swap-two -> identity | 227,269 | 226,348 |
| negate-one -> monotonic | 163,599 | 144,615 |
| negate-one -> bounds | 165,159 | 144,767 |
| space exemption removed -> identity | 29,334 | 20,508 |
| equation exemption removed -> identity | 1,024 | 1,024 |

Every mutation row and both exemption rows are NONZERO on BOTH arms, so the clean
result is not the checker being unable to fail.

### `interruptsParagraph` is NOT widened

Nothing in the predicate layer moved. Proved by sha256 of each brace-matched
function body out of both trees, with an extractor that skips regex literals -
AGENTS.md's trap is `flowDepthDelta`, whose body holds `/"(?:[^"\\]|\\.)*"|'[^']*'/g`
plus the string literals `"["`, `"{"`, `"]"`, `"}"`, so a tokenizer that cannot
tell a regex literal from a string mis-pairs the quotes and reports a body that
moved when nothing did.

```
IDENTICAL  interruptsParagraph   434871f0   IDENTICAL  opensHtmlBlock        38edb566
IDENTICAL  codeSpanClosesLater   e1547b3d   IDENTICAL  inlineContainerClose  1f9d918e
IDENTICAL  labelClose            1319d83e   IDENTICAL  wikiTargetClose       11c148ca
IDENTICAL  opensMathBlock        d2019f06   IDENTICAL  peelQuotes            6229e6d5
IDENTICAL  opensObsidianBlock    932feaa9   IDENTICAL  flowDepthDelta        49457fb0
IDENTICAL  cleanLine             d306d371   MOVED      containerPrefix, extractChunks
```

`peelQuotes` is the ninth name on purpose: it is the budget CONSUMER, so if it
had moved the compatibility rule would have moved with it. Its "quote levels
ONLY, never the list marker" rule stands, because a marker on a continuation line
always starts a new item; the second-list-marker widening is an OPENER-side peel
only. The `listDedented` pass is likewise untouched, with its own single
`BLOCKQUOTE` strip and its own `LIST_BULLET` test, so `dedentedByList` answers are
unchanged.

**One correction worth recording.** A first version of the body extractor took
the first `{` after the function name, which on a TypeScript function whose RETURN
TYPE is an object literal hashes the ANNOTATION instead of the body. It reported
`containerPrefix` at 113 bytes and `labelClose` at 96 bytes with sha
`13030adc...`, and `13030adc` is the figure AGENTS.md records for `labelClose`.
So **AGENTS.md's recorded `labelClose` hash is of the type annotation, not the
function body**, and any ticket re-deriving it with a corrected extractor will get
`1319d83e` instead. That is a weaker prior measurement, not a defect introduced
here, and it is recorded rather than silently re-based.

## Consequences

- `R-M08` and `R-M09` each lose a leftover. **Neither becomes met and the
  `2 of 16` MUST headline count does not move.** Still open against R-M09: roots
  3 and 5 in full, root 4's named residuals, roots 1 and 2's three non-container
  shapes (NRL-109), and `![a [[N|l]] b](dest.png)` and `![alt](dest(1).png)`.
  Still open against R-M08: those same roots, NRL-45's `[a]: x.png "%%"`
  leftover, NRL-93's residuals and NRL-118's note-scope disclosure.
- `- - x` speaks `x` where it used to say `- x`. Renderer-faithful, and a
  user-visible change the ticket's headline shapes do not name.
- **Three** signed regressions ship, all pinned as tripwires, all pre-existing
  classes rather than new ones, all handed to the tickets that own them: 7,168
  cells to NRL-93/NRL-115 (a tab- or four-space-indented `<!--` inside the nest),
  and to NRL-118 (container-blind `%%` note scope) both the 4 fuzz cells plus 9
  fuzz notes and the structurally measured per-item `%%` opener class above.
- Decision 7's guard was added at Ship after `/critique` found a 2,048-cell
  two-directional inversion the whole corpus above was blind to. The lesson is the
  corpus, not the code: every probe held the whitespace AFTER the `>` and varied
  everything else, so no cell in 122,368 could see a lead INSIDE the marker. A
  later ticket in this family should vary the position of whitespace, not only its
  amount.
- **AC4 of the ticket is OUT OF SCOPE.** The four `pin-nrl115-*` tripwires it
  names do not exist on this base, NRL-115 being unmerged (zero `nrl115` hits in
  `tests/extract.test.ts`). Whoever lands second updates them.
- The worst case grew by about 1 ms on a 10,000-character marker-only line. No
  cap and no sticky regex may be added to "fix" it; see decision 6.

## Not verified in Obsidian

No deploy, no CDP session, no Live Preview. Every verdict here comes from
executing Obsidian 1.13.7's shipped reading-view parser and HTML renderer in bare
Node, which is much stronger than reading them and is still not the running app.
