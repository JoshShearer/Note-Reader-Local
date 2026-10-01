# 0034. Remembering a failed threaded load for the session

- Status: accepted
- Date: 2026-10-01
- Ticket: NRL-102 (no srs.md requirement ID, and no amendment)

  The evidence for "no amendment" was first written as "`grep -n thread srs.md`
  returns zero matches". That grep is case-sensitive and the claim is
  **misleading**, so it is corrected here rather than repeated: `grep -ni thread
  srs.md` returns **one** match, `kokoroThreads: number;` at `srs.md:509`. That
  line is inside the `Settings` shape listing and declares the key's existence
  and type; it states no contract about what the engine does with the value, and
  the key is still read, still honoured on a fresh load, and still honoured on a
  deliberate change. The two nearby behavioural sentences do not reach this
  either: "A change to a content setting SHALL apply on the next read"
  (`srs.md:521`) is scoped to content settings and `kokoroThreads` is not one,
  and the normalisation sentence at `:525` is about preserving unknown keys,
  which decision 2 below satisfies by persisting nothing at all. So there is
  genuinely nothing to amend - but by reading `:509`, not by a grep that never
  saw it.

## Scope, stated first

This is **bookkeeping, not threading**. It does not explain why the four-thread
WASM load fails on the reporter's desktop, it does not try to, and it does not
make a threaded load any more likely to succeed. NRL-102's own root-cause
question - whether the failure is Flatpak-specific, general to Electron, or
fixable with a COOP/COEP header Obsidian would have to set - is explicitly out
of scope and unanswered, as is the README hedge that depends on it. What this
decision changes is that the plugin stops paying for the same failure twice.

## Context

`load()` already gives up on threads rather than on loading: when a threaded
boot fails it emits `threaded load failed (...); retrying single-threaded`,
rewrites `this.options` with `threads: 1`, disposes and loads again. That
degradation is correct and is left alone.

What it did not do is remember. `this.options.threads` is the only record that
anything went wrong, and it is the same field `setOptions` overwrites. Both
`setOptions` call sites in `main.ts` rebuild the whole options object from the
saved settings - `setKokoroWeights` and `setKokoroRuntime` each go through
`kokoroOptions()`, which reads `settings.kokoroThreads` - so changing the
weights build, or changing the device in the dropdown, re-asserts the
configured count. That re-assertion wrote the configured count straight back
over the degraded one, registered as a change, forced a dispose, and the next
load re-attempted the count that had just failed.

Measured in bare Node against the real `KokoroEngine` and a fake worker that
refuses any `init` asking for more than one thread, before anything was
changed: the sequence of thread counts the worker was asked to boot with was
**`[4, 1, 4, 1]`** across two loads separated by one weights change, with
`options.threads` back at `4` the instant `setOptions` returned. The
device-dropdown shape produced the identical sequence. After the fix the same
probe gives **`[4, 1, 1]`**.

That is also why the fix lives in `kokoro.ts` and not in `main.ts`: making
`setKokoroWeights` omit `threads` would leave the device path re-asserting it,
so a `main.ts`-only fix would be incomplete.

## Decision

1. **A session-scoped boolean on the engine instance, `threadedLoadFailed`,**
   set on the same path in `load()`'s catch that already degrades
   `options.threads` to 1.

2. **Nothing is persisted. The memory is session-scoped only, and this is the
   decision a later reader is most likely to try to "improve".** Two
   independent reasons, either one sufficient:

   - **Plugin data is vault-synced.** The only durable store a plugin has is
     `data.json` inside the vault, which is exactly the thing users sync
     between machines. A durable "threads fail here" flag would therefore
     travel to a machine where threads work perfectly well and degrade it
     permanently, with no control anywhere to clear it. That is a worse defect
     than the one being fixed: the bug here costs one wasted load attempt, a
     synced flag costs a permanent four-fold throughput loss on an unrelated
     machine.
   - **Non-negotiable 10.** `normaliseSettings` (`src/settings/index.ts`) is
     spread-based and correct today, and it has to stay that way because plugin
     data also holds reading positions. Adding a key that is really a
     machine-local diagnostic invites the whitelist rebuild that erases them.

   If a durable form is ever genuinely wanted, it belongs in a machine-local
   store that does not exist in this plugin yet, and inventing one is a larger
   decision than this ticket.

3. **The deliberate-versus-incidental rule compares the incoming REQUESTED
   count against the last requested count, never against the degraded
   effective one.** A second field, `requestedThreads`, holds the last count
   anybody explicitly asked for. Only the constructor and `setOptions` write
   it; `load()`'s degradation never does, which is the whole point - after a
   failure the effective count is 1 and the requested count is still 4, so a
   re-assertion of 4 is recognisable as a re-assertion rather than as a
   request.

   - `setKokoroWeights` and the device dropdown re-assert the configured count.
     Requested is unchanged, so the change is incidental and the thread count
     is held at its degraded value.
   - The threads slider moved to a different count changes requested, so the
     change is deliberate: it is honoured **and it clears
     `threadedLoadFailed`**, so the new count is really attempted.

   The suppression happens **before** `setOptions` computes `changed`, so the
   phantom 1-to-4 "change" no longer forces a dispose, while a real weights or
   device change still disposes - and the reload it triggers now runs at the
   count that works.

4. **The same-count case is indistinguishable and is decided, not solved.**
   Re-asserting 4 when 4 is already the requested count carries no signal at
   all: `setKokoroRuntime` is called with identical arguments by the device
   dropdown and, in principle, by a slider that landed back on its starting
   value. It is treated as **incidental and suppressed**, as the
   least-surprising of the two readings: "I changed the device" is not "retry
   threads", and silently re-paying a known-doomed multi-second attempt because
   the user touched an unrelated dropdown is the worse surprise. Two escape
   hatches exist and both are reachable without any new UI: Obsidian's slider
   fires `onChange` per value, so 4 to 3 and 3 back to 4 are each deliberate
   changes that clear the memory, and a plugin reload clears it
   unconditionally.

5. **`dispose()` must NOT clear the flag, and that is the opposite lifetime
   from ADR 0031's two flags.** This is why this is a separate ADR rather than
   an amendment to 0031: folding two opposite dispose-lifetimes into one
   document is precisely how a later reader resets the wrong flag. ADR 0031's
   `sessionFailed` and `recycleSpent` describe a suspect *session*, so a
   dispose genuinely ends them - the next load is cold and there is nothing
   left to recycle. `threadedLoadFailed` describes the *host*, and a cold load
   is exactly when the doomed attempt would be re-paid. Worse, `setOptions`
   disposes, and a settings change is the very path the defect arrived on, so
   resetting it in `dispose()` would undo this decision completely. The comment
   block in `dispose()` says so in place, because that is the line a tidy-up
   would otherwise "finish".

6. **One new `infoCb` line, counts only.** Emitted from `load()` after the
   `if (this.ready)` early return whenever the memory is set and more than one
   thread was requested:

   > `skipping the N-thread attempt: it failed earlier in this Obsidian
   > session. Reload Obsidian to try again.`

   A thread count and a remedy, no note text, no chunk text and no worker
   message (non-negotiable 1). It is emitted on every load that skips, not only
   the first, because a user who configured four threads and is quietly given
   one deserves to know why each time, that the memory lasts only this session,
   and how to clear it. The existing first-failure line is unchanged, and
   `runtimeInfo()` already reports `CPU (WASM, 1 thread)`.

7. **`kokoro.worker.ts` is not touched at all.** The worker builds its own
   backend plan from `msg.threads`, so sending `threads: 1` makes its
   `backend plan:` line read `wasm/1t` with no `4t` entry and the skip is
   already visible in the diagnostics with zero worker edits. This keeps the
   base64-inlined worker payload byte-identical and keeps
   `npm run test:inline-worker` out of play, and it leaves the
   `isRemote`/`assertLocal` guards untouched (non-negotiable 5).

## Consequences

- **One wasted threaded attempt per Obsidian launch or plugin reload remains,
  BY DESIGN.** `createEngines()` builds a fresh `KokoroEngine` on every plugin
  load, so the memory dies with the instance. That is the accepted price of
  decision 2: the alternative is persistence, and persistence is vault-synced.
  It is not a gap to be closed later without first solving the sync problem.

- **Two layers now give up on threads and they are not unified.** The worker
  keeps its own `SharedArrayBuffer` probe and its own per-attempt fallback, and
  the engine now has this memory on top. Unifying them means changing the
  worker, which this scope forbids, and the worker's probe is the backstop for
  a host where `SharedArrayBuffer` is simply absent - Android - which the
  engine-level memory cannot see. Accepted rather than overlooked.

- **Nothing is downloaded by any of this** (non-negotiable 6). The memory
  changes which `init` message is sent to an already-blob-loaded worker; the
  suite's fake `fetch` throws and is asserted never to have been called.

- **Rate is untouched** (non-negotiable 9). This is the load path; `synthesize`
  and `ownsPlayback` are not in the diff.

## Residual risk and what the evidence does not cover

- **The real threaded failure is not reproduced anywhere.** The suite's
  "failure" is a fake worker rejecting a boot. What is established is the
  memory and the option bookkeeping, never that the real ORT thread pool fails
  the way NRL-102 reports, and never that skipping it is the right call on a
  host where it would have succeeded on the second try. Nothing observed
  suggests a threaded load that fails once then works, but nothing rules it out
  either.

- **`main.ts` and `settingsTab.ts` have no bare-Node runtime**, so
  `kokoroOptions()`, both `setOptions` call sites, the device dropdown and the
  threads slider have no automated coverage of any kind. The option shapes the
  tests use are transcriptions of what those produce, checked by reading them.

- **Nothing was observed in a real Obsidian** for this change. The running
  desktop renderer holds the `main.js` that was present when it started, the
  deploy slot belongs to another lane, and restarting Obsidian was forbidden
  for this ticket, so the fixed code cannot be the code running. The pre-fix
  defect is reproducible on the real host over CDP; the fix itself is
  bare-Node evidence only, which is the same class as the suite. Rule 11
  applies in full.

- **The same-count decision in clause 4 is a judgement, not a measurement.**
  Nobody has been asked whether re-asserting 4 after a failure feels like
  "retry" to them.
