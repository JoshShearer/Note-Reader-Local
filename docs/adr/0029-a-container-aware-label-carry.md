# 0029. A container-aware label carry

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-98 (R-M09, R-M08); the lazy arm's character class corrected by
  NRL-113. Closes **root 1** and the **container members of
  root 2** of the five ADR 0023 records as residual. Amends ADR 0023 (clause 2 at
  `:56-62`, the residual-roots list, and the "re-measure the five roots"
  paragraph) and ADR 0027's cross-reference. Roots 3 and 5 are untouched, as are
  root 4's named residuals and the two pre-existing image shapes
  `![a [[N|l]] b](dest.png)` and `![alt](dest(1).png)`.

## Context

`srs.md` R-M09 promises that an image's "destination and any quoted title are
never spoken", in either position of `speakImageAlt`. NRL-63 made that true of a
soft-wrapped label in a plain paragraph. It was not true of one in a container:

```
> A ![alt
> words](zdestz.png) B

- A ![alt
  words](zdestz.png) B
```

Both spoke `zdestz.png`. Measured on this branch at its own merge base
`e4c9c1d`, by bundling the real `src/text/extract.ts` with the repo's own
esbuild and running it in bare Node:

```
> A ![alt / > words](zdestz.png) B
  speakImageAlt true   -> A [alt words](zdestz.png) B
  speakImageAlt false  -> A [alt words](zdestz.png) B
  plain-paragraph twin -> A alt words B   /   A B
```

ADR 0023 recorded this as root 1 (`interruptsParagraph` matching on the
**opener** line) and part of root 2 (matching on a line **between** opener and
closer). NRL-88 closed root 4 and deferred these two by its D-88-1, because
fixing them touches `interruptsParagraph`, which NRL-73 and NRL-74 had just
narrowed in the same run and which `codeSpanClosesLater` shares.

## Premises, settled from the renderer before any code

Read out of the installed flatpak `obsidian.asar` 1.13.7, `app.js` sha256
`8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898`. Obsidian's
markdown parser is legacy remark-parse with `options.commonmark === true`.
**NOT OBSERVED IN OBSIDIAN**: CDP port 9222 was not listening for the whole of
this work, so every renderer claim below rests on reading that file and rule 11
applies to all of it.

**A. Obsidian renders a container-prefixed soft-wrapped image AS AN IMAGE**, for
the whole family, so speaking the destination is a genuine R-M09 leak and not an
NRL-68-style not-a-defect. Module 6234 (blockquote) skips spaces and tabs per
line, takes one `>` plus one following space, and ends with
`tokenizeBlock(S.join("\n"))` - so `> A ![alt` / `> words](zdestz.png) B` becomes
the single block value `A ![alt\nwords](zdestz.png) B`. Module 745 (list) treats
an indented line as a continuation, appends an unindented non-interrupting line
too (`interruptList` is only `atxHeading` / `fencedCode` / `thematicBreak`),
strips the marker and up to four leading spaces per line, and tokenizes the
joined value. Module 9405's inline label scan has **no newline exclusion at
all**, so the label `alt\nwords` matches and the node is
`{type: "image", url: "zdestz.png"}`. A destination is not displayed.

**B. The compatibility rule is SAME OR SHALLOWER, not same or deeper.** This
**reverses** the pre-flight decision, on primary-source evidence.
`u.interruptParagraph` is
`[["thematicBreak"],["list"],["atxHeading"],["fencedCode"],["blockquote"],["html"],["setextHeading",{commonmark:!1}],["definition",{commonmark:!1}]]`,
and module 6047 gates each entry on `o.commonmark === options.commonmark`, so
`setextHeading` and `definition` are **disabled** and `table` is absent
entirely. `blockquote` and `list` ARE active. So any container marker **beyond**
the opener's own opens a new container and ends the paragraph, while a
**missing** prefix is a lazy continuation that `interruptBlockquote` and
`interruptList` tolerate for plain prose.

**C. Three shapes the ticket's framing would have had us "fix" into prose loss.**
A container marker on a continuation of a paragraph that started OUTSIDE that
container really does end the paragraph, so `A ![alt` / `> words](zdestz.png) B`,
`A ![alt` / `> mid` / `words](...)` and `A ![alt` / `- mid` / `words](...)` all
render with `words](zdestz.png) B` DISPLAYED and our leak is renderer-faithful.
A blind peel silences all three. They must keep failing closed.

**D. A callout TITLE line as the opener must fail closed.** Module 6234 matches
`/^\[!([^\]]+)\]([+\-]?)(?:\s|$)/` only when the quote's line counter is 0 and
then does `tokenizeBlock(S.shift())` for that first stripped line ALONE before
`tokenizeBlock(S.join("\n"))` on the rest, so a callout title can never join the
paragraph below it. A callout BODY line as the opener is unaffected and is
carried.

**E. The setext member of root 2 splits by shape.** Module 8671 eats up to three
leading spaces, then content to the FIRST newline (exactly ONE content line),
then requires a newline and a run of `=` or `-`; `blockMethods` is
`Object.keys(blockTokenizers)`, which puts `setextHeading` before `paragraph`, so
it fires at block start. `A ![alt` / `===` / `words](zdestz.png) B` is therefore
an h1 plus a DISPLAYED paragraph and speaking the destination is correct. With
**two or more** content lines `setextHeading` fails at block start and, being
gated out of `interruptParagraph`, cannot interrupt either - so it is one
paragraph, the image IS matched, and our speaking the destination is a genuine
leak. Not a container problem, and out of scope here.

## Decision

Four parts.

1. **Extract the peel.** The per-line loop's prefix block becomes
   `containerPrefix(line)`, a pure helper returning `{ chars, quotes, blockType,
   callout }`. One definition of "the prefix", which is the point: `cleanLine` is
   already handed `raw.slice(prefixChars)`, so without this the confirmation and
   the consumption would be two readings of the same thing, free to disagree
   about where the prefix ends. The three SIDE EFFECTS - `prevContainer = true`,
   `inList = true` and the "only a non-quote line is a list" write - stay at the
   call site and are derived from `blockType`, because a lookahead must be able
   to ask the question about a line it is not consuming. The `quotes` count
   iterates a single-level `/^\s{0,3}>\s?/` over exactly what the all-levels
   `BLOCKQUOTE` match consumed, and that the two agree is **asserted over a
   corpus**, not assumed: 20,782 lines, 14,267 of them with a non-zero prefix,
   0 mismatches of `chars`, `blockType`, `callout`, the derived side effects, or
   the level consumption.

2. **`bracketClosesLater` consumes it as a BUDGET.** The opener line's prefix is
   peeled before `interruptsParagraph`; a callout-title opener and a heading
   opener return false. Each continuation line is passed through
   `peelQuotes(line, op.quotes)` - at most the opener's own quote levels and
   **nothing else** - and the UNCHANGED `interruptsParagraph` and the UNCHANGED
   `labelClose` both run on that same peeled string.

   The budget IS premise B's rule, which is why no second predicate is needed. A
   deeper continuation keeps a leading `>` after the budget is spent and the
   unchanged BLOCKQUOTE arm rejects it. A continuation bearing a list marker
   after quote-peeling is rejected by the unchanged LIST_BULLET arm, which is
   right in every case because a marker on a continuation always starts a new
   item. A shallower-but-still-quoted continuation peels what it has and is
   accepted, matching the renderer's inner-level lazy continuation. A fully-lazy
   continuation has no prefix and is accepted exactly as today. Quote levels
   only, and not the opener's list marker: a list continuation's indent is
   whitespace, which every arm already tolerates, and peeling a marker would
   accept the new item the renderer starts there.

   `opensMathBlock` is handed the SAME BUDGET as a defaulted third parameter, so
   a container-prefixed `$$` still aborts the carry. That is root 3's territory
   and it can only fail closed. This is a **correction made at critique**: the
   first revision of this change left the budget off, on the reasoning that
   keeping `opensMathBlock` byte-identical kept the stop intact. It did not. That
   stop is the ONLY one of the label carry's four that is not an arm of
   `interruptsParagraph`, so peeling the line the predicate sees does nothing for
   it - `opensMathBlock` tests `raw.trimStart().startsWith("$$")`, which a
   `>`-prefixed line fails. Measured: `> A ![alt` / `> $$` / `> words](z.png) B`
   / `> $$` was CARRIED, where its plain twin aborts and says `A [alt equation`,
   so at `speakImageAlt: false` the fix said `A B` and silenced a line Obsidian
   displays. Obsidian renders `$$` inside a blockquote as a display-math block,
   which ends the paragraph, so the closing line is math source it shows; the
   silencing was prose loss in exactly the direction clause 3 forbids. The budget
   defaults to 0, so `codeSpanClosesLater`'s call is unchanged and that carry's
   identical pre-existing gap is neither opened nor closed. The CLOSER search
   still scans the RAW lines, because peeling never removes a `$$`. Pinned by
   `guard-nrl98-quoted-math-block-fails-closed` and its `-alt` twin, both RED
   before the correction, and by
   `guard-nrl98-quoted-complete-math-span-carried`, which holds the line that a
   complete `$$x$$` span is NOT a block opener and is still carried.

2b. **Model `interruptBlockquote`, not only `interruptParagraph`, for the two
   entries that differ.** A SECOND correction made at ship review, and the one
   that matters most, because it was found by **executing** Obsidian's own remark
   parser out of the installed asar rather than by reading it: a loader pulled the
   webpack factories out of `app.js`, instantiated the real Parser (module 1528)
   with Obsidian's own `{breaks:true, commonmark:true}` and its own math and
   comment tokenizer registrations, and parsed each shape. Read verbatim, with
   module 6047's option gate applied at `commonmark: true`, the active sets are

   ```
   interruptParagraph   thematicBreak list atxHeading fencedCode comment math
                        blockquote html
   interruptBlockquote  indentedCode fencedCode comment math atxHeading
                        setextHeading thematicBreak html list
   ```

   so once a `>` is peeled, two of them are not modelled by `interruptsParagraph`.
   **`indentedCode`** has no arm at all and is in `interruptBlockquote` only, so a
   LAZY continuation - no `>` whatever - indented four spaces or led by a tab ENDS
   the blockquote and becomes an indented CODE block that Obsidian displays
   verbatim, while the same line WITH its `>` is an ordinary paragraph
   continuation and must stay carried, `indentedCode` not being in
   `interruptParagraph`.

   **NRL-113 CORRECTING NOTE (2026-10-01).** The reasoning above is unchanged and
   still correct; what moved is the *character class* it is applied to.
   `containerCarryStops`' lazy arm reads `INDENTED_CODE`, and that constant
   carried CommonMark's tab-stop notion of "four columns" -
   `/^(?: {4}| {0,3}\t)/`. Module 134, executed out of the installed bundle
   rather than read, has **no tab-stop expansion at all**: four literal spaces, or
   one literal tab, at offset 0. So "indented four spaces or led by a tab" above
   is now literally what the arm tests, and a lead of **one to three spaces then a
   tab** no longer ends the blockquote for us, because it does not end it for the
   renderer either - one `<p>` spans the break and the destination lands in an
   `src`/`href` attribute.

   `containerCarryStops`' body is **byte-identical** across NRL-113's diff; it
   simply reads a narrower constant, and `HTML_BLOCK_OPEN` was deliberately NOT
   widened in the same diff (its own `^ {0,3}<` divergence from module 8776's
   uncapped space-and-tab loop is pre-existing and fail-closed).

   Measured on a container-carry corpus of 2 kinds x 8 container families x 12
   leads x 3 continuation modes x 512 content-key masks = **294,912 cells per
   arm**, with the renderer verdict from real rendered HTML: the destination was
   spoken in **21,504 cells on base and 0 on the fix**, **0 newly spoken**, and
   **273,408 cells are byte-identical output on both arms** rather than merely
   equal in leak count. Every moved row is a ` \t` / `  \t` / `   \t` lead in the
   `quote`, `nested-quote`, `indent-quote` or `quoted-list` family; the lone-tab
   and four-space twins are unmoved and still fail closed, which is correct,
   because those leads really do end the quote. **NOT observed live**, and
   reading-view path only. **`html`** is covered only through `opensHiddenComment`,
   i.e. `%%` and `<!--`, where the real entry fires on any block tag and swallows
   the rest of the construct into raw HTML.

   Measured before the correction, 10 shapes x 512 content-key combinations:
   **5,120 of 5,120 cells of NEW prose loss, 0 pre-existing in any of them** -
   `> A ![alt` / `    filler` / `> words](zdestz.png) B` went
   `"A [alt filler words](zdestz.png) B"` -> `"A alt filler words B"` while the
   renderer puts `words](zdestz.png) B` in a NEW blockquote and displays it. The
   premise that a blank line stops the scan so a new blockquote cannot be reached
   is FALSE: `interruptBlockquote` ends a blockquote with no blank line at all.

   `containerCarryStops(peeled, lazy)` adds exactly those two stops, at both ends,
   **gated on a container being in play** (`op.quotes > 0 || blockType === "list"`)
   so it reaches only the cells the peel newly exposes. `HTML_BLOCK_OPEN` is a
   deliberately WIDE approximation of CommonMark's seven conditions, because every
   error it can make is fail-closed; it excludes an autolink by requiring a tag
   name followed by whitespace, `/`, `>` or end of line, so `<https://x.example>`
   does not match. `lazy` uses `ANY_QUOTE_MARKER = /^\s*>/` and NOT `BLOCKQUOTE`,
   because module 6234's leading-whitespace skip is UNBOUNDED where `BLOCKQUOTE`
   caps at `\s{0,3}`: a six-space-indented `>` is still a quote line for the
   renderer, `peelQuotes` is a no-op on it, and the carry correctly confirms on the
   unpeeled text. Judging it lazy would stop it for nothing.

   Pinned by ten fixtures, seven RED before the correction and three guards in the
   counter-direction (`guard-nrl98-quoted-indented-continuation-carried`,
   `-quoted-tab-continuation-carried`, `-autolink-continuation-carried`), which are
   what stops the stop being widened into a blind indent or a blind `<` test.

   **NOT fixed, because it is pre-existing rather than exposed here:** the PLAIN
   form `A ![alt` / `<div>` / `words](dest.png) B` is already carried before
   NRL-98 and already loses that prose, measured 0 of 512 leaking on both arms.
   Closing it means an html arm on the SHARED `interruptsParagraph`, which moves
   `codeSpanClosesLater` and collides with ADR 0019's F5 guard - the collision this
   whole ticket exists to avoid. Recorded as a leftover.

3. **Relax exactly one conjunct of the BRACKET arming guard**, from
   `blockType === "paragraph"` to `(paragraph || quote || list)`. This is the
   second of two edits and it is a **measured** finding, not a reading: a
   diagnostic arm that peeled at both ends and left the guard alone left ALL
   EIGHT root-1 container shapes still leaking, because for `> A ![alt` or
   `- A ![alt` `blockType` is `"quote"`/`"list"` and the arm is gated
   independently of the predicate. NEVER `"heading"`: an ATX heading is one line
   and cannot soft-wrap. The CODE arm is untouched, so `confirmed` stays
   undefined on a container line and the `confirmed === undefined` precedence
   rule is satisfied for free.

4. **The two carries may now disagree, deliberately.** ADR 0023 clause 2 said
   the two use "the identical predicate ... so the two carries can never
   disagree about where a paragraph ends". The predicate is still identical and
   still shared byte for byte - but `bracketClosesLater` now feeds it a
   container-peeled line where `codeSpanClosesLater` feeds it the raw one, so
   they CAN disagree. That is correct: a code span cannot leave its own block,
   while a paragraph CAN span a container's lines, because the container
   tokenizers strip their prefix per line and tokenize the joined remainder. ADR
   0023 is amended rather than left standing.

## Consequences

`interruptsParagraph` itself does not move, which is what keeps ADR 0019's F5
guard (`tests/extract.test.ts`, mutation-pinned with TABLE_ROW and BLOCKQUOTE
rows against **code spans**) green by construction. Narrowing that predicate was
rejected here for exactly that reason, and it is the follow-up's problem.

THREE function bodies are byte-identical across the diff, brace-matched out of
`git show e4c9c1d:src/text/extract.ts` and out of the branch tip and compared by
sha256:

```
571b6d43e225f40801a2202c3b2d5e82ef66169bcf6e547e153c772d6037b7d1  codeSpanClosesLater
3548e8254b607e4163b14c156294e84e86e4bb86dbdb06b4374161aa9b8957b7  interruptsParagraph
13030adccb5d5a229fa1ca94e3df61668efb3d934507dd1f6e2aad1344319d05  labelClose
```

`opensMathBlock` was in that list and is NOT any more. The critique correction in
decision 2 gives it a defaulted `quoteBudget` parameter, so it moves from
`7a37672d4daa3de3a9fc3fba2b91783b4faefe3aef8c8fc4375e9c187b928997` to
`d2019f06e1e944d72d1e76d992c03ee1185d8a100ae0c1616bde64e4522e755c`. That is a
deliberate narrowing of when the carry is confirmed, in the fail-closed
direction, and it does not touch `interruptsParagraph`, so ADR 0019's F5 guard is
still green by construction.

`bracketClosesLater` itself moves, from
`1cf89106407abae0f65e7803b2692cd41d8475d26638386b195d6c5745e4fcc9` to a value the
two ship-review corrections changed again; it is not pinned by digest because it
is the function the ticket rewrites. NRL-64's
two-pass code block is unchanged, hashed at
`e7dc204f532e24ea00fadfc9162b92d272c76ebc1d4e21e7cd64a4ac6bd7d6ae`.

The three surviving digests were re-derived independently at critique with a
brace matcher written from scratch; `codeSpanClosesLater` and
`interruptsParagraph` reproduce exactly, and `labelClose`'s literal above is the
re-derived one (the figure originally recorded here, `1319d83e...`, came from a
brace matcher with a different start offset; base and tip agree under both, so
the identity claim never depended on which).

### What moved, measured on this session's own corpus against `e4c9c1d`

The recorded root 1 and root 2 totals in ADR 0023, ADR 0027 and `AGENTS.md`
were a **single number over a mixed population**, and the breakdown below
replaces them. Each row is classified by which regex of `interruptsParagraph`
matched AND by what the asar says the renderer does, which is the distinction
those numbers did not draw. Corpus: shape x 2 opener forms (image and link) x
all 512 content-key combinations.

| row | cells | base leaking | fix leaking | newly leaking |
| --- | --- | --- | --- | --- |
| 1a container opener - DEFECT | 12,288 | 12,288 | **0** | 0 |
| 1a-html, the NRL-74-unmasked `<!--`-bearing members - DEFECT | 5,120 | 5,120 | **0** | 0 |
| 1b ATX heading opener - CORRECT | 2,048 | 2,048 | 2,048 | 0 |
| 1c TABLE_ROW opener - DEFECT, not fixed here | 2,048 | 2,048 | 2,048 | 0 |
| 2a container interior, same or shallower - DEFECT | 8,192 | 8,192 | **0** | 0 |
| 2b container interior the renderer DOES break - CORRECT | 10,240 | 10,240 | 10,240 | 0 |
| 2c SETEXT, one content line - CORRECT | 2,048 | 2,048 | 2,048 | 0 |
| 2d SETEXT, two or more content lines - DEFECT, not fixed here | 2,048 | 2,048 | 2,048 | 0 |
| 2e TABLE_ROW interior - DEFECT, not fixed here | 2,048 | 2,048 | 2,048 | 0 |
| 2f blank / FENCE / HR / hidden-comment interior - CORRECT | 5,120 | 4,096 | 4,096 | 0 |

51,200 cells in all. The `1a-html` row is reported separately on purpose: it is
where the stale 5,120 figure in NRL-74's pin comment came from, and folding it in
is what made one number stand for two populations.

A second, wider enumeration of the attribute itself - destination, reference tail
and quoted title - over 13 container families x 5 shapes x 512 combinations:
**33,280 of 33,280 cells leaking at base, 0 at fix, 0 newly leaking.** The
families are blockquote, nested blockquote, lazy continuation, shallower quote,
`-`/`+`/`*` bullets, `1.` and `1)` ordered, task, quoted list, bullet-lazy and a
6-space deep indent.

### Prose loss, probed with three instruments

Widening a lookahead is what turns a fail-closed path into a prose-losing one,
and NRL-63's critique found a real prose-loss defect in exactly this area, so
none of these is sampled.

- **Named guards.** 20 guard fixtures in `tests/extract.test.ts`, all green on
  both sides. Five of them - the premise-C trio, the deeper-quote, deeper-list,
  same-marker and mixed-container shapes, and the callout-title opener - are the
  ones a blind peel silences, which is the concrete evidence the budget is
  load-bearing and not decoration.
- **Skip-path enumeration, re-derived rather than cited.** The per-line loop is
  one `for` over `lines`; every `continue` in it, inline `if (...) continue;`
  forms included, is **20 sites** - at `e4c9c1d`, lines 2289, 2292, 2303, 2310,
  2312, 2346, 2349, 2357, 2366, 2369, 2371, 2385, 2389, 2410, 2461, 2465, 2575,
  2581, 2601 and 2607, with one further `continue` in the range appearing inside
  a comment and correctly not counted. The confirmation call is at `:2530` and
  the `openBracket` write-back at `:2596`, so 16 sites precede the confirmation,
  2 sit between it and the write-back, and 2 are past it: **18 can bypass the
  arm**, which is 16 + 2 and not 16 + 2 + 2. All 18 were driven with a
  container-prefixed label whose continuation lands on that site, 512
  content-key combinations each, 9,216 cells: **0 newly spoken destinations, 0
  newly spoken hidden text, 0 newly lost displayed prose.**
- **Fuzz, 4,000 notes** with container prefixes mixed across lines at several
  depths, x 8 sampled content-key combinations = 32,000 cells. A token-level
  word diff cannot grade this change - the tokens it calls "lost" are `[alt` and
  `](zdestz.png)`, which is the fix removing markup - so the corpus carries
  distinct sentinels graded on separate axes: **0 cells newly speaking a
  destination or reference tail, 0 newly speaking text the renderer hides, 0
  losing a prose sentinel**, and 44 cells where prose INSIDE a label is silenced
  at `speakImageAlt: false`, which is the class NRL-88 documented and is correct
  by design.

### Disclosure, re-measured, three buckets kept apart

| bucket | cells | base | fix | newly spoken |
| --- | --- | --- | --- | --- |
| (i) genuinely hidden text - a line-start `%%` or `<!--` block | 28,672 | 0 | 0 | 0 |
| (ii) ADR 0019's deliberately-literal `%%` pair inside a SPOKEN code span | 8,192 | 2,048 | 2,048 | 0 |
| (iii) destination / reference tail / quoted title | 49,152 | 20,480 | 15,872 | 0 |

Bucket (ii) is kept as its own bucket for the reason NRL-44 measured: collapsing
it into (i) scores designed behaviour as a leak. Bucket (iii) is enumerated
directly rather than inferred from a two-class oracle, because a destination is
an **attribute** and sits in neither the hide nor the display class - the exact
scope limit that let NRL-74's 5,120-cell class through. Its residue is the
repeated-list-marker shapes, which are premise B's new items and must keep
leaking; the family-correct enumeration above reads 0.

### `sourceIndex` lockstep

Checked numerically by UTF-16 code-unit index - never by string search - for
length agreement, monotonic non-decreasing offsets, in-bounds offsets and
character identity, with the pre-existing `text[i] === " "` exemption for
synthesised join spaces. Over 15 prefix pairs x 8 shapes (including an astral
one and a markup-dense one) x 512 combinations = 61,440 cells: **0 failures of
any kind on both arms**, 129,024 chunks / 1,651,200 code units at base and
126,976 chunks / 747,264 code units at the fix.

The checker is **mutation-tested** so that 0 is known non-vacuous, and every row
is nonzero on BOTH arms: dropping one entry gives 90,368 length and 416,384
identity failures at the fix (129,024 / 1,208,064 at base); shifting all by one
gives 61,440 bounds and 572,288 identity; swapping two gives 90,368 monotonic and
133,888 identity; negating one gives 90,368 monotonic and 126,976 bounds.

## Residual risk

Three shapes stay open against R-M09 and go to **one** follow-up ticket, **NRL-109**, because
splitting them would leave root 2 recorded three ways:

- **root 1c**, a TABLE_ROW opener (`| A ![alt |`), 2,048 of 2,048 cells;
- **root 2e**, a TABLE_ROW interior line, 2,048 of 2,048 cells;
- **root 2d**, a setext underline after TWO OR MORE content lines, 2,048 of
  2,048 cells, for both `===` and `---`.

All three are genuine leaks: `table` is absent from Obsidian's
`interruptParagraph` entirely and `setextHeading` is gated out of it by
`commonmark: true`. A FOURTH shape is open and is PRE-EXISTING rather than opened
here: a block-level HTML tag on a continuation line of a PLAIN paragraph
(`A ![alt` / `<div>` / `words](dest.png) B`) ends the paragraph in the renderer
and we carry across it, losing the displayed prose - measured identical on both
arms. Closing it needs an html arm on the shared `interruptsParagraph`, so it
belongs with NRL-109's narrowing rather than here. A fifth, smaller one, also
unchanged on both arms and in the fail-closed direction: `opensMathBlock` uses
`trimStart()`, which accepts a tab, where the renderer's `$$` predicate skips
charCode 32 only, so `>\t$$` aborts our carry and is not a math opener for
Obsidian. That is NRL-93's family, a different predicate, and it leaks a
destination rather than losing prose. The container residue's fix direction is
**narrowing**
`interruptsParagraph`, which collides head-on with ADR 0019's F5 guard
mutation-pinning TABLE_ROW and BLOCKQUOTE as code-span carry stops for
disclosure reasons, so it must be scoped to the label carry the way this ticket
scoped the peel. Roots 3 (`opensMathBlock`, out of scope) and 5 (clause 6/7
precedence) keep the reasons ADR 0023 and ADR 0027 already record.

**R-M09 is NOT met** and the `2 of 16` MUST headline count does not move.

**NOTHING WAS OBSERVED IN OBSIDIAN.** No deploy happened and no CDP session was
attempted; port 9222 was not listening. Every renderer claim here is a reading of
`obsidian.asar`, and whether Obsidian really renders a container-prefixed
soft-wrapped image as an image - premise A, on which the whole ticket rests - is
still unverified in the app. Rule 11 applies to every number above.

Premise A was nonetheless re-derived independently at ship review, and by a
stronger method than this repo's usual asar reading: the shipped parser modules
were **executed**, so every tree quoted above is Obsidian's own output rather than
a transcription. It held - `> A ![alt` / `> words](zdestz.png) B` parses to
`blockquote > paragraph > [text, image url="zdestz.png", text]`, with the
destination a url attribute and never a text leaf - and the same for the nested,
lazy, bullet, ordered and task forms. Three stated mechanisms were WRONG without
changing the conclusion and are corrected here: module 6234's whitespace skip is
unbounded, not three-space-capped; the list de-indent regex
`/^( {1,4}|\t)?/gm` is the PEDANTIC path and Obsidian is not pedantic, the real
path being `removeIndentation`; and module 9405's `]` rule requires `(` ONLY, the
`][` reference form coming from a separate tokenizer (6252) that produces no url.
**That execution is still not the application.** It is Obsidian's READING-VIEW
remark parser; Live Preview uses a separate CodeMirror/Lezer parser nobody read,
and whether it agrees on any of these shapes is unknown.
