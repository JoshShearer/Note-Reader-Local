# 0011. Release attestation with SLSA provenance

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-16 (R-M01)

## Context

Obsidian's community plugin installer downloads exactly three files from a GitHub release:

```
main.js   manifest.json   styles.css
```

The plugin also ships ORT runtime WASM files (`ort/`) as part of the release artifact. These files are critical to on-device speech synthesis and must not be tampered with.

The risk: a compromised GitHub account or intercepted download could inject malicious code or replace ORT files with corrupted versions, silently breaking speech synthesis or introducing vulnerabilities.

The solution: SLSA Level 3 provenance attests that the released bundle was built from a specific commit, without unauthorized modifications, by the official GitHub Actions workflow.

## Decision

1. **SLSA sigstore/cosign attestation** (per Obsidian's official workflow pattern):
   - GitHub Actions builds the release, runs quality gates (typecheck, tests, build).
   - SLSA GitHub Generator creates provenance and uploads it as an artifact.
   - Release notes include the provenance link.
   - Users and tools can verify the release matches the source.

2. **ORT checksum compilation and validation**:
   - At build time (production only), compute SHA-256 checksums of all ORT files.
   - Inject checksums into `main.js` via esbuild `define` (read-only, never modified at runtime).
   - On plugin load, validate checksums against the actual ORT files.
   - Non-negotiable: no automatic fallback on checksum failure; user is told to re-install.

3. **Quality gates before release**:
   - Typecheck must pass (`tsc --noEmit --skipLibCheck`).
   - Full test suite must pass (`npm test`).
   - Production build must succeed (`npm run build`).
   - Only after all gates pass are artifacts uploaded to the release.

4. **Non-negotiables**:
   - **No model weights downloaded during build**. Checksums apply only to published ORT runtime files, not to Kokoro weights (which are user-downloaded, gated separately).
   - **No silent cloud fallback on attestation failure**. If checksums don't match, the user sees an error and is told the install may be corrupted.
   - **Checksums are read-only in the bundle**. They are injected at build time and never modified, so a compromised runtime cannot silently update them.

## Consequences

1. **SLSA provenance** gives users and distribution tools a cryptographic proof of origin. The slsa-github-generator workflow publishes provenance to the GitHub release as an SLSA provenance statement.

2. **ORT checksum validation** catches file corruption (accidental or malicious) without downloading anything on load. The check is fast (read files from disk, compute hash) and provides immediate visibility if something is wrong.

3. **Quality gates in the release workflow** ensure that builds tagged for release have passed all automated checks, matching the promise that `npm run build` would pass locally.

4. **Checksums compiled into main.js** means they travel with the plugin and are auditable in a bundle reader (e.g., decompiling main.js would show the expected hashes).

5. **No automatic fallback** keeps the non-negotiable-4 promise ("no silent cloud fallback") airtight: a checksum failure is visible, not hidden.

## Implementation

### Workflow (`.github/workflows/release.yml`)

- Triggered on git tag push.
- Builds (`npm run build`), runs all gates.
- Generates SLSA provenance using slsa-framework/slsa-github-generator.
- Uploads main.js, manifest.json, styles.css to the GitHub release.
- Uploads SLSA provenance as an artifact.

### Build-Time Checksum Injection (`esbuild.config.mjs`)

- `computeOrtChecksums()` reads ORT files from `node_modules/onnxruntime-web/dist/`.
- Computes SHA-256 hash for each file.
- Injects hashes into esbuild's `define` section as `__ORT_CHECKSUMS__`.
- Production builds only; development builds omit checksums.

### Runtime Validation (`src/main.ts`)

- `validateOrtChecksums()` runs on plugin load if `__ORT_CHECKSUMS__` is defined.
- Reads each ORT file from the plugin folder.
- Computes SHA-256 hash and compares to the embedded checksum.
- Logs any mismatch via `trace()` (no note text, just filenames and hashes).
- Does not block plugin load; user sees error in console.

## Alternatives Considered

1. **Embed checksums in manifest.json** - Rejected because manifest is mutable in the plugin folder (user settings writes back to it, erasing custom keys per R-M13 non-negotiable 10).

2. **Sign individual ORT files** - Rejected because it adds complexity (cosign per file) and doesn't integrate with the release workflow as cleanly.

3. **Trust GitHub's release integrity** - Rejected because it does not account for local file corruption or user error (moved/renamed files). Checksums provide local verification.

## Risks Mitigated

- **Supply chain tampering**: SLSA provenance proves the bundle came from the official source.
- **Local file corruption**: Checksums detect corrupted ORT files on load.
- **Silent fallback**: No automatic recovery; user is told to re-install.

## Future Work

- Integration with Obsidian's official plugin installer for provenance verification (currently manual).
- Per-release changelog linked to the provenance statement.

## Amendment (NRL-76)

Date: 2026-09-30. Ticket: NRL-76 (R-M01). This section narrows decision 1 above, which
said "SLSA GitHub Generator creates provenance" without ever saying over WHAT. That
silence was the defect: `release.yml`'s `Generate checksums` step is the only thing that
decides the subject set, and it decided it by accident.

### What the step used to do

```yaml
cd dist || true
if [ -f main.js ] && [ -f manifest.json ]; then
  sha256sum main.js manifest.json styles.css 2>/dev/null | base64 -w0 > checksums.txt
  echo "hashes=$(cat checksums.txt)" >> $GITHUB_OUTPUT
fi
```

There is no `dist/` in this repo. `npm run build` writes `main.js` and `ort/` to the
repo root, `deploy.mjs` reads from the root, and `.gitignore` never mentions `dist`. The
`|| true` swallowed the failed `cd`, so the step stayed in the root and found three of
the right files by accident.

Measured during NRL-76 by extracting this exact body and running it under `bash -e`
(GitHub's documented default for a `run:`, which is `set -e` alone; `-o pipefail` is
added only when `shell: bash` is written explicitly) in a sandbox populated at the paths
`Upload Release Assets` publishes:

- **3 of 7 published assets** were attested. The four `ort/` files had no subject.
- With a `dist/` present holding different bytes under the same three names, the attested
  `main.js` digest was the dist copy's `e32e168f...`, not the root's `79a8a4a7...`. Any
  future build step, cache restore or action that creates a `dist/` would have captured
  the attestation silently.
- With `styles.css` deleted the step **exited 0 and still wrote a 216-byte `hashes=`**
  covering only two files - a silently truncated attestation, which is worse than the
  absent one the ticket predicted. The predicted empty-output case needs `main.js` or
  `manifest.json` to be the missing file.
- A `checksums.txt` was left in the workspace.

### Decision

1. **The subject set is the seven assets `Upload Release Assets` publishes**: `main.js`,
   `manifest.json`, `styles.css` and the four `ort/ort-wasm-simd-threaded.{mjs,wasm,
   jsep.mjs,jsep.wasm}` files. `tests/release.test.ts` asserts the decoded subject set
   EQUALS the upload step's own `files:` list rather than a hardcoded list, so the two
   cannot drift apart again.

2. **The ORT files are in.** They are published on the same tagged Release and R-M01
   clause 3 / ADR 0024 make them the bytes a user downloads at runtime, so attesting 3 of
   7 left the two largest downloadables (21.6 MB and 11.1 MB) with no subject at all.
   That they are copied from `node_modules` by `copyOrtRuntime()` rather than compiled
   here is an argument FOR inclusion: SLSA provenance binds an artifact to the builder and
   the source commit, and a build that copies a dependency's bytes into a public release
   is exactly the injection point provenance covers. The `__ORT_CHECKSUMS__` digests
   compiled into `main.js` (decision 2 above) are a second layer, not a substitute - they
   only protect a user who already trusts `main.js`, and they cannot be checked without
   running the plugin, whereas a subject lets a verifier check the downloaded bytes
   directly.

3. **Subject names keep their repo-relative `ort/` prefix** rather than being flattened to
   the release-asset basenames. slsa-verifier's `verifyDigest`
   (`verifiers/internal/gha/provenance.go`) compares only `subject.Digest["sha256"]` and
   never the subject name, so a rewrite would buy no verification benefit and would add one
   more silent name-transformation stage - the class of thing this amendment removes.

4. **`set -euo pipefail` lives in the step's `run:` body, not in `shell: bash`.** The body
   is what `tests/release.test.ts` extracts and executes; a harness-level flag would be a
   guarantee no test covers.

5. **The non-empty guard lives in the build step and nowhere else.** Do NOT add
   `if: needs.build.outputs.hashes != ''` to the `provenance` job. A failing build step
   already stops provenance through `needs: build`, whereas an `if:` would SKIP the job
   silently and produce a green run with no attestation - strictly worse than the defect.

### Size and format, measured not assumed

`base64-subjects` decodes to plain `sha256sum` output. The generator's only documented
limit on it is the runner's `ARG_MAX`
(`slsa-github-generator@v2.0.0 internal/builders/generic/README.md`), with
`base64-subjects-as-file` as the documented escape hatch; it is not needed here. Measured
against the lane's real built tree: **3 subjects = 308 base64 characters, 7 = 844**.

### What this does not establish

Nothing here has run on a GitHub runner. No tag has ever been pushed to this repo
(`git ls-remote --tags origin` and `gh release list` are both empty), so
`actions/create-release`, the asset upload and the SLSA generator have still never
executed once, and no attestation has ever been produced. Every number above is a local
bash execution of the extracted step body, which is strong evidence about that shell and
no evidence at all about the release path. **R-M01 stays unmet**; NRL-79 owns the
empirical half.
