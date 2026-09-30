# 0013. Abandoning an In-Flight Engine Load

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-48

## Context

A read does two things before any audio exists: it loads the chosen engine, and
then it plays. `playWithFallback()` awaits the caller's `beforeAttempt` hook
(`src/audio/fallback.ts`), and for `main.ts` that hook resolves the candidate's
voice and then `await`s `engine.prepare()` behind a `Loading X...` Notice. For
Kokoro on a cold model load that is seconds.

Stop did nothing during that window, and the mechanism is not subtle.
`Player.stop()` aborts the controller the Player creates inside `play()`
(`src/audio/player.ts:239`); during `beforeAttempt` that controller is still
null, so `stop()` aborts nothing, and its `setState("idle")` is swallowed by the
equality guard at `player.ts:868-869` whenever the player is already idle.
Nothing in `fallback.ts` is listening either - `attempt()` registers its
`state`/`error` listeners only after `beforeAttempt` has already returned. A
Stop during a load was therefore unobservable by any route, so no
Player-event-only fix was possible.

Measured, bare Node, by driving the real `playWithFallback` against an engine
whose `prepare()` the test holds open (`tests/fallback.test.ts`, cases T1-T3, no
Obsidian available in that lane): aborting mid-load left the returned promise
pending forever, and when the load later finished the engine went on to
synthesize chunk 0 - speech after the user's explicit Stop. Worse, when the
abandoned load *failed* after the Stop, the rejection was caught as a load
failure and started speaking the *next* candidate.

The obvious-looking fix, adding an `AbortSignal` parameter to
`SpeechEngine.prepare()`, is wrong here. `types.ts:222-231` documents `prepare()`
as safe to call repeatedly, and Kokoro's is a memoised shared boot promise:
`prepare()` delegates to `load()` (`src/engines/onnx/kokoro.ts:388-390`), which
caches in `this.ready` and nulls it only on failure. Cancelling that would mean
inventing per-caller cancellation for a promise several callers share, and would
throw away a nearly-finished model.

## Decision

`prepare()` gains no signal parameter. Instead `playWithFallback()` takes an
optional 8th positional parameter `signal?: AbortSignal`, and a Stop **abandons**
the await rather than cancelling the load.

- The signal comes from a new per-read `AbortController` owned by `main.ts`
  (`readScope`), created at the top of each of the three read paths and aborted
  in `stopReading()` - which also covers the rename and delete handlers and the
  three Kokoro reconfiguration paths for free - and in `onunload()`.
- `playWithFallback()` checks `signal.aborted` at the top of each candidate
  iteration, races `beforeAttempt` against the signal, and checks again between
  a finished load and `play()`.
- An abort resolves the function with `null`. It is **not** a candidate failure:
  no `onFallback`, no next candidate. The module header already drew exactly
  that Stop-is-not-a-failure line for the play phase.
- Because `null` now means either "every candidate failed" or "the user pressed
  Stop", the caller disambiguates with its own controller rather than widening
  the return type: `main.ts` checks `scope.signal.aborted` before the "no speech
  engine is available" Notice and before arming the sleep timer.
- The abandoned promise's later settlement is **neutralised at creation**, not
  observed. `raceAbort()` converts the load's rejection into a value with an
  `onRejected` handler attached the moment the race is built, which marks the
  original promise handled for good. This is part of the decision, not an
  implementation detail: without it, a load that fails after the Stop is an
  unhandled rejection (fatal in Node by default, logged in Electron's renderer),
  and a bare `.catch(() => {})` would also hide a real load failure that arrives
  while we are still waiting. The abort arm resolves rather than rejects, so
  there is no rejecting arm in the new code at all.
- `warmUpEngine()` is untouched. Nothing was requested there, so there is no
  read to cancel.

## Consequences

- Stop during a load now takes effect immediately: the read resolves, nothing
  speaks, no fallback is attempted, and no engine-availability Notice appears.
- **The cost, stated plainly: Stop does not free the work in flight.** The model
  bytes keep loading and the worker keeps booting after the user pressed Stop.
  On a cold Kokoro load that is seconds of CPU and I/O the user asked to end.
- That cost buys the next read: a load that finishes after an abandoning Stop is
  cached in `this.ready`, so pressing Play again is instant rather than starting
  over. This is a deliberate trade, not an oversight.
- `SpeechEngine` is unchanged, so no engine needs abort plumbing and the
  repeatedly-callable contract stands.
- `main.ts` loses the triplicated `beforeAttempt` body to a shared
  `prepareCandidate()`. `readSelection` and `readFromCursor` gain the
  `loading engine` / `engine loaded` traces `readActiveNote` already had; both
  carry an engine id and a millisecond count only, so no note text is logged.
- `tests/fallback.test.ts` pins the four cases (T1-T3 fail against the unfixed
  code, T4 pins the no-signal call as unchanged), including the absence of an
  unhandled rejection rather than trusting the reasoning above.
- Not covered, and unchanged: the already-queued speechd chunk that `spd-say -S`
  cannot reach after synthesis has started (NRL-41/NRL-43). That is a later
  phase of the same read.
- Unverified: all of the above is bare-Node evidence. Nobody has pressed Stop
  while a real `Loading Kokoro...` Notice was up in Obsidian. That belongs to
  the Verify phase.

## Alternatives considered

- **Add `signal` to `SpeechEngine.prepare()`.** Rejected: see Context. Kokoro's
  load is shared and memoised, the contract promises repeated calls are safe, and
  cancelling discards work that is useful to keep.
- **Observe `Player.stop()` instead of a new controller.** Rejected as
  impossible, not merely awkward: the Player has no controller and emits no
  observable state during `beforeAttempt`, and `fallback.ts` has not attached its
  listeners yet.
- **Treat an abort as a load failure** (reuse the existing `onFallback` path).
  Rejected: it would show "Kokoro failed; trying espeak" and then speak the note
  through espeak, which is the exact opposite of what Stop means.
- **Widen `playWithFallback`'s return type** to distinguish aborted from
  exhausted. Rejected: five call sites consume the return value for nothing else,
  and the caller already holds the controller that answers the question.
- **Put `signal` on `FallbackHooks`.** Rejected: `FallbackHooks` is documented as
  callbacks only, and a positional parameter leaves every existing call site
  valid.
