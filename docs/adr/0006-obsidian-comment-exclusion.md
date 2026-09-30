# 0006. Obsidian comment exclusion

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-38 (R-M08); clause 4 amended by NRL-42, NRL-44, NRL-64, NRL-74 and
  NRL-95; clause 2 amended by NRL-68, NRL-73, NRL-74 and NRL-95

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
   (allowing whitespace) **and with no further `%` before the end of that
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

   One known miss, not opened by NRL-73 and not fixed by it: the line-start half
   uses `.trim()`, which accepts a **tab**, where the tokenizer's skip loop
   accepts charCode 32 only. So `\t%%` opens a block for us and not for Obsidian.

   This was read off the installed parser's own source and was **NOT observed
   live** in Obsidian - the same standing this ADR's other tokenizer citations
   have. Every number above is bare-Node measurement against base `bb77b77`.

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
