import { build } from "esbuild";
import process from "process";
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import builtins from "builtin-modules";

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
 * Two bundles, on purpose.
 *
 * `main.js` runs in Electron on desktop and in a WebView on mobile, so it must
 * not reference anything that only exists in a desktop runtime. The Kokoro
 * worker pulls in transformers.js and onnxruntime-web, which assume a real
 * browser and are far too large for the main bundle, so they are built
 * separately with a browser target and loaded as a worker.
 */
const mainConfig = {
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
	define: {
		// transformers.js branches on this to pick a browser or node build.
		"process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
	},
};

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
 * Ship the ONNX runtime's WASM binary alongside the plugin.
 *
 * Left to itself, onnxruntime-web resolves its `.wasm` from a jsdelivr CDN URL
 * the first time a session is created. That would mean the plugin reaches the
 * network on every cold start, and would fail outright on a phone that is
 * offline. Copying the binary in and pointing `wasmPaths` at the plugin folder
 * keeps the whole inference stack on-device.
 */
const ORT_DIST = ortDistDir();
const ORT_FILES = [
	"ort-wasm-simd-threaded.mjs",
	"ort-wasm-simd-threaded.wasm",
	"ort-wasm-simd-threaded.jsep.mjs",
	"ort-wasm-simd-threaded.jsep.wasm",
];

async function copyOrtRuntime() {
	const dest = "ort";
	await mkdir(dest, { recursive: true });
	for (const file of ORT_FILES) {
		await copyFile(path.join(ORT_DIST, "dist", file), path.join(dest, file));
	}
}

if (production) {
	await build(mainConfig);
	await build(workerConfig);
	await copyOrtRuntime();
} else {
	const ctx = await (await import("esbuild")).context(mainConfig);
	await ctx.watch();
	const workerCtx = await (await import("esbuild")).context(workerConfig);
	await workerCtx.watch();
	await copyOrtRuntime();
}
