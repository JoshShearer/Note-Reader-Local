import { App, Notice, PluginSettingTab, Setting, type ColorComponent } from "obsidian";
import type LocalTtsReaderPlugin from "../main";
import type { VoiceInfo } from "../audio/types";
import { KOKORO_VOICES, KOKORO_WEIGHTS, probeGpu } from "../engines/onnx/kokoro";
import { downloadModel, downloadVoice } from "./modelStore";
import { isAcceptableColourInput } from "./highlightColour";
import { controlAffordances, engineLimitations } from "./affordances";

export class LocalTtsSettingTab extends PluginSettingTab {
	/** Detaches the Speed slider from the player's rate event. */
	private offRate: (() => void) | null = null;
	/** Detaches the Pitch slider from the player's pitch event. */
	private offPitch: (() => void) | null = null;

	constructor(
		app: App,
		private readonly plugin: LocalTtsReaderPlugin,
	) {
		super(app, plugin);
	}

	override hide(): void {
		this.offRate?.();
		this.offRate = null;
		this.offPitch?.();
		this.offPitch = null;
		this.plugin.stopReading();
		super.hide();
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// display() re-runs on engine change; detach the old slider first.
		this.offRate?.();
		this.offRate = null;
		this.offPitch?.();
		this.offPitch = null;

		this.renderEngineSection(containerEl);
		this.renderVoiceSection(containerEl);
		this.renderPlaybackSection(containerEl);
		this.renderHighlightSection(containerEl);
		this.renderContentSection(containerEl);
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
			.setDesc(this.engineNetworkClaim())
			.addDropdown((dropdown) => {
				dropdown.addOption("auto", "Automatic");
				for (const engine of this.plugin.getEngines()) {
					dropdown.addOption(engine.id, engine.label);
				}
				dropdown.setValue(this.plugin.settings.engine).onChange(async (value) => {
					await this.plugin.setEngine(value as never);
					// Voice ids are engine-scoped, so the list must reload.
					this.display();
				});
			});

		if (this.plugin.settings.engine === "auto") {
			const chosen = new Setting(containerEl).setName("Automatic picked").setDesc("Checking...");
			void this.plugin.resolveAutomaticChoice().then((resolved) => {
				if (!containerEl.isConnected) return;
				const engine = this.plugin.getEngines().find((e) => e.id === resolved.id);
				chosen.setDesc(`${engine?.label ?? resolved.id} - ${resolved.reason}`);
			});
		}

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
				// Every limitation, not just the highlighting one: the point of
				// declaring capabilities is that the user can see all of them
				// before picking an engine.
				if (status.available) {
					const limits = engineLimitations(status.engine.capabilities, status.engine.label);
					if (limits.length > 0) {
						row.createSpan({
							cls: "local-tts-engine-note",
							text: limits.map((l) => l.text).join(", "),
						});
					}
				}
			}
		});

		// The resolved engine, not the literal stored id: with "Automatic"
		// selected, `settings.engine` is the string "auto", which matches no
		// engine.id and would hide this section even when automatic selection
		// actually picked Kokoro.
		if (this.plugin.activeEngine()?.id === "kokoro") this.renderKokoroRuntime(containerEl);
		this.renderKokoroInstall(containerEl);
	}

	/**
	 * What can honestly be claimed about network use, keyed to the RESOLVED
	 * engine (`activeEngine()?.id`, the same idiom as line 102 above and
	 * renderVoiceSection below), not a single static sentence covering all
	 * four. Switching engines visibly changes what's claimed, which is the
	 * point: the old blanket "None of them send your notes anywhere" was
	 * untrue for a cloud-backed Web Speech voice (R-S01/R-S04, non-negotiable
	 * 4's "no cloud TTS" is about what THIS plugin does, not what an OS voice
	 * a user already configured might do).
	 *
	 * The null case (before the first automatic resolution completes) is
	 * worded to be true regardless of which engine ends up resolved, not a
	 * guess at one.
	 */
	private engineNetworkClaim(): string {
		const id = this.plugin.activeEngine()?.id;
		switch (id) {
			case "kokoro":
			case "espeak":
				return "This engine runs entirely on this device; it never sends your notes anywhere.";
			case "speechd":
				return "This engine speaks through a local daemon, but it cannot report whether a given voice's synthesis needs the network (see the voice list below).";
			case "webspeech":
				return "This engine uses your operating system's installed voices. A voice marked \"needs network\" below sends the text being read to a remote service to synthesize it; pick a local voice to keep everything on this device.";
			default:
				return "Kokoro and espeak-ng run entirely on this device. Speech Dispatcher and Web Speech use voices installed on the system that this plugin cannot always verify are local; the voice list below marks what's known.";
		}
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

		// The resolved engine: with "Automatic" selected this must be the
		// engine automatic selection actually picked, or this section would
		// vanish entirely (settings.engine is the literal string "auto",
		// which matches no engine.id).
		const engine = this.plugin.activeEngine();
		if (!engine) return;

		// A voice-selection preference, not an engine one, so it lives here
		// rather than in the Engine section above. Affects automatic voice
		// selection only (pickLocaleVoice's tiebreak, voiceChoice.ts) - a
		// pinned voice is untouched regardless of this setting (R-S04's
		// "preference, not a guarantee"), and the dropdown below still lists
		// every voice.
		new Setting(containerEl)
			.setName("Prefer voices that do not require network access")
			.setDesc(
				"When choosing a voice automatically - no voice pinned, or the pinned one is gone - " +
					"prefer a voice that doesn't need the network. Not a guarantee: if nothing local " +
					"matches your language, a network or unknown-status voice may still be chosen.",
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.offlinePreferred).onChange(async (value) => {
					this.plugin.settings.offlinePreferred = value;
					await this.plugin.saveSettings();
				});
			});

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
					dropdown.addOption(voice.id, `${voice.name} (${voice.lang})${voiceNetworkMarker(voice)}`);
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
			.addSlider((slider) => {
				slider
					.setLimits(0.5, 2, 0.05)
					.setDynamicTooltip()
					.setValue(this.plugin.getPlayer().getRate())
					.onChange(async (value) => {
						await this.plugin.setRate(value);
					});
				// Follow the player, so a nudge on the control bar moves this
				// slider too. The player emits only on change, so a setValue
				// that fires onChange cannot bounce back and forth.
				this.offRate = this.plugin.getPlayer().on("rate", (rate) => {
					if (slider.getValue() !== rate) slider.setValue(rate);
				});
			});

		// Add pitch slider if the engine supports it
		const engine = this.plugin.activeEngine();
		if (engine?.capabilities.pitch) {
			new Setting(containerEl)
				.setName("Pitch")
				.setDesc("Change how high or low the voice sounds. Applies to future synthesis only.")
				.addSlider((slider) => {
					slider
						.setLimits(-50, 50, 1)
						.setDynamicTooltip()
						.setValue(this.plugin.getPlayer().getPitch())
						.onChange(async (value) => {
							await this.plugin.setPitch(value);
						});
					// Follow the player, so changes update both places
					this.offPitch = this.plugin.getPlayer().on("pitch", (pitch) => {
						if (slider.getValue() !== pitch) slider.setValue(pitch);
					});
				});
		} else if (engine) {
			// Engine doesn't support pitch, show disabled message
			new Setting(containerEl)
				.setName("Pitch")
				.setDesc(`Not available: ${engine.label} does not support pitch control.`);
		}

		// The player never prefetches for an engine that speaks as it
		// synthesises, so the slider would do nothing there. The stored value is
		// left alone so switching back to a buffer engine restores it. Resolved
		// engine, same reason as renderVoiceSection above.
		if (engine?.capabilities.ownsPlayback) {
			new Setting(containerEl)
				.setName("Look ahead")
				.setDesc(
					`Not used by ${engine.label}: it speaks each passage as it is produced, so there is nothing to prepare ahead.`,
				);
			return;
		}

		new Setting(containerEl)
			.setName("Look ahead")
			.setDesc(
				"Passages synthesised ahead of the one playing. Higher is smoother but uses more work. Applies immediately if something is playing.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 8, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.bufferAhead)
					// Goes through the plugin rather than writing the setting
					// directly, so the running player widens or narrows its
					// window now instead of on the next load.
					.onChange(async (value) => {
						await this.plugin.setBufferAhead(value);
					}),
			);
	}

	private renderHighlightSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Highlighting").setHeading();

		// On an engine that reports no timings there is nothing to highlight, so
		// the toggle is disabled and says why. The stored preference is left
		// alone on purpose, the same as "Look ahead" above: switching to
		// speech-dispatcher and back must not silently turn highlighting off.
		const active = this.plugin.activeEngine();
		const highlightToggle = controlAffordances(
			active?.capabilities ?? null,
			active?.label ?? "This engine",
		).highlightToggle;

		const highlightSetting = new Setting(containerEl)
			.setName("Highlight words")
			.setDesc("Mark the word currently being spoken.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.highlight.enabled).onChange(async (value) => {
					this.plugin.settings.highlight.enabled = value;
					await this.plugin.saveSettings();
				});
				if (!highlightToggle.enabled) toggle.setDisabled(true);
			});
		if (!highlightToggle.enabled) {
			highlightSetting.descEl.createDiv({ text: highlightToggle.reason });
		}

		// A free-text field alone would accept "not a colour" and quietly
		// highlight nothing. Invalid input is refused with a visible error and
		// the last valid colour stays in effect. Empty means follow the theme.
		const colourSetting = new Setting(containerEl)
			.setName("Highlight colour")
			.setDesc("A hex colour. Leave empty to use the theme's highlight colour.");
		const errorEl = colourSetting.descEl.createDiv({ cls: "mod-warning" });
		errorEl.hide();
		let picker: ColorComponent | null = null;
		let textInput: HTMLInputElement | null = null;
		// Set while the text field pushes its value into the picker. The
		// picker holds #rrggbb only, so if setValue echoes through onChange it
		// must not overwrite a #rgb or #rrggbbaa the user typed.
		let syncingPicker = false;

		colourSetting.addText((text) => {
			textInput = text.inputEl;
			text
				.setPlaceholder("Theme default")
				.setValue(this.plugin.settings.highlight.color)
				.onChange(async (raw) => {
					const value = raw.trim();
					if (!isAcceptableColourInput(value)) {
						errorEl.setText(
							"Not a hex colour (#rgb, #rgba, #rrggbb or #rrggbbaa). The previous colour is still in use.",
						);
						errorEl.show();
						return;
					}
					errorEl.hide();
					await this.plugin.setHighlightColour(value);
					const hex = toPickerHex(value);
					if (hex && picker) {
						syncingPicker = true;
						picker.setValue(hex);
						syncingPicker = false;
					}
				});
		});
		colourSetting.addColorPicker((p) => {
			picker = p;
			const initial = toPickerHex(this.plugin.settings.highlight.color);
			if (initial) p.setValue(initial);
			p.onChange(async (value) => {
				if (syncingPicker) return;
				errorEl.hide();
				await this.plugin.setHighlightColour(value);
				if (textInput) textInput.value = value;
			});
		});
		colourSetting.addExtraButton((button) =>
			button
				.setIcon("rotate-ccw")
				.setTooltip("Use the theme's highlight colour")
				.onClick(async () => {
					await this.plugin.setHighlightColour("");
					errorEl.hide();
					if (textInput) textInput.value = "";
				}),
		);
	}

	/**
	 * One "Content" group covering every exclusion, each row writing exactly one
	 * key.
	 *
	 * The heading is no longer "Skipped content": with speakUrls, speakImageAlt
	 * and speakEmbeds in it the group is not all-skip, and the polarity of each
	 * row follows its stored key rather than being normalised (ADR 0001).
	 *
	 * A row writing a second key is how the "Code" switch silently governed
	 * inline code, so there is no shared row here. Changes take effect on the
	 * next read: extraction runs once when a read starts, so a queue the player
	 * is already holding is deliberately left alone (ADR 0008).
	 */
	private renderContentSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Content").setHeading();

		const settings = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		type ContentKey =
			| "skipFrontmatter"
			| "skipCodeBlocks"
			| "skipInlineCode"
			| "speakUrls"
			| "speakImageAlt"
			| "speakEmbeds"
			| "skipTags"
			| "skipTables"
			| "skipHeadings";

		const rows: Array<[ContentKey, string, string]> = [
			["skipFrontmatter", "Frontmatter", "Skip the note's YAML properties block."],
			["skipCodeBlocks", "Code blocks", "Skip fenced and indented code blocks."],
			["skipInlineCode", "Inline code", "Skip `inline code` spans."],
			// Positive polarity, matching the stored speakUrls. v0 stored "skip
			// URLs" and the migration inverted it, so what the user hears is
			// unchanged even though the switch reads the other way.
			[
				"speakUrls",
				"Speak bare links",
				"Read the site name of bare URLs aloud (example.com), not the full address. Link labels are always read.",
			],
			[
				"speakImageAlt",
				"Speak image alt text",
				"Read an image's alt text aloud. The image's file path is never read.",
			],
			[
				"speakEmbeds",
				"Speak embeds",
				"Read the name an ![[embed]] refers to. The embedded note's contents are not read.",
			],
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

/**
 * Suffix for the voice dropdown: nothing for a confirmed-local voice,
 * otherwise a plain-language marker so the "unknown" case is not mistaken
 * for "known safe" (R-S01's "MUST NOT claim offline when it cannot
 * determine this" cuts both ways - silence here would be its own claim).
 */
function voiceNetworkMarker(voice: VoiceInfo): string {
	if (voice.local === true) return "";
	if (voice.local === false) return " - needs network";
	return " - network status unknown";
}

/**
 * The colour picker only takes #rrggbb. Expand #rgb, drop any alpha, and
 * return null for "" (theme default), leaving the picker as it is.
 */
function toPickerHex(stored: string): string | null {
	const hex = stored.replace(/^#/, "").toLowerCase();
	if (/^[0-9a-f]{3,4}$/.test(hex)) {
		return `#${[...hex.slice(0, 3)].map((c) => c + c).join("")}`;
	}
	if (/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(hex)) return `#${hex.slice(0, 6)}`;
	return null;
}
