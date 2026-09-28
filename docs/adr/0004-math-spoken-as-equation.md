# 0004. Math spoken as "equation"

- Status: accepted
- Date: 2026-09-28
- Ticket: NRL-9 (R-M08)

## Context

R-M08 says markdown syntax should not itself be spoken unless it is meaningful
to the content. Math was read as raw LaTeX with pieces missing: bundling the
real module, `$$\int_0^1 f(x)dx$$` returned `"$$int0^1 f(x)dx$$"`, because the
backslash-escape branch ate the `\` and the emphasis branch dropped the `_`.
Reading LaTeX aloud is not useful to a listener, and dropping it silently
leaves a gap in a sentence that the listener cannot account for.

Two traps make a naive fix worse than the bug:

- `$` is currency far more often than it is math. A plain `$...$` matcher turns
  `I paid $5 and then $10 later.` into `I paid equation later.`, which eats
  prose.
- Inline math is far more frequent than display math. A maths-heavy note with
  thirty `$x$` references would say "equation" thirty times.

## Decision

1. **Math is spoken as the single word "equation".** Not raw LaTeX, and not
   silently dropped, with the exception in point 3.

2. **Display math (`$$...$$`) always says "equation".** On one line
   (`$$...$$` with non-blank content) or as a block: a line starting `$$` with
   no closer on it, closed by the first later line containing `$$`. The block
   is its own chunk. Text after the closing `$$` on the close line is read as
   prose. With no closer anywhere it is not a block and the `$$` is text, so a
   stray `$$` cannot swallow the rest of the note. Fenced code is checked
   first, so `$$` inside a fence is untouched.

3. **Inline math (`$...$`) says "equation" only when it is long enough.** The
   content is counted in tokens: a `\name` command is one token, and each
   other non-space, non-brace character is one. 4 or more tokens speaks
   "equation" (`$E=mc^2$`, `$a^2+b^2$`). 3 or fewer is dropped (`$x$`,
   `$x_1$`, `$x^2$`, `$\alpha$`), because a single symbol announced as
   "equation" is noise, and dropping it rarely loses the sense of a sentence.

4. **Currency heuristic: an inline span needs positive evidence of math.**
   When in doubt it is left as text; a missed equation costs a few spoken
   symbols, an eaten sentence costs the content. A `$` opens math only if:
   - the next character is not whitespace and not `$`;
   - the first unescaped `$` after it on the same line is the closer, the
     character before the closer is not whitespace, and the character after
     it is not a digit (`$5-$10` stays text);
   - the content contains one of `\ ^ _ { } = + < >`, or is exactly one
     letter (`$5$` stays text).

   If the first closer fails, the opening `$` is emitted as text and the scan
   moves on, so a later `$` can still open a span. `I paid $5 and then $10
   later.` is spoken verbatim. `\$` still speaks a literal `$`.

5. **Math is consumed from its opening `$`.** The math branch runs after the
   escape and inline-code branches and before every other markup branch, so a
   `\` inside math never reaches the escape branch and an `_` inside it is
   never emphasis. Math inside backticks is code and read as written when
   inline code is spoken.

## Consequences

- "equation" is synthetic and has no raw character of its own. Its first
  seven letters map to the opening `$` and its last letter to the final
  closing `$` (for a block, the second `$` of the closing line's `$$`).
  `words.ts` highlights `[sourceIndex[first], sourceIndex[last] + 1)`, so the
  editor highlight covers exactly the math span, and the index stays
  non-decreasing. A dropped short span only advances the cursor. Tests pin the
  highlight range for inline, same-line display and block math, and the raw
  offset of the word after each form.
- Known misses, accepted:
  - Short spans that carry meaning are dropped: `$x+y$` (3 tokens) and
    `$\frac{a}{b}$` (3 tokens, braces are not counted) are silent.
  - Currency written with a closing dollar and a letter or operator between,
    such as `$5+$`, is uncommon but is treated as math and dropped.
  - `$` spans that the heuristic rejects are read as written, including their
    LaTeX, for example `$ x^2 $` with spaces inside the delimiters.
  - A `$$` block opened inside a list item or blockquote is not recognised as
    a block; only a line whose trimmed text starts with `$$` is.
- Obsidian renders some of the rejected spans as math. The trade is
  deliberate and in the direction of reading text rather than losing it.
