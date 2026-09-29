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

const ID_PREFIX = "speechd:";

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
	/**
	 * NAME column of the last `spd-say -L`. An unknown `-y` makes spd-say exit
	 * 0 having said nothing, so the only way to catch it is to check first.
	 */
	private knownNames: Set<string> | null = null;
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
			const rows = parseVoiceList(stdout.toString());
			this.knownNames = new Set(rows.map((row) => row.name));
			// NAME already includes the variant ("Afrikaans+Adam"), and it is
			// exactly what `-y` accepts, so it is the whole id. Appending the
			// variant again produced ids spd-say could not select.
			return rows.map((row) => ({
				id: `${ID_PREFIX}${row.name}`,
				name: row.variant === "none" ? row.name : `${row.name} (${row.variant})`,
				lang: row.lang,
				gender: "neutral" as const,
				engineId: "speechd" as const,
				isVariant: row.variant !== "none",
			}));
		} catch {
			return [];
		}
	}

	async selectVoice(voice: VoiceInfo): Promise<void> {
		this.voice = voice;
	}

	/**
	 * Map an id stored by an older build onto the current one.
	 *
	 * Older ids were `speechd:<NAME>+<variant>`, where NAME already carried
	 * the variant: `speechd:Afrikaans+Adam+Adam`, or `speechd:English
	 * (America)+none`. Dropping the last `+segment` recovers NAME, and the
	 * variant it names must agree with the row, so an unrelated voice that
	 * happens to share the prefix is never picked.
	 */
	resolveVoiceId(storedId: string, voices: VoiceInfo[]): VoiceInfo | undefined {
		const exact = voices.find((v) => v.id === storedId);
		if (exact) return exact;
		if (!storedId.startsWith(ID_PREFIX)) return undefined;

		const plus = storedId.lastIndexOf("+");
		if (plus <= ID_PREFIX.length) return undefined;
		const base = storedId.slice(0, plus);
		const variant = storedId.slice(plus + 1);
		const match = voices.find((v) => v.id === base);
		if (!match) return undefined;
		const name = base.slice(ID_PREFIX.length);
		const rowVariant = name.includes("+") ? name.slice(name.lastIndexOf("+") + 1) : "none";
		return rowVariant === variant ? match : undefined;
	}

	async synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
		// -e reads the text from stdin, keeping note text off the command
		// line. Without it spd-say sees no text, prints usage and exits 1.
		const args = ["-w", "-e"];

		if (this.voice) {
			const name = this.voice.id.startsWith(ID_PREFIX)
				? this.voice.id.slice(ID_PREFIX.length)
				: "";
			if (!this.knownNames) await this.listVoices();
			if (!name || !this.knownNames?.has(name)) {
				throw new Error("Requested voice unavailable");
			}
			// Never -t: it takes an enum (male1, child_female, ...), not a
			// variant name, and a variant is already selected by its NAME.
			args.push("-y", name);
		}

		// spd-say rate and pitch are -100..100.
		const rate = Math.round(clamp(-100, 100, (req.rate - 1) * 100));
		if (rate !== 0) args.push("-r", String(rate));
		const pitch = Math.round(clamp(-100, 100, req.pitch));
		if (pitch !== 0) args.push("-p", String(pitch));

		this.speaking = true;
		try {
			const text = defuseCommands(req.chunk.text);
			const { stdout, code } = await this.runner.run("spd-say", args, text, signal);
			// Fixed strings only. With -e, stdout is an echo of the note text,
			// so neither it nor stderr may reach a message or a log.
			if (code !== 0 || reportsFailure(stdout.toString(), text)) {
				throw new Error("Speech synthesis failed");
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

/**
 * In -e mode spd-say treats a line starting "!-!" as a raw SSIP command for
 * the daemon rather than text: the sentence is silently dropped and the note
 * gets to drive speech-dispatcher, which a screen reader may share. A leading
 * space is enough for spd-say to speak the line instead.
 */
function defuseCommands(text: string): string {
	return text.replace(/^!-!/gm, " !-!");
}

/**
 * spd-say reports some failures on stdout and still exits 0, e.g. "Invalid
 * voice" for a bad -t. With -e it also echoes the text it read, byte for
 * byte, after any such message. Strip that echo first, so a note that
 * happens to say "Invalid voice" is not mistaken for an error.
 */
function reportsFailure(stdout: string, text: string): boolean {
	const extra = stdout.endsWith(text) ? stdout.slice(0, stdout.length - text.length) : stdout;
	return /^(Invalid voice|Usage:)/m.test(extra);
}

function clamp(min: number, max: number, value: number): number {
	return Math.max(min, Math.min(max, value));
}
