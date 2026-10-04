import { build } from "esbuild";
import process from "process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import builtins from "builtin-modules";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const production = process.argv[2] === "production";

/**
 * Locate onnxruntime-web's dist directory.
 *
 * The package's `exports` map does not expose package.json, so resolve the
 * published entry point and walk up instead of asking for the manifest.
 */
function ortDistDir() {
	const entry = require.resolve("onnxruntime-web");
	return path.join(path.dirname(entry), "..");
}

const banner = `/*
Local TTS Reader - on-device text-to-speech for Obsidian.
Independent implementation; no code derived from any other plugin.
*/`;

/**
 * Build configuration for main.js.
 *
 * The Kokoro worker code is inlined into main.js as base64 at build time, and
 * the ORT runtime is packed in the same pass, so the installer download is the
 * three files Obsidian's installer fetches and nothing more.
 * inlineWorkerIntoMain() runs after the worker is built.
 */
function createMainConfig(ortAssets = null) {
	const define = {
		// transformers.js branches on this to pick a browser or node build.
		"process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
	};

	// Unconditional, and deliberately so. A packed-asset path that only
	// existed in production would be a path nobody develops against, and the
	// three-file install is the only shape that reaches a user - so dev carries
	// the same bytes rather than a cheaper stand-in.
	if (ortAssets) {
		define["__ORT_ASSETS__"] = JSON.stringify(ortAssets);
	}

	return {
		banner: { js: banner },
		entryPoints: ["src/main.ts"],
		outfile: "main.js",
		bundle: true,
		format: "cjs",
		platform: "node",
		target: "es2022",
		external: [
			"obsidian",
			"electron",
			"@codemirror/autocomplete",
			"@codemirror/collab",
			"@codemirror/commands",
			"@codemirror/language",
			"@codemirror/lint",
			"@codemirror/search",
			"@codemirror/state",
			"@codemirror/view",
			"@lezer/common",
			"@lezer/highlight",
			"@lezer/lr",
			...builtins,
		],
		logLevel: "info",
		sourcemap: production ? false : "inline",
		treeShaking: true,
		minify: production,
		define,
	};
}

const workerConfig = {
	banner: { js: banner },
	entryPoints: ["src/engines/onnx/kokoro.worker.ts"],
	outfile: "kokoro-worker.js",
	bundle: true,
	// A classic worker script, not an ES module: Android WebView support for
	// module workers is uneven, and a classic script has no such caveat.
	format: "iife",
	platform: "browser",
	target: "es2022",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	minify: production,
	define: {
		"process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
	},
};

/**
 * The ORT runtime's WASM and glue files, packed into main.js.
 *
 * Left to itself, onnxruntime-web resolves its `.wasm` from a jsdelivr CDN URL
 * the first time a session is created. That would mean the plugin reaches the
 * network on every cold start, and would fail outright on a phone that is
 * offline. ADR 0028 settles the alternative: it cannot be shipped as a
 * side-directory, because the three-file install has no side-directory, and it
 * cannot be fetched on demand, because the plugin review guidelines treat that
 * as executable dependency management. So it goes into the bundle.
 *
 * The list is not trimmed per platform. A build whose shipped bytes depended on
 * the build machine would make the release unreproducible and the SLSA
 * attestation meaningless, and a smaller-JSEP-build follow-up is a measured
 * question, not a build-time guess.
 */
const ORT_DIST = ortDistDir();
const ORT_FILES = [
	"ort-wasm-simd-threaded.mjs",
	"ort-wasm-simd-threaded.wasm",
	"ort-wasm-simd-threaded.jsep.mjs",
	"ort-wasm-simd-threaded.jsep.wasm",
];

/**
 * Gzip and base64 each ORT dist file for injection into main.js.
 *
 * One read per file, serving both the digest and the payload, so the bytes
 * that are hashed and the bytes that ship cannot come from two reads of a file
 * that changed underneath the build.
 *
 * Level 9 because these are already-compressed-ish WASM blobs that never
 * compress further, and the whole point is that the embedded copy is paid for
 * by every install (ADR 0028). The digest stays of the *plain* bytes, so a
 * decompression bug cannot pass verification by agreeing with itself.
 */
async function packOrtAssets() {
	const assets = {};
	for (const file of ORT_FILES) {
		const bytes = await readFile(path.join(ORT_DIST, "dist", file));
		assets[file] = {
			gzip: gzipSync(bytes, { level: 9 }).toString("base64"),
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	}
	return assets;
}

/**
 * Embed the worker script in main.js by reading the built kokoro-worker.js
 * and injecting it as a base64-encoded constant.
 */
async function inlineWorkerIntoMain() {
	const workerCode = await readFile("kokoro-worker.js", "utf8");
	const workerBase64 = Buffer.from(workerCode).toString("base64");
	const mainCode = await readFile("main.js", "utf8");

	// Inject the inlined worker code at the start of the main.js file,
	// just after the banner comment and before any other code.
	//
	// This must assign to globalThis, not declare a bare `var`. esbuild's
	// "cjs" output format wraps the whole bundle in a module function so
	// Obsidian's loader can hand it its own module/exports/require, and a
	// top-level `var` is scoped to that wrapper, not to the real global
	// object - identical to how a `var` at the top of any Node CommonJS file
	// never becomes a property of `global`. kokoro.ts's getWorkerBlobUrl()
	// reads `globalThis.KOKORO_WORKER_CODE`, so a bare `var` here left that
	// permanently undefined in every production build, on every platform,
	// which silently fell through to the file-based fallback path reading
	// `kokoro-worker.js` - the exact file this function deletes three lines
	// down. Kokoro could not load in any built (non-dev-watch) install until
	// this was a real global assignment. Confirmed live on a real Android
	// device (NRL-60): before this fix, `typeof globalThis.KOKORO_WORKER_CODE`
	// was "undefined" in a running plugin instance and Kokoro failed with
	// "File does not exist"; after, the worker loads.
	const injection = `
// Inlined Kokoro worker code (base64-encoded)
globalThis.KOKORO_WORKER_CODE = "${workerBase64}";
`;

	const injected = mainCode.replace(
		/(\*\/\n)/,
		`$1${injection}`,
	);

	await writeFile("main.js", injected, "utf8");

	// Remove the separate worker file since it is now inlined
	try {
		await rm("kokoro-worker.js");
	} catch {
		// File may not exist in dev mode
	}
}

/**
 * Append THIRD_PARTY_NOTICES.md to main.js as one trailing comment.
 *
 * main.js is the only code file Obsidian installs, and it carries
 * Apache-2.0, MIT and GPL-3.0 code (kokoro-js, transformers.js, phonemizer's
 * eSpeak NG build, ONNX Runtime) whose licenses require the notice to travel
 * with every copy. None of those packages ship license comments of their own
 * that survive minification, so without this the bundle carried none at all.
 * A comment terminator in the notices would end the comment early and turn license
 * text into code, so that is refused rather than escaped.
 */
async function appendThirdPartyNotices() {
	const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
	if (notices.includes("*/")) {
		throw new Error("THIRD_PARTY_NOTICES.md must not contain a comment terminator");
	}
	const mainCode = await readFile("main.js", "utf8");
	await writeFile("main.js", `${mainCode}\n/*!\n${notices}*/\n`, "utf8");
}

if (production) {
	// Read the published ORT files and pack them in. No weights are fetched at
	// any point: only what is already in node_modules.
	const mainConfig = createMainConfig(await packOrtAssets());
	await build(mainConfig);
	await build(workerConfig);
	await inlineWorkerIntoMain();
	await appendThirdPartyNotices();
} else {
	// Development carries the same packed assets as production on purpose. If
	// dev read the files from disk instead, a load path broken only in the
	// packed form would stay invisible until release, and the three-file
	// install never has those files beside it anyway - so that is the only
	// shape worth developing.
	const mainConfig = createMainConfig(await packOrtAssets());
	const ctx = await (await import("esbuild")).context(mainConfig);
	await ctx.watch();
	const workerCtx = await (await import("esbuild")).context(workerConfig);
	await workerCtx.watch();
}
