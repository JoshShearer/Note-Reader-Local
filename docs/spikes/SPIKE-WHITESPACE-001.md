# SPIKE-WHITESPACE-001: One Whitespace Model for the Lead Predicates

## Result
**ANSWERED (reading view only)** - the renderer's lead rules were read by executing
Obsidian's own parser, the one model is stated below, and every predicate's divergence
from it is measured with a failure direction. No `src/` change was made (NRL-153 ran
as a spike, acceptance 1-2 only). NOT VERIFIED IN A LIVE OBSIDIAN.

---

## Environment

| Property | Value |
|----------|-------|
| Ticket | NRL-153, run as a spike by the run's clarification: NRL-113 and NRL-114 already landed separately, so "one diff" is overtaken |
| Base | `60ff058` (`src/text/extract.ts`, bundled with the repo's esbuild 0.24) |
| Renderer | parser harness 1.14.4 (`app.js` sha256 `958ce57f...2df9`, the asar the installed app loads) and 1.13.7 (`8efbf581...9898`) |
| Harness validation | `node selftest.cjs` printed `SELFTEST OK` on both before any verdict |
| Version differential | 0 renderer-class differences between 1.13.7 and 1.14.4 on all 13,860 grid notes |
| Shadow arm | `src/` copied (not symlinked) per mutant; the INDENTED_CODE mutant moved cells, so the shadow is read |
| Test date | 2026-10-15 |
| Scripts | `.claude/runs/NRL-153/spike/` in the primary checkout (gitignored): `grid.cjs`, `mat.cjs`, `sum.cjs`, `cmp.cjs`, plus the printed matrices `matg.txt`, `hmat.txt`, `sum.txt` |

---

## Method

Each note is `Para.`, then either a blank line ("fresh": block start) or nothing
("para": a paragraph is open), then one construct line set carrying a lead `{L}`,
then a blank line and a top-level `ZAFTX` sentinel that catches cascades.

- **Leads (33):** every string over {space, tab} of length 0 to 4 (31), plus 5 and 6
  spaces. That puts a tab at every position up to column 4 and every space-tab mix.
- **Containers (10):** none, `> `, `>`, `>\t`, `> > `, `- `, `-\t`, `1. `, `> - `, `- > `.
  Continuation lines carry the container's continuation prefix.
- **Constructs, main grid (15):** indented code, ATX, setext `===` and `---`
  underline leads, setext content-line lead, backtick fence, `$$` math, table (lead on
  every row), `<!--` block with a blank line inside, one-line `<!-- x -->`, `<div>`,
  `%%` block, `- ` / `1. ` / `> ` markers.
- **Constructs, hazard grid (6):** `<!--` over `===`, `<!--` over `---`, `Title <!--`
  over `===`, the NRL-114 shape `<!-- y --> <!-- a` / sentinel, a `<!--` block, a
  `%%` block. These carry the setext row, the quoted-setext rows (every quote
  container) and the tab-led `<!--` rows NRL-153 acceptance 4 asks for.
- **Renderer verdict:** `GT(WT(src))`, walked with a tag stack (the `oracle111.cjs`
  comment and quoted-attribute rules), classifying the sentinel as hidden, prose,
  `<pre>` code, math, table or heading. Visible text alone cannot tell `<pre>` from `<p>`.
- **Our verdict:** `extractChunks` at two profiles: ON (skip code blocks, tables,
  headings) and OFF (all three spoken). Inline code is spoken in both. Math blocks
  are never spoken by the extractor, so a math verdict expects silence.
- **Failure directions:** *prose loss* (renderer displays prose, we are silent),
  *disclosure* (renderer hides, we speak), *excluded-content speech* (renderer shows
  code, table, heading or math that the profile excludes, and we speak it). Marker
  glyphs were checked separately for `#`, `-`, `1.` and `>`: *marker leak* (we speak a
  marker the renderer consumed) and *marker loss* (we drop one it displays).

13,860 notes x 2 profiles x 2 sentinels = **55,440 cells; 4,720 diverge** on `60ff058`.
A cell is called *lead-dependent* when its lead is non-empty and the same row at the
empty lead agrees with the renderer; otherwise it is *lead-independent*.

---

## Renderer rules, executed

Lead indices below refer to the 33-lead order printed in `matg.txt`. Every rule was
read off the measured class strings, not from the tokenizers' source.

| Construct (renderer module) | Block start (no paragraph open) | Paragraph open (interrupt) | Tab handling | Cap unit |
|---|---|---|---|---|
| Indented code (134) | lead matches `^(?: {4}\|\t)`: four literal spaces or a tab at offset 0. ` \t`, `  \t`, `   \t` are NOT code | never interrupts | literal, no tab-stop expansion | characters |
| ATX heading (8469) | any spaces and tabs, uncapped, once the line is not indented code (`   \t# x` and ` \t\t\t# x` are `<h1>`) | 0-3 spaces only; any tab refuses | skipped at block start, refused when interrupting | n/a at start; 3 spaces when interrupting |
| Setext underline (8671) | n/a | NO lead at all: ` ===`, `\t===` are prose | refused | zero |
| Setext content line | same as ATX block start | n/a | skipped | uncapped |
| Fence (1498) | any spaces and tabs once not indented code | 0-3 spaces only | skipped at start, refused when interrupting | 3 spaces when interrupting |
| `$$` math | 0-3 spaces only at top level; inside a quote, any lead that is not indented code after the peel; inside a quote or list paragraph, every lead in the grid | 0-3 spaces at top level | refused at top level, skipped in containers | container-dependent |
| Table (7793) | any spaces and tabs once not indented code (lead on every row) | never interrupts a paragraph | skipped | uncapped |
| HTML block, `<!--` and `<div>` (8776) | any spaces and tabs once not indented code | 0-3 spaces only | skipped at start, refused when interrupting | 3 spaces when interrupting |
| `%%` block (app `comment`) | 0-3 spaces only | 0-3 spaces only | refused | 3 spaces |
| List marker `-` / `1.` (745) | any lead once not indented code | 0-3 spaces; a tab or 4+ spaces leaves the marker as displayed lazy text | skipped at start | 3 spaces when interrupting |
| Quote marker `>` (6234) | any lead once not indented code | 0-3 spaces; otherwise displayed as lazy text | skipped at start | 3 spaces when interrupting |

**Container peels, executed:**

- **Quote:** eats `>` plus at most ONE SPACE. A tab after `>` is never eaten: every
  `>\t...` line in the grid (all 15 constructs, all 33 leads, both contexts) renders
  as `<pre><code>` inside the quote. `> ` + lead behaves exactly like the top-level
  lead; `>` + lead behaves like the lead with its first space removed; `> > ` is the
  same as `> `.
- **List item:** the first line eats the marker plus `( {1,4}(?! )| |\t)` (the rule
  `PEEL_LEAD` already encodes): `- ` + `  \tx` is code because up to four spaces go
  and the tab is left at offset 0; `- ` + 4 spaces + `x` is prose; `- ` + 5 spaces is
  code. `-\t` eats the tab, so its lead then behaves as at top level.
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
   start only. No column arithmetic anywhere.
3. **Block-start constructs** (ATX, setext content, fence, table, HTML block, list and
   quote markers) accept any run of spaces and tabs once rule 2 has declined the line.
4. **Interrupting constructs** (ATX, fence, HTML block, list and quote markers, `$$`,
   `%%`) accept 0-3 SPACES only. A tab anywhere in the lead refuses the interrupt and
   the line is a lazy continuation that displays its markers. Indented code and tables
   never interrupt. A setext underline takes no lead at all.
5. **`%%` and top-level `$$` take 0-3 spaces even at block start.** They are the two
   block-start exceptions to rule 3.

**Deliberate divergences.** None is justified by the grid: no predicate needs to
differ from this model to avoid a measured harm. One caution stays in force: where a
predicate cannot yet see the container peel (rule 1), the narrower lead rule is the
fail-closed one only for the hide direction. The M4 mutant below shows a top-level
rule applied to raw list lines is wrong in the other direction, so "narrow" is not
automatically safe.

---

## Measured divergences on `60ff058`

| Predicate | Divergence from the model | Cells | Direction | Example note (renderer vs us) | Owner |
|---|---|---|---|---|---|
| `HEADING` (block start) | caps the lead at 3 characters, so a 4-character space-tab lead is a paragraph | 7 top (ON) + 7 marker leaks (OFF) | excluded-content speech; `#` leak | `   \t# ZQSX`: `<h1>`; we speak `# ZQSX` | NRL-147 item 3 |
| `BLOCKQUOTE` (block start) | same 3-character cap | 7 top marker leaks | `>` leak | `   \t> ZQSX`: blockquote; we speak `> ZQSX` | NRL-147 item 3 |
| `HEADING` in `interruptsParagraph` | `\s{0,3}` takes a tab, so `Para.` / `\t# ZQSX` is a heading to us | 11 top + 16 in lists (ON) | prose loss under skip headings; excluded speech in some list cells | renderer shows `Para. # ZQSX`; we speak `Para.` | new child (with NRL-147 item 3) |
| `LIST_BULLET` / `BLOCKQUOTE` on a lazy line | strip a marker that cannot interrupt (tab or 4+ lead) | 29 `-`, 29 `1.`, 11 `>` top (OFF) | marker loss (the `1.` is a spoken number) | `Para.` / `\t1. ZQSX`: renderer shows `1. ZQSX`; we drop `1.` | same child |
| `opensMathBlock` and the extractChunks math mask | `trimStart()` takes a tab | 40 S + 58 cascade cells per profile, top level | prose loss; cascade speaks an unclosed math body | ` \t$$` / `ZQSX` / `$$`: renderer prose; we are silent | NRL-147 item 2 |
| `$$` in quotes | quoted math is not skipped (lead-independent) | 492 | excluded-content speech (math source) | `> $$` / `> ZQSX` / `> $$` | new child (containers) |
| `TABLE_ROW` | a table directly under a paragraph line is a table to us; it never interrupts in the renderer (lead-independent) | 33 top + 99 lists (ON) | prose loss under skip tables | `Para.` / `\| a \| b \|` / `\| - \| - \|` / `\| ZQSX \| c \|` | new child (beside NRL-147 item 1) |
| `FENCE` / `fenceOpensAt` in a list paragraph | judged on the raw line, not the item-dedented one | 42 S + 26 cascade (ON) | prose loss, including the rest of the note | `- Para.` / `    ```` / `  ZQSX` / `  ```` / blank / `ZAFTX`: renderer fences ZQSX and shows ZAFTX; we speak ZQSX and lose ZAFTX | new child (overlap with NRL-151 / NRL-168 unchecked) |
| setext over `<!--` in a list item | the list-content lead does not reach NRL-155's setext rule | 672 (S and cascade) | prose loss to end of note | `- <!--` / `  ===` / `  ZQSX` / `  more`: renderer `<h1><!--</h1>` then ZQSX, more; we speak nothing after `Para.` | new child |
| setext under a two-line paragraph in a quote in a list | `- > Para.` / `  > Title <!--` / `  > ===`: we take `===` as an underline; the renderer keeps one paragraph and hides the comment | 66 | **disclosure** | renderer `Para. Title`; we speak `Para. Title <!-- === ZQSX -->` | new child (possibly NRL-114's quote-in-list residual) |
| Quote peel `>\s?` | eats the tab after `>`; every `>\t` line is code in the renderer | 1,320 (ON) + 66 (OFF) | excluded-content speech; OFF loses the shown text of a one-line comment in code | `>\tZQSX`: `<pre><code>`; we speak it with skip code on | NRL-179 (its acceptance names this rule) |
| Indented code, list/quote markers, one-line comment inside quotes and lists | container indented code not recognised | 915 | excluded-content speech (ON); comment-in-code loss (OFF) | `> \tZQSX` | NRL-179 |
| ATX, setext, table in containers | skip settings not applied inside quotes and lists, and a quoted ATX speaks its `#` (lead-independent) | 736 + marker leaks | excluded-content speech; `#` leak | `> # ZQSX`: we speak the heading with skip headings on, and `# ZQSX` with it off | new child |
| Fenced code in containers (lead-independent) | quoted and listed fences not skipped | 144 | excluded-content speech; 38 cascade losses | `> ```` / `> ZQSX` / `> ```` | NRL-151 / NRL-168 (not in this run's state; unchecked) |

What agrees: top-level indented code, fence, `<!--` and `<div>` blocks, `%%` blocks,
tables at block start, setext underlines and setext content lines match the renderer on
every top-level cell. The tab-led `<!--` rows (`cmtPair`, `cmtBlock`, `htmlComment`) agree
in every container except `>\t`, where only the skip-code direction diverges: no `>\t<!--`
cell discloses at either profile.

---

## Composition hazards (NRL-113 / NRL-114, re-checked on `60ff058`)

Four single-predicate mutants were built in shadow copies and run through both grids.
Moved cells are counted against the renderer per profile and sentinel.

| Mutant | Fixed | Newly wrong | What it shows |
|---|---|---|---|
| M1: `INDENTED_CODE` back to `/^(?: {4}\| {0,3}\t)/` (undo NRL-113) | 22 math, 7 ATX | **44 disclosures** on the NRL-114 shape ` \t<!-- y --> <!-- a`, plus 11 each newly lost on indented code, list, ordered and quote markers and fence cascades, 11 fence excluded speech | `INDENTED_CODE` still composes with the HTML opener, math, ATX, fence and marker predicates. Widening it back is a disclosure. |
| M2: quote peel `>\s?` to `> ?` in `BLOCKQUOTE` and `BLOCKQUOTE_ONE_LEVEL` only | 0 | 0 | Inference, not traced: the `>\t` decisions are carried by other copies (`peelQuotes`, `QUOTE_CONTENT_LEVEL`, `containerLeadOk`, `TERM2_QUOTE_LEVEL`). Changing the named constant alone is a no-op, so a quote-peel fix must find every copy. |
| M3: `HEADING` to the block-start rule (`^(?! {4}\|\t)[ \t]*#`) | 22 (11 excluded speech, 11 loss) | **39 newly lost**, 3 excluded speech | `HEADING` serves both block start and interrupt. One regex cannot hold both rules; widening it for NRL-147 item 3 alone loses `Para.` / `   \t# x`. |
| M4: both math sites to `^ {0,3}\$\$` | 80 | **192** excluded speech in lists | The math lead is container-dependent. Narrowing the raw-line test without the list dedent swaps top-level loss for list-item math being spoken. `opensMathBlock` and the extractChunks math mask must change together, after the container peel. |

**Pairs that must change together:**

- `HEADING` block-start and interrupt use, and the `LIST_BULLET` / `BLOCKQUOTE`
  interrupt use (one model rule 4 change).
- `opensMathBlock` and the extractChunks math mask (two copies of one test), with the
  list dedent.
- `INDENTED_CODE` with `opensHtmlBlock`'s `leadIndented`, `HTML_OPENER_AT_START`,
  `PLAIN_SETEXT_HTML_OPENER` / `MODULE134_INDENTED_CODE` and the setext pre-pass mask
  (the NRL-113 / NRL-155 set). M1 confirms the pairing still holds.
- Every quote-peel copy (`BLOCKQUOTE`, `BLOCKQUOTE_ONE_LEVEL`, `peelQuotes`,
  `QUOTE_CONTENT_LEVEL`, `containerLeadOk`, `TERM2_QUOTE_LEVEL`), as NRL-114 found.
- `FENCE` / `fenceOpensAt` with the list dedent (`listStrip`, `PEEL_LEAD`).

**How the hazard changed.** NRL-113's blocking shape now agrees:
`Intro prose.` / blank / ` \t<!--` / `---` / `HIDDENA` / `more` and its `===` twin are
correct in every top-level and quote cell of the hazard grid. NRL-114's ` \t<!-- y -->
<!-- a` shape is correct everywhere. The hazard moved into list items: the same
setext-over-`<!--` shape inside `- `, `-\t`, `1. `, `> - ` and `- > ` loses the rest of
the note (672 cells), and a quote inside a list discloses (66 cells).

---

## Recommended order

Each step should re-run `grid.cjs` (main and `hazard`) on its composed tree and report
moved cells by direction, at both profiles, before and after.

1. **Quote-in-list setext disclosure (new child).** Disclosure first; lead-independent,
   narrow shape.
2. **Setext over `<!--` in list items (new child).** Prose loss to end of note; it
   extends NRL-155's rule to the list peel and touches the NRL-113 set, so it lands
   before anything else moves `INDENTED_CODE`'s callers.
3. **NRL-147 item 3 plus the interrupt-lead child, as one diff.** M3 shows the halves
   cannot land apart.
4. **NRL-147 item 2 (math)**, both sites, after the list dedent is available to it.
5. **NRL-147 item 1 plus the table-interrupt child.** Same constant, same direction.
6. **Fence in a list paragraph (new child)**, coordinated with NRL-151 / NRL-168.
7. **NRL-179** (container indented code, including `>\t`). It changes what is code in
   containers, so it must re-run the hazard grid's `<!--` rows; M1 is the warning.
8. **NRL-173** after NRL-179: its `>\t` lone line follows the same peel rule.
9. **Container skip settings and quoted `#` (new child).**
10. **NRL-157** keeps its own position census: the after-ATX position is not in this
    grid and was not re-measured here.

---

## Limits

- Reading view only, through the harness. Live Preview is separate code. NOT VERIFIED
  IN OBSIDIAN.
- Positions covered: after a blank line and after a paragraph line. After an ATX
  heading, an HR, a fence or a setext underline were not covered (NRL-157's axis).
- Speech is judged by sentinel presence plus four marker glyphs. Other markup leaks,
  `sourceIndex` lockstep and option masks beyond the two profiles were not measured.
- Containers are one level, plus two nestings. Tilde fences, `+`/`*` bullets and `)`
  ordinals were not varied.
- NRL-146, NRL-149, NRL-161, NRL-174 and NRL-185 were not in this run's ticket state,
  so overlap with them is unchecked.
