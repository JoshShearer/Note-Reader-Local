# 0021. Comment spans in a wikilink target

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-67 (R-M08, R-M09)

## Context

`%%...%%` and `<!-- -->` are hidden text. R-M08 promises they are never spoken,
and NRL-38 was written to keep that promise. A `[[wikilink]]` or `![[embed]]`
target broke it, because the target is one of the few places where text reaches
the output through a **raw emission path** rather than through `cleanLine`.

The raw emission is deliberate, and the comment above the loop in
`src/text/extract.ts` says why: the target is a path, not prose, so re-cleaning
it would run the tag branch over it and eat `#Section` when `stripTags` is on.
That is also what makes `sourceIndex` cheap here - each character of the target
is emitted by `emit(c, rawStart + k)` at its own raw offset, with no second
coordinate system to map back through.

Measured before any change, by bundling the real `src/text/extract.ts` from this
tree at `51a20c8` with the repo's own esbuild and running it in bare Node. The
four core rows are identical in all 512 combinations of the nine content keys;
the embed rows need `speakEmbeds` on to speak at all.

```
[[a/b%%SECRET%%]]          -> b%%SECRET%%        (1 output across 512 combos)
[[a/b<!--SECRET-->]]       -> b<!--SECRET-->     (1 output across 512 combos)
[[a/b%%SECRET]]            -> b%%SECRET
[[a/b#Section%%x%%]]       -> b Section%%x%%     (the `#` fragment leaks too)
[[a/b%%x%%#Section]]       -> b%%x%% Section
[[a/b%%x%%#^blk]]          -> b%%x%%
[[a%%/%%b]]                -> %%b
[[%%SECRET%%]]             -> %%SECRET%%
[[a/b%%x%%.png]]           -> b%%x%%.png
[[a/b.png%%x%%]]           -> b.png%%x%%
![[a/b%%SECRET%%]]         -> b%%SECRET%%
![[a/b%%x%%.png]]          -> (silent)
![[a/b.png%%x%%]]          -> (silent)
![[a/b%%x.y%%]]            -> (silent)
[[a/b|label %%SECRET%%]]   -> label              (already correct, 512/512)
```

Two of those rows set the shape of the fix rather than merely illustrating it.
`[[a%%/%%b]]` speaks `%%b`, because `finalSegment` splits on the `/` that is
*inside* the comment, so the emission window opens on a **closing** `%%`. And
`[[a/b#Section%%x%%]]` leaks from the heading fragment, which is past the `#`
and so outside the part of the target that `finalSegment` ever looks at.

The alias half has always been correct: `cleanLine` runs on an alias, so a
complete span inside one is already dropped. It was correct by accident of which
code path it took, and nothing asserted it.

NRL-46 pinned this as a pre-existing defect rather than fixing it, on the ground
that re-cleaning a target is a different decision with its own consequences for
the offset mapping. This is that decision.

## Decision

**A comment span inside a link target is silent, delimiters and content, and the
visible text around it is still spoken - but the target is still emitted raw.**

1. **Scan, then skip; do not clean.** `commentSpans()` scans the target once,
   left to right, pairing `%%` with the next `%%` and `<!--` with the next
   `-->`, and returns half-open raw ranges that include both delimiters.
   Comments do not nest and the two kinds cannot close each other's spans
   (ADR 0006 clause 3). The existing emission loop then skips a range by
   advancing its own index `k` past it. The target is **not** routed through
   `cleanLine`, for the reason recorded above it: the tag branch would eat
   `#Section` under `stripTags`.

2. **`sourceIndex` is preserved by construction, not by a second check.** Every
   surviving character is still emitted by the same `emit(c, rawStart + k)` at
   its true raw offset, and `k` only ever increases. So
   `sourceIndex.length === text.length`, monotonicity, in-bounds and character
   identity all hold for exactly the reason they already held for the
   trailing-separator skip in the same loop - a skipped span emits nothing at
   all, rather than emitting something that then needs a mapping. The invariant
   is one entry per emitted character, with a dropped span contributing at most
   one mapped separating space, never one entry per dropped character. No space
   is pushed for a skipped span here: both call sites already `pushSpace` either
   side of the label, so the words around the link stay separated.

3. **The scan spans the whole target: `[innerStart, targetEnd)`.** It starts at
   the target and not at the final segment, because `[[a%%/%%b]]` would
   otherwise open the window on a closing `%%`, read it as an unmatched opener
   and silence the visible `b`. It ends at the target and not at the `#`,
   because the heading fragment leaks too. Both halves were measured, not
   reasoned; the rows are in Context.

4. **An unmatched opener is target-local.** It silences from itself to the
   closing bracket and no further. The span list is a local array and
   `openComment` is never assigned from this path, so a comment opened inside
   brackets can never consume a later source line (ADR 0006 clause 5). A closer
   found *past* the target is not a closer for it - a guard rather than a
   measured case, since `inlineContainerClose` already skips comment spans when
   it hunts for `]]` and so declines to recognise most constructs that could
   reach it. It is kept because the alternative is a span whose end is outside
   the region the loop walks.

   Silencing it at all is a deliberate divergence from ADR 0006 clause 2, which
   keeps an unmatched **inline** opener literal. Clause 2's reason is that
   hiding one would silently discard visible prose. Inside a target, what is
   discarded is a path fragment bounded by `]]`, so the loss clause 2 weighs is
   bounded to one link while the disclosure it would otherwise permit is not.
   `[[a/b%%SECRET]]` therefore reads `b`: the visible text before the opener
   survives, exactly as clause 1 requires, and the rest goes.

5. **Classification stays on the RAW target. Stripping is emission-only.**
   `isFileTarget` and `finalSegment` keep seeing the target as written. This is
   the decision that needed taking rather than assuming, because a comment can
   hide or reveal the dot that decides whether a target names a file.

   For the two obvious shapes the question is moot, since the dot is in the
   visible part and both views agree: `[[a/b%%x%%.png]]` and `[[a/b.png%%x%%]]`
   both read `b.png`, and `![[a/b%%x%%.png]]` and `![[a/b.png%%x%%]]` both stay
   silent. The shape that forces the rule is `![[a/b%%x.y%%]]`. Its raw final
   segment is `b%%x.y%%`, which has a dot, so it is a file and is silent today.
   On a comment-stripped view the segment is `b`, which has no dot, so it is a
   note - and the embed would **start speaking**. That is a silent-to-spoken
   move, the one direction ADR 0008 clause 5 says this must not fail in.

   Keeping classification raw makes this change able only to **remove** spoken
   characters and never to add one, which is the same property the sentinel
   probe asserts. The two are one decision, not two.

   **`#^blockid` is classification too, and it took a second pass to see it.**
   A block id ends the label, and where it ends is now computed from the raw
   target before the loop runs rather than by the loop noticing `#^` as it
   walks. The first cut of this change left the old in-loop `break`, so a `#^`
   written *inside* a comment span was skipped along with the span and the
   label ran on past it: `[[a/b%%x#^%%SECRET]]` spoke `b%%x` before and
   `bSECRET` after - text the base silenced becoming audible, the exact
   direction this decision exists to prevent, and it slipped through because
   the first probe corpus had no template with `#^` inside a span. Found by
   `/critique` and fixed there, with the four shapes pinned in
   `pin-comment-inside-target` and the templates added to the probe.

6. **The alias path is untouched, and now asserted.** `cleanLine` already drops
   a complete span in an alias. No code changes there; a positive assertion was
   added so its correctness stops being accidental.

7. **A URL target needs nothing.** `hostSpan` accepts only `[\p{L}\p{N}.-]` in
   the host, so `%` and `<` stop it: `[[https://x.com%%SECRET%%]]` already reads
   `x.com`, and `[[https://%%S%%x.com]]` already reads nothing. That branch
   returns before the emission loop and was left alone; the sentinel probe
   covers both shapes so the reliance on `hostSpan`'s character class is checked
   rather than assumed.

## Consequences and verification

- **The disclosure closes, in both constructs and all 512 key combinations.**
  A sentinel probe bundled the base `51a20c8` extractor and this one side by
  side over 21 target templates (a comment before, inside and after the final
  segment, straddling a separator, in the `#Section` fragment, before a
  `#^blockid`, either side of the dot, holding a dot of its own, as the whole
  target, beside an alias, in a URL target, doubled, and unmatched in two
  positions) x 2 comment syntaxes x 2 constructs x 2 contexts x 512 key
  combinations = **86,016 cells per side**. Of the 64,512 cells whose sentinel
  must never be spoken, **19,968 leaked on the base and 0 leak now**.

- **The oracle has two classes, and collapsing them would invent failures.**
  The other 21,504 cells put the construct inside an inline code span with
  `skipInlineCode` off, where the raw text is what the renderer shows and the
  sentinel is *deliberately* literal (ADR 0019, ADR 0006 clause 4). All 21,504
  speak it, on both sides, unchanged. NRL-44 measured this trap directly: a
  one-class oracle scores that designed literal as a leak.

- **It can only remove.** Cell for cell, the non-whitespace characters spoken
  after the change are a subsequence of those spoken at base in **86,016 of
  86,016** cells - 66,048 byte-identical, 19,968 changed, **0** where a
  character appears that the base did not speak. That is decision 5 checked
  rather than argued.

- **`sourceIndex` held.** Checked numerically by UTF-16 code-unit index for
  length, monotonicity, bounds and character identity, exempting synthesised
  spaces: **0 failures over 2,275,328 code units on the base and 1,987,584
  after**. The drop in the count is the disclosed text no longer being spoken.

- **The pin was replaced in place, not deleted.** `pin-comment-inside-target` in
  `tests/extract.test.ts` now pins the fix over 21 wikilink and 8 embed shapes,
  keeping NRL-46's paired folder-is-dropped assertion, adding the alias form and
  the three embed shapes of decision 5 as positive guards, and adding a case
  that an unmatched opener does not escape to the next line. 29 of those
  assertions were red before the change.

- **NOT VERIFIED IN OBSIDIAN.** Every number above is bare Node against the real
  extractor. CDP port 9222 was not reachable in this lane, so what Obsidian
  itself displays for `[[a/b%%SECRET%%]]` was not observed. That matters in one
  specific direction, as the ticket said: if Obsidian renders the comment as
  part of the link text, decision 1's choice to speak `b` is still the safe
  answer but is no longer the renderer-faithful one, and it is decision 4 - the
  unmatched opener - that would need revisiting first. Per AGENTS.md rule 11
  this limitation ships with the change rather than being papered over.

- **R-M08 and R-M09 are not recorded as met.** This closes one of the three
  distinct `%%` gaps that were open (AGENTS.md known state). NRL-68's shape was
  since shown to be renderer-faithful rather than a leak, and NRL-45's leftover
  - `[a]: x.png "%%"` followed by a secret line - is untouched here. The image
  shapes NRL-63 and the escape shape NRL-66 are likewise untouched.

- **Two shapes deliberately left alone.** A backslash escape inside a target is
  not honoured by the scan, so `[[a/b\%%x%%]]` treats the `%%` as a real opener;
  the target is a path rather than prose and the emission loop does not honour
  escapes either, so honouring them in the scan alone would make the two
  disagree. And `[[folder/Note\]]` is still read as prose and still speaks its
  folder, because `\]]` stops the wikilink being recognised at all - that is
  NRL-66, pinned separately as `pin-unterminated-by-escape`, and the sentinel
  probe deliberately excludes targets ending in a backslash so the 0 above is
  not quietly borrowing NRL-66's exclusion.

## Alternatives considered

- **Route the target through `cleanLine`.** The obvious fix, and the one NRL-46
  said would need an ADR. Rejected: `cleanLine`'s tag branch eats `#Section`
  when `stripTags` is on, which is the documented reason the raw emission exists
  in the first place. It would also put the target's comment state into a
  function that can set `openComment`, which is the exact escape route decision
  4 rules out by construction.

- **Build a comment-stripped copy of the target and map offsets back.** Rejected
  as strictly more machinery for the same result: a second coordinate system to
  map through is the only way `sourceIndex` can break here, and the skip-in-place
  form has no second system at all. It would also make decision 5 hard to hold,
  because a stripped copy is exactly the view `isFileTarget` must not see.

- **Speak nothing at all for a target containing a comment.** Rejected: ADR 0006
  clause 1 keeps visible text either side of a comment everywhere else, and a
  wikilink whose label vanished would be indistinguishable from one that was
  never there.

- **Gate it on a content key.** Rejected for the standing reason in ADR 0001
  clause 6: hidden text has one right answer, and a key whose "off" position is
  a disclosure is not a setting.
