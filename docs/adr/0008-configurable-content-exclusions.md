# 0008. Configurable content exclusions: frontmatter, image alt text and embeds

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-21 (R-M09, R-M13)
- Supersedes: ADR 0001 clause 6 for three keys; ADR 0002 clause 5's closing note

## Context

R-M09 names six exclusions the user must be able to configure. `skipFrontmatter`,
`speakImageAlt` and `speakEmbeds` were stored and migrated by NRL-5 but were not
fields on `ExtractOptions` at all, so extraction could not read them even in
principle. Bundling the real module and running it confirmed that each of the
three produced byte-identical output in both positions, and that passing a
nonsense value for all three changed nothing either: frontmatter was skipped
unconditionally, a markdown image was dropped with the comment "alt text is not
prose", and an `![[embed]]` was dropped by a branch whose comment already named
this ticket.

The same probe found a leak that was not in the ticket. The image branch
consumed only a `(...)` tail, so the reference form `![alt][ref]` left `[ref]`
behind for the link branch and spoke the reference id: `Before ![alt][ref] after.`
was read as `Before ref after.`

The settings tab also offered one "Code" switch that wrote both `skipCodeBlocks`
and `skipInlineCode`, even though extraction had read them separately since NRL-5.

## Decision

1. **The three keys become required `ExtractOptions` fields**, with the same
   names and polarity as the stored `Settings` keys, so `main.ts` passes them
   through with no negation. Required rather than optional is deliberate: an
   optional field with a default is exactly how a dead toggle hides, and making
   them required let the compiler name every call site that had to be updated.
   `StripOptions` takes `speakImageAlt` and `speakEmbeds`, which are consumed
   inside `cleanLine`; `skipFrontmatter` is a block-level decision and stays on
   `ExtractOptions`.

2. **No data version bump.** Every key already exists at `PLUGIN_DATA_VERSION`
   2 with its R-M09 default, and no key is added, removed or renamed here. A
   bump with an empty `migrateV2` would be ceremony. `normaliseSettings` already
   preserves keys it does not recognise by spreading its input at both levels,
   which is non-negotiable 10 and is untouched.

3. **`speakImageAlt` defaulting to `true` changes what an existing user hears on
   upgrade.** This is a deliberate exception to ADR 0001's "nobody's reading
   changes on upgrade". R-M09 specifies `imageAltText: true`, and alt text is the
   accessible description of an image: for a feature adjacent to a screen reader
   it is the one part of an image that is prose. The switch is in the settings
   tab for anyone who disagrees.

4. **An image's destination and title are never spoken, in either position.**
   The destination scan is unchanged, so `![alt](img.png "The Title")` speaks at
   most `alt`. The reference tail `[ref]` is now consumed by the image branch,
   which fixes the leak above in both positions. Alt text is re-cleaned through
   `cleanLine`, the same way the link branch re-cleans a label, so nested markup,
   escapes and complete `%%` / `<!--` spans inside the alt are handled by the
   existing recursion rather than a second implementation.

5. **An embed speaks a label for its local reference and never transcludes.**
   `extractChunks` holds only this note's source and `sourceIndex` is an offset
   into it, so text from another file has no offset to map back to and could not
   be highlighted. The label is the alias when the author wrote a meaningful one,
   otherwise a reduction of the target, shared with the `[[wikilink]]` branch
   through one helper. Two rules are specific to embeds:

   - A numeric alias (`200`, `200x100`, case-insensitive `x`) is Obsidian's
     display sizing, which is layout rather than prose, so it is ignored.
   - A target that names a file rather than a note (`![[pic.png]]`,
     `![[report.pdf]]`) is a destination, and clause 4 says a destination is
     never spoken. So for those only a meaningful alias is read, which is also
     where Obsidian keeps an image embed's alt text; `![[pic.png]]` with no alias
     says nothing. "Names a file" means any extension but `.md` / `.markdown`,
     rather than a list of media types, so an embeddable format we have not heard
     of errs towards silence.

   This second rule is an addition to the plan, decided during implementation
   because the plan's "alias else target reduction" would otherwise have spoken
   an image path. Silence on a filename is recoverable; reading out a path is
   the thing R-M09 asks us not to do.

6. **Spoken frontmatter is source-mapped key/value text with no YAML parse.**
   `detectFrontmatter` keeps ADR 0002's judgement entirely, including the
   deliberate divergence from Obsidian's positional rule and the
   unterminated-fence rule; it only widens its return to report the opening
   fence as well as the closing one, because a spoken block has to tell a fence
   from an interior line. Both fence lines are markup and are never spoken in
   either position. Blank lines and YAML `#` comment lines carry no metadata and
   are dropped. The block is flushed as its own paragraph at the closing fence,
   so metadata never merges into the first prose line, and no block state
   (`prevBlank`, `prevPara`, `inList`, `inFence`) is touched, so an indented line
   right after the fence is still recognised as code.

   Interior lines go through `cleanLine` with `stripTags: false` and
   `skipInlineCode: false`: a `#` in a value is part of that value rather than an
   Obsidian tag, and a backtick in a YAML string is a character. `speakUrls` is
   carried through unchanged, so a `source:` field does not read out a path.
   Because the frontmatter branch returns before the `HEADING` and `TABLE_ROW`
   checks, a heading- or table-shaped value is unaffected by `skipHeadings` and
   `skipTables` without needing a flag.

   Nothing is reserialised: no YAML is parsed, no words are added, nothing is
   reordered, and every emitted character keeps its own raw offset. A value does
   go through the same *inline* cleaner as prose, so bracket and emphasis markup
   in it is stripped as it would be in a paragraph and `tags: [a, b]` is spoken
   as `tags: a, b`. That is the accepted cost of keeping URL suppression and
   comment suppression inside a value, which are the two things this path must
   not lose; a mode that bypassed inline cleaning entirely would lose both.

7. **A frontmatter line can never silence the note body.** Interior lines are
   cleaned with `blockComments = false`, and the returned `openComment` and
   `openCode` are discarded. So an unmatched `%%`, an unmatched `<!--` and an
   unmatched backtick run each end at that line: none of them can open a
   document-level comment or code span, and none can make the body literal code
   in which a real `%%` would stop being a comment. Reading a note's body aloud
   because of something in its properties is the one direction ADR 0006 exists to
   prevent. An unmatched `%%` in a value stays literal, which also matches what
   Obsidian shows in its properties table; a *complete* `%%` or `<!--` span
   inside a value is still suppressed, by the same branch that suppresses one in
   prose.

8. **One "Content" group of nine explicit rows, each writing one key.** The
   heading is no longer "Skipped content", because with `speakUrls`,
   `speakImageAlt` and `speakEmbeds` in it the group is not all-skip. The "Code"
   row is split into "Code blocks" and "Inline code", and the line that wrote
   `skipInlineCode` from the `skipCodeBlocks` toggle is deleted. No migration is
   needed for the split: both keys already exist and already hold the user's
   value. `skipTags`, `skipTables` and `skipHeadings` are kept, as ADR 0001
   clause 3 decided. `offlinePreferred` is now the only reserved key, and still
   has no toggle, per ADR 0001 clause 6.

9. **Changes apply on the next read, by adding nothing.** `extractChunks` is
   called once, when a read starts, and `Player` owns the chunk array from then
   on. So there is no settings-change hook, no re-extraction and no queue
   rebuild. This is a decision rather than an omission: rewriting a queue under a
   running read would move the highlight and the audio out of step. A test pins
   it by mutating the options object after extraction and showing the returned
   chunks are unchanged while the next call differs.

## Consequences

- An existing user with untouched settings starts hearing image alt text after
  this upgrade, and stops hearing the reference id of a reference-form image.
  Nothing else in the default configuration changes.
- `tests/extract.test.ts`'s shared `OPTS` now mirrors `DEFAULT_SETTINGS`
  exactly, including `speakImageAlt: true`. Fixtures written when images were
  always dropped keep their original expectations under an explicit
  `speakImageAlt: false`, and each gained a `true` counterpart; the NRL-38
  comment fixtures in particular prove that a comment inside an alt or an alias
  is still suppressed when the label itself is spoken.
- Every one of the nine toggles has a test in both positions, and each of those
  fixtures also asserts that flipping any of the other eight changes nothing.
  `sourceIndex` lockstep is checked exhaustively over all 2^9 = 512 option
  combinations of a fifteen-fixture corpus, by numeric UTF-16 index.
- The wikilink branch is now a caller of the shared label helper. The NRL-6
  wikilink suite passes unedited, which is the evidence that the extraction was
  pure.
