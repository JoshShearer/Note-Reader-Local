# 0025. A document-scoped closer lookahead for HTML comment blocks

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-74 (R-M08). Amends ADR 0006 clauses 2, 3 and 4; corrects two
  sentences in ADR 0018; adds a one-line amendment to ADR 0019 and ADR 0023.

## Context

`Plain prose <!--` / `SECRETA` / `more` spoke `"Plain prose"`. An unmatched
mid-line `<!--` opened a document-level comment block and silenced the rest of
the note, while the `%%` sibling of exactly the same shape correctly stayed
literal and spoke all three lines (NRL-68, ADR 0006 clause 2). That is prose
loss, not leaked markup: it discards text the renderer displays, which is the
direction ADR 0007 clause 6 and ADR 0018 both refuse.

The ticket proposed hoisting `cleanLine`'s line-start guard out from under its
`obsidianComment` gate, so that the guard applied to `<!--` too. That was built
and A/B'd against the suite before any of this was written, and it **breaks five
pins**, including `obsidian-inside-html-block` (`tests/extract.test.ts:1187`),
the very pin the ticket's own acceptance criteria say must keep passing. The
ticket mischaracterises that pin as line-start-and-unclosed. It is a **mid-line**
`<!--` whose `-->` sits four lines later, past a fence and past a `$$` line, and
it requires the text between them to be hidden. A pure line-start rule cannot
express it.

## Decision

1. **The rule is two terms, and neither is sufficient alone.** A `<!--` opens a
   document-level HTML comment block when it has no `-->` after it on its own
   line **and either**

   - only whitespace precedes it on the line (term 1, line-local), **or**
   - some **later** line in the note carries `-->` (term 2, document-scoped).

   Anything else - a mid-line `<!--` with no closer anywhere - is literal text
   that CommonMark renders and Obsidian displays, so it is spoken, delimiters
   included, exactly as an unmatched mid-line `%%` already is.

   **Term 1 was read out of the installed `obsidian.asar` in the NRL-74 session
   and the tokenizer agrees with it exactly.** Module 8776 is the HTML block
   tokenizer. It skips leading characters while they are `\t` or `" "` - spaces
   **and tabs**, with **no three-space cap** - then requires `<`, then tests the
   opener set against the first line only. The `<!--` entry is

   ```js
   u = /^<!--/,  h = /-->/          // [u, h, true] in the opener table
   ```

   `u` is **anchored**, so a mid-line `<!--` cannot open a block at all. The
   third element of the table entry is `true`, so a line-start `<!--` does
   interrupt a paragraph.

   The closer is a two-stage test, and the **first stage was stated wrongly in
   the first draft of this ADR**. Corrected at ship review by re-reading the same
   module:

   ```js
   if (A = i, !M[1].test(w))        // w is STILL THE FIRST LINE here
       for (; A < D; ) { ...walk later lines until M[1] matches... }
   ```

   So `h` is tested against the **opener's own line first**. If `-->` is present
   there the loop never runs and the block is that one line and nothing more;
   only when it is absent does the scan walk later lines, and if none matches it
   reaches the end of input and hides through EOF. The EOF half matches what we
   already did and was not changed. The same-line half is what makes
   `<!--x--> prose <!--` (no `-->` anywhere later) a **one-line** block in
   Obsidian with the next line displayed, which is the shape the ship review used
   to rule out a suspected new disclosure - see "Independently re-measured"
   below. Our `cleanLine` reaches the same answer by a different route, because
   it tests `close !== -1` per opener before it ever consults `opensHtmlBlock`.

   One welcome consequence of reading it: because that skip loop accepts tabs,
   our `view.slice(0, at).trim() === ""` is **correct** for `<!--`. The same
   expression is *wrong* for `%%`, whose tokenizer skips charCode 32 only - that
   is NRL-93, and it is not shared.

   **Term 2 is the renderer's INLINE path, and it is weaker evidence.** A
   mid-line `<!--` reaches module 4839's `.T` regex via module 7648, whose
   comment alternative is

   ```
   <!----> | <!--(?:-?[^>-])(?:-?[^-])*-->
   ```

   It requires a closer, and its negated character classes admit `\n`, so it
   does cross a soft line break. With no `-->` the `<` falls through to the text
   tokenizer and the delimiters are displayed - which is the defect direction,
   confirmed from the renderer rather than reasoned. But that path is
   **paragraph-scoped**, where ours is document-scoped. See "Known gap" below.

2. **Two predicates, not one.** `opensHtmlBlock(view, at, closesLater)` sits
   beside `opensObsidianBlock(view, at)` and is deliberately separate:

   ```ts
   function opensHtmlBlock(view: string, at: number, closesLater: boolean): boolean {
       return view.slice(0, at).trim() === "" || closesLater;
   }
   ```

   The two bodies show why. `%%` carries the lone-`%` disqualifier and no
   lookahead; `<!--` carries a lookahead and no disqualifier. Merging them would
   import `if (37 === a) return` into `<!--`, which D-73-4, ADR 0006 clause 2 and
   `srs.md`'s `%%` bullet all forbid in as many words. This is the case NRL-66's
   "do not merge two scans that answer different questions" note describes, where
   NRL-73's merge of two askings of the *same* question was the opposite case.

3. **The lookahead runs to EOF, not to the end of the paragraph - correct for
   term 1, and a KNOWN DIVERGENCE for term 2.** Record it as two things and not
   one. The two terms answer to two different renderer paths, and the single
   shared EOF scan is right for one of them and wider than the other:

   | term | renderer path | our EOF scan |
   |---|---|---|
   | 1, line-start | HTML **block** tokenizer, module 8776 | **correct** - that tokenizer really does walk to end of input |
   | 2, `closesLater` | **inline** raw-HTML tokenizer, module 4839 `.T` | **wider than the renderer**, which cannot cross a paragraph break |

   This is also a deliberate divergence from `codeSpanClosesLater` and
   `bracketClosesLater`, both of which stop at `interruptsParagraph`. The
   evidence offered for term 2's EOF scope is pin `:1187`:

   ```
   Before <!--
   %%
   ```
   $$
   --> after.
   Visible.
   ```

   Its `-->` is reachable only across a `%%` line, a fence and a `$$` line, and
   the pin requires the text between to be hidden. Stopping at any of those
   would fail it, and the ticket's acceptance criteria protect it explicitly.

   **That evidence is weak, and this clause must not be read as saying term 2's
   scope is right.** The asar read in decision 1 shows the renderer's mid-line
   path is the inline one and therefore paragraph-scoped, so pin `:1187`'s own
   expectation is not renderer-faithful in either half: its `<!--` is mid-line,
   so Obsidian displays `Before <!--` literally, and its `%%` line is a
   line-start `%%` with no lone `%`, so Obsidian's `%%` block tokenizer opens a
   comment there that never closes. The only stated justification for term 2's
   EOF scope is therefore a pin whose own expectation the same read undermines.

   It was **not** re-litigated here - it is a pre-existing pin, it is green on
   both sides of this diff, and changing it is a different ticket. **That ticket
   now exists: NRL-95**, and it owns both halves (re-examine the pin, then decide
   term 2's scope). What this ADR records is a divergence carried knowingly, not
   a choice shown correct.

4. **The scope is delivered as an explicit parameter, never ambient state and
   never a callback into `cleanLine`.** `extractChunks` computes ONE scalar,
   once, right after `source.split("\n")`:

   ```ts
   let lastHtmlCloser = -1;
   for (let k = lines.length - 1; k >= 0; k--)
       if (lines[k]!.includes("-->")) { lastHtmlCloser = k; break; }
   ```

   `lastHtmlCloser > n` is then exactly "some line after `n` carries a closer".
   A helper that rescanned `lines` per test would be an O(L) scan inside
   `codeSpanClosesLater`'s O(L) loop inside `extractChunks`' O(L) loop - O(L^3)
   on a long note. This is O(L) once and O(1) per test. Strict `>` is
   deliberate: a `-->` earlier on the same line cannot close an opener later on
   it, and the caller has already ruled out one after the opener on that line.

   It is a ninth `cleanLine` parameter, **appended** because six of the ten call
   sites bind positionally. It mirrors `outgoingCode` (NRL-64) and
   `outgoingBracket` (NRL-63) in SHAPE - one scalar handed in, so `cleanLine`
   stays line-local - but not in TIMING: it asks nothing about this line, so it
   is known before the first pass and **adds no pass**. There are still three.

   A module-level flag was built first and was the fifth pin failure: it leaked
   into the recursive label `cleanLine` call and broke `local-html-state`.

5. **The new literal escape gates `blockComments` POSITIVELY, where the `%%`
   escape negates it.** This reads like a typo and is not:

   ```ts
   if (close === -1 && obsidianComment && !(blockComments && opensObsidianBlock(raw, i))) { ... }
   if (close === -1 && htmlComment && blockComments && !opensHtmlBlock(raw, i, htmlClosesLater)) { ... }
   ```

   A recursively cleaned label passes `blockComments` false. Written
   symmetrically, such a call would take the escape and make `<!--` literal
   inside a label; `local-html-state` (`tests/extract.test.ts:1197`) and
   `srs.md`'s non-nesting bullet both require the opposite - an unmatched `<!--`
   inside a label truncates locally. `%%` can afford the symmetric form because
   literal is the right answer for it in both modes. Changing what a label does
   with `<!--` is a different ticket. All four characters are emitted with their
   true raw offsets and `i` advances past them; emitting only `<` would re-enter
   the loop at `!--` and risk the autolink or raw-HTML branch claiming it.

6. **Narrowing `opensHiddenComment` is MANDATORY and ships in the same change.**
   The `cleanLine` half alone is not a safe subset, and this is the conclusion a
   future reader is most likely to "simplify" away, so it is measured rather than
   asserted. Built as its own arm against base `8635ed2`: over **2,560
   destination-bearing cells** (5 shapes x 512 content-key combinations, **all of
   them plain-paragraph**), `zdestz` is spoken in **0 on base, 0 on the full fix,
   and 2,560 on the `cleanLine`-only variant**. The mechanism is that the
   now-literal `<!--` stops the label line truncating, so the unmatched `![`
   survives to the carry site - but with `opensHiddenComment` left wide,
   `bracketClosesLater` still refuses to confirm, the label is never recognised,
   and the whole construct including `(zdestz.png)` falls through as prose. That
   turns an R-M08 prose-loss defect into an R-M09 destination leak.
   `pin-nrl74-label-destination-not-spoken`, its `-alt` twin and
   `pin-nrl74-link-label-destination-not-spoken` are the only things in the suite
   that would catch a revert.

   **CORRECTION. "0 on the full fix" holds for the plain shapes only.** The
   sentence above was written as though it settled the destination question for
   the whole fix, and it does not: PR #113 was blocked for asserting exactly that.
   Put a **container prefix** on the same construct and the full fix speaks the
   destination. `> Before ![alt <!--x` / `> more](zdestz.png) after.` goes
   `"Before [alt"` on base to `"Before [alt <!--x more](zdestz.png) after."` on
   the fix. Measured at correction against base `5009eb6`, both arms bundled with
   the repo's own esbuild: **5,120 of 6,144 cells newly speak `zdestz`, base 0 and
   fix 512 in each of 10 shapes** (blockquote / nested quote / bullet / ordered /
   task, x image, link, x 512 content-key combinations). The **plain** family is
   **0 -> 0**, re-measured over 8 plain shapes / **4,096 cells**.

   **The cause is this fix unmasking NRL-88 root 1, not a mechanism of its own.**
   The identical container shapes **without** the `<!--` already speak the
   destination **5,120 of 5,120 on base and on the fix alike**:
   `bracketClosesLater` runs `interruptsParagraph` over the opener line, which
   matches `BLOCKQUOTE` and `LIST_BULLET`, so a container-prefixed label is never
   confirmed either way. Base's 0 on the `<!--`-bearing members was the prose-loss
   defect masking them - it hid the destination by swallowing the note - and
   removing the prose loss exposes what was already broken underneath. Traced
   rather than assumed: a **3-space indent**, which `interruptsParagraph` does not
   match, is **0 -> 0** on the same corpus with the destination correctly dropped.
   So it is **root 1**, not root 2.

   This is **not** grounds to revert decision 6 or the fix: you do not keep a
   prose-loss defect in order to mask a destination leak, and the leak was already
   present for every container-prefixed label that did not happen to carry a
   `<!--`. It is grounds to record it and pin it, which
   `pin-nrl74-container-label-still-leaks-destination` does **as a tripwire, not as
   evidence** - when NRL-88 closes root 1 that fixture's expectation must change.
   CommonMark parses these as valid images, so the destination is an attribute the
   renderer never displays and speaking it is a real R-M09 disclosure.

7. **Adopting the line-start term ALONE is FORBIDDEN.** `opensHiddenComment` can
   answer term 1 from its own argument and not term 2, so half the rule looks
   free. It is a measured disclosure. Built as a fourth arm:

   ```
   Before `a
   Prose <!--
   HIDDENX
   --> b` after.          (skipInlineCode: false)
   ```

   base `"Before a Prose b after."`, full fix `"Before a Prose b after."`,
   line-start-only variant `"Before a Prose <!-- HIDDENX --> b after."`. The
   half-rule answers false for a mid-line `<!--` that a later `-->` genuinely
   closes, so `codeSpanClosesLater` confirms a carry across a line that really
   does open a hidden block. Over the disclosure matrices in "Verification"
   below that variant leaks **768 + 768** cells where base, the full fix and the
   `cleanLine`-only arm all leak 0. `guard-nrl74-variant-C-disclosure` pins
   against it. Both terms or neither.

## Consequences and verification

All measurement is **bare Node**, built side by side with base `8635ed2` using
the repo's own esbuild, over four arms: `base`, `fix`, `conly` (the
`cleanLine`-only variant of decision 6) and `vc` (the line-start-only variant of
decision 7). **NOTHING WAS OBSERVED IN OBSIDIAN**: no deploy happened and CDP
port 9222 was not attempted. Rule 11 applies to every number here. What *did*
happen, and is new for this family, is that the renderer side rests on reading
the installed `obsidian.asar` rather than on CommonMark reasoning - see decision
1 - which is what the plan asked for and did not expect to get.

**The oracle is keyed on what the renderer shows, never on sentinel names**, and
it is transcribed from the two tokenizers in decision 1 plus the `%%` tokenizer
NRL-73 read (re-read this session at byte 2100501, unchanged). It was self-tested
against **21 hand-traced cases** before use, and one real oracle bug was caught
that way: the `%%` tokenizer eats `t.slice(0, s)` and so leaves its closer line's
remainder displayed, where the HTML block tokenizer consumes its closer line
whole. Modelling both the same way manufactured 1,536 phantom leaks.

- **Two-class probe**, 20 shapes x 512 combinations. **Scope first, because this
  probe's "0 newly leaking" was over-read**: its classes are *text* the renderer
  hides and *text* it displays, and an image or link **destination** is an
  attribute rather than either, so the 5,120-cell destination move in decision 6's
  correction lies **outside both classes** and this probe was structurally unable
  to see it. Class A (renderer hides):
  **0 spoken on base, 0 on fix, 0 on `conly`**, out of 6,656 cells per arm.
  Class B (renderer displays): lost **9,216 -> 2,304** of 13,312. **0 cells newly
  leaking and 0 newly lost.** Of the residual 2,304: **1,024** are the known gap
  below, present identically on base; **1,280** are content exclusions doing
  their job, which the oracle cannot see because it models the renderer and not
  our toggles (256 `skipCodeBlocks`, 256 `skipFrontmatter`, 256
  `speakImageAlt: false`, 512 `skipInlineCode: true` on a span that is now
  correctly recognised - NRL-73's ship-review class).
- **Disclosure probe for the two widened lookaheads.** Both, because both call
  `interruptsParagraph`. `codeSpanClosesLater`: 17 shapes x 512 = **8,704 cells**
  (a genuine hidden block beside unmatched runs of 1, 2 and 3, a run that never
  closes, both mismatched pairs and an indented opener), hidden sentinel spoken
  **0 base / 0 fix / 0 conly / 768 vc**. `bracketClosesLater`: 6 shapes x 512 =
  **3,072 cells**, hidden sentinel **0 / 0 / 0 / 768 vc**. The `vc` column is
  what makes these non-vacuous: the probe can see the class it is looking for.
  The destination `zdestz` **in that second matrix, and in that matrix only**, is
  spoken in **2,048 of 3,072 on base, fix and `conly`** - unchanged across those
  three arms for those 6 shapes. **Do not read the "alike" as a statement about
  the diff, which is how it was originally written and is false**: outside that
  matrix the destination **does** move, 0 -> 5,120 cells in the
  container-prefixed class (decision 6's correction above), and that class is
  **root 1** - `interruptsParagraph` matching a container on the **opener** line -
  not root 2. Whether the 6 shapes in this matrix are themselves root 2 was taken
  from the original probe and **not** re-measured at correction; what was
  re-measured is the class that moved.
- **Both confirmations are structurally unweakened.** `codeSpanClosesLater` and
  `bracketClosesLater` were brace-matched out of `git show 8635ed2` and out of
  the branch: after removing ONLY the new parameter and the two
  `lastHtmlCloser > n` arguments, each body is byte-identical to base
  (sha256 `8425795b1c10a8b4` and `072d4dd483cdafd8` respectively). The loop
  structure, the `firstRunOfLength` test, the `](`/`][` test and the
  `opensMathBlock` stops are untouched.
- **Subsumption**, measured and not asserted, because the added `|| closesLater`
  is a disjunction and the property is not algebraically obvious: over a 518-line
  corpus x both values of `htmlClosesLater` = **1,036 pairs, 0 widened and 114
  narrowed**. The fix can never newly hide text by this predicate.
- **`interruptsParagraph` answer changes enumerated.** **49 of 1,036 pairs, on 49
  distinct lines, and all 49 are lines the tokenizer oracle does NOT treat as a
  comment-block opener.** That is what turns "0 leaks observed" into "0 leaks
  possible by this mechanism".
- **ADR 0019's deliberately-literal class kept separate**, as NRL-44 measured it
  must be: a `<!--` inside a SPOKEN code span is **256 / 256 EQUAL** on both
  sides in three single-line shapes and 0 / 0 in the soft-wrapped one.
- **NRL-73's two-class probe re-run** (D-74-8 requires it of whichever ticket
  merges second): 22 `%%` shapes x 512, **identical on both sides** - Class A
  512/6,656 and Class B 768/7,680 on base and on fix alike, **0 newly leaking, 0
  newly lost**, ADR 0019's literal `%%` class 512 = 512.
- **`sourceIndex` lockstep** (non-negotiable 8), numeric by UTF-16 code-unit
  index over 18 notes x 512 combinations: **fix 12,032 chunks / 184,576 units,
  0 failures on all four checks; base 9,472 / 96,768, 0 failures.** The
  `text[i] === " "` exemption is mandatory and pre-existing rather than this
  diff's: without it the fix reports 8,192 identity failures and **base reports
  512**, both nonzero. The checker is non-vacuous by **four targeted mutators,
  every row nonzero on both sides**: drop an entry (L 12,032 / 9,472), add
  `src.length` to one entry (B 12,032 / 9,472), decrement one interior entry
  below its predecessor (M 12,032 / 9,472), perturb one entry to a different
  non-space character (I 10,752 / 8,192).
- **Fuzz**, 4,000 generated notes x 2 option sets: **0 newly leaking**. 8 newly
  "lost" cells across 2 notes, all 8 at `skipInlineCode: true` and **0 at
  `skipInlineCode: false`**, all in notes carrying both a backtick and a label
  opener - the exclusion class above, not prose loss. 58 cells speak `zdestz`
  where base said nothing, and **58 of 58 speak the whole literal
  `](zdestz.png)`**, which this ADR originally dismissed as "the construct has no
  matching opener, so it is literal text the renderer also displays, not a
  destination leak". **That dismissal was wrong and it is how the class in decision
  6's correction got through.** A container-prefixed soft-wrapped label has a
  matching `![`/`[` opener *and* a matching `](...)`; speaking the whole literal is
  the symptom of the leak, not evidence against it. The fuzz saw the signal and the
  reasoning threw it away. How many of the 58 belong to that class was not
  re-measured at correction - the class was measured directly instead, at 5,120
  cells. `sourceIndex` clean on both
  arms once the synthesised `"equation"` chunk is excluded (ADR 0004 builds its
  index by hand, so `src[at]` is `$`; 306 base / 316 fix), with **0 notes failing
  on the fix that do not also fail on base**.

### Independently re-measured at ship review

The numbers above are Implement's. They were re-derived from scratch at ship
review, on a **different** shape corpus, with a checker written independently, to
avoid the failure where one probe's blind spot is the whole evidence. Same two
arms, same esbuild, base `8635ed2`. All bare Node.

- **Both confirmation bodies re-hashed.** `codeSpanClosesLater` and
  `bracketClosesLater` extracted by regex from `git show 8635ed2:src/text/extract.ts`
  and from the branch, normalised by deleting only the added parameter and the
  two `lastHtmlCloser > n` arguments: sha256 prefixes `8425795b1c10a8b4` and
  `072d4dd483cdafd8` on **both** sides, matching decision-time. `interruptsParagraph`
  is byte-identical the same way; `opensMathBlock` and `inlineContainerClose` are
  byte-identical with no normalisation at all.
- **Subsumption re-measured on a fresh corpus**: 440 generated lines (10 prefixes
  x 11 bodies x 4 tails) x both values of `closesLater` = 880 pairs. **0 widened,
  72 narrowed, 808 unchanged.** The 0 is also structural - the fix is the base
  predicate conjoined with `opensHtmlBlock` - but it was measured rather than
  argued, because that is what caught NRL-42's review defect in this same area.
- **Disclosure, three independent hidden-text corpora, 21,504 cells in total.**
  H1 (a line-start `<!--` block) 8 shapes x 512, H2 (an inline `<!--...-->` pair)
  7 shapes x 512, H3 (the paths H1 and H2 miss: a reopened closer-line remainder,
  a second opener on one line, callouts, lists, tasks, tables, frontmatter,
  headings, nested quotes, a fence and a `$$` inside the block, CRLF, no trailing
  newline, wikilinks, embeds, an autolink and CJK) 21 shapes x 512. **0 cells
  newly leaking**, after adjudicating three candidates that the first pass
  flagged and none of which is a leak:
  - `<!--` / `AAA` / `--> tail <!--` / `BBB` - a **contaminated sentinel** in the
    probe itself, exactly the class of bug Implement's oracle had: `AAA` is
    0/512 on both sides, and the 512 hits were `BBB` matching `.includes("HIDDEN3")`
    through `HIDDEN3b`. Per module 8776 the block ends at line 2 inclusive, so
    `BBB` is **displayed** and the fix speaking it is the defect being fixed.
  - `<!--x--> prose <!--` / `CCC` / `more` - resolved by the same-line closer
    correction in decision 1. Obsidian's block is line 0 alone and `CCC` is
    displayed, so the fix speaking it is correct and base hiding it was prose
    loss.
  - `---` / `title: x <!--` / `DDD` / `---` / `Body.` - not frontmatter at all on
    either side (the `<!--` breaks the frontmatter scan, and so does a `%%`), so
    it is a setext heading whose `%%` sibling **already spoke `DDD` on base**.
    256 of 512, every one at `skipHeadings: false`.
- **D-74-9 re-measured on a 5-shape corpus, all of it plain-paragraph**: `zdestz`
  spoken in **0 of 2,560 on base, 0 of 2,560 on the fix, 2,560 of 2,560 on the
  `cleanLine`-only arm**, which reproduces decision 6 exactly. **Ship review shared
  Implement's blind spot here**: a second corpus was built to avoid one probe's
  blind spot being the whole evidence, and it was plain-paragraph too, so it
  confirmed the plain result twice and never reached the container-prefixed class
  that moves 0 -> 5,120. See decision 6's correction.
- **D-74-11 re-measured** by building the symmetric variant: `[label <!--hidden](target) after.`
  / `Visible.` speaks `"label after. Visible."` on base and on the fix and
  `"label <!--hidden after. Visible."` on the symmetric arm, with the image twin
  behaving identically. The positive gate is load-bearing and the comment at the
  site is accurate.
- **`sourceIndex` lockstep, both arms**: 4,000 generated notes x a random option
  set each, checked numerically by UTF-16 code-unit index for length, bounds,
  monotonicity and character identity. **88 failures on the fix and 88 on the
  base, 0 notes failing on the fix that do not also fail on base.** All 88 are
  ADR 0004's synthesised `"equation"` chunk, whose index is built by hand so
  `src[at]` is `$` - the same artifact Implement excluded, confirmed here by
  reading the failing text rather than assumed. Clean over 10,240 extractions of
  the probe corpora with no exclusions beyond the documented join space.

### One pre-existing fixture moves, and it moves silent to spoken

`tests/extract.test.ts:959`, NRL-45 decision Q9: `[a]: x.png "<!--"` followed by
a `ZSECRETZ` line went `[]` -> `["ZSECRETZ sentence here."]`. It is the **only**
pre-existing fixture in the suite that moves. Renderer-faithful: the `<!--` is
inside a quoted title, mid-line, with no `-->` anywhere, so it opens nothing. It
also makes the shape agree with its `%%` sibling, which already spoke on base
(measured identical on both sides), and removing exactly that asymmetry is what
this ticket is for. It was **replaced in place** keeping its name and source, per
the NRL-66/NRL-67 convention. Decision Q9 itself keeps its pin: `:960`, the same
shape with a `-->` four lines down, still expects `["ZAFTERZ here."]` and is green
on both sides. Do not collapse the pair.

### Known gap: our lookahead is wider than the renderer's

Term 2 scans to EOF; the renderer's mid-line path is the **inline** tokenizer,
which cannot cross a paragraph break. So

```
Plain prose <!--
SECRETA

New para.

--> tail.
```

is hidden by us and displayed by Obsidian. Measured **1,024 cells, identical on
base and on the fix** - this diff neither opened nor widened it - and re-measured
independently at ship review on the shape above, `HIDDENP` spoken in **0 of 512
on base and 0 of 512 on the fix**. Fixing it means making term 2
paragraph-scoped, which fails pin `:1187` as decision 3 explains, so it needs
that pin re-examined first.

**Tracked as NRL-95** (Bug, Medium, R-M08), filed at ship review with the module
numbers, the regexes, both measurements and the doubt about pin `:1187`. Note the
direction reversal it will have to handle: widening `opensHiddenComment` back out
**narrows** `codeSpanClosesLater` and `bracketClosesLater`, the opposite of this
diff, so decision 6's three destination pins and decision 7's
`guard-nrl74-variant-C-disclosure` must both be re-measured there.

### Other residual risks, stated plainly

- `lastHtmlCloser` is a crude text scan. It counts a `-->` inside a fenced block,
  inside frontmatter, inside another comment or inside a code span. Measured: the
  fence and frontmatter shapes are in the two-class probe and neither newly leaks
  or newly loses.
- `appendRemainder` hands `cleanLine` a **suffix**, so term 1 is measured from
  the remainder's start rather than the physical line's. Inherited from the `%%`
  predicate, NRL-73's own known limit, not opened here.
- `opensHiddenComment` still tests only the **first** `<!--` on a line while
  `cleanLine` walks every one, so `<!-- a --> <!-- b` already disagrees between
  the two sites. Pre-existing in both halves; not opened or closed here.
- A tab-indented `<!--` in a fresh-block position never reaches the predicate at
  all, because indented-code handling consumes the line first. Identical on both
  sides, and the same shape NRL-93 records for `%%`. **It is a disclosure rather
  than prose loss, which the first draft of this bullet did not say.** Measured at
  ship review: `Before x.` / blank / `\t<!--` / `HIDDEN1` / `more` speaks
  `"Before x. HIDDEN1 more"` on **base and fix alike, 512 of 512 cells each**,
  while module 8776's skip loop accepts `\t`, so Obsidian opens a block there and
  hides `HIDDEN1`. Unchanged by this diff in either direction, and it is NRL-93's
  indented-code question rather than a new one: narrowing the `<!--` predicate
  would not help, because the line never reaches it.
- The oracle surfaced one **pre-existing** divergence unrelated to `<!--`:
  `# %% off` / `ZHZ` / `%% after ZPZ.` is spoken and hidden the opposite way round
  from what the tokenizers say, because a `%%` in an ATX heading reaches the
  anchored inline tokenizer rather than the block one. Identical on base and fix,
  pinned as `heading-tracking`, and **no ticket has been filed**.
- `interruptsParagraph`'s answer set changed, so **whichever of NRL-74 and NRL-88
  merges second must re-measure NRL-88's five roots.** NRL-88's numbers are
  neither re-measured nor claimed here.
