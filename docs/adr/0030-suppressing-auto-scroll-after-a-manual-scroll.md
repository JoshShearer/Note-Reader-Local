# 0030. Suppressing auto-scroll after a manual scroll

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

---

## Amendment, NRL-90 follow-up (2026-09-30)

Added in place rather than as a new ADR, because this is the same decision
finished rather than a different one. It does three things: it clears a stale
`expectingOwnScroll` arm in `resetScrollSuppression`; it re-derives F1 against
NRL-110's `{ y: "center" }` and finds it **reachable**, correcting
ADR 0022:309-346 and the NRL-90 pre-flight triage note that said the same; and it
records F1 as an accepted, reachability-mapped, fail-open residual with the one
measurement that would decide whether it needs machinery.

### F1 is reachable, and the earlier "measure-zero" reading was wrong

The "measure-zero" expectation did **not** come from this ADR. Its
pre-amendment body, Consequences included, says nothing about `{ y: "center" }`
at all - grep lines 1-205 for `center`, `NRL-110`, `F1`, `zero-movement` or
`measure-zero` and every count is zero, which is unsurprising since ADR 0030 was
written before NRL-110 landed. The expectation lived in exactly two places:
**ADR 0022's NRL-110 amendment at :313-317**, and the NRL-90 pre-flight triage
note that was carried into this ticket's clarification. Attributing it to this
ADR's own Consequences, as an earlier draft of this amendment and of AGENTS.md
did, sends a reader looking for a sentence that is not there. Both of those two
places expected `{ y: "center" }` to make F1 vanish, on the ground that the
`center` arm of
`scrollRectIntoView` computes `moveY` unconditionally, so the
`if (moveX || moveY)` gate at `node_modules/@codemirror/view/dist/index.js:200`
almost never zeroes. That reasoning is correct as far as it goes and **stops one
screen too early**. Seven lines past the gate, at `:207-209`:

```js
let start = cur.scrollTop;
cur.scrollTop += moveY / scaleY;
movedY = (cur.scrollTop - start) * scaleY;
```

The browser **clamps** an out-of-range `scrollTop`, and a `scrollTop` write that
does not change the value fires **no `scroll` event**. So `moveY != 0` with
`movedY === 0` is an ordinary state, not a corner. `applyHighlightLayers` arms
`expectingOwnScroll` before the dispatch; with no event to read-and-clear it, the
arm survives.

Four reachable sub-cases, named so each can be argued with separately:

- **R1, the opening of every read. MEASURED.** Centring a chunk that sits in the
  first half-viewport needs a negative `scrollTop`; the browser clamps it to 0;
  the DOM does not move. This is not reasoned - it is in `docs/adr/0022:240-249`,
  NRL-110's own post-`center` on-device series on a Pixel 9 Pro XL: "Chunks 0-4
  are unchanged from the baseline ... `scrollTop` 0 - because centring them would
  mean scrolling up past the top of the document and `scrollTop` cannot go
  negative". **Five of that run's twenty-two chunk dispatches moved the DOM by
  zero**, and they are the first five of every read - exactly the seconds in which
  a user is most likely to scroll by hand.
- **R2, the tail of every note. REASONED, not measured.** Symmetric: `scrollTop`
  is already at its maximum, so centring a chunk in the last half-viewport clamps
  the same way. NRL-110's series stopped at chunk 21, `scrollTop` 1209 of a
  maximum of **8,500**, so it never reached this. That maximum belongs to one
  specific note and is quoted with it so it cannot drift again:
  `AcceptanceTest/ScrollAcceptance.md`, 60 sentences, doc length 16,211,
  `scrollHeight` **9,497** against `clientHeight` 997, re-measured on the Pixel 9
  Pro XL during NRL-90's verification pass and agreeing with the On-device
  section below. An earlier draft of this bullet derived 8,116 from
  ADR 0022:225's `scrollHeight` 9,113, which is an **older measurement of the
  same note from a different session**; 9,497 / 8,500 is the current pair, and
  the discrepancy is session drift in the note or the editor's own geometry
  rather than an error in either ticket.
- **R3, a note shorter than the viewport. REASONED, not measured.** At
  `index.js:152-155`, `if (cur.scrollHeight <= cur.clientHeight && cur.scrollWidth <= cur.clientWidth) { cur = parent; continue; }`
  skips `scrollDOM` entirely and the parent walk ends at `doc.body`, where `:202`
  calls `win.scrollBy(...)`. Whatever the window does, that can never fire a
  `scroll` event on `editor.scrollDOM`, which is the element our listener is
  attached to.
- **R4, a rect already exactly centred.** The only genuine `moveY === 0` case,
  and the only one that is measure-zero. This is all the earlier reading left
  standing, and it was wrong to leave only this.

### The consequence is bounded, and the bound is the whole reason this is accepted

`expectingOwnScroll` is a single boolean, read-and-cleared in the listener and
overwritten with `true` by each arming dispatch. So however many zero-movement
dispatches pile up, **at most one stale arm is pending at any instant, and it
swallows exactly one `scroll` event**. If a real touch drag or wheel gesture emits
two or more `scroll` events - which is the ordinary behaviour of a scroll gesture -
the second event latches suppression and the user sees nothing wrong at all.

That gives a **falsifiable prediction**: a gesture emitting >= 2 `scroll` events
makes F1's user-visible consequence nil. A gesture emitting exactly one, with
suppression failing to latch, makes F1 a real defect and warrants a follow-up
ticket. It is deliberately not filed pre-emptively.

### Why the self-expiring arm was NOT built

The obvious fix - arm the flag, then clear it unconditionally on the next
microtask or animation frame, so a dispatch that produced no event cannot leave an
arm behind - was designed, costed and **rejected, because it fails closed**:

- CodeMirror does not scroll inside `dispatch`. `index.js:7714-7715` calls
  `this.requestMeasure()`, and `:8003-8005` is
  `requestMeasure(request) { if (this.measureScheduled < 0) this.measureScheduled = this.win.requestAnimationFrame(() => this.measure()); }`.
  The `scrollTop` write at `:207-209` therefore happens in a **later** animation
  frame than our dispatch.
- A `scrollTop` write fires `scroll` asynchronously, at the next rendering update
  per CSSOM-View's "run the scroll steps", so the event lands at least one frame
  after that write.
- A `Promise.resolve().then` clear therefore lands in the same task, and a
  single-`requestAnimationFrame` clear lands at best in the same frame as
  CodeMirror's own `measure()`. Both run **before the scroll event exists**. Every
  one of our own scrolls would then be read as a user scroll, suppression would
  latch on chunk 1, and auto-scroll - the feature R-S03 asks for - would die for
  the rest of every read.
- A double-rAF clear would land after the event only if CodeMirror measures in the
  very next frame and never reschedules, and `:7824-7831` shows it can reschedule.
- A millisecond-window arm (storing a timestamp instead of a boolean) has the same
  fail-closed direction, since a device under load exceeding the window kills the
  feature, plus the arbitrary tuning constant this ADR's Alternatives-rejected
  section already refused.

F1's failure direction is "keeps following" - fail-open, one swallowed scroll
event. The self-expiring arm's is "stops following permanently" - fail-closed. The
asymmetry decides it. The remaining alternative, arming only when the target
genuinely falls outside the visible range, stays rejected on its original ground:
it needs `coordsAtPos` and a real DOM, which ADR 0022 decision 3 forbids in this
file and `tests/highlight.test.ts` cannot instantiate. Reading `scrollDOM.scrollTop`
instead does not rescue it, because the value only changes a frame later - the same
timing problem.

### What shipped

One line in `resetScrollSuppression` (`src/ui/highlight.ts`):
`expectingOwnScroll.delete(editor)` beside the existing
`scrollSuppressed.set(editor, false)`. `.delete` rather than `.set(editor, false)`,
matching the listener's own read-and-clear and the WeakMap's documented "absent
reads as not expecting". Nothing else under `src/` changed; `main.ts` is untouched,
because all three read-start sites already call `resetScrollSuppression` and the
fix reaches them for free.

Without it, a stale arm from a zero-movement dispatch (R1) survived a playback
restart and swallowed the **first** genuine user scroll of the next read, which
contradicts this function's own claim to restore normal follow behaviour and is
acceptance criterion 4 of the ticket ("playback restarting resets to the normal
follow behaviour").

### The shipped fix's own cost: a narrow fail-closed window (critique F2)

Recorded here rather than left in PR #157's body, because the section above
rejects the self-expiring arm **entirely** on a fail-open versus fail-closed
asymmetry, and the one-liner that shipped instead is not purely fail-open. It
opens a fail-closed window of its own, and a reader weighing that asymmetry
should see both sides of it.

The window: CodeMirror writes `scrollTop` off its own `requestAnimationFrame`
(`:8003-8005`), and the browser then fires `scroll` asynchronously at the next
rendering update. If a read **restarts inside that gap** - after the write, before
the event is dispatched - `resetScrollSuppression` deletes the arm, and the still
pending event from *our own* scroll arrives with nothing to consume it and latches
suppression at the very start of the new read. Before the fix the surviving arm
absorbed exactly that event, so this is the fix's own cost rather than a
pre-existing shape: the window **did not exist** before `expectingOwnScroll.delete`.

Three things bound it, and the bound is why it is accepted rather than designed
around:

- **It is bounded to one read.** A single DOM move produces a single `scroll`
  event - measured on the device, where a programmatic write 0 -> 1 and
  CodeMirror's own 300 -> 0 move each produced exactly one - so at most one event
  is ever pending, and the next `resetScrollSuppression` clears the spurious
  suppression.
- **It needs two user actions inside one rendering update.** A stop and a restart
  have to land between CodeMirror's `scrollTop` write and the resulting event's
  dispatch. A human cannot produce that by hand.
- **It is strictly narrower than the rejected arm's failure.** The self-expiring
  arm fails closed on *every* chunk of *every* read; this fails closed only on a
  restart that happens to fall inside one rendering update, and only until the
  next restart.

One refinement on that second bullet, from NRL-90's verification pass. The
window is often described as "about one animation frame", and that is a
**60Hz-unloaded** figure rather than a constant: what actually bounds it is one
rendering update, which stretches with frame time under main-thread load - and
this device demonstrably stalls (the `preparing` stalls recorded at the end of
this amendment are the same machine). So the window is wider than 16 ms under
load. It is still one rendering update, still one read, and still two user
actions deep, so the conclusion does not change; the number does.

### Coverage, and what the suite now does and does not prove

`tests/highlight.test.ts` block 19 gained `19h`-`19n`, and `fakeEditor` gained an
additive `scrollDOM` stub, so `registerScrollSuppression`'s **listener body has its
first coverage of any kind**. The Consequences bullet above, which says block 19
"does NOT and CANNOT cover `registerScrollSuppression`'s actual
`scrollDOM.addEventListener` wiring", is superseded on that point.

Two reproductions, both **red against the unfixed `resetScrollSuppression` and
green after**: `19h`, a pre-restart arm must not survive the reset, asserted on
`isScrollSuppressed`; and `19i`, the same end to end, asserting the next chunk
dispatch carries zero scroll effects. The same pair was reproduced independently
first, in a standalone bare-Node probe bundling the real `src/ui/highlight.ts`,
before either check was written.

Four **guards**, green on both sides and labelled as such, never counted as
reproductions: `19j` a no-target dispatch does not arm; `19k` the arm is consumed
exactly once (the premise `19h` depends on); `19l` `registerScrollSuppression`
attaches exactly one listener however often it is called; `19m` the reset still
clears a latched `scrollSuppressed`.

One **tripwire**, `19n`, green on both sides and explicitly not a fix: it pins both
halves of F1's accepted residual - that the first event after a zero-movement arm
is swallowed, and that the second latches - so either half can only change
deliberately.

What the suite still cannot judge is narrower than before but not empty, and the
amended KNOWN GAP comment at the end of block 19 states it: the handler is invoked
directly in the same task, so real event **timing** relative to CodeMirror's rAF
measure pass is untested; **gesture multiplicity** is a device fact; and whether
`scrollDOM` is the element Obsidian actually scrolls is unverified, since no real
`EditorView` is ever instantiated.

### Limits of this amendment

- **R2 and R3 stay reasoned, not measured.**
- **Desktop is unobserved.** CDP port 9222 is unreachable in this environment and
  the Flatpak Obsidian must not be restarted, so every on-device figure here or in
  ADR 0022 is Android-only. The one ground for generalising is the one ADR 0022
  already states: both platforms run the same bundled `@codemirror/view`.
- **`main.ts` has no bare-Node runtime**, so the three
  `registerScrollSuppression`/`resetScrollSuppression` call sites and the
  `isScrollSuppressed` read are unexercised by `npm test`.
- R-S03 is a SHOULD, so the `2 of 16` MUST headline count in AGENTS.md does not
  move.

### On-device observation (Android, 2026-09-30)

**This is the first time anything about suppression has been observed in a real
Obsidian.** ADR 0030's original Consequences section says "NOT VERIFIED IN
OBSIDIAN... acceptance criterion 7 is explicitly not deliverable in this run";
that is superseded for the four facts below and stays true for everything else.

Device: Pixel 9 Pro XL, Android 17, Obsidian WebView Chrome/154, vault
`AcceptanceTest`, note `ScrollAcceptance.md` (60 sentences, doc length 16,211,
`scrollHeight` 9,497, `clientHeight` 997, so `scrollTop` max 8,500). Driven over
CDP on `adb forward tcp:9333`. The probe hooks `EditorView.dispatch` to record each
transaction's effect count, its scroll effect's `range.head` and `y`, and
`scrollDOM.scrollTop` before the dispatch, two animation frames after it and 100 ms
after it; a separate capture-phase `scroll` listener on the same `scrollDOM` counts
native events. **Desktop remains unobserved** - CDP port 9222 is unreachable and
the Flatpak Obsidian must not be restarted.

**M1, F1 reachability, observed directly rather than inferred.** From a read
started at chunk 0 with the stored position cleared, four consecutive chunk
dispatches each carried **three effects, one of them a scroll effect** with
`y: "center"` at heads 2, 21, 128 and 290 - and `scrollTop` read **0 before, 0
immediately after, 0 two frames later and 0 at 100 ms** on every one of them, with
**zero native `scroll` events** over the whole 65-second window. So the arm
`applyHighlightLayers` sets was left unconsumed on every opening chunk. This is F1
measured on the device rather than derived from the library source, and it confirms
R1 independently of ADR 0022's series.

**M1 was then confirmed a second time, by a different agent re-measuring rather
than reading this section.** Two consecutive opening chunk dispatches each carried
three effects including one `y: "center"` scroll effect, at heads 2 and 21 - the
same first two heads as above - with `scrollTop` **0 before, 0 synchronously
after, 0 two animation frames after and 0 at 300 ms** on both, and **zero native
`scroll` events over a 72-second window**. Independent confirmation of a
measurement is rare in this repo, so it is worth saying plainly: F1 is observed,
not argued, and observed twice.

**M2, the deciding measurement, and it answers the falsifiable prediction above in
the favourable direction.** A real touch drag synthesized through CDP
`Input.synthesizeScrollGesture` (`gestureSourceType: "touch"`, 350-400 px,
speed 800) emitted **54, 46 and 33 native `scroll` events** on three separate
gestures - not 1, and not close to 1. Since the stale arm swallows exactly one
event, F1's user-visible consequence under a real gesture is **nil**: the second of
33-54 events latches suppression. The prediction is therefore met and **no
follow-up ticket is filed**. The honest limit is that this is the typical case, not
the worst one: a programmatic `scrollDOM.scrollTop += 300` emits exactly one event
and is indistinguishable from a user scroll to the listener, so a single-event
scroll source would still lose that one event.

**M2 re-measured independently, and with real OS-level touches.** NRL-90's
verification pass repeated it on the same device rather than replaying the series
above, and got **47, 53, 53, 54, 56, 98 and 223 events across seven gestures** -
**four of them real OS-level touches via `adb shell input swipe`** rather than CDP
synthesis, which is a stronger input path than the one the three figures above
used. The minimum over both passes is **47**, never 1 and never close to 1, so
F1's accepted residual costs **one swallowed event out of dozens**. The two series
agree in the only way that matters here (order of magnitude, not the digit), and
the second one widens the method as well as the sample.

**M3, the feature works at all.** After that 54-event gesture moved `scrollTop`
from 0 to 400 mid-read, the next two chunk dispatches carried **two effects and
zero scroll effects**, and `scrollTop` stayed at **400** while the read advanced
from chunk 4 to chunk 6. Suppression latched on a real gesture and the viewport
stopped tracking the read, which is acceptance criteria 1 and 2.

**M4, the one-liner this amendment ships, measured on both sides.** Same device,
same note, same probe, same command sequence, **only `main.js` differing**: an
opening clamped dispatch leaves an arm pending with zero scroll events, the read is
stopped with no scroll in between, playback is restarted, and then exactly **one**
scroll event is delivered before the restarted read's own first chunk dispatch
(`armingSoFar: 0` confirms the setup was clean, and `nEvents: 1` that it was a
single event).

- **Before** (`main.js` md5 `078d23c8…`): the restarted read's chunk dispatch
  carried **three effects, one scroll effect at head 2**, and dragged `scrollTop`
  from **300 back to 0**. The chunk after it scrolled too, so suppression never
  latched at all. The user's scroll was undone - the defect, with its user-visible
  consequence, on a real device.
- **After** (`main.js` md5 `15e618c5…`): the same dispatch carried **two effects
  and zero scroll effects**, `scrollTop` held at **300**, and `nEvents` stayed at
  1, so the plugin produced no scroll of its own. The single event latched
  suppression, because the arm no longer survived the restart.

**M4 re-measured independently too, single-variable.** The second pass rebuilt the
pre-fix side in a copied shadow root by removing only the one-liner - so the real
worktree was never touched - pushed it, verified the on-device digest, and ran the
identical command sequence. **Before**: the restarted read's chunk dispatch
carried a scroll effect and dragged `scrollTop` **300 -> 0**, suppression never
latching. **After**: **16 dispatches, zero scroll effects, heads `[]`, `scrollTop`
held at 300.** Both sides of the original M4 reproduce.

### Two method traps, recorded so they are not re-learned

Neither is a finding about the plugin. Both cost time during NRL-90's device work
and neither is visible from the code.

- **Clearing a stored reading position with `plugin.saveData()` alone is not
  enough.** The plugin's in-memory `plugin.pluginData.positions` is re-saved over
  whatever was written to disk, so the read resumes at the stored index anyway -
  observed resuming at **chunk 29** after what looked like a successful clear,
  which silently invalidates any before/after series that was supposed to start at
  chunk 0. `plugin.pluginData.positions` must be emptied in memory as well.
- **The arbitrary-CDP helper's `send` mode hangs, and the gesture silently does
  not fire, without a preceding `Runtime.evaluate` on the same socket.** Three
  runs came back with zero scroll events and no error, which reads as "the gesture
  produced nothing" rather than "the gesture never happened". Use the `seq` form
  with a leading eval, or `adb shell input swipe`, which is both more real and more
  reliable - it is also what produced four of M2's seven gestures.

**M4(i), a restart does return to normal follow behaviour.** With suppression
latched by a 33-event real gesture, a stop and a fresh read produced chunk
dispatches carrying a scroll effect again (heads 2 and 21, three effects each), and
the viewport moved from `scrollTop` 350 back to 0 as centring chunk 0 clamps at the
document top. So the reset clears suppression as well as the arm.

**One unrelated observation, recorded because it cost time and is not this
ticket's.** Three times in this session a `read-note` after a stop left the player
in `preparing` indefinitely - 60 s, 80 s and 95 s with no chunk dispatch and no
state change - and each time a `disablePlugin`/`enablePlugin` cycle restored it.
That matches the shape NRL-101 already records (a Kokoro session poisoned until
reload, trigger unidentified); it was **not** triggered by this change, since it
occurred on both the pre-fix and post-fix builds. It is not re-filed here.
