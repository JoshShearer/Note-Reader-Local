/**
 * Exercise the installed plugin in a real Obsidian renderer, including its
 * Node-enabled blob workers, adapter paths, cold concurrent synthesis and
 * HTMLAudioElement playback. No note contents are modified or returned.
 *
 * Launch Obsidian with --remote-debugging-port=9222, enable this plugin, then:
 *   npm run test:obsidian
 * Use a development vault. A Kokoro model must already be installed.
 */
import assert from "node:assert/strict";

const endpoint = process.env.OBSIDIAN_CDP ?? "http://127.0.0.1:9222";
const targets = await (await fetch(`${endpoint}/json/list`)).json();
const target = targets.find(t => t.type === "page" && t.url.startsWith("app://obsidian.md/"));
assert(target, "No Obsidian renderer is available on the debugging endpoint");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	socket.onopen = resolve;
	socket.onerror = reject;
});

async function smoke() {
	const plugin = app.plugins.plugins["local-tts-reader"];
	if (!plugin) throw new Error("Local TTS Reader must be enabled");
	const installed = plugin.getEngines().find(e => e.id === "kokoro");
	const engine = new installed.constructor(plugin.getModelStore());
	const player = new (plugin.getPlayer().constructor)({ bufferAhead: 2 });
	const urls = new Set();
	const create = URL.createObjectURL;
	const revoke = URL.revokeObjectURL;
	URL.createObjectURL = blob => { const url = create.call(URL, blob); urls.add(url); return url; };
	URL.revokeObjectURL = url => { urls.delete(url); return revoke.call(URL, url); };
	const chunks = ["This is a local speech test.", "The second passage plays next.", "The third passage finishes the test."]
		.map(text => ({ text, sourceIndex: Array.from(text, (_, i) => i), sourceStart: 0, sourceEnd: text.length }));
	let timeout;
	const limit = promise => Promise.race([promise, new Promise((_, reject) => {
		timeout = setTimeout(() => reject(new Error("Timed out during worker synthesis/playback")), 120000);
	})]).finally(() => clearTimeout(timeout));
	try {
		// These calls intentionally overlap while ready is still pending. This
		// reproduces the player's cold-start prefetch pattern.
		const results = await limit(Promise.all(chunks.map(chunk => engine.synthesize(
			{ chunk, rate: 1, pitch: 0 }, new AbortController().signal,
		))));
		const audio = results.map(result => {
			if (result.kind !== "buffer") throw new Error("Expected synthesized WAV buffer");
			const samples = new Int16Array(result.audio, 44);
			let sum = 0, peak = 0;
			for (const value of samples) { sum += value * value; peak = Math.max(peak, Math.abs(value)); }
			const rms = Math.sqrt(sum / samples.length) / 32768;
			if (result.durationMs < 500 || rms < 0.001 || peak < 300 || !result.words.length) {
				throw new Error("Synthesis returned silent/invalid audio or no word timing");
			}
			return { durationMs: result.durationMs, samples: samples.length, rms, words: result.words.length };
		});
		const states = [], words = [], errors = [];
		player.on("state", state => states.push(state));
		player.on("word", word => { if (word) words.push(word.wordIndex); });
		player.on("error", error => errors.push(error.message));
		await limit(player.play(engine, chunks, 1));
		if (errors.length || player.getState() !== "finished" || words.length < 3) {
			throw new Error(`Playback failed: ${JSON.stringify({ errors, states, words: words.length })}`);
		}
		const rejected = new installed.constructor(plugin.getModelStore());
		// Validate remote runtime URLs before the dynamic import bypasses fetch.
		const blobFor = rejected.blobFor.bind(rejected);
		rejected.blobFor = (path, type) => path.endsWith(".mjs")
			? Promise.resolve("https://example.invalid/ort.mjs") : blobFor(path, type);
		let refusal;
		try { await rejected.load(); } catch (error) { refusal = error.message; }
		finally { await rejected.dispose(); }
		if (!refusal?.includes("Refusing a remote onnxruntime glue module")) {
			throw new Error(`Remote runtime guard failed: ${refusal}`);
		}
		await engine.dispose();
		player.dispose();
		if (urls.size) throw new Error(`Leaked ${urls.size} object URLs after disposal`);
		return { audio, states, wordEvents: words.length, remoteRuntimeRejected: true, leakedUrls: urls.size };
	} finally {
		player.dispose();
		await engine.dispose();
		URL.createObjectURL = create;
		URL.revokeObjectURL = revoke;
	}
}

try {
	const response = await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Obsidian smoke test timed out")), 180000);
		socket.onmessage = event => {
			const message = JSON.parse(event.data);
			if (message.id !== 1) return;
			clearTimeout(timeout);
			resolve(message);
		};
		socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
			expression: `(${smoke.toString()})()`, awaitPromise: true, returnByValue: true,
		} }));
	});
	assert(!response.error, JSON.stringify(response.error));
	assert(!response.result.exceptionDetails, JSON.stringify(response.result.exceptionDetails));
	console.log("PASS: real Obsidian cold concurrent synthesis, playback, word timing and cleanup");
	console.log(JSON.stringify(response.result.result.value, null, 2));
} finally {
	socket.close();
}
