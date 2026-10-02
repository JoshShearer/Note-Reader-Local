# 0006. Obsidian comment exclusion

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-38 (R-M08); clause 4 amended by NRL-42, NRL-44, NRL-64, NRL-74 and
  NRL-95; clause 2 amended by NRL-68, NRL-73, NRL-74, NRL-95, NRL-93, NRL-116
  and NRL-113

## Context

Obsidian hides `%%...%%` comments in Reading view. Speaking their contents
discloses text the author deliberately hid. Before this change, a fresh bundle
of the real extractor retained both hidden content and delimiters in the inline
and block ticket reproductions. R-M08 requires converting Markdown to readable
content rather than reading raw syntax.

The pipeline's phase0 record reports inspection of the installed Obsidian
1.13.7 tokenizers: an unclosed block comment consumes the rest of the note,
whereas an unmatched inline opener remains literal. This is recorded tokenizer
evidence, not a live Obsidian reading or highlighting observation.

## Decision

1. **Comments are unconditionally silent.** Drop both delimiters and content
   for inline `%%...%%` spans and multi-line blocks. There is no comment setting.
   Keep visible prose before a comment and after its closing delimiter,
   including trailing prose on the closing line and subsequent comments there.

2. **Distinguish block and inline openers.** At the start of a prose line
   (leading **spaces** only, charCode 32, and at most **three** of them - but any
   whitespace in any quantity when a list item has already dedented the line, which
   is the renderer's own context-sensitivity and is spelled out in the three terms
   below) **and with no further `%` before the end of that
   line**, an unmatched `%%` opens a block that hides through
   the first later `%%`, or through EOF when none exists. Apply this to the
   line body after structural prefixes are peeled and to closing-line prose
   remainders. An unmatched inline `%%` remains literal and does not consume
   later lines. A lone `%` and backslash-escaped openers remain literal.
   Hiding every unmatched inline opener would silently discard visible prose;
   speaking unclosed blocks would disclose renderer-hidden content.

   The lone-`%` half is the renderer's own rule and was missing until NRL-73;
   see the divergence section below for the evidence and for why it is asked
   through one shared predicate rather than restated at each site. It applies to
   `%%` **only**: the disqualifier lives in Obsidian's `%%` tokenizer and has no
   HTML-comment equivalent, so `<!--` is deliberately not narrowed by it.

   **Confirmed against the renderer by NRL-68, which was filed to contradict
   it.** That ticket reported a trailing mid-line `%%` failing to open a block
   and called the hidden text under it a disclosure. The premise is false. The
   `%%` block tokenizer in the installed Obsidian 1.13.7, read out of
   `.../flatpak/app/md.obsidian.Obsidian/x86_64/stable/092bb11df3c993bd41aebf29b91228e3dc47ebb918c0224cea792006f123e084/files/resources/obsidian.asar`
   under `~/.local/share`, has three load-bearing lines:

   ```js
   for (var i = t.length, r = 0; r < i && 32 === t.charCodeAt(r);) r++;
   if (37 === t.charCodeAt(r) && 37 === t.charCodeAt(r + 1)) {
     for (var o = r += 2; r < i;) { var a = t.charCodeAt(r);
       if (37 === a) return;
   ```

   The skip loop accepts **spaces only**, the `%%` must then sit at the block
   start, and the function is registered as a **block** tokenizer, in all three
   of the `interruptParagraph`, `interruptList` and `interruptBlockquote` sets,
   so it cannot fire part way through a line at all.
   The inline tokenizer is `/^%%(.*?)%%/`, anchored, and `.` does not match a
   newline, so it cannot reach across the break either. A trailing mid-line `%%`
   is therefore literal text in Obsidian, the text below it is displayed, and
   speaking both is correct rather than a leak. `Plain prose %%` / `HIDEME` /
   `%%` speaking `Plain prose %% HIDEME` is the renderer-faithful result, and
   the line-start requirement in the first paragraph of this clause is now
   evidence-backed rather than asserted.

   Two real divergences fell out of the same reading, and both go the other
   way - they hide text Obsidian displays, which is the direction this clause
   calls out as the one that discards visible prose. **Both are now fixed:
   NRL-73 below, and NRL-74 in its own subsection after it.**

   **NRL-73, resolved.** `if (37 === a) return` means **any** `%` before the
   newline disqualifies the block, while we looked only for a later `%%` closer,
   so `%% 50% off` opened a block for us and not for Obsidian and the rest of the
   note was silenced. Two sites asked that question independently: the
   literal-emit escape in `cleanLine`'s comment branch (`src/text/extract.ts:903`,
   the path the reproduction actually takes) and `opensHiddenComment`
   (`:1656-1661`, reached only from `interruptsParagraph` and in turn only from
   `codeSpanClosesLater`, so it never runs on a note with no backticks and a fix
   there alone would have changed nothing). Both now call **one predicate**:

   ```ts
   function opensObsidianBlock(view: string, at: number): boolean {
       return view.slice(0, at).trim() === "" && view.indexOf("%", at + 2) === -1;
   }
   ```

   One predicate rather than two parallel edits because the two sites are the
   same question asked from two places and had already drifted on exactly the
   half that was missing. This is **not** the situation NRL-66's "do not merge
   the two scans" note describes: those two scans have deliberately *different*
   escape rules, whereas these two must agree by definition. Three properties are
   load-bearing. `blockComments &&` stays at the `cleanLine` call site as a
   **mode flag, not part of the rule**, and that is what makes the forward scan
   sound - the five recursive `cleanLine` call sites hand it a *middle slice* of a
   line rather than a suffix, and every one of them leaves `blockComments` at its
   `false` default, so the predicate is unreachable from them; the two sites that
   do pass `true` pass `raw.slice(from)` and `raw.slice(prefixChars)`, both
   suffixes, so scanning to end-of-view equals scanning to end-of-line. The
   `obsidianComment` gate is untouched, which is what keeps `<!--` out of the
   change. And the new predicate **strictly subsumes** the old expression - no `%`
   after the opener implies no `%%` after it - so `opensHiddenComment` can only
   return `false` where it used to return `true`, never the reverse.

   The scan is a **byte scan with no escape awareness**, mirroring the
   tokenizer's `charCodeAt(r) === 37`, so an escaped `\%` disqualifies the opener
   too: `%% 50\% off` / `VISIBLE PROSE AFTER` speaks `%% 50% off VISIBLE PROSE
   AFTER`. Failing toward what the renderer does is the point.

   Two consequences are **renderer-faithful and must not be reverted as
   regressions**, both measured. The disqualified opener line is itself spoken,
   delimiters included, because Obsidian displays it. And a later bare `%%` on its
   own line is still a genuine opener, so `%% 50% off` / `SECRETC` / `%%` /
   `tail.` moved from `"tail."` to `"%% 50% off SECRETC"` - the old output was
   wrong in **both directions at once**, hiding the two displayed lines and
   speaking the hidden tail. The same shape beside an unmatched backtick run moved
   from `"Before a b after."` to `"Before a %% 50% off SECRETB"` in both
   `skipInlineCode` positions.

   Because narrowing `opensHiddenComment` **widens** `codeSpanClosesLater`, the
   disclosure direction was probed separately rather than assumed: a genuine
   hidden `%%` block beside an unmatched backtick run of length 1, 2 and 3, a run
   that never closes, a mismatched pair and an HTML block all stayed silent,
   0 spoken on both sides over 5,120 cells per side, while ADR 0019's
   deliberately-literal `%%` pair inside a *spoken* span stayed at 512 on both
   sides. `codeSpanClosesLater` and `interruptsParagraph` are byte-identical
   across the diff, confirmed by hashing both function bodies. Of 1,789 distinct
   probe lines, 52 changed their `interruptsParagraph` answer and all 52 are lines
   the tokenizer does not treat as a comment opener.

   The oracle for all of the above was **transcribed from the installed
   `obsidian.asar`** rather than keyed on sentinel names, because a name-keyed
   oracle mis-classifies a shape whose second `%%` *closes* the block its first
   opened and so reports phantom leaks on a correct fix. Transcribing it also
   settled the **closer**, which this ADR had not previously cited: it is
   `for (var s = i; r < i;) { if (37 === ... && 37 === ...) { s = r + 2; break } r++ }`,
   the next `%%` **anywhere** from the newline on with no line-start requirement,
   which is what we already did. Over 19,968 cells per side, text the tokenizer
   hides leaked 1,024 -> 0 and text it displays was lost 8,704 -> 0, with 0 cells
   newly leaking or newly lost.

   **NRL-74, resolved.** The line-start half of the guard at
   `src/text/extract.ts:903` was gated on `obsidianComment`, so an unmatched
   mid-line `<!--` opened a block while `%%` correctly did not. It is narrowed,
   not `%%` widened, and by a **second** predicate rather than a widened
   `opensObsidianBlock` - the two bodies answer different questions, and merging
   them would import `if (37 === a) return` into `<!--`, which clause 2's own
   D-73-4 note forbids. This is the one place NRL-66's "do not merge the two
   scans" note DOES apply, where NRL-73's merge did not:

   ```ts
   function opensHtmlBlock(view: string, at: number, closesLater: boolean): boolean {
       return view.slice(0, at).trim() === "" || closesLater;
   }
   ```

   Two terms, neither sufficient alone, and the second cannot be answered from
   the line: it is "some LATER line carries `-->`", computed once per note in
   `extractChunks` as the scalar `lastHtmlCloser` and threaded down as a required
   parameter through `cleanLine`, `opensHiddenComment`, `interruptsParagraph`,
   `codeSpanClosesLater` and `bracketClosesLater`. `interruptsParagraph` is
   therefore no longer a pure line predicate. Both terms or neither: adopting the
   line-start term alone is a measured disclosure, because it answers false for a
   mid-line `<!--` that a later `-->` genuinely closes, so `codeSpanClosesLater`
   confirms a carry across a line that really does open a hidden block. ADR 0025
   carries the rule, the EOF scope, the measurements and the residual risks.

   The tokenizer was read this session and it **agrees with the line-start term
   exactly**. Obsidian 1.13.7's HTML block tokenizer (module 8776 of the
   installed `obsidian.asar`) skips leading spaces AND tabs with no three-space
   cap, requires `<`, and tests `u=/^<!--/` **anchored** against the first line,
   closing on the first later line matching `h=/-->/` or running to EOF. So a
   mid-line `<!--` cannot open a block at all. The second term is the renderer's
   **inline** path instead (module 4839's `.T`, used by module 7648), whose
   `<!--(?:-?[^>-])(?:-?[^-])*-->` alternative requires a closer - and that path
   is **paragraph-scoped**. NRL-74 scanned to EOF for both terms, which was wider
   than the renderer for term 2; **NRL-95 closed that**, and the two terms now
   have two scopes on purpose. Term 1 keeps its EOF scan, because module 8776
   really does walk to end of input once it has opened. Term 2 is bounded by the
   end of the opener's paragraph, where the bound is a blank line, a fence, an ATX
   heading, a thematic break or a setext underline, and deliberately **not** a
   blockquote, list or table-row line - a container re-offers its content as one
   paragraph, so stopping there was a measured disclosure. See ADR 0025 decisions
   3 and 4, and the residual list there.

   **The line-start half is now the renderer's own rule, in three terms (NRL-93).**
   It was `view.slice(0, at).trim() === ""`, any whitespace in any quantity.
   Replaced in place, per the NRL-66/NRL-67 convention; the paragraphs that
   recorded two open misses and then recorded them as BLOCKED are superseded,
   because both are closed and the reason the earlier "do not ship a one-line
   `.trim()` fix" warning gave is now the third term rather than a reason to stop.

   Term A is SPACES ONLY. The `%%` block tokenizer's skip loop is
   `for(var i=t.length,r=0;r<i&&32===t.charCodeAt(r);)r++;` immediately before
   `if(37===t.charCodeAt(r)&&37===t.charCodeAt(r+1))`, so it accepts charCode 32
   and nothing else. `\t%%` was opening a block for us and not for Obsidian, which
   silenced a paragraph's remaining lines and a blockquote whole.

   Term B is AT MOST THREE of them. The tokenizer's own loop really has no cap,
   but a continuation line indented a tab or four-plus columns never reaches it:
   the paragraph tokenizer (module 8607) skips the interrupt check for such a line
   outright -
   `if((h=t.charAt(c))===o){p=l;break}` ... `if(p>=l&&h!==a){y=t.indexOf(a,y+1);continue}`
   with `o = "\t"`, `s = " "`, `a = "\n"`, `l = 4`, gated on
   `options.commonmark`, which `VT.globalOptions={breaks:!0,commonmark:!0}` sets.
   So the line is absorbed as lazy prose and its `%%` reaches the **inline**
   tokenizer, `/^%%(.*?)%%/`, which is anchored and whose `.` does not match a
   newline, so an unmatched one is literal and displayed. Note that no tab can
   survive term B: module 6058 advances a tab to the next multiple of four, so any
   lead holding one is at least four columns, which is why one spaces-only scan
   plus a length test implements both terms.

   Term C is the third ARGUMENT, `dedentedByList`, and it is the renderer's own
   context-sensitivity rather than a convenience. A LIST ITEM's content is
   dedented by the item's own content indent before any block tokenizer sees it:
   module 745's `M` calls module 5540's remove-indentation with that indent, and
   module 6058 counts a tab as four columns. Transcribed and RUN rather than
   reasoned about, those three turn `- item` / `\t%%` / `SECRET` into
   `item` / `%%` / `SECRET`, so the renderer DOES open a comment there. When the
   argument is true the old any-whitespace test is kept, which is byte-for-byte
   the pre-NRL-93 behaviour. Omitting term C is not a smaller version of this
   change, it is a regression: measured, a bare charCode-32 scan newly speaks
   hidden text in **14,336 of 46,080** list-interior and fresh-block cells and a
   `{0,3}`-capped scan with no term C in **21,504**, where this fix moves **0**.

   `extractChunks` decides term C per line, in a forward O(L) pass with O(L)
   booleans, in the shape of the `htmlCloserAhead` pass and for the same reason:
   `codeSpanClosesLater` and `bracketClosesLater` ask about lines they are not
   consuming, so a scalar carried by the per-line loop could not answer them. The
   pass tracks its run on the QUOTE-PEELED view, because a list inside a
   blockquote dedents its item content exactly as a top-level one does while
   `containerPrefix` calls that line a quote rather than a list; it reports false
   on the MARKER line itself, because module 745 assigns the item's first line
   (`c[0] = s`) the text after the marker undedented; and it ends a run by roughly
   the condition the per-line loop uses for `inList`, minus that condition's
   BLOCKQUOTE arm, which the peel makes wrong here because `interruptList` holds
   no blockquote entry.

   **"Every approximation in it errs toward TRUE, which is the old behaviour and
   therefore cannot regress" was written here and in `extract.ts`, and NRL-93's own
   Verify pass FALSIFIED it.** Two of the run-ending terms asked their question of
   the quote-peeled body, which is not the view the renderer decides on, and both
   ended a run that the renderer keeps alive - so `listDedented` read FALSE where
   the renderer had dedented the line, the predicate declined a real opener, and
   author-hidden text was SPOKEN in **1,780 of 3,360** cells of a two-arm corpus
   oracled on real rendered HTML, with base correct in every one of the 1,780. The
   absolute is deleted rather than weakened, and these are the two terms as fixed,
   each measured:

   - HEADING / FENCE / HR end a run only when the line is **not quoted**. `> ---`
     inside a list item is a thematic break inside a blockquote nested in that
     item; it ends neither the item nor the list. **1,480 of 2,464** cells leaked
     without this term, **0** with it.
   - `blankBefore` ends a run only when the line's **raw** indent is empty as well
     as its peeled body's, because the peel removes an indent that is what keeps a
     quoted line inside the item. **368 of 896** cells leaked without this term,
     **0** with it.

   What is true of the fixed pass, and all that should be relied on, is split in
   two. The **structural** half is proved: `opensObsidianBlock` can only decline an
   opener the pre-NRL-93 rule accepted and can never accept one it declined, since
   both added terms are conjunctive refusals in front of the old body - 0
   violations over **263,672** triples covering every string over
   {space, tab, `%`, `x`, `>`} up to length 6, every `at` in range and both values
   of `dedentedByList`, with a deliberately widened variant giving 575 violations
   to show the check can fail. The **behavioural** half is only measured, never
   proved: `listDedented` is an approximation of three bundle modules, its
   remaining divergences from them are the ones enumerated below and they are
   measured identical on both sides of this change, and nothing here rules out a
   further shape in which it reads FALSE where the renderer dedented. The
   structural half bounds the damage such a shape can do to *this predicate's*
   direction; it does not bound `listDedented`'s own, which is exactly what the
   deleted sentence wrongly implied.

   **The argument is a BOOLEAN and not the indent itself, and that is a scoping
   decision with a measured residual.** Subtracting the amount needs a stack of
   enclosing item content indents plus module 5540's stop-based slice, because the
   effect does not compose by column arithmetic - a tab is consumed whole for as
   little as one column of credit, so a doubly nested `\t\t%%` ends at zero
   columns and not at four. Underestimating that stack speaks hidden text, which
   is the dangerous direction, so the boolean is the conservative member of the
   family. What it leaves open, all in the prose-loss direction and all measured
   as IDENTICAL on both sides of this change: a list item's content indented
   enough that the dedent still leaves four columns (eight spaces, or two tabs
   against a two-column item), **11 cells** of a 140-cell position census, and a
   blockquote nested INSIDE a list item, where the item dedent runs first and the
   surviving indent lands in the quote's own content, **6 more**.

   **Three divergences in the same census are NOT this predicate's and were not
   opened here.** Our `BLOCKQUOTE` is `/^(?:\s{0,3}>\s?)+/` and its `\s?` eats a
   TAB, where module 6234 consumes `>` plus at most one SPACE
   (`t.charAt(D)===a&&D++` with `a = " "`), 2 cells. Our `LIST_BULLET` is
   `/^\s*([-*+]|\d+[.)])\s+/` and its `\s+` eats the whole lead after a marker,
   where module 745's third group takes at most four spaces or one tab, 3 cells -
   **CLOSED by NRL-116; see the amendment below, and do not quote the 3.**
   And an unterminated `%%` is NOTE-scoped for us (clause 5) where Obsidian scopes
   it to the construct that holds it, which is why a `%%` on a list marker line
   silences the following items.

   **That last one is also the cost this change carries, and it is pinned rather
   than hidden.** Base was accidentally PAIRING a wrongly-recognised
   over-indented opener with a real one and so closing the block early; declining
   the wrong opener leaves the real one's note-scope reaching further. Measured by
   a 4,000-note fuzz with tabs, multi-space leads and a list-bearing population:
   **157 of 16,000 cells newly lose text the renderer displays**, against **833
   losses closed**, **12 leaks closed** and **0 cells newly leaking**; all 157 are
   notes whose surviving opener sits inside a list item (117) or a blockquote
   (40). The same fuzz newly leaks in **48** cells against the bare charCode-32
   scan and **72** against the uncapped-term-C `{0,3}` form, so it can fail.

   **Every cell count in this subsection is corpus-specific and must be quoted
   with its corpus attached**, the way NRL-88 root 4's three different totals are.
   One claim in this ticket's own record was not. `919d13e`'s commit message says
   the fix-forward pass's **370** prose-loss fuzz regressions are the SAME 370
   cells as the first draft's, "so this pass adds none". That equality holds **on
   that corpus** and does not hold in general: on the second independent Verify's
   own **48,668-cell** fuzz the set is a strict SUPERSET, **515** against the first
   draft's **487**, with **28** cells in the fix-forward pass only and **0** in the
   first draft only. That is what the mechanism predicts, both added guards only
   making a run harder to END. What does hold, and is the part that matters, is the
   direction: the relation is one-way, so there are **0** cells in which this pass
   speaks a sentinel the renderer shows where the first draft hid it, which is the
   same fact as the 0 in the first-draft-only column.

   **That cost is only half of this divergence's character, and the other half is
   a DISCLOSURE, so the root must not be recorded as prose-loss-only.** Our `%%`
   block state is note-scoped **and container-blind**, where Obsidian scopes a
   block to the construct holding it, so a later `%%` at a DIFFERENT container
   depth closes for us a block the renderer keeps open and that line's remainder is
   SPOKEN: `>> %%` / `%% SECRET` says `SECRET`, which the renderer hides. This half
   is **pre-existing and not opened here**. Measured by that second Verify against
   real rendered HTML, on a corpus carrying **no tab and no four-plus-space lead
   anywhere** - so this change provably cannot reach it - **1,088 of the 1,088
   cells with room** on a 1,728-cell corpus leak on BASE and **1,088** on the fix,
   **0 newly leaking**. Re-measured independently while writing this paragraph, by
   bundling both arms from this tree: over 8 container prefixes x all 512
   content-key combinations, **4,096 of 4,096 cells leak on base and 4,096 on the
   fix, 0 newly leaking, and 0 cells differ between the two arms in any respect**.
   It is tracked as **NRL-118** and pinned as a TRIPWIRE by
   `pin-nrl118-note-scope-closes-at-another-depth` plus its control; when NRL-118
   closes, both expectations change on purpose.

   A **fresh-block** tab-led or four-space line needed no change and did not get
   one: it never reaches this predicate, and the renderer agrees it is code.
   `blockMethods` is [frontmatter, blankLine, indentedCode, ..., comment,
   fencedCode, ...], because `FE` splices before its anchor
   (`a.splice(a.indexOf(n),0,t)`) and `indentedCode` already precedes
   `fencedCode`, and module 134 opens indented code on ONE tab
   (`else if(l===o)` with `o = "\t"`). `interruptParagraph` holds no
   `indentedCode` entry at all, and both its `setextHeading` and `definition`
   entries carry `{commonmark:!1}`, which module 6047's
   `(void 0===o.commonmark||o.commonmark===n.options.commonmark)` gate disables
   under `commonmark:!0` - worth writing down because an oracle that keeps either
   of them models the wrong parser.

   `opensHtmlBlock` keeps `.trim()` deliberately and shares none of this: module
   8776's skip loop is `(C === "\t" || C === " ")`, so Obsidian really does
   accept a tab before `<!--`. The two predicates answer different questions and
   must not be merged (D-73-4, and NRL-66's note about two scans).

   **NRL-113 AMENDMENT (2026-10-01).** The paragraph above is right and gains a
   corollary, and the `opensHtmlBlock` sentence is right as stated and gains a
   caveat.

   The corollary. Module 134's rule is **literal**: four literal spaces, or one
   literal tab, at offset 0, with **no tab-stop expansion anywhere**, and the
   tokenizer is a single loop so the continuation arm is the opener arm. It
   follows that a lead of **one to three spaces then a tab** is *not* indented
   code for Obsidian, where CommonMark's tab-stop rule would make it column
   four. `INDENTED_CODE` carried CommonMark's rule and was narrowed from
   `/^(?: {4}| {0,3}\t)/` to `/^(?: {4}|\t)/`, once, read by all three sites.
   Consequence for **this** predicate: such a line now DOES reach it, and term
   A's charCode-32-only scan declines it, which is right for the renderer's own
   reason - the `%%` skip loop is spaces only - so the line is prose carrying a
   literal `%%`, which is what the renderer displays. Measured as prose recovery
   rather than assumed: 3,072 of 179,712 corpus cells. **No term of
   `opensObsidianBlock` changed** and its body is byte-identical across the diff.

   The caveat. Module 8776's tab tolerance is real but it **never decides a
   fresh-block line**, because `blockMethods` reaches `indentedCode` (index 2)
   before `html` (index 11). So the sentence "Obsidian really does accept a tab
   before `<!--`" must not be read as "a fresh-block `\t<!--` opens an HTML
   comment block": it does not, it is code, rendered
   `<pre><code>&#x3C;!--</code></pre>` with the following lines DISPLAYED as a
   paragraph. `AGENTS.md`, `srs.md:328` and `docs/adr/0025` all drew that wrong
   conclusion from this true premise and are corrected.

   The evidence standing is **stronger** than the paragraph above: NRL-113 did
   not transcribe module 134, it **executed** Obsidian 1.13.7's own `WT` parser
   and `GT` HTML renderer out of the same `app.js` (sha256
   `8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898`) and took
   every verdict from real rendered HTML. Still **NOT observed live**, and
   **reading-view path only** - `WT`/`GT` is the markdown-to-HTML pipeline and
   Live Preview's CM6 code has never been read by any ticket in this family.

   All of this was read off the installed parser's own source - `app.js` sha256
   `8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898`,
   3,876,459 bytes - transcribed into a recursive block-level model and RUN, and
   was **NOT observed live** in Obsidian, the same standing this ADR's other
   tokenizer citations have. NRL-73's numbers above are bare-Node measurement
   against base `bb77b77`; NRL-93's are bare-Node measurement against base
   `1ed6f1c`, whose `src/` is identical to `f27517d`'s.

   **NRL-116 amendment: the marker's lead is peeled separately from the marker.**

   The `LIST_BULLET` row above is closed, and the number it is recorded at was
   **far too small - 3 cells, where the real figure is 313,344 losses closed on a
   3,096,576-cell census**, about five orders of magnitude. That is a property of
   NRL-93's corpus (a 140-cell position census that ADR 0006 describes but does
   not enumerate, and so is not reconstructable) rather than a mistake in its
   arithmetic, and it is the same caveat the subsection above already attaches to
   every count in it. Quote the corpus with the number or do not quote the number.

   **The rule.** `containerPrefix` no longer peels with the shared `LIST_BULLET`
   and `TASK`. It peels with three PEEL-LOCAL patterns, and `LIST_BULLET` stays
   **byte-identical** for its three other readers - `interruptsParagraph`, the
   `listDedented` pass and that pass's `inList` end test - which is the rule
   NRL-114's Q6 and NRL-116's Q11 both set, after NRL-93's own planned one-term
   change to a shared predicate measured a 6,144-cell regression (`TASK` is the
   one exception and the paragraph after next says why):

   ```
   PEEL_MARKER = /^\s*([-*+]|\d+[.)])(?=\s)/     module 745 group 2, as a lookahead
   PEEL_LEAD   = /^(?: {1,4}(?! )| |\t)/          module 745 group 3, verbatim
   PEEL_TASK   = /^\[[^\]]\](?=\s|$)/             the old TASK, trailing run removed
   ```

   Group 3 is the whole point: AT MOST FOUR SPACES NOT FOLLOWED BY A FIFTH, or one
   space, or one tab, and everything past it is the item's CONTENT INDENT. So
   `- ` + tab + `%%` leaves `\t%%` as content, a tab of content indent is indented
   code inside the item, and the following item is DISPLAYED.

   **It is TWO constants and not one.** `TASK`'s own trailing `\s*` ate the lead
   after a checkbox exactly as `LIST_BULLET`'s `\s+` did after a marker. Reverting
   only that half re-breaks all three task shapes AND loses a displayed `>`,
   measured directly, so narrowing one without the other is not a smaller fix.
   The shared `TASK` is **DELETED** rather than left byte-identical the way
   `LIST_BULLET` is, and that asymmetry is deliberate: once `containerPrefix`
   stopped reading it, `TASK` had no other reader anywhere in `src/` or `tests/`,
   so keeping it would have been dead code carrying a comment saying nothing reads
   it. Its NRL-8 docstring survives on `PEEL_TASK`, and the deletion is shown
   behaviour-neutral rather than argued to be: the arm was rebuilt after it and
   compared cell for cell against the one every figure below was taken on -
   **0 differing cells of 3,096,576** on the census corpus and **0 of 120,000** on
   a fuzz, against non-vacuity controls of 147,456 and 11,712 cells in which that
   same arm differs from base - and the lockstep, bucket, fuzz and attribution
   probes were all re-run against it and reproduced every number to the digit.

   **Group 3's `$` and `(?=\n)` branches are deliberately OMITTED**, so a BARE
   marker peels exactly as before. `- %%` and `-` + tab + `%%` really do reduce to
   `%%` at the item's block start, so the opener is already right and what diverges
   is the block's SCOPE - NRL-118, the row above. Widening the peel to cover them
   would change nothing about that and only enlarge the diff.

   **THE LOAD-BEARING PART IS NOT THE LEAD, IT IS RELOCATING NRL-131'S STOP
   (ADR 0035), and it is invisible from the defect's own description.** That stop
   used to read the PEELED string's own trailing whitespace run,
   `INDENTED_CODE.test(b[0].match(/\s*$/)![0].slice(1))`, which only worked because
   `\s+` had swallowed the entire lead into `b[0]`. With the lead bounded that run
   is at most four spaces or one tab, `.slice(1)` leaves at most three spaces or
   nothing, and the stop NEVER FIRES. Measured on the census corpus below, a
   variant that narrows the lead and leaves the stop where it is newly loses
   **314,880 cells of 3,096,576**, every one an NRL-131 case regressing, against
   **0** for the shipped form - which asks `INDENTED_CODE` of the REMAINING BODY,
   the place the indent lives after the narrowing, and lets `PEEL_LEAD` do
   `.slice(1)`'s old job of discounting the marker's required space.

   **The faithful lead rule is observationally equivalent to the "single space"
   rule the NRL-116 ticket text asserted.** Measured at **0 differing cells over
   48,384** structured cells and **0 over a 120,000-cell fuzz**, against a
   12,489-cell non-vacuity control, because whatever the lead declines falls to
   `INDENTED_CODE`, to `BLOCKQUOTE`'s own `\s{0,3}>` or to term B's three-space cap
   and is absorbed identically. Module 745's real rule is implemented because it is
   the renderer's, not because a measured shape distinguishes it. Said plainly so
   it is not mistaken for evidence: this is fidelity, not a closed cell count.

   **Q41: THE PROBE FOUND CORPUS BLINDNESS IN ITSELF, and it is the sixth recorded
   instance in this repo.** The Start-phase collision probe swept 2,654,208 cells
   and reported the no-relocation arm CLEAN. That zero was blind twice over: its
   nested-quote shape used `> ZQZ`, so the SENTINEL survived while the DISPLAYED
   `>` was dropped, and it carried no `marker + lead + > %%` shape at all. The
   corrected corpus adds both - a `marker + lead + > <construct>` shape, a doubly
   nested `> > ` shape, and the bare `>` CHARACTER tracked as a sentinel of its own
   across every shape - and the same arm then measures **314,880 newly lost**. The
   `marker + lead + > %%` shape the old corpus could not reach at all is the single
   largest contributor, at 110,592 of that total. A clean row on a corpus that
   cannot reach the colliding shape is not evidence, and this is the sixth time
   that has been written down here.

   **The census, on the corrected corpus.** 14 shapes x 12 leads x 6 markers x 6
   constructs x all 512 content-key combinations = **3,096,576 cells per arm**,
   verdicts from real rendered HTML produced by Obsidian 1.13.7's own parser and
   renderer run in Node (`app.js` sha256 `8efbf581...`, both selftests green),
   0 render errors over 6,048 sources, shadow root COPIED and sanity-mutated:
   **0 newly lost, 0 newly leaking, 313,344 losses closed**, 2,949,120 cells
   byte-identical, and 0 newly lost in every one of the 14 shapes. SIX of the
   fourteen shapes report **0 cells moved**, including all three nested-quote
   shapes - the plain one and both of Q41's additions - so the relocation leaves
   that family byte-identical to base rather than merely equal in leak count.
   On the same corpus the no-relocation arm moves 73,728 cells in each of those
   three and loses in all of them, which is the whole of the Q38 risk in one row.

   **The cost is the SAME NRL-118 note-scope class this subsection already
   records, and it is signed.** A 4,803-note fuzz with tabs, multi-space leads and
   a list-bearing population: **365 of 57,636 cells newly lose displayed text, over
   25 distinct notes**, against **4,038 losses closed**, **252 leaks closed** and
   **0 newly leaking**. All 25 are attributed BY CONSTRUCTION and not by
   inspection: on a corpus carrying exactly ONE comment construct per note, so no
   pairing is possible, newly-lost is **0 of 73,236 cells over 6,103 notes** with
   14,392 losses closed; and independently, every one of the 25 losing notes
   carries TWO OR MORE comment constructs, never one. The probe's own classifier
   left 4 of 19 notes "UNEXPLAINED" on a smaller run and those four were run down
   rather than waved at - each is the same pairing root with a second opener the
   classifier's regex could not describe, a list-CONTINUATION opener the item
   itself dedents or a container-prefixed one with a marker between the prefix and
   the `%%` - so the predicate is widened to "any later opener", which is what the
   root requires. The fuzz is shown able to fail in BOTH directions: base against
   base moves 0 cells and reports 0 in every column; an arm that declines the
   item-continuation openers the renderer honours reports **360 newly leaking**;
   an arm that restores NRL-93's `.trim()` reports **427 newly lost**. Note that
   this fuzz is BLIND to the relocation - the no-relocation arm scores identically
   to the shipped one on it - which is why the structured corpus is not optional.

   **Four buckets, with destinations in a bucket of their own**, because a
   destination is an ATTRIBUTE and sits in neither text class, the gap that let
   NRL-74's 5,120-cell class through a probe reporting zero. Hidden text: **0
   newly leaking of 73,728** cells. Displayed text: **0 newly lost of 364,544**.
   Destinations: an image or link label soft-wrapped across a DECLINED `%%` line
   newly speaks its destination in **10,240 of 22,528** cells for each of the two
   kinds, base 0 - which is NRL-93's own `pin-nrl93-unmasked-label-destination`
   mechanism unmasked further rather than a new class, and the CONTROL is what
   makes that a tripwire rather than a leak: the same label with ordinary prose in
   place of the `%%` speaks the destination in **22,528 of 22,528 cells on BOTH
   arms**. ADR 0019's designed literal is kept separate at 22,528 cells, base 0 and
   fix 10,240, because collapsing it into the hidden bucket scores a designed
   behaviour as a leak.

   **`sourceIndex` (non-negotiable 8)** is clean by NUMERIC UTF-16 code-unit index
   over 6,051 sources x 8 content-key sets per arm - 138,340 base chunks, 1,092,866
   units - with four mutators (drop-one, shift-all, swap-two, negate-one) NONZERO
   ON BOTH ARMS, and both exemptions shown PRE-EXISTING by removing each from a
   correct tree: without the mapped-space exemption base reports 18,552 identity
   failures and the fix 19,704, and without ADR 0004's equation exemption both
   report 128. That exemption MUST key on the synthetic TEXT and never on
   `blockType` - `extract.ts` pushes the `"equation"` chunk with blockType
   `"other"`, so a `blockType`-keyed exemption exempts nothing and reports phantom
   failures on a correct tree.

   **Exactly one function body moved**: `containerPrefix`, 105 lines to 134,
   `04a3492d` to `064e2e50` (mostly comment - the executable change is three new
   patterns plus a four-line split of one arm). The other 16 are byte-identical,
   including
   `interruptsParagraph` `0212b5f4`, `codeSpanClosesLater` `43ec230e`,
   `bracketClosesLater` `311285bb`, `opensObsidianBlock` `f3cce67c`,
   `opensHtmlBlock` `6b3bdcc3`, `opensHiddenComment` `25c9ff98`, `opensMathBlock`
   `77f97d0a`, `labelClose` `92023b33`, `cleanLine` `734750b6`, `extractChunks`
   `5c30ca2a` and `isSetextContentLine` `7ba7bfdc`. The last two of those are
   **re-measured against the rebased base `9dadbea`, not the base this ticket was
   written on**, and the old values `97edd47a` and `9588a3df` are corrected rather
   than left standing: NRL-155 (#201) landed between Verify and Merge and changed
   both of those bodies itself, so the hashes moved for a reason that is not
   NRL-116's. What the property asserts is unchanged and still holds - NRL-116's
   own diff moves `containerPrefix` and nothing else, and all 16 neighbours are
   byte-identical between `9dadbea` and this commit - but a stale literal hash in
   an identity claim is the one thing that claim must not carry. Two traps in that technique
   were both hit and both matter. The body extractor must SKIP REGEX LITERALS, or
   it mis-pairs on `flowDepthDelta`, whose body holds `/"(?:[^"\\]|\\.)*"|'[^']*'/g`
   and is followed by `"["`, `"{"`, `"]"` and `"}"` as string literals. And it must
   skip a RETURN-TYPE ANNOTATION: `containerPrefix`'s return type is a
   brace-balanced object literal sitting at end of line exactly as a body does, so
   the first naive run reported a 7-line "containerPrefix" that was byte-identical
   across the change - a silent false negative, which is the one failure mode a
   sha256 identity claim must not have. The extractor is shown non-vacuous by
   mutating a neighbour and watching it report as moved.

   **Three divergences survive on the same marker line and each is pinned rather
   than closed**: the bare `- %%` and no-space `-` + tab forms and the
   exactly-four-space form, all three NRL-118's note scope with a correctly
   recognised opener (`pin-nrl93-bare-marker-opener-still-silenced`,
   `pin-nrl116-tab-no-space-after-marker-still-silenced`,
   `pin-nrl116-four-space-lead-still-silenced`); and the `<!--` TWIN, which is NOT
   fixed - `opensHtmlBlock` accepting a tab is CORRECT for a fresh-block `<!--`,
   module 8776's skip loop taking spaces and tabs, while on a marker line the
   item's content indent makes it indented code before the HTML tokenizer is
   reached, and we model that indent as a BOOLEAN rather than an amount, which is
   the row above (`pin-nrl116-html-twin-tab-lead-still-silenced`). For the same
   boolean reason the `%%` on the newly-fixed lines is itself SPOKEN where the
   renderer shows it as code, so `skipCodeBlocks` cannot reach it.

   Four NRL-93 fixtures MOVED and are **REPLACED IN PLACE keeping their names**,
   per the NRL-66/NRL-67 convention, so every citation of them here and in
   `srs.md` still resolves: `pin-nrl93-tab-after-{bullet,ordered,task}-marker-still-silenced`
   and `pin-nrl93-list-marker-lead-eaten-still-silenced`. THEIR NAMES NOW READ
   BACKWARDS, nothing being "still silenced" in any of them, and that wart is
   deliberate and preferred to a rename that orphans the citations.

   **NOT OBSERVED IN A LIVE OBSIDIAN.** No deploy and no CDP session happened; the
   renderer side is Obsidian's own parser and renderer executed in Node, which is
   stronger than a transcription and is still not the application, and it is the
   READING-VIEW path only. Rule 11 applies to every figure above.

3. **Only the active comment's first matching closer ends it.** Comments do
   not nest. HTML comments end at `-->`; Obsidian comments end at `%%`.
   Delimiters of the other kind, escapes, backticks, fences, math and blank
   lines inside a comment are just hidden content, with no parser-state
   changes. An unclosed HTML comment continues to hide through EOF **when it
   opened a block at all**, which since NRL-74 is the two-term test in clause 2's
   NRL-74 subsection rather than the bare presence of `<!--`.

4. **Literal code stays literal.** Inline code, fenced code and indented code
   keep `%%` when their code setting enables speech. Fenced and indented code
   are entirely silent when skipped, and so is a soft-wrapped inline span as of
   the NRL-44 amendment below; the NRL-42 amendment recorded that it was not,
   which was true at the time and is no longer. Code parsing
   precedes comment recognition. Display
   math continues to follow ADR 0004; hidden math inside a comment never
   produces an "equation" announcement.
   Inline code closes only on a backtick run of the same length; an inner
   backtick must not expose literal comment syntax to prose cleaning.

   **Amended by NRL-42: a code span may cross a soft line break.** The original
   decision only considered a span that opens and closes on one line, and the
   per-line scan then let the comment branch fire on a continuation line and
   delete text Obsidian renders. So:

   - A backtick run left unmatched on a line opens a span for this purpose
     **only when a later line in the same paragraph holds a run of exactly the
     same length**. Inside a span confirmed that way, both `%%` and `<!--` stay
     literal on every continuation line, exactly as they already do inside a
     single-line span.
   - **An unmatched run with no such closer is literal text and suppresses
     nothing.** This is the load-bearing half of the rule, not an optimisation.
     Carrying an open-span flag without confirming a closer would stop the next
     line's `%%` being recognised as a block opener and would read hidden text
     aloud, which is the failure direction this ADR exists to prevent. The
     search stops at a blank line and at any construct that starts its own
     block (fence, ATX heading, thematic break, setext underline, table row,
     list bullet, blockquote), and the opening line is tested the same way,
     because a span cannot leave the block it is in.

     This stop set and the one NRL-95 added for term 2 of the `<!--` rule are
     **deliberately different sets answering different questions**, and must not
     be merged. This one asks where a code span or a label may not cross;
     `endsTerm2Scan` asks where the renderer's inline raw-HTML regex stops
     looking, and it omits table row, list bullet and blockquote for the reason
     clause 2 gives. More importantly `endsTerm2Scan` must never CALL this
     predicate: `interruptsParagraph` -> `opensHiddenComment` -> `opensHtmlBlock`
     consumes the very answer `endsTerm2Scan` produces, so reusing it there is
     mutually recursive.
   - **A line that opens a comment also stops the search.** That is an opening
     `%%` with only whitespace before it and no `%%` closer on the line, or a
     `<!--` with no `-->` on the line **that also passes clause 2's two-term
     HTML test** - it begins its line, or a later line in the note carries `-->`
     (NRL-74). Before NRL-74 the `<!--` half here was the bare "no `-->` on the
     line", which stopped the search on a line the renderer does not treat as an
     opener at all; narrowing it is what lets a soft-wrapped code span or label
     be confirmed across such a line. This is why `interruptsParagraph` takes a
     second parameter and is no longer a pure line predicate: the second term is
     not line-local. As of NRL-95 it is **paragraph-bounded** rather than
     document-scoped, precomputed once per note as a per-line boolean array
     because the bound differs per line, and it reaches this predicate as a
     scalar so the predicate itself stays line-local. Both remain exactly the shapes that hide the lines after
     them. Obsidian 1.13.7's Reading-view parser puts `comment` in
     its `interruptParagraph` list and already has `html` there, so such a line
     terminates the paragraph before any inline tokenizing runs and a code span
     provably cannot contain one. Without this, a run on the far side of a real
     block comment counts as a closer, the comment branch is suppressed on the
     opener, and the hidden text is read aloud. A `%%...%%` or `<!--...-->` pair
     that closes on its own line hides nothing beyond itself, does not end the
     paragraph, and stays literal inside the span, which is this ticket's
     central case. Obsidian agrees on both halves: its block-comment tokenizer
     returns as soon as it sees a second `%` before the newline, so a complete
     pair is never a block opener. Read off the installed parser's own source,
     which is stronger than the CommonMark reading used elsewhere here but is
     still not a live reading or highlighting observation.
   - **The skipped-code position is unchanged and still speaks such a span.**
     Silencing a soft-wrapped span under `skipInlineCode` is a separate,
     pre-existing gap tracked on its own ticket, so that path is left byte for
     byte as it was and pinned in a test rather than changed here.
     *Superseded by the NRL-44 amendment below.*

   **Amended by NRL-44: the confirmed region is verbatim, and silent when code
   is skipped.** NRL-42 made `%%` and `<!--` literal on a continuation line by
   testing `i >= literalCodeEnd` in the comment branch. That was the only branch
   in the per-line scanner that tested it, so every other construct was still
   read as markdown inside the span. Measured against the single-line-span
   oracle, which has always been verbatim and option-independent: **18 of 21
   inline constructs were re-interpreted** - `**bold**`, `*em*`, `_em_`,
   `==highlight==`, `$math$`, `$$math$$`, `<html>`, `![[embed]]`, `[[wikilink]]`,
   `[^fn]`, `![img](d.png)`, `[link](d.png)`, a bare URL, `<autolink>`, `#tag`,
   `~~strike~~` and both backslash escapes. Only `%%`, `<!--` and `:emoji:` were
   correct. So:

   - **Inside a confirmed soft-wrapped span nothing is re-interpreted as
     markdown.** The region is emitted verbatim before the branch loop runs, not
     guarded branch by branch. Eighteen guards is eighteen chances to miss one,
     and the set is not closed - the next construct added to the scanner would
     have needed a nineteenth. This is not a new rule for continuation lines, it
     is the single-line rule finally reaching them.
   - **Under `skipInlineCode` the region is silenced whole**, which is what the
     toggle's name says and what a single-line span already does. It is also the
     safe direction: a silenced region cannot disclose anything, whereas the
     disclosure hazard the NRL-42 amendment guards against exists only when the
     region is spoken. The gap left behind is exactly one mapped space.
   - **The opening line is not covered.** `cleanLine` runs on the line
     that opens the span before `codeSpanClosesLater` has confirmed it, so at
     that moment the run is unmatched, and an unmatched run is literal text whose
     tail must be spoken. Silencing or literalising that tail without the
     confirmation would delete visible prose. Confirming before cleaning is a
     restructure of the per-line loop, tracked as NRL-64 and pinned in a test.
     *Superseded by the NRL-64 amendment below.*

   **Amended by NRL-64: the opening line is covered too, by confirming before
   cleaning.** The gap above was an ordering gap, not a rule gap. `extractChunks`
   now cleans a paragraph line once to learn the length of the unmatched run it
   leaves open, asks `codeSpanClosesLater` that same question with the identical
   call the two old arming sites made, and only then cleans the line a second
   time with the confirmed length. So:

   - **The region `[runEnd, end-of-line)` on the opening line is the same region
     as `[0, closerRun)` on a continuation line**, emitted by the same code:
     verbatim when inline code is spoken, one mapped space when it is skipped.
     `` Before `a %%b%% c `` / `` d` after. `` speaks `Before a %%b%% c d after.`
     and is silent as `Before after.` under `skipInlineCode`, which is what the
     single-line span `` `a %%b%% c d` `` has always done in both positions.
   - **`codeSpanClosesLater` and `interruptsParagraph` are untouched**, which is
     the whole reason this is safe. The call moved earlier; the function did not
     change, and neither did the value passed to it. An unmatched run with no
     confirmed closer still arms nothing, so the clause above about hidden text
     stands exactly as written.
   - **The `blockType === "paragraph"` test is now at the single confirmation
     site, and it is redundant belt-and-braces there rather than load-bearing.**
     It used to be explicit at one arming site and implicit at the other, where
     an early return did the work. The rule it states - a carry is never armed
     off a heading, a quote or a list line, because a span cannot leave the block
     it is in - is real and is pinned by three fixtures. But the test is not what
     enforces it: `blockType` leaves `"paragraph"` only when `HEADING`,
     `BLOCKQUOTE` or `LIST_BULLET` matched the same raw line, and
     `codeSpanClosesLater` runs `interruptsParagraph` over that line first, which
     tests all three. Measured while shipping NRL-64: deleting the test changed 0
     of 9,792 extractions across those shapes. It is kept because it is free and
     because it states the intent where the carry is armed, not because removing
     it would break anything today.
   - **A comment delimiter in the confirmed tail no longer opens a comment, and
     that is not a new disclosure.** The span is confirmed to close later, so the
     renderer shows that `%%` as code. It cannot hide anything either: a line
     that leaves a comment open is an `opensHiddenComment` line, and
     `codeSpanClosesLater` rejects those at both ends, so no confirmation exists
     on such a line in the first place.
   - **The confirmation is armed after the link reference definition drop**
     (ADR 0018). A line that renders as nothing hands on no carry, or the next
     line would be read as the continuation of a span whose opener was never
     spoken.

   Measured, all bare-Node, both sides of the diff built side by side: **0 hidden
   sentinels spoken on either side across 11,264 sweep cells per side** (22 note
   shapes x all 512 content-key combinations) and **0 across 819,200 adversarial
   cells per side** (every unmatched, mismatched, double and triple run shape the
   ticket names, on both sides of a real `%%` and `<!--` block comment, with no
   cell leaking on one side and not the other); the designed-literal class moved
   **0 -> 2,304** spoken, all of them at `skipInlineCode: false`; **0 prose
   sentinels lost**; and `sourceIndex` clean by numeric UTF-16 code-unit index
   over **11,264 + 819,200 cells per side plus 4,000 fuzz notes**. **Nothing was
   observed in Obsidian.**
   - **Neither the closer confirmation nor the paragraph-interrupter list was
     weakened.** They now carry more weight, not less: without the confirmation
     an unmatched run would silence visible prose as well as disclose hidden
     text. The interrupter list is asserted as an invariant by a test rather than
     only relied on, so a future prefix family that is not itself a block opener
     fails loudly instead of opening a hole.
   - **A destination inside the region is spoken, because inside code the raw
     text is the rendered text.** `![alt](dest.png)` on a continuation line now
     reads as itself, delimiters and destination included. That is not a new
     exception to "a destination is never spoken": a single-line span has done
     it since long before this ticket, in both `speakImageAlt` positions. It is
     written down here because it was never written down there.

5. **Output exclusions cannot bypass comment tracking.** Scan skipped heading
   and table bodies for comments before discarding their spoken output.
   Recursively cleaned link labels, wikilink aliases and highlights drop
   complete comments, but their local state cannot open a document-level
   comment or consume subsequent source lines.
   Enclosing label/highlight delimiters inside complete comments or inline
   code cannot end that container. Truncating a comment before recursive
   cleaning would make its hidden remainder speakable.

## Consequences and verification

- Extraction keeps the original source intact. A dropped inline span uses a
  mapped separating space when needed, and subsequent text uses its true raw
  UTF-16 offsets. Multi-line skipping uses fixed line starts, not reconstructed
  or shortened Markdown. Paragraph breaks outside comments retain their pacing.
- **One space at a line join (NRL-42).** Joining soft-wrapped lines into a
  paragraph adds a separating space only when the buffer does not already end
  in one. A line whose last mapped character was itself a separating space, left
  by a dropped comment, image, tag, URL, emoji or a CR, previously produced two.
  The fix lives at the join, the single place that creates the second space, so
  the trailing-space pops in the comment branch and in `verbatimLine` are now
  defensive rather than load-bearing and are kept. Text and index stay in
  lockstep at one entry per character either way.
- Regressions exercise `extractChunks`, including exact visible output,
  first-word offsets after comments, index length/order/bounds, retained
  UTF-16 character correspondence, and chunk start/end bounds. Existing HTML,
  frontmatter, math and code tests remain in place.
- **NOT VERIFIED IN OBSIDIAN.** Implement-phase verification uses the bundled
  real module and local gates. Deployment, actual reading, and highlight
  placement in the real editor are still pending; human verification remains
  required by the ticket's acceptance criteria.
