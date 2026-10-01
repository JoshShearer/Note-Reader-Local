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
 * now rather than downloaded (ADR 0028), so the download path, the atomic
 * write helper and the missing/ok/mismatch classification it needed are gone;
 * what replaced the runtime checks is covered in tests/release.test.ts.
 */

import {
	getInstalledSizeMb,
	removeModelBuild,
	shouldClearPinnedKokoro,
	getTotalUsage,
	downloadModel,
	voiceForModelDownload,
	describeModelDownload,
	type ModelDirAdapter,
} from "../src/ui/modelStore.ts";
import { KokoroEngine, KOKORO_WEIGHTS } from "../src/engines/onnx/kokoro.ts";
import type { ModelStore } from "../src/engines/onnx/kokoro.ts";

/** A Kokoro engine with nothing on disk: only its label and listVoices() are used. */
function kokoroForVoices(): KokoroEngine {
	const store: ModelStore = {
		dir: "models",
		modelBase: "local-model://kokoro/",
		workerPath: "plugin/kokoro-worker.js",
		async readPluginFile() {
			return new ArrayBuffer(0);
		},
		async exists() {
			return false;
		},
		async read() {
			return new ArrayBuffer(0);
		},
		async readOptional() {
			return null;
		},
	};
	return new KokoroEngine(store);
}

/**
 * The slice of `app.vault.adapter` that `downloadModel` touches, in memory,
 * plus a `fetch` stub that records every URL and answers 404 for any path a
 * predicate names. Network is never reached: the stub replaces the global for
 * the duration of one call and is restored in `finally`.
 */
async function runDownload(
	voiceFile: string,
	fail404: (path: string) => boolean,
): Promise<{
	result: Awaited<ReturnType<typeof downloadModel>>;
	fetched: string[];
	written: string[];
}> {
	const folders = new Set<string>();
	const written: string[] = [];
	const app = {
		vault: {
			adapter: {
				async exists(p: string) {
					return folders.has(p);
				},
				async mkdir(p: string) {
					folders.add(p);
				},
				async writeBinary(p: string) {
					written.push(p);
				},
			},
		},
	};
	const fetched: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string) => {
		const path = String(input).replace(/^.*\/resolve\/main\//, "");
		fetched.push(path);
		if (fail404(path)) return new Response("not found", { status: 404 });
		return new Response(new Uint8Array(8), { status: 200, headers: { "content-length": "8" } });
	}) as typeof fetch;
	try {
		const result = await downloadModel(
			app as never,
			"model",
			KOKORO_WEIGHTS.fast.path,
			voiceFile,
			() => undefined,
		);
		return { result, fetched, written };
	} finally {
		globalThis.fetch = realFetch;
	}
}

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

	console.log("NRL-144: a voice 404 after a good model download is reported as the voice");
	{
		const { result, written } = await runDownload("af_heart.bin", (p) => p.startsWith("voices/"));
		// CORE (red at 079cf0c: one flat downloadFiles call returned only
		// {ok:false, error}, so the caller could not tell the model had landed).
		check("CORE stage is voice", result.stage === "voice", JSON.stringify(result));
		// GUARD (green both sides): the model files really were written first.
		check(
			"GUARD all four model files written before the voice failed",
			["config.json", "tokenizer.json", "tokenizer_config.json", KOKORO_WEIGHTS.fast.path].every((f) =>
				written.includes(`model/${f}`),
			),
			JSON.stringify(written),
		);
		// NEW CAPABILITY (not counted): which file and why, for the message.
		check("NEW file names the voice", result.file === "voices/af_heart.bin", JSON.stringify(result));
		check("NEW detail is the status", result.detail === "404", JSON.stringify(result));
		const described = describeModelDownload(result, null);
		check("NEW model reported installed", described.modelInstalled === true, JSON.stringify(described));
		check(
			"NEW message says the model installed and names the voice file",
			described.message ===
				"Kokoro model installed, but voice voices/af_heart.bin could not be downloaded (404). Pick a voice under Voice to retry.",
			described.message,
		);
		check("NEW message is not the generic failure", !described.message.startsWith("Download failed"), described.message);
	}

	console.log("NRL-144: Download with a foreign stored voice id fetches a Kokoro voice, never the foreign one");
	{
		const engine = kokoroForVoices();
		const voices = await engine.listVoices();
		const choice = voiceForModelDownload(engine, "speechd:English (America)", voices, "en", false);
		const { result, fetched } = await runDownload(choice.file, () => false);
		// CORE (red at 079cf0c, whose handler passed
		// voiceFileFor(voiceId).replace(/^voices\//, "") straight through).
		check(
			"CORE no fetched path names the speechd voice",
			fetched.every((p) => !p.includes("speechd")),
			JSON.stringify(fetched),
		);
		const voiceFetches = fetched.filter((p) => p.startsWith("voices/"));
		const kokoroFiles = new Set(voices.map((v) => `voices/${v.id.replace(/^kokoro:/, "")}.bin`));
		check(
			"CORE exactly one Kokoro voice file requested",
			voiceFetches.length === 1 && kokoroFiles.has(voiceFetches[0]!),
			JSON.stringify(voiceFetches),
		);
		// NEW CAPABILITY (not counted).
		check("NEW download succeeded", result.ok === true, JSON.stringify(result));
		check("NEW substituted id is persisted", choice.persist === true, JSON.stringify(choice));
		check("NEW substituted id is a Kokoro id", choice.voiceId.startsWith("kokoro:"), choice.voiceId);
		check("NEW en resolves to the en-US default", choice.voiceId === "kokoro:af_heart", choice.voiceId);
		check("NEW a notice explains the substitution", typeof choice.notice === "string" && choice.notice.length > 0, String(choice.notice));
		const described = describeModelDownload(result, choice.notice);
		check(
			"NEW success message carries the substitution notice",
			described.message.startsWith("Kokoro model ready.") && described.message.includes(choice.notice ?? "\u0000"),
			described.message,
		);
		const empty = voiceForModelDownload(engine, "", voices, "en", false);
		check("NEW empty stored id is resolved and persisted", empty.voiceId === "kokoro:af_heart" && empty.persist, JSON.stringify(empty));
	}

	console.log("NRL-144: a Kokoro id is used as-is; locale; model failure stops before the voice");
	{
		const engine = kokoroForVoices();
		const voices = await engine.listVoices();
		const pinned = voiceForModelDownload(engine, "kokoro:bm_george", voices, "en", false);
		check(
			"GUARD a stored kokoro id is kept, not persisted, no notice",
			pinned.voiceId === "kokoro:bm_george" && pinned.file === "bm_george.bin" && !pinned.persist && pinned.notice === null,
			JSON.stringify(pinned),
		);
		// NEW CAPABILITY (not counted): red against 079cf0c, which never resolved.
		const gb = voiceForModelDownload(engine, "speechd:English (Britain)", voices, "en-GB", false);
		check("NEW en-GB app locale picks an en-GB voice", voices.find((v) => v.id === gb.voiceId)?.lang === "en-GB", JSON.stringify(gb));

		const modelFail = await runDownload("af_heart.bin", (p) => p === KOKORO_WEIGHTS.fast.path);
		check(
			"GUARD a model 404 requests no voice",
			modelFail.fetched.every((p) => !p.startsWith("voices/")) && !modelFail.result.ok,
			JSON.stringify(modelFail.fetched),
		);
		check("NEW model 404 is stage model", modelFail.result.stage === "model", JSON.stringify(modelFail.result));
		const describedFail = describeModelDownload(modelFail.result, null);
		check(
			"NEW model failure keeps the generic wording and is not installed",
			describedFail.message === `Download failed: ${modelFail.result.error}` && !describedFail.modelInstalled,
			JSON.stringify(describedFail),
		);

		const allOk = await runDownload("af_heart.bin", () => false);
		check(
			"GUARD all-ok writes the model and the voice",
			allOk.result.ok && allOk.written.length === 5 && allOk.written.includes("model/voices/af_heart.bin"),
			JSON.stringify(allOk.written),
		);
		const describedOk = describeModelDownload(allOk.result, null);
		check("NEW plain success message", describedOk.message === "Kokoro model ready." && describedOk.modelInstalled, JSON.stringify(describedOk));
	}

	if (failures > 0) {
		console.log(`\n${failures} modelStore test(s) failed`);
		process.exit(1);
	}
	console.log("\nall modelStore tests passed");
}

await run();
