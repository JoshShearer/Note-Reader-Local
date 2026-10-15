# SPIKE-WHITESPACE-001: One Whitespace Model for the Lead Predicates

## Result
**ANSWERED (reading view only)** - the renderer's lead rules were read by executing
Obsidian's own parser, the one model is stated below, and every divergence the grids
measure is partitioned into owned families with a failure direction. No `src/` change
was made (NRL-153 ran as a spike, acceptance 1-2 only). NOT VERIFIED IN A LIVE OBSIDIAN.

Fix round 1 (after two critiques of `40c3ff3`) added the constructs the first grid
missed: an interrupt candidate inside a paragraph that spans an inline `<!--`, HR, link
reference and footnote definitions, an unclosed `$$`, two table lead shapes, frontmatter
leads, and four after-block positions. It corrected the 672-cell count (540), the `>\t`
cause, the math cascade's cause and model rule 4. The first grid had one disclosure
family; the corrected inventory has four.

---

## Environment

| Property | Value |
|----------|-------|
| Ticket | NRL-153, run as a spike by the run's clarification: NRL-113 and NRL-114 already landed separately, so "one diff" is overtaken |
| Base | `60ff058` (`src/text/extract.ts`, bundled with the repo's esbuild 0.24) |
| Renderer | parser harness 1.14.4 (`app.js` sha256 `958ce57f...2df9`, the asar the installed app loads) and 1.13.7 (`8efbf581...9898`) |
| Harness validation | `node selftest.cjs` printed `SELFTEST OK` on both, before any verdict, in both rounds |
| Version differential | 0 renderer-class differences between 1.13.7 and 1.14.4 on all 43,560 notes of the main, hazard, extra and four position grids. The frontmatter grid gave the same totals on both |
| Shadow arm | `src/` taken with `git archive 60ff058` per mutant and edited by `mutants.py`. The INDENTED_CODE mutant moved cells, so the shadow is read |
| Test date | 2026-10-15 |
| Scripts | `.claude/runs/NRL-153/spike/` in the primary checkout (gitignored). `build-arm.sh <repo> [rev]` rebuilds `arm.cjs` (the `extractChunks` bundle that `grid.cjs` loads). `grid.cjs` (modes: none = main, `hazard`, `extra`; env `POS=atx\|hr\|fence\|setext`; env `ARM=` picks a mutant bundle), `fam.cjs` (family partition), `pos.cjs`, `fm.cjs`, `cells.cjs`, `show.cjs`, `sum.cjs`, `cmp.cjs`, `mat.cjs`, `mutants.py`, plus the printed `matg.txt`, `hmat.txt`, `sum.txt`, `fam.base.txt`, `fam.extra.txt` |

---

## Method

Each note is `Para.`, then either a blank line ("fresh": block start) or nothing
("para": a paragraph is open), then one construct line set carrying a lead `{L}`,
then a blank line and a top-level `ZAFTX` sentinel that catches cascades.

- **Leads (33):** every string over {space, tab} of length 0 to 4 (31), plus 5 and 6
  spaces. That puts a tab at every position up to column 4 and every space-tab mix.
- **Containers (10):** none, `> `, `>`, `>\t`, `> > `, `- `, `-\t`, `1. `, `> - `, `- > `.
  Continuation lines carry the container's continuation prefix.
- **Main grid (15 constructs):** indented code, ATX, setext `===` and `---`
  underline leads, setext content-line lead, backtick fence, `$$` math, table (lead on
  every row), `<!--` block with a blank line inside, one-line `<!-- x -->`, `<div>`,
  `%%` block, `- ` / `1. ` / `> ` markers.
- **Hazard grid (6):** `<!--` over `===`, `<!--` over `---`, `Title <!--` over `===`,
  the NRL-114 shape `<!-- y --> <!-- a` / sentinel, a `<!--` block, a `%%` block. These
  carry the setext row, the quoted-setext rows (every quote container) and the tab-led
  `<!--` rows NRL-153 acceptance 4 asks for.
- **Extra grid (15, fix round 1):** an interrupt candidate carrying the lead inside a
  paragraph that spans an inline `<!--` (`Title <!--` / `{L}X` / sentinel / `-->`, with X
  each of `# x`, `***`, a fence, `- x`, `1. x`, `> x`, `<div>`, `$$`, `%%`); HR (`{L}***`
  / sentinel); a link reference definition `{L}[ZQSX]: https://example.com`; a footnote
  definition `{L}[^1]: ZQSX`; an unclosed `{L}$$` / sentinel; a table with the lead on
  every row and the sentinel in the LAST column (`tableDrop`); a table with the lead on
  the first row only (`tableRow1`).
- **Position grids (fix round 1):** the 15 main constructs, block-start only, directly
  after `# Head`, `***`, a closed fence or a setext heading with no blank line between
  (`POS=`). 4,950 notes each.
- **Frontmatter grid:** the 33 leads on the opening or the closing `---` of
  `---` / `title: ZQSX` / `---` at note start (`fm.cjs`).
- **Renderer verdict:** `GT(WT(src))`, walked with a tag stack (the `oracle111.cjs`
  comment and quoted-attribute rules), classifying the sentinel as hidden, prose,
  `<pre>` code, math, table or heading. Visible text alone cannot tell `<pre>` from `<p>`.
- **Our verdict:** `extractChunks` at two profiles: ON (skip code blocks, tables,
  headings) and OFF (all three spoken). Inline code is spoken in both. Math blocks
  are never spoken by the extractor, so a math verdict expects silence.
- **Failure directions:** *prose loss* (renderer displays prose, we are silent),
  *disclosure* (renderer hides, we speak), *excluded-content speech* (renderer shows
  code, table, heading or math that the profile excludes, and we speak it). Marker
  glyphs were checked separately for `#`, `-`, `1.`, `>` and `***`: *marker leak* (we
  speak a marker the renderer consumed) and *marker loss* (we drop one it displays).
- **Lead-dependent:** a cell whose lead is non-empty and whose row agrees with the
  renderer at the empty lead. Otherwise it is *lead-independent*.

| Grid | Notes | Cells | Divergent on `60ff058` |
|---|---|---|---|
| main + hazard | 13,860 | 55,440 | **4,720** |
| extra | 9,900 | 39,600 | **3,122** |
| positions (4) | 19,800 | 79,200 | **11,404**, of which 2,806 are position-specific |
| frontmatter | 66 | 132 | **96** |

---

## Renderer rules, executed

Lead indices below refer to the 33-lead order printed in `matg.txt`. Every rule was
read off the measured class strings, not from the tokenizers' source.

| Construct (renderer module) | Block start (no paragraph open) | Paragraph open (interrupt) | Tab handling | Cap unit |
|---|---|---|---|---|
| Indented code (134) | lead matches `^(?: {4}\|\t)`: four literal spaces or a tab at offset 0. ` \t`, `  \t`, `   \t` are NOT code | never interrupts | literal, no tab-stop expansion | characters |
| ATX heading (8469) | any spaces and tabs, uncapped, once the line is not indented code (`   \t# x` and ` \t\t\t# x` are `<h1>`) | 0-3 spaces only; any tab refuses | skipped at block start, refused when interrupting | n/a at start; 3 spaces when interrupting |
| HR `***` | any lead once not indented code | 0-3 spaces only. A tab-led `***` is lazy text that displays `***` (29 top-level marker losses, 28-29 in every container paragraph) | skipped at start, refused when interrupting | 3 spaces when interrupting |
| Setext underline (8671) | n/a | NO lead at all: ` ===`, `\t===` are prose. ` ---` is a thematic break under the paragraph, not text | refused | zero |
| Setext content line | same as ATX block start | n/a | skipped | uncapped |
| Fence (1498) | any spaces and tabs once not indented code | 0-3 spaces only | skipped at start, refused when interrupting | 3 spaces when interrupting |
| `$$` math | top level: 0-3 spaces only. In a quote at block start: any lead that is not indented code after the peel. In a quote or list PARAGRAPH: every lead in the grid, because there it is an inline math span inside the paragraph (`- Para.` / `  \t$$` / `  ZQSX` / `  $$` gives `<li>Para.<br><span class="math math-block">ZQSX</span>`), not a block interrupt | top level 0-3 spaces | refused at top level, skipped in containers | container-dependent |
| `$$` with no closer | a lone `$$` opens a math block that runs to the END OF THE NOTE: `Para.` / blank / `$$` / `ZQSX` / blank / `ZAFTX` is one `math-block` holding both sentinels | same | n/a | n/a |
| Table (7793) | lead on EVERY row, not indented code: a table, but the lead becomes an empty first cell and the last column is dropped. `   \t\| a \| b \|` / `   \t\| - \| - \|` / `   \t\| c \| ZQSX \|` renders `<th></th><th>a</th>` ... `<td></td><td>c</td>`, so `b` and ZQSX are not displayed. Lead on the FIRST row only: not a table, one paragraph | never interrupts a paragraph | skipped | uncapped |
| Link reference definition | any lead once not indented code (` \t[ZQSX]: https://example.com` is hidden) | never interrupts a paragraph | skipped | uncapped |
| Footnote definition `[^1]:` | hidden by the harness at every non-code lead and in every container (the reading view's footnote section is not part of `GT`) | n/a | skipped | uncapped |
| Frontmatter | only a lead-free `---` on line 1 opens it and only a lead-free `---` closes it. ` ---` / `title: ZQSX` / `---` is an HR plus a setext `<h2>`; a lead on the closer leaves `title: ZQSX` as a displayed paragraph | n/a | refused | zero |
| HTML block, `<!--` and `<div>` (8776) | any spaces and tabs once not indented code | 0-3 spaces only | skipped at start, refused when interrupting | 3 spaces when interrupting |
| `%%` block (app `comment`) | 0-3 spaces only | 0-3 spaces only | refused | 3 spaces |
| List marker `-` / `1.` (745) | any lead once not indented code | 0-3 spaces; a tab or 4+ spaces leaves the marker as displayed lazy text | skipped at start | 3 spaces when interrupting |
| Quote marker `>` (6234) | any lead once not indented code | 0-3 spaces; otherwise displayed as lazy text | skipped at start | 3 spaces when interrupting |
| Callout marker `> [!note]` | any non-code lead before the `>` keeps the callout (` \t> [!note] T` renders the callout, and we agree) | as `>` | as `>` | as `>` |

**Container peels, executed:**

- **Quote:** eats `>` plus at most ONE SPACE. A tab after `>` is never eaten, so the
  remainder starts with a tab and rule 2 makes it indented code: every `>\t...` line in
  the grid (all constructs, all 33 leads, both contexts) renders as `<pre><code>` inside
  the quote. `> ` + lead behaves exactly like the top-level lead; `>` + lead behaves
  like the lead with its first space removed; `> > ` is the same as `> `.
- **List item:** the first line eats the marker plus `( {1,4}(?! )| |\t)` (the rule
  `PEEL_LEAD` already encodes). So `-` followed by 1 to 4 spaces and text is prose
  (`-    ZQSX` is `<li>ZQSX</li>`), and `-` followed by 5 or more spaces is code
  (`- ` + 4 spaces + `ZQSX`, i.e. `-     ZQSX`, is `<li><pre><code>`). `- ` + `  \tx` is
  code because the spaces go and the tab is left at offset 0. `-\t` eats the tab, so its
  lead then behaves as at top level.
- After the peel, the remainder is judged by the block-start or interrupt rule above,
  with two exceptions measured in containers: `$$` (container-dependent, see table)
  and setext over `<!--` (see the hazards).

---

## The one model

1. **Peel containers first, with the renderer's own peel.** Quote: `>` plus one space,
   never a tab. List: marker plus `PEEL_LEAD`, and continuation lines dedented by the
   item's content width. Every predicate below sees the peeled remainder, never the
   raw line.
2. **Indented code is literal:** `^(?: {4}|\t)` on the peeled remainder, at block
   start only. No column arithmetic anywhere. This includes the remainder after `>`
   when the next character is a tab.
3. **Block-start constructs** (ATX, HR, setext content, fence, table, link reference
   and footnote definitions, HTML block, list and quote markers) accept any run of
   spaces and tabs once rule 2 has declined the line. A table whose rows carry a lead
   gains an empty first column and loses its last column; a table whose first row
   alone carries a lead is a paragraph.
4. **Interrupting constructs** (ATX, HR, fence, HTML block, list and quote markers,
   top-level `$$`, `%%`) accept 0-3 SPACES only. A tab anywhere in the lead refuses the
   interrupt and the line is a lazy continuation that displays its markers. This holds
   inside a paragraph that spans an inline `<!--`: a refused interrupt leaves the
   comment open, so its body stays hidden. Indented code, tables and link reference
   definitions never interrupt. A setext underline takes no lead at all. Inside a
   quote or list paragraph `$$` is not a block interrupt at all: every lead makes an
   inline math span, so rule 4 does not apply to container `$$`.
5. **`%%` and top-level `$$` take 0-3 spaces even at block start.** They are the two
   block-start exceptions to rule 3.
6. **A `$$` with no closer runs to the end of the note.** Frontmatter delimiters take
   no lead.

**Deliberate divergences.** One, written in the code: the extractChunks math site says
"With no closer anywhere it is not a block, so a stray `$$` cannot swallow the rest of
the note", and `opensMathBlock` requires a later `$$` line. The renderer does swallow
it, so we speak math source the renderer shows as math (180 excluded-speech cells:
116 in the main grid, 64 in the extra grid). It fails toward speech, not loss. Whether
to keep it is the owner's call (new child below). No other predicate needs to differ
from the model to avoid a measured harm. One caution stays in force: where a predicate
cannot yet see the container peel (rule 1), the narrower lead rule is the fail-closed
one only for the hide direction. The M4 mutant shows a top-level rule applied to raw
list lines is wrong in the other direction, so "narrow" is not automatically safe.

---

## Measured divergences on `60ff058`

`fam.cjs` assigns every divergent cell to exactly one family (first matching rule
wins). The tables sum exactly to their grid totals. Disclosure families come first.

### Main + hazard grids: 4,720 cells

| # | Family | Cells | Direction | Example note (renderer vs us) | Owner |
|---|---|---|---|---|---|
| 1 | setext over `<!--` under a quote in a list | 66 | **disclosure** | `- > Para.` / `  > Title <!--` / `  > ===` / `  > ZQSX` / `  > -->`: renderer `Para. Title`; we speak `Para. Title <!-- === ZQSX -->` | NRL-187 |
| 2 | setext over `<!--` in a list item (`- `, `-\t`, `1. `, `> - `, `- > `) | 540 (312 sentinel + 228 cascade; 32 lead-dependent) | prose loss to end of note | `-  <!--` / `  ===` / `  ZQSX` / `  more`: renderer `<h1>&lt;!--</h1>` then ZQSX, more; we speak only `Para.`. At the empty lead (`- <!--`) we lose nothing and only leak `<!--` / `===`. The `Title <!--` form loses only in the `-->`-closed shape | NRL-188 |
| 3 | `>\t`: the tab after `>` is not eaten, so the line is container indented code | 1,386 (1,320 ON + 66 OFF one-line-comment loss) | excluded-content speech | `>\tZQSX`: `<pre><code>`; we speak it with skip code on | NRL-179 |
| 4 | container indented code (other containers), including markers, one-line comments, link and footnote definitions inside it | 1,388 (1,205 excluded speech + 183 OFF loss) | excluded-content speech; comment-in-code loss | `> \tZQSX`, `-     ZQSX` | NRL-179 |
| 5 | tab-led table in `1. `: first row container code, the rest lazy prose | 11 | prose loss (ON) | `1. \t\| a \| b \|` / `   \t\| - \| - \|` / `   \t\| ZQSX \| c \|`: renderer `<pre>` then text; we speak `\| a \| b \|` and drop ZQSX | NRL-179 |
| 6 | `HEADING` / `BLOCKQUOTE` 3-character block-start cap | 7 (+7 `#` and 7 `>` marker leaks) | excluded-content speech; marker leak | `   \t# ZQSX`: `<h1>`; we speak `# ZQSX` | NRL-147 item 3 |
| 7 | tab-led ATX interrupt (`interruptsParagraph`'s `HEADING`) | 27 (11 top loss, 5 list loss, 11 list excluded speech) | prose loss | `Para.` / `\t# ZQSX`: renderer `Para. # ZQSX`; we speak `Para.` | NRL-189 |
| 8 | top-level `$$` lead (`trimStart()` in `opensMathBlock` and the math mask) | 80 | prose loss | ` \t$$` / `ZQSX` / `$$`: renderer prose; we are silent | NRL-147 item 2 |
| 9 | top-level unclosed `$$` runs to end of note (the closing `$$` of a lead-refused block reopens and swallows `ZAFTX`) | 116 | excluded-content speech | `Para.` / blank / `$$` / `ZQSX` / blank / `ZAFTX`: one `math-block`; we speak `$$ ZQSX ZAFTX` | new child (unclosed `$$`) |
| 10 | `$$` in containers not skipped | 492 | excluded-content speech | `> $$` / `> ZQSX` / `> $$` | NRL-192 |
| 11 | table directly under a paragraph line | 132 | prose loss (ON) | `Para.` / `\| a \| b \|` / `\| - \| - \|` / `\| ZQSX \| c \|` | NRL-190 |
| 12 | fence in a list paragraph, judged on the raw line | 68 (37 sentinel loss + 26 cascade loss + 5 excluded speech) | prose loss, including the rest of the note | `- Para.` / `    ```` / `  ZQSX` / `  ```` / blank / `ZAFTX` | NRL-191 |
| 13 | fenced code in a list item at block start: skip code on loses the rest of the note (lead-independent, empty lead included) | 38 | prose loss | `- ```` / `  ZQSX` / `  ```` / blank / `ZAFTX`: renderer shows ZAFTX; at ON we speak ZQSX and lose ZAFTX | NRL-151 / NRL-168 if either covers it (not in this run's state), else NRL-191 |
| 14 | fenced code in containers not skipped (lead-independent) | 106 | excluded-content speech | `> ```` / `> ZQSX` / `> ```` | NRL-151 / NRL-168 (unchecked) |
| 15 | heading, setext and table skip not applied in containers | 263 (+ `#` leaks) | excluded-content speech; `#` leak | `> # ZQSX`: spoken with skip headings on, `# ZQSX` with it off | NRL-192 |
| | **total** | **4,720** | | | |

Marker glyphs (separate check, not cells): `-` and `1.` lazy-line marker losses are 29
at top level and 28-29 in every container paragraph (`> `, `>`, `> > `, `- `, `-\t`,
`> - `, `- > `; 24 in `1. `). `>` is 11 at top level, 11-18 in quote containers and
`- > `, and 1-4 in list containers.
`***` (HR) is 29 at top level and 28-29 per container paragraph. All belong to NRL-189.

### Extra grid: 3,122 cells

| # | Family | Cells | Direction | Example note (renderer vs us) | Owner |
|---|---|---|---|---|---|
| 1 | tab-led interrupt candidate (ATX, HR, fence) inside a paragraph that spans an inline `<!--` | 165 (ATX 64, HR 64: top 44 each + lists 20 each; fence 37 in `- ` / `1. `, OFF) | **disclosure** | `Para.` / blank / `Title <!--` / `\t# x` / `ZQSX` / `-->`: renderer `<p>Title <!--...--></p>` displays `Title`; we speak `Title <!-- ZQSX -->` (and `x` at OFF). Same with ` \t***` | new child (interrupt in a comment-spanning paragraph) |
| 2 | `LINK_REF_DEF` (`^ {0,3}\[`) refuses a tab-bearing lead the renderer accepts | 118 (top 22, `> ` / `>` / `> > ` 52, `-\t` 22, `- > ` 22) | **disclosure** | `Para.` / blank / ` \t[ZQSX]: https://example.com`: renderer hides it; we speak `ZQSX :` | new child (link reference lead) |
| 3 | table with a lead on every row: empty first column, last column dropped | 126 (top 14 OFF; quotes 70 and `- > ` 28 at both profiles because quoted tables are not skipped; `-\t` 14 OFF) | **disclosure** | `   \t\| a \| b \|` / `   \t\| - \| - \|` / `   \t\| c \| ZQSX \|`: renderer drops `b` and ZQSX; at OFF we speak both | new child (table leads) |
| 4 | same interrupt candidates (and `- x`, `1. x`, fence) inside a comment-spanning LIST paragraph, lead-dependent | 134 | prose loss | `- Title <!--` / `  ` + `  # x` / `  ZQSX` / `  -->` | new child (interrupt in a comment-spanning paragraph) |
| 5 | `<div>`, `>` (and in lists `- `, `1. `) at 0 lead ends a comment-spanning paragraph, lead-independent | 328 (`<div>` 148, `>` 148, `- ` 16, `1. ` 16) | prose loss | `Title <!--` / `<div>` / `ZQSX` / `-->`: renderer `<p>Title &lt;!--</p><div>ZQSX-->`; we speak `Title`. `Title <!--` / `> x` / `ZQSX` / `-->`: renderer shows a quote `x ZQSX -->`; we speak `Title` | new child (block after a comment-spanning line) |
| 6 | table with a lead on the first row only: a paragraph, which skip tables drops | 122 (top 32, lists 90) | prose loss (ON) | `   \| a \| b \|` / `\| - \| - \|` / `\| ZQSX \| c \|`: one `<p>`; at ON we speak nothing of it | new child (table leads) |
| 7 | unclosed top-level `$$` | 64 | excluded-content speech | `Para.` / blank / `$$` / `ZQSX` / blank / `ZAFTX` | new child (unclosed `$$`) |
| 8 | `$$` in containers not skipped | 220 | excluded-content speech | `> $$` / `> ZQSX` | NRL-192 |
| 9 | table directly under a paragraph line (both table shapes) | 264 | prose loss (ON) | as main family 11 | NRL-190 |
| 10 | fenced code in a list item loses the rest of the note at ON | 43 | prose loss | `- Title <!--` / `  ```` / `  ZQSX` / `  -->`: renderer `<pre>` inside the item and ZAFTX shown; we lose ZAFTX | as main family 13 |
| 11 | fenced code in containers not skipped | 46 (38 excluded speech, 8 OFF loss) | excluded-content speech | as main family 14 | NRL-151 / NRL-168 (unchecked) |
| 12 | `>\t` container indented code | 990 | excluded-content speech | `>\t[ZQSX]: ...`, `>\t***` | NRL-179 |
| 13 | container indented code (other containers) | 473 | excluded-content speech | `> \t[^1]: ZQSX` | NRL-179 |
| 14 | tab-led table in `1. ` | 11 | prose loss | as main family 5 | NRL-179 |
| 15 | heading / table skip not applied in containers | 18 | excluded-content speech | quoted table | NRL-192 |
| | **total** | **3,122** | | | |

What agrees in the extra grid: footnote definitions at every non-code lead in every
container; HR alone outside `>\t` (the cell sentinel agrees, the `***` glyph is the
marker loss above); `%%` inside a comment-spanning paragraph; callout marker leads
(spot-checked, not gridded).

### Frontmatter grid: 96 of 132 cells

Our frontmatter skip ignores the delimiter lead. A lead on the closing `---` (any of the
32 non-empty leads) leaves `title: ZQSX` displayed as prose and we drop it at both
profiles (64 prose-loss cells). A lead on the opening `---` makes `title: ZQSX` a
setext `<h2>` the renderer displays; we drop it at OFF (32 heading-loss cells). Owner:
new child (frontmatter leads).

### Position grids (after `# Head`, `***`, a closed fence, a setext heading; no blank)

79,200 cells, 11,404 divergent. Of those, 2,806 diverge in a way the same cell after a
blank line does not: 379 after an ATX heading, 379 after an HR, 379 after a setext
heading and 1,669 after a fence (`pos.cjs`). The top-level position-specific cells are
the same after ATX, HR and setext: a tab-led line directly after the block is
indented code to the renderer and we do not see it. `# Head` / `\t<!-- a` / blank /
`ZQSX` / `-->` / blank / `ZAFTX`: the renderer shows `<!-- a` as code and `ZQSX -->` as
prose; at ON we speak only `ZAFTX` (36 math and 36 `<!--` loss cells, 18 each of
indented code, `-`, `1.`, `>` excluded speech, 18 one-line-comment losses, 11 ATX per
block). In lists, tab-led `$$` (108) and fences (50) lose prose. After a fence, the same
173 top-level cells appear and the other 1,496 are in containers, dominated by main
family 13's mechanism: `- ```` / `  x` / `  ```` / `  ZQSX` / blank / `ZAFTX` renders the
code then `ZQSX` and `ZAFTX` as prose; at ON we speak only `x` (the code) and lose the
rest of the note, at every lead including none. Owner: NRL-157 (after-ATX position)
for the top-level rows; main family 13's owner for the fence rows.

---

## Composition hazards (NRL-113 / NRL-114, re-checked on `60ff058`)

Single-predicate mutants were built in shadow copies (`mutants.py`) and run through the
grids. Moved cells are counted against the renderer per profile and sentinel (`cmp.cjs`).

| Mutant | Fixed | Newly wrong | What it shows |
|---|---|---|---|
| M1: `INDENTED_CODE` back to `/^(?: {4}\| {0,3}\t)/` (undo NRL-113) (round 0) | 22 math, 7 ATX | **44 disclosures** on the NRL-114 shape ` \t<!-- y --> <!-- a`, plus 11 each newly lost on indented code, list, ordered and quote markers and fence cascades, 11 fence excluded speech | `INDENTED_CODE` still composes with the HTML opener, math, ATX, fence and marker predicates. Widening it back is a disclosure. |
| M2: quote peel `>\s?` to `> ?` in `BLOCKQUOTE` and `BLOCKQUOTE_ONE_LEVEL` only (round 0) | 0 | 0 | These constants do not decide `>\t` lines. |
| M2b: the real peel, `QUOTE_PREFIX_PEEL` and `QUOTE_LEVEL_PEEL`, widened to eat a tab (round 1) | 0 main / hazard; 8 extra | 0 main / hazard; 8 extra (`>\t[ZQSX]: ...` moves from excluded speech to OFF loss) | The peel regexes already refuse the tab (`>[ \r]?`), as do `QUOTE_CONTENT_LEVEL` and `TERM2_QUOTE_LEVEL`. The 1,386 `>\t` cells are decided by the missing container indented-code rule (rule 2 on the peeled remainder): we speak `>\tZQSX`, `> \tZQSX`, `>     ZQSX` and `-     ZQSX` alike with skip code on. `BLOCKQUOTE` / `BLOCKQUOTE_ONE_LEVEL` (and `containerLeadOk` through them) eat the tab, but they matter only once container code is recognised. |
| M3: `HEADING` to the block-start rule (`^(?! {4}\|\t)[ \t]*#`) (round 0) | 22 (11 excluded speech, 11 loss) | **39 newly lost**, 3 excluded speech | `HEADING` serves both block start and interrupt. One regex cannot hold both rules; widening it for NRL-147 item 3 alone loses `Para.` / `   \t# x`. |
| M4: both math sites to `^ {0,3}\$\$` (re-run in round 1) | 80 | **192** excluded speech in lists | Fixes main family 8 only. 0 of the 116 cascade cells (main family 9) and 0 extra-grid cells move: they are the unclosed-`$$` rule, not `trimStart()`. Narrowing the raw-line test without the list dedent swaps top-level loss for list-paragraph math (an inline span there) being spoken. |
| M5: `LINK_REF_DEF` lead to the block-start rule (`^(?! {4}\|\t)[ \t]*\[`) (round 1) | 118 (all of extra family 2) | 0 in all three grids | The link-reference disclosure is independent of the other predicates in these grids. |

**Sets that must change together** (each set is one diff in the order below):

- **A. Interrupt and block-start lead set:** `HEADING`, `HR`, `LIST_BULLET`,
  `BLOCKQUOTE` in `interruptsParagraphExceptBareMarker` (with `SETEXT` and `TABLE_ROW`
  beside them in that function), and `HEADING` / `BLOCKQUOTE` block-start use. This
  set carries the in-comment interrupt disclosure, NRL-189 and NRL-147 item 3. M3 shows
  the halves cannot land apart.
- **B. Setext over `<!--` in containers:** the setext pre-pass and `isSetextContentLine`,
  `PLAIN_SETEXT_HTML_OPENER` / `MODULE134_INDENTED_CODE`, `opensHtmlBlock`'s
  `leadIndented` / `listStrip`, the list peel (`PEEL_LEAD`, `listStrip`) and the quote-in-
  list peel (`listDedented` / `dedentQuoteGate`, `peelQuotes`), with `INDENTED_CODE` and
  `HTML_OPENER_AT_START` (the NRL-113 / NRL-155 set). NRL-187 and NRL-188 both edit it.
  M1 confirms the pairing still holds.
- **C. Math:** `opensMathBlock` and the extractChunks math mask (two copies of one
  test), the unclosed-`$$` rule, and the container peel. NRL-147 item 2, the unclosed-`$$`
  child and NRL-192's math half.
- **D. Tables:** `TABLE_ROW` and the table skip site. NRL-147 item 1, NRL-190 and the
  table-lead child.
- **E. Fences in lists:** `FENCE` / `fenceOpensAt` with the list dedent (`listStrip`,
  `PEEL_LEAD`). NRL-191 and main family 13.
- **F. Container indented code:** `INDENTED_CODE` applied to the peeled remainder, with
  `BLOCKQUOTE`, `BLOCKQUOTE_ONE_LEVEL` and `containerLeadOk`. NRL-179.
- `LINK_REF_DEF` stands alone (M5).

**How the hazard changed.** NRL-113's blocking shape now agrees:
`Intro prose.` / blank / ` \t<!--` / `---` / `HIDDENA` / `more` and its `===` twin are
correct in every top-level and quote cell of the hazard grid. NRL-114's ` \t<!-- y -->
<!-- a` shape is correct everywhere. The hazard moved in two directions. Into list
items: setext over `<!--` inside `- `, `-\t`, `1. `, `> - ` and `- > ` loses the rest of
the note (540 cells), and a quote inside a list discloses (66 cells). Into paragraphs
that span an inline `<!--`: a tab-led ATX, HR or fence inside such a paragraph
discloses the comment body (165 cells), which is the NRL-113/114 shape with the
interrupt rule instead of the opener rule.

---

## Recommended order

Disclosure first. Each step is one diff, re-runs `grid.cjs` (main, `hazard`, `extra`,
and the four `POS=` grids) and `fm.cjs` on its composed tree, and reports moved cells
by direction at both profiles, before and after.

1. **Link reference lead (new child).** Disclosure, 118 cells; M5 fixes all of them and
   moves nothing else.
2. **Set A as one diff: the in-comment interrupt disclosure (new child), NRL-189 and
   NRL-147 item 3.** 165 disclosure cells plus 134 + 27 loss cells, the marker
   losses, and the 7-cell block-start cap.
3. **Set B as one diff: NRL-187 and NRL-188.** 66 disclosure + 540 loss cells. This
   diff delivers the list dedent (continuation lines dedented by the item's content
   width) that steps 5 and 7 need, and it lands before anything else moves
   `INDENTED_CODE`'s callers.
4. **Set D as one diff: the table-lead child, NRL-147 item 1 and NRL-190.** 126
   disclosure cells (column drop), then 122 + 132 + 264 loss cells.
5. **Set C as one diff: NRL-147 item 2, the unclosed-`$$` child, and NRL-192's math
   half**, after step 3's dedent. M4 is the warning.
6. **Block after a comment-spanning line (new child).** 328 lead-independent loss cells;
   it touches the comment-span scan, not a lead predicate, so it can move earlier if its
   census shows no set A overlap.
7. **Set E: NRL-191 plus main family 13** (check NRL-151 / NRL-168 first), after step 3.
8. **Set F: NRL-179** (container indented code, including `>\t` and the `1. ` table).
   It changes what is code in containers, so it must re-run the hazard grid's `<!--`
   rows; M1 is the warning.
9. **NRL-173** after NRL-179: its `>\t` lone line follows the same peel rule.
10. **NRL-192's heading and table half.**
11. **Frontmatter leads (new child).**
12. **NRL-157** with the four position grids as its census.

---

## Limits

- Reading view only, through the harness. Live Preview is separate code. NOT VERIFIED
  IN OBSIDIAN.
- Positions covered: after a blank line, after a paragraph line, and (block start only)
  directly after an ATX heading, an HR, a closed fence and a setext heading. The
  position grids carry no paragraph-open variant and no hazard or extra constructs.
- Speech is judged by sentinel presence plus five marker glyphs. Other markup leaks,
  `sourceIndex` lockstep and option masks beyond the two profiles were not measured.
- Containers are one level, plus two nestings. Tilde fences, `+`/`*` bullets and `)`
  ordinals were not varied. Callout leads were spot-checked, not gridded.
- The family partition is rule-based (`fam.cjs`): a cell matching two families is
  counted once, in the first. The partition is exact in total, not a causal proof for
  every cell. Family 5 (`<div>` / `>` ending a comment-spanning paragraph) was not traced
  to a predicate.
- NRL-146, NRL-149, NRL-151, NRL-161, NRL-168, NRL-174 and NRL-185 were not in this
  run's ticket state, so overlap with them is unchecked.
