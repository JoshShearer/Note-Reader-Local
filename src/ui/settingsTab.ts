import {
	App,
	Modal,
	Notice,
	PluginSettingTab,
	Setting,
	type ButtonComponent,
	type ColorComponent,
} from "obsidian";
import type LocalTtsReaderPlugin from "../main";
import type { VoiceInfo } from "../audio/types";
import {
	KOKORO_MODEL_METADATA,
	KOKORO_VOICES,
	KOKORO_WEIGHTS,
	VOICE_FILE_SIZE_BYTES,
	probeGpu,
	type WeightsVariant,
} from "../engines/onnx/kokoro";
import { RUNTIME_FILES } from "../engines/onnx/runtime";
import {
	downloadModel,
	downloadVoice,
	getInstalledSizeMb,
	getTotalUsage,
	removeModelBuild,
	shouldClearPinnedKokoro,
} from "./modelStore";
import { isAcceptableColourInput } from "./highlightColour";
import { controlAffordances, engineLimitations } from "./affordances";

/**
 * A minimal "are you sure" prompt.
 *
 * Obsidian's `Modal` has no built-in confirm dialog (grepped obsidian.d.ts
 * at plan time) - this is the standard plugin pattern, not a missing
 * import. Cancel, the close (x) button and clicking outside all close with
 * no action; only the confirm button runs `onConfirm`.
 */
class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly modalTitle: string,
		private readonly message: string,
		private readonly confirmText: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: this.modalTitle });
		contentEl.createEl("p", { text: this.message });

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.close();
		});
		const confirmButton = buttonRow.createEl("button", {
			text: this.confirmText,
			cls: "mod-warning",
		});
		confirmButton.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

export class LocalTtsSettingTab extends PluginSettingTab {
	/** Detaches the Speed slider from the player's rate event. */
	private offRate: (() => void) | null = null;
	/** Detaches the Pitch slider from the player's pitch event. */
	private offPitch: (() => void) | null = null;
	/** Detaches the Timer display from the player's timer event. */
	private offTimer: (() => void) | null = null;
	/** Detaches the Timer display from the player's state event. */
	private offTimerState: (() => void) | null = null;

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
		this.offTimer?.();
		this.offTimer = null;
		this.offTimerState?.();
		this.offTimerState = null;
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

		// Reader controls first: Voice, Speed, Pitch, Content, Highlighting, Sleep Timer
		this.renderVoiceSection(containerEl);
		this.renderSpeedSection(containerEl);
		this.renderPitchSection(containerEl);
		this.renderContentSection(containerEl);
		this.renderHighlightSection(containerEl);
		this.renderSleepTimerSection(containerEl);

		// Advanced section (collapsed)
		this.renderAdvancedSection(containerEl);
	}

	private renderAdvancedSection(containerEl: HTMLElement): void {
		const detailsEl = containerEl.createEl("details", { cls: "local-tts-advanced-section" });
		detailsEl.open = false;

		const summaryEl = detailsEl.createEl("summary");
		summaryEl.createEl("strong", { text: "Advanced" });

		const contentEl = detailsEl.createDiv();

		this.renderEngineSection(contentEl);
		if (this.plugin.activeEngine()?.id === "kokoro") {
			this.renderKokoroRuntime(contentEl);
			this.renderKokoroInstall(contentEl);
			this.renderOrtInstall(contentEl);
		}
		if (!this.plugin.activeEngine()?.capabilities.ownsPlayback) {
			this.renderLookAheadSection(contentEl);
		}
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
					"Local neural model, and the only route to on-device speech on Android: " +
					"real-hardware testing (SPIKE-ANDROID-001) found no reachable system TTS.",
			);

		// R-C02's model card fields shown ahead of the Download button:
		// name, language and license here (build-independent); download
		// size is on the Model build row below and installed size is on
		// Status below that, since both are per-build.
		new Setting(containerEl)
			.setName("Model")
			.setDesc(
				`${KOKORO_MODEL_METADATA.name} - ${KOKORO_MODEL_METADATA.language} - ${KOKORO_MODEL_METADATA.license} license.`,
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
		let removeButton: ButtonComponent | null = null;

		const refreshStatus = async (): Promise<void> => {
			const installed = await store.isFullyInstalled();
			const hasWanted = await store.exists(wanted.path);
			// Installed size is a real stat() of what is on disk, never the
			// download-size table: a resumed or hand-edited file must not be
			// reported as though it matched the table.
			const installedMb = await getInstalledSizeMb(
				this.app.vault.adapter,
				this.plugin.settings.kokoroModelPath,
				this.plugin.resolvedWeights(),
			);
			const installedNote = installedMb !== null ? ` (${installedMb.toFixed(1)} MB installed)` : "";
			if (!installed) {
				status.setDesc("Not installed yet.");
			} else if (hasWanted) {
				status.setDesc(`Installed: ${wanted.label}${installedNote}.`);
			} else {
				// The engine will happily run on whatever is already there, so
				// this is a nudge rather than a failure.
				status.setDesc(
					`Installed, but not the ${wanted.label} build. Download it for faster synthesis.`,
				);
			}
			removeButton?.setDisabled(!hasWanted);
		};

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
			)
			.addButton((button) => {
				removeButton = button;
				button
					// Deprecated in favour of setDestructive(), which needs Obsidian
					// >=1.13.0 - newer than this plugin's declared minAppVersion
					// (1.8.0, manifest.json). setWarning() still works everywhere
					// the plugin claims to support.
					.setWarning()
					.setButtonText("Remove")
					.setDisabled(true)
					.onClick(() => {
						new ConfirmModal(
							this.app,
							`Remove ${wanted.label}?`,
							`This deletes the downloaded ${wanted.label} weights file (${wanted.path}) ` +
								"from your vault. This cannot be undone; you can download it again later.",
							"Remove",
							() => {
								void this.removeKokoroBuild(wanted, button, refreshStatus);
							},
						).open();
					});
			});

		void refreshStatus();

		const totalUsage = new Setting(containerEl)
			.setName("Total on-disk usage")
			.setDesc("Computing...");
		void getTotalUsage(
			this.app.vault.adapter,
			this.plugin.settings.kokoroModelPath,
			// The full list, not an empty array. The runtime is bundled now
			// (ADR 0026), so on a fresh install every one of these stats is 0 -
			// but an install upgrading from the on-demand layout still has that
			// ort/ directory on disk, and passing [] would quietly drop 31 MB
			// from the figure this row is promising to be honest about.
			[...RUNTIME_FILES],
		).then((usage) => {
			if (!containerEl.isConnected) return;
			const totalMb = Math.round(usage.totalBytes / 1_000_000);
			totalUsage.setDesc(
				`${totalMb} MB across every downloaded build, voice, and the ONNX runtime, ` +
					`in ${this.plugin.settings.kokoroModelPath}.`,
			);
		});
	}

	/**
	 * Delete one Kokoro weights build, after the user has confirmed.
	 *
	 * Removing the build behind a literal Kokoro pin (not "Automatic") must
	 * not leave the engine dropdown pointed at something with no weights on
	 * disk - `shouldClearPinnedKokoro` is owner Decision 3's concrete rule
	 * for when to fall back to automatic selection instead. `reloadKokoro()`
	 * and `this.display()` run unconditionally on success, matching the
	 * Download button's own handler above: either one might have changed
	 * what is on disk under the engine's feet.
	 */
	private async removeKokoroBuild(
		wanted: WeightsVariant,
		button: ButtonComponent,
		refreshStatus: () => Promise<void>,
	): Promise<void> {
		button.setDisabled(true);
		button.setButtonText("Removing...");
		try {
			const result = await removeModelBuild(
				this.app.vault.adapter,
				this.plugin.settings.kokoroModelPath,
				this.plugin.resolvedWeights(),
			);
			if (!result.ok) {
				new Notice(
					result.error
						? `Could not remove ${wanted.label}: ${result.error}`
						: `${wanted.label} is not installed.`,
				);
				await refreshStatus();
				return;
			}
			const freedMb = (result.freedBytes / 1_000_000).toFixed(1);
			new Notice(`Removed ${wanted.label} (${freedMb} MB freed).`);

			const kokoro = this.plugin.getKokoro();
			const kokoroAvailableAfterRemoval = kokoro
				? (await kokoro.isAvailable()).available
				: false;
			if (shouldClearPinnedKokoro(this.plugin.settings.engine, kokoroAvailableAfterRemoval)) {
				await this.plugin.setEngine("auto");
				new Notice(
					"Kokoro is no longer installed; switched back to automatic engine selection.",
				);
			}

			await this.plugin.reloadKokoro();
			this.display();
		} finally {
			button.setDisabled(false);
			button.setButtonText("Remove");
		}
	}

	/**
	 * The ONNX runtime is part of the plugin, not something the user installs.
	 *
	 * ADR 0026 supersedes ADR 0024's distribution decision: Obsidian's
	 * community-plugin policies prohibit installing or updating dependencies,
	 * and a runtime fetched from a release URL is executable dependency
	 * management however well it is verified. The runtime therefore travels
	 * inside main.js, so there is nothing to download, nothing to go stale and
	 * nothing to check against the filesystem.
	 *
	 * What survives as a control is the one thing that can actually be wrong
	 * on a user machine: the pack failed to unpack, which is a corrupt install
	 * rather than a missing download. It is reported rather than papered over,
	 * and there is deliberately no repair button - reinstalling the plugin is
	 * the repair, and offering a second path would imply the first was a choice.
	 */
	private renderOrtInstall(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("ONNX Runtime").setHeading();
		new Setting(containerEl)
			.setName("Status")
			.setDesc("Bundled with the plugin. Nothing to download.")
			.setDisabled(true);
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
				else {
					// Group voices by language tag, sort within each group,
					// and add visual language headers
					const grouped = groupVoicesByLanguage(voices);
					for (const [lang, voicesInLang] of grouped) {
						// Add language header (disabled option)
						dropdown.addOption(`__lang_${lang}`, `-- ${lang} --`);
						// Add voices in this language
						for (const voice of voicesInLang) {
							const label = `  ${voice.name}${voice.isVariant ? " (variant)" : ""}${voiceNetworkMarker(voice)}`;
							dropdown.addOption(voice.id, label);
						}
					}
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
		// States the size up front, per R-C02: it is a fixed, already-known
		// constant (VOICE_FILE_SIZE_BYTES), so no separate confirmation step
		// is needed before it starts.
		const notice = new Notice(
			`Downloading voice ${file} (~${(VOICE_FILE_SIZE_BYTES / 1_000_000).toFixed(2)} MB)...`,
			0,
		);
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

	private renderSpeedSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Speed").setHeading();

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
	}

	private renderPitchSection(containerEl: HTMLElement): void {
		// Add pitch slider if the engine supports it
		const engine = this.plugin.activeEngine();
		if (!engine?.capabilities.pitch) return;

		new Setting(containerEl).setName("Pitch").setHeading();

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
	}

	private renderLookAheadSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Look ahead").setHeading();

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

	private renderSleepTimerSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Sleep timer").setHeading();

		new Setting(containerEl)
			.setName("Sleep timer")
			.setDesc("Automatically stop reading after a set duration.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("off", "Off")
					.addOption("5m", "5 minutes")
					.addOption("10m", "10 minutes")
					.addOption("15m", "15 minutes")
					.addOption("30m", "30 minutes")
					.addOption("60m", "60 minutes")
					.setValue(this.plugin.settings.timerPreset)
					.onChange(async (value) => {
						await this.plugin.setTimerPreset(value);
					});
			});

		// Timer countdown display
		const timerDisplayEl = containerEl.createDiv({ cls: "local-tts-timer-display" });
		timerDisplayEl.style.display = "none";
		const timerLabel = timerDisplayEl.createSpan();

		// Update timer display on timer event
		const updateTimerDisplay = (remaining: number) => {
			if (remaining <= 0) {
				timerDisplayEl.style.display = "none";
			} else {
				timerDisplayEl.style.display = "block";
				const minutes = Math.floor(remaining / 60000);
				const seconds = Math.floor((remaining % 60000) / 1000);
				timerLabel.setText(`Time remaining: ${minutes}:${seconds.toString().padStart(2, "0")}`);
			}
		};

		// Listen to player timer event
		this.offTimer = this.plugin.getPlayer().on("timer", (remaining) => {
			updateTimerDisplay(remaining);
		});

		// Listen to player state to hide countdown when not playing
		this.offTimerState = this.plugin.getPlayer().on("state", (state) => {
			if (state === "idle" || state === "finished") {
				timerDisplayEl.style.display = "none";
			}
		});
	}

	private renderHighlightSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Highlighting").setHeading();

		// `highlightToggle` is the WORD gate and nothing more: its own limitation
		// text is "no word highlighting" and its reason names word timings. So it
		// gates the word row below and **only** that row.
		//
		// It used to disable this master toggle as well, which on
		// speech-dispatcher - the one engine where the sentence highlight is the
		// only layer that can ever work - meant a stored `false` left the note
		// with no highlight and no reachable control to bring it back. That is the
		// bug NRL-54 names. Do not re-apply a word-timing gate to anything but
		// the word row. The stored preference is left alone on purpose, the same
		// as "Look ahead" above: switching engine must not rewrite settings.
		const active = this.plugin.activeEngine();
		const wordToggleAffordance = controlAffordances(
			active?.capabilities ?? null,
			active?.label ?? "This engine",
		).highlightToggle;

		// No this.display() on any of these three. Re-rendering the tab to grey
		// out two checkboxes costs a containerEl.empty() that moves focus to
		// body, collapses the Advanced section, and re-runs every engine probe
		// (subprocess spawns and a GPU adapter request) behind a highlight
		// checkbox. The master switch is honoured where it matters instead, in
		// highlightPlan(), so the child rows stay live and simply do nothing
		// while it is off.
		new Setting(containerEl)
			.setName("Highlight while reading")
			.setDesc("Master switch. Turn off to read with no marks at all.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.highlight.enabled).onChange(async (value) => {
					this.plugin.settings.highlight.enabled = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Highlight sentences")
			.setDesc("Mark the sentence currently being spoken. Works on every engine.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.highlight.sentence).onChange(async (value) => {
					this.plugin.settings.highlight.sentence = value;
					await this.plugin.saveSettings();
				});
			});

		const wordSetting = new Setting(containerEl)
			.setName("Highlight words")
			.setDesc("Mark the word currently being spoken, over the sentence mark.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.highlight.word).onChange(async (value) => {
					this.plugin.settings.highlight.word = value;
					await this.plugin.saveSettings();
				});
				if (!wordToggleAffordance.enabled) toggle.setDisabled(true);
			});
		if (!wordToggleAffordance.enabled) {
			wordSetting.descEl.createDiv({ text: wordToggleAffordance.reason });
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

/**
 * Group voices by BCP-47 language tag, sort within each group
 * (non-variants first, then alphabetically), and return as a sorted Map.
 */
function groupVoicesByLanguage(voices: VoiceInfo[]): Map<string, VoiceInfo[]> {
	const grouped = new Map<string, VoiceInfo[]>();

	// Group by language tag
	for (const voice of voices) {
		const lang = voice.lang;
		if (!grouped.has(lang)) {
			grouped.has(lang);
			grouped.set(lang, []);
		}
		grouped.get(lang)!.push(voice);
	}

	// Sort within each group: non-variants first, then alphabetically
	for (const voicesInLang of grouped.values()) {
		voicesInLang.sort((a, b) => {
			if (a.isVariant !== b.isVariant) {
				return a.isVariant ? 1 : -1; // Non-variants first
			}
			return a.name.localeCompare(b.name); // Alphabetically
		});
	}

	// Sort language groups alphabetically and return as new Map
	const sorted = new Map(
		Array.from(grouped.entries()).sort(([langA], [langB]) => langA.localeCompare(langB)),
	);
	return sorted;
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
