# 0026. Failed settings write retry, and the onunload bound

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-91

## Context

NRL-58 (`docs/adr` precedent: none written at the time, see `src/settings/saveQueue.ts`'s
own header comment) introduced `SaveQueue`, the single funnel for every durable
`saveData()` write, to stop an older snapshot landing after a newer one. It left two
residuals deliberately unaddressed, both named in its own code comment
(`saveQueue.ts:126-130` pre-NRL-91):

> A rejected write must not wedge the queue... The failed payload is NOT retried: a
> blind retry could resurrect a stale snapshot behind a newer one.

**Residual 1.** A failed write reports once through `onError` and does not block the
next enqueue. If no later save happens - a rename re-keys `positions` in memory, the
write to disk fails, and nothing saves again before the user quits - the disk is left
on the pre-surgery snapshot. The next launch reads the old key back.

**Residual 2.** Obsidian's `onunload(): void` is synchronous. `PositionThrottle.dispose()`
already flushes its own pending window synchronously before `onunload` returns, but the
write that flush triggers is asynchronous (`saveData()` returns a `Promise`), and nothing
in `onunload` can `await` it. An unload landing mid-write can therefore lose the newest
snapshot. `drain()`/`idle()` exist on `SaveQueue` but are test-only; there was no
production call site that could use them, because there is no lifecycle hook to hang an
`await` off.

**Reproduction, against the code as it stood before this ticket** (see
`tests/vaultPersistence.test.ts` T7-T10, run against the unmodified `SaveQueue` before
any of this ADR's changes): 18 checks failed, concretely demonstrating both residuals
rather than inferring them from reading the code alone.

- Residual 1: `onError` fired on the FIRST rejection, not after exhausting anything (there
  was nothing to exhaust); a fresh `enqueue()` after the failure was required to recover -
  with no further save, `write` was called exactly once, ever, and no retry timer was ever
  armed (`clock.pending()` stayed `0`).
- Residual 2: `SaveQueue.dispose()` did not exist at all. Every call to it threw a
  `TypeError`, caught by the test rather than crashing the suite, in all three of "a write
  is still in flight", "a retry would be armed" (moot, since residual 1 means nothing was
  ever armed pre-fix), and "nothing is armed at all".

## Decision

**Residual 1: retry with a FRESH payload, never the stale rejected one.** `SaveQueue`
gains an optional `getCurrentPayload: () => PluginData` constructor option. When a write
rejects and this option is supplied, the queue arms a capped, backed-off retry that calls
`getCurrentPayload()` again at the moment the retry actually fires - never the object that
was rejected. `main.ts` wires it to the literal same expression `saveSettings()` already
computes: `serialisePluginData(this.pluginData, this.settings)`. This is why the retry
cannot resurrect stale state even in principle: it always reads live truth, so the worst
it can write is "as new as what just failed", never older.

When `getCurrentPayload` is omitted, `SaveQueue` behaves exactly as it did before this
ticket - one attempt, one `onError`, no retry - byte for byte, which is what keeps every
pre-NRL-91 test construction site (`new SaveQueue({ write })` with no other options)
compiling and behaving unchanged.

**Retry schedule: 3 capped attempts, exponential backoff 500/1000/2000ms.** Worst-case
added delay before giving up is 3500ms. This is a judgement call, not a measurement: 3 is
small enough to bound total delay under 4 seconds while giving genuine resilience against
a momentary transient failure (disk contention, a slow adapter), rather than either a
single bare attempt or an unbounded hammering loop. **Obsidian's real `saveData()` has
never been observed to reject in this codebase's history** - NOT VERIFIED IN OBSIDIAN. If
it never rejects in practice, residual 1 was theoretical and this number was never
exercised for real; the ticket's own Caveat said as much before any code was written.

**`onError`'s semantics are REPURPOSED**, not added to. Before this ticket it fired once
per rejected write (there was only ever one attempt, so "once per write" and "once per
attempt" were the same fact). It now fires once per write that could not be saved even
after exhausting every retry - or immediately, unchanged, when `getCurrentPayload` is
absent and there is nothing to exhaust. This is a deliberate, user-visible behaviour
change: a transient failure the retry recovers from now produces ZERO Notices, where
before it produced exactly one regardless of whether the very next save would have
succeeded moments later. A new, quiet, metadata-only `onAttemptFailed(err, attempt)`
callback fires on every individual failed attempt (including ones a retry will follow),
wired to `trace()`, so the per-attempt signal `onError` used to be is not lost, only moved
to a channel that does not surface a Notice for something that turned out fine.

**A real enqueue() always supersedes an armed retry, cancelling it outright rather than
merely outrunning it.** If a real save (a rate nudge, another rename) lands while a
synthetic retry is backed off and waiting, `enqueue()` clears the timer and resets the
retry budget to zero before issuing the real write. This is the same newest-wins
invariant NRL-58 exists to protect, extended to cover the queue's own internal retry
timer as a source of a write, not only external callers. `tests/vaultPersistence.test.ts`
T9 verifies this explicitly, because it is the case where a naive implementation (replay
the stale rejected payload on a timer, race it against a real save) would reintroduce
exactly the class of defect NRL-58 closed.

**Residual 2: accept the bound, and close only the one new leak this ticket would
otherwise add.** Obsidian's `onunload()` gives no async hook. Building retry machinery
without also handling its own teardown would leave a new resource leak on top of the
pre-existing gap: an armed backoff timer pointing at a plugin instance about to be torn
down. `SaveQueue.dispose()` clears that one timer and nothing else - it does not touch
`running` or `pending`, and does not attempt to await or drain an in-flight write. `main.ts`
calls it in `onunload()`, after `positionThrottle.dispose()` has had its one synchronous
chance to enqueue a final write, before the rest of teardown.

## The exact bound

**At most one throttle window's worth of position data, OR one settings write that was
mid-retry-backoff at the moment of unload, whichever the moment catches.**

Concretely, in this codebase: "one throttle window" is `PositionThrottle`'s
`DEFAULT_INTERVAL_MS`, 1000ms (`positionThrottle.ts:38`) - the window a reading-position
progress event can sit inside before it would have been flushed on its own. This part of
the bound is unchanged from before NRL-58 and before this ticket; it was already accepted
and documented in `AGENTS.md`'s NRL-51/NRL-58 bullets.

What NRL-91 widens is the second clause, and it is a strict widening in words, not in
kind. Before this ticket, the only loss window at `onunload` was "the final flush-triggered
write's own async rejection resolves after `onunload` has returned" - a single async gap
with no retry behind it, since nothing retried. After this ticket, that same async gap
still exists (`dispose()` cannot close it: `write()`'s promise settles after `onunload`'s
synchronous body has already run), and in addition, if an EARLIER write in the same
session had already failed and its retry is still counting down when the user quits, that
armed retry is now a resource `dispose()` correctly clears - so the write it would have
retried simply does not happen. In neither case is anything CORRUPTED: the disk is left on
whatever the last successful write wrote, never on a torn or partial payload, and the loss
is bounded to "at most the most recent settings/position change", never accumulating
across a session.

## Consequences

- A transient write failure is now self-healing within ~3.5 seconds in the common case,
  with zero user-visible Notices if it recovers - a strict improvement over one Notice per
  failure regardless of outcome.
- The one new resource this ticket introduces (`retryTimer`) is torn down defensively at
  `onunload`; the two OLD resources (`running`, `pending`) are explicitly, deliberately,
  left as they were before this ticket, because there is nothing sound to do about them
  without an async teardown hook Obsidian does not offer.
- `onError`'s meaning changed for any code reading it as "a write just failed" rather than
  "a write could not be saved at all" - the only current reader is `main.ts`'s
  `reportError(...)` Notice, and its own comment at the `save: () => ...` call site was
  updated to match.

**NOT VERIFIED IN OBSIDIAN.** Two things this ADR rests on are unmeasured against the real
host, matching every other residual-risk ADR in this repository (0015, 0016): whether
Obsidian's real `saveData()` ever actually rejects in practice at all (if it does not,
residual 1's retry path has never been exercised by a real failure), and whether a real
`window.setTimeout` armed inside a plugin instance survives Obsidian's own plugin-unload
teardown long enough for `dispose()` to reach it, or is already invalidated by the time
`onunload` runs. CDP was not attempted for this ticket. All evidence above is bare-Node,
against the real `SaveQueue` class, with a fake clock the tests own
(`tests/vaultPersistence.test.ts` T7-T10).
