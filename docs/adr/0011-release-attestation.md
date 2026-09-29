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
