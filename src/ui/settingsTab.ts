import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LocalTtsReaderPlugin from "../main";
import { KOKORO_VOICES, KOKORO_WEIGHTS, probeGpu } from "../engines/onnx/kokoro";
import { downloadModel, downloadVoice } from "./modelStore";

export class LocalTtsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: LocalTtsReaderPlugin,
	) {
		super(app, plugin);
	}

	override hide(): void {
		this.plugin.stopReading();
		super.hide();
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderEngineSection(containerEl);
		this.renderVoiceSection(containerEl);
		this.renderPlaybackSection(containerEl);
		this.renderHighlightSection(containerEl);
		this.renderStripSection(containerEl);
	}

	private renderEngineSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Engine").setHeading();

		// Probing shells out to binaries, so it cannot finish before the first
		// paint. Draw the tab immediately and fill the status list in when the
		// answers arrive.
		const statusBox = containerEl.createDiv({ cls: "local-tts-engine-status" });
		statusBox.createDiv({ cls: "local-tts-engine-row", text: "Checking installed engines..." });

		new Setting(containerEl)
			.setName("Speech engine")
			.setDesc("All engines run on this device. None of them send your notes anywhere.")
			.addDropdown((dropdown) => {
				for (const engine of this.plugin.getEngines()) {
					dropdown.addOption(engine.id, engine.label);
				}
				dropdown.setValue(this.plugin.settings.engine).onChange(async (value) => {
					await this.plugin.setEngine(value as never);
					// Voice ids are engine-scoped, so the list must reload.
					this.display();
				});
			});

		void this.plugin.getEngineStatuses().then((statuses) => {
			if (!containerEl.isConnected) return;
			statusBox.empty();
			for (const status of statuses) {
				const row = statusBox.createDiv({ cls: "local-tts-engine-row" });
				row.createSpan({ cls: "local-tts-engine-name", text: status.engine.label });
				row.createSpan({
					cls: `local-tts-engine-state ${status.available ? "is-ok" : "is-missing"}`,
					text: status.available ? "ready" : status.reason || "unavailable",
				});
				if (status.available && status.engine.capabilities.timing === "none") {
					row.createSpan({
						cls: "local-tts-engine-note",
						text: "no word highlighting",
					});
				}
			}
		});

		if (this.plugin.settings.engine === "kokoro") this.renderKokoroRuntime(containerEl);
		this.renderKokoroInstall(containerEl);
	}

	/**
	 * Where Kokoro runs, and what it actually managed to run on.
	 *
	 * Both halves matter. A GPU or a thread pool can be asked for and refused
	 * by the runtime, so a settings page that only shows the request is
	 * telling the user what they wanted, not what they got.
	 */
	private renderKokoroRuntime(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Kokoro performance").setHeading();

		const kokoro = this.plugin.getKokoro();
		const actual = kokoro?.runtimeInfo();
		new Setting(containerEl)
			.setName("Currently running on")
			.setDesc(
				actual ??
					"Not loaded yet. Open a note and start reading, or wait for the background load.",
			);

		// A GPU that is present but unreachable is the single most confusing
		// state here, because nothing about it is visible from the app. Say
		// what was found and, when it is missing, what would fix it.
		const gpuRow = new Setting(containerEl).setName("GPU").setDesc("Checking...");
		void probeGpu().then((report) => {
			if (!report.usable) {
				gpuRow.setDesc(`Not available. ${report.detail}`);
				return;
			}
			const build = KOKORO_WEIGHTS.gpu;
			gpuRow.setDesc(
				`Available: ${report.detail}. Select the ${build.label} build below to use it.`,
			);
		});

		new Setting(containerEl)
			.setName("Backend")
			.setDesc(
				"Automatic uses the GPU when this device really has one, and the CPU otherwise. " +
					"Changing this reloads the model.",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("auto", "Automatic");
				dropdown.addOption("wasm", "CPU");
				dropdown.addOption("webgpu", "GPU (WebGPU)");
				dropdown.setValue(this.plugin.settings.kokoroDevice);
				dropdown.onChange(async (value) => {
					await this.plugin.setKokoroRuntime(
						value as never,
						this.plugin.settings.kokoroThreads,
					);
					this.display();
				});
			});

		new Setting(containerEl)
			.setName("CPU threads")
			.setDesc(
				"Upper limit. Synthesis is the slow part of reading a note, and more threads is " +
					"the main way to make it keep up with playback. Some runtimes refuse to start " +
					"a thread pool at all, in which case this falls back to one.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(1, Math.max(2, Math.min(16, navigator.hardwareConcurrency || 4)), 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.kokoroThreads)
					.onChange(async (value) => {
						await this.plugin.setKokoroRuntime(
							this.plugin.settings.kokoroDevice,
							value,
						);
					}),
			);
	}

	private renderKokoroInstall(containerEl: HTMLElement): void {
		const store = this.plugin.getModelStore();
		const wanted = KOKORO_WEIGHTS[this.plugin.resolvedWeights()];

		new Setting(containerEl)
			.setName("Kokoro model")
			.setDesc(
				"Downloaded once and kept in the vault so it survives plugin updates. " +
					"Needed for the Kokoro engine, and the only engine that works on Android.",
			);

		new Setting(containerEl)
			.setName("Model build")
			.setDesc(
				`${KOKORO_WEIGHTS.gpu.label}: ${KOKORO_WEIGHTS.gpu.description} ` +
					`${KOKORO_WEIGHTS.fast.label}: ${KOKORO_WEIGHTS.fast.description} ` +
					`${KOKORO_WEIGHTS.small.label}: ${KOKORO_WEIGHTS.small.description}`,
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("auto", "Automatic (fast on desktop, small on mobile)");
				for (const key of ["gpu", "fast", "small"] as const) {
					const build = KOKORO_WEIGHTS[key];
					dropdown.addOption(key, `${build.label} - ${build.sizeMb} MB`);
				}
				dropdown.setValue(this.plugin.settings.kokoroWeights);
				dropdown.onChange(async (value) => {
					await this.plugin.setKokoroWeights(value as never);
					this.display();
				});
			});

		const status = new Setting(containerEl).setName("Status");
		const refreshStatus = async (): Promise<void> => {
			const installed = await store.isFullyInstalled();
			const hasWanted = await store.exists(wanted.path);
			if (!installed) {
				status.setDesc("Not installed yet.");
			} else if (hasWanted) {
				status.setDesc(`Installed: ${wanted.label}.`);
			} else {
				// The engine will happily run on whatever is already there, so
				// this is a nudge rather than a failure.
				status.setDesc(
					`Installed, but not the ${wanted.label} build. Download it for faster synthesis.`,
				);
			}
		};
		void refreshStatus();

		new Setting(containerEl)
			.setName(`Download ${wanted.label}`)
			.setDesc(`About ${wanted.sizeMb} MB, plus the selected voice.`)
			.addButton((button) =>
				button
					.setButtonText("Download")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("Downloading...");
						const notice = new Notice("Downloading Kokoro model...", 0);
						try {
							const result = await downloadModel(
								this.app,
								this.plugin.settings.kokoroModelPath,
								wanted.path,
								this.plugin
									.voiceFileFor(this.plugin.settings.voiceId)
									.replace(/^voices\//, ""),
								({ file, loaded, total }) => {
									const pct =
										total > 0 ? ` (${Math.round((loaded / total) * 100)}%)` : "";
									notice.setMessage(`Downloading ${file}${pct}`);
								},
							);
							if (!result.ok) {
								notice.setMessage(`Download failed: ${result.error}`);
							} else {
								notice.setMessage("Kokoro model ready.");
								setTimeout(() => notice.hide(), 3000);
								// The engine may be holding an older build open.
								await this.plugin.reloadKokoro();
								this.display();
							}
						} finally {
							button.setDisabled(false);
							button.setButtonText("Download");
						}
					}),
			);
	}

	/**
	 * One voice control, not two.
	 *
	 * Kokoro used to have a voice id here and a voice *file* somewhere else,
	 * which could disagree: the engine would synthesise with one and have only
	 * the other on disk, and reading failed at the first sentence. There is
	 * one voice now, and picking it fetches its 512KB style vector if it is
	 * not already downloaded.
	 */
	private renderVoiceSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Voice").setHeading();

		const engine = this.plugin
			.getEngines()
			.find((e) => e.id === this.plugin.settings.engine);
		if (!engine) return;

		const setting = new Setting(containerEl)
			.setName("Voice")
			.setDesc(`Which voice ${engine.label} should use.`);

		setting.addDropdown(async (dropdown) => {
			dropdown.addOption("", "Loading voices...");
			try {
				const voices = await engine.listVoices();
				dropdown.selectEl.empty();
				if (voices.length === 0) dropdown.addOption("", "No voices found");
				for (const voice of voices) {
					dropdown.addOption(voice.id, `${voice.name} (${voice.lang})`);
				}
				// An id saved by an older build may name the same voice in an
				// old format. Show that voice selected; it is persisted in the
				// new form the next time reading starts.
				const stored = this.plugin.settings.voiceId;
				const remapped = voices.some((v) => v.id === stored)
					? undefined
					: engine.resolveVoiceId?.(stored, voices);
				dropdown.setValue(remapped?.id ?? stored);
			} catch (err) {
				dropdown.selectEl.empty();
				dropdown.addOption("", "Could not list voices");
				new Notice(`Could not list voices: ${errText(err)}`);
			}

			dropdown.onChange(async (value) => {
				if (engine.id === "kokoro" && !(await this.ensureVoiceDownloaded(value))) {
					dropdown.setValue(this.plugin.settings.voiceId);
					return;
				}
				await this.plugin.setVoice(value);
			});
		});

		if (engine.id === "kokoro") {
			const note = containerEl.createDiv({ cls: "local-tts-engine-row" });
			void this.plugin
				.getModelStore()
				.exists(this.plugin.voiceFileFor(this.plugin.settings.voiceId))
				.then((present) => {
					note.setText(
						present
							? "Voice downloaded."
							: "This voice is not downloaded yet; it will be fetched when you pick it.",
					);
				});
		}
	}

	/** Fetch a Kokoro voice if it is missing. Returns false if that failed. */
	private async ensureVoiceDownloaded(voiceId: string): Promise<boolean> {
		const store = this.plugin.getModelStore();
		const path = this.plugin.voiceFileFor(voiceId);
		if (await store.exists(path)) return true;

		const file = path.replace(/^voices\//, "");
		const notice = new Notice(`Downloading voice ${file}...`, 0);
		try {
			const result = await downloadVoice(
				this.app,
				this.plugin.settings.kokoroModelPath,
				file,
				() => undefined,
			);
			if (!result.ok) {
				notice.setMessage(`Voice download failed: ${result.error}`);
				setTimeout(() => notice.hide(), 6000);
				return false;
			}
			notice.hide();
			return true;
		} catch (err) {
			notice.setMessage(`Voice download failed: ${errText(err)}`);
			setTimeout(() => notice.hide(), 6000);
			return false;
		}
	}

	private renderPlaybackSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Playback").setHeading();

		new Setting(containerEl)
			.setName("Speed")
			.setDesc("How fast the note is read aloud. Applies immediately if something is playing.")
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 2, 0.05)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.rate)
					.onChange(async (value) => {
						await this.plugin.setRate(value);
					}),
			);

		new Setting(containerEl)
			.setName("Look ahead")
			.setDesc("Passages synthesised ahead of the one playing. Higher is smoother but uses more work.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 8, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.bufferAhead)
					.onChange(async (value) => {
						this.plugin.settings.bufferAhead = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderHighlightSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Highlighting").setHeading();

		new Setting(containerEl)
			.setName("Highlight words")
			.setDesc("Mark the word currently being spoken.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.highlight.enabled).onChange(async (value) => {
					this.plugin.settings.highlight.enabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Highlight colour")
			.addText((text) =>
				text
					.setPlaceholder("#ffd54f")
					.setValue(this.plugin.settings.highlight.color)
					.onChange(async (value) => {
						this.plugin.settings.highlight.color = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderStripSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Skipped content").setHeading();

		const settings = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		// One switch for both code keys. Extraction reads them separately, so
		// splitting this into two toggles is purely a UI choice, deferred until
		// NRL-8 (indented code) and the exclusions work settle what "code" covers.
		new Setting(containerEl)
			.setName("Code")
			.setDesc("Skip inline code and fenced code blocks.")
			.addToggle((toggle) =>
				toggle.setValue(settings.skipCodeBlocks).onChange(async (value) => {
					settings.skipCodeBlocks = value;
					settings.skipInlineCode = value;
					await save();
				}),
			);

		// Positive polarity, matching the stored speakUrls. v0 stored "skip
		// URLs" and the migration inverted it, so what the user hears is
		// unchanged even though the switch now reads the other way.
		new Setting(containerEl)
			.setName("Speak bare links")
			.setDesc("Read the site name of bare URLs aloud (example.com), not the full address. Link labels are always read.")
			.addToggle((toggle) =>
				toggle.setValue(settings.speakUrls).onChange(async (value) => {
					settings.speakUrls = value;
					await save();
				}),
			);

		const rows: Array<["skipTags" | "skipTables" | "skipHeadings", string, string]> = [
			["skipTags", "Tags", "Skip #tags."],
			["skipTables", "Tables", "Skip table rows."],
			["skipHeadings", "Headings", "Skip headings instead of reading them."],
		];

		for (const [key, name, desc] of rows) {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((toggle) =>
					toggle.setValue(settings[key]).onChange(async (value) => {
						settings[key] = value;
						await save();
					}),
				);
		}
	}
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
