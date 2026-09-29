# 0005. Highlight colour follows the theme by default; plugin data v2

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-14 (R-M16)

## Context

`settings.highlight.color` was stored, validated and shown as a text field, but
never applied. `styles.css` read `--local-tts-reader-highlight`, falling back to
a hardcoded `#ffd54f`, and nothing in `src/` set that variable. Bundling
`src/ui/highlight.ts` showed the word mark as `{"class":"local-tts-reader-word"}`
whatever colour was stored, including `"not a colour"`. Every user therefore saw
`#ffd54f`, and nearly every stored value is that untouched default.

A fixed yellow is a poor default on dark themes, and a free-text field accepted
anything, so an invalid value would have silently produced no highlight once
the setting did take effect.

The loader's colour rule was `/^#[0-9a-f]{3,8}$/i`, which accepts 5- and 7-digit
strings that are not colours.

## Decision

1. **The setting is made to work, not removed.** `main.ts` writes the stored
   colour to `--local-tts-reader-word-highlight` on `document.body` on load and
   on every change, and removes it on unload. The logic lives in
   `src/ui/highlightColour.ts`, which has no obsidian or DOM import so it runs
   in the Node tests.

2. **`""` means "follow the theme", and is the default.** `styles.css` reads
   `var(--local-tts-reader-word-highlight, var(--text-highlight-bg))`. An empty
   setting removes the property rather than setting it to the theme variable,
   so the fallback is written in one place.

3. **The variable is named for the word.** A sentence highlight can sit beside
   it as `--local-tts-reader-sentence-highlight` without renaming anything.

4. **Storage is hex or `""` only.** Hex is 3, 4, 6 or 8 digits. Named and
   `rgb()` colours are refused even though CSS accepts them, so the settings tab
   and the loader agree on what is valid. The tab also asks `CSS.supports` when
   that exists. It is optional because it is absent in plain Node and a missing
   global must not reject every colour. The tab offers a colour picker and a
   reset-to-theme button; invalid text shows an inline error and the last valid
   colour stays in effect.

5. **Plugin data v2, with a one-shot v1 -> v2 migration.** `migrateV1` rewrites
   a stored `#ffd54f` (case-insensitive) to `""`. Anything else was set by hand
   and is kept. Older files step forward one migration at a time: a v0 file
   goes v0 -> v1 -> v2. A file at v2 or above keeps its label and is not
   migrated, as ADR 0001 already required. Unknown keys at the root, inside
   `settings` and inside `settings.highlight` survive every step.

## Why a version bump and not a normalisation rule

`normaliseSettings` runs on every load. A rule there ("`#ffd54f` means theme")
would also rewrite a user who, after this change, deliberately picks that
yellow: their choice would be undone on the next start. A versioned migration
runs exactly once per file, which is the semantics wanted. The cost is one
more migration step, which ADR 0001 anticipated ("The next schema change must
bump `version` and add a `migrateV1`").

## Consequences

- An older build that loads a v2 file keeps the `2` label (ADR 0001), and its
  loader rejects `""` back to `#ffd54f`. Downgrading therefore shows the old
  yellow, which is what that build always showed.
- Tests pin: the old default moves in v1 and v0 files; a custom colour is kept;
  a v2 `#ffd54f` is kept; a v3 file is untouched; unknown keys survive.
- Whether `--text-highlight-bg` reads well on every community theme is not
  something this change measured. It is Obsidian's own highlight colour, which
  themes are expected to set.
