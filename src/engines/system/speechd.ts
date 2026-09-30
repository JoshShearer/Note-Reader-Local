import type {
	EngineAvailability,
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
	// True, but not by pausing anything: `spd-say` has no pause, only `-S` to
	// stop, so this engine deliberately implements neither SpeechEngine.pause()
	// nor resume(). The player recognises that and pauses it the way srs.md:250
	// sanctions instead - stop the utterance, keep the index, and re-read the
	// sentence from its start on resume. So the sound really does stop and the
	// reading really does come back, which is what this field is asked; what
	// differs from the other engines is only how far back the resume picks up.
	// Two caveats a user will notice, both inherited: the stop is the `-S` from
	// NRL-41, which cannot reach the one chunk already queued behind the spoken
	// one (about 830 ms of audio plays on, NRL-43), and the re-read repeats a
	// sentence they already heard the beginning of.
	pause: true,
	resume: true,
	sentenceBoundary: false,
	// This field is per-voice ("can say whether a GIVEN VOICE needs the
	// network", types.ts's own doc comment), not "is the daemon local
	// software" - that second claim is true but a different, coarser one.
	// `spd-say -L`'s columns are NAME/LANGUAGE/VARIANT only, with no module
	// column, so nothing in the listing itself attributes a voice to the
	// output module serving it.
	//
	// It stays false even though listVoices() can now attribute some voices
	// (NRL-55, docs/adr/0015): this is a compile-time constant, read before
	// any probe has run, so flipping it would promise per-voice
	// determinability on builds where the runtime self-check fails and every
	// voice correctly stays "unknown". Attribution is reported per voice, on
	// VoiceInfo.local, not through this flag.
	offlineStatus: false,
	// spd-say plays to the sound card and tells us nothing.
	ownsPlayback: true,
};

const ID_PREFIX = "speechd:";

/**
 * Output modules that are pure local synthesisers, so a voice served only by
 * one of them genuinely needs no network.
 *
 * Closed on purpose: these two are the only modules installed on this machine
 * and therefore the only ones anyone here could check. Adding a name means
 * establishing that the module never calls out, not guessing from its name -
 * srs.md:663 forbids claiming a voice is offline when we cannot tell.
 */
const LOCAL_MODULES = new Set(["espeak-ng", "openjtalk"]);

/** ~180 wpm, used only to pace the sentence queue. */
const CHARS_PER_SECOND = 14;

/**
 * How long to wait for a `-S` to land before speaking again anyway.
 *
 * The round trip measured 5 ms against the daemon on this machine, so this cap
 * should never be reached. It exists so a wedged daemon degrades to "speaks
 * over itself once" rather than to "never speaks again".
 */
const CANCEL_TIMEOUT_MS = 500;

/**
 * Cap on the whole module-attribution probe (NRL-55).
 *
 * `spd-say -o espeak-ng -L` measured 0.387 s on this machine at spd-say
 * 0.12.0-rc2, and the probe is one such listing per module, so this is roughly
 * an order of magnitude of headroom. It exists so a wedged daemon degrades to
 * "every voice reports unknown" rather than to "the settings tab never opens".
 */
const PROBE_TIMEOUT_MS = 5000;

interface SpdVoiceRow {
	name: string;
	lang: string;
	variant: string;
}

/**
 * The module names listed under `spd-say -O`'s "OUTPUT MODULES" header, which
 * prints bare names one per line with no columns.
 *
 * One parser, deliberately: isAvailable()'s zero-module guard and the
 * attribution probe's module list must not be able to disagree about what
 * counts as a module.
 */
function parseOutputModules(output: string): string[] {
	const lines = output.split("\n");
	const headerAt = lines.findIndex((l) => /OUTPUT MODULES/i.test(l));
	if (headerAt === -1) return [];
	return lines
		.slice(headerAt + 1)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/**
 * Count the module names listed under `spd-say -O`'s "OUTPUT MODULES"
 * header. The header matching alone (the old check) says nothing about
 * whether any module actually follows it.
 */
function countOutputModules(output: string): number {
	return parseOutputModules(output).length;
}

/** Identity of a `-L` row, for comparing one module's listing against another's. */
function rowKey(row: SpdVoiceRow): string {
	return `${row.name}\t${row.lang}\t${row.variant}`;
}

/** Order-independent identity of a whole listing. */
function canonicalKey(rows: SpdVoiceRow[]): string {
	return rows.map(rowKey).sort().join("\n");
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
	/**
	 * Voice NAMEs the module-attribution probe could confirm are served only by
	 * known-local modules, or null when it could not determine anything.
	 *
	 * The Promise is memoised rather than the value, so the settings tab and a
	 * concurrent setVoice() share one probe instead of racing two full listings.
	 */
	private attribution: Promise<Map<string, true> | null> | null = null;
	/**
	 * Utterances handed to the daemon and not yet finished. Read only by
	 * dispose(); the abort path never consults it, because a listener scoped to
	 * one call is self-evidently in flight and cannot go stale.
	 */
	private inFlight = 0;
	/** A `-S` that has been issued but may not have reached the daemon yet. */
	private cancelInFlight: Promise<void> | null = null;

	constructor(
		private readonly runner: ProcessRunner,
		/**
		 * Overridden only by tests, which cannot sit out PROBE_TIMEOUT_MS to
		 * exercise the deadline. Production always takes the default.
		 */
		private readonly probeTimeoutMs: number = PROBE_TIMEOUT_MS,
	) {}

	async isAvailable(): Promise<EngineAvailability> {
		if (!(await this.runner.which("spd-say"))) {
			return {
				available: false,
				reason:
					"Speech Dispatcher is unavailable because spd-say could not be found. Install or configure Speech Dispatcher and retry.",
			};
		}
		try {
			// -O lists configured output modules. spd-say's client autospawns
			// the daemon on connect (verified on this machine: pointing it at
			// an empty XDG_RUNTIME_DIR still started a fresh daemon rather than
			// failing), so "daemon unreachable" is not a state this probe can
			// normally observe when the spd-say binary itself exists - a failed
			// autospawn surfaces as a non-zero exit or a thrown run() below,
			// not as a distinguishable third case.
			const { code, stdout } = await this.runner.run("spd-say", ["-O"]);
			const text = stdout.toString();
			if (code !== 0 || !/OUTPUT MODULES/i.test(text)) {
				return {
					available: false,
					reason: "Speech Dispatcher is unavailable: spd-say could not be reached.",
				};
			}
			// The header line matching is not enough: it says nothing about
			// whether any module actually follows it. A daemon with no
			// synthesiser configured previously read as available here.
			if (countOutputModules(text) === 0) {
				return {
					available: false,
					reason:
						"Speech Dispatcher is installed but has no output module configured. Install a synthesizer (e.g. speech-dispatcher-espeak-ng) and configure it.",
				};
			}
			return { available: true };
		} catch (err) {
			return {
				available: false,
				reason: `Could not check Speech Dispatcher: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	/**
	 * Which voice NAMEs are served only by known-local output modules.
	 *
	 * Cached for the life of the engine, failures included. Caching a failure is
	 * deliberate: it degrades to "unknown" rather than to a wrong claim, and the
	 * alternative is re-paying a full voice listing per module on every
	 * settings-tab render.
	 *
	 * Called from listVoices() only. isAvailable() must not reach it: that path
	 * runs at startup and its fake runners throw on any unexpected call.
	 */
	private attributionMap(): Promise<Map<string, true> | null> {
		if (!this.attribution) this.attribution = this.probeAttribution();
		return this.attribution;
	}

	/**
	 * Attribute voices to output modules via `spd-say -o <module> -L`.
	 *
	 * `-o` scoping `-L` is undocumented (`spd-say --help` describes `-o` and
	 * `-O` but never their interaction), so it is not trusted, it is proved at
	 * runtime: the listings for two different modules must actually differ. On a
	 * build that ignores `-o` they do not, and then nothing is attributed. This
	 * matters concretely - measured at spd-say 0.12.0-rc2, `spd-say -o
	 * no-such-module -L` exits 0 and returns the full default 13363-line
	 * listing, so an allowlist that took `-o` on faith would have called 13,362
	 * espeak-ng voices local on any build where the flag means nothing.
	 *
	 * Every failure returns null, which listVoices() reads as "unknown". It can
	 * never produce `local: false`. See docs/adr/0015 for the residual risk the
	 * differential does not cover.
	 */
	private async probeAttribution(): Promise<Map<string, true> | null> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs);
		try {
			const modulesRun = await this.runner.run("spd-say", ["-O"], undefined, controller.signal);
			// The exit code cannot report the deadline. Aborting SIGKILLs the child,
			// a SIGKILLed child closes with a null code, and run() resolves
			// `code ?? 0` (spawn.ts), so a run cut short arrives looking like a
			// success that simply printed less. Checking the signal is the only way
			// to tell the two apart, and it has to happen after every run: a signal
			// that aborted before spawn never fires the kill listener either, so the
			// runs after the deadline are not even interrupted.
			if (controller.signal.aborted || modulesRun.code !== 0) return null;
			const modules = parseOutputModules(modulesRun.stdout.toString());
			// A differential needs two listings to compare, so a single-module
			// desktop can never attribute anything.
			if (modules.length < 2) return null;

			const perModule = new Map<string, SpdVoiceRow[]>();
			for (const module of modules) {
				const { code, stdout } = await this.runner.run(
					"spd-say",
					["-o", module, "-L"],
					undefined,
					controller.signal,
				);
				// See the note on the `-O` run: a truncated listing is worse here than
				// a missing one, because losing a row from a non-allowlisted module's
				// listing removes the ambiguity that was keeping a shared name
				// "unknown", and it makes two identical listings differ, which is the
				// one thing the differential gate reads as proof that `-o` works.
				if (controller.signal.aborted || code !== 0) return null;
				const rows = parseVoiceList(stdout.toString());
				// An unparseable listing would otherwise give this module an empty
				// canonical key, which trivially differs from a real one and would
				// falsely prove that scoping works.
				if (rows.length === 0) return null;
				perModule.set(module, rows);
			}

			// Not a count comparison: two modules can coincidentally serve the
			// same number of voices. Not "all listings pairwise distinct" either,
			// because with three modules two of them may genuinely serve the same
			// voice set while a third differs, and that third still proves scoping
			// is real. So the rule is only "not all identical".
			if (new Set([...perModule.values()].map(canonicalKey)).size < 2) return null;

			const servedBy = new Map<string, Set<string>>();
			for (const [module, rows] of perModule) {
				for (const row of rows) {
					let mods = servedBy.get(row.name);
					if (!mods) {
						mods = new Set();
						servedBy.set(row.name, mods);
					}
					mods.add(module);
				}
			}

			const attributed = new Map<string, true>();
			for (const [name, mods] of servedBy) {
				// A name served by both an allowlisted and a non-allowlisted module
				// is ambiguous: we cannot tell which one would speak it.
				if (mods.size > 0 && [...mods].every((m) => LOCAL_MODULES.has(m))) {
					attributed.set(name, true);
				}
			}
			return attributed;
		} catch {
			// A runner that rejects rather than resolving, e.g. spd-say missing
			// between isAvailable() and here. The deadline is handled by the
			// signal checks above, not here: it does not surface as a rejection.
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	async listVoices(): Promise<VoiceInfo[]> {
		try {
			const { code, stdout } = await this.runner.run("spd-say", ["-L"]);
			if (code !== 0) return [];
			const rows = parseVoiceList(stdout.toString());
			this.knownNames = new Set(rows.map((row) => row.name));
			const attributed = await this.attributionMap();
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
				// `-L` still has no module column, so the attribution comes from
				// the differential `-o` probe above rather than from this listing.
				// A probe that could not prove `-o` scoping, or a name it could not
				// pin to known-local modules alone, means unknown. This never
				// yields `local: false`: not knowing is not evidence of a network
				// voice, and srs.md:663 only forbids the unfounded offline claim.
				local: attributed?.has(row.name) ? true : ("unknown" as const),
				requiresNetwork: attributed?.has(row.name) ? false : ("unknown" as const),
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

		const result: SynthResult = {
			kind: "streamed",
			estimatedMs: (req.chunk.text.length / CHARS_PER_SECOND / (req.rate || 1)) * 1000,
			words: null,
		};

		// Already cancelled before we said anything, so the daemon has nothing
		// of ours to stop. Issuing the stop here would silence some other
		// client instead. The player discards this result: it re-checks the
		// signal the moment synthesize() resolves.
		if (signal.aborted) return result;

		// A replacement utterance must not reach the daemon before the previous
		// stop does, or that stop silences the replacement.
		await this.awaitPendingCancel();
		if (signal.aborted) return result;

		// Killing spd-say only kills the client: the daemon already has the text
		// and speaks it to the end, so an abort has to reach the daemon too.
		// Registered before the spawn, and abort listeners run synchronously, so
		// this cannot race the `finally` below the way a shared flag did.
		const onAbort = (): void => {
			this.cancelInFlight = this.stopDaemon();
		};
		signal.addEventListener("abort", onAbort, { once: true });

		this.inFlight += 1;
		try {
			const text = defuseCommands(req.chunk.text);
			const { stdout, code } = await this.runner.run("spd-say", args, text, signal);
			// Fixed strings only. With -e, stdout is an echo of the note text,
			// so neither it nor stderr may reach a message or a log.
			if (code !== 0 || reportsFailure(stdout.toString(), text)) {
				throw new Error("Speech synthesis failed");
			}
		} finally {
			this.inFlight -= 1;
			signal.removeEventListener("abort", onAbort);
		}

		return result;
	}

	/**
	 * Tell the daemon to stop the message it is speaking.
	 *
	 * `-S` is SSIP `STOP ALL`, not `STOP SELF`, which is the only reason this
	 * works: by the time it runs our own client has been SIGKILLed, so a
	 * connection-scoped stop would have nothing left to stop. The cost is that
	 * it also interrupts whatever another client (a screen reader sharing the
	 * daemon) is saying at that instant, so it must never be issued unless we
	 * really do have an utterance in flight. `-C` (`CANCEL ALL`) is deliberately
	 * never used: that would flush the other client's whole queue as well.
	 */
	private async stopDaemon(): Promise<void> {
		try {
			// No signal: this must survive the very abort that asked for it.
			await this.runner.run("spd-say", ["-S"]);
		} catch {
			// Best effort. A failed stop must not wedge the next utterance.
		}
	}

	/** Wait for a pending stop to land, but never indefinitely. */
	private async awaitPendingCancel(): Promise<void> {
		const pending = this.cancelInFlight;
		if (!pending) return;
		this.cancelInFlight = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				pending,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, CANCEL_TIMEOUT_MS);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async dispose(): Promise<void> {
		// An utterance can still be at the daemon here, e.g. if the plugin is
		// disabled mid-sentence. If the player stopped us first then the abort
		// listener has already run and there is correctly nothing to do.
		if (this.inFlight > 0) await this.stopDaemon();
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
