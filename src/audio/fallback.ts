import type { Player } from "./player";
import type { EngineId, SpeechChunk, SpeechEngine } from "./types";

/**
 * A genuine fallback chain: try the next engine when one fails to load or to
 * speak its first chunk, instead of sending the user to a dropdown (NRL-24).
 *
 * No obsidian import - this only touches `Player` and `SpeechEngine`, both
 * already obsidian-free, so it is testable with the exact FakeAudio harness
 * tests/player.test.ts already built.
 */

export interface FallbackCandidate {
	engine: SpeechEngine;
	id: EngineId;
	/** One sentence: why this candidate was chosen, or "Manually selected." */
	reason: string;
}

export interface FallbackHooks {
	/**
	 * Called once per attempt, before synthesis starts, so the caller can
	 * resolve/select that candidate's own voice and show a "Loading X..."
	 * Notice. A thrown error here counts as a load failure for that
	 * candidate, same as a synthesis failure.
	 */
	beforeAttempt?: (candidate: FallbackCandidate) => Promise<void>;
	/**
	 * Called when a candidate fails before its first chunk became audible,
	 * and another candidate remains. Never called for the last candidate
	 * (that failure is reported the existing way, by the Player's own
	 * persistent "error" listener in main.ts) and never called for a failure
	 * after real speech already started (out of scope: per-engine failure
	 * wording is NRL-25, and "already spoken text" protection is exactly
	 * this - only the first attempted engine ever falls back).
	 */
	onFallback?: (from: FallbackCandidate, to: FallbackCandidate, err: Error) => void;
}

/**
 * Try candidates in order until one's first chunk is heard, or the list is
 * exhausted. Returns the candidate that succeeded, or null.
 *
 * The guard: for each candidate, race the Player's own "state" event
 * (resolve success on the first "playing") against its "error" event (treat
 * as this candidate's failure). Both listeners are removed the instant one
 * settles, so a LATER chunk's failure - one that happens after this
 * candidate's first chunk was already heard - is never observed here and
 * falls straight through to whatever persistent "error" handler the caller
 * registered on the Player before calling this (main.ts's existing
 * reportError/Notice, unchanged). This is also what stops a fallback from
 * ever re-speaking already-spoken text: once a candidate reaches "playing",
 * this function is done with it, success or later failure alike.
 *
 * An AbortError (a user-initiated Stop, or a Player.stop() from any other
 * caller) is not "error" at all - Player's startRun() already swallows it
 * before emitting anything - so Stop can never be mistaken for a failure
 * here; this is a property of Player already true today, not new code in
 * this module. When `player.play()` itself resolves without either event
 * having fired, that means either the chunk list was empty (Player's own
 * "finished" semantics, nothing failed) or something stopped the attempt
 * before it could speak (state left at something other than "finished",
 * e.g. "idle" from a Stop) - the former counts as success, the latter
 * resolves this attempt with no candidate and no fallback.
 *
 * `player.play()` already calls `this.stop()` internally on entry, so no
 * manual teardown between attempts is needed: calling play() again with the
 * next candidate cleanly discards the failed attempt's queue, audio element
 * state and pending synthesis.
 *
 * The optional `signal` covers the phase before play() is reached at all
 * (NRL-48). `beforeAttempt` is where an engine's model is loaded, which for
 * Kokoro is seconds of cold boot, and the Player has no run of its own yet -
 * `Player.stop()` during it aborts nothing, so the caller owns a per-read
 * AbortController instead. An abort is a user Stop, so it is neither a
 * candidate failure (no `onFallback`, no next candidate) nor an error: this
 * function just resolves null, the same way the play phase already treats a
 * Stop above. The load itself is abandoned, not cancelled - `prepare()` takes
 * no signal by design, the bytes keep arriving and a finished model is kept
 * for the next read (docs/adr/0013). Because nobody awaits the abandoned
 * promise any more, its later settlement is neutralised at creation rather
 * than observed, so a load that fails after the Stop cannot start speaking
 * candidate 2 and cannot surface as an unhandled rejection.
 */
export async function playWithFallback(
	player: Player,
	candidates: FallbackCandidate[],
	chunks: SpeechChunk[],
	rate: number,
	pitch: number,
	hooks?: FallbackHooks,
	startAtSource = -1,
	signal?: AbortSignal,
): Promise<FallbackCandidate | null> {
	for (let i = 0; i < candidates.length; i++) {
		if (signal?.aborted) return null;
		const candidate = candidates[i]!;
		const isLast = i === candidates.length - 1;

		// The hook is invoked inside the try so a hook that throws
		// synchronously (the type says it returns a promise, but nothing
		// enforces that at a JS call site) is still this candidate's load
		// failure, exactly as the old try/catch around the await made it.
		let work: Promise<void> | undefined;
		try {
			work = hooks?.beforeAttempt?.(candidate);
		} catch (err) {
			work = Promise.reject(err);
		}

		const load = await raceAbort(work, signal);
		if (load.kind === "aborted") return null;
		if (load.kind === "failed") {
			if (isLast) return null;
			hooks?.onFallback?.(candidate, candidates[i + 1]!, load.error);
			continue;
		}

		// A Stop that lands between a finished load and play() would otherwise
		// go unnoticed until the next iteration, which for a single candidate
		// means never.
		if (signal?.aborted) return null;

		const outcome = await attempt(player, candidate, chunks, rate, pitch, startAtSource);
		if (outcome.kind === "succeeded") return candidate;
		if (outcome.kind === "aborted") return null;

		// outcome.kind === "failed"
		if (isLast) return null;
		hooks?.onFallback?.(candidate, candidates[i + 1]!, outcome.error);
	}
	return null;
}

type LoadOutcome =
	| { kind: "loaded" }
	| { kind: "aborted" }
	| { kind: "failed"; error: Error };

const ABORTED: LoadOutcome = { kind: "aborted" };

/**
 * Await `work`, but give up on it the moment `signal` aborts.
 *
 * Two deliberate shapes, both about unhandled rejections - Node kills the
 * process on one by default and Electron's renderer logs it, and this is the
 * real hazard of walking away from a promise you asked for:
 *
 * 1. `work`'s rejection is turned into a VALUE at the moment the race is set
 *    up, not later. Attaching that onRejected handler immediately marks the
 *    original promise handled for good, so a load that fails long after we
 *    returned null settles a promise nobody reads and nothing escapes. This is
 *    not a `.catch(() => {})` swallow: a failure that arrives while we are
 *    still waiting is still reported as this candidate's load failure.
 * 2. The abort arm RESOLVES with `aborted` rather than rejecting, so there is
 *    no rejecting arm anywhere here at all.
 *
 * The abort listener is removed on the way out so a many-candidate read does
 * not accumulate one listener per candidate on a long-lived signal.
 */
function raceAbort(work: Promise<void> | undefined, signal?: AbortSignal): Promise<LoadOutcome> {
	if (work === undefined) return Promise.resolve(signal?.aborted ? ABORTED : { kind: "loaded" });

	const settled: Promise<LoadOutcome> = Promise.resolve(work).then(
		() => ({ kind: "loaded" }) as LoadOutcome,
		(err: unknown) =>
			({
				kind: "failed",
				error: err instanceof Error ? err : new Error(String(err)),
			}) as LoadOutcome,
	);
	if (!signal) return settled;
	if (signal.aborted) return Promise.resolve(ABORTED);

	let onAbort: (() => void) | undefined;
	const aborted = new Promise<LoadOutcome>((resolve) => {
		onAbort = () => resolve(ABORTED);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([settled, aborted]).finally(() => {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	});
}

type AttemptOutcome =
	| { kind: "succeeded" }
	| { kind: "aborted" }
	| { kind: "failed"; error: Error };

function attempt(
	player: Player,
	candidate: FallbackCandidate,
	chunks: SpeechChunk[],
	rate: number,
	pitch: number,
	startAtSource = -1,
): Promise<AttemptOutcome> {
	return new Promise<AttemptOutcome>((resolve) => {
		let settled = false;
		const offState = player.on("state", (state) => {
			if (state === "playing") finish({ kind: "succeeded" });
		});
		const offError = player.on("error", (err) => {
			finish({ kind: "failed", error: err });
		});

		function finish(outcome: AttemptOutcome): void {
			if (settled) return;
			settled = true;
			offState();
			offError();
			resolve(outcome);
		}

		void player.play(candidate.engine, chunks, rate, pitch, startAtSource).then(() => {
			// play() resolved without the race above ever settling: no
			// "playing" and no "error" fired for this attempt. Either the
			// chunk list was empty (Player's own "finished" state, nothing
			// to report as a failure) or a Stop from elsewhere ended the
			// attempt first (state left at "idle", not "finished") - never a
			// synthesis failure, so this never advances the fallback chain.
			finish(player.getState() === "finished" ? { kind: "succeeded" } : { kind: "aborted" });
		});
	});
}
