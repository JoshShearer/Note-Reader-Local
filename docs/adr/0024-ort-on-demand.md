# 0024. Download the ONNX runtime on demand

- Status: **superseded for its distribution decision** by
  [0026](0026-bundle-executable-runtime.md) (NRL-96, 2026-09-30); the verification
  reasoning below is kept and reused there
- Date: 2026-09-30
- Ticket: NRL-37 (srs.md Security and Privacy; R-M01 Release Infrastructure); amends ADR 0011

> **Superseded, and kept deliberately.** Everything below is accurate history:
> this is what shipped, and why. The *distribution* half - fetch the runtime
> from a tagged release into the vault on a click - cannot be submitted to the
> Obsidian community plugin directory, because it is executable dependency
> management, which the submission guidelines prohibit. ADR 0026 bundles the
> runtime into `main.js` instead. Read the Context below for why the download
> existed at all (it is still exactly right about the three-file installer) and
> read 0026 for what replaced the distribution.

## Context

The ONNX runtime files (`ort-wasm-simd-threaded.mjs`, `.wasm`, `.jsep.mjs`, `.jsep.wasm`)
are roughly 31 MB combined (measured this session from `node_modules/onnxruntime-web`'s
`dist/` files: 20,856 + 11,133,407 + 44,484 + 21,596,019 bytes). Obsidian's own community
plugin installer fetches exactly three files from a GitHub release: `main.js`,
`manifest.json`, `styles.css`. It has never fetched a fourth, fifth, sixth or seventh
file, and never will - that is not a bug to work around, it is the installer's contract.

Before this ticket, `esbuild.config.mjs`'s `copyOrtRuntime()` wrote these files into a
repo-root `ort/` build-output directory, and `deploy.mjs` copied that directory into the
vault's plugin folder alongside the three files Obsidian's installer fetches. That worked
for `npm run deploy`, which copies everything, but it never worked for a real directory
install: under one, `ort/` is simply absent, and Kokoro cannot load. `npm run deploy`
was hiding the bug it should have caught.

ADR 0011's reasoning for vendoring these files at build time - never let the plugin reach
a CDN at runtime, verify them against a build-time-compiled checksum before trusting them -
was correct and is not discarded here. What was wrong was the assumption baked into it:
that the files would always already be present by the time `validateOrtChecksums()` ran,
because they were assumed to have shipped with the bundle. Under a directory install they
never did.

## Decision

1. **Vault-adjacent storage, same directory as weights and voices.**
   `ModelStorePaths.ortFile()` (`src/ui/paths.ts`) now resolves inside the model
   directory (`.obsidian/local-tts/kokoro/ort/<file>` by default) instead of the plugin
   folder. The model directory survives a plugin update, which replaces the plugin folder
   wholesale; the runtime files are exactly as large and exactly as disposable-on-reinstall
   as the weights already sitting there. The interface (`ortFile(name): string`) is
   unchanged - only where it resolves to moved - so `kokoro.ts`'s two call sites needed no
   change at all.

2. **Fetched from this plugin's own tagged GitHub Release assets, on explicit user
   action.** A new `downloadOrtRuntime()` in `src/ui/modelStore.ts` fetches each file from
   `https://github.com/JoshShearer/Note-Reader-Local/releases/download/<version>/<file>`,
   where `<version>` is `this.manifest.version` (bare semver, e.g. `0.1.0`) - the same tag
   shape `release.yml` already produces from a plain version-string tag push, with no new
   stored config. Triggered only by a "Download" button in the Settings tab, mirroring the
   existing Kokoro-weights download row almost verbatim, and gated identically
   (AGENTS.md non-negotiable 6: nothing fetches on load, on prewarm, or on first read).

3. **Checksums stay build-time-computed, and are now the download-time gate too, not
   only a post-hoc load-time check.** `esbuild.config.mjs`'s `computeOrtChecksums()` is
   untouched: it still reads `node_modules/onnxruntime-web`'s `dist/` files and hashes them
   locally at build time, with no network access, still injected into `main.js` as
   `__ORT_CHECKSUMS__`. What is new is that `downloadOrtRuntime()` buffers each file
   completely - never trusting bytes mid-stream - computes its SHA-256, and refuses to
   write anything to the vault if it does not match the compiled-in digest before the
   download ever started.

4. **Atomic write-to-temp-then-move; a half-written file is never promoted.**
   A new `writeBinaryAtomic()` writes to `<file>.part`, verifies its checksum, and only
   then renames it to the real filename. Any failure - a thrown write, a checksum
   mismatch, a thrown rename - removes the `.part` and leaves the final path untouched.
   A stale `.part` left over from an earlier crashed attempt is removed before a fresh
   write rather than trusted or renamed over. The only path that ever becomes the real
   filename is one that passed its checksum in full, in that attempt.

5. **`missing` and `mismatch` are distinct states, not one folded-together trace().**
   A new `OrtStatus = "missing" | "ok" | "mismatch"` and `checkOrtStatus()` classify each
   file. `missing` is the expected state on a fresh directory install - no trace, no
   Notice, since a plugin that has not been told to download its runtime yet is correct,
   not corrupt. `mismatch` is real corruption or tampering after a successful download:
   `validateOrtChecksums()` in `main.ts` still traces it (as before), and now also raises a
   user-visible `Notice`, which it did not before - a `trace()`-only failure reaches a
   diagnostics log nobody opens unprompted, which is not "visible actionable failure on
   mismatch" (the ticket's acceptance criterion).

6. **Gated identically to the model weights download.** Same explicit-click gate, same
   `DownloadProgress` shape, same per-file Notice-driven progress reporting. No
   prewarm/load/first-read trigger anywhere in the new code path.

## Consequences

- The first Kokoro use after a directory install now requires one explicit extra download
  step that the bundled-file era did not need. This is the cost the ticket accepts in
  exchange for a plugin that actually installs the ordinary way (R-M01).
- The release workflow (`.github/workflows/release.yml`) now publishes four more named
  assets per tag, alongside `main.js`/`manifest.json`/`styles.css`. What Obsidian's own
  installer fetches is unchanged - still exactly those three files - since the ORT files
  are additional assets on the same release, not a replacement for anything the installer
  already does.
- `deploy.mjs` no longer copies `ort/` into the vault plugin folder. `npm run deploy` now
  reproduces what a real directory install actually has, which is the whole point: it can
  no longer hide this bug the way it did before this ticket.
- This ADR amends ADR 0011 rather than replacing it. 0011's non-negotiables - no automatic
  fallback on checksum failure, checksums read-only in the bundle - carry forward
  unchanged. Its assumption that the ORT files are always already present at load time no
  longer holds, and its Release Infrastructure description in `srs.md` R-M01 is corrected
  alongside this ADR to describe the two-phase reality: checksums compiled at build time,
  files fetched and verified against those same digests at explicit user download time.

## Alternatives Considered

1. **Base64-inline the WASM into `main.js`.** Rejected: too large, and it would penalise
   every install, including the many that never touch Kokoro at all (the other three
   engines need none of this).

2. **Ship a native-only runtime (no JSEP/WebGPU build).** Rejected: it loses the
   GPU-capable voice path entirely, not just its speed advantage.

3. **Ship only the non-JSEP runtime.** Rejected: it loses WebGPU entirely, the same
   objection as above from a different angle.

## Risks Mitigated

- **Supply-chain tampering**: every downloaded byte is verified against a SHA-256 digest
  computed locally at build time and compiled into `main.js`, before it is ever executed.
- **Local corruption**: `checkOrtStatus()` / `validateOrtChecksums()` catch a corrupted
  on-disk file on every load, not only immediately after a download.
- **Silent fallback**: a checksum failure at download time is refused and reported per
  file; a checksum failure discovered on load is traced and now also surfaced as a
  `Notice`. Neither path falls back to anything.
- **Half-written files**: the atomic temp-then-move write means a crashed or interrupted
  download can never leave a partially-written file at the real filename, retried or not.

## Verification

Bare-Node coverage: `tests/paths.test.ts` (relocation), a new `tests/modelStore.test.ts`
(the atomic-write helper and status classification via an injected adapter, `obsidian`
having no runtime in the bare-Node suite), and two new `tests/release.test.ts` assertions
(`deploy.mjs` excludes `"ort"`; `release.yml`'s asset list includes the four ORT
filenames). **Not verified in a real Obsidian.** This environment has no reachable CDP
port and no real Obsidian instance; the settings-tab download flow, the progress Notice,
and audible Kokoro speech after a download were not driven end to end. See AGENTS.md
rules 11/12 - a green suite is not a claim that this works in Obsidian.
