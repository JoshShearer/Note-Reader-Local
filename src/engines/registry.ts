import { Platform } from "obsidian";
import type { EngineId, SpeechEngine } from "../audio/types";
import { shouldConstructLinuxDesktopEngines } from "./platform";
import { EspeakEngine } from "./system/espeak";
import { SpeechDispatcherEngine } from "./system/speechd";
import { getProcessRunner } from "./system/spawn";
import { WebSpeechEngine } from "./webspeech";
import {
	KokoroEngine,
	type KokoroOptions,
	type ModelStore,
	type WeightsPreference,
} from "./onnx/kokoro";

export interface EngineStatus {
	engine: SpeechEngine;
	available: boolean;
	/** Why it is unavailable, for the settings UI. */
	reason: string;
}

/**
 * Build the engines that make sense on this platform.
 *
 * Anything needing a subprocess is desktop-only by construction: Obsidian's
 * mobile build is a WebView with no node, so importing the process runner
 * there would throw at load. Engines are constructed lazily for that reason.
 */
export function createEngines(
	kokoroStore: ModelStore,
	kokoroOptions: Partial<KokoroOptions> = {},
): SpeechEngine[] {
	const engines: SpeechEngine[] = [new KokoroEngine(kokoroStore, kokoroOptions)];

	// espeak-ng and spd-say are Linux-only system binaries: constructing
	// these engines on macOS/Windows desktop would only produce `which`
	// failures in `probeEngines` below, so the guard is Linux desktop
	// specifically, not desktop-vs-mobile (srs.md, R-M02 Linux Support).
	if (shouldConstructLinuxDesktopEngines(Platform)) {
		const runner = getProcessRunner();
		engines.push(new EspeakEngine(runner), new SpeechDispatcherEngine(runner));
	}

	engines.push(new WebSpeechEngine());
	return engines;
}

/**
 * Turn the `auto` weights setting into a concrete choice.
 *
 * Lives here because this is the layer that knows about the platform, and the
 * answer is a platform question: the fast build is 60MB larger and needs more
 * memory than a phone's WebView is comfortable with, while a desktop that
 * takes the small build pays for it on every single sentence.
 */
export function resolveWeights(setting: "auto" | WeightsPreference): WeightsPreference {
	if (setting !== "auto") return setting;
	// Not `gpu`, even on a desktop with a GPU: that build is a 326MB download
	// and the engine falls back to the CPU when it is not there, so choosing
	// it automatically would mean silently recommending a download nobody
	// asked for. The settings tab offers it once a GPU is actually detected.
	return Platform.isMobile ? "small" : "fast";
}

/** Probe each engine. Never throws; unavailability is reported, not fatal. */
export async function probeEngines(engines: SpeechEngine[]): Promise<EngineStatus[]> {
	return await Promise.all(
		engines.map(async (engine): Promise<EngineStatus> => {
			if (engine.capabilities.desktopOnly && Platform.isMobile) {
				return { engine, available: false, reason: "Not available on mobile" };
			}
			try {
				const result = await engine.isAvailable();
				return { engine, available: result.available, reason: result.available ? "" : result.reason };
			} catch (err) {
				return {
					engine,
					available: false,
					reason: err instanceof Error ? err.message : String(err),
				};
			}
		}),
	);
}

export function findEngine(engines: SpeechEngine[], id: EngineId): SpeechEngine | undefined {
	return engines.find((e) => e.id === id);
}
