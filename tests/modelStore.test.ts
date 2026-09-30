/**
 * Installed-size accounting and model-build removal (NRL-33, R-C02).
 *
 * `modelStore.ts` imports `App` from `obsidian` for its other exports, but
 * only ever uses it as a type - `obsidian` has no runtime in this suite
 * (AGENTS.md), and its package.json points `main` at an empty string, so an
 * actual value import would fail to resolve. The functions under test take a
 * small injected `ModelDirAdapter` instead of the real `App`/`DataAdapter`,
 * exactly so this logic can be exercised here - the same escape hatch
 * settings/data.ts and settings/positionThrottle.ts already use.
 *
 * The ONNX runtime used to be in this file too. It is bundled inside main.js
 * now rather than downloaded (ADR 0026), so the download path, the atomic
 * write helper and the missing/ok/mismatch classification it needed are gone;
 * what replaced the runtime checks is covered in tests/release.test.ts.
 */

import {
	getInstalledSizeMb,
	removeModelBuild,
	shouldClearPinnedKokoro,
	getTotalUsage,
	type ModelDirAdapter,
} from "../src/ui/modelStore.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

/**
 * An in-memory `ModelDirAdapter`, holding only what the surviving tests drive.
 *
 * `list()`/`rmdir()` derive folder structure from the tracked files' path
 * prefixes rather than tracking folders as their own entities: this suite
 * never creates an empty folder that holds no file, so a folder "exists"
 * exactly when some tracked file's path starts with `${folder}/`.
 */
class FakeAdapter implements ModelDirAdapter {
	files = new Map<string, ArrayBuffer>();
	removeCalls: string[] = [];
	rmdirCalls: string[] = [];

	async remove(path: string): Promise<void> {
		this.removeCalls.push(path);
		this.files.delete(path);
	}

	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}

	async stat(path: string): Promise<{ size: number } | null> {
		const data = this.files.get(path);
		return data ? { size: data.byteLength } : null;
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = `${path}/`;
		const files: string[] = [];
		const folders = new Set<string>();
		for (const key of this.files.keys()) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) files.push(key);
			else folders.add(`${prefix}${rest.slice(0, slash)}`);
		}
		return { files, folders: Array.from(folders) };
	}

	async rmdir(path: string, _recursive: boolean): Promise<void> {
		this.rmdirCalls.push(path);
		const prefix = `${path}/`;
		for (const key of Array.from(this.files.keys())) {
			if (key === path || key.startsWith(prefix)) this.files.delete(key);
		}
	}
}

async function run(): Promise<void> {
	console.log("getInstalledSizeMb: null for a missing build, right MB for gpu/fast/small");
	{
		const adapter = new FakeAdapter();
		adapter.files.set("model/onnx/model.onnx", new ArrayBuffer(326_000_000));
		adapter.files.set("model/onnx/model_q4f16.onnx", new ArrayBuffer(155_000_000));
		// model_quantized.onnx (small) is deliberately absent.

		check(
			"missing build -> null",
			(await getInstalledSizeMb(adapter, "model", "small")) === null,
		);
		check(
			"gpu build -> 326 MB from the real bytes on disk",
			(await getInstalledSizeMb(adapter, "model", "gpu")) === 326,
			String(await getInstalledSizeMb(adapter, "model", "gpu")),
		);
		check(
			"fast build -> 155 MB from the real bytes on disk",
			(await getInstalledSizeMb(adapter, "model", "fast")) === 155,
			String(await getInstalledSizeMb(adapter, "model", "fast")),
		);
	}

	console.log(
		"removeModelBuild: reports freedBytes from a real stat, and removes the weights file",
	);
	{
		const adapter = new FakeAdapter();
		adapter.files.set("model/onnx/model_quantized.onnx", new ArrayBuffer(92_000_000));

		const result = await removeModelBuild(adapter, "model", "small");

		check("ok is true", result.ok === true, JSON.stringify(result));
		check("freedBytes matches what was on disk", result.freedBytes === 92_000_000, String(result.freedBytes));
		check(
			"the weights file is gone",
			!(await adapter.exists("model/onnx/model_quantized.onnx")),
		);
		check("no error reported", result.error === undefined, String(result.error));
	}

	console.log(
		"removeModelBuild: a build that was never installed is a no-op, not a failed remove",
	);
	{
		const adapter = new FakeAdapter();

		const result = await removeModelBuild(adapter, "model", "gpu");

		check("ok is false", result.ok === false, JSON.stringify(result));
		check("freedBytes is 0", result.freedBytes === 0);
		check("no remove() call was made at all", adapter.removeCalls.length === 0);
	}

	console.log(
		"removeModelBuild: the onnx/ folder is cleaned up once it is left empty, best-effort",
	);
	{
		const adapter = new FakeAdapter();
		adapter.files.set("model/onnx/model_q4f16.onnx", new ArrayBuffer(155_000_000));

		await removeModelBuild(adapter, "model", "fast");

		check(
			"rmdir was attempted on the now-empty onnx/ folder",
			adapter.rmdirCalls.includes("model/onnx"),
			JSON.stringify(adapter.rmdirCalls),
		);
	}

	console.log(
		"removeModelBuild: the onnx/ folder is left alone while another build still lives there",
	);
	{
		const adapter = new FakeAdapter();
		adapter.files.set("model/onnx/model_q4f16.onnx", new ArrayBuffer(155_000_000));
		adapter.files.set("model/onnx/model_quantized.onnx", new ArrayBuffer(92_000_000));

		const result = await removeModelBuild(adapter, "model", "fast");

		check("removal itself still succeeds", result.ok === true, JSON.stringify(result));
		check(
			"onnx/ was not removed - the small build is still in it",
			!adapter.rmdirCalls.includes("model/onnx"),
			JSON.stringify(adapter.rmdirCalls),
		);
		check(
			"the surviving build is untouched",
			await adapter.exists("model/onnx/model_quantized.onnx"),
		);
	}

	console.log(
		"shouldClearPinnedKokoro: true only for a literal kokoro pin left unavailable by the removal",
	);
	{
		check(
			"kokoro pinned, unavailable after removal -> true",
			shouldClearPinnedKokoro("kokoro", false) === true,
		);
		check(
			"kokoro pinned, still available after removal -> false",
			shouldClearPinnedKokoro("kokoro", true) === false,
		);
		check("auto selection, unavailable -> false", shouldClearPinnedKokoro("auto", false) === false);
		check("auto selection, available -> false", shouldClearPinnedKokoro("auto", true) === false);
		check(
			"a different engine pinned -> false regardless of kokoro's availability",
			shouldClearPinnedKokoro("espeak", false) === false,
		);
	}

	console.log(
		"getTotalUsage: aggregates shared files + every build + every voice + the given ORT files, all from real stats",
	);
	{
		const adapter = new FakeAdapter();
		adapter.files.set("model/config.json", new ArrayBuffer(1000));
		adapter.files.set("model/tokenizer.json", new ArrayBuffer(2000));
		adapter.files.set("model/tokenizer_config.json", new ArrayBuffer(500));
		// Only the "fast" build is installed; gpu and small are not.
		adapter.files.set("model/onnx/model_q4f16.onnx", new ArrayBuffer(155_000_000));
		// Only one of the 28 voices is installed.
		adapter.files.set("model/voices/af_heart.bin", new ArrayBuffer(522_240));
		// One ORT file present, one asked-for-but-absent.
		adapter.files.set(
			"model/ort/ort-wasm-simd-threaded.jsep.wasm",
			new ArrayBuffer(21_596_019),
		);

		const usage = await getTotalUsage(adapter, "model", [
			"ort-wasm-simd-threaded.jsep.wasm",
			"ort-wasm-simd-threaded.jsep.mjs",
		]);

		check("sharedBytes sums the 3 shared files", usage.sharedBytes === 3500, String(usage.sharedBytes));
		check("builds.fast is the installed build's real size", usage.builds.fast === 155_000_000, String(usage.builds.fast));
		check("builds.gpu is 0 - not on disk, not NaN or negative", usage.builds.gpu === 0, String(usage.builds.gpu));
		check("builds.small is 0 - not on disk", usage.builds.small === 0, String(usage.builds.small));
		check(
			"voicesBytes counts only the one voice actually on disk",
			usage.voicesBytes === 522_240,
			String(usage.voicesBytes),
		);
		check(
			"ortBytes counts only the present ORT file, the missing one contributes 0",
			usage.ortBytes === 21_596_019,
			String(usage.ortBytes),
		);
		check(
			"totalBytes is the sum of every category",
			usage.totalBytes === 3500 + 155_000_000 + 522_240 + 21_596_019,
			String(usage.totalBytes),
		);
	}

	if (failures > 0) {
		console.log(`\n${failures} modelStore test(s) failed`);
		process.exit(1);
	}
	console.log("\nall modelStore tests passed");
}

await run();
