import type {
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
	// False describes the plugin, not the platform. speechSynthesis does have
	// pause() and resume(); this engine never calls them, and the player pauses
	// an <audio> element a `kind: "live"` result never fills. So today pressing
	// pause here changes an icon and nothing else. Declaring true because the
	// browser API could is exactly the lie this field exists to stop. NRL-23 is
	// expected to wire the real calls up and flip these two.
	pause: false,
	resume: false,
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

	async isAvailable(): Promise<boolean> {
		if (!hasSpeechSynthesis()) return false;
		return (await waitForVoices()).length > 0;
	}

	async listVoices(): Promise<VoiceInfo[]> {
		if (this.voicesLoaded) return this.voices;
		const raw = await waitForVoices();
		this.voices = raw.map(toVoiceInfo);
		this.voicesLoaded = true;
		return this.voices;
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
				window.speechSynthesis.cancel();
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

	async stop(): Promise<void> {
		if (hasSpeechSynthesis()) window.speechSynthesis.cancel();
	}

	async dispose(): Promise<void> {
		await this.stop();
		this.voices = [];
		this.voicesLoaded = false;
	}
}
