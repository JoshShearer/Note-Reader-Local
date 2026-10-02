# Local TTS Reader - agent instructions

An Obsidian community plugin that reads notes aloud entirely on-device. Four speech
engines behind one interface, with word-level highlighting driven by source offsets.

This file is the canonical instruction set. `CLAUDE.md` is a symlink to it, so Claude
Code and opencode read the same rules.

- **Spec / contract:** `srs.md` (MoSCoW requirement IDs `R-M01`…`R-C05`). It is the
  acceptance criteria, not a wishlist. Deviating from it is allowed; doing so silently
  is not - record an ADR in `docs/adr/` and amend `srs.md`.
- **Architecture map:** `CONTEXT.md`.
- **Linear conventions:** `.claude/linear.md`.

---

## Quality gates

`.github/workflows/ci.yml` runs `npm ci`, then `npm run typecheck`, then `npm run build`,
then `npm test` on every push and every pull request, and
`.github/workflows/release.yml` gates tagged commits as well. There is still no lint
script and no git hook, so nothing runs the gates at the moment you commit: CI is a
backstop, not a substitute. Run them locally first.

```bash
npm test          # 24 suites: extract, engine, player, paths, kokoro, settings, positionThrottle, highlightColour, highlight, affordances, engineSelection, webspeechVoices, fallback, espeak, types, release, voiceChoice, platform, readSelection, modelStore, adrNumbers, vaultPersistence, loadingNotice, suiteRegistry
npm run typecheck # tsc --noEmit --skipLibCheck
npm run build     # typecheck + esbuild production (main.js only; the worker and ONNX runtime are inlined into it)
```

Both must pass before any commit. `npm run build` before anything that touches the
bundle, the worker, or the esbuild config.

That `npm test` line's count and its name list are asserted against `package.json`'s
`pretest` by `tests/suiteRegistry.test.ts`, so a new suite is added by editing the script
and the prose follows, rather than the two drifting apart on a clean merge (NRL-85).
Do not add a second gate line of that shape anywhere in this file: that test fails by
name when it finds zero anchors or more than one.

`npm test` is `node run-tests.mjs` (NRL-80). It used to be a 24-deep `&&` chain, whose
short-circuit meant the first failing suite hid every later one - measured, with a
`process.exit(1)` appended to the built extract suite (1 of 24) and a `throw` appended to
the built loadingNotice suite (23 of 24), the chain exited 1 after ONE suite with zero
mentions of the late crash. The runner runs all 24 serially, streams each one's output
verbatim behind a `>>> <name>` banner, and ends with a per-suite `ok` / `FAIL` / `CRASH`
table, the aggregate check counts, and the failing suite names LAST. The same injection
against the runner names both. Three things about it are load-bearing. **The suite list
is not written in it** - `pretest` stays the one registry and `suitePathsFromPretest`
derives the built paths from it, which is why adding a suite still means editing exactly
one script. **Its main guard is `path.basename(process.argv[1]) === "run-tests.mjs"`, not
the usual `import.meta.url` idiom**, which fires inside the esbuild bundle of the test
that imports the runner and would re-enter the whole run from inside a suite. And
**classification is by exit code only** - `tests/readSelection.test.ts` prints no
`all ... passed` line at all, so a summary-line rule would invent a failure; a non-zero
exit with no `FAIL` line of its own is a CRASH and the summary carries its last lines.
`run-tests.d.mts` exists so `tsc` can type that import without a `tsconfig.json` change.
One thing this does not catch, unchanged from the chain: a `test` script that never
invokes the runner at all cannot be detected from inside a suite the runner is what runs.

Two more things about it, both of which a tidy-up would plausibly undo.

**`run-tests.mjs` must never call `process.exit`.** All three failure exits are
`process.exitCode = 1` plus a `return`, and that is not a style preference.
`process.exit` tears the process down without flushing writes still queued in userspace,
and stdout to a **pipe** is asynchronous - which is every CI log viewer, every `| tee`,
every `| head`. Measured on the real 24-suite run with one failure injected: a file
redirect delivered 5,097 lines while `node run-tests.mjs 2>&1 | { sleep 25; cat; }`
delivered **915 and lost the `FAILING SUITES:` line** - the one line the runner exists to
put at the end of a failing log. `tests/suiteRegistry.test.ts` section 13 pins both
directions, with the no-failure path as a positive control so a harness that simply
cannot carry a large payload cannot make the failure checks pass for the wrong reason.

**The registry-to-execution link is two layers, and both are load-bearing.** Layer 1 is
`suiteRegistry` importing `suitePathsFromPretest` and asserting order, set and count,
which catches a suite dropped in *derivation*. Layer 2 is the runner's own
planned-vs-produced reconciliation, which catches one dropped in the *execution loop* -
and layer 1 is **blind** to that, because it runs inside that loop. Measured: a layer-2
mutation leaves `suiteRegistry` green while the runner still exits 1. Neither is
redundant with the other.

Windows portability of the runner is **reasoned, not measured**. Nothing here has been
run on Windows, and section 13's own harness shells out to `/bin/sh`.

```bash
npm run deploy         # build, copy the three shipped files into ~/Documents/Notes/.obsidian/plugins/, and PRUNE: it then deletes every other top-level entry there except data.json and dotfiles (NRL-122)
npm run test:obsidian  # CDP smoke test; needs Obsidian on --remote-debugging-port=9222
npm run test:inline-worker # 1 suite (nrl-15-inline-worker.test.ts): verifies the shipped main.js (no ort/ directory) after a production build; run separately, not part of npm test's bare-Node chain
```

### Driving a real Obsidian over CDP: four traps, all of which cost time

A clean-install harness for this plugin is worked out and lives in
`/tmp/opencode/nrl96-*.mjs`. Four things about it are not obvious, and each one
first presented as a plugin defect:

- **A brand-new vault shows a vault-trust prompt, and community plugins do not
  load until it is answered.** Obsidian blocks all community plugins and
  `app.plugins.enablePluginAndSave(id)` becomes a **silent no-op** - it resolves,
  throws nothing, and `app.plugins.enabledPlugins` stays `{}`. The prompt is a
  `.modal-container` reading *"Do you trust the author of this vault?"*. Click
  **"Trust author and enable plugins"**. This is what made the plugin look like
  it "never loads" across several earlier tickets: the manifest was found,
  `loadPlugin()` returned `{loaded:false, errs:[]}`, and no console error ever
  appeared, because nothing had actually been enabled. A synthetic test vault
  you created yourself is safe to trust.
- **`community-plugins.json` is read at startup only.** Writing it while
  Obsidian is running has no effect on that process. Enable the plugin, or stop
  and restart, before concluding anything.
- **A stale process can hold port 9222 after a kill**, and then every probe
  describes a dead window. Check the owner: `ss -ltnp | grep 9222` and compare
  the pid's start time against your launch. Clear the profile's
  `SingletonLock`/`SingletonCookie`/`SingletonSocket` between runs, and check
  there is no leftover `about:blank` Settings target.
- **`connect` must pick the right page target.** Obsidian opens extra page
  targets, including a Settings window at `about:blank` that can be *first* in
  `/json/list`. Connecting to it gives `app is not defined` and looks like a
  crash. Prefer `url.includes('index.html')` for plugin work, and target the
  `about:blank` page explicitly to click settings UI. Obsidian's classes
  (`MarkdownView` and friends) are not globals in the main world; use
  `app.workspace.activeLeaf.view.editor.cm` for CodeMirror and
  `getActiveFile()` for the file.

Two more measurement notes worth not re-learning. The player creates its audio
with `new Audio()` and **never attaches it to the document**, so
`document.querySelector('audio')` finds nothing; read
`plugin.player.audio` instead and watch `currentTime`, `duration` and
`readyState`. And `read-note` is asynchronous and slow to first audio on CPU
(about 17 s here, mostly model load), so poll for `playing` rather than
assuming a fixed delay, and reset with `stop-reading` first - a finished read
leaves the player terminal and a naive check reads that as instant success.

`tests/engine.test.ts` shells out to the real `spd-say` binary and needs a running
speech-dispatcher daemon (here with the `speech-dispatcher-espeak-ng` output module). It
is a Linux desktop test and will fail elsewhere. `tests/espeak.test.ts` covers `espeak.ts`
with a fake `ProcessRunner` only: the `espeak-ng` binary itself is not installed on this
machine, so there is still no real-binary coverage for that engine, only for
speech-dispatcher. Re-measured 2026-10-01 on this Pop!_OS 24.04 host: `which espeak-ng`
prints nothing, `/usr/bin/espeak*` does not exist, and `dpkg -l` lists only
`espeak-ng-data` and `libespeak-ng1` (1.51) plus `speech-dispatcher-espeak-ng`, the data,
the shared library and the speechd output module, none of which gives `espeak.ts` a command
to spawn. (Commit `7c75866`'s "1.52.0, pacman" install does not exist here; `which pacman`
prints nothing either. Corrected by NRL-138.) The two regions of `tests/engine.test.ts` that
need the daemon - the preamble checks and the real-binary block that speaks aloud and
asserts wall-clock duration - are bypassed when `NRL_SKIP_REAL_SPEECHD` is exactly `"1"`,
which is what both workflows set. A skip prints one `SKIP <name>` line per bypassed check
and is counted separately from `ok`, so a partial run can never read as a full one. With
the variable unset, a missing binary or a dead daemon still fails the suite.

---

## Non-negotiables

Each of these is a promise the product makes. Breaking one is a BLOCK, not a concern.

### Privacy

1. **No note text in any log, ever.** `trace()` takes counts, ids and durations. The
   closest any call site gets is `${source.length} chars`. Never interpolate chunk text,
   selection text, or spoken text - not even into an error message.
2. **Speech text reaches subprocesses on stdin, never argv.** A command line shows up in
   `ps` and in spawn error messages. `espeak.ts` and `speechd.ts` both pipe; keep it that
   way.
3. **No telemetry.** No analytics, no beacon, no crash reporting, no "anonymous usage".

### Network

4. **No cloud TTS, ever, and no automatic fallback to one.** No API keys, no accounts.
5. **The Kokoro worker refuses remote fetches at runtime** (`kokoro.worker.ts`
   `isRemote` + `assertLocal`). Those guards exist because transformers.js and kokoro-js
   both default to CDN URLs. Do not remove them; if a load path breaks, fix the path, not
   the guard.
6. **Every byte downloaded is user-initiated.** Model weights and voices download on an
   explicit click. Nothing fetches on load, on prewarm, or on first read.

### Mobile safety

7. **`manifest.json` declares `isDesktopOnly: false`.** No node builtin may be imported
   in a way that evaluates on mobile. `child_process` is type-only plus one call-time
   `require("child_process")` reached from two method bodies (`src/engines/system/spawn.ts`),
   and the engines that reach it are constructed only when `shouldConstructLinuxDesktopEngines`
   (`src/engines/platform.ts`) passes, which is Linux desktop specifically and narrower
   than not-mobile: a macOS or Windows desktop is not mobile and still gets neither.
   `Platform.isMobile` does appear in `registry.ts`, in `resolveWeights` and
   `probeEngines`, but it is not what gates that construction. Keep it that way, and
   check `main.js`'s `require()` list after any dependency change - it should contain
   only `obsidian`, `@codemirror/view`, `@codemirror/state` and `child_process`, the last
   allowed only in that call-time shape (`docs/adr/0033`). **Never `import()` a builtin**:
   esbuild leaves it as a native dynamic import, Obsidian's renderer cannot resolve a bare
   builtin specifier, and that is how both Linux engines reported "not installed" from the
   first commit until NRL-135 while every bare-Node suite stayed green. CI and
   `tests/release.test.ts` both fail on one. Do not hide a builtin from those checks with a
   computed specifier or `window.require`.

### Correctness

8. **Source offsets are the highlighting mechanism.** `SpeechChunk.sourceIndex[i]` maps
   each character of spoken text back to its offset in the raw markdown. Never highlight
   by searching the editor for the spoken string. If you change the stripping logic in
   `extract.ts`, the index must stay in lockstep - every dropped span still pushes an
   index entry.
9. **Playback rate is applied exactly once.** An engine with `ownsPlayback: true` is told
   the rate; everything else renders at natural speed and the player applies it. Both at
   1.5x is 2.25x, which shipped once already. There is a test; do not weaken it.
10. **Settings normalisation must not destroy keys it does not recognise.** Plugin data
    holds more than settings. A whitelist-rebuild erases reading positions on the next
    rate nudge.

---

## Verification rules

11. **A green test suite is not a claim that something works.** Unit tests here run in
    bare Node against fakes. Before saying a user-facing change works, exercise it the
    way a user would: `npm run deploy`, then drive the real plugin in Obsidian.
12. **Reproduce a bug end-to-end before fixing it.** Most of the defects in this codebase
    were invisible to the test suite and obvious the moment the real function was run
    against real input. Bundle the module and run it rather than reasoning about it.
13. **Never assert a measurement you did not take.** Performance claims in comments and
    in `srs.md` are real numbers from real runs. If you quote a ratio, a size, or a
    latency, you measured it in this session or you cite where it was measured.
14. **Repo existence is not install-path existence.** Verify a command or a file on this
    machine (`--help`, `ls`, `curl | head`) before depending on it.

---

## Known state

The working tree passes its gates. The audit against `srs.md` that opened this repo found
2 of 16 MUST requirements fully met. That count has not been re-run since, and several
tickets have closed gaps against it, so treat it as a floor rather than as current state.

**NRL-96 bundled the ONNX runtime and, for the first time in this repo, exercised the
plugin in a real Obsidian.** The runtime is packed into `main.js` by
`esbuild.config.mjs` (`docs/adr/0028`, superseding ADR 0024's distribution decision),
because Obsidian's community-plugin policy prohibits installing or updating dependencies
at runtime and a release-URL runtime is that however carefully it is verified. Install is
three files: `main.js`, `manifest.json`, `styles.css`, and `npm run build` no longer emits
`ort/`. Measured: 32,794,766 plain ORT bytes, 7,934,451 gzipped, carried as 10,579,272
bytes of base64 inside a 13,649,236-byte `main.js`. (This line used to call 10,579,272 the
gzipped size. It is the base64 length; corrected 2026-10-01 by re-deriving all three
figures from `node_modules/onnxruntime-web/dist`.) `tests/release.test.ts` unpacks all four
assets from the shipped bundle and compares them by SHA-256 against
`node_modules/onnxruntime-web/dist`, so the pack is verified against the publisher's bytes
rather than against itself; mutations that add a weight, drop a digest, reintroduce a
download URL, or drop a file from the build's own list each turn it red.

**What that bought, in a real Obsidian 1.13.7 on Linux** (synthetic vault, three files
deployed and nothing else): the plugin loads and registers all ten commands; the settings
tab renders the new row as **"ONNX Runtime / Status: Bundled with the plugin. Nothing to
download"**; clicking the real `Download` button fetched 148 MB of Kokoro weights plus a
voice, still user-initiated as `AGENTS.md` non-negotiable 6 requires; a read completed
`idle` -> `finished` over both chunks in 25.2 s on the CPU/WASM backend, which is the
backend that reads the pack; **zero non-local network requests** were captured on the CDP
`Network` domain across a whole read; the audio element played in real time
(`currentTime` 0.12 -> 1.24 against a 3.95 s duration, `readyState` 4); the word mark
advanced `This` -> `is` -> `a` -> `synthetic` inside a held sentence mark and both cleared
on Stop; and `resume from stored position @ 22` appears in the trace. Rule 9 was re-checked
on the real UI: `setRate(1.5)` gives an element `playbackRate` of exactly 1.5 and 1.37x
observed advance, not 2.25x. **The headline `2 of 16` count does not move** - R-M01 was
already counted, and its *release path* is still unexercised (no tag has ever been pushed).

**Three claims remain open and are the honest limit of the ticket.** Nothing was observed
on **Android**: whether a 13.6 MB `main.js` parses acceptably in that WebView, and whether
`DecompressionStream` exists there and inflates 21 MB in tolerable time, are both unmeasured
(desktop Chromium has both). The **JSEP/WebGPU pair was never loaded** by a running
Obsidian: this machine reported `GPU available (nvidia ampere, no shader-f16)` and the
plugin fell back to the CPU, so `ort-wasm-simd-threaded.jsep.*` is packed and
byte-verified but not yet executed by the host. And **no engine other than Kokoro was
heard** - inside the flatpak sandbox `espeak-ng`, `spd-say` and system voices are all
absent, so all three reported unavailable, which is correct behaviour on a machine with no
speech tooling rather than a gap in the plugin. **That last clause was only half the story,
corrected by NRL-135:** with the tooling present, both Linux engines would still have
reported unavailable, because `spawn.ts`'s `import("child_process")` could not resolve in
Obsidian's renderer. NRL-135 (PR #177, `docs/adr/0033`) replaced it with a call-time
`require`; on 2026-10-01, on a host with a native `/usr/bin/obsidian` 1.13.7 per commit
`7c75866`, both reported available and a read on Auto went `preparing` -> `playing` on
`speechd`, advancing a chunk. Not listened to by ear. **That host is not this Pop!_OS
machine, and the run is not reproducible here** (NRL-138, measured 2026-10-01): the only
Obsidian on this machine is the Flatpak (`flatpak list --app` gives `md.obsidian.Obsidian
1.13.7 user`, the live process is `/app/obsidian` under `bwrap`, and `which obsidian`,
`ls /usr/bin/obsidian` and `dpkg -l | grep -i obsidian` find nothing), the sandbox sees
neither speech binary (`flatpak run --command=sh md.obsidian.Obsidian -c 'command -v
espeak-ng spd-say'` finds neither, with `FLATPAK_ID=md.obsidian.Obsidian`), and the
`~/Documents/NoteReaderTest` vault is absent. `7c75866`'s message, that the Flatpak here
"has been replaced by the native one", is wrong for this machine; the commit is not
rewritten and this sentence is the correction.
Two residuals were reproduced and filed, and both have since had a fix merged. **NRL-142**
(PR #184, `d53d95c`): two concurrent `spd-say` clients racing the daemon's autospawn left
one exiting 1, so a probe that ran beside another (plugin enable, or the settings tab's
paired calls) reported speechd unreachable and Auto picked espeak. A single cold probe
autospawns fine. `SpeechDispatcherEngine.isAvailable()` now coalesces concurrent callers
onto one in-flight probe (cleared on settle, never cached) and retries `-O` exactly once,
after 500 ms, only when the exit is non-zero, unsignalled, and stderr holds
`Autospawn failed` plus `Can't set lock on pid file` or `already running`; a bind failure,
a refused connection or an empty stderr is never retried. `probeAttribution`, `listVoices`
and `synthesize` are byte-identical and do **not** retry, so a race there still fails closed
to `"unknown"`. Measured with the real bundled `speechd.ts` against a private autospawning
daemon (the host daemon here runs `-s -t 0` and was not touched): 6 of 6 trials lost the
race before the fix and 0 of 6 after, across one instance, two instances, paired
`probeEngines` and an external `spd-say` racing one probe. Two limits travel with that.
**The loser's stderr seen in the verify run was `already running` every time**; the
`Can't set lock on pid file` form is pinned by a unit test (C2) only. And **the acceptance
criterion in real Obsidian is NOT VERIFIED**: the Flatpak sandbox here has no `spd-say`.
**NRL-141**
(PR #181, `47cf18d`, ADR 0010's NRL-141 amendment): the Web Speech probe used to wait its
full 5,000 ms timeout on **every** call when the host had no voices, so every Auto read here
reached `playing` at about +5.1 s, against `srs.md:2282`'s 1,000 ms acceptable bound. The
confirmed-empty outcome is now cached per `WebSpeechEngine` behind one shared in-flight
poll, invalidated by a persistent `voiceschanged` listener and by a synchronous
`getVoices()` read on every call, so the local-voice gate stays fail-closed. Measured with
the real `webspeech.ts` and real timers at 0 voices, in bare Node and injected into the
running Obsidian 1.13.7 renderer: first `hasLocalVoice()` 4,909 ms, later calls and
`isAvailable()` 0 ms. **The fix narrows the wait, it does not remove it**: the first probe
after load still pays up to the full timeout, so a read issued inside that window waits out
the rest of it. **The acceptance criterion itself, an Auto read reaching `playing` in under
1,000 ms with speechd warm, is NOT VERIFIED**: no build carrying the fix was loaded into an
Obsidian that can reach `spd-say`, and no real host firing `voiceschanged` late has been
observed.

**The first of those three has since closed, on a second, independent device.** A Pixel 9
Pro XL (Android 17, WebView `app.vanium.webview`, Chromium 154) loaded the identical
13,649,236-byte `main.js`, all 9 commands registered, and the runtime unpacked with
matching digests (SIMD 354.2 ms, JSEP 524.9 ms). A real Kokoro read produced real-time
audio **(corrected 2026-10-01: what was observed is the audio element's `currentTime`
advancing in real time inside a chunk, which says nothing about whether synthesis keeps up
across chunks. Measured for sustained throughput on this same device, Kokoro misses 1x by
roughly 3-4x and 2x by 8.2x; see "Android playback throughput" below)**, stop/restart survived an actual `adb shell am force-stop` process kill and resumed
mid-chunk, `setRate(1.5)` gave exactly 1.5 with no doubling, and the whole session captured
zero non-local network requests. The **JSEP/WebGPU claim is still open**: this device also
has no GPU-loadable weights downloaded, so the packed JSEP build remains verified-but-
unexecuted on both platforms tested so far. **(Closed negative for this device on
2026-10-01: `navigator.gpu` exists but `requestAdapter()` returns `null` inside Obsidian's
WebView, so there is nothing for JSEP to execute on. See below.)** Two new, real findings came out of that same
session, filed rather than folded in here: a Kokoro ONNX crash that leaves the session
poisoned until Obsidian reloads, trigger unidentified (NRL-101, since **half** closed - the
paragraph after this one is the whole of what moved), and the 4-thread WASM load
failing reproducibly on a desktop Flatpak install, falling back to ~2.7x-real-time
single-threaded synthesis rather than the README's assumed near-1x (NRL-102, since
**partly** closed - the repeat cost is gone, the root cause is untouched and the 2.7x
figure still stands; read the NRL-102 paragraphs in the Android-throughput section
below and do not read "closed" as "fixed"). Full
measurement detail for both the Android acceptance and the two findings is in NRL-96's
comment thread, not duplicated here.

**NRL-101 is HALF closed, and the two halves must not be collapsed into one: the poisoning is
fixed, the trigger is still unidentified and unreproduced.** `src/engines/onnx/kokoro.ts` now
marks a posted worker synthesis failure (`sessionFailed`) and the next request recycles the
worker, once per successful-synthesis epoch (`recycleSpent`), instead of leaving a poisoned
ONNX session in place for the rest of the Obsidian session; a failure that survives the
recycle gets the distinct `KOKORO_RELOAD_REQUIRED` message rather than the engine's own text a
third time (`docs/adr/0031-recycling-a-poisoned-kokoro-session.md`). Measured on the Pixel 9
Pro XL: read 1 failed in **8 ms** with the engine's own message and `isPrepared()` false; read 2
produced a **complete second load** (`recycling the Kokoro worker...` then a fresh
`kokoro ready on CPU (WASM, 1 thread)`) in **3,475 ms**; read 3 gave `KOKORO_RELOAD_REQUIRED`
in **0 ms with no third load**; and a failure followed by a good request produced **115,244
bytes** of real audio with both flags cleared. Independently reproduced by a second agent,
which measured **133,244 B** on different text. **Zero non-local network requests** across the
recycle on the CDP `Network` domain - 10 `requestWillBeSent` across four captures, every one
`_capacitor_file_` or `blob:` - so non-negotiable 6 is **measured** here rather than reasoned:
the recycle re-reads the 155 MB of weights locally and downloads nothing. `setRate(1.5)` gave
an element `playbackRate` of exactly 1.5, so non-negotiable 9 still holds.

**The honest limit is large and must travel with every number above.** The deterministic
trigger used was an **unknown voice id**, which does **not** corrupt the ONNX session, so this
evidence establishes the *handling* and the UI - it does **not** establish that recycling cures
real ORT corruption, which is still exactly the unreproduced thing the ticket was filed about.
Desktop is **entirely unobserved** (CDP 9222 unreachable throughout). **No requirement moves,
`srs.md` was deliberately not amended, and the `2 of 16` MUST count does not move.**

**One classification from that work, recorded so it is not re-litigated: a `preparing` stall is
a THIRD case, neither this defect nor "the worker never answers".** A live stall showed
`pending: 0`, `sessionFailed: false`, and a direct `synthesize()` returning real audio in
**9,369 ms** - the engine healthy while the read orchestration never reached it. The trigger was
self-inflicted (three overlapping `read-note` commands), and Verify could **not** replicate it
(the same trigger reached `playing` in 5,012 ms), so the classification stands unchallenged but
unreplicated. **No ticket is filed for it**, deliberately: filing blind is what the plan
forbade.

### Android playback throughput, and the native-TTS bridge (2026-10-01)

Every number in this section was measured on 2026-09-30 / 2026-10-01 against `main` at
`abfcb85`, on the Pixel 9 Pro XL above (GrapheneOS, Android 17, Obsidian Android, WebView
`Chrome/154.0.8037.57`, `navigator.hardwareConcurrency` 8, `navigator.deviceMemory` 8),
driven over CDP through `adb forward ... localabstract:webview_devtools_remote_<pid>`. All
synthesis runs were **genuinely offline**: airplane mode on, Wi-Fi disabled, and
`adb shell ping -c1 1.1.1.1` returning `connect: Network is unreachable`. The device was
restored afterwards (airplane off, default engine unchanged, test note deleted, the
`synthesize` wrapper removed). The requirement being tested is the owner's: **offline
playback on Android at 2x or faster, sustained.** 2x playback needs synthesis at RTF
(compute seconds per audio second) of 0.5 or lower.

**Kokoro fails it, on the fast build, by 8.2x.** Weights on disk were
`onnx/model_q4f16.onnx`, 154,586,422 bytes. Note that `resolveWeights("auto")` returned
`"small"` (q8) on this device, as `Platform.isMobile` dictates, and q4f16 ran only because
q8 was not on disk and `weightsOrder` falls through to whatever is present - so a fresh
Android install would download q8, which `kokoro.ts`'s own comment records as about 2.5x
slower than q4f16. Test: a 5,008-character synthetic English note (41 chunks), rate 2.0,
`bufferAhead` 2, `kokoroThreads` 4, model warm before the measured run was attempted:

```
preparing -> first audio       72.0 s     (cold load; the warm-up was reset before it held)
playing window                351.9 s     (72.0 s -> 423.9 s)
audio delivered                86.0 s     11 chunks: 7.175 7.7 6.875 9.375 7.675 7.125
                                          10.1 8.225 7.175 7.7 6.875
same audio at 2x should take   43.0 s     -> 8.2x too slow
stalled                       304.6 s     11 distinct events = 87% of the window silent
reached                      chunk 24 of 41, never finished
element playbackRate          exactly 2   (rule 9 holds; rate was not the problem)
```

Effective RTF is **roughly 3 to 4**. That figure is a range on purpose: the harness wrapped
`player.synthesize`, whose per-call times overlap the `bufferAhead` prefetch, so per-call
milliseconds are not clean RTF and only the window totals above are. A stall was counted as
`currentTime` unchanged for more than 300 ms while the player reported `playing`. **Method
trap:** the first harness appended one stall per 100 ms poll and reported 2,425 "stalls";
count open/close intervals, not polls. And at about 421 s the probe found
`app.plugins.plugins['local-tts-reader']` momentarily `undefined` with the Obsidian pid
unchanged; on re-probe the plugin was loaded and idle but `app.plugins.enabledPlugins` was
empty. **Unexplained**, possibly adjacent to NRL-101, and recorded rather than guessed at.

**The root cause is a host ceiling, not plugin code.** Inside Obsidian's Android WebView:

```
crossOriginIsolated             false
typeof SharedArrayBuffer        "undefined"; new SharedArrayBuffer(8) throws
WebAssembly SIMD validate       true
navigator.gpu                   object, but requestAdapter() -> null
```

ONNX Runtime Web's multi-threaded WASM needs `SharedArrayBuffer`, which needs cross-origin
isolation (COOP/COEP response headers). Obsidian serves its page from `http://localhost`
without them and **a plugin cannot set response headers**. So **`kokoroThreads` cannot
take effect on Android at all** - eight cores, one doing the work - and with no WebGPU
adapter there is no faster backend to fall to. No weights choice fixes this. The owner's
position, recorded 2026-10-01: **Kokoro is not an acceptable Android solution**, and likely
not for desktops without a usable GPU either. The desktop half of that is **consistent with
the existing record but was not re-measured here**: `kokoro.ts` records q4f16 at about 1x on
a 4-thread desktop CPU, which already fails a 2x bar, and NRL-102 records 2.7x slower than
real time when threads fail.

**NRL-102 is probably a different bug from the Android ceiling.** Desktop Obsidian 1.13.7
(Flatpak) renderer pid 51787's `/proc/<pid>/cmdline` carries
`--enable-features=GlobalShortcutsPortalPreferredTrigger,PdfUseShowSaveFilePicker,SharedArrayBuffer,Vulkan`.
So desktop Electron explicitly enables `SharedArrayBuffer`, and whatever defeats the
4-thread load there is something else. **Limit:** this proves the flag reaches the
renderer; `typeof SharedArrayBuffer` was not evaluated inside the desktop page, because CDP
9222 was not listening and Obsidian was not restarted to open it.

**NRL-102 is PARTLY closed, and what did NOT close matters more than what did.** `89aedd0`,
PR #188, `docs/adr/0034-remembering-a-failed-threaded-load-for-the-session.md`. **The root
cause is untouched and unfixed.** Threads still fail on this host, single-threaded synthesis
is still roughly 2.7x slower than real time, and the non-Flatpak comparison the ticket asks
for remains unresolvable: the Flatpak is the only Obsidian on this machine, re-measured this
run. **One wasted threaded attempt per Obsidian launch or plugin reload remains, BY DESIGN.**

What closed is the *repeat* cost only. A failed threaded load is now remembered for the plugin
session, so an incidental re-read of the same `kokoroThreads` value no longer resurrects the
doomed attempt. Two new private fields on `KokoroEngine`: `threadedLoadFailed`, set in the
existing catch in `load()` that already degrades `options.threads` to 1, and
`requestedThreads`, written **only** by the constructor and `setOptions` and never by the
degradation, so the two diverge exactly when a failure has been remembered. `setOptions`
therefore compares the incoming **REQUESTED** value against the last requested value, never
against the degraded effective one, and the suppression happens before `changed` is computed
so a phantom 1 -> 4 no longer forces a dispose.

**The ticket's own premise was wrong and is corrected here.** There is exactly one
`new KokoroEngine` site (`src/engines/registry.ts:33`, reached once from `src/main.ts:156`),
so the degradation already persisted for the whole plugin session and a bare `dispose()` -
including NRL-101's recycle - left threads at 1. "Every fresh load re-pays" was not literally
true. The two real re-pay paths were once per launch, which stays, and `setOptions` resetting
threads to 4 because `kokoroOptions()` re-reads `settings.kokoroThreads`. The second is what
was fixed, and the device dropdown (`src/ui/settingsTab.ts:280-283`) hit it the same way by
re-asserting the unchanged count, which is why the fix had to live in `kokoro.ts` and **not**
in `setKokoroWeights`: a `main.ts`-only fix would have missed the device path.

Evidence, **bare Node against a fake worker that refuses any init asking for more than one
thread**, which is the class to hold every figure below to. Init thread-count sequences:
`[4,1,4,1]` unfixed against `[4,1,1]` fixed; the device-dropdown shape gives the identical
`[4,1,4,1]`; a deliberate change to 2 gives `[4,1,2]` with the memory cleared and the attempt
really made at the new value rather than silently forced to 1; and the adversarial re-arm case
is `[4,1,2,1,2,1]` unfixed against `[4,1,2,1,1]` fixed, where the memory re-arms after the 2
also fails and the skip line names the **NEW** count rather than the stale 4. 22 new checks in
`tests/kokoro.test.ts`, of which **6 are defect reproductions** (T1c, T1d, T2, T3b, T4e, T5)
and 3 are red merely because the new field and the new `infoCb` line did not exist. Verify
corrected the author's own 5-of-9 split **upward, in the author's disfavour**: T4e's failure
detail on the reverted build carries a *second* `threaded load failed (` line, which can only
exist because the second doomed attempt was really made.

**One thing was measured on the real desktop, and it is the DEFECT rather than the fix.** The
defect reproduced verbatim over CDP against the deployed pre-fix build, with the ticket's
trace character for character once `device: "wasm"` was forced at the engine level:
`backend plan: wasm/4t -> wasm/1t`, then `threaded load failed (...)`, then
`kokoro ready on CPU (WASM, 1 thread)` with `options.threads` 1 - after which the exact
`kokoroOptions()` shape put `options.threads` back to 4 with `ready` nulled. **The FIX was
not and could not be observed.** The running renderer provably held pre-fix code
(`"threadedLoadFailed" in engine` was false, and the live `setOptions` stringified to the
merge-base one-liner), the build on disk belonged to another lane, and restarting Obsidian was
forbidden, so every figure about the fix is bare-Node and rule 11 applies to all of it.

**A new measurement from that same session contradicts a claim already in this file, and both
are left standing.** A plain `engine.load()` with the settings as found took the **GPU** path
and **SUCCEEDED**: `backend choice: GPU (nvidia ampere, no shader-f16) with onnx/model.onnx`,
`backend plan: webgpu/1t -> wasm/4t -> wasm/1t`, `loaded on webgpu with 1 thread(s) in
3193ms`, `kokoro ready on GPU (WebGPU)`. So with as-found settings on this desktop the
4-thread WASM attempt is **never reached**, which is why the ticket's trace needed the wasm
backend forced. That is at odds with the NRL-96 paragraph earlier in this file, which records
this machine reporting `GPU available (nvidia ampere, no shader-f16)` and the plugin falling
back to the CPU with the JSEP pair never loaded. **Neither claim is deleted.** The new one's
limits: it was taken against a *different concurrent lane's* deployed build rather than
against `main`, on an un-restarted renderer, in one session. NRL-96's session also recorded
`backend plan: wasm/4t -> wasm/1t` with no webgpu entry, so its device resolved differently.
**NRL-139 now holds the question** of which is current.

**Nothing is persisted, deliberately, and persisting it is the WRONG fix.** Plugin data is
`data.json`, which is vault-synced, so a durable "threads failed here" flag would follow the
vault to a machine where threads work and degrade it permanently with no way back - a worse
defect than the one being fixed. Non-negotiable 10 is the independent second reason: a new
settings key invites the whitelist rebuild that erases reading positions. `docs/adr/0034`
carries both, plus the reason this flag must deliberately **survive** `dispose()` where
NRL-101's `sessionFailed` / `recycleSpent` pair is deliberately cleared by it. Verify grepped
the whole diff for `saveData|loadData|normaliseSettings|pluginData|DEFAULT_SETTINGS|data.json|`
`localStorage|adapter.write|writeFile` and all four hits are prose explaining why nothing is
persisted; `src/settings/` is untouched.

**The limits, every one of them load-bearing.** The suite's "failure" is a fake worker refusing
to boot, so nothing establishes that the real ORT thread pool fails the way the ticket reports,
nor that a once-failed load would not have worked on a second try. `src/main.ts` and
`src/ui/settingsTab.ts` have no bare-Node runtime, so `kokoroOptions()`, both `setOptions`
call sites, the device dropdown and the threads slider have **no automated coverage of any
kind**, and the option shapes in the tests are transcriptions - though the real-host
reproduction did drive the `kokoroOptions()` shape against the live engine, which is stronger
than a transcription for that one step. The worker keeps its own `SharedArrayBuffer` probe and
its own per-attempt fallback (`src/engines/onnx/kokoro.worker.ts` is byte-identical by
sha256), so **two un-unified layers now give up on threads**; that is accepted, the worker's
probe being the backstop for a host where `SharedArrayBuffer` is simply absent, which the
engine-level memory cannot see. And the same-count-is-incidental choice is a **judgement
nobody has user-tested**: re-asserting 4 when 4 is already stored carries no signal at all,
because the device dropdown and the slider call `setKokoroRuntime` with identical arguments,
so it is treated as incidental and suppressed, with the slider's per-value `onChange` and a
plugin reload as the escape hatches.

**No requirement moves and the `2 of 16` MUST count does not move.** This ticket cites no
requirement ID, and `srs.md` was not amended. State the reason in its corrected form:
`grep -n thread srs.md` is zero matches, but `kokoroThreads` **does** appear at `srs.md:509`,
in the Settings shape listing with no behavioural contract attached. The case-sensitive grep
that missed it was caught by critique as a rule 13 violation and corrected in ADR 0034, so
quote the corrected form rather than the bare zero.

**The direct native route is still closed on a current WebView.** NRL-35's BLOCKED_BY_HOST
was measured on Chrome/88; re-measured on Chromium 154 it holds: `typeof speechSynthesis`
and `typeof SpeechSynthesisUtterance` are `"undefined"`;
`Capacitor.isPluginAvailable('TextToSpeech')` is `false`; the full Capacitor plugin list is
`App, Browser, CapacitorCookies, CapacitorHttp, Clipboard, Device, Filesystem, Haptics,
KeepAwake, Keyboard, Preferences, RateApp, SecureStorage, SplashScreen, StatusBar, WebView`;
and `AndroidInterface`, `ObsidianBridge`, `electron` and `require` are all undefined.
Obsidian's own manifest also matters here: `dumpsys package md.obsidian` shows exactly one
intent query, `queriesIntents=[Intent { act=android.support.customtabs.action.CustomTabsService }]`,
so **even a Capacitor TextToSpeech plugin would fail to bind an engine on Android 11+**
until Obsidian also declared the `TTS_SERVICE` query. That is the concrete, two-part ask if
a feature request is ever filed with Obsidian.

**The door that is open: loopback HTTP.** The WebView page origin is `http://localhost`, so
`http://127.0.0.1:<port>` is same-scheme. With a listener on device loopback (an
`adb reverse tcp:8771` socket), both a plain `fetch` and
`Capacitor.Plugins.CapacitorHttp.get` returned **200** from inside Obsidian.

**A prebuilt bridge failed, and why is worth knowing.** `it.eja.ttsserver` v1.6.5 (GPL-3.0,
APK sha256 `09d6da4d67c3446bb6d837bb4dce5ccda43cf764b03aa417fca759969b555cc4`) hung on
every synthesis with `W TextToSpeech: synthesizeToFile failed: not bound to TTS engine`.
`dumpsys` showed `targetSdk=34` and **no `queriesIntents` line at all**: an app targeting
API 30+ cannot see or bind a TTS engine without declaring
`<queries><intent><action android:name="android.intent.action.TTS_SERVICE"/></intent></queries>`.
It was broken on every modern Android, not just this one. It also bound `0.0.0.0:35248`,
LAN-exposed, and was uninstalled.

**A purpose-built bridge works.** `io.loopstring.ttsbridge`, one 393-line Java Activity, a
16,797-byte APK built without gradle (Android build-tools 34.0.0 and platform android-34 in
`~/Android/Sdk`; Temurin JDK 21.0.12.1 in `~/Android/tools`, because this machine had a JRE
and no `javac`). **Source, build script and measurement script are in
`companion/android/`** (README there). It declares the `TTS_SERVICE` query, binds
**127.0.0.1 only**, requires a random 32-hex token on every route but `/health`, and takes
text in a **POST body, never a query string** (non-negotiable 2's reasoning: a URL lands in
logs the way argv lands in `ps`). Result: `queriesIntents=[Intent { act=android.intent.action.TTS_SERVICE }]`,
`TTS init: SUCCESS`, zero "not bound" errors. **The query is proven causal, not inferred**:
the same Java with only `<queries>` removed gave `queriesIntents=[]`,
`TTS init: FAILED (-1)` and a 503 from `/synthesize`. Obsidian itself targets SDK 36, so
package visibility applies to it too.

Three defects in the first committed version were found by `/critique` running the bridge
on the device, and are fixed; each is worth not reintroducing. **The bind address.**
`InetAddress.getLoopbackAddress()` returned **`::1`** on Android 17, so the socket sat in
`/proc/net/tcp6` while every document said `127.0.0.1`: on device, `nc 127.0.0.1 8787` was
refused and `nc ::1 8787` answered, and from inside Obsidian both `fetch` and
`CapacitorHttp` failed at `127.0.0.1` (`CapacitorHttp` also failed at `localhost`, which
Java resolves to `127.0.0.1`). It now binds the IPv4 loopback explicitly and logs the address
actually bound rather than a literal. **An unauthenticated crash.** The body buffer was sized
from the `Content-Length` header before the token check, and the `OutOfMemoryError` escaped
a `catch (Exception)`, so one request with no token and `Content-Length: 2000000000` gave
`FATAL EXCEPTION: tts-bridge-http ... at MainActivity.handle` and killed the process. Headers
are now capped at 16 KiB, the body at 64 KiB, the token is checked before the body is read,
and each connection catches `Throwable`; re-run, seven hostile inputs (no token or token,
`Content-Length` of 2000000000, 65537, -5, `abc` and 9999999999, and a 20 KB unterminated
header) drew 401, 413, 400 or 431 from one surviving process. **Overstated provenance.** An
earlier draft of this paragraph said the repo copy was byte-identical to "the build that
produced the numbers below". Only some rows came from that build; three came from a superseded
one. Every bridge number below has since been re-measured on the current committed source
(`classes.dex` sha256 `c81e9ceea4edf09170d6becb778c59cefb992ad451ec7d1a753727ac67aba646`),
by `companion/android/measure.sh`, in two fresh app sessions.

Build trap: **d8 8.2.2 cannot dex an anonymous `UtteranceProgressListener`** here
(`NullPointerException: Cannot invoke "String.length()"`); `-g:none` and `--release 11` did
not help, a named nested class did.

**Native TTS passes the requirement with margin.** All offline (airplane mode, ping
unreachable), engine `app.grapheneos.speechservices`, committed build above, two fresh app
sessions:

```
input       rate   audio out    session A           session B           2x target
482 chars   1.0    32.276 s     3,734 ms  RTF 0.116  5,106 ms  RTF 0.158  PASS
482 chars   2.0    16.138 s     3,838 ms  RTF 0.238  4,023 ms  RTF 0.249  PASS
 72 chars   1.0     5.097 s       681 ms  RTF 0.134    859 ms  RTF 0.169  PASS
```

Read the 2.0 row as the requirement itself: that audio is already rendered at 2x, so
synthesis outruns 2x playback by **4.0x to 4.2x**. Against Kokoro's roughly 3 to 4 on the
same phone that is **roughly 20 to 35 times the throughput**, with zero download. (An
earlier draft quoted RTF 0.108 to 0.120, 4.6x and "roughly 30 times"; those came from a
superseded build and are replaced, not averaged in.) A 72-character sentence synthesizes in
681 to 859 ms with the engine already bound. That is synthesis time measured from the host
over `adb forward`, **not** time to first audio inside the plugin, which has not been
measured, and it must not be set against Kokoro's 72 s cold load as if it were.

Two integration facts follow. Synthesis time is roughly independent of rate (3,734 vs
3,838 ms in session A; session B's first call ran slower at 5,106 ms). And **the engine
applies rate at synthesis time** - at 2.0 the file itself is half as long, 16.138 s against
32.276 s - so an engine built on it must own its rate and the Player must not apply rate
again, or the result is 4x. That is exactly the defect non-negotiable 9 exists to prevent.

**No word timings, by either API.** `onRangeStart` fired **zero** times across all six
`synthesizeToFile` calls above **and** both `speak()` probes (72 characters, `rc` 0,
finished, 5,502 and 5,355 ms wall for 5.097 s of audio). So this engine simply does not
implement it. That needs no new architecture: `speechd.ts:24` already declares
`timing: "none"`, and `src/ui/highlight.ts:69-75` already keeps the sentence layer and
NRL-72's scroll while disabling only the word row for such an engine. **The owner accepted
losing the word highlight on Android on 2026-10-01.**

**One engine, one voice, on this device.** `tts.getEngines()` lists only
`app.grapheneos.speechservices`, with one voice (`en_US`, quality 500,
`isNetworkConnectionRequired` false). Google TTS (`com.google.android.tts`) is installed as
a package but registers no `TTS_SERVICE` (`cmd package query-services -a
android.intent.action.TTS_SERVICE` returns one service), `secure tts_enabled_plugins` is
`null`, and writing `secure tts_default_synth` to Google TTS did **not** change
`getDefaultEngine()`. This is a GrapheneOS characteristic and says nothing about stock
Android's voice count. The bridge's `/setengine` route rebinds through the three-argument
`TextToSpeech(ctx, listener, enginePackage)` constructor, which is the only engine switch an
app controls, but it is **untested** for lack of a second engine.

**Distribution precedent for a companion app exists.** Matching names and descriptions in
the live `community-plugins.json` (8,259 entries): 51 mention Ollama, 32 Zotero, 12 LM
Studio, 5 AnkiConnect - all plugins that only work with a separately installed local app or
server. These are regex hits on listing text, not audited dependency counts, but they
establish that "plugin plus local companion over loopback" is an accepted directory shape.

**The WebView-to-bridge path has now run end to end**, from inside Obsidian on the device,
against the fixed build: `GET /health` at `127.0.0.1` and at `localhost` returned 200 by both
`fetch` and `CapacitorHttp`, and `POST /synthesize` through `CapacitorHttp` at `127.0.0.1`
returned 200 with audio. A `fetch` POST carrying `Authorization` still fails, because the
bridge has **no `OPTIONS` handler** and the CORS preflight is refused, so the plugin side
must use `CapacitorHttp` or the bridge must answer preflight.

**What is NOT yet established, and must not be read as done:** no sustained multi-chunk read
went through the real Player; the bridge handles requests on its single accept thread with
no read timeout, so one connected-but-silent client stalls every other request until it
closes (reproduced: `/health` answered at t0, went silent while such a client was open, and
answered again once it closed), and a long synthesis blocks `/health` the same way; a
synthesis that fails or times out can leave its WAV in the app cache; no foreground service
exists, so the bridge serves only while its Activity is alive, and whether the plugin can
launch it (an intent or custom-scheme URL from the WebView) is untested; the token still goes
to logcat; Play and F-Droid distribution are unexplored; and nothing here amends `srs.md` or
adds an ADR, both of which a shipped companion-app engine will need under the deviation rule
at the top of this file. The `2 of 16` count does not move.

**Supertonic 3 was evaluated and rejected for Android.** `Supertone/supertonic-3` on
Hugging Face: four ONNX graphs totalling **398,075,273 bytes** (`vector_estimator`
256,534,781, `vocoder` 101,424,195, `text_encoder` 36,416,150, `duration_predictor`
3,700,147), fp32 only with no quantized variant published - 99M parameters at 4 bytes is
the whole explanation. That is 2.7x Kokoro's real 148 MB download. Its weights are BigScience
OpenRAIL-M (use-restricted, not OSI); the code repo, `supertone-oss-archive/supertonic`, was
archived with its last push on 2026-09-09. Its one real advantage is 31 languages from one
checkpoint with no phonemizer, where `kokoro-js@1.2.1` is English-only. It would run on the
ORT already bundled, but on Android it would hit the same single-thread ceiling, and its
`vector_estimator` reads like an iterative sampler (a hypothesis from file names and sizes,
not measured).

### Community-directory submission state (measured 2026-09-30)

Submission now happens at community.obsidian.md with a linked GitHub account, reading
`manifest.json` from the default branch HEAD; the old pull request to `obsidian-releases`
is no longer the route. The id `local-tts-reader` is free. No release and no tag exist on
`origin`. Two gaps would plausibly fail review. **Third-party license text is absent from
the bundle**: `kokoro-js@1.2.1` is Apache-2.0 and `onnxruntime-web` is MIT, both are packed
into `main.js`, and `main.js` contains zero license comments, while the developer policies
require complying with bundled code's licenses. **Nothing lints**: the official
`eslint-plugin-obsidianmd` (0.4.2, `obsidianmd/eslint-plugin`) has never been run, there is
no eslint in `devDependencies`, and `ci.yml` has no lint step. A hand grep found no
`innerHTML`, `activeLeaf`, `console.log`, `var` or regex lookbehind in `src/`, and four inline
`style.display` writes in `src/ui/settingsTab.ts:775-798`.

`main.js` composition at 13,650,767 bytes: ORT base64 payload **10,579,272** (77.5%), the
inlined Kokoro worker as base64 **2,956,176** (21.7%, decoding to 2,217,132 bytes of JS),
and everything else **115,319** (0.8%). Two levers, measured: the worker is base64'd but
**not** gzipped, and gzip-then-base64 would be 1,223,852 bytes, saving **1,732,324**; and the
two `.jsep.*` files alone cost **6,749,720** bytes of the bundle while being unexecutable on
the one Android device measured, since it has no WebGPU adapter.

Two confirmed moves: R-M01 (standard Obsidian Community Plugin) is met as of NRL-16, with
all release infrastructure in place (README.md, LICENSE, versions.json, SLSA Level 3 workflow,
and ORT runtime checksum validation) - but read the R-M01 evidence correction below before
relying on that parenthesis, because until NRL-69 that workflow had never run successfully
even once. R-M14 (backend capability detection) is met as of NRL-22,
because every capability that differs across the four engines now gates the control it affects,
and the ones that gate nothing have no control to gate. R-M03's spike (SPIKE-ANDROID-001) is
resolved as of NRL-35, and this one did need a real device, not bare-Node reasoning:
`window.speechSynthesis` does not exist at all in Obsidian's Android WebView (Chrome/88 WebView
on Android 10, a Huawei P30 Pro), Obsidian's Capacitor bridge has no TextToSpeech plugin compiled
in (`Capacitor.isPluginAvailable('TextToSpeech')` is `false`), and Obsidian itself exposes no TTS
facility to plugins. All three were measured directly against the live page over CDP, and the
`TTS: Test Android native TTS` command this added was then built, deployed into that device's real
vault, enabled, and run through `executeCommandById` exactly as the command palette would, landing
the same `BLOCKED_BY_HOST` result in the plugin's own diagnostics log. Result: BLOCKED_BY_HOST,
demonstrated rather than assumed, which is the valid terminal state the spec's Spike Failure clause
describes and is why Kokoro-in-WebView is the Android backend rather than a native bridge.

That same device surfaced a second, narrower blocker after NRL-60 and NRL-61 fixed the
worker-loading bug and polyfilled two missing runtime APIs (`Object.hasOwn`, `ReadableStream`
async iteration): Kokoro's vendored `onnxruntime-web` runtime is a WASM SIMD build by name
(`ort-wasm-simd-threaded.wasm` / `.jsep.wasm`), and the device's WebView reports
`WebAssembly SIMD is not supported in the current environment`. This is a VM instruction-set
gap, not a missing JS API, so it cannot be polyfilled - confirmed by live re-testing on the
device, not assumed. NRL-62 considered and rejected building a non-SIMD fallback (a second
vendored WASM build set, `WebAssembly.validate()` feature detection, and a parallel path in
`kokoro.ts`'s backend plan): Chrome shipped WASM SIMD in May 2021, so the large majority of
Android devices in real use today already support it, and the one confirmed non-SIMD device is
this same frozen Huawei OEM WebView component (`com.huawei.webview`, no Play-Store-updatable
Android System WebView package on it) that NRL-35 already found unusual rather than
representative. Weighed against that speculative benefit, the concrete cost is real: a second
set of vendored WASM files, a second set of build-time checksums, and a larger install for
every user, not only pre-2021 ones. The decision is to document pre-2021-WebView /
non-SIMD Android as an **explicit out-of-support tier** rather than build the fallback.
`srs.md` makes no formal WASM/SIMD requirement to amend - R-M03 only requires the native-bridge
spike NRL-35 already resolved, and is silent on WASM instruction-set support entirely, so this
is a scoping decision on an unstarted requirement, not a documented spec deviation, and no ADR
is warranted. Revisit if a second independent non-SIMD device report surfaces, or after NRL-37
ships: on-demand ORT download changes the cost side of this calculus, since a non-SIMD build
would then be a second optional download rather than a mandatory addition to every install.

R-M01's *evidence* is weaker than that parenthesis reads, and NRL-69 corrected it without
moving the count. The "SLSA Level 3 workflow" had **never completed a single successful
run**, and it stayed that way until NRL-79. Measured over the repo's full paginated Actions
history at `01c9a84`: 112 recorded runs, of which `release.yml` accounted for 103 and **all
103 were failures, with zero successes ever**; 95 runs preceded the repo's first-ever
successful run and every one of those 95 was a `release.yml` failure. Two compounding
defects caused it, both fixed by NRL-69, and the comment block in
`.github/workflows/release.yml` records the A/B that isolated them: the SLSA generator was called as a step's `uses:` when a reusable workflow
has to be called at job level, **and** the reference was missing its `.yml` extension.
Either half alone stops the whole file compiling, which is why every historical run was a
0-second, 0-job failure with no log, created on branch pushes that `on: push: tags` should
never have matched at all. NRL-69 also added `.github/workflows/ci.yml`, which runs
`npm ci`, `npm run typecheck`, `npm run build`, a `require()`-list assertion and `npm test`
on every push and every `pull_request`; its first run, `36677239800`, is this repo's first
successful workflow run of any kind, and a deliberate one-line test inversion on a throwaway
branch went red as run `36678786748` with the `Test` step the only failing step, so the check
is demonstrated in both directions rather than inferred from YAML that parses. Those
figures are history and not the present tally: as of NRL-79 `release.yml` stands at
**`{failure: 106, success: 1}`**, the single success being run `36785920227`, and the
repo-wide total was 281 immediately after that experiment (284 a few minutes later, from
unrelated lane activity).

What NRL-69 by itself established is only that `release.yml` *compiles*: the merge commit
`01c9a84` on `main` produced a green `ci.yml` run (`36679940668`) and **no** `release.yml`
run at all, where every earlier push to `main` produced a failing one. It said nothing about
what the release path does.

**NRL-79 exercised that path once, end to end.** Exactly one release tag has ever been
pushed to this repo: `0.1.1`, at commit `3d7b3e1`, on 2026-09-30, alongside a `nightly`
negative control at the identical commit. Both tags and the Release were deleted afterwards,
so `git ls-remote --tags origin` and `gh release list` are **empty again** and the Release
assets are no longer downloadable; what survives is the permanent run log, two still-live
workflow artifacts and a Rekor entry. `actions/create-release` (**since deleted by NRL-104** -
it is no longer in `release.yml` and the citations below say what replaced it), the asset upload
and the SLSA provenance job - none of which had executed once across 106 recorded `release.yml`
failures - all executed and all concluded success in run `36785920227`: six jobs, none
skipped, 97 seconds, this repo's first successful `release.yml` run. The workflow produced a
real SLSA v0.2 in-toto attestation whose **seven subject digests equal the sha256 of the
seven files that run actually built**, re-derived from the surviving `dist` workflow
artifact and so independent of the deleted Release; whose **DSSE signature verifies**
against a Fulcio certificate that chains to Fulcio's published root under `openssl verify
-attime <integratedTime> -x509_strict`, with a flipped-byte tamper control on the rebuilt
PAE giving `Verification failure`; and whose certificate **names this repository**, commit
`3d7b3e18062cf11a86856db4e866e38075022059`, ref `refs/tags/0.1.1`,
`.github/workflows/release.yml` and run `.../runs/36785920227/attempts/1`, with OIDC issuer
`token.actions.githubusercontent.com`. It is recorded in Rekor at logIndex 3026377928, uuid
`108e9186e8c5677a9dbc7018a00a5be00677d7a60223c5df12485367a30bc1a46bf46013a8350b1b`,
integrated 2026-09-30T22:31:16Z, append-only and undeletable. Treat R-M01 as met on its
shipped files and **exercised once, end to end, on its release path**.

Four caveats travel with that sentence and must not be separated from it. It was exercised
**once**, on a throwaway tag and a Release both since deleted, on one day, on
`ubuntu-latest`, with three `The set-output command is deprecated and will be disabled soon`
warnings from `actions/create-release@v1`, so **nothing about recurrence is established**;
**2026-10-19** stays a dated re-verification trigger for this path, because that is when the
`ubuntu-latest` label migrates to Ubuntu 26 - but **the `set-output` half of that trigger is
discharged**, not pending: NRL-104 deleted the `actions/create-release@v1` step that was the
sole source of those three warnings and the file's only `using: node12` runtime, and the
`softprops/action-gh-release` commit it is pinned to declares `using: "node24"` and holds zero
literal `::set-output`. So the one *observed* thing that was going to break this path is gone,
and the Ubuntu 26 migration is now the only reason left to re-check on that date.
**NRL-104 makes this path LESS exercised rather than more, and that is the honest reading.**
NRL-79's single successful run used `actions/create-release@v1` plus a separate upload step; the
shipped configuration - one `softprops/action-gh-release@efb35369` step creating the Release and
uploading all three assets - **has never run on a real runner**, because no tag has been pushed
since. Every claim about it is desk-verified from the pinned action's own `action.yml` and dist,
plus `tests/release.test.ts`'s regex assertions over the workflow text. The attestation was
**not** validated by
`slsa-verifier` or `gh attestation` under a TUF-rooted Sigstore trust bundle: neither exists
on this machine (`gh` is 2.45.0 and `gh attestation --help` returns `unknown command`), the
trust anchor used was Fulcio's root fetched over TLS, Rekor's signed entry timestamp and its
27-hash inclusion proof were not recomputed, the CT SCT was not checked against a CT log key
and no policy engine ran - so this is **not** "verified to SLSA Level 3" in the conventional
sense, and nobody has run the check a downstream consumer would run. **Nothing was installed
into Obsidian**: the Release was world-readable for about two and a half minutes and was
digested and deleted, never installed from, so `srs.md:106`'s "MUST install as an ordinary
Obsidian Community Plugin" is still unobserved and is now the binding gap on R-M01, together
with whatever NRL-96 does to clause 3. And the **`2 of 16` headline count does not move** -
not because the evidence is thin, but because R-M01 was already one of the two met MUSTs
before this ticket, so there is no R-M01-shaped seat left to take; what NRL-79 changed is
that the weakest "met" claim in this file stopped being weak. Tracked as NRL-79. Of the two
defects known to sit on that path, **both are now fixed**, NRL-75 and NRL-76, and NRL-79's
run has since exercised both fixes on a real runner. NRL-75's own parenthesis needs
correcting as well as closing: `tags: ["*"]` does **not** match any tag, it matches any tag
whose name holds no `/`, because GitHub's
published table row for `'*'` reads "Matches all branch and tag names that don't contain a
slash (`/`)" (github/docs@main `workflow-syntax.md`, read verbatim during NRL-75). So the
`backup/nrl-54-pre-split-...` tag the ticket cited was **documented-inert**, and the live
hazard was the slash-free shapes - `nightly`, `wip`, `pre-rebase`, `v0.1.0`, `0.1.0-rc1`,
`backup-nrl-54-...` - each of which would have cut a real public GitHub Release. The trigger
is now `tags: ["[0-9]+.[0-9]+.[0-9]+"]`: bare semver, no `v` prefix (manifest.json's version
is `0.1.0` and versions.json's sole key is `"0.1.0"`, so a `v*.*.*` pattern would never
fire), prereleases excluded (`prerelease: false` is hardcoded in the `Upload Release Assets`
step - the single `softprops/action-gh-release` step that both creates the Release and uploads
its assets as of NRL-104; the `Create GitHub Release` step this sentence used to name was
deleted by that ticket). These are **filter patterns, not regexes** - `*` is a wildcard and not a quantifier,
which is why `[0-9]*.[0-9]*.[0-9]*` was rejected as matching `0.1.0-rc1` - and the authority
for applying `+` to a bracket class is GitHub's own row `v[12].[0-9]+.[0-9]+`, documented as
matching `v1.10.1`. `tests/release.test.ts` pins it with three checks, all three parsing the
workflow's own `on: push: tags:` list and one comparing it to `EXPECTED_TAG_PATTERNS`, and the
matcher they depend on is validated against **every row of that published table** rather than
against itself, because a wrong hand-rolled matcher would make the three checks green while
the workflow behaved differently in production. Measured: the three went red against the
unmodified file (`["*"]`, all ten operational shapes firing) and green after; the five guard
tag shapes - the `backup/`-shaped name plus the four real version tags - were green on both
sides. **NRL-79 exercised exactly one pair of that filter empirically**, on a single commit:
the tag `0.1.1` fired `release.yml` in **2 seconds**, and the tag `nightly` - slash-free, so
it would have matched the old `["*"]` - produced **no run of any workflow**. That negative
is exhaustive rather than bounded-wait: enumerating every run ever recorded against sha
`3d7b3e18` returns two, the branch `ci.yml` run and the `0.1.1` Release run, and assumes no
waiting bound at all. So the narrowing is **empirically established for that one pair** and
only **strongly supported** as a general claim. The limits are real and should stay written
down: only that pair was tested, the other nine operational shapes `tests/release.test.ts`
enumerates remain **desk-verified** against GitHub's published table and are reasonably left
there, and GitHub exposes no observable that distinguishes "the filter rejected this ref"
from "this ref never reached the dispatcher", so `nightly`'s silence rests on the
single-variable design - same commit, same `release.yml` bytes, six minutes apart, only the
tag name differing - rather than on a direct signal.
Two further things about that fix are worth carrying. The `matchesFilterPattern()` oracle in
`tests/release.test.ts` **must stay faithful to GitHub's documented semantics rather than
convenient**, because it is the only thing standing between a green suite and a workflow that
behaves differently in production. NRL-75's first Verify caught it silently mistranslating the
documented `\` escape: `v1\*` compiled to a literal backslash followed by a live wildcard, so it
did not match the tag `v1*`. The remedy for a related false comment was to **narrow the comment,
not to add throws** - a throw on a character GitHub treats as an ordinary literal would make the
oracle diverge from the thing it exists to model, which is the same failure in the other
direction. And two shapes were seen on that path and deliberately left there. **The first is
now GONE, removed by NRL-104.** It was `release.yml:179`'s `tag_name: ${{ github.ref }}`, the
full `refs/tags/<tag>` handed to a step whose adjacent `release_name` line used the bare
`github.ref_name`; NRL-79's run log showed the step receiving `tag_name: refs/tags/0.1.1`
verbatim, the resulting Release came out with the bare tag `0.1.1`, and `git ls-remote` after
the run showed no stray `refs/tags/refs/tags/...` ref, so it was harmless in practice and
still wrong by inspection, surviving only on server-side normalisation this repo does not
control. NRL-104 deleted the `actions/create-release@v1` step that carried it, and the
replacement names **no `tag_name:` at all** - deliberately, because
`softprops/action-gh-release` defaults its tag to `github.ref` and writing the key would put
the same shape straight back. `tests/release.test.ts` pins the absence by name. The
second **closed with NRL-105** (`8215bd2`, PR #153, `docs/adr/0011`'s NRL-105 amendment). It
used to read that nothing anywhere checked a pushed tag against `manifest.json`'s version or
`versions.json`'s keys, so the trigger admitted only bare semver but admitted any bare semver -
the one item on this path with a user-visible failure mode. A `build`-job step named
**`Verify the tag matches the version files`** now sits between `Install dependencies` and
`Run quality gates` and makes three comparisons against `github.ref_name`, which reaches the
body through `env: TAG:` rather than a `${{ }}` interpolation: `manifest.json`'s `version` must
equal it exactly, `package.json`'s `version` must equal it exactly, and `versions.json` must
hold that exact key with a non-empty value. It **fails loudly and rewrites none of the three
files** - a workflow that edits the version it is releasing would leave the tag, the reviewed
commit and the signed attestation describing three different things - and it reports every
disagreement rather than the first, because a tag is expensive to retry. It carries **no `if:`**
deliberately: `on:` is `push.tags` with the bare-semver filter only, so `github.ref_name` is
always the pushed tag and a condition that could silently skip would be the worse failure
(ADR 0011 decision 5). **The guard has never run on a GitHub runner.** No tag has been pushed
since NRL-79's `0.1.1`, so every behavioural claim about it is `bash -e` against fixture trees
in a sandbox on this machine, which is a weaker class of evidence than the run log NRL-79 left.
One scope limit, identified at Verify: the guard reads the **tagged commit's** three files,
while Obsidian's installer reads `versions.json` from the **repository at `HEAD`**, so a
`versions.json` edited after the tag was cut is outside what the guard can see. That is a real
limit of where the two sides look, not a defect in the step.
Correcting a claim this paragraph used to make, and that three other places made with it:
Obsidian's installer does **not** read `versions.json` off the Release. Read out of the
installed `obsidian.asar` (flatpak Obsidian 1.13.7, this session): `manifest.json`, `main.js`
and `styles.css` are fetched through `Py(repo, tag, file)` = `https://github.com/` + repo +
`/releases/download/` + tag + `/` + file, while the string `versions.json` appears **exactly
once in the whole asar** and is fetched through `Dy(repo, "versions.json")` =
`https://raw.githubusercontent.com/` + repo + `/HEAD/versions.json`, whose loop keeps the
greatest key whose value satisfies the running app version. So `versions.json` is read **from
the repository at `HEAD`**, never from the Release.
**R-M01 does not move and the `2 of 16` headline count does not move.** R-M01's binding gap is
still `srs.md:106`'s "MUST install as an ordinary Obsidian Community Plugin", which nobody has
ever observed - nothing has been installed into Obsidian from a Release - and NRL-105 does not
touch that. What closed is a hazard on the path, not the gap.
**NRL-76 is fixed** (`8797745`), and the defect it closed was worse than the ticket recorded.
The old step's `cd dist || true` plus its `if [ -f ... ]` guard did not merely hash the repo
root by accident: with one published asset missing it exited **0** and wrote a *silently
truncated* attestation - 216 bytes covering two subjects - rather than the absent one the
ticket predicted, so a green run could have shipped provenance that omitted files the release
carried. The step hashes **every** published path, and three parts of that are load-bearing.
**That set is THREE, not seven** - `main.js`, `manifest.json`, `styles.css`
(`.github/workflows/release.yml:130-133`). This paragraph used to say "all seven published
paths, including the four `ort/` WASM runtime files", and that went stale with ADR 0028 /
NRL-96, which packed the runtime into `main.js` and stopped publishing `ort/` at all; NRL-104's
`tests/release.test.ts` now pins the uploaded set at exactly those three. **Read every
`seven`-subject figure in this section as NRL-79's 2026-09-30 run and not as current
behaviour**: that run predates ADR 0028, so its attestation covered the seven files the
release then carried. What the property asserts is unchanged and is not a count - the hashed
set equals the published set, with `extractUploadedFiles` the single source of truth tying
them together. `set -euo pipefail` is not
decoration: without `pipefail` a missing asset still gives exit 0 and 720 bytes of truncated
`hashes=`, because the failing `sha256sum` sits upstream of a pipe. The non-empty guard lives
**in the build step**, and there is deliberately **no `if:` on the provenance job** - a
failing step already stops it through `needs: [build, release]`, whereas an `if:` would SKIP
provenance silently and produce a green run with no attestation, which is the same silence
being removed. **That list is two entries as of NRL-106 and both are load-bearing.** `release`
is in it purely to **order** `provenance`'s `upload-assets` job after the Release object it
attaches `multiple.intoto.jsonl` to exists; before NRL-106 the two were siblings on
`needs: build` and the attachment could have run first, which on NRL-79's one success was
avoided only by 28 s of accidental slack. `build` must stay, because the generator's input
`base64-subjects: ${{ needs.build.outputs.hashes }}` has no `needs` context to read without it. No `if:` is present on that job and **none may be added**
(ADR 0011 decision 5 of the NRL-76 amendment, which `tests/release.test.ts` still enforces).
**This has never run on a real runner**: no tag has been pushed since NRL-79's `0.1.1`, so
GitHub has never compiled the two-entry form, and that a `needs:` value may be a **list**
beside a job-level `uses:` rests on github/docs read verbatim plus SchemaStore - desk evidence,
not a run.
And the `ort/` path prefixes are safe in the SLSA input format, settled at source rather than
assumed: the generator's `parseSubjects` validates the **digest** only, and `verifyDigest`
never reads `subject.Name`. In `tests/release.test.ts`, `extractUploadedFiles` is the single
source of truth tying the hashed set to the published set, and it and `extractRunBlock` both
**throw** rather than returning empty, so a parser that stops matching fails the suite instead
of passing vacuously. **That sentence is still true and was never the whole protection; NRL-124
(`f250ddd`) added the half it missed.** A throw catches a parser that stops matching, not one
that matches the WRONG text. `extractUploadedFiles` used to take the first match of
`Upload Release Assets` or `files: |` anywhere in the file and end its capture at the first
blank line, so a comment quoting either literal hijacked the slice while `files:` stayed inside
it and nothing threw: measured at **11 reported entries instead of three**, with the slice
widening from 11 lines to 12. Both extractors now locate their step by an exact `- name:` line
at its own indentation, through a shared `extractStepText`, and end a block at the next key
indented at or shallower than it, so a `#`-prefixed line can never satisfy the match. The
throws are unchanged. This is test-only: no `src/` change, `srs.md` byte-identical, **R-M01 does
not move** and the `2 of 16` count does not move. Full measurements, including two shapes found
for the first time there, are in `docs/adr/0011-release-attestation.md`. Every number above is a local bash execution of the step body, but the
step itself is **no longer unexercised**: NRL-79's run `36785920227` ran it on a GitHub
runner, `Generate checksums` concluded success under `set -euo pipefail` with the non-empty
guard in place, and the attestation it fed carried all **seven** subjects the published set held
*on that day* - no `dist/` capture and no silent truncation, which is exactly the NRL-76 failure
shape. The same step on today's tree would carry three, per the paragraph above. One honest
limit: the literal `hashes=` value is nowhere in the run log, because the step writes it to
`$GITHUB_OUTPUT` and never echoes it, so the seven-subject decode downstream is the evidence
and the 844-byte figure stays a reconstruction rather than a reading.
One method trap from that work, recorded because mutation testing is how several tickets in
this repo establish their counts: **symlinking a shadow root defeats mutation testing**. Node
resolves symlinks, so a `__dirname`-derived `ROOT` silently resolves back to the real
worktree, the mutation is never read, and every run comes back green. Copy the bundle instead
of linking it, and sanity-mutate once before trusting a shadow.
**A second trap sits on the same technique and is a different failure, so the note above does
not cover it: a `cp -a` of a git WORKTREE carries a `.git` FILE, not a directory.** It holds
`gitdir: .../.git/worktrees/<name>`, so a git command run inside the copy rewrites the **real**
worktree's INDEX. Measured during NRL-102's Verify: a
`git checkout <mergebase> -- src/engines/onnx/kokoro.ts` inside the shadow left the real
worktree reading `MM`. The file *content* was never wrong - its sha256 matched `HEAD`'s blob
throughout - only the index entry pointed at the merge-base blob, and `git reset HEAD -- <path>`
restored it. The symlink trap makes the mutation invisible; this one corrupts the tree you are
measuring against. Give the shadow its own `.git`, or never run git inside it. **It recurred in
NRL-131's Verify on a different lane, which is why it is worth two paragraphs rather than one**:
the defence that worked there was to `tar`-copy the tree and then DELETE the copy's `.git` before
running any git command in it, confirmed by `git status --short` coming back empty in the real
worktree after every step.

**A third trap, on the technique those two serve rather than on the copy: hashing a function body
can hash the TYPE ANNOTATION instead.** Measured by NRL-131 and independently reproduced twice. A
brace-matching extractor that takes the first `{` after the function name stops at the close of an
**object-literal return type**, so for `labelClose` it hashes a 96-byte declaration containing not
one body statement. That is what `AGENTS.md`'s recorded `labelClose` hash `13030adc` is: the body
alone is 427 bytes (`92023b33`) and the whole declaration including the body is 524 bytes
(`1319d83e`). The consequence is narrow but real: a prior ticket's "proven byte-identical" claim
for `labelClose` pins the signature and the return type and **would not have caught a body
change**. **Scope, checked rather than assumed: `labelClose` is the ONLY one of the nine protected
functions whose return type is an object literal**, so it is the only recorded entry affected -
`opensMathBlock`'s `d2019f06` is a legitimate whole-declaration hash, its return type being
`: boolean {`, and a first pass that flagged it as a second instance was the probe's own error.
Note this trap compounds with the `flowDepthDelta` one recorded elsewhere in this file: an
extractor has to skip regex literals, template literals and comments **and** object-literal return
types before a body hash means what it says.
`actionlint` 1.7.7 is not a substitute for
running it: measured during NRL-69, it was silent on **both** halves of the compile defect
that had broken every run in this repo's history, so its silence on this file is weak
evidence. The `2 of 16` headline count does not move in either direction. Note also that
`release.yml` runs will keep being created and failing on pushes of refs that predate
`01c9a84`, because GitHub compiles the workflow from the pushed ref; that is expected, not
a regression, so the failure figure above grows rather than being a fixed total - 103 at
`01c9a84`, 106 by NRL-79's pre-flight.

R-M09 (configurable content exclusions) did **not** move, and the reason matters because
NRL-21's title invites the opposite conclusion. Its *configurability* half is met: all six
exclusions the requirement names have a live toggle at the spec's default, each toggle
demonstrably moves extraction in both positions, and inline code is separable from fenced
code. (Measured at `ad1027d` by bundling the real `extract.ts` and sweeping all 512
combinations of the nine content keys.) Its *reduction* half is split in two, and only one
of the two halves has moved.

The **path** half moved with NRL-46 (`docs/adr/0017`, `srs.md:309` and `:366`). A
`[[wikilink]]` or `![[embed]]` whose target had no dot in its final segment used to speak the
whole target, so a note filed under a private folder read the folder structure aloud. The
label is now the target's final path segment only, in **both** branches - the separator set is
`/` and `\`, a trailing separator falls back to the last non-empty segment, and a target of
only separators speaks nothing - and a target that is itself a bare URL is reduced to its host
with any userinfo stripped, in either position of `speakUrls`. Evidence, from bundling the real
`src/text/extract.ts` from the tree and from base `789d3c2` side by side with the repo's own
esbuild: **0 newly-spoken folder, drive or credential sentinels across 731,136 probe cells**
(645,120 in the sentinel privacy matrix plus 86,016 in the adversarial-context matrix), with
sentinel-bearing cells falling from 263,680 on base to 6,144 and every shape that still speaks
one also speaking it on base; and `sourceIndex` clean over **747,008 cells**, checked
numerically by UTF-16 code-unit index for length, monotonicity, bounds and character identity.
**Nothing was observed in Obsidian.** CDP port 9222 was unreachable during that ticket, so what
Obsidian itself displays for a folder-qualified wikilink is still unknown.

Two residual leaks on that same path half, **both closed in the 2026-09-30 batch**. They are
recorded rather than deleted because the shapes are worth knowing and the fixes are worth not
undoing.

`[[folder/Note\]]` used to speak its folder: the trailing backslash was consumed as a
CommonMark escape, so the construct was never recognised as a wikilink at all, no reduction
ran, and the raw text fell through to prose. **NRL-66** (`fee0aa1`, `docs/adr/0017` clause 8
plus an amendment section) added `wikiTargetClose`, a wikilink- and embed-local closing scan
that skips code spans and complete comment spans exactly as the shared `inlineContainerClose`
does but does **not** honour `\` as an escape, and pointed the embed and wikilink branches at
it. `inlineContainerClose` itself and its image, link and highlight call sites are
**untouched**, which is what kept NRL-66 independent of NRL-63; do not merge the two scans.
No reduction logic was needed and that was traced rather than assumed: `finalSegment`'s
trailing-separator branch already returns `Note` for the target `folder/Note\`, the emission
loop's existing skip already drops the trailing backslash, and `isFileTarget` already split on
`\`. Measured by bundling the real extractor against base `a8f45db`: **13,312 leaking cells of
15,360 fell to 0**, and `sourceIndex` was clean over 571,904 UTF-16 code units. Three
deviations are accepted rather than fixed, all measured: a target holding a literal `]]` after
a backslash now closes at that `]]` so its tail becomes prose, silent-to-audible in 3,072
cells, **every one of which already speaks the same sentinel on base in its backslash-free
form** (base parity, not a new leak class); a dangling backslash after a `#fragment` or an
`|alias` is spoken as itself (`[[a/b#Head\]]` says `b Head\`), because the trailing-separator
skip covers the path part only; and a URL target with a trailing backslash now speaks its host
where the base said nothing, credentials and path still silent.

And `[[a/b%%SECRET%%]]` used to speak `b%%SECRET%%`: a wikilink label is emitted raw so
`sourceIndex` can map every character to its exact offset, which is why `cleanLine`'s comment
branch never ran on it. **NRL-67** (`a8f45db`, `docs/adr/0021`) fixed it without giving up the
raw path. `commentSpans()` scans `[innerStart, targetEnd)` once, pairing `%%` with the next
`%%` and `<!--` with the next `-->`, and `emitWikiLabel` skips a span by **advancing `k` inside
the existing emission loop**, so every surviving character is still emitted by the same
`emit(c, rawStart + k)` and the offset mapping is preserved by construction rather than by a
second check. Four parts are load-bearing. The target is **not** routed through `cleanLine`,
whose tag branch would eat `#Section` under `stripTags`. The scan window starts at `innerStart`
and not `segStart`, because `[[a%%/%%b]]` opens the emission window on a *closing* `%%`, and
ends at `targetEnd` and not `pathEnd`, because the `#` fragment leaked too. An unmatched opener
is **target-local**: the scan is a local array and never assigns `openComment`, so ADR 0006
clause 5 holds by construction. And `isFileTarget` and `finalSegment` still classify the **raw**
target (decision Q4), never a comment-stripped view, which is what keeps the exclusion able
only to remove spoken characters: on a stripped view `![[a/b%%x.y%%]]` would lose its only dot,
become a note and **start speaking**, the silent-to-spoken direction ADR 0008 clause 5 forbids.
`[[a/b%%SECRET%%]]` now speaks `b`. Measured against base `51a20c8`: **19,456 leaking cells fell
to 0** over 43,008 hidden-class cells; the deliberately-literal class (a `%%` pair inside a
*spoken* inline code span, ADR 0019's designed behaviour) was unchanged at 1,024 on both sides,
kept as its own class for the reason NRL-44 measured; and the "only removes spoken characters"
property held over **108,992 cells with 0 additions**. One known leftover, in the removal
direction: the scan does not honour a backslash escape, so `[[a/b\%%x%%]]` now silences the
whole label where it spoke `%%x%%`, recorded in ADR 0021 because the emission loop does not
honour escapes either.

Both fixtures were **replaced in place** rather than deleted, keeping their paired
folder-is-dropped assertions - NRL-66 replaced `pin-unterminated-by-escape` and
`pin-comment-inside-target` kept its name - so the new behaviour can only change deliberately.
**Nothing in either fix was observed in Obsidian.** CDP port 9222 was unreachable throughout
that batch, so what Obsidian renders for `[[folder/Note\]]` or `[[a/b%%SECRET%%]]` is still
unknown; both decisions rest on never speaking a path (ADR 0017, ADR 0021) rather than on
renderer fidelity, and rule 11 applies in full to every number above.

The **image** half moved **partway** with NRL-63 (`0e44050`, `docs/adr/0023`), and "partway"
is the whole of it. `srs.md:313` and `:366` promise that an image's "destination and any
quoted title are never spoken", and an alt text crossing a soft line break did not honour that
(NRL-44 F9, which **survived NRL-44** because that fix made the confirmed region verbatim and
did not make the scanner recognise a construct across a break at all). A soft-wrapped image or
link label is now carried across the break by `bracketClosesLater`, which mirrors
`codeSpanClosesLater` exactly - including its `interruptsParagraph` stopping rules at both ends
- and adds one requirement of its own: the closing line's first `]` must be followed by `(` or
`[`, so a shortcut label with no destination is never confirmed and no visible prose is
silenced to close a leak that is not there. The **plain-paragraph** image and link cases are
fixed: **512/512 leaking cells fell to 0/512** for each, and the wrapped form is now
byte-identical to the single-line form, so `speakImageAlt` governs the alt text across the
break exactly as it does on one line.

**A destination is still spoken in some shapes.** Record it as **five distinct roots
and not one**, because earlier drafts of ADR 0023 and `srs.md` said "one mechanism" and a
reader who assumes it is just containers will fix two of the five and believe they are done.
**Root 4 is CLOSED as of NRL-88** (`docs/adr/0027`) and the **CONTAINER MEMBERS of roots 1 and 2
are CLOSED as of NRL-98** (`docs/adr/0029`); root 4 and roots 1 and 2 each leave named residual
shapes of their own, and roots 3 and 5 are untouched. The numbering is kept as it was so every
existing citation still resolves. The `11,520 of 19,456` headline this paragraph used to carry is
**deleted rather than updated**: it was a pre-NRL-74 baseline on a corpus nobody can reconstruct,
and NRL-88 and NRL-98 each re-measured their own rather than trying to reconcile it.

**Every count in this list is a pre-NRL-74 baseline, and roots 1 and 2 are now known to have been
single numbers over MIXED populations.** NRL-98 measured them per row and `docs/adr/0029` carries
the table; do not quote the two figures below. NRL-74 made an unmatched mid-line `<!--` literal
instead of opening a comment block, and that **unmasked 5,120 cells of root 1** which the
prose-loss bug had been hiding: a container-prefixed soft-wrapped label carrying a mid-line `<!--`
used to swallow the rest of the note, so its destination was never reached. NRL-98 re-measured
that class as its own row - 5 shapes x 2 opener forms x 512 content-key combinations = 5,120
cells, all 5,120 leaking at `e4c9c1d` and **0 at the fix** - rather than folding it in. **Re-measure
this list before reasoning from it.**

1. `interruptsParagraph` matching on the **opener** line. **CONTAINER MEMBERS CLOSED as of
   NRL-98** (`docs/adr/0029`). The recorded `2,048 of 2,048` **plus the 5,120 NRL-74 unmasked**
   was one number over three populations and must not be quoted: measured at `e4c9c1d` on a
   shape x 2 opener forms x 512 matrix, the container openers were **12,288 of 12,288 -> 0**, the
   `<!--`-bearing members of that class **5,120 of 5,120 -> 0**, the ATX heading opener
   **2,048 -> 2,048 and CORRECT**, and a TABLE_ROW opener **2,048 -> 2,048 and still a leak**
   (root 1c, NRL-109).
2. `interruptsParagraph` matching on a line **between** opener and closer. **CONTAINER MEMBERS
   CLOSED as of NRL-98**, same caveat on the recorded `1,792 of 2,048`. Measured at `e4c9c1d`:
   a container interior whose opener is in the SAME or a DEEPER container **8,192 of 8,192 -> 0**;
   one whose opener is OUTSIDE that container **10,240 -> 10,240 and CORRECT**, because
   Obsidian's `interruptParagraph` holds a `blockquote` and a `list` entry so the renderer breaks
   there too and silencing it would be prose loss; a setext underline after ONE content line
   **2,048 -> 2,048 and CORRECT**; after TWO OR MORE **2,048 -> 2,048 and still a leak** (root
   2d); a TABLE_ROW interior **2,048 -> 2,048 and still a leak** (root 2e); blank / fence / HR /
   hidden-comment interiors **4,096 of 5,120 -> 4,096 and CORRECT**.
3. `opensMathBlock`, clause 7a's separate stop - 512 of 512.
4. **CLOSED as of NRL-88** (`docs/adr/0027`). `bracketClosesLater` returned at the first later
   line bearing any `]` and tested only that one, so a line that does *not* end the paragraph
   but carries a non-closing bracket aborted the confirmation. **The recorded 3,584 was wrong
   by half**: it counts the **image** form only, and the link twin is another 3,584 through the
   same code, so root 4's real size is **7,168** on a corpus counting both kinds, and more once
   shapes the ticket's seven lines miss are added (a stray and the closer on one line,
   `[a][b]`, two pairs, a nested pair). Re-measured at `df12262` over an 11-shape x 2-kind x
   512 corpus: **11,264 cells, all 11,264 leaking -> 1,024**, so **10,240 closed and 0 newly
   leaking**. This one was never a container problem at all, which is why "just handle
   blockquotes and lists" would not have finished the ticket.
   **Three things a later reader would otherwise redo, all measured rather than reasoned.**
   (a) **Both call sites must change together.** Fixing the confirmation alone is not a safe
   subset, it is strictly worse than changing nothing: the consumption site in `cleanLine`
   closed a carried label at the first `]` unconditionally, so it ended the label at the stray
   and let the real `](dest)` fall out as prose - all 7,168 cells still leaked **and** the alt
   text was silenced. One shared helper, `labelClose`.
   (b) **It is bracket DEPTH, not "skip any `]` not followed by `(`"**, which is how the ticket
   worded it. The naive skip loses real prose: `A ![shortcut` / `more] text` /
   `and [link](dest) here` became `"A here"`, because skipping a shortcut label's own closer
   lets the scan adopt an unrelated later `](`. `guard-nrl88-shortcut-not-confirmed` is the
   only thing in the suite that catches a regression to it.
   (c) **`labelClose`'s early return at "no `]` left on this line" is load-bearing and must not
   be "completed".** It leaves a trailing unmatched `[` uncounted, which looks like an
   oversight. Completing it newly leaked in **10 of 4,000** fuzz notes and moved
   `guard-nrl63-nested-label`, because our carry takes the **first** unmatched opener where
   CommonMark takes the **last**.
   **Two residual shapes remain, both deliberate and both pinned.** A **bare unmatched `]`** on
   an interior line keeps its destination spoken and that is CORRECT: CommonMark ends a label
   there, so the construct is a shortcut reference with no definition and `](dest)` is literal
   text the renderer shows (read from the CommonMark spec TEXT, not run against a reference
   implementation, not seen in Obsidian). So the ticket's "seven such lines" is **six defects
   and one correct behaviour**. And clause (c)'s uncounted bracket, which is **one
   mechanism in THREE positions and not one shape** - corrected at NRL-88's ship review,
   where the first draft said one and pinned one. A trailing unmatched `[` on the **opener**
   line, an unbalanced `[` on an **interior** line (there the `[` IS counted, and the
   label's real closer is then eaten as the inner pair's), and a pair **straddling** the
   break. Each measures 1,024 of 1,024 cells in both kinds and each is **identical on base
   and on the fix**; all three are now pinned, and they come off together when the
   first-versus-last-opener conflict is settled, never one at a time.
5. Clause 6 and 7 precedence - a line opening both a label and a soft-wrapped code span arms
   the code carry only, and a code span opening on a later line inside a live label is not
   recognised - 1,024 of 1,024.

All five are **destination-only, fail-closed and prose-safe**: an aborted confirmation leaves
the line exactly as the pre-NRL-63 tree had it, so none of them can lose prose. Some of the
remainder is also not a defect and must not be "fixed": an ATX heading is a single line and
cannot soft-wrap, and a setext heading is already carried. **That second half is narrower than
it reads**, measured at NRL-88: what is carried is an underline sitting *after* the label has
closed (0 of 1,024 leaking, both sides). An underline *between* opener and closer is
`SETEXT.test` and therefore `interruptsParagraph`, so it is **root 2** and it leaks 1,024 of
1,024 on both sides. The ATX form leaks 1,024 of 1,024 on both sides and is correct.
**NRL-98 split that root-2 setext member by SHAPE and only one half is a defect.** Obsidian's
setext tokenizer (module 8671) eats content to the FIRST newline only, so with ONE content line
before the underline the renderer really does produce a heading plus a separate DISPLAYED
paragraph and speaking the destination is renderer-faithful - the NRL-68 outcome, now pinned by
`guard-nrl98-setext-one-content-line`. With TWO OR MORE content lines the tokenizer fails at
block start and, being gated out of `interruptParagraph` by `commonmark: true` (module 6047),
cannot interrupt either, so it is one paragraph, the image IS matched and we leak. That half is
root 2d and is NRL-109's.

**Roots 1 and 2's container members CLOSED with NRL-98** (`docs/adr/0029`), and the way they
closed is the thing to carry: `interruptsParagraph` was **not** widened. NRL-88 deferred them
because widening that shared predicate would move NRL-64's carry and collide with ADR 0019's F5
guard; NRL-98 avoided the collision by feeding the UNCHANGED predicate a different string.
`bracketClosesLater` peels at most the **opener's own quote levels** from each continuation line -
`peelQuotes(line, op.quotes)` - and runs the unchanged `interruptsParagraph` and the unchanged
`labelClose` on that peeled string, while `opensMathBlock` still takes the RAW line. Three things
about it are load-bearing. **The budget IS the compatibility rule**, not a performance bound:
Obsidian's `interruptParagraph` contains `blockquote` and `list`, so any marker DEEPER than the
opener's opens a new container and ends the paragraph, while a MISSING prefix is a lazy
continuation the renderer tolerates - so the rule is SAME OR SHALLOWER, and a deeper continuation
is rejected by the unchanged BLOCKQUOTE arm once the budget is spent. This **reverses** the
pre-flight decision, which said same-or-deeper; a blind peel silenced five shapes Obsidian
displays, measured. **Quote levels only, never the opener's list marker**, because a marker on a
continuation always starts a new item (module 745's `M` branch). And **peeling alone does not
close root 1**: the BRACKET arming guard also had to relax from `blockType === "paragraph"` to
`(paragraph || quote || list)`, measured, because for `> A ![alt` the arm is gated independently
of the predicate - a diagnostic arm with the peel at both ends and the guard untouched left all
eight container shapes still leaking. **Never "heading"**, which
`guard-nrl63-opening-line-is-list`'s unreplaced ATX sibling pins. A **callout title** opener
fails closed, because module 6234 tokenizes that first stripped line alone. What remains of
roots 1 and 2 is three NON-container shapes - a TABLE_ROW opener (root 1c), a TABLE_ROW interior
(root 2e) and a setext underline after two or more content lines (root 2d) - whose fix direction
is NARROWING `interruptsParagraph` and which therefore DOES collide with ADR 0019's F5 guard, so
they are **one** follow-up, **NRL-109**, and must be scoped the way NRL-98 scoped the peel. Root 3 is
left because clause 7a's `opensMathBlock` stop exists to fix a real prose-loss defect, and
removing it trades prose for a destination - the trade ADR 0007 clause 6 refuses. Root 5 is
clause 6's own recorded precedence rule. Neither root 3 nor root 5 has a ticket, deliberately:
each is a recorded decision rather than an open defect, so reopening either means arguing with
the reason and not just picking up a number.

**NRL-98's evidence, all bare-Node, every arm rebuilt from source against `e4c9c1d` with the
repo's own esbuild.** Fixtures: **27 checks RED before the change and 0 after** - 26 core pins in
the NRL-38 table plus one in-place replacement in the NRL-42 table - against **21 guards green on
both sides**, which are evidence of nothing and exist so the peel cannot be half-adopted into a
blind one.

**SHIP REVIEW FOUND A THIRD EDIT WAS NEEDED, and it is the thing to carry out of this ticket.**
It is counted separately from the 27 because it was red against this branch's own first revision
rather than against `e4c9c1d`, and it was found by **executing** Obsidian's remark parser out of
the installed asar - a loader pulled the webpack factories out of `app.js`, instantiated the real
Parser (module 1528) with Obsidian's own `{breaks:true, commonmark:true}` and its own math and
comment tokenizer registrations - rather than by reading it. **Once a `>` is peeled, correctness
needs `interruptBlockquote` modelled and not only `interruptParagraph`, and they are different
sets.** Read verbatim with module 6047's gate applied at `commonmark: true`:

```
interruptParagraph   thematicBreak list atxHeading fencedCode comment math blockquote html
interruptBlockquote  indentedCode fencedCode comment math atxHeading setextHeading
                     thematicBreak html list
```

Three entries were not modelled, and each silenced text Obsidian displays:

- **`math`**, which `interruptsParagraph` never covered because `opensMathBlock` is a separate
  stop (root 3) testing `raw.trimStart().startsWith("$$")` - which a `>`-prefixed line FAILS. A
  quoted `$$` block was CROSSED where the plain twin aborts. `opensMathBlock` now takes the same
  quote budget as a defaulted third parameter. The claim in the first revision's own comment, that
  keeping it byte-identical kept the stop intact, was **inverted**: it failed open.
- **`indentedCode`**, which has no arm at all and is in `interruptBlockquote` ONLY. A LAZY
  continuation - no `>` whatever - indented four spaces or led by a tab ENDS the blockquote and
  becomes an indented CODE block. The same line WITH its `>` is an ordinary paragraph continuation
  and must stay carried, which is why the new stop takes a `lazy` flag rather than testing indent
  blindly.
- **`html`**, covered only through `opensHiddenComment` (`%%`, `<!--`) where the real entry fires
  on any block tag and swallows the rest of the construct into raw HTML.

Measured before the correction, 10 shapes x 512 content-key combinations: **5,120 of 5,120 cells
of NEW prose loss, 0 pre-existing in any of them.** `> A ![alt` / `    filler` /
`> words](zdestz.png) B` went `"A [alt filler words](zdestz.png) B"` -> `"A alt filler words B"`,
while the renderer puts `words](zdestz.png) B` in a NEW blockquote and displays it. **The premise
that a blank line stops the scan, so a new blockquote cannot be reached, is FALSE** -
`interruptBlockquote` ends a blockquote with no blank line at all. `containerCarryStops(peeled,
lazy)` adds the two missing stops at both ends, **gated on a container being in play** so it
reaches only the cells the peel exposes; `HTML_BLOCK_OPEN` is a deliberately WIDE approximation
because every error it can make is fail-closed, and it excludes an autolink by requiring a tag
name followed by whitespace, `/`, `>` or end of line. `lazy` uses `/^\s*>/` and NOT `BLOCKQUOTE`,
because module 6234's whitespace skip is UNBOUNDED where `BLOCKQUOTE` caps at `\s{0,3}`, so a
six-space-indented `>` is a quote line for the renderer and must keep being carried. **9 checks
red before the two corrections and 0 after**, against 4 new counter-direction guards.

**Two shapes are PRE-EXISTING and NOT fixed**, recorded so they are not read as opened here. A
block-level HTML tag on a continuation line of a PLAIN paragraph (`A ![alt` / `<div>` /
`words](dest.png) B`) already loses that prose before NRL-98, 0 of 512 leaking on both arms;
closing it needs an html arm on the SHARED `interruptsParagraph`, which moves
`codeSpanClosesLater` and collides with ADR 0019's F5 guard, so it belongs with NRL-109. And
`opensMathBlock`'s `trimStart()` accepts a tab where the renderer's `$$` predicate skips charCode
32 only, so `>\t$$` aborts our carry and is not a math opener for Obsidian - NRL-93's family, a
different predicate, and a destination leak rather than prose loss. Two pre-existing fixtures were **replaced in place** per the NRL-66/NRL-67 convention,
keeping their names: `pin-nrl74-container-label-still-leaks-destination` (whose own comment said
its expectation must change when root 1 closes, and whose attribution of root 1 to NRL-88 is
corrected there) and `guard-nrl63-opening-line-is-list`. **No other fixture in the suite moved.**
**Three** of the four function bodies the must-not-weaken criterion names are **byte-identical**,
brace-matched out of both trees and compared by sha256: `codeSpanClosesLater` `571b6d43`,
`interruptsParagraph` `3548e825`, `labelClose` `13030adc` - **and that third figure is corrected
by NRL-131: `13030adc` is the 96-byte declaration through `labelClose`'s TypeScript RETURN-TYPE
ANNOTATION, with not one statement of the body in it. The body alone is 427 bytes and hashes
`92023b33`; the whole declaration including the body is 524 bytes and hashes `1319d83e`. The old
figure is kept here rather than silently replaced so nobody reconciling an older measurement
thinks the number changed meaning; see the method note beside the shadow-root trap for the scope,
which is `labelClose` alone.** `opensMathBlock` was the fourth and
**moves**, `7a37672d` -> `d2019f06`, for the ship-review correction above; that is a narrowing in
the fail-closed direction and it does not touch `interruptsParagraph`, so ADR 0019's F5 guard is
still green by construction. NRL-64's two-pass code block is unchanged at `e7dc204f`, and
`bracketClosesLater` itself moves from `1cf89106` to `df68d86a`.
`containerPrefix` is asserted to be an exact refactor of the inline peel rather than assumed to
be: 20,782 corpus lines, 14,267 with a non-zero prefix, **0 mismatches** of `chars`, `blockType`,
`callout`, the three derived side effects, or the iterated quote-level consumption against what
the all-levels `BLOCKQUOTE` match consumed. **That claim is INVALIDATED by NRL-131, which rewrote
`containerPrefix` as a loop, and its corpus is not reconstructable, so it must not be re-quoted.**
Four computed properties replace it; see the NRL-131 paragraph below for what they are and what
each one measured.

The destination itself was enumerated directly rather than inferred from a two-class oracle,
because a destination is an **attribute** and sits in neither the renderer's hide nor its display
class - the exact scope limit that let NRL-74's 5,120-cell class through. Over 13 container
families x 5 shapes x 512 content-key combinations = **33,280 cells, all 33,280 leaking at base
and 0 at the fix, 0 newly leaking.** Prose loss was probed with **three** instruments because none
sees everything: the 20 named guards; the **skip-path enumeration re-derived**, not cited - the
per-line loop holds exactly **20 `continue` sites** counting inline `if (...) continue;` forms,
with the confirmation at `:2530` and the write-back at `:2596`, so 16 precede the confirmation, 2
sit between, 2 are past it and **18 can bypass the arm**, and all 18 driven with a
container-prefixed label landing on them over 9,216 cells gave **0 new destinations, 0 new hidden
text, 0 newly lost displayed prose**; and a **4,000-note fuzz** x 8 sampled combinations = 32,000
cells with **0 newly leaking, 0 newly disclosing hidden text, 0 losing a prose sentinel** and 44
cells of the designed `speakImageAlt: false` alt-text class NRL-88 documented. A token-level word
diff **cannot grade this change** and the first fuzz pass proved it: the tokens it calls "lost"
are `[alt` and `](zdestz.png)`, which is the fix removing markup, so the corpus carries separate
sentinels per axis. Disclosure was re-measured in **three buckets kept apart** - genuinely hidden
text 0 of 28,672 on both sides; ADR 0019's deliberately-literal `%%` pair inside a SPOKEN code
span **2,048 on both sides**, which must stay its own bucket or it scores as a leak; and the
attribute bucket above. `sourceIndex` is clean by numeric UTF-16 code-unit index over 61,440
cells on both arms (126,976 chunks / 747,264 code units at the fix), and the checker is
**mutation-tested with every row nonzero on both sides**: drop-one 90,368 length + 416,384
identity, shift-all-by-one 61,440 bounds + 572,288 identity, swap-two 90,368 monotonic + 133,888
identity, negate-one 90,368 monotonic + 126,976 bounds.

**NOTHING WAS OBSERVED IN OBSIDIAN.** CDP port 9222 was not listening and no deploy happened, so
rule 11 applies to every figure above and the premise the whole ticket rests on - that Obsidian
renders a container-prefixed soft-wrapped image AS an image - is unverified in the app. It WAS
re-derived independently at ship review by the stronger method above, executing the shipped parser
rather than reading it, and it held: `> A ![alt` / `> words](zdestz.png) B` parses to
`blockquote > paragraph > [text, image url="zdestz.png", text]`, the destination a url attribute
and never a text leaf, and the same for the nested, lazy, bullet, ordered and task forms. Three
stated mechanisms were wrong without changing the conclusion and are corrected in ADR 0029: module
6234's whitespace skip is unbounded rather than three-space-capped, the list de-indent
`/^( {1,4}|\t)?/gm` is the PEDANTIC path and Obsidian is not pedantic, and module 9405's `]` rule
requires `(` only, the `][` form coming from a separate tokenizer. **That execution is still not
the application**: it is the READING-VIEW parser, and Live Preview's CodeMirror/Lezer parser was
not read at all. **R-M09 is NOT met** and
the `2 of 16` MUST headline count does not move: roots 3 and 5, root 4's named residuals, roots 1
and 2's three non-container shapes, and the two pre-existing image shapes
`![a [[N|l]] b](dest.png)` and `![alt](dest(1).png)` all stay open against it.

**A blockquote NESTED inside a list item is now peeled, as of NRL-131** (PR #193, squash
`04022bd`, `docs/adr/0035`, `srs.md:317`, `:328` and `:370` amended). `containerPrefix` is now a
**LOOP** - quote levels, then a callout marker if a quote was consumed in that same round, else a
list marker and its task checkbox, then round again - and **not an extra arm**. That is why the fix
went there rather than into a second predicate: `containerPrefix`'s own comment exists so there is
ONE definition of "the prefix", and `peelQuotes` derives its budget from the `quotes` field, so
fixing it anywhere else would split exactly the definition that comment keeps single. `- > x`,
`> - > x`, `- - x`, `- - > x` and `- > - > x` all reduce now, where only the un-nested forms did.
The nested `>` is **COUNTED** in `quotes`, deliberately: `peelQuotes` spends that field as
NRL-98's same-or-shallower compatibility budget, so a peel without a count would leave a
continuation line bearing the nested `>` rejected by the unchanged `BLOCKQUOTE` arm, aborting the
carry and leaving the destination leak exactly where it was. **Termination is a proof rather than
a cap**: every matcher that can fire consumes a non-empty string, so any non-breaking iteration
strictly increases `chars`, and `chars <= line.length` bounds it. There is no iteration cap and no
sticky regex, a `lastIndex` on the shared `BLOCKQUOTE` / `LIST_BULLET` constants being a live bug
since `interruptsParagraph` and the dedent pass read them too. **Measured cost is LINEAR in rounds,
not the O(prefix x length) the plan predicted**, because V8 string slices are O(1) views:
**1.0059 ms** on the non-HR worst case `"- * ".repeat(2500)` and **0.0005 ms** on a typical
`- > item text`. The worst case quoted is the non-HR twin because an HR-shaped marker-only line
never reaches the function at all - `HR.test(raw)` flushes and continues 35 lines above the call
site - which is also why the computed fixture sweep came out at zero moved fixtures.

**The fifth returned field is the part a later reader would undo, so read its reason before
touching it.** `blockType` is now `"quote"` for `- > x` where it was `"list"`, and `blockType`
**ALSO** drove `inList`, which gates the indented-code opener. So `containerPrefix` returns a fifth
field `outerList` ("a list marker was consumed while `quotes` was still 0", i.e. the OUTERMOST
container is a list) and the call site drives `inList` off THAT, with `prevContainer` still off
`blockType`. Without it a 4-space continuation under `- > x` would newly be read as indented code,
which is **new prose loss in a diff whose whole purpose is the opposite direction**.
`blockType: "quote"` itself is a **CONSISTENCY call, not a correctness one**: either value passes
NRL-98's BRACKET arming guard, which accepts `paragraph || quote || list`.

**The F1 guard is the newest code here, and critique caught it rather than the plan's corpus.**
Whitespace INSIDE the list marker's lead defeated the loop. For `- <TAB>> %%`, `LIST_BULLET`'s
greedy `\s+` ate the whole lead and round 2 ate the `>`, leaving `%%` at offset 0 of the body where
`opensObsidianBlock`'s plain line-start rule fires and `dedentedByList` is never consulted. **Base
was CORRECT** on that shape; the first implementation both silenced displayed prose and spoke
author-hidden text, **2,048 cells each way**, which is the two-directional inversion AC2 exists to
catch. The guard breaks the loop after a list marker whose consumed run past the marker's one
separating space satisfies `INDENTED_CODE`, reusing this file's own definition of the threshold so
the two cannot drift. Verify attacked it in **both** directions. **0 under-peel failures over 21
shapes**: `-  > x`, `-   > x`, `-    > x`, `1. > x`, `1) > x`, `* > x`, `+ > x`, `- [ ] > x`,
`- [x] > x`, `- - > x`, `> - > x`, `- > - > x`, `- > > x`, `- - - > x`, `2. - > x`, `- 1. > x` and
the 2-to-3-space line leads all still peel, so the guard does not quietly reintroduce the original
defect. Every **over-threshold** shape is **byte-identical to base**. And the threshold flips at
**exactly 5 spaces, not off by one**, enumerated at N=1..8 for `-`, `*`, `+`, `1.` and `1)`, which
is CommonMark's marker-plus-1-to-4 content-indent rule, the single-character discount in the guard
being the separator the marker itself requires. One row of the ticket's own under-peel list was
**WRONG and the guard is right**: `- <TAB>> x` renders as a pre/code block with the `>` VISIBLE, so
declining to peel it is renderer-faithful and the fix leaves it exactly as base does. One
divergence remains in the under-peel direction and ADR 0035 decision 7 discloses it: `- [x]` and
`- [ ]` with 2, 3 or 4 spaces then a tab are real blockquotes for the renderer (tab-stop expansion
from a 5-column marker) while we stop and keep speaking the `>`. All three of those cells are
identical on base and on the fix, so they are leftovers of the original defect rather than
regressions.

**THE SIGNED TRADE, and it belongs as prominently as the fix: this closes disclosure and OPENS
prose loss.** NRL-93's census was re-run in shape rather than replayed, because its own 140-cell
corpus is described but not enumerated in ADR 0006 and is **NOT reconstructable** (the same caveat
NRL-98's corpus carries): 10 opener positions x 14 container contexts, which also comes to 140
cells by construction. On it, **disclosure 20 -> 0 and prose loss 32 -> 58**, and `srs.md:328`'s
"a blockquote nested inside a list item (6 more)" row **does NOT close, it GROWS**, to **22 of its
50 quote-in-list cells** from 6 on base, against 16 disclosure cells on base and 0 on the fix. The
root of the growth is named rather than guessed: `opensObsidianBlock`'s `dedentedByList` term is
untouched by this change, so 16 of the new cells are NRL-118's container-blind note scope reaching
past the construct now that the opener is correctly recognised, and the rest is that boolean's own
four-column residual, exposed on a nested list item where the base peel's leftover `-` had been
blocking the predicate. **A 7,168-cell regression ships**, two rows of 4,096 at **0 -> 3,584**
each: a nested prefix plus a TAB or 4-or-more spaces before `<!--`, which Obsidian **DISPLAYS** -
its `indentedCode` block method at index 2 beats `html` at index 11 - while `opensHtmlBlock`'s
line-start term accepts that whitespace and we now hide it. **The reason it ships rather than
blocking is a measured control, taken independently twice, not a judgement call:** the un-nested
twin `> <TAB><!--` loses the same prose **ON BASE** (512 of 512, and 3,072 of 3,072 on the wider
corpus), and on the fix the nested form is **BYTE-IDENTICAL to its un-nested twin across 14,336
comparisons with 0 differing**. So the nested shapes **JOIN an already-wrong path** rather than
opening a class, and the mechanism is necessarily shared, `opensHtmlBlock` being byte-identical
across the diff. **The `%%` form genuinely does NOT regress nested** - 0 cells on every arm over 9
prefixes x 2 whitespace forms x 512 masks, for both the hidden and the displayed sentinel - and
that had to be **MEASURED**, because ADR 0035 originally asserted it without measuring and was
corrected in place before merge. What the trade buys, measured independently: a flush nested `%%`
opener speaks the author-hidden sentinel **3,584 of 3,584 cells on base and 0 on the fix**, with
every un-nested control 0 on both arms. **NRL-145 is filed for the regressing class.** ADR 0007
clause 6's preference applies here (a near-miss spoken beats a sentence swallowed), but the point
to carry is that the trade was **adjudicated on the control** rather than waved through on that
preference.

**A second residual Verify found and the PR had not named, 4d, and it is not a fourth signed
regression.** `LIST_BULLET`'s lead is an unbounded whitespace star and the F1 guard inspects only
the run PAST the marker's one separating space, so after a quote peel a later round can eat 4 or
more LEADING spaces: `- >     - x` drops a displayed `-`, **0 -> 3,584 cells**. It is a member of
the already-signed class, proven the same way the trade is: the un-nested control `>     - x` loses
that marker **512 of 512 on base**, the fix's nested output is byte-identical to that twin across
**3,584 comparisons with 0 differing**, and the prose sentinel is **never** lost (0 of 4,608
cells). `- >    - x` at three spaces is a genuine nested list for the renderer and the fix speaks
it correctly. A **documentation gap**, now recorded in ADR 0035 beside decision 7's task-marker
residual.

**What replaced NRL-98's invalidated proof, and the correction that was needed.** NRL-98's
"`containerPrefix` is an exact refactor of the inline peel, 20,782 corpus lines, 0 mismatches" is
**INVALIDATED** by the loop rewrite, that corpus is **not reconstructable**, and **it must not be
re-quoted** - the paragraph above carrying it says so in place. Four computed properties replace
it, measured against the OLD function lifted verbatim out of the merge base by a brace-matched
extractor rather than retyped, over a 10,528-line corpus (every string and template literal in all
25 test files, a hand-built nested matrix, and a 4,000-note deterministic fuzz). **(b) monotone
extension: 0 failures.** **(c) `outerList === (OLD.blockType === "list")` wherever the four old
fields agree: 0 failures.** **(d) the direction: 1,547 differing lines over 2 named shape classes
with 0 UNCLASSIFIED**, and the classifier shown falsifiable (dropping its quote arm leaves 542
lines unclassified). **(a) the pure FIXED POINT property is 309 FAILURES, not 0**, and that is not
a defect: **the F1 guard deliberately breaks it**, the guard existing precisely to stop peeling
where `iterate(OLD)` would keep going. All 309 are guard-caused and **all 309 are fail-CLOSED**,
with 0 fail-open, hand-checkable on `- <TAB>> x` (NEW stops at `chars` 3 where `iterate(OLD)`
reaches 5). ADR 0035 first recorded 0 for (a), measured on the PRE-guard implementation and never
re-run, and was **corrected in place before merge**: (a) as originally stated is superseded by the
weaker property the guard is compatible with, namely `NEW === iterate(OLD)` on every line the guard
does not stop and `NEW === OLD` on every line it does. Re-quoting 0 for (a) against a
guard-carrying tree is forbidden. (d)'s corpus is Verify's own and is distinguished in the ADR from
the implementer's 8,189 lines over 12 classes, so neither is quoted without its corpus.

**The reconciliation with NRL-120, which merged first, and this part is reusable.**
`src/text/extract.ts` and `tests/extract.test.ts` **auto-merged with no conflict**; only `srs.md`
conflicted and only by **ADJACENCY** - ours changed `:317`, `:328` and `:370`, theirs changed
`:327` only, all three stages 2,361 lines, and **no line was changed by both** - so it was resolved
as a line-wise union by a script that THROWS if any line is changed on both sides. NRL-120 did
**not** touch `containerPrefix` (its body is byte-identical on the old base and on new `main`); it
added a **new CALLER**, the setext-content forward pass, which reads `prefix.blockType` and
`prefix.chars`, both of which NRL-131 redefines for a nested line. Two consequences, both measured
rather than reasoned. That caller **fails closed on a nested line by construction**:
`isSetextContentLine`'s quote branch requires `p.chars === quoteChars`, and `quoteChars` comes from
`BLOCKQUOTE` anchored on the RAW line, which cannot match a line starting with a list marker, so an
`outerList` line satisfies neither branch and the refusal is withheld, the direction NRL-120
documents as safe. And NRL-120's `lazyInList` expression `prefix.blockType !== "list"` was shown
**provably unobservable** against the alternative `!prefix.outerList` over 15,776 cells with **0
differing**, so its line was left **byte-identical** rather than generalised on a guess. **The two
changes are SET-DISJOINT, measured**: over those 15,776 cells NRL-120 alone moves **640**, NRL-131
on the new base moves **6,496**, the merged tree moves exactly their union **7,136**, and the
**intersection is 0**. All **12** of NRL-120's own subject shapes are byte-identical on `main` and
on the merged tree across 4 option masks. One method note from that confinement probe, which is the
corpus-blindness lesson landing on the prober's own instrument: the first classifier reported 928
unclassified and was itself wrong, missing `> - > <!--` because it anchored the list marker at line
start, found and corrected before concluding.

**`opensHtmlBlock`'s body MOVED** across the merge, `e962f69f` / 59 B to `6b3bdcc3` / 79 B, **and
that is NRL-120's change, not NRL-131's**: the merged body matches the new `origin/main` exactly.
The other **8** protected bodies are byte-identical across all three trees, **including
`peelQuotes`** (`interruptsParagraph` `0212b5f4`, `codeSpanClosesLater` `43ec230e`, `labelClose`
`92023b33` as its real body, `opensMathBlock` `77f97d0a`, `opensObsidianBlock` `f3cce67c`,
`inlineContainerClose` `8da74d5f`, `wikiTargetClose` `18052772`, `peelQuotes` `b23aa85e`), and
`containerPrefix` moved `0c7d6d2f` / 1,372 B to `04a3492d` / 5,276 B as intended.
**`interruptsParagraph` was NOT widened.** `flowDepthDelta` is identical at `ec178340`, which is
this file's own extractor trap and shows the scanner is not mis-pairing the quotes inside its regex
literal.

**The limits, and they are the usual ones at full force.** **NOTHING WAS OBSERVED IN OBSIDIAN**: no
deploy and no CDP session happened for this ticket at Implement, at Verify or at the merge. Every
renderer verdict comes from the parser harness, which **EXECUTES Obsidian 1.13.7's own reading-view
parser and renderer out of the installed asar**, so it is stronger than a transcription and **is
still not the application**; Live Preview's CodeMirror/Lezer parser has never been read by any
ticket in this family. Rule 11 applies to every number above. **AC4** (updating the four
`pin-nrl115-*` tripwires deliberately) was **out of scope** because NRL-115 is still unmerged and
those fixtures do not exist on `main`, and it is handed to whoever lands it. Residual **DEST-LEAK**
families remain on the fix: **3,584 of 8,704** cells in the soft-wrapped-with-tab-interior class
and **4,608 of 9,216** in the soft-wrapped-with-mid-line-comment class, both pre-existing. And one
**user-visible widening past the ticket's headline**, renderer-verified and deliberate: `- - x` now
speaks `x` where it said `- x`.

**R-M08 and R-M09 each lose a leftover. NEITHER becomes met and the `2 of 16` MUST headline count
does not move.** What stays open against them: roots 3 and 5 in full, root 4's named residuals,
roots 1 and 2's three non-container shapes (NRL-109), the two pre-existing image shapes
`![a [[N|l]] b](dest.png)` and `![alt](dest(1).png)`, NRL-45's `[a]: x.png "%%"` leftover, NRL-93,
NRL-118 and now **NRL-145**.

One thing from NRL-63 is worth carrying separately, because it is what to re-run if anyone
widens the lookahead. Its critique found a **real prose-loss defect** and fixed it before the
commit: a `$$` display-math block between a label's opener and closer silenced the alt text
**and** still spoke the destination, because `extractChunks` consumes such a block with a
`continue` that never reaches the carry site. `opensMathBlock` fixed it, called from
`bracketClosesLater` at both ends and mirroring `extractChunks`' own test including its
later-closer search; `interruptsParagraph` was deliberately **not** widened, because it is
shared with `codeSpanClosesLater` and widening it would move NRL-64. Verify then enumerated
**all 20 skip-paths** between the carry read and the carry arm and found the rest fail-closed:
31,744 cells, 0 prose loss. **Re-run that enumeration** before touching the lookahead - and
do not reuse the number, because the region has moved. **Three different numbers have been
claimed for this one enumeration and the arithmetic below is the settled one**, re-counted at
NRL-88's ship review by stripping comments and attributing every `continue` to its owning loop
by brace depth. The per-line loop body holds **20** control-flow exits, all of them `continue`
and all of them the outer `lineNo` loop's: **16** between the carry read and the confirmation
call, **2** between that call and the carry write-back, and **2** after the write-back, which
therefore cannot drop the carry. So **18 can bypass the arm**. NRL-88's own **plan said 18 and
was RIGHT**; NRL-88's implement and the first draft of `docs/adr/0027` said 16 exits / 12
pre-arm / 14 bypass and were **low by four**, and the cause is identified rather than guessed:
that count matched `^\s*continue;$` and missed the four inline `if (...) continue` forms
(the frontmatter blank/`#` line, `inComment` with no closer on the line, `inIndentedCode` with
a blank line, and `inFence` under `skipCodeBlocks`). NRL-63's recorded **20** equals this
total-exits figure, but its prose called it the read-to-arm window, which is 16. Over 15
mid-line shapes x 2 kinds x 512 = **15,360 cells: 0 newly leaking, 0 prose sentinels lost**,
and the four paths the miscount had omitted were then probed in their own right, in both the
"after the label closes" and "between opener and closer" positions, over **4,096 further
cells: 0 newly leaking and 0 prose words lost at `speakImageAlt: true`**. So the miscount hid
no unexamined defect, which is the only reason it is a corrected record rather than a blocker.
**Fourteen of the eighteen are unreachable with a live carry** because `interruptsParagraph`
or `opensMathBlock` already matches the line, which is fail-closed by construction - that
covers the fence, the indented-code and the `inComment` paths, since a line opening any of
them aborts the confirmation. The rest need their own argument and have one: the two
frontmatter exits `continue` before the arm so never arm a carry, and the `LINK_REF_DEF` drop
additionally requires `paraText === "" && !wasPara`, which a live carry makes false.

Two pre-existing image shapes are **not** NRL-88 and remain open against the same requirement,
in **both** positions of `speakImageAlt`: a label holding another bracket construct
(`![a [[N|l]] b](dest.png)`), and `![alt](dest(1).png)`, which speaks a fragment of the
destination, `.png)`. Neither was opened by NRL-21. **Do not record R-M09 as met until roots 1
and 2 (NRL-98), roots 3 and 5, root 4's named residuals (clause 4's bare `]`, plus clause 3's
uncounted bracket in all three of its positions), and those two shapes all close**, and the
headline count stays at 2 of 16: NRL-46, NRL-44, NRL-66, NRL-67, NRL-63 and NRL-88 each closed a
leftover, not the requirement. **R-M09 is NOT met.** **Nothing in any of it was observed in
Obsidian** - CDP port 9222 was unreachable at every attempt, so rule 11 applies to every number
in this section.

NRL-88's own evidence, all bare-Node against base `df12262` with the repo's own esbuild, and
kept here because the shapes are worth knowing. **0 of 39,936 non-root-4 cells changed a single
output byte**, so roots 1, 2, 3 and 5 are unmoved cell for cell rather than merely equal in
leak count, and eight function bodies (`interruptsParagraph`, `codeSpanClosesLater`,
`opensMathBlock`, `opensHiddenComment`, `opensObsidianBlock`, `opensHtmlBlock`,
`inlineContainerClose`, `wikiTargetClose`) were proven byte-identical by hashing them out of
both trees. **Prose loss** over 18 shortcut/never-closes/bracket-only shapes x 512 = 9,216
cells, **0 losing a prose word**, with one class run down rather than waved at: 512 cells stop
speaking `ref` on `A ![sc` / `[b] more][ref]`, and `ref` is a reference NAME the single-line
branch has always consumed, confirmed by the stray form on the fix being byte-identical to the
stray-free form on base. **That `ref` class is 512 here and 256 in NRL-88's PR, and both are
right**: 256 is the `speakImageAlt: true` half, 512 is the full sweep over both positions. If
the two numbers ever read as a contradiction, it is this and not a measurement dispute. **Non-interference with all three carries** - NRL-64's `outgoingCode`,
NRL-63's own paragraph carry and NRL-74's `lastHtmlCloser` - over 19 shapes x 512 = 9,728
cells, of which **15 shapes are byte-identical on both sides** including "code+label same
line" (root 5), "all three live" and both hidden-block shapes; the 4 that moved are root-4
fixes with 0 newly leaking and 0 prose sentinels lost over 2,048 cells. **Disclosure**, since
this diff WIDENS `bracketClosesLater` and NRL-74 required the later ticket to re-measure: a
genuine hidden comment block beside a newly-armed carry, **12,288 cells per side, 0 spoken on
base, 0 on the fix, 0 newly spoken**, with ADR 0019's deliberately-literal class kept separate
at **1,024 on both sides** and the probe shown non-vacuous by a NRL-73-disqualified `%%`
opener. `sourceIndex` clean by numeric UTF-16 index over **40,448 chunks / 870,144 units** with
all four mutators firing (drop 39,936 length; shift 32,768 bounds + 667,648 identity; swap
78,848 monotonic + 77,824 identity; zero 672,768 identity), and **both exemptions shown
mandatory AND pre-existing** by removing each from a correct tree: without `text[i] === " "`
the fix reports 45,696 and BASE reports 52,224, and without ADR 0004's `equation` allow both
arms report 8,192. A **4,000-note fuzz** x 4 option sets: **0 newly leaking, 0 prose sentinels
lost, 44 leaks closed**, demonstrably able to fail since the same fuzz found the 10 newly-leaking
notes that killed the full-depth arm. And the acceptance oracle is deliberately **not** NRL-63's
wrapped-equals-single-line, which agrees in **0 of 7,168 cells on base and on the fix alike**
because the single-line form hits the out-of-scope nested-bracket defect and mis-parses on its
own - inheriting it would make a correct fix unfalsifiable in both directions.

Verify re-measured root 4 on **its own** corpus rather than replaying the ship one, and the
numbers must always be quoted with the corpus attached because there are now three: the
ticket's seven stray lines are **3,584 image-only and reproduce exactly**; the same seven over
**both kinds** are **7,168 -> 1,024**; the ship corpus of 11 shapes x 2 kinds x 512 is
**11,264 -> 1,024**; and Verify's own 14,336-cell corpus **closed 9,216 of 13,312**. A bare
total from any one of them will be read as contradicting the others.

Verify also settled claim (b) - that the naive "skip any `]` not followed by `(`" is worse than
changing nothing - **by construction rather than by argument**: it built the confirmation-only
arm and measured it **strictly worse than base**, 7,168 still leaking **and** 1,536 prose-loss
cells, which is exactly what D-88-10 predicted. That is why (b) above is not a reasoned caution.

Three smaller findings from that pass, none of them blocking and each recorded only so the next
probe does not read it as new. **A token fused to an unmatched `<!--` on a label interior line
stops being spoken at `speakImageAlt: true` too** (256 cells per kind), which looks like a new
silencing until the control is run: the stray-free form drops the same token on base, so it is
pre-existing and in the silencing direction, and the mechanism is already pinned by
`local-html-state` and `srs.md:327`. **ADR 0019's deliberately-literal class moved 2,048 ->
1,536 in Verify's corpus**, a *decrease* and therefore in the silencing direction, all of it at
`speakImageAlt: false` with the control agreeing on base - do not reconcile it against the
`1,024 on both sides` figure above, which is the ship corpus and a different one.

Two traps worth preserving, because both cost time and neither is visible from the code.
**A `sourceIndex` equation exemption must key on the synthetic TEXT, not on `blockType`.**
`extract.ts:2407` pushes the synthetic `"equation"` chunk with `blockType` `"other"`, so a
checker exempting `blockType === "equation"` silently exempts nothing and reports 8,192
identity failures on a correct tree. **A naive function-body extractor false-positives on
`flowDepthDelta`.** Its body holds the regex literal `/"(?:[^"\\]|\\.)*"|'[^']*'/g`, whose
double quotes mis-pair any tokenizer that does not know a regex literal from a string, and the
lines below it hold `"["`, `"{"`, `"]"` and `"}"` as string literals. Hashing function bodies is
the right technique - NRL-73, NRL-74 and NRL-88 all used it - but the extractor has to skip
regex literals or it will report a body that moved when nothing did.

R-M10 (speech segmentation) did not move the count either, and the reason is different
from R-M09's. Its acceptance criteria are met on the automated evidence and the evidence
is strong: NRL-28 shipped `src/text/segment.ts`, CJK splits at its full-width terminators,
the hard cap never cuts a grapheme, English is byte-identical over 4,000 generated prose
fixtures, and verification confirmed all of it against ICU and against the merge base over
corpora in the hundreds of thousands, in both segmenter positions. What is missing is not a
gap in the code, it is that **nothing was observed in Obsidian**. Two things follow, and
either alone is enough to stop the count moving. Whether `Intl.Segmenter` exists on the
Obsidian WebView at all is unknown, and the no-segmenter branch collapses CJK straight back
to one chunk, so the requirement's central behaviour may not happen on the target runtime;
calling a MUST met on bare-Node probes in that situation is exactly what rule 11 above
forbids. And the audible consequence is unheard: a 360-unit Chinese paragraph now produces
60 utterances where `main` produced 2, and a 1,200-unit one produces 200 where it produced
6. That is correct by design and `mergeShort` deliberately will not fold it, but nobody has
heard whether sixty six-character utterances sound like speech or like a stutter. So the
headline count stays at 2 of 16. Move it when someone has read a CJK note aloud in a real
Obsidian and confirmed the segmenter is there.

**The `Intl.Segmenter`-presence half of this has since closed**, on the Pixel 9 Pro XL from
NRL-96's second-device pass. `typeof Intl.Segmenter` reported `"function"` over CDP, and a
live Chinese paragraph's chunk boundaries - measured at [19, 32, 23, 18] characters for the
first four sentences of a six-sentence source - matched
`new Intl.Segmenter("zh", {granularity:"sentence"}).segment()`'s own output on that same host
exactly, rather than collapsing to one chunk. So the central behaviour this requirement
worries about does happen on the target runtime, on this device. The audible half stands
exactly as written above: nothing was listened to for tone or naturalness this pass either,
only structural facts (chunk count, word-event count, real-time `currentTime` advance) were
measured, so whether a run of many short Chinese utterances sounds like speech or a stutter
is still unheard.

One thing R-M10 does *not* cover, recorded so it is not mistaken for it. The grapheme snap
is on the hard split only: `splitOversized` snaps every cut back to a cluster boundary and
`splitSentences` does not, so a non-ASCII terminator followed directly by a combining mark
can still end a chunk inside a combining sequence. Degenerate text only, no natural prose
reaches it, and it is already written down in three places - `srs.md:376`, ADR 0009's
grapheme-safety consequence, and the comment on `splitSentences` itself.

Word granularity inside a run of Han used to sit beside that one. It no longer does. NRL-47
(`docs/adr/0014-cjk-word-granularity.md`, `srs.md:689` under R-S03) made `findWords`
subdivide a regex span containing Han, Kana or Hangul instead of leaving a whole CJK sentence
as one span, so the word highlight advances inside a CJK sentence. The evidence is bare-Node
measurement at `02cd72f` against base `d7e64df`, bundling the real modules: Chinese went from
3 chunks of 1 span to 3 of 4, Japanese from 1 span to 6, unspaced Korean from 1 to 12, English
unchanged at 15, Latin/Cyrillic/Greek/Arabic byte-identical across 15,000 comparisons, and
`sourceIndex` lockstep held with 0 failures over 65 hand-built chunks plus 4,000 fuzz strings.
R-S03 is a SHOULD, so the headline count above does not move, and that count is not what this
paragraph is about.

**Nothing was observed in Obsidian**, so do not read the numbers above as a claim that a
reader sees the fix. CDP port 9222 was refused, so no deploy-and-smoke happened, and rule 11
applies exactly as it does to R-M10. Two things specifically remain unheard or unseen. Whether
the Obsidian WebView has a word segmenter at all is the same open question R-M10 carries, and
it matters more here: the no-segmenter fallback deliberately keeps the old one-span-per-sentence
behaviour, so on a runtime without `Intl.Segmenter` the fix does not happen. And nobody has
watched a 4-span Chinese sentence or a 12-span Korean one highlight in a real editor, so
whether that granularity reads as speech or as flicker is unknown.

**Word events during a live CJK read were observed for the first time in that same NRL-96
device pass**, though not the exact per-sentence span counts the bare-Node numbers above
describe. A 4-chunk Chinese read fired 85 `word` events - far more than one per sentence -
consistent with the segmenter-based subdivision being active on a real WebView rather than
the no-segmenter one-span fallback, but the granularity was not counted chunk-by-chunk the
way the bare-Node evidence above was, and nothing was watched or listened to for whether it
reads as speech or as flicker. That half of the open question stands exactly as written
above.

Two leftovers from NRL-47 itself, from the PR rather than rediscovered later. `hasCjkScript`
covers Han, Kana and Hangul only, so Thai, Lao, Khmer, Myanmar and Tibetan still get one span
per run - they write no spaces either, and they were out of scope, not overlooked. And Korean
extraction measured 1.82x slower, 10.2 ms to 18.7 ms over 9,200 units, which is the per-syllable
grapheme cut doing its work.

R-M08 moved partway with NRL-45 (`docs/adr/0018-speak-what-the-renderer-shows.md`,
`srs.md` R-M08's excluded-syntax list). A CommonMark link reference definition renders as
nothing, so it is now dropped whole - label, colon, destination and any quoted title - by
`LINK_REF_DEF` in `src/text/extract.ts` and its one call site. Three parts of that are
load-bearing and must not be "simplified". Recognition needs the **full** CommonMark shape
on one line **and** an empty paragraph buffer (`blockType !== "heading" && paraText === ""
&& !wasPara && !wasContainer`), because a definition may not interrupt a paragraph and a
near-miss is preferred spoken over a sentence swallowed (ADR 0007 clause 6). The branch
sits **after** `cleanLine` and after `inComment = cleaned.openComment`, and that placement
is the whole of decision Q9: output exclusions do not exclude parsing, so dropping the line
before `cleanLine` ran would stop an unclosed `<!--` inside a title from hiding the rest of
the note and make text the author hid audible. Footnote definitions are deliberately **not**
covered, and that is the same rule rather than an exception - a footnote body is displayed
and a link reference definition displays nothing, so only the `[^1]:` marker goes.
`interruptsParagraph` and `codeSpanClosesLater` were deliberately left untouched, which is
what keeps NRL-45 and NRL-44 independent. Evidence, all bare-Node: **0 prose sentinels
swallowed and 0 hidden sentinels made audible across 22,528 probe cells**, `sourceIndex`
clean over **456,960 UTF-16 units** checked numerically, and 13 pre-fix failures
re-established independently. **Nothing was observed in Obsidian.**

Three leftovers from it, recorded so the paragraph above is not read as finishing R-M08.
`[a]: x.png "%%"` followed by a secret line still speaks the secret; that is pre-existing,
not opened here, and the mechanism was not run down. The second of two consecutive
definitions inside a blockquote stays spoken (decision Q8): the first line sets
`wasContainer`, so the second fails the empty-buffer half of the guard, and blocking it is
deliberate - it keeps that half honest at the cost of leaked markup, which ADR 0007 clause 6
prefers to a swallowed sentence. And a multi-line definition,
with the destination on the following line, is out of scope (decision Q7) - it has the same
per-line-scanner root as NRL-44's whole family. **Do not record R-M08 as fully met.** NRL-44
closed the literal-region family (see the NRL-42/NRL-44 bullet below), NRL-64 closed its
opening-line leftover and NRL-63 closed the plain-paragraph half of F9, but NRL-63's remainder
- five roots, of which root 4 closed with **NRL-88** and roots 1 and 2's CONTAINER members with
**NRL-98**, all enumerated in the R-M09 section above - keeps
`srs.md`'s "known gap" clause alive against the same requirement; NRL-45's own
`[a]: x.png "%%"` leftover in the paragraph above is untouched; and the 2026-09-30 batch filed
two **new** defects against R-M08 that go the opposite way, hiding text Obsidian displays.
**NRL-73** (High) and **NRL-74** (Medium) are **both closed**; both are in the last
bullet of this section. Nothing in that family has been observed in Obsidian. The headline count
stays at 2 of 16, and neither closing moves it. **Three** things remain open against R-M08, and
this list is the one to check before anyone proposes closing the requirement: the surviving
roots of NRL-63's five - roots 3 and 5 in full, root 4's named residuals (root 4 itself closed
with **NRL-88**, ADR 0027), and roots 1 and 2's three NON-container shapes (a TABLE_ROW opener,
a TABLE_ROW interior, and a setext underline after two or more content lines), which are **one
follow-up, NRL-109**, and not three, roots 1 and 2's CONTAINER members having closed with
**NRL-98**; NRL-45's `[a]: x.png "%%"` leftover in the paragraph above; and **NRL-93**, the
tab-led `%%` that our `.trim()` accepts and the renderer's spaces-only skip loop does not, which
silences a paragraph's remaining lines and a container whole (NRL-74 left it untouched by
construction, not by measurement: `opensHtmlBlock` is a second predicate beside
`opensObsidianBlock` rather than a widened one, and `.trim()` is correct for `<!--` where it is
wrong for `%%`). **NRL-95 came off this list** - a mid-line `<!--` whose only `-->` sits in a
LATER paragraph is no longer hidden; see its own paragraph at the end of this section, and read
the NRL-111 correction there before quoting its probe. Nothing in any of the three was exercised
in a real Obsidian (rule 11).

The remaining gaps are tracked in Linear. Notable reproduced defects, so you do not
rediscover them:

- The sentence and word highlights are two layers as of NRL-54 (`docs/adr/0020`,
  `srs.md` R-M13). Two `StateEffect`s and two `StateField`s, because one field that
  *assigns* its decoration set is what let the word mark erase the sentence within a
  frame; the word is drawn over the sentence, not instead of it. Four parts are
  load-bearing. **Colour cannot be what distinguishes the two layers**: both custom
  properties are written from the one `highlight.color` and both fall back to
  `--text-highlight-bg`, so they always hold the same value (measured `identical=true`
  at the default `""` and at `#ff0000`). The sentence is therefore an underline and the
  word the filled mark, and `tests/highlight.test.ts` block 11 pins that the two rules
  cannot declare the same property set - without it a later tidy-up merging them
  reproduces the original defect with a green suite, which is how it arrived the first
  time. **No `color-mix()`** in those rules: Chrome/88 computes it to nothing rather
  than degrading, so it would blank a layer on mobile only. **There are three clears
  and none is an alias for another** - ending a reading clears both in one transaction,
  advancing a word clears only the word - because `applyHighlight = applyWordHighlight`
  serving both jobs is what left the last sentence marked after every Stop, error,
  sleep-timer expiry and natural finish. And **an engine capability may gate only the
  layer it names**: `capabilities.timing` reports word timings, so it disables the word
  row and must never touch the master switch or the sentence row, or speech-dispatcher -
  the one engine where the sentence is the only possible layer - is left with no
  highlight and no reachable control.
  **Nothing was observed in Obsidian**, and here that caveat bites harder than usual,
  because the two claims that matter most are the two bare Node cannot judge: whether an
  underline plus a filled mark reads as two layers on a real theme, and whether the
  settings rows disable the way the code says. `settingsTab.ts` imports `obsidian` and
  cannot run in the suite at all, `main.ts` likewise, so the two event handlers, all
  three clear paths, `retargetHighlightEditor` and `refreshHighlightLayers` have no
  automated coverage of any kind. CDP port 9222 was refused for the whole of the work.
  Two things are shipped knowingly. `highlightPlan()` reads the *settings-selected*
  engine rather than the speaking one, so changing the dropdown mid-read can suppress a
  word mark whose timings are still arriving. And the sentence underline spans source
  that was deliberately not spoken - a skipped inline-code span, or a folder-qualified
  wikilink NRL-46 works to avoid saying - which is inherent to a span-based mark and has
  no privacy consequence, since nothing is logged or spoken and the text is already on
  screen, but the mark does assert "I am reading this" over a skipped span.
- The editor viewport follows the spoken sentence as of NRL-72 (`docs/adr/0022`,
  `srs.md` R-S03). `applyHighlightLayers` gained a third optional `scrollTo` offset and
  pushes `EditorView.scrollIntoView` onto the effects array it already had, so the scroll
  is a **third effect in the same dispatch**. That is load-bearing rather than tidy: a
  second transaction would give CodeMirror a legal intermediate state between the two
  layer updates, which is exactly the one-frame disagreement NRL-54 and ADR 0020 exist to
  prevent. The scroll fires on the **chunk event only, never per word**, deliberately - per
  word it would override a manual mid-read scroll several times a second instead of once a
  sentence, and the word is on screen anyway inside a chunk capped at 220 characters.
  `applyWordHighlight`, all three clears and `applySentenceHighlight` are unchanged and
  take no offset, so ending a reading and flipping a settings toggle mid-read both leave
  the viewport where it is. **The scroll is gated on a layer being drawn** (ADR 0022
  decision 7, `scrollTargetForChunk`), which the first implementation was not: with
  `highlight.enabled` false the chunk dispatch drew zero decoration ranges and still
  carried one scroll effect. The condition is the **disjunction** of the two layers and
  each half of it is load-bearing. `layers.word` is in it because "word drawn, sentence
  not" is reachable - three independent toggles - and the word mark lands inside that
  chunk on the next word event, which is also why the *plan* is consulted rather than the
  ranges in this transaction: at chunk time `main.ts` always passes `word: null`.
  `layers.sentence` must be able to carry the decision alone, with no reference to word
  timing, or speech-dispatcher loses the scroll along with the word row it can never have.
  And 0 is returned as an offset rather than filtered, so the first chunk of a note still
  scrolls to the top. **`y: "nearest"` WAS load-bearing and is no longer what ships** -
  **corrected by NRL-110**, which passes `{ y: "center" }`. Read the next two sentences as
  history. NRL-72 passed no options object, so "no jump when the highlight is already
  visible" was the library's behaviour rather than ours: measured in bare Node against the
  vendored `@codemirror/view`, `scrollIntoView(5)` gave one effect carrying `range.head 5`,
  `y "nearest"`, `x "nearest"`, `yMargin 5`, and in `dist/index.js` `moveY` was assigned
  only when the rect fell outside the bounding box, with the scroll gated on
  `if (moveX || moveY)`. That gate is what NRL-110 trades away: `y: "center"` takes the
  `else` branch at `dist/index.js:175-181`, which assigns `moveY` unconditionally, so a
  chunk event now scrolls **even when the sentence is already visible**. It was traded on a
  real measurement, the first this project has ever taken of the scroll on screen - under
  `"nearest"` on a Pixel 9 Pro XL in real Obsidian the spoken sentence's top sat at 973px of
  a 997px editor on every chunk from the eleventh onward, flush with the bottom edge. Only
  `y` is passed, so `x` stays `"nearest"`, and no `yMargin` is passed because the arm that
  actually runs for us never reads one. **That is geometry, not structure, and the
  mechanism first recorded for it was wrong** - corrected at NRL-110's close in ADR 0022
  decision 3, which NRL-90 must read rather than the earlier version. `side` is 1 (the
  effect carries an empty cursor range), and that kills the **middle** arm, the one guarded
  by `y == "start" || (y == "center" && side < 0)`; it is the *precondition* of the
  fall-through arm, which also reads `yMargin` and is reached when
  `rectHeight > boundingHeight`. What keeps us off it is only that a cursor rect is 19px
  against a 997px editor on the measured device, confirmed by the landing position being
  exactly `(997 - 19) / 2 = 489.0` with no `yMargin` term, 24 dispatches out of 24. So
  "passing one would be dead config" overstates it: a line taller than the viewport would
  read one. A
  `coordsAtPos` visibility test is **still not added, but the old reason is dead**: it no
  longer "duplicates what `nearest` already does", because on this path `nearest` does
  nothing. It stays unwritten purely because it needs a DOM the bare-Node suite cannot build
  (`EditorView` is never instantiated in `tests/highlight.test.ts`), so anyone wanting the
  no-jump-when-visible property back must build it and accept that the suite cannot see it. `highlight.ts` is therefore **no longer decoration-only**, and its header
  comment was rewritten rather than left lying; the guarantee that survives is the cursor,
  the text selection, the focused element and the undo history, measured as a
  byte-identical `state.selection` with `docChanged === false`. The user's scroll position
  is deliberately no longer promised.
  Evidence, **bare-Node only**: `tests/highlight.test.ts` blocks 14-16, **4 red before the
  change and 0 after** (14a effect count, 14b the target offset, 14c the `nearest`
  defaults, 14f the document-length clamp). **NRL-110 correction appended, not rewritten:**
  14c was **replaced in place** (the NRL-66/NRL-67 convention) to assert
  `y === "center" && x === "nearest"`, and it was the **one** check in the whole suite that
  NRL-110 turned red - measured red at the pre-change tree and green after, with nothing
  else moving. NRL-110 also added **14h GUARD**, green on both sides and not counted as
  evidence, pinning effect identity *and* order in the single dispatch (sentence, then
  word, then exactly one scroll, one transaction), because 14a only counted three effects
  and 14e only counted one transaction - neither forbade re-ordering the scroll ahead of a
  decoration effect. Block 17 covers the gate and is a **defect
  reproduction** rather than new capability, since the ungated scroll shipped in this same
  branch: **2 red** against the old unconditional expression staged in the block (17a
  highlighting off, 17f both rows off), 0 after, with 17b green on both sides establishing
  that zero ranges were drawn in the offending case. 17g is red there too but only because
  the function did not exist, so it is labelled new capability and not counted. This is a FEATURE, so those four are **new
  capability, not a defect reproduction** - there was no bug to reproduce. The plan
  predicted five; 14e ("one transaction") was measured **green on both sides**, because the
  old code also dispatched exactly one transaction and simply put no scroll in it, so it is
  relabelled a guard rather than conjoined with 14a to manufacture a red. Blocks 15 and 16
  and checks 14d/14e/14g are all guards, green both sides, and are not counted.
  NRL-72 itself recorded **NOTHING WAS OBSERVED IN OBSIDIAN** - no deploy and no CDP
  session - and that sentence is kept as history because the reasoning around it still
  stands: a bare-Node assertion that a `StateEffect` with `range.head === 18` rode on the
  transaction is **not** evidence that a user sees the view move.
  **NRL-110 changed that, and this is one of the few things in this file that WAS exercised
  in a real Obsidian.** On a Pixel 9 Pro XL (Android 17, WebView Chromium 154), real
  Obsidian, `AcceptanceTest/ScrollAcceptance.md` (16,211 characters, ~9.5 screens against a
  997px editor), source mode, sampling `scrollDOM.scrollTop` and
  `coordsAtPos(chunk.sourceStart).top` relative to `scrollDOM`'s own box on every chunk
  advance: the baseline `y: "nearest"` build pinned the spoken line's top at **0.976 of
  `clientHeight`** (973px of 997, flush with the bottom edge) on every chunk from 11
  onward, and the shipped `y: "center"` build pins it at **0.490** (489px of 997, 508px of
  context below) on every chunk from 5 through 23, with chunks 0-4 clamped at the document
  top because centring them would need a negative `scrollTop`. A hook on
  `EditorView.dispatch` confirmed every scroll effect as `y "center"`, `x "nearest"`,
  `yMargin 5`, in a three-effect single dispatch. **Both series were independently
  reproduced to the digit by a second agent** on its own build of the merged commit,
  including re-measuring the baseline by reverting the one argument in a copied shadow root
  and pushing that build to the device - so the numbers are not one agent's run replayed.
  **Three limits stay open and must travel with those numbers.** Desktop **feel** - whether
  recentring on every chunk reads as comfortable tracking or as the page twitching every
  two seconds - has been watched on no platform by anyone; a `scrollTop` series is not a
  person looking at a screen. Whether Obsidian's own **desktop** editor extensions
  intercept or override the scroll effect is untested, CDP 9222 being unreachable, so the
  Android evidence rests on exactly one stated ground: both platforms run the same bundled
  `@codemirror/view` `scrollRectIntoView`. And NRL-72's **Live Preview** premise is
  untouched - whether folds and widgets put `chunk.sourceStart` at the screen position a
  plain-text offset implies - because all measurement was in source mode. One artefact is
  recorded in ADR 0022 rather than here: two early post-fix runs scrolled not at all right
  after a `disablePlugin`/`enablePlugin` reload, cause **unidentified**, not reproduced
  from a clean state by either the implementer or the independent re-measure, and not
  attributable to this change. The sentence that used to sit here - "**Not solved, and
  an explicit follow-up:** nothing detects a manual mid-read scroll, so one is overridden
  at the next sentence boundary" - is **no longer true in either half** and is corrected
  rather than left standing: NRL-90 added the `scrollDOM` detection and the suppression
  policy, so see the NRL-90 bullet below for what detects it, what the policy is, and the
  one case in which a scroll event is still misattributed.
  R-S03 is a SHOULD, so the `2 of 16` MUST headline count does not move.
- A note switch mid-read no longer drags the highlight or the NRL-72 scroll onto the
  wrong document, as of NRL-89 (PR #116, `2b4c18a`). This is a **separate** gap from the
  manual-scroll one the bullet above used to carry as "not solved" and NRL-90 has since
  closed - that one is about a manual scroll *within* the note being read getting
  overridden, this one is about a **different note entirely** getting decorated and
  scrolled - and NRL-89 closes only the second. Before it, nothing
  in the plugin listened for `active-leaf-change` at all, so the chunk/word handlers'
  `if (!this.activeEditor) return;` guard kept pointing at whichever editor
  `retargetHighlightEditor` last touched: the note a read STARTED on, not the one now in
  front. Before NRL-72 that only drew a stale decoration on the wrong document, odd but
  passive; after NRL-72 the same path also moved that document's viewport, an active
  disturbance of a note the user switched to for their own reasons. `shouldHighlightLeaf`
  (`src/ui/highlight.ts`) is the pure decision a new `active-leaf-change` listener in
  `main.ts` (`handleActiveLeafChange`) consults: a leaf earns the highlight and scroll only
  while its file matches the in-flight read's path **and** a read is actually in flight.
  `readingFilePath` alone cannot answer that: `Player.getFilePath()` is deliberately not
  cleared by `stop()` (`player.ts:147-171`), so a finished or stopped read still names its
  note by path long after nothing is in flight, and without the `readingInFlight` gate a
  return visit to that same note would re-arm a dead reading's highlight. On a match,
  `handleActiveLeafChange` resumes decorating and scrolling immediately via
  `renderChunkHighlight(player.getChunk(player.getIndex()))` rather than waiting for the
  next chunk event, which could be seconds away; on a mismatch while a read is in flight,
  `suspendHighlightEditor` clears both layers and drops `activeEditor` so the existing
  per-handler guards do the suppressing for as long as the mismatch lasts.
  `renderChunkHighlight` is the prior inline `player.on("chunk", ...)` body, extracted
  verbatim (diffed line-for-line byte-identical) so the normal chunk-advance path and this
  reattach path cannot drift apart. Word-level highlighting is deliberately not replayed on
  reattach - only the sentence layer redraws, the same precedent `refreshHighlightLayers`
  already set elsewhere - so the word mark catches up on the next natural word event.
  Evidence, **bare-Node only**: `tests/highlight.test.ts` block 18, 6 checks pinning
  `shouldHighlightLeaf` across the match / different-file / not-in-flight / non-markdown-leaf
  / no-read-started / neither cases; no failing-before count is claimed because the function
  did not exist before this change, so this is new capability pinned fail-safe, not a
  reproduced-then-fixed defect. **NOTHING WAS OBSERVED IN OBSIDIAN.** No deploy and no CDP
  session happened for this fix, so two premises the commit message names as unconfirmed
  stay unconfirmed here too: whether Obsidian reuses one CodeMirror `EditorView` per pane
  across a same-pane file switch, and whether `leaf.view` can still be a `DeferredView`
  rather than a loaded `MarkdownView` at the moment `active-leaf-change` fires - the
  `instanceof MarkdownView` check fails closed in that case, which is under-highlighting,
  not the wrong-note failure mode this fixes, so the failure direction stays safe either way
  but the premise itself is unverified. R-S03 is a SHOULD, so the `2 of 16` MUST headline
  count does not move, and this bullet does not touch the manual-scroll follow-up recorded
  in the bullet above, which NRL-90 closed separately.
- **A manual scroll made mid-read is detected and respected as of NRL-90** (PR #127,
  `fe867f8`, plus this ticket's follow-up; `docs/adr/0030`, `srs.md` R-S03). A `scroll`
  event on `editor.scrollDOM` that the plugin's own dispatch did not cause latches
  suppression on that editor, and `scrollTargetForChunk` then returns `null` so the chunk
  dispatch carries no scroll effect at all. Suppression lapses only when playback restarts
  (`resetScrollSuppression`, called at all three read-start sites and deliberately **not**
  on the NRL-89 leaf-reattach path, since reattaching to a note whose read is still in
  flight is not a fresh `play()`). Attribution is a read-and-clear boolean armed
  immediately before a scrolling dispatch, not a timer and not viewport arithmetic: ADR
  0022 decision 3 forbids `coordsAtPos` in this file and the bare-Node suite cannot
  instantiate an `EditorView`. No timer, no sentence count and no toggle - all three were
  considered and rejected in ADR 0030.
  **The follow-up shipped one line**, `expectingOwnScroll.delete(editor)` inside
  `resetScrollSuppression`, and the defect it closes is worth stating because it reverses
  what two ADRs predicted. `applyHighlightLayers` arms the flag before every scrolling
  dispatch, but a dispatch does not always move the DOM: `scrollRectIntoView` passes its
  `if (moveX || moveY)` gate at `node_modules/@codemirror/view/dist/index.js:200` and then
  has its `cur.scrollTop += moveY / scaleY` write **clamped** by the browser at `:207-209`
  (the `scrollLeft` twin is the next four lines, `:211-214`),
  and a `scrollTop` write that changes nothing fires **no `scroll` event**. So the arm
  survives unconsumed, and before this line it survived a playback restart too and
  swallowed the first genuine user scroll of the next read - contradicting
  `resetScrollSuppression`'s own claim to restore normal follow behaviour. Reproduced in
  bare Node against the real `src/ui/highlight.ts` before anything was changed; `19h` and
  `19i` in `tests/highlight.test.ts` block 19 are red against the unfixed function and
  green after, with four guards and one tripwire green on both sides and labelled as such.
  **F1 is REACHABLE, and the earlier "measure-zero" reading was wrong.** That expectation
  came from **`docs/adr/0022`'s NRL-110 amendment at `:313-317`** and from NRL-90's
  pre-flight triage note, **not** from ADR 0030 - an earlier draft of this bullet and of
  ADR 0030's own amendment attributed it to ADR 0030's Consequences, and that section
  contains no occurrence of `center`, `NRL-110`, `F1` or `measure-zero` at all, which is
  unsurprising since ADR 0030 predates NRL-110. Get the attribution right or a reader goes
  hunting for a sentence that is not there. The reasoning itself was that the `center` arm
  computes `moveY` unconditionally, so the gate almost never zeroes; it stops at the gate
  and misses `movedY` **seven lines later**; `moveY != 0` with the DOM not moving is
  ordinary. Both ADR 0022 and ADR 0030 are corrected in place rather than left standing,
  and the superseded reading must not be restated. The strongest evidence was already in the repo: NRL-110's own post-`center`
  on-device series at `docs/adr/0022:240-249` records chunks 0-4 holding `scrollTop` 0,
  **five of twenty-two dispatches moving the DOM by zero**, at the opening of every read.
  Three further reachable cases are named in ADR 0030; R2 (a note's tail) and R3 (a note
  shorter than the viewport, taking the parent walk at `index.js:152-155`) stay **reasoned,
  not measured**.
  **The residual is accepted, not fixed, and the reason is fail-direction.** Clearing the
  arm on a microtask or a single animation frame would land before the scroll event exists,
  because CodeMirror does not scroll inside `dispatch` (`index.js:7714-7715` requests a
  measure, `:8003-8005` schedules it on `requestAnimationFrame`) and the native event is
  asynchronous after that write. It would read every one of our own scrolls as a user
  scroll and kill auto-scroll from chunk 1 - fail-closed. F1 is fail-open and costs exactly
  one swallowed `scroll` event, because the flag is a single read-and-cleared boolean, so a
  gesture emitting two or more events still latches. `19n` pins both halves as a tripwire.
  Build on the NRL-110 decision-3 correction recorded above rather than the superseded
  `side === 1` reasoning.
  **The one-liner is not purely fail-open either, and that cost is now written into
  ADR 0030 rather than living only in PR #157's body.** `expectingOwnScroll.delete` opens a
  narrow **fail-closed** window that did not exist before: CodeMirror writes `scrollTop` off
  its own `requestAnimationFrame` and the native `scroll` event arrives at the next
  rendering update, so a read restarting **inside that gap** deletes the arm and the still
  pending event from our own scroll latches suppression at the start of the new read. Before
  the fix the surviving arm absorbed it - which was the defect - so this is the fix's own
  cost, not a pre-existing shape. It is bounded to **one read** (one DOM move produces one
  event, measured, so at most one is ever pending and the next restart clears it) and needs
  **two user actions inside one rendering update**, which a human cannot produce by hand.
  Note the bound's units: "about one animation frame" is a **60Hz-unloaded** figure, and the
  real bound is one rendering update, which stretches with frame time under load - and this
  device demonstrably stalls. Still one read, so the conclusion holds and the number does not.
  **OBSERVED IN A REAL OBSIDIAN, for the first time for this feature, on Android** - so
  ADR 0030's original "NOT VERIFIED IN OBSIDIAN" is superseded for these four facts and
  stands for everything else. Pixel 9 Pro XL, Obsidian WebView Chrome/154, vault
  `AcceptanceTest`, `ScrollAcceptance.md`, driven over `adb forward tcp:9333` with a probe
  hooking `EditorView.dispatch` and counting native `scroll` events on the same
  `scrollDOM`. **F1 observed, not inferred**: four consecutive opening chunk dispatches each
  carried a `y: "center"` scroll effect (heads 2, 21, 128, 290) with `scrollTop` **0 before,
  0 two frames after and 0 at 100 ms**, and **zero native scroll events** across the whole
  window. **The falsifiable prediction came out favourable**: one real touch drag through
  CDP `Input.synthesizeScrollGesture` emitted **54, 46 and 33** native `scroll` events on
  three gestures, so swallowing one has **no user-visible consequence under a gesture** -
  which is why **no follow-up ticket is filed** (the exposure is a single-event scroll
  source only, and a programmatic `scrollTop +=` is exactly that, so the worst case is real
  but narrow). **The feature works**: after a 54-event gesture moved `scrollTop` 0 -> 400
  mid-read, the next two chunk dispatches carried two effects and **zero** scroll effects and
  `scrollTop` held at 400 while the read advanced from chunk 4 to 6. **The one-liner measured
  on both sides**, same device, same note, same sequence, only `main.js` differing: before,
  the restarted read's chunk dispatch carried a scroll effect at head 2 and dragged
  `scrollTop` **300 back to 0**; after, it carried **zero** scroll effects and `scrollTop`
  held at **300**. And a restart does restore follow - with suppression latched, a fresh read
  dispatched scroll effects again at heads 2 and 21.
  **All three of those were then re-measured by a second agent rather than replayed, which is
  rare enough in this repo to be worth saying.** **M1 confirmed independently**: two
  consecutive opening chunk dispatches each carried a `y: "center"` scroll effect (heads 2
  and 21) with `scrollTop` **0 before, 0 synchronously after, 0 two frames after and 0 at
  300 ms**, and **zero native `scroll` events over 72 s**. **M2 came out stronger than the
  first pass**: **47, 53, 53, 54, 56, 98 and 223** events across **seven** gestures, **four
  of them real OS-level touches via `adb shell input swipe`** rather than CDP synthesis -
  minimum **47**, never 1 - so F1's accepted residual costs **one swallowed event out of
  dozens**. **M4 confirmed single-variable**, with the pre-fix side built in a copied shadow
  root by removing only the one-liner so the worktree was never touched: before, `scrollTop`
  dragged **300 -> 0**; after, **16 dispatches, 0 scroll effects, `scrollTop` held at 300**.
  **Two method traps from that device work, recorded so they are not re-learned.** Clearing a
  stored reading position with `plugin.saveData()` alone is **not enough** - the in-memory
  `plugin.pluginData.positions` is re-saved over it and the read resumes at the stored index
  (observed resuming at **chunk 29**), silently invalidating any series meant to start at
  chunk 0; it must be emptied in memory too. And the arbitrary-CDP helper's `send` mode
  **hangs and the gesture silently does not fire** without a preceding `Runtime.evaluate` on
  the same socket - three runs returned zero events and no error, which reads as "the gesture
  produced nothing" rather than "the gesture never happened". Use the `seq` form with a
  leading eval, or `adb shell input swipe`, which is both more real and more reliable.
  **Limits.** `main.ts` imports `obsidian` and has no bare-Node runtime, so the three
  register/reset call sites and the `isScrollSuppressed` read are **unexercised by
  `npm test`**. The suite invokes the captured handler directly, so real event timing
  relative to CodeMirror's measure pass and whether `scrollDOM` is the element Obsidian
  actually scrolls are still uncovered by it - the amended KNOWN GAP comment at the end of
  block 19 states exactly that. **Desktop is unobserved**: CDP port 9222 is unreachable in
  this environment and the Flatpak Obsidian must not be restarted, so every on-device figure
  is Android-only. Nothing was listened to or watched for feel. One unrelated thing recurred
  three times and is NRL-101's, not this ticket's: a `read-note` after a stop left the player
  in `preparing` indefinitely until a `disablePlugin`/`enablePlugin` cycle, on the pre-fix and
  post-fix builds alike. R-S03 is a SHOULD, so the `2 of 16` MUST headline count does not
  move.
- **The floating control bar is reachable and touch-sized on mobile as of NRL-112** (PR #164,
  `0455aa9`, `docs/adr/0032`). The bar used to be `position: fixed; top: 0` with no mobile
  branch anywhere in the UI layer, so on a phone it sat behind the device safe-area inset and
  Obsidian's own view header, with 28x28 transport buttons and 20x20 speed buttons against
  `srs.md:1768`'s touch-target MUST. The fix is **CSS only** under `body.is-mobile`: `top:
  calc(var(--safe-area-inset-top) + var(--view-header-height))`, which on the Pixel 9 Pro XL
  resolved to **110.333px** from two Obsidian-owned variables measured on device
  (66.333336 + 44), and `min-width`/`min-height: 44px` on all seven controls (authority:
  Obsidian's own `--input-height`, measured at 44px on that device). `src/ui/controlBar.ts`,
  `src/ui/affordances.ts` and `src/engines/platform.ts` are untouched, there is no `Platform`
  import under `src/ui/`, and `PlatformFlags` was deliberately not widened.
  **The methodological finding here is worth more than the fix, and anyone "simplifying" the
  verification would re-open the defect with a green result.
  `document.elementFromPoint()` is the WRONG ORACLE for whether a control is reachable.** On
  the pre-fix broken layout it returned the correct button at **all seven** control centres,
  while real OS-level `adb shell input tap` touches at **three** of those centres (play/pause,
  **stop**, faster) did **nothing at all** - state stayed `playing` / 18 / 1.5 throughout -
  with a positive control proving the taps reached the WebView at all (an editor tap moved the
  cursor head 530 -> 2200 and focused `.cm-content`). `stop` is the decisive control to tap,
  because a landed tap gives `idle` unambiguously where play/pause can be confused with a
  double toggle. Verify a touch target by tapping it through the OS, never by hit-testing it
  from inside the page.
  On-device evidence for the fix: all seven controls **44 x 44**, wrapped into **3 rows**,
  `scrollWidth 222 == clientWidth 222`, occupying x 112 -> 336 of 448; **all seven real taps
  landed** (play/pause `playing`->`paused`->`playing`, next `14`->`15`, previous `15`->`14`,
  faster `1.50`->`1.55`, slower `1.55`->`1.50`, replay held index 16 with `currentTime`
  6.80 -> 0, stop -> `idle`); `audio.playbackRate` exactly 1.5, so non-negotiable 9 holds; and
  **R-M14 survived** - all four affected controls stayed present at 44 x 44, `display: flex`,
  `visibility: visible`, reachable, `disabled: true`, opacity 0.45, `cursor: not-allowed`, with
  the reason in `title`, so the relayout disables rather than hides.
  **`flex-wrap` does the work, not the `max-width` clamp.** The clamp computes 432px against a
  bar that settled at 224px, because a `position: fixed` shrink-to-fit box with `left: 50%` /
  `right: auto` only gets `100vw - left`. The ~464px content-sum arithmetic in ADR 0032 and in
  `styles.css` establishes that the content cannot fit on one row; it is **arithmetic, not the
  observed cause of the wrap**, and must not be quoted as the latter.
  The staleness guard is what makes those figures trustworthy and is worth reusing: exactly one
  injected `<style>` holds the plugin CSS, and `.includes("is-mobile")` flipping false -> true
  was checked **before** any rect was measured. Verify additionally caught the device running a
  7,867-byte pre-correction stylesheet when the committed file is 8,366, redeployed, and
  re-measured against the committed bytes.
  **Desktop is unobserved** - CDP 9222 was unreachable for the whole run - and rests on a
  **zero-deletion diff** (`styles.css` 66/0, `tests/highlight.test.ts` 171/0,
  `git diff --name-only -- src/` empty) plus `body.is-mobile` being unable to match on desktop.
  Also unestablished: tablet, a ~360 CSS px phone, landscape, and the view-header-disabled case.
  One confirmed overlap came out of Verify and was **filed as NRL-129, not fixed here**: on an
  unscrollable note (`scrollHeight 997 == clientHeight 997`) the first chunk's sentence mark
  measured y 209.6-255.6 against a bar bottom of 236, so 26.4px of its 46px height sits behind
  the bar in the band x 112-336, and `y: "center"` cannot help because there is nowhere to
  scroll. ADR 0032's "neither direction was observed" was corrected to say so. **NRL-129 has
  since CLOSED it** - see the next bullet, and read its pre-fix figure (46 of 46px occluded on
  its own note) rather than this one, because how much of the mark the bar covers depends on
  where that note's first line sits.
  **No requirement moves and the `2 of 16` MUST headline count does not move.** `srs.md:1768`'s
  touch-target MUST is satisfied on the one device tested, but R-M07 is a MUST about exposing
  the five transport controls and was never on the met list; this fixes the bar's reachability,
  which is a necessary part of it rather than the whole.
- **The mobile editor reserves the control bar's band as of NRL-129** (PR #180, `04a95b8`,
  `docs/adr/0032`'s NRL-129 amendment). The defect was NRL-112's own leftover above: 44px touch
  targets made the bar wrap to three rows, so it grew from 41px to 125.64px and its bottom edge
  moved to about y 236, while NRL-110's `y: "center"` cannot rescue a note too short to scroll
  because there is nowhere to move the sentence to. The fix is **one declaration**, a mobile-only
  `padding-top` on the editor **PANE**:
  `body.is-mobile.local-tts-control-bar-visible .view-content > .markdown-source-view.mod-cm6`.
  **The pane and not the scroller**, and that is load-bearing rather than taste: Obsidian 1.13.7
  already owns the phone scroller's `padding-top` at specificity **(0,7,0)** (`app.css:20426`),
  `padding-top` is ONE property so a rule there **replaces** that host value rather than adding
  to it, and its base differs by configuration. `.markdown-source-view` in this position carries
  no padding declaration, so our rule is uncontested at (0,5,1). The `.view-content >` child
  boundary is load-bearing too, because `app.css:11953` pads a NESTED source view and a
  descendant selector would pad every inline embed and table-cell editor for the duration of a
  read. The height is **published by JS** as `--local-tts-control-bar-height` from the bar's
  `offsetHeight`, in the same `refresh()` statement group that toggles `.is-visible` so the two
  can never disagree, **because CSS cannot ask how many rows `flex-wrap` produced** - a frozen
  row count under-pads a narrower phone (the defect partly returns) and over-pads a tablet. The
  two string names live in a new DOM-free, `obsidian`-free `src/ui/controlBarCss.ts` so the
  bare-Node suite can pin that the TypeScript and the stylesheet agree.
  **On-device evidence, and it is unusually strong for this repo because BOTH ARMS were measured**
  on a Pixel 9 Pro XL (Android 17, Obsidian WebView Chromium 154) over `adb forward`, the pre-fix
  build still being on the device rather than merely cited. Pre-fix the sentence mark's top sat at
  **185.61** against a bar bottom of **235.97**, so **46 of 46px occluded** - worse than the
  26.4 of 46 NRL-112 recorded, because that note's first line sits higher. Post-fix **311.61**,
  so **0px occluded with 75.64px clearance**. Published height **126px** and pane `padding-top`
  **126px**, matching the integer-rounding prediction exactly. All seven control-bar buttons
  landed real `adb shell input tap` presses with an editor tap as the positive control and `stop`
  giving `idle`, and `audio.playbackRate` was exactly 1.5, so non-negotiable 9 holds.
  **Two arithmetic-only predictions were then measured and both held.** NRL-110's `y: "center"`
  landing moves from 489.0 to **552.01 measured** against 551.8 predicted, the 0.21 being the
  integer 126px publish against the 125.64 the arithmetic used - so **489.0 is a desktop /
  bar-hidden figure from here on**, and ADR 0022 and NRL-110's own series stay correct for those
  conditions. And NRL-90's named residual gave **exactly 1** clamped scroll event on bar-hide
  (`scrollTop` 9731 -> 9605, -126) which did **not** survive into the next read (9605 -> 0), with
  zero scroll events across the short-note read.
  **The staleness guard is what makes those rects trustworthy**: exactly one plugin `<style>`,
  `textContent.length` **12538 == the committed byte count**, and
  `local-tts-control-bar-visible` flipping false -> true, all asserted BEFORE any rect was read.
  **The desktop negative was established with a positive control**, not reasoned from the
  `body.is-mobile` gate: injecting the committed stylesheet into the live desktop page gave
  **0px** padding even with the class present and 126px forced, and **126px** only once
  `is-mobile` was added. Reverted after.
  **One NEW finding came out of Verify and the ADR carries it too: the height publish is
  two-staged.** It reads **109px** during `preparing` - the bar's hidden-state height, 16.64px
  short - then **126px** at `playing` about 14.5 s later. During that window
  `barTop + 109 = 219.33` against a bar bottom of **235.97**, so the clearance guarantee is
  **narrower than the ADR's derivation claims**; what saved it on this device is 75.28px of
  unrelated slack. Measured clear in **both** stages, so acceptance holds. This is a
  start-of-**every**-read case and is DISTINCT from the mid-read-rotation residual the ADR
  already records.
  **The limits are real and travel with every number above.** `src/ui/controlBar.ts` imports
  `obsidian` and has no bare-Node runtime, so the publish, its `> 0` guard and the `destroy()`
  teardown have **no automated coverage of any kind** - only the two string names are pinned, and
  the eight new red-before checks assert `styles.css` as **text**. Reading view is **deliberately
  unpadded** (`.markdown-preview-view` gets no rule, the highlight being a CodeMirror decoration
  that does not exist there), so the bar can still overlay preview text. A mid-read rotation
  leaves a stale published height until the next player state event re-runs `refresh()`. The
  view-header-disabled case compounds with this ADR's existing `--view-header-height` residual
  and can still leave up to **44px** occluded. Tablet, a ~360 CSS px phone and landscape are all
  unobserved. And **nobody watched the screen** or judged whether the reserved band feels right -
  everything above is machine measurement over CDP and adb, so rule 11's human half is unmet.
  **No requirement moves and the `2 of 16` MUST headline count does not move.** R-S03 is a
  SHOULD, and R-M07 was never on the met list.
- A selection-scoped read clips its queue by **scanning** `sourceIndex` as of NRL-57
  (`src/audio/clip.ts`, `srs.md` R-M11). This defect was not recorded here before, and it
  shipped inside NRL-52. The deleted expression was `textStart = from - chunk.sourceStart`
  in `main.ts`: subtracting one raw offset from another is only right while one raw
  character produces one spoken character, and markdown stripping is exactly what breaks
  that, so the slice slid by however many characters had been stripped. Measured at
  `bbe37f3` by bundling the real `extract.ts`, `segment.ts` and `words.ts` with the old
  clip transcribed verbatim: selecting `bold` out of `Before **bold** after.` spoke
  `ld a` mapped [11,17), 2 offsets outside the selection; selecting `after` in the same
  note spoke `r.`, 1 outside; selecting `label` out of `Before [label](destination)
  after.` spoke `abel `, 1 outside; and selecting `hidden` out of `Before %%hidden%%
  after.` spoke `ter.` mapped [20,24), 4 outside - text from outside the selection
  entirely. The scan compares with `<` against the selection bounds and never searches for
  an exact offset, because `sourceIndex` is non-decreasing but **not** strictly
  increasing: `mergeShort`'s synthesised join space can take the same offset as the entry
  before it. **The load-bearing warning is about the test, not the code.**
  `note[sourceIndex[i]] === text[i]` was GREEN on the bug, 0 mismatches on all four cases,
  because the old clip sliced `text` and `sourceIndex` by the same wrong window, so
  character identity survived while the window was wrong. That assertion passing is how 73
  green checks in `tests/readSelection.test.ts` hid this through PR #58, and it is kept
  only as a guard, explicitly labelled one. That file no longer holds a 37-line copy of the
  implementation; it imports the real symbol, which is the other half of why it could not
  fail. Evidence: 17 checks red against the old algorithm staged in the new module (16
  C-cases plus the point-selection case), 0 red after, with every check that was green on
  both sides relabelled a guard rather than counted. One **user-visible behaviour change**:
  a selection holding only content extraction excludes now shows "No text in selection."
  and starts no playback, where it used to speak whatever the miscomputed slice landed on.
  **Nothing was observed in Obsidian** - no deploy and no CDP session happened during this
  work - so the two host-side halves are unverified: that `read-selection` still appears in
  the palette only with a selection, and that the Notice appears in the real UI. This does
  **not** move the `2 of 16` MUST count. R-M11 was never on the met list, `main.ts` still
  has no runtime in the suite, and rule 11 applies.
- Rename and delete handlers exist as of NRL-51: `this.app.vault.on("rename")` and
  `("delete")` in `onload`, both through `registerEvent`. One path-boundary-safe prefix
  sweep covers stored positions for files and folders with no type branch. Repeated events
  for an already-moved or dropped prefix are no-ops. The sweep lives in `src/settings/data.ts` as
  `moveReadingPositions` / `dropReadingPositions`, not in main.ts, because main.ts cannot
  run in the suite at all. Both handlers assign a new map to the `positions` *field*; the
  root container is never rebuilt.
  **A rename or a delete stops an in-flight reading of that note, and the comparison is
  against `oldPath` / the deleted path, not the new one.** Both halves are load-bearing.
  The queue is not retargeted - `SpeechChunk.id` hashes `filePath`, so rewriting it without
  recomputing the id would desynchronise the field from its own definition - and the queue
  therefore keeps reporting the *old* path until the next `play()`. So a handler that
  compared `newPath === player.getFilePath()` would never fire, and one that skipped the
  stop would let the next progress event write the old key back, recreating the orphan the
  handler just cleaned. The cost is user-visible: the audio stops.
  **Both of NRL-51's two residual gaps closed with NRL-58**, and the paragraphs that said
  they were open have been deleted rather than appended to. There is now **one** predicate,
  `covers`, exported from `src/settings/data.ts` and used by the sweep *and* the stop, which
  is what "the same path-boundary-safe relation" means: a folder event stops a descendant's
  read, and `Notes/AB/x.md` survives a `Notes/A` event because of the trailing separator.
  Its **argument order is load-bearing and not symmetric** - the queue path is the candidate,
  the event path is the prefix - because reversed, renaming one note would stop a read of
  every sibling under its parent folder. And **writes are serialised** by
  `src/settings/saveQueue.ts`: single-flight with coalescing, newest wins, at most one write
  in flight and one payload pending, a rejection reported exactly once through `reportError`
  and never wedging the queue, and, **as shipped by NRL-58**, no retry of a failed payload (a
  blind retry could resurrect a stale snapshot behind a newer one, which is the defect being
  closed). Both handler bodies moved out of main.ts into `src/settings/vaultEvents.ts` behind
  a narrow port, because main.ts has no runtime in the suite and those bodies shipped in
  NRL-51 with no automated coverage of any kind.
  **NRL-58's two residuals - no retry, and `onunload` cannot drain - are both closed by
  NRL-91 (PR #123, `aa87203`, `docs/adr/0026`).** `SaveQueue` now takes an optional
  `getCurrentPayload` constructor option; when supplied, a rejected write arms a capped
  3-attempt, 500/1000/2000ms backed-off retry that reads `getCurrentPayload()` FRESH at the
  moment it fires rather than replaying the stale rejected object, so it can never write
  anything older than what just failed. A real `enqueue()` always supersedes an armed retry
  and resets its budget, which is the same newest-wins invariant extended to cover the
  retry timer itself as a write source. `onunload` still cannot `await` - Obsidian gives no
  hook to - so `dispose()` closes only the one NEW resource retry introduces, the armed
  timer, and deliberately leaves an in-flight `running` write or a queued `pending` payload
  exactly as it finds them. ADR 0026 states the resulting bound precisely: at most one
  throttle window of position data, or one settings write that was mid-retry-backoff at the
  moment of unload, whichever the moment catches - never a torn or corrupted payload, and
  never accumulating across a session. **NOT VERIFIED IN OBSIDIAN**: whether Obsidian's real
  `saveData()` ever actually rejects in practice is unmeasured, so if it never does,
  residual 1's retry path has never been exercised by a real failure; whether an armed
  `window.setTimeout` survives Obsidian's own plugin-unload teardown long enough for
  `dispose()` to reach it is likewise unmeasured. All of NRL-91's evidence is bare-Node
  against the real `SaveQueue` with a fake clock (`tests/vaultPersistence.test.ts` T7-T10,
  18 failures pre-fix). R-M12's MUST audit floor does not move.
  Evidence, all bare-Node, measured on both sides of the diff by transcribing the shipped
  handler bodies and `saveSettings()` line for line and driving the real `PositionThrottle`
  and the real map sweeps: **7 failures at `c91ee0c`, 0 after**. A `Notes/A` -> `Notes/B`
  rename while reading `Notes/A/deep.md` left `stop()` uncalled and the in-memory map holding
  **both** `Notes/A/deep.md` and `Notes/B/deep.md` one throttle window later, and a folder
  delete resurrected its key the same way. Two writes released in reverse settled in reverse,
  durable order `[w1, w0]` against an enqueue order of `[w0, w1]`, leaving the disk holding
  `["Notes/A/deep.md"]` after a rename to `Notes/A/renamed.md`. Staged fail-first in the new
  modules, as both halves are extractions: **21 failures** in
  `tests/vaultPersistence.test.ts` against the verbatim old behaviour (10 for the stop, 8 for
  the ordering, 3 for the post-fix-only failure case), 0 after.
  **A user-visible behaviour change:** a folder rename or delete now stops a descendant read
  audibly. That is the identical trade NRL-51 already took and documented for the exact-path
  case, extended to descendants for consistency rather than as a new decision.
  What still does **not** hold. **NOTHING WAS OBSERVED IN OBSIDIAN**; CDP 9222 has been
  refused for every recent ticket in this repo and no deploy happened. main.ts's two handler
  shells, the port construction and the `SaveQueue` construction still have no automated
  coverage of any kind, obsidian having no runtime, and the stop-then-flush ordering the
  combined test relies on is a *transcription* of main.ts's player state subscription, not
  the real wiring. Whether Obsidian emits descendant events is still unverified, though
  correctness no longer depends on the answer. A repeated descendant event after a folder
  event does call `stop()` again: the queue is deliberately not retargeted so it still
  matches, and the module is stateless so there is nowhere to dedupe. That is harmless
  rather than merely tolerated, because `Player.stop()` ends in `setState("idle")`, which
  early-returns on an unchanged state. `onunload` is synchronous and cannot await the
  queue's `drain()`, so an unload mid-flight can still lose the newest snapshot - unchanged
  in kind from the pre-existing un-awaited `void this.saveSettings()`, since coalescing only
  ever discards an intermediate snapshot and the newest payload is a strict successor.
  **That specific gap is now named and bounded rather than merely noted, by NRL-91 (PR #123,
  `docs/adr/0026`) - see the retry/dispose paragraph earlier in this bullet.** `onunload`
  still cannot await anything; what NRL-91 adds is a capped retry for a failed write plus a
  `dispose()` that clears the one new timer the retry introduces, so the pre-existing
  async-gap-at-unload described here is unchanged in kind, not closed. NOT VERIFIED IN
  OBSIDIAN applies to that paragraph exactly as it does here.
  **R-M12's MUST audit floor does NOT move** and the `2 of 16` headline count is untouched:
  nothing here was exercised in a real vault, so rule 11 applies exactly as it does
  elsewhere on this list.
- Reading positions are throttled with a leading edge and a trailing flush, in
  `src/settings/positionThrottle.ts`, not in main.ts, and the window is flushed from the
  player's `state` subscription on `paused` / `idle` / `finished` rather than from
  `stopReading()` or the `toggle()` call sites. The captured pending index is written, never
  `getIndex()`, because on natural completion `getIndex()` is `chunks.length` and resolves to
  no chunk. The pre-change gate recorded nothing inside its window and its timer only
  nulled the handle, so the last position of a read was simply never persisted; measured
  with a replica of it, 5 progress events produced 2 saves and index 4 was dropped. The
  second in-flight save race this bullet used to record - a position write overlapping a rate
  nudge - closed with NRL-58's `src/settings/saveQueue.ts`, and `tests/vaultPersistence.test.ts`
  T5 pins exactly that pair: a rename's write and a rate change's write, released newest-first,
  must still end with both the rekeyed map and rate 1.5 durable. The `registerEvent` wiring
  and the state-subscription flush are **not covered by the committed suite**: `obsidian`
  has no runtime in bare Node. Prior scratch probes used a stub, not a real vault. R-M12
  remains unverified in Obsidian, including stop, quit, reopen and resume; this merge does
  not raise the MUST audit floor.

- `DEFAULT_SETTINGS.engine` became `"auto"` in NRL-24 (docs/adr/0010), the same shape as
  `speakImageAlt`'s default flip in NRL-21/ADR 0008: a genuinely fresh install, or any
  `data.json` predating this build, now speaks via automatic quality-ranked selection
  instead of the old default of unavailable Kokoro. `Settings.engine` widened to
  `EngineSelection = "auto" | EngineId`; a saved manual pin round-trips unchanged through
  `normaliseSettings()`'s new validation, never coerced to `"auto"`. Unverified as of NRL-24
  Implement: whether `SpeechSynthesisVoice.localService` (the fail-closed gate that keeps
  Web Speech out of the automatic chain unless a voice is confirmed local) reports anything
  meaningful inside Obsidian's own Electron/Chromium on Linux, and real GPU detection
  end-to-end in that same build - both only checkable in a real Obsidian, not bare Node.
- `speakImageAlt`, `speakEmbeds` and `skipFrontmatter` became live `ExtractOptions` fields in
  NRL-21 (`docs/adr/0008`), and all nine content keys now have one toggle each in the
  settings tab's "Content" group. `offlinePreferred` is not a content key and is **no longer
  reserved**: `src/ui/settingsTab.ts:572-584` ships a real toggle for it under the Voice
  group, "Prefer voices that do not require network access", and `src/main.ts:1039` passes it
  to `resolveStoredVoice`, where it becomes `pickLocaleVoice`'s network tiebreak
  (`src/audio/voiceChoice.ts:63-70`), so it is live behaviour rather than a dead toggle. It
  was seen in the real settings tab during NRL-121's Verify phase. `docs/adr/0001` clause 6
  and its NRL-21 amendment both still call it the one key with no toggle; read those as
  history, not as the shipped state. Two consequences worth knowing:
  `speakImageAlt` defaults to `true`, so this is the one upgrade that changes what an
  existing user hears; and spoken frontmatter runs its lines through `cleanLine` with
  `blockComments` false and discards the returned `openComment`/`openCode`, which is what
  stops a YAML value opening a comment or code span that silences the note body. Do not
  "simplify" either half of that.
- Stop and Repeat on speechd do reach the daemon as of NRL-41: `synthesize()` subscribes to
  the `AbortSignal` the player already hands it and issues `spd-say -S`. Do not "simplify"
  either half of that. `-S` is SSIP `STOP ALL`, which is **not** connection-scoped, and that
  is the only reason it works at all, since our own client has been SIGKILLed by the time it
  runs; the cost is that it also cuts off whatever another client sharing the daemon (a
  screen reader) is saying at that instant. So it must never fire unless one of our own
  utterances is in flight, which is why an abort seen on entry, a successful utterance and an
  idle `dispose()` all deliberately send nothing. `-C` (`CANCEL ALL`) stays banned: it would
  flush the other client's whole queue. `tests/engine.test.ts` pins all five cases and the
  reasoning lives on `stopDaemon()`. What remains is about 800 ms of speech after a Stop, and
  as of NRL-43 that is **accepted, not outstanding** (`docs/adr/0016`). Do not attempt to fix
  it by reaching for a better cancel verb, because that was tried and measured: a full SSIP
  socket client using `CANCEL self`, which the daemon acknowledges with `703 CANCELED` for the
  queued message *and* the speaking one, leaves the tail at 810/800 ms against the same
  810/800 ms for `-S`. A single-utterance probe had audio *starting* ~700 ms after the cancel
  was acknowledged, and `701 BEGIN` fires 3-10 ms after queueing, so SSIP never reports when
  sound really starts or stops. The speech is already committed to the daemon's output module
  and PulseAudio by the time any stop arrives. Two costs therefore stand, both deliberate and
  neither a latency problem: `-S` still cuts off another client sharing the daemon, and the
  Player can still run a chunk ahead after a stop because `-w` is not an audio-end signal
  (`CONTEXT.md` explains that part).
- speechd voices are no longer uniformly `"unknown"` as of NRL-55 (`docs/adr/0015`).
  `spd-say -L` still has no module column, so `listVoices()` now runs a differential
  self-check instead: enumerate modules with `spd-say -O`, require at least two, run
  `spd-say -o <module> -L` per module, and attribute rows **only if not all modules' row
  sets are identical**, which is what catches a build that ignores `-o`. A NAME is
  `local: true` / `requiresNetwork: false` only when every module serving it is on the
  closed allowlist (`espeak-ng`, `openjtalk`); everything else stays `"unknown"` and the
  engine can never emit `local: false`. `RunResult.signal` in `src/engines/system/spawn.ts`
  became a **required** field for this: an aborted or externally killed child closes with a
  null exit code, `code ?? 0` reads that as success, and a silently truncated listing is
  worse than a missing one, because losing a row removes the ambiguity that was keeping a
  shared NAME `"unknown"` *and* makes two identical listings differ. Do not make it optional
  again, and do not "simplify" `code ?? 0`, which NRL-41's Stop depends on.
  **R-S01 is narrowed, not closed, and R-S04 is explicitly not claimed** (ADR 0015 says why,
  and corrects a stale premise about `offlinePreferred` while it is there). The evidence is
  bare-Node and real-daemon measurement: against the running daemon 13,231 voices moved from
  `"unknown"` to `local: true` with 0 left `"unknown"`; the allowlist demonstrably gates,
  since replaying the real daemon's own bytes with `espeak-ng` relabelled non-allowlisted
  flips all 13,231 back to `"unknown"`; and a 40-mode / 66-check fail-closed matrix all
  landed on `"unknown"`. **Nothing was observed in Obsidian** - CDP port 9222 was refused at
  every attempt. Two residual shapes are named in ADR 0015's Residual risk with their
  measurements: a short read that exits `code 0` with no signal, which no observable can
  detect, and the probe's non-atomicity across `-O` then N x `-o -L`, where removal fails
  closed but addition inside the measured 778 ms window could produce a wrong `local: true`.
  NRL-71 took the partial mitigation for the second: a closing `spd-say -O` with the same
  three checks, giving up unless the parsed, order-independent module set is unchanged. It
  originally ran under the probe's one shared controller; **NRL-84 gave it its own**, so read
  that half of this sentence as history and the NRL-84 paragraph below as the current code. It narrows the window rather than closing it (a module can still be added
  and removed between the two `-O` calls, and the N per-module listings are still read at N
  different instants), and the give-up is memoised with no retry, so a daemon reconfigured
  inside the window leaves every voice `"unknown"` until the plugin reloads.
  **NRL-87 corrected that machinery's test coverage, not the machinery.** It is test-only:
  `git diff origin/main...HEAD -- src/` was empty and `speechd.ts` is byte-identical, so no
  behaviour changed and no requirement became met. What moved is the evidence. NRL-71's
  `AttributionScript.modulesAgain` in `tests/engine.test.ts` defaults to `modules` when unset,
  which buys five pre-existing cases as free control arms for the closing `-O` but also replays
  each case's injected failure onto that closing call, so a failure meant to be caught at the
  *opening* run was caught at the closing one instead. Two guards silently stopped
  discriminating - the opening `-O`'s `modulesRun.signal !== null` and the per-module loop's
  `controller.signal.aborted` - and the closing `-O`'s own `controller.signal.aborted` had never
  been covered at all. All three are pinned now (case J gains an explicit clean `modulesAgain`;
  new cases H2 and M5), the default is deliberately kept for the arms that benefit from it, and
  ADR 0015's "cases I-L pin all of it" is replaced by a per-clause coverage table. Two details
  are load-bearing and must not be "tidied". **H2 pins by call trace, not by verdict**: with the
  loop's abort clause deleted the closing guard still gives up and every voice is still
  `"unknown"`, so `scopedCalls` is the only observable that moves. And **M5's `oCount() === 2` is
  not decoration**: without it the case degrades into being caught by the loop's abort clause
  with an identical verdict, leaving the closing clause unpinned again, which is the exact
  failure the ticket exists to fix.
  **Those four clauses are now PINNED, by NRL-94**, and the paragraph that stood here - "four
  clauses still survive deletion ... no case in the suite exercises a deadline or a non-zero
  exit on the opening `-O`, or a non-zero exit on a per-module listing ... no follow-up ticket
  has been filed" - is **false and deleted rather than left standing**. **O1**, the opening
  `-O`'s `controller.signal.aborted`, is pinned by **case J2**, by CALL TRACE and not by
  verdict: the reply is otherwise clean, so the per-module loop's own abort clause catches an O1
  deletion one step later and `scopedCalls` (0 -> 1) is the only observable that moves.
  **O3**, the opening `-O`'s `code !== 0`, is pinned by **case J3**, which needs a VALID
  two-module stdout - case E2's `{ code: 1, stdout: "" }` is already caught by the arity guard -
  and an explicit clean `modulesAgain`, or the injected exit replays onto the closing `-O` and
  is caught there instead. **P3**, the per-module loop's `code !== 0`, is pinned by **case D4**,
  whose failing listing must carry PARSEABLE rows (case D's has none, so `rows.length === 0`
  catches it) and must have dropped the SHARED row, or the mutant's verdict does not move.
  **S3**, the count-instead-of-set module comparison, is pinned by **case M8**: a same-size but
  different module set, which is the half M2 cannot cover because the count mutation leaves M2
  green. Each was **reproduced as a survivor first** - mutation applied, full 24-suite
  `npm test` observed exiting 0 with the engine suite green at 207 checks - and then measured
  red with the new case present. NRL-94 is **test-only**: `git diff origin/main...HEAD -- src/`
  is empty, `speechd.ts` is byte-identical, so no behaviour changed and no requirement became
  met. Its own sweep was **re-derived from the clauses present today** rather than replayed -
  22 mutations, 19 single-clause plus 3 combined (each of the three guards dropped whole) - and
  **no mutation that was red before is green after**. It turned up **one further survivor that
  is not a coverage gap**: **L1**, the `mods.size > 0` term of the attribution condition, which
  is **unreachable-false** rather than untested, since a `servedBy` key is only ever created in
  the same step that adds its first module, so `mods.size` can never be 0 and no fixture can
  kill it. None was written, and this is recorded so the probe is not read as fully
  mutation-covered. Do not read those ADR rows as saying the clauses are dispensable - every clause is
  load-bearing per the comments on it. R-S01 is a SHOULD and stays narrowed, not closed, and the
  `2 of 16` MUST headline count does not move. **Nothing was observed in Obsidian**, which here
  is NOT APPLICABLE rather than skipped, nothing under `src/` having changed.
  **NRL-87's own** evidence is **bare-Node mutation evidence**: 21 mutations of
  `src/engines/system/speechd.ts` (19 single-clause plus 2 combined), the full `npm test` after
  each, the file restored and its sha256 re-asserted every time, with no mutation that was red
  before going green after. That count is NRL-87's and not NRL-94's - NRL-94 re-derived its own
  sweep at 22, above - so do not read "21" as covering the paragraph before it. **Nothing was observed in Obsidian**, and that caveat is unusually
  toothless here because the change has no user-visible surface to observe. R-S01 is a SHOULD
  and stays narrowed, not closed; the `2 of 16` MUST headline count does not move.
  **NRL-83 added the harness contract those tests now rest on, and is likewise test-only** -
  `git diff origin/main...HEAD -- src/` was empty, so no product behaviour changed and no
  requirement became met. `attributionRunner`'s `oCalls` counter lives on the **runner, not on
  the probe**, so NRL-71's "call 1 is the opener, call 2 is the closer" holds only while **one
  runner serves exactly one `probeAttribution()`** - i.e. one `SpeechDispatcherEngine`
  instance, attribution being memoised per instance. A third `-O` makes `modulesAgain` answer
  a *second* probe's OPENING call, so that probe takes the divergent module set as its
  baseline, sees no divergence and attributes: a pass for the wrong reason. Three parts are
  load-bearing and must not be "tidied". A violation is **recorded on the returned handle's
  `violations` array and never thrown**, because `probeAttribution()` ends in a bare
  `catch { return null; }` that would launder a throw into exactly the silent give-up this
  closes. The cap is `> 2` and not `=== 2`, so a later path that legitimately skips the
  closing `-O` (NRL-84) is not pre-broken - what is forbidden is a third call. And **`M6`
  asserts only that the two probes *disagree*, never that probe 2 says `true`**, so no wrong
  verdict is pinned as expected behaviour. `noReuse()` is asserted in all 23 conforming
  blocks; M6 deliberately carries none, being the violator, and the reply expression
  `(oCalls > 1 ? script.modulesAgain : undefined) ?? script.modules ?? []` is byte-identical,
  so no existing case moved. One caveat the PR understates, measured during Verify: the
  fixture sensitivity affects **`M6(a)`, the contract check, not only `M6(c)`** - perturbing
  the `festival` `lists` entry kills probe 2 after three `-O` calls when it is removed or
  emptied, so all three checks fail, and fails (c) alone when it points at a list containing
  Afrikaans. **Every perturbation tried failed loudly and none produced a spurious green.**
  Evidence is **bare-Node**: deleting the cap from the compiled suite gives exactly one red,
  M6's contract check. **Nothing was observed in Obsidian**, which here is not applicable
  rather than skipped, nothing under `src/` having changed. R-S01 stays narrowed and the
  `2 of 16` MUST headline count does not move.
  **NRL-84 (`8a025fc`) is the one of these three that DOES change `src/`**, unlike NRL-87 and
  NRL-83. The closing `-O` now runs under a **fresh `AbortController` with its own
  `CLOSING_PROBE_TIMEOUT_MS` of 500 ms** (`src/engines/system/speechd.ts`), a third defaulted
  constructor positional so `registry.ts` and `affordances.test.ts` compile untouched. Before
  it, N per-module listings - a count the probe does not bound - could spend the whole 5,000 ms
  deadline and leave the closing run none; it then aborted **holding a perfectly good reply**
  (code 0, no signal, the identical module set), the probe returned `null`, and the give-up
  being memoised with no retry, every voice reported `"unknown"` for the life of the plugin
  instance. **The outer abort is deliberately NOT inherited by that scope**, and the reason is
  the whole of why the ticket is not a no-op: an outer deadline that expires *before* the
  closing call is already caught by the per-module loop's own abort check, so the only case
  left is the outer timer firing *during* a closing run that would otherwise have answered,
  and propagating the outer abort would leave exactly that case returning `null` as before.
  **The closing guard therefore carries EXACTLY ONE abort clause**, reading only the signal
  that run was handed, and that is load-bearing rather than tidy. A two-clause guard would set
  both flags in case M5, so each clause alone would survive deletion while the pair only
  *looked* pinned - the silent split NRL-87 exists to correct. Verify measured the stronger
  form: the suite now **rejects** a two-clause guard outright (mutation N1 is red on M7),
  because M5 and M7 set **disjoint** flags, M5 pinning "the closing budget MUST discard" and
  M7 "the outer one must NOT".
  Two costs, both accepted and both to be read as current behaviour. The probe's worst case is
  now `probeTimeoutMs + closingTimeoutMs` = **5500 ms** rather than 5000 ms, **measured at
  5405 ms at shipped defaults** (a loop starved to +4903 ms then a hanging closing `-O`), with
  no path exceeding the sum: still bounded, still deterministic, and the outer budget still
  bounds the one part that grows with the module count. And **NRL-71's non-atomicity window
  widens by up to 500 ms in the starved case**: the outer deadline is no longer a hard
  "believe nothing observed after this instant" line, because the probe can now issue and
  accept the closing `-O` up to 500 ms after `controller` aborted. The fail direction stays
  safe - the closing set comparison still catches module **addition**, the one direction that
  can produce a wrong `local: true` - and narrowing the window again would undo the ticket.
  Two test-side facts that correct claims made above. **Case H now discriminates the loop's
  abort clause**, which NRL-87 explicitly believed it could not: H's expired outer deadline no
  longer reaches the closing run, so H attributes and its verdict moves. Mutation **P1 makes
  four checks red, not one** (H x2 and H2 x2), so the pin got stronger without H being edited,
  and H2's comment plus ADR 0015's coverage row were corrected rather than left standing. And
  **the fake runner still does not model `NodeProcessRunner`'s SIGKILL-on-abort**, deliberately:
  in production `spawn.ts` kills the child, so an aborted closing run also arrives with
  `signal: "SIGKILL"`, and modelling that in the fake would let `againRun.signal !== null`
  catch M5's expired closing budget and cost M5 its pin on **C1**. The abort clause and the
  signal clause are cleanly separable in the suite and entangled in production; both stay.
  Evidence is **bare-Node fixtures plus reading the code**, nothing more: **nothing was
  observed in Obsidian** (CDP 9222 refused, so `/check-constraints` logged rule 11 as UNKNOWN,
  which bites harder here than on NRL-87 or NRL-83 precisely because `src/` changed), and
  **the starvation path was never provoked against a real daemon** - it was not reconfigured,
  restarted or given extra modules. R-S01 is a SHOULD, so it stays narrowed rather than closed
  and the `2 of 16` MUST headline count does not move. `srs.md` is silent on probe timeouts and
  was not amended; `docs/adr/0015` gained the NRL-84 Residual-risk paragraph and the corrected
  mutation rows inside PR #111, so do not duplicate them here.
- Stop now aborts a read that is still in its load phase, as of NRL-48 (`docs/adr/0013`).
  Before it, `main.ts` held no `AbortController` at all and `Player`'s own one is created
  inside `play()`, so during `beforeAttempt`'s `await engine.prepare()` a Stop was
  unobservable by any route and the note started speaking once the model finished loading.
  `main.ts` now owns a per-read `readScope` controller, superseded at the top of all three
  read paths and aborted in `stopReading()` and `onunload()`, and `playWithFallback()` takes
  an 8th optional positional `signal` which it checks at the top of each iteration and again
  between a finished load and `play()`. Two halves are deliberate and must not be
  "simplified". An abort resolves `null` and never fires `onFallback`, because a user Stop is
  not a candidate failure - the callers disambiguate the two `null`s with
  `scope.signal.aborted` before the "no speech engine is available" Notice and before arming
  the sleep timer. And `raceAbort()` converts the load's rejection into a *value* at
  race-setup time rather than catching it later, which is what stops a post-abort rejection
  becoming either an unhandled rejection or a fallback trigger; the abort arm resolves rather
  than rejects, so no rejecting arm exists. The load is abandoned, not cancelled: bytes keep
  downloading and a finished model is kept for the next read, so Stop does not free work in
  flight. Evidence is **bare-Node only** - `tests/fallback.test.ts` T1-T4 plus an independent
  probe bundling the real `fallback.ts` against the real `Player`, both showing 8 FAILURE(S)
  at the pre-fix base `d7e64df` and green at the fix. **Nothing was observed in Obsidian.**
  NRL-48's one on-screen leftover **closed with NRL-65** (`src/ui/loadingNotice.ts`). The
  `Loading X...` Notice is built with duration 0, so it never self-dismisses, and it used to
  be hidden only in the abandoned `prepare()`'s `finally`: after a Stop during a cold Kokoro
  load it stayed up until the load finished on its own. Reproduced again before the fix, by
  transcribing `main.ts`'s own Notice block and driving it through the real
  `playWithFallback`: SHOW +6 ms, Stop +58 ms, resolve null +59 ms, **HIDE +357 ms** of a
  350 ms load. Re-run against the shipped code on the identical schedule, the hide moves to
  **+58 ms**, the same millisecond as the Stop, with the abandoned load still settling at
  +357 ms. `withLoadingNotice(show, work, signal)` now dismisses at whichever comes
  first, the work settling or the signal aborting, and **`ADR 0013 is unchanged`** - the load
  is still abandoned rather than cancelled, `prepare()` still takes no signal, `SpeechEngine`
  is untouched, and nothing about when bytes stop arriving moved. The signal is for the
  Notice only. Three parts are load-bearing. The signal reaches `prepareCandidate` as an
  **explicit argument from all three call sites**, never read off `this.readScope`, because
  that field is reassigned by the next read and this method belongs to one particular read -
  reading the field would fail to dismiss a superseded read's own Notice and would let a
  later read's abort dismiss one that is not its own, which is exactly the rule NRL-48
  established. **Already aborted on entry means `show()` is not called at all** while `work()`
  still runs exactly once, because a show-then-hide in one turn is a flash that depends on
  host behaviour nobody has verified, and skipping construction leaves ADR 0013's load
  behaviour byte-identical. And the dismissal is idempotent by three parts that are not
  redundant with each other: a captured `hidden` boolean for the cross-path double call,
  `{ once: true }`, and a `removeEventListener` so a many-candidate read does not accumulate
  one listener per candidate on the long-lived `scope.signal`.
  Evidence, **bare-Node only**, staged fail-first because the module *is* the fix: **6
  failures** against a transcription of the old policy, 0 after - and only **3 of those 6 are
  defect reproductions** (`tests/loadingNotice.test.ts` L1 and L2, plus `tests/fallback.test.ts`
  T5(i)). L7 (1) and L8 (2) are red only because the old policy has no signal parameter at
  all, so they are labelled new capability and new behaviour rather than counted. L9 was
  *planned* as red and measured green on both sides, so it is relabelled a guard: the old
  block invoked its load inside the `try`, so a synchronously throwing `prepare()` already hit
  the `finally`. The transcription itself was checked rather than eyeballed - the verbatim
  block and the transcription produced identical step transcripts under both the reproduction
  schedule and a sync-throwing `prepare()` - which is what stops the count being theatre.
  **Nothing was observed in Obsidian** for NRL-65 either; CDP port 9222 was not available.
  The specific unverified assumption is **whether obsidian's real `Notice` behaves as this
  rests on**: that one built with `duration 0` never self-dismisses, and that `hide()` called
  once at an arbitrary moment removes it cleanly. That is outside what the suite can cover
  rather than a gap in it - every check is about *when* `hide()` is called, which a fake
  `Dismissable` observes exactly, and none is about what the host then does to the DOM. It is
  deliberately **not** written into `srs.md`, which states the requirement rather than the
  evidence. So R-M07 is **still not** recorded as fully met and the `2 of 16` MUST headline
  count above does not move: rule 11 applies, `main.ts` has no runtime in the suite, and the
  three call-site edits, the `new Notice` construction and the `show()` closure therefore have
  no automated coverage of any kind.
- `cleanLine` is called once per source line, but since NRL-42 that is no longer the whole
  story: an inline code span may cross a soft line break, so `Cleaned.openCode` carries the
  length of a run left open and `codeSpanClosesLater` confirms a later line closes it. The
  confirmation is load-bearing, not an optimisation. An unmatched backtick run is literal
  text, so arming the carry without it stops the next line's `%%` being seen as a block
  opener and reads hidden text aloud - which is exactly what happened to six fixtures
  during NRL-42's review. Do not weaken that lookahead or the `interruptsParagraph` rule
  that stops it at a comment-opening line.
- NRL-42 fixed only the spoken half of ADR 0006 clause 4, and it fixed it only for the
  comment branch. NRL-44 (`docs/adr/0019`) finished both halves at once, and the reason the
  fix is one change rather than five is a measurement: an enumeration probe against the
  single-line-span oracle found **18 of 21** inline constructs re-interpreted as markdown
  inside a confirmed soft-wrapped span, not the three the tickets named. Only `%%`, `<!--`
  and `:emoji:` were correct. So the region `[0, literalCodeEnd)` is now emitted **once,
  before the branch loop**, verbatim when code is spoken and silenced whole when it is
  skipped. Do not "simplify" that back into per-branch `i >= literalCodeEnd` guards: the
  three branches that were already correct were correct by accident of which ticket touched
  them, and the set of branches is not closed. Post-fix the same probe reports 0 of 21.
  N2, F4 and F7 closed with it, and so did the **15 other constructs nobody had
  enumerated** - the three named shapes were a sample of the family, not the family. F5
  closed as an invariant test instead of a code change
  (`HEADING`, `BLOCKQUOTE`, `LIST_BULLET`, `TABLE_ROW` must each stop a carry, mutation-
  checked). The rest of the evidence, all bare-Node, all measured on both sides of the
  diff: the disclosure probe's **two-class oracle** held **HIDING 0 to 0 and LITERAL 1,536
  to 1,536** over **25,600 extractions per side**, plus **36,864 per side** across the 18
  constructs; `sourceIndex` was clean over **12,288 adversarial combinations**, checked
  numerically by UTF-16 code-unit index; **28 fixtures were red pre-fix**; and a
  **4,000-note fuzz** found **0 new disclosures and 0 prose loss**. Keeping the oracle's
  two classes apart is load-bearing rather than tidy: collapsing them scores NRL-42's
  designed literal `%%` as a leak and invents failures that are not there.
  **Nothing was observed in Obsidian.** One of the two shapes NRL-44 left open has since
  closed. **NRL-64** (N1 - the tail after the unmatched run on the span's *opening* line was
  spoken as prose) closed by reordering the per-line loop: `extractChunks` cleans a paragraph
  line once to learn the run length, calls `codeSpanClosesLater` with the identical arguments,
  and only then cleans the line again with a new 6th `cleanLine` parameter `outgoingCode`, so
  the tail goes through the **same region emitter** as a carried-in span. `codeSpanClosesLater`
  and `interruptsParagraph` were not touched (function bodies byte-identical), and the
  `blockType === "paragraph"` test moved to the single confirmation site, where it is redundant
  belt-and-braces rather than load-bearing: `codeSpanClosesLater` already runs
  `interruptsParagraph` over the opening line, which matches all three constructs that make
  `blockType` non-paragraph, and deleting the test changed 0 of 9,792 measured extractions. Two
  consequences that are *not*
  regressions: `pin-nrl64-opening-line` now expects `"Before a %%b%% c d after."` and
  `pin-skipped-code` now expects `"Before after."`, both matching their single-line oracle.
  Evidence, bare-Node, built side by side with base `29c52ae`: **0 hidden sentinels spoken on
  either side over 11,264 sweep cells per side and 819,200 adversarial cells per side, with 0
  cells leaking on one side and not the other**; the designed-literal class **0 -> 2,304**
  spoken, all at `skipInlineCode: false`; **0 prose lost**; `sourceIndex` clean by numeric
  UTF-16 index over those cells plus a 4,000-note fuzz; 13 fixtures red pre-fix.
  **Nothing was observed in Obsidian.** The other shape NRL-44 left open, **NRL-63** (F9 - a
  soft-wrapped image was not recognised across the break at all), closed **partially** with
  `0e44050` / `docs/adr/0023`: `bracketClosesLater` now carries a label across the break, the
  plain-paragraph image and link cases went 512/512 leaking to 0/512, and **a destination is
  still spoken through five distinct roots**, enumerated in the R-M09 section above. **Root 4 of
  the five closed with NRL-88** (`docs/adr/0027`) and the **container members of roots 1 and 2
  closed with NRL-98** (`docs/adr/0029`); roots 3 and 5 remain in full, plus root 4's own named
  residuals and roots 1 and 2's three non-container shapes. The
  `11,520 of 19,456` figure that used to sit in this sentence is deleted rather than updated:
  it was a pre-NRL-74 baseline on an unreconstructable corpus, and NRL-88 and NRL-98 each
  measured their own.
  Nothing in either fix was observed in Obsidian.
  Two things NRL-44 did **not** weaken, and must not be: `codeSpanClosesLater`'s
  confirmation, which now prevents silencing visible prose as well as disclosing hidden
  text, and `interruptsParagraph`, which NRL-45 also depends on.
- NRL-39's autolink shape (F7) closed with NRL-44, and it closed the way NRL-39 said it had
  to: not by guarding the autolink branch, which would have put the spoken `<` back via the
  bare-URL branch, but by neither branch running inside the region at all. A span carrying
  `<https://x.com>` on a continuation line now speaks it literally in **both** `speakUrls`
  positions, and so does a bare URL. `srs.md` R-M08 was amended to promise literalness in
  general rather than for `%%` and `<!--` only.
- One consequence of that generality, written down because it looks like a privacy
  regression and is not: a destination inside the region is spoken. `![alt](dest.png)` on a
  continuation line reads as itself, delimiters and destination included, because inside a
  code span the raw text is what the renderer shows. A **single-line** span has done exactly
  this since long before NRL-44, in both `speakImageAlt` positions (measured at `8d7fdce`:
  `` `![alt](d.png)` `` speaks `![alt](d.png)` with `speakImageAlt: false`). The disclosure
  probe separates it as its own class for this reason: hiding sentinels stayed at 0 across
  73,728 extractions, the destination class moved 0 to 4,608, all at `skipInlineCode: false`.
  This is the intended reading of the requirement, not a deviation from it: both ADR 0019
  and `srs.md` R-M08 say so in as many words, so do not "fix" it back.
- **NRL-68 is closed as not-a-defect**, and the way it closed is worth carrying, because it
  was filed High as a disclosure. It reported that a trailing mid-line `%%` fails to open a
  block comment, so `Plain prose %%` / `HIDEME` / `%%` says `Plain prose %% HIDEME`. That is
  the measured behaviour and it is correct. Obsidian 1.13.7's `%%` tokenizer, read out of the
  installed `obsidian.asar`, skips **spaces only**, then requires `%%` at the block start, and
  is registered as a **block** tokenizer in the `interruptParagraph` set, so it cannot fire
  part way through a line at all; the inline tokenizer `/^%%(.*?)%%/` is anchored and `.` does
  not match a newline. So `HIDEME` is displayed in Obsidian, speaking it is renderer-faithful,
  and the ticket's own Caveat named this outcome. The spec sentence needed the citation, not
  the code: `src/text/extract.ts` did not change, `srs.md:326` and ADR 0006 clause 2 now carry
  the tokenizer evidence, and `pin-nrl68-midline-opener-is-literal` in `tests/extract.test.ts`
  pins the correct behaviour so it cannot be "fixed" back. Read off the installed parser, **NOT
  VERIFIED IN OBSIDIAN**. Of the three `%%` **disclosure** gaps that were open when this
  paragraph was first written, **one remains**: **NRL-45's leftover**, `[a]: x.png "%%"`
  followed by a secret line, where the `%%` in a quoted title is an unmatched inline opener
  (ADR 0006). NRL-68 itself closed as not-a-defect, above, and **NRL-67** - a `%%` inside a
  wikilink target, spoken because the label took a raw-emission path that never ran comment
  stripping - was **fixed** by `a8f45db` / `docs/adr/0021`; see the R-M09 path-half section
  above. Keep this disclosure-direction list separate from the prose-loss pair in the next
  bullet. They are opposite failures with opposite fixes, and a merged list would hold entries
  that cannot share a remedy.
- Two new defects came out of reading that tokenizer, and both go the **opposite** way to the
  family above: they hide text Obsidian displays, which is prose loss rather than disclosure.
  **NRL-73** (High) and **NRL-74** (Medium) are **both fixed**, NRL-73 first and NRL-74 on
  top of it.

  **NRL-73**: `if (37 === a) return` means any lone `%` before the newline disqualifies the
  block in Obsidian, while we looked only for a later `%%` closer, so
  `%% 50% off` / `VISIBLE PROSE AFTER` spoke `""` and the rest of the note was silenced. The fix
  is **one shared predicate**, `opensObsidianBlock(view, at)` in `src/text/extract.ts`, returning
  `view.slice(0, at).trim() === "" && view.indexOf("%", at + 2) === -1`, called from **both**
  sites that used to ask the question separately: the literal-emit escape in `cleanLine`'s
  comment branch (was `:618`, now `:903` and calling the helper) and `opensHiddenComment` (was
  `:1351`, now `:1656-1661`). One predicate rather than two parallel edits because these two are
  the same question asked from two places and had already drifted on exactly the half that was
  missing; ADR 0006 clause 2 and `docs/adr/0006`'s divergence section carry the reasoning.
  `blockComments &&` stays at the `cleanLine` call site as a **mode flag, not part of the rule**,
  and that is load-bearing: the five recursive `cleanLine` call sites pass middle slices of a
  line rather than suffixes, and they all default `blockComments` to false, which is the only
  reason a forward scan to end-of-view is sound. The `obsidianComment` gate is untouched, which
  is what keeps `<!--` out of the change (D-73-4), and `interruptsParagraph` and
  `codeSpanClosesLater` are **byte-identical** across the diff (checked by hashing both function
  bodies, 13 and 9 lines).
  **The opener line is now spoken, delimiters included**, which is the wanted outcome because
  Obsidian displays it. Three shapes therefore move **silent -> spoken** and are
  **renderer-faithful rather than leaks**: `%% 50% off` / `SECRETC` / `%%` / `tail.` went
  `"tail."` -> `"%% 50% off SECRETC"`, and the base was wrong in **both directions at once** -
  hiding the two displayed lines *and* speaking the hidden tail. Do not revert them; three
  fixtures pin them with that reasoning.
  Evidence, all bare-Node, built side by side against base `bb77b77` with the repo's own
  esbuild, and keyed on a **tokenizer oracle transcribed from the installed `obsidian.asar` in
  that session** rather than on sentinel names (a name-keyed oracle mis-classifies a shape whose
  second `%%` *closes* the block its first opened, and reports phantom leaks on a correct fix).
  The transcription was self-tested against 16 hand-traced cases first, which caught three wrong
  hand expectations rather than three oracle bugs. Over **19,968 cells per side** (22 prose+`%%`
  shapes x 512 content-key combinations x sentinels): **Class A, text the tokenizer hides, leaked
  1,024 -> 0**, and **Class B, text the tokenizer displays, was lost 8,704 -> 0**, with **0 cells
  newly leaking and 0 newly lost**. Narrowing `opensHiddenComment` **widens**
  `codeSpanClosesLater`, so the disclosure direction was probed separately over **5,120 cells per
  side**: a genuine hidden `%%` block beside an unmatched backtick run of length 1, 2 and 3, a
  run that never closes, a mismatched pair, and an HTML block, all **0 -> 0 spoken**, while ADR
  0019's deliberately-literal `%%` pair inside a *spoken* span stayed **512 on both sides** -
  the two classes must not be collapsed. Of **1,789 distinct probe lines, 52 changed their
  `interruptsParagraph` answer and all 52 are lines the transcribed tokenizer does not treat as
  a comment opener.** `sourceIndex` clean by numeric UTF-16 code-unit index over **23,040 chunks
  / 321,024 units**, and the checker is demonstrably **non-vacuous**: drop-one-entry 23,040
  length failures, shift-all-by-1 13,824 bounds + 23,040 identity, swap-two-entries 23,040
  monotonic + 20,992 identity. A **4,000-note fuzz** found **0 newly leaking notes** (30 -> 9
  leaking, 21 fixed, 0 new) and 0 `sourceIndex` failures; all 3 distinct notes still diverging
  were shown by a causation test to be explained by a **container-prefixed `%%` line**, which
  the oracle cannot judge because it does not model the blockquote and list tokenizers
  re-offering a stripped remainder. That last item is a **limit of the oracle, not a defect
  claim**: it is unchanged on both sides, and which of the two is right there is unknown.
  **NOTHING WAS OBSERVED IN OBSIDIAN.** CDP port 9222 was not reachable, no deploy happened, and
  the renderer side rests entirely on reading `obsidian.asar` - so whether Obsidian really
  displays `%% 50% off` and the line after it is still unverified, and rule 11 applies to every
  number above. The `%%`-block tokenizer's **closer** was also read this session and is the next
  `%%` anywhere from the newline on, with no line-start requirement; that matches what we already
  did and nothing was changed for it. Two known misses, neither opened by NRL-73 and neither
  fixed: the line-start half still uses `.trim()`, which accepts a **tab**, where the tokenizer
  skips charCode 32 only, so `\t%%` opens a block for us and not for Obsidian; and NRL-45's
  `[a]: x.png "%%"` leftover is untouched.

  The tab miss was measured at ship review rather than left as theory, and it is **live prose
  loss**, not a curiosity: `Para line.` / `\t%%` / `SECRET` / `VISIBLE` speaks only
  `"Para line."`, and a tab-led `%%` inside a blockquote or a list silences the container
  whole - **identical on both sides of this diff, 0 of 40 tab cells moved**, so NRL-73 neither
  opened it nor widened it. It is **not** a one-line `.trim()` fix and must not be shipped as
  one. In a *fresh block* position a tab-led `%%` never reaches the predicate at all, because
  our indented-code handling eats the line first (`\t%%` / `SECRET_TAB` / `VISIBLE` already
  speaks `"SECRET_TAB VISIBLE"`), and whether Obsidian also treats it as indented code is
  **unknown**: the transcribed tokenizer models the `%%` construct only, and `FE(e, "comment",
  "fencedCode", ...)` orders it against *fencedCode*, saying nothing about indented code. So
  narrowing the predicate would be right for the paragraph-continuation case and possibly the
  wrong shape for the fresh-block one. Tracked as **NRL-93**, and it needs the indented-code
  question answered first. (The commit message for this change says NRL-89: that number was
  written before the issue was filed and Linear assigned 93. NRL-93 is the real one.)

  One behaviour class NRL-73's own probes did not report, found by the ship-review fuzz over
  120,960 cells: a soft-wrapped code span whose interior holds **only disqualified `%%` lines**
  and no genuine opener. `Before ` + backtick + `a` / `%% 50% off` / `SPANPROSE` / `%% 2% w` /
  `b` + backtick + ` after.` spoke `"Before a 2% w b after."` on base in **both**
  `skipInlineCode` positions - half-recognising the span, saying its two ends and one interior
  line as prose while dropping the rest, so it agreed with neither the skipped form nor the
  spoken one. The narrowing lets `codeSpanClosesLater` confirm the span, so it is now governed
  by `skipInlineCode` exactly as a single-line span is: `"Before after."` skipped, verbatim
  spoken. Every line in it is displayed by Obsidian, as code, so neither position is a leak.
  This is why the fuzz's 768 "unjustified removals" are not prose loss: **all 768 are at
  `skipInlineCode: true` and none is in a note with no backtick at all**, which is the
  exclusion doing its job rather than the comment predicate losing text. Pinned by
  `pin-nrl73-span-of-only-disqualified-openers` and its `-spoken` twin.

  **NRL-74** (Medium) is **fixed** (`docs/adr/0025`, `srs.md`'s `<!--` bullet). An unmatched
  mid-line `<!--` opened a block for us while `%%` correctly did not, so
  `Plain prose <!--` / `SECRETA` / `more` spoke `"Plain prose"` and now speaks
  `"Plain prose <!-- SECRETA more"`. **The ticket's own stated fix is wrong and must not be
  retried**: hoisting the line-start guard out from under `obsidianComment` breaks FIVE pins,
  including `obsidian-inside-html-block` (`tests/extract.test.ts:1187`), which the ticket's
  acceptance criteria protect - that pin's `<!--` is MID-LINE with its `-->` four lines later
  past a fence and a `$$`.

  **This is the first ticket in the family whose `<!--` rule was READ rather than reasoned.**
  Obsidian 1.13.7's HTML block tokenizer (module 8776 of the installed `obsidian.asar`) skips
  leading spaces **and tabs** with no three-space cap and then tests `u=/^<!--/` **anchored**,
  closing on the **opener's own line** when a `h=/-->/` is there, otherwise on the first later
  line matching one, otherwise at EOF. (The first draft of ADR 0025 said "the first *later*
  line" and omitted the same-line stage; corrected at ship review by re-reading module 8776,
  and it matters - it is what makes `<!--x--> prose <!--` a one-line block with the next line
  displayed.) So the line-start term is the renderer's own rule, and our `.trim()` is
  **correct** here where it is wrong for `%%` (NRL-93 is not shared). The second term is the
  renderer's **inline** path instead (module 4839's `.T`,
  `<!--(?:-?[^>-])(?:-?[^-])*-->`), which requires a closer - and that path is
  **paragraph-scoped** where NRL-74's was document-scoped.

  **So D-74-4's EOF scope was correct for term 1 and a KNOWN DIVERGENCE for term 2, and it must
  not be recorded as a decision shown right.** NRL-74 measured that residual at 1,024 cells,
  identical on both sides (re-measured independently at its ship review: 0 of 512 on base and 0
  of 512 on the fix for `Before x.` / `Prose <!--` / `HIDDENP` / blank / `New paragraph -->` /
  `Tail.`). **NRL-95 CLOSED it** - see its own paragraph at the end of this section - and in
  doing so it re-examined the pin NRL-74 cited as `:1187`, which is in fact at `:1201`, and
  found its expectation wrong in **both** halves and a DISCLOSURE rather than prose loss. Two
  things NRL-74 recorded here are **backwards and were corrected by NRL-95**. The pin number,
  and the direction: bounding term 2 **WIDENS** `codeSpanClosesLater` and `bracketClosesLater`
  rather than narrowing them, because it narrows `opensHtmlBlock` -> `opensHiddenComment` ->
  `interruptsParagraph` so both carries return false LESS often. The three D-74-9 destination
  pins and `guard-nrl74-variant-C-disclosure` were re-measured there and all four are UNMOVED,
  0 of 512 differing cells each.

  Five things are load-bearing. `opensHtmlBlock` is a **SECOND predicate**, not a widened
  `opensObsidianBlock` - merging them imports `if (37 === a) return` into `<!--`, which D-73-4
  forbids, and this IS the case NRL-66's "do not merge two scans" note describes where NRL-73's
  merge was the opposite case. The lookahead was **one scalar**, `lastHtmlCloser`, computed once
  in `extractChunks`; a per-call scan would be O(L^3). **NRL-95 replaced that scalar with a
  per-line boolean array**, `htmlCloserAhead`, computed in one backward pass - still O(L) once
  and O(1) per test, now with O(L) booleans - because the bound it carries differs per line and
  a scalar cannot express one. The O(L^3) reasoning survives verbatim as the reason a per-call
  rescan is still refused. It reaches `cleanLine` as an **explicit required parameter**, still a
  scalar at that boundary so `cleanLine` stays line-local, never ambient - a module-level flag was built first and was the fifth
  pin failure, leaking into the recursive label call. The new literal escape gates
  `blockComments` **POSITIVELY** where the `%%` escape negates it, which looks like a typo and
  is what keeps a recursively cleaned label truncating locally (`local-html-state`, srs.md's
  non-nesting bullet). And **narrowing `opensHiddenComment` with BOTH terms is mandatory, not
  optional**: the `cleanLine`-only variant newly speaks an image/link **destination** in
  **2,560 of 2,560** measured cells against 0 on base and 0 on the fix **for the
  plain-paragraph shapes that corpus used**, turning an R-M08 prose-loss defect into an R-M09
  leak, while adopting the **line-start term alone** is a measured **disclosure**
  (`Before BT a` / `Prose <!--` / `HIDDENX` / `--> b BT after.` speaks HIDDENX, which base and
  the fix both keep silent). Three fixtures pin the first and
  `guard-nrl74-variant-C-disclosure` pins the second.

  **That "0 on the fix" is true of the PLAIN shape only, and the full fix DOES newly speak a
  destination in the container-prefixed class.** This is the correction Verify blocked PR #113
  for, and the earlier wording asserted the opposite of what is measurable, so read the numbers
  here and not that sentence's implication. A container-prefixed soft-wrapped image or link
  label whose label carries a mid-line `<!--` - `> Before ![alt <!--x` / `> more](zdestz.png)
  after.` - went from `"Before [alt"` on base to `"Before [alt <!--x more](zdestz.png) after."`
  on the fix. Measured at correction by bundling both arms against base `5009eb6` with the
  repo's own esbuild: **5,120 of 6,144 cells newly speak the destination, base 0 and fix 512 in
  every one of 10 shapes** (blockquote / nested quote / bullet / ordered / task, x image, link,
  x all 512 content-key combinations). The **plain** shapes are **0 -> 0**, widened at
  correction to 8 plain shapes / **4,096 cells, 0 on base and 0 on the fix** - which is exactly
  why the three pins above and every probe the PR ran missed it.

  **It is not a new leak class, and that distinction is the whole of why the behaviour was not
  reverted.** The identical container shapes **without** the `<!--` already leak **5,120 of
  5,120 on base AND on the fix** (measured at correction, same arms): that is **NRL-88 root 1**,
  `interruptsParagraph` matching a container on the opener line, so `bracketClosesLater` never
  confirms and the construct falls through as prose. Base's 0 was the prose-loss bug *masking*
  exactly the `<!--`-bearing members of that class - it hid the destination by swallowing the
  rest of the note - and fixing the prose loss unmasks them. The root was **traced, not
  guessed**: `interruptsParagraph` tests `BLOCKQUOTE` and `LIST_BULLET` directly, and a
  **3-space indent**, which is not a container it matches, measures **0 -> 0** with the
  destination correctly dropped. Attribute it to **root 1 and not root 2**. CommonMark parses
  these as valid images, so the destination is an attribute and speaking it is a genuine R-M09
  disclosure rather than renderer-faithful; keeping a prose-loss defect in order to mask it is
  not the trade, which is why this is documented and pinned rather than reverted.
  `pin-nrl74-container-label-still-leaks-destination` pins one shape of it, **as a tripwire and
  not as evidence of a fix**: when NRL-88 closes root 1 that expectation must change on purpose.

  Evidence, all bare-Node, four arms built side by side against base `8635ed2`, keyed on an
  oracle **transcribed from those tokenizers** and self-tested on 21 hand-traced cases first
  (which caught one real oracle bug: the `%%` tokenizer leaves its closer line's remainder
  displayed, the HTML one consumes its closer line whole, and modelling both alike manufactured
  1,536 phantom leaks). Two-class probe, 20 shapes x 512 combinations: **Class A, text the
  renderer hides, 0 spoken on base and 0 on the fix; Class B, text it displays, lost 9,216 ->
  2,304 of 13,312; 0 cells newly leaking and 0 newly lost**, with the residual 2,304 fully
  accounted for (1,024 the known gap above, 1,280 content exclusions the oracle cannot see).
  **Read that "0 newly leaking" with its scope attached**: the oracle's two classes are *text*
  the renderer hides and *text* it displays, and an image or link **destination** is an
  attribute rather than either, so the 5,120-cell destination move above sits **outside both
  classes** and this probe could not have reported it. That is a scope limit of the oracle, not
  a contradiction of its numbers.
  Disclosure probes for **both** widened lookaheads: `codeSpanClosesLater` **8,704 cells** and
  `bracketClosesLater` **3,072 cells**, hidden sentinel **0 on base, 0 on the fix, 768 each on
  the forbidden line-start-only variant** - which is what makes them non-vacuous. Both
  confirmations proven **structurally unweakened** by brace-matching each body out of base and
  out of the branch and showing them byte-identical modulo the threaded argument. Subsumption
  **0 widened / 114 narrowed** over 1,036 pairs, measured not asserted because the added
  `|| closesLater` is a disjunction. **49 of 1,036** pairs changed `interruptsParagraph`'s
  answer, on 49 distinct lines, **all 49 lines the tokenizer oracle does not call an opener**.
  NRL-73's own two-class probe **re-run** (D-74-8): identical on both sides, 0 newly leaking,
  0 newly lost. `sourceIndex` clean by numeric UTF-16 index over **12,032 chunks / 184,576
  units**, non-vacuous by **four targeted mutators with every row nonzero on both sides**, and
  the `text[i] === " "` exemption shown pre-existing (without it the fix reports 8,192 and BASE
  reports 512). A **4,000-note fuzz**: 0 newly leaking; its 8 "lost" cells are all at
  `skipInlineCode: true` and 0 at false, the exclusion class NRL-73's ship review already
  recorded; and its 58 destination cells **all 58** speak the whole literal `](zdestz.png)`,
  which the PR dismissed as "a construct with no matching opener, so literal text the renderer
  shows". **That dismissal was wrong, and it is how the 5,120-cell class above got through.**
  A container-prefixed soft-wrapped label has a matching `![`/`[` opener *and* a matching
  `](...)`, so speaking the whole literal is precisely the symptom, not a reason it is benign.
  The fuzz saw the signal and the reasoning discarded it. Which of those 58 cells are that class
  was **not** re-measured at correction; the class itself was, at 5,120 cells, directly.

  **One pre-existing fixture moved, silent -> spoken**: `tests/extract.test.ts:959` (NRL-45
  decision Q9) went `[]` -> `["ZSECRETZ sentence here."]`, the only one in the whole suite. It
  is renderer-faithful (mid-line `<!--` in a quoted title, no `-->` anywhere) and makes the
  shape agree with its `%%` sibling, which already spoke on base. **Replaced in place** per the
  NRL-66/NRL-67 convention; Q9 keeps its pin at `:960`, the same shape with a `-->` four lines
  down, green on both sides. ADR 0018 carried two sentences this falsifies and both were
  amended rather than left lying, as were ADR 0019's and ADR 0023's "`interruptsParagraph` is
  not touched / not widened" claims - NRL-74 **narrows** it, the opposite direction, and gives
  it a second parameter.

  **NOTHING WAS OBSERVED IN OBSIDIAN.** No deploy happened and CDP 9222 was not attempted; the
  renderer side rests entirely on reading `obsidian.asar`, so rule 11 applies to every number
  above. Two other residuals, both pre-existing and neither opened here: `lastHtmlCloser` is a
  crude text scan that counts a `-->` inside a fence, inside frontmatter or inside another
  comment (measured: neither newly leaks nor newly loses), and a tab-indented `<!--` in a
  fresh-block position never reaches the predicate because indented-code handling eats the line
  first - NRL-93's shape, not shared. That second one is a **disclosure** rather than prose
  loss, which is worth saying because every other residual on this list goes the other way:
  `Before x.` / blank / `\t<!--` / `HIDDEN1` / `more` speaks `"Before x. HIDDEN1 more"` on
  **base and fix alike, 512 of 512 cells each** (measured at ship review), while module 8776's
  skip loop accepts `\t`, so Obsidian opens a block there and hides `HIDDEN1`. Narrowing the
  `<!--` predicate would not help - the line never reaches it - so it is NRL-93's
  indented-code question and not a second one. The oracle also surfaced a **pre-existing `%%`-in-heading
  divergence** (`# %% off` / `ZHZ` / `%% after ZPZ.`), identical on both sides, pinned as
  `heading-tracking`, **no ticket filed**. **`interruptsParagraph`'s answer set changed, so
  whichever of NRL-74 and NRL-88 merges second must re-measure NRL-88's five roots**; they are
  neither re-measured nor claimed here. **Concretely: NRL-74 UNMASKS 5,120 cells of NRL-88 root
  1** that the prose-loss bug was hiding, so root 1's recorded `2,048 of 2,048` and the
  `11,520 of 19,456` headline in the R-M09 section are both **pre-NRL-74 baselines** and neither
  is current. **NRL-88 merged second and did re-measure**, for root 4 only, which is the one it
  scoped: root 4 had **not** moved, and that was traced rather than assumed - its shapes carry
  no `%%` and no `<!--` on either the opener or the stray line, so the narrowing never fires
  inside them, and the unmasking landed on root 1. **NRL-98 then re-measured roots 1 and 2 on
  its own corpus against its own base `e4c9c1d`** and found they had each been a single number
  over a mixed population; the per-row breakdown is in `docs/adr/0029` and the 5,120 unmasked
  cells are reported there as their own row, measured 5,120 of 5,120 at base and 0 at the fix.
  Roots 3 and 5 are **still un-re-measured** and their recorded counts are still pre-NRL-74
  baselines.
  R-M08 is **NOT** met and the `2 of 16` count does not move.

  **NRL-95 closed NRL-74's own known gap**, the last one on that bullet's list: term 2 of the
  `<!--` block rule, "some later line carries `-->`", is now bounded by the end of the OPENER'S
  PARAGRAPH instead of running to end of document. Term 1 (line-start) keeps its EOF scan
  untouched, because that half IS module 8776's rule. `Before x.` / `Prose <!--` / `HIDDENP` /
  blank / `New paragraph -->` / `Tail.` went `"Before x. Prose Tail."` to
  `"Before x. Prose <!-- HIDDENP New paragraph --> Tail."`, reproduced at `4dcb753` in this
  session before anything was edited.

  The data structure changed with it and that is the part to know. `lastHtmlCloser`, one scalar,
  is **gone**; `htmlCloserAhead`, a per-line boolean array computed in one backward pass, is what
  `extractChunks` now builds, because the bound differs per line. Three details of that loop are
  load-bearing: the assignment precedes folding line `k` in (that is the old strict `>`), `ahead`
  resets at a stop line (a paragraph cannot see past its own end), and a `-->` ON a stop line is
  deliberately unreachable from earlier lines while the stop line itself still gets the following
  run's answer - which is what keeps `table-tracking` and `heading-html-tracking` green.
  **THE TRAP, and it must not be tidied away:** the bound predicate is a separate, comment-blind
  helper, `endsTerm2Scan`, and it MUST NOT be `interruptsParagraph`, because
  `interruptsParagraph` -> `opensHiddenComment` -> `opensHtmlBlock` consumes the very answer it
  produces, so reusing it is mutually recursive.

  **The stop set is blank / FENCE / HEADING / HR / SETEXT / `TERM2_LIST`, and it departs from
  `interruptsParagraph`'s own term list in THREE places for THREE different reasons.** The
  ticket's first draft gave one reason for all three; ship review falsified it for the list half
  and changed the behaviour, so read the three separately and do not re-merge them.

  `BLOCKQUOTE` is **dropped**, and that is compatible with `blockquote` being in Obsidian's
  `u.interruptParagraph` rather than contradicted by it: the blockquote tokenizer PEELS the `>`
  and re-runs the paragraph tokenizer on the stripped content, so a continuation line of the SAME
  quote is never a quote STARTING. `> Prose <!--` / `> HIDDENQ` / `> more -->` is one paragraph
  inside the quote and Obsidian HIDES `HIDDENQ`; stopping there speaks it. Two guards are red on
  the arm that puts the term back. Its cost is now pinned rather than left unstated: where the
  quote STARTS after the opener, the renderer's paragraph really does end and we hide text it
  displays (`pin-nrl95-quote-starting-after-opener-still-hidden`), fail-closed and identical on
  base.

  `TABLE_ROW` is **dropped, for a stronger reason than the ticket first gave**. Not merely that
  our `/^\s*\|/` matches a lone `| a |` GFM would not call a table: **`table` appears nowhere in
  `u.interruptParagraph`**, and the only two terms ever inserted into that list anywhere in
  `app.js` are `math` and `comment`. So NO table row can interrupt a paragraph in Obsidian,
  delimiter row or not, and a real GFM table between opener and closer is hidden too. **Do not
  "fix" `TABLE_ROW` to require a delimiter row and then add it here** - that reopens the
  disclosure on the real-table shape, which `guard-nrl95-real-gfm-table-closer` now holds.

  `LIST_BULLET` is **REPLACED, not dropped, and the reason the first draft gave for dropping it
  was FALSE.** A list does NOT re-offer its lines as one paragraph the way a blockquote does:
  `- x`/`- y`/`- z` is three items with three paragraphs, so the closer is not in the opener's
  paragraph and Obsidian DISPLAYS every line. Dropping the term whole therefore retained prose
  loss with nothing to justify it. The correct term is module 745's own silent-mode rule,
  transcribed as `TERM2_LIST = /^[ \t]*(?:[-*+]|1\.)[ \t]/`: a bullet at ANY indent interrupts
  (no three-space cap in that loop), an ordered marker only when it is literally `1.` (Obsidian
  runs `commonmark` falsy so `)` is not a marker, and the silent path returns unless the digit
  string is exactly `"1"`). `LIST_BULLET`'s `\d+[.)]` accepts `7.`, `01.` and `1)`, and stopping
  at one of those IS a disclosure - three guards are red on the arm that puts the whole term
  back. Measured at ship review: **5 fixtures red against the pre-review arm, 0 after**, and over
  a **19,584-cell sweep** the `TERM2_LIST` arm diverges in **3,456 cells and in 0 cells where an
  independent transcription of module 745's silent path says the line does not interrupt**, with
  `sourceIndex` clean by numeric UTF-16 index over every chunk of all 19,584 cells. Two residual
  prose losses stay, both of the container-prefix class and both pinned as tripwires: a quote or a
  bullet our anchored regexes cannot see because the `>` is never peeled before the scan.

  **One pin moved and its old expectation was a DISCLOSURE, not merely prose loss.**
  `obsidian-inside-html-block` (`tests/extract.test.ts:1201`, which NRL-74 mis-cited as `:1187`)
  went `"Before after. Visible."` to `"Before <!--"`, replaced in place per the NRL-66/NRL-67
  convention. Three independent lines converge: the asar read (module 8776 returns early unless
  `<` is the first non-tab/space character, so the mid-line `<!--` routes to module 7648's
  paragraph-scoped 4839 `.T`, which finds no `-->` in the one-line paragraph, while line 2's
  line-start `%%` opens a comment that never closes); the paragraph-bounded arm, which produces
  exactly that string; and NRL-74's own oracle, re-run unmodified with all 21 hand-traced cases
  still passing, which says `Before` is DISPLAYED while `after.` and `Visible` are HIDDEN. A
  **second** pre-existing expectation moved, and it was **not predicted by the plan** - the plan
  swept the suite's fixture ARRAYS and this one is an `expect()` call: NRL-45's decision-Q9
  second fixture, `[a]: x.png "<!--"` with its `-->` two paragraphs down, went
  `["ZAFTERZ here."]` to `["ZSECRETZ sentence here.", "-->", "ZAFTERZ here."]`. Renderer-faithful,
  and a THIRD fixture was added with the `-->` inside the opener's own paragraph so Q9's ordering
  property keeps a test.

  Evidence, **all bare Node**, four arms built side by side from `4dcb753` with the repo's own
  esbuild: **15 red before / 0 after**, of which **11 are the plan's core cases** and 3 are their
  dependent offset checks; 7 guard fixtures and 4 explicit lockstep checks were green on both
  sides and are counted as guards. Oracle-keyed two-class probe, 28 shapes x 512 combinations:
  text the renderer DISPLAYS but we silenced fell **8,448 to 1,792 of 21,504 Class-B cells, 0
  newly leaking and 0 newly lost**, with every one of the residual 1,792 named as a content-key
  exclusion the oracle cannot see (256 cells each at one constant toggle). Disclosure probes on
  both widened lookaheads: 8,704 + 3,072 cells on NRL-74's corpus, unmoved, plus 4,608 + 3,072 on
  NRL-95's own, where a genuinely hidden block's sentinel is **0 on base and 0 on the fix** while
  the "thread the array to `cleanLine` only" simplification newly speaks an image/link
  **destination** in **2,048 of 3,072** cells - which is what makes those probes non-vacuous.
  Predicate-layer subsumption: **0 widened, 178 narrowed** over 697 documents / 2,794 (document,
  line) pairs, so fail-closed is measured rather than argued; `interruptsParagraph`'s answer moved
  in 28 pairs on 3 distinct lines, all three mid-line `<!--` lines the oracle does not call an
  opener. `sourceIndex` clean by numeric UTF-16 code-unit index over **29,184 chunks / 362,752
  units** on the fix and 21,248 / 268,032 on base, with all four targeted mutators nonzero on
  BOTH arms and the `text[i] === " "` exemption shown pre-existing (13,824 on the fix, 10,240 on
  base without it). A **4,000-note fuzz** x 2 option sets: 0 newly leaking, 0 newly lost, 0
  `sourceIndex` failures, and the destination literal `](zdestz.png)` spoken in **1,601 notes on
  base and 1,601 on the fix** - identical, so this diff moves none of the pre-existing R-M09
  leaks - against 1,603 on the simplification arm. NRL-73's `%%` two-class probe re-run:
  identical on both arms, 0 newly leaking, 0 newly lost, ADR 0019's deliberately-literal class
  512 = 512. And `opensObsidianBlock`, `opensHtmlBlock`, `opensHiddenComment`,
  `interruptsParagraph`, `opensMathBlock` and `labelClose` are **byte-identical** across the diff
  by sha256 of each brace-matched body, while `codeSpanClosesLater` and `bracketClosesLater` are
  byte-identical modulo the threaded argument's type and two index expressions.

  **Two residuals NRL-95 does NOT close**, both fail-closed and both pinned so they are not
  rediscovered as new: the container/table exclusion above, and the fact that the scan is
  forward-only from the opener line and does **not** bound the opener's OWN block, so an ATX
  heading's mid-line `<!--` still reaches a later closer
  (`guard-nrl95-atx-opener-not-bounded`, the same class as the pre-existing `heading-tracking`
  `%%` divergence). So NRL-95 does not make term 2 fully faithful to module 4839 and must not be
  read as claiming it. **NOTHING WAS OBSERVED IN OBSIDIAN.** CDP port 9222 was not listening and
  no Obsidian process was running for the whole run, and no deploy happened; the renderer side
  rests entirely on reading `obsidian.asar` 1.13.7, whose bytes triage confirmed identical to the
  ones NRL-74 read, so rule 11 applies to every number above. `interruptsParagraph`'s answer set
  moved for the third time in this family, so **NRL-98 and NRL-93, which both sit downstream,
  must re-measure**. R-M08 is still **NOT** met and the `2 of 16` MUST count does not move.
- **NRL-120 closed two of NRL-111's five recorded Class B components** (`docs/adr/0025`'s
  NRL-120 section, `srs.md`'s `<!--` bullet). Both were prose loss and both reproduced on base
  `f250ddd` at exactly the recorded size before any change: NRL-111's corpus lost **51,200**
  cells on base and loses **15,360** now, the difference being exactly **30,720** (a line-start
  `<!--` over a setext underline, which is heading TEXT because `setextHeading` precedes `html`
  in `blockMethods`) plus **5,120** (a `$$` line, which `math` in `u.interruptParagraph` makes a
  paragraph end). The other three components (skipCodeBlocks, bare `1)` = NRL-119, the NRL-88
  root-1 quote class) are unchanged. Four things are load-bearing and each was added because a
  probe caught the version without it NEWLY SPEAKING hidden text: the refusal is withheld inside
  any raw HTML block and after a ` \t<!--` block (the `rawHtml` state), on any lazy list
  continuation including one under a BARE marker (`listDedented` plus `listInRun`), and on a list
  item whose later lines sit shallower than the marker (module 5540 strips the smallest non-zero
  indent across the item). And the refusal is **NOT threaded into `opensHiddenComment`**,
  deliberately against the plan: a refused `<!--` line still ends the paragraph for the
  lookaheads, and the threaded arm turns two NRL-42 "hidden text not disclosed" guards red.
  `TERM2_MATH` is `/^ {0,3}\$\$+[^$]*$/`, 0 disagreements with the executed renderer over
  48,018 exhaustive cases; `opensMathBlock` is untouched and is the wrong predicate for it. All
  censuses, the fuzz and the wrong arms are in the ADR. The headline this line used to carry,
  **"0 newly lost" over every corpus, was false**: Verify's 24.4M-cell census found **2,436 cells
  newly losing displayed text**, all through `TERM2_MATH` and all under `skipHeadings`, because
  the `$$` stop exposed the heading site's CommonMark-wide `SETEXT`. **Fixed at the root before
  merge**: Obsidian's own `MarkdownRenderer`, called in the running app over CDP, renders a setext
  heading only for an underline of the exact shape `^(?:=+|-+)$` under exactly one content line,
  and the heading site now tests exactly that (`SETEXT_UNDERLINE_EXACT` plus
  `paraStart >= lineStarts[lineNo - 1]`). An Obsidian-oracle fuzz over the 5,123 cells that differ
  from the first revision found **0 newly lost and 2,113 loss cells closed**. A second,
  independent Verify then ran its own census on the merged revision against `079cf0c`:
  **30,906,816 cells, 240 newly lost (all heading text inside a rendered `<h1>` under
  `skipHeadings`, the exclusion working) and 249,508 newly leaking, every one reproducing on
  base in a defused form**, so unmaskings rather than new disclosures (NRL-136, NRL-137 and the
  space-tab class). It also found an unmasking route the PR did not describe: the exact-underline
  heading site itself, **792 cells** where base dropped hidden text as a two-or-more-line
  "heading" under `skipHeadings`, **8** of them a code-span plus inline-comment shape outside the
  four recorded classes (``QPAQ `code`` / `` `<!--` `` / `QUAQ -->` / `===` / `QTJQ`), no ticket
  filed. Details, the seven moved expectations and the NRL-119 tripwire it leaves, in the ADR.
  **Two pre-existing Class A classes are UNMASKED, not opened** (corrected at Ship: Implement's
  censuses had no raw-HTML or reopen row after a refused heading, so their "0 newly leaking" does
  not cover them). Ship's own census, 989,184 cells against real rendered HTML, found **73,728
  newly speaking, every one reproduced on base** once the heading's `<!--` becomes plain text:
  the same-line reopen (`<!-- y --> <!--` is raw HTML to the renderer, which hides the rest of the
  note; **NRL-136**), which part 2's `$$` stop also unmasks by a second route; and raw HTML blocks
  spoken as prose, `<?x` and a `<div>` holding a mid-line `<!--` (**NRL-137**). Verify added a
  fourth, **736 cells** of a space-tab `<!--`, the NRL-93 / NRL-115 family. The
  `pin-nrl120-unmasked-*` rows are the tripwires, each beside a base control. **NRL-115 overlaps term 1**: whichever
  of NRL-115 and NRL-120 merges second must rebase and re-run both censuses (the `after setext`
  rows with leads ` `, `  `, `   `, ` \t`, `\t` are in NRL-120's corpus for that). **NOT VERIFIED
  IN OBSIDIAN BY A HUMAN, and the new extractor never ran inside Obsidian**: Obsidian's live
  `MarkdownRenderer` was used over CDP as an oracle (45 named inputs, structurally identical to
  the Node harness), but the deployed build was not loaded because Obsidian was not restarted.
  Live Preview unread, rule 11 applies. R-M08 is still **NOT** met and the `2 of 16` count
  does not move.
  **NRL-155 corrected the refusal's lead rule** (PR #201, `b0bed1b`, ADR 0025 decision 2's
  in-place amendment, `srs.md`'s `<!--` bullet). "At most three spaces, a tab is never setext
  content" was false for one to three spaces then a tab: module 134 is literal (four spaces or
  one tab at offset 0), so ` \t<!--` over `===` is a heading, and after an ATX heading, a
  thematic break or a fence line `# Head` / ` \t<!--` / `===` / `HIDDENA` / `more` spoke only
  `Head`. The plain arm now refuses for any lead `MODULE134_INDENTED_CODE` does not take, a
  tab-bearing lead only in block position (an allowlist on the raw previous line, not
  `wasPara`). Quote and list arms stay spaces-only, fail-closed. 12 core pins red on `faf55a3`,
  green after; bare Node against the executed parser, **NOT VERIFIED IN OBSIDIAN**. R-M08 not
  met, `2 of 16` unchanged.
- R-C02's Context table named three gaps: three of five install-time fields missing (language,
  installed size, license), and no remove action at all, so up to 573 MB across three Kokoro
  builds plus the ~31 MB ORT runtime could accumulate in a directory deliberately hidden from
  the vault's file tree. NRL-33 (PR #112, `cf9f7fe`) addresses all of it in `settingsTab.ts`,
  `modelStore.ts` and `kokoro.ts`: `KOKORO_MODEL_METADATA` and `VOICE_FILE_SIZE_BYTES` are
  measured off this session's own `node_modules` rather than guessed, `getInstalledSizeMb` and
  `getTotalUsage` are always a real `adapter.stat()` rather than the download-size table so a
  resumed or hand-edited file cannot silently lie, and `removeModelBuild` falls the engine back
  to `"auto"` with a notice when removing the build behind a literal Kokoro pin would otherwise
  leave `resolveSelection`'s one-element candidate list with nothing to select (owner Decision
  3). Language coverage is deliberately `English (US, UK)` with no download-other-languages
  control - `kokoro-js@1.2.1` freezes its voice map at 28 English voices, its phonemizer at
  en-us/en, and its bundled espeak-ng WASM throws on any other language code, so a button that
  looked like it worked would fetch, write, report success, and fail at play time - which is a
  scoping decision recorded on the issue, not a gap left open.
  **R-C02 is NOT recorded as met, and should not be until someone says otherwise with evidence
  named.** All of the above is bare-Node: `tests/kokoro.test.ts` and `tests/modelStore.test.ts`
  only, no deploy and no CDP session. Rule 11 applies at full force here because the change is
  entirely new `settingsTab.ts` UI surface - a model card, a measured installed-size read, a
  remove button, a confirmation flow, an engine-fallback notice - and `settingsTab.ts` imports
  `obsidian` and cannot run in the bare-Node suite at all, exactly as NRL-54's highlight settings
  rows could not. Nobody has opened Obsidian's settings tab and seen the five fields render, or
  the license text, or pressed the remove button and watched a real 522 KB or larger file
  disappear from `.obsidian/local-tts/kokoro`, or confirmed the fallback notice fires when the
  pinned engine's only build is removed. Move R-C02 to met only after that observation happens
  in a real Obsidian, and name what was seen.

- The suite count is **machine-asserted** as of NRL-85 (`tests/suiteRegistry.test.ts`, PR #117,
  `b971e96`). It derives the registry from `package.json`'s `pretest` and asserts agreement
  only, never a literal, which is why it can count itself. Four sites move together: `pretest`,
  the `test` chain, this file's `npm test` gate line (**count and full name list, in order**)
  and `srs.md`'s release-gate bullet. Adding a suite now means editing all four or the gate
  fails. The drift it closes was not hypothetical: the count moved wrong three times in one
  `/run-tickets` run, every time on a **clean** merge, because two lanes bumping the number from
  their own bases touch either different files or different lines of one file and git has
  nothing to conflict on.
  **The SKIP trap this paragraph used to describe is gone: NRL-80 replaced the tie rather than
  leaving it, which is what NRL-85 asked whoever landed it to do.** Read the history only as
  history. Checks 5 and 6 no longer parse the `test` script for suite paths - it holds none, so
  looking for them could only ever have reached that SKIP. They import the runner's own pure
  `suitePathsFromPretest` and assert what matters now: that the runner derives the same suites
  as `pretest`, in the same order, with no duplicate and every derived path shaped
  `tests/.build/<name>.test.mjs`, plus a check 5''' that `scripts.test` invokes
  `run-tests.mjs` at all. That last one is a **named failure and not a skip**. Measured on this
  tree: `suiteRegistry` reports 34 ok and **0 skipped**, nothing in the file skips today, and
  its `skip()` helper survives only behind a `void skip;` so a future conditional check has one
  ready.
  **One honest limit survives, unchanged from the chain and not widened by the rewrite.** A
  `test` replaced by a command that never invokes the runner at all still cannot be caught from
  in here, because this file runs inside the run that command would not start. Layer 2, the
  runner's own planned-versus-produced reconciliation, is the other half of the tie and is
  likewise inside it.
  Three residual holes, all inside that one file. A **trailing comma** in this file's name list
  passes silently, because the splitter filters empty entries (measured: exit 0 with a comma
  appended to `suiteRegistry`); that one is cosmetic, since no wrong count and no wrong name can
  hide behind it. `UNREGISTERED_SUITES` is an **unguarded escape hatch**: a name added to it
  drops that suite out of check 4 with nothing asserting the reason still holds. And check 4's
  disk comparator is the one comparison in the file with **no section 12 mutation guard**,
  unlike every parser and `listsEqual`, so a tidy-up there could go vacuous the way the guards
  exist to prevent everywhere else.
  Evidence is **bare-Node**. Nothing was observed in Obsidian, and for this ticket that is **not
  applicable** rather than a gap: nothing under `src/` changed and it is not user-facing. No
  requirement moves and the `2 of 16` MUST count does not move.

## Style

- No em-dashes. A plain hyphen or a rephrase.
- Comments explain *why*, and are worth writing when the reason is not reconstructable
  from the code. The existing comments in `player.ts` and `kokoro.ts` are the house style.
- Say what is true, including when something failed, is unverified, or you are guessing.
- Cite a target by a stable anchor: a function or constant name, a heading, or a quoted
  sentence, never a line number, because a line number rots on the next edit anywhere above
  it and nothing checks it. Measured: NRL-152 surveyed 53 `srs.md:<line>` citations across 22
  files and found roughly half stale, with one sentence cited seven times; NRL-134's own two
  citations rotted twice while it was open.
