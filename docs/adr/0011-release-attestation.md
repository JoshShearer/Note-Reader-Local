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

**Superseded in part by the NRL-79 amendment below; kept as written because it records
what was true at NRL-76.** Nothing here had run on a GitHub runner. No tag had ever been
pushed to this repo (`git ls-remote --tags origin` and `gh release list` were both empty),
so `actions/create-release`, the asset upload and the SLSA generator had still never
executed once, and no attestation had ever been produced. Every number above is a local
bash execution of the extracted step body, which is strong evidence about that shell and
no evidence at all about the release path. NRL-79 owned the empirical half and has since
run it.

## Amendment (NRL-79): the first exercised release

Date: 2026-09-30. Ticket: NRL-79 (R-M01). This section records the first and so far only
end-to-end execution of the release path this ADR describes. It changes no decision above.
It exists because every number in this ADR before it came from a local shell, and this
ticket's whole purpose was to replace that with an observation.

### The run

A single-variable experiment. Two tags were pushed at the **identical** commit
`3d7b3e18062cf11a86856db4e866e38075022059`, so the only variable between them was the tag
name: `nightly` first, as the negative control for NRL-75's narrowed
`tags: ["[0-9]+.[0-9]+.[0-9]+"]` filter, then `0.1.1`. `nightly` produced **no run of any
workflow**; `0.1.1` produced run
[`36785920227`](https://github.com/JoshShearer/Note-Reader-Local/actions/runs/36785920227)
**2 seconds** after the push. That run is this repo's **first successful `release.yml` run**,
against 106 recorded failures and zero prior successes. Duration 97 seconds. Both tags and
the Release were deleted afterwards, so the Release assets can no longer be downloaded.

Six jobs, all `success`, **none skipped**:

| Job | Conclusion |
| --- | --- |
| `build` | success |
| `release` | success |
| `provenance / detect-env` | success |
| `provenance / generator` | success |
| `provenance / upload-assets` | success |
| `provenance / final` | success |

The runner's own gate output was `24 suites: 24 ok, 0 failed; 4822 checks ok, 16 skipped,
0 failed`, byte-identical to the local run on the same commit, with all four npm lifecycle
lines printing `note-reader-local@0.1.1`.

### The attestation

`payloadType application/vnd.in-toto+json`, statement
`https://in-toto.io/Statement/v0.1`, predicate `https://slsa.dev/provenance/v0.2`, one
signature. Builder id
`.../slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@refs/tags/v2.0.0`.
`invocation.configSource`: uri
`git+https://github.com/JoshShearer/Note-Reader-Local@refs/tags/0.1.1`, `digest.sha1`
`3d7b3e18062cf11a86856db4e866e38075022059`, `entryPoint .github/workflows/release.yml`.

Seven subjects, which is decision 1 of the NRL-76 amendment holding on a real runner rather
than in a local shell - no `dist/` capture, no silent truncation:

| Subject | sha256 |
| --- | --- |
| `main.js` | `ba0c4e297fbf91fddd5fde78e1ff271071ed17facd4c5799d0294b21cf188d9d` |
| `manifest.json` | `9bc49cccc389276581bdb54da5caf3682e7479e7d09a2228ce53bc7190151e18` |
| `styles.css` | `710ec3172ce6158b19cf02fa7ef6fafc9c361f4bcd92f7709babe9ec98d00575` |
| `ort/ort-wasm-simd-threaded.mjs` | `43c25054b6b9ac000f786c65545ff83a45f871e0e310e8c2f4d48a363bb66db4` |
| `ort/ort-wasm-simd-threaded.wasm` | `f061472c6e77d6d50d079aacdc0ff9b63fee287ddd2cbf46cf62438d3891de2b` |
| `ort/ort-wasm-simd-threaded.jsep.mjs` | `08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9` |
| `ort/ort-wasm-simd-threaded.jsep.wasm` | `c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39` |

Those seven digests were checked twice against real bytes, from two independent sources:
against the sha256 of the seven downloaded Release assets while the Release still existed,
and again - after it was deleted - against the seven files in the run's still-live `dist`
workflow artifact. Both comparisons are set-equal with no extras and no omissions. Subject
names keep the `ort/` prefix while the assets are flattened basenames, exactly as decision 3
above intends.

The envelope is 16,968 bytes, sha256
`f871d6c808218d1ba895e70b8ec9c5444ceb605d1a4bf0fa55aee84b95de9cba`; its decoded 10,547-byte
payload is sha256 `03fb877c9a1f9b9673607bac21dd1c00d3e79155a9f13c980ba3e6dcedf9c021`. Both
equal the `envelopeHash` and `payloadHash` Rekor serves for the entry.

### Signature and certificate

The DSSE PAE was rebuilt (`DSSEv1 28 application/vnd.in-toto+json 10547 <payload>`, 10,592
bytes) and verified against the signing certificate's P-256 public key with
`openssl dgst -sha256 -verify`: **`Verified OK`**, with a tamper control (one flipped byte
at offset 5000) giving **`Verification failure`**.

The leaf certificate chains to Fulcio's published root:
`openssl verify -CAfile root.pem -untrusted inter.pem -attime 1790807476 -x509_strict`
returns `OK`. Root fingerprint
`3B:A7:B6:CC:4E:95:46:9D:4D:33:4B:49:CB:25:7A:D8:53:70:76:FA:84:B0:CA:87:FF:4E:CF:E6:A5:46:80:C1`.
Certificate validity 2026-09-30T22:31:16Z to 22:41:16Z, with a CT Precertificate SCT.

Every identity claim in it names this repository and this run: OIDC issuer
`https://token.actions.githubusercontent.com`, SAN the
`generator_generic_slsa3.yml@refs/tags/v2.0.0` reusable workflow, trigger `push`, sha
`3d7b3e18062cf11a86856db4e866e38075022059`, repository `JoshShearer/Note-Reader-Local`, ref
`refs/tags/0.1.1`, build config
`.github/workflows/release.yml@refs/tags/0.1.1`, run invocation
`.../actions/runs/36785920227/attempts/1`, runner environment `github-hosted`, repository
visibility `public`.

### Transparency log

Rekor entry uuid
`108e9186e8c5677a9dbc7018a00a5be00677d7a60223c5df12485367a30bc1a46bf46013a8350b1b`, kind
`dsse` apiVersion `0.0.1`, logIndex 3026377928, integratedTime 1790807476 =
2026-09-30T22:31:16Z. `GET https://rekor.sigstore.dev/api/v1/log/entries/<uuid>` returns
HTTP 200. The entry carries a `signedEntryTimestamp` and a 27-hash `inclusionProof`. It is
append-only: deleting the tag and the Release does not remove it.

### What this amendment does NOT establish

**No TUF-rooted verifier was run, and this is not "verified to SLSA Level 3" in the
conventional sense.** Specifically:

1. The trust anchor was Fulcio's root fetched over **TLS** from `fulcio.sigstore.dev`, not
   obtained through the Sigstore **TUF** root. The chain verification is therefore rooted in
   web PKI plus that hostname, which is weaker than what `slsa-verifier` does.
2. Rekor's `signedEntryTimestamp` was **not** verified against Rekor's log public key, and
   the 27-hash inclusion proof was **not** recomputed against a signed checkpoint.
3. The CT SCT was **not** checked against a CT log key.
4. **No SLSA policy check ran.** Nothing asserted "this builder is trusted at L3 for this
   source repo" as a policy decision; the fields such a policy would read were read by hand
   and found correct.

The tooling absence is the reason, not a choice about rigour: `gh` is 2.45.0 and has no
`attestation` command, and neither `slsa-verifier` nor `cosign` is installed on this machine.
Installing an unverified binary was out of scope.

Two further limits. **One run, one tag, one day**, on `ubuntu-latest`, with three
`The set-output command is deprecated and will be disabled soon` warnings from
`actions/create-release@v1`; nothing about recurrence follows, and **2026-10-19** (the
`ubuntu-latest` migration to Ubuntu 26) is a dated re-verification trigger. And **nothing was
installed into Obsidian** - the Release existed for about two and a half minutes and was
digested and deleted, never installed from - so `srs.md`'s headline "MUST install as an
ordinary Obsidian Community Plugin" remains unobserved and is now the binding gap on R-M01.
