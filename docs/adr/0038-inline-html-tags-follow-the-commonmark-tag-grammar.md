# 0038. Inline HTML tags follow the CommonMark tag grammar

- Status: accepted
- Date: 2026-10-16
- Ticket: NRL-202
- Requirements: R-M08
- Amends: the element whitelist in `extract.ts` (`INLINE_ELEMENTS`, `BREAKING_ELEMENTS`) as
  the only tags dropped; ADR 0007 clause 6 cites that whitelist's trade.

## Context

`cleanLine` dropped an inline HTML tag only when its name was on a whitelist of formatting and
breaking elements and every attribute was `name=value` or a known boolean. The trade it
recorded was "leaked markup costs less than a lost sentence": `x<y and z>w` was read as prose
for fear that it was a comparison the reader sees.

The parser-harness oracle (Obsidian 1.13.7 and 1.14.4) shows the opposite. The renderer passes
any CommonMark raw-HTML tag through as an element, and the browser hides it.
`see <my file.md> now` shows `see  now`, and `x<y and z>w` shows `xw`. `a <b and c> d`,
`x <i am here> y`, `a <span foo> b` and `<QtQ> b` all hide the tag too. So the whitelist's
"false positive eats a sentence" was text the page also hides, and its leak spoke hidden text,
which R-M08 forbids. NRL-194's critic measured 1,103 such cells.

## Decision

- After the whitelist branch, which is unchanged so formatting tags still join words
  (`un<b>bold</b>ed`), a tag matching CommonMark's raw-HTML grammar is dropped (`CM_TAG`). An
  open tag is `<name` + attributes (`name`, or `name=value` unquoted, single or double quoted)
  + optional `/` + `>`. A closing tag is `</name>`. The name is ASCII letters, digits and `-`,
  starting with a letter. On one line.
- Such a tag separates the words either side: it is not a known formatting element, and a
  merged word is worse to hear than a space.
- Text that cannot be a tag stays text: `a < b`, `<3`, `<->`, `< x>`, `<1a>`, `<a@b>`.

## Consequences

- Measured: a generator of 30 tag shapes x 17 wrappers (prose, quote, list, heading, code
  span, link label, wikilink, `%%`, table, emphasis, glued, HTML block, indented, angle
  destination, image alt) x DEF/CODE/ALL x stripTags on and off gave 3,060 cells. Newly
  disclosed 0, newly lost 0, 542 hidden tokens no longer spoken.
- Eight NRL-166 pins re-pinned. They spoke `<textarea>`, `<script>`, `<svg><text>` and
  `<math><mtext>` tags the page hides. Their sentinels are unchanged.
- Not modelled: a tag spanning lines (CommonMark allows a line break inside one), and the
  content of raw-text elements (`<script>`, `<style>`) written inline, which the browser hides
  and which is still spoken as before.
- NOT VERIFIED IN OBSIDIAN: reading-view parser harness only.
