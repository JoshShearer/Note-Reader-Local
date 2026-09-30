# 0025. A document-scoped closer lookahead for HTML comment blocks

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-74 (R-M08), then NRL-95 (R-M08), which bounded term 2 of the rule
  to the opener's paragraph and rewrote decisions 3 and 4, the "Known gap"
  section and the residual list below. Amends ADR 0006 clauses 2, 3 and 4;
  corrects two sentences in ADR 0018; adds a one-line amendment to ADR 0019 and
  ADR 0023.
- NOTE ON THE TITLE: "document-scoped" describes term 1 only as of NRL-95. The
  file name is kept so existing references still resolve.

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
pins**, including `obsidian-inside-html-block` (cited here as
`tests/extract.test.ts:1187`; it is in fact at `:1201`, and NRL-95 corrected the
reference), the very pin the ticket's own acceptance criteria say must keep
passing. The ticket mischaracterises that pin as line-start-and-unclosed. It is a
**mid-line** `<!--` whose `-->` sits four lines later, past a fence and past a
`$$` line, and it required the text between them to be hidden. A pure line-start
rule cannot express it. **That pin's expectation was itself wrong and NRL-95
replaced it** - see decision 3 - so read this paragraph as NRL-74's reasoning at
the time rather than as current state.

## Decision

1. **The rule is two terms, and neither is sufficient alone.** A `<!--` opens a
   document-level HTML comment block when it has no `-->` after it on its own
   line **and either**

   - only whitespace precedes it on the line (term 1, line-local), **or**
   - some **later** line carries `-->` (term 2; document-scoped as NRL-74
     shipped it, bounded by the opener's paragraph as of NRL-95 - decision 3).

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
   **paragraph-scoped**, where NRL-74's was document-scoped. NRL-95 bounded it;
   see decision 3 and "CLOSED by NRL-95" below.

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

3. **The two terms have DIFFERENT scopes, and that is the renderer's own
   asymmetry rather than an inconsistency.** Term 1 scans to EOF; term 2 is
   bounded by the end of the opener's paragraph. Record it as two things and not
   one, because the two terms answer to two different renderer paths:

   | term | renderer path | our scope |
   |---|---|---|
   | 1, line-start | HTML **block** tokenizer, module 8776 | **EOF - correct**, that tokenizer really does walk to end of input once it has opened |
   | 2, `closesLater` | **inline** raw-HTML tokenizer, module 4839 `.T` | **the opener's paragraph** (NRL-95), matching a regex applied to one paragraph's inline text |

   NRL-74 shipped a single shared EOF scan for both, and recorded term 2's half
   as a divergence carried knowingly. **NRL-95 closed it.** What follows is the
   resolution, replacing NRL-74's "the evidence is weak and was not
   re-litigated" paragraphs.

   The only justification NRL-74 offered for term 2's EOF scope was one pin,
   cited there as `:1187` and in fact at `tests/extract.test.ts:1201`, whose
   fixture NRL-74's own text mis-quoted:

   ```
   Before <!--
   %%
   ```
   $$
   --> after.
   Visible.
   ```

   It expected `"Before after. Visible."`, and its `-->` is reachable only
   across a `%%` line, a fence and a `$$` line, so any paragraph bound fails it.
   NRL-74 already conceded that this was weak evidence. **NRL-95 showed the pin
   was wrong, and wrong in a worse way than prose loss: its old expectation
   encoded a DISCLOSURE.** Three independent lines converge on `"Before <!--"`:

   - **the asar read.** Module 8776 returns early unless `<` is the first
     non-tab/space character, so this mid-line `<!--` never reaches the HTML
     block tokenizer at all. It reaches module 7648's inline path, module 4839's
     `.T`, applied to the one-line paragraph `Before <!--`, which holds no
     `-->`. So Obsidian displays `Before <!--` literally. Line 2's `%%` is
     line-start with no lone `%`, so the `%%` block tokenizer opens a comment
     there that never closes and hides lines 2-6.
   - **the paragraph-bounded arm**, built from `4dcb753` and run in NRL-95's
     Implement session, independently produces exactly `"Before <!--"`.
   - **NRL-74's own self-tested oracle**, re-run unmodified in that session with
     all 21 hand-traced cases still passing, says `Before` is DISPLAYED while
     `after.` and `Visible` are HIDDEN. So the old expectation spoke two
     sentinels Obsidian hides.

   The pin was **replaced in place** per the NRL-66/NRL-67 convention: same
   name, same fixture, expectation `"Before <!--"`. It is now the evidence
   AGAINST term 2's EOF scope, not for it.

   Term 1 keeps its EOF scan, and that is not a compromise: module 8776 is the
   rule it mirrors.

4. **The scope is delivered as an explicit parameter, never ambient state and
   never a callback into `cleanLine`.** `extractChunks` computes ONE per-line
   boolean array, once, right after `source.split("\n")`:

   ```ts
   const htmlCloserAhead: boolean[] = new Array<boolean>(lines.length).fill(false);
   let ahead = false;
   for (let k = lines.length - 1; k >= 0; k--) {
       const line = lines[k]!;
       htmlCloserAhead[k] = ahead;
       if (endsTerm2Scan(line)) { ahead = false; continue; }
       if (line.includes("-->")) ahead = true;
   }
   ```

   `htmlCloserAhead[n]` is exactly "some line AFTER `n`, and before the first
   line that ends `n`'s paragraph, carries a closer". NRL-74 shipped a scalar,
   `lastHtmlCloser`, and `lastHtmlCloser > n`; NRL-95 replaced it, because the
   bound is per-line and a scalar cannot carry one. **The O(L^3) reasoning
   survives verbatim as the reason a per-call rescan is still refused:** a helper
   that rescanned `lines` per test would be an O(L) scan inside
   `codeSpanClosesLater`'s O(L) loop inside `extractChunks`' O(L) loop. The array
   is O(L) time once, O(1) per test, and O(L) booleans of extra memory.
   Rejected: a `paragraphEnd: number[]` array plus the old scalar (strictly more
   work and more state for the same answer), and lazy memoised computation (extra
   mutable state for no gain).

   Three details of that loop are load-bearing. The assignment **precedes**
   folding line `k` in, which is the old scalar's strict `>` - a `-->` on line
   `n` cannot close an opener later on `n`, and the caller has already ruled out
   one after the opener on that line. `ahead` is **reset at a stop line**,
   because a paragraph cannot see past its own end. And a `-->` sitting **ON** a
   stop line is deliberately unreachable from earlier lines, while the stop line
   itself still gets the following run's answer - which is what keeps
   `table-tracking` and `heading-html-tracking` green.

   **THE MUTUAL-RECURSION TRAP.** The bound predicate is a separate, comment-blind
   helper, `endsTerm2Scan`, and it MUST NOT be `interruptsParagraph`:

   ```
   interruptsParagraph -> opensHiddenComment -> opensHtmlBlock -> consumes this answer
   ```

   so reusing `interruptsParagraph` here is mutually recursive - unbounded, or
   needing a sentinel argument threaded through four functions to break the
   cycle. `endsTerm2Scan` is comment-blind by construction rather than by a flag
   for exactly that reason. Do not "simplify" it into a call to
   `interruptsParagraph`.

   **Its stop set is `interruptsParagraph`'s terms with `BLOCKQUOTE` and
   `TABLE_ROW` dropped and `LIST_BULLET` REPLACED by `TERM2_LIST`**, and the
   three departures are three different reasons rather than one. The list half
   was corrected at NRL-95's ship review; the earlier draft of this ADR dropped
   `LIST_BULLET` whole on a justification that measurement falsified. See the
   residual list below.

   The value still reaches `cleanLine` as a **scalar** ninth parameter,
   `htmlCloserAhead[lineNo]!`, **appended** because six of the ten call sites
   bind positionally. So `cleanLine` stays line-local, it mirrors `outgoingCode`
   (NRL-64) and `outgoingBracket` (NRL-63) in SHAPE, and it still asks nothing
   about this line, so it **adds no pass**. There are still three.

   A module-level flag was built first and was the fifth pin failure: it leaked
   into the recursive label `cleanLine` call and broke `local-html-state`. That
   warning still applies.

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

**NRL-95 moved the SECOND of that pair, and added a third.** With term 2 bounded
by the opener's paragraph, `[a]: x.png "<!--"` / blank / `ZSECRETZ ...` / blank /
`-->` / blank / `ZAFTERZ here.` no longer opens a comment at all: the `-->` is two
paragraphs away and the renderer's inline path cannot cross a blank line. It went
`["ZAFTERZ here."]` -> `["ZSECRETZ sentence here.", "-->", "ZAFTERZ here."]`, and
the lone `-->` line is spoken too, which is also renderer-faithful - `-->` matches
no HTML block opener and is not a tag, so it is ordinary paragraph text. It was
**replaced in place** again, and a THIRD fixture was added rather than the second
merely edited, so decision Q9's own ordering property keeps a test: the same shape
with the `-->` inside the opener's OWN paragraph still expects `["ZAFTERZ here."]`
and is green on both sides. **This fixture was not predicted by NRL-95's plan** -
its fixture sweep covered the suite's fixture ARRAYS and this one is an `expect()`
call, so it was found by running the suite. It is the only pre-existing suite
expectation NRL-95 moves other than the `:1201` pin decision 3 discusses.

### CLOSED by NRL-95: our term-2 lookahead was wider than the renderer's

NRL-74 shipped term 2 scanning to EOF while the renderer's mid-line path is the
**inline** tokenizer, which cannot cross a paragraph break. So

```
Plain prose <!--
SECRETA

New para.

--> tail.
```

was hidden by us and displayed by Obsidian. NRL-74 measured it at **1,024 cells,
identical on base and on the fix**, and re-measured the shape above at ship review
with `HIDDENP` spoken in **0 of 512 on base and 0 of 512 on the fix**. NRL-95
bounded term 2 and it now speaks: measured in NRL-95's Implement session by
bundling the real `src/text/extract.ts` from `4dcb753` and from the fix side by
side with the repo's own esbuild, the ticket's own repro went
`"Before x. Prose Tail."` -> `"Before x. Prose <!-- HIDDENP New paragraph -->
Tail."`, and across the oracle-keyed two-class probe (28 shapes x 512 content-key
combinations, 21,504 Class-B cells per arm) the text the renderer DISPLAYS but we
silenced fell from **8,448 lost to 1,792 lost, with 0 cells newly leaking and 0
newly lost**. The residual 1,792 is fully accounted for: every one of them is a
content-key exclusion the oracle cannot see, 256 cells each at one constant toggle
(`skipInlineCode` x3 rows, `skipCodeBlocks` x2, `speakImageAlt`, `skipFrontmatter`).

Two evidence notes on that number, because they matter more than the number. The
probe was run against **oracle.mjs unmodified** first and reported **1,024 cells
newly leaking in two shapes**, both of them a setext underline or a thematic break
between opener and closer. That is an **oracle limit, not a leak**: `oracle.mjs`'s
`endsParagraph` models blank / fence / ATX heading / html-opener / `%%`-opener
only, and Obsidian's own parser prototype - read out of the same installed
`obsidian.asar` in that session, `app.js` sha256
`8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898`, at byte offset
22284 - sets

```js
u.interruptParagraph = [["thematicBreak"],["list"],["atxHeading"],["fencedCode"],
  ["blockquote"],["html"],["setextHeading",{commonmark:!1}],["definition",{commonmark:!1}]]
```

so a thematic break and a setext underline both DO end the paragraph the inline
regex is applied to. Note what that list does NOT contain, read at NRL-95's ship
review and load-bearing for the `TABLE_ROW` decision below: **`table`**, nowhere,
and the only two terms ever inserted into it anywhere in `app.js` are `math` and
`comment`. The numbers above are from `oracle95.mjs`, a copy of
`oracle.mjs` with those two terms added on that primary-source authority and
nothing else changed, re-run against the unmodified 21-case self-test with all 21
still passing. `list`, `blockquote` and `definition` were deliberately NOT added,
because the oracle models neither container prefix re-offering nor link reference
definitions and adding the terms without the structure would trade one wrong
answer for another.

**And the direction claim NRL-74 recorded here was BACKWARDS.** It said bounding
term 2 would **narrow** `codeSpanClosesLater` and `bracketClosesLater`. It
**WIDENS** them: bounding term 2 narrows `opensHtmlBlock` -> `opensHiddenComment`
-> `interruptsParagraph`, so both carries return false LESS often and confirm MORE
often. Measured on fixtures - a code span and a label each now survive a paragraph
break base refused - and on the predicate layer: over 697 documents / 2,794
(document, line) pairs the shipped term-2 array is **0 widened, 178 narrowed**
against base's `lastHtmlCloser > n`, a strict subset, so the change is fail-closed
by measurement rather than by argument. The three destination pins and
`guard-nrl74-variant-C-disclosure` were re-measured rather than assumed and all
four are **UNMOVED, 0 of 512 differing cells each**, because none of their `-->`s
sits outside the opener's paragraph.

### Residual risks left by NRL-95's own bound, stated plainly

- **The stop set drops `BLOCKQUOTE` and `TABLE_ROW`, and replaces `LIST_BULLET`
  with `TERM2_LIST`.** Three departures, three reasons. The first draft of this
  ADR gave one reason for all three and the ship-review critique falsified it for
  the list half, so read the three separately.

  **`BLOCKQUOTE`, dropped - correct, and compatible with `blockquote` being in
  `u.interruptParagraph`.** The renderer's blockquote tokenizer PEELS the `>`
  prefix and re-runs the paragraph tokenizer on the stripped content, so a
  continuation line of the SAME quote is never a quote STARTING;
  `u.interruptParagraph` is about the other case. So `> Prose <!--` /
  `> HIDDENQ` / `> more -->` is one paragraph inside the quote, module 4839's
  regex does find the closer, and Obsidian HIDES `HIDDENQ`. Stopping there speaks
  it. Measured: the two quote guards are RED on the arm that puts `BLOCKQUOTE`
  back. The cost is real and is now pinned as a tripwire rather than left
  unstated: where the quote STARTS after the opener (`Prose <!--` /
  `> HIDDENQ3` / `more -->`) the renderer's paragraph really does end at line 2
  and displays everything, and we hide it. Fail-closed, identical on base, and
  only fixable with container-prefix awareness - the NRL-88 root-1 class
  (`pin-nrl95-quote-starting-after-opener-still-hidden`).

  **`TABLE_ROW`, dropped - correct, and for a STRONGER reason than this ADR first
  gave.** The first reason was that our `TABLE_ROW` is `/^\s*\|/` and matches a
  lone `| a |` line GFM does not treat as a table. True but narrow. The real
  reason, read out of `app.js` this session: **`table` appears nowhere in
  `u.interruptParagraph`**, and the only two terms ever inserted into that list
  are `math` and `comment` (`RE(t.interruptParagraph,"fencedCode","math")` and
  `RE(i.interruptParagraph,"fencedCode","comment")` are the only two such calls
  in the file). So NO table row can interrupt a paragraph in Obsidian, delimiter
  row or not, and a REAL GFM table between opener and closer is hidden too.
  **Do not "fix" `TABLE_ROW` to require a delimiter row and then add it here**;
  that reopens the disclosure on exactly the real-table shape, which is why
  `guard-nrl95-real-gfm-table-closer` was added. All three table guards are RED
  on the arm that puts `TABLE_ROW` back.

  **`LIST_BULLET`, REPLACED - the first draft's reason here was FALSE and the
  behaviour was changed at ship review.** The draft said a list, like a
  blockquote, re-offers its lines as one paragraph. It does not: `- x` / `- y` /
  `- z` is three items with three paragraphs, so the closer is NOT in the
  opener's paragraph and Obsidian DISPLAYS every line. Dropping `LIST_BULLET`
  whole therefore retained prose loss with no disclosure to justify it. The
  correct term is module 745's own silent-mode rule, transcribed into
  `TERM2_LIST = /^[ \t]*(?:[-*+]|1\.)[ \t]/`: a bullet at ANY indent interrupts
  a paragraph (no three-space cap in that loop), and an ordered marker interrupts
  only when it is literally `1.` - Obsidian runs `commonmark` falsy, so `)` is
  not a marker, and the silent path returns unless the digit string is exactly
  `"1"`. `LIST_BULLET`'s `\d+[.)]` accepts `7.`, `01.` and `1)`, and stopping at
  one of those IS a disclosure: three guards are RED on the arm that puts the
  whole of `LIST_BULLET` in the stop set. Measured on the change itself: five
  fixtures RED against the pre-ship-review arm
  (`pin-nrl95-bullet-items-are-three-paragraphs`, `-bullet-line-between`,
  `-bullet-any-indent`, `-bullet-tab-indent`, `-ordered-one-dot-interrupts`), 0
  after; and over a **19,584-cell sweep** (3 openers x 32 middle lines x 3 tails
  x 64 content-key combinations) the arm with `TERM2_LIST` diverges from the arm
  without it in **3,456 cells and in 0 cells where an independent transcription
  of module 745's silent path says the middle line does NOT interrupt** - so the
  widening never speaks text the renderer hides. `sourceIndex` clean by numeric
  UTF-16 code-unit index over every chunk of all 19,584 cells, 0 failures.

  What survives all three: the stop set answers `true` for a strict subset of the
  lines the document-scoped predicate did, so omitting a term is fail-closed and
  ADDING one is the dangerous direction. Two residual prose losses stay, both
  pinned as tripwires and both of the container-prefix class: a quote or a bullet
  that our anchored regexes cannot see because the `>` is never peeled before the
  scan (`pin-nrl95-quote-starting-after-opener-still-hidden`,
  `pin-nrl95-bullet-inside-quote-still-hidden`).
- **The scan is forward-only from the opener line and does not bound the OPENER's
  own block.** An ATX heading's or a table row's mid-line `<!--` therefore still
  reaches a later closer that module 4839's paragraph-scoped path could not.
  Over-hiding, so fail-closed; pre-existing; the same class as the already-pinned
  `heading-tracking` `%%` divergence. Pinned as
  `guard-nrl95-atx-opener-not-bounded`, identical to `heading-html-tracking`, and
  out of NRL-95's scope. So NRL-95 does NOT make term 2 fully faithful to module
  4839, and must not be read as claiming it.
- `htmlCloserAhead` is still a crude text scan within a paragraph. It counts a
  `-->` inside a code span or inside another comment on a non-stop line. NRL-95
  **partly mitigated** the older, wider form of this bullet, which said the scan
  also counted a `-->` inside a fenced block, inside frontmatter or behind a blank
  line: a fence line and a blank line now stop the scan, and frontmatter's `---`
  is matched by the same `SETEXT`/`HR` terms, so a closer there no longer reaches
  an earlier opener. Measured: the fence and frontmatter shapes are in the
  two-class probe and neither newly leaks nor newly loses.
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
- `interruptsParagraph`'s answer set changed AGAIN at NRL-95: **28 (document,
  line) pairs over 697 documents, on 3 distinct lines, every one of them a
  mid-line `<!--` line the tokenizer oracle does NOT call a comment-block
  opener.** So **whichever of NRL-74, NRL-95, NRL-98 and NRL-93 merges last must
  re-measure NRL-88's remaining roots.** Their numbers are neither re-measured nor
  claimed here.
- `codeSpanClosesLater` and `bracketClosesLater` were shown structurally
  unweakened rather than asserted to be: brace-matched out of both trees and
  **byte-identical modulo the threaded argument's type and the two index
  expressions**. `opensObsidianBlock`, `opensHtmlBlock`, `opensHiddenComment`,
  `interruptsParagraph`, `opensMathBlock` and `labelClose` are **byte-identical**
  across the NRL-95 diff, by sha256 of each brace-matched body.
- **NOTHING IN NRL-95 WAS OBSERVED IN OBSIDIAN.** CDP port 9222 was not listening
  and no Obsidian process was running for the whole of that run, and no deploy
  happened. Every renderer claim above, including the whole case for moving pin
  `:1201`, rests on reading `obsidian.asar` 1.13.7 (sha256 confirmed identical to
  the bytes NRL-74 read) plus a transcribed oracle. Rule 11 applies to every
  number.
