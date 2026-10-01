import { build } from "esbuild";
import process from "process";
import builtins from "builtin-modules";

/**
 * Bundle the test files so node runs plain JS.
 *
 * node's type stripping cannot handle parameter properties or enums, which the
 * source uses freely, so tests go through esbuild like everything else.
 */
const entries = process.argv.slice(2);

if (entries.length === 0) {
	console.error("usage: build-tests.mjs <entry.ts> [...]");
	process.exit(1);
}

await build({
	entryPoints: entries,
	outdir: "tests/.build",
	outExtension: { ".js": ".mjs" },
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	packages: "external",
	external: [...builtins],
	logLevel: "warning",
	sourcemap: "inline",
	// src/engines/system/spawn.ts loads child_process with a plain require(),
	// because that is the only thing that resolves a builtin inside Obsidian
	// (NRL-135, docs/adr/0033). An ESM bundle has no `require`, and esbuild's
	// __require shim throws without one, so give it the real thing.
	banner: {
		js: 'import { createRequire as __nrlCreateRequire } from "node:module";\nconst require = __nrlCreateRequire(import.meta.url);',
	},
});
