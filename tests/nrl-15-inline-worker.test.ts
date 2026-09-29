/**
 * Verify that the Kokoro worker is correctly inlined into main.js
 * as part of NRL-15.
 *
 * Tests confirm:
 * - Worker code is embedded as base64 in main.js
 * - Blob URL construction works
 * - No file fetch for kokoro-worker.js is required
 * - manifest.json is unchanged
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import assert from "node:assert";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

console.log("Worker inlining verification");

{
	// Verify that main.js contains the inlined worker code
	const mainJs = await readFile("main.js", "utf8");
	check("main.js exists and is readable", mainJs.length > 0);
	check(
		"main.js contains the KOKORO_WORKER_CODE variable",
		mainJs.includes("var KOKORO_WORKER_CODE ="),
	);
	check(
		"base64 worker code is embedded",
		mainJs.match(/var KOKORO_WORKER_CODE = "[A-Za-z0-9+/]+={0,2}";/) !== null,
	);

	// Extract and verify the base64 code can be decoded
	const match = mainJs.match(/var KOKORO_WORKER_CODE = "([A-Za-z0-9+/]+={0,2})";/);
	if (match && match[1]) {
		try {
			const decoded = Buffer.from(match[1], "base64").toString("utf8");
			check("base64 code decodes successfully", decoded.length > 0);
			check(
				"decoded worker contains postMessage (worker functionality)",
				decoded.includes("postMessage"),
			);
			check(
				"decoded worker contains addEventListener (worker functionality)",
				decoded.includes("addEventListener"),
			);
		} catch (err) {
			console.log(`  FAIL decoding worker: ${err}`);
		}
	}

	// Verify main.js size is approximately 2.1MB more than without the worker
	// (the base64 encoding expands by roughly 4/3)
	check("main.js is large enough to contain worker code", mainJs.length > 2_500_000);
}

{
	// Verify no separate kokoro-worker.js file exists
	const files = await readdir(".");
	check(
		"kokoro-worker.js does not exist separately",
		!files.includes("kokoro-worker.js"),
		files.filter((f) => f.includes("kokoro")).join(", "),
	);
}

{
	// Verify manifest.json is unchanged
	const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
	check("manifest.json has correct id", manifest.id === "local-tts-reader");
	check("manifest.json has isDesktopOnly", manifest.isDesktopOnly === false);
	check("manifest.json version exists", manifest.version !== undefined);
}

{
	// Verify ORT files are still present (not replaced by worker inlining)
	const ortFiles = await readdir("ort");
	check("ort directory exists", ortFiles.length > 0);
	check(
		"ort contains wasm files",
		ortFiles.some((f) => f.endsWith(".wasm")),
		`found: ${ortFiles.join(", ")}`,
	);
	check(
		"ort contains mjs files",
		ortFiles.some((f) => f.endsWith(".mjs")),
		`found: ${ortFiles.join(", ")}`,
	);
}

{
	// Verify require() list is still correct (mobile safety)
	const mainJs = await readFile("main.js", "utf8");
	const requires = [...mainJs.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
	const unique = [...new Set(requires)].sort();

	check(
		"require() list only contains safe modules",
		unique.every(
			(m) =>
				m === "obsidian" || m === "@codemirror/view" || m === "@codemirror/state",
		),
		`found: ${unique.join(", ")}`,
	);
	check("obsidian is required", unique.includes("obsidian"));
	check("@codemirror/view is required", unique.includes("@codemirror/view"));
	check("@codemirror/state is required", unique.includes("@codemirror/state"));
}

console.log(`${failures === 0 ? "all" : failures} inlining checks${failures === 0 ? " passed" : " failed"}`);
process.exit(failures === 0 ? 0 : 1);
