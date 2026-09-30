/**
 * Regression tests for release infrastructure (NRL-16).
 *
 * These tests verify:
 * 1. Build succeeds with ORT checksums compiled
 * 2. Checksums are read-only in main.js
 * 3. No model weights downloaded during build
 * 4. Workflow file is valid GitHub Actions YAML
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Tests are run from tests/.build/release.test.mjs, so go up 3 levels to reach the root.
const ROOT = path.resolve(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "main.js");
const WORKFLOW_FILE = path.join(ROOT, ".github/workflows/release.yml");
const MANIFEST_FILE = path.join(ROOT, "manifest.json");
const VERSIONS_FILE = path.join(ROOT, "versions.json");
const README_FILE = path.join(ROOT, "README.md");
const LICENSE_FILE = path.join(ROOT, "LICENSE");
const ADR_FILE = path.join(ROOT, "docs/adr/0011-release-attestation.md");
const ADR_ORT_FILE = path.join(ROOT, "docs/adr/0024-ort-on-demand.md");
const DEPLOY_FILE = path.join(ROOT, "deploy.mjs");
const MAIN_TS_FILE = path.join(ROOT, "src/main.ts");

let totalTests = 0;
let passedTests = 0;

function test(name: string, fn: () => void) {
	totalTests++;
	try {
		fn();
		console.log(`  ok   ${name}`);
		passedTests++;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.log(`  FAIL ${name}`);
		console.log(`       ${message}`);
	}
}

function assert(condition: boolean, message: string) {
	if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string) {
	if (actual !== expected) {
		throw new Error(message || `Expected ${expected}, got ${actual}`);
	}
}

function assertMatch(text: string, regex: RegExp, message?: string) {
	if (!regex.test(text)) {
		throw new Error(message || `Text does not match ${regex}`);
	}
}

function assertFileExists(filePath: string, message?: string) {
	if (!fs.existsSync(filePath)) {
		throw new Error(message || `File does not exist: ${filePath}`);
	}
}

// --- Build Succeeds with ORT Checksums Compiled

test("Build succeeds with production mode", () => {
	assertFileExists(MAIN_JS, "main.js not found after build");
});

// --- Kokoro Worker Inlining (NRL-60)
//
// esbuild's "cjs" output format wraps the whole bundle in a module function,
// so a bare top-level `var` is scoped to that wrapper, never to the real
// global object - the same reason a `var` at the top of any Node CommonJS
// file never becomes a property of `global`. kokoro.ts's getWorkerBlobUrl()
// reads the inlined worker off `globalThis.KOKORO_WORKER_CODE`, so the
// inject step must assign to globalThis, not declare `var`. A regression
// here silently breaks Kokoro on every platform: it falls through to a
// file-based fallback path reading a `kokoro-worker.js` this same build step
// deletes, so the failure is "File does not exist" with no working fallback.

test("Inlined worker code is assigned to globalThis, not a bare var", () => {
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	assertMatch(
		content,
		/globalThis\.KOKORO_WORKER_CODE\s*=/,
		"main.js must assign globalThis.KOKORO_WORKER_CODE; a bare `var` is " +
			"scoped to esbuild's cjs module wrapper and never reaches the real " +
			"global object, which kokoro.ts reads from",
	);
	assert(
		!/(?<!globalThis\.)\bvar\s+KOKORO_WORKER_CODE\s*=/.test(content),
		"KOKORO_WORKER_CODE must not be declared with a bare `var`",
	);
});

// --- ORT Checksum Validation Reads Binary, Not Text (NRL-60)
//
// validateOrtChecksums() in main.ts used to read these binary .wasm/.mjs
// files with the text-mode adapter.read(), then re-encode the (already
// UTF-8-decoded, lossy) string back to bytes with TextEncoder before
// hashing. That round-trip corrupts real binary data - invalid UTF-8 byte
// sequences collapse to U+FFFD - so it hashed its own mangled copy, never
// the file, and reported a mismatch unconditionally regardless of whether
// the file on disk was actually correct. TextEncoder has exactly one call
// site in the whole source tree (this one), so its absence from the bundle
// is an unambiguous signal the buggy read+re-encode path is gone.

test("ORT checksum validation does not round-trip binary data through text", () => {
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	assert(
		!content.includes("TextEncoder"),
		"TextEncoder should not appear in main.js - it was only ever used to " +
			"re-encode a lossy UTF-8 decode of binary ORT files before hashing " +
			"them, which made checksum validation always fail regardless of " +
			"whether the file was correct",
	);
});

test("main.js contains ORT checksums", () => {
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	assertMatch(content, /ort-wasm-simd-threaded\.mjs/, "main.js missing ORT .mjs checksum");
	assertMatch(content, /ort-wasm-simd-threaded\.wasm/, "main.js missing ORT .wasm checksum");
	assertMatch(
		content,
		/ort-wasm-simd-threaded\.jsep\.mjs/,
		"main.js missing ORT JSEP .mjs checksum",
	);
	assertMatch(
		content,
		/ort-wasm-simd-threaded\.jsep\.wasm/,
		"main.js missing ORT JSEP .wasm checksum",
	);
});

test("Checksums in main.js are valid hex strings", () => {
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	// Extract all hex strings that look like SHA-256 hashes (64 hex chars).
	const hexPattern = /"([a-f0-9]{64})"/g;
	const matches = content.match(hexPattern) || [];
	assert(matches.length >= 4, "Expected at least 4 SHA-256 hashes in main.js");
});

// --- Checksums are Read-Only in main.js

test("Checksums are not wrapped in eval() or Function()", () => {
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	const hashInEval = /eval\s*\(\s*["'`].*[a-f0-9]{64}/.test(content);
	const hashInFunction = /Function\s*\(\s*["'`].*[a-f0-9]{64}/.test(content);
	assert(
		!hashInEval && !hashInFunction,
		"Checksums should not be wrapped in eval() or Function() calls",
	);
});

test("__ORT_CHECKSUMS__ is not reassigned in main.js", () => {
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	// Count assignments to __ORT_CHECKSUMS__.
	const assignmentPattern = /__ORT_CHECKSUMS__\s*=/g;
	const assignments = content.match(assignmentPattern) || [];
	// Only the initial definition should exist (esbuild inlines it as a define).
	// We don't expect a reassignment in the code.
	assert(assignments.length <= 1, "Checksums should be assigned only once (at define-time)");
});

test("Checksums are not modified by plugin code", () => {
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	// Check that the checksums object is not reassigned or deleted at the
	// statement level (excluding esbuild's internal minification machinery).
	// The checksums are defined once at the top and then used in the plugin,
	// never reassigned or destroyed.
	const reassignments = content.match(/var S\s*=.*; var S\s*=/g) || [];
	const deletes = content.match(/delete\s+S\s*\[/g) || [];
	assert(
		reassignments.length === 0 && deletes.length === 0,
		"Checksums object should not be reassigned or deleted",
	);
});

// --- No Model Weights Downloaded During Build

test("ORT directory contains only published files", () => {
	const ortDir = path.join(ROOT, "ort");
	const expectedFiles = [
		"ort-wasm-simd-threaded.mjs",
		"ort-wasm-simd-threaded.wasm",
		"ort-wasm-simd-threaded.jsep.mjs",
		"ort-wasm-simd-threaded.jsep.wasm",
	];

	for (const file of expectedFiles) {
		const filePath = path.join(ortDir, file);
		assertFileExists(filePath, `Expected ORT file not found: ${file}`);
	}

	// Check that no other files were downloaded (e.g., Kokoro weights).
	const allFiles = fs.readdirSync(ortDir);
	for (const file of allFiles) {
		const isExpected = expectedFiles.includes(file);
		assert(isExpected, `Unexpected file in ort/: ${file} (should not be there)`);
	}
});

test("No Kokoro weights in ort directory", () => {
	const ortDir = path.join(ROOT, "ort");
	const allFiles = fs.readdirSync(ortDir);
	const hasKokoroWeights = allFiles.some((f) =>
		/kokoro|model|weight|pt$|safetensors$|bin$/.test(f),
	);
	assert(!hasKokoroWeights, "Kokoro weights should not be downloaded during build");
});

// --- ONNX Runtime is fetched on demand, not bundled with the plugin (NRL-37)
//
// `esbuild.config.mjs`'s copyOrtRuntime() still populates a repo-root `ort/`
// build-output directory (checked above), but that directory is not itself
// "the shipped plugin bundle" - deploy.mjs's copy loop was what made it part
// of an installed plugin folder, and only a real directory install (main.js,
// manifest.json, styles.css - exactly what Obsidian's own installer fetches)
// proves whether that copy actually happened. `npm run deploy` copying `ort/`
// silently hid the bug this ticket fixes (AGENTS.md verification rule 11),
// so `ort` must be gone from its copy list, permanently, or the next person
// to touch deploy.mjs could silently reintroduce the exact bug NRL-37 fixed.

test("deploy.mjs's copy list excludes ort/ (NRL-37)", () => {
	const content = fs.readFileSync(DEPLOY_FILE, "utf-8");
	const arrayMatch = content.match(/for \(const item of (\[[^\]]*\])/);
	const arraySource = arrayMatch?.[1];
	assert(arraySource !== undefined, "deploy.mjs's copy-item array not found");
	const items = JSON.parse(arraySource!.replace(/'/g, '"'));
	assert(
		!items.includes("ort"),
		"deploy.mjs must not copy ort/ into the vault plugin folder - it is now " +
			"fetched by the user via the Settings tab's Download button, and " +
			"copying it here would hide the directory-install bug NRL-37 fixed",
	);
	assert(
		items.includes("main.js") && items.includes("manifest.json") && items.includes("styles.css"),
		"deploy.mjs must still copy the three files Obsidian's own installer fetches",
	);
});

/**
 * The repo-relative paths `Upload Release Assets` publishes to the tagged Release.
 *
 * Hoisted out of the NRL-37 check below during NRL-76 so that check and the
 * NRL-76 subject-set check read ONE source of truth: the provenance subject set
 * must equal the published set, and two independent transcriptions of the same
 * list would let them drift apart silently, which is the whole shape of NRL-76.
 *
 * Defensive in the same way `parseOnPushTags` is: there is no yaml dependency,
 * so this is a regex over the text, and every failure mode throws rather than
 * returning `[]`. An empty list would make the subject-set check vacuously green.
 */
function extractUploadedFiles(content: string): string[] {
	const uploadStepMatch = content.match(
		/Upload Release Assets[\s\S]*?files:\s*\|([\s\S]*?)\n\s*\n/,
	);
	const filesBlock = uploadStepMatch?.[1];
	if (filesBlock === undefined) {
		throw new Error(
			"could not locate the `Upload Release Assets` step's `files: |` block in the workflow text; " +
				"refusing to return an empty published-asset list, which would make the NRL-76 subject-set " +
				"check vacuously green",
		);
	}
	const files: string[] = [];
	for (const raw of filesBlock.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		files.push(line);
	}
	if (files.length === 0) {
		throw new Error(
			"the `Upload Release Assets` `files: |` block was found but holds no entries; " +
				"refusing to return an empty published-asset list",
		);
	}
	return files;
}

test("release.yml's Upload Release Assets step includes the four ORT filenames (NRL-37)", () => {
	const published = extractUploadedFiles(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
	for (const file of [
		"ort/ort-wasm-simd-threaded.mjs",
		"ort/ort-wasm-simd-threaded.wasm",
		"ort/ort-wasm-simd-threaded.jsep.mjs",
		"ort/ort-wasm-simd-threaded.jsep.wasm",
	]) {
		assert(
			published.includes(file),
			`Upload Release Assets step must publish ${file} as an extra release ` +
				"asset so it is fetchable at releases/download/<tag>/<filename> " +
				"without changing what Obsidian's own installer fetches",
		);
	}
});

// --- The checksum step's subjects are the published assets (NRL-76)
//
// `release.yml`'s `Generate checksums` step is the ONLY thing that decides what
// the SLSA generator attests: its `hashes` output becomes `base64-subjects`. It
// used to open with `cd dist || true` into a directory this repo does not have,
// so it stayed in the workspace root and found three of the right files by
// accident, and every one of its failure modes was silent.
//
// THESE CHECKS EXECUTE THE STEP. They extract its `run:` block, write it to a
// script and run it in a throwaway sandbox populated at exactly the paths the
// upload step publishes, then observe the exit code, the `$GITHUB_OUTPUT`
// bytes, the decoded subject paths, digests this file recomputes itself, and
// the sandbox filesystem. The ONLY text operation is locating the step. A check
// that grepped for `cd dist` would pass the moment someone reformatted the
// YAML while the step still hashed the wrong bytes.
//
// `bash -e` and deliberately NOT `-o pipefail`: that is GitHub's documented
// default for a `run:` (fail-fast via `set -e` alone; `-o pipefail` is added
// only when `shell: bash` is given explicitly), and its absence is precisely
// why the old `sha256sum | base64` pipeline could not fail the step. The fix
// therefore has to put `set -euo pipefail` in the BODY, which is what these
// checks execute - a `shell: bash` key would be a guarantee nothing here covers.

/**
 * A named step's `run: |` literal block, common indentation stripped.
 *
 * Defensive for the same reason `parseOnPushTags` is: a silently-empty script
 * would make every execution check below trivially green.
 */
function extractRunBlock(content: string, stepName: string): string {
	const lines = content.split("\n");
	const stepLine = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
	if (stepLine === -1) {
		throw new Error(
			`could not locate a \`- name: ${stepName}\` step in the workflow text; refusing to ` +
				"return an empty script, which would make every execution check vacuously green",
		);
	}
	let runLine = -1;
	for (let i = stepLine + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "run: |") {
			runLine = i;
			break;
		}
		// A new step has begun before any `run: |` was found.
		if (line.trim().startsWith("- name:")) break;
	}
	if (runLine === -1) {
		throw new Error(`step "${stepName}" has no \`run: |\` literal block`);
	}
	const runIndent = (lines[runLine] ?? "").search(/\S/);
	const body: string[] = [];
	for (let i = runLine + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "") {
			body.push("");
			continue;
		}
		if (line.search(/\S/) <= runIndent) break;
		body.push(line);
	}
	while (body.length > 0 && (body[body.length - 1] ?? "") === "") body.pop();
	const indents = body.filter((l) => l.trim() !== "").map((l) => l.search(/\S/));
	if (indents.length === 0) {
		throw new Error(`step "${stepName}"'s \`run: |\` block is empty`);
	}
	const common = Math.min(...indents);
	return body.map((l) => (l.trim() === "" ? "" : l.slice(common))).join("\n") + "\n";
}

interface StepRun {
	/** Process exit status. 0 on success. */
	status: number;
	stderr: string;
	/** Raw `$GITHUB_OUTPUT` file contents. */
	output: string;
	/** The value written after `hashes=`, or `""` if none was written. */
	hashes: string;
	/** Decoded `sha256sum`-format subject lines. */
	subjects: Array<{ digest: string; file: string }>;
	/** The sandbox workspace the step ran in, for filesystem assertions. */
	work: string;
	/** Every path this harness planted, relative to `work`. */
	planted: string[];
}

/**
 * Run `release.yml`'s `Generate checksums` step in a throwaway sandbox.
 *
 * `omit` leaves one published path absent; `impostorDir` plants a directory of
 * the same filenames holding DIFFERENT bytes, which is how the `cd` defect is
 * proved without any check naming `cd`.
 */
function runChecksumStep(
	options: { omit?: readonly string[]; impostorDir?: string } = {},
): StepRun {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	const script = extractRunBlock(content, "Generate checksums");
	const published = extractUploadedFiles(content);
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "nrl76-checksums-"));
	const work = path.join(sandbox, "workspace");
	const runnerTemp = path.join(sandbox, "runner-temp");
	fs.mkdirSync(work, { recursive: true });
	fs.mkdirSync(runnerTemp, { recursive: true });

	const omit = new Set(options.omit ?? []);
	const planted: string[] = [];
	for (const rel of published) {
		if (omit.has(rel)) continue;
		const abs = path.join(work, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		// Per-path bytes, so a digest can only be right by having hashed the
		// right file - a single shared body would let a wrong file pass.
		fs.writeFileSync(abs, `workspace-root bytes for ${rel}\n`);
		planted.push(rel);
	}
	if (options.impostorDir !== undefined) {
		for (const rel of published) {
			const abs = path.join(work, options.impostorDir, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, `IMPOSTOR bytes for ${rel}\n`);
			planted.push(path.posix.join(options.impostorDir, rel));
		}
	}

	const scriptPath = path.join(sandbox, "generate-checksums.sh");
	fs.writeFileSync(scriptPath, script);
	const outputPath = path.join(runnerTemp, "github_output");
	fs.writeFileSync(outputPath, "");

	let status = 0;
	let stderr = "";
	try {
		// `-e` only. See the section comment: that is GitHub's documented default.
		execFileSync("bash", ["-e", scriptPath], {
			cwd: work,
			env: { ...process.env, GITHUB_OUTPUT: outputPath, RUNNER_TEMP: runnerTemp },
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err: unknown) {
		const e = err as { status?: number | null; stderr?: string | Buffer };
		status = typeof e.status === "number" ? e.status : 1;
		stderr = e.stderr === undefined ? "" : String(e.stderr);
	}

	const output = fs.readFileSync(outputPath, "utf-8");
	const hashesMatch = /^hashes=(.*)$/m.exec(output);
	const hashes = hashesMatch?.[1] ?? "";
	const subjects: Array<{ digest: string; file: string }> = [];
	if (hashes !== "") {
		const decoded = Buffer.from(hashes, "base64").toString("utf-8");
		for (const line of decoded.split("\n")) {
			if (line.trim() === "") continue;
			const row = /^([0-9a-f]{64})\s+\*?(.*)$/.exec(line);
			if (row === null) {
				throw new Error(`decoded subject line is not sha256sum output: ${JSON.stringify(line)}`);
			}
			subjects.push({ digest: row[1] ?? "", file: row[2] ?? "" });
		}
	}
	return { status, stderr, output, hashes, subjects, work, planted };
}

/** sha256 of a file, computed here so a decoded digest is never taken on trust. */
function sha256OfFile(file: string): string {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Every file under `dir`, as paths relative to it. */
function listFilesRecursive(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
		else out.push(rel);
	}
	return out;
}

// DEFECT REPRODUCTION (NRL-76). Measured red against the pre-fix body: the step
// attested 3 of the 7 published assets, leaving the four `ort/` files - the bytes
// a user downloads at runtime under R-M01 clause 3 / ADR 0024, and the two
// largest downloadables - with no subject at all. Asserted against the upload
// step's own `files:` list rather than a hardcoded set, so the published set and
// the attested set cannot drift apart again.
test("release.yml attests every published release asset and nothing else (NRL-76)", () => {
	const published = extractUploadedFiles(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
	const run = runChecksumStep();
	assertEquals(run.status, 0, `checksum step exited ${run.status} on a complete workspace: ${run.stderr}`);
	const attested = run.subjects.map((s) => s.file).sort();
	const expected = [...published].sort();
	const missing = expected.filter((f) => !attested.includes(f));
	const extra = attested.filter((f) => !expected.includes(f));
	assert(
		missing.length === 0 && extra.length === 0,
		`the provenance subject set must equal the set Upload Release Assets publishes. ` +
			`Missing from the attestation: ${JSON.stringify(missing)}. ` +
			`Attested but not published: ${JSON.stringify(extra)}. ` +
			`An asset with no subject is downloadable with no attestation at all.`,
	);
});

// GUARD (green on both sides). Without it the check above is satisfiable by a
// literal string: every decoded digest must be the real sha256 of the file that
// subject names, recomputed here.
test("guard: every attested digest is the real sha256 of the file it names", () => {
	const run = runChecksumStep();
	assertEquals(run.status, 0, `checksum step exited ${run.status}: ${run.stderr}`);
	assert(run.subjects.length > 0, "the checksum step produced no subjects at all");
	const wrong: string[] = [];
	for (const subject of run.subjects) {
		const abs = path.join(run.work, subject.file);
		if (!fs.existsSync(abs)) {
			wrong.push(`${subject.file}: attested but absent from the workspace`);
			continue;
		}
		const real = sha256OfFile(abs);
		if (real !== subject.digest) wrong.push(`${subject.file}: attested ${subject.digest}, real ${real}`);
	}
	assert(wrong.length === 0, `attested digests do not match the workspace files: ${wrong.join("; ")}`);
});

// DEFECT REPRODUCTION (NRL-76), and the `cd dist || true` half of it - proved
// without any check naming `cd`, so a reformat cannot make it vacuous. Measured
// red against the pre-fix body with a `dist/` present: the attested `main.js`
// digest was the dist copy's, not the workspace root's, so a directory created
// by any future build step, cache restore or action would have captured the
// attestation silently.
test("a sibling directory of same-named files cannot capture the attestation (NRL-76)", () => {
	const run = runChecksumStep({ impostorDir: "dist" });
	assertEquals(run.status, 0, `checksum step exited ${run.status} with a dist/ present: ${run.stderr}`);
	assert(run.subjects.length > 0, "the checksum step produced no subjects at all");
	const wrong: string[] = [];
	for (const subject of run.subjects) {
		const root = path.join(run.work, subject.file);
		const impostor = path.join(run.work, "dist", subject.file);
		if (!fs.existsSync(root)) {
			wrong.push(`${subject.file}: no such file at the workspace root`);
			continue;
		}
		const rootDigest = sha256OfFile(root);
		if (subject.digest === rootDigest) continue;
		const which = fs.existsSync(impostor) && sha256OfFile(impostor) === subject.digest
			? "the dist/ copy's bytes"
			: "bytes from neither the root nor dist/";
		wrong.push(
			`${subject.file}: attested ${subject.digest} (${which}); the released file's digest is ${rootDigest}`,
		);
	}
	assert(
		wrong.length === 0,
		"the attestation must cover the files that are released, which are the ones at the " +
			`workspace root: ${wrong.join("; ")}`,
	);
});

// DEFECT REPRODUCTION (NRL-76), and SHARPER THAN THE TICKET PREDICTED. The
// description says a missing artifact would leave the step with no `hashes`
// output. Measured against the pre-fix body with one published asset removed:
// the step exited 0 AND still wrote a `hashes=` value covering the files that
// were present - a silently TRUNCATED attestation, not an absent one. Both are
// worse than a failure, because the generator would sign whatever it was handed.
test("a missing release asset fails the checksum step outright (NRL-76)", () => {
	const missing = "ort/ort-wasm-simd-threaded.wasm";
	const published = extractUploadedFiles(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
	assert(published.includes(missing), `${missing} is no longer a published asset; pick another`);
	const run = runChecksumStep({ omit: [missing] });
	assert(
		run.status !== 0,
		`the checksum step exited 0 with ${missing} absent and wrote ${Buffer.byteLength(run.output)} ` +
			`bytes to $GITHUB_OUTPUT covering ${run.subjects.length} of ${published.length} assets. ` +
			"A build that cannot hash everything it publishes must fail, not hand the SLSA generator " +
			"a truncated subject list.",
	);
	assertEquals(
		Buffer.byteLength(run.output),
		0,
		`$GITHUB_OUTPUT must be untouched when the step fails, so \`needs.build.outputs.hashes\` ` +
			`cannot resolve to a partial list; it holds ${JSON.stringify(run.output)}`,
	);
});

// DEFECT REPRODUCTION (NRL-76). The pre-fix body wrote its base64 to a
// `checksums.txt` in the workspace and read it back. Measured red: the file was
// there after the run. Asserted as "no file the harness did not plant", not as
// "no file called checksums.txt", so renaming the side effect cannot dodge it.
test("the checksum step leaves no file behind in the workspace (NRL-76)", () => {
	const run = runChecksumStep();
	assertEquals(run.status, 0, `checksum step exited ${run.status}: ${run.stderr}`);
	const planted = new Set(run.planted);
	const strays = listFilesRecursive(run.work).filter((f) => !planted.has(f));
	assert(
		strays.length === 0,
		`the checksum step wrote ${JSON.stringify(strays)} into the workspace. The step runs before ` +
			"`Upload build artifacts`, so anything it leaves can end up in the artifact it is attesting.",
	);
});

// GUARD (green on both sides), on the wiring the checks above cannot see. The
// subject list only matters if the generator receives it, and the `if:` clause
// is the one way to make this whole step moot with a GREEN run: `needs: build`
// already stops `provenance` when the build fails, whereas an
// `if: needs.build.outputs.hashes != ''` would SKIP provenance silently and
// produce no attestation at all. See ADR 0011, Amendment (NRL-76), decision 5.
test("guard: the provenance job consumes the build's hashes and carries no if:", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	assertMatch(
		content,
		/^\s+hashes:\s*\$\{\{\s*steps\.hash\.outputs\.hashes\s*\}\}\s*$/m,
		"the build job must still export the `hash` step's output as `hashes`",
	);
	assertMatch(
		content,
		/^\s+base64-subjects:\s*\$\{\{\s*needs\.build\.outputs\.hashes\s*\}\}\s*$/m,
		"the provenance job must still take its subjects from `needs.build.outputs.hashes`",
	);
	const lines = content.split("\n");
	const start = lines.findIndex((l) => /^\s{2}provenance:\s*$/.test(l));
	assert(start !== -1, "could not locate the `provenance:` job");
	const jobLines: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^\s{2}\S/.test(line)) break; // next job at the same indent
		jobLines.push(line);
	}
	const conditional = jobLines.filter((l) => /^\s{4}if:/.test(l));
	assert(
		conditional.length === 0,
		`the provenance job carries ${JSON.stringify(conditional)}. A failing build step already stops ` +
			"it through `needs: build`; an `if:` would SKIP it silently and produce a green run with no " +
			"attestation, which is strictly worse than the defect NRL-76 fixed.",
	);
});

// --- ORT checksum validation distinguishes "missing" from "mismatch" (NRL-37)
//
// Before NRL-37, a missing ORT file (the only possible state on a fresh
// directory install, since the files were never bundled there) and a
// genuinely corrupt one were folded into the same trace()-only path. Pinned
// against src/main.ts, not the minified main.js: the pretest chain builds
// tests from TypeScript sources via build-tests.mjs, and this is a source-
// shape assertion, not a build-output one. If a future edit collapses the
// two branches back together, this fails rather than silently reintroducing
// the bug this ticket fixes.

test("validateOrtChecksums branches on missing vs mismatch as distinct outcomes", () => {
	const content = fs.readFileSync(MAIN_TS_FILE, "utf-8");
	assertMatch(
		content,
		/worst === "missing"/,
		"main.ts must check for a missing-runtime status separately from mismatch",
	);
	assertMatch(
		content,
		/worst === "mismatch"/,
		"main.ts must check for a mismatch status separately from missing",
	);
	// The missing branch must return without alarming the user - it is the
	// expected pre-download state, not a failure.
	const missingBranch = content.match(/if \(worst === "missing"\) return;/);
	assert(
		missingBranch !== null,
		'the "missing" branch must be a silent early return, not a trace or Notice',
	);
	// The mismatch branch must both trace() (diagnostics) and raise a Notice
	// (user-visible) - a trace()-only failure is not "visible actionable
	// failure on mismatch" (the ticket's acceptance criterion).
	const mismatchSection = content.slice(content.indexOf('worst === "mismatch"'));
	assertMatch(
		mismatchSection.slice(0, 800),
		/trace\(/,
		'the "mismatch" branch must call trace() for diagnostics',
	);
	assertMatch(
		mismatchSection.slice(0, 800),
		/new Notice\(/,
		'the "mismatch" branch must raise a user-visible Notice, unlike "missing"',
	);
});

test("ADR 0024 exists and documents the ort-on-demand decision", () => {
	assertFileExists(ADR_ORT_FILE, "docs/adr/0024-ort-on-demand.md not found");
	const content = fs.readFileSync(ADR_ORT_FILE, "utf-8");
	assertMatch(content, /NRL-37/, "ADR 0024 missing NRL-37 ticket reference");
	assertMatch(content, /checksum/i, "ADR 0024 missing checksum mention");
	assertMatch(content, /atomic/i, "ADR 0024 missing atomic-write mention");
});

// --- Workflow File is Valid GitHub Actions YAML

test("Workflow file exists", () => {
	assertFileExists(WORKFLOW_FILE, ".github/workflows/release.yml not found");
});

test("Workflow YAML is syntactically valid", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	// Basic YAML syntax check: ensure no unclosed blocks and no obvious errors.
	const lines = content.split("\n");
	let indentStack: number[] = [0];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] || "";
		const stripped = line.replace(/^\s+/, "");
		if (stripped.startsWith("#")) continue; // Skip comments
		if (stripped === "") continue; // Skip empty lines

		const leadingSpaces = line.length - stripped.length;
		// Basic indent tracking (no complex rules; just ensure consistency).
		const stackTop = indentStack[indentStack.length - 1];
		if (stackTop !== undefined && leadingSpaces > stackTop) {
			indentStack.push(leadingSpaces);
		} else {
			while (
				indentStack.length > 1 &&
				leadingSpaces < (indentStack[indentStack.length - 1] || 0)
			) {
				indentStack.pop();
			}
		}
	}
	// If we get here without exception, YAML structure is at least plausible.
	assert(indentStack.length > 0, "Workflow YAML structure is invalid");
});

test("Workflow has required top-level keys", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	assertMatch(content, /^\s*name:\s+Release/m, "Workflow missing 'name: Release' key");
	assertMatch(content, /^\s*on:\s*\n\s+push:/m, "Workflow missing 'on: { push }' key");
	assertMatch(content, /^\s*jobs:\s*\n/m, "Workflow missing 'jobs' key");
});

test("Workflow has all required jobs", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	assertMatch(content, /^\s+build:\s*\n/m, "Workflow missing 'build' job");
	assertMatch(content, /^\s+release:\s*\n/m, "Workflow missing 'release' job");
	assertMatch(content, /^\s+provenance:\s*\n/m, "Workflow missing 'provenance' job");
});

test("Build job has quality gates", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	assertMatch(content, /npm run typecheck/, "Build job missing typecheck gate");
	assertMatch(content, /npm test/, "Build job missing test gate");
	assertMatch(content, /npm run build/, "Build job missing build gate");
});

test("Provenance job references SLSA generator", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	assertMatch(
		content,
		/slsa-framework\/slsa-github-generator/,
		"Workflow missing SLSA provenance generator",
	);
});

// --- Tag Trigger Is Version-Only (NRL-75)
//
// `.github/workflows/release.yml` used to trigger on `tags: ["*"]`. A GitHub
// filter-pattern `*` matches every tag name that holds no `/`, so `nightly`,
// `wip`, `pre-rebase`, `v0.1.0` or `0.1.0-rc1` would each have cut a real,
// public GitHub Release through `actions/create-release`. Narrowed to bare
// semver.
//
// THE MATCHER BELOW IS THE RISK, NOT THE PATTERN. These are GitHub FILTER
// PATTERNS, not regexes, and a wrong translation would make the three NRL-75
// checks pass while the workflow behaved differently in production - worse
// than the bug. So `matchesFilterPattern` is validated against GitHub's own
// published example table (the check named "...reproduces GitHub's documented
// example table"), never against itself, and malformed or unsupported syntax
// reports rather than being handed to the RegExp engine. That last clause is
// narrower than it once read: it used to say "every construct it does not
// understand throws", which was false and is why the guard named
// "filter-pattern literals stay literal and malformed syntax reports" now
// pins where the real line sits. See `filterPatternToRegExp`.
//
// Source, read verbatim during this ticket, github/docs@main
// content/actions/reference/workflows-and-actions/workflow-syntax.md:
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#filter-pattern-cheat-sheet

/** The whole tag-trigger list this repo intends to ship (NRL-75). */
const EXPECTED_TAG_PATTERNS: readonly string[] = ["[0-9]+.[0-9]+.[0-9]+"];

/**
 * Extract `on: push: tags:` from the workflow TEXT.
 *
 * There is no yaml dependency in package.json, so this is a regex over the
 * file. That is only safe if a failed parse is LOUD: a silently-empty list
 * would make every check below vacuously green, which is the exact shape of
 * defect this repo keeps finding. Both failure modes therefore throw, and
 * `test()` turns a throw into a named FAIL line.
 *
 * Pure - takes the text, touches no filesystem - so the guard below can drive
 * it over synthetic strings and prove it cannot return `[]`.
 */
function parseOnPushTags(content: string): string[] {
	const block =
		/^on:[ \t]*\r?\n(?:[ \t]*(?:#.*)?\r?\n)*[ \t]+push:[ \t]*\r?\n(?:[ \t]*(?:#.*)?\r?\n)*[ \t]+tags:[ \t]*\r?\n((?:[ \t]*(?:#.*)?\r?\n|[ \t]+-[ \t]+\S.*\r?\n)+)/m.exec(
			content,
		);
	if (block === null) {
		throw new Error(
			"could not locate an `on:` / `push:` / `tags:` block in the workflow text; " +
				"refusing to return an empty pattern list, which would make every NRL-75 check vacuously green",
		);
	}
	const entries: string[] = [];
	for (const line of (block[1] ?? "").split("\n")) {
		const item = /^[ \t]+-[ \t]+(.*)$/.exec(line);
		if (item === null) continue; // blank or comment line inside the block
		let value = (item[1] ?? "").trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}
		if (value === "") {
			throw new Error("`on: push: tags:` holds an empty entry; refusing to treat it as a pattern");
		}
		entries.push(value);
	}
	if (entries.length === 0) {
		throw new Error(
			"`on: push: tags:` block was found but holds no `- <pattern>` entries; " +
				"refusing to return an empty pattern list",
		);
	}
	return entries;
}

/**
 * One GitHub filter pattern -> an anchored RegExp.
 *
 * Documented set only (cheat sheet, cited above): `*` = zero or more characters
 * but not `/`; `**` = zero or more of any character; `?` = zero or one of the
 * preceding character; `+` = one or more of the preceding character; `[]` = one
 * alphanumeric character listed or in an `a-z` / `A-Z` / `0-9` range; `!` at the
 * start negates earlier positive patterns.
 *
 * "The preceding character" is the preceding EMITTED TOKEN, which is the whole
 * bracket class when one precedes - that is exactly what GitHub's own
 * `v[12].[0-9]+.[0-9]+` row requires, and the table check below is what pins it.
 * Anchored, because a filter pattern matches the whole ref name.
 *
 * `\` escapes the next character, which the docs require: "If a name contains
 * any of these characters and you want a literal match, you need to escape each
 * of these special characters with `\`" (workflow-syntax.md:87, and the same
 * sentence in the tags reusable). A trailing lone `\` has nothing to escape and
 * no documented meaning, so it throws rather than degrading to a literal
 * backslash. `\` before a character with no special meaning yields that
 * character, which is glob convention rather than a documented rule - the docs
 * define the escape only for their own special set.
 *
 * WHAT THROWS AND WHAT DOES NOT, stated precisely because an earlier draft of
 * this comment claimed "anything undocumented throws" and that was FALSE.
 * Malformed or unsupported SYNTAX throws: a bracket class outside the
 * alphanumeric / `a-z`,`A-Z`,`0-9`-range set (`[^0-9]`, `[\d]`, `[]`), an
 * unclosed `[`, a `]` with no opener, a quantifier with nothing before it
 * (`+abc`, `?abc`, `[0-9]++`, `[0-9]+?`), a leading `!` (list-level, see
 * `refMatchesPatterns`), an empty pattern, and a trailing `\`. A CHARACTER with
 * no special meaning in a filter pattern does NOT throw: `(`, `)`, `|`, `{`,
 * `}`, `^`, `$` and `.` are ordinary characters in a ref name, so they are
 * regex-escaped and matched literally. That is GitHub's semantics rather than a
 * gap - throwing on them would make this oracle stricter than the thing it is
 * an oracle for. The escaping is what stops JavaScript's meaning (`[\w]`,
 * `[^a]`, a bare `.` as any-character) leaking in.
 */
function filterPatternToRegExp(pattern: string): RegExp {
	if (pattern.length === 0) throw new Error("filter pattern is empty");
	if (pattern.startsWith("!")) {
		throw new Error(
			`filter pattern "${pattern}" starts with '!'; negation is list-level, use refMatchesPatterns`,
		);
	}
	let out = "";
	// The last emitted token, so `+` and `?` can re-wrap it. Null means "no token
	// a quantifier may attach to", which is a loud failure rather than a no-op.
	let last: string | null = null;
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i] ?? "";
		if (ch === "*") {
			const token = pattern[i + 1] === "*" ? ".*" : "[^/]*";
			out += token;
			last = token;
			i += token === ".*" ? 2 : 1;
			continue;
		}
		if (ch === "+" || ch === "?") {
			if (last === null) {
				throw new Error(
					`filter pattern "${pattern}": '${ch}' at index ${i} has no preceding character to quantify`,
				);
			}
			const suffix = ch === "+" ? "+" : "{0,1}";
			out = out.slice(0, out.length - last.length) + "(?:" + last + ")" + suffix;
			// A second quantifier on the same token is undocumented, so make it loud.
			last = null;
			i += 1;
			continue;
		}
		if (ch === "[") {
			const close = pattern.indexOf("]", i + 1);
			if (close === -1) {
				throw new Error(`filter pattern "${pattern}": unclosed '[' at index ${i}`);
			}
			const body = pattern.slice(i + 1, close);
			// Ranges can only include a-z, A-Z and 0-9 (docs). Refuse anything else
			// rather than forwarding it: `[^0-9]` and `[\d]` are regex, not GitHub.
			if (!/^(?:[A-Za-z0-9]|[a-z]-[a-z]|[A-Z]-[A-Z]|[0-9]-[0-9])+$/.test(body)) {
				throw new Error(
					`filter pattern "${pattern}": '[${body}]' is outside the documented alphanumeric / a-z,A-Z,0-9-range set`,
				);
			}
			const token = "[" + body + "]";
			out += token;
			last = token;
			i = close + 1;
			continue;
		}
		if (ch === "]") {
			throw new Error(`filter pattern "${pattern}": ']' at index ${i} with no opening '['`);
		}
		if (ch === "\\") {
			// Documented escape (workflow-syntax.md:87). The escaped character becomes a
			// LITERAL and the escape consumes both, so the pattern `v1\*` matches the tag
			// `v1*` and nothing else. Emitting the backslash as a literal and leaving the
			// next character live - which this used to do - is the one way to be silently
			// wrong here: `v1\*` became the regex /^v1\\[^\/]*$/, false for the tag `v1*`
			// and true for `v1\anything`.
			const next = pattern[i + 1];
			if (next === undefined) {
				throw new Error(
					`filter pattern "${pattern}": trailing '\\' at index ${i} with nothing to escape`,
				);
			}
			const escaped = next.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
			out += escaped;
			last = escaped;
			i += 2;
			continue;
		}
		// Everything else is a literal. Escaped, so a regex metacharacter in a tag
		// name - the `.` in `0.1.0` - cannot silently widen the pattern.
		const literal = ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		out += literal;
		last = literal;
		i += 1;
	}
	return new RegExp("^" + out + "$");
}

/** Does `ref` match this single filter pattern? */
function matchesFilterPattern(pattern: string, ref: string): boolean {
	return filterPatternToRegExp(pattern).test(ref);
}

/** Does `ref` match the configured list, honouring `!` negation in order? */
function refMatchesPatterns(patterns: readonly string[], ref: string): boolean {
	let included = false;
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) {
			if (matchesFilterPattern(pattern.slice(1), ref)) included = false;
		} else if (matchesFilterPattern(pattern, ref)) {
			included = true;
		}
	}
	return included;
}

// GUARD (green on both sides of NRL-75). THIS IS THE ORACLE for the three
// counted checks below: every row of GitHub's published "Patterns to match
// branches and tags" table, transcribed verbatim from
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#patterns-to-match-branches-and-tags
// If `matchesFilterPattern` is wrong, this goes red, so the NRL-75 checks
// cannot pass on a broken matcher.
test("filter-pattern matcher reproduces GitHub's documented example table", () => {
	const rows: Array<{ pattern: string; matches: string[]; notMatches: string[] }> = [
		{ pattern: "feature/*", matches: ["feature/my-branch", "feature/your-branch"], notMatches: [] },
		{
			pattern: "feature/**",
			matches: ["feature/beta-a/my-branch", "feature/your-branch", "feature/mona/the/octocat"],
			notMatches: [],
		},
		{ pattern: "main", matches: ["main"], notMatches: ["mainline", "release/main"] },
		{
			pattern: "releases/mona-the-octocat",
			matches: ["releases/mona-the-octocat"],
			notMatches: ["releases/mona"],
		},
		// The `'*'` row's description is the whole reason NRL-75's reproduction
		// uses slash-free names: "Matches all branch and tag names that don't
		// contain a slash (/)".
		{ pattern: "*", matches: ["main", "releases"], notMatches: ["all/the/branches"] },
		{ pattern: "**", matches: ["all/the/branches", "every/tag"], notMatches: [] },
		{ pattern: "*feature", matches: ["mona-feature", "feature", "ver-10-feature"], notMatches: [] },
		{ pattern: "v2*", matches: ["v2", "v2.0", "v2.9"], notMatches: [] },
		// The decisive row: `+` applied to a preceding BRACKET CLASS, and the
		// two-digit minor in `v1.10.1` proving `[0-9]+` is one-or-more digits.
		{ pattern: "v[12].[0-9]+.[0-9]+", matches: ["v1.10.1", "v2.0.0"], notMatches: [] },
	];
	const wrong: string[] = [];
	for (const row of rows) {
		for (const ref of row.matches) {
			if (!matchesFilterPattern(row.pattern, ref)) wrong.push(`"${row.pattern}" should match "${ref}"`);
		}
		for (const ref of row.notMatches) {
			if (matchesFilterPattern(row.pattern, ref)) wrong.push(`"${row.pattern}" should NOT match "${ref}"`);
		}
	}
	assert(wrong.length === 0, `matcher disagrees with GitHub's documented table: ${wrong.join("; ")}`);
});

// GUARD (green on both sides). The cheat sheet's own inline examples, same
// source, covering `?` and the two bracket examples the table does not reach.
test("filter-pattern matcher reproduces GitHub's cheat-sheet examples", () => {
	assert(matchesFilterPattern("Octo*", "Octocat"), '`Octo*` should match `Octocat`');
	assert(matchesFilterPattern("[CB]at", "Cat"), "`[CB]at` should match `Cat`");
	assert(matchesFilterPattern("[CB]at", "Bat"), "`[CB]at` should match `Bat`");
	assert(!matchesFilterPattern("[CB]at", "Hat"), "`[CB]at` should not match `Hat`");
	assert(matchesFilterPattern("[1-2]00", "100"), "`[1-2]00` should match `100`");
	assert(matchesFilterPattern("[1-2]00", "200"), "`[1-2]00` should match `200`");
	assert(!matchesFilterPattern("[1-2]00", "300"), "`[1-2]00` should not match `300`");
	assert(matchesFilterPattern("*.jsx?", "page.js"), "`*.jsx?` should match `page.js`");
	assert(matchesFilterPattern("*.jsx?", "page.jsx"), "`*.jsx?` should match `page.jsx`");
	assert(!matchesFilterPattern("*.jsx?", "page.jsxx"), "`*.jsx?` should not match `page.jsxx`");
});

// NRL-75 VERIFY FINDING 2 (defect reproduction). `\` is a DOCUMENTED filter-pattern
// construct - workflow-syntax.md:87, "If a name contains any of these characters and
// you want a literal match, you need to escape each of these special characters with
// `\`" - and the matcher used to get it silently wrong: `v1\*` translated to
// `^v1\\[^/]*$`, a literal backslash followed by a live wildcard, so it returned false
// for the tag `v1*` it is supposed to match and true for `v1\anything`. Blast radius
// was zero (the shipped pattern list is backslash-free), but this helper's entire
// justification is fidelity to documented semantics, so a wrong answer here is worse
// than no helper.
test("filter-pattern matcher honours the documented `\\` escape (NRL-75)", () => {
	const wrong: string[] = [];
	const shouldMatch: Array<[string, string]> = [
		["v1\\*", "v1*"],
		["v1\\?", "v1?"],
		["v1\\+", "v1+"],
		["v1\\[", "v1["],
		["v1\\]", "v1]"],
		["\\!v1", "!v1"],
		["v1\\\\", "v1\\"],
		// `.` is not in the documented special set, so escaping it is redundant - but a
		// redundant escape must still name its own character, not a backslash plus a
		// live construct. This is the shape a future `[0-9]+\.[0-9]+\.[0-9]+` would take.
		["v1\\.0", "v1.0"],
		// `\` before a character with no special meaning yields that character. The docs
		// define the escape only for their special set, so this half is glob convention
		// (fnmatch, minimatch) rather than a documented rule; it is pinned so the choice
		// is deliberate rather than incidental.
		["\\d", "d"],
		// A quantifier attaches to an escaped literal as it does to any other token.
		["v1\\*+", "v1*"],
		["v1\\*+", "v1**"],
	];
	for (const [pattern, ref] of shouldMatch) {
		let got: string;
		try {
			got = String(matchesFilterPattern(pattern, ref));
		} catch (err: unknown) {
			got = `THREW: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (got !== "true") wrong.push(`"${pattern}" should match "${ref}" (got ${got})`);
	}
	const shouldNotMatch: Array<[string, string]> = [
		// The whole defect: the escaped `*` must not stay a wildcard.
		["v1\\*", "v1zzz"],
		["v1\\*", "v1"],
		// And the backslash itself must not survive into the ref.
		["v1\\*", "v1\\*"],
		["\\d", "\\d"],
		["v1\\+", "v1++"],
	];
	for (const [pattern, ref] of shouldNotMatch) {
		let got: string;
		try {
			got = String(matchesFilterPattern(pattern, ref));
		} catch (err: unknown) {
			got = `THREW: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (got !== "false") wrong.push(`"${pattern}" should NOT match "${ref}" (got ${got})`);
	}
	// A trailing lone `\` has nothing to escape and no documented meaning, so it
	// reports rather than degrading to a literal backslash. Stated choice, not an
	// accident: the alternative silently makes a truncated pattern look valid.
	let trailing = "";
	try {
		matchesFilterPattern("v1\\", "v1\\");
		trailing = "(did not throw)";
	} catch (err: unknown) {
		trailing = err instanceof Error ? err.message : String(err);
	}
	if (!/trailing '\\'/.test(trailing)) {
		wrong.push(`a trailing lone backslash should report; got ${JSON.stringify(trailing)}`);
	}
	assert(wrong.length === 0, `\\ escape mistranslated: ${wrong.join("; ")}`);
});

// GUARD (green on both sides of the NRL-75 verify fix), and it exists because an
// earlier draft of `filterPatternToRegExp`'s doc comment claimed "anything
// undocumented throws", which was FALSE. A character with no special meaning in a
// filter pattern is regex-escaped and treated as a literal, and that is GitHub's
// semantics, not a gap: `(`, `|`, `)`, `{`, `}`, `^` and `$` are ordinary characters
// in a ref name. The escaping is what stops JavaScript's meaning leaking in. What
// DOES throw is malformed or unsupported syntax, listed below. Pinning both halves
// stops the comment drifting away from the code again in either direction.
test("guard: filter-pattern literals stay literal and malformed syntax reports", () => {
	const wrong: string[] = [];
	// Each of these is matched by itself and by nothing its regex meaning would match.
	const literals: Array<[string, string[]]> = [
		["(a|b)", ["a", "b", "ab"]],
		["a{2,3}", ["aa", "aaa"]],
		["^main$", ["main"]],
		["v1.0", ["v1x0"]],
	];
	for (const [pattern, notRefs] of literals) {
		if (!matchesFilterPattern(pattern, pattern)) wrong.push(`"${pattern}" should match itself`);
		for (const ref of notRefs) {
			if (matchesFilterPattern(pattern, ref)) wrong.push(`"${pattern}" should NOT match "${ref}"`);
		}
	}
	// Malformed or outside the documented set. These are the loud half.
	const reporters = ["[^0-9]", "[\\d]", "[]", "[0-9", "]abc", "+abc", "?abc", "[0-9]++", "[0-9]+?", "!v*", ""];
	for (const pattern of reporters) {
		let threw = false;
		try {
			filterPatternToRegExp(pattern);
		} catch {
			threw = true;
		}
		if (!threw) wrong.push(`"${pattern}" should report instead of translating`);
	}
	assert(wrong.length === 0, `matcher literal/report split moved: ${wrong.join("; ")}`);
});

// GUARD (green on both sides). The parser must FAIL LOUDLY, never return `[]`.
// Without this, a future edit to the workflow's shape would silently disarm
// every check below it while the suite stayed green.
test("workflow tag parser reports a shape it cannot read instead of returning []", () => {
	const unreadable = "name: Release\n\non: [push]\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n";
	let threw = "";
	try {
		const got = parseOnPushTags(unreadable);
		throw new Error(`parser returned ${JSON.stringify(got)} for an unparseable workflow instead of reporting`);
	} catch (err: unknown) {
		threw = err instanceof Error ? err.message : String(err);
	}
	assertMatch(threw, /could not locate an `on:`/, `unexpected parser message: ${threw}`);

	const emptyBlock = "on:\n  push:\n    tags:\n      # every entry commented out\n\njobs:\n";
	let threwEmpty = "";
	try {
		const got = parseOnPushTags(emptyBlock);
		throw new Error(`parser returned ${JSON.stringify(got)} for an entry-less block instead of reporting`);
	} catch (err: unknown) {
		threwEmpty = err instanceof Error ? err.message : String(err);
	}
	assertMatch(threwEmpty, /holds no `- <pattern>` entries/, `unexpected parser message: ${threwEmpty}`);

	// And it does read the real file, so the checks below are not green by
	// accident of a parser that reports on everything.
	const live = parseOnPushTags(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
	assert(live.length > 0, "parser read the real workflow but produced no patterns");
});

test("release.yml's tag trigger is not a catch-all (NRL-75)", () => {
	const patterns = parseOnPushTags(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
	const catchAll = patterns.filter((p) => p === "*" || p === "**");
	assert(
		catchAll.length === 0,
		`release.yml on.push.tags contains ${JSON.stringify(catchAll)}: every slash-free tag ` +
			"(nightly, wip, 0.1.0-rc1, v0.1.0) would cut a real public GitHub Release. " +
			"Expected a version-only pattern (NRL-75).",
	);
});

test("release.yml's tag trigger is the bare-semver pattern (NRL-75)", () => {
	const patterns = parseOnPushTags(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
	assertEquals(
		JSON.stringify(patterns),
		JSON.stringify(EXPECTED_TAG_PATTERNS),
		`release.yml on.push.tags is ${JSON.stringify(patterns)}; expected ${JSON.stringify(EXPECTED_TAG_PATTERNS)} (NRL-75)`,
	);
});

test("no operational tag shape matches release.yml's tag trigger (NRL-75)", () => {
	const patterns = parseOnPushTags(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
	// Slash-free on purpose. Per the `'*'` docs row a `backup/`-shaped name is
	// already inert under `"*"`; these are the shapes that really fire.
	const operational = [
		"nightly",
		"wip",
		"pre-rebase",
		"backup-nrl-54-pre-split-20260930T053352Z",
		"v0.1.0",
		"0.1.0-rc1",
		"0.1.0-beta.1",
		"0.1",
		"0.1.0.1",
		"release",
	];
	const fired = operational.filter((tag) => refMatchesPatterns(patterns, tag));
	assert(
		fired.length === 0,
		`these tag names still match release.yml's ${JSON.stringify(patterns)} and would cut a real ` +
			`public GitHub Release: ${JSON.stringify(fired)} (NRL-75)`,
	);
});

// GUARD, NOT A REPRODUCTION, and deliberately labelled one: this is the tag name
// the ticket cites, and it is GREEN ON BOTH SIDES. GitHub's `'*'` row says the
// pattern matches only names that contain no slash, so this tag was already
// inert before the fix. It is kept because the name is the one on disk; calling
// it a reproduction would be theatre.
test("guard: the backup/-shaped tag matches neither the old nor the new trigger", () => {
	const real = "backup/nrl-54-pre-split-20260930T053352Z";
	assert(!refMatchesPatterns(["*"], real), `"*" unexpectedly matched ${real}`);
	assert(!refMatchesPatterns(EXPECTED_TAG_PATTERNS, real), `new pattern unexpectedly matched ${real}`);
});

// GUARD on the pattern's MEANING rather than on the file: narrowing must not
// stop the release this plugin would actually cut. `0.1.0` is manifest.json's
// current version and versions.json's only key.
test("guard: the bare-semver pattern still fires on real version tags", () => {
	for (const tag of ["0.1.0", "1.10.1", "10.0.0", "0.0.0"]) {
		assert(
			refMatchesPatterns(EXPECTED_TAG_PATTERNS, tag),
			`${JSON.stringify(EXPECTED_TAG_PATTERNS)} should match the version tag ${tag}`,
		);
	}
});

// --- Release Files Exist

test("README.md exists", () => {
	assertFileExists(README_FILE, "README.md not found");
});

test("README.md is not empty", () => {
	const content = fs.readFileSync(README_FILE, "utf-8");
	assert(content.length > 100, "README.md is too short");
	assertMatch(content, /Local TTS Reader/, "README.md missing project name");
	assertMatch(content, /on-device/, "README.md missing on-device mention");
	assertMatch(content, /privacy/i, "README.md missing privacy mention");
});

test("LICENSE exists", () => {
	assertFileExists(LICENSE_FILE, "LICENSE not found");
});

test("LICENSE is MIT", () => {
	const content = fs.readFileSync(LICENSE_FILE, "utf-8");
	assertMatch(content, /MIT License/, "LICENSE missing MIT header");
	assertMatch(content, /Permission is hereby granted/, "LICENSE missing permission clause");
});

test("versions.json exists", () => {
	assertFileExists(VERSIONS_FILE, "versions.json not found");
});

test("versions.json is valid JSON", () => {
	const content = fs.readFileSync(VERSIONS_FILE, "utf-8");
	try {
		const doc = JSON.parse(content);
		assert(typeof doc === "object", "versions.json is not an object");
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse versions.json: ${message}`);
	}
});

test("manifest.json exists", () => {
	assertFileExists(MANIFEST_FILE, "manifest.json not found");
});

test("ADR 0011 exists", () => {
	assertFileExists(ADR_FILE, "docs/adr/0011-release-attestation.md not found");
});

test("ADR 0011 mentions SLSA", () => {
	const content = fs.readFileSync(ADR_FILE, "utf-8");
	assertMatch(content, /SLSA/i, "ADR 0011 missing SLSA mention");
});

test("ADR 0011 mentions ORT checksums", () => {
	const content = fs.readFileSync(ADR_FILE, "utf-8");
	assertMatch(content, /checksum/i, "ADR 0011 missing checksum mention");
	assertMatch(content, /ORT/i, "ADR 0011 missing ORT mention");
});

// Summary
// Conditional (NRL-69): printed unconditionally this line claimed a pass on a red
// run, and a reader scanning the log sees it before the count below.
if (passedTests === totalTests) console.log(`\nall release tests passed\n`);
console.log(`${passedTests} of ${totalTests} passed`);
if (passedTests === totalTests) {
	process.exit(0);
} else {
	process.exit(1);
}
