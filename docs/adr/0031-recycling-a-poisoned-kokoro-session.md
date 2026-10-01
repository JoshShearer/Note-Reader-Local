# 0031. Recycling a poisoned Kokoro session

- Status: accepted
- Date: 2026-10-01
- Ticket: NRL-101 (no srs.md requirement ID; R-M07/R-M05 adjacent)

## Scope, stated first because it is the easiest thing to misread

**This fixes the blast radius, not the trigger.** The initial ORT crash
(`failed to call OrtRun(). ERROR_CODE: 2 ... running Expand node.
Name:'/encoder/bert/Expand' Status Message: invalid expand shape`) occurred
**once in roughly 15 minutes on one device**, with the three best hypotheses
already excluded by clean-session re-runs - CJK content in general, the specific
sentence, and 14 Unicode/script/emoji/RTL/control-character inputs - and it is
**not reproduced here**. Nothing in this decision makes that crash less likely,
and nothing in it establishes that recycling the worker cures an onnxruntime
session which has entered that state. Do not read this ADR, its tests, or its
device observation as a crash fix.

## Context

What *was* reproduced, twice, is the aftermath. Immediately after the one
observed crash, 14 direct `engine.synthesize()` probes - including a plain
English control - all failed in 4-169 ms with the identical message. A full
plugin reload (`disablePlugin` + `enablePlugin`) was the only thing that
recovered it.

The mechanism is structural and was read off the code rather than inferred.
`kokoro.worker.ts`'s drain loop catches a throw from `speak()` and posts
`{type:"error", id, message}`. `kokoro.ts`'s `case "error"` arm rejects **the one
pending entry** for that id and touches nothing else: `this.worker`,
`this.ready` and `this.prepared` all survive. So the next `synthesize()`
short-circuits on `if (this.ready) return await this.ready;` straight back into
the same worker and the same session. `dispose()` is the only thing in the file
that calls `worker.terminate()`, and nothing calls `dispose()` on a failure.
The engine instance is long-lived - `createEngines()` constructs exactly one
`KokoroEngine` and `main.ts` calls it once in `onload` - so one failure silently
breaks every later read for the rest of the Obsidian session, with no diagnostic
anywhere pointing at "reload the app".

## Decision

1. **Mark the engine when the worker reports a speak failure**, in the
   `case "error"` arm's `msg.id !== undefined` branch, before the pending
   lookup, with a boolean `sessionFailed`.
2. **Recycle on the NEXT `synthesize()`, not inside the failing one.** A new
   private `recycleIfSessionFailed()` runs before `await this.load()`: it clears
   the mark, `await this.dispose()`es, spends the budget, and loads again.
3. **One recycle per successful-synthesis epoch**, with a second boolean
   `recycleSpent`. A failure arriving after a spent recycle throws
   `KOKORO_RELOAD_REQUIRED` immediately, with no second reload.
4. **`isPrepared()` returns `this.prepared && !this.sessionFailed`**, so the
   recycling read raises main.ts's existing NRL-65 "Loading Kokoro (local
   neural)..." notice - **and `prepare()` performs the recycle too**, so the
   reload happens inside that notice rather than behind it. The second half of
   that is not tidiness and was not in the plan; it is there because the first
   half alone was measured not to work. See "The loading notice needs two
   halves" below.
5. **One exported string, `KOKORO_RELOAD_REQUIRED`, is the whole of the distinct
   notice.** `reportError` already puts `err.message` into a Notice for ten
   seconds and traces it.
6. **`kokoro.worker.ts` is not touched at all** - an empty
   `git diff -- src/engines/onnx/kokoro.worker.ts` is part of the gate.

## Why the mark lives in the worker `error` arm and not in a catch

The intent was "any non-abort rejection from a speak". A `catch` around the
awaited pending promise is a **wider** set that includes two things which are
not poisoned sessions, and both matter:

- **`dispose()`'s own `new Error("Kokoro engine disposed")`.** The player
  prefetches, so at the moment chunk N poisons the session chunk N+1 is already
  awaiting its pending entry. The recycle's own `dispose()` rejects it - so a
  catch-based mark would **re-arm the flag the recycle just consumed**,
  guaranteeing a second reload on the very next read, every single time.
- **`sendVoice()`'s "Voice file ... is not downloaded" throw**, a missing-file
  condition no amount of reloading can fix.

An `AbortError` can never arrive on the worker arm: aborts are rejected locally
by `synthesize()`'s own signal listener and by `cancelPending()`, neither of
which goes near the worker's messages. So the narrow seam realises the intent
and is strictly safer. The **id-less** `error` branch is deliberately not
marked: it rejects the load promise, and `loadOnce()`'s catch already nulls
`ready`, clears `prepared`, terminates the worker and rethrows, so that path
self-heals.

## The loading notice needs two halves, and this was measured

Making `isPrepared()` false is what raises the notice, but on its own it does
not put the reload inside it. main.ts wraps **`prepare()`** in
`withLoadingNotice`, and `prepare()` used only to call `load()`, which
short-circuits on `if (this.ready) return await this.ready` - and a poisoned
engine still holds a resolved `ready`. So the notice was shown and dismissed
before the recycle started.

Measured on a Pixel 9 Pro XL (Android 17, WebView Chromium 154) over CDP, with
the mark set and a real `read-note`: the diagnostics log reads
`loading engine kokoro` and `engine loaded kokoro in 0ms` at the same
millisecond, the notice was sampled on screen from +117 ms to +205 ms - a
**88 ms** window - and the recycle's own load ran from 05:48:12.661 to
05:48:22.501, **9,840 ms**, all of it after the notice had gone. That is exactly
the "appears hung" failure this decision exists to avoid, arriving through a
different door.

So `prepare()` now recycles as well, guarded on `sessionFailed && !recycleSpent`.
The budget guard is the load-bearing half: a throw out of `prepare()` is a
candidate **load** failure, and `playWithFallback` turns that into "no speech
engine is available; check settings.", which would lose
`KOKORO_RELOAD_REQUIRED` altogether. The hint must come from `synthesize()`,
where the player's error path carries it to `reportError`. Both directions are
pinned: `prepare()` recycling (red without the change) and `prepare()` never
throwing the hint (green either way, kept as a guard).

## Why there is no retry inside the failing call

A recycle costs a full cold load. `dispose()` revokes the blob cache, so the ORT
pack is re-inflated (measured elsewhere on this device at 354.2 ms SIMD /
524.9 ms JSEP) and 155 MB of weights are re-read from disk. Spending that
silently inside one `synthesize()` would read as a hang, which is worse than one
honest failure. So the failing read reports the engine's own message and the
next read pays for the reload, with a visible loading notice.

A narrower recycle that kept `this.blobs` would be faster and is deliberately
**not** taken: `dispose()` is the exact teardown a plugin reload performs, and a
plugin reload is the only recovery anyone has observed to work. Narrowing it
would optimise against an unmeasured hypothesis.

## The ordering trap in `recycleIfSessionFailed()`

`this.recycleSpent = true` is assigned **after** `await this.dispose()`, which
looks like a mistake and is not: `dispose()` clears both flags, so assigning
first would hand the budget straight back. That ordering is also exactly what
makes a settings change (`setOptions` -> `dispose`) and a plugin reload refill
the budget while the recycle's own dispose cannot. A tidy-up that hoists it
silently disables the bound.

## The budget's clearing rules, and the accepted cost

`recycleSpent` is cleared by a successful `synthesize()` (so one transient
failure cannot arm the notice forever), by any `dispose()`, and by a **failed**
recycle load. That last one is deliberate twice over: after a failed load the
engine is in the same state as one that never loaded, so the next read is an
ordinary cold load rather than a second recycle, and `load()`'s own errors
("Kokoro weights are missing. Download them from settings.", "Bundled ONNX
Runtime is corrupted. Reinstall Local TTS Reader.") are allowed through
**unchanged** rather than being replaced by a generic reload hint - replacing
them would hide the real cause, the opposite of this ticket's purpose.

**Accepted cost:** the budget is per-engine-instance, so a user whose underlying
problem was transient and self-corrected between the recycle and a later read
still sees the reload notice until something disposes the engine. Accepted
because, on the only evidence anyone has, a failure that survives a full worker
teardown is not recoverable in-session, and the alternative is a multi-second
reload on every read for a failure already shown not to respond to one.

## The reload does not fetch, by construction

Non-negotiables 5 and 6. `loadOnce()` gets config, tokenizer and weights from
`this.store.readOptional()` (vault adapter reads under
`.obsidian/local-tts/kokoro`), the worker script from the in-memory
`globalThis.KOKORO_WORKER_CODE` base64, and the two runtime files from
`readBundledRuntime()`, which inflates `__ORT_ASSETS__` out of `main.js` and
verifies SHA-256. There is no `fetch()` anywhere on the path, and
`kokoro.worker.ts`'s `isRemote`/`assertLocal` guards and fetch shim are
byte-identical across this change. Asserted both ways in the suite: a throwing
`fetch` stub with a zero-call assertion, and a positive check that the weights
path is read a second time.

## Consequences

- A failure followed by a good request now recovers without the user doing
  anything, at the cost of one visible model reload.
- A failure that survives the reload produces a distinct, actionable message
  instead of the same engine text a third time.
- `isPrepared()` no longer means only "loaded"; it means "ready to speak without
  a load". That is what main.ts's loading-notice gate actually wants, but a
  future caller reading it as "has loaded at least once" would be wrong.
- `prepare()` can now spend the recycle budget, so `warmUpEngine()` reaches it
  too: a settings change that triggers a prewarm on a marked engine recycles
  there instead of on the next read. That is the same work in a better place,
  and it is why the **budget** (`recycleSpent`) is cleared by a successful
  synthesis rather than by a successful load - a load proves the worker boots,
  not that it can speak. Read that precisely, because a looser wording of this
  bullet contradicted the accepted-cost bullet above: a success clears the
  budget, **not** the mark, and only while the budget is still unspent. Once
  `sessionFailed` and `recycleSpent` are both true the engine is terminally
  stuck until a `dispose()` - a good request gets `KOKORO_RELOAD_REQUIRED` in
  0 ms and never reaches the line that would refill the budget. That is the
  accepted cost stated above, not a softer second rule.
- Rate application (non-negotiable 9) is untouched: Kokoro's capabilities have
  `ownsPlayback: false`, the worker always receives `rate: 1`, and the recycle
  re-issues no speak, so there is no second application anywhere.
- No cloud fallback is introduced (non-negotiable 4): the recycle reloads the
  same local engine and `playWithFallback` is unchanged.
- `srs.md` is **not** amended and no requirement moves. R-M07 says nothing about
  session recovery and nothing here deviates from any requirement, so this is
  additive behaviour in an unspecified area. The `2 of 16` MUST count is
  unchanged.

## Residual risk

- **Blast radius only.** Repeated here because it is the whole of the ticket's
  honest ceiling: the trigger is unknown and unreproduced.
- **Recycling-cures-ORT is UNPROVEN.** The on-device trigger used to exercise
  this path is an **unknown voice id**, which kokoro-js rejects inside
  `tts.generate` and which travels the identical drain-catch ->
  `{type:"error", id}` -> `case "error"` -> `reportError` path. It does **not**
  corrupt the onnxruntime session. So the device observation demonstrates that
  the *handling* was wrong and that the new handling recovers; it does not
  demonstrate that a reload cures a genuinely corrupted session. The only
  evidence for that remains the single observed manual plugin reload.
- **The indefinite `preparing` stall is out of scope.** A separate failure was
  seen on the same device during NRL-90: no chunk dispatch at all, state stuck
  in `preparing`, needing three reload cycles at 60/80/95 s, present on both
  builds. It is structurally distinguishable from this poisoning - poisoning
  fails loudly and fast (an error is posted, `player` emits `error`, a "playback
  failed" line appears, 4-169 ms), the stall is silent (no error event, no log
  line) - and `kokoro.worker.ts`'s own comment names a candidate, the separately
  bundled espeak-ng phonemizer's uncontrolled async init never settling.
  **This change does not address it**: the mark is only ever set by a posted
  error, so a worker that never answers never arms the recycle. The
  discriminator is one probe: race a direct `synthesize()` against a 10 s
  timeout and read the tail of the diagnostics log. A watchdog around `load()`
  and `speak()` is a separate change with its own risk - a timeout that fires on
  a slow but healthy 155 MB load on a phone is worse than the stall - and should
  be filed only once a stall has actually been classified by that probe.
- **An abandoned request can still spend a recycle.** The mark is set before the
  pending lookup, so an error posted for an id nobody is waiting on any more -
  a job already inside `await tts.generate()` when a `cancel` arrived - marks the
  session too. That is the planned behaviour and it fails in the conservative
  direction (one extra reload on the next read, never a missed one), but a user
  who stops mid-synthesis at the exact moment the worker throws pays for a
  reload they did not cause. Not measured; identified by reading
  `kokoro.worker.ts`'s drain loop, whose generation check skips queued jobs but
  cannot unwind one already in flight.
- **A pre-existing worker-message exposure, not opened here.** `errText(err)` in
  the worker already flows a kokoro-js/onnxruntime message into `reportError`'s
  Notice and into the diagnostics log, so if kokoro-js ever embedded input text
  in a throw it would already be exposed. Nothing in this change widens that:
  the two new fields are booleans, the new `infoCb` line is a fixed string with
  no interpolation, and `KOKORO_RELOAD_REQUIRED` is a literal. A candidate
  follow-up rather than a change inside this ticket.
