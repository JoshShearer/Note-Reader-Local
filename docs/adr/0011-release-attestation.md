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

2. **ORT checksum validation** catches file corruption (accidental or malicious) without downloading anything. As of NRL-96 (ADR 0028) it also covers the case where there is nothing on disk to be corrupt: the runtime is packed into `main.js`, and each pack entry is verified against its compiled-in digest after decompression, so a damaged bundle reports itself instead of handing wrong bytes to onnxruntime.

3. **Quality gates in the release workflow** ensure that builds tagged for release have passed all automated checks, matching the promise that `npm run build` would pass locally.

4. **Checksums compiled into main.js** means they travel with the plugin and are auditable in a bundle reader (e.g., decompiling main.js would show the expected hashes). Since ADR 0028 that is no longer only an audit affordance: the digests now guard the only copy of the runtime that exists.

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

   **Superseded in part by ADR 0028 / NRL-96**: the ONNX runtime now ships packed inside
   `main.js`, `npm run build` emits no `ort/` directory at all, and the upload step
   publishes the three files only - so the set is **three** subjects today, not seven. The
   mechanism in this clause is unchanged and is why nothing had to be edited for it: the
   assertion reads the upload step's own `files:` list, so the subject set followed the
   published set down from seven to three on its own. Decision 2 below is the clause ADR
   0028 actually retired.

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
executed once, and no attestation had ever been produced. (`actions/create-release` was
deleted by NRL-104; see the amendment at the end of this file. This sentence is correct
history and is left as written.) Every number above is a local
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
`ubuntu-latest` migration to Ubuntu 26) is a dated re-verification trigger. (Those three
warnings are what NRL-104 acted on; the step that emitted them is gone, and that dated
trigger is now also the trigger for re-running the replacement. See the amendment at the
end of this file. This paragraph is correct history and is left as written.) And **nothing was
installed into Obsidian** - the Release existed for about two and a half minutes and was
digested and deleted, never installed from - so `srs.md`'s headline "MUST install as an
ordinary Obsidian Community Plugin" remains unobserved and is now the binding gap on R-M01.

## Amendment (NRL-104): one action creates the Release and uploads its assets

The `release` job ran two actions back to back. `Create GitHub Release`
(`actions/create-release@v1`) cut the Release; `Upload Release Assets`
(`softprops/action-gh-release@v1`) then attached the three published files to it. The
second action can do both jobs, so the first step is **deleted** and `softprops` now
creates the Release as well as uploading to it.

**Nothing was broken.** This is scheduled work on a published deprecation path, not a fix
for an outage. NRL-79's run `36785920227` succeeded with both steps in place.

### What the deletion removes, and what it does not

Three things go with the step, and only the first is the reason the ticket exists.

1. **The `set-output` deprecation.** All three `The set-output command is deprecated and
   will be disabled soon` warnings in NRL-79's run log came from
   `actions/create-release@v1`. It is the one observed thing that will actually break this
   path when GitHub disables the command. **Credit this to the DELETION and not to the
   version choice**: both `softprops` dists - `v1`'s commit `de2c0eb8` and `v3.0.3`'s
   `efb35369` - hold **zero** literal `::set-output`, measured by reading each tree's
   `dist/index.js` in this session. Upgrading `softprops` fixes nothing here; removing
   `actions/create-release` is what fixes it.
2. **The `tag_name: ${{ github.ref }}` shape.** The deleted step passed the full
   `refs/tags/0.1.1` where its own adjacent `release_name:` used the bare
   `github.ref_name`. NRL-79 measured it harmless - the Release came out with the bare tag
   `0.1.1` and `git ls-remote` showed no stray `refs/tags/refs/tags/...` ref - but it
   survived only on server-side normalisation this repo does not control. **No `tag_name:`
   is set on the replacement, deliberately.** `softprops/action-gh-release` defaults its
   tag to `github.ref`, so naming it would put the same shape straight back for no gain.
3. **A `using: node12` runtime**, the oldest in the file. It ran fine on 2026-09-30 and no
   deprecation annotation named it.

### The pin

`uses: softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64 # v3.0.3`.

Pinned by **commit** rather than by tag, because a tag is rewritable by whoever owns it,
with the trailing `# v3.0.3` comment carrying the human-readable version. Resolved on this
machine in this session rather than from memory (AGENTS.md rule 14): the ref
`tags/v3.0.3` is an **annotated tag object** `e598afbe1493e6b1bafb1f389cabb956eab91231`,
which dereferences to commit `efb35369e0ad2afab669f228072c1b0d510eae64`, tagger date
2026-08-30. That tree's `action.yml` declares `using: "node24"` and defines every input
used here. **The annotated-tag indirection is a real trap**: the ref endpoint's
`.object.sha` is the tag object, not a commit, and pinning it would be wrong.

**`v1` was considered and rejected.** Its tag has not moved since 2022-11-21, corresponds
to release `v0.1.15`, and declares `using: "node16"` - also deprecated. Pinning it would
have preserved exactly today's behaviour at the cost of leaving goal 3 above half done.
The cost of the upgrade is accepted in exchange: two major versions of behaviour change in
an action nobody here has run at that version.

### `fail_on_unmatched_files: true`

This input is **not optional and not housekeeping**. The action's own `action.yml`
documents it as *"Fails if any of the `files` globs match nothing. Defaults to false"* and
sets no `default:` key, so without it a run where `main.js` failed to arrive publishes a
Release carrying fewer assets than the attestation covers **and still concludes success**.
That is exactly the NRL-76 silent-truncation shape - a green run shipping provenance whose
subject set does not describe what the Release holds - which decisions 4 and 5 above
refuse. It is the same fail-closed reasoning as the non-empty guard in `Generate
checksums`, applied at the publishing end.

### `files:` stays last, and the prose above the step matters too

`extractUploadedFiles` in `tests/release.test.ts` is the single source of truth tying the
hashed set to the published set (decision 1). It is a regex over the workflow text, not a
YAML parse, and its capture ends at the **first blank line**, not at the next YAML key. So
the replacement's `with:` block puts `files: |` **last**, with the blank line after it, and
`name:`, `draft:`, `prerelease:` and `fail_on_unmatched_files:` all above it. A key written
below it would be trimmed into the published-asset list and reported by the NRL-76
subject-set check as `extra`.

One thing here was **measured during implementation rather than reasoned, and it is new**:
the regex takes the **first** occurrence of its anchors anywhere in the file, so a *comment*
above the step quoting `Upload Release Assets` or the `files:` block scalar verbatim also
hijacks the capture. A first draft of the explanatory comment did exactly that, and the
NRL-76 equality check went red with comment prose reported as published assets. The comment
now names neither literally - which is why the pre-existing comment near `Generate
checksums` splits the step name across two lines - and the two reworded comments at the top
of the file say "the release-upload step below" rather than the literal name. This is a
fragility of the extractor, not of the workflow, and it is written down here because the
failure looks like an attestation defect and is not one.

`name: Release ${{ github.ref_name }}` is carried over so the Release keeps the title
NRL-79 observed as `Release 0.1.1`. `draft: false` and `prerelease: false` stay explicit:
the second is the other half of NRL-75's semver-only `on: push: tags` filter. No
`env: GITHUB_TOKEN` - the job already carries `permissions: contents: write` and the action
reads the default token.

### What this does not establish

**This path is unexercised on a real runner again.** NRL-79's single successful run
`36785920227` exercised `actions/create-release@v1` plus `softprops/action-gh-release@v1`;
that one empirical data point **no longer covers the shipped configuration**. No tag has
been pushed since, so the Release-creation half of the release path is back to where it
stood before NRL-79: desk-verified only. The existing **2026-10-19** re-verification
trigger (the `ubuntu-latest` migration to Ubuntu 26) now covers this as well, and re-running
the path after that date is the only thing that will close it.

All evidence for this amendment is: the workflow text; `gh api` reads of the action's refs,
tags and tree on this machine; a replay of the real `extractUploadedFiles` regex against the
edited file, capturing exactly `main.js`, `manifest.json`, `styles.css`; a PyYAML parse of
the whole workflow (no `yaml` or `js-yaml` is installed in `node_modules`, so the suite's
own helpers remain regexes); and eight new checks in `tests/release.test.ts`, five of which
were measured red against the unedited workflow. `actionlint` is **not installed on this
machine** and was not run; AGENTS.md records it as having been silent on both halves of the
compile defect that broke every run in this repo's history, so its absence costs little.
Nothing about the Release this produces has been seen, because none has been cut.

## Amendment (NRL-105): the pushed tag is checked against the version files

NRL-75 narrowed `on: push: tags` to `[0-9]+.[0-9]+.[0-9]+`, so the workflow admits only a
bare-semver tag. It admits **any** bare semver. Nothing anywhere read `manifest.json`,
`package.json` or `versions.json`, so pushing `9.9.9` at a commit whose manifest says
`0.1.0` would cut a public Release named `9.9.9` carrying a manifest that says `0.1.0`.

Obsidian's community-plugin installer reads `manifest.json` off the Release to learn the
plugin's version, and reads `versions.json` to decide which Obsidian versions may install it.
**The two come from different places, and an earlier draft of this amendment got the second
one wrong by saying both are read off the Release.** Read out of the installed `obsidian.asar`
(flatpak Obsidian 1.13.7, measured during NRL-105's Verify): the install path fetches
`manifest.json`, `main.js` and `styles.css` through `Py(repo, tag, file)` =
`https://github.com/` + repo + `/releases/download/` + tag + `/` + file, while the string
`versions.json` occurs **exactly once in the whole asar** and is fetched through
`Dy(repo, "versions.json")` = `https://raw.githubusercontent.com/` + repo +
`/HEAD/versions.json`, whose loop keeps the greatest key whose value satisfies the running app
version. So `versions.json` is read **from the repository at `HEAD`**, never from the Release.

That gives this step a real scope limit, and it is a limit of where the two sides look rather
than a defect in the step: **the guard reads the tagged commit's three files, while the
installer reads `versions.json` at `HEAD`.** A `versions.json` edited after the tag was cut -
a key removed, or its value changed - is therefore outside what the guard can see, and the
guard's agreeing at tag time is not a promise about what the installer will read later. The
guard is not widened to chase it: a step that fetched `HEAD` would make the release path depend
on a mutable ref, which is the opposite of what the rest of this ADR is for. The honest
statement is that the guard pins the tagged commit, and nothing pins `HEAD`.

A tag that disagrees with either file publishes a Release whose name and contents contradict each
other, and the user-facing symptom is an install reporting the wrong version or being
silently filtered out of the compatible set. Every other item left open on this path - the
`set-output` deprecation, the `tag_name` shape, the provenance job's `needs:` - is a CI-side
hazard; AGENTS.md records this one as "the one item here with a user-visible failure mode",
and this amendment is what retires that sentence.

A new `build`-job step, `Verify the tag matches the version files`, closes it.

### Decision

Numbered **1-8 within this amendment**. They do not continue the NRL-76 amendment's
decisions 1-5, which are referenced below by their own numbers.

1. **Three comparisons, exactly the three the ticket names.** `manifest.json`'s `version`
   must equal `github.ref_name`; `package.json`'s `version` must equal it; and
   `versions.json` must hold a key equal to it, tested with
   `Object.prototype.hasOwnProperty.call` rather than a substring or `grep` search. The key
   test is deliberately exact in both directions: `0.1.01` *contains* `0.1.0` and `0.1` is a
   *prefix* of `0.1.0`, and both must fail. Nothing normalises the tag - a `v`-prefixed tag
   fails rather than being stripped - because normalising is how the class of mismatch this
   step exists to catch would come straight back.
2. **Fail, and never rewrite.** The step does not touch any of the three files. A workflow
   that edits the version it is releasing is a worse failure mode than a stopped release:
   the pushed tag, the reviewed commit and the signed SLSA attestation would then describe
   three different things, and the attestation would be *correct* about bytes nobody
   reviewed.
3. **The tag arrives through `env:`, and the body reads `"$TAG"`.** Two reasons, and both
   matter. It is the documented script-injection-safe shape: a `${{ }}` expanded into a
   shell body is expanded by the expression engine before bash ever sees it. And it is what
   makes the body testable at all - `extractRunBlock` in `tests/release.test.ts` returns the
   `run:` block **verbatim**, so a `${{ }}` written inside it would survive into the
   extracted script as an unevaluable literal and every execution check in the suite would
   be exercising something the runner never runs. A check pins that the body contains no
   `${{` at all.
4. **node, not jq.** `Setup Node.js` (`actions/setup-node@v4`) runs two steps upstream, so
   node is on PATH by an explicit step rather than by whatever `ubuntu-latest` happens to
   preinstall. The test harness guarantees node where it does not guarantee `jq`. (`jq` *is*
   installed on the machine this was written on, `/usr/bin/jq`, so the decision rests on the
   runner rather than on the sandbox.)
5. **Shell options live in the body**, `set -euo pipefail` as its first line, per this ADR's
   NRL-76 amendment decision 4: the body is what the suite executes, and a `shell: bash` key
   would be a guarantee no test covers. Honestly, per option: `-u` is **load-bearing** - it
   turns a typo'd variable name into a hard error instead of an empty comparison, which here
   is the difference between a failed run and a Release nothing checked. `-e` and
   `-o pipefail` are **precedent and future-proofing, not load-bearing today**: the `node -e`
   is the last command in the body so its exit status ends the script either way, and there
   is no pipeline in the body at all. They are kept because `Generate checksums` has them,
   because NRL-76's whole defect was a missing `pipefail` under a `sha256sum | base64`, and
   because the next person to add a second command here should not have to remember.
   Note the `-z "${TAG:-}"` form: the `:-` is deliberate, so an *unset* `TAG` produces this
   step's own named message rather than bash's `TAG: unbound variable`.
6. **No `if:` on the step, deliberately.** `release.yml`'s `on:` mapping is exactly
   `{push: {tags: ["[0-9]+.[0-9]+.[0-9]+"]}}` - measured, not assumed, by parsing the whole
   file with PyYAML and by slicing the text from `on:` to `jobs:` and listing its keys by
   indentation depth. There is no `workflow_dispatch`, no `workflow_call`, no `schedule`, no
   `repository_dispatch` and no `branches:` anywhere in the file, so the `build` job cannot
   run with `github.ref_name` being anything but the pushed bare-semver tag. A condition's
   only possible effect would therefore be to make the step skippable, and this ADR's
   NRL-76 amendment decision 5 refuses exactly that: a silent skip on a real tag push is
   strictly worse than a failure. What replaces the condition is a **tripwire test** on the
   `on:` block, green on both sides of this change, which fails the moment a non-tag trigger
   is added and forces whoever adds it to decide what the guard does on a branch ref -
   instead of the guard quietly failing every such run. The body also fails loudly when
   `TAG` is empty or unset, which is the fail-closed answer to that same hypothetical; it is
   not a skip.
7. **Every disagreement is reported, not the first.** The body collects into a `problems[]`
   array and prints all of it to stderr, each line naming the file, the value found and the
   tag. A release is cut by pushing a tag, and a tag is expensive to retry: it has to be
   deleted locally and remotely, and every failed attempt leaves a permanent run in Actions
   history (AGENTS.md records 106 `release.yml` failures already). Stopping at the first
   mismatch would mean three push-fail-delete cycles for one half-finished version bump.
8. **A `versions.json` key must map to a non-empty string**, and the sentinel for an
   unreadable or malformed file is **`undefined`, not `null`**. That second half is not
   stylistic. A first draft used `null` as the sentinel and skipped the `versions.json`
   checks when `load()` returned it, so a `versions.json` whose entire content is the
   literal `null` **exited 0** - measured during prototyping. `JSON.parse` can return `null`
   and can never return `undefined`, so `undefined` is the only safe sentinel, and the
   object test rejects `null` and arrays explicitly. The empty-value rule follows from what
   the key is for: it carries the minimum Obsidian version string the installer reads, so an
   empty or non-string value is indistinguishable in effect from the missing key the ticket
   already requires failing on.

   **What is deliberately NOT checked**: `versions.json`'s value is not compared against
   `manifest.json`'s `minAppVersion`; there is no semver ordering; there is no monotonicity
   check against the keys already present; and nothing checks that the tagged commit is
   reachable from a branch. The first of those was scoped out explicitly, and the rest were
   never in scope.

### Placement in the job

After `Install dependencies` (`npm ci`) and **before** `Run quality gates`. The guard reads
three small JSON files, so it costs seconds; running it after the gates would mean a
mismatched tag had already paid for a full typecheck, build and test. It needs `npm ci`
before it only incidentally - it imports nothing - and sits after it because that is where
the first cheap check belongs in this job's existing shape.

The explanatory comment block that sits above `Run quality gates` (the build-before-test
ordering and `NRL_SKIP_REAL_SPEECHD`) belongs to that step and was **not** detached: the new
step goes in above it, not between it and the step it documents.

One fragility of the test extractor had to be respected while writing the new comment, and
it is the same one the NRL-104 amendment records: `extractUploadedFiles` anchors on the
**first** occurrence of its two literal anchors anywhere in the file, so a comment quoting
the upload step's name or its block scalar verbatim hijacks the published-asset capture. The
new comment quotes neither, and the real regex was re-run against the edited file to confirm
it still captures exactly `main.js`, `manifest.json`, `styles.css`.

### What this does not establish

**The guard has never run on a GitHub runner.** No tag has been pushed to this repo since
NRL-79's `0.1.1` on 2026-09-30, and this ticket pushes none, so like the NRL-104 amendment
this is desk-verified only and the existing **2026-10-19** re-verification trigger (the
`ubuntu-latest` migration to Ubuntu 26) is what covers it. Nothing here establishes that
`github.ref_name` arrives in `TAG` as expected on a real runner, only that the body behaves
correctly when it does.

All evidence for this amendment is: the workflow text; a PyYAML parse of the whole edited
file (no `yaml` or `js-yaml` is installed in `node_modules`, which is why the suite's own
helpers remain regexes) confirming the `build` job's step order as
`checkout, Setup Node.js, Install dependencies, Verify the tag matches the version files,
Run quality gates, Generate checksums, Upload build artifacts`; a replay of the real
`extractUploadedFiles` regex against the edited file; and **18 checks in
`tests/release.test.ts`, 17 of which were measured red before the step existed** - 16 because
`extractRunBlock` throws a named diagnosis when the step is absent, plus the check on this
amendment's own existence. The 18th is the `on:`-block tripwire, green on both sides and
labelled as a guard rather than counted. The checks execute the extracted body as
`bash -e <script>` in an `os.tmpdir()` sandbox holding three planted JSON files, which is
strong evidence about that shell and no evidence about the release path.

A **mutation pass** over the shipped step establishes that the new checks discriminate rather
than merely pass. Each mutation was applied **in place in the worktree** - never through a
symlinked shadow root, because node resolves symlinks back to the real tree and the mutation
is then never read (AGENTS.md's NRL-76 trap) - the full `npm test` was run, and the file was
restored from a byte-identical copy with its sha256 re-asserted every time. Thirteen
mutations, and the honest results:

| mutation | checks turned red |
| --- | --- |
| report only `problems[0]` | report-every-disagreement, and only that |
| `hasOwnProperty` -> `Object.keys(...).some(k => k.includes(tag))` | **none** |
| the complete substring variant, value read through the found key | key-contains-tag, tag-is-prefix-of-key |
| strip a leading `v` from the tag | nothing-normalises-the-tag |
| delete the `package.json` clause | the `package.json` check, and report-every-disagreement |
| delete the non-empty-value clause | the empty-value check |
| delete the `-z "${TAG:-}"` clause | empty-or-unset-`TAG`-by-name |
| `load()` -> a bare `require()` | malformed-JSON-is-diagnosed, and only that |
| a missing file is silently skipped instead of pushed | missing-file-is-named |
| move the step below the gates | the ordering check, and only that |
| inline the tag as a `${{ }}` expression | the `env:` check plus eleven execution checks |
| add `if: startsWith(github.ref, 'refs/tags/')` | the `shell:`/`if:` check, and only that |
| restore the `null` sentinel | not-a-map-of-version-keys, and only that |

**One planned mutation turned nothing red, and the reason is worth keeping.** Replacing the
`hasOwnProperty` key test with a one-clause `includes` substring test leaves the step still
failing both cases, because decision 8's non-empty-value clause catches it as a second line of
defence: with the key `0.1.01` and the tag `0.1.0`, `versions[tag]` is `undefined`, so the step
exits 1 reporting `versions.json["0.1.0"] is undefined`. Measured directly, not inferred. So
that mutation is not an escaping one at all; the **complete** substring variant, which also
reads the value through the key it found, is - and the two key-exactness checks catch it. Two
other mutations were weaker than planned for the same kind of reason and each needed a
supplementary one: a bare `require()` still names the missing file in its `MODULE_NOT_FOUND`
message, so only the stack-trace check reds, and the missing-file check is pinned instead by
silently skipping the push; and the `undefined` sentinel is pinned by restoring the `null` one
rather than by any of the planned ten.

`actionlint` is **not installed on this machine** and was not run; AGENTS.md records it as
having been silent on both halves of the compile defect that broke every run in this repo's
history, so its absence costs little. `srs.md` is unchanged: R-M01 states the requirement and
this guard is implementation of it, not a deviation. **Rule 11 is not applicable** rather
than skipped - a CI step has no Obsidian-visible surface - and saying so is better than
claiming a pass.

## Amendment (NRL-106): the attestation's upload is ordered after the Release

Date: 2026-09-30. Ticket: NRL-106 (R-M01). This section narrows decision 1 above and
follows directly on the NRL-79 amendment's subject - the attestation and its attachment to
the Release object.

### The defect

The `provenance` job declared `needs: build` and nothing else. The `release` job, which
creates the GitHub Release, also declares `needs: build`. So the two were **siblings, not
ordered**: the generator's `upload-assets` job, which attaches `multiple.intoto.jsonl` to the
Release, was unordered with respect to the job that creates the thing it attaches to. Run
first, it has no Release object to attach to.

The failure mode is the bad kind. It is not a hard error that stops the run; it is a **green
run with no attestation attached** - the same silence decision 5 of the NRL-76 amendment
refuses, arriving by scheduling instead of by an `if:`.

### What NRL-79's one successful run actually showed, and why it is luck

Run `36785920227`, this repo's first successful `release.yml` run, did not race harmfully:

| Job | Started | Completed |
| -- | -- | -- |
| `release` | 22:30:46Z | **22:30:55Z** |
| `provenance / upload-assets` | **22:31:23Z** | 22:31:33Z |

28 seconds of slack, and the attestation was attached. **Nothing in the file produced that
margin.** `provenance / generator` happens to take about 28 s, and that is the only reason
`upload-assets` landed behind `release`. A faster generator or a slower `release` job inverts
it. Those timestamps are evidence about the **old** behaviour, not about this change: the
ordering has never been enforced on any run, including the one success.

### The decision

`needs: [build, release]`. One line, at the `provenance` job. Both entries are load-bearing
and neither is removable:

- **`build`** so `needs.build.outputs.hashes` - the generator's `base64-subjects` input -
  still resolves. Dropping it leaves that reference with no `needs` context to read.
- **`release`** purely for **ordering**, so `upload-assets` cannot start before the Release
  object exists.

The comment above the job now names both halves for that reason, and
`tests/release.test.ts`'s existing `provenance` guard was extended to assert the **set**
`{build, release}` rather than the presence of one entry. The comparison is order-insensitive
and spelling-tolerant on purpose: GitHub treats `needs` as a set, so `[release, build]` and a
block sequence are the same dependency graph, and asserting a literal would pin formatting
rather than behaviour. Two traps were measured on the job's own text while writing it. A
slice-wide substring search for `build` is **already vacuous**, because
`base64-subjects: ${{ needs.build.outputs.hashes }}` carries that word, so such a check would
stay green with `build` dropped from the list - the exact regression it would exist to catch.
And `release` occurs nowhere else in the job today, so a substring search for it would have
appeared to work for the wrong reason. Hence the assertion is scoped to the `needs:` line.

### No `if:` was added, and decision 5 is unchanged

Decision 5 of the NRL-76 amendment stands and is reinforced: no `if:` of any kind is on the
`provenance` job, and the guard test still asserts there is none. GitHub **does** permit
`jobs.<job_id>.if` on a reusable-workflow call, so this is a policy decision and not a syntax
restriction, which is precisely why the test has to keep enforcing it.

**One consequence to record rather than guard against.** After this change, a **failed**
`release` job skips `provenance` through ordinary `needs:` semantics - GitHub's own
documentation for `jobs.<job_id>.needs` says so: "If a job fails or is skipped, all jobs that
need it are skipped unless the jobs use a conditional expression that causes the job to
continue." That is **acceptable, and categorically different from what decision 5 forbids.**
The forbidden shape is a skip on a **green** run: the run reports success and silently ships
no attestation. This is a skip that **follows a red run** - `release` failed, so the overall
run is already red and visibly so, and there is no **complete** Release for `upload-assets` to
attach `multiple.intoto.jsonl` to.

**That wording is deliberately "no complete Release" and not "no Release object", which an
earlier draft of this section claimed.** NRL-104 replaced `actions/create-release` plus a
separate upload step with a single `softprops/action-gh-release` step at `draft: false`
(`.github/workflows/release.yml:317-320`), so a failure part way through that step's asset
uploads can leave a **public Release carrying only some of its assets**. A failed `release`
job therefore does **not** guarantee the absence of a Release object. What it does guarantee
is the half of the argument that is load-bearing here: the run is **visibly RED either way**.
Verified on this tree by reading the file - there is no `continue-on-error` anywhere in
`release.yml`, and the `release` job carries no `if:` (nor does any other job or step), so a
failing `release` fails the run and cannot be laundered into a green one. That is what makes
this categorically different from decision 5's forbidden skip-on-a-green-run, and the
distinction does not depend on whether a partial Release exists.

Note also that the **pre-change behaviour was strictly worse**, not merely unordered: with
`provenance` a sibling of `release`, `upload-assets` could attach an attestation to a Release
that did not yet carry the subjects that attestation names - provenance pointing at files the
Release object did not hold. Ordering removes that shape.

Do **not** "fix" the skip with `if: always()` or `if: success() || failure()`: that would run
the generator against a Release that is absent or incomplete, turning a clean red into a
confusing one, and it is an `if:` on `provenance`, which decision 5 bans outright.

### What this does not establish

**This has never run on a real runner.** No tag has been pushed since NRL-79's `0.1.1`, so
there is no run in which `upload-assets` was observed waiting on `release`, and the ordering
this amendment claims is therefore asserted rather than demonstrated.

**The two-entry form alongside a job-level `uses:` is desk evidence.** That `needs:` is
permitted at all on a reusable-workflow call is empirical here - the job already carried
`needs: build` alongside its job-level `uses:`, and run `36785920227` compiled and ran all six
jobs. What is **not** empirical is that the value may be a **list**. That rests on
github/docs read verbatim: `reusing-workflow-configurations.md`'s "Supported keywords for jobs
that call a reusable workflow" lists `jobs.<job_id>.needs` explicitly, and
`section-using-jobs-in-a-workflow-needs.md` says of `needs` that "It can be a string or array
of strings", with `needs: [job1, job2]` as its documented example. So a list is the documented
form of a permitted key - a value change, not a new key - but **GitHub has not compiled this
file**. The only thing that would settle it empirically is a push that makes it do so.

`actionlint` is **not installed on this machine** and was not run; AGENTS.md records it as
having been silent on both halves of the compile defect that broke every run in this repo's
history, so its absence costs little. The existing **2026-10-19** re-verification trigger for
the release path already covers re-running it. `srs.md` is unchanged: R-M01 states the
requirement and job ordering inside `release.yml` is implementation of it, not a deviation.
R-M01 does not become any more met - the release path is still exercised exactly once, on a
since-deleted tag, and the clause 3 install gap is untouched - so the `2 of 16` MUST headline
count does not move. **Rule 11 is not applicable** rather than skipped: a CI job dependency
has no Obsidian-visible surface, and saying so is better than claiming a pass.
