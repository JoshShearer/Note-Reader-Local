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
 * call and fills in later, so the first read is never trusted: the engine polls
 * for up to VOICE_TIMEOUT_MS and listens for `voiceschanged`.
 *
 * NRL-141: that poll is paid once per engine, not once per call. On a host
 * whose speechSynthesis reports no voices at all (measured on a Flatpak
 * Obsidian on Linux), every probe used to wait out the full timeout, and
 * `buildProbes()` waits for every engine's probe, so every Auto read did too.
 * A confirmed-empty outcome is now remembered, concurrent callers share one
 * poll, and the memory can only ever hold "no voices": it is dropped by any
 * `voiceschanged` event, and every call still reads `getVoices()` once first,
 * so voices that arrive without an event are seen on the next call.
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

/**
 * `SpeechSynthesisVoice.localService` maps to `VoiceInfo.local`/`requiresNetwork`
 * honestly: `undefined` (the API allows it) becomes `"unknown"` on both fields
 * rather than being coerced to either boolean, per R-S01's "MUST NOT claim a
 * voice is offline when the backend cannot determine this". Separate from
 * `hasLocalVoice()`/`listLocalVoices()` below, which answer a narrower,
 * fail-closed question for automatic selection only and must not be routed
 * through this.
 */
function voiceLocality(localService: boolean | undefined): { local: boolean | "unknown"; requiresNetwork: boolean | "unknown" } {
	if (localService === true) return { local: true, requiresNetwork: false };
	if (localService === false) return { local: false, requiresNetwork: true };
	return { local: "unknown", requiresNetwork: "unknown" };
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
		...voiceLocality(voice.localService),
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

	/**
	 * A full VOICE_TIMEOUT_MS poll ended with no voices. Holds only that
	 * negative, never a voice list, so it cannot make a voice appear: the
	 * fail-closed local-voice gate (ADR 0010) is unaffected by it.
	 */
	private emptyConfirmed = false;
	/** The one poll in progress, shared by every caller that arrives during it. */
	private inflight: Promise<SpeechSynthesisVoice[]> | null = null;
	/** Ends the in-flight poll early with whatever `getVoices()` now holds. */
	private settleInflight: (() => void) | null = null;
	/** Ends the in-flight poll with no voices and caches nothing (dispose). */
	private abortInflight: (() => void) | null = null;
	/** The speechSynthesis our persistent listener is attached to. */
	private listeningOn: SpeechSynthesis | null = null;

	/**
	 * Any `voiceschanged` invalidates every cached answer. It also settles an
	 * in-flight poll at once if the event brought voices; if it brought none
	 * the poll simply carries on to its timeout.
	 */
	private readonly onVoicesChanged = (): void => {
		this.emptyConfirmed = false;
		this.voices = [];
		this.voicesLoaded = false;
		this.settleInflight?.();
	};

	/** Register the persistent listener once, lazily, and move it if the API object changes. */
	private listen(synth: SpeechSynthesis): void {
		if (this.listeningOn === synth) return;
		this.unlisten();
		synth.addEventListener("voiceschanged", this.onVoicesChanged);
		this.listeningOn = synth;
	}

	private unlisten(): void {
		this.listeningOn?.removeEventListener("voiceschanged", this.onVoicesChanged);
		this.listeningOn = null;
	}

	/** Wait for the voice list to populate, which is never immediate. */
	private waitForVoices(): Promise<SpeechSynthesisVoice[]> {
		if (!hasSpeechSynthesis()) return Promise.resolve([]);
		const synth = window.speechSynthesis;
		this.listen(synth);

		// Always one live read first, even with an empty outcome cached: a host
		// can fill its list without ever firing voiceschanged.
		const immediate = synth.getVoices();
		if (immediate.length > 0) {
			this.emptyConfirmed = false;
			return Promise.resolve(immediate);
		}
		if (this.emptyConfirmed) return Promise.resolve([]);
		if (this.inflight) return this.inflight;

		let waited = 0;
		let done = false;
		let resolvePoll!: (voices: SpeechSynthesisVoice[]) => void;
		const poll = new Promise<SpeechSynthesisVoice[]>((resolve) => {
			resolvePoll = resolve;
		});
		const finish = (voices: SpeechSynthesisVoice[]): void => {
			if (done) return;
			done = true;
			if (this.inflight === poll) {
				this.inflight = null;
				this.settleInflight = null;
				this.abortInflight = null;
			}
			// Only a poll that ran to its timeout confirms "no voices"; one ended
			// by dispose() caches nothing.
			if (voices.length === 0 && waited >= VOICE_TIMEOUT_MS) this.emptyConfirmed = true;
			resolvePoll(voices);
		};
		const tick = (): void => {
			if (done) return;
			const voices = window.speechSynthesis.getVoices();
			if (voices.length > 0) {
				finish(voices);
				return;
			}
			waited += VOICE_POLL_MS;
			if (waited >= VOICE_TIMEOUT_MS) {
				finish([]);
				return;
			}
			window.setTimeout(tick, VOICE_POLL_MS);
		};
		this.inflight = poll;
		this.settleInflight = () => {
			const voices = hasSpeechSynthesis() ? window.speechSynthesis.getVoices() : [];
			if (voices.length > 0) finish(voices);
		};
		this.abortInflight = () => finish([]);
		tick();
		return poll;
	}

	async isAvailable(): Promise<EngineAvailability> {
		if (!hasSpeechSynthesis()) {
			return { available: false, reason: "This platform has no Web Speech API." };
		}
		const voices = await this.waitForVoices();
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
		const raw = await this.waitForVoices();
		this.voices = raw.map(toVoiceInfo);
		// An empty list is not memoised here: it would outlive a later
		// voiceschanged. waitForVoices() already makes the empty case cheap.
		this.voicesLoaded = raw.length > 0;
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
		const raw = await this.waitForVoices();
		return raw.some((v) => v.localService === true);
	}

	/** Only the voices `hasLocalVoice()` would count as local, mapped like `listVoices()`. */
	async listLocalVoices(): Promise<VoiceInfo[]> {
		const raw = await this.waitForVoices();
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
		this.unlisten();
		this.abortInflight?.();
		this.abortInflight = null;
		this.inflight = null;
		this.settleInflight = null;
		this.emptyConfirmed = false;
		this.voices = [];
		this.voicesLoaded = false;
	}
}
