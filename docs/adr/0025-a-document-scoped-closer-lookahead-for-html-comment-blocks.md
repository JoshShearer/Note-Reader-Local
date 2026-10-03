# 0025. A document-scoped closer lookahead for HTML comment blocks

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-74 (R-M08), then NRL-95 (R-M08), which bounded term 2 of the rule
  to the opener's paragraph and rewrote decisions 3 and 4, the "Known gap"
  section and the residual list below. Amends ADR 0006 clauses 2, 3 and 4;
  corrects two sentences in ADR 0018; adds a one-line amendment to ADR 0019 and
  ADR 0023.
- NOTE ON THE TITLE: "document-scoped" describes term 1 only as of NRL-95. The
  file name is kept so existing references still resolve.
- Amended by NRL-114 (R-M08), 2026-10-02: the term-2 bound reads a quoted line's
  quote-peeled body, and term 2 is masked on a container line module 134 makes
  code. See "AMENDED by NRL-114" at the end.
- Amended by NRL-115 (R-M08), 2026-10-01: term 1's `.trim()` is right only where
  module 8776 is REACHED, and for an indented paragraph continuation or an indented
  fresh block inside a container it is not. See "AMENDED by NRL-115" at the end; the
  decision 1 paragraph calling `.trim()` correct for `<!--` carries a pointer.

## Context

`Plain prose <!--` / `SECRETA` / `more` spoke `"Plain prose"`. An unmatched
mid-line `<!--` opened a document-level comment block and silenced the rest of
the note, while the `%%` sibling of exactly the same shape correctly stayed
literal and spoke all three lines (NRL-68, ADR 0006 clause 2). That is prose
loss, not leaked markup: it discards text the renderer displays, which is the
direction ADR 0007 clause 6 and ADR 0018 both refuse.

The ticket proposed hoisting `cleanLine`'s line-start guard out from under its
`obsidianComment` gate, so that the guard applied to `<!--` too. That was built
and A/B'd against the suite before any of this was written, and it **breaks five
pins**, including `obsidian-inside-html-block` (cited here as
`tests/extract.test.ts:1187`; it is in fact at `:1201`, and NRL-95 corrected the
reference), the very pin the ticket's own acceptance criteria say must keep
passing. The ticket mischaracterises that pin as line-start-and-unclosed. It is a
**mid-line** `<!--` whose `-->` sits four lines later, past a fence and past a
`$$` line, and it required the text between them to be hidden. A pure line-start
rule cannot express it. **That pin's expectation was itself wrong and NRL-95
replaced it** - see decision 3 - so read this paragraph as NRL-74's reasoning at
the time rather than as current state.

## Decision

1. **The rule is two terms, and neither is sufficient alone.** A `<!--` opens a
   document-level HTML comment block when it has no `-->` after it on its own
   line **and either**

   - only whitespace precedes it on the line (term 1, line-local), **or**
   - some **later** line carries `-->` (term 2; document-scoped as NRL-74
     shipped it, bounded by the opener's paragraph as of NRL-95 - decision 3).

   Anything else - a mid-line `<!--` with no closer anywhere - is literal text
   that CommonMark renders and Obsidian displays, so it is spoken, delimiters
   included, exactly as an unmatched mid-line `%%` already is.

   **Term 1 was read out of the installed `obsidian.asar` in the NRL-74 session
   and the tokenizer agrees with it exactly.** Module 8776 is the HTML block
   tokenizer. It skips leading characters while they are `\t` or `" "` - spaces
   **and tabs**, with **no three-space cap** - then requires `<`, then tests the
   opener set against the first line only. The `<!--` entry is

   ```js
   u = /^<!--/,  h = /-->/          // [u, h, true] in the opener table
   ```

   `u` is **anchored**, so a mid-line `<!--` cannot open a block at all. The
   third element of the table entry is `true`, so a line-start `<!--` does
   interrupt a paragraph.

   The closer is a two-stage test, and the **first stage was stated wrongly in
   the first draft of this ADR**. Corrected at ship review by re-reading the same
   module:

   ```js
   if (A = i, !M[1].test(w))        // w is STILL THE FIRST LINE here
       for (; A < D; ) { ...walk later lines until M[1] matches... }
   ```

   So `h` is tested against the **opener's own line first**. If `-->` is present
   there the loop never runs and the block is that one line and nothing more;
   only when it is absent does the scan walk later lines, and if none matches it
   reaches the end of input and hides through EOF. The EOF half matches what we
   already did and was not changed. The same-line half is what makes
   `<!--x--> prose <!--` (no `-->` anywhere later) a **one-line** block in
   Obsidian with the next line displayed, which is the shape the ship review used
   to rule out a suspected new disclosure - see "Independently re-measured"
   below. Our `cleanLine` reaches the same answer by a different route, because
   it tests `close !== -1` per opener before it ever consults `opensHtmlBlock`.

   One welcome consequence of reading it: because that skip loop accepts tabs,
   our `view.slice(0, at).trim() === ""` is **correct** for `<!--`. The same
   expression is *wrong* for `%%`, whose tokenizer skips charCode 32 only - that
   is NRL-93, and it is not shared.

   **AMENDED by NRL-115: half of that paragraph is wrong.** The skip loop does
   accept tabs, and `.trim()` is the right test for an UNINDENTED mid-line or
   line-start `<!--`, which is the shape NRL-74 was fixing. But module 8776 is
   never reached for a paragraph continuation led by a tab or four columns, nor
   for a fresh block inside a quote or a list item led by a tab or four spaces,
   so for those lines `.trim()` opened a block the renderer never opens. The
   `<!--` and `%%` defects are different defects, and they do share that
   root (module 8607's lazy-continuation branch). See "AMENDED by NRL-115".

   **Term 2 is the renderer's INLINE path, and it is weaker evidence.** A
   mid-line `<!--` reaches module 4839's `.T` regex via module 7648, whose
   comment alternative is

   ```
   <!----> | <!--(?:-?[^>-])(?:-?[^-])*-->
   ```

   It requires a closer, and its negated character classes admit `\n`, so it
   does cross a soft line break. With no `-->` the `<` falls through to the text
   tokenizer and the delimiters are displayed - which is the defect direction,
   confirmed from the renderer rather than reasoned. But that path is
   **paragraph-scoped**, where NRL-74's was document-scoped. NRL-95 bounded it;
   see decision 3 and "CLOSED by NRL-95" below.

2. **Two predicates, not one.** `opensHtmlBlock(view, at, closesLater)` sits
   beside `opensObsidianBlock(view, at)` and is deliberately separate:

   ```ts
   function opensHtmlBlock(view: string, at: number, closesLater: boolean): boolean {
       return view.slice(0, at).trim() === "" || closesLater;
   }
   ```

   The two bodies show why. `%%` carries the lone-`%` disqualifier and no
   lookahead; `<!--` carries a lookahead and no disqualifier. Merging them would
   import `if (37 === a) return` into `<!--`, which D-73-4, ADR 0006 clause 2 and
   `srs.md`'s `%%` bullet all forbid in as many words. This is the case NRL-66's
   "do not merge two scans that answer different questions" note describes, where
   NRL-73's merge of two askings of the *same* question was the opposite case.

3. **The two terms have DIFFERENT scopes, and that is the renderer's own
   asymmetry rather than an inconsistency.** Term 1 scans to EOF; term 2 is
   bounded by the end of the opener's paragraph. Record it as two things and not
   one, because the two terms answer to two different renderer paths:

   | term | renderer path | our scope |
   |---|---|---|
   | 1, line-start | HTML **block** tokenizer, module 8776 | **EOF - correct**, that tokenizer really does walk to end of input once it has opened |
   | 2, `closesLater` | **inline** raw-HTML tokenizer, module 4839 `.T` | **the opener's paragraph** (NRL-95), matching a regex applied to one paragraph's inline text |

   NRL-74 shipped a single shared EOF scan for both, and recorded term 2's half
   as a divergence carried knowingly. **NRL-95 closed it.** What follows is the
   resolution, replacing NRL-74's "the evidence is weak and was not
   re-litigated" paragraphs.

   The only justification NRL-74 offered for term 2's EOF scope was one pin,
   cited there as `:1187` and in fact at `tests/extract.test.ts:1201`, whose
   fixture NRL-74's own text mis-quoted:

   ```
   Before <!--
   %%
   ```
   $$
   --> after.
   Visible.
   ```

   It expected `"Before after. Visible."`, and its `-->` is reachable only
   across a `%%` line, a fence and a `$$` line, so any paragraph bound fails it.
   NRL-74 already conceded that this was weak evidence. **NRL-95 showed the pin
   was wrong, and wrong in a worse way than prose loss: its old expectation
   encoded a DISCLOSURE.** Three independent lines converge on `"Before <!--"`:

   - **the asar read.** Module 8776 returns early unless `<` is the first
     non-tab/space character, so this mid-line `<!--` never reaches the HTML
     block tokenizer at all. It reaches module 7648's inline path, module 4839's
     `.T`, applied to the one-line paragraph `Before <!--`, which holds no
     `-->`. So Obsidian displays `Before <!--` literally. Line 2's `%%` is
     line-start with no lone `%`, so the `%%` block tokenizer opens a comment
     there that never closes and hides lines 2-6.
   - **the paragraph-bounded arm**, built from `4dcb753` and run in NRL-95's
     Implement session, independently produces exactly `"Before <!--"`.
   - **NRL-74's own self-tested oracle**, re-run unmodified in that session with
     all 21 hand-traced cases still passing, says `Before` is DISPLAYED while
     `after.` and `Visible` are HIDDEN. So the old expectation spoke two
     sentinels Obsidian hides.

   The pin was **replaced in place** per the NRL-66/NRL-67 convention: same
   name, same fixture, expectation `"Before <!--"`. It is now the evidence
   AGAINST term 2's EOF scope, not for it.

   Term 1 keeps its EOF scan, and that is not a compromise: module 8776 is the
   rule it mirrors.

4. **The scope is delivered as an explicit parameter, never ambient state and
   never a callback into `cleanLine`.** `extractChunks` computes per-line boolean
   arrays, once, right after `source.split("\n")`. NRL-95 shipped one array and
   one backward pass; **NRL-111 added a forward pass in front of it**, because one
   term of the stop set is not answerable from the line alone (see the amendment
   at the end of this decision):

   ```ts
   const term2Stop: boolean[] = new Array<boolean>(lines.length).fill(false);
   {
       let paraLinesAbove = 0;
       for (let k = 0; k < lines.length; k++) {
           const line = lines[k]!;
           term2Stop[k] = endsTerm2Scan(line, paraLinesAbove);
           paraLinesAbove = endsTerm2Block(line, paraLinesAbove) ? 0 : paraLinesAbove + 1;
       }
   }
   const htmlCloserAhead: boolean[] = new Array<boolean>(lines.length).fill(false);
   let ahead = false;
   for (let k = lines.length - 1; k >= 0; k--) {
       const line = lines[k]!;
       htmlCloserAhead[k] = ahead;
       if (term2Stop[k]!) { ahead = false; continue; }
       if (line.includes("-->")) ahead = true;
   }
   ```

   The two passes cannot be one loop in either direction: the content-line count
   depends on lines BEFORE `k` and the closer carry on lines AFTER it. Both are
   O(L) and the pair is still O(L).

   `htmlCloserAhead[n]` is exactly "some line AFTER `n`, and before the first
   line that ends `n`'s paragraph, carries a closer". NRL-74 shipped a scalar,
   `lastHtmlCloser`, and `lastHtmlCloser > n`; NRL-95 replaced it, because the
   bound is per-line and a scalar cannot carry one. **The O(L^3) reasoning
   survives verbatim as the reason a per-call rescan is still refused:** a helper
   that rescanned `lines` per test would be an O(L) scan inside
   `codeSpanClosesLater`'s O(L) loop inside `extractChunks`' O(L) loop. The array
   is O(L) time once, O(1) per test, and O(L) booleans of extra memory.
   Rejected: a `paragraphEnd: number[]` array plus the old scalar (strictly more
   work and more state for the same answer), and lazy memoised computation (extra
   mutable state for no gain).

   Three details of that loop are load-bearing. The assignment **precedes**
   folding line `k` in, which is the old scalar's strict `>` - a `-->` on line
   `n` cannot close an opener later on `n`, and the caller has already ruled out
   one after the opener on that line. `ahead` is **reset at a stop line**,
   because a paragraph cannot see past its own end. And a `-->` sitting **ON** a
   stop line is deliberately unreachable from earlier lines, while the stop line
   itself still gets the following run's answer - which is what keeps
   `table-tracking` and `heading-html-tracking` green.

   **THE MUTUAL-RECURSION TRAP.** The bound predicate is a separate, comment-blind
   helper, `endsTerm2Scan`, and it MUST NOT be `interruptsParagraph`:

   ```
   interruptsParagraph -> opensHiddenComment -> opensHtmlBlock -> consumes this answer
   ```

   so reusing `interruptsParagraph` here is mutually recursive - unbounded, or
   needing a sentinel argument threaded through four functions to break the
   cycle. `endsTerm2Scan` is comment-blind by construction rather than by a flag
   for exactly that reason. Do not "simplify" it into a call to
   `interruptsParagraph`.

   **Its stop set is `interruptsParagraph`'s terms with `BLOCKQUOTE` and
   `TABLE_ROW` dropped, `LIST_BULLET` REPLACED by `TERM2_LIST`, and `SETEXT`
   SPLIT INTO THREE (NRL-111)**, and the four departures are four different
   reasons rather than one. The list half was corrected at NRL-95's ship review;
   the earlier draft of this ADR dropped `LIST_BULLET` whole on a justification
   that measurement falsified. See the residual list below.

   **AMENDED BY NRL-111: the `SETEXT` term as NRL-95 shipped it was a stop the
   renderer does not have, and the reasoning for it in this ADR rested on an
   INVERTED PREMISE.** This paragraph replaces that reasoning rather than sitting
   beside it, and two other places in this file that stated the premise have been
   corrected in place as well.

   The inverted premise was that Obsidian runs with `commonmark` **falsy**, which
   this ADR inferred from `u.interruptParagraph` holding
   `["setextHeading",{commonmark:!1}]` and `["definition",{commonmark:!1}]`
   entries at all. It is the opposite. `VT.globalOptions` is
   `{breaks:!0, commonmark:!0}` and the sole parse entry applies it, so
   `options.commonmark` is **TRUE**; module 6047 gates each entry on
   `o.commonmark === n.options.commonmark`, so those two `{commonmark:!1}` entries
   are the **DISABLED** ones. **`setextHeading` and `definition` do not interrupt
   a paragraph in Obsidian at all.** A setext underline ends a paragraph only
   through the setextHeading **block** tokenizer, module 8671, which takes exactly
   **one** content line.

   So the term needs **block position**, which a line-local regex cannot supply,
   and that is why `endsTerm2Scan` gained a `paraLinesAbove` parameter and why
   `extractChunks` gained the forward pass above. Deleting `SETEXT.test(line)` is
   **not** the fix: measured, an arm identical to shipped minus that one term is
   RED on `pin-nrl95-setext-between` and newly LOSES 36,864 cells of text the
   renderer displays.

   The split is three terms with three independent justifications, each one read
   off **real rendered HTML** produced by executing Obsidian 1.13.7's own parser
   and renderer in Node (the durable harness at
   `~/.local/share/note-reader-local/obsidian-parser-harness/`), not off a
   transcription:

   | term | shape | gated? | why it stops |
   |---|---|---|---|
   | `TERM2_SETEXT_EQ` | `/^=+\r?$/` | **yes**, `paraLinesAbove === 1` | module 8671's one-content-line rule. Measured: `Title` / `===` is `<h1>`; `Title` / ` ===`, `Title` / `===  `, `Title` / `===\t` and `Title` / `\t===` are each one `<p>` with the `===` as prose, so the shape is exact and NOT CommonMark's `^ {0,3}...\s*$` |
   | `TERM2_LONE_DASH` | `/^ {0,3}-\s*$/` | no | a bare `-` is a LIST item starting: module 745 accepts a marker with nothing after it, and `list` is in `u.interruptParagraph` unconditionally. Measured: `Prose <!--` / `more` / `-` / `HIDDENE` / `--> t.` renders `<p>...</p><ul><li>HIDDENE...` |
   | `TERM2_DASH_RUN` | `/^ {0,3}--+\s*$/` | no | module 4839's `.T` body cannot consume two consecutive dashes, so a `--` anywhere between opener and closer makes the construct fail to match whatever the block structure is. Measured: that shape renders as ONE `<p>` with every line visible |
   | `TERM2_SETEXT_DASH` | `/^--+\r?$/` | **yes**, `paraLinesAbove === 1` | **ADDED BY NRL-111's SECOND PASS**, see the F4 correction below. A dash run that IS its block's second line is a setext `<h2>` and therefore a real BLOCK END, which the first draft denied unconditionally. Measured: `Lead.` / `--` is `<h2 data-heading="Lead.">Lead.</h2>`, while `Lead.` / ` --`, `Lead.` / `-- ` and `Lead.` / `--\t` are each one `<p>` - so the shape is exact, measured rather than assumed symmetric with the `=` half, and `\r?` holds because `Lead.\r\n--\r\n` is still an `<h2>` |

   The union of the four dash/eq shapes is **not** `SETEXT`: ` ===` and `===  `
   lose their stop. That is deliberate and it closes cells rather than opening
   them, the renderer having no underline there either.

   **`endsTerm2Block` is split out from `endsTerm2Scan`, and conflating them is a
   measured disclosure.** The content-line count resets on `endsTerm2Block` only.
   `TERM2_DASH_RUN` is the one term that stops the scan **without ending a block**,
   so `--` / `Prose <!--` / `===` / `HIDDENE` / `--> t.` gives its `===` two
   content lines above it, which is not an underline, and the renderer hides
   `HIDDENE`. An arm that reset the count there speaks it: measured at 3,072 cells
   and RED on `pin-nrl111-dash-pair-is-not-a-block-end`.

   **CORRECTED BY NRL-111's SECOND PASS, and the correction is the F4 finding.**
   "Without ending a block" is true of a dash run OFF a block's second line and
   false ON it, where the setextHeading tokenizer reaches it first and makes it an
   `<h2>`. The first draft gated the `=` run on block position and left the dash
   run position-INDEPENDENT, i.e. it repeated for dashes the exact error it had
   just fixed for `=`. So `Lead.` / `--` / `Prose <!--` / `===` / `HIDDENE` /
   `--> t.` gave the `===` four content lines, did not stop, and dropped text the
   renderer displays: **512 cells of prose loss, green on base 874410d and red on
   the first draft**, now pinned as
   `pin-nrl111-dash-run-on-a-second-line-is-an-h2`. The remedy is a FOURTH term,
   `TERM2_SETEXT_DASH`, in `endsTerm2Block` only and under the identical
   `paraLinesAbove === 1` gate; `TERM2_DASH_RUN` keeps its ungated place in
   `endsTerm2Scan`, which is why the two stay separate patterns rather than
   becoming one with one gate. The other direction is pinned too, by
   `guard-nrl111-dash-run-off-a-second-line-is-not-an-h2`, which is RED on base and
   RED on the arm that makes the dash run a block end unconditionally.

   **Direction of the whole change, proved exhaustively over a bounded alphabet
   rather than sampled.** Over every line of length <= 5 drawn from the 14
   characters the predicate can read, at each of four content-line counts
   (579,195 lines, 2,316,780 (line, count) pairs): **1,960 widenings, every one of
   them a `1)` ordered marker; 387 narrowings, every one of them an `=` run; 0
   cases where `endsTerm2Block` holds without `endsTerm2Scan`; and 0 cases where
   `endsTerm2Scan` holds without `endsTerm2Block` other than a dash run.** Each
   clause was shown live by emptying its exception set, which turns the same run
   red at 1,960 and 387 respectively, and by an arm whose `TERM2_LIST` is widened
   to `\d+[.)]`, which produces 5,136 violations of the first clause. **The bound
   is real and must be stated with the claim: lines longer than 5 characters and
   characters outside that alphabet are not covered, so this is a proof over the
   enumerated domain and a strong argument - not a proof - outside it.**

   **RE-RUN WITH A SIGN BY NRL-111's SECOND PASS, and the sign is the part that
   mattered.** The figures above classify each divergence and say nothing about
   whether the renderer shows or hides the line, which is how an argument that
   correctly identified `1)` as the only widening class coexisted with a 7,168-cell
   disclosure inside that very class. The re-run asks the renderer about **every
   diverging (line, count) PAIR at its own count**, not per line at `k=1` - a
   per-line sign is simply wrong for a position-gated term, since the same line
   stops at 1 and does not at 2. Over the same alphabet and bound (813,615 lines,
   3,254,460 pairs) against base 874410d:

   - **2,064 widenings, every one a `1)` at a capped indent, 0 unclassified. Sign:
     the renderer DISPLAYS the line in 2,064 of 2,064, so every widening is a
     correct prose-loss fix and none is a disclosure.**
   - **7,627 narrowings: 387 an `=` run off a block's second line, 7,240 a list
     marker past three columns of indent, 0 unclassified. Sign: the renderer HIDES
     the line in 387 of 387 and in 7,224 of 7,240, so all but 16 narrowings remove
     a disclosure.**
   - The 16 exceptions were run down rather than rounded off: they are four
     distinct lines (`\t* --`, `\t*\t--`, `\t+ --`, `\t+\t--`) at four counts each,
     and the renderer shows them because the line holds a **mid-line `--`** that
     module 4839's regex cannot cross, not because the marker interrupts. That is
     **F2**, the already-pinned out-of-scope root
     (`tripwire-nrl111-f2-midline-dashes-between-opener-and-closer`), which the
     uncapped pattern had been catching by accident. Not a new class.

   The probe demonstrably discriminates: run identically against the FIRST DRAFT it
   reports 8 **unclassified** widenings - `"\t1) "` and `"\t1)\t"` at each of four
   counts - and signs all 8 as lines the renderer HIDES. The same bound caveat
   applies to the signed re-run as to the original.

   The value still reaches `cleanLine` as a **scalar** ninth parameter,
   `htmlCloserAhead[lineNo]!`, **appended** because six of the ten call sites
   bind positionally. So `cleanLine` stays line-local, it mirrors `outgoingCode`
   (NRL-64) and `outgoingBracket` (NRL-63) in SHAPE, and it still asks nothing
   about this line, so it **adds no pass**. There are still three.

   A module-level flag was built first and was the fifth pin failure: it leaked
   into the recursive label `cleanLine` call and broke `local-html-state`. That
   warning still applies.

5. **The new literal escape gates `blockComments` POSITIVELY, where the `%%`
   escape negates it.** This reads like a typo and is not:

   ```ts
   if (close === -1 && obsidianComment && !(blockComments && opensObsidianBlock(raw, i))) { ... }
   if (close === -1 && htmlComment && blockComments && !opensHtmlBlock(raw, i, htmlClosesLater)) { ... }
   ```

   A recursively cleaned label passes `blockComments` false. Written
   symmetrically, such a call would take the escape and make `<!--` literal
   inside a label; `local-html-state` (`tests/extract.test.ts:1197`) and
   `srs.md`'s non-nesting bullet both require the opposite - an unmatched `<!--`
   inside a label truncates locally. `%%` can afford the symmetric form because
   literal is the right answer for it in both modes. Changing what a label does
   with `<!--` is a different ticket. All four characters are emitted with their
   true raw offsets and `i` advances past them; emitting only `<` would re-enter
   the loop at `!--` and risk the autolink or raw-HTML branch claiming it.

6. **Narrowing `opensHiddenComment` is MANDATORY and ships in the same change.**
   The `cleanLine` half alone is not a safe subset, and this is the conclusion a
   future reader is most likely to "simplify" away, so it is measured rather than
   asserted. Built as its own arm against base `8635ed2`: over **2,560
   destination-bearing cells** (5 shapes x 512 content-key combinations, **all of
   them plain-paragraph**), `zdestz` is spoken in **0 on base, 0 on the full fix,
   and 2,560 on the `cleanLine`-only variant**. The mechanism is that the
   now-literal `<!--` stops the label line truncating, so the unmatched `![`
   survives to the carry site - but with `opensHiddenComment` left wide,
   `bracketClosesLater` still refuses to confirm, the label is never recognised,
   and the whole construct including `(zdestz.png)` falls through as prose. That
   turns an R-M08 prose-loss defect into an R-M09 destination leak.
   `pin-nrl74-label-destination-not-spoken`, its `-alt` twin and
   `pin-nrl74-link-label-destination-not-spoken` are the only things in the suite
   that would catch a revert.

   **CORRECTION. "0 on the full fix" holds for the plain shapes only.** The
   sentence above was written as though it settled the destination question for
   the whole fix, and it does not: PR #113 was blocked for asserting exactly that.
   Put a **container prefix** on the same construct and the full fix speaks the
   destination. `> Before ![alt <!--x` / `> more](zdestz.png) after.` goes
   `"Before [alt"` on base to `"Before [alt <!--x more](zdestz.png) after."` on
   the fix. Measured at correction against base `5009eb6`, both arms bundled with
   the repo's own esbuild: **5,120 of 6,144 cells newly speak `zdestz`, base 0 and
   fix 512 in each of 10 shapes** (blockquote / nested quote / bullet / ordered /
   task, x image, link, x 512 content-key combinations). The **plain** family is
   **0 -> 0**, re-measured over 8 plain shapes / **4,096 cells**.

   **The cause is this fix unmasking NRL-88 root 1, not a mechanism of its own.**
   The identical container shapes **without** the `<!--` already speak the
   destination **5,120 of 5,120 on base and on the fix alike**:
   `bracketClosesLater` runs `interruptsParagraph` over the opener line, which
   matches `BLOCKQUOTE` and `LIST_BULLET`, so a container-prefixed label is never
   confirmed either way. Base's 0 on the `<!--`-bearing members was the prose-loss
   defect masking them - it hid the destination by swallowing the note - and
   removing the prose loss exposes what was already broken underneath. Traced
   rather than assumed: a **3-space indent**, which `interruptsParagraph` does not
   match, is **0 -> 0** on the same corpus with the destination correctly dropped.
   So it is **root 1**, not root 2.

   This is **not** grounds to revert decision 6 or the fix: you do not keep a
   prose-loss defect in order to mask a destination leak, and the leak was already
   present for every container-prefixed label that did not happen to carry a
   `<!--`. It is grounds to record it and pin it, which
   `pin-nrl74-container-label-still-leaks-destination` does **as a tripwire, not as
   evidence** - when NRL-88 closes root 1 that fixture's expectation must change.
   CommonMark parses these as valid images, so the destination is an attribute the
   renderer never displays and speaking it is a real R-M09 disclosure.

7. **Adopting the line-start term ALONE is FORBIDDEN.** `opensHiddenComment` can
   answer term 1 from its own argument and not term 2, so half the rule looks
   free. It is a measured disclosure. Built as a fourth arm:

   ```
   Before `a
   Prose <!--
   HIDDENX
   --> b` after.          (skipInlineCode: false)
   ```

   base `"Before a Prose b after."`, full fix `"Before a Prose b after."`,
   line-start-only variant `"Before a Prose <!-- HIDDENX --> b after."`. The
   half-rule answers false for a mid-line `<!--` that a later `-->` genuinely
   closes, so `codeSpanClosesLater` confirms a carry across a line that really
   does open a hidden block. Over the disclosure matrices in "Verification"
   below that variant leaks **768 + 768** cells where base, the full fix and the
   `cleanLine`-only arm all leak 0. `guard-nrl74-variant-C-disclosure` pins
   against it. Both terms or neither.

## Consequences and verification

All measurement is **bare Node**, built side by side with base `8635ed2` using
the repo's own esbuild, over four arms: `base`, `fix`, `conly` (the
`cleanLine`-only variant of decision 6) and `vc` (the line-start-only variant of
decision 7). **NOTHING WAS OBSERVED IN OBSIDIAN**: no deploy happened and CDP
port 9222 was not attempted. Rule 11 applies to every number here. What *did*
happen, and is new for this family, is that the renderer side rests on reading
the installed `obsidian.asar` rather than on CommonMark reasoning - see decision
1 - which is what the plan asked for and did not expect to get.

**The oracle is keyed on what the renderer shows, never on sentinel names**, and
it is transcribed from the two tokenizers in decision 1 plus the `%%` tokenizer
NRL-73 read (re-read this session at byte 2100501, unchanged). It was self-tested
against **21 hand-traced cases** before use, and one real oracle bug was caught
that way: the `%%` tokenizer eats `t.slice(0, s)` and so leaves its closer line's
remainder displayed, where the HTML block tokenizer consumes its closer line
whole. Modelling both the same way manufactured 1,536 phantom leaks.

- **Two-class probe**, 20 shapes x 512 combinations. **Scope first, because this
  probe's "0 newly leaking" was over-read**: its classes are *text* the renderer
  hides and *text* it displays, and an image or link **destination** is an
  attribute rather than either, so the 5,120-cell destination move in decision 6's
  correction lies **outside both classes** and this probe was structurally unable
  to see it. Class A (renderer hides):
  **0 spoken on base, 0 on fix, 0 on `conly`**, out of 6,656 cells per arm.
  Class B (renderer displays): lost **9,216 -> 2,304** of 13,312. **0 cells newly
  leaking and 0 newly lost.** Of the residual 2,304: **1,024** are the known gap
  below, present identically on base; **1,280** are content exclusions doing
  their job, which the oracle cannot see because it models the renderer and not
  our toggles (256 `skipCodeBlocks`, 256 `skipFrontmatter`, 256
  `speakImageAlt: false`, 512 `skipInlineCode: true` on a span that is now
  correctly recognised - NRL-73's ship-review class).
- **Disclosure probe for the two widened lookaheads.** Both, because both call
  `interruptsParagraph`. `codeSpanClosesLater`: 17 shapes x 512 = **8,704 cells**
  (a genuine hidden block beside unmatched runs of 1, 2 and 3, a run that never
  closes, both mismatched pairs and an indented opener), hidden sentinel spoken
  **0 base / 0 fix / 0 conly / 768 vc**. `bracketClosesLater`: 6 shapes x 512 =
  **3,072 cells**, hidden sentinel **0 / 0 / 0 / 768 vc**. The `vc` column is
  what makes these non-vacuous: the probe can see the class it is looking for.
  The destination `zdestz` **in that second matrix, and in that matrix only**, is
  spoken in **2,048 of 3,072 on base, fix and `conly`** - unchanged across those
  three arms for those 6 shapes. **Do not read the "alike" as a statement about
  the diff, which is how it was originally written and is false**: outside that
  matrix the destination **does** move, 0 -> 5,120 cells in the
  container-prefixed class (decision 6's correction above), and that class is
  **root 1** - `interruptsParagraph` matching a container on the **opener** line -
  not root 2. Whether the 6 shapes in this matrix are themselves root 2 was taken
  from the original probe and **not** re-measured at correction; what was
  re-measured is the class that moved.
- **Both confirmations are structurally unweakened.** `codeSpanClosesLater` and
  `bracketClosesLater` were brace-matched out of `git show 8635ed2` and out of
  the branch: after removing ONLY the new parameter and the two
  `lastHtmlCloser > n` arguments, each body is byte-identical to base
  (sha256 `8425795b1c10a8b4` and `072d4dd483cdafd8` respectively). The loop
  structure, the `firstRunOfLength` test, the `](`/`][` test and the
  `opensMathBlock` stops are untouched.
- **Subsumption**, measured and not asserted, because the added `|| closesLater`
  is a disjunction and the property is not algebraically obvious: over a 518-line
  corpus x both values of `htmlClosesLater` = **1,036 pairs, 0 widened and 114
  narrowed**. The fix can never newly hide text by this predicate.
- **`interruptsParagraph` answer changes enumerated.** **49 of 1,036 pairs, on 49
  distinct lines, and all 49 are lines the tokenizer oracle does NOT treat as a
  comment-block opener.** That is what turns "0 leaks observed" into "0 leaks
  possible by this mechanism".
- **ADR 0019's deliberately-literal class kept separate**, as NRL-44 measured it
  must be: a `<!--` inside a SPOKEN code span is **256 / 256 EQUAL** on both
  sides in three single-line shapes and 0 / 0 in the soft-wrapped one.
- **NRL-73's two-class probe re-run** (D-74-8 requires it of whichever ticket
  merges second): 22 `%%` shapes x 512, **identical on both sides** - Class A
  512/6,656 and Class B 768/7,680 on base and on fix alike, **0 newly leaking, 0
  newly lost**, ADR 0019's literal `%%` class 512 = 512.
- **`sourceIndex` lockstep** (non-negotiable 8), numeric by UTF-16 code-unit
  index over 18 notes x 512 combinations: **fix 12,032 chunks / 184,576 units,
  0 failures on all four checks; base 9,472 / 96,768, 0 failures.** The
  `text[i] === " "` exemption is mandatory and pre-existing rather than this
  diff's: without it the fix reports 8,192 identity failures and **base reports
  512**, both nonzero. The checker is non-vacuous by **four targeted mutators,
  every row nonzero on both sides**: drop an entry (L 12,032 / 9,472), add
  `src.length` to one entry (B 12,032 / 9,472), decrement one interior entry
  below its predecessor (M 12,032 / 9,472), perturb one entry to a different
  non-space character (I 10,752 / 8,192).
- **Fuzz**, 4,000 generated notes x 2 option sets: **0 newly leaking**. 8 newly
  "lost" cells across 2 notes, all 8 at `skipInlineCode: true` and **0 at
  `skipInlineCode: false`**, all in notes carrying both a backtick and a label
  opener - the exclusion class above, not prose loss. 58 cells speak `zdestz`
  where base said nothing, and **58 of 58 speak the whole literal
  `](zdestz.png)`**, which this ADR originally dismissed as "the construct has no
  matching opener, so it is literal text the renderer also displays, not a
  destination leak". **That dismissal was wrong and it is how the class in decision
  6's correction got through.** A container-prefixed soft-wrapped label has a
  matching `![`/`[` opener *and* a matching `](...)`; speaking the whole literal is
  the symptom of the leak, not evidence against it. The fuzz saw the signal and the
  reasoning threw it away. How many of the 58 belong to that class was not
  re-measured at correction - the class was measured directly instead, at 5,120
  cells. `sourceIndex` clean on both
  arms once the synthesised `"equation"` chunk is excluded (ADR 0004 builds its
  index by hand, so `src[at]` is `$`; 306 base / 316 fix), with **0 notes failing
  on the fix that do not also fail on base**.

### Independently re-measured at ship review

The numbers above are Implement's. They were re-derived from scratch at ship
review, on a **different** shape corpus, with a checker written independently, to
avoid the failure where one probe's blind spot is the whole evidence. Same two
arms, same esbuild, base `8635ed2`. All bare Node.

- **Both confirmation bodies re-hashed.** `codeSpanClosesLater` and
  `bracketClosesLater` extracted by regex from `git show 8635ed2:src/text/extract.ts`
  and from the branch, normalised by deleting only the added parameter and the
  two `lastHtmlCloser > n` arguments: sha256 prefixes `8425795b1c10a8b4` and
  `072d4dd483cdafd8` on **both** sides, matching decision-time. `interruptsParagraph`
  is byte-identical the same way; `opensMathBlock` and `inlineContainerClose` are
  byte-identical with no normalisation at all.
- **Subsumption re-measured on a fresh corpus**: 440 generated lines (10 prefixes
  x 11 bodies x 4 tails) x both values of `closesLater` = 880 pairs. **0 widened,
  72 narrowed, 808 unchanged.** The 0 is also structural - the fix is the base
  predicate conjoined with `opensHtmlBlock` - but it was measured rather than
  argued, because that is what caught NRL-42's review defect in this same area.
- **Disclosure, three independent hidden-text corpora, 21,504 cells in total.**
  H1 (a line-start `<!--` block) 8 shapes x 512, H2 (an inline `<!--...-->` pair)
  7 shapes x 512, H3 (the paths H1 and H2 miss: a reopened closer-line remainder,
  a second opener on one line, callouts, lists, tasks, tables, frontmatter,
  headings, nested quotes, a fence and a `$$` inside the block, CRLF, no trailing
  newline, wikilinks, embeds, an autolink and CJK) 21 shapes x 512. **0 cells
  newly leaking**, after adjudicating three candidates that the first pass
  flagged and none of which is a leak:
  - `<!--` / `AAA` / `--> tail <!--` / `BBB` - a **contaminated sentinel** in the
    probe itself, exactly the class of bug Implement's oracle had: `AAA` is
    0/512 on both sides, and the 512 hits were `BBB` matching `.includes("HIDDEN3")`
    through `HIDDEN3b`. Per module 8776 the block ends at line 2 inclusive, so
    `BBB` is **displayed** and the fix speaking it is the defect being fixed.
  - `<!--x--> prose <!--` / `CCC` / `more` - resolved by the same-line closer
    correction in decision 1. Obsidian's block is line 0 alone and `CCC` is
    displayed, so the fix speaking it is correct and base hiding it was prose
    loss.
  - `---` / `title: x <!--` / `DDD` / `---` / `Body.` - not frontmatter at all on
    either side (the `<!--` breaks the frontmatter scan, and so does a `%%`), so
    it is a setext heading whose `%%` sibling **already spoke `DDD` on base**.
    256 of 512, every one at `skipHeadings: false`.
- **D-74-9 re-measured on a 5-shape corpus, all of it plain-paragraph**: `zdestz`
  spoken in **0 of 2,560 on base, 0 of 2,560 on the fix, 2,560 of 2,560 on the
  `cleanLine`-only arm**, which reproduces decision 6 exactly. **Ship review shared
  Implement's blind spot here**: a second corpus was built to avoid one probe's
  blind spot being the whole evidence, and it was plain-paragraph too, so it
  confirmed the plain result twice and never reached the container-prefixed class
  that moves 0 -> 5,120. See decision 6's correction.
- **D-74-11 re-measured** by building the symmetric variant: `[label <!--hidden](target) after.`
  / `Visible.` speaks `"label after. Visible."` on base and on the fix and
  `"label <!--hidden after. Visible."` on the symmetric arm, with the image twin
  behaving identically. The positive gate is load-bearing and the comment at the
  site is accurate.
- **`sourceIndex` lockstep, both arms**: 4,000 generated notes x a random option
  set each, checked numerically by UTF-16 code-unit index for length, bounds,
  monotonicity and character identity. **88 failures on the fix and 88 on the
  base, 0 notes failing on the fix that do not also fail on base.** All 88 are
  ADR 0004's synthesised `"equation"` chunk, whose index is built by hand so
  `src[at]` is `$` - the same artifact Implement excluded, confirmed here by
  reading the failing text rather than assumed. Clean over 10,240 extractions of
  the probe corpora with no exclusions beyond the documented join space.

### One pre-existing fixture moves, and it moves silent to spoken

`tests/extract.test.ts:959`, NRL-45 decision Q9: `[a]: x.png "<!--"` followed by
a `ZSECRETZ` line went `[]` -> `["ZSECRETZ sentence here."]`. It is the **only**
pre-existing fixture in the suite that moves. Renderer-faithful: the `<!--` is
inside a quoted title, mid-line, with no `-->` anywhere, so it opens nothing. It
also makes the shape agree with its `%%` sibling, which already spoke on base
(measured identical on both sides), and removing exactly that asymmetry is what
this ticket is for. It was **replaced in place** keeping its name and source, per
the NRL-66/NRL-67 convention. Decision Q9 itself keeps its pin: `:960`, the same
shape with a `-->` four lines down, still expects `["ZAFTERZ here."]` and is green
on both sides. Do not collapse the pair.

**NRL-95 moved the SECOND of that pair, and added a third.** With term 2 bounded
by the opener's paragraph, `[a]: x.png "<!--"` / blank / `ZSECRETZ ...` / blank /
`-->` / blank / `ZAFTERZ here.` no longer opens a comment at all: the `-->` is two
paragraphs away and the renderer's inline path cannot cross a blank line. It went
`["ZAFTERZ here."]` -> `["ZSECRETZ sentence here.", "-->", "ZAFTERZ here."]`, and
the lone `-->` line is spoken too, which is also renderer-faithful - `-->` matches
no HTML block opener and is not a tag, so it is ordinary paragraph text. It was
**replaced in place** again, and a THIRD fixture was added rather than the second
merely edited, so decision Q9's own ordering property keeps a test: the same shape
with the `-->` inside the opener's OWN paragraph still expects `["ZAFTERZ here."]`
and is green on both sides. **This fixture was not predicted by NRL-95's plan** -
its fixture sweep covered the suite's fixture ARRAYS and this one is an `expect()`
call, so it was found by running the suite. It is the only pre-existing suite
expectation NRL-95 moves other than the `:1201` pin decision 3 discusses.

### CLOSED by NRL-95: our term-2 lookahead was wider than the renderer's

NRL-74 shipped term 2 scanning to EOF while the renderer's mid-line path is the
**inline** tokenizer, which cannot cross a paragraph break. So

```
Plain prose <!--
SECRETA

New para.

--> tail.
```

was hidden by us and displayed by Obsidian. NRL-74 measured it at **1,024 cells,
identical on base and on the fix**, and re-measured the shape above at ship review
with `HIDDENP` spoken in **0 of 512 on base and 0 of 512 on the fix**. NRL-95
bounded term 2 and it now speaks: measured in NRL-95's Implement session by
bundling the real `src/text/extract.ts` from `4dcb753` and from the fix side by
side with the repo's own esbuild, the ticket's own repro went
`"Before x. Prose Tail."` -> `"Before x. Prose <!-- HIDDENP New paragraph -->
Tail."`, and across the oracle-keyed two-class probe (28 shapes x 512 content-key
combinations, 21,504 Class-B cells per arm) the text the renderer DISPLAYS but we
silenced fell from **8,448 lost to 1,792 lost, with 0 cells newly leaking and 0
newly lost**. The residual 1,792 is fully accounted for: every one of them is a
content-key exclusion the oracle cannot see, 256 cells each at one constant toggle
(`skipInlineCode` x3 rows, `skipCodeBlocks` x2, `speakImageAlt`, `skipFrontmatter`).

Two evidence notes on that number, because they matter more than the number. The
probe was run against **oracle.mjs unmodified** first and reported **1,024 cells
newly leaking in two shapes**, both of them a setext underline or a thematic break
between opener and closer. That is an **oracle limit, not a leak**: `oracle.mjs`'s
`endsParagraph` models blank / fence / ATX heading / html-opener / `%%`-opener
only, and Obsidian's own parser prototype - read out of the same installed
`obsidian.asar` in that session, `app.js` sha256
`8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898`, at byte offset
22284 - sets

```js
u.interruptParagraph = [["thematicBreak"],["list"],["atxHeading"],["fencedCode"],
  ["blockquote"],["html"],["setextHeading",{commonmark:!1}],["definition",{commonmark:!1}]]
```

so a thematic break DOES end the paragraph the inline regex is applied to.
**CORRECTED BY NRL-111: the setext half of that sentence was WRONG, and in the
disclosure direction.** `setextHeading` and `definition` carry `{commonmark:!1}`,
`VT.globalOptions` sets `commonmark:!0`, and module 6047 gates each entry on
`o.commonmark === n.options.commonmark` - so those two entries are the DISABLED
ones and a setext underline does NOT interrupt a paragraph. It ends one only as
the second line of a setextHeading block (module 8671, exactly one content line).
Treating it as an unconditional interrupter shipped a live 2,048-cell disclosure;
see decision 4's NRL-111 amendment. Note what that list does NOT contain, read at NRL-95's ship
review and load-bearing for the `TABLE_ROW` decision below: **`table`**, nowhere,
and the only two terms ever inserted into it anywhere in `app.js` are `math` and
`comment`. The numbers above are from `oracle95.mjs`, a copy of
`oracle.mjs` with those two terms added on that primary-source authority and
nothing else changed, re-run against the unmodified 21-case self-test with all 21
still passing. `list`, `blockquote` and `definition` were deliberately NOT added,
because the oracle models neither container prefix re-offering nor link reference
definitions and adding the terms without the structure would trade one wrong
answer for another.

**And the direction claim NRL-74 recorded here was BACKWARDS.** It said bounding
term 2 would **narrow** `codeSpanClosesLater` and `bracketClosesLater`. It
**WIDENS** them: bounding term 2 narrows `opensHtmlBlock` -> `opensHiddenComment`
-> `interruptsParagraph`, so both carries return false LESS often and confirm MORE
often. Measured on fixtures - a code span and a label each now survive a paragraph
break base refused - and on the predicate layer: over 697 documents / 2,794
(document, line) pairs the shipped term-2 array is **0 widened, 178 narrowed**
against base's `lastHtmlCloser > n`, a strict subset, so the change is fail-closed
by measurement rather than by argument. The three destination pins and
`guard-nrl74-variant-C-disclosure` were re-measured rather than assumed and all
four are **UNMOVED, 0 of 512 differing cells each**, because none of their `-->`s
sits outside the opener's paragraph.

### Residual risks left by NRL-95's own bound, stated plainly

- **The stop set drops `BLOCKQUOTE` and `TABLE_ROW`, and replaces `LIST_BULLET`
  with `TERM2_LIST`.** Three departures, three reasons. The first draft of this
  ADR gave one reason for all three and the ship-review critique falsified it for
  the list half, so read the three separately.

  **`BLOCKQUOTE`, dropped - correct, and compatible with `blockquote` being in
  `u.interruptParagraph`.** The renderer's blockquote tokenizer PEELS the `>`
  prefix and re-runs the paragraph tokenizer on the stripped content, so a
  continuation line of the SAME quote is never a quote STARTING;
  `u.interruptParagraph` is about the other case. So `> Prose <!--` /
  `> HIDDENQ` / `> more -->` is one paragraph inside the quote, module 4839's
  regex does find the closer, and Obsidian HIDES `HIDDENQ`. Stopping there speaks
  it. Measured: the two quote guards are RED on the arm that puts `BLOCKQUOTE`
  back. The cost is real and is now pinned as a tripwire rather than left
  unstated: where the quote STARTS after the opener (`Prose <!--` /
  `> HIDDENQ3` / `more -->`) the renderer's paragraph really does end at line 2
  and displays everything, and we hide it. Fail-closed, identical on base, and
  only fixable with container-prefix awareness - the NRL-88 root-1 class
  (`pin-nrl95-quote-starting-after-opener-still-hidden`).

  **`TABLE_ROW`, dropped - correct, and for a STRONGER reason than this ADR first
  gave.** The first reason was that our `TABLE_ROW` is `/^\s*\|/` and matches a
  lone `| a |` line GFM does not treat as a table. True but narrow. The real
  reason, read out of `app.js` this session: **`table` appears nowhere in
  `u.interruptParagraph`**, and the only two terms ever inserted into that list
  are `math` and `comment` (`RE(t.interruptParagraph,"fencedCode","math")` and
  `RE(i.interruptParagraph,"fencedCode","comment")` are the only two such calls
  in the file). So NO table row can interrupt a paragraph in Obsidian, delimiter
  row or not, and a REAL GFM table between opener and closer is hidden too.
  **Do not "fix" `TABLE_ROW` to require a delimiter row and then add it here**;
  that reopens the disclosure on exactly the real-table shape, which is why
  `guard-nrl95-real-gfm-table-closer` was added. All three table guards are RED
  on the arm that puts `TABLE_ROW` back.

  **`LIST_BULLET`, REPLACED - the first draft's reason here was FALSE and the
  behaviour was changed at ship review.** The draft said a list, like a
  blockquote, re-offers its lines as one paragraph. It does not: `- x` / `- y` /
  `- z` is three items with three paragraphs, so the closer is NOT in the
  opener's paragraph and Obsidian DISPLAYS every line. Dropping `LIST_BULLET`
  whole therefore retained prose loss with no disclosure to justify it. The
  correct term is module 745's own silent-mode rule, transcribed into
  `TERM2_LIST`: a bullet interrupts a paragraph and an ordered marker interrupts
  only when its digit string is exactly `"1"` (`if (silent && o !== "1") return`).
  `LIST_BULLET`'s `\d+[.)]` accepts `7.` and `01.`, and stopping at one of those
  IS a disclosure: two guards are RED on the arm that puts the whole of
  `LIST_BULLET` in the stop set.

  **CORRECTED BY NRL-111 on the `)` half, and the pattern changed with it.**
  NRL-95 wrote `1\.` on the premise that "Obsidian runs `commonmark` falsy, so
  `)` is not a marker". That premise is the inverted one decision 4's amendment
  corrects: `commonmark` is TRUE, module 745's marker test is
  `y === h || z && y === v` with `z = options.commonmark` and `v = ")"`, so `1)`
  IS a marker and DOES interrupt. Measured against real rendered HTML:
  `Prose <!--` / `1) HIDDENE` / `more -->` gives
  `<p>Prose &#x3C;!--</p><ol><li>HIDDENE...`, so the paragraph ends there and the
  renderer displays it; `7.`, `7)`, `01.` and `01)` all stay one `<p>` with the
  sentinel inside the comment. The term became
  `TERM2_LIST = /^ {0,3}(?:[-*+]|1[.)])[ \t]/` (and, since NRL-119, its tail is
  `(?:[ \t]|\r?$)`; see "CLOSED by NRL-119" at the end of this ADR),
  `guard-nrl95-ordered-paren-not-an-interrupter` was REPLACED IN PLACE by
  `pin-nrl111-ordered-paren-interrupts` with the opposite expectation, and two
  `)` twins of the digit-string guards were added.

  **THE SENTENCE THAT USED TO END THIS BULLET WAS WRONG AND IS THE LESSON OF
  NRL-111's SECOND PASS.** It read "this direction was prose loss rather than
  disclosure, which is why it was the lower-severity half". That is true of the
  shape the fixture pins and false of the pattern change that produced it. The
  pattern was `^[ \t]*` with **no indent cap**, so adding `1)` to it also added
  `\t1) `, `    1) `, ` \t1) ` and every other over-indented form - every one of
  which the renderer HIDES - and the widening therefore shipped a **live
  disclosure, 7,168 newly leaking cells over 14 shapes (room 9,216)**, in a ticket
  whose whole purpose was removing one. Worse, this very ADR recorded the uncapped
  indent as "wrong in the DISCLOSURE direction" two paragraphs below, so the fact
  was written down and not joined up.

  The exhaustive direction argument below was **not wrong about the class and was
  wrong about its SIGN**: it proved every widening was a `1)` ordered marker and
  then assumed a `1)` was benign, without asking the renderer whether each
  widening's own line was shown or hidden. A direction argument that names a class
  and does not sign it is not a safety argument. The second pass re-ran it with a
  per-pair sign (see below), and signing is now part of the probe rather than part
  of the prose.

  **The indent cap landed with it**, so the sentence above is now true: both halves
  of `TERM2_LIST`'s indent axis moved together, which is what this bullet's own
  prose had argued for and the first diff failed to do.

  **Two things about `TERM2_LIST`. The FIRST WAS FIXED by NRL-111's second
  pass; the second was NRL-119's remaining half and is now CLOSED by NRL-119 (see
  the section of that name at the end of this ADR).** `^[ \t]*` had NO
  indent cap, and that was wrong in the DISCLOSURE direction: module 745's list
  tokenizer gives up past three columns of indent and a tab reaches column four on
  its own, so `\t- x` and `    - x` are lazy paragraph prose and do NOT interrupt.
  Measured against real rendered HTML: `Prose <!--` / `\t- HIDDENL` / `more -->`
  renders `<p>Prose <!--\n\t- HIDDENL\nmore --></p>`, i.e. the renderer HIDES
  `HIDDENL`. The indent axis was swept with the real renderer across all five
  markers (`-`, `*`, `+`, `1.`, `1)`) and eleven indents, and the split is TOTAL
  with no mixed row: 0, 2 and 3 spaces DISPLAY the sentinel, while 4 spaces, 5
  spaces, `\t`, ` \t`, `  \t`, `   \t` and `\t\t` all HIDE it.
  `pin-nrl95-bullet-any-indent` and `pin-nrl95-bullet-tab-indent` therefore
  encoded a disclosure as expected behaviour; both were REPLACED IN PLACE by
  `pin-nrl111-bullet-four-space-indent-is-not-a-marker` and
  `pin-nrl111-bullet-tab-indent-is-not-a-marker` with the opposite expectation, and
  the pattern is now `^ {0,3}`. This closes **NRL-119's first half** as well as
  NRL-111's own widening: on a 55-shape x 512 indent corpus (11 indents x 5
  markers) base leaks **14,336 of 17,920 class-A cells** and the capped arm leaks
  **0**, with 0 newly lost and base's 2,048 class-B cells closed as well. A tab is
  Obsidian's own default indent for a nested list item, so the leaking shape was
  the ordinary one.

  The SECOND was untouched by NRL-111: the `[ \t]` requirement missed a BARE
  marker, which module 745 accepts (`next!=="\n" && next!==""` passes), so `*`,
  `+`, `1.` and `1)` alone on a line are all measured interrupters and we failed
  closed on all four - 5,120 cells, prose loss. That was **NRL-119's second half**,
  deliberately not done in NRL-111, with `pin-nrl111-bare-ordered-marker-unmasked`
  as the tripwire that stopped the stop set growing a bare-marker term by accident.
  **NRL-119 has since closed it on purpose**, with the measurement that tripwire
  asked for, and replaced the pin in place; see "CLOSED by NRL-119" below. Measured on the first pass's own list change: five
  fixtures RED against the pre-ship-review arm
  (`pin-nrl95-bullet-items-are-three-paragraphs`, `-bullet-line-between`,
  `-bullet-any-indent`, `-bullet-tab-indent`, `-ordered-one-dot-interrupts`), 0
  after; and over a **19,584-cell sweep** (3 openers x 32 middle lines x 3 tails
  x 64 content-key combinations) the arm with `TERM2_LIST` diverges from the arm
  without it in **3,456 cells and in 0 cells where an independent transcription
  of module 745's silent path says the middle line does NOT interrupt** - so the
  widening never speaks text the renderer hides. `sourceIndex` clean by numeric
  UTF-16 code-unit index over every chunk of all 19,584 cells, 0 failures.

  What survives all three: the stop set answers `true` for a strict subset of the
  lines the document-scoped predicate did, so omitting a term is fail-closed and
  ADDING one is the dangerous direction. Two residual prose losses stay, both
  pinned as tripwires and both of the container-prefix class: a quote or a bullet
  that our anchored regexes cannot see because the `>` is never peeled before the
  scan (`pin-nrl95-quote-starting-after-opener-still-hidden`,
  `pin-nrl95-bullet-inside-quote-still-hidden`). **The bullet half CLOSED with
  NRL-114** (`term2QuotedStop`, see "AMENDED by NRL-114" at the end); that pin was
  replaced in place and now expects HIDDENL spoken.
- **The scan is forward-only from the opener line and does not bound the OPENER's
  own block.** An ATX heading's or a table row's mid-line `<!--` therefore still
  reaches a later closer that module 4839's paragraph-scoped path could not.
  Over-hiding, so fail-closed; pre-existing; the same class as the already-pinned
  `heading-tracking` `%%` divergence. Pinned as
  `guard-nrl95-atx-opener-not-bounded`, identical to `heading-html-tracking`, and
  out of NRL-95's scope. So NRL-95 does NOT make term 2 fully faithful to module
  4839, and must not be read as claiming it.
- `htmlCloserAhead` is still a crude text scan within a paragraph. It counts a
  `-->` inside a code span or inside another comment on a non-stop line. NRL-95
  **partly mitigated** the older, wider form of this bullet, which said the scan
  also counted a `-->` inside a fenced block, inside frontmatter or behind a blank
  line: a fence line and a blank line now stop the scan, and frontmatter's `---`
  is matched by `HR` and by NRL-111's `TERM2_DASH_RUN` both (it was `SETEXT`/`HR`
  before NRL-111 split that term; a three-dash run still stops unconditionally),
  so a closer there no longer reaches an earlier opener. Measured: the fence and frontmatter shapes are in the
  two-class probe and neither newly leaks nor newly loses.
- `appendRemainder` hands `cleanLine` a **suffix**, so term 1 is measured from
  the remainder's start rather than the physical line's. Inherited from the `%%`
  predicate, NRL-73's own known limit, not opened here.
- `opensHiddenComment` still tests only the **first** `<!--` on a line while
  `cleanLine` walks every one, so `<!-- a --> <!-- b` already disagrees between
  the two sites. Pre-existing in both halves; not opened or closed here.
- A tab-indented `<!--` in a fresh-block position never reaches the predicate at
  all, because indented-code handling consumes the line first. Identical on both
  sides of NRL-74's diff. **AMENDED BY NRL-113 (2026-10-01), and the amendment
  inverts this bullet's verdict rather than refining it.** The bullet is kept
  because the shape is worth knowing and because its 512-of-512 figure is still
  correct about *what we speak*; it was **wrong about what the renderer does**.
  What it said: "It is a disclosure rather than prose loss ... `Before x.` /
  blank / `\t<!--` / `HIDDEN1` / `more` speaks `"Before x. HIDDEN1 more"` on
  **base and fix alike, 512 of 512 cells each**, while module 8776's skip loop
  accepts `\t`, so Obsidian opens a block there and hides `HIDDEN1`", attributed
  to NRL-93's indented-code question.
  - The premise about module 8776 is **true** and the conclusion **does not
    follow**. `blockMethods`, produced by RUNNING the real construction rather
    than reading it, puts `indentedCode` at index **2** and `html` at index
    **11**, so module 134 consumes the line and module 8776 is never consulted.
  - The real rendered HTML, from Obsidian 1.13.7's own `WT` parser and `GT`
    renderer executed in Node, is `<p>Before x.</p>` +
    `<pre><code>&#x3C;!--</code></pre>` + `<p>HIDDEN1<br>more</p>`. `HIDDEN1`
    and `more` are **DISPLAYED**, so this is **NOT a disclosure and not a
    divergence at all**, in either position of `skipCodeBlocks`. Pinned by
    `guard-nrl113-fresh-block-tab-html-is-indented-code`.
  - **The adjacent real leak was a lead of one to three spaces then a tab**,
    which module 134 does not call indented code because it does no tab-stop
    expansion. There `html` *is* reached and the body *is* hidden, and we spoke
    it. NRL-113 closed it by narrowing `INDENTED_CODE` to `/^(?: {4}|\t)/`:
    18,432 of 179,712 corpus cells leaking on base, 0 on the fix, 0 newly
    leaking, plus 21,504 of 294,912 container-carry cells where the same lead
    made us speak a destination.
  - `opensHtmlBlock` is **unchanged** and its `.trim()` is still correct for
    `<!--`, exactly as this ADR's decision 1 says. Nothing in this amendment
    merges the two predicates, and narrowing the `<!--` predicate would still
    not have helped: the fresh-block tab line genuinely is code.
- The oracle surfaced one **pre-existing** divergence unrelated to `<!--`:
  `# %% off` / `ZHZ` / `%% after ZPZ.` is spoken and hidden the opposite way round
  from what the tokenizers say, because a `%%` in an ATX heading reaches the
  anchored inline tokenizer rather than the block one. Identical on base and fix,
  pinned as `heading-tracking`, and **no ticket has been filed**.
- `interruptsParagraph`'s answer set changed AGAIN at NRL-95: **28 (document,
  line) pairs over 697 documents, on 3 distinct lines, every one of them a
  mid-line `<!--` line the tokenizer oracle does NOT call a comment-block
  opener.** So **whichever of NRL-74, NRL-95, NRL-98 and NRL-93 merges last must
  re-measure NRL-88's remaining roots.** Their numbers are neither re-measured nor
  claimed here.
- `codeSpanClosesLater` and `bracketClosesLater` were shown structurally
  unweakened rather than asserted to be: brace-matched out of both trees and
  **byte-identical modulo the threaded argument's type and the two index
  expressions**. `opensObsidianBlock`, `opensHtmlBlock`, `opensHiddenComment`,
  `interruptsParagraph`, `opensMathBlock` and `labelClose` are **byte-identical**
  across the NRL-95 diff, by sha256 of each brace-matched body.
- **NOTHING IN NRL-95 WAS OBSERVED IN OBSIDIAN.** CDP port 9222 was not listening
  and no Obsidian process was running for the whole of that run, and no deploy
  happened. Every renderer claim above, including the whole case for moving pin
  `:1201`, rests on reading `obsidian.asar` 1.13.7 (sha256 confirmed identical to
  the bytes NRL-74 read) plus a transcribed oracle. Rule 11 applies to every
  number.

### CLOSED by NRL-111: the `SETEXT` stop was a stop the renderer does not have

NRL-95's own automated Verify found this and failed the ticket for it; the PR was
merged anyway, so it was live in `main` from `0953b7d` until NRL-111. Decision 4's
amendment carries the mechanism, the three-way split of the term and the exhaustive
direction property. What follows is the measurement.

**The oracle is not a transcription.** Every renderer claim in this section comes
from executing Obsidian 1.13.7's own parser (`WT`) and HTML renderer (`GT`) out of
the installed bundle in bare Node, through the durable harness at
`~/.local/share/note-reader-local/obsidian-parser-harness/` (`app.js` sha256
`8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898`, 3,876,459
bytes, re-verified this session; its own six-case self-test re-run, 6 ok). That
matters here more than anywhere, because **NRL-111 exists precisely because NRL-95
reasoned from a transcription that passed its self-test.**

**One correction to the harness's own oracle, which it is worth not rediscovering.**
`leak.cjs` locates HTML comments in the rendered output with `indexOf("<!--")`.
Obsidian's heading handler emits `data-heading="<the raw heading text>"`, so a
heading whose text contains `<!--` puts a literal `<!--` inside an **attribute**,
and that scan takes it as a comment opener and swallows every following element to
the next `-->`. Measured on `Prose <!--` / `===` / `more` / `===` / `HIDDENE` /
`--> t.`, whose real HTML is
`<h1 data-heading="Prose <!--">Prose &#x3C;!--</h1><h1 ...>more</h1><p>HIDDENE<br>--> t.</p>`:
the naive scan reports `HIDDENE` HIDDEN where a reader plainly sees it. NRL-111's
`oracle111.cjs` skips a tag to its `>` **honouring quoted attribute values**, which
fixes it. Pinned as `guard-nrl111-double-setext-attribute-shape`.

**Two-class probe, 1,350 shapes x 512 content-key combinations = 691,200 cells per
arm.** Four structural axes: 5 prefixes (the dash-pair hazard), 3 opener positions,
45 middle constructs enumerated by construct AND by position, 2 tails.

```
                       Class A (renderer HIDES)   Class B (renderer DISPLAYS)
                       301,056 cells              390,144 cells
base 874410d           50,176 spoken              56,320 lost
NRL-111                 5,120 spoken              51,200 lost
NEWLY LEAKING 0        NEWLY LOST 0               50,176 cells differ
```

Room to fail was 50,176 cells on the disclosure side and 56,320 on the prose-loss
side, so neither direction is vacuous. **45,056 disclosure cells closed and 5,120
prose-loss cells closed.**

**"0 NEWLY LEAKING, 0 NEWLY LOST" IS A STATEMENT ABOUT THIS CORPUS AND IS FALSE
OUTSIDE IT.** The corpus's four axes are 5 prefixes, 3 opener positions, 45 middle
constructs and 2 tails, and its indent axis is thin: it enumerates middle
CONSTRUCTS, not the INDENTS a construct can carry. An independent Verify built an
indent-split corpus and found the first pass **newly leaking 7,168 cells over 14
shapes (room 9,216)** through `TERM2_LIST`'s missing cap - a class this probe
cannot see and therefore never contradicted. Quote the figure with the corpus
attached, always, and never as "the fix leaks nothing". The second pass's own
probes are reported in their own section below with their own corpora stated.

**Every residual cell is accounted for and every one is identical on base.**
Class A's remaining 5,120 are one shape, `\t- x`, the `TERM2_LIST` indent-cap
disclosure recorded in the list-half bullet above. Class B's remaining 51,200 are:
5,120 `skipCodeBlocks` (a content-key exclusion the oracle cannot see), 5,120 the
bare-`1)` fail-closed gap, 5,120 the already-pinned NRL-88 root-1 quote class,
5,120 a `$$` math-block line that is in `u.interruptParagraph` and not in our stop
set, and 30,720 a **line-start** `<!--` whose next line is a setext underline or a
dash run, which makes it an `<h1>`/`<h2>` rather than an HTML block - i.e. **term 1
needs block position too**, in the prose-loss direction. None of the five is opened
by NRL-111 and none has a ticket yet. **(Amended by NRL-120: the `$$` component and the
line-start-over-underline component are closed, 51,200 -> 15,360 on this same
corpus; see the NRL-120 section at the end of this ADR. The other three stand.)**

**"EVERY RESIDUAL ACCOUNTED FOR" MISSED TWO, both class A and both 512 cells on
both arms, so both inherited rather than opened here**, found by the independent
Verify and recorded rather than glossed. A **tab-only line is taken as blank** by
the forward pass's `line.trim() === ""`, which resets the content-line count where
the renderer does not end a block there. And a **lazy list continuation resets the
count** as well, because the line it continues matches `TERM2_LIST` while the
renderer is still inside the same paragraph. Neither moves between base and either
pass of NRL-111; both belong with the five above and with F1 below rather than with
anything this ticket changed.

**Four alternate implementations were built and each is measurably worse, so no
design decision here rests on argument.**

| arm | Class A spoken | Class B lost | the fixture that catches it |
|---|---|---|---|
| NRL-111 as shipped | 5,120 | 51,200 | - |
| shipped minus `SETEXT.test(line)` (the "one-character fix") | 5,120 | **93,184** (+36,864) | `pin-nrl95-setext-between` and 5 more |
| content-line count reset at a dash run | **8,192** (+3,072) | 51,200 | `pin-nrl111-dash-pair-is-not-a-block-end` |
| `TERM2_SETEXT_EQ` kept at CommonMark's `^ {0,3}=+\s*$` | **13,312** (+8,192) | 51,200 | `pin-nrl111-eq-indented-not-an-underline`, `-eq-trailing-space-not-an-underline` |
| content-line count never reset | 5,120 | **54,272** (+3,072) | `guard-nrl111-count-resets-at-a-block-end` |
| `TERM2_LIST` widened to `\d+[.)]` | - | - | the four digit-string guards |
| `HR` removed from the stop set | 5,120 | **66,560** (+15,360) | `pin-nrl95-hr-between` |
| **`TERM2_LIST` left uncapped at `^[ \t]*`** (what the first pass shipped) | - | - | `pin-nrl111-bullet-four-space-indent-is-not-a-marker`, `-bullet-tab-indent-is-not-a-marker`; **+7,168 newly leaking on the indent corpus**, see the second-pass section |
| **`TERM2_SETEXT_DASH` omitted** (what the first pass shipped) | - | - | `pin-nrl111-dash-run-on-a-second-line-is-an-h2`; +512 newly lost |
| `TERM2_DASH_RUN` made a block end UNCONDITIONALLY | - | - | `pin-nrl111-dash-pair-is-not-a-block-end`, `guard-nrl111-dash-run-off-a-second-line-is-not-an-h2` |

In all 26 differing shapes across the first three alternates the shipped arm agrees
with the rendered HTML and the alternate does not.

**The three "measured as NOT affected" shapes, held on both arms.** 17 controls x
512 = 8,704 cells per arm: `***` / `___` / `---` / `----` / `- - -` (thematicBreak,
unconditionally in the list), `--` at four positions (the inline regex cannot cross
it), a lone `-` at three positions (a bare list marker), and `=`-runs on the second
line at four shapes. **0 of 17 moved between base and the fix, and both arms agree
with the renderer in all 17.** The probe discriminates: on the
delete-the-term arm 11 of 17 move and all 11 then disagree with the renderer.

**`sourceIndex` lockstep**, by numeric UTF-16 code-unit index over the whole
691,200-cell corpus: 979,968 chunks / 14,983,680 units on the fix and 993,792 /
15,178,240 on base, **0 length, 0 monotonicity, 0 bounds and 0 identity failures on
both arms**. Non-vacuous, with every row nonzero on both arms: drop-one gives
882,688 / 901,632 length failures; shift-by-one 570,880 bounds plus 409,088 /
422,912 identity; swap-two 813,568 / 832,512 monotonic and the same identity;
zero-all 956,928 / 970,752 identity. The main corpus produces **no** `equation`
chunk, so a second 72-note math corpus (inline `$$y$$`, inline `$x$`, display
block) was run to exercise that exemption: 79,872 / 70,656 chunks of which 30,720 /
29,696 hold the synthetic word, 0 failures with the exemption and **30,720 / 29,696
identity failures without it**, so it is shown mandatory AND pre-existing. The
space exemption likewise: 39,936 / 36,864 failures without it on the math corpus and
673,792 / 699,392 on the main one.

**The equation exemption must key on the synthetic SPAN, not on the chunk's whole
text, and this extends the AGENTS.md note rather than repeating it.** AGENTS.md
already records that keying on `blockType === "equation"` exempts nothing, because
`extract.ts` pushes the display-block chunk with `blockType: "other"`. Keying on
`text === "equation"` is the next wrong answer: the **inline** `$$y$$` form embeds
the synthetic word MID-CHUNK (`"Prose equation after."`), so a whole-text key
exempts only the display form and reports **8 identity failures per inline
occurrence, on BOTH arms**. The right key is per index: every index of the
synthetic word points at the `$` that opened it. Measured at the second pass over a
36-note math corpus x all 512 content-key combinations, 365,568 units on the
shipped arm and 532,992 on base: 0 failures with the exemption, **106,496 on the
shipped arm and 147,456 on base without it**, so it is mandatory on both arms and
pre-existing.

**Function bodies**: 18 of 19 brace-matched bodies are **byte-identical** across the
diff by sha256 - `flowDepthDelta`, `labelClose`, `inlineContainerClose`,
`wikiTargetClose`, `opensObsidianBlock`, `opensHtmlBlock`, `opensHiddenComment`,
`interruptsParagraph`, `codeSpanClosesLater`, `bracketClosesLater`, `opensMathBlock`,
`containerPrefix`, `peelQuotes`, `containerCarryStops`, `cleanLine`,
`detectFrontmatter`, `splitSentences`, `mergeShort`.

**"ONLY `extractChunks` MOVED" UNDERCOUNTS, and `endsTerm2Scan` necessarily moved -
it gained a parameter.** The accurate statement, re-measured at the second pass with
a brace-matched extractor that was sanity-mutated first (one deliberate body edit,
exactly one `MOVED` reported): base 874410d has 32 top-level function bodies and the
shipped tree has 33; **30 of the 32 are byte-identical**, `endsTerm2Block` is
ADDED, and `endsTerm2Scan` and `extractChunks` are the two that moved. Of the
critical predicates, **16 of 16 top-level ones are byte-identical**
(`interruptsParagraph`, `codeSpanClosesLater`, `bracketClosesLater`,
`opensMathBlock`, `opensHiddenComment`, `opensObsidianBlock`, `opensHtmlBlock`,
`inlineContainerClose`, `wikiTargetClose`, `labelClose`, `cleanLine`,
`finalSegment`, `isFileTarget`, `commentSpans`, `containerCarryStops`,
`flowDepthDelta`), and `emitWikiLabel` is an arrow function inside `cleanLine` and
so is covered by `cleanLine` being byte-identical rather than hashed on its own.
The extractor was **sanity-mutated
first** and reported `MOVED`, and it is built around the two traps that have each
bitten several agents: `flowDepthDelta`'s body holds a regex literal plus `"["`,
`"{"`, `"]"`, `"}"` string literals, and `labelClose`'s return type
`: { close: number; depth: number }` is not its body - the first draft of the
extractor hashed that type instead, reported every body `SAME` **including the
deliberately mutated one**, and was fixed before any number above was taken.

**4,000-note fuzz** over a 49-line vocabulary x 4 option sets, 16,000 cells:
**0 newly leaking**, Class A leaking 62 -> 42, Class B lost 2,006 -> 2,018,
**12 newly lost in ONE distinct note shape**, run down rather than dismissed: the
note's only interrupter is a **bare `1)`** line, which `TERM2_LIST`'s `[ \t]`
requirement misses, and base's wrong `===  ` stop happened to MASK it. Prose loss,
not disclosure, the same gap the list-half bullet above records at 5,120 cells where
nothing masks it, and pinned as `pin-nrl111-bare-ordered-marker-unmasked` so it
cannot change silently. The same fuzz finds 20 newly lost on the delete-the-term
arm, so it is demonstrably able to fail.

### NRL-111's SECOND PASS: what an independent Verify found, and what it cost

The first pass was **FAILED by an independent Verify** and the reason is worth
stating in one sentence, because it is the generalisable part: **the `1)` widening
shipped a new live disclosure, in a ticket whose whole purpose was removing one.**
Everything below is the second pass, measured the same way - Obsidian 1.13.7's own
parser and HTML renderer executed in Node through the durable harness, whose
`selftest.cjs` (6 ok) and `oracle-selftest.cjs` (9 ok) were re-run first.

**One scope limit of the oracle, recorded by that Verify and respected here.** An
image's or an embed's alt text lives only in an HTML **attribute**, so
`visibleText()` counts it as hidden. Every corpus in this section is free of image
and embed constructs for that reason; do not add one without handling it explicitly.

**THE BLOCKING FINDING.** The only widening in the first pass was
`/^[ \t]*1\)[ \t]/`, and `TERM2_LIST` had no indent cap, so that widening set
split by indent and the split was total:

| widening lines | distinct lines | renderer | the first pass |
|---|---|---|---|
| indent 0 to 3 columns | 246 | **shows** in 246/246 | correct prose-loss fix |
| indent >= 4 columns or any tab | 28 | **HIDES** in 28/28 | **newly leaked, 28 of 28** |

**7,168 newly leaking cells over 14 shapes (room 9,216)**, and **3,584 of 3,584
room** in a bullet-controlled corpus. **Introduced rather than unmasked**: in all 14
shapes base spoke 0/512 and the first pass spoke 512/512, while the `1.`/`-`/`*`/`+`
twins at the same indents read 512 on **both** arms - that is NRL-119's inherited
half, and it is the control that separates the two. A tab is Obsidian's own default
indent for a nested list item, so the leaking shape is this:

```
Some notes <!-- draft, do not publish
	1) internal budget 4.2M
	2) layoff list attached
-->
```

**THE REMEDY IS THE CAP, and it is strictly dominant over base in both
directions.** Of the two remedies Verify measured, dropping `1)` merely returns to
base and costs 1,024 class-B cells, while the indent cap gives Class A 0 **and**
Class B 0. The cap is what landed, together with `1)`, so **both halves of
`TERM2_LIST`'s indent axis moved in one commit** - which is what this ADR's own
prose had argued for and the first diff failed to do. It closes **NRL-119's first
half** (a live 5,120-cell disclosure) as well as the first pass's own widening.
**NRL-119's second half, a bare marker alone on a line, stayed open** and was
tripwired, not fixed, by NRL-111. It is now closed; see "CLOSED by NRL-119" at the
end of this ADR.

**Re-measured, with the corpus and the room to fail stated for every figure.**
Arm 0 is base `874410d`; "head" is the first pass; "new" is what ships.

`TERM2_LIST` indent corpus, 11 indents x 5 markers, three families:

| family | shapes | cells | class A / B | base A spoken | head A spoken | new A spoken | newly leaking (head / new) | room |
|---|---|---|---|---|---|---|---|---|
| A: marker line right after the opener | 55 | 28,160 | 17,920 / 10,240 | 14,336 | **17,920** | **0** | **3,584 / 0** | 3,584 |
| B: marker line two lines down | 55 | 28,160 | 17,920 / 10,240 | 14,336 | **17,920** | **0** | **3,584 / 0** | 3,584 |
| C: bullet-only control, no `1)` at all | 33 | 16,896 | 10,752 / 6,144 | 10,752 | 10,752 | **0** | 0 / 0 | **0** |

Family C is the control that separates the two halves: with no ordered marker in it
the `1)` widening has **no room at all** there (room 0), so its 10,752 class-A cells
are purely NRL-119's inherited disclosure and the cap is the only thing that moves
them. On class B, new loses **0** of 8,192 room in A and in B, and closes base's
2,048. The probe demonstrably fails against a wrong arm: head and an
otherwise-identical uncapped arm both report 3,584 newly leaking.

Verify's own structural two-class corpus, 277 shapes x 512 = **141,824 cells** per
arm, 43,520 class A and 98,304 class B, oracle crashes 0:

```
                 class A spoken   class B lost   newly leaking   newly lost
base 874410d     26,880           43,776         -               -
first pass       1,536            45,824         0 (room 16,640) 2,048 (room 54,528)
SHIPPED          1,536            45,312         0 (room 16,640) 1,536 (room 54,528)
closed by SHIPPED: 25,344 class A
```

The shipped arm's 1,536 newly-lost cells are **exactly three shapes, one each from
F1, F2 and F3 below**, enumerated per shape rather than aggregated. The first
pass's fourth, `reset-dashrun-then-opener-eq2nd`, is the F4 fix.

**FOUR findings. F4 was clean enough to fix; F1, F2 and F3 are pinned as
tripwires** with their measured counts, directions and roots, and tickets are being
filed. All four are PROSE LOSS - the renderer displays the sentinel and we drop it -
and all four are measured against base as well, which matters: **F1, F2 and F3 are
RED on base**, because base spoke the sentinel accidentally right by not gating the
`=` run at all. The trade is 25,344 class-A cells closed against 1,536 class-B cells
lost. It is not a wash and it is not free.

- **F4, FIXED. 512 cells, room 1,536.** A `--` that IS its block's second line is
  a setext `<h2>`, so a real block end, and the first pass denied that
  unconditionally - repeating for the dash run the exact position-independent error
  it fixed for the `=` run. The remedy is `TERM2_SETEXT_DASH` in `endsTerm2Block`
  under the identical `paraLinesAbove === 1` gate; `TERM2_DASH_RUN` keeps its
  ungated scan stop. On the dedicated 8-shape F4 corpus (4,096 cells, 2,560 class A
  / 1,536 class B): the shipped arm is **0 newly lost of 1,536 room and 0 newly
  leaking**, the three class-B dash shapes stay spoken at 512 each, and the five
  class-A shapes (` --`, `--\t`, two-above, zero-above, after-blank) correctly go
  512 -> 0, closing 2,560 inherited class-A cells. The first pass loses 512 of that
  room, so the probe fails against the wrong arm.
- **F1, 6,144 cells over 12 of 17 shapes, prose loss, room 7,680.** The forward
  pass uses the term-2 **stop** set as a **block-end** set, and that set omits real
  renderer block ends: blockquote, nested quote, table, `$$`, indented code,
  footnote definition, link reference definition, a bare `* + 1. 1)` marker, a
  comment block. So `paraLinesAbove` over-counts and a correct second-line stop is
  suppressed. **No F1 cell in the measured corpus leaks: 0 of 7,680 room.** An
  earlier revision of this bullet generalised that into "a narrow stop set used as
  a counter can only OVER-count, so none can leak", and **NRL-111's second Verify
  falsified it.** The counter can also UNDER-count, two ways, and under-counting to
  exactly 1 turns the gate on where the renderer has no underline: `TERM2_LIST`
  matches a container-OPENING marker line, which is a block start and not a block
  end, and `line.trim() === ""` takes a tab-only line as blank. Measured at 55,296
  and 12,288 class-A cells, both saturated, **0 newly leaking and cell-for-cell
  identical on base, on the first pass and on an uncapped arm** - so the shipped
  behaviour is untouched and it was the CLAIM that was wrong. Both mechanisms are
  listed as class-A residuals earlier in this same section, which is to say the
  document contradicted itself. F1 is therefore prose loss **plus a disclosure
  mechanism**, not prose-loss-only. Verify
  measured 6,656 over 13 shapes against the first pass; F4's fix closed one of them
  (`setextH2viaDash`), which is why the figure is 6,144 over 12 here. Pinned as
  `tripwire-nrl111-f1-blockquote-above-is-not-a-counted-block-end`.
- **F2, 3,584 cells over 7 of 9 shapes, prose loss, room 4,608.** A mid-line `--`
  between opener and closer makes module 4839's regex fail, so the renderer shows
  everything; we detect dash-ONLY lines. Already declared out of scope by the first
  pass's PR. It is also where the signed direction re-run's 16 exceptional
  narrowings land. Pinned as
  `tripwire-nrl111-f2-midline-dashes-between-opener-and-closer`.
- **F3, 3,072 cells over 6 of 21 shapes, prose loss, room 3,072 (saturated).** A
  container-indented `=` run (`- Prose <!--` / `  ===`): `TERM2_SETEXT_EQ` is
  anchored at column 0 and the renderer peels the container prefix first. The
  quote-prefixed members of the same corpus are lost on base too and are not part of
  the 3,072. Pinned as `tripwire-nrl111-f3-container-indented-eq-run`.

**Fixture ablation, 32 fixtures x 17 arms.** The shipped arm is 0 RED. Base is
**15 RED**. Each term is still decisive under ablation and each new fixture has real
room to fail:

| arm | RED | the fixture that catches it |
|---|---|---|
| shipped | **0** | - |
| base 874410d | **15** | the 9 first-pass reproductions, the 2 retargeted bullet pins, and the 3 F-tripwires plus `guard-nrl111-dash-run-off-a-second-line-is-not-an-h2` |
| first pass (head) | 3 | the 2 retargeted bullet pins + `pin-nrl111-dash-run-on-a-second-line-is-an-h2` |
| uncapped `TERM2_LIST` | 2 | the 2 retargeted bullet pins |
| `TERM2_SETEXT_DASH` omitted | 1 | `pin-nrl111-dash-run-on-a-second-line-is-an-h2` |
| `1)` removed | 1 | `pin-nrl111-ordered-paren-interrupts` |
| `TERM2_SETEXT_EQ` term DELETED | 4 | `pin-nrl95-setext-between` (NRL-95's C5) and 3 more |
| `TERM2_SETEXT_EQ` ungated | 8 | the four `pin-nrl111-eq-*` third/fourth-line pins and more |
| `TERM2_LONE_DASH` removed | 1 | `guard-nrl111-lone-dash-third-line` |
| `TERM2_DASH_RUN` scan stop removed | 1 | `guard-nrl111-dash-pair-third-line` |
| dash run a block end unconditionally | 2 | `pin-nrl111-dash-pair-is-not-a-block-end`, `guard-nrl111-dash-run-off-a-second-line-is-not-an-h2` |
| count never resets | 2 | `guard-nrl111-count-resets-at-a-block-end` |
| count resets on the SCAN set | 2 | `pin-nrl111-dash-pair-is-not-a-block-end` |
| `TERM2_SETEXT_EQ` at CommonMark's shape | 2 | `pin-nrl111-eq-indented-not-an-underline`, `-eq-trailing-space-not-an-underline` |
| gate at `=== 2` | 10 | 10 of the eq pins |
| `HR` removed | 1 | `pin-nrl95-hr-between` |
| `TERM2_LIST` widened to a BARE marker | 1 | `pin-nrl111-bare-ordered-marker-unmasked` |

**The delete-the-term arm is still RED on `pin-nrl95-setext-between`**, so the
simultaneity NRL-111 rests on - the C5 pin and the NRL-111 pins holding at once -
is still real and not an artefact of the second pass.

**`sourceIndex` re-measured on this pass's own corpora**, by numeric UTF-16
code-unit index: main corpus 475 notes x all 512 content-key combinations =
243,200 extractions per arm, **460,032 chunks / 3,357,440 units** on the shipped arm
and 549,888 / 4,803,328 on base, **0 length, 0 monotonicity, 0 bounds, 0 identity
failures on both arms**. All four mutators nonzero on both arms: drop-one 449,536 /
539,392 length; shift-by-one 2,758,400 / 3,778,560 identity; swap-two 399,872 /
493,312 monotonic plus 716,032 / 888,448 identity; zero-all 2,775,040 / 4,021,248
identity. Both exemptions mandatory on both arms: without the space exemption
73,984 / 159,232, and on a separate 36-note math corpus (18,432 extractions per
arm, 365,568 / 532,992 units) without the equation exemption **106,496 / 147,456**.

**Function bodies** were re-measured with the extractor **sanity-mutated first** -
one deliberate one-body edit, exactly one `MOVED` reported - and the three trap
functions (`labelClose`, `flowDepthDelta`, `isWordChar`) confirmed extracted. The
`labelClose` return-type trap has now caught four agents in this run and Verify's
own first extractor hit the regex-literal trap, so do not re-roll this by hand.

**STILL NOT OBSERVED IN OBSIDIAN**, exactly as the first pass. No deploy and no CDP
session happened in the second pass either. The oracle is the shipped
**reading-view** parser and renderer executed in Node, and **Live Preview has never
been read**. Rule 11 applies to every number in this section.

**NOTHING IN NRL-111 WAS OBSERVED IN OBSIDIAN.** No deploy happened and CDP 9222 was
not attempted. Executing the shipped parser and renderer in Node is much stronger
than reading them and is still **not the running app**: it is the **reading-view**
pipeline only, and **Live Preview is separate code that no ticket in this family has
ever read or run**. The hast transformers are stubbed empty in the render harness
(they only decorate `<a>` elements). Rule 11 applies to every number in this
section.

### CLOSED by NRL-120: term 1 needs block position, and `$$` ends the term-2 paragraph

Both were found by NRL-111 as part of its accounted-for Class B residual and both
were pre-existing. **Reproduced on base `f250ddd` before any change**, through the
durable harness (app.js sha256 `8efbf581...9898` re-verified against the installed
flatpak asar, `selftest.cjs` 6 ok, `oracle-selftest.cjs` 9 ok, the extractor COPIED
into each arm and sanity-mutated once): NRL-111's own 1,350-shape corpus lost
**51,200** Class B cells on base, of which **30,720** are exactly the line-start
`<!--` over an underline (60 shapes x 512) and **5,120** exactly the `$$` shape
(10 shapes x 512).

**Part 1, term 1.** `blockMethods` runs `setextHeading` (index 10) before `html`
(index 11), so a line-start `<!--` whose next line is an exact underline is the
heading's one content line and never reaches module 8776. Measured:
`<!--` / `===` / `HIDDENA` renders
`<h1 data-heading="<!--">&#x3C;!--</h1><p>HIDDENA</p>`, `-`, `--` and `---` give
`<h2>`, and ` ===`, `===  `, four spaces, `- - -` and ` -- ` are not underlines and
leave the HTML block open. `opensHtmlBlock` gained a required fourth argument,
`setextContent`, and became `!setextContent && (term1 || term2)` (decision Q7: the
refusal gates both terms, because the heading is its own block). The answer comes
from a forward pass, `isSetextContentLine`, and is cleanLine's only. Decisions,
each measured rather than argued:

1. **Three container shapes, everything else fails closed.** Plain; quote levels
   only with the underline at the same depth; a column-0 list marker with one
   space, the underline indented by exactly the marker width, and no later line of
   the item indented by less (module 5540 strips the SMALLEST non-zero indent
   across the item, so `- <!--` / `  -` / `HIDDEN` / `<div>` / ` ===` keeps the
   `<!--` raw and HIDDEN hidden; the fuzz found it).
2. **Lead at most three SPACES.** A tab or four columns is a lazy continuation or
   indented code, never a setext content line. The `^\s*<!--` arm newly leaked
   **8,640** census cells.
   **Corrected by NRL-155, amended in place rather than deleted: "a tab is never a
   setext content line" is FALSE for a lead of one to three spaces and then a
   tab.** Module 134 (indented code) is literal - four spaces or one tab at offset
   0, with no tab-stop expansion - so ` \t<!--` is not indented code to the
   renderer and reaches setextHeading: ` \t<!--` / `===` / `HIDDENA` / `more` renders
   `<h1 data-heading="<!--">\t&#x3C;!--</h1><p>HIDDENA<br>more</p>` (executed
   parser, app.js sha256 `8efbf581...9898`). The cap was right only for a lone tab
   and for four or more spaces. On main the error was masked at document start and
   after a blank line, because our own `INDENTED_CODE` (`/^(?: {4}| {0,3}\t)/`) also
   wrongly takes ` \t` (NRL-113's defect); it was live directly after an ATX
   heading, a thematic break or a fence closer, where `INDENTED_CODE` needs
   `wasBlank`, so `# Head` / ` \t<!--` / `===` / `HIDDENA` / `more` hid to end of note
   (12 core cells, red on main `faf55a3`). Once NRL-113 narrows `INDENTED_CODE`, the
   same error loses **20,480 of 99,840** sweep cells (13 leads x 5 underlines x 3
   positions x 512 masks); with the correction those 20,480 are 0.
   The plain arm now reads `PLAIN_SETEXT_HTML_OPENER` (`/^[ \t]*<!--/`) and refuses
   only when `MODULE134_INDENTED_CODE` (`/^(?: {4}|\t)/`, the renderer's literal rule,
   deliberately not our `INDENTED_CODE`) does not match. A **tab-bearing** lead
   (`/^ *\t/`) additionally needs BLOCK position, because module 8607 counts the
   first tab of a lead as four columns and continues the paragraph without walking
   `interruptParagraph`: `Intro.` / ` \t<!--` / `===` / `HIDDENA` / `-->` is one `<p>`
   whose inline comment hides HIDDENA. Block position is an option-independent
   allowlist on the raw previous line (first line, a SPACES-only blank line, or a
   spaces-capped ATX heading, thematic break or fence line), not extractChunks'
   `wasPara`, whose skip paths reset paragraph state (the `wasPara` arm newly
   spoke HIDDEN in 3,584 predecessor-census cells, `| a |` under skipTables among
   them), and not the shared `HEADING` / `HR` / `FENCE`, which accept a tab-led `# H`
   or `***` that is a lazy continuation (1,792 cells). A whitespace line holding a
   tab is not blank to module 8607, so it is not on the list either (1,792 cells on
   the NRL-113 arm). Spaces-only leads keep the original rule exactly. The QUOTE
   and LIST arms stay spaces-only, fail-closed: `> \t<!--` is code inside the quote
   only through module 6234's one-character peel (NRL-114), and `- \t<!--` is code
   in the item. (**Amended by NRL-114:** the QUOTE arm now takes this rule on the
   quote body, and both shapes are now spoken because term 2 is masked on a
   container line module 134 makes code; the LIST arm's lead is unchanged.)
   `TERM2_MATH` was checked for the same lead error and needs no
   change: ` \t$$` renders a paragraph. Evidence is bare-Node against the executed
   reading-view parser; **NOT VERIFIED IN OBSIDIAN**.
3. **Not inside a raw HTML block.** `rawHtml` state in the pass: a `<div>`,
   `<span>`, `<script>`, `<?` or `<!X` block emits the later `<!--` raw. Without it
   **73,536** cells newly leaked (`nohtmlstate` arm); without it and the list veto
   together **82,752** (`nogate`). The same state also stays open after a ` \t<!--`
   with no closer, because that line is an HTML comment block to the renderer and
   indented code to us (NRL-93 / NRL-115's divergence, not fixed here), so the
   refusal must not reach inside it; the fuzz found that one.
4. **Not a lazy list continuation.** Inside a list a lone `-` is the next item,
   not an underline: `- item` / `<!--` / `-` / `HIDDEN` is one list with the `<!--`
   raw in the first item. Vetoed by `listDedented` plus `listInRun`, a list marker
   (bare ones included, since `LIST_BULLET` misses `-` alone) anywhere in the run
   of non-blank lines above. Gives up the lazy `===` and `--` headings, fail-closed.
5. **The refused line still starts a block.** `html` fires on it in the
   `interruptParagraph` walk before `setextHeading` claims the block, so the
   paragraph above is flushed first. Without the flush, `SEEN` / `<!--` / `===`
   made the whole buffer a heading and skipHeadings dropped SEEN; fuzz-found.
6. **Not threaded into `opensHiddenComment`**, a deliberate deviation from the
   plan. The lookaheads ask "does this line END the paragraph", and a refused
   `<!--` line still does (`Intro. \`a` / `<!--` / `===` / `b\` c` renders no code
   span). The threaded arm newly DISCLOSES: it turns
   `guard-html-opener-in-carry` and `guard-nrl64-html-opener-before-closer` red on
   their "hidden text not disclosed" checks. `interruptsParagraph`,
   `codeSpanClosesLater`, `bracketClosesLater`, `opensObsidianBlock`,
   `opensMathBlock`, `labelClose`, `containerPrefix`, `peelQuotes` and
   `endsTerm2Scan` are byte-identical across the diff by sha256 of each
   brace-matched body (extractor sanity-mutated first: one edit, one MOVED).
7. **`appendRemainder` passes `false`.** The rest of a comment's closing line is
   still inside that HTML block for the renderer.

**Part 2, `TERM2_MATH`.** `math` is in `u.interruptParagraph` unconditionally, so a
`$$` line ends the paragraph a mid-line `<!--` belongs to. It is a block end, so it
sits in `endsTerm2Block` and resets the content-line count. The shape is the
executed parser's: `/^ {0,3}\$\$+[^$]*$/` disagrees with the renderer in **0** of
48,018 exhaustive cases (every non-blank line up to length 6 over
{space, tab, `$`, `y`}, and up to 5 with backslash, backtick and a trailing CR
added, between `Prose <!--` and three tails). No closer is needed. `opensMathBlock`
is untouched and is the wrong predicate here: it asks whether extractChunks will
consume a block, not whether the paragraph ends. The term-2 pass still reads raw
lines, so `> $$` is not a stop: fail-closed, pinned as
`pin-nrl120-quoted-math-still-hidden`. **CLOSED by NRL-114**, which reads a quoted
line on its peeled body; the pin was replaced in place and now expects HIDDENM
spoken (see "AMENDED by NRL-114" at the end).

**Both directions, signed per cell at each cell's own position, on ONE arm that
carries both parts.** Room to fail is the Class A cells silent on base.

| corpus | cells | Class A spoken base -> fix | Class B lost base -> fix | newly leaking | newly lost | room |
|---|---|---|---|---|---|---|
| NRL-111's, 1,350 shapes x 512 | 691,200 | 0 -> 0 | 51,200 -> **15,360** | 0 | 0 | 301,056 |
| part 1 census, 870,780 shapes x 16 masks, 2 sentinels | 18,778,560 | 385,352 -> 385,352 | 8,030,816 -> 7,569,504 | **0** | **0** | 9,168,936 |
| part 1 reduced, 22,085 shapes x all 512 masks | 13,569,024 | 133,632 -> 133,632 | 6,993,920 -> 5,755,648 | **0** | **0** | 5,640,192 |
| supplement (bare markers, shallower item lines, a ` \t<!--` block above), 7,840 x 512 | 6,021,120 | 32,768 -> 32,768 | 2,166,784 -> 1,890,304 | **0** | **0** | 3,788,800 |
| part 2 math census, 92,340 shapes x 16 masks | 2,068,416 | 0 -> 0 | 649,728 -> 448,608 | **0** | **0** | 1,032,000 |
| lookahead probe for `codeSpanClosesLater` / `bracketClosesLater`, 2,970 sources (9 container forms incl. lazy quote and lazy bullet, 5 leads, code / image / link, setext and math middles) x 512, 5 tokens | 7,603,200 | 124,928 -> 124,928 | 3,180,032 -> 2,389,504 | **0** | **0** | 1,038,336 |

The part 1 census axes: 22 container forms (plain, quote, lazy quote underline,
lazy quote, quote only on the underline, `>  `, nested, nested-shallower,
list, lazy list underline, deep list underline, list continuation, ordered,
ordered short, list-in-quote, quote-in-list, task, two-space marker, star, nested
list, lazy nested list, one-space indent), 30 positions (document start, after one
and two blanks, continuation, ATX, setext `===` and `---`, HR, closed fence, list
and quote and ordered items above, indented code, a dash pair, a closed math
block, tab-only and space-tab lines, a loose list, nested lists, a quote blank,
`<div>`, `<div>` then blank, `<span>`, an unclosed and a closed `<script>`, `<?x`,
a quoted `<div>`, frontmatter, a table, and the form's own container), 7 leads x 3
opener texts plus two mid-line openers, 20 underline and near-miss lines, 3 tails.
The 16 masks vary skipHeadings, skipCodeBlocks and skipTables over two settings of
the other six keys; the 512-mask run above covers every combination on a reduced
shape set.

**Every probe was shown able to fail with a deliberately wrong arm**, on the same
corpus: part 1 census `broadul` (CommonMark underline shape) **660,360** newly
leaking, `nogate` 82,752, `nohtmlstate` 73,536, `trimlead` 8,640; math census
 `includes("$$")` **208,320** and `trimStart()` **140,880** newly leaking (the
arm with no math stop at all differs from base in 0 cells); the supplement,
dropping `listInRun` **69,120**, dropping the list dedent scan **345,600**,
dropping the ` \t<!--` state **368,640**. The census cannot see the flush (no
sentinel sits above the opener), so that arm is caught by its pin and the fuzz. Every guard fixture added here is red
on the wrong arm it stands in front of and green on base and on the fix.

**Fuzz**, 12 seeds x 4,000 notes x 4 option sets = 192,000 cells over a vocabulary
extended with every NRL-120 shape. NRL-111's LCG lost precision past 2^53 and
different seeds converged on the same notes, so it was replaced with mulberry32.
Class A spoken 4,492 on base and 4,508 on the fix, Class B lost 28,637 and 27,819.
**16 newly leaking cells in 5 distinct notes, every one the same-line reopen class
below**, and **6 newly lost cells in 2 notes**, both the prose-loss unmaskings
below. Against wrong arms on seeds 1 and 2: `nogate` 14 / 12, `trimlead` 16 / 8,
`notabstate` 8 / 4, `nolistrun` 4 / 4, `noscan` 4 / 0, `mathung` 10 / 0 newly
leaking, and dropping the flush 30 / 14 newly lost.

**UNMASKED, NOT OPENED, and the only newly-spoken class left.** A line that starts
an HTML comment block and closes it on the same line (`<!-- y --> <!--`) ends that
block at the end of the line, so a further unclosed `<!--` on it is raw HTML that
hides the rest of the note in the reading view. We read the second `<!--` as a
mid-line opener and, with no closer in its paragraph, speak what follows. That is
a **pre-existing Class A disclosure on base**: `<!-- y --> <!--` / `- x` /
`HIDDENA` speaks HIDDENA on base, and so does the guard row
`SEEN` / `---` / `<!-- y --> <!--` / `HIDDENA`. Before NRL-120 an earlier line-start
`<!--` over an underline opened our own comment and happened to hide the same
text; the refusal removes that mask. Pinned as
`pin-nrl120-unmasked-same-line-reopen`, a tripwire. Tracked as **NRL-136**.

**Corrected at Ship: "the only newly-spoken class left" was wrong, because the
census rows above never put a raw HTML block or a reopen line AFTER a refused
heading.** Ship ran its own census against real rendered HTML, 1,656 notes (12 heading
shapes in plain, quote, nested-quote and list containers x 23 follow-ups x 6
preambles) x 512 content-key combinations, 989,184 sentinel cells in all: **73,728
newly speaking, 0 newly lost**, in 144 notes and exactly three classes of 24,576 each, and **every one of the 73,728 reproduces on base** once
the heading's `<!--` is replaced by plain text, so each is an unmasking rather than a
new disclosure, the NRL-74 precedent. (1) The same-line reopen above. (2) A
processing-instruction raw HTML block, `<!--` / `===` / `<?x` / `HIDDENP`, whose
content the browser hides as a bogus comment. (3) A `<div>` raw HTML block holding a
mid-line `<!--`. (2) and (3) are one pre-existing class, raw HTML blocks spoken as
prose, tracked as **NRL-137**. **Part 2 unmasks class (1) by a second route**:
`<!-- y --> <!--` / `HIDDENA` / `$$` / `--> t.` was hidden on base only because the
term-2 scan ran past the `$$` to the `-->`, and base already speaks it with a blank
line in that position. Tripwires: `pin-nrl120-unmasked-reopen-by-math-stop`,
`pin-nrl120-unmasked-processing-instruction`, `pin-nrl120-unmasked-div-block-comment`,
each beside its base control. A Ship fuzz (8 seeds x 4,000 notes x 7 option sets)
agreed: every newly-speaking cell either reproduced on base in a defused form or was
shown causal on the reopen shape, and the cells left over were image alt text spoken
by design under `speakImageAlt`.
Two prose-loss classes are unmasked the same way and are shown to reproduce on base
in a defused form: a display-math block we consume as "equation" (ADR 0004's
design, which the oracle counts as loss), and our CommonMark-wide `SETEXT` taking
`===  ` under a paragraph that an unclosed `$$` had already ended for the renderer.

**Corrected at Verify, and the second of those two classes is now CLOSED at its root.**
Verify blocked the first revision (`8add7ba`): over its own 24.4M-cell census,
**2,436 cells newly lost displayed text**, every one through `TERM2_MATH` and every one
needing `skipHeadings`, so this section's "0 newly lost" was false for that route. The
mechanism: once the `$$` stop kept a `<!--` literal, the line after the paragraph was
reached by the heading site in `extractChunks`, whose wide `SETEXT`
(`/^ {0,3}(?:=+|-+)\s*$/`, any number of content lines) called it an underline, and
`skipHeadings` dropped the whole paragraph. Verify's two reproductions:
`Prose VISIBLEP <!--` / ` ===` / `$$` / `VISIBLEM --> t.` lost VISIBLEP, and
`<div>` / `VISIBLED` / `<div><!--` / `===` / `$$` / `HIDDENM --> t.` lost VISIBLED.
Obsidian 1.13.7's own `MarkdownRenderer`, called in the running app over CDP on
2026-10-01 (a stronger oracle than the asar parser executed in Node, and the first
time this family used it), renders a setext heading ONLY for an underline of the
exact shape `^(?:=+|-+)$` - no leading and no trailing whitespace - under exactly ONE
content line: `x` / ` ===`, `x` / `=== `, `x` / `\t===` and `a` / `x` / `===` are all a
`<p>` showing the `===`, and `x` / ` ---` is a `<p>` plus `<hr>`. The heading site now
tests `SETEXT_UNDERLINE_EXACT` and `paraStart >= lineStarts[lineNo - 1]`, the same
shape `isSetextContentLine` and `endsTerm2Block` already used, so the three no longer
disagree. `SETEXT` itself is unchanged because `interruptsParagraph` shares it, which
keeps every carry stopping where it did. A refused shape falls to `HR` or to the
paragraph, both of which speak, so the change can only stop dropping text. Evidence:
both reproductions are pinned (`pin-nrl120-setext-needs-exact-underline`,
`pin-nrl120-setext-needs-one-content-line`, RED on `8add7ba`); seven earlier
expectations moved, each checked against the same renderer, six to what it displays
and one, `guard-nrl111-lone-dash-third-line`, to a spoken `-` that the renderer shows
as an empty list bullet, which is NRL-119's bare-marker gap and is now a tripwire; and
an Obsidian-oracle fuzz (3 seeds x 4,000 notes x 2 skipHeadings positions, every one
of the 5,123 cells that differ from `8add7ba` rendered in the app) found **0 newly
lost and 2,113 cells of loss closed**. Its 9 newly-speaking cells are 3 notes: two are
image alt text spoken by design (the oracle reads `textContent`, not `alt`), and one is
a `<div>` raw HTML block that `main` already speaks with `skipHeadings` off, i.e. the
NRL-137 class, uncovered when `skipHeadings` stopped over-dropping. Verify's 24.4M-cell
census was not re-run on that harness, which did not survive the run; a second,
independent Verify built its own and is recorded below. Verify also counted
**736 cells of a space-tab `<!--` class** (the NRL-93 / NRL-115 family) among the
newly-spoken unmaskings, which this section did not list; it is listed here.

**`sourceIndex` lockstep**, by numeric UTF-16 index, both arms: 0 length, monotonicity, bounds or identity failures on
NRL-111's corpus (512 masks; 1,012,224 chunks / 15,476,224 units on the fix), the
reduced part 1 corpus (16 masks; 726,208 / 3,609,440), the math census corpus (16
masks; 3,466,976 / 26,603,392) and a dedicated 420-note equation corpus (512 masks;
471,040 / 5,518,848 on the fix, 363,520 / 4,135,424 on base) that really produces
equation chunks, display and inline `$$y$$` alike (212,992 on the fix, 159,744 on
base). All four mutators nonzero on every corpus and both arms (on the equation
corpus, fix: drop 458,752 length, shift 194,560 bounds + 184,320 identity, swap
285,184 monotonic + 233,984 identity, zero 378,880 identity; base: 355,328,
186,368 + 115,712, 201,728 + 153,600, 302,080). The equation exemption keys on the
synthetic TEXT and is mandatory on both arms: without it, 212,992 and 159,744
identity failures. The space exemption is pre-existing: without it base fails too.

**Residuals, all fail-closed (prose loss, never disclosure):** a `$$` behind a `>`
prefix; a lazy list continuation's `===` / `--` heading; a nested or quoted list
marker, a task item, or a marker with two or more spaces; a line under any raw
HTML block until its end condition; NRL-111's other three Class B components
(5,120 skipCodeBlocks, 5,120 bare `1)` = NRL-119, 5,120 the NRL-88 root-1 quote
class), unchanged. A quoted or listed setext heading still speaks its underline
(`<!-- === HIDDENA`), exactly as `> Title` / `> ===` always has.

**NRL-115 overlaps term 1 and must re-run this census when it rebases**, and this
ticket must re-run NRL-115's if NRL-115 lands first. The `after setext` rows with
leads ` `, `  `, `   `, ` \t` and `\t` are in this corpus for that purpose.

**Second Verify, on the merged revision `e448540` (recorded at Finish).** An
independent census against base `079cf0c`, oracle111 on rendered HTML:
PRE(34) x OPEN(34) x UL(40) x TAIL(17) = 786,080 notes x 16 masks =
**30,906,816 sentinel cells**, room 9,906,212 hidden cells and 14,730,136 loss
cells. **Newly lost: 240, every one heading text inside a rendered `<h1>` under
`skipHeadings`**, which is that exclusion working (base spoke it because it did
not recognise the heading). **Newly leaking: 249,508, every one reproducing on base
in a defused form at the same mask** (opener defused 93,616, underline blanked
149,868, `$$` blanked plus dedent 3,600, all `$$` blanked 1,632, tail underline
blanked 792); by class NRL-136 140,320, NRL-137 `<div>` 53,616, NRL-137
processing instruction 50,844, space-tab `<!--` 4,720, other 8. So they are
unmaskings in the sense used above, not new disclosures, and the counts supersede
Ship's 73,728 and Verify-1's 736 for scale, on a different corpus. Ablation
without `TERM2_MATH`: 148,140 newly leaking, all explained, 0 newly lost. Wrong
arms were caught on the same census: the previous revision `8add7ba` 3,036 newly
lost outside headings, a `\s*` lead with no `rawHtml` or lazy guards 57,152
unexplained leaks, `TERM2_MATH = /^\s*\$\$/` 8,064 unexplained. NRL-111's corpus
re-measured: Class B 51,200 -> 15,360, Class A 0 -> 0. `sourceIndex` 0 failures on
every chunk of every arm, the equation exemption mandatory (6,040 base / 6,280
merge failures without it), all four mutators nonzero on both arms.

**A further unmasking route this section did not describe, found by that Verify.**
The exact-underline heading site (`SETEXT_UNDERLINE_EXACT` plus the one-content-line
test) is itself a route: where base treated a two-or-more-line paragraph over `===`
as a setext heading and `skipHeadings` dropped renderer-hidden text with it, the
fix no longer calls it a heading and speaks that text. **792 cells**, all
reproducing on base with the underline blanked (the `tailUlBlank` row above), so
again an unmasking and not a new disclosure. Example:
`<?x QPAQ` / `QOAQ plain` / `QUAQ -->` / `===` / `QTJQ` (NRL-137's
processing-instruction class). **8 of the 792 belong to none of the four classes
recorded here**: a code span plus an inline comment,
``QPAQ `code`` / `` `<!--` `` / `QUAQ -->` / `===` / `QTJQ`, where at mask 418 the
fix speaks QUAQ and base speaks it too once the `===` is blanked. No ticket is filed
for that 8-cell shape; it is recorded here so it is not rediscovered as new.

**NOT VERIFIED IN OBSIDIAN BY A HUMAN, and the extractor change was never run inside
Obsidian.** What did touch the running app: the heading-site correction above used
Obsidian 1.13.7's own `MarkdownRenderer` over CDP as an oracle, and the second Verify
rendered all 45 of its named inputs through that live renderer into a detached
element and found them structurally identical to the Node harness in all 45. It then
deployed the test-merge, but Obsidian was not restarted, so the in-memory plugin was
the previous build and `npm run test:obsidian` (which failed at its
remote-runtime-guard assertion after synthesis and playback succeeded) exercised
`main`, not this `extract.ts`. Nobody listened to a read. Live Preview has never been
read. Rule 11 applies to every number here. R-M08 is still NOT met and the `2 of 16`
count does not move.

## AMENDED by NRL-115 (2026-10-01): term 1 is right only where module 8776 is reached

**The defect.** Term 1 asked whether only whitespace precedes `<!--` on the line,
with `.trim()`, and decision 1 recorded that as correct because module 8776's skip
loop accepts spaces and tabs with no cap. The premise is true and the conclusion
does not follow, because module 8776 is not reached for two kinds of indented line:

- **A paragraph continuation led by a tab or four or more columns.** Module 8607
  (paragraph), on the `commonmark: true` branch Obsidian always runs, counts each
  following line's indent, sets it to four on a tab, and at four `continue`s
  WITHOUT running the `interruptParagraph` check at all. The line is lazy prose;
  no block tokenizer sees it.
- **A fresh block inside a quote or a list item led by a tab or four spaces.**
  `blockMethods` runs `indentedCode` (module 134) before `html`, so the line is
  indented code. At the top level our INDENTED_CODE branch already consumes such a
  line before any predicate runs and is untouched here (decision Q2: NRL-113 owns
  those positions); inside a container no branch of ours did.

`Before x.` / tab `<!--` / `SECRET` / `VISIBLE` spoke `"Before x."` and Obsidian
displays all four lines. Reproduced on base `2c4e2ca` (and on the ticket's original
base `7965da2`) by running the real extractor against Obsidian 1.13.7's own parser
and renderer executed in Node (`app.js` sha256 `8efbf581...9898`, re-derived from the
installed `obsidian.asar` with `asar2.mjs`; selftest 6 ok, oracle selftest 9 ok):
**6,656 prose-loss cells**, exactly the ticket's count, on its 9-lead x 5-position x
512-combination corpus.

**The decision.** `opensHtmlBlock` takes a fifth argument, `leadIndented`, and it
refuses TERM 1 ONLY: `!setextContent && ((!leadIndented && view.slice(0, at).trim()
=== "") || closesLater)`. NRL-120's `setextContent` still gates both terms; NRL-115's
gates term 1 only, and the asymmetry is deliberate. A setext content line ENDS the
paragraph, because it is a heading. A lazy continuation does NOT, so term 2 still
applies to it (decision Q3): a lazy `<!--` whose `-->` is later in the same paragraph
is an inline comment for module 4839 and stays hidden. (Q3 is AMENDED by the F2
correction below: NRL-95's term-2 bound can stop short of that `-->` at a line module
8607 absorbs, and there term 1 is now kept instead.) The same asymmetry decides the
threading: `opensHiddenComment` passes `false` for `setextContent` (NRL-120, unchanged)
and passes `htmlLeadIndented` through, so a lazy `<!--` line no longer interrupts the
paragraph for `codeSpanClosesLater` and `bracketClosesLater`. The new predicate implies
NRL-120's for every argument: **0 violations over 291,272 tuples** (every string on
{space, tab, `<`, `x`} up to length 6, every `at`, all three flags), against 25,614 for
a deliberately widened variant.

The argument is computed per line by a forward pass, `rendererLeads`, because
"indented" is measured **after the renderer's own container dedent** and a line-local
predicate cannot see that. Module 6234 strips `>` and one SPACE (never a tab). Module
745 hands each list item to module 5540, which removes `p` columns from every line,
`p` being the smaller of the marker's padded width and the least indent of any
indented line in the WHOLE item, by module 6058's tab stops, so a tab straddling the
boundary goes entirely; `1. ` pads to FOUR columns (module 745's odd-width bump). Each
item is collected whole before any of its lines is judged. The pass FAILS CLOSED: an
unrecorded line keeps the old answer; the default block classification is FRESH, never
paragraph; unmodelled constructs put the frame into `unknown`, which ends only at a
truly empty line followed by a column-0 line. This is a hand port of PR #169's
(`baf8a85`) machinery onto the NRL-120 + NRL-131 base, not a rebase; on the
1,232,896-cell position census below, the port without the setext tiers reproduces
`baf8a85`'s numbers exactly (loss 299,008, newly leaking 6,144).

### The after-setext disclosure that blocked PR #169, and the two tiers that close it

PR #169 failed Verify on `PROSEP` / `===` / ` \t<!--` / `QSECRETQ` / `QVISQ`: the model
read the underline as paragraph text, so it claimed the ` \t<!--` line was lazy, and
the fix spoke the comment body. The renderer makes `<h1>PROSEP</h1>` and then a raw
HTML block, so both sentinels are hidden. Reproduced on `baf8a85` in 512 of 512 option
combinations per shape, base 0. It is **wider than Verify recorded**: `=`, `==`, `-`
and `--` leak the same way, in plain, intro, leading-space content, quote, nested
quote, list, ordered, callout, quote-in-list and list-in-quote positions; `---` does
not, because the model's thematic-break test already ended the paragraph.

`walkLeadFrame`'s paragraph branch now ends the paragraph at a setext underline, in
two tiers whose ORDER is load-bearing:

1. After the tab / four-column continuation test (a tab-led or four-column underline
   is a lazy continuation for module 8607, never an underline) and BEFORE the
   interrupt test: `SETEXT_UNDERLINE_EXACT` (NRL-120's constant, module 8671's exact
   shape) under exactly one content line makes the frame FRESH. It has to pre-empt
   the list and thematic-break tests because `-` and `---` there are h2 in Obsidian.
2. AFTER the interrupt test, and only when it is false: any other underline-shaped
   line (`RL_SETEXT`, now tolerating a trailing CR: two or more content lines above,
   ` ===`, `=== `, a count the walker may get wrong in a container view) puts the frame
   into `unknown`, which records nothing, so following lines keep the old answer.

**A measured wrong arm is why tier 2 sits after the interrupt test.** One broad
underline test placed BEFORE it pre-empts `walkLeadList`, so `> PROSEP` / `>    -` /
`>\t<!--` leaked: the renderer makes `   -` a list item whose content `<!--` opens an
HTML block, and the walker made the next line a fresh indented-code line. That arm
newly leaks **45,056** sentinel-cells on the after-setext census below. The lesson is
the same block-position error class NRL-136's rework was blocked on: ending a paragraph
is fail-closed only if the ending line does not open a container that consumes the
next line's lead.

### Evidence, all bare Node against the executed reading-view parser and renderer

Every cell is signed per sentinel at its own position against real rendered HTML
(`oracle111.rendererHides`). "Room" is sentinel-cells the renderer hides and base
leaves silent. Four wrong arms: **W-notiers** (the port without either tier, i.e.
`baf8a85`'s behaviour on this base), **W-preempt** (one broad underline test before
the interrupt test, no tier 2), **W-nob1** (tier 2 only), **W-term2** (narrow term 2
too).

| corpus | cells | room | fix newly disclosing | fix newly lost | base-agreeing cells moved | wrong arms newly disclosing |
| -- | --: | --: | --: | --: | --: | -- |
| position census (prior Verify's 43 positions x 14 leads x 4 shapes x 512) | 1,232,896 | 972,800 | **0** | **0** | 0 of 737,280 | W-notiers 6,144; W-term2 101,888 |
| after-setext census (28 containers x 18 underline shapes x 10 leads x 2 shapes x 512) | 5,160,960 | 3,631,104 | **0** | **0** | 0 of 2,471,936 | W-notiers 284,672; W-preempt 45,056; W-nob1 14,336; W-term2 311,296 |
| NRL-120 part-1 structural census (652,800 notes x 16 masks) | 10,444,800 | 9,527,096 | 10,640 | 72 | 23,152 of 6,576,554 | W-notiers 19,632; W-term2 22,992 |
| lookahead probe (10 containers x code/image/link x 4 middles x 10 leads, plus PR #169's quote-in-list rows, x 512) | 634,880 | 875,520 | 17,408 | 0 | 0 of 261,120 | W-term2 69,632 |
| fresh-seed fuzz (seeds 1150115, 8250402, 6021023, 3141593; 4,000 notes each x 4 masks) | 64,000 | 37,915 | 6 (2 notes) | 22 (4 notes) | 576 of 48,328 | W-preempt 10; W-term2 72 |

The after-setext census rows are: underlines `=`, `==`, `===`, `-`, `--`, `---`,
`----`, `- -`, ` ===`, `  ===`, `   ===`, `   -`, `=== `, `===\t`, `===\r`, `\t===`,
`    ===`, ` \t=`; leads ` \t`, `  \t`, `   \t`, tab, 4 and 8 spaces, `\t `, `\t\t`, 3
spaces, none; containers plain, intro paragraph, two and three content lines,
leading-space content, after an ATX heading, after a hard break, quote, quote with two
content lines, nested quote, nested quote with an outer-depth underline, list, list
with two content lines, ordered list, callout, lazy underline in a quote and in a list,
fully lazy quote and list, quote-in-list, list-in-quote, `>\t` quote, `>\t` underline,
a fence before the paragraph (top level, quoted, in a list item) and a fence around the
opener (quoted, in a list item).

**Every newly moved cell is accounted for, by ablation and not by pattern.** The rule:
a newly disclosing or newly lost cell is accepted only if BASE, on the same note with
the `<!--` the fix declines defused to `xx` (singly, then in pairs, then all at once),
at the same option mask, does the same, AND the renderer's verdict for that sentinel is
unchanged by the defusal. All 10,640 + 72 structural-census cells, all 17,408
lookahead cells and all 6 + 22 fuzz cells pass it; **0 unexplained**. Every base-agreeing
cell that moved (23,152 and 576) is byte-identical to base's output on the defused note.
The classes, so they are not rediscovered as new:

- Structural census: a lazily-continued `<!--` line followed by a raw HTML block
  (`<div>` with a mid-line `<!--`, a `<?x` processing instruction) or a reopen line
  (`<!-- y --> <!--`). These are NRL-120's and NRL-137's pre-existing raw-HTML classes,
  unmasked once base's over-hiding stops swallowing them.
- Lookahead: every one of the 17,408 is the sentinel INSIDE an image label (the alt
  attribute) with `speakImageAlt` on, image rows only; links and code spans moved 0 toward
  disclosure, and no destination was newly spoken. Speaking alt text is the designed
  `speakImageAlt` behaviour, and base speaks the same once the line is defused.
- Fuzz: 6 + 22 cells in 6 notes, all passing the defusal rule. One note was run down
  by hand: a `%%` on a callout title line, which the renderer does not open and we do
  (the class NRL-136's Verify recorded); base's earlier over-hiding had been closing
  over it, and only defusing BOTH lines the fix declines reproduces the fix's output.
  The other five are attributed by the rule only, not root-caused.

**PR #169's NRL-131-attributed cells, re-measured on this base.** Its lookahead
probe's 8,192 quote-in-list destination cells: **0** newly leaking now (NRL-131 peels
the nested quote), and that row instead closes 8,192 cells of prose loss. Its own
4,000-note fuzz (generator seeds 1 to 4,000, its four masks) re-run here: **29 newly
leaking cells in 3 notes -> 1 cell in 1 note**, and **6 newly lost in 1 note -> 6 in
1 note**, all reproducing on base defused. Both surviving notes carry an indented
backtick fence line (six spaces in one, a list-continuation fence in the other), the
shape PR #169 traced to `FENCE` accepting any indent (NRL-132); that root was not
re-derived here, only the defusal attribution was. Its two `pin-nrl115-unmasked-quote-in-list-*` tripwires are
not carried over: on this base both shapes agree with the renderer.

**One pre-existing expectation moved, replaced in place.** NRL-131's tripwire
`- > \t<!-- ZHIDEZ` / `more ZPROSEZ` asserted `[]` and asked to change when NRL-115
landed. The renderer shows `<pre><code>&#x3C;!-- ZHIDEZ</code></pre><p>more ZPROSEZ</p>`
inside the quote inside the item, so both lines are displayed and it now asserts
`["<!-- ZHIDEZ", "more ZPROSEZ"]`. The first line is spoken as prose rather than
dropped as code even under `skipCodeBlocks`, which is pre-existing: the defused twin
`- > \txx ZHIDEZ` speaks `xx ZHIDEZ` on base under the same options.

**Tests.** 22 `pin-nrl115-` rows plus the replaced tripwire were RED on `2c4e2ca`
(23 failures) and green on the fix. 16 `pin-nrl115-setext-` rows are green on base and
on the fix and RED against W-notiers (16 failures); W-preempt fails the two
`guard-nrl115-setext-preempt-` rows, W-nob1 fails `pin-nrl115-setext-dash1-space-tab`,
and W-term2 fails `guard-nrl115-term2-same-paragraph-closer-still-hides` and NRL-120's
`guard-nrl120-tab-lead-is-lazy`. Every other `guard-nrl115-` row is green on all arms
and counts as nothing.

**Interactions.** Function bodies were brace-matched out of `2c4e2ca` and the fix and
hashed: `opensObsidianBlock`, `isSetextContentLine`, `containerPrefix`, `peelQuotes`,
`endsTerm2Scan`, `endsTerm2Block`, `opensMathBlock`, `labelClose`,
`containerCarryStops` and `firstRunOfLength` were byte-identical on that first rework
(`containerCarryStops` no longer is: see F1 below), and `extractChunks`
differs only in computing `htmlLeadIndented` and threading it, so the `listDedented`,
`setextContent` and `htmlCloserAhead` passes are untouched. `sourceIndex` was clean by
numeric UTF-16 code-unit index on base and on the fix in every census row above (0
length, bounds, monotonicity or identity failures; 11,753,984 fix chunks / 85,433,856
units in the after-setext census alone), with the equation exemption keyed on the
synthetic TEXT, and the checker is non-vacuous: on the position census all four mutators
are nonzero on both arms (drop 14,580 / 17,512 length; shift 5,136 / 7,144 bounds and
14,580 / 17,512 identity; swap 14,580 / 17,512 monotonic; zero 14,356 / 17,288
monotonic, base / fix).

**Known misses, left on purpose.** Tier 2 keeps base's hiding wherever an
underline-shaped line is not the exact one-content-line heading, so where the renderer
in fact continues the paragraph (two or more content lines, ` ===`, `=== `, `===\t`)
the text after an indented `<!--` stays silenced; pinned as
`pin-nrl115-setext-two-content-lines-left` and two siblings. On the after-setext census
the price of both tiers together, measured as displayed sentinel-cells the port without
tiers spoke and the fix does not, is 1,183,744, and it also contains top-level fresh
blocks after a heading (indented code for the renderer; decisions Q2 and Q5). The
fresh-seed fuzz cannot see the setext class (W-notiers newly leaks 6 there, the same 6
as the fix), so the two censuses are the evidence for it, not the fuzz. PR #169's other
misses stand: top-level fresh blocks after a heading, a thematic break, a fence close, a
real table or a lazy line after a quote stay silenced (Q2, Q5); a table-row-shaped line
is classified FRESH; term 2 still hides an indented code line inside a container whose
`-->` follows by our scan (Q3); and a container's indented-code line is spoken as prose,
so `skipCodeBlocks` does not remove it.

**NOT VERIFIED IN OBSIDIAN.** No deploy and no CDP session happened. The oracle is the
shipped reading-view parser and renderer executed in Node; **Live Preview is separate
code and was not examined**. Rule 11 applies to every number in this section. R-M08 is
still NOT met and the `2 of 16` count does not move.

### Rework r3 (2026-10-02): the ship critique's F1-F3, NRL-155's (iv), and four defects the fuzz found

The first rework (kept patch, critique BLOCK at `818f8d0`) was re-applied onto `9dadbea`,
after NRL-155. NRL-155's `isSetextContentLine`, `MODULE134_INDENTED_CODE`, `INDENTED_CODE`
and `SETEXT_UNDERLINE_EXACT` are byte-identical (bodies hashed out of both trees), as are
`opensObsidianBlock`, `containerPrefix`, `peelQuotes`, `endsTerm2Scan`, `endsTerm2Block`,
`opensMathBlock`, `labelClose` and `firstRunOfLength`. Reproduced first on `9dadbea`: the
ticket corpus gives exactly **6,656** prose-loss cells, and `Intro.` / ` \t<!--` / `===` /
`HIDDENA` / `more` speaks `Intro.` where the renderer displays all of it.

- **F1 (disclosure, critique).** `containerCarryStops` still stopped the label carry at a
  peeled `\t<!--` line that cleanLine no longer hid, so `> A ![alt ZAZ` / `>\t<!--` /
  `> words](ZDZ.png) ZBZ` spoke the destination. It now takes `lazyLead` and does not
  apply its HTML-tag stop on a line `rendererLeads` marks as a LAZY continuation (every
  tag, because such a line never reaches module 8776). **Deviation from the plan**, which
  passed all of `htmlLeadIndented`: the fuzz showed that refusing on a FRESH indented-code
  line inside a container newly loses a displayed destination (`>\t![alt` / `>\t<div>` /
  `>\tx](ZDZ.png)` is a code block, which no label spans), so only the lazy half is passed.
- **F2 (disclosure, critique).** `Prose` / `\t<!-- ZCZ` / `\t` / `ZHZ -->`: Obsidian absorbs
  every tab-led line as lazy text and the `-->` closes an inline comment; NRL-95's term-2
  bound stops at the `\t` line, so term 2 was false and term 1 was refused. The walker now
  records `closerInPara`: a lazy indented line keeps term 1 when a `-->` lies later in the
  walker's own lazy paragraph (the scan stops at a whitespace-only line with no tab or at
  an unindented interrupter, and continues through underline-shaped lines). `endsTerm2Scan`
  is untouched. **Decision Q3 is amended accordingly.** Residual, not fixed and identical on
  base: the MID-LINE twin `Prose <!-- ZCZ` / `\t` / `ZHZ -->` is still spoken.
- **F3 (crash, critique).** The walker recursed per container level (RangeError at a few
  thousand `>`). It now drains an explicit stack, and stops descending at
  `RL_MAX_DEPTH` = 32 levels (iterative alone took 9,589 ms on 20,000 `- `). **Beyond the
  cap it fails closed and keeps base's prose loss**: deeper content records nothing, so each
  such line keeps the old answer. Measured over quote, list and alternating quote/list
  nesting to depth 40, seven shapes, seven masks: 32 levels are fixed, 33 and deeper speak
  exactly what base speaks (0 newly disclosing, 0 newly lost; base's prose loss retained in
  42 sentinel-cells per depth per container kind). A wrong arm that claims the un-walked
  lines as lazy newly discloses 98 and 168 cells there, so the probe can fail. Worst case
  320 ms on one line of 100,000 `- `.
- **NRL-155 (iv)** is closed by the re-applied walker (a ` \t` or tab-led `<!--` after a
  paragraph line is lazy, and the `===` after it is lazy text) and pinned.

**Four further defects, found by this rework's own fuzz rather than the plan's corpora**,
each a disclosure on the plan's prototype (kept patch plus F1-F3), each pinned with a row
RED there and green here, and each fixed in the fail-closed direction:

1. **Tabs in a thematic break.** `RL_HR` took a tab between or after the markers; Obsidian
   does not (`- \t---` is a list item, `***\t` paragraph text, `*\t*\t*` nested items, all
   executed). `> - \t---` / `>\t<!--` was read as a rule plus an indented-code line, and
   `***\t` ended the paragraph for the closer scan. `RL_HR` is now spaces-only between and
   after the markers; the tab-tolerant shape survives only in `mayInterruptQuote` and
   `mayInterruptList`, which must over-approximate.
2. **A `|`-, definition- or underline-shaped line is paragraph text** for the renderer, so
   setext tier 1's "one content line" undercounted (`>>|` / `Z` / `>>-` is a paragraph and a
   list item). Tier 1 now also needs the paragraph to have started after a non-ambiguous
   line.
3. **Such a line, or a line-start HTML construct, may itself be setext content** when an
   underline-shaped line follows (`>>=` / `>>-` is an h2; `><!--` / `>-` is an h2, not a
   comment to skip to its `-->`). The frame goes to `unknown` there.
4. **A list cut at a line that MAY interrupt it** (`$$`) may really continue its last item,
   and module 5540's dedent is the least indent over the whole item, so the walker's
   shorter item over-dedented `   \t<!--` to a bare tab. The last item of such a list is
   no longer walked.

**Evidence, all bare Node against the executed reading-view parser and renderer** (`app.js`
sha256 `8efbf581...9898`, selftest OK), on base `9dadbea`, every sentinel signed at its own
position; "attributed" means base reproduces the cell once the `<!--` the fix declines is
defused (singly, in pairs, or all at once) with the renderer's verdict unchanged.

| corpus | cells | fix newly disclosing | fix newly lost | wrong arms |
| -- | --: | --: | --: | -- |
| ticket (9 leads x 5 positions x 512) | 23,040 | 0 | 0 (6,656 closed) | - |
| setext single / hand / nested / fences / double | 1,059,840 / 277,056 / 1,351,680 / 1,216,512 / 7,065,600 | 0 | 0 | W-notiers newly discloses 14,896 on hand |
| F1 carry census (10 container prefixes x 4 constructs x 11 continuation prefixes x 9 leads x 4 middles x 4 closer prefixes x 3 comment shapes, x 4 masks) | 760,320 | 6,372, all attributed | 5,376, all attributed | kept and W-f1-off: 720 unattributed |
| F2 interior census | 42,560 | 0 | 648, all a never-closed fence under `skipCodeBlocks` (the fix speaks it with that key off) | kept: 5,876 unattributed |
| NRL-95/NRL-111-style term-2 census (2,880 shapes x 512) | 1,474,560 | 0 | 0 (11,264 `skipCodeBlocks` exclusion) | kept 57,600 |
| NRL-155 99,840 sweep | 99,840 | 0 | 0 (46,080 loss -> ok) | - |
| NRL-155 predecessor census (9,600 shapes x 512) | 4,915,200 | 0 | 0 (827,904 fixed) | kept 102,400 |
| fuzz, 6 fresh seeds x 10,000 notes x 4 masks | 240,000 | 37, all attributed | 42, all attributed | prototype and W-hr-loose: 4 unattributed |
| fuzz, 126 further seeds x 10,000 notes x 4 masks | 5,040,000 | all attributed | all attributed | found defects 2-4 on the intermediate arms |

`sourceIndex` lockstep clean by numeric UTF-16 index on base and fix (67,840 fix chunks /
659,456 units at 512 masks), equation exemption keyed on the synthetic text, all four
mutators nonzero on both arms; NEWLOCK 0 in every corpus. "New `opensHtmlBlock` implies old":
0 violations over 291,272 tuples, read out of both files, against 25,614 for a widened
variant. W-f2-stopAtSetext moves no corpus cell; NRL-155's two tab-led guards and
`pin-nrl115-f2-scan-continues-through-underline` are what catch it.

**Known misses.** The mid-line F2 twin; tier 2 and the new `unknown` exits keep base's
hiding wherever an underline-shaped line is not modelled (fail-closed prose loss); content
beyond 32 container levels keeps base's loss; a lazy `<!--` whose later `-->` sits inside a
`--` run is kept hidden though the inline regex rejects it (base's behaviour); and
`>\t<!--` lines followed by an indented `~~~` fence reach NRL-132's FENCE class. **NOT
VERIFIED IN OBSIDIAN**, reading-view parser only, Live Preview not examined.

**Rebased onto NRL-113 (#194) and NRL-116 (#200) at ship.** Both touched `extract.ts` after
this work was measured on `9dadbea`; the textual merge was clean apart from `srs.md`, and three
fixtures moved, each toward the executed renderer's verdict and each replaced in place:
`guard-nrl113-space-tab-paragraph-continuation-unmoved` (a ` \t<!--` paragraph continuation,
now spoken whole, which is this ticket's class), `pin-nrl116-html-twin-tab-lead-still-silenced`
(the following item is now spoken; the `<!--` code text is spoken as prose rather than skipped
as code) and `guard-nrl115-fresh-block-space-tab-is-nrl113` (NRL-113 closed that disclosure, so
the row now hides as the renderer does). The corpus figures in the table above are the
`9dadbea` measurements and were not re-run on the rebased tree.

**Ship critique of r3 (CONCERNS, 66), two fixes made before commit.** (1) **CRLF disclosure.**
`extractChunks` splits on `\n`, so every line of a CRLF note keeps its `\r`, and the walker's
thematic-break, heading and blank tests did not allow for one: `Prose ZPZ` / `___` / ` \t<!-- ZHZ`
/ `ZH2Z` joined with `\r\n` spoke `<!-- ZHZ ZH2Z`, which the renderer hides (972 of 336,600 cells
of the critic's CRLF setext census, 0 on base). `rendererLeads` now drops one trailing `\r` from
each line's view; the census reads 0 new disclosure / 0 new loss after, four CRLF fuzz seeds
(about 388k cells) have every remaining move reproducing on base with the declined `<!--` defused,
and three `pin-nrl115-crlf-*` rows were RED before. Whether `editor.getValue()` can hand
`extractChunks` a CRLF string at all was not checked. (2) **Quadratic closer scan.** The
`closerInPara` scan re-ran from every lazy indented line; `> Prose` plus 20,000 `>\tlazy` lines
took 22,347 ms against base's 222 ms. `closerAheadTable` computes the same answers in one backward
pass per frame (241 ms), and the two versions gave byte-identical chunks and `sourceIndex` over
400,000 fuzz notes x masks. Base is itself quadratic on other long lazy shapes (the critic
measured 46.7 s for `Prose` plus 20,000 tab-led lines on base); that is not changed here.

**Merged with NRL-117 (#209) after Verify (2026-10-02).** NRL-117 made the `%%` predicate's
list dedent an amount (`listDedented`); this section's `rendererLeads` is the `<!--` side's own
container model. The two feed different openers and stay separate (D-73-4). They do encode one
visible difference, and it is an approximation rather than a contradiction: NRL-117 budgets an
item's dedent at module 5540's `maximum` (fail toward hiding), while `rendererLeads` takes the
smaller of that and the item's least indent, which is what the renderer uses. So on
`- item` / ` x` / `     <!--` the two arrays disagree about whether the third line is a block
start, and because each array reaches only its own opener, no output moves. NRL-117's two
`<!--` twin tripwires, `pin-nrl117-html-twin-deep-indent-still-silenced` and
`-double-tab-still-silenced`, went red on the merge as written to, and were replaced in place
after checking real rendered HTML (`<li>item\n&#x3C;!--\nSECRET\nTAILA</li>`). Re-measured on
the merged tree against base `d496646`, bare Node against the executed reading-view parser:
ticket corpus 6,656 loss cells to 0; structural census 3,820,824 cells with 0 new disclosure
and 0 new loss (a naive wrong arm W1 newly discloses 32,370); setext single 1,059,840, hand
277,056, nested 1,351,680, fences 1,216,512 and double 7,065,600 cells all 0 new disclosure, 0
new loss, 0 lockstep failures; NRL-117's own 1,170-source x 512 census (2,957,312 graded text
cells) 0 newly lost, 0 newly disclosed, 110,592 losses closed (W1: 1,536 new disclosures);
NRL-155's 99,840-cell sweep 46,080 loss-to-ok and nothing worse; and a four-arm composition
check (old base, old head, new base, new head) over 720,000 fuzz cells found 110 cells where
the two changes interact, every one closing a loss. The carry and interior corpora give the same
counts the r3 plan recorded (6,372 / 5,376 unmasked and 648 `skipCodeBlocks` exclusion). NOT
VERIFIED IN OBSIDIAN.

## AMENDED by NRL-114 (2026-10-02): the term-2 bound reads a quoted line's peeled body, and term 2 is masked on a container code line

NRL-114 narrows the blockquote peel to `>` plus at most one space (ADR 0006,
clause 2's NRL-114 amendment). Its commit 7cdc7b7 could not land alone: on
`9132c3b` it newly lost displayed text, because two pieces of this ADR's rule
had only ever been fed the wide peel's output. The renderer verdicts below come
from Obsidian 1.13.7's own parser and HTML renderer executed in Node (`app.js`
sha256 `8efbf581...9898`).

**Shape A, a quote's fresh-block body that module 134 makes indented code.**
`>\t<!-- ZCZ` / `> ===` / `> ZAZ -->` / `TAIL ZBZ` renders as
`<blockquote><pre><code>&#x3C;!-- ZCZ</code></pre><p>===<br>ZAZ --><br>TAIL ZBZ</p>`.
With the tab left in the body, term 1 already declined the line (`leadIndented`),
but term 2 (the later `-->`) still opened a block and hid `===` and `ZAZ`.

*Decision.* `htmlLeadCode[k] = htmlLeadIndented[k] && !leads.cont[k] &&
!leads.unsureFresh[k]`, i.e. `leadIndentedForHtml`'s `nested &&
startsIndentedCode(lead)` fresh-block branch, and term 2 is masked ONCE, at the
array level: `htmlClosesLaterAt` replaces `htmlCloserAhead` at every reader
(the `cleanLine` call, `codeSpanClosesLater`, `bracketClosesLater` and through
them `interruptsParagraph` and `opensHiddenComment`). Masking can only make term
2 false, so `opensHtmlBlock`'s composed answer still implies its old one, and its
body is byte-identical. The same flag vetoes a `%%` block opener on that line
(`cleanLine`'s new `containerCodeLine` argument) and stops a label carry in
`bracketClosesLater`, because the renderer has a code block there in both cases.

*Where the walker is unsure, base's answer is kept whole.* After a table-shaped,
definition-shaped, block-id-shaped or underline-shaped line the walker says
"fresh" as a safe default, while the renderer may continue a paragraph (or, after
`[^1]:`, a footnote it dedents). Masking term 2 there newly spoke an inline
comment's body (`> | a |` / `> \t<!-- SECRETH` / `> =` / `> HIDDEN` / `> --> t.`
is ONE paragraph), so `rendererLeads` records `unsureFresh` and those lines take
the pre-NRL-114 raw term-2 answer (`htmlCloserAheadRaw`). A lone CR before the
line's first `<!--` or `%%` drops the term-1 veto, since the renderer starts a
new physical line there that the walker never saw.

**Shape B, a lazy tab-led continuation, then a QUOTED paragraph end.**
`> Plain ZPZ prose` / `>\t<!-- ZCZ` / `> ---` / `> ZAZ -->` / `TAIL ZBZ` renders as
`<blockquote><p>Plain ZPZ prose<br>&#x3C;!-- ZCZ</p><hr><p>ZAZ --><br>TAIL ZBZ</p>`.
The term-2 pass read the raw line, so `> ---` was never a stop (NRL-95 had pinned
this as a fail-closed residual; the narrower peel unmasked it).

*Decision.* `term2QuotedStop` WRAPS `endsTerm2Scan` / `endsTerm2Block` rather than
editing them (both bodies byte-identical, for NRL-119's lane): an unquoted line
takes exactly the old path; a quoted line is peeled with `TERM2_QUOTE_LEVEL`
(`/^ {0,3}> ?/`, spaces only on both sides, narrower than the peel's own
`\s{0,3}` on purpose, since a `>` behind a tab is a lazy continuation for module
8607, not a nested quote) and then:

- a spaces-only blank body is a stop;
- a body whose lead is four or more spaces or whose first non-space character is
  other whitespace (a tab, an NBSP) is NOT a stop, blank or not (decisions Q4 and
  Q10): module 8607 lazy-continues it, and stopping there is the disclosure
  direction (`pin-nrl114-quoted-tab-hr-is-not-a-stop`,
  `guard-nrl114-quoted-tab-blank-is-not-a-stop`);
- a callout TITLE on a quote's certain first line is a block of its own;
- anything else is `endsTerm2Scan(body, ...)`, unchanged.

**Deviation from the plan: no depth-rise stop.** Decision Q3 planned a stop where
quote depth rises. It was built and REMOVED: remark keeps more lines in one
paragraph than a bare depth test predicts, and that arm newly spoke hidden text
in this ticket's fuzz. Its cost is the pre-existing one, pinned as
`pin-nrl114-deeper-quote-still-hides-term2` (`> Plain <!--` / `>> ZAZ -->`, the
renderer displays ZCZ and ZAZ, identical on every arm, fail-closed).

**`isSetextContentLine`'s quote arm** gets the plain arm's NRL-155 lead rule on
the quote body (`PLAIN_SETEXT_HTML_OPENER` and not `MODULE134_INDENTED_CODE`, a
tab-bearing lead only in block position via `inQuoteSetextBlockPosition`), with
one base-parity case: a non-space, non-tab whitespace character directly after
`>` keeps the old spaces-only answer. Narrowing term 1's `.trim()` lead for that
character was built, closed those cells, and unmasked 46 newly disclosing fuzz
cells of the classes below, so it was reverted.

### Evidence, all bare Node against the executed renderer

Censuses, base `9132c3b` against the fix, units = sentinel-cells (every sentinel
in a shape x every one of the 512 content-key masks, signed against the rendered
HTML; a displayed sentinel in a code, heading, table or math context is excused
when its content key is on). "Reconstructed" means rebuilt by construction from
the source ticket's description, not replayed.

| corpus | shapes x masks | lost base -> fix (closed / NEWLY) | disclosed base -> fix (closed / NEWLY) |
|---|---|---|---|
| NRL-114 amendment census, reconstructed (7 leads x 6 bodies x quoted/lazy x closer/none x 2 positions) | 308 x 512 | 75,264 -> 30,720 (44,544 / **0**) | 4,096 -> 0 (4,096 / **0**) |
| run 205646 quoted-setext class plus quoted-HR rows, reconstructed | 270 x 512 | 36,864 -> 24,576 (12,288 / **0**) | 0 -> 0 (no room) |
| run 205646's 638,976-cell census plus augmentation, reconstructed | 1,664 x 512 | 359,680 -> 115,968 (243,712 / **0**) | 88,064 -> 20,480 (67,584 / **0**) |
| 7cdc7b7's 3,150-shape census plus quoted HR/blank rows | 5,670 x 512 | 986,112 -> 373,504 (612,608 / **0**) | 97,792 -> 66,048 (31,744 / **0**) |
| NRL-115 Verify census plus augmentation | 5,418 x 512 | 1,261,312 -> 819,456 (441,856 / **0**) | 2,048 -> 0 (2,048 / **0**) |
| NRL-155 predecessor census plus quoted twins | 20,800 x 512 | 5,448,192 -> 3,427,840 (2,020,352 / **0**) | 48,128 -> 48,128 (0 / **0**) |
| NRL-131 position census x 512 plus `<!--` rows | 980 x 512 | 314,112 -> 82,176 (231,936 / **0**) | 0 -> 0 (no room) |

Destination: 6,656 -> 6,656 in the 638,976-cell corpus, 0 moved, 0 elsewhere.
Every corpus carries a quoted-setext row, a quoted thematic-break row (`---`,
`***`, `-`, bare `>`) and a tab-led `<!--` row. Room to fail is shown by the
wrong arm: 7cdc7b7 alone newly loses 10,240 sentinel-cells in the amendment census
and 46,080 in the 3,150-shape one, and the depth-rise and term-1-narrowing arms
both newly disclosed in the fuzz.

**Fuzz, and every newly moved cell adjudicated on a defused control (decision
Q11).** Three 4,000-note fuzz runs (per-line unique sentinels; tabs, NBSP, VT,
U+3000, lone CR and CRLF; quote, nested-quote, tab-between-levels, callout, list
and quote-in-list prefixes; `<!--`, `-->`, `%%`, setext, quoted HR, tables,
footnotes, destinations), masks 221 (the suite's `OPTS`) and 0:

| seed | sentinel-cells | lost base -> fix (closed / newly) | disclosed base -> fix (closed / newly) |
|---|---|---|---|
| 20261002 | 25,978 | 3,352 -> 2,285 (1,071 / 4) | 615 -> 607 (19 / 11) |
| 7 | 25,854 | 3,266 -> 2,334 (937 / 5) | 671 -> 654 (25 / 8) |
| 99 | 26,034 | 3,197 -> 2,283 (914 / 0) | 639 -> 637 (4 / 2) |

All 30 newly moved sentinel-cells sit in 15 notes. In every one, base was right
only by accident: an over-wide peel or opener that this change corrects had
hidden or exposed the region, and the fix exposes a pre-existing gap behind it.
Each is accepted ONLY because the fix's output on the note is byte-identical,
modulo the one defused token, to base's output on a twin with that trigger
defused:

| note | moved | class | defused twin (base output = fix output on the original) |
|---|---|---|---|
| 20261002 n1670, n1796, n2730; 7 n510, n990, n3011; 99 n1486 | disclose a footnote body | NRL-163 (unreferenced footnote definition) | `>\v%%` -> `>\va%%`; `<!--` -> `<!-`; `>\t> %%` -> `>\t> a%%`; `>　%%` -> `> a%%`; `>>\t%%` -> `>>\ta%%`; `>\t>    %%` -> `>\t>    a%%`; `<!--` -> `<!-` (twins in note order) |
| 20261002 n193, n2311 | disclose text after a lone CR | NRL-164 (lone CR) | `>　%%` -> `> a%%`; `<!--` -> `<!-` |
| 20261002 n1334; 7 n1018, n1123 | lose text after a lone CR | NRL-164 | `%% HBAZ` -> `HBAZ`; `>>\t%%` -> `>>\ta%%`; `>\t>    %%` -> `>\t>    a%%` |
| 20261002 n3524; 7 n1677 | lose text after a VT- or tab-led `%%` in a list/quote | NRL-165 (NRL-153 family) | `[!note]      %% HAAZ` -> `[!note]      HAAZ`; `> \t %%` -> `> \t a%%` |
| 7 n263 | disclose a `<!--` body inside a raw `<div>` block | NRL-137 | `>     %%` -> `>     a%%` |

NRL-164 and NRL-165 were filed by this ticket with renderer / base / fix rows;
NRL-163 was filed at the orchestrator's unblock. None is an owner decision for
NRL-114.

**Found at ship by `/critique`, outside every corpus above, and adjudicated the
same way.** A hand-built probe set of 60 shapes and a further 4,000-note fuzz (seed 4242,
quote, list, callout, footnote, table, setext, HR, fence, math, `%%`, `<!--` and
label populations, 20% CRLF, masks `skipCodeBlocks`/`skipTables` off and on,
30,064 sentinel-cells, executed renderer) turned up newly moved cells in four
probe shapes (below) and in 8 fuzz notes (42 sentinel-cells). Every one has a
twin, one defused token or one `>\t` -> `> \t`, on which base speaks exactly the
fix's sentinel set (a set comparison, weaker than the byte-identity used for the
table above), so each is an unmasking under decision Q11 and not a new class:
the fuzz notes fall into the NRL-163 footnote class, the code-line inline-`%%`
miss below, and one CRLF `$$` scope note whose `<!--`-defused twin loses the
same tail on base. But the first probe shape is named nowhere above, which is
the corpus-blindness lesson again: no structured corpus put a table-shaped line
above the opener.

| shape | moved | why | base control (base output = fix output) |
|---|---|---|---|
| `> \| a \|` / `>\t<!-- ZCZ` / `> ---` / `> ZAZ -->` | lose ZCZ, ZAZ | `unsureFresh` keeps the raw term-2 answer, which never sees `> ---` (the NRL-95 container residual) | the ` \t` twin, `> \| a \|` / `> \t<!-- ZCZ` / ...; also the unquoted `\| a \|` / `\t<!-- ZCZ` / `---` |
| `> [^1]: foot` / `>\t<!-- ZCZ` / `> ---` / `> ZAZ -->` | lose ZAZ (and stop disclosing ZCZ) | the renderer's footnote holds `<!-- ZCZ` as an html node; NRL-163 | the unquoted `[^1]: foot` / `\t<!-- ZCZ` / `---` / `ZAZ -->` |
| `>\t%% ZAZ` / `> \tZBZ %% ZCZ %%` | lose ZCZ (and stop losing ZAZ, ZBZ) | a container line declined as code is still cleaned as prose, so its inline `%%` pair is stripped (the known miss above) | the ` \t` twin `> \t%% ZAZ` / ... |
| `> \t-` / `>\t\tZAZ` / `>\t> ZBZ <!-- ZCZ` / `> \t[^1]: ZDZ` / `[^1]: ZEZ` / `>\tZFZ -->` | disclose ZEZ, ZFZ | an unreferenced footnote definition after a code block; NRL-163 | `<!-- ZCZ` -> `ZCZ` |

The first two are pinned with their controls
(`pin-nrl114-table-line-then-quoted-hr-still-hides-term2` /
`guard-nrl114-table-line-space-tab-control`,
`pin-nrl114-quoted-footnote-then-quoted-hr-unmasked` /
`guard-nrl114-unquoted-footnote-control`); each pin is RED on base and each
control is green on base. The same fuzz found 0 `sourceIndex` length or identity
failures on the fix.

**`sourceIndex`**, by numeric UTF-16 code-unit index on both arms over every corpus
above and all three fuzz runs: **0 failures** (fix: 28,561,920 chunks / 168,228,352
units on the largest corpus alone), with all four mutators nonzero on both arms
in every corpus (drop-one: length; shift-all: identity, plus bounds where a chunk
ends at the note's end; swap-two: monotonic and identity; negate-one: bounds).
Both exemptions are pre-existing: without `text[i] === " "` the fuzz reports 535
identity failures on base and 541 on the fix, and without the synthetic
`equation` text 208 on each.

**Function bodies** (sha256 prefix of the brace-matched body, by an extractor
that skips strings, template literals, comments and regex literals and skips an
object-literal return type; it reproduces AGENTS.md's recorded `labelClose`
`92023b33` and `flowDepthDelta` `ec178340`): byte-identical on base, 7cdc7b7 alone
and the fix: `opensHtmlBlock` `fcd96db3`, `opensObsidianBlock` `f3cce67c`,
`interruptsParagraph` `fb9d300a`, `endsTerm2Block` `6ee6ee43`, `endsTerm2Scan`
`79a65e08`, `codeSpanClosesLater` `57607b36`, `labelClose` `92023b33`,
`closerAheadTable` `76967375`, `opensMathBlock` `77f97d0a`, `inlineContainerClose`
`8da74d5f`, `wikiTargetClose` `18052772`, `flowDepthDelta` `ec178340`,
`opensHiddenComment` `98f5273f`. Moved, as intended: `peelQuotes` (7cdc7b7),
`containerPrefix` (7cdc7b7), `isSetextContentLine`, `bracketClosesLater`,
`cleanLine` (one argument and one term).

**Tests.** Against base `9132c3b`, 22 NRL-38 checks are red (10 are 7cdc7b7's own
pins, 12 this continuation's, including five pre-existing tripwires replaced in
place: `pin-nrl95-bullet-inside-quote-still-hidden`,
`pin-nrl117-scope-cost-contentless-marker`, `pin-nrl120-quoted-math-still-hidden`,
`guard-nrl155-quote-arm-unchanged`, `guard-nrl155-list-arm-unchanged`) and the
NRL-114 textual section throws. Against 7cdc7b7 alone, 15 are red: 13 of this
continuation's and the two `pin-nrl115-f1-code-line-*` pins 7cdc7b7 regressed on
this base. Four guards are green on all three arms, and two 7cdc7b7 fixtures
whose expectations were stale on every arm were renamed and replaced
(`guard-nrl114-quote-tab-html-comment-spoken`,
`guard-nrl114-setext-quote-tab-html-opener-spoken`).

**Known misses, pinned.** A container line declined as code is spoken as prose,
so `skipCodeBlocks` does not silence it (displayed text, base parity on the
shapes base already spoke). `>  \t<!-- ZCZ` / `> ===` speaks the `===` underline
the renderer does not display (a glyph, not hidden text). A deeper quote after an
opener still hides (above).

**NOTHING WAS OBSERVED IN OBSIDIAN.** Reading-view parser and renderer executed
in Node only; Live Preview has never been read or run; AGENTS.md rule 11 applies
to every number above. Overlap: NRL-119 edits `endsTerm2Block` and `TERM2_LIST`;
this change wraps them and never edits their bodies, and whichever of the two
merges second must rebase and re-run both censuses. R-M08 is NOT met and the
2-of-16 MUST count does not move.

### CLOSED by NRL-119: a list marker alone on its line ends the paragraph

`TERM2_LIST` required `[ \t]` after the marker, so a marker ALONE on its line was not
a term-2 stop. Module 745's silent path accepts a marker followed by a newline or end
of input (`if (next!==" " && next!=="\t" && (pedantic || next!=="\n" && next!=="")) return;`),
and `list` is unconditionally in `u.interruptParagraph`, so `*`, `+`, `1.` and `1)`
alone on a line each end the paragraph. Reproduced at base `faf55a3` before any edit,
with Obsidian 1.13.7's own `WT` parser and `GT` renderer executed from the installed
`obsidian.asar` (app.js sha256 `8efbf581...9898`, re-derived from the installed flatpak
with `asar2.mjs` in the same session): `Prose <!--` / `*` / `HIDDENE` / `--> t.` renders
`<p>Prose &#x3C;!--</p><ul><li>HIDDENE<br>--> t.</li></ul>`, and the same for `+`, `1.`,
`1)` and a CRLF `*\r`, while base spoke `"Prose t."` in all five. Fail-closed prose loss.

**The change is the tail only:**

```
TERM2_LIST = /^ {0,3}(?:[-*+]|1[.)])(?:[ \t]|\r?$)/
```

The indent cap and the digit rule from NRL-111 are unchanged, and both still bind a
bare marker: `    *`, `\t*`, `7.`, `7)` and `01.` alone on a line each render as ONE
`<p>` with the sentinel inside the raw comment, so the renderer HIDES it. `\r?` is
there because `extractChunks` splits on `\n` alone. `TERM2_LONE_DASH` was deliberately
NOT folded into this pattern: it carries a distinct setext-position meaning (the `<h2>`
case) and folding it would move the NRL-95 and NRL-111 dash pins that cite it. The two
now overlap on a bare `-`, which changes no answer because both are ungated block ends
in `endsTerm2Block`. `LIST_BULLET` was deliberately NOT widened (see the glyph residual
below). The `src/` diff is that one regex plus comments.

**Fixtures: 7 RED before, 0 after.** `pin-nrl111-bare-ordered-marker-unmasked` was
REPLACED IN PLACE (same name) from the tripwire `"Prose t."` to
`"Prose <!-- more === 1) HIDDENE --> t."`, re-measured against the renderer; six new
pins, `pin-nrl119-bare-{star,plus,one-dot,one-paren}-interrupts`,
`-bare-star-three-space-indent-interrupts` and `-bare-star-crlf-interrupts`, were each
RED on base. Six fixtures are GUARDS, green on both sides and not counted:
`guard-nrl119-bare-star-trailing-space-interrupts` (the plan expected it red; `* `
already matched the old `[ \t]`, so it was relabelled), and
`guard-nrl119-bare-{seven-dot,seven-paren,zero-padded-one,four-space-star,tab-star}-hidden`.
Each guard of the last five has room to fail against a deliberately wrong arm: the
three digit guards are RED on an arm with `\d+[.)]` in front of the widened tail, and
the two indent guards are RED on an arm with `^[ \t]*`, as are NRL-111's four digit
guards and its two indent pins respectively. A shadow arm (the fix tree with the old
pattern restored) reproduced base exactly, so the arm builds read their own copies.

**Two-class probes, oracle = `oracle111.rendererHides`, never `leak.cjs`.**

| corpus | cells per arm | room (disclosure / prose loss) | base A spoken / B lost | fix A spoken / B lost | newly leaking | newly lost |
|---|---|---|---|---|---|---|
| NRL-111's 1,350-shape corpus | 691,200 | 301,056 / 374,784 | 0 / 15,360 | 0 / 10,240 | **0** | **0** |
| NRL-119 bare-marker corpus | 622,080 | 294,912 / 86,016 | 0 / 241,152 | 0 / 142,848 | **0** | **0** |
| NRL-111's 17 must-not-widen controls | 8,704 | - | agree with renderer in 17 | agree in 17, 0 moved | 0 | 0 |

**Those two "0 newly lost" figures were TRUE OF THEIR CORPORA AND FALSE OF THE CHANGE,
and independent Verify blocked the PR on it.** Neither corpus held a soft-wrapped code
span or link/image label, so neither could see the carries; see "NRL-119 fix round 1"
below for the 67,584 cells of new prose loss the first diff caused there and the second
edit that closes them. Read every number in this section as the first diff's, except
where the fix round re-measured it.

The bare-marker corpus is 9 markers (`-`, `*`, `+`, `1.`, `1)`, plus `7.`, `7)`, `01.`,
`01)` so the disclosure side has room) x indents {0, 1, 3, 4 spaces, tab} x tails {end of
line, a space, `\r`} x 9 positions (line after the opener, after two content lines,
after a block end, after `===  `, opener in a list item, in a quote, as an ATX heading,
the line before the closer, and the marker line BEFORE the opener with a `===` after it)
x 512 content keys. It closed 98,304 prose-loss cells and moved nothing else. **The
probe reaches the disclosure side on wrong arms**: `\d+[.)]` with the widened tail
newly leaks **98,304** cells and `^[ \t]*` with it **76,800**; on NRL-111's corpus the
same two arms newly leak 20,480 and 5,120. An arm using `(?:\s|$)` instead of
`(?:[ \t]|\r?$)` agrees with the fix on both corpora and on every fixture; only the
census below separates them.

**Exhaustive moved-line census.** Every line of length 5 or less over {space, tab, `-`,
`*`, `+`, `1`, `7`, `0`, `.`, `)`, `x`, `\r`} (271,452 lines) x `paraLinesAbove` 0..3,
with `endsTerm2Scan` and `endsTerm2Block` LIFTED from each arm's own source by brace
extraction (throws on a missing span, no transcription). **30 lines widen, 0 narrow, and
every one of the 30 is `^ {0,3}(?:[-*+]|1[.)])\r?$`.** Each was then SIGNED at its own
position against the renderer, in 11 positions x 512 masks = 168,960 cells: **0 newly
leaking, 0 newly lost, 138,240 prose-loss cells closed.** The disclosure room inside that
set is only 15,360 cells (a line-start `<!--`, where the renderer hides and nothing
moved), because the 30 lines are real interrupters; room on the disclosure side is
carried by the corpus above, not by this census. The census does separate the wrong
arms, signed at the same 11 positions over masks 0 and 511: `\d+[.)]` widens 2,452
lines (2,422 off the expected form) and newly leaks 30,868 cells; `^[ \t]*` widens 1,452
(1,422 off-form) and newly leaks 17,202; `(?:\s|$)` widens 6,444 (6,414 off-form, every
one with a `\r` before the end of the line) and newly leaks **10,834** cells in the
"marker line before the opener" position. So the `\r?$` shape is load-bearing, not
cosmetic.

**`sourceIndex` lockstep** by numeric UTF-16 code-unit index on both arms: NRL-111's
corpus base 974,848 chunks / 17,349,120 units and fix 974,848 / 17,477,120, 0 failures
of length, monotonicity, bounds or identity; the bare-marker corpus base 889,344 /
6,352,640 and fix 920,064 / 8,364,800, 0 failures. All four mutators nonzero on both
arms (bare-marker corpus, fix: drop 880,896 length; shift 622,080 bounds + 297,984
identity; swap 713,472 monotonic + 713,472 identity; zero 920,064 identity; base drop
850,176, shift 622,080 + 267,264, swap 658,176 + 658,176, zero 889,344). The
`text[i] === " "` exemption is mandatory and pre-existing (without it: fix 221,184,
base 116,736). The equation exemption keys on the synthetic TEXT and was exercised on a
156-note math corpus (inline `$$y$$`, `$x$`, display, with bare-marker middles added):
0 failures with it, and without it 70,656 on the fix and 60,416 on base, all four
mutators nonzero on both.

**Fuzz**, 4,000 notes x 4 option sets with bare markers added to NRL-111's vocabulary:
0 newly leaking, 0 newly lost, class B 858 -> 854. NRL-111's own fuzz, unchanged: 0 and
0, class B 1,112 -> 1,100. **Honest limit:** the fuzz is weak on this axis; the
`\d+[.)]` arm also reads 0 newly leaking on it, and only `^[ \t]*` reaches 4 cells.

**Residuals, all fail-closed and all identical on base and fix.**

- **The marker GLYPH is still spoken.** The renderer shows no marker, but `TERM2_LIST`
  only decides where the term-2 scan stops; dropping the glyph is `LIST_BULLET`'s
  block-level `\s+` strip, which feeds `containerPrefix` and `blockType` and accepts any
  `\d+`, so it needs its own position-gated measurement. So the new pins expect
  `"Prose <!-- * HIDDENE --> t."`, and `guard-nrl111-lone-dash-third-line` keeps its
  expectation (only its comment changed). No word is lost or leaked by the glyph. Owned
  by NRL-154, filed from NRL-119's ship phase. The same root also let
  `bracketClosesLater` and `codeSpanClosesLater` carry across a bare marker; that half
  is NO LONGER a residual, it was folded into NRL-119 by the fix round below.
- **A quoted opener** (`> Prose <!--` / `> *`): 23,040 cells lost on both arms. The
  term-2 pass reads raw lines and never peels `>`; the NRL-88 root-1 class.
- **Container-relative indentation in a list item**: `- Prose <!--` followed by a
  4-space or tab-indented marker, or by `7.` / `01.` at 0 or 1 space, displays the
  sentinel and we hide it, 27,648 cells on both arms.
- **An ATX opener and a marker line before the opener**: 46,080 cells each on both
  arms, the 4-space/tab and non-`1` digit rows. The ATX one is
  `guard-nrl95-atx-opener-not-bounded`'s class; the before-the-opener one is a fresh
  block, where indented code or any digit string starts a block that our count does not
  model. Not opened or widened here.

### NRL-119 fix round 1: `interruptsParagraph` sees a bare marker too

**What Verify found.** Widening `TERM2_LIST` alone newly LOST displayed prose. A
soft-wrapped code span, link label or image label whose opener line carries a mid-line
`<!--`, and which wraps across a bare marker line, was CARRIED across it:
``A `xx <!--`` / `*` / `HIDDENE` / ``--> yy` B.`` spoke `"A B."` on the first diff and
`"A xx yy B."` on base, while the renderer makes no span at all
(``<p>A `xx &#x3C;!--</p><ul><li>HIDDENE<br>--> yy` B.</li></ul>``, every word displayed).
The label form, `a [xx <!--` / `*` / `HIDDENE --> zz](dest.png) b`, spoke
`"a xx * HIDDENE --> zz b"`, dropping the displayed literal `](dest.png)`. Over Verify's
42 shapes x 512 content keys: code 2,560 + 2,560, link 5,120, image 2,560 + 2,560 + 5,120
newly lost, 0 newly leaking. Reproduced on the rebased head before any edit.

**Root cause.** Two predicates answer "does this line end the paragraph", and only one
learned the bare-marker rule. The first diff taught `TERM2_LIST`, so `opensHtmlBlock`
now (correctly) answers false on such an opener line, which lets `codeSpanClosesLater`
and `bracketClosesLater` run at all. They ask `interruptsParagraph`, whose list term is
`LIST_BULLET` (`\s+` after the marker), so it never saw `*`, `+`, `1.` or `1)` alone.
The carry was confirmed across a line the renderer ends the paragraph at. This was NOT
new: the same predicate gap already silenced displayed text with no `<!--` at all
(``A `xx`` / `*` / `HIDDENE` / ``yy` B.`` spoke `"A B."` on base; that was NRL-154's
symptom 2). Base's wider `<!--` block had masked the `<!--`-bearing members, exactly as
NRL-74 unmasked root 1.

**The fix** adds one disjunct to `interruptsParagraph`:

```
BARE_LIST_MARKER = /^ {0,3}(?:[-*+]|1[.)])\r?$/
```

the bare-marker half of `TERM2_LIST`, deliberately the PRECISE rule and not
`LIST_BULLET`'s loose one. The cap and the digit rule are load-bearing in the
DISCLOSURE direction here, the opposite of the term-2 case: past three columns, or with
`7.` or `01.`, the line is a lazy continuation, the renderer forms the image or link
across it (`a ![x` / `7.` / `HIDDENE](dest.png) b` is one `<p>` with an
`internal-embed src="dest.png"`), and stopping the carry speaks the destination. This
folds NRL-154's `interruptsParagraph` acceptance criterion into NRL-119, because the two
cannot be closed separately without shipping the regression; NRL-154 keeps the glyph.
`interruptsParagraph` is still a pure widening (more stops, never fewer), so ADR 0019's
F5 invariant stays green, and its only callers are the two carry confirmations.

**Fixtures: 18 RED on the pre-round head, 0 after.** Fifteen `<!--`-bearing pins
(code, link, image x `*`, `+`, `1.`, `1)`, `   *`) and three no-comment pins for the
pre-existing class. Seven GUARDS, green on base, pre-round head and fix: a CRLF `*\r`
and a lone `-` (already stopped by `LIST_BULLET` and `SETEXT`), and five disclosure-side
guards (`7.`, `01.`, `7)`, four-space `*`, tab `*` inside an image or link label). The
`\d+[.)]` arm makes the three digit guards RED and the `^[ \t]*` arm the two indent
guards, measured in a COPIED shadow tree whose pre-round arm reproduces the 18 RED, so
the shadow reads its own source. One tripwire pin records a pre-existing class the
fix round's fuzz surfaced (below).

**Measurements, all against Obsidian 1.13.7's own `WT`/`GT` (app.js sha256
`8efbf581...9898`, `selftest.cjs` SELFTEST OK), base = `origin/main` at the rebase.**

| probe | corpus | room on base (disclosure / prose loss) | newly leaking | newly lost |
|---|---|---|---|---|
| Verify's `p3.cjs`, base -> fix | 42 shapes x 512 x 4 sentinels | - | **0** | **0** (first diff: 20,480) |
| carry corpus `p4.cjs`, base -> fix | 1,200 shapes (code/link/image x with/without `<!--` x 20 marker lines x 2 positions x plain, quote, list item, lazy, ordered item) x 512 x 4 sentinels = 2,457,600 | 407,552 / 1,486,336 | **0** | **0** (188,416 closed) |
| same, base -> first diff | same | same | 0 | **67,584** |
| same, first diff -> fix | same | 407,552 / 1,491,456 | 0 | 0 (183,296 closed) |
| same, three wrong arms | `\d+[.)]` / `^[ \t]*` / `^\s*(?:[-*+]\|\d+[.)])\s*$` | same | **100,352 / 28,672 / 129,024** | 0 |
| moved-line signing `sign.cjs`, base -> fix | the 16 moved lines x 3 kinds x 2 x 4 positions x 5 containers x 512 x 4 = 3,932,160 | 573,440 / 2,392,064 | **0** | **0** (662,528 closed) |
| NRL-111 corpus `probe111.cjs`, base -> fix | 691,200 | 301,056 / 390,144 | 0 | 0 |
| NRL-119 bare corpus `bare119.cjs`, base -> fix | 622,080 | 294,912 / 86,016 | 0 | 0 |
| 17 must-not-widen controls | 8,704 | - | 0 moved | 0 moved |

**Exhaustive census of `interruptsParagraph` itself**, lifted from each arm's own bundle
(exported from a copied tree): every line of length 5 or less over {space, tab, `-`, `*`,
`+`, `1`, `7`, `0`, `.`, `)`, `x`, `\r`} (271,453 lines) x all four
(`htmlClosesLater`, `dedentedByList`) pairs. Against base and against the first diff
alike: **16 lines widen, 0 narrow, all 16 `^ {0,3}(?:[*+]|1[.)])$`** (the `-` and `\r`
forms were already stopped). Wrong arms: `\d+[.)]` widens 356 (340 off-form), `^[ \t]*`
119 (103), the loose `\s` arm 1,211 (1,195). The 16 were then signed at their own
positions (the `sign.cjs` row above).

**Carry fuzz** (`fuzzc.cjs`, new): 4,000 notes over a vocabulary of span and label openers
and closers, `<!--`/`-->`, bare and spaced markers and containers, a unique sentinel per
prose line and per destination, 6 option sets, 82,872 cells, signed against an
option-aware view of the rendered HTML (inline `<code>` dropped under `skipInlineCode`,
`<pre>` under `skipCodeBlocks`, image `alt` counted under `speakImageAlt`). First diff
-> fix: **0 newly leaking, 0 newly lost**. Base -> fix: 0 newly lost and **8 newly spoken
cells, all one note, all inline-code text under `skipInlineCode`**, introduced by the
first diff and unchanged by this round. They are not a disclosure: the renderer
DISPLAYS the text, as code. It is a pre-existing class unmasked: a quoted code span with
its closer on a lazy line (``> A `xx`` / ``--> yy` B.``) is never carried, on base too,
because `codeSpanClosesLater` tests the raw opener line and `BLOCKQUOTE` stops it (the
code-span twin of NRL-88 root 1; NRL-98 closed it for labels only). Pinned as the
tripwire `pin-nrl119-quoted-code-span-lazy-closer-not-carried`. The fuzz reaches the
disclosure side: `\d+[.)]` 46, `^[ \t]*` 96, loose 134 newly leaking, against 10,959
cells of room.

**`sourceIndex` lockstep** by numeric UTF-16 code-unit index over the carry corpus: base
1,275,648 chunks / 13,950,976 units, fix 1,298,688 / 16,848,384, 0 failures of length,
monotonicity, bounds or identity on both. Mutators nonzero on both arms (fix: drop
1,260,800 length; shift 614,400 bounds + 684,288 identity; swap 1,220,864 monotonic +
1,220,864 identity; zero 1,298,688 identity; base: 1,229,056; 614,400 + 661,248;
1,180,416 + 1,180,416; 1,275,648). The space exemption is mandatory on both (fix 191,488,
base 130,048 without it). NRL-111's corpus: base 974,848 / 17,349,120 and fix 974,848 /
17,477,120, 0 failures. Math corpus (inline `$$y$$`, `$x$`, display), exemption keyed on
the synthetic text: 0 with it, 70,656 (fix) and 60,416 (base) without it, all four
mutators nonzero on both.

**Residuals of the round, none opened by it.** The glyph (NRL-154). The quoted
lazy-closer code span above, exclusion-only. Every remaining prose-loss cell in the carry
corpus is identical on base.

**NOT VERIFIED IN OBSIDIAN.** No deploy happened and no running Obsidian was touched;
every verdict above is the reading-view parser and renderer executed in Node. Live
Preview has never been read. Rule 11 applies to every number. R-M08 is still NOT met and
the `2 of 16` count does not move.

### NRL-119 fix round 2: the bare-marker stop reads the line the renderer reads

**What Verify found.** Round 1's `BARE_LIST_MARKER` newly SPOKE an image or link
destination (and image alt text) that base kept silent, when the bare marker sat on a
quote continuation whose `>` is followed by a TAB: `> A ![xx` / `>\t*` /
`> yy](zdestz.png) B.` spoke `"A [xx * yy](zdestz.png) B."` where base and the renderer
say `"A B."` (`<blockquote><p>A <span class="internal-embed" src="zdestz.png"
alt="xx\t*yy"></span> B.</p></blockquote>`). Verify's `tabq.cjs`, 672 shapes x 512 =
344,064 cells: 53,248 newly leaking, 0 newly lost. Reproduced on 9522c11 before any edit,
for the image and link forms, `*`, `+`, `1.`, `1)`, nested `> >\t*`, indented ` >\t*` and
a lazy closer.

**The renderer's rule after `>`**, executed with the harness and read in the blockquote
tokenizer transcribed in `obsidianBlocks.ts`: leading SPACES AND TABS are skipped, the `>`
is taken, and then ONE optional U+0020 SPACE is stripped (`if (t.charAt(D) === " ") D++`)
and nothing else. A tab, a second space, an NBSP or a CR after the `>` stays in the
content line, and an NBSP before the `>` makes the line plain text. A tab-led
continuation is never interrupted (`> A` / `>\t* x` is `<p>A<br>* x</p>`), and a lone CR
is a line ending to it.

**Cause.** `bracketClosesLater` tested every interrupter on `peelQuotes`' output, whose
`BLOCKQUOTE_LEVEL` (`>\s?`) eats the tab as if it were the optional space, so `>\t*`
became a bare `*` and round 1's term stopped the carry on a line the renderer keeps as
lazy prose.

**The change, and it is deliberately the smallest one.** `bracketClosesLater` now tests
`BARE_LIST_MARKER` on `quoteContent(line, op.quotes)` - the renderer's reading, peeling
`QUOTE_CONTENT_LEVEL = /^[ \t]{0,3}> ?/` per level - and every other interrupter on the
legacy `peelQuotes` exactly as base did, through a new `interruptsParagraphExceptBareMarker`
(`interruptsParagraph` is that plus `BARE_LIST_MARKER`, so its other callers are
unchanged). Two properties follow by construction. On a line where the two peels agree,
the lookahead is exactly 9522c11's. On a line where they disagree - a tab, NBSP or CR
right after a `>`, or an NBSP before one - the bare-marker arm cannot fire (the content
starts with that character, and `BARE_LIST_MARKER` needs spaces then a marker), so the
line is exactly base's. `containerPrefix`, `peelQuotes`, `BLOCKQUOTE_LEVEL` and every
other caller are untouched.

**Why not the renderer's peel for every arm, which the brief preferred.** It was built
and measured three times this round, and each draft was rejected by measurement:

1. The peel alone (e3684fb's first form) closed base leaks (`>\t-`, `>\t=`, `>\t===`,
   `>\t<div>`) but newly LOST displayed text in three places where the old peel's
   accidental stops had masked a missing one: a tab-led code opener (16,640 cells in the
   extended tab corpus), a mixed-lead lazy marker (83,200 in the generator), and a quoted
   list item's de-indent (22,016).
2. e3684fb added a partial-laziness rule, a lazy-line stop, a per-line quoted-list
   de-indent and a code-opener refusal. /critique ran an independent generator against
   the renderer: 177 of 24,000 notes NEWLY spoke a destination (the de-indent ignored
   remark's whole-item minimum and counted a task checkbox; a quote-list-quote chain met
   the new laziness; an html half of the lazy stop took inline `<em>` for a block start).
3. 40302f6 removed those and kept an "old reading" for some openers. A second /critique
   BLOCKED it (score 45): that old reading still carried round 1's `BARE_LIST_MARKER`, so
   every opener routed to it reopened the tab-marker leak (192 of 3,520 cells per tab
   prefix, 384 for NBSP); its list-in-quote test missed list-quote-list openers (192 lost
   per prefix); and a space-then-tab opener escaped it (72 lost). The round's own census
   then found NBSP and lone-CR shapes on top.

The pattern is NRL-153's: base's answer on a tab-after-`>` line is right by ACCIDENT in
many shapes (the eaten tab stands in for a quoted list item's whole-item de-indent, for a
lazy line's uncapped interrupters and for a lone CR's line ending), so the whitespace
predicates must move together. NRL-114 owns the peel itself.

**Fixtures.** 44 rows in the NRL-38 table, every one but `>    *` (round 1's win) with the
fix's output EQUAL TO BASE. RED on 9522c11: 13 (the 8 Verify shapes; the two tab-after-`>`
opener shapes /critique 2 found leaking; two NBSP shapes where round 1 newly leaked and
that Verify's corpora never generated; and one quoted-list shape where round 1 was right
and base is not, given up and pinned as a residual). RED on base: 1 (`>    *`, round 1's
win). Reach of the rejected and ablation arms: e3684fb 23 rows, 40302f6 17, an arm testing
the term on the legacy peel (= 9522c11's reading) 13, an arm whose content peel strips all
whitespace after `>` 15, one that strips none 1, one with a `\s` lead 1, one with no
bare-marker term in the carry 1. Fourteen rows are RESIDUAL tripwires where the renderer
disagrees with base and the fix alike: eleven that a rejected draft (or 9522c11) closed
and this round gives up (`>\t-` image and link, `>\t===`, `>\t<div>`, a `>`+NBSP dash, a
tab code opener, a tab-opener continuation across `>\t=`, a partially lazy indented
line, a lazy mixed-lead marker, a quoted list item's de-indented marker, a quoted-list
five-space dash), and three that nothing closed, NRL-161's among them.

**Measurements**, against Obsidian 1.13.7's own `WT`/`GT` (app.js sha256
`8efbf581...9898`, SELFTEST OK), alt-aware (an image's rendered `alt` counts as spoken
text under `speakImageAlt`; the plain `visibleText` oracle scores alt text as hidden and
reports phantom leaks).

Base = `origin/main` `d496646` (this branch was rebased onto it during the round; every
row below was re-run after the rebase), fix = the shipped tree.

| corpus | cells | room on base (leak / loss) | newly leaking | newly lost | wrong arm reaches |
|---|---|---|---|---|---|
| Verify's `tabq.cjs` as shipped | 344,064 | 413,184 / 971,264 | **0** | **0** | 9522c11: 53,248 leak |
| `tabq` extended: 17 quote prefixes (`>`, `> `, `>\t`, `> \t`, `>  \t`, 2-5 spaces, `>\t\t`, nested, `>\t>\t`, indented, lazy closer, `- >`) x 17 middle lines x 3 kinds x 2 x CRLF, alt-aware | 1,775,616 | 1,899,520 / 5,947,904 | **0** | **0** | 9522c11 86,016 leak; the term on the legacy peel 86,016; a content peel stripping all whitespace 152,576 |
| `tabq` comment rows (`<!--`, `-->`, `%%`, ...) | 835,584 | 1,461,760 / 1,758,208 | **0** | **0** | none: no arm diverges, this corpus has no room for this change |
| Verify's `gen.cjs` extended to 21 container prefixes (11 new tab and space leads, `>\t` opener, `- >\t`, `> -` with `>\t  `), alt-aware, full 512 masks on every shape that diverges on 7 quick masks | 979,776 shapes, 29,844 diverging, 15,280,128 cells | 0 / 17,072,128 | **0** | **0** | 9522c11 and the legacy-peel arm 836,608 leak; all-whitespace peel 3,643,648 leak |
| exhaustive peel census: every prefix of length 5 or less over {space, tab, `>`, NBSP, CR} x 22 tails (85,932 lines) at budgets 1 and 2, as a middle and as a closer line of a quoted image and link label, wherever the legacy and the renderer's peel DIFFER (39,095 lines at budget 1, 42,838 at budget 2; 468,348 shapes), plus every prefix before four opener forms in three contexts | 8 quick masks per shape, 512 where any diverges | - | **0** (no shape's output differs from base at all) | **0** | the legacy-peel arm: 11,944 shapes diverge, 2,703,360 cells newly leaking |
| /critique 1's generator `gen3.cjs`, 12 seeds x 4,000 notes, alt-aware | 48,000 notes | - | **0** | **0** | e3684fb: 177 notes in 6 of these seeds |
| /critique 2's generator `gen4.cjs` (list>quote>list, tasks, `> 10.`, callouts, NBSP, CRLF), 6 seeds x 1,500 plus CRLF, `speakImageAlt: false` and `skipInlineCode: false` + `speakUrls` + `stripTags: false` runs | 18,000 notes | - | **0** | **0** | 40302f6 (its finding) |
| /critique 2's census `census4.cjs`: 13 opener prefixes x 4 pre-lines x 2 kinds x 8 quote leads x 11 middles x 5 closers | 45,760 | - | **0** | **0** | 40302f6: 192 to 384 per prefix |
| Verify's `fuzz2.cjs` carry fuzz, prefixes widened with 8 tab and space quote leads, 4 seeds x 4,000 notes x 6 masks, alt-aware | 96,000 | 68,834 / 525,753 | **0** | **0** | 9522c11 10 leak; all-whitespace peel 304 leak |
| Verify 1's `p3.cjs` | 42 shapes x 512 x 4 x 3 | - | **0** | **0** | - |
| round 1's `p4.cjs` carry corpus | 2,457,600 | 407,552 / 1,486,336 | **0** | **0** | (no tab shapes) |
| NRL-111 corpus `probe111.cjs` | 691,200 | 301,056 / 390,144 | **0** | **0** | - |
| NRL-119 bare corpus `bare119.cjs` | 622,080 | 294,912 / 86,016 | **0** | **0** | - |
| 17 must-not-widen controls | 8,704 | - | 0 moved | 0 moved | - |
| NRL-111 fuzz `fuzz119.cjs` | 16,000 | - | **0** | **0** | - |
| NRL-98's container-label templates (87) plus a tab twin of every quoted one (106), alt-aware | 197,632 | 167,168 / 772,480 | **0** | **0** | none: byte-identical on every arm |

**What this gives back against 9522c11, stated rather than buried.** On the census, against
9522c11 the fix newly LOSES 6,469,632 cells and closes 2,703,360 leaking ones. Every one of
the lost cells is a cell where base also loses (the census shows no shape where the fix
differs from base): round 1's term, reading the legacy peel's bare `*`, stopped carries
the renderer really does end there, right by accident - for example a partially lazy
`>\t*` under `> > A ![xx`, where the inner quote's `interruptBlockquote` ends at the
tab-led line, and a quoted list item's de-indented `*`. Keeping those would need the
partial-laziness and de-indent rules, which the drafts had and /critique showed wrong.
Against base the census moves nothing.

**`sourceIndex` lockstep** by numeric UTF-16 code-unit index over the extended tab corpus plus the round's fixture
inputs: base 5,421,056 chunks / 40,387,584 units, fix 5,433,344 / 40,944,640, 0 failures
on both. Mutators nonzero on both (fix: drop 4,909,824 length; shift 1,778,176 bounds +
3,655,168 identity; swap 4,643,072 monotonic + 4,542,208 identity; zero 5,429,760
identity; base 4,893,440; 1,778,176 + 3,642,880; 4,630,784 + 4,529,920; 5,417,472). The
equation exemption, keyed on the synthetic text, is mandatory on both (512 identity
failures without it). The space exemption reads 0 without it on this corpus, so this
corpus does not show it mandatory; round 1's does. No emit or `pushSpace` path changed:
the diff only decides whether a carry is confirmed.

**Residuals, all identical on base and pinned.** The fourteen above; `>\t* x` (a marker WITH
content) still speaks its destination through `LIST_BULLET`'s any-indent `^\s*`, filed as
NRL-161; and the consumption path still reads a tab after `>` as the optional space
(NRL-114 under NRL-153).

**NOT VERIFIED IN OBSIDIAN.** No deploy happened; every verdict above is the reading-view
parser and renderer executed in Node, and Live Preview has never been read. Rule 11
applies to every number. R-M08 is still NOT met and the `2 of 16` count does not move.

### CLOSED by NRL-136 (2026-10-01): a closed comment and a reopened one on an HTML-block line

**The defect, reproduced before any change** on `origin/main` `844b7f6` with the
real `extract.ts` bundled by the repo's esbuild and copied (not linked) into a scratch
arm, against Obsidian 1.13.7's own WT parser and GT renderer through the durable
harness (`app.js` sha256 `8efbf581...9898` re-derived from the installed asar with
`asar2.mjs`, `selftest.cjs` 6 ok, `oracle-selftest.cjs` 9 ok). All four of the
ticket's rows spoke text the renderer hides: `x` / blank / `<!-- y --> <!-- Q1Z` /
`TAIL` said `x <!-- Q1Z TAIL` where only `x` is shown, and the `$$` and setext rows
that NRL-120 had unmasked reproduced on `main` now that it is merged. Module 8776
opens an HTML block at the line-start `<!--`, ends it on the same line at its
`-->`, and passes the WHOLE line through raw, so the second, unclosed `<!--`
becomes a comment in the browser's parse of the rendered output. Its scope is the
document, not the paragraph, so neither existing term could see it.

**The first draft (PR #186, `d021898`) was blocked at Verify** for three new
disclosure classes, each reproduced here on that build before the rework: a `-->`
inside an inline `%%...%%` pair closed the browser comment and spoke the pair's
content (60 of 79 newly disclosing fuzz cells); a heading line inside a markdown
HTML block opened under the browser comment was read as a heading; and a fixed
"at most four spaces or one tab" rule for list-item content disclosed where the
renderer's real strip differs. Its fuzz also left 41 newly lost cells unexplained.
The rework is a rebase onto NRL-120 by hand rather than a cherry-pick (run 205531
decision Q0).

**Decisions.**

1. **A third term, decided by the caller.** `cleanLine` takes a 13th argument,
   `htmlContext`: `"block"` when the caller has established that the view is an
   HTML-block line, `"raw"` for the remainder of an HTML block's closing line,
   `"inline"` for what follows a browser comment's `-->` on an ordinary line, and
   `"none"` otherwise. A later unclosed `<!--` in a `"block"` or `"raw"` view opens a
   browser comment (`Cleaned.openCommentBrowser`); a first `<!--` that starts the
   block opens our own block comment as before (`openCommentBlock`). `opensHtmlBlock`,
   `opensObsidianBlock`, `endsTerm2Scan`, `endsTerm2Block`, `labelClose`,
   `opensMathBlock`, `isSetextContentLine`, `rawHtmlBlockEnd` and `containerPrefix`
   are byte-identical to `844b7f6` (sha256 of each top-level body).
2. **Setext wins (run 205531 plan decision).** A line that is setext heading content
   never gets `"block"`. NRL-120's own refusal (`setextContent`) is unchanged and is
   not widened; the block term additionally refuses a line over an `=` underline,
   lazy or not, and over a `-` underline outside any list (`setextLike`). Measured:
   `> <!-- y --> <!-- S2Z` / `===` renders an `<h1>` showing `<!-- S2Z`.
3. **`opensHiddenComment` pairs in sequence (plan decision).** When the first comment
   on the line closes, a trailing unclosed opener is asked the block question, so
   `Para` / `<!-- y --> <!-- Q` ends the paragraph for the code-span and label
   lookaheads. The setext refusal stays out of it, for NRL-120's reason.
4. **Q1, reversing run 180051's decision 1.** The first draft left a `-->` inside an
   inline `%%` pair unmodelled and pinned it as a residual. It is now modelled
   (`browserCloserAt`): on the same line, non-greedy as `/^%%(.*?)%%/`, after backtick
   code spans (a `-->` in code closes), backslash escapes and complete inline HTML
   comments (module 4839's `.T` binds first, so `<!-- %%x --> S%% B` closes at that
   comment and shows S). It does not apply on a fence or literal line, a raw HTML
   line, or an ATX or setext heading line. An inline `<!--` left open on an earlier
   line of the same paragraph, with its `-->` later in the paragraph, suppresses
   pairing until that `-->` (`browserInline`): the pair is comment text there.
5. **Headings close inside `data-heading`, and the rest of the line is spoken.** The
   plan kept the first draft's "read the heading whole" and pinned the attribute's
   rest as a residual (`# A %%x --> S%% B` lost S). **Deviation:** the rest of the raw
   line after the `-->` is now spoken as its own chunk, then the heading, which is
   what the reader sees (`S%% B">A B`); a `<!--` in that rest opens a comment that
   runs to the heading text's own first `-->`, after which the heading text is shown
   inline. Setext content lines take the same path.
6. **Q2 and Q3 became one parse, `containerViews`.** The plan described a separate Q2
   state and a list-only `listStrip` pass. Both are now read off one recursive parse
   of quote runs and list items (module 6234's lazy-line rule with its interrupters;
   module 745's item collection, bullet pad and its interrupters including the app's
   comment tokenizer, spaces-only lead and no further `%`; module 5540's strip through
   6058's stops), which also marks literal lines (fences by character and length,
   display math by its closing `$` run, frontmatter) and markdown HTML-block lines
   (comment and types 1 to 6, with setext precedence), each scoped to its container
   by recursion. Under a browser comment an HTML-block line is raw: its `-->` closes
   with a raw remainder, nothing else on it is markdown. A separate Q2 state was built
   first and became redundant with this, **0 differing outputs over 50,725 notes x 2
   option sets**, so it was removed. Fences and `%%` blocks opened under the browser
   comment end with their container (`blockHome`, `browserBlockHolds`).
7. **The lead test depends on the paragraph above.** `htmlBlockLine(view, listStrip,
   paraOpen)`: at most three spaces and no tab when a paragraph is open (module 8607),
   anything but a leading four spaces or tab on a fresh block (module 134 claims only
   those). A line with no `>` after a quote line is a fresh block here, because `html`
   is in `interruptBlockquote`. A callout marker counts only on its quote's first
   line; on a later line `[!note]` is text.
8. **`<!-->` and `<!--->` end the markdown block on their own line**, 8776's end test
   matching the opener's own `-->`, so what they leave open is a browser comment.

**Reconciliation.** All 29 first-draft rows are ported; three expectations moved on
purpose, each against rendered HTML: `pin-nrl136-heading-closer` now `line Head -->
line TAIL` (decision 5), the residual `%%`-pair row became
`pin-nrl136-q1-heading-attribute-rest` and core rows, and the list five-space residual
is now core (`pin-nrl136-q3-list-five-space-content`, `item`). NRL-120's four rows that
named NRL-136 were replaced in place with names kept: `pin-nrl120-unmasked-same-line-reopen`
`<!-- SECRETH`, `guard-nrl120-same-line-reopen-on-base` `SEEN`,
`pin-nrl120-unmasked-reopen-by-math-stop` and `guard-nrl120-reopen-blank-stop-on-base`
`t.`. The NRL-137 rows did not move. Tests: 68 NRL-136 rows; **40 core rows red on
`844b7f6` and green after**, plus the four reconciled NRL-120 rows; 27 guards green on
both sides; one tripwire (`pin-nrl136-residual-div-opener`, NRL-137).

**Censuses**, oracle-keyed per cell via `oracle111.rendererHides` at the cell's own
sentinel, two option sets (test defaults; everything spoken), loss judged on the
second only, fix against `844b7f6`:

| corpus | cells | base disc | fix disc | new disc | new loss | fixed disc / loss | wrong arm |
|---|---|---|---|---|---|---|---|
| Q1 (`%%` placement x line kind x position, setext twins) | 8,792 | 1,728 | 0 | 0 | 0 | 1,728 / 30 | no skip: 576 disclosed vs fix; skip everywhere: 144 lost |
| Q2 (opener container x closer kind x container exit) | 20,640 | 5,456 | 0 | 0 | 0 | 5,456 / 92 | no raw lines: 648 disclosed, 288 lost |
| Q3 (marker x lead x sibling x first comment x shape) | 75,582 | 12,768 | 0 | 0 | 0 | 12,768 / 2,097 | no strip: 7,416 disclosed; first-draft rule: 4,986; any lead: 5,781 lost vs base |
| port (22 positions x 9 variants x 10 indents x 18 followers) | 323,460 | 37,664 | 8,901 | 0 | 0 | 28,763 / 888 | no third term: 29,643 disclosed vs fix |

The port census's followers include `===`, `---`, `$$`, a `%%` pair, a Q2 block and
code-span and label carries (destination sentinel `zdestz`), so the narrowed
`codeSpanClosesLater` and `bracketClosesLater` are covered. Its 8,901 residual
disclosures are all on base too (0 new).

**Fuzz**, `fuzz2.cjs`, seeds 90210, 424242, 1234567 (the first draft's) and 777001,
31337, 2718281, 16180339, 4,000 notes x 2 option sets each, 338,716 cells: **21
newly disclosing**, every one reproducing on base once the reopen is defused (19:
replaced by a plain opener, removed, or its line blanked) or with its own line alone
after a paragraph (2, NRL-137's `<div>`); **49 newly lost**, every one reproducing on
base defused (32) or attributed to a pre-existing misread proven by a named control
that loses on base at the same construct (17): math in a list item read as markdown
(N1, N7), a callout title `%%` (N3, N4), `%%` inside list-item indented code (N8), and
term 2 crossing a `%%` comment line, its stop set lacking one (N10), plus 4 where the
sentinel's own line with a `%%` or `<!--` opener already loses on base. 21,676
disclosures and 459 losses closed. Default-options losses: 527, of which 481 are
`skipCodeBlocks`/`skipInlineCode` excluding code the base misread as prose and 46 are
the all-options losses above. Every newly changed cell was attributed by ablation (a
rebuild with exactly one of: the third term, Q1, the raw-line model, the list strip,
the raw remainder, the literal/fence/`%%` model, disabled). **The first draft's 41
unexplained loss cells**, classified individually: all 41 are spoken by this fix.

**`sourceIndex`** checked by numeric UTF-16 code unit over every census note x 2
option sets (50,128 notes): `844b7f6` 198,154 chunks / 1,658,186 units and the fix
178,534 / 1,348,380, both clean; drop-one, shift-all, swap-two and negate-one each
fire on both arms. 0 lockstep failures in any fuzz seed.

**Residuals, named and not closed.** (a) NRL-137's raw HTML blocks spoken as prose
(`<div> <!-- Q1Z`), pinned. (b) Term 2 crossing a `%%` comment line (N10): a
pre-existing gap in the term-2 stop set, which this ticket deliberately leaves
byte-identical. (c) Math and fences inside list items, callout titles and `%%` inside
item code are read by the per-line loop as it always has; where NRL-136's new
behaviour meets them, the controls above show base mishandles the same construct.
(d) `<!-->` follows oracle111, which treats it as an opener; a browser treats it as an
empty comment, and nothing here was read in one. (e) The model is container-aware but
approximate (callout titles, nested quote laziness, tab stops beyond those measured).
**Reading view only. NOT VERIFIED IN OBSIDIAN**: no deploy, no running app, Live
Preview never read; rule 11 applies to every number here. R-M08 is still NOT met and
the `2 of 16` count does not move.

**Ship addendum (2026-10-01): rebased onto NRL-131, four more fixes.** The numbers
above were measured against `844b7f6`. Ship rebased onto `2c4e2ca`, which carries
NRL-131's peel of a quote nested in a list item (ADR 0035, `containerPrefix` now peels
`- > `, `- - > ` and their alternations), and re-measured against that base. The four
censuses above came out cell-for-cell identical (0 newly disclosing, 0 newly lost), and
a fifth, the port census plus ten nested-container positions (`- > `, `- - > `,
`> - > `, `- > - > `, a nested continuation and lazy line, `- - `, a nested callout,
`-    > ` and `-     > `), 56,700 notes / 439,740 cells, also 0 and 0. A fuzz with
nested-container leads added (`fuzz3.cjs`, same seven seeds, 338,716 cells) then found
four defects in this ticket's own model, all fixed with a core row red on the pre-Ship
tree and green after:

- A `%%` led by spaces then a tab is paragraph text (the app's comment tokenizer skips
  spaces only), but `containerViews` took it for a `%%` block, swallowed the list under
  it and left a reopening line unstripped. `  \t%% Z0Q` / `1. <!-- a --> x <!-- Z6Q` /
  `    <!-- y --> <!-- Z7Q` newly spoke `<!-- Z7Q` against `2c4e2ca`. Present before the
  rebase too; the earlier fuzz's leads did not reach it.
- A lazy `=` under a quoted line underlines it only while it stays in the quote run; an
  exact underline after it ends the quote there (NRL-120's run break) and makes `=` the
  content of its own heading. `setextLike` and `browserSetextText` now ask whether the
  next line left the quote. `<!-- y --> <!-- Z0Q` / `> A Z1Q --> Z2Q B` / `=` / `===`
  newly spoke Z1Q; `> <!-- y --> <!-- S2Z` / `=` / `===` / `S3Z`, spoken by base too,
  is now hidden.
- A `%%` straight after a callout marker is title text, not a block, so under a browser
  comment the next line's `-->` still closes it. NRL-131's peel of `- > [!note]` is what
  brought the nested form into the fuzz's reach.
- A heading as a list item's content (`- # Z2Q`) leaves no paragraph open, so a
  six-space line under it is indented code and its `-->` closes, `%%` pair and all; and
  a line that left a quote run starts a block, so over an exact underline it is setext
  content. Both were prose loss in the pre-Ship tree.

After those, the same fuzz: **14 newly disclosing**, 8 reproducing on base defused and 6
in two notes holding a `<div> <!--` line, which `2c4e2ca` speaks with the line alone
(NRL-137); **15 newly lost**, 13 reproducing on base defused and 2 in one note where
term 2 crosses a `%%` comment line (N10 above, whose control still loses on `2c4e2ca`);
23,901 disclosures and 430 losses closed; 0 `sourceIndex` failures on either arm. The
censuses after the fixes: Q1-Q3 unchanged, the port census's closed disclosures rose
28,763 -> 29,303, the nested census 41,513, each still 0 new in both directions.
Measured with the same harness (app.js sha256 `8efbf581...`), reading view only; NOT
VERIFIED IN OBSIDIAN.

### CLOSED by NRL-156/NRL-132 (2026-10-03): `FENCE` accepted any indent, in both directions

**The defect, reproduced before any change** on `origin/main` `01a2caa`, bundling the
real `extract.ts`: `const FENCE = /^\s*(\`\`\`|~~~)/;` tested a fence opener and closer
against ANY leading whitespace, where the renderer caps both at the same rule every
other interrupter in this file already honours (`HEADING`/`BLOCKQUOTE`/`HR`'s `{0,3}`).
Disclosure direction (NRL-156): `"Intro.\n    \`\`\`\n \t<!--\n===\nHIDDENA\n-->\nTail."`,
default options - a four-space-led \`\`\` after an open paragraph is module 8607's lazy
continuation, not a fence, so Obsidian shows `Intro. \`\`\` Tail.` with HIDDENA hidden
inside the `<!--...-->` block the renderer opens on the line beneath it; we spoke
`"Intro. <!-- === HIDDENA --> Tail."`, disclosing HIDDENA. Prose-loss direction
(NRL-132, folded into this ticket's census and fix per the owner's 2026-10-02 review -
NRL-132's own branch had no commits): three repro notes with a 4-space, 6-space and
8-space-in-a-list-item lead before a never-closed \`\`\`, all of which we read as a fence
opener with no closer, so everything after it - VISIBLE1/VISIBLE2, the repro's own
sentinels - was swallowed to end of document/container. All four reproduced unchanged
on `01a2caa` before any edit.

**Ground truth already existed and was reused, not re-derived.** `containerViews`
(NRL-136's model) already computed a renderer-faithful fence-opener test for its own
per-container fence tracking: a lead that passes `wasOpen ? /^ {0,3}$/.test(lead) :
!/^(?: {4}|\t)/.test(lead)` gates whether a `` ` `` or `~` run at that lead opens a
fence. That expression is now the named predicate `fenceOpensAt(lead, wasOpen)`,
extracted verbatim (same two branches, same two regexes) rather than rewritten, and
`containerViews` itself now calls it instead of its own inline copy. `wasOpen` is "a
paragraph left open at this point by the line before": `containerViews`' own signal at
its level, `wasPara`/`prevPara` at the document's top level (the main per-line loop),
and `paraLinesAbove > 0` for term 2's forward scan (`endsTerm2Block`) - the same meaning,
read from three different places that already tracked it for other reasons.

**Deliberately NOT a single capped constant.** The fresh-block branch
(`!/^(?: {4}|\t)/.test(lead)`) admits a lead `MODULE134_INDENTED_CODE` would reject if it
were tab-stop-aware - a single space then a tab still opens a FRESH-BLOCK fence, because
module 134 is literal rather than tab-stop-expanding (NRL-113). Measured directly against
the executed Obsidian 1.13.7 parser/renderer: `"\n \t\`\`\`\ncode1\n\`\`\`\nAfter."` (fresh
block, document start) renders one `<pre><code>code1\n</code></pre>` - the space-then-tab
lead DOES open a fence there - while the identical lead after an open paragraph
(`"Before x.\n \t\`\`\`\nmiddle\nAfter."`) does not: one `<p>` showing the literal \`\`\`.
A blind `{0,3}`-style narrowing of the fresh-block branch would have wrongly rejected the
first case.

**Three call sites change, two are proven no-ops** (not six/three as the Start-phase
plan enumerated 1:1 - the plan's own site `f`, the `htmlParaOpen` loop, is measured below
to be reachable-in-principle but a verified NO-OP over this ticket's whole position
census, since `containerViews` already marks every fence line's `literalAt`/`htmlLineAt`
before that loop's own FENCE check is ever reached; it is fixed anyway, consistently with
the model it mirrors, costing nothing measured):

1. **`containerViews`'s own fence detection** (NRL-136's model) - extraction only, see above.
2. **`endsTerm2Block`** - `FENCE.test(line)` gated on `fenceOpensAt(lead, paraLinesAbove > 0)`.
3. **The main per-line loop's fence toggle** - split into an OPEN test (gated `!inFence`,
   `fenceOpensAt(lead, wasPara) && FENCE.test(raw)`) and a CLOSE test (gated `inFence`,
   the EXISTING `BLOCK_END_FENCE` constant - `/^ {0,3}(?:\`{3,}|~{3,})/` - unconditionally,
   because a closer never depends on an outer open paragraph). `BLOCK_END_FENCE` already
   existed (NRL-155) for an unrelated predecessor-line question and is reused rather than
   duplicated; it does no char/length pairing with the opener, which is deliberately NOT
   added here (a pre-existing, out-of-scope simplification NRL-132's own AC names and
   declines to fix).
4. **The `htmlParaOpen` loop's fence toggle** (plan site `f`) - both `FENCE.test(view)`
   occurrences gated the same way, threading the loop's own already-computed `wasOpen`
   local through `fenceOpensAt`. Measured NO-OP: reverting just this one site and
   re-running the full 576-cell position census below produces a byte-for-byte identical
   JSON output, confirming `literalAt[k] || htmlLineAt[k]` (containerViews' own answer,
   computed earlier in the same function) already short-circuits this loop's FENCE check
   for every cell. Kept anyway for consistency with the model it mirrors; it is a genuine
   backstop for whatever `containerViews` does not reach (`RL_MAX_DEPTH`), just unexercised
   by this corpus.

**Two sites are genuine no-ops, confirmed by their own guard conditions, not re-derived
by differential**: the `listItemContent`/`listDedented` run-end test and the main-loop
list-end test each only reach `FENCE.test()` after a preceding `!/^\s/.test(raw)` (or
equivalent `!indented`) guard already established the line's lead is empty - the
`{0,3}` cap and the unconditional any-indent test agree by construction at lead `""`.
Left untouched.

**`interruptsParagraphExceptBareMarker` is narrowed, not widened.** Every call in this
family (`codeSpanClosesLater`, `bracketClosesLater`) asks about a line that, if it does
not interrupt, continues a paragraph the OPENER line already left open - `wasOpen` is
always `true` there - so the term collapses to a fixed cap: `FENCE_CONTINUATION =
/^ {0,3}(\`\`\`|~~~)/`, matching HEADING/BLOCKQUOTE/HR's existing `{0,3}` caps in the
same function (only FENCE and LIST_BULLET lacked one; LIST_BULLET is NRL-109's, untouched).
Confirmed NOT a widening of ADR 0019's F5 guard: that guard's own enumeration
(`tests/extract.test.ts`'s `HEADING`/`BLOCKQUOTE`/`LIST_BULLET`/`TABLE_ROW` loop) does not
name FENCE at all, and the full `npm test` run after this change leaves the F5 guard
block and all of NRL-64's own fixtures green (`fence-interrupt` and
`opening-line-is-heading`/`-quote`/`-list` cases are all zero-indent, so the cap never
fires on them; see below for the subsumption claim this rests on).

**`interruptsParagraph`, `codeSpanClosesLater`, `labelClose`, `opensMathBlock`,
`opensObsidianBlock`, `opensHtmlBlock`, `inlineContainerClose`, `wikiTargetClose` and
`peelQuotes` are unchanged** - `npm test`'s full suite (24 suites, 6,699 checks) passes
unmodified, including every NRL-64 fixture (`guard-nrl64-*`) and ADR 0019's own F5 guard
block, none of which were edited.

**`NRL-151` is explicitly out of scope and was checked, not assumed, to be untouched.**
NRL-151 records that the main-loop opener tests `raw` rather than a container-peeled
body, so a QUOTED fence is never recognised at all; this ticket's plan said to leave that
mechanism alone and not change which string any site tests. It was not touched: the main
loop's `fenceLead` and `FENCE.test(raw)` both still read `raw` verbatim, only the GATING
boolean changed. The position census below independently surfaces the SAME mechanism in
LIST items too (not only quotes, as NRL-151's own title names): 10 of 576 cells, all with
a tab in a list-item fence lead, are wrong IDENTICALLY on base and on this fix (both
speak only the item's opening line, where the renderer shows the fence line literally)
- 0 newly regressed, 0 newly fixed, confirming this specific defect predates and is
unaffected by this change. Left for NRL-151, as instructed.

**Two additional raw FENCE.test() call sites exist that neither this ticket's plan nor
its "six call sites" count named**: inside `containerViews`'s own quote-run detection
(deciding whether a non-quote-marked line continues or ends a blockquote run) and its
list-run detection (the analogous question for a list item's lazy continuation). Reading
each: the quote-run site is only ever reached at a lead of 0-3 spaces, because an
EARLIER arm of the same `||` chain (`/^(?: {4}|\t)/.test(u)`) already breaks the run for
any 4-space-or-tab lead, so FENCE's own any-indent reach is moot there - a fence-shaped
line always interrupts a blockquote at 0-3 spaces or less regardless of `wasOpen`,
matching HEADING/HR in the same chain. The list-run site is reached at `indent <= 4`
(wider than the quote site), and was NOT differentially tested against a capped
alternative - it is left as found, because the plan did not name it and no measured
cell in the position census below attributes a wrong output to it. Recorded here as an
HONEST GAP in this ticket's own coverage rather than silently matched to the plan's
"six sites, three fixed three no-op" framing, which undercounted by two.

**Position census**, all 576 cells graded against the real Obsidian 1.13.7
parser/renderer (`oracle111.cjs`/`parser.cjs`/`render.cjs`, `app.js` sha256
`8efbf581...9898`, `selftest.cjs` 6 ok), base = `01a2caa` (pre-fix, copied not linked),
fix = this tree: 12 positions (after an open paragraph; fresh block at document start,
after a blank line, after a heading, after an HR, after a fence-close; inside a quote
after a quoted paragraph and fresh-in-quote; inside a list item after item-content and
fresh-in-item; nested list-in-quote and quote-in-list) x 12 leads (0-6 spaces, a bare
tab, space-then-tab x1-3, tab-then-space) x 2 content kinds (a plain VISIBLE1 sentinel;
a `<!--HIDDEN1-->` sentinel) x 2 option masks (`skipCodeBlocks` true/false) = 576 cells.
Each fence marker is SINGLE, with no closer anywhere in the note (matching both repro
shapes exactly), which is load-bearing: an earlier revision of this same census used a
symmetric closer at the matching lead and reported 37 false "regressions", all of which
were CommonMark correctly re-pairing the two markers as an INLINE code span (governed by
`skipInlineCode`, a different, untested axis) rather than a block fence - a genuine
renderer construct, not a defect, discovered only by cross-checking the raw HTML. The
grading oracle for the prose-loss axis was likewise corrected to classify a sentinel
genuinely inside a real `<pre><code>`/`<code>` element as CODE (correctly excludable
under `skipCodeBlocks: true`) rather than lost prose, which an earlier pass over this
census conflated (reporting 54 false residuals before the correction, 10 real ones
after).

| axis | newly fixed | newly regressed | unchanged-correct | unchanged-still-wrong |
|---|---|---|---|---|
| disclosure (`HIDDEN1`) | 31 | 0 | 252 | 5 |
| prose-loss (`VISIBLE1`/`Tail.`) | 31 | 0 | 252 | 5 |

0 `sourceIndex` lockstep failures on either arm, checked numerically by UTF-16 code-unit
index (length, bounds, identity, monotonicity) over all 576 cells on both arms. All 10
`unchanged-still-wrong` cells (5 per axis, since the disclosure and loss rows of the same
cell move together) are the NRL-151-adjacent list-item-plus-tab shape named above,
identical on base and fix. The closer-cap edge case (NRL-132's own AC: "a 4-space-led
\`\`\` inside an already-open, zero-indent fence is content, not a closer") was checked
separately against the real renderer rather than folded into the 576-cell grid, because a
symmetric closer at the SAME lead as the opener reopens the inline-code-span ambiguity
above: `"Before.\n\`\`\`\ncode1\n    \`\`\`\ncode2\n\`\`\`\nAfter."` renders
`<pre><code>code1\n    \`\`\`\ncode2\n</code></pre>` - the 4-space-led line stays CODE
content, confirmed matching this fix's own output (`"Before. code1 \`\`\` code2 After."`
under `skipCodeBlocks: false`).

**Fuzz/mutator evidence for the `sourceIndex` checker's own soundness**: four mutators
(drop-one-entry, shift-all-by-one, swap-two-entries, negate-one), each shown to FAIL the
checker on a real fixture from this ticket's own corpus before confirming the checker
passes on the real, unmutated output - `tests/extract.test.ts`'s new block, not a
one-off script.

**Residuals, named rather than silently left.** (a) NRL-151's mechanism, in BOTH quote
and list-item contexts (the latter not named in NRL-151's own title), 10 of 576 census
cells, unaffected by this fix in either direction. (b) The two un-enumerated
`containerViews`-internal FENCE.test() sites (quote-run and list-run detection), neither
differentially tested against a capped alternative; the quote-run site is reasoned (not
measured) to already be equivalent in practice because an earlier OR-branch already caps
its reachable lead at 0-3 spaces, and the list-run site (reachable at `indent <= 4`) is
an open question this ticket does not resolve. (c) Fence character/length pairing (a
`\`\`\`` opener closed by a `~~~` run) remains unchecked everywhere, per NRL-132's own
AC, which asks only for the indent cap. (d) The `htmlParaOpen` loop fix (site f above) is
unexercised by this corpus; it is a provable no-op here, not a provable fix.

**NOT VERIFIED IN OBSIDIAN.** No deploy and no CDP session happened for this ticket; the
renderer side is Obsidian 1.13.7's own reading-view parser and renderer executed in Node
out of the installed asar (stronger than a transcription, still not the application).
Live Preview was not examined. R-M08 is still NOT met and the `2 of 16` MUST headline
count does not move: this closes two named leftovers (NRL-156's disclosure, NRL-132's
prose loss), not the requirement, and NRL-151 plus the two un-enumerated containerViews
sites above stay open against the same requirement.

**SHIP REVIEW MEASURED BOTH un-enumerated `containerViews` sites rather than accepting
residual (b) above as a closed question.** The implement phase's own honesty - "reasoned
(not measured)" for the quote-run site, "an open question this ticket does not resolve"
for the list-run site - is the right call to flag, and ship review resolves both with the
real Obsidian 1.13.7 parser/renderer and the real bundled extractor, not by reading.

*Quote-run site* (`if (u.trim() === "" || /^(?: {4}|\t)/.test(u) || FENCE.test(u) || ...)
break;`, inside the `>`-prefixed run collection): the structural argument is a genuine
proof, not a hunch, and it is now ALSO measured. Base (`01a2caa`, pre-fix) and this tree
produce **byte-identical spoken text and `sourceIndex`** over a 24-cell corpus (12 leads
from `""` through `"    \t"` x 2 shapes: a fence-shaped interrupt line followed by a
`<!--HIDDEN-->` block, and the same line followed by plain `VISIBLE1`/`VISIBLE2`
sentinels inside a quote). Separately checked against the real renderer: 0 disclosures,
0 prose loss across all 24 cells. One cell is worth naming because it looked wrong before
being checked against the renderer rather than against expectation: a one-space-led fence
inside a quote, after the quote ends, opens a genuine fresh TOP-LEVEL fence with no
closer, so a trailing `<!--HIDDEN-->` becomes literal FENCE CONTENT and is correctly
spoken, exactly matching `GT(WT(...))`'s own `<pre><code>&#x3C;!--\nHIDDENX\n-->\n...`
output - not a leak, the designed-literal class ADR 0019 already names.

*List-run site* (`if (prevBlank || HEADING.test(v) || FENCE.test(v) || HR.test(v) || ...)
break;`, inside the list-item membership loop): measured, not reasoned, because unlike
the quote-run site there is no equivalent OR-short-circuit proof available (`indent <=
4` admits a bare tab, which the continuation cap and the fresh-block cap both reject, so
no single prior term caps it the way `/^(?: {4}|\t)/.test(u)` does for quotes). Base vs.
this tree, 252 cells (markers `-`, `1.`, `12.`, `123.`, `1234.`, `12345.` x 14 leads
(`""` through two-tab and tab-then-space forms) x 3 shapes: a hidden `<!--...-->` right
after the fence-shaped candidate line, plain `VISIBLE1`/`VISIBLE2` prose after it, and the
same nested inside a blockquote): **0 of 252 cells differ**, in spoken text or
`sourceIndex`, between base and this tree. Leaving this site exactly as the implement
phase left it is therefore a measured no-op for this diff, not an assumed one.

**One genuine, PRE-EXISTING disclosure was found while probing this site, and it is named
rather than silently folded into the "0 differ" count above.** `- A` / `  \t\`\`\`` /
`  \t<!--` / `HIDDENX` / `-->` / `AFTERX` (bullet marker, a 2-or-3-space-then-tab lead)
speaks `"A <!-- HIDDENX --> AFTERX"` on **both base and this tree, byte-identical**, where
the renderer hides `HIDDENX` inside a genuine comment. Traced, not merely observed to
match: with `indent >= contentIndent` for a narrow bullet, this line never reaches the
list-run FENCE check being audited here at all (it takes the earlier `cur.push` branch
unconditionally); the disclosure is instead a property of the item's uniform minimum-
indent dedent (`p` in the list-item content loop) cutting a shared amount off every line
in the item, which leaves a bare tab at the front of the dedented `<!--` line, and
`containerViews`' OWN (unchanged, already-fixed-before-this-ticket, byte-identical on
base and fix) fence/comment-eligibility test at that nested recursion level - the
`fenceOpensAt` call this ticket extracted from inline code, not the FENCE.test() sites
under audit - declines to treat a tab-led lead as eligible for either a fence OR a
browser-comment opener once it is judged a paragraph continuation (`wasOpen: true`),
regardless of which parallel dedent pipeline produced that tab. Confirmed independent of
the fence shape specifically: replacing the `` ``` `` line with a heading, with ordinary
prose at the identical lead, or removing it outright, closes the disclosure (each speaks
only the expected sentinels); the fence shape is what reproduces it, but the ROOT is the
dedent/eligibility interaction, not either of the two audited FENCE.test() sites. **This
is out of scope for NRL-156**: it is identical on base (not introduced or widened by this
diff), and fixing it would mean reconciling container-item dedent with paragraph-
continuation eligibility inside nested list content, a different mechanism from the fence
indent cap this ticket is about. Recorded here rather than filed, in the tradition of
this file's other named-but-unticketed residuals (root 3, root 5, the `heading-tracking`
`%%` divergence); revisit if a second independent report of the same shape surfaces.

**NOTHING WAS OBSERVED IN OBSIDIAN for this amendment either.** Both censuses are bare
Node, bundling the real `src/text/extract.ts` from this tree and from `01a2caa` with the
repo's own esbuild, graded against Obsidian 1.13.7's reading-view parser and renderer
executed out of the installed asar (`app.js` sha256 `8efbf581...9898`). Live Preview was
not examined. R-M08 and the `2 of 16` MUST headline count are unaffected: this amendment
closes residual (b) above with measurement rather than reasoning, it does not close a new
requirement, and the pre-existing disclosure it surfaces is named, not fixed, here.

### CLOSED by NRL-158 (2026-10-03): a whitespace-only line holding a tab is not blank while a paragraph is open

**The defect, reproduced before any change** on `origin/main` `8d2b3f2`, bundling the
real `extract.ts`: `"Intro.\n\t\n\t<!--\n===\nHIDDENA\n--> t."`, this file's own default
options, spoke `"Intro. === HIDDENA --> t."` (under the test suite's `skipCodeBlocks:
true`; with `{}` it spoke the `<!--` literally too). Obsidian renders the whole note as
ONE paragraph - `<p>Intro.<br>\n<br>\n<!--\n===\nHIDDENA\n--> t.</p>` - because module
8607 absorbs the whitespace-only `\t` line as a lazy continuation rather than the blank
line that would end the paragraph, so the inline `<!--...-->` comment stays scoped to
that one continuing paragraph and hides `===`/`HIDDENA`/`-->` inside it, leaving only
`Intro. t.` visible. This is pre-existing and identical on NRL-155's own fix (`faf55a3`):
NRL-155 narrowed a DIFFERENT, SPACES-ONLY block-position gate
(`inSetextBlockPosition`/`:3243`) for an unrelated question (whether the line ABOVE a
tab-led `<!--` sits in block-end position) and deliberately left this ticket's question -
is a tab-bearing whitespace line itself blank - open, pinning it as the tripwire
`pin-nrl155-tab-whitespace-line-is-not-blank`. That pin's own fixture happens to use a
LEADING-SPACE lead on both the blank line and the `<!--` line (`" \t \n \t<!--"`), which
is why it already passed before this ticket: `INDENTED_CODE` (`/^(?: {4}|\t)/`) does not
match a space-led line, so the second-stage misfire this ticket closes was never
reachable from that one fixture.

**Harness census run FIRST, per the AC**, against Obsidian 1.13.7's real parser and
renderer (`WT`/`GT`, `~/.local/share/note-reader-local/obsidian-parser-harness`, `app.js`
sha256 `8efbf581...9898`, `selftest.cjs` 6 ok): a SPACES-ONLY whitespace line always ends
an open paragraph, exactly like any other blank line. A whitespace line holding a TAB
anywhere in its run - bare, tab-then-space, space-then-tab at one to four leading spaces,
two tabs, or CR-terminated - while a paragraph is open before it, is swallowed as a lazy
continuation instead, never the blank line that would end it; leading-space count before
the tab does not matter, only "contains a tab" does. The identical tab-bearing line, with
NO paragraph open before it (document start, right after a heading/HR/fence-close, or
right after a REAL blank line), is ordinary blank - the rule is conditional on "is a
paragraph currently open", not a property of the line alone. Containers are a GENUINELY
DIFFERENT, more complex rule, not the same predicate with a container flag: a quote line
carrying its OWN `>` marker interacts with the renderer's setext/HTML block precedence in
ways the top-level rule does not (measured below), and a bare line with no marker at all
ends the quote or list regardless of a tab (module 6234's own lazy/blank test, independent
of module 8607's). Scoped out, per the plan, exactly as NRL-155 scoped the same axis out
of its own gate.

**Root cause: THREE sites independently test "is this line blank" with no reference to
whether a paragraph is open, and a FOURTH already has the right rule, inline and
un-shared.** `walkLeadFrame`'s "para" state (then `extract.ts:4497-4504`, now unmoved) already
read `if (blank && !view.includes("\t")) { state = "fresh"; ... }` - exactly the fact the
harness re-confirmed above, encoded once for NRL-115's own lead walk and never promoted.
The three wrong sites, all unconditional `trim() === ""`: the `htmlParaOpen` precompute
loop's own blank test (then `:5556`); the main per-line loop's `blank`/`wasBlank`
computation (then `:6227`), which feeds the list-end check and the indented-code-open
guard; and the paragraph-flush test (then `:6386`), the one that directly flushes
`"Intro."` on the blank line in the repro. Traced with throwaway instrumentation before
any fix: the flush at the third site sets `prevBlank = true` for the blank line (via the
unconditional test at the second site, read before the reorder below), which then wrongly
satisfies `!blank && !inList && wasBlank && INDENTED_CODE.test(raw)` for the following
`"\t<!--"` line - `INDENTED_CODE` (`/^(?: {4}|\t)/`) matches a bare tab lead - opening it
as a FRESH indented-code block that is never closed and crosses no `-->`. Both stages had
to move together or the repro's own bare-tab shape still failed with only one fixed
(confirmed directly: a scratch build with site 2 fixed alone already happens to speak the
repro's right TEXT, "Intro. t.", but as two separate flushed chunks rather than Obsidian's
one continuing paragraph - the right string for the wrong structural reason, and wrong
`sourceIndex`/chunk-boundary shape; see the census note on chunk structure below).

**The fix is one named predicate, styled after `fenceOpensAt` (NRL-156) and citing
`walkLeadFrame`'s already-correct inline test as the fact it promotes rather than
invents**: `blankEndsParagraph(line, paragraphOpen)` returns `line.trim() === "" &&
(!paragraphOpen || !line.includes("\t"))`. Applied at the three sites:

1. `htmlParaOpen` precompute loop - `view.trim() === ""` becomes
   `blankEndsParagraph(view, wasOpen)` in its `||` chain. No other change: when it
   returns `false` (tab-bearing, paragraph open), every other disjunct in the same `if`
   also fails on whitespace content, so control falls through to `open = true` at the
   loop's end - the continuation this predicate names.
2. The main loop's `blank`/`wasBlank` computation - reordered so `wasPara` (`prevPara`,
   already declared the same line) is read BEFORE `blank`, then `const blank =
   blankEndsParagraph(raw, wasPara);`. This alone closes the indented-code-open misfire
   traced above, for the FOLLOWING line.
3. The paragraph-flush test - when `body.trim() === ""` but
   `blankEndsParagraph(body, wasPara)` is `false`, the line is swallowed with no append
   (`prevPara = true; continue;`) instead of flushing. **One addition beyond the plan's
   literal text, kept for a reason measured rather than assumed**: this branch is
   additionally gated on the CURRENT line's own `blockType === "paragraph"`. The plan's
   own claim - "`wasPara` is never true for a container line, so this is a byte-identical
   no-op for every quote/list line" - is about the PREVIOUS line's blockType, and is true
   of every fixture measured; but a FRESH quote/list marker on the CURRENT line (its body
   happening to be blank, e.g. `"Intro.\n> \t\n> more."`) can still see `wasPara === true`
   from the plain paragraph before it, and `prevContainer` is already set unconditionally
   for that blockType a few lines above this check regardless of what follows. Swallowing
   such a line without the guard would leave `prevPara` and `prevContainer` both `true`
   going into the next iteration, an invariant violation nothing downstream expects, even
   though every measured case (the mutually-exclusive-flush-at-`blockType !== "paragraph"`
   path downstream still produces the right output either way) happens not to show it. The
   guard makes the plan's stated invariant true by construction instead of by the corpus
   this ticket happened to try.

**Position census, both directions, against the real renderer** (same harness, base =
`8d2b3f2` copied not linked, fix = this tree): **486 cells** = 9 whitespace-line shapes
(bare tab, tab-space, space-tab, 2sp-tab, 3sp-tab, 4sp-tab, tab-tab, spaces-only-3 as a
control, CR-terminated bare tab) x 6 predecessor contexts (open plain paragraph; doc
start; after a heading; after an HR; after a fence-close; after a real blank line) x 9
follower shapes (tab-led `<!--` block, space-tab-led `<!--` block, 4-space-led `<!--`
block, plain prose, ATX heading, HR, fence, list marker, table row).

| direction | count | corpus |
|---|---|---|
| disclosure CLOSED (base spoke `HIDDENA`, fix does not) | 16 | 486 |
| NEWLY LEAKING (fix speaks `HIDDENA` where base did not) | 0 | 486 |
| matches the renderer's own visible text, both arms | 193 | 486 |
| MISSES the renderer, both arms (pre-existing, unaffected) | 277 | 486 |
| NEWLY MATCHES the renderer (fix correct, base was not) | 16 | 486 |
| NEWLY MISSES the renderer (fix regressed, base matched) | 0 | 486 |
| unchanged, base === fix byte for byte | 470 | 486 |

The 16 closed/newly-matching cells are exactly the 8 tab-bearing whitespace shapes x the
2 `<!--`-at-tab-or-4-space-lead followers, under the single "open plain paragraph"
predecessor - 0 under any of the other 5 predecessors, confirming the "no paragraph open"
axis is untouched, and 0 under the space-tab-led `<!--` follower, which NRL-155's own
fixture already covered (not newly reachable, not newly broken). `spaces-only-3` closes
nothing, as the harness census predicted. The 277 "both miss" cells are the pre-existing,
out-of-scope `INDENTED_CODE`-masks-content miss this ticket's own `guard-nrl158-*no-
paragraph-open` fixtures pin unchanged (`skipCodeBlocks: true` intentionally silences the
`<!--` line itself; unrelated to the blank-line question here).

**Container census, confirming unchanged rather than correct** (same harness, same two
arms): **48 cells** = 8 tab-bearing whitespace shapes x 3 follower shapes (a `<!--`
block, plain prose, an ATX heading) x 2 container kinds (quote, list), each with the
container's own marker carried on every line including the whitespace-only one. **48 of
48 unchanged, 0 differ.** One shape probed while building this census is worth recording
because it contradicts a plausible generalisation of the harness's own top-level finding:
inside a quote with REAL preceding paragraph content, a tab-bearing whitespace line DOES
continue the quote's own paragraph when the next line is plain prose
(`"> Before x.\n> \t\n> more."` renders one `<p>Before x.<br><br>more.</p>`) but does NOT
when the next line is `"<!--"` specifically (`"> Before x.\n> \t\n> <!--\n> ===\n>
HIDDENA\n> --> t."` renders the paragraph ending at the blank line, then a SEPARATE
setext-heading block for `<!--`/`===`, with `HIDDENA`/`--> t.` in a further paragraph
after it - all DISPLAYED, nothing hidden). This asymmetry is real, measured, and is
precisely the kind of container-specific interaction the plan's own census flagged as
needing its own model; it is not fixed here, and the guard fixtures pin the (unaffected)
current behaviour rather than this renderer nuance.

**sourceIndex lockstep**: the double-tab-blank shape the plan named by name
(`"Intro.\n\t\n\t\nNext."`) is the one case where the joined TEXT cannot distinguish base
from the fix at all - both read `"Intro. Next."`, since there is nothing between the two
swallowed lines to speak differently. What differs is chunk STRUCTURE: base flushes
`"Intro."` at the first tab line (2 chunks, clean per-chunk `sourceIndex`); the fix keeps
the paragraph open across BOTH swallowed lines and appends `"Next."` through the same
join-space synthesis (`sourceOffsetOfSpace`) every other soft-wrapped continuation uses (1
chunk, one synthetic gap offset at the raw newline immediately before `"Next."`). Checked
numerically by UTF-16 code-unit index (length, bounds, identity modulo the synthetic-space
exemption, monotonicity) on the merged chunk, with the house four-mutator proof (drop-one-
entry, shift-all-by-one, swap-two-entries, negate-one) each shown able to fail the checker
on this exact chunk before confirming it passes on the real, unmutated output -
`tests/extract.test.ts`'s own new block, not a one-off script.

**`interruptsParagraph`, `codeSpanClosesLater`, `bracketClosesLater`, `labelClose`,
`opensMathBlock`, `opensObsidianBlock`, `opensHtmlBlock`, `fenceOpensAt`,
`inlineContainerClose`, `wikiTargetClose`, `peelQuotes` and `containerPrefix` are
unchanged** - the full `npm test` run (25 suites, 6,815 pre-existing checks) passes
byte-for-byte identically before and after this diff, with only the 14 new NRL-158 checks
moving from red to green; `pin-nrl155-tab-whitespace-line-is-not-blank` and the full
`guard-nrl155-*`/`pin-nrl115-*`/`pin-nrl120-*`/`pin-nrl136-*` families (364 `ok` lines
total across both runs) are confirmed intact and unmodified.

**Residuals, named rather than silently left.** (a) Containers (quote/list paragraph
continuation across a tab-bearing whitespace line, including the asymmetric `<!--`-vs-
plain-prose shape measured above) stay exactly as found - genuinely out of scope, not a
smaller version of the same defect. (b) The pre-existing `INDENTED_CODE`-masks-content
miss on the "no paragraph open" axis (277 of 486 top-level census cells) is unaffected,
not fixed, by this ticket; it is NRL-93/NRL-115's family, unrelated to the blank-line
question here. (c) The `blockType === "paragraph"` guard at site 3 is a defensive
addition proven unobservable on every fixture tried (base and fix agree whether or not
it is present); it is kept for the invariant it makes true by construction, not because
a failing fixture demanded it.

**NOT VERIFIED IN OBSIDIAN.** No deploy and no CDP session happened for this ticket; both
censuses are bare Node, bundling the real `src/text/extract.ts` from this tree and from
`8d2b3f2` with the repo's own esbuild, graded against Obsidian 1.13.7's reading-view
parser and renderer executed out of the installed asar. Live Preview was not examined.
R-M08 is still NOT met and the `2 of 16` MUST headline count does not move: this closes
the blank-line-with-a-tab disclosure NRL-155 pinned and deferred, not the requirement;
the container axis and the pre-existing `INDENTED_CODE` miss both stay open against it.
