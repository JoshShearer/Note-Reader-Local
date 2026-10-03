/**
 * The Read Me Offline bridge engine (NRL-130, docs/adr/0036).
 *
 * Drives the real `ReadMeBridgeEngine` against a fake transport that records
 * every request, and drives it through the real `Player` and the real
 * `playWithFallback` with the FakeAudio/Blob/URL/rAF mocking block that
 * tests/player.test.ts and tests/fallback.test.ts use. No socket, no
 * obsidian import.
 *
 * The rate checks are the reason this file exists. The bridge renders at
 * whatever rate it is asked for, and the player applies the user's rate to
 * every buffer it plays, so an engine that forwarded the user's rate would
 * be heard at rate squared: 4x at a 2x setting (non-negotiable 9).
 */

import { Player } from "../src/audio/player.ts";
import { playWithFallback, stopsFallback, type FallbackCandidate } from "../src/audio/fallback.ts";
import { pcmToWav } from "../src/audio/wav.ts";
import { rankEngines, selectEngine } from "../src/engines/selection.ts";
import { shouldConstructBridgeEngine } from "../src/engines/platform.ts";
import { normaliseSettings, DEFAULT_SETTINGS } from "../src/settings/index.ts";
import {
	BRIDGE_HOST,
	BridgeBusyError,
	HEALTH_TIMEOUT_MS,
	ReadMeBridgeEngine,
	type BridgeRequest,
	type BridgeResponse,
	type BridgeTransport,
} from "../src/engines/bridge/readMe.ts";
import { EngineUnavailableError, type SpeechChunk, type SpeechEngine, type SynthResult } from "../src/audio/types.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

// --- Browser stand-ins (same block as tests/fallback.test.ts) -------------

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

let fakeAudio!: FakeAudio;
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
(globalThis as Record<string, unknown>).DOMException = class extends Error {
	constructor(message: string, name: string) {
		super(message);
		this.name = name;
	}
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Every `rate=` value in a URL's query. (`URL` itself is stubbed above.) */
function rateParams(url: string): string[] {
	return [...url.matchAll(/[?&]rate=([^&]*)/g)].map((m) => decodeURIComponent(m[1] ?? ""));
}

// --- Fixtures ---------------------------------------------------------------

const SECRET_TEXT = "ZSECRETZ the note says this.";
const TOKEN = "0123456789abcdef0123456789abcdef";

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

/** One second of 22,050 Hz mono silence, the shape Android's TTS writes. */
const WAV_1S = pcmToWav(new Int16Array(22050).buffer, 22050);

function json(status: number, body: unknown): BridgeResponse {
	const bytes = new TextEncoder().encode(JSON.stringify(body));
	return { status, header: () => "application/json", body: bytes.buffer as ArrayBuffer };
}

const HEALTHY = {
	ok: true,
	version: 1,
	ttsReady: true,
	engine: "com.google.android.tts",
	voice: "en-us-x-iol-local",
	port: 8787,
	busy: false,
	maxChars: 3900,
};

/** A transport that records requests and answers from a route table. */
function fakeTransport(
	answer: (req: BridgeRequest) => BridgeResponse | Promise<BridgeResponse>,
): { transport: BridgeTransport; requests: BridgeRequest[] } {
	const requests: BridgeRequest[] = [];
	return {
		requests,
		transport: async (req) => {
			requests.push(req);
			return await answer(req);
		},
	};
}

function healthyBridge(): BridgeResponse | ((req: BridgeRequest) => BridgeResponse) {
	return (req: BridgeRequest) =>
		req.url.endsWith("/health")
			? json(200, HEALTHY)
			: { status: 200, header: () => "audio/wav", body: WAV_1S.slice(0) };
}

function engineWith(
	answer: (req: BridgeRequest) => BridgeResponse | Promise<BridgeResponse>,
	config = { port: 8787, token: TOKEN },
): { engine: ReadMeBridgeEngine; requests: BridgeRequest[] } {
	const { transport, requests } = fakeTransport(answer);
	return { engine: new ReadMeBridgeEngine(() => config, transport), requests };
}

async function caught(p: Promise<unknown>): Promise<Error | null> {
	try {
		await p;
		return null;
	} catch (err) {
		return err as Error;
	}
}

// --- B1: the rate on the wire is always 1.0 ---------------------------------

console.log("B1 /synthesize is always asked for rate=1.0, whatever the user's rate");
for (const rate of [0.5, 1, 1.7, 2]) {
	const { engine, requests } = engineWith(healthyBridge() as (r: BridgeRequest) => BridgeResponse);
	await engine.synthesize({ chunk: chunk(SECRET_TEXT), rate, pitch: 0 }, new AbortController().signal);
	const url = requests[0]?.url ?? "";
	const rates = rateParams(url);
	check(`rate ${rate}: query rate is exactly "1.0"`, rates[0] === "1.0", url);
	check(`rate ${rate}: no other rate parameter`, rates.length === 1, url);
}

// --- B2: text in the body, token in a header, loopback only ----------------

console.log("B2 text goes in the POST body and the token in a header, to 127.0.0.1 only");
{
	const { engine, requests } = engineWith(healthyBridge() as (r: BridgeRequest) => BridgeResponse, {
		port: 8790,
		token: `  ${TOKEN}  `,
	});
	await engine.synthesize({ chunk: chunk(SECRET_TEXT), rate: 2, pitch: 0 }, new AbortController().signal);
	const req = requests[0]!;
	check("method is POST", req.method === "POST", req.method);
	check("body is the chunk text, exactly", req.body === SECRET_TEXT, String(req.body));
	check("the URL never carries the text", !req.url.includes("ZSECRETZ") && !req.url.includes("note"), req.url);
	check("the URL never carries the token", !req.url.includes(TOKEN), req.url);
	check("Authorization is Bearer <trimmed token>", req.headers.Authorization === `Bearer ${TOKEN}`, req.headers.Authorization);
	check("host is the IPv4 loopback and the port is the configured one", req.url.startsWith(`http://${BRIDGE_HOST}:8790/`), req.url);
	check("BRIDGE_HOST is 127.0.0.1 (not localhost, not ::1)", BRIDGE_HOST === "127.0.0.1", BRIDGE_HOST);
}

// --- B3: the result is a buffer the player can play ------------------------

console.log("B3 a 200 WAV becomes a buffer result with its real duration and no word timings");
{
	const { engine } = engineWith(healthyBridge() as (r: BridgeRequest) => BridgeResponse);
	const result: SynthResult = await engine.synthesize(
		{ chunk: chunk("Hello."), rate: 1, pitch: 0 },
		new AbortController().signal,
	);
	check("kind is buffer", result.kind === "buffer", result.kind);
	if (result.kind === "buffer") {
		check("duration read from the WAV header", Math.abs(result.durationMs - 1000) < 1, String(result.durationMs));
		check("sample rate read from the WAV header", result.sampleRate === 22050, String(result.sampleRate));
		check("no word timings are invented", result.words.length === 0, String(result.words.length));
	}
	check("declares timing none", engine.capabilities.timing === "none");
	check("is a buffer engine: ownsPlayback false", engine.capabilities.ownsPlayback === false);
	check("not desktop-only", engine.capabilities.desktopOnly === false);
}

// --- B4: the whole chain at 2.0 is 2.0, not 4.0 ------------------------------

console.log("B4 through the real Player at a 2.0 setting: element 2.0 x bridge 1.0 = 2.0 total");
{
	const { engine, requests } = engineWith(healthyBridge() as (r: BridgeRequest) => BridgeResponse);
	const player = new Player({ bufferAhead: 1 });
	void player.play(engine, [chunk("One."), chunk("Two.", 1)], 2.0, 0);
	for (let i = 0; i < 20 && player.getState() !== "playing"; i++) await tick();
	const synth = requests.filter((r) => r.url.includes("/synthesize"));
	const bridgeRate = Number(rateParams(synth[0]?.url ?? "")[0]);
	check("player reached playing", player.getState() === "playing", player.getState());
	check("element playbackRate is exactly 2.0", fakeAudio.playbackRate === 2, String(fakeAudio.playbackRate));
	check("bridge rendered at exactly 1.0", bridgeRate === 1, String(bridgeRate));
	check(
		"total speed-up is exactly 2.0 (4.0 would be the double-rate defect)",
		fakeAudio.playbackRate * bridgeRate === 2,
		String(fakeAudio.playbackRate * bridgeRate),
	);
	player.stop();
}

// --- B5: availability -------------------------------------------------------

console.log("B5 availability is probed on /health with a short timeout and never throws");
{
	const { engine, requests } = engineWith(() => json(200, HEALTHY));
	const result = await engine.isAvailable();
	check("healthy bridge with a token: available", result.available, JSON.stringify(result));
	check("probe is a GET of /health", requests[0]?.method === "GET" && requests[0].url.endsWith("/health"), requests[0]?.url);
	check("probe sends no token (the route is unauthenticated)", Object.keys(requests[0]?.headers ?? {}).length === 0);
	check("probe timeout is short (<= 2 s)", (requests[0]?.timeoutMs ?? Infinity) <= 2000 && HEALTH_TIMEOUT_MS <= 2000);
	check("last health is kept for the settings UI", engine.lastHealth()?.voice === HEALTHY.voice);
	const voices = await engine.listVoices();
	check("lists the voice /health reports, without vouching for it", voices.length === 1 && voices[0]!.local === "unknown");
}
{
	const { engine } = engineWith(() => Promise.reject(new TypeError("Failed to fetch")));
	const result = await engine.isAvailable();
	check("nothing listening: unavailable, not thrown", result.available === false);
	check(
		"nothing listening: says to install and turn on Read Me Offline",
		!result.available && /Read Me Offline/.test(result.reason) && /turn on/.test(result.reason),
		!result.available ? result.reason : "",
	);
	check("nothing listening: no stale health kept", engine.lastHealth() === null);
}
{
	const { engine } = engineWith(() => json(200, HEALTHY), { port: 8787, token: "" });
	const result = await engine.isAvailable();
	check(
		"no token yet: unavailable, and says where the token comes from",
		!result.available && /pairing token/.test(result.reason),
		!result.available ? result.reason : "available",
	);
}
{
	const { engine } = engineWith(() => json(200, { ...HEALTHY, version: 2 }));
	const result = await engine.isAvailable();
	check("another contract version: unavailable", !result.available && /version 2/.test(result.reason));
}
{
	const { engine } = engineWith(() => json(200, { ...HEALTHY, ttsReady: false }));
	check("speech engine not ready: unavailable", !(await engine.isAvailable()).available);
}
{
	const { engine } = engineWith(() => ({
		status: 200,
		header: () => "text/html",
		body: new TextEncoder().encode("<html>").buffer as ArrayBuffer,
	}));
	const result = await engine.isAvailable();
	check("something else on the port: unavailable", !result.available && /not Read Me/.test(result.reason));
}
{
	const { engine, requests } = engineWith(() => json(200, HEALTHY), { port: 70000, token: TOKEN });
	const result = await engine.isAvailable();
	check("invalid port: unavailable and nothing is requested", !result.available && requests.length === 0);
}

// --- B6: failures a user can act on, and none leaks text or token ----------

console.log("B6 each contract error becomes a clear message that carries no note text and no token");
const statuses: Array<[string, BridgeResponse]> = [
	["401", json(401, { error: "unauthorized" })],
	["503 busy", json(503, { error: "busy", reason: "playback" })],
	["503 tts-not-ready", json(503, { error: "tts-not-ready" })],
	["413", json(413, { error: "too-long", maxChars: 10 })],
	["500", json(500, { error: "internal" })],
];
const errors = new Map<string, Error>();
for (const [name, res] of statuses) {
	const { engine } = engineWith((req) => (req.url.endsWith("/health") ? json(200, HEALTHY) : res));
	const err = await caught(engine.synthesize({ chunk: chunk(SECRET_TEXT), rate: 1, pitch: 0 }, new AbortController().signal));
	errors.set(name, err ?? new Error("did not throw"));
	check(`${name}: throws`, err !== null);
	check(`${name}: message carries no note text`, !!err && !err.message.includes("ZSECRETZ"), err?.message);
	check(`${name}: message carries no token`, !!err && !err.message.includes(TOKEN), err?.message);
}
check("401: says the token was rejected", /token/.test(errors.get("401")!.message), errors.get("401")!.message);
check("401: is an EngineUnavailableError", errors.get("401") instanceof EngineUnavailableError);
check("503 busy: a BridgeBusyError", errors.get("503 busy") instanceof BridgeBusyError);
check("503 busy: says Read Me is reading aloud itself", /reading aloud/.test(errors.get("503 busy")!.message));
check("503 busy: ends the read instead of falling back", stopsFallback(errors.get("503 busy")!));
check("503 tts-not-ready: does fall back (only busy is terminal)", !stopsFallback(errors.get("503 tts-not-ready")!));
check("guard: an ordinary Error does not stop the fallback chain", !stopsFallback(new Error("x")));

{
	const { engine } = engineWith(() => json(200, HEALTHY), { port: 8787, token: " " });
	const err = await caught(engine.synthesize({ chunk: chunk("Hi."), rate: 1, pitch: 0 }, new AbortController().signal));
	check("no token: synthesize refuses before sending anything", err instanceof EngineUnavailableError, err?.message);
}
{
	const controller = new AbortController();
	const { engine } = engineWith(() => {
		controller.abort();
		return Promise.reject(new Error("aborted by signal"));
	});
	const err = await caught(engine.synthesize({ chunk: chunk("Hi."), rate: 1, pitch: 0 }, controller.signal));
	check("a Stop mid-request surfaces as AbortError, not a bridge failure", err?.name === "AbortError", err?.name);
}

// --- B6b: requests are serialized; a full queue is not "Read Me is playing"

console.log("B6b one request at a time, so a prefetching player never overruns the bridge's queue");
{
	let inFlight = 0;
	let maxInFlight = 0;
	const { engine, requests } = engineWith(async (req) => {
		if (req.url.endsWith("/health")) return json(200, HEALTHY);
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((r) => setTimeout(r, 5));
		inFlight--;
		return { status: 200, header: () => "audio/wav", body: WAV_1S.slice(0) };
	});
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, i) =>
			engine.synthesize({ chunk: chunk(`Sentence ${i}.`, i), rate: 1, pitch: 0 }, new AbortController().signal),
		),
	);
	check("8 parallel calls: all succeed", results.every((r) => r.kind === "buffer"));
	check("8 parallel calls: never more than one in flight", maxInFlight === 1, String(maxInFlight));
	check(
		"8 parallel calls: sent in call order",
		requests.map((r) => r.body).join("|") === Array.from({ length: 8 }, (_, i) => `Sentence ${i}.`).join("|"),
	);
}
{
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const { engine, requests } = engineWith(async () => {
		await gate;
		return { status: 200, header: () => "audio/wav", body: WAV_1S.slice(0) };
	});
	const first = engine.synthesize({ chunk: chunk("First."), rate: 1, pitch: 0 }, new AbortController().signal);
	const controller = new AbortController();
	const second = engine.synthesize({ chunk: chunk("Second."), rate: 1, pitch: 0 }, controller.signal);
	controller.abort();
	release();
	await first;
	const err = await caught(second);
	check("a request aborted while queued is never sent", requests.length === 1, String(requests.length));
	check("a request aborted while queued rejects with AbortError", err?.name === "AbortError", err?.name);
	const third = await engine.synthesize({ chunk: chunk("Third."), rate: 1, pitch: 0 }, new AbortController().signal);
	check("the queue keeps working after an aborted waiter", third.kind === "buffer");
}
{
	const { engine } = engineWith(() => json(503, { error: "busy", reason: "queue" }));
	const err = await caught(engine.synthesize({ chunk: chunk("Hi."), rate: 1, pitch: 0 }, new AbortController().signal));
	check("503 busy/queue: not a BridgeBusyError", !(err instanceof BridgeBusyError), err?.name);
	check("503 busy/queue: does not end the read (the defect seen on the MatePad)", !!err && !stopsFallback(err));
}

// --- B7: a busy bridge ends the read, it does not fall to Kokoro -----------

console.log("B7 a busy bridge on the first sentence stops the read and never tries the next engine");
{
	const { engine } = engineWith((req) =>
		req.url.endsWith("/health") ? json(200, HEALTHY) : json(503, { error: "busy", reason: "playback" }),
	);
	let secondTried = false;
	const second: SpeechEngine = {
		...engine,
		id: "kokoro",
		label: "next",
		capabilities: engine.capabilities,
		isAvailable: async () => ({ available: true }),
		listVoices: async () => [],
		selectVoice: async () => {},
		synthesize: async () => {
			secondTried = true;
			throw new Error("should not run");
		},
		dispose: async () => {},
	};
	const player = new Player({ bufferAhead: 0 });
	player.on("error", () => undefined);
	let stoppedOn: string | null = null;
	let fellBack = false;
	const candidates: FallbackCandidate[] = [
		{ engine, id: "readme", reason: "" },
		{ engine: second, id: "kokoro", reason: "" },
	];
	const result = await playWithFallback(player, candidates, [chunk("One.")], 2, 0, {
		onStop: (c) => {
			stoppedOn = c.id;
		},
		onFallback: () => {
			fellBack = true;
		},
	});
	check("no candidate is reported as succeeding", result === null);
	check("onStop names the bridge", stoppedOn === "readme", String(stoppedOn));
	check("onFallback never fired", !fellBack);
	check("the next engine was never asked to synthesize", !secondTried);
}

// --- B8: where it exists, how it ranks, how its setting is stored ----------

console.log("B8 constructed on Android only, ranked first when available, port validated");
check("Android app: constructed", shouldConstructBridgeEngine({ isAndroidApp: true }));
check("anything else (desktop, iOS): not constructed", !shouldConstructBridgeEngine({ isAndroidApp: false }));
{
	const ranked = rankEngines([
		{ id: "readme", available: true },
		{ id: "kokoro", available: true, kokoroGpuFp32Live: true },
		{ id: "webspeech", available: true },
	]);
	check("available bridge ranks first, above even a live-GPU Kokoro", ranked[0]?.id === "readme", JSON.stringify(ranked.map((r) => r.id)));
	const without = rankEngines([
		{ id: "readme", available: false },
		{ id: "kokoro", available: true, kokoroGpuFp32Live: false },
	]);
	check("unavailable bridge is not ranked; Kokoro is still chosen", without.length === 1 && without[0]?.id === "kokoro");
	check(
		"desktop unchanged: with no bridge probe at all the order is the old one",
		JSON.stringify(rankEngines([{ id: "speechd", available: true }, { id: "espeak", available: true }]).map((r) => r.id)) ===
			JSON.stringify(["speechd", "espeak"]),
	);
}
{
	const none = selectEngine([
		{ id: "kokoro", available: false },
		{ id: "readme", available: false },
		{ id: "webspeech", available: false },
	]);
	check(
		"Android with nothing ready: points at the bridge, not at espeak-ng or a Kokoro download",
		none.id === "readme" && /Read Me Offline/.test(none.reason) && !/espeak/.test(none.reason),
		JSON.stringify(none),
	);
	const desktopNone = selectEngine([{ id: "kokoro", available: false }, { id: "speechd", available: false }]);
	check("desktop with nothing ready: unchanged advice", desktopNone.id === "kokoro" && /espeak-ng/.test(desktopNone.reason));
}
check("default port is 8787", DEFAULT_SETTINGS.bridgePort === 8787);
check("a stored port round-trips", normaliseSettings({ bridgePort: 8790 }).bridgePort === 8790);
check("a garbage port falls back to the default", normaliseSettings({ bridgePort: "x" }).bridgePort === 8787);
check("an out-of-range port is clamped", normaliseSettings({ bridgePort: 99999 }).bridgePort === 65535);
check("a manual 'readme' pin is a valid engine selection", normaliseSettings({ engine: "readme" }).engine === "readme");
check("the token is not a setting (it lives in device-local storage)", !("bridgeToken" in DEFAULT_SETTINGS));
check(
	"unknown keys survive normalisation (non-negotiable 10)",
	(normaliseSettings({ bridgePort: 8787, positions: { a: 1 } }) as unknown as Record<string, unknown>).positions !== undefined,
);

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all bridge tests passed");
