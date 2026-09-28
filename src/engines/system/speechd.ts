import type {
	EngineCapabilities,
	EngineId,
	SpeechEngine,
	SynthRequest,
	SynthResult,
	VoiceInfo,
} from "../../audio/types";
import type { ProcessRunner } from "./spawn";

/**
 * speech-dispatcher via `spd-say`.
 *
 * This is the zero-install path: if a desktop has a speech daemon configured
 * it just works, and on this machine it already does. The cost is that audio
 * goes straight to the sound card, so we get no samples and no timing, which
 * means word highlighting cannot work on this engine. It is offered as a
 * last-resort fallback, not as a peer of the file-based engines.
 */

const CAPABILITIES: EngineCapabilities = {
	voices: true,
	timing: "none",
	rate: true,
	pitch: true,
	desktopOnly: true,
	// spd-say plays to the sound card and tells us nothing.
	ownsPlayback: true,
};

/** ~180 wpm, used only to pace the sentence queue. */
const CHARS_PER_SECOND = 14;

interface SpdVoiceRow {
	name: string;
	lang: string;
	variant: string;
}

/** Parse `spd-say -L`, whose columns are NAME, LANGUAGE, VARIANT. */
function parseVoiceList(output: string): SpdVoiceRow[] {
	const lines = output.split("\n");
	const headerAt = lines.findIndex((l) => /NAME\s+LANGUAGE\s+VARIANT/i.test(l));
	if (headerAt === -1) return [];

	const rows: SpdVoiceRow[] = [];
	for (const line of lines.slice(headerAt + 1)) {
		if (!line.trim()) continue;
		const m = line.match(/^\s*(.+?)\s{2,}(\S+)\s+(\S+)\s*$/);
		if (!m) continue;
		rows.push({ name: m[1]!.trim(), lang: m[2]!, variant: m[3]! });
	}
	return rows;
}

export class SpeechDispatcherEngine implements SpeechEngine {
	readonly id: EngineId = "speechd";
	readonly label = "speech-dispatcher";
	readonly capabilities = CAPABILITIES;

	private voice: VoiceInfo | null = null;
	/** Set while a chunk is being spoken so stop() can interrupt the daemon. */
	private speaking = false;

	constructor(private readonly runner: ProcessRunner) {}

	async isAvailable(): Promise<boolean> {
		if (!(await this.runner.which("spd-say"))) return false;
		try {
			// -O lists configured output modules. An empty list means a daemon
			// is installed but has no synthesiser behind it, which is the state
			// that makes this engine look present but silent.
			const { code, stdout } = await this.runner.run("spd-say", ["-O"]);
			return code === 0 && /OUTPUT MODULES/i.test(stdout.toString());
		} catch {
			return false;
		}
	}

	async listVoices(): Promise<VoiceInfo[]> {
		try {
			const { code, stdout } = await this.runner.run("spd-say", ["-L"]);
			if (code !== 0) return [];
			return parseVoiceList(stdout.toString()).map((row) => ({
				id: `speechd:${row.name}+${row.variant}`,
				name: row.variant === "none" ? row.name : `${row.name} (${row.variant})`,
				lang: row.lang,
				gender: "neutral" as const,
				engineId: "speechd" as const,
			}));
		} catch {
			return [];
		}
	}

	async selectVoice(voice: VoiceInfo): Promise<void> {
		this.voice = voice;
	}

	async synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
		const args = ["-w"];

		if (this.voice) {
			// Our id is `speechd:<name>+<variant>`; spd-say wants them apart.
			const rest = this.voice.id.replace(/^speechd:/, "");
			const plus = rest.indexOf("+");
			const name = plus === -1 ? rest : rest.slice(0, plus);
			const variant = plus === -1 ? undefined : rest.slice(plus + 1);
			if (name) args.push("-y", name);
			if (variant && variant !== "none") args.push("-t", variant);
		}

		// spd-say rate and pitch are -100..100.
		const rate = Math.round(clamp(-100, 100, (req.rate - 1) * 100));
		if (rate !== 0) args.push("-r", String(rate));
		const pitch = Math.round(clamp(-100, 100, req.pitch));
		if (pitch !== 0) args.push("-p", String(pitch));

		this.speaking = true;
		try {
			const { stderr, code } = await this.runner.run("spd-say", args, req.chunk.text, signal);
			if (code !== 0 && stderr.trim()) {
				throw new Error(`spd-say failed: ${stderr.trim()}`);
			}
		} finally {
			this.speaking = false;
		}

		return {
			kind: "streamed",
			estimatedMs: (req.chunk.text.length / CHARS_PER_SECOND / (req.rate || 1)) * 1000,
			words: null,
		};
	}

	/** Flush anything the daemon still has queued. */
	async stop(): Promise<void> {
		if (!this.speaking) return;
		try {
			await this.runner.run("spd-say", ["-C"]);
		} catch {
			// best effort
		}
	}

	async dispose(): Promise<void> {
		await this.stop();
	}
}

function clamp(min: number, max: number, value: number): number {
	return Math.max(min, Math.min(max, value));
}
