# 0014. Word granularity inside a CJK sentence

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-47 (R-S03)

## Context

`findWords` located words with one regex, `/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu`.
Han, Hiragana, Katakana and Hangul are all `\p{L}` and none of those scripts
writes an inter-word space, so an entire CJK sentence matched as a single span.
`allocateWordTimings` then handed that one span the whole chunk duration and the
word highlight sat on a full sentence for its full length instead of advancing
through it.

Reproduced before any source edit, by bundling the real `src/text/extract.ts`
and `src/audio/words.ts` at `d7e64df` with the repo's own esbuild and running
them in bare Node (node v24.21.0, `Intl.Segmenter` present). Default
`ExtractOptions` with `locale: "en"`, `allocateWordTimings(chunk, 3000, 1)`:

```
Chinese  "这是第一句。这是第二句。第三句结束了。"
  3 chunks; each 1 span, 1 timing covering the whole span for 2920ms of 3000ms
English  "This is the first one. This is the second one. The third one is over."
  1 chunk; 15 spans, lengths [4,2,3,5,4,4,2,3,6,4,3,5,3,2,5], first timing 165ms
Japanese "日本語のテキストを読み上げます。"       -> 1 span of 15 units
Korean   "안녕하세요세계반갑습니다."             -> 1 span of 13 units
Mixed    "ABC中文DEF"                            -> 1 span of 8 units
```

NRL-28 made this more visible rather than causing it. CJK now reaches the player
as many short sentences, so the reader sees a block highlight flick from
sentence to sentence with no motion inside any of them.

## Decision

### 1. `Intl.Segmenter` subdivides the regex spans; it does not replace them

`findWords(text, cuts?)` runs the same regex it always ran. A span is then cut
at the segmenter offsets falling strictly inside it **only if** the span
contains a Han, Kana or Hangul code point. A span holding none of those is
pushed through untouched, so Latin, Cyrillic, Greek and Arabic spans are
identical by construction rather than by hope.

Replacing the regex with ICU was the obvious alternative and is wrong. Measured
on node v24.21.0, ICU with `granularity: "word"` segments
`well-known U.S.A. e.g. dont’t over.` as

```
well / - / known / U.S.A / . / e.g / . / dont’t / over / .
```

where the regex gives

```
well-known / U.S.A. / e.g. / dont’t / over.
```

ICU's word-like set is neither a superset nor a subset of the regex's: it splits
hyphenated compounds and drops the trailing period the regex keeps. Any mapping
between the two would move English spans and break the requirement that the
other scripts stay put.

The script test uses `scx` (Script_Extensions) and not `Script`, because U+30FC,
the katakana prolonged sound mark in コーヒー, is `Script=Common` and would be
missed by the plain form.

### 2. A Hangul run is additionally cut at grapheme boundaries

ICU boundaries alone are not enough for Korean. Measured on node v24.21.0,
`안녕하세요세계반갑습니다` comes back as **one** word segment under `ko`, `en`
and `und` alike: V8's ICU ships no Korean word dictionary. So `wordCutPoints`
also cuts every maximal `\p{scx=Hangul}` run at the grapheme-cluster boundaries
inside it, giving one span per syllable block.

A Hangul syllable block is itself a syllable, which is exactly the unit
decision 4's weighting assumes, and per-syllable Korean is the same granularity
ICU already gives Han. Cutting at grapheme boundaries rather than code points is
what keeps it safe: a syllable written with conjoining jamo (U+1100 U+1161
U+11A8, verified as one cluster) is never split, and `graphemeBoundaries`
already has the offline UAX 29 breaker behind it.

Applied uniformly, so **spaced** Korean moves too: `안녕하세요 세계 반갑습니다`
becomes 5 + 2 + 5 syllable spans rather than 3 word spans. That is intended.
The acceptance criteria name Latin, Cyrillic, Greek and Arabic as the scripts
that must not move; Korean is not among them, and splitting spaced Korean but
not unspaced Korean would be the stranger rule.

### 3. With no `Intl.Segmenter`, keep today's single span

`wordCutPoints` returns `[]` and `findWords` falls through to the regex
unchanged, so CJK collapses to one span per sentence exactly as before. R-S03 is
a SHOULD, so degrading to sentence-granularity highlighting stays in spec, and
`wordBoundaries` already argues there is no useful offline word rule for a
script that writes no spaces - a space-based fallback cannot help the one case
that needs help.

The **spans** are what is unchanged here, not the timings. Decision 4 changes
`weightOf` unconditionally, outside the `cuts` path, so a chunk mixing Latin
with CJK is re-weighted even in this position. Measured with `noSegmenters` on
`ABC 中文中文中文中文 DEF end.` at 3000ms: the four spans are identical either
way, and `ABC` goes from 698ms to 344ms while the Han span goes from 826ms to
1887ms. A pure-ASCII chunk is byte-identical in both positions, verified.

That is deliberate rather than an oversight. The CJK term is a better estimate
of spoken length whether or not subdivision happened, and gating it on
`chunk.wordSpans` would make a word's weight depend on how the chunk was
segmented rather than on the word, which is the worse of the two. It is written
down because "falls through unchanged" reads as a promise about timings and is
not one, and because this is plausibly the shipping path: whether the Obsidian
WebView has a word segmenter at all is still unknown.

**Presence of a segmenter is tested as `src.word(locale) !== undefined`, never
as an empty boundary list.** Those are different questions. An unspaced Hangul
chunk returns an empty boundary list from a perfectly working segmenter (see
decision 2), so reading the list as the test would silently disable the Hangul
rule for exactly the case it exists for.

### 4. `weightOf` gains one syllable per Han, Kana or Hangul code point

Splitting a sentence into spans is not enough on its own: the spans then have to
be weighted or the highlight still drifts inside the sentence. `weightOf`
counted ASCII vowel groups (`/[aeiouy]+/gi`) and returned 1 syllable for any CJK
span of any width. Arithmetic on the formula: a 1-unit Han span weighed
`1 + 1*0.06 + 0.45 = 1.51` and a 3-unit one `1 + 3*0.06 + 0.45 = 1.63`, a 1.08x
ratio against a true ratio near 3. With the CJK term they weigh 1.51 and
`3 + 0.18 + 0.45 = 3.63`, a 2.40x ratio.

ASCII is byte-identical. The old expression was `match(VOWEL_GROUP)?.length ?? 1`
and the new one is `(vowels + cjk) || 1` with `vowels = match?.length ?? 0`: the
`?? 1` only fired when the match was null, which is exactly when `(0 + 0) || 1`
gives 1, and `.length` is never 0 when the match is not null. Cyrillic, Greek
and Arabic are unchanged too, for the duller reason that `VOWEL_GROUP` is
ASCII-only and they already scored 1 syllable per word.

`letters = clean.length` stays a UTF-16 count, so an astral Han code point
counts 2 there and 1 in the CJK term. Pre-existing, left alone.

### 5. A cut that would open a word-less sub-span is dropped

Measured during implementation: ICU puts a word boundary before the final `.` of
`안녕하세요세계반갑습니다.`, which the regex had kept inside its span, so the
chunk gained a thirteenth span that was nothing but a full stop. `weightOf`
gives such a span 0.5 and the highlight would flash on a period. A sub-span
holding no `\p{L}` or `\p{N}` is therefore folded backwards into the syllable
before it. The first sub-span can never be word-less, because the regex span
begins with `[\p{L}\p{N}]`.

### 6. The seam is `SpeechChunk.wordSpans`, threaded in `extractChunks`

`SpeechChunk` gains `wordSpans?: WordSpan[]` and `allocateWordTimings` reads
`chunk.wordSpans ?? findWords(chunk.text)`. The policy - which offsets to cut at
- lives in `extract.ts` next to the rest of the segmentation policy, and
`words.ts` receives a plain sorted `number[]`, so it still imports nothing but
its own types.

The ticket proposed threading the segmenter from the player. That premise was
wrong: `player.ts` imports only `wordAt`, and `allocateWordTimings` is called
from `src/engines/system/espeak.ts` and `src/engines/onnx/kokoro.ts`.
`extractChunks` already takes a `SegmenterSource` and `opts.locale`, and the
`SpeechChunk` it produces already flows to both engines, so the chunk is the
natural carrier.

Spans are computed in the identity post-pass at the end of `extractChunks`, and
that is the only correct place: `mergeShort` mutates `prev.text` and
`prev.sourceIndex` in place and `splitOversized` re-slices both, so spans
computed any earlier would be stale. They are set only when subdivision actually
changed the span count, so an English note gains neither the field nor the
array and the `?? findWords(...)` fallback stays the default path rather than
becoming dead code.

### 7. The locale is passed through but nothing depends on it

Measured: `这是第一句`, `日本語のテキストを読み上げます` and
`안녕하세요세계반갑습니다` segment identically under `zh`/`ja`/`ko`, `en` and
`und` on this V8. `opts.locale` is still passed through, for consistency with
`sentenceBoundaries` and `splitOversized` and because a full-ICU build may one
day use it, but nobody should later read the pass-through as load-bearing.

## Consequences

Measured after the change, same bundle and same fixtures:

```
Chinese  "这是第一句。这是第二句。第三句结束了。"
  3 chunks; 4, 4 and 4 spans (was 1, 1 and 1), first timing 621ms of 3000ms
English  "This is the first one. This is the second one. The third one is over."
  1 chunk; 15 spans, lengths unchanged, first timing 165ms - byte-identical
Japanese "日本語のテキストを読み上げます。"  -> 6 spans (日本語/の/テキスト/を/読み上げ/ます)
Korean   "안녕하세요세계반갑습니다."        -> 12 spans, one per syllable, the last 다.
Korean   "안녕하세요 세계 반갑습니다"        -> 12 spans (was 3)
Mixed    "ABC中文DEF"                       -> 3 spans (was 1)
```

A span that **glues** Latin to CJK does change - `ABC中文DEF` becomes ABC/中文/DEF
- and that is intended. It was never a Latin word span; it was a Latin word
stuck to a CJK one.

The read-selection path in `main.ts` re-slices `chunk.text` and
`chunk.sourceIndex` and rebuilds the chunk with a spread, so a surviving
`wordSpans` array would index the unclipped text and put every span past the
clip point off by `textStart` - a non-negotiable 8 violation the existing tests
could not see, because `tests/readSelection.test.ts` holds its own copy of the
clip logic rather than importing `main.ts`. An exported `clipWordSpans` helper
now does the re-basing and is imported by both the real call site and that
suite.

`extract.ts` gains a runtime import of `src/audio/words.ts`. That file imports
nothing but its own types, so no node builtin reaches it and `main.js`'s
`require()` list is unaffected (non-negotiable 7).

One pre-existing behaviour is recorded here so it is not mistaken for a
regression introduced by this change: a combining mark is neither `\p{L}` nor
`\p{N}`, so the `findWords` regex ends a word at one and therefore cuts inside a
grapheme cluster. `가́나́다́` is three clusters and gives three
one-unit spans before and after this change alike. Degenerate text only, no
natural prose reaches it, and it is pinned in `tests/extract.test.ts`.

**Not verified in Obsidian.** Every number in this ADR comes from bare Node
(node v24.21.0, `Intl.Segmenter` present) or from arithmetic on the weight
formula. Whether Obsidian's WebView has a word segmenter at all is the same open
question R-M10 still carries, and nobody has watched a CJK note highlight in a
real editor. Two things follow if the WebView turns out to have no word
segmenter: decision 3's fallback fires and the behaviour is exactly what it was
before this ticket. And nobody has heard whether a highlight advancing through
a Chinese sentence one or two characters at a time reads as speech or as a
flicker.
