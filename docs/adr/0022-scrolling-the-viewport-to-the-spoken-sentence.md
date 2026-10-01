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

3. **`y: "center"` and no viewport arithmetic of our own.** **Amended by NRL-110**;
   the original text of this decision chose `y: "nearest"` by passing no options
   object at all, and the amendment section at the end of this ADR records the
   on-device measurement that falsified it. The call now passes `{ y: "center" }`
   and nothing else, so `x` keeps the library's `"nearest"` and we still do no
   viewport arithmetic ourselves. Read out of the vendored
   `node_modules/@codemirror/view/dist/index.js` in this session: `ScrollTarget`'s
   constructor (`:2385`) defaults `y` and `x` to `"nearest"` and `yMargin` /
   `xMargin` to 5, so the effect carries `range.head`, `y "center"`,
   `x "nearest"`, `yMargin 5`, `xMargin 5`. In `scrollRectIntoView` the
   `y == "nearest"` branch (`:163-174`) assigns `moveY` only when the target rect
   is above the bounding box top or below its bottom, and the scroll is gated on
   `if (moveX || moveY)` (`:200`) - that gate zeroing was the whole of "no jump
   when the highlight is already visible". The `else` branch (`:175-181`) computes
   `moveY = targetTop - bounding.top` unconditionally, and for `y == "center"`
   with `rectHeight <= boundingHeight` `targetTop` centres the rect, so the gate
   almost never zeroes and **a chunk event now scrolls even when the sentence is
   already on screen**. That property is traded away deliberately, for the reason
   in the amendment section. `yMargin` is **not** passed, because the arm that
   actually runs for us never reads it. **That is an empirical property of the
   geometry and not a structural guarantee, and the mechanism recorded here at
   first was wrong** - corrected at NRL-110's close, and NRL-90 must take the
   corrected version. The `y` ternary has three arms. Arm 1,
   `y == "center" && rectHeight <= boundingHeight`, centres the rect and reads no
   `yMargin`. Arm 2, `y == "start" || (y == "center" && side < 0)`, reads
   `yMargin` and is dead for us, and *this* is what `side` excludes:
   `EditorView.scrollIntoView(pos)` with a number builds an empty cursor range
   (`dist/index.js:8337`, `EditorSelection.cursor(pos)`), so `head === anchor` and
   `side` is 1 (`:3321`, `range.head < range.anchor ? -1 : 1`). Arm 3, the
   fall-through `rect.bottom - boundingHeight + yMargin`, **also reads `yMargin`**,
   and it is reached exactly when `side >= 0` **and**
   `rectHeight > boundingHeight` - so `side` being 1 is arm 3's *precondition*,
   not its exclusion. What keeps us off arm 3 is only `rectHeight <=
   boundingHeight`: a single cursor position's rect measured at 19px (30.3px on
   chunk 0) against a 997px editor on the device in the amendment below, confirmed
   by the landing position matching `(997 - 19) / 2 = 489.0` exactly on 24 of 24
   observed dispatches with no `yMargin` term in it. A single line taller than
   the editor viewport would take arm 3 and would read a `yMargin`, so "passing
   one would be dead config" overstates it; the accurate claim is the narrow one,
   that the arm we run on never reads it. A visibility
   test of our own would still need `coordsAtPos` and a real DOM, which the
   bare-Node suite cannot build, so it stays unwritten - but no longer on the
   ground that `nearest` already does it, because on this path it does not.

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
- The scroll target is the chunk's start, so a long chunk is positioned by its
  start and its end may still fall below the fold. **Corrected by NRL-110**: the
  original bullet said such a chunk "will not scroll even if its end is not" on
  screen, which followed from `nearest`. Under `y: "center"` it does scroll - the
  chunk's start is centred regardless of whether it was already visible - so what
  is accepted rather than worked around is now only that a chunk taller than the
  viewport cannot have both its ends on screen, and that the `center` arm at
  `dist/index.js:177` falls through to the start/end arm when
  `rectHeight > boundingHeight`.
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
- **A custom `coordsAtPos` visibility test.** Needs a DOM and is untestable in
  this suite - `EditorView` is never instantiated in `tests/highlight.test.ts`.
  **Corrected by NRL-110**: the second half of the original reason, that
  `y: "nearest"` already does exactly this inside the library, is no longer true,
  because `y: "center"` takes the branch that has no visibility gate. It is still
  not added, but now purely on the untestability ground, and "do not add one" is
  downgraded from a rule to a cost: anyone who wants the no-jump-when-visible
  property back has to build it, and has to accept that the bare-Node suite
  cannot see it.
- **A user-facing toggle.** Out of scope per the ticket.
- **A `scrollDOM` listener suppressing auto-scroll after a manual one.** The
  right eventual answer, and deferred as the follow-up named above rather than
  half-built here.

## Amendment, NRL-110: the sentence is centred, not merely brought into view

Decision 3 originally chose `y: "nearest"` by passing no options object, and
bought "no jump when the highlight is already visible" from CodeMirror's own
visibility gate. A user reported from real use on desktop Obsidian that the
spoken line tracks the **bottom edge** of the editor rather than the middle, so
the sentence being read sits at or below the fold. That is `"nearest"` behaving as
documented: it moves the target the minimum distance needed to get it inside the
box, and a read advancing downward therefore always arrives at the bottom.

**This is the first time this project has measured the scroll's on-screen
behaviour at all.** NRL-72's own record says "NOTHING WAS OBSERVED IN OBSIDIAN".
Measured over CDP on a Pixel 9 Pro XL (Android 17, WebView Chromium 154), real
Obsidian, vault `AcceptanceTest`, note `ScrollAcceptance.md` (16,211 characters,
122 lines, `scrollHeight` 9,113 against `clientHeight` 997 - 9.1 screens), Kokoro
engine, sampling `scrollDOM.scrollTop`, `scrollDOM.clientHeight` and
`coordsAtPos(chunk.sourceStart).top` relative to `scrollDOM`'s own bounding box on
every chunk advance. `fraction` is that top as a share of `clientHeight`, so 0.5 is
the vertical centre and 1.0 is the bottom edge.

**Before, `y: "nearest"`** (chunks 0-21). Chunks 0-10 sit on the first screen, so
the gate zeroes, `scrollTop` stays 0 and the fraction simply climbs as the read
walks down the page: 0.200, 0.257, 0.282, 0.402, 0.426, 0.546, 0.570, 0.691,
0.715, 0.835, 0.859. From chunk 11 the scroll engages, and the fraction then pins
at **0.976 on every single chunk** - 11 through 21, `topPx` 973 of `clientHeight`
997 - while `scrollTop` advances 4, 28, 148, 172, 292, 316, 436, 460, 580, 628,
748. A ~24px line whose top is at 973 of 997 is flush with the bottom edge with
nothing below it. That is the reported defect, measured.

**After, `y: "center"`** (same note, same chunk range 0-21, same sampler, rebuilt
and `adb push`ed, plugin reloaded with `disablePlugin` / `enablePlugin`, stored
reading position cleared so the read starts at chunk 0). Chunks 0-4 are
**unchanged from the baseline** - 0.200, 0.257, 0.282, 0.402, 0.426, `scrollTop` 0
- because centring them would mean scrolling *up* past the top of the document and
`scrollTop` cannot go negative, so the view is clamped at the document top and the
line simply sits above centre. From chunk 5 the centring engages and the fraction
pins at **0.490 on every chunk, 5 through 21** - `topPx` 489 of `clientHeight` 997,
so 508px of context below the spoken line's top - while `scrollTop` climbs 56, 80,
200, 224, 344, 368, 488, 512, 632, 656, 776, 800, 920, 944, 1064, 1112, 1209. The
run carried **22 three-effect dispatches, one per chunk**, and a hook on
`EditorView.dispatch` confirmed each scroll effect's value as
`y "center"`, `x "nearest"`, `yMargin 5`, exactly as decision 3 above predicts.

So against the 0.976 baseline the spoken line moves from flush with the bottom edge
to the vertical centre, which is the acceptance criterion.

**The traded-away property is visible in that same pair of series, not merely
argued.** At chunk 5 the baseline had `scrollTop` 0 and fraction 0.546 - the
sentence was already on screen, so `"nearest"`'s gate zeroed and the view did not
move. Post-fix the same chunk has `scrollTop` 56 and fraction 0.490: it scrolled.
Chunks 5-10 are precisely the cases where the old gate zeroed and the new one does
not, measured on both sides.

What is **traded away** knowingly: the zero-movement property. Under `"center"`
the gate at `dist/index.js:200` almost never zeroes, so the view now moves once
per sentence rather than only when it has to. The alternative considered and not
taken was keeping `"nearest"` and widening `yMargin` to roughly 35-40% of
`editor.dom.clientHeight`, which would have kept the gate and still kept the line
out of the extreme edge. It was rejected because it needs a DOM read for the
viewport height, a policy for what to do when that read fails or returns 0, and
viewport arithmetic of our own - the thing decision 3 exists to avoid - whereas
`{ y: "center" }` is one argument and hands all the arithmetic back to the library.

**Three things remain open and must not be read as settled by the numbers above.**

1. **Desktop feel.** Whether recentring on every chunk reads as comfortable
   tracking or as the page twitching every two seconds has been watched on no
   platform. Nothing in a bare-Node suite or a `scrollTop` series can answer it;
   it needs a person watching a read.
2. **Desktop interception.** Whether Obsidian's own desktop editor extensions
   intercept or override the scroll effect is untested, because desktop CDP port
   9222 is unreachable (the Flatpak Obsidian is running without
   `--remote-debugging-port` and this work must not restart it). The Android
   measurement is defensible on exactly one ground: both platforms run the same
   bundled `@codemirror/view` `scrollRectIntoView`, so the geometry being changed
   is identical. It is **not** a claim about desktop.
3. **NRL-72's Live Preview premise, still unresolved.** Whether Obsidian's folds
   and widgets put `chunk.sourceStart` at the screen position a plain-text offset
   implies. The measurement above was taken in source mode
   (`view.getMode() === "source"`), so it does not test the Live Preview case.

One measurement artefact is recorded so a later probe does not read it as a
defect. Two early post-fix runs on this device produced **no scroll at all**
(`scrollTop` 0 with the spoken line's top at 1721px of a 997px editor) immediately
after a `disablePlugin` / `enablePlugin` reload, where every later run from a clean
state scrolled correctly. **The cause is unidentified.** NRL-90's scroll
suppression was the obvious suspect and was **ruled out by direct test**: firing a
genuine native `scroll` event on `scrollDOM` before starting a read, which is what
those runs did by accident, still produced 7 of 7 chunk dispatches with a real
scroll (`scrollTop` 80 at chunk 6, matching the clean series), so
`resetScrollSuppression` at read start does clear a latched suppression. The
remaining plausible explanation, untested, is that `main.ts`'s
`if (!this.activeEditor) return;` guard was still closed because no
`active-leaf-change` had fired since the reload, in which case the chunk handler
dispatched nothing at all - neither layer nor scroll - which would be
under-highlighting rather than a scroll defect. It is harness-only in origin and
was not reproduced from a clean state in either direction.

**Interaction with NRL-90, stated and not acted on.** NRL-90's scroll suppression
(`registerScrollSuppression`, `nextScrollSuppression`, `resetScrollSuppression`,
`isScrollSuppressed`, `expectingOwnScroll`) is untouched by this change, including
the `expectingOwnScroll.set(editor, true)` arm, which stays exactly where it was.
But NRL-90's F1 - a chunk dispatch that moves by zero fires no native `scroll`
event, so the armed flag is never read-and-cleared and the next genuine user
scroll is misattributed as ours - becomes close to measure-zero in practice rather
than fixed, because `"center"` almost always produces a real movement. The stale-arm
window shrinks to the residual cases where `center` still computes zero - and
**that residual set is narrower than this paragraph originally said**, corrected at
NRL-110's close. It listed "a target rect taller than the viewport, which falls
through to the start/end arm" as a zero-movement case. That is wrong in the other
direction: the fall-through arm computes
`moveY = rect.bottom - boundingHeight + yMargin - bounding.top`, which is non-zero
in general, so a rect taller than the viewport stops being **centred** - it becomes
end-aligned - rather than becoming motionless. It therefore still fires a native
`scroll` event and still consumes the arm. What is left of the zero-movement set is
a rect already exactly centred, and nothing else that has been identified.
**NRL-90 must re-derive F1 against what this ticket
actually landed and must not reuse any pre-NRL-110 measurement of it.**
