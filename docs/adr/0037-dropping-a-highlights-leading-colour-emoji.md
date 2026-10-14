# 0037. Dropping a highlight's leading colour emoji

- Status: accepted
- Date: 2026-10-14
- Ticket: NRL-180 (R-M08; `srs.md` amended at the `==highlight==` bullet of R-M08 Markdown Processing)

## Context

Obsidian 1.14.4's `==highlight==` tokenizer calls `im(e, t)`: the first code
point of the text after the opening `==` is looked up in the table `nm`, and a
hit is cut from the text and becomes `data-highlight="<colour>"` on the `<mark>`.
The 12 code points are the circle and square families of red, orange, yellow,
green, blue and purple (U+1F534, 1F7E0, 1F7E1, 1F7E2, 1F535, 1F7E3 and
U+1F7E5 to 1F7EA). Only the first code point is tested: `== 🔴x==` is not a
highlight at all, `==a🔴b==` keeps its emoji, `==🟤x==` (brown, not in the
table) keeps it, and a U+FE0F after the emoji is left in the text (invisible).
1.13.7 showed the emoji. NRL-171's differential found no other visible-text
difference between the two bundles.

Before the change extract spoke `Buy 🔴milk today` for `Buy ==🔴milk== today`
where the 1.14.4 reading view shows `Buy milk today` (reproduced by bundling the
real extractor and running the 1.14.4 harness).

## Decision

Follow 1.14.4 unconditionally. In the `==` branch of `cleanLine`, when the first
code point after the opening `==` is one of the 12, the inner text starts after
it (two raw code units), with `rawStart` advanced by the same amount, so
`sourceIndex` stays in lockstep across the surrogate pair (rule 8).

## Consequences

- A vault on Obsidian 1.13.7 shows that one emoji and the plugin no longer
  speaks it. Whether a read engine voices a colour emoji at all is unmeasured.
- Rejected: a runtime version gate. The version that introduced the change is
  somewhere in 1.14.0 to 1.14.3 and is unmeasured, so a gate would be a guess,
  and the note text cannot say which renderer will show it. Failing closed
  (never speak what the installed reading view hides) was preferred.
- Round 1 narrowed this: see below.

## Round 1: drop only where the renderer opens the mark

Verify found that the first version dropped the emoji wherever extract's own
`==` pairing matched, including shapes where Obsidian 1.14.4 forms no colour
`<mark>` and shows the emoji: `a === b ==🟪x== c` (the renderer pairs the
earlier `==` of `===`), a line opening with `<!--` (raw HTML block), a wikilink
alias, `==🔴 ==🔵️fox==` (the first opener closes at the third
`==`), and an image alt. That is displayed content newly lost against `499038d`.

Extract's pairing is not changed (out of scope). The skip is now gated on state
`cleanLine` keeps for this decision only (`highlightColour`). It is not taken
when the line opens with `<!--`, inside a wikilink alias, an image alt or a link
label opening on `![`, or after an earlier `==` in the same paragraph that could
open a mark and that extract did not pair (an `==` followed by a non-space, such
as a run of `=`; a wikilink with no closer or an empty target; a dropped comment
holding `==`). That memory is cleared at a blank line. Where unsure the emoji is
kept, which is the pre-NRL-180 behaviour, so the cost of a miss is a hidden emoji
still spoken (disclosing), not a lost one. sourceIndex is untouched: only the
decision changed.

Measured 2026-10-14 with Verify's generator (`vgen.cjs`, graded against the
1.14.4 harness and base `499038d`; counts are notes with a lost cell). Head
`81378d2`: 78 newly lost (seed 4242, N=4000) and 47 (seed 9001, N=3000). This
round: 45 and 24 newly lost, 0 newly disclosing at both seeds, 271 and 223
fixed. Removing `<code>` text from the renderer side (the options skip inline
code, so a shown `` `==🟢` `` was never speakable) leaves 19 and 5.

Every remaining note was minimised and is one artifact: the shown emoji sits
where extract speaks nothing on base either (a bare URL, a table row, an embed,
a wikilink path or code alias, an invalid inline comment), and base only
matched the grader's per-character count because it spoke the hidden emoji of a
different highlight. The grader counts characters, not positions. So the
residual is not a shape where base spoke a shown emoji and this build drops it,
but that is a reading of minimised cases, not a proof; the raw grader numbers
above are not 0 and are not claimed to be. The ticket rows, the 12 emoji and the
`vlost.cjs` families (bold, heading, callout, list, quote, percent comment, inline
code, html tag) still drop. The gate is a list of shapes the generator found, not a
port of the renderer's tokenizer, so an unprobed shape can still drop a shown
emoji. Not verified in a live Obsidian.
