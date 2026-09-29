import type { EngineId } from "../audio/types";

/**
 * Automatic, quality-ranked engine selection (docs/adr/0010).
 *
 * No obsidian import, following src/ui/affordances.ts: the ranking rule is
 * the part worth testing, and the tests run in plain Node. This module never
 * probes anything itself - every `EngineProbe` is handed in already resolved,
 * so the actual hardware/vault checks (kokoro.isAvailable(),
 * kokoro.plannedBackend(), a subprocess isAvailable(), webspeech's
 * hasLocalVoice()) live where the rest of this codebase's IO lives, in
 * main.ts.
 */

/** What `Settings.engine` actually stores: a concrete engine, or "let the plugin pick". */
export type EngineSelection = "auto" | EngineId;

export interface EngineProbe {
	id: EngineId;
	/**
	 * Already fully resolved by the caller: `isAvailable()` for
	 * espeak/speechd/kokoro; for webspeech, `isAvailable() &&
	 * hasLocalVoice()` - the local-voice gate is baked into this boolean
	 * before it reaches this module, which stays free of browser-specific
	 * concepts (AGENTS.md non-negotiable 4).
	 */
	available: boolean;
	/**
	 * Only meaningful when `id === "kokoro"`: a real GPU adapter answered
	 * `navigator.gpu.requestAdapter()` right now, AND the fp32
	 * (`KOKORO_WEIGHTS.gpu`) build is already on disk. Confirmed live, not
	 * just planned - see kokoro.ts's `plannedBackend()`.
	 */
	kokoroGpuFp32Live?: boolean;
}

export interface RankedCandidate {
	id: EngineId;
	/** One sentence: the settings tab's "chosen and why" line, and the
	 *  "trying the next engine" fallback notice. */
	reason: string;
}

/**
 * Every auto-eligible engine, best first.
 *
 * Fixed rank order, never derived from the probes, only gated by them:
 *
 *   1. kokoro, but only when `kokoroGpuFp32Live` - the GPU/fp32 path measured
 *      at 0.10-0.13x wall/audio on this machine, clearly the best available
 *      voice when it is real.
 *   2. speechd
 *   3. espeak
 *   4. kokoro again, this time on the CPU (any WASM or GPU/fp16 plan) - a
 *      smooth worse voice beats a better voice with gaps (recorded
 *      clarification), so it ranks below both native engines rather than
 *      above them.
 *   5. webspeech, and only when the probe already confirms every voice it
 *      would use is local (never a possibly network-backed one).
 *
 * A given kokoro probe can only satisfy one of slots 1 and 4, never both -
 * `kokoroGpuFp32Live` is a single boolean - so kokoro never appears twice in
 * the same list.
 */
export function rankEngines(probes: EngineProbe[]): RankedCandidate[] {
	const byId = new Map(probes.map((p) => [p.id, p]));
	const kokoro = byId.get("kokoro");
	const speechd = byId.get("speechd");
	const espeak = byId.get("espeak");
	const webspeech = byId.get("webspeech");

	const out: RankedCandidate[] = [];

	if (kokoro?.available && kokoro.kokoroGpuFp32Live) {
		out.push({
			id: "kokoro",
			reason:
				"Kokoro is confirmed running on a live GPU (fp32) path, the fastest option measured on this machine.",
		});
	}
	if (speechd?.available) {
		out.push({ id: "speechd", reason: "Speech Dispatcher is installed and responding." });
	}
	if (espeak?.available) {
		out.push({ id: "espeak", reason: "espeak-ng is installed and responding." });
	}
	if (kokoro?.available && !kokoro.kokoroGpuFp32Live) {
		out.push({
			id: "kokoro",
			reason:
				"Kokoro is available on the CPU. Slower than a native engine, so it ranks below Speech Dispatcher and espeak-ng.",
		});
	}
	if (webspeech?.available) {
		out.push({
			id: "webspeech",
			reason: "A local system voice is available.",
		});
	}

	return out;
}

/** Top of `rankEngines()`, or an actionable "nothing is ready" result. */
export function selectEngine(probes: EngineProbe[]): RankedCandidate {
	const ranked = rankEngines(probes);
	if (ranked.length > 0) return ranked[0]!;
	return {
		id: "kokoro",
		reason:
			"No speech engine is ready yet. Download the Kokoro model, or install espeak-ng or speech-dispatcher, from settings.",
	};
}

/**
 * Resolve a stored `Settings.engine` value against real probes.
 *
 * A manual pin is respected exactly as stored, unconditionally - it is never
 * re-ranked or gated by availability here. (A pin that turns out not to work
 * is reported by the existing "not available" Notice in main.ts, unchanged.)
 * Only `"auto"` delegates to `selectEngine()`.
 */
export function resolveSelection(
	setting: EngineSelection,
	probes: EngineProbe[],
): RankedCandidate {
	if (setting !== "auto") return { id: setting, reason: "Manually selected." };
	return selectEngine(probes);
}
