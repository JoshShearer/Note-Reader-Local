/**
 * Path handling for the model store.
 *
 * These are pure functions over vault paths, so they can be checked without an
 * Obsidian instance. The bugs they guard against are the kind that only show up
 * once the plugin is loaded: a path that reads back as valid but points at
 * nothing, so the model silently never loads.
 */

import { modelStorePaths, pluginVaultPath } from "../src/ui/paths.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

console.log("the plugin folder is addressed from the vault root");
{
	// manifest.dir is just the folder name. Using it directly is the bug this
	// guards: `.obsidian/plugins` is required or the adapter looks in the wrong
	// place and the worker script is never found.
	const dir = pluginVaultPath("local-tts-reader");
	check("has .obsidian/plugins prefix", dir.startsWith(".obsidian/plugins/"), dir);
	check("keeps the folder name", dir.endsWith("/local-tts-reader"), dir);
	check("uses forward slashes", !dir.includes("\\"), dir);
	check("no doubled separators", !dir.includes("//"), dir);
}

console.log("plugin path handles the value Obsidian actually supplies");
{
	// `manifest.dir` is a vault path, not a bare folder name. Prefixing it
	// again yields `.obsidian/plugins/.obsidian/plugins/local-tts-reader`,
	// which does not exist, so this must be idempotent.
	const fromObsidian = pluginVaultPath(".obsidian/plugins/local-tts-reader");
	check("already-prefixed dir is not doubled",
		fromObsidian === ".obsidian/plugins/local-tts-reader", fromObsidian);
	check("contains the prefix exactly once",
		fromObsidian.split(".obsidian/plugins/").length === 2, fromObsidian);
	check("matches the bare-name form",
		fromObsidian === pluginVaultPath("local-tts-reader"), fromObsidian);

	const store = modelStorePaths(".obsidian/plugins/local-tts-reader", ".obsidian/local-tts/kokoro");
	check("plugin root is not doubled", !store.pluginRoot.includes(".obsidian/plugins/.obsidian"),
		store.pluginRoot);
	check("worker path is not doubled", !store.workerPath.includes(".obsidian/plugins/.obsidian"),
		store.workerPath);
	check("ort path is not doubled",
		!store.ortFile("ort-wasm-simd-threaded.jsep.mjs").includes(".obsidian/plugins/.obsidian"),
		store.ortFile("ort-wasm-simd-threaded.jsep.mjs"));
}

console.log("model files sit outside the plugin folder");
{
	const store = modelStorePaths("local-tts-reader", ".obsidian/local-tts/kokoro");
	check("plugin root resolved", store.pluginRoot.startsWith(".obsidian/plugins/"), store.pluginRoot);

	// A plugin update replaces the plugin folder, so anything downloaded there
	// would be lost. The 90MB of weights have to live elsewhere in the vault.
	check("model dir is not inside the plugin folder",
		!store.modelDir.startsWith(store.pluginRoot), store.modelDir);

	check("worker script resolves inside the plugin folder",
		store.workerPath.startsWith(store.pluginRoot), `${store.workerPath} vs ${store.pluginRoot}`);
	check("ort runtime resolves inside the plugin folder",
		store.ortFile("x.wasm").startsWith(store.pluginRoot),
		`${store.ortFile("x.wasm")} vs ${store.pluginRoot}`);
}

console.log("model paths are built per file");
{
	const store = modelStorePaths("local-tts-reader", ".obsidian/local-tts/kokoro");
	check("weights path", store.modelFile("onnx/model_quantized.onnx")
		=== ".obsidian/local-tts/kokoro/onnx/model_quantized.onnx", store.modelFile("onnx/model_quantized.onnx"));
	check("voice path", store.modelFile("voices/af_heart.bin")
		=== ".obsidian/local-tts/kokoro/voices/af_heart.bin", store.modelFile("voices/af_heart.bin"));
	check("config path", store.modelFile("config.json")
		=== ".obsidian/local-tts/kokoro/config.json", store.modelFile("config.json"));
}

console.log("a leading or trailing slash in settings does not break paths");
{
	// These come from user-editable settings, so sloppy input has to be
	// normalised rather than producing `.obsidian/plugins/local-tts-reader//ort`.
	const store = modelStorePaths("local-tts-reader", "/.obsidian/local-tts/kokoro/");
	check("model dir normalised", store.modelDir === ".obsidian/local-tts/kokoro", store.modelDir);
	check("no doubled separators in worker path", !store.workerPath.includes("//"), store.workerPath);
	check("no doubled separators in ort path",
		!store.ortFile("ort-wasm-simd-threaded.jsep.mjs").includes("//"),
		store.ortFile("ort-wasm-simd-threaded.jsep.mjs"));
}

if (failures > 0) {
	console.log(`\n${failures} path test(s) failed`);
	process.exit(1);
}
console.log("\nall path tests passed");
