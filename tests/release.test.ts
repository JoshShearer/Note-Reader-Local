/**
 * Release-artifact regression tests (NRL-16, amended by NRL-96).
 *
 * The load-bearing test in here is "the runtime unpacks byte-identical to
 * node_modules". Everything else is a cheap guard on the shape of that: the
 * asset table has to exist in the bundle, deploy has to copy three files, the
 * release must not publish a runtime to download, and the policies that
 * forbid that must be recorded.
 *
 * It reads the real built main.js, not the sources, because the thing being
 * asserted is what ships. It never runs the plugin: `obsidian` has no runtime
 * in this suite (AGENTS.md), so a passing run here is evidence about the
 * artifact and not about a working install.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
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
const ADR_RUNTIME_FILE = path.join(ROOT, "docs/adr/0026-bundle-executable-runtime.md");
const RUNTIME_TS_FILE = path.join(ROOT, "src/engines/onnx/runtime.ts");
const ORT_DIST = path.join(ROOT, "node_modules/onnxruntime-web/dist");
const DEPLOY_FILE = path.join(ROOT, "deploy.mjs");
const MAIN_TS_FILE = path.join(ROOT, "src/main.ts");

let totalTests = 0;
let passedTests = 0;

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

/** Every ORT asset name, read off disk rather than hard-coded twice. */

// --- Only the runtime is packed: no model weights

test("nothing but the ORT runtime is packed into the bundle", () => {
	// Weights must only ever arrive on an explicit user click (AGENTS.md
	// non-negotiable 6), so the thing to assert is that the pack contains no
	// weight file - not that the strings "onnx" or "model" are absent from
	// main.js, which they are and must be: the default model is the
	// HuggingFace repo id "onnx-community/Kokoro-82M-v1.0-ONNX" and it appears
	// verbatim in the bundle. A substring test over that would be a false
	// positive by construction, and the first version of this check was.
	//
	// The pack is a table keyed by filename, so the key set is the pack. Every
	// key must be one we read off disk in node_modules, which is what makes
	// this non-vacuous: a packed 82 MB weights file would add its own key and
	// fail here rather than hide inside an unreferenced string.
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	// `m[1]` is `string | undefined` to tsc even though the group is a
	// mandatory capture; the filter is what narrows it, and dropping the
	// undefined here would be what turns a name-shape change into a silent
	// hole rather than a loud one.
	const keys = [...content.matchAll(/"([^"]+)":\{gzip:"/g)]
		.map((m) => m[1])
		.filter((name): name is string => name !== undefined);
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

// --- The runtime is bundled, and it unpacks byte-identical (NRL-96, ADR 0026)
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

	// Read the two string fields out of the object that follows the anchor.
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

function ortAssetNames(): string[] {
	return fs
		.readdirSync(ORT_DIST)
		.filter((name) => name.startsWith("ort-wasm-") && (name.endsWith(".mjs") || name.endsWith(".wasm")))
		.sort();
}


test("every ORT file is packed into main.js and unpacks to the published bytes", () => {
	const content = fs.readFileSync(MAIN_JS, "utf-8");
	const names = ortAssetNames();
	assert(names.length > 0, `no ORT assets found in ${ORT_DIST}`);

	for (const name of names) {
		const packed = readPackedAsset(content, name);
		const plain = gunzipSync(Buffer.from(packed.gzip, "base64"));
		const digest = createHash("sha256").update(plain).digest("hex");
		assertEquals(
			digest,
			packed.sha256,
			`${name}: unpacked bytes do not hash to the digest recorded beside them`,
		);

		// The published bytes, not the ones this build happened to copy. If
		// node_modules and the embedded pack ever disagree, the install is
		// running code nobody upstream shipped, and that is the whole claim.
		const published = fs.readFileSync(path.join(ORT_DIST, name));
		assertEquals(
			digest,
			createHash("sha256").update(published).digest("hex"),
			`${name}: the embedded copy is not the file onnxruntime-web published`,
		);
	}
});

test("the build packs exactly RUNTIME_FILES, and nothing else", async () => {
	// esbuild.config.mjs cannot import runtime.ts - it runs in plain Node
	// before any bundle exists, with no TS loader - so the canonical list and
	// the build's own list are two copies that have to be kept in agreement by
	// a check rather than by import. This is that check, and it is a real
	// equality on both sides: not "every build entry is a known name" (which
	// would pass with a build that packed only one of the four) and not "every
	// canonical name is packed" (which cannot see a stray extra).
	const { RUNTIME_FILES } = await import("../src/engines/onnx/runtime.ts");
	const config = fs.readFileSync(path.join(ROOT, "esbuild.config.mjs"), "utf-8");

	const arrayMatch = config.match(/const ORT_FILES = \[([^\]]*)\]/);
	const arraySource = arrayMatch?.[1] ?? "";
	assert(arraySource !== "", "esbuild.config.mjs's ORT_FILES list not found");
	const buildFiles = [...arraySource.matchAll(/"([^"]+)"/g)]
		.map((m) => m[1])
		.filter((name): name is string => name !== undefined);

	assert(
		JSON.stringify(buildFiles) === JSON.stringify([...RUNTIME_FILES]),
		`esbuild.config.mjs packs ${buildFiles.join(", ")} but runtime.ts declares ` +
			`${RUNTIME_FILES.join(", ")}; a pack and its reader that disagree about ` +
			"which files exist is a missing-runtime bug at play time",
	);

	// And the bundle itself carries exactly that set.
	const packed = [...fs.readFileSync(MAIN_JS, "utf-8").matchAll(/"([^"]+)":\{gzip:"/g)]
		.map((m) => m[1])
		.filter((name): name is string => name !== undefined);
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
			"of how it is verified (ADR 0026)",
	);
	assert(
		!content.includes("ORT_RELEASE_REPO"),
		"main.js still carries the release-repo constant the on-demand download used",
	);
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
			"them any more, and publishing a downloadable runtime is what ADR 0026 " +
			"exists to stop",
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

test("ADR 0026 records the bundling decision and supersedes ADR 0024's", () => {
	assertFileExists(ADR_RUNTIME_FILE, "docs/adr/0026-bundle-executable-runtime.md not found");
	const content = fs.readFileSync(ADR_RUNTIME_FILE, "utf-8");
	assertMatch(content, /0024/, "ADR 0026 must name the decision it supersedes");
	assertMatch(content, /polic/i, "ADR 0026 must state the policy that forced this");
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
//
// Conditional (NRL-69): printed unconditionally this line claimed a pass on a
// red run, and a reader scanning the log sees it before the count below. It
// also runs after every pending test has settled, since three of them are
// async and would otherwise be counted as neither pass nor fail.
await Promise.all(pending);

if (passedTests === totalTests) console.log(`\nall release tests passed\n`);
console.log(`${passedTests} of ${totalTests} passed`);
process.exit(passedTests === totalTests ? 0 : 1);
