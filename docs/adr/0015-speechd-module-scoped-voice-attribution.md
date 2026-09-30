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

Everything else stays `"unknown"`. The engine can never emit `local: false`.

The whole probe runs under one 5 s deadline, and the deadline is checked on the
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
`tests/engine.test.ts` pin all of it, including a control arm proving attribution
still happens when nothing is killed, and that a signal can only ever cost
information, never produce `local: false`.

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
