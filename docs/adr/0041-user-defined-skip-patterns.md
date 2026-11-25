# 0041. User-defined skip patterns

- Status: accepted
- Date: 2026-11-25
- Ticket: GitHub #271 (R-M09, R-M13)

## Context

A user asked for regular expressions that exclude text from speech (timestamps,
`{{annotations}}`, `Source:` lines), configurable one by one, with invalid ones reported in
settings and highlighting and reading positions left accurate.

## Decision

1. **Patterns match the raw markdown, not the spoken text.** The raw note is what the user sees
   while writing a pattern, and a match is then already a source range.

2. **A match is only a source range.** It joins the ranges `dropHiddenText` already applies to
   every buffer before segmentation, so offsets stay in lockstep (non-negotiable 8) and block
   parsing never sees the pattern. Deleting the text before parsing was rejected: it would move
   every later offset, and a pattern matching `<!--` or `%%` would speak the comment body.
   The ranges also join `strictSpans`, so a footnote kept inside a `%%` block (NRL-212) can still
   be skipped.

3. **Flags are fixed at `gm`, with `u` tried first.** `u` keeps `.` from matching half an emoji,
   but its grammar rejects patterns people type, such as `{{.*?}}`, so those fall back to the
   lenient grammar. A range that would then split a surrogate pair is widened to the whole pair.
   Case-insensitive matching is not offered.

4. **An invalid pattern is stored as typed and ignored on a read.** Its row shows the engine's
   message. That message quotes the pattern, so it is shown only there and never traced.

5. **A buffer that a pattern cut down to punctuation alone yields no utterance** (`{{note}}.`).

6. **`skipPatterns` is a required `ExtractOptions` field** (ADR 0008), and `main.ts` builds the
   options in one place for all three read commands. No data version bump: the key is new, and
   its absence normalises to an empty list.

## Accepted

- **A pattern that backtracks heavily can freeze Obsidian.** JavaScript cannot interrupt a regex,
  and extraction runs on the main thread. The settings row and the README say so. Nothing but the
  user's own pattern can cause it.
- **An inline formula is spoken as "equation", mapped to its two delimiters** (ADR 0004). A
  pattern matching only one delimiter clips that word; one matching the whole formula drops it.
- **A drop between two words leaves one space**, as it does for text Obsidian hides, so
  `foo{{x}}bar` is spoken as two words.
