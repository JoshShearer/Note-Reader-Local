# 0027. Suppressing auto-scroll after a manual scroll

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-90 (R-S03)
- Amends: docs/adr/0022 decision 2 and its Alternatives-rejected section

## Context

ADR 0022 (NRL-72) put a viewport scroll on the chunk dispatch, gated on a highlight
layer actually being drawn (`scrollTargetForChunk`), but named its own limitation
plainly in Consequences:

> **NOT SOLVED: fighting a manual mid-read scroll.** The ticket's criterion asks
> that the auto-scroll not fight a manual scroll, and nothing here detects one.
> Scrolling away mid-read is undone at the next sentence boundary.

and in Alternatives rejected:

> **A `scrollDOM` listener suppressing auto-scroll after a manual one.** The
> right eventual answer, and deferred as the follow-up named above rather than
> half-built here.

This is that follow-up. Before this ticket, `scrollTargetForChunk(layers, sourceStart)`
took two parameters and returned a scroll target whenever a layer was drawn, with
no way to express "a manual scroll happened" at all:

```ts
export function scrollTargetForChunk(layers: HighlightLayers, sourceStart: number): number | null {
	if (!layers.sentence && !layers.word) return null;
	return sourceStart;
}
```

Confirmed by direct code reading of the pre-NRL-90 `src/ui/highlight.ts` and by
`grep -rn "suppress\|WeakMap\|scrollDOM" src/ui/highlight.ts src/main.ts`, which
returned zero matches: there was no suppression mechanism of any kind anywhere in
the codebase, so every chunk event scrolled unconditionally regardless of any
prior manual scroll. This is NRL-90's own acceptance criterion 5 made concrete,
and `tests/highlight.test.ts` block 19 reproduces it directly: the transcribed
old two-parameter function returns a non-null target for a manually-scrolled
editor, because the concept is absent from its signature.

## Decision

1. **Suppression lapses only on playback restart, not on a timer or a sentence
   count.** Per the ticket's own clarification: a deliberate scroll-away is
   respected for the rest of the reading, and "restart" is already a
   well-defined lifecycle event in this codebase - the same three call sites
   `retargetHighlightEditor` already resets state at (`readActiveNote`,
   `readSelection`'s `SelectionReadPort.retarget` closure, `readFromCursor`).
   No N-seconds-off-screen and no N-sentences constant was considered further
   than naming it as a rejected alternative below: either would need a tuning
   number nothing in this codebase's history has needed for a policy this
   coarse, and the clarification explicitly asked for none.

2. **Own-vs-user scroll detection is a read-and-clear flag, not a timer.**
   `scrollDOM` fires a native `'scroll'` event for both a user-initiated scroll
   and the plugin's own `EditorView.scrollIntoView` effect, and the event
   itself carries no origin. `applyHighlightLayers` arms a module-level
   `WeakMap<EditorView, boolean>` (`expectingOwnScroll`) to `true` immediately
   before dispatching, and ONLY on the branch that is actually pushing a
   scroll effect - a chunk dispatch with no scroll target never arms it, or a
   later genuine user scroll would be misattributed as the plugin's own the
   next time a scroll effect fires. The listener `registerScrollSuppression`
   attaches reads-and-clears that same entry on every `'scroll'` event: `true`
   means "this is the scroll we just caused", consumed and ignored; `false` or
   absent means a scroll happened that the plugin did not cause, fed into
   `nextScrollSuppression` as a genuine user scroll.

3. **Suppression state is a second `WeakMap<EditorView, boolean>` in
   `highlight.ts`, not a field on `Player`.** Confirmed against `player.ts`:
   `play()` takes an engine, chunks, rate, pitch and a start offset, no editor
   reference, and CONTEXT.md states the reason plainly - `Player` is a
   chunk-queue player, not a reading session, and does not know about the
   editor. This is exactly the kind of editor-keyed UI state
   `sentenceHighlightField`/`wordHighlightField` already keep out of it, so it
   stays in `highlight.ts` alongside them.

4. **The pure core is two functions**, matching this file's existing style of
   writing decisions as explicit named functions rather than inline booleans
   (`highlightPlan`, `shouldHighlightLeaf`):

   - `nextScrollSuppression(currentlySuppressed: boolean, isUserScroll: boolean): boolean`
     is the whole state machine. Written as two explicit branches rather than
     the one-line `currentlySuppressed || isUserScroll` it is logically equal
     to, so a later third state is a visible new branch rather than a silent
     behaviour change dressed as a refactor - the same reasoning `highlightPlan`
     and `scrollTargetForChunk` already apply to their own conditionals.
     Suppression **latches**: once true it stays true until an explicit
     `resetScrollSuppression` call, which is a separate function and
     deliberately not an input to `nextScrollSuppression` itself, because
     "reset" and "no user scroll seen on this event" are different facts -
     conflating them would let a later `false` argument silently un-suppress,
     which is not the policy this ticket implements.

   - `scrollTargetForChunk(layers: HighlightLayers, sourceStart: number, suppressed: boolean): number | null`
     gains a third REQUIRED parameter, not optional or defaulted, checked
     ahead of the existing layer disjunction. Required, following this
     repo's own convention for threading a new document- or editor-scoped
     fact through an existing function (`CONTEXT.md`'s `lastHtmlCloser`
     precedent through `cleanLine`, and `RunResult.signal` becoming required
     in NRL-55): `tsc` then fails every call site that does not yet know
     about suppression, rather than silently keeping the old always-scroll
     behaviour. `tests/highlight.test.ts` block 17's three pre-existing call
     sites were updated to pass `suppressed: false` explicitly, pinning that
     unsuppressed behaviour is byte-identical to before.

5. **The glue - `registerScrollSuppression`, `isScrollSuppressed`,
   `resetScrollSuppression`, and the arming call inside
   `applyHighlightLayers` - is wired at the same call sites as the existing
   highlight wiring, and only those.** `registerScrollSuppression(editor)` is
   called at the identical three `main.ts` sites `registerHighlighting` is
   called at for a FRESH read (`readActiveNote`, `readSelection`,
   `readFromCursor`), deduplicated via a `WeakSet<EditorView>` the same way
   `registerHighlighting` states its own "safe to call more than once per
   editor" contract, but via a `WeakSet` rather than a CM6 state-field check
   since a native DOM listener has no CM6 config to introspect.
   `resetScrollSuppression(editor)` is called immediately alongside it at
   those same three sites - operationalising "playback restart" as exactly
   those sites, per decision 1. Neither is called from the NRL-89
   leaf-reattach path (`handleActiveLeafChange`): reattaching to a note whose
   read is still in flight is not a fresh `play()` call, so a manual scroll
   made before switching notes away and back must still be respected when the
   user returns.

## Consequences

- A manual scroll during playback is no longer overridden at the next
  sentence boundary. It is undone only by starting a fresh read of the same
  or a different note.
- **The own-vs-user scroll detection is a BEST-EFFORT HEURISTIC, not a proof,
  and this has never been run against a real browser's actual scroll-event
  timing.** Stated explicitly because AGENTS.md rule 13 forbids asserting an
  unmeasured claim as fact, and nothing in this run could measure it: CDP port
  9222 was unreachable, so no deploy and no real Obsidian session happened.
  Three specific unknowns follow from that, the same shape ADR 0022 already
  named for the base scroll mechanism, now compounded by this ticket's own
  listener:
  - Whether a browser's `scrollDOM` ever fires more than one `'scroll'` event
    per `scrollIntoView`-induced move. If it does, the read-and-clear flag
    desyncs: the first event consumes `expectingOwnScroll` and a second,
    still-our-own event reads it as absent and is misattributed to the user,
    suppressing auto-scroll after a move the user never made.
  - Whether a genuine user scroll landing in the same task-queue turn as the
    plugin's own scroll's event can interleave ahead of it, which would have
    the listener consume the wrong event as "ours" and leave the real user
    scroll unaccounted for.
  - Whether the suppression is perceptible or correct as a FEEL fix at all.
    This is fundamentally a product-feel property a green bare-Node suite
    cannot judge (the ticket's own acceptance criterion 7 says so), and
    nothing here changes that.
- **The `WeakMap`s are garbage-collected with the editor; no separate cleanup
  path exists or is needed.** `expectingOwnScroll`, `scrollSuppressed` and
  `scrollListenerAttached` (a `WeakSet`) are all keyed on the `EditorView`
  instance itself. When a pane closes and its `EditorView` becomes
  unreachable, its entries in all three collections become unreachable with
  it and are reclaimed by the garbage collector; there is nothing to dispose,
  and nobody should later add a teardown path believing one is missing. The
  native `scrollDOM` listener added by `registerScrollSuppression` is not
  explicitly removed either, for the same reason: it is a closure captured by
  the `EditorView`'s own `scrollDOM` element, and both are reclaimed together
  once nothing else references the view.
- `tests/highlight.test.ts` block 19 covers only the two pure pieces:
  `nextScrollSuppression`'s state transitions, and `scrollTargetForChunk`'s
  `suppressed` parameter (including the defect-reproduction pair showing the
  pre-fix function always scrolls). It does NOT and CANNOT cover
  `registerScrollSuppression`'s actual `scrollDOM.addEventListener` wiring
  or whether the heuristic in decision 2 correctly identifies the plugin's
  own scroll in a real browser - both need a real `EditorView` and a real DOM
  `'scroll'` event, and this file never instantiates a real `EditorView`
  (ADR 0022 decision 3 already says so, and it remains true).
- R-S03 is a SHOULD ("the highlight SHOULD follow playback as segments
  advance"), so this does not move the `2 of 16` MUST headline count in
  AGENTS.md's Known state.
- **NOT VERIFIED IN OBSIDIAN.** No deploy happened and no CDP session was
  attempted for this ticket. Acceptance criterion 7 ("verified in real
  Obsidian... a green bare-Node suite cannot judge it") is explicitly not
  deliverable in this run and is left unchecked, consistent with every other
  ticket in this repo's history.

## Alternatives rejected

- **A timer-based suppression lifetime (N seconds off-screen).** Rejected by
  the ticket's own clarification: no arbitrary tuning constant, and
  "restart" is already a well-defined lifecycle event with no number to pick.
- **A sentence-count-based suppression lifetime (N sentences).** Same
  reasoning; also considered and not preferred by the clarification.
- **A user-facing toggle for the suppression policy.** ADR 0022 already
  rejected a toggle for the scroll feature itself as out of scope; this
  ticket's clarification reaffirms preferring an automatic policy over a new
  setting.
- **Debouncing or rate-limiting the `scrollDOM` listener with a timer.**
  Rejected for the same "no arbitrary tuning constant" reason as the
  suppression lifetime - the read-and-clear flag needs no interval to tune,
  and a debounce would add exactly the kind of millisecond constant this
  ticket's clarification asks to avoid.
- **Storing suppression state on `Player` instead of a `WeakMap` in
  `highlight.ts`.** Rejected because `Player` does not know about the editor
  by design (CONTEXT.md; `play()`'s signature has no editor parameter), and
  giving it one for this ticket alone would be a new, one-off exception to
  that boundary for state that is properly UI-layer, editor-keyed data.
