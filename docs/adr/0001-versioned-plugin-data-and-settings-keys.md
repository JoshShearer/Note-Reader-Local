# 0001. Versioned plugin data and srs.md settings keys

- Status: accepted
- Date: 2026-09-28
- Ticket: NRL-5 (R-M13)

## Context

Until this change `saveSettings()` wrote the flat `Settings` object as the whole
of `data.json`, and `normaliseSettings` rebuilt that object from a whitelist of
known keys. Every load dropped anything unrecognised, and every save (which
fires on each rate nudge, voice change and toggle flip) made the loss permanent.
Nothing else wrote plugin data yet, so nothing was lost in practice, but reading
positions (NRL-20) would have been erased the first time the user touched a
slider.

`srs.md` specifies a versioned container (`PluginData { version, settings,
positions }`) and a settings key set that differs from what the code stored.

## Decision

1. **Versioned container.** `data.json` is now
   `{ "version": 1, "settings": {...}, "positions": {} }`. `positions` exists
   from v1 even though nothing writes it yet, so adding reading positions does
   not need a second migration.

2. **v0 -> v1 migration.** A file with no numeric `version` is the old flat
   shape (11 top-level keys, with `strip` nested). It is lifted into v1 by
   `migrateV0` in `src/settings/data.ts`. Unrecognised v0 top-level keys are
   carried to the v1 root. A file with a numeric version keeps that label, so a
   file written by a newer build is not relabelled as v1 by an older one.

3. **Adopt the srs.md key names now**, flat under `settings`:

   | v0 key | v1 key | Migration |
   | -- | -- | -- |
   | `strip.code` | `skipCodeBlocks` | copy |
   | `strip.code` | `skipInlineCode` | copy the same value |
   | `strip.urls` | `speakUrls` | **invert** |
   | `strip.tags` | `skipTags` | copy |
   | `strip.tables` | `skipTables` | copy |
   | `strip.headings` | `skipHeadings` | copy |
   | (none) | `skipFrontmatter` | default `true` |
   | (none) | `speakImageAlt` | default `true` |
   | (none) | `speakEmbeds` | default `false` |
   | (none) | `offlinePreferred` | default `false` |

   `engine`, `voiceId`, `rate`, `pitch`, `highlight`, `bufferAhead` and the
   `kokoro*` keys keep their names. `skipTags`, `skipTables` and `skipHeadings`
   are not in the srs.md sketch; they are added to it rather than dropped.

4. **Mixed polarity is kept.** The spec names content read by default `skipX`
   and content dropped by default `speakX`, so the stored value is `false` for
   the common case either way. Normalising to one polarity would mean diverging
   from the spec for no behavioural gain. The cost is that the migration must
   invert `strip.urls`; a copy would silently flip every existing user's URL
   preference, so a test pins both directions.

5. **One setting becomes two for code.** v0 had a single `strip.code` switch
   covering inline and fenced code. Both new keys take its value, and the single
   "Code" toggle writes both until the UI splits them.

6. **Reserved keys get no UI.** `skipInlineCode`, `skipFrontmatter`,
   `speakImageAlt`, `speakEmbeds` and `offlinePreferred` are stored and migrated
   but not yet read by extraction. A key may exist before its behaviour does;
   a toggle may not. Rendering a switch that does nothing is the dead-toggle
   defect, so the switches appear when the behaviour does.

7. **Unknown keys are preserved at every level.** `normaliseSettings` starts
   from a copy of its input and validates known keys over it (including inside
   `highlight`). `loadPluginData` does the same at the container root.
   `saveSettings()` writes the loaded container back with the live settings in
   it, so version, positions and anything else survive every save.

## Consequences

- The settings URL toggle is now labelled "Speak bare links" and is bound to
  `speakUrls` directly. Its visual state is the opposite of the old "URLs"
  (skip) toggle for the same user; what the user hears is unchanged.
- `ExtractOptions` keeps its old field names; `main.ts` maps the new keys onto
  them (`skipUrls = !speakUrls`). Renaming them belongs with the extraction work.
- The next schema change must bump `version` and add a `migrateV1`.
- The load -> save round trip lives in `src/settings/data.ts`, which has no
  `obsidian` import, so `tests/settings.test.ts` exercises it in plain Node.
