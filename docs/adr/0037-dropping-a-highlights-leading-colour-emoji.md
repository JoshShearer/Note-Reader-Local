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
- The drop is narrowed by round 2 below: the emoji is now kept by default
  and dropped only where the mark is proven to open at it. That supersedes the
  decision above where they differ.

## Round 1 (superseded)

Verify found that the first version dropped the emoji wherever extract's own
`==` pairing matched, including shapes where 1.14.4 forms no colour `<mark>`
and shows the emoji (`a === b ==🟪x== c`, a line opening with `<!--`, a
wikilink alias, an image alt). Round 1 added a deny-list of such contexts as
state kept by `cleanLine`. Both critics blocked it: every raw HTML block other
than a comment (`<div>`, `<p>`, `<details>`, `<center>`, type 7 tags, in
containers too) and several rarer shapes (`*==🔴 a*==`, inline math or a link
label spanning a line, indented code in a container) still lost a shown emoji
that base spoke; the stray-`==` memory reset only at a blank line, so it kept
the emoji after a list item, heading or quote opening; and it was not reset
between the passes `extractChunks` makes over one line, so a later `==` on the
line changed the verdict of the re-clean. A deny-list cannot be complete.

## Round 2: keep by default, drop only where proven

The emoji is spoken unless every condition below shows that 1.14.4 opens the
mark at it. Losing displayed content is the project's must-block failure;
speaking a colour emoji the reading view hides is a minor, non-private miss,
so where extract cannot tell, it keeps the emoji.

- Only the main body clean of a line may drop it (`bodyOpts` in
  `extractChunks` carries the raw line to prove against). Frontmatter (with
  `skipFrontmatter: false` a property value is shown literally), comment
  remainders, tables and every other call keep it.
- `colourLinesOk` rules a line out, from the raw lines alone: frontmatter; a
  fenced block; display math after any odd `$$` line until a bare `$$`; a `%%`
  block; an HTML block (types 1-5 until the line holding their end marker, the
  rest until an empty line, since a whitespace-only line does not end one in
  the 1.14.4 harness); a line that may be indented code (a tab in the lead,
  four spaces after a quote marker, five after a list marker or task box, or
  four leading spaces without an open non-quote paragraph above); and any line
  after an earlier line of the same paragraph that holds a risky character or
  a stray `==`. That paragraph memory resets at a blank or quote-blank line,
  a heading, a bullet or `1.` item, and a quote opening with no quote since the
  last blank line.
- `colourMarkProven` then checks the line itself: before the opener, once
  quote, list, task and callout markers, closed code spans, clean earlier
  `==x==` pairs and lone `==` between spaces are removed, there is no `==`
  and none of `` ` $ [ ] < > % \ | ``; the opener sits at the content start or
  after a space, `*`, `_`, `(` or a quote mark (or is the whole label of an
  inline link, `[==🟠l==](url)`); the text inside holds none of those
  characters nor `* _ ~ =`; the closer is extract's own on the same line and
  is followed by an edge, a space or plain punctuation.

The decision is a pure function of the line and that per-note array, so every
clean of a line reaches the same verdict. sourceIndex is unchanged: the skip
is still two raw units with `rawStart` advanced.

Measured 2026-10-14 against the 1.14.4 harness (`selftest.cjs` and
`oracle-selftest.cjs` OK first), base `499038d`, round 1 `a124388`, graded by
source position: for each colour emoji, shown = the renderer still shows it
after that one emoji is swapped for a table emoji absent from the note;
spoken = a chunk character whose sourceIndex is that offset. Counts are emoji
positions, summed over two option sets (Verify's, and inline code, URLs,
tables, embeds and frontmatter spoken). Grader and generators are kept in the main
checkout's local, untracked `.claude/runs/NRL-180/r2/` (`pos.cjs`, `mygen.cjs`, `grid.cjs`).

| corpus | newly lost (shown, base spoke, now dropped) | fixed (hidden, base spoke, now dropped) | disclosing that round 1 dropped |
| -- | -- | -- | -- |
| Verify's `vgen.cjs` seed 4242, N=4000 | 0 | 1290 + 1290 | 1126 + 1169 |
| Verify's `vgen.cjs` seed 9001, N=3000 | 0 | 956 + 956 | 896 + 933 |
| HTML-block / multi-block / frontmatter grid, 8,528 notes | 0 | 3144 + 3144 | 496 + 496 |
| own generator, 14 seeds x 3,000 notes | 0 | 17095 + 17095 | 30045 + 29833 |

Round 1 lost 0 on Verify's generator by position but 11185 + 13673 positions
on the own generator and 3176 + 3384 on the grid, all now spoken again. No
position is newly disclosing against base. sourceIndex lockstep over the
115,056 note-option pairs: 96 mismatching chunks on base and 96 on this build
(pre-existing, unchanged). Verify's per-character grader still reports 19 and
10 newly-lost notes at the two seeds; minimised, each one is a shown emoji in
inline code or an embed path that extract speaks nothing for on base either,
matched on base only by a different, hidden emoji, so by position it is 0.

Accepted residual: the large disclosure counts. Speaking a hidden colour emoji
is the base behaviour, and the generators are dense with the risky constructs
on purpose; in plain paragraphs, list items, quotes, headings, callouts, bold
and task items the emoji still drops (the ticket's rows and all 12 emoji are
pinned). Known disclosures are pinned in `tests/extract.test.ts`, including
`==🔴 ==🔵️fox==`, where the renderer hides 🔴 at a first `==` that extract does
not pair: hiding it needs a change to extract's general `==` pairing, which is
out of scope. The proof is a set of sufficient conditions, not a port of the
renderer's tokenizer, so a construct no generator produced could still break
it. Not verified in a live Obsidian.
