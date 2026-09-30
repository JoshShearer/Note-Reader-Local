# 0019. The literal region of a soft-wrapped code span

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-44 (R-M08, R-M09); amends ADR 0006 clause 4, which NRL-42 amended before it;
  clause 3 amended by NRL-64, which also amends ADR 0006 clause 4 again

## Context

`cleanLine` scans one source line at a time. A backtick run left unmatched on one
line and closed on a later line of the same paragraph is one code span in the
renderer, but two unrelated lines to the scanner. NRL-42 taught the scanner about
that case for comments only: it carries the run length forward, confirms with
`codeSpanClosesLater` that a later line really closes it, and then treats
`[0, literalCodeEnd)` on each continuation line as code content in the comment
branch, so a `%%` there stays literal instead of hiding the rest of the note.

The comment branch was the only branch that learned this. Every other branch in
the same loop kept reading code content as markdown. Two symptoms were already
written down - a mismatched-length backtick run swallowed (N2), a backslash
escape eaten (F4), an autolink dropped (F7) - and the ticket carried them as
three separate bullets, which invited three separate guards.

Before writing any code, the real `src/text/extract.ts` from `8d7fdce` was
bundled with the repo's own esbuild and every inline construct pushed through the
continuation line of a confirmed span, with the same construct in a **single-line**
span as the oracle. A single-line span is already fully verbatim and fully
option-independent - measured at `8d7fdce`, `` `https://x.com/p` `` speaks the
whole URL under `speakUrls: false`, `` `#tag` `` speaks `#tag` under
`stripTags: false`, `` `![alt](d.png)` `` speaks the raw construct under
`speakImageAlt: false`. The result: **18 of 21 constructs were re-interpreted**
inside the region - `**bold**`, `*em*`, `_em_`, `==highlight==`, `$math$`,
`$$math$$`, `<html>`, `![[embed]]`, `[[wikilink]]`, `[^fn]`, `![img](d.png)`,
`[link](d.png)`, a bare URL, `<autolink>`, `#tag`, `~~strike~~`, `\%%` and `\*`.
Only `%%`, `<!--` and `:emoji:` were correct, the first two because the comment
branch was the one that tested `literalCodeEnd` and the third because no branch
consumes it.

Separately, `skipInlineCode: true` neither silenced such a span nor kept it
literal: it spoke the prose and dropped the markup, which is the behaviour of
neither toggle position.

## Decision

1. **Inside a confirmed soft-wrapped span nothing is re-interpreted as
   markdown.** The region `[0, literalCodeEnd)` is emitted once, before the
   branch loop, with `verbatimLine`'s emit rule: every non-space character at its
   true offset, every whitespace run collapsed to one mapped space carrying the
   offset of the run's first character.

   This is written as a simplification and not as a list of exempt constructs,
   deliberately. Eighteen `i >= literalCodeEnd` guards is eighteen chances to
   miss one, the set is not closed, and the enumeration above is the evidence
   that per-branch guarding could never have been complete: the three branches
   that were correct were correct by accident of which ticket touched them. N2,
   F4 and F7 close as three of eighteen symptoms of one cause.

   `verbatimLine` is not called, only copied from: it pops its own trailing space
   for the paragraph join, which is right on the fenced-code path and wrong
   mid-line here.

2. **Under `skipInlineCode` the region is silenced whole**, leaving exactly one
   mapped space so the words either side do not run together - the same shape as
   the existing unmatched-run drop. Three reasons: it is what the toggle's name
   says, it matches what a single-line span already does, and it is the safe
   direction. A silenced region cannot disclose anything, whereas the disclosure
   hazard NRL-42's ship phase found a HIGH defect in exists only when the region
   is spoken.

   Two consequences. The `carrying` gate no longer tests `!opts.skipInlineCode`,
   and the unmatched-run length is now reported as `openCode` in both toggle
   positions, because the length of an unmatched run is a fact about the source
   rather than about whether we speak it. And a continuation line lying wholly
   inside the region now cleans to the empty string, so the carry is re-armed
   before `extractChunks` drops an empty line, or the span's closing line would
   be read as fresh prose - the very thing the silence was for.

3. **The opening line is out of scope and stays as it is.** `cleanLine` runs on
   the opening line before `codeSpanClosesLater` has confirmed the span, so at
   that moment the run is unmatched; an unmatched run is literal text in
   CommonMark and its tail must be spoken. Silencing or literalising it without
   the confirmation would delete visible prose from any line containing a stray
   backtick. Confirming before cleaning is a restructure of the per-line loop and
   is tracked as **NRL-64**, pinned by `pin-nrl64-opening-line`.

   **Amended by NRL-64: the opening line is now in scope, and the reasoning above
   is why the fix had to be an ordering change.** The constraint was never that
   the tail should be spoken as prose; it was that nothing on that line yet knew
   the run was confirmed. `extractChunks` now cleans the line once to learn the
   run length, calls `codeSpanClosesLater` with the identical arguments, and
   cleans the line a second time passing the confirmed length as a new sixth
   `cleanLine` parameter, `outgoingCode`. The tail `[runEnd, end-of-line)` is
   then emitted by **the same region emitter** as `[0, literalCodeEnd)`, so the
   two halves of a soft-wrapped span are provably one rule rather than two
   similar ones - verbatim when code is spoken, one mapped space when it is
   skipped. Three things this deliberately does *not* do: it does not give
   `cleanLine` a lookahead callback, which would make it document-aware, where a
   second pass keeps it line-local but for one scalar; it does not touch
   `codeSpanClosesLater` or `interruptsParagraph`, so clause 4 below stands
   unchanged and an unconfirmed run still arms nothing; and it does not arm the
   carry before the link reference definition drop (ADR 0018), because a line
   that renders as nothing must hand on no span.
   `pin-nrl64-opening-line` keeps its name and its source and now expects
   `Before a %%b%% c d after.`; `pin-skipped-code` now expects `Before after.`
   Both are consequences of the rule, and both match their single-line oracle.
   A second confirmed-carry kind - a soft-wrapped image or link, NRL-63 - would
   attach at the same site: another `confirmed*` scalar computed between the two
   passes and another parameter consumed by the same emitter.

4. **`codeSpanClosesLater` keeps its mandatory confirmation, and
   `interruptsParagraph` is not touched.** (Amended by NRL-74: that predicate is
   now **narrowed** - the opposite direction to the widening this clause and ADR
   0023 warn against - and gains a second, document-scoped parameter. This
   clause's conclusion is unchanged, and `codeSpanClosesLater`'s body was proven
   byte-identical to base modulo the threaded argument; see ADR 0025.) The
   confirmation now carries more
   weight, not less: before this change, arming the carry without it would have
   read hidden text aloud; after it, the same mistake would also silence visible
   prose. `opensHiddenComment` tests the raw line and models no structural
   prefix, which would be a hole if any prefix family were not itself a paragraph
   interrupter. None is, so instead of a speculative code change (F5) there is a
   behavioural invariant test: `HEADING`, `BLOCKQUOTE`, `LIST_BULLET` and
   `TABLE_ROW` must each stop a span carrying across them. Mutation-checked - each
   family removed from `interruptsParagraph` in turn fails exactly its own
   assertion, and makes the sentinel audible.

5. **A destination inside the region is spoken, because inside code the raw text
   is the rendered text.** `![alt](dest.png)` on a continuation line now reads as
   itself. This is not a new exception to "a destination is never spoken"
   (R-M09, ADR 0017): a single-line span has spoken it in both `speakImageAlt`
   positions since long before this ticket. It is recorded here because it was
   never recorded there.

## Consequences and verification

- **Enumeration, after**: 0 of 21 constructs re-interpreted, against the same
  single-line-span oracle. Was 18 of 21 at `8d7fdce`.
- **Disclosure probe, two classes.** 5 backtick shapes (single, double, triple,
  and both length mismatches) x 10 comment placements x all 512 masks of the nine
  content keys = 25,600 extractions, with a *hiding* sentinel (text a genuine
  block opener hides) and a *literal* sentinel (a pair closed on its own line
  inside a spoken span, audible by design per ADR 0006 clause 4). Measured before
  and after: **hiding 0 -> 0, literal 1,536 -> 1,536**, every literal one at
  `skipInlineCode: false`. The two classes must not be collapsed; a one-class
  sweep over the same bodies reports all 1,536 as leaks, and the plan's narrower
  35-body first cut reported 768.
- **Disclosure probe, extended to the 18 newly-verbatim constructs**: each one
  carrying a sentinel behind a line-start block opener, behind a mid-line `%%`
  (which is literal text, not an opener), and inside an image destination, x 512
  masks = 73,728 extractions. Hiding 0 -> 0. Mid-line-`%%` audibility unchanged
  at 9,216, by-design literal pairs unchanged at 4,608, and the destination class
  0 -> 4,608, all at `skipInlineCode: false`, which is decision 5.
- **`sourceIndex` lockstep** (AGENTS.md rule 8) over 24 corpus rows x 512 masks =
  12,288 combinations, checked numerically by UTF-16 code unit for length,
  `sourceStart`, `sourceEnd`, bounds, monotonicity and character identity. Four
  of those rows are new and cover the region: markdown in it, escapes and URLs in
  it, bracket constructs in it, and a mismatched run.
- **The fixtures failed first.** 28 assertions failed against `8d7fdce` with the
  final fixture set in place and passed after the change. The out-of-scope pins
  (`pin-nrl64-opening-line`, `pin-nrl63-softwrapped-image`), the single-line
  controls, the NRL-42 `guard-*` rows and the F5 invariant all passed in both
  positions, which is what makes them controls rather than fixtures.
- **NOT VERIFIED IN OBSIDIAN.** The renderer oracle is the installed Obsidian
  1.13.7 parser source plus the single-line-span control measured here. Nothing
  was deployed and nothing was heard. AGENTS.md rule 11 applies: a green suite is
  not a claim that this works in Obsidian.
