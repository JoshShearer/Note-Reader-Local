/**
 * The ONNX runtime on-demand download path (NRL-37): the atomic
 * write-to-temp-then-move helper and the missing/ok/mismatch status
 * classification.
 *
 * `modelStore.ts` imports `App` from `obsidian` for its other exports, but
 * only ever uses it as a type - `obsidian` has no runtime in this suite
 * (AGENTS.md), and its package.json points `main` at an empty string, so an
 * actual value import would fail to resolve. `writeBinaryAtomic` and
 * `checkOrtStatus` take a small injected `AtomicAdapter` instead of the real
 * `App`/`DataAdapter`, exactly so this logic can be exercised here (decision
 * D6 on this ticket) - the same escape hatch settings/data.ts and
 * settings/positionThrottle.ts already use.
 */

import {
	writeBinaryAtomic,
	checkOrtStatus,
	worstOrtStatus,
	type AtomicAdapter,
} from "../src/ui/modelStore.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

async function sha256Hex(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function toBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer;
}

function fromBuffer(buf: ArrayBuffer): string {
	return new TextDecoder().decode(buf);
}

/**
 * An in-memory `AtomicAdapter`. `writeBinary` can be told to throw on
 * specific paths, to simulate a write failing mid-stream without needing a
 * real filesystem.
 */
class FakeAdapter implements AtomicAdapter {
	files = new Map<string, ArrayBuffer>();
	private throwOnWrite = new Set<string>();
	writeCalls: string[] = [];
	renameCalls: Array<[string, string]> = [];
	removeCalls: string[] = [];

	failWriteOnce(path: string): void {
		this.throwOnWrite.add(path);
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.writeCalls.push(path);
		if (this.throwOnWrite.has(path)) {
			this.throwOnWrite.delete(path);
			throw new Error(`simulated write failure: ${path}`);
		}
		this.files.set(path, data);
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const data = this.files.get(path);
		if (!data) throw new Error(`ENOENT: ${path}`);
		return data;
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		this.renameCalls.push([oldPath, newPath]);
		const data = this.files.get(oldPath);
		if (!data) throw new Error(`ENOENT (rename source): ${oldPath}`);
		this.files.set(newPath, data);
		this.files.delete(oldPath);
	}

	async remove(path: string): Promise<void> {
		this.removeCalls.push(path);
		this.files.delete(path);
	}

	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}
}

async function run(): Promise<void> {
	console.log("writeBinaryAtomic: successful write commits");
	{
		const adapter = new FakeAdapter();
		const bytes = toBuffer("real ort bytes");
		const checksum = await sha256Hex("real ort bytes");

		const result = await writeBinaryAtomic(adapter, "ort/file.wasm", bytes, checksum);

		check("result.ok", result.ok === true, JSON.stringify(result));
		check("final file exists", adapter.files.has("ort/file.wasm"));
		check(
			"final file has the right bytes",
			fromBuffer(adapter.files.get("ort/file.wasm")!) === "real ort bytes",
		);
		check("no stray .part file", !adapter.files.has("ort/file.wasm.part"));
	}

	console.log(
		"writeBinaryAtomic: a write that throws mid-stream leaves no committed file and no stray .part",
	);
	{
		const adapter = new FakeAdapter();
		adapter.failWriteOnce("ort/file.wasm.part");
		const bytes = toBuffer("bytes that never land");
		const checksum = await sha256Hex("bytes that never land");

		const result = await writeBinaryAtomic(adapter, "ort/file.wasm", bytes, checksum);

		check("result.ok is false", result.ok === false);
		check("error message present", typeof result.error === "string" && result.error.length > 0);
		check("no final file", !adapter.files.has("ort/file.wasm"));
		check("no stray .part file", !adapter.files.has("ort/file.wasm.part"));
	}

	console.log("writeBinaryAtomic: checksum mismatch discards the temp file, never commits");
	{
		const adapter = new FakeAdapter();
		const bytes = toBuffer("corrupted-in-transit");
		const wrongChecksum = "0".repeat(64);

		const result = await writeBinaryAtomic(adapter, "ort/file.wasm", bytes, wrongChecksum);

		check("result.ok is false", result.ok === false);
		check(
			"error names the file and mentions checksum",
			(result.error ?? "").includes("Checksum mismatch") &&
				(result.error ?? "").includes("ort/file.wasm"),
			result.error,
		);
		check("no final file", !adapter.files.has("ort/file.wasm"));
		check("no stray .part file", !adapter.files.has("ort/file.wasm.part"));
	}

	console.log(
		"writeBinaryAtomic: an existing valid file is not corrupted by a failed retry",
	);
	{
		const adapter = new FakeAdapter();
		// Simulate a prior successful download already sitting at the final path.
		adapter.files.set("ort/file.wasm", toBuffer("already installed and correct"));

		// A second attempt (e.g. re-clicking Download) that fails its checksum
		// must never touch the existing, already-verified final file.
		const badBytes = toBuffer("a corrupted re-download");
		const wrongChecksum = "1".repeat(64);
		const result = await writeBinaryAtomic(adapter, "ort/file.wasm", badBytes, wrongChecksum);

		check("retry result.ok is false", result.ok === false);
		check(
			"existing final file is untouched",
			fromBuffer(adapter.files.get("ort/file.wasm")!) === "already installed and correct",
		);
		check("no stray .part file after the failed retry", !adapter.files.has("ort/file.wasm.part"));
	}

	console.log(
		"writeBinaryAtomic: a stale .part from a prior crash is removed before a fresh write, not trusted or renamed over",
	);
	{
		const adapter = new FakeAdapter();
		// A crashed previous attempt left a stale, unverified .part on disk.
		adapter.files.set("ort/file.wasm.part", toBuffer("stale half-written garbage"));

		const goodBytes = toBuffer("this attempt's real bytes");
		const goodChecksum = await sha256Hex("this attempt's real bytes");
		const result = await writeBinaryAtomic(adapter, "ort/file.wasm", goodBytes, goodChecksum);

		check("result.ok", result.ok === true, JSON.stringify(result));
		check(
			"final file has THIS attempt's bytes, not the stale .part's",
			fromBuffer(adapter.files.get("ort/file.wasm")!) === "this attempt's real bytes",
		);
		check(
			"the stale .part was removed rather than renamed over",
			adapter.removeCalls.includes("ort/file.wasm.part"),
		);
		check("no stray .part file remains", !adapter.files.has("ort/file.wasm.part"));
	}

	console.log("checkOrtStatus: classifies missing, ok and mismatch per file");
	{
		const adapter = new FakeAdapter();
		const okBytes = toBuffer("good file");
		const okChecksum = await sha256Hex("good file");
		adapter.files.set("model/ort/a.wasm", okBytes);
		adapter.files.set("model/ort/b.wasm", toBuffer("corrupted"));
		// c.wasm is never written: missing.

		const checksums = {
			"a.wasm": okChecksum,
			"b.wasm": await sha256Hex("what it should have hashed to"),
			"c.wasm": await sha256Hex("whatever"),
		};

		const statuses = await checkOrtStatus(
			adapter,
			"model",
			["a.wasm", "b.wasm", "c.wasm"],
			checksums,
		);

		check("a.wasm is ok", statuses["a.wasm"] === "ok", statuses["a.wasm"]);
		check("b.wasm is mismatch", statuses["b.wasm"] === "mismatch", statuses["b.wasm"]);
		check("c.wasm is missing", statuses["c.wasm"] === "missing", statuses["c.wasm"]);
	}

	console.log("worstOrtStatus: mismatch outranks missing, which outranks ok");
	{
		check(
			"all ok -> ok",
			worstOrtStatus({ a: "ok", b: "ok" }) === "ok",
		);
		check(
			"one missing among ok -> missing",
			worstOrtStatus({ a: "ok", b: "missing" }) === "missing",
		);
		check(
			"one mismatch among missing and ok -> mismatch",
			worstOrtStatus({ a: "ok", b: "missing", c: "mismatch" }) === "mismatch",
		);
		check("empty map -> missing", worstOrtStatus({}) === "missing");
	}

	if (failures > 0) {
		console.log(`\n${failures} modelStore test(s) failed`);
		process.exit(1);
	}
	console.log("\nall modelStore tests passed");
}

await run();
