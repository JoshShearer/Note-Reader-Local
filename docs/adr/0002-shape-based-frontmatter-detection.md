# 0002. Shape-based frontmatter detection

- Status: accepted
- Date: 2026-09-28
- Ticket: NRL-7 (R-M08)

## Context

`extractChunks` treated a `---` on line 0 as the start of YAML frontmatter and
skipped every line until the next `---`. That one positional check failed in
two opposite directions, both reproduced by bundling the real module:

- `"---\nSome prose here.\nMore prose in this note."` returned zero chunks. A
  horizontal rule at the top of a note, or any unterminated `---` there,
  swallowed the whole document and the user heard nothing.
- `"\n---\ntitle: secret\n---\nProse follows here."` returned
  `["title: secret", "Prose follows here."]`. A single leading blank line
  defeated the check and the frontmatter was read aloud. Frontmatter routinely
  holds tags, aliases and template fields, so this is close to a privacy defect.

Obsidian's own rule is positional: only a `---` on line 1 opens frontmatter.
Following it exactly fixes the first failure and keeps the second.

## Decision

1. **Detect frontmatter by shape as well as position.** `detectFrontmatter`
   in `src/text/extract.ts` treats a block as frontmatter only when all of
   these hold:
   - the opening `---` is the first non-blank line (leading blank lines are
     ignored);
   - a closing `---` exists;
   - every line between the fences is a `key:` line, a comment (`#`), blank,
     or, after a key, a list item (`- x`), an indented continuation, or a line
     inside a still-open flow collection (`tags: [a,` wrapped onto the next
     line);
   - at least one `key:` line is present.

   A key is anything up to the first `: ` that does not start with whitespace,
   `-` or `#`, or a quoted string. It is deliberately loose: an ASCII-only rule
   was tried first and started reading `título: x`, `日付: x`, `"my key": x`
   and `created (date): x` aloud on line-1 frontmatter that the old positional
   check had skipped. The fences also tolerate surrounding whitespace and a
   leading BOM, as the old check did.

   Anything else is a horizontal rule and the note is read normally.

2. **Deliberate divergence from Obsidian.** A note that begins with blank lines
   and then a `key: value` block is rendered by Obsidian as a rule followed by
   visible text. We stay silent on it. Staying silent on visible text is
   recoverable; reading someone's frontmatter aloud is not. The call site
   carries a comment saying so, so the check is not "fixed" back to positional.

3. **Key-shaped but invalid YAML is skipped.** `---\nnot: really: valid: yaml\n---`
   is treated as frontmatter. We do not run a YAML parser; the line matches the
   key shape, the governing principle above prefers silence, and Obsidian itself
   treats a line-1 fenced block as (invalid) properties, so this case agrees
   with Obsidian.

4. **An unterminated fence is never frontmatter.** `---\ntitle: x\nProse.` has
   no closing fence, so the `---` is a silent rule and the remaining lines are
   read, including `title: x`. That matches what Obsidian renders as visible
   text, and it means one stray `---` can no longer silence a note.

5. **Horizontal rules are explicit.** A thematic-break pattern (three or more
   of `-`, `*` or `_`, optionally spaced) is checked before list bullets, so
   `- - -` is silent instead of being read as a bullet containing `- -`. It
   touches no state. `Title\n---` (a setext heading) is left to NRL-8.

6. **Not `MetadataCache`.** `extractChunks(source, opts)` is a pure module with
   no `App` access; `src/main.ts` passes it only the note source and options,
   and the tests run it in bare Node where `obsidian` is external. Beyond that,
   `MetadataCache.frontmatterPosition` follows Obsidian's positional rule, which
   gives the wrong answer for the blank-line privacy case in point 2.

## Consequences

- Skipped frontmatter lines are dropped whole while the raw offset still
  advances past them, so every later `sourceIndex` entry remains a true raw
  offset. Tests pin the first spoken character of both the skipped and the
  horizontal-rule cases to its source position.
- A note whose visible text happens to be a fenced block of `key: value` lines
  after leading blank lines will not be read. This is the accepted cost.
- Frontmatter skipping is still unconditional. `skipFrontmatter` (added by
  NRL-5, ADR 0001) is stored but not read; wiring it is NRL-21.
