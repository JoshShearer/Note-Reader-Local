import {
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	type TAbstractFile,
	type WorkspaceLeaf,
	getLanguage,
	moment,
} from "obsidian";
import { EditorView } from "@codemirror/view";

import { Player } from "./audio/player";
import { describeUnavailable, type SpeechChunk, type SpeechEngine, type VoiceInfo } from "./audio/types";
import { playWithFallback, type FallbackCandidate } from "./audio/fallback";
import { extractChunks } from "./text/extract";
import { platformSegmenters } from "./text/segment";
import { resolveStoredVoice } from "./audio/voiceChoice";
import { applySelectionReadGate, clipChunksToSelection, type SelectionReadPort } from "./audio/clip";
import { createEngines, findEngine, probeEngines, resolveWeights } from "./engines/registry";
import {
	KokoroEngine,
	KOKORO_WEIGHTS,
	voiceFilePath,
	type KokoroOptions,
	type WeightsPreference,
} from "./engines/onnx/kokoro";
import { WebSpeechEngine } from "./engines/webspeech";
import {
	rankEngines,
	resolveSelection,
	type EngineProbe,
	type EngineSelection,
	type RankedCandidate,
} from "./engines/selection";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import { loadPluginData, serialisePluginData, type PluginData } from "./settings/data";
import { PositionThrottle } from "./settings/positionThrottle";
import { SaveQueue } from "./settings/saveQueue";
import { applyVaultDelete, applyVaultRename, type VaultEventPort } from "./settings/vaultEvents";
import {
	applyHighlightLayers,
	applySentenceHighlight,
	applyWordHighlight,
	clearHighlights,
	clearSentenceHighlight,
	clearWordHighlight,
	highlightPlan,
	isScrollSuppressed,
	registerHighlighting,
	registerScrollSuppression,
	resetScrollSuppression,
	scrollTargetForChunk,
	shouldHighlightLeaf,
	type HighlightLayers,
} from "./ui/highlight";
import {
	WORD_HIGHLIGHT_VAR,
	SENTENCE_HIGHLIGHT_VAR,
	applyWordHighlightColour,
	applySentenceHighlightColour,
} from "./ui/highlightColour";
import {
	createModelStore,
	type VaultModelStore,
} from "./ui/modelStore";
import { withLoadingNotice } from "./ui/loadingNotice";
import { reportError, trace } from "./diagnostics";
import { LocalTtsSettingTab } from "./ui/settingsTab";
import { ControlBar } from "./ui/controlBar";
import { controlAffordances } from "./ui/affordances";

export default class LocalTtsReaderPlugin extends Plugin {
	override settings: Settings = { ...DEFAULT_SETTINGS };
	/**
	 * The loaded data.json container. Held so saveSettings() writes back the
	 * version, positions and any keys this build does not know about, instead
	 * of replacing the whole file with the settings object.
	 */
	private pluginData!: PluginData;

	private engines: SpeechEngine[] = [];
	private player!: Player;
	private modelStore!: VaultModelStore;
	private activeEditor: EditorView | null = null;
	/**
	 * The current read's cancellation scope (NRL-48).
	 *
	 * Not the Player's: `Player` creates its own controller inside `play()`, so
	 * for the whole time a read is resolving voices and loading an engine model
	 * there is nothing on the Player to abort, and `Player.stop()` during that
	 * window is a no-op. This controller covers exactly that earlier phase, is
	 * aborted by `stopReading()` (and by unload), and is superseded whenever a
	 * new read starts.
	 */
	private readScope: AbortController | null = null;
	private controlBar!: ControlBar;
	/**
	 * Throttled reading-position writes. Its own module because main.ts cannot be
	 * tested at all (obsidian has no runtime) and the window needs a clock the
	 * test owns; see src/settings/positionThrottle.ts.
	 */
	private positionThrottle!: PositionThrottle;
	/**
	 * The single funnel for every durable write. One write in flight, one pending
	 * payload, newest wins; see src/settings/saveQueue.ts for why ordering the
	 * writes is the whole point.
	 */
	private saveQueue!: SaveQueue;
	/**
	 * Everything the vault rename/delete orchestration needs from obsidian. The
	 * orchestration itself lives in src/settings/vaultEvents.ts so it is reachable
	 * from the suite; this object is the only part that cannot be.
	 */
	private vaultEvents!: VaultEventPort;
	/**
	 * The last automatic resolution computed, so `activeEngine()` has a sync
	 * answer for UI call sites that cannot await (checkCallback, the control
	 * bar). Only meaningful when `settings.engine === "auto"`; refreshed by
	 * `resolveAutomaticChoice()`, which is the async, authoritative source of
	 * truth (docs/adr/0010).
	 */
	private autoResolution: RankedCandidate | null = null;

	override async onload(): Promise<void> {
		trace(this.app, this.manifest.dir!, "plugin loaded");

		this.pluginData = loadPluginData(await this.loadData());
		this.settings = this.pluginData.settings;
		// Immediately after the container and before anything else in onload, not
		// beside the PositionThrottle below: saveSettings() now routes through this
		// and nothing in onload may save before it exists. Nothing between here and
		// there saves today, so this is a guard against a later insertion rather
		// than a fix for a present ordering bug.
		this.saveQueue = new SaveQueue({
			write: (payload) => this.saveData(payload),
			// The same expression saveSettings() computes below, so a retry
			// (NRL-91) reads live settings at the moment it fires and can never
			// resurrect the stale payload that was rejected.
			getCurrentPayload: () => serialisePluginData(this.pluginData, this.settings),
			onAttemptFailed: (err, attempt) => {
				trace(this.app, this.manifest.dir!, `save attempt ${attempt} failed`, err);
			},
			onError: (err) => {
				reportError(this.app, this.manifest.dir!, "save failed", err);
			},
		});
		this.applyHighlightColour();

		this.modelStore = createModelStore(
			this.app,
			this.manifest.dir!,
			this.settings.kokoroModelPath,
		);

		this.engines = createEngines(this.modelStore, this.kokoroOptions());

		// Which backend the engine settled on, and why the faster ones were
		// rejected, is the single most useful thing in a performance report.
		const kokoro = findEngine(this.engines, "kokoro");
		if (kokoro instanceof KokoroEngine) {
			kokoro.onInfo((message) => trace(this.app, this.manifest.dir!, "kokoro", message));
		}

		this.player = new Player({ bufferAhead: this.settings.bufferAhead });
		// The player is the one authority on rate (srs.md R-M16). Seed it from
		// settings before anything observes it, so the control bar and the
		// settings slider start from the same value.
		this.player.setRate(this.settings.rate);
		this.player.setPitch(this.settings.pitch);

		this.positionThrottle = new PositionThrottle({
			save: (chunkIndex) => {
				void this.savePosition(chunkIndex).catch((err: unknown) => {
					reportError(this.app, this.manifest.dir!, "save reading position failed", err);
				});
			},
			currentFilePath: () => this.player.getFilePath(),
			timers: {
				setTimeout: (fn, ms) => window.setTimeout(fn, ms),
				clearTimeout: (handle) => window.clearTimeout(handle as number),
			},
		});

		// After the player, because the port reads the queue's file path off it.
		this.vaultEvents = {
			currentFilePath: () => this.player.getFilePath(),
			stop: () => this.stopReading(),
			positions: () => this.pluginData.positions,
			setPositions: (next) => {
				// The FIELD, never the container: a rebuilt root would take every
				// key this build does not know about with it (non-negotiable 10).
				this.pluginData.positions = next;
			},
			save: () => {
				void this.saveSettings().catch(() => {
					// Deliberately swallowed, and it is not a lost error. The
					// SaveQueue's onError above reports every write that could not
					// be saved (even after retrying, NRL-91) exactly once, so
					// reporting here as well would show the user two notices for
					// one failure; and the trace line the orchestration emits
					// immediately before this names which event it was.
				});
			},
			trace: (step, detail) => trace(this.app, this.manifest.dir!, step, detail),
		};

		// After the loadPluginData() call above and not before: a vault event
		// arriving first would hit a `!`-initialised field. Registered through
		// registerEvent, so both are torn down with the plugin.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => this.handleVaultRename(file, oldPath)),
		);
		this.registerEvent(this.app.vault.on("delete", (file) => this.handleVaultDelete(file)));
		// NRL-89: nothing previously watched a leaf change, so switching notes
		// mid-read left the chunk/word handlers' existing `!this.activeEditor`
		// guards pointed at whichever editor `retargetHighlightEditor` last
		// touched - the note the read STARTED on, not the one now in front.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => this.handleActiveLeafChange(leaf)),
		);

		// Sentence-level highlighting. Ranges come from the chunk's source
		// offsets, never from searching the editor (non-negotiable 8).
		this.player.on("chunk", (chunk) => this.renderChunkHighlight(chunk));

		// Word-level highlighting, drawn over the sentence rather than replacing
		// it. This handler must never clear the sentence layer.
		this.player.on("word", (payload) => {
			// The view can be closed mid-playback; a missing editor just means
			// there is nothing left to highlight.
			if (!this.activeEditor) return;
			if (!payload || !this.highlightLayers().word) {
				clearWordHighlight(this.activeEditor);
				return;
			}
			applyWordHighlight(this.activeEditor, {
				from: payload.timing.sourceStart,
				to: payload.timing.sourceEnd,
			});
		});

		this.player.on("progress", (progress) => {
			// Track reading position for resume.
			//
			// The path comes from the player, not from the active view. The
			// active view is whatever note happens to be in front, which is the
			// wrong file the moment the user switches notes mid-read - the queue
			// behind is still the note the reading started on. The gate is a
			// non-empty path rather than an active editor, so a read whose note
			// is no longer in front still records where it got to; otherwise
			// closing the view would silently discard the last position.
			//
			// The throttle writes the first event of a window immediately and
			// keeps the newest of the rest for a trailing flush, so a saveData per
			// progress event is avoided without losing the last one before a stop.
			const filePath = this.player.getFilePath();
			if (filePath) this.positionThrottle.note(filePath, progress.chunkIndex);
		});

		this.player.on("state", (state) => {
			if (state === "finished" || state === "idle") this.clearBothHighlights();
			// Every state change that ends the user's attention closes the window,
			// which is what makes the final second survive. One place rather than
			// patching stopReading() and the two toggle() call sites: setState is
			// the only route into all of them, and it early-returns on an unchanged
			// state, so a stop from idle cannot re-save a stale queue.
			//
			// "finished" is in the set for a reason that is easy to miss: on
			// natural completion getIndex() is chunks.length, so there is no chunk
			// to read. The flush writes its captured index instead, and that is the
			// last chunk - without this it would be lost whenever its progress
			// event landed inside an open window.
			if (state === "paused" || state === "idle" || state === "finished") {
				this.positionThrottle.flush();
			}
		});

		this.player.on("error", (err) => {
			this.clearBothHighlights();
			reportError(this.app, this.manifest.dir!, "playback failed", err);
		});

		this.player.on("timerExpired", () => {
			new Notice("Sleep timer expired.");
			this.clearBothHighlights();
		});

		this.controlBar = new ControlBar(this);
		this.refreshEngineAffordances();
		// Kicked off now, not deferred to onLayoutReady: cheap (no model load,
		// no download - just store.exists() and a GPU probe), and it feeds
		// activeEngine()'s sync cache, which the control bar and the palette's
		// checkCallback read before anything else has a chance to await it.
		if (this.settings.engine === "auto") void this.resolveAutomaticChoice();

		this.addRibbonIcon("audio-lines", "Read this note aloud", () => {
			void this.readActiveNote().catch((err: unknown) => {
				reportError(this.app, this.manifest.dir!, "readActiveNote failed", err);
			});
		});

		this.addCommand({
			id: "read-note",
			name: "Read note aloud",
			callback: () => {
				void this.readActiveNote().catch((err: unknown) => {
					reportError(this.app, this.manifest.dir!, "readActiveNote failed", err);
				});
			},
		});

		this.addCommand({
			id: "read-selection",
			name: "Read selection",
			checkCallback: (checking: boolean) => {
				const editor = this.currentEditor()?.editor;
				if (!editor) return false;
				const hasSelection = !editor.state.selection.main.empty;
				if (!checking && hasSelection) {
					const sel = editor.state.selection.main;
					void this.readSelection(sel.from, sel.to);
				}
				return hasSelection;
			},
		});

		this.addCommand({
			id: "read-from-cursor",
			name: "Read from cursor",
			checkCallback: (checking: boolean) => {
				const editor = this.currentEditor()?.editor;
				if (!editor) return false;
				if (!checking) {
					const cursorPos = editor.state.selection.main.from;
					void this.readFromCursor(cursorPos);
				}
				return true;
			},
		});

		this.addCommand({
			id: "toggle-playback",
			name: "Pause or resume reading",
			// Gated for the same reason the control bar's button is (R-M14), and
			// it has to be gated here too: disabling the button alone still left
			// the palette able to reach a state the player could not leave.
			//
			// All four engines currently declare pause, so this never hides
			// today. It is not dead: an engine that owns playback, implements
			// neither SpeechEngine.pause() nor resume(), and cannot take the
			// player's stop-and-retain route either would declare false, and the
			// palette must not offer it a command that parks a reading nothing
			// can restart. The reason is the capability, never ownsPlayback.
			//
			// checkCallback hides the command instead of showing a reason, which
			// is the other half of what R-M14 permits. A palette entry has no
			// tooltip to put a reason in, and an entry that runs and does
			// nothing is the defect, not the absence.
			checkCallback: (checking: boolean) => {
				if (!this.canPause()) return false;
				if (!checking) this.player.toggle();
				return true;
			},
		});

		this.addCommand({
			id: "stop-reading",
			name: "Stop reading",
			callback: () => this.stopReading(),
		});

		this.addCommand({
			id: "replay-sentence",
			name: "Repeat current sentence",
			callback: () => void this.player.replayCurrent(),
		});

		this.addCommand({
			id: "next-sentence",
			name: "Next sentence",
			checkCallback: (checking: boolean) => {
				const isPlaying = this.player.getState() !== "idle" && this.player.getState() !== "finished";
				if (!checking && isPlaying) void this.player.next();
				return isPlaying;
			},
		});

		this.addCommand({
			id: "previous-sentence",
			name: "Previous sentence",
			checkCallback: (checking: boolean) => {
				const isPlaying = this.player.getState() !== "idle" && this.player.getState() !== "finished";
				if (!checking && isPlaying) void this.player.previous();
				return isPlaying;
			},
		});

		this.addCommand({
			id: "test-android-native-tts",
			name: "Test Android native TTS",
			callback: () => {
				void this.testAndroidNativeTts();
			},
		});

		this.addSettingTab(new LocalTtsSettingTab(this.app, this));

		// Loading Kokoro takes seconds, and doing it on the first click is what
		// makes the plugin feel broken rather than slow. Start it now, in the
		// background, so the model is usually hot by the time anyone asks.
		// Failures here are not worth a Notice: nothing was requested yet, and
		// the same failure will surface properly on the first real attempt.
		this.app.workspace.onLayoutReady(() => {
			void this.warmUpEngine();
		});
	}

	/** Load the selected engine's heavy resources ahead of the first request. */
	private async warmUpEngine(): Promise<void> {
		const engine = this.activeEngine();
		if (!engine?.prepare) return;
		try {
			if (!(await engine.isAvailable()).available) return;
			const started = Date.now();
			await engine.prepare();
			trace(
				this.app,
				this.manifest.dir!,
				"engine prewarmed",
				`${engine.id} in ${Date.now() - started}ms`,
			);
		} catch (err) {
			trace(this.app, this.manifest.dir!, "prewarm failed", err);
		}
	}

	/**
	 * SPIKE-ANDROID-001 (NRL-35): the acceptance-criteria artifact itself, not
	 * just a doc. Investigates the four routes the spec orders (srs.md:1197),
	 * in order, and reports PASS or BLOCKED_BY_HOST via Notice.
	 *
	 * Steps 1 and 2 are not runtime-checkable: there is no documented Obsidian
	 * API surface for TTS to probe, and confirming its absence is exactly what
	 * manual investigation against a real device did (docs/spikes/SPIKE-ANDROID-001.md).
	 * This command starts at step 3, the two routes JS can actually attempt.
	 */
	private async testAndroidNativeTts(): Promise<void> {
		const PHRASE = "Obsidian text to speech test.";

		// Step 3: WebView/Web Speech access to installed system voices.
		if (typeof window !== "undefined" && "speechSynthesis" in window) {
			try {
				await new Promise<void>((resolve, reject) => {
					const utterance = new SpeechSynthesisUtterance(PHRASE);
					utterance.onstart = () => resolve();
					utterance.onerror = (event) =>
						reject(new Error(event.error || "speechSynthesis error"));
					window.speechSynthesis.speak(utterance);
					// Measured on a real Android WebView (SPIKE-ANDROID-001): the API
					// can be entirely absent, so a WebView that accepts the call but
					// never fires either event must not hang this command forever.
					window.setTimeout(
						() => reject(new Error("no onstart/onerror within 3s")),
						3000,
					);
				});
				new Notice("Android native TTS: PASS via Web Speech API.", 8000);
				trace(this.app, this.manifest.dir!, "android TTS spike", "PASS via webspeech");
				return;
			} catch (err) {
				trace(this.app, this.manifest.dir!, "android TTS spike: webspeech failed", err);
			}
		}

		// Step 4: safe plugin-accessible Capacitor facilities. Obsidian's Android
		// build is a Capacitor app, but `Capacitor.Plugins` only ever contains
		// the fixed whitelist compiled into that build (App, Filesystem,
		// Preferences, ...); a community plugin cannot add a new native plugin
		// without a custom Obsidian build, which the spike forbids.
		const capacitor = (
			window as unknown as {
				Capacitor?: {
					isPluginAvailable?: (name: string) => boolean;
					Plugins?: Record<string, { speak?: (opts: { text: string }) => Promise<unknown> }>;
				};
			}
		).Capacitor;
		if (capacitor?.isPluginAvailable?.("TextToSpeech")) {
			try {
				await capacitor.Plugins?.TextToSpeech?.speak?.({ text: PHRASE });
				new Notice("Android native TTS: PASS via Capacitor TextToSpeech.", 8000);
				trace(this.app, this.manifest.dir!, "android TTS spike", "PASS via capacitor");
				return;
			} catch (err) {
				trace(this.app, this.manifest.dir!, "android TTS spike: capacitor failed", err);
			}
		}

		new Notice(
			"Android native TTS: BLOCKED_BY_HOST. No Obsidian TTS facility, native bridge, " +
				"Web Speech API, or Capacitor TextToSpeech plugin is reachable from an ordinary " +
				"community plugin on this device. See docs/spikes/SPIKE-ANDROID-001.md.",
			15000,
		);
		trace(this.app, this.manifest.dir!, "android TTS spike", "BLOCKED_BY_HOST");
	}

	override onunload(): void {
		// This path calls player.dispose() rather than stopReading(), so it has
		// to abort the read scope itself or an in-flight engine load would go on
		// to start speaking through a disposed plugin.
		this.readScope?.abort();
		this.readScope = null;
		// Before the player, and unconditionally: a trailing flush that fired
		// after dispose would call savePosition on an unloaded plugin. Nothing
		// cleared the window handle before this - it leaked on every path.
		this.positionThrottle?.dispose();
		// After the position flush above has had its one synchronous chance to
		// enqueue a final write (which may itself arm a retry if that write
		// later fails): clears only the armed-retry-timer resource NRL-91
		// introduces, a leak this ticket would otherwise add on top of the
		// pre-existing gap. Deliberately does NOT await or drain the in-flight
		// write itself - onunload() is synchronous and Obsidian gives it no
		// hook to wait for one; see docs/adr/0026 for the bound this leaves.
		this.saveQueue?.dispose();
		this.controlBar?.destroy();
		this.player?.dispose();
		// Both, or the sentence property outlives the plugin on document.body.
		// highlightColour.ts's own comment promises "leaves nothing behind on
		// unload", and ADR 0005 says the same.
		document.body.style.removeProperty(WORD_HIGHLIGHT_VAR);
		document.body.style.removeProperty(SENTENCE_HIGHLIGHT_VAR);
		for (const engine of this.engines) void engine.dispose();
	}

	// --- Reading ------------------------------------------------------------

	/**
	 * The active note, as text plus the CodeMirror view to decorate.
	 *
	 * Obsidian's public `Editor` is a wrapper that has `getValue` and
	 * `transaction`, not `dispatch`, so it cannot be used as a CodeMirror
	 * `EditorView` even though it looks like one. `EditorView.findFromDOM`
	 * walks up from the view's container to the real view, which is the
	 * supported way to get at it. The `cm` property is the fallback for older
	 * builds where the container lookup comes up empty.
	 */
	private currentEditor(): { editor: EditorView; source: string; filePath: string } | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;

		const editor =
			EditorView.findFromDOM(view.containerEl) ??
			((view.editor as unknown as { cm?: EditorView }).cm ?? null);
		if (!editor) return null;

		const filePath = view.file?.path ?? "";
		return { editor, source: view.editor.getValue(), filePath };
	}

	async readActiveNote(): Promise<void> {
		const t = (step: string, detail?: unknown) =>
			trace(this.app, this.manifest.dir!, step, detail);
		t("readActiveNote: entered");

		const current = this.currentEditor();
		if (!current) {
			t("no editor found", "getActiveViewOfType(MarkdownView) or CodeMirror view");
			new Notice("Open a note first.");
			return;
		}
		t("editor found", `${current.source.length} chars`);

		// A new read supersedes the previous one, and holds its own local handle
		// so a later read aborting this.readScope cannot be mistaken for a Stop
		// of this read (NRL-48).
		this.readScope?.abort();
		const scope = (this.readScope = new AbortController());

		this.retargetHighlightEditor(current.editor);
		registerHighlighting(current.editor);
		registerScrollSuppression(current.editor);
		resetScrollSuppression(current.editor);

		const chunks = extractChunks(
			current.source,
			{
				stripTags: this.settings.skipTags,
				speakUrls: this.settings.speakUrls,
				skipCodeBlocks: this.settings.skipCodeBlocks,
				skipInlineCode: this.settings.skipInlineCode,
				skipTables: this.settings.skipTables,
				skipHeadings: this.settings.skipHeadings,
				skipFrontmatter: this.settings.skipFrontmatter,
				speakImageAlt: this.settings.speakImageAlt,
				speakEmbeds: this.settings.speakEmbeds,
				// Not a setting: the UI language, which is what the segmenters are
				// built with. appLocale() never throws and falls back to "en".
				locale: appLocale(),
			},
			platformSegmenters,
			current.filePath,
		);
		t("chunks extracted", `${chunks.length}`);

		if (chunks.length === 0) {
			new Notice("Nothing to read in this note.");
			return;
		}

		// Captured once, as its own local: `this.settings.engine` is a mutable
		// property, so re-reading it inside the `else` branch below would not
		// narrow from EngineSelection to EngineId the way this local does.
		const selection = this.settings.engine;
		const isAutomatic = selection === "auto";
		let candidates: FallbackCandidate[];
		if (isAutomatic) {
			t("resolving automatic candidates", "auto");
			candidates = await this.rankedCandidates();
			t("automatic candidates resolved", candidates.map((c) => c.id).join(","));
			if (candidates.length === 0) {
				new Notice("Local TTS Reader: no speech engine is available; check settings.", 8000);
				return;
			}
		} else {
			const engineId = selection;
			const engine = findEngine(this.engines, engineId);
			if (!engine) {
				t(
					"no engine matched",
					`engineId=${engineId} available=${this.engines.map((e) => e.id).join(",")}`,
				);
				new Notice(`Local TTS Reader: no engine named "${engineId}".`, 6000);
				return;
			}
			t("engine matched", engineId);

			t("checking isAvailable", engineId);
			const availability = await engine.isAvailable();
			t("isAvailable returned", `${engineId}=${availability.available}`);
			if (!availability.available) {
				new Notice(
					`Local TTS Reader: ${describeUnavailable(availability.reason, "Pick another engine in settings.")}`,
					8000,
				);
				return;
			}
			candidates = [{ engine, id: engineId, reason: "Manually selected." }];
		}

		// Resume from the stored position for this file, if there is one.
		//
		// The offset is passed through as stored rather than resolved to a chunk
		// here. Player.findIndex is the same search done better: it matches on
		// `sourceEnd >`, so an offset sitting in a span nothing was spoken from
		// (a skipped code block) still resolves to the chunk after it. The
		// pre-filter this replaces required `sourceStart <= off < sourceEnd`, so
		// such an offset found no chunk and startAtSource stayed -1, which Player
		// read as "the top of the note" - a stored position from inside a code
		// block restarted the note. Past-the-end was the same hole, and Player
		// owns the nearest-valid fallback for it too (srs.md:441, R-M12).
		let startAtSource = -1;
		const filePath = current.filePath;
		const storedPosition = this.pluginData.positions?.[filePath];
		if (storedPosition) {
			startAtSource = storedPosition.sourceOffset;
			t("resume from stored position", `${filePath} @ ${startAtSource}`);
		}

		const result = await playWithFallback(this.player, candidates, chunks, this.settings.rate, this.settings.pitch, {
			beforeAttempt: (candidate) =>
				this.prepareCandidate(candidate, isAutomatic, current.filePath, scope.signal),
			onFallback: (from, to, err) => {
				t("fallback", `${from.id} -> ${to.id}: ${errText(err)}`);
				new Notice(
					`Local TTS Reader: ${from.engine.label} failed (${errText(err)}); trying ${to.engine.label}.`,
					6000,
				);
			},
		}, startAtSource, scope.signal);

		// A null result means either "every candidate failed" or "the user
		// pressed Stop". Only the controller can tell them apart, and blaming
		// the engines for a Stop would be a lie (NRL-48).
		if (scope.signal.aborted) {
			t("read cancelled during load", candidates.map((c) => c.id).join(","));
			return;
		}

		if (!result) {
			t("no candidate succeeded", candidates.map((c) => c.id).join(","));
			new Notice("Local TTS Reader: no speech engine is available; check settings.", 8000);
			return;
		}

		if (isAutomatic) this.autoResolution = { id: result.id, reason: result.reason };

		// Initialize sleep timer if preset is not "off"
		const timerMs = this.presetToMs(this.settings.timerPreset);
		if (timerMs > 0) this.player.setTimer(timerMs);

		const runtime = result.engine.runtimeInfo?.();
		new Notice(
			`Reading ${chunks.length} passages with ${result.engine.label}${runtime ? ` on ${runtime}` : ""}.`,
		);
		t("playback started", result.id);
	}

	/**
	 * One candidate's pre-synthesis work: resolve its voice, then load its model
	 * behind a "Loading X..." Notice.
	 *
	 * Factored out of the three read paths (NRL-48) because it was triplicated
	 * and the abort handling that now wraps it should exist once. The trace
	 * calls carry an engine id and a millisecond count only - never note text -
	 * so keeping them in the shared copy is safe, and it means `readSelection`
	 * and `readFromCursor` gain the tracing `readActiveNote` already had.
	 *
	 * The `signal` parameter dismisses the NOTICE, not the load. `prepare()`
	 * still takes no signal and is not cancelled: a Stop abandons the await in
	 * `playWithFallback`, the bytes keep arriving and a finished model is kept
	 * for the next read (docs/adr/0013, unchanged). What NRL-65 adds is that the
	 * `Loading X...` Notice is hidden at the Stop rather than when that
	 * abandoned load eventually settles - it is built with duration 0, so it
	 * never self-dismisses on its own. The signal arrives as an explicit
	 * argument rather than being read off `this.readScope`, because that field
	 * is reassigned by the next read and this method belongs to one particular
	 * read; see the comment at the call to `withLoadingNotice` below.
	 */
	private async prepareCandidate(
		candidate: FallbackCandidate,
		isAutomatic: boolean,
		filePath: string,
		signal?: AbortSignal,
	): Promise<void> {
		const voices = await this.voicesForSelection(candidate.engine, isAutomatic);
		// Note language for voice selection (priority: frontmatter lang > app locale)
		const noteLang = this.extractNoteLanguage(filePath);
		await this.selectVoiceIfNeeded(candidate.engine, voices, noteLang);

		// Loading can take seconds. Say so, rather than announcing playback that
		// will not start yet and leaving the silence to speak for itself.
		if (candidate.engine.prepare && candidate.engine.isPrepared?.() === false) {
			// Bound before the thunk: TypeScript does not carry the
			// optional-method narrowing above across a closure boundary, so
			// `candidate.engine.prepare()` inside the arrow would not typecheck.
			const load = candidate.engine.prepare.bind(candidate.engine);
			// `signal` is the argument, never `this.readScope`. That field is a
			// MUTABLE one, reassigned at the top of all three read paths, and
			// this method runs inside `beforeAttempt`, i.e. inside an await
			// chain belonging to ONE read. If a second read starts while this
			// one's candidate is still loading, the field already points at the
			// new read's controller, so reading it here would never dismiss
			// this read's own Notice on its own Stop, and would let a later
			// read's abort dismiss a Notice that is not its own. That is the
			// rule NRL-48 established; the captured `scope` local at each call
			// site is the per-read identity.
			await withLoadingNotice(
				() => new Notice(`Loading ${candidate.engine.label}...`, 0),
				async () => {
					trace(this.app, this.manifest.dir!, "loading engine", candidate.id);
					const started = Date.now();
					await load();
					trace(
						this.app,
						this.manifest.dir!,
						"engine loaded",
						`${candidate.id} in ${Date.now() - started}ms`,
					);
				},
				signal,
			);
		}
	}

	/**
	 * Voices `selectVoiceIfNeeded` is allowed to substitute from.
	 *
	 * In automatic mode, Web Speech is only ever offered voices
	 * `hasLocalVoice()` already gated as local (see `buildProbes()`) - and
	 * that gate has to reach the actual voice choice too, or a webspeech
	 * candidate that was ranked because SOME voice is local could still have
	 * a network voice substituted in as the one actually spoken, quietly
	 * reopening the non-negotiable-4 gap this ticket closes. A manual pin to
	 * Web Speech is unaffected: it always sees every voice, unchanged.
	 */

	private async readSelection(from: number, to: number): Promise<void> {
		const current = this.currentEditor();
		if (!current) {
			new Notice("Open a note first.");
			return;
		}

		const chunks = extractChunks(
			current.source,
			{
				stripTags: this.settings.skipTags,
				speakUrls: this.settings.speakUrls,
				skipCodeBlocks: this.settings.skipCodeBlocks,
				skipInlineCode: this.settings.skipInlineCode,
				skipTables: this.settings.skipTables,
				skipHeadings: this.settings.skipHeadings,
				skipFrontmatter: this.settings.skipFrontmatter,
				speakImageAlt: this.settings.speakImageAlt,
				speakEmbeds: this.settings.speakEmbeds,
				locale: appLocale(),
			},
			platformSegmenters,
			current.filePath,
		);

		// Each chunk's slice is derived from its own sourceIndex, never from
		// raw-offset arithmetic: markdown stripping breaks the
		// one-raw-character-to-one-spoken-character assumption that
		// `from - chunk.sourceStart` needed (non-negotiable 8, NRL-57).
		const selectedChunks = clipChunksToSelection(chunks, from, to);

		// NRL-92: selectedChunks is computed and checked BEFORE the in-flight
		// read is touched. A selection that turns out to hold nothing
		// speakable - because it held only content extraction excludes, e.g.
		// a %%comment%% or a skipped code span - must leave whatever is
		// currently playing untouched rather than aborting it and showing a
		// Notice in its place. applySelectionReadGate is the one place that
		// ordering is enforced; see src/audio/clip.ts for why the order is
		// the whole point and not an implementation detail.
		const port: SelectionReadPort = {
			abort: () => this.readScope?.abort(),
			retarget: () => {
				this.retargetHighlightEditor(current.editor);
				registerHighlighting(current.editor);
				registerScrollSuppression(current.editor);
				resetScrollSuppression(current.editor);
			},
			showEmptyNotice: () => new Notice("No text in selection."),
		};
		if (!applySelectionReadGate(port, selectedChunks)) return;

		const scope = (this.readScope = new AbortController());

		const selection = this.settings.engine;
		const isAutomatic = selection === "auto";
		let candidates: FallbackCandidate[];
		if (isAutomatic) {
			candidates = await this.rankedCandidates();
			if (candidates.length === 0) {
				new Notice("No speech engines available.", 8000);
				return;
			}
		} else {
			const engine = findEngine(this.engines, selection);
			if (!engine) {
				new Notice(`Engine ${selection} not available.`, 8000);
				return;
			}
			candidates = [{ engine, id: selection, reason: "" }];
		}

		await playWithFallback(this.player, candidates, selectedChunks, this.settings.rate, this.settings.pitch, {
			beforeAttempt: (candidate: FallbackCandidate) =>
				this.prepareCandidate(candidate, isAutomatic, current.filePath, scope.signal),
		}, -1, scope.signal);

		// A Stopped read must not arm a sleep timer (NRL-48).
		if (scope.signal.aborted) return;

		// Initialize sleep timer if preset is not "off"
		const timerMs = this.presetToMs(this.settings.timerPreset);
		if (timerMs > 0) this.player.setTimer(timerMs);
	}

	private async readFromCursor(position: number): Promise<void> {
		const current = this.currentEditor();
		if (!current) {
			new Notice("Open a note first.");
			return;
		}

		this.readScope?.abort();
		const scope = (this.readScope = new AbortController());

		this.retargetHighlightEditor(current.editor);
		registerHighlighting(current.editor);
		registerScrollSuppression(current.editor);
		resetScrollSuppression(current.editor);

		const chunks = extractChunks(
			current.source,
			{
				stripTags: this.settings.skipTags,
				speakUrls: this.settings.speakUrls,
				skipCodeBlocks: this.settings.skipCodeBlocks,
				skipInlineCode: this.settings.skipInlineCode,
				skipTables: this.settings.skipTables,
				skipHeadings: this.settings.skipHeadings,
				skipFrontmatter: this.settings.skipFrontmatter,
				speakImageAlt: this.settings.speakImageAlt,
				speakEmbeds: this.settings.speakEmbeds,
				locale: appLocale(),
			},
			platformSegmenters,
			current.filePath,
		);

		if (chunks.length === 0) {
			new Notice("Nothing to read in this note.");
			return;
		}

		const selection = this.settings.engine;
		const isAutomatic = selection === "auto";
		let candidates: FallbackCandidate[];
		if (isAutomatic) {
			candidates = await this.rankedCandidates();
			if (candidates.length === 0) {
				new Notice("No speech engines available.", 8000);
				return;
			}
		} else {
			const engine = findEngine(this.engines, selection);
			if (!engine) {
				new Notice(`Engine ${selection} not available.`, 8000);
				return;
			}
			candidates = [{ engine, id: selection, reason: "" }];
		}

		await playWithFallback(this.player, candidates, chunks, this.settings.rate, this.settings.pitch, {
			beforeAttempt: (candidate: FallbackCandidate) =>
				this.prepareCandidate(candidate, isAutomatic, current.filePath, scope.signal),
		}, position, scope.signal);

		// A Stopped read must not arm a sleep timer (NRL-48).
		if (scope.signal.aborted) return;

		// Initialize sleep timer if preset is not "off"
		const timerMs = this.presetToMs(this.settings.timerPreset);
		if (timerMs > 0) this.player.setTimer(timerMs);
	}

	/**
	 * Record where the reading has reached, under the key the chunk itself owns.
	 *
	 * The path is not a parameter, and that is the point rather than tidiness:
	 * with no path argument there is no call site that *can* write a position
	 * under a key the chunk does not belong to, so the class of defect closes
	 * instead of being fixed at one site. It used to take the path as an argument
	 * and ignore chunk.filePath, which let a caller save the active view's note
	 * against a queue holding another.
	 *
	 * Nothing here reads chunk.text. The record is built from the chunk's id,
	 * sequence and sourceStart, so no note content can reach data.json's
	 * neighbours, a log, or a save error (non-negotiable 1).
	 *
	 * The container is mutated before the await, so a caller that returns
	 * immediately - a Stop, a pause, a rename's handler - has already recorded
	 * the position in memory; only the disk write is outstanding.
	 */
	private async savePosition(chunkIndex: number): Promise<void> {
		if (chunkIndex < 0 || !this.player) return;

		// The player owns the queue, so it answers rather than being cast open.
		const chunk = this.player.getChunk(chunkIndex);
		if (!chunk) return;

		const filePath = chunk.filePath;
		if (!filePath) return;

		const position = {
			filePath,
			segmentId: chunk.id,
			segmentIndex: chunk.sequence,
			sourceOffset: chunk.sourceStart,
			updatedAt: Date.now(),
		};

		// Add to the container; never rebuild it. A whitelist rebuild here is the
		// defect non-negotiable 10 exists for: saveSettings() runs on every rate
		// nudge, so one erases every reading position the user has.
		if (!this.pluginData.positions) this.pluginData.positions = {};
		this.pluginData.positions[filePath] = position;
		await this.saveSettings();
	}

	/**
	 * Unwrap Obsidian's event argument and hand the orchestration two strings.
	 *
	 * TAbstractFile, not TFile, and no branch on the type: a folder event reaches
	 * the same handler, and since NRL-58 one `covers` relation serves both the map
	 * sweep and the playback stop, so a folder needs no special case anywhere.
	 * Everything that decides anything lives in src/settings/vaultEvents.ts,
	 * because main.ts has no runtime in the bare-Node suite and these two bodies
	 * shipped in NRL-51 with no automated coverage at all.
	 */
	private handleVaultRename(file: TAbstractFile, oldPath: string): void {
		applyVaultRename(this.vaultEvents, oldPath, file.path);
	}

	private handleVaultDelete(file: TAbstractFile): void {
		applyVaultDelete(this.vaultEvents, file.path);
	}

	private async voicesForSelection(engine: SpeechEngine, isAutomatic: boolean): Promise<VoiceInfo[]> {
		if (isAutomatic && engine instanceof WebSpeechEngine) return await engine.listLocalVoices();
		return await engine.listVoices();
	}

	/**
	 * Extract the note's language from frontmatter `lang` key, if present.
	 *
	 * Priority order for voice selection: frontmatter lang > app locale.
	 * Returns undefined if the key is not found.
	 */
	private extractNoteLanguage(filePath: string): string | undefined {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return undefined;
		const cache = this.app.metadataCache.getFileCache(file);
		return cache?.frontmatter?.lang as string | undefined;
	}

	/**
	 * Apply the configured voice, or a substitute the user is told about.
	 *
	 * A voice id is scoped to its engine, so switching engines invalidates it.
	 * The substitute follows the note language (if marked in frontmatter), then
	 * the app language rather than whatever sorts first (on speech-dispatcher
	 * that is Afrikaans, out of thousands), and the notice names both voices.
	 * It is persisted so the notice fires once.
	 */
	private async selectVoiceIfNeeded(engine: SpeechEngine, voices: VoiceInfo[], noteLang?: string): Promise<void> {
		if (voices.length === 0) return;
		const resolved = resolveStoredVoice(
			engine,
			this.settings.voiceId,
			voices,
			noteLang,
			appLocale(),
			this.settings.offlinePreferred,
		);
		await engine.selectVoice(resolved.voice);
		if (resolved.id !== this.settings.voiceId) {
			this.settings.voiceId = resolved.id;
			await this.saveSettings();
		}
		if (resolved.notice) new Notice(`Local TTS Reader: ${resolved.notice}`, 8000);
	}

	stopReading(): void {
		// Before player.stop(), and the half that actually does something when a
		// read is still loading its engine: the Player has no run to abort yet at
		// that point (NRL-48). Every other caller of stopReading() - the rename
		// and delete handlers, and the three Kokoro reconfiguration paths - gets
		// this for free.
		this.readScope?.abort();
		this.readScope = null;
		this.player.stop();
		this.clearBothHighlights();
	}

	/**
	 * Which highlight layers the current settings and engine permit.
	 *
	 * `hasWordTiming` is false for no resolved engine as well as for an engine
	 * reporting `timing: "none"`; neither can produce a word range worth drawing.
	 */
	private highlightLayers(): HighlightLayers {
		const engine = this.activeEngine();
		return highlightPlan(this.settings.highlight, !!engine && engine.capabilities.timing !== "none");
	}

	/**
	 * Point the highlight layers at a new editor, clearing the old one first.
	 *
	 * The clear cannot be left to the `state` handler. Every read path assigns
	 * `activeEditor` *before* `Player.play()`, and `play()` begins with its own
	 * `stop()`, which drives `state: "idle"` and therefore `clearBothHighlights`
	 * - by which time `activeEditor` already names the new editor, so the old
	 * note keeps its marks for the rest of the session. `Player` holds no
	 * editor of its own (CONTEXT.md, "a chunk-queue player, not a reading
	 * session"), so the only thing that knows which view was drawn into is this
	 * field, and it has to be drained before it is overwritten.
	 */
	private retargetHighlightEditor(editor: EditorView): void {
		if (this.activeEditor && this.activeEditor !== editor) {
			clearHighlights(this.activeEditor);
		}
		this.activeEditor = editor;
	}

	/** Both layers. Used when a reading ends, not when a word advances. */
	private clearBothHighlights(): void {
		if (this.activeEditor) clearHighlights(this.activeEditor);
	}

	/**
	 * NRL-89: leaving the note a read is in flight on. Clears both layers on
	 * the editor they were drawn into (not the one now in front - there may
	 * not even be one, if the user closed the pane) and drops `activeEditor`
	 * so the chunk/word handlers' existing `if (!this.activeEditor) return;`
	 * guards do the suppressing, unchanged, for as long as the mismatch lasts.
	 */
	private suspendHighlightEditor(): void {
		this.clearBothHighlights();
		this.activeEditor = null;
	}

	/**
	 * Draw the sentence layer (and the matching scroll) for one chunk, or
	 * clear both layers for `null`.
	 *
	 * Extracted verbatim from the body that used to live inline in the
	 * `player.on("chunk", ...)` registration, so the normal chunk-advance path
	 * and NRL-89's reattach-on-leaf-change path share one implementation and
	 * cannot drift apart. `handleActiveLeafChange`'s match branch calls this
	 * directly with `player.getChunk(player.getIndex())` so criterion 3
	 * ("resumes decorating and scrolling") does not have to wait for the next
	 * chunk event, which could be seconds away.
	 */
	private renderChunkHighlight(chunk: SpeechChunk | null): void {
		// No chunk means playback moved off the note entirely, so both layers
		// go. Every other branch here touches one layer only: clearing both
		// from a per-layer handler is what coupled the two toggles together.
		if (!chunk) {
			this.clearBothHighlights();
			return;
		}
		if (!this.activeEditor) return;
		// One transaction, because both layers change together here: the new
		// sentence has to arrive in the same update that retires the previous
		// sentence's word mark, or a word stays lit inside the wrong sentence
		// until the next word event - which on a slow first synthesis, or on
		// an engine that emits no word events at all, is a long time. The
		// viewport scroll rides in that same transaction for the same
		// reason (NRL-72, docs/adr/0022).
		//
		// The scroll target is `chunk.sourceStart` and NOT the sentence
		// range's `from`: that range is null when the sentence layer is off,
		// and the viewport should still follow playback then, because the
		// word layer may be the only one visible. Which offset to use is
		// decided here; highlight.ts only knows how to build the effect.
		//
		// `scrollTargetForChunk` is the gate, and it returns null when
		// neither layer is drawn OR the editor's auto-scroll is suppressed
		// (NRL-90). It lives in highlight.ts rather than inline here because
		// main.ts has no runtime in the suite, which is exactly how this
		// shipped ungated in the first place: the offset was passed
		// unconditionally, so with highlighting switched off the dispatch
		// below drew zero ranges and still moved the viewport.
		//
		// One `highlightLayers()` call, not two, so the sentence range and
		// the scroll decision cannot be computed from different plans.
		const layers = this.highlightLayers();
		applyHighlightLayers(
			this.activeEditor,
			{
				sentence: layers.sentence
					? { from: chunk.sourceStart, to: chunk.sourceEnd }
					: null,
				word: null,
			},
			scrollTargetForChunk(layers, chunk.sourceStart, isScrollSuppressed(this.activeEditor)),
		);
	}

	/**
	 * NRL-89: the active-leaf-change handler. Decides, via the pure
	 * `shouldHighlightLeaf`, whether the leaf that just became active is the
	 * note an in-flight read is on - and either resumes decorating/scrolling
	 * it (match) or suspends the layers (no match, read still in flight).
	 *
	 * `activeFilePath` is resolved the same way `currentEditor()` already
	 * does: only a loaded `MarkdownView` has a `file` to read, and decoration
	 * only ever makes sense for a markdown editor, so there is nothing for a
	 * non-MarkdownView leaf to match even if a path were resolved for it. A
	 * leaf that is still a deferred (unloaded) view also narrows to `null`
	 * here, which fails closed - under-highlighting rather than drawing into
	 * a view that has not finished loading.
	 *
	 * `inFlight` is derived from `Player.getState()`, not from `getFilePath()`
	 * alone: `getFilePath()` is deliberately not cleared by `stop()`
	 * (player.ts:147-171), so a finished or stopped read still names its note
	 * by path - `shouldHighlightLeaf`'s own doc comment explains why that
	 * alone would re-arm a dead reading's highlight on a return visit.
	 *
	 * Word-level highlighting is deliberately NOT replayed on reattach:
	 * `Player` holds no queryable "current word" field, and
	 * `refreshHighlightLayers()` already sets this same precedent elsewhere -
	 * redrawing the sentence layer only. The word mark catches up on the next
	 * natural word event, exactly as it does after any settings toggle flip.
	 */
	private handleActiveLeafChange(leaf: WorkspaceLeaf | null): void {
		const state = this.player.getState();
		const inFlight = state === "preparing" || state === "playing" || state === "paused";
		const activeFilePath =
			leaf?.view instanceof MarkdownView ? (leaf.view.file?.path ?? null) : null;

		if (shouldHighlightLeaf(activeFilePath, this.player.getFilePath(), inFlight)) {
			const current = this.currentEditor();
			if (!current) return; // defensive; a MarkdownView match implies currentEditor() succeeds
			this.retargetHighlightEditor(current.editor);
			registerHighlighting(current.editor);
			this.renderChunkHighlight(this.player.getChunk(this.player.getIndex()) ?? null);
			return;
		}

		if (inFlight) this.suspendHighlightEditor();
		// Not in flight and no match: nothing is being read, so activeEditor
		// (if stale from a finished read) is left alone rather than touched on
		// every leaf change with no read in progress.
	}

	/**
	 * Redraw the layers for the settings as they now stand, without waiting for
	 * the next chunk boundary.
	 *
	 * The sentence effect is only dispatched from the `chunk` handler, so a
	 * toggle flipped mid-paragraph would otherwise stay on screen until the next
	 * sentence. On speech-dispatcher that is worse than it sounds: it emits no
	 * word events at all, so nothing else would clear it either.
	 */
	private refreshHighlightLayers(): void {
		if (!this.activeEditor) return;
		const layers = this.highlightLayers();
		if (!layers.sentence) clearSentenceHighlight(this.activeEditor);
		if (!layers.word) clearWordHighlight(this.activeEditor);
		// getIndex() is chunks.length on natural completion, so getChunk() is
		// undefined there and nothing is redrawn. That is the wanted behaviour:
		// a finished read has no current sentence.
		const chunk = this.player.getChunk(this.player.getIndex());
		if (layers.sentence && chunk) {
			applySentenceHighlight(this.activeEditor, { from: chunk.sourceStart, to: chunk.sourceEnd });
		}
	}

	// --- Settings plumbing --------------------------------------------------

	getEngineStatuses() {
		return probeEngines(this.engines);
	}

	getEngines(): SpeechEngine[] {
		return this.engines;
	}

	getModelStore(): VaultModelStore {
		return this.modelStore;
	}

	/**
	 * The engine `settings.engine` currently means, or null.
	 *
	 * Synchronous and cached, for UI call sites that cannot await
	 * (checkCallback, the control bar's capability gate). A manual pin
	 * resolves immediately, exactly as before. "auto" reads the last
	 * `resolveAutomaticChoice()` result - null until the first one completes,
	 * which every UI caller already handles by treating a null engine as "no
	 * capabilities to gate on yet" (main.ts, affordances.ts).
	 */
	activeEngine(): SpeechEngine | null {
		if (this.settings.engine !== "auto") return findEngine(this.engines, this.settings.engine) ?? null;
		if (!this.autoResolution) return null;
		return findEngine(this.engines, this.autoResolution.id) ?? null;
	}

	/**
	 * Probe every engine's real, current availability - no model load, no
	 * download (non-negotiable 6). Kokoro's probe additionally answers
	 * whether its GPU/fp32 path is confirmed live right now
	 * (`plannedBackend()`: a real `navigator.gpu.requestAdapter()` call plus
	 * a vault stat, never a fetch); webspeech's probe folds in
	 * `hasLocalVoice()`, so `selection.ts` never has to know what "local"
	 * means for a browser voice (docs/adr/0010).
	 */
	private async buildProbes(): Promise<EngineProbe[]> {
		return await Promise.all(
			this.engines.map(async (engine): Promise<EngineProbe> => {
				if (engine instanceof KokoroEngine) {
					const available = (await engine.isAvailable()).available;
					const plan = await engine.plannedBackend();
					return {
						id: "kokoro",
						available,
						kokoroGpuFp32Live: plan?.device === "webgpu" && plan.path === KOKORO_WEIGHTS.gpu.path,
					};
				}
				if (engine instanceof WebSpeechEngine) {
					return { id: "webspeech", available: await engine.hasLocalVoice() };
				}
				return { id: engine.id, available: (await engine.isAvailable()).available };
			}),
		);
	}

	/**
	 * The full ranked fallback chain for automatic selection, engines
	 * attached - what `readActiveNote()` hands to `playWithFallback()`.
	 * Re-probes every call: this is the async, authoritative source of
	 * truth, as opposed to `activeEngine()`'s sync cache.
	 */
	async rankedCandidates(): Promise<FallbackCandidate[]> {
		const probes = await this.buildProbes();
		const out: FallbackCandidate[] = [];
		for (const r of rankEngines(probes)) {
			const engine = findEngine(this.engines, r.id);
			if (engine) out.push({ engine, id: r.id, reason: r.reason });
		}
		return out;
	}

	/**
	 * What automatic selection would pick right now, and why - the settings
	 * tab's "chosen and why" line, and the source of `activeEngine()`'s cache
	 * for as long as `settings.engine === "auto"`.
	 */
	async resolveAutomaticChoice(): Promise<RankedCandidate> {
		const probes = await this.buildProbes();
		const resolved = resolveSelection("auto", probes);
		this.autoResolution = resolved;
		this.refreshEngineAffordances();
		return resolved;
	}

	/**
	 * Point the control bar at the active engine's capabilities.
	 *
	 * A direct call rather than an event: there is one writer (`setEngine`) and
	 * one subscriber, and the plugin is not an event source today. The cost is
	 * that a second writer of `settings.engine` would leave the bar stale with
	 * no symptom, which is why `setEngine` must stay the only one.
	 */
	private refreshEngineAffordances(): void {
		const engine = this.activeEngine();
		this.controlBar.setEngine(engine?.capabilities ?? null, engine?.label ?? "This engine");
	}

	/**
	 * Whether the active engine's audio can actually be paused and resumed.
	 *
	 * Read from the same module the control bar reads, so the button and the
	 * command cannot disagree about it. Evaluated per call rather than cached:
	 * the palette asks on open, which is always after `setEngine`.
	 */
	private canPause(): boolean {
		const engine = this.activeEngine();
		return controlAffordances(engine?.capabilities ?? null, engine?.label ?? "This engine")
			.playPause.enabled;
	}

	/**
	 * The only permitted writer of `settings.engine`.
	 *
	 * Anything that depends on which engine is active is refreshed from here, so
	 * changing engine takes effect without reloading the plugin.
	 */
	async setEngine(id: EngineSelection): Promise<void> {
		this.settings.engine = id;
		await this.saveSettings();
		if (id === "auto") await this.resolveAutomaticChoice();
		this.refreshEngineAffordances();
		void this.warmUpEngine();
	}

	/** The Kokoro engine, if it is in the registry. */
	getKokoro(): KokoroEngine | null {
		const engine = findEngine(this.engines, "kokoro");
		return engine instanceof KokoroEngine ? engine : null;
	}

	/** Engine options derived from settings, with `auto` values resolved. */
	private kokoroOptions(): Partial<KokoroOptions> {
		return {
			device: this.settings.kokoroDevice,
			threads: this.settings.kokoroThreads,
			weights: resolveWeights(this.settings.kokoroWeights),
		};
	}

	/** Which weights build the engine would load, for the settings tab. */
	resolvedWeights(): WeightsPreference {
		return resolveWeights(this.settings.kokoroWeights);
	}

	/** Throw away the loaded model, e.g. after downloading a different build. */
	async reloadKokoro(): Promise<void> {
		this.stopReading();
		await this.getKokoro()?.dispose();
		void this.warmUpEngine();
	}

	async setKokoroWeights(weights: Settings["kokoroWeights"]): Promise<void> {
		this.settings.kokoroWeights = weights;
		await this.saveSettings();
		this.stopReading();
		this.getKokoro()?.setOptions(this.kokoroOptions());
		void this.warmUpEngine();
	}

	/**
	 * Change the Kokoro backend.
	 *
	 * Playback stops first: the engine throws away its worker when the backend
	 * changes, and a queue of half-synthesised sentences pointing at a dead
	 * worker is not something the player should have to reason about.
	 */
	async setKokoroRuntime(device: Settings["kokoroDevice"], threads: number): Promise<void> {
		this.settings.kokoroDevice = device;
		this.settings.kokoroThreads = threads;
		await this.saveSettings();
		this.stopReading();
		this.getKokoro()?.setOptions(this.kokoroOptions());
		void this.warmUpEngine();
	}


	/** Vault path of the style vector a voice id needs. */
	voiceFileFor(voiceId: string): string {
		return voiceFilePath(voiceId);
	}

	async setVoice(voiceId: string): Promise<void> {
		this.settings.voiceId = voiceId;
		await this.saveSettings();
		const engine = this.activeEngine();
		const voices = (await engine?.listVoices()) ?? [];
		const wanted = voices.find((v) => v.id === voiceId);
		if (engine && wanted) await engine.selectVoice(wanted);
	}

	/**
	 * Change playback speed, live if something is already reading.
	 *
	 * Both the control bar and the settings slider call this. Neither updates
	 * its own display afterwards: the player emits `rate` and each observes
	 * that, so a change from either place shows in both. A running chunk
	 * speeds up or slows down immediately rather than on the next sentence.
	 *
	 * The player is updated before the save is awaited: the control bar
	 * computes each nudge from player.getRate(), so a wheel scroll firing
	 * several ticks inside one saveData would otherwise read a stale rate and
	 * lose all but the first.
	 */
	async setRate(rate: number): Promise<void> {
		this.settings.rate = rate;
		this.player.setRate(rate);
		await this.saveSettings();
	}

	/**
	 * Change pitch, applied to future synthesis only.
	 *
	 * Like rate, both the control bar and the settings slider observe the
	 * "pitch" event from the player to avoid feedback loops.
	 */
	async setPitch(pitch: number): Promise<void> {
		this.settings.pitch = pitch;
		this.player.setPitch(pitch);
		await this.saveSettings();
	}

	/**
	 * Set the sleep timer preset and apply it to the player.
	 *
	 * Converts preset strings (e.g. "5m" = 5 minutes = 300000ms) to milliseconds
	 * and starts the timer. "off" clears any running timer.
	 */
	async setTimerPreset(preset: string): Promise<void> {
		this.settings.timerPreset = preset as Settings["timerPreset"];
		const presetMs = this.presetToMs(preset);
		this.player.setTimer(presetMs);
		await this.saveSettings();
	}

	/**
	 * Convert a timer preset string to milliseconds.
	 *
	 * "off" returns 0, minute presets return minutes * 60 * 1000.
	 */
	private presetToMs(preset: string): number {
		switch (preset) {
			case "5m":
				return 5 * 60 * 1000;
			case "10m":
				return 10 * 60 * 1000;
			case "15m":
				return 15 * 60 * 1000;
			case "30m":
				return 30 * 60 * 1000;
			case "60m":
				return 60 * 60 * 1000;
			case "off":
			default:
				return 0;
		}
	}

	/**
	 * Store the look-ahead and hand it to the running player.
	 *
	 * The Look ahead slider used to write the setting and save, which left the
	 * player on whatever it read at construction until the next plugin load.
	 *
	 * The player is updated before the save is awaited, for setRate's reason: a
	 * slider dragged across several steps fires repeatedly inside one saveData,
	 * and the runtime must not lag behind. The stored value is read back from
	 * the player rather than taken from the caller, so what is persisted is
	 * exactly the window in use rather than a value that only gets clamped on
	 * the next load.
	 */
	async setBufferAhead(count: number): Promise<void> {
		this.player.setBufferAhead(count);
		this.settings.bufferAhead = this.player.getBufferAhead();
		await this.saveSettings();
	}

	/**
	 * Store a highlight colour and apply it. The caller validates; "" means
	 * follow the theme.
	 */
	async setHighlightColour(color: string): Promise<void> {
		this.settings.highlight.color = color;
		await this.saveSettings();
		this.applyHighlightColour();
	}

	/**
	 * Write the colour to the custom properties styles.css reads. On body
	 * because the highlight is a CodeMirror mark inside whichever editor is
	 * reading, and every one of those sits under body.
	 */
	private applyHighlightColour(): void {
		applySentenceHighlightColour(document.body.style, this.settings.highlight.color);
		applyWordHighlightColour(document.body.style, this.settings.highlight.color);
	}

	async saveSettings(): Promise<void> {
		this.pluginData = serialisePluginData(this.pluginData, this.settings);
		// A highlight toggle flipped mid-read takes effect now rather than at the
		// next sentence boundary. Cheap, and it is the only thing that makes the
		// toggles feel connected on an engine with no word events.
		//
		// BEFORE the await, not after, since NRL-58 put a queue behind the write:
		// after it, a mid-read toggle would wait behind an unrelated queued save
		// before the highlight moved, which is exactly the promise above.
		this.refreshHighlightLayers();
		// The queue, not saveData directly. This is the plugin's only saveData
		// call site, so ordering it here orders every persistence path.
		await this.saveQueue.enqueue(this.pluginData);
	}

	getPlayer(): Player {
		return this.player;
	}
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The language Obsidian's UI is in, which is what the user reads in.
 *
 * getLanguage() arrived in Obsidian 1.8.7 and the manifest allows 1.8.0, so
 * it is feature-checked; before it, moment's locale follows the app setting.
 * Not navigator.language, which is the OS locale.
 */
export function appLocale(): string {
	try {
		if (typeof getLanguage === "function") {
			const lang = getLanguage();
			if (lang) return lang;
		}
		const fromMoment = moment.locale();
		if (fromMoment) return fromMoment;
	} catch {
		// fall through
	}
	return "en";
}
