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
npm run build     # typecheck + esbuild production (main.js, kokoro-worker.js, ort/)
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
npm run deploy         # build + copy into ~/Documents/Notes/.obsidian/plugins/
npm run test:obsidian  # CDP smoke test; needs Obsidian on --remote-debugging-port=9222
npm run test:inline-worker # 1 suite (nrl-15-inline-worker.test.ts): verifies main.js/ort/ after a production build; run separately, not part of npm test's bare-Node chain
```

`tests/engine.test.ts` shells out to the real `spd-say` binary and needs a running
speech-dispatcher daemon (here with the `speech-dispatcher-espeak-ng` output module). It
is a Linux desktop test and will fail elsewhere. `tests/espeak.test.ts` covers `espeak.ts`
with a fake `ProcessRunner` only: the `espeak-ng` binary itself is not installed on this
machine (confirmed via `which espeak-ng`), so there is still no real-binary coverage for
that engine, only for speech-dispatcher. The two regions of `tests/engine.test.ts` that
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
   in a way that evaluates on mobile. `child_process` is type-only plus two dynamic
   `await import()` calls inside method bodies, behind `Platform.isMobile`. Keep it that
   way, and check `main.js`'s `require()` list after any dependency change - it should
   contain only `obsidian`, `@codemirror/view`, `@codemirror/state`.

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
run**. Measured over the repo's full paginated Actions history at `01c9a84`: 112 recorded
runs, of which `release.yml` accounts for 103 and **all 103 are failures, with zero
successes ever**; 95 runs preceded the repo's first-ever successful run and every one of
those 95 was a `release.yml` failure. Two compounding defects caused it, both fixed by
NRL-69, and the comment block in `.github/workflows/release.yml` records the A/B that
isolated them: the SLSA generator was called as a step's `uses:` when a reusable workflow
has to be called at job level, **and** the reference was missing its `.yml` extension.
Either half alone stops the whole file compiling, which is why every historical run was a
0-second, 0-job failure with no log, created on branch pushes that `on: push: tags` should
never have matched at all. NRL-69 also added `.github/workflows/ci.yml`, which runs
`npm ci`, `npm run typecheck`, `npm run build`, a `require()`-list assertion and `npm test`
on every push and every `pull_request`; its first run, `36677239800`, is this repo's first
successful workflow run of any kind, and a deliberate one-line test inversion on a throwaway
branch went red as run `36678786748` with the `Test` step the only failing step, so the check
is demonstrated in both directions rather than inferred from YAML that parses.

What that does **not** establish is anything the release path does. `release.yml` is now
shown only to *compile*: the merge commit `01c9a84` on `main` produced a green `ci.yml` run
(`36679940668`) and **no** `release.yml` run at all, where every earlier push to `main`
produced a failing one. **No release tag has ever been pushed** - `git ls-remote --tags
origin` is empty and `gh release list` is empty - so `actions/create-release`, the artifact
upload and the SLSA provenance job have never executed once, and `srs.md`'s "SLSA Level 3
provenance" MUST still rests on a workflow that has never produced an attestation. Treat
R-M01 as met on its shipped files and **unexercised on its release path**. Tracked as
NRL-79. Of the two defects known to sit on that unexercised path, **NRL-75 is fixed** and
NRL-76 is not. NRL-75's own parenthesis needs correcting as well as closing: `tags: ["*"]`
does **not** match any tag, it matches any tag whose name holds no `/`, because GitHub's
published table row for `'*'` reads "Matches all branch and tag names that don't contain a
slash (`/`)" (github/docs@main `workflow-syntax.md`, read verbatim during NRL-75). So the
`backup/nrl-54-pre-split-...` tag the ticket cited was **documented-inert**, and the live
hazard was the slash-free shapes - `nightly`, `wip`, `pre-rebase`, `v0.1.0`, `0.1.0-rc1`,
`backup-nrl-54-...` - each of which would have cut a real public GitHub Release. The trigger
is now `tags: ["[0-9]+.[0-9]+.[0-9]+"]`: bare semver, no `v` prefix (manifest.json's version
is `0.1.0` and versions.json's sole key is `"0.1.0"`, so a `v*.*.*` pattern would never
fire), prereleases excluded (`prerelease: false` is hardcoded in the `Create GitHub Release`
step). These are **filter patterns, not regexes** - `*` is a wildcard and not a quantifier,
which is why `[0-9]*.[0-9]*.[0-9]*` was rejected as matching `0.1.0-rc1` - and the authority
for applying `+` to a bracket class is GitHub's own row `v[12].[0-9]+.[0-9]+`, documented as
matching `v1.10.1`. `tests/release.test.ts` pins it with three checks, and the matcher they
depend on is validated against **every row of that published table** rather than against
itself, because a wrong hand-rolled matcher would make the three checks green while the
workflow behaved differently in production. Measured: the three went red against the
unmodified file (`["*"]`, all ten operational shapes firing) and green after; the five
guards, including the `backup/`-shaped name, were green on both sides. **DESK-VERIFIED ONLY
AND UNEXERCISED**: no tag has ever been pushed, so it is not observed that `0.1.0` fires the
workflow or that `nightly` no longer does, and NRL-79 still owns that empirical half.
NRL-76 is untouched (the checksum step `cd dist || true` into a directory that does not
exist, whose output feeds the provenance job's subjects). `actionlint` 1.7.7 is not a substitute for
running it: measured during NRL-69, it was silent on **both** halves of the compile defect
that had broken every run in this repo's history, so its silence on this file is weak
evidence. The `2 of 16` headline count does not move in either direction. Note also that
`release.yml` runs will keep being created and failing on pushes of refs that predate
`01c9a84`, because GitHub compiles the workflow from the pushed ref; that is expected, not
a regression, so the 103 above grows rather than being a fixed total.

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

**A destination is still spoken**, tracked as **NRL-88**. Record it as **five distinct roots
and not one**, because earlier drafts of ADR 0023 and `srs.md` said "one mechanism" and a
reader who assumes it is just containers will fix two of the five and believe they are done.
**Root 4 is CLOSED as of NRL-88** (`docs/adr/0027`); **four remain** and root 4 leaves
named residual shapes of its own. The numbering is kept as it was so every existing citation still
resolves. The `11,520 of 19,456` headline this paragraph used to carry is **deleted rather
than updated**: it was a pre-NRL-74 baseline on a corpus nobody can reconstruct, and NRL-88
re-measured its own (below) rather than trying to reconcile it.

**Every count in this list is a pre-NRL-74 baseline and root 1's is known to be low.** NRL-74
made an unmatched mid-line `<!--` literal instead of opening a comment block, and that
**unmasked 5,120 cells of root 1** which the prose-loss bug had been hiding: a container-prefixed
soft-wrapped label carrying a mid-line `<!--` used to swallow the rest of the note, so its
destination was never reached. Measured at NRL-74's correction against base `5009eb6`, base 0 and
fix 512 in each of 10 shapes; the same shapes without the `<!--` already leaked 512/512 on both
sides, which is what makes them root 1 rather than a new class. **Re-measure this list before
reasoning from it** - see NRL-74's bullet below for the numbers and the method.

1. `interruptsParagraph` matching on the **opener** line - 2,048 of 2,048 cells, **plus the
   5,120 NRL-74 unmasked**; this row is the one the re-measure will move most.
2. `interruptsParagraph` matching on a line **between** opener and closer - 1,792 of 2,048.
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

**Roots 1 and 2 were deferred, not attempted, and are tracked as NRL-98**, and the reason is a
standing rule rather than time: fixing them means widening `interruptsParagraph`, which is
shared with `codeSpanClosesLater` and which NRL-73 and NRL-74 had just narrowed in the same run.
NRL-98 carries the reproductions, the pre-NRL-74 baselines with the instruction to re-measure
before quoting them, and the setext correction below. Root 3 is
left because clause 7a's `opensMathBlock` stop exists to fix a real prose-loss defect, and
removing it trades prose for a destination - the trade ADR 0007 clause 6 refuses. Root 5 is
clause 6's own recorded precedence rule. Neither root 3 nor root 5 has a ticket, deliberately:
each is a recorded decision rather than an open defect, so reopening either means arguing with
the reason and not just picking up a number.

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
- five roots, tracked as **NRL-88** and enumerated in the R-M09 section above - keeps
`srs.md`'s "known gap" clause alive against the same requirement; NRL-45's own
`[a]: x.png "%%"` leftover in the paragraph above is untouched; and the 2026-09-30 batch filed
two **new** defects against R-M08 that go the opposite way, hiding text Obsidian displays.
**NRL-73** (High) and **NRL-74** (Medium) are **both closed**; both are in the last
bullet of this section. Nothing in that family has been observed in Obsidian. The headline count
stays at 2 of 16, and neither closing moves it. **Four** things remain open against R-M08, and
this list is the one to check before anyone proposes closing the requirement: NRL-88's five
roots; NRL-45's `[a]: x.png "%%"` leftover in the paragraph above; **NRL-93**, the tab-led `%%`
that our `.trim()` accepts and the renderer's spaces-only skip loop does not, which silences a
paragraph's remaining lines and a container whole (NRL-74 left it untouched by construction, not
by measurement: `opensHtmlBlock` is a second predicate beside `opensObsidianBlock` rather than a
widened one, and `.trim()` is correct for `<!--` where it is wrong for `%%`); and **NRL-95**,
NRL-74's own known gap, a mid-line `<!--` whose only `-->` sits in a LATER paragraph, which we
still hide and Obsidian displays. Nothing in any of the four was exercised in a real Obsidian
(rule 11).

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
  scrolls to the top. **`y: "nearest"` is load-bearing**: no options object is passed,
  so "no jump when the highlight is already visible" is the library's behaviour, not ours.
  Measured in bare Node against the vendored `@codemirror/view`: `scrollIntoView(5)` gives
  one effect carrying `range.head 5`, `y "nearest"`, `x "nearest"`, `yMargin 5`, and in
  `dist/index.js` `moveY` is assigned only when the rect falls outside the bounding box,
  with the scroll gated on `if (moveX || moveY)`. **Do not add a `coordsAtPos` visibility
  test**: it needs a DOM the bare-Node suite cannot build and duplicates what `nearest`
  already does. `highlight.ts` is therefore **no longer decoration-only**, and its header
  comment was rewritten rather than left lying; the guarantee that survives is the cursor,
  the text selection, the focused element and the undo history, measured as a
  byte-identical `state.selection` with `docChanged === false`. The user's scroll position
  is deliberately no longer promised.
  Evidence, **bare-Node only**: `tests/highlight.test.ts` blocks 14-16, **4 red before the
  change and 0 after** (14a effect count, 14b the target offset, 14c the `nearest`
  defaults, 14f the document-length clamp). Block 17 covers the gate and is a **defect
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
  **NOTHING WAS OBSERVED IN OBSIDIAN.** No deploy happened and no CDP session was
  attempted. A bare-Node assertion that a `StateEffect` with `range.head === 18` rode on
  the transaction is **not** evidence that a user sees the view move: it says nothing about
  `scrollDOM.scrollTop`, nothing about whether Obsidian's own editor extensions intercept
  or override a scroll effect, nothing about whether the movement reads as smooth or as a
  jolt, and nothing about whether Live Preview's folds and widgets put `chunk.sourceStart`
  at the screen position a plain-text offset implies - which would scroll to the wrong
  place with a fully green suite. **Not solved, and an explicit follow-up:** nothing
  detects a manual mid-read scroll, so one is overridden at the next sentence boundary.
  R-S03 is a SHOULD, so the `2 of 16` MUST headline count does not move.
- A note switch mid-read no longer drags the highlight or the NRL-72 scroll onto the
  wrong document, as of NRL-89 (PR #116, `2b4c18a`). This is a **separate** gap from the
  "not solved" follow-up in the bullet above - that one is about a manual scroll *within*
  the note being read getting overridden, this one is about a **different note entirely**
  getting decorated and scrolled - and NRL-89 closes only the second. Before it, nothing
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
  count does not move, and this bullet does not touch the still-open manual-scroll follow-up
  recorded immediately above.
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
  settings tab's "Content" group. `offlinePreferred` is the only reserved key left, and
  still has no toggle by design (`docs/adr/0001` clause 6). Two consequences worth knowing:
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
  **Four clauses still survive deletion, recorded rather than fixed so they are not
  rediscovered as new:** **O1**, the opening `-O`'s `controller.signal.aborted`; **O3**, the
  opening `-O`'s `code !== 0`; **P3**, the per-module loop's `code !== 0`; and **S3**, a
  count-instead-of-set module comparison. No case in the suite exercises a deadline or a
  non-zero exit on the opening `-O`, or a non-zero exit on a per-module listing. **No follow-up
  ticket has been filed.** Do not read the ADR table's "nothing" rows as saying those clauses
  are dispensable - every clause is load-bearing per the comments on it.
  All of the above is **bare-Node mutation evidence**: 21 mutations of
  `src/engines/system/speechd.ts` (19 single-clause plus 2 combined), the full `npm test` after
  each, the file restored and its sha256 re-asserted every time, with no mutation that was red
  before going green after. **Nothing was observed in Obsidian**, and that caveat is unusually
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
  still spoken through five distinct roots**, tracked as **NRL-88** and
  enumerated in the R-M09 section above. **Root 4 of the five closed with NRL-88**
  (`docs/adr/0027`); four remain, plus root 4's own named residuals. The
  `11,520 of 19,456` figure that used to sit in this sentence is deleted rather than updated:
  it was a pre-NRL-74 baseline on an unreconstructable corpus, and NRL-88 measured its own.
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
  **paragraph-scoped** where ours is document-scoped.

  **So D-74-4's EOF scope is correct for term 1 and a KNOWN DIVERGENCE for term 2, and it must
  not be recorded as a decision shown right.** The residual is measured at 1,024 cells and
  identical on both sides (re-measured independently at ship review: 0 of 512 on base and 0 of
  512 on the fix for `Before x.` / `Prose <!--` / `HIDDENP` / blank / `New paragraph -->` /
  `Tail.`): a mid-line `<!--` whose only `-->` sits in a later paragraph is still hidden by us
  and displayed by Obsidian. It is not fixable without re-examining pin `:1187`, whose own
  expectation the same read makes doubtful in **both** halves - its `<!--` is mid-line so
  Obsidian displays it, and its `%%` line is a genuine line-start `%%` opener that never
  closes. Tracked as **NRL-95** (Bug, Medium, R-M08), filed at NRL-74's ship review. Note the
  direction reversal it carries: widening `opensHiddenComment` back out **narrows**
  `codeSpanClosesLater` and `bracketClosesLater`, the opposite of NRL-74, so the three D-74-9
  destination pins and `guard-nrl74-variant-C-disclosure` must be re-measured there.

  Five things are load-bearing. `opensHtmlBlock` is a **SECOND predicate**, not a widened
  `opensObsidianBlock` - merging them imports `if (37 === a) return` into `<!--`, which D-73-4
  forbids, and this IS the case NRL-66's "do not merge two scans" note describes where NRL-73's
  merge was the opposite case. The lookahead is **one scalar**, `lastHtmlCloser`, computed once
  in `extractChunks`; a per-call scan would be O(L^3). It reaches `cleanLine` as an **explicit
  required parameter**, never ambient - a module-level flag was built first and was the fifth
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
  inside them, and the unmasking landed on root 1. Roots 1, 2, 3 and 5 are **still
  un-re-measured** and their recorded counts are still pre-NRL-74 baselines.
  R-M08 is **NOT** met and the `2 of 16` count does not move.
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
  **One live trap, and it is armed for NRL-80.** Checks 5 and 6 compare the `test` script
  against the registry, and a `test` naming **no** `tests/.build/*.test.mjs` path prints two
  counted SKIPs rather than failing, deliberately, so NRL-80's runner rewrite cannot turn this
  red for no defect. The SKIP is loud rather than silent - it is counted separately, and it
  suppresses the bare `all suite registry tests passed` line that a reader would grep for - but
  what is lost is real: once `test` names no suite path, **nothing ties the registry to
  execution**. Measured at its sharpest against the shipped file rebuilt at `558bd40`, run over
  a copied tree: with `"test": "true"`, running zero suites, it prints `2 SKIPPED` and
  `all suite registry tests passed (2 skipped)` and **exits 0**. Naming some but not all stays a
  hard failure, measured on the same tree by dropping one entry from the real chain:
  `1 FAILURE(S)`, exit 1, naming the missing suite. So the degradation is the all-or-nothing
  case specifically, and whoever lands NRL-80 should replace that tie rather than read the SKIP
  as harmless.
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
