# 0006. Obsidian comment exclusion

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-38 (R-M08)

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
   keep `%%` when their code setting enables speech, and remain entirely
   silent when skipped. Code parsing precedes comment recognition. Display
   math continues to follow ADR 0004; hidden math inside a comment never
   produces an "equation" announcement.
   Inline code closes only on a backtick run of the same length; an inner
   backtick must not expose literal comment syntax to prose cleaning.

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
- Regressions exercise `extractChunks`, including exact visible output,
  first-word offsets after comments, index length/order/bounds, retained
  UTF-16 character correspondence, and chunk start/end bounds. Existing HTML,
  frontmatter, math and code tests remain in place.
- **NOT VERIFIED IN OBSIDIAN.** Implement-phase verification uses the bundled
  real module and local gates. Deployment, actual reading, and highlight
  placement in the real editor are still pending; human verification remains
  required by the ticket's acceptance criteria.
