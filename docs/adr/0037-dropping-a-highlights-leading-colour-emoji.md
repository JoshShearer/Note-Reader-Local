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
- Not changed: a highlight inside a wikilink alias, which the renderer shows
  literally as `==...==`, was already spoken differently; it now also drops the
  emoji.
