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
 */
export async function playWithFallback(
	player: Player,
	candidates: FallbackCandidate[],
	chunks: SpeechChunk[],
	rate: number,
	pitch: number,
	hooks?: FallbackHooks,
	startAtSource = -1,
): Promise<FallbackCandidate | null> {
	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i]!;
		const isLast = i === candidates.length - 1;

		try {
			await hooks?.beforeAttempt?.(candidate);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			if (isLast) return null;
			hooks?.onFallback?.(candidate, candidates[i + 1]!, error);
			continue;
		}

		const outcome = await attempt(player, candidate, chunks, rate, pitch, startAtSource);
		if (outcome.kind === "succeeded") return candidate;
		if (outcome.kind === "aborted") return null;

		// outcome.kind === "failed"
		if (isLast) return null;
		hooks?.onFallback?.(candidate, candidates[i + 1]!, outcome.error);
	}
	return null;
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
