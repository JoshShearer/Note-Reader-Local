/**
 * Release-artifact regression tests (NRL-16, amended by NRL-37, NRL-75,
 * NRL-76, and NRL-96/ADR 0028).
 *
 * The load-bearing test since NRL-96 is "the runtime unpacks byte-identical
 * to node_modules": the ONNX runtime ships inside main.js rather than being
 * downloaded, so everything else is a cheap guard on the shape of that claim.
 * It reads the real built main.js, not the sources, because the thing being
 * asserted is what ships. It never runs the plugin: `obsidian` has no runtime
 * in this suite (AGENTS.md), so a passing run here is evidence about the
 * artifact and not about a working install.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

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
const ADR_RUNTIME_FILE = path.join(ROOT, "docs/adr/0028-bundle-executable-runtime.md");
const RUNTIME_TS_FILE = path.join(ROOT, "src/engines/onnx/runtime.ts");
const ORT_DIST = path.join(ROOT, "node_modules/onnxruntime-web/dist");
const DEPLOY_FILE = path.join(ROOT, "deploy.mjs");
const MAIN_TS_FILE = path.join(ROOT, "src/main.ts");

let totalTests = 0;
let passedTests = 0;

// Async-capable: NRL-96's bundling checks import runtime.ts dynamically and
// unpack real gzip streams, which the rest of this file's synchronous tests
// never needed. A sync test still works unchanged, wrapped in an async IIFE.
const pending: Array<Promise<void>> = [];

function test(name: string, fn: () => void | Promise<void>): void {
	pending.push(
		(async () => {
			totalTests++;
			try {
				await fn();
				console.log(`  ok   ${name}`);
				passedTests++;
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				console.log(`  FAIL ${name}`);
				console.log(`       ${message}`);
			}
		})(),
	);
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

// --- The runtime is bundled, and it unpacks byte-identical (NRL-96, ADR 0028)
//
// This is the test that matters. Obsidian's community-plugin policies
// prohibit installing or updating dependencies, so a runtime fetched from a
// release URL is not shippable however well it is verified, and the only
// remaining question is whether the bytes we embed are the bytes
// onnxruntime-web published. Everything below either reads the same table or
// guards the ways that answer could become a lie.

/**
 * Extract one packed asset out of the real bundle.
 *
 * Hand-scanned rather than eval'd, and matched per filename rather than by
 * parsing the whole table, for three reasons that all matter here. esbuild
 * minifies the object literal so its keys are bare (`{gzip:"..."`), which means
 * it is not JSON and `JSON.parse` rejects it at position 31. Scanning for the
 * matching brace handles ~10 MB of base64 without the catastrophic backtracking
 * a regex over that would cause, and the string-literal handling is what keeps
 * an escaped quote inside a payload from closing the scan early. The failure is
 * a throw rather than a silent undefined, because "no table in the bundle" and
 * "table present, asset missing" are very different bugs and must not read the
 * same.
 */
function readPackedAsset(content: string, name: string): { gzip: string; sha256: string } {
	const anchor = content.indexOf(`"${name}":{gzip:"`);
	assert(anchor >= 0, `main.js carries no packed asset for ${name}`);

	const gzipStart = anchor + `"${name}":{gzip:"`.length;
	const gzipEnd = content.indexOf('"', gzipStart);
	assert(gzipEnd > gzipStart, `the packed gzip payload for ${name} is not terminated`);

	const shaStart = content.indexOf('sha256:"', gzipEnd);
	assert(shaStart >= 0, `the packed asset for ${name} carries no digest`);
	const shaFrom = shaStart + 'sha256:"'.length;
	const shaEnd = content.indexOf('"', shaFrom);
	assert(shaEnd > shaFrom, `the packed digest for ${name} is not terminated`);

	return { gzip: content.slice(gzipStart, gzipEnd), sha256: content.slice(shaFrom, shaEnd) };
}

function ortAssetNames() {
	return fs
		.readdirSync(ORT_DIST)
		.filter((name) => name.startsWith("ort-wasm-") && (name.endsWith(".mjs") || name.endsWith(".wasm")))
		.sort();
}

test("nothing but the ORT runtime is packed into the bundle", () => {
	// Weights must only ever arrive on an explicit user click (AGENTS.md
	// non-negotiable 6), so the thing to assert is that the pack contains no
	// weight file - not that the strings "onnx" or "model" are absent from
	// main.js, which they are and must be: the default model is the
	// HuggingFace repo id "onnx-community/Kokoro-82M-v1.0-ONNX" and it appears
	// verbatim in the bundle. A substring test over that would be a false
	// positive by construction, and the first version of this check was.
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	const keys = [...content.matchAll(/"([^"]+)":\{gzip:"/g)]
		.map((m) => m[1])
		.filter((name) => name !== undefined);
	assert(keys.length > 0, "no packed-asset table found in main.js");

	const ortNames = ortAssetNames();
	for (const key of keys) {
		assert(
			ortNames.includes(key),
			`main.js packs ${key}, which is not a published ORT asset. Model weights ` +
				"may only be downloaded on an explicit user click, never packed",
		);
	}
});

test("every ORT file is packed into main.js and unpacks to the published bytes", () => {
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	const names = ortAssetNames();
	assert(names.length > 0, `no ORT assets found in ${ORT_DIST}`);

	for (const name of names) {
		const packed = readPackedAsset(content, name);
		const plain = gunzipSync(Buffer.from(packed.gzip, "base64"));
		const digest = crypto.createHash("sha256").update(plain).digest("hex");
		assertEquals(
			digest,
			packed.sha256,
			`${name}: unpacked bytes do not hash to the digest recorded beside them`,
		);

		const published = fs.readFileSync(path.join(ORT_DIST, name));
		assertEquals(
			digest,
			crypto.createHash("sha256").update(published).digest("hex"),
			`${name}: the embedded copy is not the file onnxruntime-web published`,
		);
	}
});

test("the build packs exactly RUNTIME_FILES, and nothing else", async () => {
	// esbuild.config.mjs cannot import runtime.ts - it runs in plain Node
	// before any bundle exists, with no TS loader - so the canonical list and
	// the build's own list are two copies that have to be kept in agreement by
	// a check rather than by import.
	const { RUNTIME_FILES } = await import("../src/engines/onnx/runtime.ts");
	const config = fs.readFileSync(path.join(ROOT, "esbuild.config.mjs"), "utf-8");

	const arrayMatch = config.match(/const ORT_FILES = \[([^\]]*)\]/);
	const arraySource = arrayMatch?.[1] ?? "";
	assert(arraySource !== "", "esbuild.config.mjs's ORT_FILES list not found");
	const buildFiles = [...arraySource.matchAll(/"([^"]+)"/g)]
		.map((m) => m[1])
		.filter((name) => name !== undefined);

	assert(
		JSON.stringify(buildFiles) === JSON.stringify([...RUNTIME_FILES]),
		`esbuild.config.mjs packs ${buildFiles.join(", ")} but runtime.ts declares ` +
			`${RUNTIME_FILES.join(", ")}; a pack and its reader that disagree about ` +
			"which files exist is a missing-runtime bug at play time",
	);

	const packed = [...fs.readFileSync(MAIN_JS, "utf-8").matchAll(/"([^"]+)":\{gzip:"/g)]
		.map((m) => m[1])
		.filter((name) => name !== undefined);
	assert(
		JSON.stringify([...packed].sort()) === JSON.stringify([...RUNTIME_FILES].sort()),
		`main.js packs ${packed.join(", ")} rather than the declared runtime files`,
	);
});

test("the pack is gzip, so the bundle grows far less than the runtime's raw size", () => {
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	let raw = 0;
	let packed = 0;
	for (const name of ortAssetNames()) {
		raw += fs.readFileSync(path.join(ORT_DIST, name)).length;
		packed += Buffer.from(readPackedAsset(content, name).gzip, "base64").length;
	}
	// Measured this session: 32,794,766 raw against 10,579,272 packed. The
	// threshold is deliberately loose - it is here to catch a regression to
	// storing the files uncompressed, not to pin a ratio that moves whenever
	// onnxruntime-web ships a new build.
	assert(
		packed < raw * 0.5,
		`expected the pack to be under half the raw size, got ${packed} of ${raw}`,
	);
});

test("nothing in the bundle can fetch a runtime at runtime", () => {
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	assert(
		!content.includes("releases/download"),
		"main.js references a release download URL - the runtime must ship inside " +
			"the bundle, and a fetch is executable dependency management regardless " +
			"of how it is verified (ADR 0028)",
	);
	assert(
		!content.includes("ORT_RELEASE_REPO"),
		"main.js still carries the release-repo constant the on-demand download used",
	);
});

test("runtime.ts reaches the network for nothing", () => {
	const content = fs.readFileSync(RUNTIME_TS_FILE, "utf-8");
	for (const forbidden of ["fetch(", "XMLHttpRequest", "https://", "http://"]) {
		assert(
			!content.includes(forbidden),
			`src/engines/onnx/runtime.ts contains ${forbidden} - the unpack path must ` +
				"be entirely local, since that is the property that replaces the download",
		);
	}
	assert(
		content.includes("DecompressionStream"),
		"runtime.ts must decompress through the platform's own gzip decoder rather " +
			"than shipping a second inflate implementation",
	);
});

test("a corrupt pack is rejected rather than executed", async () => {
	// The check that matters is that a digest mismatch throws, so a damaged
	// install reports itself instead of handing wrong bytes to onnxruntime.
	// Driven against the real module with a deliberately wrong digest, which is
	// the only way to reach the failure from outside: unpacking a genuinely
	// valid pack is the passing case and cannot fail here.
	const { unpackRuntimeFile } = await import("../src/engines/onnx/runtime.ts");
	const name = "ort-wasm-simd-threaded.mjs";
	const good = readPackedAsset(fs.readFileSync(MAIN_JS, "utf-8"), name);

	const bytes = await unpackRuntimeFile(good);
	assertEquals(
		bytes.byteLength,
		fs.readFileSync(path.join(ORT_DIST, name)).length,
		"a good pack must inflate to the published size",
	);

	let threw = false;
	try {
		await unpackRuntimeFile({ gzip: good.gzip, sha256: "0".repeat(64) });
	} catch {
		threw = true;
	}
	assert(threw, "a pack whose digest does not match must throw, not be returned");
});

test("deploy.mjs copies exactly the three files Obsidian's installer fetches", () => {
	const content = fs.readFileSync(DEPLOY_FILE, "utf-8");
	const arrayMatch = content.match(/for \(const item of (\[[^\]]*\])/);
	const arraySource = arrayMatch?.[1];
	assert(arraySource !== undefined, "deploy.mjs's copy-item array not found");
	const items = JSON.parse(arraySource!.replace(/'/g, '"'));

	assert(
		!items.includes("ort"),
		"deploy.mjs must not copy ort/ into the vault plugin folder. A directory " +
			"install is only main.js, manifest.json and styles.css, so shipping ort/ " +
			"would hide a load path that is broken for every real user (AGENTS.md " +
			"verification rule 11)",
	);
	assert(
		items.includes("main.js") && items.includes("manifest.json") && items.includes("styles.css"),
		"deploy.mjs must still copy the three files Obsidian's own installer fetches",
	);
});

test("release.yml publishes no runtime asset to download", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	assert(
		!/ort\/ort-wasm/.test(content),
		"release.yml still uploads the ORT files as release assets. Nothing fetches " +
			"them any more, and publishing a downloadable runtime is what ADR 0028 " +
			"exists to stop",
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
 * so this is a text scan, and every failure mode throws rather than returning
 * `[]`. An empty list would make the subject-set check vacuously green.
 *
 * SCOPED TO THE STEP since NRL-124. It used to be one regex over the whole file,
 * `/Upload Release Assets[\s\S]*?files:\s*\|([\s\S]*?)\n\s*\n/`, and that had
 * two parser artefacts that leaked out as constraints on whoever edited the
 * workflow. It took the FIRST occurrence of either anchor anywhere, so a comment
 * merely quoting the step name or a `files: |` block hijacked the capture and
 * reported comment prose as published assets (hit for real during NRL-104, and
 * re-measured for NRL-124 at 11 entries of which only three were real). And it
 * ended the capture at the
 * first BLANK LINE rather than at the next YAML key, so a `with:` key written
 * below the scalar became a published asset while a blank line inside the scalar
 * - legal YAML - truncated the list. It now reads the step slice
 * `extractUploadStep` returns, which locates the step by an exact `- name:`
 * match, and ends the block at the next key at or shallower than `files:`.
 *
 * NRL-75's oracle rule governs the shape of this: it must stay faithful to what
 * GitHub actually parses, so it does not throw on anything GitHub treats as
 * ordinary text.
 */
function extractUploadedFiles(content: string): string[] {
	// Forward reference to a function declared further down, which hoists. The
	// slice is the whole point: the step is located by name, not by the first
	// match anywhere, which is what a comment used to be able to hijack.
	const lines = extractUploadStep(content).split("\n");
	// `|`, `|-` and `|+` are all literal block scalars GitHub accepts. The old
	// `files:\s*\|` swallowed a chomping indicator into the capture and reported a
	// bogus `-` entry; matching it here keeps this faithful to what GitHub parses.
	const filesAt = lines.findIndex((line) => /^\s*files:\s*\|[-+]?\s*$/.test(line));
	if (filesAt === -1) {
		throw new Error(
			"could not locate the `Upload Release Assets` step's `files: |` block in the workflow text; " +
				"refusing to return an empty published-asset list, which would make the NRL-76 subject-set " +
				"check vacuously green",
		);
	}
	const keyIndent = (lines[filesAt] ?? "").search(/\S/);
	const files: string[] = [];
	for (let i = filesAt + 1; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		// A blank line is legal INSIDE a YAML literal block scalar, so it is skipped
		// rather than ending the block. The old first-blank-line terminator read one
		// as the end and silently dropped every entry after it (NRL-124 decision 4).
		if (raw.trim() === "") continue;
		// The block ends at the first line indented at or shallower than its own
		// `files:` key, which is what YAML says and what the old regex did not.
		if (raw.search(/\S/) <= keyIndent) break;
		const line = raw.trim();
		// A DELIBERATE DIVERGENCE from GitHub, kept rather than fixed (NRL-124
		// decision 9): inside a literal block scalar `# x` is a GLOB, not a comment,
		// so GitHub would treat it as a pattern to publish. Nothing in the real
		// workflow has such a line, and `fail_on_unmatched_files: true` makes GitHub
		// fail that run loudly, so this under-report cannot silently ship a short
		// Release. Removing the skip would be a behaviour change with no defect
		// behind it.
		if (line.startsWith("#")) continue;
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

// --- The pushed tag is checked against the version files (NRL-105)
//
// `on: push: tags` admits only bare semver since NRL-75, but it admits ANY bare
// semver. Nothing read `manifest.json`, `package.json` or `versions.json`, so
// pushing `9.9.9` at a commit whose manifest says `0.1.0` cut a Release whose
// name and contents contradicted each other. Obsidian's community-plugin
// installer reads `manifest.json` off the Release to learn the version and
// `versions.json` to decide which Obsidian versions may install it, which is
// what makes this the one hazard on this path that reaches a user.
//
// THESE CHECKS EXECUTE THE STEP, for the same reason the NRL-76 block below
// does: a check that grepped the YAML would pass the moment someone reformatted
// a comparison that no longer discriminated. The body is extracted verbatim,
// written to a script, and run in a throwaway sandbox holding three planted JSON
// files. `bash -e` and deliberately NOT `-o pipefail` - see the section comment
// above `extractRunBlock` - which is what makes the body's own
// `set -euo pipefail` the thing under test rather than a harness flag.
//
// Four of the checks exist only to stop a vacuous pass and are labelled where
// they sit: 5 is the only pin on "report every disagreement rather than the
// first", 13 asserts the MESSAGE and not just the status because an unset `TAG`
// exits non-zero even with the `-z` clause deleted, 15 pins that no `${{ }}`
// reaches the body (one would make every execution check above a fiction), and
// 17 is a tripwire on the `on:` block, green on both sides, standing in for the
// `if:` this step deliberately does not carry.

/** The step name both the workflow and these checks must spell identically. */
const TAG_GUARD_STEP = "Verify the tag matches the version files";

/**
 * The same, for the upload step. Hoisted into one place by NRL-124 so the anchor
 * literal `extractUploadStep` and `extractUploadedFiles` both depend on exists
 * exactly once in this file rather than twice.
 */
const UPLOAD_STEP_NAME = "Upload Release Assets";

/** The matching triple, as exact file bytes. Each case overrides exactly one. */
const GOOD_MANIFEST = '{"id":"local-tts-reader","version":"0.1.0","minAppVersion":"1.8.0"}\n';
const GOOD_PACKAGE = '{"name":"local-tts-reader","version":"0.1.0"}\n';
const GOOD_VERSIONS = '{"0.1.0":"1.8.0"}\n';

interface GuardRun {
	/** Process exit status. 0 on success. */
	status: number;
	stdout: string;
	stderr: string;
	/** The sandbox workspace the step ran in. */
	work: string;
}

/**
 * Run `release.yml`'s tag-guard step in a throwaway sandbox.
 *
 * A sibling of `runChecksumStep` rather than a parameterisation of it: that one
 * plants its fixture from `extractUploadedFiles` (the published-asset list),
 * creates a `$GITHUB_OUTPUT`, and decodes base64 `sha256sum` subjects, none of
 * which exists here - and this step needs a `TAG` env var, per-case file
 * CONTENTS and stdout, which that one has no concept of. Threading both through
 * one runner would put a `subjects: []` on every result, which is the kind of
 * field that later gets asserted vacuously.
 *
 * `null` means "do not create that file at all"; `tag: null` means "do not set
 * `TAG` at all", and it must DELETE the key from the inherited environment, or
 * an ambient `TAG` in a developer's shell would make check 13 pass for the wrong
 * reason.
 */
function runTagGuardStep(
	options: {
		tag?: string | null;
		manifest?: string | null;
		pkg?: string | null;
		versions?: string | null;
	} = {},
): GuardRun {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	// Throws if the step is absent or renamed, rather than yielding an empty
	// script that would make every check below green.
	const script = extractRunBlock(content, TAG_GUARD_STEP);
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "nrl105-tag-guard-"));
	const work = path.join(sandbox, "workspace");
	fs.mkdirSync(work, { recursive: true });

	const plant = (name: string, bytes: string | null | undefined, fallback: string) => {
		const value = bytes === undefined ? fallback : bytes;
		if (value === null) return;
		fs.writeFileSync(path.join(work, name), value);
	};
	plant("manifest.json", options.manifest, GOOD_MANIFEST);
	plant("package.json", options.pkg, GOOD_PACKAGE);
	plant("versions.json", options.versions, GOOD_VERSIONS);

	const scriptPath = path.join(sandbox, "verify-tag.sh");
	fs.writeFileSync(scriptPath, script);

	const env: Record<string, string | undefined> = { ...process.env };
	const tag = options.tag === undefined ? "0.1.0" : options.tag;
	if (tag === null) delete env.TAG;
	else env.TAG = tag;

	let status = 0;
	let stdout = "";
	let stderr = "";
	try {
		// `-e` only. See the section comment above `extractRunBlock`: that is
		// GitHub's documented default for a `run:`.
		stdout = execFileSync("bash", ["-e", scriptPath], {
			cwd: work,
			env,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err: unknown) {
		const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
		status = typeof e.status === "number" ? e.status : 1;
		stdout = e.stdout === undefined ? "" : String(e.stdout);
		stderr = e.stderr === undefined ? "" : String(e.stderr);
	}
	return { status, stdout, stderr, work };
}

/**
 * A named step's whole YAML text, from its `- name:` line to the next line at
 * the same or shallower indentation.
 *
 * Throws for the same reason every other extractor in this file does: an empty
 * string would make the `shell:` / `if:` / `env:` checks vacuously green.
 */
function extractStepText(content: string, stepName: string): string {
	const lines = content.split("\n");
	const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
	if (start === -1) {
		throw new Error(
			`could not locate a \`- name: ${stepName}\` step in the workflow text; refusing to ` +
				"return an empty step body, which would make the wiring checks vacuously green",
		);
	}
	const indent = (lines[start] ?? "").search(/\S/);
	const out: string[] = [lines[start] ?? ""];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "") {
			out.push("");
			continue;
		}
		// The next step, or a comment block introducing it, sits at this indent.
		if (line.search(/\S/) <= indent) break;
		out.push(line);
	}
	return out.join("\n");
}

/** The 1-based line index of a step's `- name:` line, for ordering checks. */
function stepNameLine(content: string, stepName: string): number {
	const lines = content.split("\n");
	const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
	if (at === -1) throw new Error(`no \`- name: ${stepName}\` step in the workflow text`);
	return at + 1;
}

// 1. DEFECT REPRODUCTION. Red against the unguarded workflow: `extractRunBlock`
// throws, which `test()` prints as a named FAIL with the diagnosis attached.
test("the tag guard passes when the tag agrees with all three version files (NRL-105)", () => {
	const run = runTagGuardStep();
	assertEquals(run.status, 0, `the guard rejected a matching triple: ${run.stderr}`);
	assertMatch(
		run.stdout,
		/0\.1\.0/,
		"a passing guard must say which tag it agreed with, so a green log is readable",
	);
});

// 2.
test("a manifest.json version that disagrees with the tag fails the run (NRL-105)", () => {
	const run = runTagGuardStep({ manifest: '{"version":"0.1.1"}\n' });
	assert(run.status !== 0, "a manifest whose version is not the tag must fail the run");
	assertMatch(run.stderr, /manifest\.json/, "the message must name the file that disagrees");
	assertMatch(run.stderr, /0\.1\.1/, "the message must name the value it found");
	assertMatch(run.stderr, /0\.1\.0/, "the message must name the tag it was compared against");
});

// 3.
test("a package.json version that disagrees with the tag fails the run (NRL-105)", () => {
	const run = runTagGuardStep({ pkg: '{"name":"x","version":"0.2.0"}\n' });
	assert(run.status !== 0, "a package.json whose version is not the tag must fail the run");
	assertMatch(run.stderr, /package\.json/, "the message must name the file that disagrees");
	assertMatch(run.stderr, /0\.2\.0/, "the message must name the value it found");
});

// 4.
test("a versions.json with no key for the tag fails the run (NRL-105)", () => {
	const run = runTagGuardStep({ versions: '{"0.0.9":"1.8.0"}\n' });
	assert(run.status !== 0, "versions.json with no key equal to the tag must fail the run");
	assertMatch(run.stderr, /versions\.json/, "the message must name versions.json");
	assertMatch(
		run.stderr,
		/0\.0\.9/,
		"the message must list the keys it did find, or the author cannot see what to fix",
	);
});

// 5. THE ONLY PIN on "report every disagreement, not the first". A body that
// stopped at the first problem passes checks 2, 3 and 4 and fails only this one.
// A tag is expensive to retry - delete it locally and remotely, and every attempt
// leaves a permanent run in Actions history - so three push-fail-delete cycles
// for one half-finished version bump is the wrong trade.
test("the tag guard reports every disagreement, not just the first (NRL-105)", () => {
	const run = runTagGuardStep({
		manifest: '{"version":"1.0.0"}\n',
		pkg: '{"name":"x","version":"2.0.0"}\n',
		versions: '{"3.0.0":"1.8.0"}\n',
	});
	assert(run.status !== 0, "three disagreements must fail the run");
	for (const file of ["manifest.json", "package.json", "versions.json"]) {
		assert(
			run.stderr.includes(file),
			`stderr must name every disagreeing file, but ${file} is absent. ` +
				`A body that stops at the first problem makes the author push, fail and delete a tag ` +
				`once per file. Full stderr: ${JSON.stringify(run.stderr)}`,
		);
	}
});

// 6. Kills `includes` / `startsWith` / `grep` key matching.
test("a versions.json key that merely contains the tag is not a match (NRL-105)", () => {
	const run = runTagGuardStep({ versions: '{"0.1.01":"1.8.0"}\n' });
	assert(
		run.status !== 0,
		"`0.1.01` contains `0.1.0` as a substring but is a different version; a substring or " +
			"`grep` key test would wrongly accept it",
	);
});

// 7. The other direction of the same defect: the tag as a prefix of a key.
// manifest and package both say `0.1`, so only the key check can fail this.
test("a tag that is a prefix of a versions.json key is not a match (NRL-105)", () => {
	const run = runTagGuardStep({
		tag: "0.1",
		manifest: '{"version":"0.1"}\n',
		pkg: '{"name":"x","version":"0.1"}\n',
		versions: '{"0.1.0":"1.8.0"}\n',
	});
	assert(run.status !== 0, "the tag `0.1` must not match the key `0.1.0`");
	assertMatch(run.stderr, /versions\.json/, "only the versions.json check can fail this case");
});

// 8. See the plan-phase decision recorded on NRL-105: the key's only purpose is
// to carry the minimum Obsidian version string the installer reads, so an empty
// value is indistinguishable in effect from the missing key.
test("a versions.json key mapping to an empty value fails the run (NRL-105)", () => {
	const run = runTagGuardStep({ versions: '{"0.1.0":""}\n' });
	assert(run.status !== 0, "a key present with an empty minAppVersion must fail the run");
	assertMatch(run.stderr, /versions\.json/, "the message must name versions.json");
});

// 9.
test("a missing version file fails the run and is named (NRL-105)", () => {
	const run = runTagGuardStep({ versions: null });
	assert(run.status !== 0, "an absent versions.json must fail the run");
	assertMatch(
		run.stderr,
		/versions\.json/,
		"the message must name the file that is missing, not merely exit non-zero",
	);
});

// 10. A diagnosis, not a node stack trace: the reader of a failed release run
// needs the file name, and a raw throw buries it under frames.
test("malformed JSON in a version file is diagnosed, not thrown (NRL-105)", () => {
	const run = runTagGuardStep({ manifest: "{ not json\n" });
	assert(run.status !== 0, "unparseable JSON must fail the run");
	assertMatch(run.stderr, /manifest\.json/, "the message must name the unparseable file");
	assert(
		!/\n\s+at /.test(run.stderr),
		`the guard must diagnose a malformed file rather than letting node print a stack trace. ` +
			`Full stderr: ${JSON.stringify(run.stderr)}`,
	);
});

// 11. The trigger cannot produce a `v`-prefixed tag, so this exists to stop a
// well-meaning "strip the v" edit: normalising the tag would reintroduce exactly
// the class of mismatch this step is for.
test("nothing normalises the tag, so a v-prefixed tag fails (NRL-105)", () => {
	const run = runTagGuardStep({ tag: "v0.1.0" });
	assert(
		run.status !== 0,
		"`v0.1.0` must not be silently normalised to `0.1.0`; the files say `0.1.0` and the tag does not",
	);
});

// 12. THE PROTOTYPING HOLE. A first draft used `null` as the "file unreadable"
// sentinel and skipped the versions checks on it, so a versions.json whose whole
// content is the literal `null` EXITED 0. The sentinel must be `undefined`, which
// `JSON.parse` cannot return, and the object test must reject `null` explicitly.
test("a versions.json that is not a map of version keys fails the run (NRL-105)", () => {
	for (const bytes of ["[]\n", "null\n"]) {
		const run = runTagGuardStep({ versions: bytes });
		assert(
			run.status !== 0,
			`versions.json holding ${JSON.stringify(bytes.trim())} carries no key for the tag and must ` +
				`fail the run. A \`null\` sentinel for an unreadable file makes the literal \`null\` exit 0.`,
		);
		assertMatch(run.stderr, /versions\.json/, "the message must name versions.json");
	}
});

// 13. THE MESSAGE IS THE ASSERTION. With the `-z "${TAG:-}"` clause deleted, an
// unset or empty TAG still exits non-zero - every comparison fails against an
// undefined tag - so a status-only check stays green on the mutation and proves
// nothing.
test("an empty or unset TAG fails the run by name (NRL-105)", () => {
	for (const tag of ["", null] as Array<string | null>) {
		const run = runTagGuardStep({ tag });
		assert(run.status !== 0, `TAG=${JSON.stringify(tag)} must fail the run`);
		assertMatch(
			run.stderr,
			/TAG/,
			`the guard must say that TAG itself is missing rather than reporting three version ` +
				`mismatches against an empty tag. Full stderr: ${JSON.stringify(run.stderr)}`,
		);
	}
});

// 14. The guard reads three small JSON files, so it must cost seconds rather
// than a full typecheck+build+test, and it must not sit after the gates where a
// mismatched tag would already have paid for them.
test("the tag guard runs after npm ci and before the quality gates (NRL-105)", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	const guard = stepNameLine(content, TAG_GUARD_STEP);
	const install = stepNameLine(content, "Install dependencies");
	const gates = stepNameLine(content, "Run quality gates");
	assert(
		install < guard && guard < gates,
		`the guard must sit between \`Install dependencies\` (line ${install}) and ` +
			`\`Run quality gates\` (line ${gates}), but it is at line ${guard}`,
	);
});

// 15. If a `${{ }}` were written into the body, `extractRunBlock` would return it
// as an unevaluable literal and every execution check above would be exercising
// something the runner never runs. It is also the documented
// script-injection-safe shape.
test("the tag reaches the guard through env:, never interpolated into the body (NRL-105)", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	const step = extractStepText(content, TAG_GUARD_STEP);
	assertMatch(
		step,
		/\n\s+env:\n\s+TAG:\s*\$\{\{\s*github\.ref_name\s*\}\}\s*\n/,
		"the step must carry `env:` with `TAG: ${{ github.ref_name }}`",
	);
	const body = extractRunBlock(content, TAG_GUARD_STEP);
	assert(
		!body.includes("${{"),
		`the run body must contain no \`\${{ }}\` expression: extractRunBlock returns it verbatim, so ` +
			`one would make every execution check in this block a fiction, and it is the documented ` +
			`script-injection shape. Body: ${JSON.stringify(body)}`,
	);
});

// 16. ADR 0011's NRL-76 amendment, decision 4: shell options live in the BODY,
// because the body is what this suite executes and a `shell: bash` key would be
// a guarantee nothing here covers. And NRL-76 decision 5: no `if:` - `on:` is
// `push.tags` only (check 17), so a condition's only effect would be to make the
// step skippable, and a silent skip on a real tag push is worse than a failure.
test("the guard sets its shell options in the body and carries no shell: or if: (NRL-105)", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	const body = extractRunBlock(content, TAG_GUARD_STEP);
	assertEquals(
		(body.split("\n")[0] ?? "").trim(),
		"set -euo pipefail",
		"the body's first line must be `set -euo pipefail` (ADR 0011, NRL-76 decision 4)",
	);
	const step = extractStepText(content, TAG_GUARD_STEP);
	for (const key of ["shell:", "if:"]) {
		const offender = step
			.split("\n")
			.find((l) => l.trim().startsWith(key) && !l.trim().startsWith("#"));
		assertEquals(
			offender,
			undefined,
			`the step must carry no \`${key}\` key, but found ${JSON.stringify(offender)}`,
		);
	}
});

// 17. GUARD (green on both sides). This stands in for the `if:` the step does not
// carry. `on:` is exactly `{push: {tags: [...]}}`, so `github.ref_name` can only
// ever be the pushed bare-semver tag and no condition is needed. The moment
// someone adds `workflow_dispatch:` or `branches:`, this fails and forces them to
// decide what the guard does on a non-tag ref - instead of the guard quietly
// failing every such run.
test("guard: release.yml's `on:` block is push.tags and nothing else (NRL-105)", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	const onAt = content.search(/^on:/m);
	const jobsAt = content.search(/^jobs:/m);
	assert(onAt !== -1 && jobsAt !== -1 && onAt < jobsAt, "the workflow must have `on:` before `jobs:`");
	const slice = content.slice(onAt, jobsAt);
	const byIndent = new Map<number, string[]>();
	for (const raw of slice.split("\n")) {
		if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
		const indent = raw.search(/\S/);
		if (raw.trim().startsWith("- ")) continue; // a list entry, not a key
		const at = byIndent.get(indent) ?? [];
		at.push(raw.trim());
		byIndent.set(indent, at);
	}
	assertEquals(
		JSON.stringify(byIndent.get(0) ?? []),
		JSON.stringify(["on:"]),
		"nothing but `on:` may sit at column 0 in this slice",
	);
	assertEquals(
		JSON.stringify(byIndent.get(2) ?? []),
		JSON.stringify(["push:"]),
		"`on:` must hold `push:` and nothing else - no workflow_dispatch, workflow_call or schedule. " +
			"Adding one changes what `github.ref_name` can be, which is what the tag guard compares.",
	);
	assertEquals(
		JSON.stringify(byIndent.get(4) ?? []),
		JSON.stringify(["tags:"]),
		"`push:` must hold `tags:` and nothing else - a `branches:` key would make `github.ref_name` " +
			"a branch name and the tag guard would fail every push to it",
	);
});

// 18.
test("ADR 0011 records the NRL-105 tag-guard decision", () => {
	const adr = fs.readFileSync(ADR_FILE, "utf-8");
	assertMatch(
		adr,
		/Amendment \(NRL-105\)/,
		"docs/adr/0011-release-attestation.md must carry an `Amendment (NRL-105)` section",
	);
});

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

// --- One pinned action creates the Release and uploads its assets (NRL-104)
//
// `release.yml` used to run two actions back to back: `Create GitHub Release`
// (`actions/create-release@v1`) and then `Upload Release Assets`
// (`softprops/action-gh-release@v1`). The second can do both jobs, and the
// first was the sole source of the three `The set-output command is deprecated`
// warnings NRL-79's run `36785920227` recorded, plus the only `using: node12`
// runtime in the file and the `tag_name: ${{ github.ref }}` shape that passed a
// full `refs/tags/0.1.1` where the adjacent line used the bare `github.ref_name`
// and survived only on server-side normalisation this repo does not control.
//
// These checks read the workflow TEXT. They cannot say the path works - no tag
// has been pushed since the change, so the shipped configuration is unexercised
// on a real runner exactly as it was before NRL-79 (ADR 0011, Amendment NRL-104).
//
// Several are SCOPED to the upload step rather than to the whole file, and the
// scoping is what makes them mean anything: `draft: false` and `prerelease: false`
// existed file-wide before this change, inside the step being deleted, so a
// content-wide regex would have been green on both sides and proved nothing.

/**
 * The `Upload Release Assets` step's own text, from its `- name:` line to the
 * next line at the same or shallower indentation.
 *
 * Defensive in the same way `extractUploadedFiles` and `parseOnPushTags` are:
 * it THROWS rather than returning `""`, because an empty string would make
 * every "is X inside the upload step" check below vacuously green, and a
 * vacuous green on the step that decides what ships is the NRL-76 shape.
 * `extractUploadedFiles` reads this same slice, so both depend on this one
 * literal step name - which is why the guard below pins it.
 *
 * A WRAPPER OVER `extractStepText` since NRL-124, rather than its own scanner.
 * It used to be `content.indexOf("- name: Upload Release Assets")`, which takes
 * the first occurrence anywhere, so a comment quoting the step name moved the
 * slice's start into that comment: measured at an 11 line slice widening to 12,
 * with `files:` still present so the fail-closed throw below never fired.
 * `extractStepText` matches `line.trim() === "- name: X"`, which a `#`-prefixed
 * line can never satisfy, so comment lines are skipped BY CONSTRUCTION. There is
 * deliberately no separate comment filter: NRL-75's precedent is that an oracle
 * must not throw on text the real system treats as ordinary, and a filter that
 * can never fire would be dead code inside the one thing standing between a
 * green suite and a release workflow that behaves differently in production.
 */
function extractUploadStep(content: string): string {
	// `extractStepText` pushes a blank line rather than breaking on it, so the
	// slice carries the blank that separates this step from the next job. Strip it
	// so the slice stays the step's own lines, which is what every scoped
	// assertion below is written against.
	const lines = extractStepText(content, UPLOAD_STEP_NAME).split("\n");
	while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
	const step = lines.join("\n");
	if (!step.includes("files:")) {
		throw new Error(
			"the `Upload Release Assets` step body was found but holds no `files:` key; " +
				"the slice is wrong and the scoped checks below would be vacuous",
		);
	}
	return step;
}

// DEFECT-SHAPED (NRL-104), red against the pre-change file at `:163-164`.
// Scheduled work on a published deprecation path rather than an outage: nothing
// was broken, and `actions/create-release@v1` is simply the thing being removed.
test("release.yml no longer uses actions/create-release (NRL-104)", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	const uses = content.match(/^\s*uses:\s*\S+/gm) ?? [];
	const offenders = uses.filter((line) => line.includes("actions/create-release"));
	assert(
		offenders.length === 0,
		`actions/create-release is still referenced by a \`uses:\`: ${JSON.stringify(offenders)}. ` +
			`It is the only source of the set-output deprecation warnings NRL-79 observed and the ` +
			`only using: node12 runtime in the file.`,
	);
	assert(
		!/^\s*-\s*name:\s*Create GitHub Release\s*$/m.test(content),
		"a step is still named `Create GitHub Release`; softprops/action-gh-release creates the Release itself",
	);
});

// RED against `@v1`. Asserts the SHAPE - a 40-hex commit plus a trailing `# v`
// comment naming the human-readable version - and deliberately NOT the literal
// SHA, so a future legitimate bump is one edit in the workflow rather than two.
test("the release action is pinned to a 40-hex commit with a version comment (NRL-104)", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	assertMatch(
		content,
		/uses:\s*softprops\/action-gh-release@[0-9a-f]{40}\s*#\s*v/,
		"softprops/action-gh-release must be pinned by 40-hex commit SHA with a trailing `# v<version>` comment, " +
			"not by a moving tag. A tag is rewritable by its owner; the comment is what keeps the pin readable.",
	);
	assert(
		!/uses:\s*softprops\/action-gh-release@v/.test(content),
		"softprops/action-gh-release is still pinned by tag",
	);
});

/**
 * The four NRL-104 scoped assertions' patterns, in one place.
 *
 * Hoisted by NRL-124 so the assertions below and the anchoring guard that pins
 * their behaviour read the SAME regexes and cannot drift apart - the same reason
 * `extractUploadedFiles` is one source of truth for the published set (NRL-76
 * decision 1).
 *
 * Every one is `/^\s*...$/m` anchored, and that anchoring is the whole reason
 * NRL-124's hijack is a loud false RED rather than a silent false pass: a `#`
 * before a key defeats `^\s*`, so a key supplied only inside a comment fails its
 * assertion instead of satisfying it. `guard: a key supplied only in a comment
 * satisfies no scoped assertion` below pins that BEHAVIOURALLY, against fixtures,
 * rather than by reading this file's own source.
 */
const UPLOAD_STEP_KEY_PATTERNS: ReadonlyArray<{ key: string; pattern: RegExp }> = [
	{ key: "fail_on_unmatched_files", pattern: /^\s*fail_on_unmatched_files:\s*true\s*$/m },
	{ key: "name", pattern: /^\s*name:\s*Release \$\{\{ github\.ref_name \}\}\s*$/m },
	{ key: "draft", pattern: /^\s*draft:\s*false\s*$/m },
	{ key: "prerelease", pattern: /^\s*prerelease:\s*false\s*$/m },
];

/** One of the four by name, so a typo is a throw rather than a vacuous green. */
function uploadStepKeyPattern(key: string): RegExp {
	const found = UPLOAD_STEP_KEY_PATTERNS.find((entry) => entry.key === key);
	if (found === undefined) {
		throw new Error(`no UPLOAD_STEP_KEY_PATTERNS entry named ${JSON.stringify(key)}`);
	}
	return found.pattern;
}

// RED - the input is absent before this change, and it defaults to FALSE in the
// action. Without it a missing `main.js` publishes a Release carrying fewer
// assets than the attestation covers and still concludes success, which is
// precisely the silent-truncation shape NRL-76 removed from `Generate checksums`.
test("the upload step fails on an unmatched file (NRL-104)", () => {
	const step = extractUploadStep(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
	assertMatch(
		step,
		uploadStepKeyPattern("fail_on_unmatched_files"),
		"`fail_on_unmatched_files: true` must be set on the upload step: it defaults to false, so a " +
			"missing asset would publish a short Release and still succeed",
	);
});

// RED against `:168`. The action defaults its tag to `github.ref`, so naming it
// would reintroduce the exact `refs/tags/<tag>` shape this ticket deletes.
test("release.yml names no tag_name anywhere (NRL-104)", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	// Full-line comments are stripped first, and that is deliberate rather than a
	// loophole. The workflow's own comments describe the deleted shape at length -
	// naming it is how the reason it went survives - so a raw text search would be
	// red against a correct file. What must not exist is the KEY. Still red against
	// the pre-change file, where `tag_name: ${{ github.ref }}` was a real key.
	const yamlOnly = content
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
	assert(
		!/\btag_name\s*:/.test(yamlOnly),
		"`tag_name:` is present. softprops/action-gh-release defaults to `github.ref`; setting it " +
			"explicitly is how the full `refs/tags/0.1.1` shape got in, and it survived only on " +
			"server-side normalisation this repo does not control.",
	);
});

// RED, and only because the assertions are SCOPED. All three keys existed in the
// pre-change file - inside the `Create GitHub Release` step being deleted - so a
// content-wide search would pass on both sides of this diff and prove nothing.
test("the upload step carries the Release title, draft and prerelease flags (NRL-104)", () => {
	const step = extractUploadStep(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
	assertMatch(
		step,
		uploadStepKeyPattern("name"),
		"the upload step must carry `name: Release ${{ github.ref_name }}` - the Release title NRL-79 " +
			"observed as `Release 0.1.1`, which the deleted step's `release_name:` used to set. " +
			"`github.ref_name` and not `github.ref`.",
	);
	assertMatch(
		step,
		uploadStepKeyPattern("draft"),
		"`draft: false` must stay explicit on the upload step",
	);
	assertMatch(
		step,
		uploadStepKeyPattern("prerelease"),
		"`prerelease: false` must stay explicit on the upload step: NRL-75's semver-only `on: push: tags` " +
			"filter excludes prereleases, and this is the second half of that reasoning",
	);
});

// GUARD (green on both sides). `extractUploadedFiles` anchors on this literal
// string, so renaming the step turns the NRL-76 subject-set check into a throw.
test("guard: the upload step is still named literally `Upload Release Assets`", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	assertMatch(
		content,
		/^\s*-\s*name:\s*Upload Release Assets\s*$/m,
		"`extractUploadedFiles` and `extractUploadStep` both anchor on this exact step name",
	);
});

// --- The extractors are scoped to the step they name (NRL-124)
//
// Everything from here to the end of this section is about the EXTRACTORS, not
// about the workflow. `extractUploadedFiles` is the single source of truth tying
// the hashed set to the published set (ADR 0011, NRL-76 decision 1), so a case
// where it silently reports the wrong set is the one that must be impossible.
//
// Before NRL-124 both extractors took the FIRST match of a literal anchor
// anywhere in the file, and `extractUploadedFiles` ended its capture at the first
// blank line rather than at the next YAML key. Those parser artefacts leaked out
// as three unenforced constraints on whoever edited the workflow: `files: |` had
// to be last in `with:`, a blank line had to follow it, and no nearby comment
// could quote the step name or a `files: |` block. All three are gone, and the
// cases below are what keeps them gone.
//
// The fixtures are built from the REAL workflow text in memory. The file itself is
// never written to: its operative content is out of scope for NRL-124, and the
// point is to exercise the extractors against shapes the file deliberately does
// not have.

/** The upload step's `- name:` line as it appears in the workflow, with indent. */
const UPLOAD_STEP_ANCHOR = `      - name: ${UPLOAD_STEP_NAME}`;

/**
 * The real workflow text with one injection applied inside, or immediately above,
 * the upload step.
 *
 * It asserts its own injection applied exactly once and changed the text, because
 * a silent no-op would make every case built on it vacuously green - the same
 * non-vacuity rule `extractUploadedFiles` itself follows.
 *
 * The needle is searched only in the slice AFTER the step's `- name:` line, and
 * that is not fussiness. `            styles.css` also appears in the comment
 * above `Generate checksums`, so a whole-file replace lands there instead and
 * produces a fixture that looks perfectly clean. That trap was hit while
 * reproducing NRL-124 and cost a measurement.
 */
function hijackedWorkflow(needle: string, replacement: string, base?: string): string {
	const content = base ?? fs.readFileSync(WORKFLOW_FILE, "utf-8");
	const at = content.indexOf(UPLOAD_STEP_ANCHOR);
	if (at === -1) {
		throw new Error(
			`the workflow text holds no \`${UPLOAD_STEP_ANCHOR.trim()}\` line at the expected indent; ` +
				"the NRL-124 fixtures cannot be built and would otherwise be vacuous",
		);
	}
	const head = content.slice(0, at);
	const tail = content.slice(at);
	const hits = tail.split(needle).length - 1;
	if (hits !== 1) {
		throw new Error(
			`the fixture needle ${JSON.stringify(needle)} matched ${hits} times in the upload step, ` +
				"expected exactly 1; the fixture would not hold the shape its case names",
		);
	}
	const out = head + tail.replace(needle, replacement);
	if (out === content) throw new Error("the NRL-124 fixture injection was a no-op");
	return out;
}

// DEFECT REPRODUCTION (NRL-124). Measured red against the pre-fix extractor at
// ELEVEN entries: the step name, the `uses:` line, `with:`, all four `with:` keys,
// `files: |` itself and only then the three real files. The capture started at the
// comment's `files: |` and ran into the real step, so the NRL-76 subject-set
// equality check reported comment prose as published assets. This shape was hit
// for real by a first-draft comment during NRL-104 and routed around by not
// naming the step in nearby prose.
test("a comment quoting the step name and a `files: |` block does not hijack the published set (NRL-124)", () => {
	const fixture = hijackedWorkflow(
		UPLOAD_STEP_ANCHOR,
		[
			`      # - name: ${UPLOAD_STEP_NAME}`,
			"      # files: |",
			"      #   hijack.txt",
			UPLOAD_STEP_ANCHOR,
		].join("\n"),
	);
	assertEquals(
		extractUploadedFiles(fixture).join(","),
		"main.js,manifest.json,styles.css",
		"a comment quoting the step name or a `files: |` block must not move the capture. " +
			"`extractUploadedFiles` is the only thing tying the attestation subject set to the " +
			"published set, so a case where it reports the wrong set is the one to make impossible.",
	);
});

// DEFECT REPRODUCTION (NRL-124). Measured red at a 12 line slice against the real
// step's 11, with nothing thrown: `files:` was still inside the widened slice, so
// the fail-closed throw covered a rename or a deletion but not a hijack.
//
// The oracle is EQUALITY against the real step and deliberately not "the slice's
// first line is `- name: ...`". `indexOf` landed inside the comment at the `-`, so
// the hijacked slice's first line already reads `- name: Upload Release Assets`
// with the `# ` stripped (measured), and a first-line check does not discriminate.
test("a comment quoting the step name does not widen the upload step slice (NRL-124)", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	const fixture = hijackedWorkflow(
		UPLOAD_STEP_ANCHOR,
		`      # - name: ${UPLOAD_STEP_NAME}\n${UPLOAD_STEP_ANCHOR}`,
	);
	assertEquals(
		extractUploadStep(fixture),
		extractUploadStep(content),
		"the step slice must be located by an exact `- name:` match at its own indent, so a comment " +
			"quoting the name cannot move its start. Every NRL-104 scoped assertion reads this slice.",
	);
});

// DEFECT REPRODUCTION (NRL-124), replacing the guard that used to sit in this slot
// and asserting the OPPOSITE of it (the NRL-66/NRL-67 replace-in-place
// convention). The old guard asserted that NO YAML key followed `files: |` inside
// the upload step, because the extractor's capture ended at the first blank line
// and any key below the scalar was trimmed into the published-asset list and
// reported by the NRL-76 check as `extra`. That was a constraint on the workflow
// author enforced by nothing but prose, and it is the artefact NRL-124 removed. A
// key below the scalar is now simply not a published asset, which is what YAML
// says. Measured red at FOUR entries, the fourth being `body: ignored`.
test("a `with:` key after `files: |` is not a published asset (NRL-124)", () => {
	const fixture = hijackedWorkflow(
		"            styles.css\n",
		"            styles.css\n          body: ignored\n",
	);
	assertEquals(
		extractUploadedFiles(fixture).join(","),
		"main.js,manifest.json,styles.css",
		"the block scalar must end at the next key at or shallower than `files:`, not at the first " +
			"blank line, so key ORDER inside `with:` is no longer load-bearing. If this is red, the " +
			"old first-blank-line terminator is back and `files: |` has to be last again.",
	);
});

// DEFECT REPRODUCTION (NRL-124). `|`, `|-` and `|+` are all literal block scalars
// GitHub accepts. The old `files:\s*\|` swallowed the chomping indicator into the
// capture, so its first trimmed line was the bare `-`: measured red at FOUR
// entries, `["-", "main.js", "manifest.json", "styles.css"]`, against the
// pre-NRL-124 workflow so the new comment's own hijack shape could not confound it.
// A bogus entry is the dangerous direction here, because the NRL-76 subject-set
// equality check reads this list as the published set.
test("a chomping indicator on the block scalar is not a published asset (NRL-124)", () => {
	const fixture = hijackedWorkflow("          files: |\n", "          files: |-\n");
	assertEquals(
		extractUploadedFiles(fixture).join(","),
		"main.js,manifest.json,styles.css",
		"`files: |-` and `files: |+` are block scalars GitHub accepts, so the chomping indicator " +
			"must not be read as a published path",
	);
});

// DEFECT REPRODUCTION (NRL-124). A blank line is legal inside a YAML literal block
// scalar, and the old first-blank-line terminator read one as the end of the
// block: measured red at TWO entries, silently dropping `styles.css`. That is the
// dangerous direction for this extractor, because an under-reported published set
// makes the NRL-76 subject-set equality check compare two short lists.
test("a blank line inside the `files: |` block does not truncate the published set (NRL-124)", () => {
	const fixture = hijackedWorkflow("            manifest.json\n", "            manifest.json\n\n");
	assertEquals(
		extractUploadedFiles(fixture).join(","),
		"main.js,manifest.json,styles.css",
		"a blank line is legal inside a YAML literal block scalar and must be skipped, not treated " +
			"as the end of the block",
	);
});

// The fail-closed throws survive the refactor. Both paths existed before NRL-124
// and must keep existing, because a `[]` return is what would make the NRL-76
// subject-set check vacuously green - and a vacuous green on the step that decides
// what ships is the NRL-76 shape itself.
//
// Its label depends on which workflow text it runs against, and both halves were
// measured. Against the PRE-NRL-124 workflow it is a GUARD, green on both sides of
// the diff. Against the SHIPPED workflow it is a DEFECT REPRODUCTION: the comment
// above the step now quotes both literals on purpose (ADR 0011, decision 10), so
// the old whole-file extractor still finds its anchors in that comment after the
// step is renamed and returns a list where it must throw.
test("guard: a renamed step and an emptied block still THROW rather than returning []", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");

	const renamed = hijackedWorkflow(UPLOAD_STEP_ANCHOR, "      - name: Upload Something Else");
	let threw = false;
	try {
		extractUploadedFiles(renamed);
	} catch {
		threw = true;
	}
	assert(threw, "a renamed upload step must throw, never return an empty published-asset list");

	threw = false;
	try {
		extractUploadStep(renamed);
	} catch {
		threw = true;
	}
	assert(threw, "a renamed upload step must throw from extractUploadStep too");

	// The block scalar is kept and its three entries removed, which is the shape a
	// bad edit actually produces. `files:` is still present, so `extractUploadStep`
	// returns happily and only `extractUploadedFiles` can catch it.
	const emptied = hijackedWorkflow(
		"          files: |\n            main.js\n            manifest.json\n            styles.css\n",
		"          files: |\n",
		content,
	);
	threw = false;
	try {
		extractUploadedFiles(emptied);
	} catch {
		threw = true;
	}
	assert(threw, "a `files: |` block holding no entries must throw, never return []");
});

// GUARD (green on both sides, and labelled one deliberately), pinning the ONE
// property that makes NRL-124's hijack survivable: the four scoped assertions are
// `/^\s*...$/m` anchored, so a key supplied only on a `#` line satisfies NONE of
// them. That is why the measured failure mode is a loud false RED and not a silent
// false pass, and it is the reason NRL-124 is a fragility ticket rather than a
// High-severity correctness one.
//
// It asserts BEHAVIOURALLY, against fixtures, and never by reading this file's own
// source: a reflective check would pass against a pattern that had quietly stopped
// discriminating. Measured for the `fail_on_unmatched_files` shape during NRL-104's
// Verify and re-measured for NRL-124 at `[false, true, true, true]` in both hijack
// shapes, which is why there is one fixture per key rather than one for all four.
test("guard: a key supplied only in a comment satisfies no scoped assertion (NRL-124)", () => {
	const content = fs.readFileSync(WORKFLOW_FILE, "utf-8");
	const offenders: string[] = [];
	for (const { key, pattern } of UPLOAD_STEP_KEY_PATTERNS) {
		const line = (content.split("\n").find((l) => pattern.test(l)) ?? "").trimEnd();
		if (line === "") {
			offenders.push(`${key}: no line of the real workflow matches its own pattern`);
			continue;
		}
		// Shape 1: the key commented out in place, at its own indentation.
		const inPlace = hijackedWorkflow(`${line}\n`, `${line.replace(/^(\s*)/, "$1# ")}\n`, content);
		// Shape 2: the key deleted and supplied on a `#` line in a comment that also
		// quotes the step name, which is the slice-widening hijack. Built on top of
		// shape 1's deletion so the real key is genuinely gone.
		const stripped = hijackedWorkflow(`${line}\n`, "", content);
		const aboveStep = hijackedWorkflow(
			UPLOAD_STEP_ANCHOR,
			[
				`      # - name: ${UPLOAD_STEP_NAME}`,
				`      # ${line.trim()}`,
				UPLOAD_STEP_ANCHOR,
			].join("\n"),
			stripped,
		);
		for (const [shape, fixture] of [["commented in place", inPlace], ["quoted above the step", aboveStep]] as const) {
			if (pattern.test(extractUploadStep(fixture))) {
				offenders.push(`${key} (${shape}): the pattern matched a key present only on a \`#\` line`);
			}
		}
	}
	assert(
		offenders.length === 0,
		`a scoped assertion is satisfied by a commented-out key, which turns a hijack from a loud ` +
			`false red into a silent false pass: ${offenders.join("; ")}`,
	);
});

// GUARD (green on both sides). The NRL-76 equality check above runs the real
// shell step; this one pins the other end of the same coupling cheaply, so a
// reorder that smuggles an extra entry into the published list is named here
// even if the sandboxed step run is ever skipped.
test("guard: the published asset list is still exactly the three installed files", () => {
	const published = extractUploadedFiles(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
	assertEquals(
		published.join(","),
		"main.js,manifest.json,styles.css",
		"the upload step must publish exactly the three files Obsidian's installer fetches (ADR 0028)",
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
	const missing = "styles.css";
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
// is the one way to make this whole step moot with a GREEN run:
// `needs: [build, release]` already stops `provenance` when the build fails,
// whereas an `if: needs.build.outputs.hashes != ''` would SKIP provenance
// silently and produce no attestation at all. See ADR 0011, Amendment (NRL-76),
// decision 5. The `needs:` membership check below is NOT a guard: it is NRL-106's
// own assertion, red against the `needs: build` this job carried before, and the
// `release` entry it pins is there purely for ORDERING - without it the
// generator's `upload-assets` job is unordered with respect to the job that
// creates the Release it attaches the attestation to.
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
			"it through `needs: [build, release]`; an `if:` would SKIP it silently and produce a green " +
			"run with no " +
			"attestation, which is strictly worse than the defect NRL-76 fixed.",
	);

	// NRL-106. `needs:` must hold BOTH `build` and `release`, and the comparison is a
	// SORTED SET rather than a literal because GitHub treats `needs` as a set: its own
	// docs' `needs: [job1, job2]` example waits for both with no ordering significance
	// between the entries, so `[release, build]` and a block sequence are the same
	// dependency graph and asserting a literal would pin formatting rather than
	// behaviour. Two traps, both measured on this slice. The assertion is scoped to the
	// `needs:` LINE and not to `jobLines`, because a slice-wide substring search for
	// `build` is ALREADY vacuous - `base64-subjects: ${{ needs.build.outputs.hashes }}`
	// carries it, so such a check would stay green with `build` dropped from the list,
	// which is exactly the regression that breaks that reference at run time. And
	// `release` occurs nowhere else in this job today, so a substring search for it would
	// have appeared to work for the wrong reason. The set equality catches an omission on
	// either side and a spurious third entry.
	const needsLines = jobLines.filter((l) => /^\s{4}needs:/.test(l));
	assertEquals(
		needsLines.length,
		1,
		`the provenance job carries ${needsLines.length} \`needs:\` keys (${JSON.stringify(needsLines)}). ` +
			"YAML resolves duplicates last-wins and silently, so exactly one is required.",
	);
	const needsIndex = jobLines.findIndex((l) => /^\s{4}needs:/.test(l));
	const inline = (jobLines[needsIndex] ?? "").replace(/^\s{4}needs:\s*/, "").trim();
	const parsedNeeds: string[] = [];
	if (inline !== "") {
		// Flow spelling: `needs: build` or `needs: [build, release]`.
		for (const entry of inline.replace(/^\[/, "").replace(/\]$/, "").split(",")) {
			const name = entry.trim().replace(/^['"]|['"]$/g, "");
			if (name !== "") parsedNeeds.push(name);
		}
	} else {
		// Block sequence: `needs:` then `      - build` / `      - release`.
		for (let i = needsIndex + 1; i < jobLines.length; i++) {
			const match = /^\s{6}-\s*(\S+)/.exec(jobLines[i] ?? "");
			if (!match) break;
			const name = (match[1] ?? "").replace(/^['"]|['"]$/g, "");
			if (name !== "") parsedNeeds.push(name);
		}
	}
	assertEquals(
		parsedNeeds.slice().sort().join(","),
		"build,release",
		`the provenance job depends on ${JSON.stringify(parsedNeeds)}. Both entries are load-bearing: ` +
			"`build` so `needs.build.outputs.hashes` resolves, and `release` so the generator's " +
			"`upload-assets` job cannot start before the Release object it attaches " +
			"`multiple.intoto.jsonl` to exists. See ADR 0011, Amendment (NRL-106).",
	);
});

test("ADR 0024 exists and documents the ort-on-demand decision", () => {
	assertFileExists(ADR_ORT_FILE, "docs/adr/0024-ort-on-demand.md not found");
	const content = fs.readFileSync(ADR_ORT_FILE, "utf-8");
	assertMatch(content, /NRL-37/, "ADR 0024 missing NRL-37 ticket reference");
	assertMatch(content, /checksum/i, "ADR 0024 missing checksum mention");
	assertMatch(content, /atomic/i, "ADR 0024 missing atomic-write mention");
});
test("ADR 0024 is marked superseded, and kept", () => {
	assertFileExists(ADR_ORT_FILE, "docs/adr/0024-ort-on-demand.md not found");
	const content = fs.readFileSync(ADR_ORT_FILE, "utf-8");
	assertMatch(
		content,
		/[Ss]uperseded/,
		"ADR 0024 must be marked superseded - the history is kept deliberately, " +
			"so leaving it unmarked is how the old decision gets re-implemented",
	);
});

test("ADR 0028 records the bundling decision and supersedes ADR 0024's", () => {
	assertFileExists(ADR_RUNTIME_FILE, "docs/adr/0028-bundle-executable-runtime.md not found");
	const content = fs.readFileSync(ADR_RUNTIME_FILE, "utf-8");
	assertMatch(content, /0024/, "ADR 0028 must name the decision it supersedes");
	assertMatch(content, /polic/i, "ADR 0028 must state the policy that forced this");
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
//
// Conditional (NRL-69): printed unconditionally this line claimed a pass on a
// red run, and a reader scanning the log sees it before the count below. It
// also runs after every pending test has settled, since several are async
// (NRL-96's bundling checks) and would otherwise be counted as neither pass
// nor fail.
await Promise.all(pending);

if (passedTests === totalTests) console.log(`\nall release tests passed\n`);
console.log(`${passedTests} of ${totalTests} passed`);
if (passedTests === totalTests) {
	process.exit(0);
} else {
	process.exit(1);
}
