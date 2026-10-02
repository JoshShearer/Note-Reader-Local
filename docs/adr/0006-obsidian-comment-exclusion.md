# 0006. Obsidian comment exclusion

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-38 (R-M08); clause 4 amended by NRL-42, NRL-44, NRL-64, NRL-74 and
  NRL-95; clause 2 amended by NRL-68, NRL-73, NRL-74, NRL-95, NRL-93, NRL-116, NRL-117,
  NRL-113 and NRL-114

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
   the first later `%%`, or through EOF when none exists - **but only within
   the container that holds the opener**: a block opened inside a blockquote or
   a list item ends where that container ends (NRL-118, the amendment under
   clause 5). An opener outside every container keeps the note-wide reach. Apply this to the
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

   **NRL-117 amendment: term C is an AMOUNT, not a boolean, and the amount is a
   stack of character cuts.** NRL-93 shipped term C as `dedentedByList: boolean`
   and named this as its own residual. The boolean is right for one level of list
   nesting and too coarse beyond it: `- item` dedents by two columns, so eight
   spaces leaves six and two tabs leave one, both of which the renderer absorbs as
   lazy prose while we opened a comment block.

   **`opensObsidianBlock` did not change and must not.** Its body is byte-identical
   across NRL-117 and so is its 263,672-triple structural proof; the third argument
   keeps its name and its two values. What changed is the MEANING of `true` - from
   "this line is list content" to that conjoined with "and the item's dedent really
   does leave the lead at the block start a `%%` opener needs" - and the pass that
   computes it. The pass now produces TWO arrays: `listItemContent`, which is the
   pre-NRL-117 array bit for bit and is what NRL-120's setext pass reads, and
   `listDedented`, which is `listItemContent && leadReachesBlockStart(residual)`.
   Keeping them apart is load-bearing rather than tidy: `lazyInList` reading the
   narrowed array would make `setextContent` true on a deeply indented item line,
   which makes a `<!--` literal and SPOKEN - a disclosure out of a change whose
   whole purpose is to refuse.

   **The amount is not a subtraction, and that is measured rather than reasoned.**
   The obvious rule, `columnsOfLead - itemContentIndent <= 3`, was built and
   measured: it DISCLOSED **7,168 cells of a 3,021,824-cell census** in one shape,
   `- outer` / `  - inner` / two tabs + `%%`. Two reasons, both module 745's and
   module 5540's. Module 745 NESTS - the inner list is tokenized out of the outer
   item's already-dedented content, so the dedent runs once per enclosing level -
   and module 5540 spends a budget measured in COLUMNS by removing whole
   CHARACTERS (`while (s && !(s in c)) s--` then `slice(c[s] + 1)`), so a tab goes
   entirely or not at all. Two two-column budgets therefore take both tabs and land
   on column 0, where the subtraction says four columns survive. `leadStops`,
   `listDedentCut` and `itemHeadCols` implement modules 6058, 5540 and 745's `M`
   respectively, including `M`'s odd-prefix pad for a one-digit ordered marker,
   which is why `1. x` budgets five columns where `- x` budgets two.

   **The walk pushes one level per item HEAD, not one per line.** `- - x` is two
   items on one line, module 745 reaching the inner one by tokenizing the outer
   item's first-line content, which `M` restores undedented. Measured before that
   was handled: pushing one level there under-dedents every line below it and the
   predicate then declines an opener the renderer honours - **2,342 cells of newly
   SPOKEN hidden text in a 219,300-cell exhaustive sweep**, which is the one
   direction this change must not move. Bare markers are the other half of that
   class, which is why `ITEM_HEAD`'s gap alternation ends in `$`.

   **Three approximations are kept and every one of them fails toward HIDING**,
   which is the asymmetry NRL-93 named: an under-estimate of the dedent speaks
   hidden text, while declining to narrow only keeps a prose loss that was already
   there. The budget is module 5540's `maximum` rather than the lower `p` it really
   uses, which is the minimum indent over the item's own non-blank lines.
   `interruptList` is not modelled, so a `%%` line indented LESS than the item's
   content indent is taken as item content where Obsidian - which puts `comment` in
   that list - ends the list and makes the line indented code at document level.
   And an item head this file cannot parse pushes a whole-lead budget rather than
   nothing, because a level left off the stack would under-dedent everything below
   it. Measured cost of the first two together: **22 cells of a 667-cell
   renderer-keyed sweep, every one identical on both sides.**

   **Refusal-only is proved exhaustively rather than sampled**, in the shape of
   term A and B's own triple proof and discharging the ticket's requirement that an
   under-estimate be shown impossible rather than merely unobserved: **0 violations
   over 11,438,076 line cells**, spanning every document of up to three lines over
   every string over {space, tab, `-`, `%`, `x`} of length up to three, with the
   pre-NRL-117 array recomputed from the base tree rather than from a
   re-implementation, and with `listItemContent` asserted equal to it in all
   11,438,076. A COMPUTED direction was taken on the disagreements too, over a
   second exhaustive family in which the construct line always carries the `%%` in
   question - 219,300 graded cells, **0 newly lost and 0 newly disclosed**, against
   **5,280** newly disclosed for the disqualified subtraction on the identical
   family, which is what makes the sweep non-vacuous.

   **A blockquote nested INSIDE a list item is out of scope and still divergent.**
   The pass peels `BLOCKQUOTE` before applying any budget, where the renderer
   dedents the item first and peels the quote second, so for `- item` / `  > \t%%`
   the tab is gone before the budget is applied and no indent model can see it.
   That is NRL-114's quote-peel narrowing; 8 such cells stay divergent and 4 close
   here. Four further cells at a four-column quote indent read as disclosures and
   are byte-identical on both sides - pre-existing, not opened here.

   **One cost is in the DISCLOSURE direction and must not be separated from the
   figures above.** Clause 5 used to scope an unterminated `%%` block to the NOTE
   where Obsidian scopes it to the construct holding it, so our openers paired up
   in sequence and DECLINING one shifted the parity of every later one: a block
   that covered lines X..Y covered something else instead, and text the renderer
   hides could become spoken. NRL-93, NRL-116 and NRL-120 each narrowed this
   predicate and are each exposed to it, and each reported 0 cells newly leaking.
   NRL-117 measured the other direction for the first time, and it found a real
   cost: **146 newly disclosed cells in 11 notes of a 12,000-distinct-note fuzz
   x 8 option sets = 388,944 graded cells, against 1,199 disclosures closed**, plus
   491 newly lost against 8,475 closed. (Implement recorded 144 / 1,204 / 512 /
   8,530 on the same instrument and the same seeded corpus; the small differences
   are the four extra option-set masks the re-measure had to choose, the Implement
   run's own four not being recorded. Read the two as the same measurement, not as
   a disagreement.)

   **NRL-118 shipped the container rule in clause 5 before this change merged, and
   that SHRANK this cost rather than leaving it.** Re-measured on the identical
   instrument and identical seeded corpus with the base as the only variable -
   12,000 distinct notes, 388,944 graded cells, 5,856 attribute-bucket cells held
   separately in both arms - the class falls from **146 newly disclosed cells in 11
   notes at base `9bdc74c` to 40 cells in 3 notes at base `dad8de2`**, a 73%
   reduction, while disclosures closed rises from 1,199 to 1,255. Newly lost falls
   with it, 491 to 301, against 8,483 closed. So the net disclosure direction moves
   from 8.2:1 in favour to **31:1 in favour**. Nothing grew in either direction.
   The class is not empty, and the residue is the same mechanism: clause 5's scope
   is now the container, but inside one container our openers still pair up in
   sequence, so declining one still shifts the parity of the later ones in that
   same container.

   It is **attributed by a controlled switch** rather than argued, and the switch
   holds on both bases: capping the corpus at ONE `%%` construct per note gives
   193,904 graded cells with **0 newly disclosed and 0 newly lost at `dad8de2`**
   (0 and 0 at `9bdc74c` too), so none of it comes from the indent model and all of
   it from the pairing. The 1,170 x 512 census, which carries one comment construct
   per note by construction, is **byte-identical across the rebase** - 2,957,312
   graded text cells, 0 newly disclosed, 2,816 newly lost, 155,392 losses closed and
   9,728 of 64,512 attribute cells moved, on both bases - which is the same
   attribution reached a second way. The model's own per-line faithfulness is the
   other half of the control: an ARBITRARY refusal-only narrowing of the same
   boolean discloses **1,424** cells under the identical one-construct cap where
   this one discloses 0, and the disqualified single-subtraction arm of Q43
   discloses **24** there, so refusal-only is necessary without being sufficient.
   Pinned by `pin-nrl117-note-scope-parity-discloses`, which carries both directions
   in one note and whose per-sentinel directions are unchanged across the rebase
   (PROSEB newly disclosed, TAILA newly lost, on both bases), and
   `pin-nrl117-scope-cost-contentless-marker`. One method note worth keeping: the
   first version of that fuzz used `seed * 1103515245 + 12345` in doubles, which
   overflows 2^53 and has a short period - it reported 12,000 notes and generated a
   few hundred distinct ones, and found 0 disclosures for that reason. The
   distinct-note count is now printed so a degenerate generator cannot be mistaken
   for a clean result.

   **NOTHING WAS OBSERVED IN A RUNNING OBSIDIAN.** Every figure above is bare Node
   against the reading-view parser and renderer executed in-process out of the
   installed `app.js` (sha256 `8efbf581...9898`); Live Preview's CodeMirror parser
   is unread, as it is for every ticket in this family, and rule 11 applies.

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
   (`t.charAt(D)===a&&D++` with `a = " "`), 2 cells - **CLOSED by NRL-114 in the
   quote PEEL, and the 2 was far too small; see the NRL-114 amendment below, and
   do not quote the 2.** Our `LIST_BULLET` is
   `/^\s*([-*+]|\d+[.)])\s+/` and its `\s+` eats the whole lead after a marker,
   where module 745's third group takes at most four spaces or one tab, 3 cells -
   **CLOSED by NRL-116; see the amendment below, and do not quote the 3.**
   And an unterminated `%%` is NOTE-scoped for us (clause 5) where Obsidian scopes
   it to the construct that holds it, which is why a `%%` on a list marker line
   silenced the following items. **NRL-118 closed that root**; see the amendment
   under clause 5. The paragraphs below are kept as the record of what was
   measured while it was open.

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
   It was tracked as **NRL-118** and pinned as a TRIPWIRE by
   `pin-nrl118-note-scope-closes-at-another-depth` plus its control. **NRL-118
   closed it**: the pin was retargeted to `""` and renamed in place to
   `pin-nrl118-different-depth-percent-opens-new-block`, and its control did NOT
   move, because with no container the second `%%` really is the first block's
   closer and the renderer displays `SECRET`. The 1,088 cells are 0 on the fix;
   the amendment under clause 5 carries the numbers and their corpora.

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

   (NRL-115, at its merge with NRL-117: the `<!--` twin is now CLOSED for prose
   loss. NRL-115 gives `opensHtmlBlock` a container model of its own,
   `rendererLeads`, which dedents a list item by the renderer's rule and refuses
   the opener on a line module 8776 is never offered. It is deliberately a
   separate model from NRL-117's `listDedented`, which feeds the `%%` predicate
   only (D-73-4). `pin-nrl116-html-twin-tab-lead-still-silenced` and both
   `pin-nrl117-html-twin-*` rows were replaced in place, each re-checked against
   real rendered HTML from the executed reading-view parser; see ADR 0025's
   NRL-115 section. NOT VERIFIED IN OBSIDIAN.)

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

   **NRL-118 amendment: a `%%` block is CONTAINER-scoped, not note-scoped.**
   Obsidian's blockquote and list tokenizers collect their own lines first and
   only then tokenize the content, so a `%%` block opened inside a container can
   never reach past that container's end. Ours used to, and that one root moved
   in both directions: a later `%%` at a different depth closed a block the
   renderer had already ended, so `>> %%` / `%% SECRET` SPOKE `SECRET` (the
   disclosure the ticket was filed High for), and a block that should have ended
   at its container kept hiding displayed text up to the next `%%` (the prose-loss
   half NRL-93 recorded as its cost).

   **The rule, as shipped after the NRL-118 fix pass.** A `%%` block ends where
   Obsidian's own parser ends it, and nowhere else:

   a. **The renderer's block tokenizer is re-run, not approximated.**
      `src/text/obsidianBlocks.ts` transcribes remark-parse 8 as Obsidian 1.13.7
      configures it (`commonmark: true`, `gfm: true`, `pedantic: false`) plus
      the frontmatter, `$$` math, `%%` comment, footnote-definition and block-id
      tokenizers Obsidian registers, out of the installed bundle (`app.js` sha256
      `8efbf581...9898`): the same method order, the same `interruptParagraph`,
      `interruptList`, `interruptBlockquote` and footnote interrupt sets with the
      same option gates, the same container collection loops, and the same content
      rewrites (a quote drops `>` plus one space; a list item drops its marker and
      runs remark's `remove-indentation`; a footnote drops its label), recursing
      exactly where the renderer recurses. It records every `%%` block comment the
      renderer creates, with the note line it starts on and the note line holding
      its last character, using remark's own per-line offset table so a comment
      that ends at the start of a stripped line ends ON that line.
      **Provenance and licensing (added before merge, from the second Verify).**
      Most of the transcribed code is MIT-licensed upstream code as bundled by
      Obsidian: remark-parse 8 (Titus Wormer), and math and footnote tokenizers
      whose structure matches remark-math 3 (Junyoung Choi) and remark-footnotes 2
      (Titus Wormer), identified by structure and not diffed line by line against
      upstream. The MIT notices are carried in the module's header. Obsidian's own
      code is small: the `%%` comment tokenizer (about 25 lines), the block-id
      pattern, the `[^` definition refusal and frontmatter. Those are retyped
      functional transcriptions, not verbatim copies, but they reproduce
      proprietary behaviour closely, and **whether that is acceptable is an owner
      decision recorded as open**, not settled here.
   b. **It is consulted only for a block BOTH parsers open on the same line.** The
      opener is then the same `%%` by construction: in both it is the last `%%` on
      its line with no `%` after it, and a container only ever strips a line's
      prefix. If the renderer's comment runs out of container before any closing
      `%%`, our block ends after the renderer's last covered line. A comment the
      renderer closes with a `%%` needs nothing, because we find that same closer.
      A block the renderer does NOT open (one of our own opener misreads) stays
      note-scoped exactly as before, so no pre-existing opener divergence can be
      made worse by this rule; it is left to its own root.
   c. **The first line past the comment is processed FRESH**, as though no block
      had been open, which is what the renderer does with it: the container's
      parent tokenizes it, and a line-start `%%` there opens a new block. For
      `>> %%` / `%% SECRET` the bare `%%` is an `interruptBlockquote` construct, the
      quotes end on line 1, and a new top-level comment hides `SECRET`.
   d. **An opener outside every container is unchanged**: its renderer comment
      reaches the end of the note or a closer we also find, so nothing moves.
      `%%` / `%% SECRET` still speaks `SECRET`, as the reading view displays it,
      and `guard-nrl118-note-scope-control-no-container` pins that. `<!--` is
      untouched (decision 6): its scopes are a different root (ADR 0025).

   **Why a transcription and not a column model.** The first revision of this fix
   (`26cd7ed`) modelled containers by columns: peel a `>`, compare an indent with
   an item's content column, test a list of interrupter regexes, then patch the
   shapes Ship's fuzz found (eight patches: a break line read as a container, a
   one-column-short break, tab rules, a setext lookahead, uncertain `2.` layers, a
   taint after hidden container endings, a fallback after a hidden `<!--`). An
   independent Verify still FAILED it: seven reduced shapes newly spoke text the
   reading view hides, 244 cells in 74 notes that no `%%` neutralisation could
   attribute to base. Run against the transcribed loops, all seven come from three
   rules that are not column rules at all:

   - **`remove-indentation` dedents an item by its SMALLEST indent, lazy lines
     included**, capped by the content column, and an ordered marker below ten
     whose `lead + marker + spacing` has odd length gains a phantom column (`1. `
     counts as four, `1) ` as three). So under `1. > %%` the line `   \tSECRET` is
     dedented to `SECRET`, a lazy line inside the quote and inside its comment,
     where the column model left `\tSECRET` (indented code, ending the quote). The
     same rule decides `  1. > %%` / `    SECRET`, `   - > %%` / `\tSECRET`,
     `2. x` / `> %%` / `   \tSECRET` and `-    * * *` / `>> %% x` / `    SECRET`.
   - **The list loop counts a marker character it then rejects.** `   ---` under
     `-   %% x` and a blank line: the `-` is tried as a marker, adds its column, is
     refused (no space after it), and the incremented width now reaches the
     content column, so the line CONTINUES the item, blank line and all. The column
     model had this as a "one column short" setext special case with no blank.
   - **Any line indented more than four columns continues an item**, whatever its
     content column (`V = r2 >= indent || r2 > 4`). `     # SECRET` under a
     `  \t- %%` item (content column six) is item content, dedented to `# SECRET`
     inside the comment, not an ATX heading that ends the item.

   None of these is a patch target; each falls out of running the loops. That is
   the "correct in principle" the fix pass was asked for, and the residuals below
   are the places where the EXTRACTOR, not the scope, still diverges.

   **Evidence, all bare Node, base `54c3b7a` (origin/main) against the fix, both
   bundled from copied source with the repo's own esbuild, oracle = real rendered
   HTML from Obsidian's parser and renderer executed out of the bundle (harness
   `selftest.cjs` OK, `app.js` sha256 re-verified). Every sentinel is signed at its
   own position; room is stated; each probe is shown able to fail.**

   - **The transcription against the real parser**, comparing each `%%` block's
     start line, end line and last covered line, 1,650,000 notes in three
     unrelated families, 403,944 of them holding a comment: **0 mismatches**.
     450,000 come from Verify's own generator and a widened variant (more tabs,
     leads, nesting, markers, callouts, footnotes, tables); 600,000 are token soup
     (random markdown-significant tokens, no shape templates, half of it weighted
     to brackets, colons and quotes); 600,000 are a richer soup carrying every
     block family the bundle has, frontmatter, a BOM and CRLF line ends. The
     bracket-weighted soup is what found the one transcription miss this pass
     made, 1 note in 150,000: Obsidian WRAPS remark's definition tokenizer and
     refuses a label starting `^` (footnote syntax), so `[^id` / ... / `x]:y` is
     not one definition swallowing a `%%` line. Fixed, and pinned by a direct
     check. Non-vacuity: a
     transcription whose quote takes no lazy lines mismatches 731 of 20,000 notes,
     and one that dedents items by the content column (the column model's rule)
     mismatches 91 of 20,000. The scan gives up, leaving our own behaviour, on a
     lone carriage return, on a note the bundle would refuse, and past 64 levels
     of container nesting, which bounds its O(depth x length) cost on a
     pathological note (400 nested items: about 0.2 s, then no answer).
   - **The ticket's class** (NRL-93 second Verify's generator, 432 notes x 4
     option sets = 1,728 cells, 1,088 hidden-side room): leaks **1,088 -> 0**,
     loses 0 of 640.
   - **Verify's method at 600,000 notes**: its `gen.cjs` verbatim (300,000 notes)
     plus the widened variant (300,000), each x 3 option sets (default,
     speak-everything, a random mask): 5,688,432 cells, 1,154,197 hidden-side room,
     3,386,261 displayed-side room. Newly spoken: 7,258 text cells and 123
     destinations, **every one reducible to a pre-existing root**: 7,333 by Verify's
     own reduction (some subset of the note's `%%` lines, neutralised, makes BASE
     speak the sentinel while the renderer still hides it) and 48 more by line
     deletion plus neutralisation (a variant with no `%%` at all in which base
     speaks it), **0 not shown**. The usual causes are an opener we misread pairing
     with a later `%%`, a raw unterminated HTML tag the browser swallows, and a
     raw `<!--` that escapes its container. 3,774 newly spoken image alt cells:
     3,719 with the image displayed (alt is an attribute, spoken by design under
     `speakImageAlt`, ADR 0008), and 55 with it hidden, all 55 reducible. Newly
     lost: 22,452 cells, 22,449 pre-existing by subset control at their own option
     set, and 3 (one shape) pinned below with a twin that loses the same text on
     base. Base-to-fix, the fix closes far more than it opens; the classified
     counts above are what matter. `sourceIndex` lockstep: 0 failures over
     25,413,840 UTF-16 units. Can fail, same generator (widened, 30,000 notes,
     292,458 cells, 58,995 room), cells NOT reducible to a pre-existing root:
     no-lazy-quote transcription 1,420 in 428 notes, column-dedent transcription 10
     in 4 notes, a scope that ends every comment on its opener line 6,157 in 1,659
     notes; the fix **0**. (`26cd7ed` itself fails 22 of this pass's NRL-118 test
     checks; it predates three later commits on main, so it is not rerun on this
     fuzz against today's base.)
   - **Ship's independent fuzz**, its own generator: 160,000 notes, 150,642 cells,
     29,264 room. 8 newly leaking text cells and 15 newly spoken destinations, all
     reducible: 21 by `%%` neutralisation and the last 2 (one note) by deletion to
     a comment-free twin, `- > A [x` / `    y](zdestz.png) z`, whose destination
     base already speaks (NRL-88's container-label family). 112 newly lost, 112
     pre-existing by subset control.
   - **Structural census** (10 opener prefixes x 7 continuation prefixes x 9 line
     kinds x 7 sentinels, 4 option sets: 13,720 cells, 1,176 room): disclosure
     **440 -> 0, 0 newly leaking** (the no-lazy-quote arm newly leaks 208). Prose
     loss 5,495 -> 1,602; 176 newly lost = 72 content exclusions + 96 display math
     spoken as "equation" (ADR 0004) + 8 on one note, `> - %%` / `> - Z1` /
     `    %% Z2`, pre-existing (`> - x` / `    %% S` loses S on base).
   - **Cross-carry sweep** (soft-wrapped code spans, link and image labels whose
     opener sits before, on or inside the region where the scope now ends and whose
     closer sits after it; 17,280 notes, 339,840 cells, 115,936 room): **0 newly
     leaking text, 0 newly spoken destinations**; 936 alt-text cells in their own
     bucket. Newly lost 24 = 8 exclusions + 16 literal `](zdestz.png)` tails the
     renderer displays as text and our label carry drops, pre-existing (the
     neutralised twin drops them on base). Can fail: the no-lazy-quote arm newly
     leaks 26,756 and speaks 2,648 destinations.
   - **AC4, NRL-131's shape** over 6 prefixes x all 512 option combinations:
     `ZHIDEZ` lost **512 -> 0** for each list prefix (2,560 cells), `> ` unchanged.
   - **NRL-93's census** (480 cells) and two-arm corpus (2,464 + 896, losses 984
     and 518) identical on
     both arms, 0 new either way; **NRL-73's two-class probe**, 24,576 cells per
     class over all 512 combinations: hidden text spoken 0 on both, displayed text
     lost 0 on both; ADR 0019's literal bucket 256 of 1,024 on both, kept apart.
   - **Invariance**, the structural claim of part b: a note in which the renderer
     has no `%%` comment that runs out of container must produce byte-identical
     chunks (text, `sourceIndex`, `sourceStart`, `blockType`). NRL-93's invariance
     corpus (3,240 notes, 12,960 cells): 152 cells differ, **0** outside such notes.
     The two generators above (200,000 notes, 600,000 cells): 105,604 differ, **0**
     outside such notes.
   - **Code.** `extract.ts` gains 32 lines and loses none, so every existing
     function body, `cleanLine` included, is byte-identical to base. The
     `codeLeadItem` argument the column model added is gone: NRL-116's peel made it
     redundant, and part b keeps a misread opener note-scoped anyway.
   - **`sourceIndex`** by numeric UTF-16 index over NRL-118's 2,124-note corpus x 4
     option sets: 0 failures on both arms (14,320 chunks / 138,672 units base,
     21,457 / 250,824 fix), all four mutators nonzero on both (drop, shift, swap,
     negate). The equation exemption is keyed on the synthetic text.
   - **Runtime** stays linear, and that took two departures from the bundle's
     letter that keep its answers: the table tokenizer looks for a row's pipe
     only up to the row's newline (the bundle searches to the end of the note and
     then compares, which is quadratic on a long note with no pipe), and the
     definition label close is read from a backward table computed once per
     content string (the bundle walks to the next `]` at every `[`-led block: 29 s
     on a 40,000-line note of `[x` paragraphs, now about 0.1 s). Both were shown
     identical to the literal transcription on 600,000 notes. The scan alone runs
     at about 170 ms for 160,000 lines of prose and 590 ms for 160,000 lines of
     dense mixed containers; the whole extraction stays within about 3x base on
     every shape tried, timings noisy. Container nesting is the one cost that
     grows with depth, hence the 64-level bound above.

   **Residuals, named rather than closed, each fail-closed or pre-existing.**
   (1) A line of item content whose `%%` is indented past code depth still opens a
   block for us, because `dedentedByList` is a boolean (NRL-117):
   `pin-nrl118-residual-deep-item-content-opener` (identical on base) and
   `pin-nrl118-residual-code-depth-line-after-item` (`-    %%` / `    %% PROSE`, the
   3 fuzz cells above; its control loses PROSE on base). (2) A raw HTML block whose
   tag never closes is hidden by the browser and spoken by us, comment or no
   comment; `> %%` / `<div\tx` / `SECRET` used to be hidden only because our block
   ran past the quote, and is now pinned as that pre-existing root
   (`pin-nrl118-ship-tab-after-tag-not-html` with a comment-free control). (3) A
   `%%` the renderer does not treat as an opener but we do (NRL-93, NRL-114,
   NRL-159 shapes) keeps base's note scope by part b. (4) `<!--` keeps its own
   scopes. (5) The transcription is of Obsidian 1.13.7; an Obsidian update can
   change any tokenizer, so the differential above must be re-run against a new
   bundle before trusting the scope again.

   **NOTHING WAS OBSERVED IN A RUNNING OBSIDIAN.** Reading view only; Live Preview
   has never been read or run by any ticket in this family, and AGENTS.md rule 11
   applies to every number above.

### Clause 2 amendment, NRL-114: the peel's quote marker rule

The quote PREFIX PEEL, not any `%%` predicate, was the last divergence in this
census's `>` + whitespace position. Obsidian's blockquote tokenizer (module
6234) consumes the `>` and then advances over at most one character, and that
character must be a SPACE (`t.charAt(D)===a&&D++` with `a = " "`). Our shared
`BLOCKQUOTE` is `/^(?:\s{0,3}>\s?)+/`, and `\s` is the JS class, so the peel ate
the tab, put `%%` at offset 0 of the quote body and hid text Obsidian displays.
It was recorded above at **2 cells**; the real member set is the whole of `\s`
(tab, tab-then-space, NBSP, vertical tab, ideographic space) and the context set
is every quote depth, the callout body, a quote in a list item and a three-space
indent.

**The fix is PEEL-LOCAL, which is NRL-98's precedent verbatim: feed the
UNCHANGED predicate a different string rather than moving the shared one.** Two
constants, `QUOTE_LEVEL_PEEL = /^\s{0,3}>[ \r]?/` and
`QUOTE_PREFIX_PEEL = /^(?:\s{0,3}>[ \r]?)+/`, replace `BLOCKQUOTE_LEVEL` (whose
only two readers were the peel) at the peel sites: `containerPrefix`'s all-levels
gate and per-level counter, `peelQuotes`'s budget spend, and
`isSetextContentLine`'s two prefix reads. `BLOCKQUOTE` itself is
**byte-identical**, because `interruptsParagraph` reads it and narrowing that
would move `codeSpanClosesLater` and collide with ADR 0019's F5 guard. The
`listDedented` pass and the `setextContent` listInRun scan deliberately keep the
WIDE constant: for `>\t%%` the wide peel leaves `indented` false where a narrow
one would leave it true, and `indented` true keeps the item run alive, i.e. hides.
Leaving them wide is both the speak direction and unchanged behaviour. Do not
"align" them without measuring.

**The all-levels form must be LITERALLY `^(?:<one level>)+`.** `containerPrefix`
gates on it and then walks the one-level form across exactly what it matched, and
"the iteration consumes exactly `q[0]`" is what licenses `quotes` as a peel
budget. `tests/extract.test.ts`'s NRL-114 section pins the composition, the two
literals, every call site, the deliberate non-sites and the walk property over
585 constructed prefix lines. Re-measured on `9132c3b`: the half-fix that leaves
the gate wide and narrows the counter newly loses **98,304** and newly discloses
**27,136** of the census reconstruction's **5,160,960** sentinel-cells (below)
against the fix, and turns nine fixtures plus checks (a) and (d) red.

**A lone CR is still consumed, and that one character is measured rather than
assumed.** A CR is a line TERMINATOR for the renderer, not whitespace:
`> Plain prose` / `>\r%%` / `> SECRET` renders as
`<blockquote><p>Plain prose</p></blockquote>` with SECRET HIDDEN. Consuming it
puts that `%%` at offset 0 of our body, the same place. Re-measured on `9132c3b`,
a space-only peel newly SPEAKS author-hidden text in **32,256** (and newly loses
**6,144**) of the same 5,160,960 sentinel-cells. A real CRLF file is untouched
either way. Lone CRs elsewhere on a line are a separate, pre-existing model gap,
NRL-164 (below).

**Numbers, re-measured on `9132c3b` and REPLACING 7cdc7b7's** (which were taken
on an older base and in a different unit: cells rather than sentinel-cells; its
`1,612,800 / 89,600 / 30,720 / 17,920 / 6,144 / 11 red` are not to be quoted or
averaged). The census is a RECONSTRUCTION built by construction, not an extension
of NRL-93's 140 cells, which are described but never enumerated: 9 container
contexts x 14 post-`>` whitespace members x 5 constructs x 5 block positions =
3,150 shapes, rendered once each with Obsidian's own parser and extracted under
all 512 content-key masks = **1,612,800 cells, 5,160,960 sentinel-cells** (every
sentinel token in a shape, in every mask, signed against the rendered HTML; a
displayed sentinel in a code, heading, table or math context is excused when its
content key is on). Arms: base = `9132c3b`; 7cdc7b7 alone = base plus 7cdc7b7's
`src/`; fix = this change.

| arm | displayed but silenced | newly lost vs base | hidden but spoken | newly disclosing vs base |
|---|---|---|---|---|
| base | 575,488 | - | 81,408 | - |
| 7cdc7b7 alone | 471,808 | **46,080** | 53,248 | 0 |
| fix | 241,408 | **0** | 49,664 | **0** |

So 7cdc7b7 alone still carries a composed loss on this base (46,080
sentinel-cells), which is why it could not land, and the fix closes 334,080 lost
and 31,744 disclosing sentinel-cells with 0 newly lost and 0 newly disclosing.
Destination and image-alt buckets are 0 on every arm in this corpus.

**What the continuation had to fix, because 7cdc7b7 alone newly lost displayed
text.** Two predicates downstream of the peel had only ever been fed the wide
peel's output; both fixes live in ADR 0025's NRL-114 amendment, summarised here:

- **A container fresh-block line that module 134 makes indented code** (`>\t<!--`,
  `> \t<!--`, `>     <!--`) was still an HTML-block opener through
  `opensHtmlBlock`'s term 2. Masked once, at the array level (`htmlLeadCode`), and
  the same flag vetoes a `%%` opener on such a line and stops a label carry.
- **The term-2 bound read the raw line**, so `> ---`, `> -`, `> ***` and a bare
  `>` never ended the opener's paragraph. `term2QuotedStop` wraps the unchanged
  `endsTerm2Scan` / `endsTerm2Block` with the line's quote levels peeled.
- **`isSetextContentLine`'s quote arm** gets the plain arm's lead rule on the
  quote body (`PLAIN_SETEXT_HTML_OPENER` and not `MODULE134_INDENTED_CODE`, a
  tab-bearing lead only in block position, `inQuoteSetextBlockPosition`), so
  `>  \t<!--` / `> ===` is the `<h1>` the renderer makes.

**Residuals in the same character position**, each identical on base and on the
fix and pinned as a tripwire: (a) `>\t> %%`, a tab BETWEEN levels, which the next
level's own `\s{0,3}` re-absorbs (`pin-nrl114-tab-between-levels-still-silenced`);
(c) `- item` / `  > Plain` / `  >\t%%`, where `opensObsidianBlock`'s
`dedentedByList` term keeps the any-whitespace rule
(`pin-nrl114-quote-tab-in-list-item-still-silenced`). 7cdc7b7's residual (b),
`>\t<!--` on a lazy continuation, had already been closed underneath it by NRL-115
and is now a guard (`guard-nrl114-quote-tab-html-comment-spoken`).

**Unmaskings, accepted only on a defused control.** Three 4,000-note fuzz runs
were made (seeds 20261002, 7 and 99, masks 221 and 0, 24,000 cells); every newly
lost or newly disclosing sentinel-cell against base is a place where base was
right only by ACCIDENT, through the same over-wide peel or opener this change
corrects. Each is accepted only because the fix's output is byte-identical,
modulo the one defused token, to what base already produces on a twin with that
trigger defused. Three pre-existing model gaps account for all of them, each
filed: an unreferenced footnote definition is spoken where the renderer shows
nothing (**NRL-163**); a lone CR is a line terminator for the renderer and not
for our `\n` split (**NRL-164**); and a VT- or tab-bearing `%%` lead inside a
list-and-quote container is an opener for us and not for the renderer
(**NRL-165**, NRL-153's family). One fuzz cell is NRL-137 (a raw `<div>` block
holding a `<!--`). The full table of inputs, twins and outputs is in ADR 0025's
NRL-114 amendment.

**NOTHING WAS OBSERVED IN OBSIDIAN.** Every renderer verdict comes from
executing Obsidian 1.13.7's own parser and HTML renderer in bare Node (`app.js`
sha256 `8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898`),
which is much stronger than transcribing it and is still not the running app;
and it is the READING-VIEW path only, Live Preview's CM6 parser having never
been read or run by any ticket in this family. AGENTS.md rule 11 applies to
every number above. R-M08 is NOT met and the 2-of-16 MUST count does not move.

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
