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
  sentinel inside the comment. The term is now
  `TERM2_LIST = /^ {0,3}(?:[-*+]|1[.)])[ \t]/`,
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

  **Two things about `TERM2_LIST`. The FIRST IS NOW FIXED by NRL-111's second
  pass; the second is still open as NRL-119's remaining half.** `^[ \t]*` had NO
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

  The SECOND is untouched: the `[ \t]` requirement misses a BARE marker, which
  module 745 accepts (`next!=="\n" && next!==""` passes), so `*`, `+`, `1.` and
  `1)` alone on a line are all measured interrupters and we fail closed on all four
  - 5,120 cells, prose loss. That is **NRL-119's second half** and it is
  deliberately not done here; `pin-nrl111-bare-ordered-marker-unmasked` is the only
  thing in the suite that goes red on an arm widening `[ \t]` to `([ \t]|$)`, so
  it is the tripwire that stops the stop set growing a bare-marker term by
  accident. Measured on the first pass's own list change: five
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
  `pin-nrl95-bullet-inside-quote-still-hidden`).
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
  sides, and the same shape NRL-93 records for `%%`. **It is a disclosure rather
  than prose loss, which the first draft of this bullet did not say.** Measured at
  ship review: `Before x.` / blank / `\t<!--` / `HIDDEN1` / `more` speaks
  `"Before x. HIDDEN1 more"` on **base and fix alike, 512 of 512 cells each**,
  while module 8776's skip loop accepts `\t`, so Obsidian opens a block there and
  hides `HIDDEN1`. Unchanged by this diff in either direction, and it is NRL-93's
  indented-code question rather than a new one: narrowing the `<!--` predicate
  would not help, because the line never reaches it.
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
**NRL-119's second half, a bare marker alone on a line, stays open** and is
tripwired, not fixed.

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
   in the item. `TERM2_MATH` was checked for the same lead error and needs no
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
`pin-nrl120-quoted-math-still-hidden`.

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
