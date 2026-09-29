# 0009. Unicode sentence and grapheme segmentation

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-28 (R-M10)

## Context

All sentence logic was one regex, `/[.!?…]+["')\]]*\s+/g`. It needs an ASCII
terminator followed by whitespace, and CJK has neither, so CJK was never split.
`Intl.Segmenter` appeared nowhere in the repo. Reproduced by bundling the real
module at the merge base `fb71812` and running it, before any source edit:

```
"这是第一句。这是第二句。第三句结束了。"   -> 1 chunk of 19 UTF-16 units
"这是第一句。" x60 (360 units)            -> 2 chunks, the first exactly 220
                                             units, cut mid-sentence
219 "a" + U+1F600 + 10 "b" + "."          -> 220 + 12, piece one ending in a
                                             lone high surrogate and piece two
                                             opening with its lone low surrogate
219 "a" + "e" + U+0301 + 10 "b" + "."     -> 220 + 12, piece two opening with a
                                             bare combining mark
```

Four facts shaped the design, each measured rather than assumed:

1. ICU segments that Chinese paragraph into three sentences of 6, 6 and 7
   units. All three are below `MIN_CHUNK_CHARS` (40), so `mergeShort` folds
   them straight back into one chunk. **Swapping the regex for a segmenter
   therefore changes nothing at all.**
2. On English, ICU both adds boundaries the regex lacks and removes ones it
   has, and the two are nowhere near symmetric. Measured over 4,000 generated
   English prose fixtures: raw ICU supplies **1,803 boundaries the regex does
   not have**, spread over 1,229 of the 4,000, and declines to supply
   **15,523** that the regex does - it will not break after `e.g.`, after
   `...` or after `U.S.A.`. So on that corpus a straight replacement would
   have moved English in both directions at once, dominantly toward longer
   chunks. What makes the net effect on English nil is not ICU's behaviour but
   clause 4's guard: over those same 4,000 fixtures it admitted **0** of the
   1,803 into the union.

   An earlier version of this line said ICU adds nothing to English. That was
   false, and clause 4 - four clauses down, about the `!` in `[!note]` -
   contradicts it outright. The honest argument is stronger than the one it
   replaces: the union is safe because of the guard, not because ICU is
   conservative.

   **That 1,803-to-15,523 ratio is a property of the corpus, not of ICU, and
   it inverts.** NRL-28's verification found the balance reversed on an
   independently generated English corpus, and the NRL-28 finish pass then
   measured what drives it (`node v24.21.0`, bundling this repo's own
   `legacySentenceBoundaries` against `Intl.Segmenter`, 2026-09-29):

   | Corpus, 4,000 fixtures each | ICU-only | Regex-only |
   |---|---|---|
   | Prose, newline-free | 0 | 1,327 |
   | Prose joined with soft line breaks | 0 | 0 |
   | Markdown: headings, list items, blockquote, blank lines | **24,000** | 0 |
   | Terminator-free lines joined by `\n` | **12,000** | 0 |

   The whole inversion is one effect: **ICU ends a sentence at a hard line
   break and the regex cannot**, because the regex demands `[.!?…]+` before
   the whitespace. On the markdown corpus **100%** of the 24,000 ICU-only
   boundaries sit immediately after a newline.

   Two separate reasons this does not reach the decision, and the first is the
   one that matters most:

   - **`splitSentences` is never handed a newline.** `extractChunks` splits
     the source on `\n` (`src/text/extract.ts:1279`) and `appendToParagraph`
     joins paragraph lines with a space (`:1369`), so the line break is gone
     before the splitter sees the text. The newline-free row is the only row
     describing input this code actually receives.
   - Clause 4's guard admits **0** ICU-only boundaries on every row above,
     including the 24,000, because walking back over the whitespace lands on
     the previous line's last character, which in English is ASCII.

   So state the conclusion as scoped: *on the newline-free English prose the
   splitter is actually given*, replacing the regex would lengthen chunks.
   Stated as a general property of ICU versus this regex it is false.
3. An astral emoji survives `cleanLine`, because the `EMOJI` drop test reads a
   single UTF-16 unit and a lone surrogate is in none of its ranges. So astral
   characters really do reach the splitter.
4. `a` followed by 300 combining acutes is 301 UTF-16 units and exactly **one**
   extended grapheme cluster. A strict 220 cap is therefore unsatisfiable
   without destroying a character.

## Decision

1. **A new pure module, `src/text/segment.ts`, owns all segmentation.** It
   imports nothing, for the same reason `src/ui/affordances.ts` does not:
   bare-Node tests drive it directly, and a node builtin reaching it would
   break mobile (AGENTS.md non-negotiable 7).

2. **Segmenters arrive through an injected `SegmenterSource`, never as a
   global.** `platformSegmenters` feature-detects and caches; `noSegmenters`
   returns `undefined` from all three methods. `extractChunks` takes it as an
   optional third argument defaulting to `platformSegmenters`. Availability on
   the Obsidian WebView is a runtime question, and the alternative - deleting
   `Intl.Segmenter` from the global object in a test - leaks into every test
   that follows.

3. **Sentence boundaries are the UNION of the legacy regex and ICU, not a
   replacement**, because of measurement 2. Each boundary is tagged with
   whether the regex found it.

4. **An ICU-only boundary is accepted only when the terminator before it is at
   or above U+0080.** This was not in the original plan; it was added after the
   first green run, because ICU splits `[!note] Callout body text here.` after
   the `!` - a real Obsidian callout marker - and an English note gained a
   one-character chunk. The guard admits every boundary this change exists for
   (`。`, `？`, `！`, `؟`, `۔`) and by construction can admit none where the
   terminator is ASCII.

   Reaching the terminator takes **two** walks back from the boundary, and
   both were paid for. Whitespace, because ICU counts the space after a
   terminator as part of the sentence it closes. And a closing or final
   punctuation mark (`\p{Pe}`, `\p{Pf}`), because the legacy regex already
   allows a run of closers after its terminator (`["')\]]*`) and that class is
   ASCII-only. The first walk alone shipped in the branch and was caught at
   review by bundling both extractors: with smart punctuation on, which is
   how most English notes are written, `He said “stop.” Then he left.` gained
   an ICU-only boundary that the straight-quoted form does not have and that
   `mergeShort` then refused to fold, so
   `“First.” “Second.” “Third.” Tail text here now.` became four utterances of
   8, 9, 8 and 19 units where the merge base and the straight-quoted form are
   one of 47. `\p{Pf}` and `\p{Pe}` are the Unicode spelling of the regex's own
   closer class, so CJK is untouched: `」`, `》` and `）` are walked over only
   to land on the `。` underneath, which is what admits the boundary.

5. **`mergeShort` may only erase a boundary the legacy regex also found.**
   This is the half of the fix that makes CJK reach the player as sentences,
   per measurement 1. Text with an ASCII terminator is untouched, because
   clause 4 makes every boundary there a legacy one.

6. **`MAX_CHUNK_CHARS` is a target, not a guarantee**, per measurement 4.
   `splitOversized` prefers, in order: the last space past the halfway mark
   (unchanged); then the last word boundary in the window, **subject to the
   same halfway floor**; then the raw cap. Whichever wins is snapped **back**
   to a grapheme boundary. The floor on the word branch is not symmetry for
   its own sake: without it, `"hi "` followed by 300 unbroken characters
   breaks at the only word boundary in the window and emits a three-unit
   chunk, where the cap alone gave 220. That was found by running the real
   module against the merge base over generated shapes, not by any fixture in
   the suite, and it is now pinned by one.

   A shared floor is not enough on its own: the two branches must also floor
   the same **measurement**. The space branch cuts *at* the space rather than
   after it, so the piece it emits carries no trailing space, while ICU puts a
   word boundary one unit past that space. A space at exactly `cursor + 110`
   was therefore rejected at 110 by the space branch and re-accepted at 111 by
   the word branch, and `"a" x 110 + " " + "b" x 300` split as 111/220/80
   where the merge base gives 220/191. A candidate is now walked back over any
   space run it sits behind before the floor is applied, so both branches name
   the same offset for the same cut and the word branch can accept nothing the
   space branch rejected. Found in verification (finding B1) by sweeping the
   planted space across **every** offset in the window: exactly one offset in
   220 fires, which is why three earlier probes that clustered *near* the
   halfway mark all missed it. Sampling a boundary is not testing it.

7. **One indivisible-grapheme exception, with guaranteed forward progress.**
   If snapping lands at or before the cursor, the piece opens with a cluster
   longer than the cap, and that whole cluster is emitted as the piece. It
   cannot be divided, and stopping short would mean no progress at all. The
   301-unit cluster above is emitted whole rather than cut or dropped.

8. **The grapheme fallback is a bundled offline UAX 29 breaker, not code-point
   iteration.** Iterating code points keeps surrogate pairs intact and nothing
   else: it would still orphan a combining mark, halve a flag and cut a ZWJ
   sequence in two. It implements GB3 to GB13 including GB9c, the Unicode 15.1
   Indic conjunct rule.

9. **That fallback may use RegExp Unicode property escapes.** It adds no engine
   floor: `extract.ts` already fails to *parse* without them, via `isWordChar`'s
   `/[\p{L}\p{N}'’-]/u`, so a third property-free tier would be unreachable
   code. `\p{Prepended_Concatenation_Mark}` is the one property V8 lacks
   (verified) and is spelled out as a code-point list. The `v` flag is not used
   either, because it needs an es2024 target and this repo builds to es2022.

10. **`locale` is a required `ExtractOptions` field, fed by `appLocale()`.**
    There is no language detection and no voice selection; both are out of
    scope on the ticket. Required rather than optional for the reason
    CONTEXT.md gives for the nine content keys: an optional field with a
    default is exactly how a dead option hides. `extract.ts` must not import
    `main.ts`, so the value is passed in at the one call site.

11. **A malformed locale tag costs the locale, never the segmentation.**
    `new Intl.Segmenter` throws `RangeError` on a bad tag - measured: `zh-cn`
    and `en-GB` are accepted, `en_US` is not - and Obsidian's `getLanguage()`
    is not contractually a well-formed BCP 47 tag, so construction retries once
    with the host default before giving up.

12. **There is no offline word-boundary fallback.** A word boundary is only
    ever a preference in clause 6, never a correctness requirement, and the one
    case it exists for - a script with no spaces - is exactly the case a
    space-based fallback could not help with.

## Consequences

- **CJK is segmented.** The reproduction's Chinese fixture is 3 chunks, the
  Japanese one 2, and the 360-unit Chinese paragraph is 60 chunks of 6 units
  each, none of them cut mid-sentence.
- **That last number is also the main risk in this change, and it is
  unverified.** 60 utterances where there were 2 is a large change in how the
  `Player` drives an engine, and `mergeShort` deliberately will not fold them,
  because folding is exactly the bug. Chinese sentences really are that short,
  so this is arguably correct pacing, but nobody has heard it. It matters most
  on speechd, which runs one chunk ahead of its own audio (CONTEXT.md), so a
  Stop mid-paragraph now abandons a 6-unit chunk rather than a 220-unit one -
  probably an improvement, still unmeasured. Anyone verifying this should
  listen to a Chinese note end to end before trusting the chunk counts.
- **Right-to-left gains U+061F.** The Arabic fixture goes from 1 chunk to 2:
  the ICU-only `؟` boundary survives, and the ASCII `.` boundary is still
  erased by `mergeShort` exactly as before. Both halves are the design.
- **No chunk can end inside a surrogate pair, an emoji sequence or a combining
  sequence** - in `splitOversized`, which snaps every cut back to a cluster
  boundary in either segmenter position, because clause 8 places those cuts
  when ICU is absent. **It is not true of `splitSentences`, which does not
  snap.** An ICU sentence boundary landing immediately before a `SpacingMark`
  or a combining mark ends a chunk inside a combining sequence, because
  nothing walks a sentence boundary back to a cluster boundary the way clause
  6 walks a hard cut back. Found in verification, non-blocking: it needs a
  sentence terminator followed directly by a combining mark, which is
  degenerate text, and no surrogate pair was split across 32,000 fuzz cases.
  Recorded rather than fixed in this pass, because closing it means giving
  `splitSentences` the same snap and that moves where every boundary lands -
  its own fail-first change, not a line in a repair.
- **ASCII prose is byte-identical. ASCII with no space in a 220-unit window is
  not, and that is clause 6 working rather than a regression.** The
  unqualified claim that stood here was wrong, and both halves of why were
  found by generated corpora rather than by the suite. What is measured:
  - Over **4,000 generated English prose and markdown fixtures** - the shapes
    a person actually writes, with punctuation, headings, blockquotes and
    multiple paragraphs - output matches the merge base in `text`,
    `sourceStart`, `sourceEnd` and `sourceIndex`: **zero differences**.
  - Over a corpus built to break it - 15,751 fixtures sweeping a planted space
    across every offset in the window at four cursor positions, multi-space
    runs, all 29 ASCII punctuation marks at every offset in the second half of
    the window, digit/letter transitions, ten markdown wrappers and 3,000
    seeded random ASCII strings, in **both** segmenter positions, plus 615 of
    those fixtures under all 512 content-toggle combinations: **661,262
    comparisons, 58,835 differences**. Every single one is in text where some
    220-unit window holds no space past its halfway mark.
  That condition is exactly when the space branch has nothing to offer and
  clause 6's word branch is consulted, which is what it exists for: a
  400-character unbroken token with a comma in it is cut after the comma
  instead of blindly at 220. English prose never reaches it, which is what the
  4,000-fixture figure measures. The smallest non-final piece any differing
  fixture produced is **111 units**, so none of *that corpus* undercuts clause
  6's floor.
  Clause 4's guard is what makes the *sentence* half structural rather than
  lucky: where the terminator is ASCII, no ICU-only boundary can be admitted
  at all.

  **The floor is a property of those two branches, not of `splitOversized`.**
  The repair pass measured "minimum non-final length 111 and zero non-final
  pieces ending in a space" over an all-punctuation sweep and that is true of
  the sweep, but it is not an invariant of the code, because the
  grapheme-snap exception below deliberately breaks both halves. Measured in
  the NRL-28 finish pass (2026-09-29, bundled `src/text/extract.ts` at
  `c29e7af`): over 924 fixtures placing one indivisible 301-unit cluster after
  an `a`-run of length 0 to 230, with and without a space before it, in both
  segmenter positions, **478** non-final pieces fall under 111 units, the
  shortest being **1** unit, and **240** non-final pieces end in a space -
  120 in each segmenter position, so it is not the word branch doing it. That
  is the snap walking back to the start of a cluster that straddles the cap,
  which is exactly what the exception is for. Quote the floor as what the
  space and word branches guarantee; the snap overrides it by design.
  The claim this replaces - "1,351,680 then 20,076 then 296,960 comparisons,
  zero differences" - was an artefact of three corpora that all lacked long
  spaceless ASCII runs and all sampled near the halfway mark instead of
  sweeping it. B1 lived in exactly that gap. The counts were real; what they
  covered was narrower than the sentence they were used to support.
- **Non-ASCII punctuation in otherwise-English prose is a separate question,
  and it is where the review found the clause 4 defect.** Scoping it: of the
  BMP characters that, placed between an ASCII terminator and the following
  space, move output away from the merge base, clause 4's second walk removed
  the 77 that are `\p{Pf}` or `\p{Pe}` - the quotes and brackets real English
  uses. What still moves is 1,575 characters: 1,365 combining marks, 94
  `\p{Po}` (which includes `。`, `؟` and `．`, where moving is the whole
  point), 81 opening marks, 33 invisible format characters and 2 halfwidth
  katakana marks. Only the `\p{Po}` group occurs in real prose; the rest
  require a terminator immediately followed by a combining mark or an opening
  bracket, which no natural text produces.
- **The offline breaker agrees with ICU on every well-formed input - since the
  GB9c repair, and not before it.** This claim had already been narrowed once
  at review and was still false. Verification (finding B2) found 15 distinct
  disagreeing well-formed shapes, all of the form
  `consonant + linker + ZWJ + consonant`. UAX 29 gives ZWJ `InCB=Extend`, so
  it may sit inside an Indic conjunct run without ending it; `breakClass`
  classes it as `Grapheme_Cluster_Break=ZWJ`, which it must, because GB11
  needs to see it; and the GB9c state update read the break class, so a ZWJ
  cleared the run and the second consonant started a new cluster.
  `U+0915 U+094D U+200D U+0915` reported a boundary at 3 where ICU reports
  none, and all 100 (linker, consonant) pairs in the module's own tables did
  the same. The tables *were* derived by probing `Intl.Segmenter`, so "they
  agree by construction" was true of the tables and not of the state machine
  reading them - which is the general lesson, not a detail about ZWJ. Fixed
  with an explicit `isIncbExtend` predicate that asks the InCB question
  instead of the GCB one; ZWNJ, which is `GCB=Extend` and `InCB=None`, still
  ends the run.
  Re-measured after the fix, by a sweep written for this pass and reusing no
  earlier harness: **611,870 strings** - every ordered pair and triple over a
  40-code-point awkward alphabet, the full 19 x 19 x 19 linker/consonant cross
  product with ten InCB-relevant fillers between them, every BMP code point in
  five contexts, and 150,000 seeded random strings - **zero well-formed
  disagreements**.
- **Lone surrogates still disagree, and the "25 shapes" this line used to give
  was a property of one corpus, not a fact about the breaker.** A sweep over
  an alphabet that deliberately contains lone surrogates finds 28,971 distinct
  disagreeing shapes in 300,000 strings. What is invariant, and what actually
  makes it harmless, is the direction: across those same strings the breaker's
  boundary set is a **superset of ICU's in every case, 0 exceptions**, so it
  can only ever add a boundary and never remove one, and it therefore cannot
  split a well-formed cluster. A file decoded as UTF-8 cannot hold a lone
  surrogate in the first place. Recorded rather than chased.
- **With no segmenter at all, CJK collapses back to one chunk.** That is the
  honest consequence, and R-M10's "segmentation MAY fall back to paragraphs or
  safe-sized chunks" is what licenses it. Pinned by test so the fallback does
  not quietly grow an English-shaped rule for CJK later.
- `sourceIndex` stays in UTF-16 code units end to end, which is what
  `words.ts` and `ui/highlight.ts` already assume (non-negotiable 8). Six
  existing shared offset loops in the suite were converted from `[...k.text]`
  to numeric `charCodeAt` indexing, behind one `unitsMatch` helper. A spread
  iterates code points, so its index stops matching the `sourceIndex` slot as
  soon as a fixture holds an astral character. Measured on `"x😀yz"` with a
  correct index, the spread form compares the two-unit `😀` against the
  one-unit `raw[1]`, returns false on correct data, and reads only 4 of the 5
  `sourceIndex` slots. It is unusable on astral input in either direction,
  which is why no astral fixture could join those shared corpora before this.
  The conversion is behaviour-preserving for the BMP-only fixtures they hold
  today: the suite's passing-assertion count was unchanged across it.
- The cap assertion that allowed 240 units is replaced by "at most 220 unless
  the piece is a single grapheme cluster". 240 was slack no code path reached.
- **Not addressed.** `findWords` (`src/audio/words.ts:35`) has no separator
  inside a run of Han, so a whole CJK sentence is one word span and the
  highlight covers it for its entire duration. That is a word-granularity gap
  R-M10 does not cover and needs its own ticket. Also unaddressed: the
  `![alt]` trailing-U+FE0F shape, and choosing a voice matching the note's
  language, which the ticket puts out of scope.
- **NOT VERIFIED IN OBSIDIAN.** The reproduction, the fix and every number
  above come from bundling the real modules and running them. No deployment,
  restart or live reading was performed, so audible CJK pacing and following-
  word highlighting on a non-Latin note remain unverified by a human.
