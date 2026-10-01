import type {
	EngineAvailability,
	EngineCapabilities,
	EngineId,
	SpeechEngine,
	SynthRequest,
	SynthResult,
	VoiceInfo,
} from "../../audio/types";
import type { ProcessRunner, RunResult } from "./spawn";

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
 * `srs.md` R-S01 forbids claiming a voice is offline when we cannot tell.
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
 * Cap on the probe up to and including the last per-module listing (NRL-55).
 *
 * `spd-say -o espeak-ng -L` measured 0.387 s on this machine at spd-say
 * 0.12.0-rc2, and the probe is one such listing per module, so this is roughly
 * an order of magnitude of headroom. It exists so a wedged daemon degrades to
 * "every voice reports unknown" rather than to "the settings tab never opens".
 *
 * NRL-84: this is no longer a cap on the WHOLE probe. NRL-71's closing `-O`
 * runs under CLOSING_PROBE_TIMEOUT_MS instead, so the probe's worst case is
 * `probeTimeoutMs + closingTimeoutMs`, 5500 ms by default. Still bounded and
 * still deterministic; and this one still bounds the part that grows without
 * limit, which is the one listing per configured module.
 */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Cap on NRL-71's closing `spd-say -O` alone (NRL-84).
 *
 * The closing `-O` used to share PROBE_TIMEOUT_MS with the listings that run
 * before it, so N slow modules could spend the whole budget and leave it
 * nothing. It would then abort with a perfectly good reply in hand, the probe
 * would return null, and - the give-up being memoised with no retry - every
 * voice would report "unknown" for the life of the plugin instance.
 *
 * Measured this session on this machine (spd-say 0.12.0-rc2, two output
 * modules, read-only calls, daemon untouched): `spd-say -O` over n=15 ran a
 * median of 4.4 ms, min 3.0, max 7.2. 500 ms is ~69x that max and 10% of the
 * outer deadline, so it is headroom for a wedged daemon rather than a budget
 * the call can realistically reach.
 *
 * Deliberately NOT chained to the outer signal: the starvation case IS the
 * outer timer firing mid-closing-run, so forwarding the outer abort into this
 * scope would leave the behaviour exactly as it was. The outer deadline still
 * bounds everything before this run, which is where the unbounded growth lives.
 */
const CLOSING_PROBE_TIMEOUT_MS = 500;

/**
 * Pause before the one retry of a `-O` that lost the autospawn race (NRL-142).
 *
 * The loser exits within about 8 ms (7-8 ms over 3 shell trials at ship
 * time), long before the winner's daemon is accepting connections, and a
 * retry that arrives during that window tries to autospawn again and loses
 * the same way. Measured this session with the real bundled
 * module against a private spd-say 0.12.0-rc2 autospawned daemon, two engine
 * instances probing a stopped daemon at once: the winning `-O` returned at
 * 326-343 ms, and the retry still lost in 10 of 10 trials at a 0 ms delay and
 * 5 of 10 at 300 ms (retry issued at ~323 ms), and in 0 of 10 at 500 ms and 0
 * of 10 at 1000 ms. 500 is the smallest of those with no loss, about 180 ms
 * after the slowest winner. A slower or loaded machine spawns more slowly, so
 * this is a measured floor rather than a guarantee: if the retry also loses,
 * the probe reports unavailable exactly as it did before NRL-142, and the next
 * probe sees the then-running daemon.
 */
const RACE_RETRY_DELAY_MS = 500;

/**
 * Whether a failed `-O` lost the autospawn race to another client (NRL-142).
 *
 * Two spd-say clients that connect to a stopped autospawned daemon at the same
 * moment both try to spawn it; one wins, and the other exits 1 with one of two
 * reasons, and this machine's spd-say 0.12.0-rc2 printed both: "Speech
 * Dispatcher already running" in every losing trial during implementation, and
 * "Can't set lock on pid file" (the variant the ticket recorded) in 2 of 3
 * losing trials at ship time. Both are required to sit behind
 * "Autospawn failed", so a daemon that genuinely cannot start - "Can't bind
 * local socket", a plain connection refused, an empty stderr - is never
 * retried and still reports unavailable.
 *
 * Reads stderr only to classify it. It is never logged or echoed into a
 * reason: the reasons below stay fixed literals.
 */
function isAutospawnRaceLoss(stderr: string): boolean {
	return (
		stderr.includes("Autospawn failed") &&
		(stderr.includes("Can't set lock on pid file") || stderr.includes("Speech Dispatcher already running"))
	);
}

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

/**
 * Order-independent identity of a `-O` module list.
 *
 * Copies before sorting so the caller's array is not reordered, and does not
 * dedupe: ["a", "a"] and ["a"] read as different, which is the fail-closed
 * direction for the comparison this feeds.
 */
function moduleSetKey(modules: string[]): string {
	return [...modules].sort().join("\n");
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
	/**
	 * The availability probe currently running, shared by every caller that
	 * arrives while it is in flight (NRL-142). Cleared the moment it settles,
	 * so it is a coalescing point and never a cache: a daemon that appears or
	 * disappears later is still seen by the next call.
	 *
	 * Separate from `attribution` on purpose. That probe has its own `-O`
	 * calls, deadlines and call-count contract (NRL-71, NRL-83, NRL-84), and
	 * routing availability through it would change all three.
	 */
	private availabilityProbe: Promise<EngineAvailability> | null = null;

	constructor(
		private readonly runner: ProcessRunner,
		/**
		 * Overridden only by tests, which cannot sit out PROBE_TIMEOUT_MS to
		 * exercise the deadline. Production always takes the default.
		 */
		private readonly probeTimeoutMs: number = PROBE_TIMEOUT_MS,
		/**
		 * Overridden only by tests, which cannot sit out CLOSING_PROBE_TIMEOUT_MS
		 * to exercise the closing deadline. Production always takes the default.
		 */
		private readonly closingTimeoutMs: number = CLOSING_PROBE_TIMEOUT_MS,
		/**
		 * Overridden only by tests, which pass 0 so the suite never sleeps.
		 * Production always takes the default.
		 */
		private readonly raceRetryDelayMs: number = RACE_RETRY_DELAY_MS,
	) {}

	/**
	 * Concurrent callers share one in-flight probe (NRL-142). The plugin probes
	 * from more than one place at once - `onload`'s resolveAutomaticChoice()
	 * racing anything right after enable, and the settings tab's
	 * resolveAutomaticChoice()/getEngineStatuses() pair - and two `spd-say -O`
	 * clients reaching a stopped autospawned daemon together make one of them
	 * lose the spawn and read as "could not be reached".
	 */
	isAvailable(): Promise<EngineAvailability> {
		if (this.availabilityProbe) return this.availabilityProbe;
		const probe = this.probeAvailability().finally(() => {
			if (this.availabilityProbe === probe) this.availabilityProbe = null;
		});
		this.availabilityProbe = probe;
		return probe;
	}

	private async probeAvailability(): Promise<EngineAvailability> {
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
			// failing), so a single cold probe against a stopped daemon is fine.
			// What is NOT fine is two clients connecting to a stopped daemon at
			// the same moment (NRL-142): both try to spawn it, one wins, and
			// the other exits 1 even though the daemon is coming up. Our own
			// callers are coalesced in isAvailable(); another client (a screen
			// reader, a second plugin instance, a shell) cannot be, so that one
			// specific loss is retried exactly once below. Any other failed
			// autospawn still surfaces as a non-zero exit or a thrown run().
			let result = await this.runner.run("spd-say", ["-O"]);
			if (result.code !== 0 && result.signal === null && isAutospawnRaceLoss(result.stderr)) {
				await new Promise<void>((resolve) => setTimeout(resolve, this.raceRetryDelayMs));
				result = await this.runner.run("spd-say", ["-O"]);
			}
			const { code, stdout } = result;
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
			// success that simply printed less. Checking the abort flag is the only
			// way to tell the two apart, and it has to happen after every run: a
			// signal that aborted before spawn never fires the kill listener either,
			// so the runs after the deadline are not even interrupted.
			//
			// The abort flag alone is not enough, because it only ever sees a kill
			// *we* issued. An external SIGTERM - an OOM killer, a session teardown,
			// a user's pkill - truncates the listing with the flag still false
			// (measured: code 0, aborted false, stdout cut short mid-listing). A
			// truncated `-O` is not merely less information: dropping a
			// non-allowlisted module means it is never listed, never queried, and
			// the ambiguity that was keeping a shared NAME "unknown" disappears with
			// it, while two modules can still remain so the arity guard does not
			// fire. `RunResult.signal` is read here and in the per-module loop only:
			// the synthesize and `-S` paths below kill their own child on purpose and
			// must go on reading that as a success (NRL-41).
			if (controller.signal.aborted || modulesRun.signal !== null || modulesRun.code !== 0) {
				return null;
			}
			const modules = parseOutputModules(modulesRun.stdout.toString());
			// A differential needs two listings to compare, so a single-module
			// desktop can never attribute anything.
			if (modules.length < 2) return null;

			const perModule = new Map<string, SpdVoiceRow[]>();
			for (const module of modules) {
				const { code, stdout, signal } = await this.runner.run(
					"spd-say",
					["-o", module, "-L"],
					undefined,
					controller.signal,
				);
				// See the note on the `-O` run: a truncated listing is worse here than
				// a missing one, because losing a row from a non-allowlisted module's
				// listing removes the ambiguity that was keeping a shared name
				// "unknown", and it makes two identical listings differ, which is the
				// one thing the differential gate reads as proof that `-o` works. Our
				// own deadline shows up as `aborted`; any other kill shows up only as
				// a terminating signal, with `code` laundered to 0.
				if (controller.signal.aborted || signal !== null || code !== 0) return null;
				const rows = parseVoiceList(stdout.toString());
				// An unparseable listing would otherwise give this module an empty
				// canonical key, which trivially differs from a real one and would
				// falsely prove that scoping works.
				if (rows.length === 0) return null;
				perModule.set(module, rows);
			}

			// Re-read the module set (NRL-71). The probe is a sequence of separate
			// `spd-say` runs, so the daemon's configured modules can change between
			// them, and module ADDITION is the one direction that can produce a wrong
			// `local: true`: a non-allowlisted module configured in after `-O` was read
			// serves names the probe never observes it serving, so those names get
			// attributed to an allowlisted module alone. Removal already fails closed,
			// because `spd-say -o <gone> -L` falls back to the default module's full
			// listing and that fallback makes the shared names ambiguous.
			//
			// This NARROWS the window, it does not close it. A module can still be
			// added and removed entirely between the two `-O` calls, and the
			// per-module listings above are still read at N different instants. No
			// `spd-say` call reads the module list and the per-module listings as one
			// observation, so a real fix needs a different interface to the daemon (a
			// direct SSIP client) rather than a better sequence of `spd-say` calls,
			// which is deliberately out of scope. See docs/adr/0015 Residual risk.
			//
			// Compared as a parsed, order-independent set rather than as stdout bytes:
			// the daemon is not promised to list modules in a stable order, and a
			// reordered listing would otherwise cost every voice its attribution for
			// nothing. The same three checks as every other run here.
			//
			// NRL-84: its OWN controller and its OWN budget, not the outer probe's.
			// Sharing them meant the listings above could spend the whole deadline
			// and leave this run none, so an `-O` that answered cleanly - code 0, no
			// signal, the identical module set - was discarded solely because the
			// outer timer had fired while it was in flight, and every voice reported
			// "unknown" until the plugin reloaded. The outer abort is deliberately
			// NOT forwarded here: an outer deadline that expires BEFORE this run is
			// already caught by the loop's own abort check, so the only case left is
			// the one this scope exists to survive.
			//
			// Hence exactly ONE abort clause below, reading the signal this run was
			// actually given. Keeping `controller.signal.aborted ||` alongside it
			// would restore the old behaviour and, worse, make the pair untestable:
			// a fixture that expires the outer deadline sets both flags, so either
			// clause alone would survive deletion while the guard only looked pinned.
			// Cases M5 and M7 in tests/engine.test.ts hold the two halves apart.
			const closingScope = new AbortController();
			const closingTimer = setTimeout(() => closingScope.abort(), this.closingTimeoutMs);
			let againRun: RunResult;
			try {
				againRun = await this.runner.run("spd-say", ["-O"], undefined, closingScope.signal);
			} finally {
				clearTimeout(closingTimer);
			}
			if (closingScope.signal.aborted || againRun.signal !== null || againRun.code !== 0) {
				return null;
			}
			if (moduleSetKey(parseOutputModules(againRun.stdout.toString())) !== moduleSetKey(modules)) {
				return null;
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
				// voice, and `srs.md` R-S01 only forbids the unfounded offline claim.
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
