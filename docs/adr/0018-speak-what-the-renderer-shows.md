# 0018. Speak What the Renderer Shows

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-45

## Context

A CommonMark link reference definition is a block-level construct that renders
as nothing. `src/text/extract.ts` had no branch for it, so the whole line fell
through to prose and every part of it was read aloud.

Measured before any change, by bundling the real `src/text/extract.ts` from
`git archive 4c5cf97` with the repo's own esbuild and sweeping all 512
combinations of the nine content keys:

```
[theref]: zdestz.png "ZTITLEZ"   -> theref : zdestz.png "ZTITLEZ"
  1 distinct output across 512 combinations; keys that move it: NONE
[theref]: zdestz.png             -> theref : zdestz.png
[theref]: zdestz.png 'ZTITLEZ'   -> theref : zdestz.png 'ZTITLEZ'
[theref]: zdestz.png (ZTITLEZ)   -> theref : zdestz.png (ZTITLEZ)
[theref]: <zdestz one.png> "T"   -> theref : <zdestz one.png> "T"
> [theref]: zdestz.png "ZTITLEZ" -> theref : zdestz.png "ZTITLEZ"
- [theref]: zdestz.png "ZTITLEZ" -> theref : zdestz.png "ZTITLEZ"

Before [label][theref] after.
[theref]: zdestz.png "ZTITLEZ"   -> "Before label after." | "theref : ... "
```

So no toggle governs it, in either direction, and with the reference actually
used the definition is still read out as a second chunk after the prose that
uses it.

`srs.md` R-M08 says markdown syntax is not spoken unless meaningful to the
content, and R-M09 promises that for an image "the destination and any quoted
title are never spoken". A definition line carrying `dest.png "Title"` reads out
exactly that pair, through a construct neither promise named.

What could not be measured here: that Obsidian's own renderer hides the line.
That is read off CommonMark, not observed.

## Decision

**Speak what the renderer shows.** A link reference definition displays nothing,
so the whole line goes. A footnote definition's body IS displayed at the foot of
the note, so only its `[^1]:` marker goes. Both outputs follow from the one rule
rather than one being an exception to the other.

1. **The definition line is dropped whole** - label, colon, destination and any
   quoted title. Speaking the label alone would be speaking a reference name,
   which is syntax, with only the destination hidden.

2. **Footnote definitions are not covered.** `[^1]: Text.` keeps `cleanLine`'s
   own branch, which drops the marker and speaks the body, and the regex's
   `(?!\^)` is what keeps the two apart. This is consistency with clause 1, not
   an exception to it.

3. **Recognition demands the complete one-line CommonMark shape AND an empty
   paragraph buffer.** A destination is required, and an optional title must be
   the last thing on the line, so `[see also]: not a definition, just a
   sentence` fails the shape and stays spoken. CommonMark also forbids a
   definition from interrupting a paragraph, so `Prose text.` followed by
   `[see also]: whatever` is a paragraph continuation and stays spoken too.
   Recognition requires positive evidence, and leaked markup is preferred to a
   swallowed word (ADR 0007 clause 6).

4. **`interruptsParagraph` and `codeSpanClosesLater` are untouched.** Because a
   definition is only recognised with an empty buffer it can never sit inside a
   paragraph, so adding it to `interruptsParagraph` would change nothing that
   function governs while widening what `codeSpanClosesLater` rejects. That
   function is the one NRL-44 depends on; leaving it alone is what keeps the two
   tickets independent.

   A corollary: when `carriedCode` is live the previous line was a buffered
   paragraph line, so `paraText !== ""` and the new branch cannot fire. A
   soft-wrapped code span can never be truncated by this change.

5. **No content key governs it.** It is unconditional syntax removal, like the
   footnote marker and the comment delimiters. A tenth content key whose "off"
   position speaks a destination aloud would be a setting with one right answer,
   which ADR 0001 clause 6 says not to add. The ticket's "both positions of any
   toggle" criterion is answered by pinning the behaviour across the existing
   512-combination sweep instead.

6. **Recognised inside a blockquote or list prefix.** The check runs on `body`,
   after the prefix peel, at the same place every other construct is tested,
   because the line renders as nothing inside a quote too.

7. **A multi-line definition is out of scope.** A destination on the following
   line has the same per-line-scanner root as NRL-44's whole family, and picking
   it up here would import that refactor. Worst case is unchanged from today: it
   is still spoken.

8. **A definition-shaped line on the second or later line of a blockquote or
   list stays spoken.** The per-line scanner keeps no per-container paragraph
   buffer, so `> Prose.` / `> [r]: d.png` reaches the branch with the global
   buffer empty even though CommonMark treats the second line as a lazy
   paragraph continuation that a definition may not interrupt. `!wasContainer`
   blocks it, which keeps clause 3's empty-buffer half honest at the cost of
   leaked markup - the trade clause 3 already names.

9. **The branch sits AFTER `cleanLine` and after `inComment` is assigned.** Output
   exclusions do not exclude parsing. A title or destination can carry an
   unclosed `<!--`, which opens a comment and hides the rest of the note;
   dropping the line before that was parsed would stop the hiding and make text
   the author hid audible. That is a privacy-direction regression, and it
   outranks the cost of cleaning a line that is then discarded.

   **Amended by NRL-74 (ADR 0025).** The clause is unaffected - parse before you
   drop - but its example no longer holds. `[a]: x.png "<!--"` followed by a
   `ZSECRETZ` line used to speak nothing at all; it now speaks the `ZSECRETZ`
   line, because a mid-line `<!--` with no `-->` anywhere in the note opens no
   block, so there is nothing for the ordering to preserve in that particular
   shape. The clause keeps its pin at `tests/extract.test.ts:960`, the same shape
   with a `-->` four lines down, where the title's `<!--` really is an opener and
   the ordering really does matter; that fixture is green on both sides of
   NRL-74. See also NRL-68: a mid-line opener is not an opener.

10. **A definition shape inside an ATX heading is not dropped.** A link reference
    definition is a leaf block and cannot occur inside a heading, so
    `# [a]: x.png` is inline content the renderer shows. Table rows and fenced
    or indented code already leave the loop before this point, so a heading is
    the only container needing an explicit guard.

## Consequences

- **`prevBlank` is deliberately not set on the dropped line.** A definition
  followed with no blank line by a four-space-indented line therefore still
  speaks that line rather than treating it as indented code. Erring towards
  speaking is ADR 0007 clause 6 again, and it keeps the drop from changing what
  any *other* construct means.

- **`prevContainer` is deliberately left as the prefix peel set it.** A
  definition on the first line of a quote is dropped and the quote's container
  state survives, so a lazy continuation after it still knows where it is. The
  visible cost is that two consecutive quoted definitions behave differently -
  `> [a]: x.png` on line one is dropped, `> [b]: y.png` on line two is spoken,
  because clause 8's `!wasContainer` sees the container the first line set. That
  errs towards speaking, which is the preferred direction.

- **`sourceIndex` stays in lockstep by construction.** The branch `continue`s
  before `appendToParagraph`, so the dropped line contributes zero index entries
  and no space of its own; `sourceIndex.length === text.length` holds with
  nothing to reconcile. The inline mechanism, `pushSpace`, is not on this path.
  If any future variant keeps part of the line, the dropped span must contribute
  exactly ONE mapped space through a single `pushSpace`, never one entry per
  character (AGENTS.md rule 8). Verified numerically: 16,384 runs (32 shapes x
  512 masks), 467,456 UTF-16 code units checked by index, 0 failures on equal
  length, monotonicity, bounds or character identity, plus an assertion that no
  emitted offset lands inside the dropped line's `[lineStart, lineEnd)` span and
  that offsets stay monotonic across the chunk boundary the drop now spans.

- **Probed, not asserted, in the swallowing direction.** This change drops a
  whole line, so the failure mode is a lost sentence rather than a leak. Base and
  patched extractors were bundled side by side and diffed over a 32-shape
  sentinel corpus (`ZBEFOREZ`, `ZPROSEZ`, `ZAFTERZ`, `ZFOOTZ`, `ZCODEZ`,
  `ZTITLEZ`, `ZSECRETZ`) x all 512 key combinations = 16,384 cells. Result:
  **8,192 cells changed, every one of them in the 16 allow-listed fixtures**;
  the other 16 fixtures were byte-identical in all 512 masks. In every changed
  cell the patched output is a strict character-level deletion from the base
  output (no character added), and every removed character came from the
  recognised definition line. **0** sentinels swallowed outside a dropped
  definition line and **0** hidden sentinels made audible. The only sentinel
  drops are `ZTITLEZ` occurrences that sit inside the dropped definition lines
  themselves, which is the point of the change.

- **One pre-existing shape found and not fixed.** `[a]: x.png "%%"` followed by a
  `ZSECRETZ` line speaks `ZSECRETZ` - byte-identical before and after, because an
  Obsidian block-comment opener needs `%%` with only whitespace before it, and a
  `%%` inside a quoted title is an unmatched inline opener that stays literal
  (ADR 0006). The definition line itself now goes; the disclosure is unchanged
  and is not caused by this ticket.

- **`[a]: <!--` is not a definition** - the destination may not start with `<`
  unless it is a closed `<...>` - so it is still spoken as `a :`. It was
  "unchanged in both directions" when this was written and **NRL-74 changed the
  second half**: the `<!--` is mid-line with no `-->` anywhere, so it no longer
  hides the rest of the note and the note is spoken (measured `"a :"` ->
  `"a : <!-- ZSECRETZ sentence here."`). The definition-recognition half is still
  unchanged. Whether either of these shapes was ever a disclosure turns on
  NRL-68's already-recorded finding that a mid-line opener is not an opener; after
  NRL-74 the `<!--` and `%%` siblings agree, which is what that ticket was for.
  See ADR 0025.

- **NOT VERIFIED IN OBSIDIAN.** Every measurement above is bare Node against the
  real extractor, per the ticket's own caveat. That Obsidian's renderer hides
  this line is read off CommonMark, not observed, and per AGENTS.md rule 11 that
  limitation ships with the change.

## Alternatives considered

- **Speak the label only.** Rejected: a reference name is syntax, not prose, and
  the result would be a noise word with the destination hidden - worse than both
  the current behaviour and the drop.

- **Add a tenth content key.** Rejected by clause 5. Its "off" position would
  read a destination and a title aloud, which is the thing R-M09 exists to stop.

- **Reuse `interruptsParagraph` for the check.** Rejected by clause 4. It would
  widen `codeSpanClosesLater`'s rejection set as a side effect and couple this
  ticket to NRL-44.

- **Drop the line before `cleanLine` runs.** The cheaper spelling, and rejected
  by clause 9: it turns an author's unclosed comment into audible text.

- **Handle the multi-line form.** Rejected by clause 7: it needs the per-line
  scanner replaced, which is a separate piece of work.
