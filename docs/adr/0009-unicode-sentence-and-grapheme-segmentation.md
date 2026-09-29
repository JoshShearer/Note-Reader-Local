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
2. On English, ICU never adds a boundary the regex lacks, but it does remove
   several: it declines to break after `e.g.`, after `...` and after `U.S.A.`,
   all three of which the regex breaks after. A straight replacement would have
   moved English text in the direction of longer chunks.
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
  sequence**, in either segmenter position, because clause 8 places those cuts
  when ICU is absent.
- **ASCII text is byte-identical.** Proved rather than asserted, by three
  probes against the merge base comparing `text`, `sourceStart`, `sourceEnd`
  and `sourceIndex`, all run in **both** segmenter positions. 1,320 ASCII-only
  string literals scraped out of `tests/extract.test.ts` under all 512
  combinations of the nine content toggles: **1,351,680 comparisons, zero
  differences**. Then 717 generated ASCII shapes clustered around the 220-unit
  cap and the halfway mark, a region the scraped corpus barely touches:
  **20,076 comparisons, zero differences**. The second probe is the one that
  found the clause 6 runt, so it earned its place rather than confirming the
  first. Then at review, a third corpus generated from scratch rather than
  scraped - 290 ASCII fixtures over the same 512 masks and both positions -
  **296,960 comparisons, zero differences**. Clause 4's guard is what makes
  the sentence half structural rather than lucky: where the terminator is
  ASCII, no ICU-only boundary can be admitted at all.
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
- **The offline breaker agrees with ICU on every well-formed input.** Verified
  twice by two independently written sweeps: 632,070 strings during
  implementation and 321,975 more at review, both over awkward alphabets,
  ordered pairs and triples, every BMP code point between two letters, astral
  samples and Devanagari conjuncts. The GB9c tables were derived from
  `Intl.Segmenter` itself rather than transcribed, so the two agree by
  construction. The review sweep additionally fed in **lone surrogates**, and
  there the two differ: the breaker reports a boundary beside a lone surrogate
  where ICU reports none, in 25 shapes, always one extra boundary and never
  one fewer. A file decoded as UTF-8 cannot contain a lone surrogate, and the
  direction of the difference cannot split a well-formed pair, so this is
  recorded rather than chased. The earlier "zero disagreements" claim was true
  of its own corpus, which did not include lone surrogates.
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
