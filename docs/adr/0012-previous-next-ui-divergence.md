# 0012. Previous and Next Button UI Divergence

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-53

## Context

`srs.md:266-267` specifies that previous and next buttons shall be part of the
control interface to move between chunks during playback:

> The control bar shall include ... Previous (skip back one chunk) and Next
> (skip forward one chunk) buttons to navigate the queue.

NRL-19 implemented the underlying player logic (`Player.next()` and
`Player.previous()`) but did not implement the UI buttons themselves. This
left the feature incomplete: the capability existed but was not exposed to the
user through the control bar interface.

## Decision

Add Previous and Next buttons to the control bar UI (`src/ui/controlBar.ts`),
wired to `player.next()` and `player.previous()` respectively.

- **Previous button**: placed before the Replay button, uses "skip-back" icon,
  navigates to the previous chunk and replays it from the start. Does nothing
  if already at the first chunk (bounds-checked by the player).
- **Next button**: placed after the Stop button, uses "skip-forward" icon,
  navigates to the next chunk and replays it from the start. Does nothing if
  already at the last chunk (bounds-checked by the player).
- **Gating**: The buttons are never disabled or hidden. They are always
  available during active playback, paused, or preparing states. The player
  itself handles bounds-checking and silently no-ops out-of-bounds navigation
  attempts (first chunk when calling `previous()`, last chunk when calling
  `next()`).
- **Progress readout**: The n/total readout correctly reflects the new chunk
  index after navigation, maintained by the existing `Player.on("progress")`
  event.

## Justification for the deviation

This resolves the incompleteness rather than being a true deviation from spec.
The buttons were required but missing. Adding them fulfills the original
requirement.

## Consequences

- `src/ui/controlBar.ts` gains two new buttons (Previous, Next) with click
  handlers wired to `player.previous()` and `player.next()`.
- `tests/player.test.ts` gains four new test cases:
  - `next()` mid-run advances the chunk index and replays.
  - `next()` at the last chunk is a no-op.
  - `previous()` mid-run decrements the chunk index and replays.
  - `previous()` at the first chunk is a no-op.
- `srs.md:266-267` is clarified to note that buttons are implemented in the
  controlBar and navigation bounds are checked by the player itself.
