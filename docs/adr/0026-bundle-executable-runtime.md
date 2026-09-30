# 0026. Bundle the executable runtime, download nothing

- **Status:** accepted
- **Date:** 2026-09-30
- **Supersedes:** [0024](0024-ort-on-demand.md) — its distribution decision only.
  Its verification reasoning survives and is reused here; see *Relationship to
  ADR 0024* below.
- **Amends:** `srs.md` R-S02 (privacy) and the release section that described
  the runtime as fetched from a tagged release.

## Context

ADR 0024 moved the onnxruntime-web WASM and glue files out of the plugin folder
and into the vault-adjacent model directory, fetched from this plugin's own
tagged GitHub Release on an explicit user click. The reasoning that produced it
still holds: Obsidian's community-plugin installer fetches only `main.js`,
`manifest.json` and `styles.css`, so a real directory install never had those
31 MB in the plugin folder in the first place, and building them into the
installer payload would have meant the same bytes fetched by two different
paths.

What ADR 0024 did not weigh is the plugin review policy. Obsidian's
[submission guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
and the review checklist both treat a plugin that installs or updates its own
dependencies as a rejection. A runtime fetched from a release URL is exactly
that, and the fact that it is checksum-verified, is served from this plugin's
own repository, and requires a click does not change what it is: the plugin is
arranging for new executable code to run on the user's machine, from outside the
reviewed artifact. "Trust our own checksum" is not a defence, because the
checksum and the code it covers are both compiled into the very bundle the
reviewer looked at — so the review is simultaneously necessary and
insufficient, which is the worst of both rather than a mitigation.

So the distribution decision had to be revisited. The three-file install is
fixed by the host, and the runtime must be inside `main.js`.

## Decision

**The onnxruntime-web dist files are gzipped, base64-encoded and injected into
`main.js` at build time. Nothing is downloaded at runtime, ever, for any
reason.**

### Consequences, in the order they bit

1. **Every install pays for the runtime whether or not it uses Kokoro.** This
   is the real cost, and it is not small. Measured this session on the shipped
   build:

   | Asset | Plain | Gzipped, base64'd in the bundle |
   | --- | --- | --- |
   | `ort-wasm-simd-threaded.mjs` | 20,856 | 11,236 |
   | `ort-wasm-simd-threaded.wasm` | 11,133,407 | 3,818,316 |
   | `ort-wasm-simd-threaded.jsep.mjs` | 44,484 | 20,520 |
   | `ort-wasm-simd-threaded.jsep.wasm` | 21,596,019 | 6,729,200 |
   | **Total** | **32,794,766** | **10,579,272** |

   `main.js` goes from 2.3 MB to 13.6 MB. Gzip is not optional here: these are
   already-compressed-ish WASM blobs that do not compress further on their own,
   so the ~3.1x ratio is entirely base64 removing that property. A reader whose
   voice is `espeak` or speech-dispatcher pays those 10.6 MB and never touches
   them.

   **This is the cost the policy imposes, and it is accepted rather than
   worked around.** The obvious workarounds all reintroduce the thing being
   removed. A second, smaller WASM build for the WASM-only backend is a real
   option and is not what rejected here: the 11.1 MB non-JSEP build is still
   11.1 MB, and whether the JSEP build can be dropped entirely depends on the
   WebGPU path working on every runtime we claim to support, which is unverified
   on the minimum Obsidian versions. Deferring that to a measured follow-up
   rather than assuming it is the point of recording it here.

2. **Decompression is lazy and per-file.** `readBundledRuntime(name)` inflates
   one asset on demand and caches the resulting blob URL for the engine
   instance's lifetime. A Kokoro read on the WASM backend never touches the
   21 MB JSEP payload. This is a real saving on mobile, and it is the reason
   the pack is per-file rather than one concatenated blob that must all be
   inflated together.

3. **The digest is of the *plain* bytes, not the gzip stream.** Verifying what we
   just inflated is the check that a decode bug cannot pass by agreeing with
   itself. `unpackRuntimeFile` hashes the decompressed `ArrayBuffer` and throws
   on a mismatch, so a damaged install reports itself instead of handing wrong
   bytes to onnxruntime.

4. **`DecompressionStream` rather than a bundled inflate.** It is a host API
   present in the Chromium versions Obsidian ships on both platforms, so this
   adds no second implementation of a security-relevant routine and no bytes to
   the bundle. The alternative, a vendored pako, would be both larger and a
   second thing to audit.

5. **No filesystem path is involved at any point.** `paths.ts` keeps an
   `ortFile()` for one reason only: an install upgrading from ADR 0024 can still
   have real `ort/` files on disk, and `getTotalUsage` counts them so the
   "total on-disk usage" figure in the settings tab stays true rather than
   quietly shrinking by 31 MB the moment the user upgrades. Nothing reads them.

6. **The settings tab has no runtime control, and that is the honest UI.** There
   is nothing to download, nothing to go stale, and nothing to repair short of
   reinstalling the plugin, so the section now says exactly that. A "repair"
   button would imply the first install was a choice.

## What was deliberately not done

- **No CDN, no `jsdelivr`, no "fall back to a remote copy if the pack is
  broken."** Every one of those is the ADR 0024 policy under a new name, and the
  failure mode they paper over is a corrupt local install, which reinstalling
  fixes.
- **No lazy chunk loaded on first Kokoro use.** That is deferred execution of
  downloaded code, which is the same policy question with better timing.
- **No trimming of the asset list at build time** based on which backends the
  current platform could use. It would make the shipped bytes depend on the
  build machine, which makes the release unreproducible and the provenance
  attestation meaningless.

## Relationship to ADR 0024

ADR 0024 stays in the repository, marked superseded for its distribution
decision. Three parts of its reasoning are kept and reused verbatim:

- The build computes the digests from `node_modules` and compiles them in, so
  the verified bytes and the shipped bytes cannot come from different places.
- Verification happens before anything executes, not during or after.
- `ort-wasm-simd-threaded.jsep.*` is the pair the engine actually loads, and
  the other pair exists only for a WASM-only backend.

Its status classification (missing vs mismatch) and the settings-tab download
UI are gone with the download.

## Consequences

- Positive: a clean install needs nothing from the network before it can
  synthesise. There is no "download 31 MB before your first read" step, no
  partial-download state, and no state where a plugin update leaves a user's
  runtime stranded at a version the new bundle cannot use. The three-file
  install is genuinely the whole install.
- Positive: no runtime URL, so there is nothing for a network observer, a
  captive portal or an air-gapped machine to fail on, and nothing to add to a
  privacy promise.
- Negative: 11.3 MB added to every download and parse, and the bundle no longer
  parses in under a second. On a low-end device that is a real cost paid for a
  feature most readers will never use. It is accepted because the alternative is
  a plugin that cannot be submitted.
- Negative: an upgrading user with a stale `ort/` directory keeps 31 MB on disk
  until they clear it themselves. The settings tab counts it honestly; nothing
  deletes it silently, because deleting a directory a previous version created
  is not this version's call to make.

## Verification status

**What is measured in bare Node.** All four assets unpack from the shipped
`main.js` byte-identical to the files `onnxruntime-web` published, checked by
SHA-256 against `node_modules/onnxruntime-web/dist` rather than against a
self-consistent copy (`tests/release.test.ts`). `main.js` contains no
release-download URL and no release-repo constant. The three-file deploy list is
pinned. A pack whose digest does not match throws. `runtime.ts` contains no
`fetch`, no URL, and no `http`.

**What is now measured in a real Obsidian**, which this ADR previously said was
unobserved. A clean isolated vault, the three files deployed by `deploy.mjs` and
nothing else, Obsidian 1.13.7 on Linux:

- The plugin **loads**: all ten commands register, and the playback control bar
  renders in the editor.
- The settings tab renders the replacement UI as intended: the model card's
  runtime row reads **"ONNX Runtime / Status: Bundled with the plugin. Nothing to
  download."** That string is the user-visible half of this decision, and it had
  never been seen rendered.
- Model download still works and is still **user-initiated**: clicking the real
  `Download` button in the real settings window fetched 148 MB (q4f16 weights
  plus the `af_heart` voice) into `.obsidian/local-tts/kokoro`.
- With the model present, a read **completes end to end**. Automatic selection
  resolved `kokoro`, the notice read *"Reading 2 passages with Kokoro (local
  neural) on CPU (WASM, 1 thread)"*, and the player went `idle` -> `finished`
  over both chunks in 25.2 s. CPU/WASM is the backend that reads the pack, so
  this is the code path ADR 0026 is about.
- **Zero non-local network requests during a full read.** Captured on the CDP
  `Network` domain across a complete `idle` -> `finished` read, filtering out
  `app:`, `blob:`, `data:` and `chrome:` schemes: none. The runtime came out of
  `main.js`.
- **Audio really played.** The player's `HTMLAudioElement` is created with
  `new Audio()` and never attached to the document, so it is invisible to a DOM
  query. Read off the instance instead: `duration` 3.95 s, `readyState` 4,
  `paused` false, and `currentTime` advancing 0.12 -> 0.35 -> 0.54 -> 0.74 ->
  0.98 -> 1.24 over 250 ms polls. That is real-time playback, not a state
  machine that merely believes it advanced.
- Both highlight layers work and the clear works. Sampled mid-read, the sentence
  mark held `"This is a synthetic test note. No private notes are used."` while
  the word mark advanced `This` -> `is` -> `a` -> `synthetic` inside it. After
  `stop-reading`, both decoration counts were 0.
- Reading-position resume works: the trace recorded `resume from stored position
  / Release acceptance.md @ 22` on a later read.
- Rule 9 (rate applied exactly once) holds here. Through the plugin's own
  `setRate(1.5)`, the element's `playbackRate` was exactly 1.5 and observed
  media advance was 1.37x wall clock - not the 2.25x a double apply produces.

**What is still not measured, and remains the honest limit of this ADR.**
Everything above is desktop Linux, and the specific claims this ADR cannot
close are unchanged:

- Whether a 13.6 MB `main.js` parses and instantiates acceptably on the minimum
  supported Obsidian versions, and in particular on the **Android WebView**.
  Nothing here was observed on a phone.
- Whether `DecompressionStream` exists in every WebView this plugin claims to
  support, and whether inflating 21 MB through it is tolerable on a phone. It
  exists in the desktop Chromium this test used.
- Whether the existing non-SIMD Android out-of-support tier (see `AGENTS.md`,
  NRL-62) interacts badly with the size change.
- The CPU/WASM backend was the one exercised. The JSEP/WebGPU pair
  (`ort-wasm-simd-threaded.jsep.*`) is packed and verified byte-identical, but
  this machine reported `GPU available (nvidia ampere, no shader-f16)` and
  therefore fell back to the CPU, so **the JSEP files have not been loaded by a
  running Obsidian.**

Rule 11 in `AGENTS.md` still applies to the bare-Node half. The desktop half is
now observation rather than inference, which is what moved.
