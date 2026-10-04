import type {
	EngineAvailability,
	EngineCapabilities,
	EngineId,
	SpeechEngine,
	SynthRequest,
	SynthResult,
	VoiceInfo,
} from "../../audio/types";
import { allocateWordTimings } from "../../audio/words";
import { parseWav } from "../../audio/wav";
import type { ProcessRunner } from "./spawn";

/**
 * espeak-ng driven as a subprocess.
 *
 * Shelling out rather than going through speech-dispatcher is the whole point:
 * `--stdout` hands us the WAV, so we know the real duration and can place
 * words. speech-dispatcher plays straight to the sound card and reports
 * nothing back.
 */

/** espeak-ng's own sample rate. */
const ESPEAK_SAMPLE_RATE = 22050;
const ESPEAK_DEFAULT_WPM = 175;

const CAPABILITIES: EngineCapabilities = {
	voices: true,
	timing: "measured",
	rate: true,
	pitch: true,
	desktopOnly: true,
	// Same WAV-into-the-player path as Kokoro, so pausing the element works.
	pause: true,
	resume: true,
	// The WAV carries no marks; word timings are apportioned, not reported.
	sentenceBoundary: false,
	// A local binary with a built-in voice list. Nothing here can need a network.
	offlineStatus: true,
	// `--stdout` gives us a WAV, so the player owns playback and its speed.
	ownsPlayback: false,
};

/**
 * Languages espeak-ng ships with.
 *
 * Kept as a static list on purpose: the engine has to work with no network.
 * `listVoices()` can still report exactly what the installed binary supports,
 * which is the authoritative answer.
 */
const BUILTIN_LANGUAGES: Array<[code: string, name: string]> = [
	["en-us", "English (US)"],
	["en-gb", "English (UK)"],
	["de", "German"],
	["fr", "French"],
	["fr-fr", "French (France)"],
	["es", "Spanish"],
	["it", "Italian"],
	["pt", "Portuguese"],
	["pt-br", "Portuguese (Brazil)"],
	["nl", "Dutch"],
	["da", "Danish"],
	["sv", "Swedish"],
	["fi", "Finnish"],
	["pl", "Polish"],
	["cs", "Czech"],
	["ru", "Russian"],
	["uk", "Ukrainian"],
	["el", "Greek"],
	["tr", "Turkish"],
	["ar", "Arabic"],
	["he", "Hebrew"],
	["hi", "Hindi"],
	["id", "Indonesian"],
	["ja", "Japanese"],
	["ko", "Korean"],
	["cmn", "Mandarin (Chinese)"],
	["yue", "Cantonese"],
	["th", "Thai"],
	["vi", "Vietnamese"],
];

function toVoiceInfo(code: string, name: string): VoiceInfo {
	return {
		id: `espeak:${code}`,
		name,
		lang: code,
		gender: "neutral",
		engineId: "espeak",
		// Genuinely local for every voice: espeak.ts has no fetch/http/XMLHttpRequest/
		// axios/WebSocket call anywhere (grep-confirmed), it only spawns the local
		// espeak-ng binary via ProcessRunner. Covers both the real --voices parse
		// and the BUILTIN_LANGUAGES fallback, since both call this function.
		local: true,
		requiresNetwork: false,
	};
}

export class EspeakEngine implements SpeechEngine {
	readonly id: EngineId = "espeak";
	readonly label = "espeak-ng";
	readonly capabilities = CAPABILITIES;

	private voice: VoiceInfo = toVoiceInfo("en-us", "English (US)");

	constructor(private readonly runner: ProcessRunner) {}

	async isAvailable(): Promise<EngineAvailability> {
		const path = await this.runner.which("espeak-ng");
		if (!path) {
			return {
				available: false,
				reason: "espeak-ng is not installed. Install the espeak-ng package and retry.",
			};
		}
		try {
			const { code, stdout } = await this.runner.run("espeak-ng", ["--version"]);
			if (code === 0 && stdout.toString().trim().length > 0) return { available: true };
			return {
				available: false,
				reason: "espeak-ng was found but is not responding to --version. Reinstall the espeak-ng package.",
			};
		} catch (err) {
			return {
				available: false,
				reason: `Could not check espeak-ng: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	async listVoices(): Promise<VoiceInfo[]> {
		// `--voices` lists what this install actually has, which beats our
		// static list. It prints lines like "1  en          en-us  english (usa)".
		try {
			const { code, stdout } = await this.runner.run("espeak-ng", ["--voices"]);
			if (code === 0) {
				const parsed = parseVoiceList(stdout.toString());
				if (parsed.length > 0) return parsed;
			}
		} catch {
			// fall through to the built-in list
		}
		return BUILTIN_LANGUAGES.map(([code, name]) => toVoiceInfo(code, name));
	}

	async selectVoice(voice: VoiceInfo): Promise<void> {
		this.voice = voice;
	}

	async synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
		const lang = this.voice.id.replace(/^espeak:/, "");

		const args = [
			"-v",
			lang,
			"-s",
			String(Math.round(ESPEAK_DEFAULT_WPM * (req.rate || 1))),
			"-p",
			String(clampPitch(req.pitch)),
			"--stdout",
		];

		const { code, stdout } = await this.runner.run("espeak-ng", args, req.chunk.text, signal);
		// Fixed string only, mirroring speechd.ts's own precedent: raw stderr
		// is unaudited process output, not something to surface verbatim.
		if (code !== 0) throw new Error(`Speech synthesis failed (espeak-ng exited with code ${code}).`);

		const audio = toArrayBuffer(stdout);
		if (audio.byteLength === 0) throw new Error("espeak-ng produced no audio");

		const wav = parseWav(audio);
		return {
			kind: "buffer",
			audio,
			sampleRate: wav.sampleRate || ESPEAK_SAMPLE_RATE,
			durationMs: wav.durationMs,
			words: allocateWordTimings(req.chunk, wav.durationMs, req.rate || 1),
		};
	}

	async dispose(): Promise<void> {}
}

/** espeak-ng pitch is 0-99 with 50 as default; our setting is -50..50. */
function clampPitch(pitch: number): number {
	return Math.max(0, Math.min(99, Math.round(50 + (pitch || 0))));
}

function parseVoiceList(output: string): VoiceInfo[] {
	const out: VoiceInfo[] = [];
	for (const line of output.split("\n")) {
		// Priority, then two-letter code, then file, then a human label.
		const m = line.match(/^\s*\d+\s+(\S+)\s+(\S+)\s+(.*\S)\s*$/);
		if (!m) continue;
		const file = m[2]!;
		const label = m[3]!;
		if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(file)) continue;
		out.push(toVoiceInfo(file, label.charAt(0).toUpperCase() + label.slice(1)));
	}
	return out;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	// Narrowed with instanceof rather than asserted, because whether
	// `Uint8Array#buffer` is typed `ArrayBuffer` or `ArrayBufferLike` depends on
	// the TypeScript version, so an assertion is required under one and flagged
	// as unnecessary by the linter under the other.
	const buffer = data.buffer;
	if (buffer instanceof ArrayBuffer) {
		if (data.byteOffset === 0 && data.byteLength === buffer.byteLength) {
			return buffer;
		}
		return buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
	}
	// Not a plain ArrayBuffer (a SharedArrayBuffer, or one from another realm):
	// copy the bytes into one.
	const out = new ArrayBuffer(data.byteLength);
	new Uint8Array(out).set(data);
	return out;
}
