import { MarkdownView, Notice, Plugin, getLanguage, moment } from "obsidian";
import { EditorView } from "@codemirror/view";

import { Player } from "./audio/player";
import type { EngineId, SpeechEngine } from "./audio/types";
import { extractChunks } from "./text/extract";
import { resolveStoredVoice } from "./audio/voiceChoice";
import { createEngines, findEngine, probeEngines, resolveWeights } from "./engines/registry";
import {
	KokoroEngine,
	voiceFilePath,
	type KokoroOptions,
	type WeightsPreference,
} from "./engines/onnx/kokoro";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import { loadPluginData, serialisePluginData, type PluginData } from "./settings/data";
import { applyHighlight, registerHighlighting } from "./ui/highlight";
import { WORD_HIGHLIGHT_VAR, applyWordHighlightColour } from "./ui/highlightColour";
import { createModelStore, type VaultModelStore } from "./ui/modelStore";
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
	private controlBar!: ControlBar;

	override async onload(): Promise<void> {
		trace(this.app, this.manifest.dir!, "plugin loaded");
		this.pluginData = loadPluginData(await this.loadData());
		this.settings = this.pluginData.settings;
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

		this.player.on("word", (payload) => {
			if (!this.settings.highlight.enabled || !payload) {
				this.clearHighlight();
				return;
			}
			// The view can be closed mid-playback; a missing editor just means
			// there is nothing left to highlight.
			if (!this.activeEditor) return;
			applyHighlight(this.activeEditor, {
				from: payload.timing.sourceStart,
				to: payload.timing.sourceEnd,
			});
		});

		this.player.on("state", (state) => {
			if (state === "finished" || state === "idle") this.clearHighlight();
		});

		this.player.on("error", (err) => {
			this.clearHighlight();
			reportError(this.app, this.manifest.dir!, "playback failed", err);
		});

		this.controlBar = new ControlBar(this);
		this.refreshEngineAffordances();

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
			if (!(await engine.isAvailable())) return;
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

	override onunload(): void {
		this.controlBar?.destroy();
		this.player?.dispose();
		document.body.style.removeProperty(WORD_HIGHLIGHT_VAR);
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
	private currentEditor(): { editor: EditorView; source: string } | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;

		const editor =
			EditorView.findFromDOM(view.containerEl) ??
			((view.editor as unknown as { cm?: EditorView }).cm ?? null);
		if (!editor) return null;

		return { editor, source: view.editor.getValue() };
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

		const engineId = this.settings.engine;
		const engine = findEngine(this.engines, engineId);
		if (!engine) {
			t("no engine matched", `engineId=${engineId} available=${this.engines.map((e) => e.id).join(",")}`);
			new Notice(`Local TTS Reader: no engine named "${engineId}".`, 6000);
			return;
		}
		t("engine matched", engineId);

		this.activeEditor = current.editor;
		registerHighlighting(current.editor);

		const chunks = extractChunks(current.source, {
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
		});
		t("chunks extracted", `${chunks.length}`);

		if (chunks.length === 0) {
			new Notice("Nothing to read in this note.");
			return;
		}

		t("checking isAvailable", engineId);
		const available = await engine.isAvailable();
		t("isAvailable returned", `${engineId}=${available}`);
		if (!available) {
			new Notice(
				`Local TTS Reader: ${engine.label} is not available. Pick another engine in settings.`,
				8000,
			);
			return;
		}

		await this.selectVoiceIfNeeded(engine);

		// Loading can take seconds. Say so, rather than announcing playback
		// that will not start yet and leaving the silence to speak for itself.
		if (engine.prepare && engine.isPrepared?.() === false) {
			const loading = new Notice(`Loading ${engine.label}...`, 0);
			try {
				t("loading engine", engineId);
				const started = Date.now();
				await engine.prepare();
				t("engine loaded", `${engineId} in ${Date.now() - started}ms`);
			} finally {
				loading.hide();
			}
		}

		const runtime = engine.runtimeInfo?.();
		new Notice(
			`Reading ${chunks.length} passages with ${engine.label}${runtime ? ` on ${runtime}` : ""}.`,
		);
		t("playback started", engineId);
		// Player emits failures via its error event rather than rejecting play().
		await this.player.play(engine, chunks, this.settings.rate);
	}

	/**
	 * Apply the configured voice, or a substitute the user is told about.
	 *
	 * A voice id is scoped to its engine, so switching engines invalidates it.
	 * The substitute follows the app language rather than whatever sorts
	 * first (on speech-dispatcher that is Afrikaans, out of thousands), and
	 * the notice names both voices. It is persisted so the notice fires once.
	 */
	private async selectVoiceIfNeeded(engine: SpeechEngine): Promise<void> {
		const voices = await engine.listVoices();
		if (voices.length === 0) return;
		const resolved = resolveStoredVoice(engine, this.settings.voiceId, voices, appLocale());
		await engine.selectVoice(resolved.voice);
		if (resolved.id !== this.settings.voiceId) {
			this.settings.voiceId = resolved.id;
			await this.saveSettings();
		}
		if (resolved.notice) new Notice(`Local TTS Reader: ${resolved.notice}`, 8000);
	}

	stopReading(): void {
		this.player.stop();
		this.clearHighlight();
	}

	private clearHighlight(): void {
		if (this.activeEditor) applyHighlight(this.activeEditor, null);
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

	/** The engine `settings.engine` names, or null if the registry has no such id. */
	activeEngine(): SpeechEngine | null {
		return findEngine(this.engines, this.settings.engine) ?? null;
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
	async setEngine(id: EngineId): Promise<void> {
		this.settings.engine = id;
		await this.saveSettings();
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
	 * Store a highlight colour and apply it. The caller validates; "" means
	 * follow the theme.
	 */
	async setHighlightColour(color: string): Promise<void> {
		this.settings.highlight.color = color;
		await this.saveSettings();
		this.applyHighlightColour();
	}

	/**
	 * Write the colour to the custom property styles.css reads. On body
	 * because the highlight is a CodeMirror mark inside whichever editor is
	 * reading, and every one of those sits under body.
	 */
	private applyHighlightColour(): void {
		applyWordHighlightColour(document.body.style, this.settings.highlight.color);
	}

	async saveSettings(): Promise<void> {
		this.pluginData = serialisePluginData(this.pluginData, this.settings);
		await this.saveData(this.pluginData);
	}

	getPlayer(): Player {
		return this.player;
	}
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
