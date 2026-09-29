import { build } from "esbuild";
import process from "process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import builtins from "builtin-modules";
import { createHash } from "node:crypto";

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

/**
 * Compute SHA-256 checksums of ORT runtime files at build time.
 * Read-only in the bundle: used to validate file integrity on load.
 * Non-negotiable (NRL-16 ADR 0011): no model weights downloaded during build.
 */
async function computeOrtChecksums(ortFiles) {
	const checksums = {};
	const ortDist = ortDistDir();
	for (const file of ortFiles) {
		const filePath = path.join(ortDist, "dist", file);
		try {
			const data = await readFile(filePath);
			const hash = createHash("sha256").update(data).digest("hex");
			checksums[file] = hash;
		} catch (err) {
			console.error(`Failed to compute checksum for ${file}:`, err.message);
			throw err;
		}
	}
	return checksums;
}

const banner = `/*
Local TTS Reader - on-device text-to-speech for Obsidian.
Independent implementation; no code derived from any other plugin.
*/`;

/**
 * Build configuration for main.js.
 * ORT checksums are injected at build time (production only) for runtime validation.
 * Non-negotiable: checksums are read-only, never modified after build.
 */
function createMainConfig(ortChecksums = null) {
	const define = {
		// transformers.js branches on this to pick a browser or node build.
		"process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
	};

	// Inject ORT checksums at build time for production builds.
	// Checksums are read-only in the bundle and validated on load (src/main.ts).
	if (production && ortChecksums) {
		define["__ORT_CHECKSUMS__"] = JSON.stringify(ortChecksums);
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
	// Compute ORT checksums at build time for runtime validation.
	// Non-negotiable: no model weights downloaded, only published ORT files.
	const ortChecksums = await computeOrtChecksums(ORT_FILES);
	const mainConfig = createMainConfig(ortChecksums);
	await build(mainConfig);
	await build(workerConfig);
	await copyOrtRuntime();
} else {
	const mainConfig = createMainConfig();
	const ctx = await (await import("esbuild")).context(mainConfig);
	await ctx.watch();
	const workerCtx = await (await import("esbuild")).context(workerConfig);
	await workerCtx.watch();
	await copyOrtRuntime();
}
