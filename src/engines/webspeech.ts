import type {
	EngineAvailability,
	EngineCapabilities,
	EngineId,
	SpeechEngine,
	SynthRequest,
	SynthResult,
	VoiceInfo,
} from "../audio/types";

/**
 * The browser's own speechSynthesis.
 *
 * Worth keeping on desktop: on macOS and Windows it reaches the system voices
 * with no download and no subprocess, and its `boundary` events give genuine
 * word positions, which is better than anything we can infer. On Linux it is
 * only as good as the local libspeechd setup, so espeak-ng and Kokoro are the
 * better picks there.
 *
 * The long-standing trap is that `getVoices()` returns an empty array on first
 * call and fills in later, so every entry point polls and listens rather than
 * trusting the first read.
 */

const VOICE_POLL_MS = 100;
const VOICE_TIMEOUT_MS = 5000;

const CAPABILITIES: EngineCapabilities = {
	voices: true,
	timing: "native",
	rate: true,
	pitch: true,
	desktopOnly: false,
	// A true mid-utterance pause: this engine implements pause()/resume() with
	// speechSynthesis's own, so the sentence is held where it is rather than
	// stopped and re-read. Measured in Chromium 154 off the sink monitor
	// (NRL-23): 0 ms of audio across a 2.7 s pause, 2000 ms more after the
	// resume, so the utterance was held rather than ended. Not measured in
	// Obsidian's own Electron build, whose voices come from a different
	// backend; if it turns out to be a no-op there, delete the two methods
	// below and the player falls back to stop-and-retain with no other change.
	pause: true,
	resume: true,
	// onboundary drops every event whose name is not "word", so sentence marks
	// never reach us even from engines that emit them.
	sentenceBoundary: false,
	// System voices may be network-backed (Chrome ships several) and the API
	// does not say which, so this engine cannot answer the question honestly.
	offlineStatus: false,
	// speechSynthesis speaks straight to the sound card.
	ownsPlayback: true,
};

function hasSpeechSynthesis(): boolean {
	return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Wait for the voice list to populate, which is never immediate. */
function waitForVoices(): Promise<SpeechSynthesisVoice[]> {
	if (!hasSpeechSynthesis()) return Promise.resolve([]);
	const immediate = window.speechSynthesis.getVoices();
	if (immediate.length > 0) return Promise.resolve(immediate);

	return new Promise((resolve) => {
		let waited = 0;
		const tick = (): void => {
			const voices = window.speechSynthesis.getVoices();
			if (voices.length > 0) {
				resolve(voices);
				return;
			}
			waited += VOICE_POLL_MS;
			if (waited >= VOICE_TIMEOUT_MS) {
				resolve([]);
				return;
			}
			window.setTimeout(tick, VOICE_POLL_MS);
		};
		window.speechSynthesis.addEventListener("voiceschanged", tick, { once: true });
		tick();
	});
}

function toVoiceInfo(voice: SpeechSynthesisVoice): VoiceInfo {
	// Voice names vary wildly by platform. The URI is the only stable handle.
	const id = voice.voiceURI || voice.name;
	return {
		id: `webspeech:${id}`,
		name: voice.name.replace(/\s*\(.*\)\s*$/, "").trim() || voice.name,
		lang: voice.lang,
		gender: guessGender(voice.name),
		engineId: "webspeech",
	};
}

function guessGender(name: string): VoiceInfo["gender"] {
	if (/\b(male|man|george|daniel|alex|fred|thomas|david|james|michael|mark|arthur|jenny|mark)\b/i.test(name)) {
		return "male";
	}
	if (/\b(female|woman|samantha|victoria|karen|moira|tessa|fiona|serena|allison|ava|zira|susan)\b/i.test(name)) {
		return "female";
	}
	return "neutral";
}

export class WebSpeechEngine implements SpeechEngine {
	readonly id: EngineId = "webspeech";
	readonly label = "System voices (Web Speech)";
	readonly capabilities = CAPABILITIES;

	private voice: VoiceInfo | null = null;
	private voices: VoiceInfo[] = [];
	private voicesLoaded = false;

	async isAvailable(): Promise<EngineAvailability> {
		if (!hasSpeechSynthesis()) {
			return { available: false, reason: "This platform has no Web Speech API." };
		}
		const voices = await waitForVoices();
		if (voices.length === 0) {
			return {
				available: false,
				reason: "No voices are installed for this platform's speech synthesis. Install a system voice and retry.",
			};
		}
		return { available: true };
	}

	async listVoices(): Promise<VoiceInfo[]> {
		if (this.voicesLoaded) return this.voices;
		const raw = await waitForVoices();
		this.voices = raw.map(toVoiceInfo);
		this.voicesLoaded = true;
		return this.voices;
	}

	/**
	 * Whether at least one voice is confirmed local, for automatic selection.
	 *
	 * Fails closed: `SpeechSynthesisVoice.localService` is `boolean |
	 * undefined`, and `undefined` counts as NOT local, the same as an
	 * explicit `false`. `CAPABILITIES.offlineStatus` stays `false` - this is
	 * a narrower, automatic-selection-only signal, not a general "which
	 * voices need the network" answer (AGENTS.md non-negotiable 4). A manual
	 * pin to this engine never calls this method and is unaffected.
	 */
	async hasLocalVoice(): Promise<boolean> {
		const raw = await waitForVoices();
		return raw.some((v) => v.localService === true);
	}

	/** Only the voices `hasLocalVoice()` would count as local, mapped like `listVoices()`. */
	async listLocalVoices(): Promise<VoiceInfo[]> {
		const raw = await waitForVoices();
		return raw.filter((v) => v.localService === true).map(toVoiceInfo);
	}

	async selectVoice(voice: VoiceInfo): Promise<void> {
		this.voice = voice;
	}

	async synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
		if (!hasSpeechSynthesis()) {
			throw new Error("Web Speech API is not available on this platform");
		}
		const voices = await this.listVoices();
		if (voices.length === 0) {
			throw new Error("No speech synthesis voices are available on this device");
		}

		const selected =
			voices.find((v) => v.id === this.voice?.id) ?? voices[0]!;
		const nativeVoice = window.speechSynthesis
			.getVoices()
			.find((v) => v.voiceURI === selected.id.replace(/^webspeech:/, ""));

		const utterance = new SpeechSynthesisUtterance(req.chunk.text);
		if (nativeVoice) utterance.voice = nativeVoice;
		utterance.rate = req.rate || 1;
		// The UI setting is -50..50; the API wants roughly 0..2.
		utterance.pitch = 1 + (req.pitch || 0) / 50;

		return await new Promise<SynthResult>((resolve, reject) => {
			let settled = false;

			const cleanup = (): void => {
				utterance.onend = null;
				utterance.onerror = null;
				utterance.onboundary = null;
				signal.removeEventListener("abort", onAbort);
			};

			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				// Stop pressed while paused arrives here, which is exactly the
				// case cancelSpeech() exists for.
				this.cancelSpeech();
				cleanup();
				reject(new DOMException("Aborted", "AbortError"));
			};

			signal.addEventListener("abort", onAbort, { once: true });

			utterance.onboundary = (event) => {
				if (event.name && event.name !== "word") return;
				const start = event.charIndex;
				const end = start + (event.charLength || 0);
				const sourceStart = req.chunk.sourceIndex[start] ?? req.chunk.sourceStart;
				const sourceEndRaw = req.chunk.sourceIndex[end - 1];
				req.onWord?.({
					start,
					end,
					sourceStart,
					sourceEnd: sourceEndRaw !== undefined ? sourceEndRaw + 1 : end,
					// Chrome reports elapsed seconds on the event itself, which is
					// a real measurement rather than our guess.
					offsetMs: event.elapsedTime * 1000,
					// No end time is provided; the player holds until the next word.
					durationMs: 0,
				});
			};

			utterance.onend = () => {
				if (settled) return;
				settled = true;
				cleanup();
				req.onEnd?.();
				resolve({ kind: "live", words: null });
			};

			utterance.onerror = (event) => {
				if (settled) return;
				// Chrome fires these for our own cancel() calls.
				if (event.error === "canceled" || event.error === "interrupted") return;
				settled = true;
				cleanup();
				reject(new Error(`Speech synthesis failed: ${event.error}`));
			};

			window.speechSynthesis.speak(utterance);
		});
	}

	/**
	 * Hold the utterance where it is, and let it go on again.
	 *
	 * A pair, and the player refuses either one alone. Both are safe to call
	 * when nothing is speaking: pause() on an idle queue is a no-op, and
	 * resume() on one is how the cancel path below un-wedges itself.
	 */
	pause(): void {
		if (hasSpeechSynthesis()) window.speechSynthesis.pause();
	}

	resume(): void {
		if (hasSpeechSynthesis()) window.speechSynthesis.resume();
	}

	/**
	 * Cancel, then un-pause.
	 *
	 * `cancel()` while the queue is paused leaves some Chromium builds paused
	 * with an empty queue, and every later `speak()` then goes nowhere: pause
	 * followed by Stop would end the plugin's ability to speak at all. The
	 * `resume()` is ordered after the cancel so there is nothing left to be
	 * audible, and the sink monitor measured 0 ms of audio out of this pair
	 * (NRL-23). Chromium 154 did not reproduce the wedge itself - the next
	 * utterance started with or without this line - so treat it as cheap
	 * insurance against the older Chromium in Obsidian rather than as a fix for
	 * something reproduced here.
	 */
	private cancelSpeech(): void {
		if (!hasSpeechSynthesis()) return;
		window.speechSynthesis.cancel();
		window.speechSynthesis.resume();
	}

	async stop(): Promise<void> {
		this.cancelSpeech();
	}

	async dispose(): Promise<void> {
		await this.stop();
		this.voices = [];
		this.voicesLoaded = false;
	}
}
