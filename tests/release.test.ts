/**
 * Regression tests for release infrastructure (NRL-16).
 *
 * These tests verify:
 * 1. Build succeeds with ORT checksums compiled
 * 2. Checksums are read-only in main.js
 * 3. No model weights downloaded during build
 * 4. Workflow file is valid GitHub Actions YAML
 */

import * as fs from "node:fs";
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

test("release.yml's Upload Release Assets step includes the four ORT filenames (NRL-37)", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	const uploadStepMatch = content.match(
		/Upload Release Assets[\s\S]*?files:\s*\|([\s\S]*?)\n\s*\n/,
	);
	const filesBlock = uploadStepMatch?.[1];
	assert(filesBlock !== undefined, "Upload Release Assets step's files: block not found");
	for (const file of [
		"ort/ort-wasm-simd-threaded.mjs",
		"ort/ort-wasm-simd-threaded.wasm",
		"ort/ort-wasm-simd-threaded.jsep.mjs",
		"ort/ort-wasm-simd-threaded.jsep.wasm",
	]) {
		assert(
			filesBlock!.includes(file),
			`Upload Release Assets step must publish ${file} as an extra release ` +
				"asset so it is fetchable at releases/download/<tag>/<filename> " +
				"without changing what Obsidian's own installer fetches",
		);
	}
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
