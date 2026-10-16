/**
 * The Read Me Offline bridge engine (NRL-130, docs/adr/0036).
 *
 * Drives the real `ReadMeBridgeEngine` against a fake transport that records
 * every request, and drives it through the real `Player` and the real
 * `playWithFallback` with the FakeAudio/Blob/URL/rAF mocking block that
 * tests/player.test.ts and tests/fallback.test.ts use. No socket, no
 * obsidian import.
 *
 * Since Read Me's ADR 0014 the engine owns playback: Read Me reads the note
 * in its own service (`/play`, `/status`, `/control`), because Android muted
 * Obsidian's own audio about 5 s after Obsidian left the screen. The rate
 * checks still matter: Read Me applies the user's rate at synthesis, so the
 * player must apply none, or the note is heard at rate squared
 * (non-negotiable 9).
 */

import { Player } from "../src/audio/player.ts";
import { playWithFallback, stopsFallback, type FallbackCandidate } from "../src/audio/fallback.ts";
import { rankEngines, selectEngine } from "../src/engines/selection.ts";
import { shouldConstructBridgeEngine } from "../src/engines/platform.ts";
import { normaliseSettings, DEFAULT_SETTINGS } from "../src/settings/index.ts";
import {
	BRIDGE_HOST,
	BridgeBusyError,
	BridgeStoppedError,
	PLAY_MAX_CHUNKS,
	HEALTH_TIMEOUT_MS,
	ReadMeBridgeEngine,
	type BridgeRequest,
	type BridgeResponse,
	type BridgeTransport,
} from "../src/engines/bridge/readMe.ts";
import { EngineUnavailableError, type SpeechChunk, type SpeechEngine, type SynthRequest } from "../src/audio/types.ts";

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
	play: true,
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

/**
 * Read Me's side of `/play`, `/status` and `/control`, in memory. Each
 * `/status` while playing reports the current chunk and then moves on by
 * `step`, standing in for Read Me reading; `ended` after the last.
 */
class FakeReadMe {
	session = 0;
	state = "none";
	index = 0;
	chunks: string[] = [];
	step = 1;
	busy = false;
	controls: string[] = [];
	answer = (req: BridgeRequest): BridgeResponse => {
		const path = req.url.replace(/^http:\/\/[^/]+/, "");
		if (path === "/health") return json(200, HEALTHY);
		if (path.startsWith("/play")) {
			if (this.busy) return json(503, { error: "busy", reason: "playback" });
			this.chunks = String(req.body).split("\u001e");
			this.session += 1;
			this.state = "playing";
			this.index = 0;
			return json(200, { session: this.session, chunks: this.chunks.length });
		}
		if (path === "/status") {
			const now = { session: this.session, state: this.state, index: this.index };
			if (this.state === "playing") {
				this.index += this.step;
				if (this.index >= this.chunks.length) {
					this.index = this.chunks.length - 1;
					this.state = "ended";
				}
			}
			return json(200, now);
		}
		if (path.startsWith("/control")) {
			this.controls.push(path);
			const session = Number(/session=(\d+)/.exec(path)?.[1]);
			if (session !== this.session) return json(409, { error: "stale-session", session: this.session });
			if (path.includes("action=pause")) this.state = "paused";
			if (path.includes("action=resume")) this.state = "playing";
			if (path.includes("action=stop")) this.state = "stopped";
			return json(200, { session: this.session, state: this.state, index: this.index });
		}
		return json(404, { error: "not-found" });
	};
}

function engineWith(
	answer: (req: BridgeRequest) => BridgeResponse | Promise<BridgeResponse>,
	config = { port: 8787, token: TOKEN },
): { engine: ReadMeBridgeEngine; requests: BridgeRequest[] } {
	const { transport, requests } = fakeTransport(answer);
	return { engine: new ReadMeBridgeEngine(() => config, transport, () => tick()), requests };
}

function readMe(config = { port: 8787, token: TOKEN }): { fake: FakeReadMe; engine: ReadMeBridgeEngine; requests: BridgeRequest[] } {
	const fake = new FakeReadMe();
	return { fake, ...engineWith(fake.answer, config) };
}

function req(c: SpeechChunk, rate = 1, following: SpeechChunk[] = []): SynthRequest {
	return { chunk: c, rate, pitch: 0, following: () => following };
}

const plays = (requests: BridgeRequest[]): BridgeRequest[] => requests.filter((r) => r.url.includes("/play"));

async function caught(p: Promise<unknown>): Promise<Error | null> {
	try {
		await p;
		return null;
	} catch (err) {
		return err as Error;
	}
}

// --- B1: the user's rate goes to Read Me, once -------------------------------

console.log("B1 /play carries the user's rate, and nothing else does");
for (const rate of [0.5, 1, 1.7, 2]) {
	const { engine, requests } = readMe();
	await engine.synthesize(req(chunk(SECRET_TEXT), rate), new AbortController().signal);
	const url = plays(requests)[0]?.url ?? "";
	const rates = rateParams(url);
	check(`rate ${rate}: /play asks for exactly ${rate.toFixed(2)}`, rates[0] === rate.toFixed(2), url);
	check(`rate ${rate}: no other rate parameter`, rates.length === 1, url);
	check(`rate ${rate}: no request but /play carries a rate`, requests.filter((r) => /rate=/.test(r.url)).length === 1);
}

// --- B2: text in the body, token in a header, loopback only ----------------

console.log("B2 the chunks go in the POST body and the token in a header, to 127.0.0.1 only");
{
	const { engine, requests } = readMe({ port: 8790, token: `  ${TOKEN}  ` });
	await engine.synthesize(req(chunk(SECRET_TEXT), 2, [chunk("Second.", 1)]), new AbortController().signal);
	const play = plays(requests)[0]!;
	check("method is POST", play.method === "POST", play.method);
	check("body is the chunks, separated by U+001E", play.body === `${SECRET_TEXT}\u001eSecond.`, JSON.stringify(play.body));
	for (const r of requests) {
		check(`${r.method} ${r.url.replace(/\?.*/, "")}: the URL never carries the text`, !r.url.includes("ZSECRETZ") && !r.url.includes("note"), r.url);
		check(`${r.method} ${r.url.replace(/\?.*/, "")}: the URL never carries the token`, !r.url.includes(TOKEN), r.url);
		check(`${r.method} ${r.url.replace(/\?.*/, "")}: to the IPv4 loopback and the configured port`, r.url.startsWith(`http://${BRIDGE_HOST}:8790/`), r.url);
	}
	check("Authorization is Bearer <trimmed token>", play.headers.Authorization === `Bearer ${TOKEN}`, play.headers.Authorization);
	check("BRIDGE_HOST is 127.0.0.1 (not localhost, not ::1)", BRIDGE_HOST === "127.0.0.1", BRIDGE_HOST);
}

// --- B3: the engine owns playback ------------------------------------------

console.log("B3 the engine owns playback: a streamed result, no buffer, no word timings");
{
	const { engine } = readMe();
	const result = await engine.synthesize(req(chunk("Hello.")), new AbortController().signal);
	check("kind is streamed", result.kind === "streamed", result.kind);
	check("declares timing none", engine.capabilities.timing === "none");
	check("ownsPlayback true (Read Me's ADR 0014)", engine.capabilities.ownsPlayback === true);
	check("pause and resume are a pair", engine.capabilities.pause && engine.capabilities.resume);
	check("not desktop-only", engine.capabilities.desktopOnly === false);
}

// --- B4: the whole chain through the real Player ----------------------------

console.log("B4 through the real Player at 2.0: one /play at 2.00 for the whole note, the element untouched");
{
	const { fake, engine, requests } = readMe();
	const player = new Player({ bufferAhead: 1 });
	const progress: number[] = [];
	player.on("progress", (p) => progress.push(p.chunkIndex));
	const notes = [chunk("One.", 0), chunk("Two.", 1), chunk("Three.", 2)];
	void player.play(engine, notes, 2.0, 0);
	for (let i = 0; i < 200 && player.getState() !== "finished"; i++) await tick();
	check("player reached finished", player.getState() === "finished", player.getState());
	check("exactly one /play for three chunks", plays(requests).length === 1, String(plays(requests).length));
	check("Read Me got all three chunks", fake.chunks.join("|") === "One.|Two.|Three.", fake.chunks.join("|"));
	check("Read Me reads at exactly 2.00", rateParams(plays(requests)[0]!.url)[0] === "2.00");
	check("the player's own element never played (4.0 would be the double-rate defect)", fakeAudio === undefined || fakeAudio.src === "");
	check("the highlight visited every chunk in order", [0, 1, 2].every((i) => progress.includes(i)), JSON.stringify(progress));
}

console.log("B4b the session follows Read Me: past chunks resolve at once, a replay or a new rate starts again");
{
	const { fake, engine, requests } = readMe();
	fake.step = 0;
	const notes = [chunk("A.", 0), chunk("B.", 1), chunk("C.", 2)];
	const first = engine.synthesize(req(notes[0]!, 1, notes.slice(1)), new AbortController().signal);
	await tick();
	fake.index = 2; // Read Me read on while Obsidian was in the background.
	await first;
	await engine.synthesize(req(notes[1]!, 1, notes.slice(2)), new AbortController().signal);
	check("a chunk Read Me already read resolves without a new /play", plays(requests).length === 1);
	fake.state = "ended";
	await engine.synthesize(req(notes[2]!, 1, []), new AbortController().signal);
	check("the last chunk resolves once Read Me has ended", plays(requests).length === 1);
	fake.step = 1;
	await engine.synthesize(req(notes[0]!, 1, notes.slice(1)), new AbortController().signal);
	check("going back to an earlier chunk starts a new session", plays(requests).length === 2);
	await engine.synthesize(req(notes[1]!, 1.5, notes.slice(2)), new AbortController().signal);
	check("a new rate starts a new session at that rate", plays(requests).length === 3 && rateParams(plays(requests)[2]!.url)[0] === "1.50");
}

console.log("B4c what /play can carry: no separator inside a chunk, a blank chunk ends the session, the limit");
{
	const { fake, engine } = readMe();
	await engine.synthesize(req(chunk("Odd\u001etext.", 0), 1, [chunk("Fine.", 1), chunk("   ", 2), chunk("After.", 3)]), new AbortController().signal);
	check("a separator inside a chunk becomes a space, so indexes hold", fake.chunks.join("|") === "Odd text.|Fine.", fake.chunks.join("|"));
	const blank = await engine.synthesize(req(chunk("   ", 2), 1, [chunk("After.", 3)]), new AbortController().signal);
	check("a blank chunk resolves without asking Read Me", blank.kind === "streamed");
	const many = Array.from({ length: PLAY_MAX_CHUNKS + 5 }, (_, i) => chunk(`S${i}.`, i + 1));
	await engine.synthesize(req(chunk("Start.", 0), 1, many), new AbortController().signal);
	check(`at most ${PLAY_MAX_CHUNKS} chunks in one /play`, fake.chunks.length === PLAY_MAX_CHUNKS, String(fake.chunks.length));
}

console.log("B4d pause, resume and stop act on Read Me's session; a stop from Read Me ends the read");
{
	const { fake, engine } = readMe();
	fake.step = 0;
	const controller = new AbortController();
	const pending = engine.synthesize(req(chunk("One.", 0), 1, [chunk("Two.", 1)]), controller.signal);
	await tick();
	engine.pause();
	engine.resume();
	await tick();
	check("pause then resume reach /control with the session", fake.controls.join(",") === "/control?action=pause&session=1,/control?action=resume&session=1", fake.controls.join(","));
	controller.abort();
	const err = await caught(pending);
	await tick();
	check("an abort (the player's Stop) rejects with AbortError", err?.name === "AbortError", err?.name);
	check("and tells Read Me to stop", fake.controls.at(-1) === "/control?action=stop&session=1", fake.controls.join(","));
}
{
	const { fake, engine } = readMe();
	fake.step = 0;
	const pending = engine.synthesize(req(chunk("One.", 0), 1, [chunk("Two.", 1)]), new AbortController().signal);
	await tick();
	fake.state = "stopped"; // the lock screen's Stop, or an article started in Read Me
	const err = await caught(pending);
	check("Read Me stopping the session ends the read", err instanceof BridgeStoppedError, err?.name);
	check("and does not fall back to another engine", !!err && stopsFallback(err));
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
	const { play: _play, ...older } = HEALTHY;
	const { engine } = engineWith(() => json(200, older));
	const result = await engine.isAvailable();
	check("a Read Me without /play: unavailable, and says to update it", !result.available && /update it to 1\.1\.0/.test(result.reason), !result.available ? result.reason : "available");
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

{
	const { engine } = engineWith(() => json(503, { error: "busy", reason: "queue" }));
	const err = await caught(engine.synthesize({ chunk: chunk("Hi."), rate: 1, pitch: 0 }, new AbortController().signal));
	check("503 busy/queue: not a BridgeBusyError", !(err instanceof BridgeBusyError), err?.name);
	check("503 busy/queue: does not end the read", !!err && !stopsFallback(err));
}

// --- B7: a busy bridge ends the read, it does not fall to Kokoro -----------

console.log("B7 a busy bridge on the first sentence ends the read and never tries the next engine");
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
	const reported: Error[] = [];
	player.on("error", (err) => reported.push(err));
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
	for (let i = 0; i < 50 && reported.length === 0; i++) await tick();
	// An engine that owns playback is "playing" before its first request is
	// answered (player.ts announcePlaying), so the refusal arrives as the
	// player's error, not as a failed attempt: onStop does not fire, and the
	// read still ends where it is (plugin ADR 0037).
	check("the bridge is the candidate the read stayed on", result?.id === "readme", String(result?.id));
	check("Read Me's refusal reaches the player's error report", reported[0] instanceof BridgeBusyError, reported[0]?.name);
	check("onStop is not the route any more", stoppedOn === null, String(stoppedOn));
	check("onFallback never fired", !fellBack);
	check("the next engine was never asked to synthesize", !secondTried);
	check("the read ended", player.getState() !== "playing", player.getState());
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
