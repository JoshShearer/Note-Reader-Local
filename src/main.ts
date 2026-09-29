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
import { createModelStore, type VaultModelStore } from "./ui/modelStore";
import { reportError, trace } from "./diagnostics";
import { LocalTtsSettingTab } from "./ui/settingsTab";
import { ControlBar } from "./ui/controlBar";

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
			callback: () => this.player.toggle(),
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
		const engine = findEngine(this.engines, this.settings.engine);
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

	async setEngine(id: EngineId): Promise<void> {
		this.settings.engine = id;
		await this.saveSettings();
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
		const engine = findEngine(this.engines, this.settings.engine);
		const voices = (await engine?.listVoices()) ?? [];
		const wanted = voices.find((v) => v.id === voiceId);
		if (engine && wanted) await engine.selectVoice(wanted);
	}

	/**
	 * Change playback speed, live if something is already reading.
	 *
	 * Both the control bar and the settings slider go through this, so a
	 * change from either place is reflected everywhere: the setting persists
	 * and a running chunk speeds up or slows down immediately rather than on
	 * the next sentence.
	 */
	async setRate(rate: number): Promise<void> {
		this.settings.rate = rate;
		await this.saveSettings();
		this.player.setRate(rate);
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
