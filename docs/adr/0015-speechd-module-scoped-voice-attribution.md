# 0015 - speech-dispatcher voice attribution via a verified `-o <module> -L` scoping

Status: accepted (NRL-55)

Requirement: R-S01 (`srs.md:636-663`), narrowed rather than closed.

## Context

`VoiceInfo.local` and `VoiceInfo.requiresNetwork` are `boolean | "unknown"`, and
R-S01 says a backend MUST NOT claim a voice is offline when it cannot determine
this. NRL-26 therefore made the speech-dispatcher engine report `"unknown"` for
every voice: `spd-say -L`'s columns are NAME, LANGUAGE and VARIANT only, with no
column linking a voice back to the output module that would speak it, and
`spd-say -O` lists modules with no link back to individual NAME rows.

There is an undocumented behaviour that could bridge that gap. Measured on this
machine at spd-say 0.12.0-rc2:

```
spd-say -O                     # "OUTPUT MODULES" header, then: espeak-ng, openjtalk
spd-say -L                     # 13363 lines
spd-say -o espeak-ng -L        # 13363 lines, 0.387 s
spd-say -o openjtalk -L        # 2 lines (header + "Default / ja / none"), 0.005 s
spd-say -o no-such-module -L   # exit 0, 13363 lines
```

So `-o` appears to scope the listing to the named module. `spd-say --help`
documents `-o, --output-module` and `-O, --list-output-modules` and says nothing
about their interaction, and this was observed on exactly one build on one
machine.

## Decision

Use the scoping, but do not trust the flag. Prove it at runtime, per engine
instance, with a differential self-check, and fail closed to `"unknown"`
whenever the proof does not land:

1. `spd-say -O`. A non-zero exit, or output with no `OUTPUT MODULES` header,
   gives up.
2. Fewer than two modules gives up. A differential needs two listings to
   compare, so a single-module desktop can never attribute anything.
3. `spd-say -o <module> -L` per module. Any non-zero exit, any throw, or any
   listing that parses to zero rows gives up. Zero rows matter specifically:
   an empty canonical listing trivially differs from a real one and would
   falsely prove that scoping works.
4. **The gate.** Canonicalise each module's listing as its sorted
   `name\tlang\tvariant` rows joined, and require that they are *not all
   identical*. If they are, `-o` is being ignored on this build.
5. Attribute a NAME `local: true`, `requiresNetwork: false` only if the set of
   modules serving it is non-empty and *every* module in it is on a closed
   allowlist of pure local synthesisers: `espeak-ng` and `openjtalk`. A name
   served by both an allowlisted and a non-allowlisted module is ambiguous and
   stays `"unknown"`.
6. Any probe run whose child was **terminated by a signal** gives up, whatever
   its exit code says. `RunResult.signal` carries the second argument of node's
   `close` event for exactly this.
7. `spd-say -O` again as the last step, under the same controller and the same
   three checks as step 6, and the **parsed, order-independent** module set must
   equal the one step 1 read. Anything else gives up. Added by NRL-71; see
   Residual risk for what it does and does not cover.

Everything else stays `"unknown"`. The engine can never emit `local: false`.

The probe up to and including the last per-module listing runs under one 5 s
deadline (NRL-84 gave the closing `-O` its own 500 ms one; see Residual risk),
and every deadline here is checked on the
`AbortSignal` after every run rather than through the exit code. That is not
defensive tidiness. Aborting a run SIGKILLs the child, a SIGKILLed child closes
with a null exit code, and `NodeProcessRunner.run` resolves `code ?? 0`, so a
listing cut short by the deadline arrives indistinguishable from a successful
short listing (measured this session). A truncated listing is worse than a
missing one twice over: losing a row from a non-allowlisted module's listing
removes the ambiguity that was keeping a shared NAME `"unknown"`, and it makes
two otherwise identical listings differ, which is exactly what step 4 reads as
proof that `-o` works. Case H in `tests/engine.test.ts` pins both.

Step 6 exists because that abort check alone was not enough, and the reason it
looked sufficient is worth naming: an abort flag only ever sees a kill *we*
issued. Any other termination - an OOM killer, a session teardown, a stray
`pkill` - truncates the listing in exactly the same way with
`controller.signal.aborted` still `false`. Measured this session against the real
`NodeProcessRunner.run`, with an external `SIGTERM` sent to a child printing
three lines: `code 0`, `aborted false`, and stdout holding the first two lines
only. Node's `close` event does pass the terminating signal as its second
argument; the handler was discarding it. So `RunResult` now carries
`signal: NodeJS.Signals | null` as a **required** field - an optional one a
construction site forgets reads as "not signal-terminated", which is the unsafe
default - while `code ?? 0` is deliberately left alone, because `synthesize()`
SIGKILLs its own `spd-say` on Stop (NRL-41) and must go on reading that as a
success. The new field is therefore read in the attribution probe and nowhere
else.

Fed the same truncated listings the real runner produces, the pre-step-6
extractor reported `English (America)` as `local: true` / `requiresNetwork:
false` where `"unknown"` is required, from a truncated `-o festival -L` that
dropped the shared row and equally from a truncated `-O` that dropped festival
itself; the untruncated fixtures gave `"unknown"` correctly. Cases I-L in
`tests/engine.test.ts` cover that family, including a control arm (K) proving
attribution still happens when nothing is killed, and that a signal can only ever
cost information, never produce `local: false`.

**Corrected by NRL-87.** An earlier revision of this paragraph said cases I-L
"pin all of it". They do not, and the claim was the kind a later change would
lean on when deciding a clause is safe to simplify. Measured by mutation on this
branch - delete one clause of `probeAttribution()`, run the full suite, restore
the file - the coverage is per clause, not per case:

| Clause | Pinned by |
| -- | -- |
| opening `-O`: `controller.signal.aborted` | case J2 (NRL-94), by call trace: the loop's own abort clause catches the deletion one step later, so the verdict cannot move |
| opening `-O`: `modulesRun.signal !== null` | case J, which needs an explicit clean `modulesAgain` to do it |
| opening `-O`: `modulesRun.code !== 0` | case J3 (NRL-94), which needs a valid two-module stdout and an explicit clean `modulesAgain` to do it |
| per-module loop: `controller.signal.aborted` | cases H and H2, by verdict AND call trace (NRL-84; was H2 by call trace only) |
| per-module loop: `signal !== null` | cases I and L |
| per-module loop: `code !== 0` | case D4 (NRL-94), whose failing listing must have parseable rows or the `rows.length === 0` guard catches it instead |
| closing `-O`: `closingScope.signal.aborted` | case M5, re-fixtured onto the closing budget (NRL-84) |
| closing `-O`: `againRun.signal !== null` | case M3 |
| closing `-O`: runs under `closingScope.signal`, not the outer one | case M7 (NRL-84) |
| closing `-O`: the outer abort clause is ABSENT | case M7 (NRL-84) |
| closing `-O`: `againRun.code !== 0` | case M4 |
| closing `-O`: the module set is compared as a SET, not by count | case M8 (NRL-94); case M2 is its other half, pinning that a REORDERED set still attributes |

Two of those pins did not exist before NRL-87 and one was silently lost.
NRL-71's `modulesAgain` field defaults to `modules` when unset, which buys five
free control arms but also replays a case's injected failure onto the closing
`-O`; case J's SIGTERM was therefore being caught at the closing call before the
opening guard it exists to pin was reached, so deleting that opening clause -
or the whole opening guard - left the suite green. J now sets an explicit clean
`modulesAgain` and the default is kept for the arms that benefit from it. The
loop's abort clause was pinned by H2 rather than by case H because H's delayed
module is the last of two: deleting the clause there changed neither the verdict
nor the call trace. H2 puts three modules in the loop with the deadline on the
middle one and asserts the trace stops at it.

**Corrected by NRL-84.** The sentence that used to follow - that H2's verdict is
deliberately not the discriminator, "because with the clause deleted the closing
`-O`'s own abort check still gives up and every voice is still `"unknown"`" - was
true only while the closing `-O` shared the outer controller. It no longer does.
Re-measured on this branch with the same mutation (delete the loop's
`controller.signal.aborted ||`, full engine suite, restore, re-assert the
sha256): the probe now runs the whole loop, the closing `-O` answers cleanly
under its own 500 ms budget and the probe ATTRIBUTES, so **four** checks go red
where one did - both of H2's, and both of case H's, H having become a
discriminator for this clause without being edited. The call trace is kept as a
check in its own right because it is the only observable that says *where* the
loop stopped, but it is no longer the only one that moves.

**Closed by NRL-94.** The three rows above used to read "**nothing** (survives
deletion)", and a fourth clause - the module-set re-read compared as a set rather
than by count - had no row at all. All four are now pinned: the opening `-O`'s
`controller.signal.aborted` by **case J2**, its `modulesRun.code !== 0` by **case
J3**, the per-module loop's `code !== 0` by **case D4**, and the set-not-count
comparison by **case M8**. Each was reproduced as a survivor first - the mutation
applied to `src/engines/system/speechd.ts`, the full 24-suite `npm test`
observed exiting 0 with the engine suite green at 207 checks - and then measured
red with the new case present, with the failing check named in each direction.
The evidence is bare-Node mutation testing only; NRL-94 changed nothing under
`src/`, so `probeAttribution()` is byte-identical and no requirement moved.
Do not read this table as saying the clauses are dispensable - `probeAttribution()`
is unchanged and every clause is load-bearing per the comments on it.

Two details on the gate in step 4. It is not a count comparison, because two
modules can coincidentally serve the same number of voices. It is not "all
listings pairwise distinct" either: with three modules, two allowlisted ones may
genuinely serve the same voice set while a third differs, and that third still
proves scoping is real. "Not all identical" is exactly the weakest rule that
catches a build ignoring `-o`.

The probe result is memoised as a Promise for the life of the engine instance,
failures included. `listVoices()` runs on every settings-tab render, on
`setVoice` and from `voicesForSelection`, and the probe costs a full listing per
module. Caching a failure degrades to a less informative answer, never to a
wrong one. Measured on this machine: `listVoices()` went from 369 ms to 743 ms
on the first call and back to 350 ms on the second.

The probe is called from `listVoices()` only, never from `isAvailable()`, which
runs at startup and whose fake runners throw on unexpected calls.

## Why a bogus-module sentinel is not the gate

The obvious cheap check is to ask for a module that cannot exist and see whether
the listing changes. It does not work here. `spd-say -o no-such-module -L` exits
0 and returns the **default** module's full list, measured twice this session as
13363 lines. On this machine the default module is `espeak-ng`, so the sentinel's
listing is byte-identical to `espeak-ng`'s. A sentinel gate would therefore
always conclude "scoping is ignored" and suppress attribution for the one module
that actually matters. It is not run at runtime at all: it would cost a second
13363-row listing to learn nothing, and the engine deliberately imports no
logger (`trace()` needs `App` and `manifestDir`, which this engine is never
given), so there is nowhere for an advisory result to go.

## Residual risk

The differential proves that `-o` **changes** the listing. It does not prove
that it changes it **by serving module**. A Speech Dispatcher build that scoped
`-L` by something else - by language, say - would pass the gate and mis-attribute
voices. No probe reachable through `spd-say` can rule that out: there is no
second, independent source of truth for which module serves a NAME.

If that happened, a voice really served by a network module could be reported
`local: true`, which is precisely what R-S01 forbids. The mitigations are
partial, not sound: the allowlist means a mis-attribution only matters when a
non-allowlisted module's voice is mistaken for an allowlisted one's, and the
never-emit-`false` rule keeps the failure to over-claiming locality rather than
also inventing network dependence. This is stated rather than argued away: the
design is a calculated narrowing of an honest `"unknown"`, not a proof.

Two further shapes were characterised during verification. They are named here
with their measurements so that neither is read as covered by the general
statement above.

**A short read that exits `code 0` with no signal at all.** Step 6 closes
truncation by signal. It cannot see a listing that ends early while the child
exits cleanly, and neither can any other check in the probe: a short listing and
a short module is the same observation. Two of the three routes to it were
measured shut this session. Through the runner itself, 40 runs of a
200,000-line producer through `NodeProcessRunner.run` produced 0 short reads, so
the runner does not lose the tail of a large stdout on its own. Through EPIPE, a
real `spd-say -L | head -3` exits 141 and a directly spawned producer dies by
SIGPIPE, so both are caught, one by the exit code and one by step 6. The route
that remains is `spd-say` itself printing a partial listing and exiting 0, on an
internal error it does not surface as a non-zero status. No observable available
to the probe can detect that, so it is accepted rather than mitigated. The
allowlist and the never-emit-`false` rule still bound its consequence to an
over-claim of locality.

**The probe is not atomic.** It is `-O` followed by N separate
`spd-say -o <module> -L` runs, and the daemon's configured module set can change
between them. Module **removal** fails closed, and that was measured: a module
that disappears after `-O` makes `spd-say -o <gone> -L` fall back to the default
module's full listing, and that fallback makes every name the gone module shared
with another one ambiguous, so those names stay `"unknown"`. Module **addition**
is the direction that can produce a wrong `local: true`: a non-allowlisted
module configured in after `-O` has been read serves names the probe never
observes it serving, and those names can then be attributed to an allowlisted
module alone. It requires the daemon to be reconfigured inside the probe's own
window, measured at 778 ms on this machine, and no `spd-say` call reads the
module list and the per-module listings as one atomic operation, so the sequence
cannot be made a single observation. The 778 ms is NRL-55's measurement of
NRL-55's probe, taken before the step below existed.

The cheap partial mitigation this section originally declined **was taken, in
NRL-71**: step 7 above. `-O` runs again as the probe's last step, under its own
`AbortController` and its own 500 ms deadline since NRL-84 (see below), and
subject to the same three checks as every other run here (our own abort flag, `RunResult.signal`
for a kill we did not issue, and a non-zero exit). The comparison is on the
**parsed, order-independent** module set, never on the stdout bytes: the daemon is
not promised to list its modules in a stable order, and a reordered listing would
otherwise cost every voice its attribution for nothing. Case M2 in
`tests/engine.test.ts` pins that; M1 pins the divergence give-up, M3 and M4 pin
the signal and exit-code checks on the new run specifically, and **M5 (NRL-87, re-fixtured
by NRL-84)** pins the abort check on it - the one shape where the closing reply
is itself perfectly good (code 0, no signal, the same module set) and only the
deadline having expired distinguishes it - and **M7 (NRL-84)** pins the opposite
half, that the OUTER deadline expiring during such a reply must not discard it. M5 also asserts `oCount() === 2`, because the
case only means anything if the deadline fired during the closing run rather than
earlier; without that assertion it could degrade into being caught by the loop's
abort clause with an identical verdict, leaving the closing clause unpinned again.
Before M5 existed, deleting that clause left the whole suite green.

It **narrows the window rather than closing it**, and the uncovered shapes are
named rather than argued away. A module added and removed entirely between the
two `-O` calls is invisible to the comparison. The N per-module listings are
still read at N different instants, so a module added before one listing and
removed before the closing `-O` is invisible too. No `spd-say` call reads the
module list and the per-module listings as one observation, so closing the window
needs a different interface to the daemon - a direct SSIP client, which NRL-43
built and measured for an unrelated purpose - rather than a better sequence of
`spd-say` calls. That is deliberately out of scope.

**The closing `-O` has its own deadline (NRL-84).** NRL-71 put it under the same
`AbortController` and therefore the same 5 s budget as everything before it,
which was the right default - it keeps the total from drifting - but it made the
closing run the last thing in line for a budget the probe does not bound. The
probe runs one `spd-say -o <module> -L` per configured module and nothing caps
the module count, so N slow modules can spend the deadline and leave the closing
`-O` nothing. It then aborts holding a perfectly good reply, the probe returns
null, and - the give-up being memoised with no retry - **every** voice reports
`"unknown"` for the life of the plugin instance. Latent rather than observed:
measured this session on this machine (spd-say 0.12.0-rc2, two output modules,
read-only calls, the daemon untouched), `spd-say -O` ran a median of 4.4 ms over
n=15, min 3.0, max 7.2, against `spd-say -o espeak-ng -L` at a median 357.1 ms
and `-o openjtalk -L` at 6.2 ms, so the closing call is well under a percent of
the budget on a two-module desktop.

It now runs under a second `AbortController` with `CLOSING_PROBE_TIMEOUT_MS`,
500 ms, which is ~69x that measured max and 10% of the outer deadline. Three
consequences, all deliberate. The outer abort is **not** forwarded into that
scope: the starvation case *is* the outer timer firing mid-closing-run, and an
outer deadline that expires *before* the closing run is already caught by the
per-module loop's own abort check, so propagating it would have made the change
a no-op. The guard on the closing run therefore carries **exactly one** abort
clause, reading the signal that run was actually handed; keeping the outer
clause alongside it would both restore the old behaviour and make the pair
untestable, since a fixture expiring the outer deadline sets both flags and each
clause alone would survive deletion while the guard only looked pinned. And the
probe's worst case becomes `probeTimeoutMs + closingTimeoutMs`, 5500 ms rather
than 5000 ms - still bounded, still deterministic, and the outer budget still
bounds the one part that grows with the module count. `PROBE_TIMEOUT_MS`'s doc
comment was rewritten rather than left saying "the whole probe". Cases M5 and M7
in `tests/engine.test.ts` hold the two halves apart: M5 was re-fixtured onto the
closing budget and still pins the abort clause (mutation-checked both ways - with
the fix in place and M5 left on the OLD outer-budget fixture it fails against the
*unmutated* file, because it was pinning exactly the behaviour NRL-84 removes),
and M7 pins that an outer deadline expiring during a clean closing `-O` does
**not** discard it. Nothing was observed in Obsidian.

The give-up is memoised exactly like every other probe failure, and no retry was
added. So a daemon reconfigured inside the probe's window leaves **every** voice
`"unknown"` until the plugin reloads. That is the intended direction: `"unknown"`
is the honest answer and re-probing would re-pay a full per-module listing on
every settings-tab render.

Measured cost, NRL-71's own numbers on this machine (spd-say 0.12.0-rc2, two
output modules, bare-Node, 10 fresh engine instances on the probe-miss path and
10 memoised calls per side, three base/change pairs run back to back): miss-path
median 769.8, 762.0 and 782.2 ms without the closing `-O` against 768.4, 763.4
and 787.2 ms with it, so the three median differences are -1.4, +1.4 and +5.0 ms.
The extra round trip is not separable from run-to-run noise at this sample size,
which is consistent with `-O` being the cheap call in the probe. Memo-path
medians were 379.3, 363.3 and 378.7 ms without against 369.1, 367.7 and 382.1 ms
with, as expected since the memoised path runs no probe at all. Two further pairs
were run on the same protocol before the change was committed, one of them with
the change side first to control for warming: +18.1 ms and +3.7 ms of median
difference. Do not read -1.4 to +5.0 as a bound; five pairs span -1.4 to
+18.1 ms and the per-pair series overlap each other throughout, which is the
actual reason the round trip is not separable here rather than the deltas being
small. Attribution itself did not move on any pair: 13,231 rows, all
`local: true`, 0 `"unknown"`, 0 `false`, identical on both sides and agreed by
all 10 fresh instances on each side. **Nothing was observed in Obsidian**; CDP
port 9222 was not exercised for this change.

R-S01 is **still not claimed**. "Why `srs.md` is unchanged" below stands
unaltered: this only narrows an already-honest `"unknown"` further, it can still
never emit `local: false`, and `srs.md` is not edited by NRL-71.

## Consequences

- On this machine, live against the running daemon after the change: all 13231
  voices `listVoices()` returns report `local: true` / `requiresNetwork: false`,
  none report `false`, none report `"unknown"`. Before the change all 13231 were
  `"unknown"`.
- openjtalk's `Default` voice does not appear in `listVoices()` at all, because
  `listVoices()` enumerates from the bare `spd-say -L`, which is the *default*
  module's list. The probe still attributes it; nothing currently asks.
- `CAPABILITIES.offlineStatus` stays `false`. It is a compile-time constant read
  before any probe runs, so flipping it would promise per-voice determinability
  on builds where the self-check fails and every voice correctly stays
  `"unknown"`. Attribution is reported per voice instead.
- No note text touches the probe. Its argv is the fixed strings `-O`, `-o`, `-L`
  plus module names that came from the daemon's own `-O` output, so nothing from
  the vault reaches a command line. The stdin-only rule for speech text is
  untouched: `synthesize()` is unchanged. Voice names are daemon-supplied
  catalogue data, so the new in-memory attribution map holds nothing
  user-derived. No logging was added.
- The `-L` stdouts are parsed and discarded; none of them reaches an error
  message, preserving the existing rule that spd-say stdout never enters a
  thrown string.

## Why `srs.md` is unchanged

R-S01's MUST is "MUST NOT claim a voice is offline when the backend cannot
determine this". This change only ever moves a voice from `"unknown"` to a
determination backed by a runtime self-check, and can never emit `local: false`,
so the MUST is narrowed towards, not weakened. `"unknown"` was already the
honest answer and remains the answer for every unattributable voice, on every
build where the self-check fails, and on every machine with fewer than two
output modules. R-S01 is therefore narrowed rather than closed and its text
stands.

R-S04 is deliberately not claimed, and the reason recorded during triage turned
out to be stale, so it is corrected here rather than repeated. The premise was
that `offlinePreferred` is a reserved key with no toggle by design. It is not:
`src/ui/settingsTab.ts:359-371` renders "Prefer voices that do not require
network access" and `src/main.ts:1038` feeds it to `pickLocaleVoice`, both since
NRL-26 (`8a54319`). The comment at `src/settings/index.ts:39` still calls the key
reserved and unread, which is drift left by that ticket and is not touched here.

R-S04 is not claimed because this change does not move it. `pickLocaleVoice`
penalises only `local === false` (`src/audio/voiceChoice.ts:70`), so a voice
going from `"unknown"` to `true` does not change automatic selection at all.
The one user-visible effect is the voice dropdown's suffix
(`voiceNetworkMarker`, `src/ui/settingsTab.ts:788`): a speechd voice that read
" - network status unknown" now reads with no suffix.
