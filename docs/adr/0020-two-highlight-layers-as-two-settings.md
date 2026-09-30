# 0020. Two highlight layers, two settings, and a difference that is not colour

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-54 (R-M13, R-S03; follow-up to NRL-29)
- Amends: `srs.md` R-M13's `TTSSettings` shape and its highlight-colour paragraph
- Builds on: ADR 0005 (highlight colour as a CSS custom property)

## Context

NRL-29 added a sentence highlight and it worked on speech-dispatcher only, by
accident: that engine reports `timing: "none"` and never emits a word event, so
nothing came along to overwrite the mark. Everywhere else the word highlight
replaced it within a frame, because `src/ui/highlight.ts` had one `StateField`,
one `StateEffect` and one CSS class, and the field *assigned* its decoration set
rather than composing. NRL-54 was opened for the remainder.

The first pass at NRL-54 built the right structure - two effects, two fields, so
the marks genuinely coexist - and then shipped three defects on top of it, all
reproduced against the real bundled modules rather than read:

1. **The two layers were pixel-identical, so the feature could not be seen.**
   The two CSS rule bodies were byte-identical once the var name was normalised
   away, and `main.ts` feeds both custom properties from the one stored
   `highlight.color`. Measured: `identical=true` at the default `""` (both
   properties removed, both rules falling back to `--text-highlight-bg`) and at
   `#ff0000` (both set to `#ff0000`).
2. **The sentence mark was never cleared.** `highlight.ts` ended with
   `export const applyHighlight = applyWordHighlight`, and `main.ts`'s
   `clearHighlight()` was `applyHighlight(editor, null)`. The sentence field
   ignores a word effect by design, so every Stop, error, sleep-timer expiry and
   natural finish left the last sentence underlined for the rest of the session.
3. **A word-timing fact could still silence the sentence.** `settingsTab.ts`
   applied `controlAffordances(...).highlightToggle` - which is the *word* gate;
   its own limitation text is "no word highlighting" - to the master toggle as
   well. On speech-dispatcher, the one engine where the sentence is the only
   layer that can ever work, a stored `enabled: false` therefore left the note
   with no highlight and no reachable control to bring it back.

Recording this is not optional book-keeping. `srs.md:477` declares

```ts
highlight: { enabled: boolean; color: string };
```

and this change widens it. `AGENTS.md` allows deviating from the spec and forbids
doing it silently.

## Decision

1. **Two layers, two fields, two effects, and the word drawn over the sentence.**
   Kept from the first pass. One field with one effect cannot express "over";
   assignment is what produced the original defect.

2. **`Settings.highlight` gains `sentence` and `word`, both defaulting to
   `true`.** `enabled` stays as a master switch. Three booleans rather than two
   because `enabled` is already stored in every existing `data.json` and in
   `srs.md`, and silently repurposing a stored key is worse than adding two.
   `normaliseSettings` spreads `...highlight` before overriding the known keys,
   so unrecognised keys survive (non-negotiable 10).

3. **A word-timing capability gates the word row and nothing else.**
   `affordances.ts` is unchanged; it was already correct, and
   `highlightToggle`'s own reason string has always named word timings. The
   master switch and the sentence row are never disabled by an engine
   capability. This is the whole of defect 3.

4. **The difference between the two layers is treatment, not colour.** The
   sentence is a `border-bottom` rule; the word keeps the filled background and
   ring it already had. This is forced rather than chosen: the requirement in
   NRL-54 asks for one stored colour feeding two custom properties in the same
   `saveSettings` path, and both fall back to `--text-highlight-bg`, so the two
   properties hold the same value at every setting. Colour therefore *cannot* be
   what separates them, and a second colour setting was rejected as scope that
   the ticket explicitly did not ask for.

   No `color-mix()` and no relative colour syntax, however tempting a tinted
   band is. Obsidian's Android WebView is Chrome/88 (SPIKE-ANDROID-001), where an
   unsupported colour function computes to nothing rather than degrading - which
   would blank a layer on mobile only, the hardest place to notice.

5. **Three clears, none an alias for another.** Ending a reading clears both
   layers in one transaction; advancing a word clears only the word; the
   sentence has its own clear for symmetry. Merging them back is what would
   re-couple the toggles, because the word handler clears on every word event
   while the word toggle is off. Defect 2 was exactly one alias too many.

6. **The draw decision is a pure function, `highlightPlan()`.** It was inline in
   two event handlers, and `main.ts` cannot run in the bare-Node suite, so the
   timing gate was untestable and untested. The first pass's test file said in
   its own docstring that it was "verified during E2E testing", which nothing had
   done, while describing the behaviour as "word overwrites" - the thing the
   ticket says must not happen.

7. **The editor the marks were drawn into is drained before it is replaced.**
   Every read path assigns `activeEditor` before `Player.play()`, and `play()`
   begins with its own `stop()`, which drives `state: "idle"` and the clear - by
   which time the field already names the *new* editor. Reading note A then
   starting note B left A marked permanently. `Player` holds no editor
   (`CONTEXT.md`: "a chunk-queue player, not a reading session"), so this field
   is the only thing that knows, and `retargetHighlightEditor()` is where that
   responsibility now lives.

8. **A toggle takes effect immediately, not at the next sentence boundary.**
   The sentence effect is only dispatched from the `chunk` handler, so flipping a
   toggle mid-paragraph would leave the mark on screen until the next sentence -
   and on speech-dispatcher, with no word events at all, nothing else would clear
   it. `saveSettings()` now redraws the layers.

## Consequences

- `srs.md` R-M13's `TTSSettings` gains the two keys, and its highlight-colour
  paragraph loses "when added": the sentence highlight now exists.
- An existing user sees a new underline under the sentence being spoken. Both new
  keys default to `true`, so this is an upgrade that changes what the reader
  looks like. It does not change what is spoken.
- The sentence underline spans source the plugin deliberately did not speak: a
  skipped inline-code span or a folder-qualified wikilink inside the sentence is
  underlined even though NRL-46 went to some trouble not to say it. Measured, not
  assumed. No privacy consequence - nothing is logged and nothing is spoken, and
  the text is already on screen - but the mark does assert "I am reading this"
  over a span that was skipped. Inherent to a span-based sentence mark.
- `highlightPlan()` reads the *settings-selected* engine, not the engine actually
  speaking. Changing the dropdown mid-read can therefore suppress a word mark
  that the running engine is still producing timings for. Narrow, and it needs a
  deliberate mid-read engine change; not fixed here.
- **Nothing was observed in Obsidian.** The two things that matter most are the
  two a bare-Node suite cannot judge: whether an underline plus a filled mark
  reads as two layers on a real theme, and whether the settings rows disable the
  way the code says. `settingsTab.ts` imports `obsidian` and cannot run in the
  suite at all. CDP port 9222 was refused for the whole of this work.

## Alternatives rejected

- **One effect carrying a `kind` discriminator.** The ticket allowed it if it
  composed. Two fields is less code and makes "compose" structural rather than a
  property of the reducer.
- **A second stored colour for the sentence.** It would make the two layers
  distinguishable by hue, which is what a reader would expect. Rejected because
  the ticket's criteria name one colour feeding both properties in one
  `saveSettings` path, and adding a settings key nobody asked for is how the
  settings tab got the dead toggles ADR 0008 had to clean up.
- **Dropping `enabled` and deriving it as `sentence || word`.** Cleaner as a
  model, and it would have made the coupling class impossible rather than merely
  fixed. Rejected because `enabled` is a stored key in every existing
  `data.json`, is named in `srs.md`, and is asserted by `tests/settings.test.ts`;
  repurposing it silently is the migration hazard non-negotiable 10 exists for.
- **Keeping the word-timing gate on the master toggle and telling the user
  why.** This is what shipped, and it is the defect: the reason string is about
  word timings, and it was disabling the sentence highlight.
