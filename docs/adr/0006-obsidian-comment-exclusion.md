# 0006. Obsidian comment exclusion

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-38 (R-M08); clause 4 amended by NRL-42 and NRL-44

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
   (allowing whitespace), an unmatched `%%` opens a block that hides through
   the first later `%%`, or through EOF when none exists. Apply this to the
   line body after structural prefixes are peeled and to closing-line prose
   remainders. An unmatched inline `%%` remains literal and does not consume
   later lines. A lone `%` and backslash-escaped openers remain literal.
   Hiding every unmatched inline opener would silently discard visible prose;
   speaking unclosed blocks would disclose renderer-hidden content.

3. **Only the active comment's first matching closer ends it.** Comments do
   not nest. HTML comments end at `-->`; Obsidian comments end at `%%`.
   Delimiters of the other kind, escapes, backticks, fences, math and blank
   lines inside a comment are just hidden content, with no parser-state
   changes. Existing unclosed HTML comments continue to hide through EOF.

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
   - **A line that opens a comment also stops the search.** That is an opening
     `%%` with only whitespace before it and no `%%` closer on the line, or a
     `<!--` with no `-->` on the line: exactly the two shapes that hide the
     lines after them. Obsidian 1.13.7's Reading-view parser puts `comment` in
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
   - **The opening line is still not covered.** `cleanLine` runs on the line
     that opens the span before `codeSpanClosesLater` has confirmed it, so at
     that moment the run is unmatched, and an unmatched run is literal text whose
     tail must be spoken. Silencing or literalising that tail without the
     confirmation would delete visible prose. Confirming before cleaning is a
     restructure of the per-line loop, tracked as NRL-64 and pinned in a test.
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
