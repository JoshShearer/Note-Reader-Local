# 0022. Scrolling the viewport to the spoken sentence

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-72 (R-S03)
- Amends: `srs.md` R-S03; ADR 0020's decoration-only property
- Builds on: ADR 0020 (two highlight layers, two settings)

## Context

`src/ui/highlight.ts` tracked playback with decorations and nothing moved the
editor's viewport. `grep -r scrollIntoView src/` had zero matches anywhere in the
codebase. On a note longer than one screen the highlight walks off the visible
area and the reader has no way to see where playback is without scrolling by
hand.

R-S03 requires the *highlight* to follow playback as segments advance, and that
half is met. It says nothing about the *viewport* following the highlight, so the
old behaviour was in spec. That is exactly why this needs an ADR rather than a
bug fix: it is new user-visible behaviour the contract does not describe, and it
deliberately ends a property `highlight.ts` used to state about itself and ADR
0020 quotes.

## Decision

1. **One transaction, three effects.** The scroll effect is appended to the
   effects array `applyHighlightLayers` already dispatches, not sent as a second
   `dispatch`. A frame must never show the two highlight layers disagreeing -
   that is ADR 0020's whole subject - and a separate transaction gives CodeMirror
   a legal intermediate state between them.

2. **Scroll on the chunk event only, at `chunk.sourceStart`.** Never on a word
   tick. A manual mid-read scroll is then overridden at most once a sentence
   rather than several times a second, and the spoken word stays visible anyway
   because the chunk cap is 220 characters, roughly two to four editor lines.
   `applyWordHighlight` and all three clears are unchanged, and
   `applySentenceHighlight` deliberately gains no scroll parameter either, so
   `refreshHighlightLayers` - the settings-toggle redraw - never moves the
   viewport.

3. **`y: "nearest"` and no viewport arithmetic of our own.** No options object is
   passed to `EditorView.scrollIntoView`, so CodeMirror's defaults apply.
   Measured in bare Node against the vendored `@codemirror/view` in this session:
   `EditorView.scrollIntoView(5)` yields one `StateEffect` whose value carries
   `range.head 5`, `y "nearest"`, `x "nearest"`, `yMargin 5`, `xMargin 5`. Read
   out of `@codemirror/view/dist/index.js`, under `y == "nearest"` `moveY` is
   assigned only when the target rect is above the bounding box top or below its
   bottom, and the scroll is gated on `if (moveX || moveY)`, so a target already
   in view moves by zero. A visibility test of our own would need `coordsAtPos`
   and a real DOM, which the bare-Node suite cannot build, so it would be
   untestable here for no gain. **Do not add one.**

4. **The effect is constructed in `highlight.ts`; which offset to use is decided
   in `main.ts`.** `highlight.ts` is the module already permitted to import
   `@codemirror/view`, it owns the `try`/`catch` that tolerates an editor torn
   down mid-playback, and it is the module the bare-Node suite can drive.
   `main.ts` has no runtime in the suite at all. `main.ts` passes
   `chunk.sourceStart` rather than the sentence range's `from`, because that
   range is `null` when the sentence layer is off and the viewport should still
   follow playback then.

5. **This deliberately ends `highlight.ts`'s decoration-only property, and
   narrows the guarantee rather than dropping it.** The header comment used to
   say the module "cannot disturb the cursor, the undo history, or the user's
   place in the document", and ADR 0020's Context quotes it. The cursor and the
   undo history still hold, and so do the text selection and the focused element:
   measured in bare Node, applying `EditorView.scrollIntoView(5)` to an
   `EditorState` leaves `state.selection` byte-identical and `docChanged` false,
   and the effect carries a scroll target rather than a `SelectionRange`. The
   third clause is now false by design, because repositioning the viewport is the
   feature. No decision in ADR 0020 is reversed: two fields, two effects, three
   clears and the treatment-not-colour distinction are all untouched.

6. **The offset is clamped to the document length**, the same policy the two
   fields already apply to a decoration's `range.to`. Measured: an out-of-range
   head does not throw at dispatch time, it rides forward unchanged, so the clamp
   is about a stale offset scrolling somewhere wrong rather than about a crash.

7. **No layer drawn, no scroll.** `scrollTargetForChunk(layers, sourceStart)` in
   `src/ui/highlight.ts` returns the offset when `layers.sentence || layers.word`
   and `null` otherwise, and `main.ts` passes its result where it used to pass
   `chunk.sourceStart` unconditionally. The scroll is a service to the highlight,
   not a feature of its own: with no highlight there is nothing to keep in view,
   and moving the viewport of someone who deliberately switched highlighting off
   is behaviour nobody asked for. This corrects decision 2 as originally
   implemented: with `highlight.enabled` false the chunk dispatch drew zero
   decoration ranges and still carried one scroll effect at `head 18`. Measured
   by staging the old unconditional expression in `tests/highlight.test.ts` block
   17: 17a and 17f red, everything else green, and 17b green on both sides
   confirming zero ranges were drawn in the offending case.

   Three parts of the condition are load-bearing.

   - **`layers.word` is in the disjunction**, because "word drawn, sentence not"
     is reachable rather than hypothetical: the master switch, the sentence row
     and the word row are three independent toggles in `settingsTab.ts`, so
     `{ enabled: true, sentence: false, word: true }` on an engine that reports
     timings plans `{ sentence: false, word: true }`. The word mark lands inside
     that chunk a moment later and has to be on screen for it.
   - **The plan is consulted, not the ranges in this transaction.** At chunk time
     `main.ts` always passes `word: null` because the word range is not known
     yet, so a gate reading the transaction's own ranges would refuse to scroll
     in exactly the word-only case above.
   - **`layers.sentence` can carry the decision alone**, with no reference to
     word timing, which is ADR 0020's rule that a capability gates only the layer
     it names. speech-dispatcher reports no timings, so its plan is
     `{ sentence: true, word: false }` and the sentence is its only possible
     layer; a gate that consulted the word row would leave the one engine that
     most needs the viewport to follow playback without it.

   Zero is returned as an offset rather than filtered out, so the first chunk of
   a note still scrolls to the top; `applyHighlightLayers` already tests
   `typeof scrollTo === "number"` rather than truthiness.

## Consequences

- A reader on a long note sees the view follow the speech. New visible behaviour
  on every engine that can highlight at all, including speech-dispatcher, where
  the sentence is the only layer.
- **There is no toggle of its own, but it is not ungated.** The ticket's Out of
  scope rules out a dedicated setting, and decision 7 instead ties the scroll to
  the highlight settings that already exist: switching highlighting off, or
  switching both layer rows off, stops the viewport moving as well. That is the
  only way to turn it off, and it is a consequence of the existing toggles rather
  than a new control.
- **NOT SOLVED: fighting a manual mid-read scroll.** The ticket's criterion asks
  that the auto-scroll not fight a manual scroll, and nothing here detects one.
  Scrolling away mid-read is undone at the next sentence boundary. Suppressing
  that needs a `scrollDOM` listener and a "the user has taken over" state, which
  is machinery the ticket's Out of scope excludes in spirit. An explicit
  follow-up, to be filed.
- A settings toggle flipped mid-read redraws the sentence through
  `applySentenceHighlight` and therefore does not scroll. Deliberate: a settings
  change is not playback advancing, and yanking the viewport because someone
  opened the settings tab would be worse than leaving it where it is.
- The scroll target is the chunk's start, so a long chunk whose start is on
  screen will not scroll even if its end is not. That follows from `nearest`
  plus a start-of-chunk target and is accepted rather than worked around.
- **Nothing was observed in Obsidian.** No deploy happened and no CDP session was
  attempted during this work. A bare-Node assertion that a `StateEffect` with
  `range.head === 18` and `y === "nearest"` rode on the transaction is **not**
  evidence that a user sees the view move. The suite proves the effect is
  constructed and carried. It proves nothing about `scrollDOM.scrollTop`, nothing
  about whether Obsidian's own editor extensions intercept or override a scroll
  effect, nothing about whether the movement reads as smooth or as a jolt, and
  nothing at all about the manual-scroll clause, which this implementation does
  not attempt anyway. Also unverified and worth naming separately: whether
  Obsidian's Live Preview folds and widgets put `chunk.sourceStart` at a screen
  position that differs from what a plain-text offset implies, which would scroll
  to the wrong place with a fully green suite.

## Alternatives rejected

- **A second transaction for the scroll.** Breaks ADR 0020's one-frame
  invariant by giving CodeMirror a legal state between the two layer updates.
- **Scrolling on the word tick as well.** Overrides a manual scroll several times
  a second instead of once a sentence, for a word that is already on screen
  inside a chunk of at most 220 characters.
- **A custom `coordsAtPos` visibility test.** Needs a DOM, is untestable in this
  suite, and `y: "nearest"` already does exactly this inside the library.
- **A user-facing toggle.** Out of scope per the ticket.
- **A `scrollDOM` listener suppressing auto-scroll after a manual one.** The
  right eventual answer, and deferred as the follow-up named above rather than
  half-built here.
