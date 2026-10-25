/**
 * The optional Piper engine over a loopback server (NRL-148, docs/adr/0040).
 *
 * Drives the real `PiperEngine` against a fake transport that records every
 * request, and through the real `Player` with the FakeAudio/Blob/URL/rAF block
 * that tests/player.test.ts and tests/bridge.test.ts use. No socket, no
 * obsidian import, and no real Piper server: what the server actually answers
 * is upstream's, reviewer-read and not run (see the ADR), so these checks pin
 * the plugin's side of the contract only.
 */

import { readFileSync, readdirSync } from "node:fs";
import { Player } from "../src/audio/player.ts";
import { pcmToWav } from "../src/audio/wav.ts";
import { EngineUnavailableError, type SpeechChunk, type SpeechEngine, type SynthRequest } from "../src/audio/types.ts";
import {
	ALLOWED_PATHS,
	DEFAULT_PIPER_PORT,
	NOT_CHECKED_REASON,
	PIPER_HOST,
	PIPER_PROBE_PATH,
	PIPER_SYNTH_PATH,
	PROBE_TIMEOUT_MS,
	PiperEngine,
	buildSynthesizeRequest,
	confirmManualEngine,
	makeRequestUrlTransport,
	parseVoices,
	withDeadline,
	type PiperRequest,
	type PiperResponse,
	type PiperTransport,
} from "../src/engines/piper/piper.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

// --- Browser stand-ins (same block as tests/bridge.test.ts) ---------------

class FakeAudio {
	src = "";
	playbackRate = 1;
	currentTime = 0;
	paused = true;
	private listeners = new Map<string, Array<() => void>>();
	addEventListener(type: string, fn: () => void): void {
		const set = this.listeners.get(type) ?? [];
		set.push(fn);
		this.listeners.set(type, set);
	}
	removeEventListener(type: string, fn: () => void): void {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
	}
	fire(type: string): void {
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
	}
	play(): Promise<void> {
		this.paused = false;
		return Promise.resolve();
	}
	pause(): void {
		this.paused = true;
	}
	removeAttribute(): void {
		this.src = "";
	}
}

let fakeAudio: FakeAudio | undefined;
(globalThis as Record<string, unknown>).Audio = class {
	constructor() {
		fakeAudio = new FakeAudio();
		return fakeAudio as unknown as object;
	}
} as unknown as typeof Audio;
(globalThis as Record<string, unknown>).requestAnimationFrame = (): number => 1;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (): void => undefined;
(globalThis as Record<string, unknown>).Blob = class {
	constructor(public parts: unknown[]) {}
};
(globalThis as Record<string, unknown>).URL = {
	createObjectURL: (): string => `blob:${Math.random()}`,
	revokeObjectURL: (): void => undefined,
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// --- Fixtures ---------------------------------------------------------------

const SECRET_TEXT = "ZSECRETZ the note says this.";

function chunk(text: string, i = 0): SpeechChunk {
	return {
		id: `c${i}`,
		sequence: i,
		blockType: "paragraph",
		filePath: "note.md",
		text,
		sourceIndex: Array.from(text, (_, k) => i * 100 + k),
		sourceStart: i * 100,
		sourceEnd: i * 100 + text.length,
	};
}

function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function json(status: number, body: unknown): PiperResponse {
	return { status, body: bytes(JSON.stringify(body)) };
}

/** 0.5 s of silence at 22050 Hz: what a Piper medium voice returns. */
const WAV = (): ArrayBuffer => pcmToWav(new Int16Array(11025).buffer, 22050);

const VOICES = {
	"en_US-lessac-medium": { language: { code: "en_US" }, audio: { sample_rate: 22050 } },
	"de_DE-thorsten-low": { audio: { sample_rate: 16000 } },
	oddname: {},
};

/** Every request the engine makes, answered from a route table. */
function fakeServer(
	answer: (req: PiperRequest) => PiperResponse | Promise<PiperResponse> = defaultAnswer,
): { transport: PiperTransport; requests: PiperRequest[] } {
	const requests: PiperRequest[] = [];
	return {
		requests,
		transport: async (req) => {
			requests.push(req);
			allRequests.push(req);
			return await answer(req);
		},
	};
}

function defaultAnswer(req: PiperRequest): PiperResponse {
	const path = req.url.replace(/^http:\/\/[^/]+/, "");
	if (req.method === "GET" && path === PIPER_PROBE_PATH) return json(200, VOICES);
	if (req.method === "POST" && path === PIPER_SYNTH_PATH) return { status: 200, body: WAV() };
	return json(404, { error: "not found" });
}

/** Across the whole suite, for the allowlist check at the end. */
const allRequests: PiperRequest[] = [];

function piper(
	answer?: (req: PiperRequest) => PiperResponse | Promise<PiperResponse>,
	config = { port: DEFAULT_PIPER_PORT },
): { engine: PiperEngine; requests: PiperRequest[]; config: { port: number } } {
	const { transport, requests } = fakeServer(answer);
	return { engine: new PiperEngine(() => config, transport), requests, config };
}

function req(c: SpeechChunk, rate = 1): SynthRequest {
	return { chunk: c, rate, pitch: 0 };
}

async function caught(p: Promise<unknown>): Promise<Error | null> {
	try {
		await p;
		return null;
	} catch (err) {
		return err as Error;
	}
}

const posts = (requests: PiperRequest[]): PiperRequest[] => requests.filter((r) => r.method === "POST");
const gets = (requests: PiperRequest[]): PiperRequest[] => requests.filter((r) => r.method === "GET");
const sig = (): AbortSignal => new AbortController().signal;

// --- P1: no I/O unless asked -----------------------------------------------

console.log("P1 construction, isAvailable, lastAvailability and listVoices never touch the server");
{
	const { engine, requests, config } = piper();
	const before = await engine.isAvailable();
	check("unchecked: unavailable", !before.available);
	check("unchecked: the reason says how to check", !before.available && before.reason === NOT_CHECKED_REASON, JSON.stringify(before));
	check("unchecked: lastAvailability agrees", !engine.lastAvailability().available);
	check("unchecked: no voices", (await engine.listVoices()).length === 0);
	check("no prepare(), so warmUpEngine returns before anything", (engine as SpeechEngine).prepare === undefined);
	check("nothing was requested", requests.length === 0, String(requests.length));

	await engine.check();
	const n = requests.length;
	check("after a check: available from the cache", (await engine.isAvailable()).available);
	check("after a check: voices from the cache", (await engine.listVoices()).length === 3);
	check("after a check: isAvailable/listVoices/lastAvailability added no request", requests.length === n, String(requests.length));

	config.port = 5012;
	check("a port change: back to not checked", engine.lastAvailability().available === false && (engine.lastAvailability() as { reason: string }).reason === NOT_CHECKED_REASON);
	check("a port change: no voices", (await engine.listVoices()).length === 0);
	check("a port change: still no request", requests.length === n);
}

// --- P2: the probe -----------------------------------------------------------

console.log("P2 check() asks GET /voices once and reads what answered");
{
	const { engine, requests } = piper();
	const [a, b] = await Promise.all([engine.check(), engine.check()]);
	check("ready", a.available && b.available);
	check("concurrent checks share one request", requests.length === 1, String(requests.length));
	const r = requests[0]!;
	check("GET", r.method === "GET");
	check("to 127.0.0.1:5011/voices", r.url === `http://127.0.0.1:${DEFAULT_PIPER_PORT}/voices`, r.url);
	check("short probe timeout", r.timeoutMs === PROBE_TIMEOUT_MS, String(r.timeoutMs));
	check("no body on the probe", r.body === undefined);
	const voices = await engine.listVoices();
	const lessac = voices.find((v) => v.name === "en_US-lessac-medium");
	check("voice id is piper:<name>", lessac?.id === "piper:en_US-lessac-medium", JSON.stringify(lessac));
	check("lang from language.code, normalised", lessac?.lang === "en-US", lessac?.lang);
	check("lang falls back to the name prefix", voices.find((v) => v.name === "de_DE-thorsten-low")?.lang === "de-DE");
	check("lang empty when nothing says", voices.find((v) => v.name === "oddname")?.lang === "");
	check("every voice local and needs no network (R-S01)", voices.every((v) => v.local === true && v.requiresNetwork === false && v.engineId === "piper"));
}
{
	const cases: Array<[string, (req: PiperRequest) => PiperResponse | Promise<PiperResponse>, RegExp]> = [
		["refused", () => Promise.reject(new Error("ECONNREFUSED")), /No Piper server answered on 127\.0\.0\.1:5011\. Start it with --host 127\.0\.0\.1 --port 5011/],
		["404", () => json(404, {}), /not like a Piper server/],
		["HTML", () => ({ status: 200, body: bytes("<html>hi</html>") }), /not like a Piper server/],
		["a JSON array", () => json(200, ["a"]), /not like a Piper server/],
		["zero voices", () => json(200, {}), /has no voices/],
	];
	for (const [name, answer, pattern] of cases) {
		const { engine } = piper(answer);
		const result = await engine.check();
		check(`${name}: unavailable with an actionable reason`, !result.available && pattern.test(result.reason), JSON.stringify(result));
		check(`${name}: the cache says the same`, !engine.lastAvailability().available);
	}
	const { engine, requests } = piper(undefined, { port: 70000 });
	const bad = await engine.check();
	check("invalid port: unavailable, no request", !bad.available && requests.length === 0 && /valid port/.test((bad as { reason: string }).reason));
}

// --- P3: the rate is the player's (non-negotiable 9) ------------------------

console.log("P3 the request body is identical at every rate and carries no length_scale");
{
	const bodies: string[] = [];
	for (const rate of [0.5, 1, 1.7, 2]) {
		const { engine, requests } = piper();
		await engine.synthesize(req(chunk(SECRET_TEXT), rate), sig());
		bodies.push(String(posts(requests)[0]?.body));
	}
	check("byte-identical bodies for 0.5/1/1.7/2", bodies.every((b) => b === bodies[0]), JSON.stringify(bodies));
	check("no length_scale and no rate key", !/length_scale|rate/.test(bodies[0]!), bodies[0]);
	check("buildSynthesizeRequest without a voice is just the text", JSON.stringify(buildSynthesizeRequest("x", null)) === '{"text":"x"}');
	check("ownsPlayback false", new PiperEngine(() => ({ port: 1 }), async () => json(200, {})).capabilities.ownsPlayback === false);
}
{
	console.log("P3b through the real Player at 1.7: the engine gets rate 1, the element plays at 1.7");
	const { engine } = piper();
	const seen: number[] = [];
	const spy: SpeechEngine = Object.assign(Object.create(engine) as PiperEngine, {
		synthesize(r: SynthRequest, s: AbortSignal) {
			seen.push(r.rate);
			return engine.synthesize(r, s);
		},
	});
	const player = new Player({ bufferAhead: 1 });
	const playing = player.play(spy, [chunk("One.", 0), chunk("Two.", 1)], 1.7, 0);
	for (let i = 0; i < 20 && !fakeAudio?.src; i++) await tick();
	check("the engine was asked at rate 1 every time", seen.length > 0 && seen.every((r) => r === 1), JSON.stringify(seen));
	check("prefetch ran (a buffer engine)", seen.length >= 2, String(seen.length));
	check("the element plays at exactly 1.7", fakeAudio?.playbackRate === 1.7, String(fakeAudio?.playbackRate));
	player.stop();
	await playing.catch(() => undefined);
}

// --- P4: text in the body only, to loopback only (rule 2's reason) ---------

console.log("P4 a synthesis is a JSON POST to 127.0.0.1:<port>/synthesize, with the text only in the body");
{
	const { engine, requests } = piper(undefined, { port: 5099 });
	const voices = await (async () => {
		await engine.check();
		return await engine.listVoices();
	})();
	await engine.selectVoice(voices.find((v) => v.name === "en_US-lessac-medium")!);
	const result = await engine.synthesize(req(chunk(SECRET_TEXT)), sig());
	const post = posts(requests)[0]!;
	check("POST", post?.method === "POST");
	check("to /synthesize", post.url === "http://127.0.0.1:5099/synthesize", post.url);
	check("JSON content type", post.contentType === "application/json", post.contentType);
	check("body is { text, voice }", post.body === JSON.stringify({ text: SECRET_TEXT, voice: "en_US-lessac-medium" }), post.body);
	for (const r of requests) {
		check(`${r.method} ${r.url}: no query or fragment`, !/[?#]/.test(r.url));
		check(`${r.method} ${r.url}: the URL never carries the text`, !r.url.includes("ZSECRETZ"));
		check(`${r.method} ${r.url}: IPv4 loopback`, r.url.startsWith(`http://${PIPER_HOST}:5099/`));
	}
	check("PIPER_HOST is 127.0.0.1", PIPER_HOST === "127.0.0.1");
	check("a buffer result", result.kind === "buffer");
	if (result.kind === "buffer") {
		check("duration from the WAV", Math.abs(result.durationMs - 500) < 1, String(result.durationMs));
		check("sample rate from the WAV", result.sampleRate === 22050);
		check("word timings for every word", result.words.length === 5, String(result.words.length));
	}
}
{
	const { engine, requests } = piper();
	const blank = await engine.synthesize(req(chunk("   ")), sig());
	check("a blank chunk sends nothing", requests.length === 0 && blank.kind === "streamed");
}

// --- P5: the gate - no text before a Piper-shaped /voices -------------------

console.log("P5 an unchecked engine probes before its first POST, and a failed probe sends no text");
{
	const { engine, requests } = piper();
	await engine.synthesize(req(chunk(SECRET_TEXT)), sig());
	check("GET /voices came first", requests[0]?.method === "GET" && requests[0].url.endsWith("/voices"), JSON.stringify(requests.map((r) => r.method)));
	check("then one POST", posts(requests).length === 1);
}
{
	const { engine, requests } = piper((r) => (r.method === "GET" ? json(200, ["not", "piper"]) : { status: 200, body: WAV() }));
	const err = await caught(engine.synthesize(req(chunk(SECRET_TEXT)), sig()));
	check("refused with EngineUnavailableError", err instanceof EngineUnavailableError, String(err));
	check("no POST", posts(requests).length === 0);
	check("the reason does not carry the text", !String(err?.message).includes("ZSECRETZ"));
}
{
	let refuse = false;
	const { engine, requests } = piper((r) => {
		if (r.method === "POST" && refuse) return Promise.reject(new Error(`ECONNRESET ${SECRET_TEXT}`));
		return defaultAnswer(r);
	});
	await engine.synthesize(req(chunk("One.")), sig());
	refuse = true;
	const err = await caught(engine.synthesize(req(chunk(SECRET_TEXT)), sig()));
	check("a dropped connection: EngineUnavailableError", err instanceof EngineUnavailableError, String(err));
	check("a dropped connection: the caught error's text is not echoed", !String(err?.message).includes("ZSECRETZ"), err?.message);
	refuse = false;
	const getsBefore = gets(requests).length;
	await engine.synthesize(req(chunk("Two.")), sig());
	check("the next job re-probes first", gets(requests).length === getsBefore + 1);
}
for (const [name, bad] of [
	["a 500", (): PiperResponse => ({ status: 500, body: bytes(`error while speaking ${SECRET_TEXT}`) })],
	["a non-WAV 200", (): PiperResponse => ({ status: 200, body: bytes(`not audio ${SECRET_TEXT} padding padding padding padding`) })],
] as const) {
	let fail = true;
	const { engine, requests } = piper((r) => (r.method === "POST" && fail ? bad() : defaultAnswer(r)));
	const err = await caught(engine.synthesize(req(chunk(SECRET_TEXT)), sig()));
	check(`${name}: rejected`, err !== null);
	check(`${name}: the server's body is not echoed (non-negotiable 1)`, err !== null && !err.message.includes("ZSECRETZ"), err?.message);
	if (name === "a 500") check(`${name}: says the status`, err?.message === "Piper server answered 500.", err?.message);
	check(`${name}: the cached answer is dropped`, !engine.lastAvailability().available);
	fail = false;
	const getsBefore = gets(requests).length;
	await engine.synthesize(req(chunk("Next.")), sig());
	check(`${name}: the next job re-probes before sending text (F3)`, gets(requests).length === getsBefore + 1 && requests[requests.length - 2]?.method === "GET");
}

// --- P6: confirmManualEngine -------------------------------------------------

console.log("P6 confirmManualEngine probes Piper and leaves every other engine alone");
{
	const { engine, requests } = piper();
	const result = await confirmManualEngine(engine);
	check("one GET for Piper", requests.length === 1 && requests[0]!.method === "GET");
	check("and its answer", result?.available === true);
	check("voices cached for the pinned-voice step", (await engine.listVoices()).length === 3);
	let probed = 0;
	const other = {
		id: "espeak",
		isAvailable: async () => {
			probed += 1;
			return { available: true };
		},
	} as unknown as SpeechEngine;
	check("null for another engine", (await confirmManualEngine(other)) === null);
	check("and that engine's isAvailable was never called", probed === 0);
}

// --- P7: one at a time, and Stop -------------------------------------------

console.log("P7 requests are serialized, and Stop drops queued work");
{
	const releases: Array<() => void> = [];
	const { engine, requests } = piper((r) =>
		r.method === "POST" ? new Promise<PiperResponse>((resolve) => releases.push(() => resolve({ status: 200, body: WAV() }))) : defaultAnswer(r),
	);
	await engine.check();
	const first = engine.synthesize(req(chunk("One.", 0)), sig());
	const second = engine.synthesize(req(chunk("Two.", 1)), sig());
	for (let i = 0; i < 5; i++) await tick();
	check("only the first POST is out", posts(requests).length === 1, String(posts(requests).length));
	releases.shift()!();
	await first;
	for (let i = 0; i < 5; i++) await tick();
	check("the second goes once the first settled", posts(requests).length === 2);
	releases.shift()!();
	await second;

	const stopper = new AbortController();
	const inflight = engine.synthesize(req(chunk("Three.", 2)), stopper.signal);
	const queued = engine.synthesize(req(chunk("Four.", 3)), stopper.signal);
	for (let i = 0; i < 5; i++) await tick();
	engine.cancelPending();
	stopper.abort();
	const e1 = await caught(inflight);
	const e2 = await caught(queued);
	check("the in-flight job is abandoned as an abort", e1?.name === "AbortError", String(e1?.name));
	check("the queued job is dropped as an abort", e2?.name === "AbortError", String(e2?.name));
	releases.shift()?.();
	for (let i = 0; i < 5; i++) await tick();
	check("the queued job was never sent", posts(requests).length === 3, String(posts(requests).length));
}
{
	console.log("P7b an abandoned in-flight result does not advance the Player");
	let release: (() => void) | null = null;
	const { engine } = piper((r) =>
		r.method === "POST" ? new Promise<PiperResponse>((resolve) => (release = () => resolve({ status: 200, body: WAV() }))) : defaultAnswer(r),
	);
	fakeAudio = undefined;
	const player = new Player({ bufferAhead: 0 });
	const progress: number[] = [];
	player.on("progress", (p) => progress.push(p.chunkIndex));
	const playing = player.play(engine, [chunk("One.", 0), chunk("Two.", 1)], 1, 0);
	for (let i = 0; i < 10; i++) await tick();
	player.stop();
	await playing.catch(() => undefined);
	(release as (() => void) | null)?.();
	for (let i = 0; i < 10; i++) await tick();
	const audioAfter = fakeAudio as FakeAudio | undefined;
	check("nothing was played after Stop", !audioAfter?.src, String(audioAfter?.src));
	// One progress event is the "preparing" announcement play() makes up front.
	check("no chunk was announced as playing, none advanced", progress.length === 1 && progress[0] === 0, JSON.stringify(progress));
	check("the player is idle", player.getState() === "idle", player.getState());
}

// --- P8: withDeadline and the requestUrl adapter ---------------------------

console.log("P8 withDeadline and the requestUrl mapping");
{
	const never = new Promise<number>(() => undefined);
	const timeout = await caught(withDeadline(never, 5));
	check("times out with a fixed message", timeout?.message === "Timed out.", timeout?.message);
	const ac = new AbortController();
	const pending = caught(withDeadline(never, 10_000, ac.signal));
	ac.abort();
	check("aborts with AbortError", (await pending)?.name === "AbortError");
	check("passes a value through", (await withDeadline(Promise.resolve(7), 100)) === 7);

	const seen: unknown[] = [];
	const transport = makeRequestUrlTransport(async (p) => {
		seen.push(p);
		return { status: 503, arrayBuffer: bytes("x") };
	});
	const res = await transport({ method: "POST", url: "http://127.0.0.1:5011/synthesize", contentType: "application/json", body: "{}", timeoutMs: 1 });
	const p = seen[0] as Record<string, unknown>;
	check("requestUrl gets throw: false, so an error status is an answer", p.throw === false);
	check("url, method, content type and body passed through", p.url === "http://127.0.0.1:5011/synthesize" && p.method === "POST" && p.contentType === "application/json" && p.body === "{}");
	check("status and arrayBuffer mapped", res.status === 503 && res.body.byteLength === 1);
	const refused = makeRequestUrlTransport(() => Promise.reject(new Error("net::ERR_CONNECTION_REFUSED")));
	check("a refused connection rejects (no answer arrived)", (await caught(refused({ method: "GET", url: "u", timeoutMs: 1 }))) !== null);

	const { engine } = piper(() => new Promise<PiperResponse>(() => undefined));
	const start = Date.now();
	// A hung server: the probe gives up at its deadline rather than holding the read.
	const hung = await engine.check();
	check("a hung server: the probe times out unavailable", !hung.available && /No Piper server answered/.test((hung as { reason: string }).reason));
	check("within about the probe timeout", Date.now() - start < PROBE_TIMEOUT_MS + 1000, String(Date.now() - start));
}

// --- P9: never the network routes ------------------------------------------

console.log("P9 every request the suite saw went to an allowed path, and the source names no other");
{
	const paths = new Set(allRequests.map((r) => r.url.replace(/^http:\/\/[^/]+/, "")));
	check("ALLOWED_PATHS is /voices and /synthesize", JSON.stringify([...ALLOWED_PATHS].sort()) === JSON.stringify(["/synthesize", "/voices"]));
	check("every recorded path is allowed", [...paths].every((p) => ALLOWED_PATHS.includes(p)), JSON.stringify([...paths]));
	// The engine's one exit to the network refuses any other path, whatever a
	// future edit asks it to send. Reached through the private method on purpose.
	const { engine: guarded, requests: guardedRequests } = piper();
	const send = (guarded as unknown as { send: (port: number, path: string, r: object) => Promise<unknown> }).send.bind(guarded);
	for (const path of ["/download", "/all-voices", "/info", "/", "/voices?x=1"]) {
		const err = await caught(send(DEFAULT_PIPER_PORT, path, { method: "GET", timeoutMs: 50 }));
		check(`send() refuses ${path}`, err !== null);
	}
	check("and none of those reached the transport", guardedRequests.length === 0, String(guardedRequests.length));
	check("parseVoices rejects a non-object", parseVoices("x") === null && parseVoices(null) === null);
	const dir = "src/engines/piper";
	for (const file of readdirSync(dir)) {
		const source = readFileSync(`${dir}/${file}`, "utf8");
		check(
			`${file}: no download, all-voices or info path literal`,
			!/["'`]\/?(download|all-voices|info)\b/.test(source),
		);
		check(`${file}: no trace() call (non-negotiable 1)`, !/(?<!`)\btrace\(/.test(source));
		check(`${file}: no fetch or Node http`, !/\bfetch\(|["'](node:)?https?["']/.test(source));
	}
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all piper tests passed");
