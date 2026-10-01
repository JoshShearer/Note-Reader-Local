# 0032. Mobile placement for the floating control bar

- Status: accepted
- Date: 2026-10-01
- Ticket: NRL-112 (R-M07 `srs.md:262`; `srs.md:1768` "Mobile controls MUST have touch-friendly hit targets"; R-M03 `srs.md:185` engaged)
- Amends: nothing. `srs.md` needs no amendment - this is a gap against it, not a deviation from it.

## Context

The floating control bar (`src/ui/controlBar.ts`, mounted on `document.body`) is the
only on-screen transport surface the plugin has. It was written for desktop and had
no mobile branch of any kind: before this change `styles.css` contained zero `@media`
queries, never read a safe-area inset, and nothing under `src/ui/` imported
`Platform`. So it rendered byte-identically on a phone and on a desktop.

NRL-96's Android acceptance pass drove the player through `executeCommandById` and
direct `plugin.player` reads over CDP, never through the bar's own buttons, which is
why that pass was green while the bar was unusable.

### What was measured, and where

Every number below was measured this session (2026-10-01) over CDP against a real
device: **Pixel 9 Pro XL, Android 17, WebView Chromium 154.0.8037.57, Obsidian
1.13.7**, vault `AcceptanceTest`, portrait. `adb forward tcp:9333
localabstract:webview_devtools_remote_<pid>`.

Host facts:

| Reading | Value |
| --- | --- |
| `window.innerWidth` x `innerHeight` | 448 x 997 CSS px |
| `devicePixelRatio` | 3 |
| `--safe-area-inset-top` | 66.333336px |
| `--safe-area-inset-left` / `--safe-area-inset-right` | 0px / 0px |
| `--view-header-height` | 44px |
| `--input-height` | 44px |
| `.view-header` real rect | y 66.33, height 44.33, bottom 110.67, `position: fixed`, `z-index: 1` |
| `document.body.className` | carries **both** `is-mobile` and `is-phone`; `is-tablet` false |

The defect, with a read in progress so the bar carried `.is-visible` and
`player.getState()` was `playing`:

| Reading | Value |
| --- | --- |
| Control bar rect | x 60.5, **y 0**, 327 x 46.28, bottom **46.28** |
| Transport buttons | **26.54 x 28** (28px declared, shrunk by `flex-shrink` under `nowrap`) |
| Speed `-` / `+` buttons | **20 x 20** |
| Speed readout | 42 x 16.64 |

The bar's entire 46.28px height sat inside the 66.333336px safe-area inset. A
screenshot (`adb exec-out screencap -p`) shows the Android status bar - clock,
notification icons, signal, wifi, battery - drawn **over** the bar, with the progress
readout `1 / 121` half-hidden behind the signal bars.

Two further measurements make "unreachable" a demonstration rather than an inference:

- `document.elementFromPoint()` at each button's own centre returned that button.
  So the DOM hit test **passes** and is not the right oracle here.
- `adb shell input tap 437 68` - a real OS-level touch at the play/pause button's
  measured centre (CSS 145.8, 22.6 x `devicePixelRatio` 3) - left
  `player.getState()` at `playing`. Nothing happened.
- Positive control for that negative: `adb shell input tap 672 1500`, in the editor
  body, moved the CodeMirror cursor from line 0 ch 0 to line 4 ch 240 and focused
  `.cm-content`. So `input tap` reaches the WebView; it is the bar's pixels
  specifically that a finger cannot reach, because the system UI owns them.

Separately, 28 x 28 and 20 x 20 are both below any touch target size, which
`srs.md:1768` requires and which the ticket cites directly.

## Decision

**Direction 1: keep the top placement and offset it, in CSS only, under
`body.is-mobile`.** Two rules, six declarations, appended at the end of `styles.css`
so no existing line is touched:

```css
body.is-mobile .local-tts-control-bar {
	top: calc(var(--safe-area-inset-top) + var(--view-header-height));
	max-width: calc(100vw - var(--safe-area-inset-left) - var(--safe-area-inset-right) - 16px);
	flex-wrap: wrap;
	justify-content: center;
}

body.is-mobile .local-tts-cb-btn,
body.is-mobile .local-tts-cb-speed-btn {
	min-width: 44px;
	min-height: 44px;
}
```

`src/ui/controlBar.ts` is **not changed at all**.

### 1. Direction 1 over direction 2 (move to a bottom anchor)

The ticket offered both. Direction 1 wins on three counts:

- **Desktop is unchanged by construction, not by re-measurement.** `body.is-mobile`
  cannot match a desktop Obsidian, and the diff deletes zero lines. Direction 2 would
  have to flip the `top`, the show/hide `translate(-50%, -100%)` and the
  `border-radius: 0 0 10px 10px` all together, and each is a desktop-visible rule.
- **Rule 7 risk is zero rather than managed.** Direction 2 needs a `Platform.isMobile`
  branch, which would be the first `Platform` import under `src/ui/`. A CSS-only fix
  adds no import, so `main.js`'s `require()` list cannot move.
- **A bottom anchor has to clear Obsidian's mobile navigation bar**, whose height this
  repo does not control and which the user can disable (`is-floating-nav` is present
  on this device). That is a second guess on top of the one direction 1 already makes.

The cost is honest: the offset is composed from chrome heights this repo does not own.
It is composed from Obsidian's **own variables** rather than literals precisely so it
tracks the device and the theme, but if Obsidian renames or re-scopes either variable
the bar moves. That is recorded under Residual risk rather than engineered around.

### 2. `body.is-mobile`, not `body.is-phone`

Pre-flight proposed `is-phone` and had not considered tablets. Measured above, this
device's `body` carries **both**, so `is-mobile` is the superset Obsidian also sets on
a tablet. An Android tablet has the same safe-area inset, the same `.view-header` and
the same touch input, and R-M03 names Android without excluding tablets, so `is-phone`
would leave a tablet with the identical defect. `is-mobile` is equally unmatchable on
desktop, so the desktop-unchanged-by-construction argument is preserved exactly.

### 3. 44 x 44, sourced to the host

`srs.md:1768` requires touch-friendly targets and names no number. The authority used
is Obsidian's own `--input-height`, **measured at 44px on this device**, so the
plugin's targets match the host's own controls rather than an imported guideline.

`min-width`/`min-height` rather than `width`/`height` is deliberate. CSS clamps the
used value to `max(min-width, width)`, so the desktop `width: 28px; height: 28px`
(`styles.css:109-110`) and `width: 20px; height: 20px` (`:168-169`) stay **literally in
the file** and still govern desktop. That is what makes "desktop unchanged" a
zero-deletion diff instead of an argument.

### 4. `flex-wrap` is load-bearing; `max-width` is kept, but NOT as the thing that forces the wrap

Pre-flight recorded a naive width sum of 434px against the 448px viewport. **That
figure is low.** Re-derived from the stylesheet's own values, with
`box-sizing: border-box` confirmed on the bar by CDP:

```
5 transport buttons        5 x 44                              = 220
6 parent gaps              6 x 4                               =  24
.local-tts-cb-speed        2 margin + 8 padding + 1 border
                           + 44 + 2 gap + 42 readout + 2 gap
                           + 44                                = 145
.local-tts-cb-progress     4 margin + 8 padding + 1 border
                           + 40 min-width                      =  53
                                                      content  = 442
bar padding 2 x 10 + border 2 x 1                              =  22
                                                        total ~ 464
```

against a measured 448px viewport. The 434 figure omits the speed group's and the
progress readout's own `margin-left`/`padding-left`/`border-left` (24px) and the two
inner speed gaps (4px). So the bar overflows at 44px targets **even on this
448px-wide device**, and a 360-CSS-px phone overflows by roughly 104px. (~464 is
arithmetic from measured CSS values, not itself a measurement; the post-fix rect is
measured on the device and recorded in the ticket.)

`flex-wrap: wrap` is therefore the mechanism that absorbs the overflow without
removing a control or shrinking a target below 44px.

**`max-width` was expected to be the constraint that forces that wrap, and was
measured not to be.** The reasoning above - that a `left: 50%` /
`translate(-50%, ...)` box overflows off both edges unless it is clamped - predicted
the clamp would be binding. On the device it is not: the computed `max-width` is
**432px** while the bar settled at **224px** wide. A `position: fixed` shrink-to-fit
box with `left: 50%` and `right: auto` has an available width of only
`100vw - left` = 448 - 224 = **224px**, and that, not the clamp, is what forced the
three-row wrap. So read the ~464px arithmetic above as arithmetic that establishes
*that* the content cannot fit on one row, not as the observed cause of the wrap.

`max-width` is kept rather than deleted, for the second reason it was argued for
rather than the first: it is the landscape and notched-side guard, and it stops the
bar growing past the viewport if `left`/`right` ever stop being 0px or if the
positioning changes. The measured `--safe-area-inset-left`/`-right` are both `0px` on
this device in portrait, so those two terms are inert here. **Neither the landscape
case nor a notched-side case was exercised**, so the clamp is desk-reasoned, not
measured, and `tests/highlight.test.ts` section 20 asserts only that it is present.

The seven flex children, confirmed in order by CDP, are five `.local-tts-cb-btn` (one
of them `.local-tts-cb-btn-primary`), then `.local-tts-cb-speed`, then
`.local-tts-cb-progress`.

Pre-flight predicted from that order that "the first thing to wrap is the progress
readout, then the speed group - never a transport button in isolation". **That was
measured wrong too, for the same reason as the clamp.** At the settled width of 224px
the bar's content box is 224 - 20 padding - 2 border = **202px**, and five 44px buttons
with four 4px gaps need **236px**. So only four fit on a row, and the measured post-fix
layout puts previous / replay / play-pause / stop on row 1 at **y 116.33** and `next`
**alone** at the head of row 2 at **y 164.33**, beside the speed group, with the
progress readout on row 3. A transport button *is* separated from the others on this
device. It is still 44 x 44 and still tappable - `next` was driven by a real
`adb shell input tap` and moved the index 7 -> 8 - so this is a worse grouping than
predicted rather than a defect, and it is recorded because it is the thing to reason
from if anyone later reorders the children or hides a control to recover one row.

### 5. The progress readout is kept, and the mobile block hides nothing

Pre-flight left open whether to hide `.local-tts-cb-progress` on mobile to buy 53px.
It is kept, for three reasons. It is the only on-screen position indicator the plugin
has. `flex-wrap` already buys the space, so hiding it would remove information to buy
width that is already bought. And it leaves the mobile block with **no `display: none`
and no `visibility: hidden` at all**, which is what makes R-M14's constraint - "a
mobile relayout must not turn a disabled control into a missing one" - true by
inspection of the diff rather than by a probe. (`.local-tts-cb-progress` is not
affordance-gated in any case: `controlBar.ts`'s `apply()` is called only on
`playPauseBtn`, `slowerBtn`/`fasterBtn` and `speedValueEl`.)

### 6. No touch gesture is added to the speed readout

Acceptance criterion 3 asks that the rate be changeable on touch without a `wheel`
event. Sizing the existing `+`/`-` buttons to 44 x 44 satisfies it: they already exist
and already fire on `click` (`controlBar.ts:90`, `:99` -> `nudgeRate`). No new gesture
is added.

The `wheel` listener (`controlBar.ts:103-114`) stays exactly as it is, as a desktop
convenience. Its bail at `:109` on `!this.affordances.rate.enabled` is correct and is
kept. A touch drag on the readout is deliberately **not** added: the comment at
`:106-108` already records that swallowing the gesture would stop the note scrolling,
and on a 42px-wide span pinned over the editor that would compete with note scrolling
for every user, not only for engines with no rate control.

## Consequences

- The bar moves to a computed `top` of 66.333336 + 44 = **110.33px** on this device,
  clear of both the safe-area inset and Obsidian's own `.view-header` (bottom 110.67).
  The bar's `z-index: 60` beats the header's measured `z-index: 1`, so the 160ms show
  transition now slides over the header rather than in from the screen edge.
- **The hidden bar now parks on screen.** The hidden state is
  `transform: translate(-50%, -100%)`, a translate of the bar's own height. At
  `top: 0` that put it off-screen; at `top: ~110px` the idle bar's rect was measured
  at **y 1.3 to 110.3**. This is harmless and was confirmed live rather than assumed:
  the same rule sets `opacity: 0` and `pointer-events: none`, both re-read from the
  idle bar over CDP, and `document.elementFromPoint()` at its centre plus four further
  probe points across that strip returned `.view-header` or `.cm-line`, never the bar
  or any descendant of it.
- Desktop is untouched: `git diff --numstat -- styles.css` shows **66 insertions, 0
  deletions**, all appended after the previous last line (202). (An earlier draft of
  this ADR and the ticket's `implementationSummary` both said 58; the difference is the
  CSS comments added by Ship's critique corrections, and 66 is what `--numstat` reports
  against the committed file.)
- `src/ui/controlBar.ts`, `src/ui/affordances.ts` and `src/engines/platform.ts` are
  unchanged. `PlatformFlags` is deliberately **not** widened with an `isMobile` field;
  its docstring records that omission as deliberate, and a CSS-only fix needs no
  platform predicate in TypeScript at all. No new import anywhere, so `main.js`'s
  `require()` list cannot move.

## Residual risk - what was NOT established

- **No desktop Obsidian was observed.** `environment.desktopCdp9222` is unreachable
  this run (the Flatpak is running without `--remote-debugging-port` and the pipeline
  must not restart it). Desktop rests on a zero-deletion diff plus the text assertions
  in `tests/highlight.test.ts` section 21, **not** on running a desktop Obsidian.
- **No tablet was observed**, although decision 2 widens the selector to cover one.
- **No narrow (~360 CSS px) phone was observed**, which decision 4's arithmetic says
  is the real stress case. One device, one viewport, one orientation.
- **Landscape was not exercised**, so the left/right inset terms in `max-width` stay
  inert and unverified.
- **`--view-header-height` is assumed to describe live chrome.** This device carries
  Obsidian's `show-view-header` body class; a user can turn the view header off, and
  whether the variable still reports 44px then was not measured. If it does, the
  offset over-shoots by 44px and the bar floats a little low - degraded, not
  unreachable, which is why this is recorded rather than engineered around.
- **The wrapped bar covers editor text, which the desktop bar never did.** At `top: 0`
  the bar overlaid the tab and view-header strip; at `top: ~110px` and 125.64px tall it
  occupies editor rows from y 110.3 to roughly y 236. `src/ui/highlight.ts:474` scrolls
  with `y: "center"` (NRL-110), so the spoken sentence is centred rather than parked at
  the top and is not normally underneath it. **The case this ADR first recorded as
  unmeasured has since been observed, in the overlapping direction**, by Verify on this
  same device: on an unscrollable note (`scrollHeight` 997 == `clientHeight` 997,
  `scrollTop` 0, keyboard dismissed) the first chunk's sentence mark measured
  **y 209.6 to 255.6** against a bar bottom of **236**, so **26.4px of its 46px height
  sits behind the bar**, in the band x 112 to 336. `y: "center"` cannot help, because
  there is nowhere to scroll. So read this bullet as a confirmed overlap on a short
  note rather than as an open question; it is filed as **NRL-129**
  (https://linear.app/note-reader-local/issue/NRL-129) and is not fixed here. The
  opposite direction - a note long enough to scroll - remains unobserved.
- **No claim is made about any Obsidian version other than 1.13.7 on this device.**
- `src/ui/controlBar.ts` imports `obsidian` at line 1, so it has no runtime in the
  bare-Node suite. Nothing in `npm test` can observe a rect, a wrap, an inset or a
  tap; section 20 pins `styles.css` as text only. A green suite is not evidence here
  (AGENTS.md rule 11).

## Alternatives rejected

- **Direction 2, a bottom anchor above Obsidian's mobile navigation bar.** The
  conventional home for media controls and where a thumb already is. Rejected for the
  three reasons in decision 1, chiefly that it must clear a navbar whose height this
  repo does not control and which the user can disable, and that it would need the
  first `Platform` import under `src/ui/`. Worth revisiting if the top offset proves
  fragile across Obsidian versions.
- **A literal pixel offset.** Rejected under rule 13: it would be correct on exactly
  this device and wrong on the next.
- **`width`/`height` overrides at 44px.** Rejected because it would require editing or
  shadowing the desktop declarations, and `min-*` achieves the same used value while
  leaving them in the file for the desktop tripwire to assert.
- **Hiding `.local-tts-cb-progress` on mobile.** Rejected per decision 5.
- **A touch drag on the speed readout.** Rejected per decision 6.
- **Widening `PlatformFlags` with `isMobile`.** Rejected: its docstring records the
  omission as deliberate, and this fix needs no platform predicate in TypeScript.

## NRL-129 amendment: the mobile editor reserves the bar's band

- Date: 2026-10-01
- Ticket: NRL-129 (https://linear.app/note-reader-local/issue/NRL-129), filed by this
  ADR's own Residual-risk bullet above. That bullet already carries the correction from
  "neither direction was observed" to the measured overlap, and is **not** restated here.
- Amends this ADR in place. No new ADR and no `srs.md` amendment: the placement decision
  is this document's, and R-M07 was never on the met list, so **no requirement moves and
  the `2 of 16` MUST headline count does not move.**

### The defect, and why it is a consequence of two correct changes

NRL-112's 44px targets made the bar wrap to three rows, so it grew from 41px to
**125.64px** tall and its bottom edge moved from y 41 to about **y 236**. NRL-110
changed the auto-scroll to `{ y: "center" }`, which normally parks the spoken sentence
near the middle of the editor and well clear of that. Both are right. They interact badly
in exactly one case: a note too short to scroll, where there is nowhere for the scroll to
move to. Measured on the Pixel 9 Pro XL (`scrollHeight 997 == clientHeight 997`,
`scrollTop 0`, keyboard dismissed), the first chunk's sentence mark sat at **y 209.6 to
255.6** against a bar bottom of **236**: **26.4px of its 46px height behind the bar**, in
the band x 112 to 336.

### Decision: direction 1, a mobile-only top padding on the editor pane

One rule, one declaration, appended to the `body.is-mobile` region of `styles.css`:

```css
body.is-mobile.local-tts-control-bar-visible .view-content > .markdown-source-view.mod-cm6 {
	padding-top: var(--local-tts-control-bar-height, 0px);
}
```

`src/ui/controlBar.ts`'s `refresh()` toggles `CONTROL_BAR_VISIBLE_CLASS` on
`document.body` in the same statement group as the bar's own `.is-visible`, so the two can
never disagree, and publishes `CONTROL_BAR_HEIGHT_VAR` from `this.el.offsetHeight` when
that is non-zero. `destroy()` removes both. The two names live in a new DOM-free,
`obsidian`-free `src/ui/controlBarCss.ts` so the bare-Node suite can pin them - the
`highlightColour.ts` idiom, and the reason block 12 of `tests/highlight.test.ts` can pin a
custom-property name at all.

`padding-top`, not `scroll-padding-top`: scroll padding is an inset on the scrollport for
scrolling operations, and this defect's whole shape is a document that **cannot** scroll.

### Why no literal is needed, and none appears

Padding ADDS to every offset already above the first line, so
`firstLineTop_new = firstLineTop_old + barHeight`. In both of Obsidian 1.13.7's mobile
header configurations the first editor line already starts at or below the chrome's
bottom: under `.is-phone.auto-full-screen` the scroller's own
`--view-top-spacing-markdown` is itself `calc(var(--safe-area-inset-top) +
var(--view-header-height) + 16px)` (`app.css:21366`), and otherwise
`--view-header-position` is `static` (`:18908`) so the header occupies real layout space
above `.view-content` in a column flex (`:6530`). The bar's top is
`calc(var(--safe-area-inset-top) + var(--view-header-height))` (decision 1 above). So
`firstLineTop_old >= barTop`, hence `firstLineTop_new >= barTop + barHeight = barBottom`,
for any device, row count or theme. The measured case is the slack version:
209.6 + 125.64 = 335.2 against a bar bottom of 236.

### The pane, not the scroller and not `.cm-content`

All line numbers below are `app.css` unpacked from the installed Obsidian 1.13.7 asar and
read in this session.

Obsidian already owns the phone scroller's `padding-top`:
`.is-phone .mod-root .workspace-leaf-content .view-content .markdown-source-view >
.cm-editor > .cm-scroller { padding-top: var(--view-top-spacing-markdown) }` at `:20426`,
specificity **(0,7,0)**. Padding is ONE property, so a rule there would **replace** that
value rather than add to it, and its base differs by configuration -
`calc(safe-area + header + 16px)` at `:21366`, `var(--size-4-2)` at `:18904`, and on a
tablet the same box is padded by `padding: var(--file-margins)` at `:3940`. Restating a
host value we must preserve, or reaching for `!important`, is worse than moving one box
out. `.markdown-source-view` in this position carries no padding declaration, so our rule
is uncontested at **(0,5,1)**, and `* { box-sizing: border-box }` (`:3190`) with
`.markdown-source-view.mod-cm6 { height: 100%; display: flex; flex-direction: column }`
(`:3530`) means a `padding-top` there shrinks the editor's box from the top rather than
overflowing it.

`.view-content >` is load-bearing, not tidiness, and the evidence is stronger than a
hygiene argument: Obsidian nests whole source views inside the editor and really does pad
one of them - `.inline-embed > .markdown-embed-content > .markdown-source-view { padding:
var(--embed-padding) }` at `:11953`. A descendant selector would pad every inline embed
and every table-cell editor by the bar's height for the duration of a read. The child
boundary is the one Obsidian asserts itself at `:3939`.

Padding `.cm-scroller` or `.cm-content` is additionally worse for the NRL-90 reason
below: there the content moves **within** the scroller, where pane padding moves the
scroller's own border box and leaves the content's position inside it untouched.

### Why the height is published by JS, and the honest cost

**Rejected: a CSS-only expression from the bar's own declarations.** It is derivable for
the one measured device and only for it. The 125.64px decomposes exactly as
44 + 44 + 16.64 (two 44px control rows and the progress readout alone) + 2 x 4px `gap` +
12px `padding` + 1px `border-bottom`. Every term is contingent: the row **count** is
viewport-width dependent (decision 4's arithmetic says a ~360px phone wraps to more rows
and a wide tablet to fewer) and the third row's height is `--font-ui-smaller`'s line box,
so it is theme dependent. CSS cannot ask how many rows a `flex-wrap` produced, so the
expression would have to freeze "three rows" - which under-pads a narrower phone,
partly reopening this defect, and over-pads a tablet. That is rule 13 exactly.

**The cost of publishing it instead, stated plainly:** `controlBar.ts` imports `obsidian`
at line 1 and has **no bare-Node runtime**, so the publish, the `> 0` guard and the
teardown have **no automated coverage of any kind** - identical to NRL-112's position.
`controlBarCss.ts` recovers the only testable part, the two string names, which is what
stops a one-character divergence between the TypeScript and the stylesheet silently
producing no padding with every other check green.

### Consequence for NRL-110: 489.0 is a desktop / bar-hidden figure from here on

This is a deliberate change to a measured number recorded elsewhere, written down so
nobody finds it by surprise. `scrollRectIntoView`
(`node_modules/@codemirror/view/dist/index.js:140-200`) builds `bounding` as
`{ top: rect.top, bottom: rect.top + cur.clientHeight * scaleY }` for the first ancestor
with `scrollHeight > clientHeight`, and the `center` arm (`:175-181`) lands the cursor
rect at `bounding.top + (boundingHeight - rectHeight) / 2`. Pane padding moves the
scroller's `rect.top` **down** by `barHeight` and reduces its `clientHeight` by the same
`barHeight`. So NRL-110's measured landing of **489.0** = (997 - 19) / 2 becomes, on
mobile while the bar is visible, **125.64 + (871.36 - 19) / 2 = 551.8** in viewport
coordinates. **NRL-110's 489.0 is a desktop / bar-hidden figure from here on** (ADR 0022
and NRL-110's own series are unamended and remain correct for those conditions).

The property NRL-110 cares about is preserved and strengthened: the spoken line is still
not parked flush with an edge, and it is now centred inside the **unobstructed** band,
which is direction 3's correctness without touching `src/ui/highlight.ts`. The
fall-through arm (`rectHeight > boundingHeight`, ADR 0022 decision 3 as corrected by
NRL-110) is still not reached - 19px against 871px - and `yMargin` is still unread on the
arm that runs. **551.8 is arithmetic from the library source, not a measurement**; Verify
measures it.

### Why NRL-90's suppression is not tripped, and the one case where it is

The hazard would be an unarmed `scroll` event fired by the layout change itself, which
would latch suppression for a whole read. Two mechanisms were checked in the library
source rather than assumed.

CodeMirror's own re-anchor write (`index.js:7913-7919`:
`diff = lineBlockAt(scrollAnchorPos).top - scrollAnchorHeight`, then a `scrollTop` write)
keys on the anchor line's **height-map** top, a document-internal coordinate. Pane padding
moves the scroller's border box and leaves `scrollTop`, the content's position within the
scroller and the height map untouched, so `diff` is 0 and no write happens. (That is the
second reason to prefer the pane over `.cm-scroller` or `.cm-content`.)

The browser's own `scrollTop` clamp fires only when the scrollable **range** shrinks. Pane
padding shrinks `clientHeight`, which **enlarges** `scrollHeight - clientHeight`, so
showing the bar cannot clamp. It can clamp when the bar **hides** while the note is
scrolled to the bottom - **one** unarmed `scroll` event, which latches suppression
*after* the read has already ended, and `resetScrollSuppression` runs at all three
read-start sites, so the next read clears it. That is the one named, bounded case and
Verify measures it. NRL-90's F1 residual (a dispatch that moves the DOM by zero) is
unchanged in kind, since `center` still computes `moveY` unconditionally, though **which**
opening chunks clamp at `scrollTop` 0 will differ, the box being smaller.

### What this does not touch

`src/ui/highlight.ts` is **not in the diff**, so ADR 0022 decision 3 (no `coordsAtPos`
there) and ADR 0030 are satisfied by construction and no new scroll source exists.
`src/ui/affordances.ts` is untouched. The new rule declares `padding-top` and nothing
else, so **R-M14 holds by inspection**: there is still no `display: none` and no
`visibility: hidden` anywhere in the mobile block, and block 20's existing sweep over
every `body.is-mobile` rule picks the new rule up for free. The rule is deliberately
**not** wrapped in an `@media`, because block 20's scanner is flat and its own comment
records that a mobile rule inside an at-rule drops out of that sweep silently.
Non-negotiable 9 is not on this path.

### Why not the other three directions

- **Direction 3, pass an obstruction height into the scroll target** so `y: "center"`
  centres within the unobstructed band. The ticket called it the most correct of the four
  and it **cannot fix this defect at all**: the case is a note that **cannot scroll**, so
  there is nowhere to move the sentence to however the target is computed. It also reaches
  into the one file ADR 0022 decision 3 and ADR 0030 both constrain. Note that the chosen
  fix obtains direction 3's *effect* on scrollable notes as a side effect, by shrinking the
  box the `center` arm measures - see the NRL-110 section above.
- **Direction 4, auto-hide the bar** after a few seconds of no interaction. It leaves the
  first screen occluded for the whole period the bar is up, which includes the start of
  every read - exactly the window this defect is about - and it changes behaviour the user
  did not ask to change.
- **Direction 2, narrow the bar by dropping a control on mobile.** Argued down in this
  ADR already, at decision 5 and in the "no `display: none`" paragraph of decision 4's
  block, on R-M14 grounds. Nothing here reopens it, and the chosen fix adds no
  `display: none` of its own.

### Residual risk - what this amendment does NOT establish

- **Nothing was observed on a device for this fix.** Every number above is either the
  pre-fix measurement already recorded in this ADR, arithmetic from `app.css` and
  `@codemirror/view`'s own source, or a derivation. `npm test` checks `styles.css` as
  **text** and cannot observe a rect; `controlBar.ts` has no bare-Node runtime at all.
  **A green suite is not evidence here** (rule 11), and 551.8 in particular is predicted,
  not measured (rule 13).
- **Reading view is deliberately not padded.** `.markdown-preview-view` gets no rule,
  because the highlight is a CodeMirror decoration and does not exist there. The bar can
  still overlay preview text; that is pre-existing and out of scope.
- **A mid-read rotation leaves a stale published height** until the next player state
  event re-runs `refresh()`. No `ResizeObserver` was added: it would be more untestable
  code in the one file the suite cannot reach.
- **`offsetHeight` is integer-rounded, so the published value will not equal the measured
  one.** The 125.64px above would publish as `126px`. The 0.36px goes into extra clearance,
  which is the fail-safe direction, but a reader comparing the two numbers on the device
  should expect them to differ by under a pixel rather than conclude something is wrong.
  `getBoundingClientRect().height` would be exact; `offsetHeight` was kept because it is
  the cheaper read and the difference is below the threshold anything here cares about.
- **The editor loses `barHeight` of visible height while a read is in progress.** That is
  the layout shift direction 1 was always going to cost, taken knowingly.
- **The view-header-disabled case is still open**, and compounds here: this ADR's existing
  `--view-header-height` residual means the bar's top can sit up to 44px above the real
  chrome bottom, and the padding is the bar's measured height, so up to 44px of the first
  line can still be occluded.
- **Tablet, a ~360 CSS px phone and landscape** remain unobserved, as above.
- **Desktop rests on construction, not observation.** CDP 9222 is unreachable here, so the
  argument is that `body.is-mobile` cannot match a desktop Obsidian and the diff deletes
  zero lines from `styles.css`; block 21's five desktop guards stay green.
