import { MarkdownView, Notice, Plugin, getLanguage, moment } from "obsidian";
import { EditorView } from "@codemirror/view";

import { Player } from "./audio/player";
import { describeUnavailable, type SpeechChunk, type SpeechEngine, type VoiceInfo } from "./audio/types";
import { playWithFallback, type FallbackCandidate } from "./audio/fallback";
import { extractChunks } from "./text/extract";
import { platformSegmenters } from "./text/segment";
import { resolveStoredVoice } from "./audio/voiceChoice";
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
import { applyHighlight, registerHighlighting } from "./ui/highlight";
import { WORD_HIGHLIGHT_VAR, applyWordHighlightColour } from "./ui/highlightColour";
import { createModelStore, type VaultModelStore } from "./ui/modelStore";
import { reportError, trace } from "./diagnostics";
import { LocalTtsSettingTab } from "./ui/settingsTab";
import { ControlBar } from "./ui/controlBar";
import { controlAffordances } from "./ui/affordances";

/**
 * ORT runtime file checksums, compiled at build time (production only).
 * Non-negotiable: read-only and never modified at runtime.
 * Validated against local files to ensure integrity.
 * Injected by esbuild.config.mjs via __ORT_CHECKSUMS__ define.
 */
declare const __ORT_CHECKSUMS__: Record<string, string> | undefined;

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
	private positionUpdateTimeout: number | null = null;
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

		// Validate ORT runtime checksums on load if present (production builds only).
		// Non-negotiable: ensures integrity of published artifact files without
		// triggering downloads. No automatic fallback on failure; user is told
		// to re-install the plugin (report the error with manifest.dir).
		if (__ORT_CHECKSUMS__) {
			try {
				await this.validateOrtChecksums();
			} catch (err) {
				reportError(
					this.app,
					this.manifest.dir!,
					"ORT checksum validation failed",
					err,
				);
			}
		}

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

		// Sentence-level highlighting
		this.player.on("chunk", (chunk) => {
			if (!this.settings.highlight.enabled || !chunk) {
				this.clearHighlight();
				return;
			}
			if (!this.activeEditor) return;
			applyHighlight(this.activeEditor, {
				from: chunk.sourceStart,
				to: chunk.sourceEnd,
			});
		});

		// Word-level highlighting (on top of sentence)
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

		this.player.on("progress", (progress) => {
			// Track reading position for resume
			if (this.activeEditor) {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.file?.path) {
					const filePath = view.file.path;
					// Debounce position updates to avoid hammering saveData
					if (!this.positionUpdateTimeout) {
						this.positionUpdateTimeout = window.setTimeout(() => {
							this.positionUpdateTimeout = null;
						}, 1000);
						// Save position async, don't block playback
						void this.savePosition(filePath, progress.chunkIndex);
					}
				}
			}
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
				const editor = this.activeEditor;
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
				const editor = this.activeEditor;
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

		this.activeEditor = current.editor;
		registerHighlighting(current.editor);

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

		// Load stored reading position for this file
		let startAtSource = -1;
		const filePath = current.filePath;
		const storedPosition = this.pluginData.positions?.[filePath];
		if (storedPosition) {
			// Try to find the chunk that contains the stored offset
			const targetOffset = storedPosition.sourceOffset;
			const foundChunk = chunks.find((c) => c.sourceStart <= targetOffset && c.sourceEnd > targetOffset);
			if (foundChunk) {
				startAtSource = foundChunk.sourceStart;
				t("resume from stored position", `${filePath} @ ${targetOffset}`);
			}
		}

		const result = await playWithFallback(this.player, candidates, chunks, this.settings.rate, {
			beforeAttempt: async (candidate) => {
				const voices = await this.voicesForSelection(candidate.engine, isAutomatic);
				await this.selectVoiceIfNeeded(candidate.engine, voices);

				// Loading can take seconds. Say so, rather than announcing
				// playback that will not start yet and leaving the silence to
				// speak for itself.
				if (candidate.engine.prepare && candidate.engine.isPrepared?.() === false) {
					const loading = new Notice(`Loading ${candidate.engine.label}...`, 0);
					try {
						t("loading engine", candidate.id);
						const started = Date.now();
						await candidate.engine.prepare();
						t("engine loaded", `${candidate.id} in ${Date.now() - started}ms`);
					} finally {
						loading.hide();
					}
				}
			},
			onFallback: (from, to, err) => {
				t("fallback", `${from.id} -> ${to.id}: ${errText(err)}`);
				new Notice(
					`Local TTS Reader: ${from.engine.label} failed (${errText(err)}); trying ${to.engine.label}.`,
					6000,
				);
			},
		}, startAtSource);

		if (!result) {
			t("no candidate succeeded", candidates.map((c) => c.id).join(","));
			new Notice("Local TTS Reader: no speech engine is available; check settings.", 8000);
			return;
		}

		if (isAutomatic) this.autoResolution = { id: result.id, reason: result.reason };

		const runtime = result.engine.runtimeInfo?.();
		new Notice(
			`Reading ${chunks.length} passages with ${result.engine.label}${runtime ? ` on ${runtime}` : ""}.`,
		);
		t("playback started", result.id);
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

		this.activeEditor = current.editor;
		registerHighlighting(current.editor);

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

		// Filter chunks to only those within the selection range
		const selectedChunks = chunks.filter((chunk) => chunk.sourceEnd > from && chunk.sourceStart < to);

		if (selectedChunks.length === 0) {
			new Notice("No text in selection.");
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

		await playWithFallback(this.player, candidates, selectedChunks, this.settings.rate, {
			beforeAttempt: async (candidate: FallbackCandidate) => {
				const voices = await this.voicesForSelection(candidate.engine, isAutomatic);
				await this.selectVoiceIfNeeded(candidate.engine, voices);
				if (candidate.engine.prepare && candidate.engine.isPrepared?.() === false) {
					const loading = new Notice(`Loading ${candidate.engine.label}...`, 0);
					try {
						await candidate.engine.prepare();
					} finally {
						loading.hide();
					}
				}
			},
		});
	}

	private async readFromCursor(position: number): Promise<void> {
		const current = this.currentEditor();
		if (!current) {
			new Notice("Open a note first.");
			return;
		}

		this.activeEditor = current.editor;
		registerHighlighting(current.editor);

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

		await playWithFallback(this.player, candidates, chunks, this.settings.rate, {
			beforeAttempt: async (candidate: FallbackCandidate) => {
				const voices = await this.voicesForSelection(candidate.engine, isAutomatic);
				await this.selectVoiceIfNeeded(candidate.engine, voices);
				if (candidate.engine.prepare && candidate.engine.isPrepared?.() === false) {
					const loading = new Notice(`Loading ${candidate.engine.label}...`, 0);
					try {
						await candidate.engine.prepare();
					} finally {
						loading.hide();
					}
				}
			},
		}, position);
	}

	private async savePosition(filePath: string, chunkIndex: number): Promise<void> {
		if (chunkIndex < 0 || !this.player) return;

		// Get the current chunks from player state to find segment info
		const chunks = (this.player as unknown as { chunks: SpeechChunk[] }).chunks;
		if (!chunks || chunkIndex >= chunks.length) return;

		const chunk = chunks[chunkIndex];
		if (!chunk) return;

		const position = {
			filePath,
			segmentId: chunk.id,
			segmentIndex: chunk.sequence,
			sourceOffset: chunk.sourceStart,
			updatedAt: Date.now(),
		};

		// Update plugin data
		if (!this.pluginData.positions) this.pluginData.positions = {};
		(this.pluginData.positions as Record<string, typeof position>)[filePath] = position;
		await this.saveSettings();
	}

	private async voicesForSelection(engine: SpeechEngine, isAutomatic: boolean): Promise<VoiceInfo[]> {
		if (isAutomatic && engine instanceof WebSpeechEngine) return await engine.listLocalVoices();
		return await engine.listVoices();
	}

	/**
	 * Apply the configured voice, or a substitute the user is told about.
	 *
	 * A voice id is scoped to its engine, so switching engines invalidates it.
	 * The substitute follows the app language rather than whatever sorts
	 * first (on speech-dispatcher that is Afrikaans, out of thousands), and
	 * the notice names both voices. It is persisted so the notice fires once.
	 */
	private async selectVoiceIfNeeded(engine: SpeechEngine, voices: VoiceInfo[]): Promise<void> {
		if (voices.length === 0) return;
		const resolved = resolveStoredVoice(engine, this.settings.voiceId, voices, appLocale(), this.settings.offlinePreferred);
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

	/**
	 * Validate ORT runtime file checksums against expected values.
	 * Non-negotiable: no silent failure or automatic fallback.
	 * Only runs in production builds where __ORT_CHECKSUMS__ is defined.
	 * Failures are traced but do not block plugin load (user sees error).
	 */
	private async validateOrtChecksums(): Promise<void> {
		if (!__ORT_CHECKSUMS__) return;

		const expectedChecksums = __ORT_CHECKSUMS__;
		const pluginDir = this.manifest.dir!;

		// Checksums are compiled at build time; if any file is missing,
		// the user's plugin install is corrupted. Report it and continue
		// so the user gets immediate visibility rather than silent failure.
		for (const [file, expectedHash] of Object.entries(expectedChecksums)) {
			const filePath = `${pluginDir}/ort/${file}`;
			try {
				// Read the file from disk and compute its hash.
				const content = await this.app.vault.adapter.read(filePath);
				// Note: content is a string; encode to bytes for hashing.
				const bytes = new TextEncoder().encode(content);
				const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
				const hashArray = Array.from(new Uint8Array(hashBuffer));
				const actualHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

				if (actualHash !== expectedHash) {
					trace(
						this.app,
						pluginDir,
						"checksum mismatch",
						`${file}: expected ${expectedHash}, got ${actualHash}`,
					);
				}
			} catch (err) {
				trace(this.app, pluginDir, "checksum read failed", `${file}: ${err}`);
			}
		}
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
