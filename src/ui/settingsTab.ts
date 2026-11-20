import {
	App,
	Modal,
	Notice,
	Setting,
	setIcon,
	type ColorComponent,
} from "obsidian";
import type LocalTtsReaderPlugin from "../main";
import type { Settings } from "../settings";
import type { VoiceInfo } from "../audio/types";
import { READ_ME_FDROID_URL, READ_ME_SETUP_STEPS, shouldShowBridgeSetup } from "../engines/bridge/readMe";
import {
	describeKokoroVoiceFile,
	KOKORO_MODEL_METADATA,
	KOKORO_VOICES,
	KOKORO_WEIGHTS,
	WEIGHTS_KEYS,
	GPU_CAPABLE_WEIGHTS,
	type WeightsKey,
	VOICE_FILE_SIZE_BYTES,
	probeGpu,
} from "../engines/onnx/kokoro";
import { RUNTIME_FILES } from "../engines/onnx/runtime";
import { KNOWN_ENGINES } from "../engines/registry";
import {
	describeModelDownload,
	downloadModel,
	downloadVoice,
	getInstalledSizeMb,
	getTotalUsage,
	listInstalledVoices,
	removeModelBuild,
	removeVoice,
	shouldClearPinnedKokoro,
} from "./modelStore";
import { isAcceptableColourInput } from "./highlightColour";
import { controlAffordances } from "./affordances";

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

/**
 * The plugin's settings UI, drawn into any container.
 *
 * Not a `PluginSettingTab`: the sidebar view (settingsView.ts) hosts it, and
 * the Settings dialog only carries a pointer to that view. Everything here
 * takes a container element, so the same rows work in either place.
 */
type VoiceSortKey = "name" | "lang" | "gender" | "grade";
type KokoroVoiceRow = (typeof KOKORO_VOICES)[number];

/** Radius of the download button's progress ring, in its 20-unit viewBox. */
const RING_RADIUS = 7;

/** A model download in progress: how to stop it, how far it is, and the button showing it. */
interface BuildDownload {
	controller: AbortController;
	/** 0 to 1 once the size is known, null before that. */
	fraction: number | null;
	button: HTMLButtonElement | null;
	ring: SVGElement | null;
}

export class SettingsPanel {
	/** Detaches the Speed slider from the player's rate event. */
	private offRate: (() => void) | null = null;
	/** Detaches the Pitch slider from the player's pitch event. */
	private offPitch: (() => void) | null = null;
	/** Detaches the Timer display from the player's timer event. */
	private offTimer: (() => void) | null = null;
	/** Detaches the Timer display from the player's state event. */
	private offTimerState: (() => void) | null = null;
	/** Detaches the Status bubble from the player and the plugin. */
	/** Downloads in progress ("build:<key>" or "voice:<file>"), so a redrawn page can show them again. */
	private buildDownloads = new Map<string, BuildDownload>();
	private offStatus: (() => void) | null = null;
	/** Stops the Model box's memory line following the engine. */
	private offMemory: (() => void) | null = null;
	/** Re-asks the Engine section's rows; set while that section is drawn. */
	private refreshEngineSection: (() => void) | null = null;

	constructor(
		private readonly app: App,
		private readonly plugin: LocalTtsReaderPlugin,
	) {}

	/** Detach every listener this panel registered. Safe to call repeatedly. */
	unmount(): void {
		this.offRate?.();
		this.offRate = null;
		this.offPitch?.();
		this.offPitch = null;
		this.offTimer?.();
		this.offTimer = null;
		this.offTimerState?.();
		this.offTimerState = null;
		this.offStatus?.();
		this.offStatus = null;
		this.offMemory?.();
		this.offMemory = null;
		this.refreshEngineSection = null;
		if (this.slideTimer !== null) window.clearTimeout(this.slideTimer);
		this.slideTimer = null;
	}

	/** How the Kokoro voice table is sorted; kept across redraws so a download does not reset it. */
	private voiceSort: { key: VoiceSortKey; dir: 1 | -1 } = { key: "grade", dir: 1 };

	/** Titles of the collapsible groups that are expanded; survives redraws. */
	private openSections = new Set<string>(["Voice", "Speed", "Pitch"]);

	/** Where the panel is drawn, kept so a section can ask for a redraw. */
	private root: HTMLElement | null = null;

	/** Containers already listening for row clicks, so a redraw does not stack listeners. */
	private wired = new WeakSet<HTMLElement>();

	/**
	 * Make a click anywhere on a switch row flip its switch.
	 *
	 * One delegated listener per container, because the rows are rebuilt on
	 * every redraw. Clicks that already do something (the switch itself,
	 * buttons, links, inputs) are left alone.
	 */
	private wireRowToggles(containerEl: HTMLElement): void {
		if (this.wired.has(containerEl)) return;
		this.wired.add(containerEl);
		containerEl.addEventListener("click", (event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest(".checkbox-container, button, a, input, select, textarea")) return;
			const row = target.closest(".setting-item");
			const toggle = row?.querySelector<HTMLElement>(".checkbox-container");
			toggle?.click();
		});
	}

	/**
	 * The two pages, side by side in a pager: the main settings, and the page
	 * for one engine that slides in over it. `subEngine` is the engine whose
	 * page is open, or null for the main page; it survives a remount so the
	 * pane reopens where it was left.
	 */
	private mainEl: HTMLElement | null = null;
	private subEl: HTMLElement | null = null;
	private subBody: HTMLElement | null = null;
	private pagerEl: HTMLElement | null = null;
	private subEngine: { id: string; label: string } | null = null;
	/** Scroll offset of the main page, restored when coming back from an engine page. */
	private mainScroll = 0;
	private slideTimer: number | null = null;

	/** Long enough for the slide in styles.css; the other page is dropped from layout after it. */
	private static readonly SLIDE_MS = 260;

	/** Redraw the page that is showing; the sections call this after a change that reshapes them. */
	private display(): void {
		if (!this.root) return;
		if (this.subEngine && this.subBody) this.renderEnginePage(this.subBody, this.subEngine.id, this.subEngine.label);
		else this.renderMain();
	}

	/** Draw (or redraw) the whole panel into `containerEl`. */
	mount(containerEl: HTMLElement): void {
		this.root = containerEl;
		containerEl.empty();
		this.wireRowToggles(containerEl);

		this.pagerEl = containerEl.createDiv({ cls: "local-tts-pager" });
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) this.pagerEl.addClass("is-reduced-motion");
		this.mainEl = this.pagerEl.createDiv({ cls: "local-tts-page local-tts-page-main" });
		this.subEl = this.pagerEl.createDiv({ cls: "local-tts-page local-tts-page-sub" });
		this.subEl.hidden = true;
		this.renderMain();

		// Reopened with an engine page open: show it at once, no slide.
		if (this.subEngine) this.buildSubPage(this.subEngine.id, this.subEngine.label, false);
	}

	private renderMain(): void {
		const el = this.mainEl;
		if (!el) return;
		el.empty();
		// Re-runs on engine change; detach the old sliders first.
		this.offRate?.();
		this.offRate = null;
		this.offPitch?.();
		this.offPitch = null;
		this.offStatus?.();
		this.offStatus = null;

		// What is being read, and with what, above the controls that shape it.
		this.renderStatusBubble(el);

		// Reader controls first: Voice, Speed, Pitch, Content, Highlighting, Sleep Timer
		this.renderVoiceGroup(el);
		this.renderContentSection(el);
		this.renderHighlightSection(el);
		this.renderSleepTimerSection(el);

		// Engine section (collapsed)
		this.renderEngineGroup(el);
	}

	/** The element that scrolls the pane, for resetting and restoring the position. */
	private scroller(): HTMLElement | null {
		return this.root?.closest<HTMLElement>(".local-tts-settings-scroll") ?? null;
	}

	/** Slide an engine's page in over the main settings. */
	private openEngine(id: string, label: string): void {
		if (this.subEngine || !this.pagerEl) return;
		this.mainScroll = this.scroller()?.scrollTop ?? 0;
		this.subEngine = { id, label };
		this.buildSubPage(id, label, true);
	}

	private buildSubPage(id: string, label: string, animate: boolean): void {
		const pager = this.pagerEl;
		const sub = this.subEl;
		const main = this.mainEl;
		if (!pager || !sub || !main) return;
		if (this.slideTimer !== null) window.clearTimeout(this.slideTimer);

		sub.empty();
		// Pinned at the top of the pane while the page scrolls beneath it.
		const header = sub.createDiv({ cls: "local-tts-subpage-header" });
		// The whole ribbon is the way back, not just the arrow: the icon is a
		// small target, and the title beside it reads as a "back to" label.
		const back = header.createSpan({ cls: "local-tts-subpage-back" });
		setIcon(back, "arrow-left");
		const title = header.createSpan({ cls: "local-tts-subpage-title", text: label });
		title.id = "local-tts-subpage-title";
		// Named by the title, not an aria-label: Obsidian shows any aria-label as a tooltip.
		header.setAttribute("role", "button");
		header.setAttribute("aria-labelledby", "local-tts-subpage-title");
		header.tabIndex = 0;
		header.addEventListener("click", () => this.closeEngine());
		header.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			this.closeEngine();
		});
		const body = sub.createDiv({ cls: "local-tts-subpage-body" });
		this.subBody = body;
		this.renderEnginePage(body, id, label);

		sub.hidden = false;
		const scroller = this.scroller();
		if (scroller) scroller.scrollTop = 0;
		if (!animate) {
			pager.addClass("is-sub");
			main.hidden = true;
			return;
		}
		// Reflow with the sub page parked off to the right, then let the class
		// change run the transition.
		void sub.offsetWidth;
		pager.addClass("is-sub");
		this.slideTimer = window.setTimeout(() => {
			main.hidden = true;
			this.slideTimer = null;
		}, SettingsPanel.SLIDE_MS);
	}

	/** Slide back to the main settings. */
	private closeEngine(): void {
		const pager = this.pagerEl;
		const sub = this.subEl;
		const main = this.mainEl;
		if (!this.subEngine || !pager || !sub || !main) return;
		if (this.slideTimer !== null) window.clearTimeout(this.slideTimer);
		this.subEngine = null;
		this.subBody = null;

		// Redrawn first: availability and the Automatic choice may have changed
		// while the engine page was open (a download, a bridge check).
		main.hidden = false;
		this.renderMain();
		const scroller = this.scroller();
		if (scroller) scroller.scrollTop = this.mainScroll;
		void main.offsetWidth;
		pager.removeClass("is-sub");
		this.slideTimer = window.setTimeout(() => {
			sub.hidden = true;
			sub.empty();
			this.slideTimer = null;
		}, SettingsPanel.SLIDE_MS);
	}

	/**
	 * Whether an engine has anything to configure on this device. The gear is
	 * only drawn for those that do, and an engine's page is only built from the
	 * same list, so the two cannot drift apart.
	 */
	private engineHasSettings(id: string): boolean {
		const engine = this.plugin.getEngines().find((e) => e.id === id);
		if (!engine) return false;
		return (
			(id === "kokoro" && !!this.plugin.getKokoro()) ||
			(id === "readme" && !!this.plugin.getBridge()) ||
			(id === "piper" && !!this.plugin.getPiper()) ||
			id === "webspeech" ||
			id === "speechd" ||
			// Look ahead applies to engines that hand back audio.
			!engine.capabilities.ownsPlayback
		);
	}

	/** Everything configurable about one engine. */
	private renderEnginePage(host: HTMLElement, id: string, label: string): void {
		host.empty();
		const engine = this.plugin.getEngines().find((e) => e.id === id);
		if (id === "kokoro" && this.plugin.getKokoro()) {
			this.renderKokoroAbout(host);
			this.renderKokoroModels(host);
			this.renderKokoroBackend(host);
			this.renderLookAheadSection(host);
			this.renderKokoroVoices(host);
			this.renderKokoroDownloads(host);
		}
		// Only where some voices may need the network.
		if (id === "webspeech" || id === "speechd") this.renderOfflinePreference(host);
		if (id === "readme" && this.plugin.getBridge()) this.renderBridgeSection(host);
		if (id === "piper" && this.plugin.getPiper()) this.renderPiperSection(host);
		// Kokoro draws its own Look ahead, above the voices.
		if (engine && id !== "kokoro" && !engine.capabilities.ownsPlayback) this.renderLookAheadSection(host);
		if (!this.engineHasSettings(id)) {
			host.createEl("p", {
				cls: "setting-item-description local-tts-subpage-empty",
				text: `${label} has no settings.`,
			});
		}
	}

	/**
	 * A collapsible group; returns the element to draw its rows into.
	 *
	 * Open state is remembered by title across redraws: changing a setting
	 * re-runs mount(), which rebuilds the element, and a fresh <details> starts
	 * closed.
	 */
	private collapsible(parent: HTMLElement, title: string, cls: string): HTMLElement {
		const detailsEl = parent.createEl("details", { cls: `local-tts-section ${cls}` });
		detailsEl.open = this.openSections.has(title);
		detailsEl.addEventListener("toggle", () => {
			if (detailsEl.open) this.openSections.add(title);
			else this.openSections.delete(title);
		});
		detailsEl.createEl("summary").createEl("strong", { text: title });
		return detailsEl.createDiv();
	}

	private renderEngineGroup(containerEl: HTMLElement): void {
		const contentEl = this.collapsible(containerEl, "Engine", "local-tts-advanced-section");

		// Each engine's own configuration lives on its page, opened from the
		// gear beside it in the table.
		this.renderEngineSection(contentEl);
	}

	private renderOfflinePreference(containerEl: HTMLElement): void {
		// Sits under the engine choice: it governs which voice is picked
		// automatically for whichever engine is in use. Affects automatic voice
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
	}

	private renderEngineSection(containerEl: HTMLElement): void {
		const engineSetting = new Setting(containerEl)
			.setName("Speech engine")
			.setDesc("Choose how notes are read aloud.");

		// One selectable entry per engine, plus Automatic: the name and status
		// on a first line, what the engine does with your text and what it
		// cannot do on a second. An engine that is not available is greyed but
		// still selectable, so its settings can be set up ahead of the engine
		// arriving; the reason is its tooltip. Probing shells out to binaries
		// and cannot finish before the first paint, so the entries are drawn at
		// once and the status fills in when the answers arrive.
		// Inside the "Speech engine" row, not after it, so the row's box holds it.
		const table = engineSetting.settingEl.createEl("table", { cls: "local-tts-engine-table" });
		table.setAttribute("role", "radiogroup");
		// aria-labelledby, not aria-label: Obsidian shows any aria-label as a
		// hover tooltip, and this one only needs to name the group for readers.
		engineSetting.nameEl.id = "local-tts-engine-label";
		table.setAttribute("aria-labelledby", "local-tts-engine-label");
		const head = table.createTHead().insertRow();
		for (const label of ["", "Engine", "Status", ""]) head.createEl("th", { text: label });

		const entries = new Map<string, HTMLTableSectionElement>();
		const select = async (value: string): Promise<void> => {
			if (value === this.plugin.settings.engine) return;
			// An engine that cannot run here cannot be chosen. Its page is still
			// open from the gear, so it can be set up ahead of time. Automatic is
			// not an engine, and is always choosable.
			if (value !== "auto" && entries.get(value)?.hasClass("is-unavailable")) return;
			await this.plugin.setEngine(value as never);
			// Choosing Piper is the user asking for it, so ask its server
			// now; nothing else on this page makes a request to it.
			if (value === "piper") await this.plugin.checkPiper();
			// Voice ids are engine-scoped, so the list must reload.
			this.display();
		};
		const addEntry = (id: string, label: string): void => {
			// A tbody per engine keeps its two rows together as one target for
			// hover, selection and the tooltip.
			const entry = table.createTBody();
			entry.addClass("local-tts-engine-option");
			entry.setAttribute("role", "radio");
			entry.tabIndex = 0;
			const selected = this.plugin.settings.engine === id;
			entry.setAttribute("aria-checked", String(selected));
			entry.toggleClass("is-selected", selected);

			const top = entry.insertRow();
			const markCell = top.insertCell();
			markCell.addClass("local-tts-engine-mark");
			markCell.rowSpan = 2;
			top.insertCell().setText(label);
			top.insertCell().setText("Checking...");
			const gearCell = top.insertCell();
			gearCell.addClass("local-tts-engine-gear-cell");
			// Spans both of the entry's rows so the button is as tall as the entry.
			gearCell.rowSpan = 2;
			if (id !== "auto" && this.engineHasSettings(id)) {
				const gear = gearCell.createEl("button", {
					cls: "clickable-icon local-tts-engine-gear",
					attr: { type: "button" },
				});
				setIcon(gear, "settings");
				// Named by the engine's own name cell, not an aria-label: Obsidian
				// shows any aria-label as a tooltip.
				const nameCell = top.cells[1]!;
				nameCell.id = `local-tts-engine-name-${id}`;
				gear.setAttribute("aria-labelledby", nameCell.id);
				gear.addEventListener("click", (event) => {
					event.stopPropagation();
					this.openEngine(id, label);
				});
				gear.addEventListener("keydown", (event) => event.stopPropagation());
			}

			const notes = entry.insertRow().insertCell();
			notes.addClass("local-tts-engine-notes");
			// Starts under the engine name: the mark and the gear span both rows.
			notes.colSpan = 2;
			notes.createDiv({ cls: "local-tts-engine-claim", text: this.engineClaim(id) });

			entry.addEventListener("click", () => void select(id));
			entry.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				void select(id);
			});
			entries.set(id, entry);
		};
		addEntry("auto", "Automatic");
		// Every known engine, in a fixed order. One this platform does not build
		// is greyed with the reason as its tooltip, and still selectable: the
		// choice is synced with the vault, and the engine may exist elsewhere.
		const built = new Map(this.plugin.getEngines().map((e) => [e.id, e]));
		for (const known of KNOWN_ENGINES) {
			const engine = built.get(known.id);
			addEntry(known.id, engine?.label ?? known.label);
			if (!engine) {
				const entry = entries.get(known.id)!;
				entry.addClass("is-unavailable");
				entry.setAttribute("title", known.absentReason);
				const state = entry.rows[0]!.cells[2]!;
				state.empty();
				state.createSpan({ cls: "local-tts-engine-state is-missing", text: "not on this device" });
			}
		}

		const chosen =
			this.plugin.settings.engine === "auto"
				? new Setting(containerEl).setName("Automatic picked").setDesc("Checking...")
				: null;

		// Re-run after a bridge check the user started (renderBridgeSection):
		// pasting a token or turning the bridge on changes which engine is
		// ready, and these rows would otherwise keep the answer from when the
		// tab opened. Only the latest round may write, as in the bridge section.
		let latestFill = 0;
		const fill = (): void => {
			const thisFill = ++latestFill;
			const current = (): boolean => containerEl.isConnected && thisFill === latestFill;
			if (chosen) chosen.setDesc("Checking...");
			void Promise.all([this.plugin.resolveAutomaticChoice(), this.plugin.getEngineStatuses()]).then(
				([resolved, statuses]) => {
					if (!current()) return;
					const engine = this.plugin.getEngines().find((e) => e.id === resolved.id);
					const label = engine?.label ?? KNOWN_ENGINES.find((k) => k.id === resolved.id)?.label ?? resolved.id;
					chosen?.setDesc(`${label} - ${resolved.reason}`);
					this.drawEngineStatuses(entries, statuses);
					// Which engine Automatic would use right now, but only when
					// one really is ready: with none, the resolution is just the
					// advice to set one up, not a choice.
					const cell = entries.get("auto")?.rows[0]?.cells[1];
					const anyReady = statuses.some((st) => st.available);
					cell?.setText(anyReady ? `Automatic (${label})` : "Automatic");
				},
			);
		};
		this.refreshEngineSection = fill;
		fill();
	}

	private drawEngineStatuses(
		entries: Map<string, HTMLTableSectionElement>,
		statuses: Awaited<ReturnType<LocalTtsReaderPlugin["getEngineStatuses"]>>,
	): void {
		const setState = (entry: HTMLTableSectionElement, ok: boolean, text: string, reason: string): void => {
			entry.toggleClass("is-unavailable", !ok);
			// The reason is the whole tooltip, so a greyed entry is never a mystery.
			if (ok) entry.removeAttribute("title");
			else entry.setAttribute("title", reason);
			const state = entry.rows[0]!.cells[2]!;
			state.empty();
			state.createSpan({ cls: `local-tts-engine-state ${ok ? "is-ok" : "is-missing"}`, text });
		};

		for (const status of statuses) {
			const entry = entries.get(status.engine.id);
			if (!entry) continue;
			setState(entry, status.available, status.available ? "ready" : status.reason || "unavailable", status.reason || "Not available.");
		}

		const auto = entries.get("auto");
		if (auto) {
			const anyReady = statuses.some((st) => st.available);
			setState(
				auto,
				anyReady,
				anyReady ? "ready" : "nothing ready",
				"No engine is ready yet, so Automatic has nothing to pick. Install or set one up and it will start working.",
			);
			// Automatic is not an engine and is never greyed out or blocked.
			auto.removeClass("is-unavailable");
		}
	}

	/**
	 * Read Me Offline's bridge (NRL-130): port, pairing token, and what the
	 * bridge says about itself right now.
	 *
	 * Only drawn where the engine exists (Android). The token field is a
	 * password input and is written to this device's local storage, never to
	 * data.json (main.ts `getBridgeToken`, docs/adr/0036).
	 */
	private renderBridgeSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Read Me Offline bridge").setHeading();

		const status = new Setting(containerEl).setName("Status").setDesc("Checking...");
		// A plain anchor: no fetch or preload until the user taps it (non-negotiable 6).
		const setup = new Setting(containerEl).setName("Set up Read Me Offline");
		setup.descEl.createEl("a", { href: READ_ME_FDROID_URL, text: "Get Read Me Offline" });
		const steps = setup.descEl.createEl("ol");
		for (const step of READ_ME_SETUP_STEPS) steps.createEl("li", { text: step });
		setup.settingEl.toggle(shouldShowBridgeSetup(null));
		// A re-check keeps the block as the last check left it, so a connected
		// bridge does not flash the setup steps in above the fields on every
		// blur. Only the latest check may write: an earlier, slower one resolving
		// last would otherwise show a stale result.
		let latestCheck = 0;
		const refresh = (): void => {
			// The first check runs alongside the Engine section's own; later
			// ones are the user's, and may have changed what is ready.
			if (latestCheck > 0) this.refreshEngineSection?.();
			const bridge = this.plugin.getBridge();
			if (!bridge) return;
			const thisCheck = ++latestCheck;
			status.setDesc("Checking...");
			void bridge.isAvailable().then((availability) => {
				if (!containerEl.isConnected || thisCheck !== latestCheck) return;
				setup.settingEl.toggle(shouldShowBridgeSetup(availability));
				const health = bridge.lastHealth();
				if (availability.available && health) {
					const voice = health.voice ? `, voice ${health.voice}` : "";
					status.setDesc(`Connected: ${health.engine || "speech engine"}${voice}.`);
				} else {
					status.setDesc(availability.available ? "Connected." : availability.reason);
				}
			});
		};
		status.addButton((button) => button.setButtonText("Check again").onClick(refresh));
		refresh();

		new Setting(containerEl)
			.setName("Pairing token")
			.setDesc(
				"Copy it from Read Me Offline's Settings and paste it here. Kept on this device only; " +
					"it is not saved with the vault.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text.setPlaceholder("Paste the token");
				text.setValue(this.plugin.getBridgeToken());
				text.onChange((value) => {
					this.plugin.setBridgeToken(value);
				});
				text.inputEl.addEventListener("blur", refresh);
			});

		new Setting(containerEl)
			.setName("Port")
			.setDesc("Must match the port shown in Read Me Offline's Settings. Default 8787.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(this.plugin.settings.bridgePort));
				text.onChange(async (value) => {
					const port = Number(value);
					if (!Number.isInteger(port) || port < 1 || port > 65535) return;
					this.plugin.settings.bridgePort = port;
					await this.plugin.saveSettings();
				});
				text.inputEl.addEventListener("blur", refresh);
			});
	}

	/**
	 * The optional Piper server (NRL-148, docs/adr/0040): its status, a button
	 * to check it, and its port.
	 *
	 * Unlike the bridge section above, drawing this makes no request. The
	 * status row shows the engine's cached answer, and only Check connection
	 * (or choosing Piper, or starting a read with it) asks the server.
	 */
	private renderPiperSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Piper server").setHeading();

		const describe = (): string => {
			const piper = this.plugin.getPiper();
			if (!piper) return "";
			const availability = piper.lastAvailability();
			return availability.available ? "Connected." : availability.reason;
		};
		const status = new Setting(containerEl).setName("Status").setDesc(describe());
		status.addButton((button) =>
			button.setButtonText("Check connection").onClick(async () => {
				status.setDesc("Checking...");
				await this.plugin.checkPiper();
				// Voices and the status both come from the check; redraw both.
				this.display();
			}),
		);

		new Setting(containerEl)
			.setName("Port")
			.setDesc(
				"The port your Piper server listens on, on this computer (127.0.0.1). Default 5011. " +
					"Changing it needs a new Check connection.",
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(this.plugin.settings.piperPort));
				text.onChange(async (value) => {
					const port = Number(value);
					if (!Number.isInteger(port) || port < 1 || port > 65535) return;
					this.plugin.settings.piperPort = port;
					await this.plugin.saveSettings();
					status.setDesc(describe());
				});
			});

		new Setting(containerEl)
			.setName("Setting up the server")
			.setDesc(
				"Piper is installed and started separately; this plugin never installs it or downloads voices. " +
					"See companion/piper/README.md in the plugin's repository.",
			);
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
	private engineClaim(id: string): string {
		switch (id) {
			case "kokoro":
			case "espeak":
				return "This engine runs entirely on this device; it never sends your notes anywhere.";
			case "speechd":
				return "This engine speaks through a local daemon, but it cannot report whether a given voice's synthesis needs the network (see the voice list below).";
			case "piper":
				return "This engine sends each sentence to the Piper server on this computer (127.0.0.1); nothing leaves the device.";
			case "readme":
				return "This engine hands the note to Read Me Offline on this device, over a connection nothing outside the device can reach, and Read Me reads it aloud with this device's own voices, also with the screen off. Read Me Offline only offers voices that need no network.";
			case "webspeech":
				return "This engine uses your operating system's installed voices. The system can report if a voice needs the network but it's not a guarantee.";
			default:
				return "Picks the first available engine from this list.";
		}
	}

	/** What Kokoro is, and what a model and a voice are, before the controls. */
	private renderKokoroAbout(host: HTMLElement): void {
		const about = createFragment();
		about.append(
			createDiv({
				cls: "local-tts-about-paragraph",
				text:
					"Kokoro is a text-to-speech engine that runs trained neural networks locally on your computer. " +
					"It uses the ONNX runtime, which is bundled with this plugin.",
			}),
			createDiv({
				cls: "local-tts-about-paragraph",
				text:
					"This engine needs model and voice files to function, which can be downloaded below. " +
					"A model is the trained neural network that turns text into speech, available in several sizes and precisions. " +
					"A voice is a small file of style data that sits on top of a model and gives the speech its particular sound.",
			}),
		);
		new Setting(host).setName("About").setDesc(about);
	}

	/**
	 * The Kokoro model, as a table of the builds you can use.
	 *
	 * First on the page because everything below follows from it: which
	 * backends can run the chosen build, and what is worth downloading. Each
	 * build has its own Download or Remove. Picking a row picks the build the
	 * engine prefers; what is actually on disk still decides what loads.
	 */
	private renderKokoroModels(host: HTMLElement): void {
		const modelDir = this.plugin.kokoroModelPath();
		const adapter = this.app.vault.adapter;
		const resolved = KOKORO_WEIGHTS[this.plugin.resolvedWeights()];
		// The model's name is its Hugging Face repository. The button only opens
		// that page in the browser; nothing is fetched from it.
		const pageUrl = `https://huggingface.co/${KOKORO_MODEL_METADATA.name}`;
		// One line each. Language and license stay because srs.md R-C02 requires
		// them to be shown before installation (size is in the table below).
		const about = createFragment();
		about.append(
			createDiv({ text: "Text-to-speech neural network models are downloaded from huggingface.co." }),
			createDiv({ text: `Model ID: ${KOKORO_MODEL_METADATA.name}` }),
			createDiv({ text: `Language: ${KOKORO_MODEL_METADATA.language} - License: ${KOKORO_MODEL_METADATA.license}` }),
		);
		const setting = new Setting(host)
			.setName("Model")
			.setDesc(about)
			.addButton((button) =>
				button.setButtonText("Visit Hugging Face model page").onClick(() => {
					window.open(pageUrl, "_blank", "noopener");
				}),
			);

		const table = setting.settingEl.createEl("table", { cls: "local-tts-engine-table local-tts-choice-table" });
		table.setAttribute("role", "radiogroup");
		const head = table.createTHead().insertRow();
		for (const label of ["", "Build", "Size", ""]) head.createEl("th", { text: label });
		const body = table.createTBody();

		// Builds known to be on disk. A build that is not downloaded cannot be
		// picked; Automatic always can.
		const installedBuilds = new Set<string>();
		const select = async (value: Settings["kokoroWeights"]): Promise<void> => {
			if (value === this.plugin.settings.kokoroWeights) return;
			if (value !== "auto" && !installedBuilds.has(value)) return;
			await this.plugin.setKokoroWeights(value);
			this.display();
		};
		const addRow = (
			value: Settings["kokoroWeights"],
			title: string,
			detail: string,
			size: string,
		): HTMLTableRowElement => {
			const row = body.insertRow();
			row.addClass("local-tts-choice-row");
			row.setAttribute("role", "radio");
			row.tabIndex = 0;
			const selected = this.plugin.settings.kokoroWeights === value;
			row.setAttribute("aria-checked", String(selected));
			row.toggleClass("is-selected", selected);
			row.insertCell().addClass("local-tts-engine-mark");
			const name = row.insertCell();
			name.createDiv({ text: title });
			name.createDiv({ cls: "local-tts-choice-detail", text: detail });
			row.insertCell().setText(size);
			row.insertCell().addClass("local-tts-choice-action");
			row.addEventListener("click", () => void select(value));
			row.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				void select(value);
			});
			return row;
		};

		addRow("auto", "Automatic", `Uses ${resolved.label}: the fast build on desktop, the small one on mobile.`, "");
		for (const key of WEIGHTS_KEYS) {
			const build = KOKORO_WEIGHTS[key];
			const row = addRow(key, build.label, build.description, `${build.sizeMb} MB`);
			const action = row.cells[3]!;
			row.addClass("is-missing");
			void getInstalledSizeMb(adapter, modelDir, key).then((installedMb) => {
				if (!row.isConnected) return;
				if (installedMb !== null) installedBuilds.add(key);
				row.toggleClass("is-missing", installedMb === null);
				const button = action.createEl("button", {
					cls: installedMb === null ? "mod-cta" : "mod-warning",
					text: installedMb === null ? "Download" : "Remove",
					attr: { type: "button" },
				});
				// A button inside a selectable row: it acts on its own and does not pick the row.
				button.addEventListener("keydown", (event) => event.stopPropagation());
				// Redrawn mid-download: pick the running download back up.
				const running = installedMb === null ? this.buildDownloads.get(`build:${key}`) : undefined;
				if (running) {
					running.button = button;
					this.paintDownloading(running);
				}
				button.addEventListener("click", (event) => {
					event.stopPropagation();
					if (installedMb === null) {
						// A click on a running download cancels it.
						const active = this.buildDownloads.get(`build:${key}`);
						if (active) active.controller.abort();
						else void this.downloadKokoroBuild(key, button);
						return;
					}
					new ConfirmModal(
						this.app,
						`Remove ${build.label}?`,
						`This deletes the downloaded ${build.label} weights (${build.path}) from your vault. This cannot be undone; you can download it again later.`,
						"Remove",
						() => {
							button.disabled = true;
							void this.deleteKokoroBuild(key);
						},
					).open();
				});
			});
		}
		this.renderKokoroMemory(setting.settingEl);
	}

	/**
	 * Whether the model is in memory, and a way to let go of it. Sits at the
	 * bottom of the Model box.
	 *
	 * Unloading shuts the engine down and frees what the model uses. It is not
	 * reloaded until something needs it: the next read with Kokoro loads it
	 * again, a little slower than usual.
	 */
	private renderKokoroMemory(box: HTMLElement): void {
		const row = box.createDiv({ cls: "local-tts-model-memory" });
		const text = row.createDiv({ cls: "setting-item-description" });
		const button = row.createEl("button", { text: "Unload model", attr: { type: "button" } });
		button.addEventListener("click", () => {
			button.disabled = true;
			void this.plugin.unloadKokoro().then(() => this.display());
		});
		// Read now and whenever a read starts or ends: the model is usually loaded
		// by a read that began after this page was drawn.
		let off: () => void = () => undefined;
		const paint = (): void => {
			if (!row.isConnected) {
				// The page was left: stop listening (this row's own listeners only).
				off();
				return;
			}
			const kokoro = this.plugin.getKokoro();
			const runtime = kokoro?.runtimeInfo() ?? null;
			const loaded = runtime !== null || (kokoro?.isPrepared() ?? false);
			const dtype = kokoro?.loadedWeights() ?? null;
			const build = WEIGHTS_KEYS.map((k) => KOKORO_WEIGHTS[k]).find((w) => w.dtype === dtype);
			text.setText(
				loaded
					? `Loaded${build ? `: ${build.label}` : ""}${runtime ? `, running on ${runtime}` : ""}. Unloading shuts the engine down and frees its memory; it loads again the next time you read with Kokoro.`
					: "Not loaded. It loads the next time you read with Kokoro.",
			);
			button.disabled = !loaded;
		};
		paint();
		this.offMemory?.();
		const offState = this.plugin.getPlayer().on("state", paint);
		const offInfo = this.plugin.onReadInfoChange(paint);
		off = () => {
			offState();
			offInfo();
		};
		this.offMemory = off;
	}

	/**
	 * Where the chosen model can run, and nothing it cannot.
	 *
	 * Only the fp32 build is loaded on the GPU (the integer builds fall back to
	 * the CPU, see `weightsOrder`), so for the other two the CPU is the only
	 * backend and is all that is listed. The CPU thread count belongs to the CPU
	 * backend, so it is only here while the CPU can be in use.
	 */
	private renderKokoroBackend(host: HTMLElement): void {
		const key = this.plugin.resolvedWeights();
		// Automatic prefers whichever installed build runs best, so it keeps the
		// GPU open; an explicit build opens it only if the GPU can load that build.
		const gpuCapable = this.plugin.settings.kokoroWeights === "auto" || GPU_CAPABLE_WEIGHTS.includes(key);
		const device = this.plugin.settings.kokoroDevice;

		const actual = this.plugin.getKokoro()?.runtimeInfo();
		const setting = new Setting(host)
			.setName("Backend")
			.setDesc(
				(actual
					? `Currently running on ${actual}. `
					: "Not loaded yet. Open a note and start reading, or wait for the background load. ") +
					"Changing this reloads the model.",
			);

		const options: Array<{ value: Settings["kokoroDevice"]; label: string; detail: string }> = gpuCapable
			? [
					{ value: "auto", label: "Automatic", detail: "The GPU when this device really has one, the CPU otherwise." },
					{ value: "webgpu", label: "GPU (WebGPU)", detail: "Checking..." },
					{ value: "wasm", label: "CPU (WASM)", detail: "Runs anywhere, and is much slower with this build." },
				]
			: [{ value: "wasm", label: "CPU (WASM)", detail: `The only backend for ${KOKORO_WEIGHTS[key].label}.` }];

		const table = setting.settingEl.createEl("table", { cls: "local-tts-engine-table local-tts-choice-table" });
		table.setAttribute("role", "radiogroup");
		const body = table.createTBody();
		let gpuDetail: HTMLElement | null = null;
		for (const option of options) {
			const row = body.insertRow();
			row.addClass("local-tts-choice-row");
			row.setAttribute("role", "radio");
			row.tabIndex = 0;
			const selected = gpuCapable ? device === option.value : true;
			row.setAttribute("aria-checked", String(selected));
			row.toggleClass("is-selected", selected);
			row.insertCell().addClass("local-tts-engine-mark");
			const name = row.insertCell();
			name.createDiv({ text: option.label });
			const detail = name.createDiv({ cls: "local-tts-choice-detail", text: option.detail });
			if (option.value === "webgpu") gpuDetail = detail;
			const choose = async (): Promise<void> => {
				if (options.length === 1 || device === option.value) return;
				await this.plugin.setKokoroRuntime(option.value, this.plugin.settings.kokoroThreads);
				this.display();
			};
			row.addEventListener("click", () => void choose());
			row.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				void choose();
			});
		}

		// A GPU that is present but unreachable is the most confusing state here,
		// because nothing about it is visible from the app. Say what was found
		// and, when it is missing, what would fix it.
		if (gpuDetail) {
			const detail = gpuDetail;
			void probeGpu().then((report) => {
				detail.setText(report.usable ? `Available: ${report.detail}.` : `Not available. ${report.detail}`);
			});
		}

		// Threads are a CPU setting: shown unless the GPU is the chosen backend.
		if (!gpuCapable || device !== "webgpu") {
			const threads = new Setting(host)
				.setName("CPU threads")
				.setDesc(
					"Upper limit. Synthesis is the slow part of reading a note, and more threads is " +
						"the main way to make it keep up with playback.",
				)
				.addSlider((slider) =>
					slider
						.setLimits(1, Math.max(2, navigator.hardwareConcurrency || 4), 1)
						.setDynamicTooltip()
						.setValue(this.plugin.settings.kokoroThreads)
						.onChange(async (value) => {
							await this.plugin.setKokoroRuntime(this.plugin.settings.kokoroDevice, value);
						}),
				);
			threads.settingEl.addClass("local-tts-wide-slider");
		}
	}

	/**
	 * Download one build, with the voice it needs. Only ever starts from a click
	 * (non-negotiable 6).
	 */
	private async downloadKokoroBuild(key: WeightsKey, button: HTMLButtonElement): Promise<void> {
		const build = KOKORO_WEIGHTS[key];
		const entry: BuildDownload = { controller: new AbortController(), fraction: null, button, ring: null };
		this.buildDownloads.set(`build:${key}`, entry);
		this.paintDownloading(entry);
		const notice = new Notice(`Downloading ${build.label}...`, 0);
		try {
			// A stored voice from another engine (or none) is resolved to a
			// Kokoro voice here, at the click, never on engine switch
			// (NRL-144, rule 6).
			const choice = await this.plugin.resolveKokoroDownloadVoice();
			const result = await downloadModel(
				this.app,
				this.plugin.kokoroModelPath(),
				build.path,
				choice.file,
				({ file, loaded, total }) => {
					const pct = total > 0 ? ` (${Math.round((loaded / total) * 100)}%)` : "";
					notice.setMessage(`Downloading ${file}${pct}`);
					// The ring follows the weights, which are nearly all of the download.
					if (file === build.path) {
						entry.fraction = total > 0 ? loaded / total : null;
						this.paintDownloading(entry);
					}
				},
				entry.controller.signal,
			);
			const described = describeModelDownload(result, choice.notice);
			notice.setMessage(described.message);
			// Only once the voice file is on disk, so the stored id never names
			// a voice that is not there.
			if (result.ok && choice.persist) await this.plugin.setVoice(choice.voiceId);
			if (result.ok) window.setTimeout(() => notice.hide(), choice.notice ? 8000 : 3000);
			if (result.cancelled) window.setTimeout(() => notice.hide(), 3000);
			if (described.modelInstalled) {
				// The engine may be holding an older build open.
				await this.plugin.reloadKokoro();
				this.display();
			}
		} catch (err) {
			notice.setMessage(`Download failed: ${errText(err)}`);
		} finally {
			this.buildDownloads.delete(`build:${key}`);
			this.restoreDownloadButton(entry);
		}
	}

	/** Put a download button back to "Download" once its download has ended. */
	private restoreDownloadButton(entry: BuildDownload): void {
		const live = entry.button;
		if (!live?.isConnected) return;
		live.empty();
		live.removeClass("local-tts-dl-active");
		live.addClass("mod-cta");
		live.setText("Download");
	}

	/** Show a running download on its button: a progress ring, "Cancel", and no accent color. */
	private paintDownloading(entry: BuildDownload): void {
		const button = entry.button;
		if (!button?.isConnected) return;
		if (!entry.ring || !button.contains(entry.ring)) {
			button.empty();
			button.removeClass("mod-cta");
			button.addClass("local-tts-dl-active");
			const svg = button.createSvg("svg", { cls: "local-tts-dl-ring", attr: { viewBox: "0 0 20 20" } });
			svg.createSvg("circle", { cls: "local-tts-dl-track", attr: { cx: "10", cy: "10", r: String(RING_RADIUS) } });
			svg.createSvg("circle", {
				cls: "local-tts-dl-arc",
				attr: { cx: "10", cy: "10", r: String(RING_RADIUS), transform: "rotate(-90 10 10)" },
			});
			button.createSpan({ text: "Cancel" });
			entry.ring = svg;
		}
		const ring = entry.ring;
		const arc = ring.querySelector(".local-tts-dl-arc");
		if (!arc) return;
		const known = entry.fraction !== null;
		ring.toggleClass("is-indeterminate", !known);
		const length = 2 * Math.PI * RING_RADIUS;
		const shown = known ? Math.min(1, Math.max(0, entry.fraction ?? 0)) * length : length * 0.25;
		arc.setAttribute("stroke-dasharray", `${shown} ${length}`);
	}

	/** Delete one weights build and tidy up after it. */
	private async deleteKokoroBuild(key: WeightsKey): Promise<void> {
		const build = KOKORO_WEIGHTS[key];
		const result = await removeModelBuild(this.app.vault.adapter, this.plugin.kokoroModelPath(), key);
		new Notice(
			result.ok
				? `Removed ${build.label} (${(result.freedBytes / 1_000_000).toFixed(1)} MB freed).`
				: `Could not remove ${build.label}${result.error ? `: ${result.error}` : "."}`,
		);
		// The build in use is gone: fall back to Automatic rather than leaving it selected.
		if (result.ok && this.plugin.settings.kokoroWeights === key) await this.plugin.setKokoroWeights("auto");
		await this.afterKokoroRemoval();
	}

	/**
	 * Every Kokoro voice, with its download state and what is known about it.
	 *
	 * The list is the plugin's own table (the voices kokoro-js can speak), so it
	 * is complete whether or not anything is downloaded. Clicking a row selects
	 * that voice, fetching it first if it is not on disk (a click, so the
	 * download rule holds). Download and Remove act on the file alone. The
	 * quality grade is the Kokoro project's own rating, not a measurement made
	 * here.
	 */
	private renderKokoroVoices(host: HTMLElement): void {
		const modelDir = this.plugin.kokoroModelPath();
		const adapter = this.app.vault.adapter;
		const setting = new Setting(host)
			.setName("Voices")
			.setDesc(
				`Pick the voice Kokoro reads with. Each voice is a small file (approximately ${(VOICE_FILE_SIZE_BYTES / 1_000_000).toFixed(2)} MB). ` +
					"Each voice was given a rating by the Kokoro project from A (best) to F. Click a column heading to sort.",
			);
		const table = setting.settingEl.createEl("table", { cls: "local-tts-engine-table local-tts-choice-table local-tts-voice-table" });
		table.setAttribute("role", "radiogroup");
		const head = table.createTHead().insertRow();
		const body = table.createTBody();

		// Best first: the letter, then + before nothing before -.
		const rank = (grade: string): number => {
			const letter = grade.charCodeAt(0) - 65;
			return letter + (grade.endsWith("+") ? -0.3 : grade.endsWith("-") ? 0.3 : 0);
		};
		const byDefault = (x: KokoroVoiceRow, y: KokoroVoiceRow): number =>
			x.lang.localeCompare(y.lang) || rank(x.grade) - rank(y.grade) || x.name.localeCompare(y.name);

		/** The columns that sort, and how: each returns <0, 0 or >0 for ascending order. */
		const columns: Array<{ key: VoiceSortKey; label: string; title?: string }> = [
			{ key: "name", label: "Voice" },
			{ key: "lang", label: "Language" },
			{ key: "gender", label: "Gender" },
			{ key: "grade", label: "Quality", title: "Overall quality grade from the Kokoro project, A (best) to F." },
		];
		const compare = (key: VoiceSortKey): ((x: KokoroVoiceRow, y: KokoroVoiceRow) => number) => {
			switch (key) {
				case "name":
					return (x, y) => x.name.localeCompare(y.name);
				case "lang":
					return byDefault;
				case "gender":
					return (x, y) => x.gender.localeCompare(y.gender) || byDefault(x, y);
				case "grade":
					return (x, y) => rank(x.grade) - rank(y.grade) || byDefault(x, y);
			}
		};

		let installed: Set<string> | null = null;
		const headerCells = new Map<VoiceSortKey, HTMLTableCellElement>();
		head.createEl("th");
		for (const column of columns) {
			const th = head.createEl("th", { cls: "local-tts-sortable" });
			th.tabIndex = 0;
			th.setAttribute("role", "columnheader");
			if (column.title) th.setAttribute("title", column.title);
			headerCells.set(column.key, th);
			const sortBy = (): void => {
				const same = this.voiceSort.key === column.key;
				this.voiceSort = { key: column.key, dir: same ? (this.voiceSort.dir === 1 ? -1 : 1) : 1 };
				draw();
			};
			th.addEventListener("click", sortBy);
			th.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				sortBy();
			});
		}
		head.createEl("th");

		const idOf = (file: string): string => `kokoro:${file}`;

		const draw = (): void => {
			// The sorted column shows an arrow; the others show none.
			for (const column of columns) {
				const th = headerCells.get(column.key)!;
				const active = this.voiceSort.key === column.key;
				th.setText(`${column.label}${active ? (this.voiceSort.dir === 1 ? " \u25b2" : " \u25bc") : ""}`);
				th.setAttribute("aria-sort", active ? (this.voiceSort.dir === 1 ? "ascending" : "descending") : "none");
			}

			body.empty();
			const order = compare(this.voiceSort.key);
			const voices = [...KOKORO_VOICES].sort((x, y) => this.voiceSort.dir * order(x, y));
			for (const voice of voices) {
				const row = body.insertRow();
				row.addClass("local-tts-choice-row");
				row.setAttribute("role", "radio");
				row.tabIndex = 0;
				const selected = this.plugin.settings.voiceId === idOf(voice.file);
				row.setAttribute("aria-checked", String(selected));
				row.toggleClass("is-selected", selected);
				row.insertCell().addClass("local-tts-engine-mark");
				row.insertCell().setText(voice.name);
				row.insertCell().setText(voice.lang);
				row.insertCell().setText(voice.gender === "female" ? "Female" : voice.gender === "male" ? "Male" : "Neutral");
				const quality = row.insertCell();
				quality.setText(voice.grade);
				quality.addClass("local-tts-voice-grade");
				const present = installed?.has(`${voice.file}.bin`) ?? null;
				const action = row.insertCell();
				action.addClass("local-tts-choice-action");
				row.toggleClass("is-missing", present === false);

				// Picking never downloads: a voice that is not on disk is chosen
				// only after its Download button has been used.
				const choose = async (): Promise<void> => {
					const id = idOf(voice.file);
					if (present !== true || this.plugin.settings.voiceId === id) return;
					await this.plugin.setVoice(id);
					this.display();
				};
				row.addEventListener("click", () => void choose());
				row.addEventListener("keydown", (event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					void choose();
				});

				if (present === null) continue;
				const button = action.createEl("button", {
					cls: present ? "mod-warning" : "mod-cta",
					text: present ? "Remove" : "Download",
					attr: { type: "button" },
				});
				button.addEventListener("keydown", (event) => event.stopPropagation());
				// Redrawn mid-download (a sort, say): show the running one again.
				const running = present ? undefined : this.buildDownloads.get(`voice:${voice.file}`);
				if (running) {
					running.button = button;
					this.paintDownloading(running);
				}
				button.addEventListener("click", (event) => {
					event.stopPropagation();
					if (!present) {
						// A click on a running download cancels it.
						const active = this.buildDownloads.get(`voice:${voice.file}`);
						if (active) {
							active.controller.abort();
							return;
						}
						const entry: BuildDownload = { controller: new AbortController(), fraction: null, button, ring: null };
						this.buildDownloads.set(`voice:${voice.file}`, entry);
						this.paintDownloading(entry);
						void this.ensureVoiceDownloaded(idOf(voice.file), entry).then(() => {
							this.buildDownloads.delete(`voice:${voice.file}`);
							this.restoreDownloadButton(entry);
							this.display();
						});
						return;
					}
					new ConfirmModal(
						this.app,
						`Remove ${voice.name}?`,
						this.plugin.settings.voiceId === idOf(voice.file)
							? `This is the voice you have selected. Removing it deletes ${voice.file}.bin from your vault and leaves no voice selected. You can download it again later.`
							: `This deletes ${voice.file}.bin from your vault. You can download it again later.`,
						"Remove",
						() => {
							button.disabled = true;
							void removeVoice(adapter, modelDir, `${voice.file}.bin`).then(async (result) => {
								new Notice(
									result.ok
										? `Removed voice ${voice.file}.`
										: `Could not remove ${voice.file}${result.error ? `: ${result.error}` : "."}`,
								);
								if (result.ok) await this.clearKokoroVoiceIfSelected(voice.file);
								await this.afterKokoroRemoval();
							});
						},
					).open();
				});
			}
		};

		// Drawn at once, then again when the files on disk are known: the buttons
		// depend on that.
		draw();
		void listInstalledVoices(adapter, modelDir).then((files) => {
			if (!table.isConnected) return;
			installed = new Set(files.map((v) => v.file));
			draw();
		});
	}

	/**
	 * Everything Kokoro has downloaded, one table row each, with its own Delete.
	 *
	 * Drawn inside the download row's own box. Listed from what is on disk, not
	 * from what the settings say should be there: a model build and each voice
	 * file are separate downloads, and any of them can be removed on its own.
	 * Deleting the voice that is selected is allowed; it is fetched again the
	 * next time it is picked.
	 */
	private renderKokoroDownloads(host: HTMLElement): void {
		const row = new Setting(host)
			.setName("Downloads")
			.setDesc("All downloaded files are listed here for easy cleanup.");
		const table = row.settingEl.createEl("table", { cls: "local-tts-engine-table local-tts-download-table" });
		const head = table.createTHead().insertRow();
		for (const label of ["File", "Size", ""]) head.createEl("th", { text: label });
		const body = table.createTBody();
		const modelDir = this.plugin.kokoroModelPath();
		const adapter = this.app.vault.adapter;

		// The total sits in the table's footer, so the row says both what is
		// downloaded and how much space all of it takes.
		const foot = table.createTFoot().insertRow();
		foot.insertCell().setText("Total on disk");
		const totalCell = foot.insertCell();
		totalCell.setText("Computing...");
		foot.insertCell();
		foot.addClass("local-tts-download-total");
		foot.cells[0]!.setAttribute(
			"title",
			`Every downloaded build and voice, and the ONNX runtime, in ${modelDir}.`,
		);
		void getTotalUsage(
			adapter,
			modelDir,
			// The full list, not an empty array. The runtime is bundled now
			// (ADR 0028), so on a fresh install every one of these stats is 0 -
			// but an install upgrading from the on-demand layout still has that
			// ort/ directory on disk, and passing [] would quietly drop 31 MB
			// from the figure this row is promising to be honest about.
			[...RUNTIME_FILES],
		).then((usage) => {
			if (!host.isConnected) return;
			totalCell.setText(`${Math.round(usage.totalBytes / 1_000_000)} MB`);
		});

		const addRow = (
			title: string,
			size: string,
			onDelete: () => Promise<void>,
			confirm: { title: string; message: string },
		): void => {
			const row = body.insertRow();
			row.insertCell().setText(title);
			row.insertCell().setText(size);
			const action = row.insertCell();
			action.addClass("local-tts-download-action");
			const button = action.createEl("button", { cls: "mod-warning", text: "Remove", attr: { type: "button" } });
			button.addEventListener("click", () => {
				new ConfirmModal(this.app, confirm.title, confirm.message, "Remove", () => {
					button.disabled = true;
					void onDelete();
				}).open();
			});
		};

		const draw = async (): Promise<void> => {
			body.empty();

			for (const key of WEIGHTS_KEYS) {
				const build = KOKORO_WEIGHTS[key];
				const mb = await getInstalledSizeMb(adapter, modelDir, key);
				if (mb === null) continue;
				addRow(
					`Model: ${build.label}`,
					`${mb.toFixed(1)} MB`,
					() => this.deleteKokoroBuild(key),
					{
						title: `Remove ${build.label}?`,
						message: `This deletes the downloaded ${build.label} weights (${build.path}) from your vault. You can download it again later.`,
					},
				);
			}

			for (const voice of await listInstalledVoices(adapter, modelDir)) {
				const known = describeKokoroVoiceFile(voice.file);
				const selected = this.plugin.voiceFileFor(this.plugin.settings.voiceId) === `voices/${voice.file}`;
				addRow(
					`Voice: ${known ? `${known.name} (${known.lang})` : voice.file}${selected ? " - selected" : ""}`,
					`${(voice.bytes / 1_000_000).toFixed(2)} MB`,
					async () => {
						const result = await removeVoice(adapter, modelDir, voice.file);
						new Notice(
							result.ok
								? `Removed voice ${voice.file}.`
								: `Could not remove ${voice.file}${result.error ? `: ${result.error}` : "."}`,
						);
						if (result.ok) await this.clearKokoroVoiceIfSelected(voice.file.replace(/\.bin$/, ""));
						await this.afterKokoroRemoval();
					},
					{
						title: `Remove ${known?.name ?? voice.file}?`,
						message: selected
							? `This is the voice you have selected. Deleting it removes ${voice.file} from your vault and leaves no voice selected. You can download it again from the voices list.`
							: `This deletes ${voice.file} from your vault. You can download it again from the voices list.`,
					},
				);
			}

			if (body.rows.length === 0) {
				const empty = body.insertRow().insertCell();
				empty.colSpan = 3;
				empty.setText("Nothing has been downloaded yet.");
			}
		};
		void draw();
	}

	/** A removed voice cannot stay selected: clear the choice if it was the one in use. */
	private async clearKokoroVoiceIfSelected(file: string): Promise<void> {
		if (this.plugin.settings.voiceId === `kokoro:${file}`) await this.plugin.clearVoice("kokoro");
	}

	/** After a file is removed: drop the engine's copy, switch off Kokoro if it can no longer run, redraw. */
	private async afterKokoroRemoval(): Promise<void> {
		const kokoro = this.plugin.getKokoro();
		const available = kokoro ? (await kokoro.isAvailable()).available : false;
		if (shouldClearPinnedKokoro(this.plugin.settings.engine, available)) {
			await this.plugin.setEngine("auto");
			new Notice("Kokoro is no longer installed; switched back to automatic engine selection.");
		}
		await this.plugin.reloadKokoro();
		this.display();
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
	/**
	 * The read in progress: how many passages, which engine and on what. Kept
	 * live from the player's state and the plugin's own read info, so it needs
	 * no pop-up when reading starts.
	 */
	private renderStatusBubble(parent: HTMLElement): void {
		const setting = new Setting(parent).setName("Status");
		setting.settingEl.addClass("local-tts-status-bubble");

		const update = (): void => {
			const player = this.plugin.getPlayer();
			const state = player.getState();
			const info = this.plugin.getReadInfo();
			const inFlight = state === "preparing" || state === "playing" || state === "paused";
			const lines: string[] = [];
			// Only engines with a model to load say anything about it.
			const prepared = this.plugin.activeEngine()?.isPrepared?.();
			const model = prepared === undefined ? "" : prepared ? " - model loaded" : " - model not loaded";
			if (info && inFlight) {
				lines.push(`Engine: ${info.engine}${info.runtime ? ` on ${info.runtime}` : ""}${model}`);
			} else {
				const engine = this.plugin.activeEngine();
				if (engine) {
					const runtime = engine.runtimeInfo?.();
					lines.push(`Engine: ${engine.label}${runtime ? ` on ${runtime}` : ""}${model}`);
				}
			}
			const fragment = createFragment();
			fragment.append(...lines.map((text) => createDiv({ text })));
			setting.setDesc(fragment);
		};
		update();
		const offState = this.plugin.getPlayer().on("state", update);
		const offInfo = this.plugin.onReadInfoChange(update);
		this.offStatus?.();
		this.offStatus = () => {
			offState();
			offInfo();
		};
	}

	/** Voice, speed and pitch together, in one collapsible group. */
	private renderVoiceGroup(parent: HTMLElement): void {
		const containerEl = this.collapsible(parent, "Voice", "local-tts-section");
		this.renderVoiceRows(containerEl);
		this.renderSpeedRows(containerEl);
		this.renderPitchRows(containerEl);
	}

	private renderVoiceRows(containerEl: HTMLElement): void {
		// The resolved engine: with "Automatic" selected this must be the
		// engine automatic selection actually picked, or this section would
		// vanish entirely (settings.engine is the literal string "auto",
		// which matches no engine.id).
		const engine = this.plugin.activeEngine();
		if (!engine) return;

		// Piper's voices come from its server, and listing them makes no
		// request, so before a check the list is empty for a reason worth saying.
		const piper = this.plugin.getPiper();
		const piperHint =
			piper && engine === piper && !piper.lastAvailability().available
				? " Voices appear after Check connection (Piper settings, from the gear in Engine) or the first read."
				: "";
		const description = createFragment();
		description.append(createDiv({ text: `Current engine: ${engine.label}` }));
		// Only engines that fetch voice files have anything to download.
		if (engine.id === "kokoro") {
			description.append(createDiv({ text: "Download voices from the engine's settings" }));
		}
		if (piperHint) description.append(createDiv({ text: piperHint.trim() }));
		const setting = new Setting(containerEl).setName("Voice").setDesc(description);

		setting.addDropdown(async (dropdown) => {
			dropdown.addOption("", "Loading voices...");
			try {
				// Kokoro: only voices that are downloaded.
				const voices = await this.plugin.usableVoices(engine);
				dropdown.selectEl.empty();
				if (voices.length === 0) {
					dropdown.addOption("", engine.id === "kokoro" ? "No voices downloaded" : "No voices found");
				}
				else {
					// Group voices by language tag, sort within each group. Each
					// group is an <optgroup>: its label is a heading the browser
					// will not let you pick, where an ordinary option standing in
					// for a header could be chosen and stored as a voice id.
					const grouped = groupVoicesByLanguage(voices);
					for (const [lang, voicesInLang] of grouped) {
						const group = dropdown.selectEl.createEl("optgroup", { attr: { label: lang } });
						for (const voice of voicesInLang) {
							// Kokoro's voices carry a rating and a gender, which are what
							// tell them apart; the others are named as before.
							const kokoro = engine.id === "kokoro" ? describeKokoroVoiceFile(voice.id.replace(/^kokoro:/, "")) : null;
							const detail = kokoro
								? ` - ${kokoro.gender === "female" ? "Female" : kokoro.gender === "male" ? "Male" : "Neutral"}, quality ${kokoro.grade}`
								: "";
							group.createEl("option", {
								value: voice.id,
								text: `${voice.name}${detail}${voice.isVariant ? " (variant)" : ""}${voiceNetworkMarker(voice)}`,
							});
						}
					}
				}
				// An id saved by an older build may name the same voice in an
				// old format. Show that voice selected; it is persisted in the
				// new form the next time reading starts.
				const stored = this.plugin.settings.voiceId;
				const known = voices.some((v) => v.id === stored);
				const remapped = known ? undefined : engine.resolveVoiceId?.(stored, voices);
				// An engine never used has no voice of its own yet and the stored
				// id belongs to another. Show the voice a read would use rather
				// than an empty box; it is saved when reading starts or you pick.
				// Kokoro with nothing valid chosen (never picked, or its voice was
				// removed) shows an empty choice rather than a voice nobody picked.
				if (engine.id === "kokoro" && !known && !remapped) {
					dropdown.selectEl.insertBefore(
						createEl("option", { value: "", text: "No voice selected" }),
						dropdown.selectEl.firstChild,
					);
					dropdown.setValue("");
				} else {
					const fallback = known || remapped ? null : this.plugin.previewVoice(engine, voices);
					dropdown.setValue(remapped?.id ?? fallback?.id ?? stored);
				}
			} catch (err) {
				dropdown.selectEl.empty();
				dropdown.addOption("", "Could not list voices");
				new Notice(`Could not list voices: ${errText(err)}`);
			}

			dropdown.onChange(async (value) => {
				if (value === "") return;
				await this.plugin.setVoice(value);
			});
		});

		// A way into the active engine's own page, from where the voice is chosen.
		if (this.engineHasSettings(engine.id)) {
			setting.addButton((button) =>
				button
					.setIcon("settings")
					.setButtonText("Current Engine Settings")
					.onClick(() => this.openEngine(engine.id, engine.label)),
			);
		}
	}

	/** Fetch a Kokoro voice if it is missing. Returns false if that failed. */
	private async ensureVoiceDownloaded(voiceId: string, entry?: BuildDownload): Promise<boolean> {
		const store = this.plugin.getModelStore();
		const path = this.plugin.voiceFileFor(voiceId);
		if (path === null) return false;
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
				this.plugin.kokoroModelPath(),
				file,
				({ loaded, total }) => {
					if (!entry) return;
					entry.fraction = total > 0 ? loaded / total : null;
					this.paintDownloading(entry);
				},
				entry?.controller.signal,
			);
			if (result.cancelled) {
				notice.setMessage("Download cancelled.");
				window.setTimeout(() => notice.hide(), 3000);
				return false;
			}
			if (!result.ok) {
				notice.setMessage(`Voice download failed: ${result.error}`);
				window.setTimeout(() => notice.hide(), 6000);
				return false;
			}
			notice.hide();
			return true;
		} catch (err) {
			notice.setMessage(`Voice download failed: ${errText(err)}`);
			window.setTimeout(() => notice.hide(), 6000);
			return false;
		}
	}

	private renderSpeedRows(containerEl: HTMLElement): void {
		const speed = new Setting(containerEl)
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
		speed.settingEl.addClass("local-tts-wide-slider");
	}

	private renderPitchRows(containerEl: HTMLElement): void {
		// Add pitch slider if the engine supports it
		const engine = this.plugin.activeEngine();
		if (!engine?.capabilities.pitch) return;

		const pitch = new Setting(containerEl)
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
		pitch.settingEl.addClass("local-tts-wide-slider");
	}

	private renderLookAheadSection(containerEl: HTMLElement): void {
		const lookAhead = new Setting(containerEl)
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
		lookAhead.settingEl.addClass("local-tts-wide-slider");
	}

	private renderSleepTimerSection(parent: HTMLElement): void {
		const containerEl = this.collapsible(parent, "Sleep timer", "local-tts-section");

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
		// Obsidian's toggle(): display none, or back to the stylesheet's block.
		timerDisplayEl.toggle(false);
		const timerLabel = timerDisplayEl.createSpan();

		// Update timer display on timer event
		const updateTimerDisplay = (remaining: number) => {
			if (remaining <= 0) {
				timerDisplayEl.toggle(false);
			} else {
				timerDisplayEl.toggle(true);
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
				timerDisplayEl.toggle(false);
			}
		});
	}

	private renderHighlightSection(parent: HTMLElement): void {
		const containerEl = this.collapsible(parent, "Highlighting", "local-tts-section");

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
		// Greys the three rows below while the master switch is off, in place.
		let applyMaster: (enabled: boolean) => void = () => undefined;
		new Setting(containerEl)
			.setName("Highlight while reading")
			.setDesc("Master switch. Turn off to read with no marks at all.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.highlight.enabled).onChange(async (value) => {
					this.plugin.settings.highlight.enabled = value;
					applyMaster(value);
					await this.plugin.saveSettings();
				});
			});

		const sentenceSetting = new Setting(containerEl)
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
			.setName("Highlight color")
			.setDesc("A hex color. Leave empty to use the theme's highlight color.");
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
							"Not a hex color (#rgb, #rgba, #rrggbb or #rrggbbaa). The previous color is still in use.",
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
			// The swatch cannot be empty: with no color set it shows the theme's.
			const initial = toPickerHex(this.plugin.settings.highlight.color) ?? themeHighlightHex(containerEl);
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
				.setTooltip("Use the theme's highlight color")
				.onClick(async () => {
					await this.plugin.setHighlightColour("");
					errorEl.hide();
					if (textInput) textInput.value = "";
					// Move the swatch back to the theme's color too.
					const themed = themeHighlightHex(containerEl);
					if (themed && picker) {
						syncingPicker = true;
						picker.setValue(themed);
						syncingPicker = false;
					}
				}),
		);

		applyMaster = (enabled: boolean): void => {
			sentenceSetting.setDisabled(!enabled);
			// The word row also stays off where the engine cannot report words.
			wordSetting.setDisabled(!enabled || !wordToggleAffordance.enabled);
			colourSetting.setDisabled(!enabled);
		};
		applyMaster(this.plugin.settings.highlight.enabled);
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
	private renderContentSection(parent: HTMLElement): void {
		const containerEl = this.collapsible(parent, "Content", "local-tts-content-section");

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
			["skipFrontmatter", "Skip frontmatter", "Skip the note's YAML properties block."],
			["skipCodeBlocks", "Skip code blocks", "Skip fenced and indented code blocks."],
			["skipInlineCode", "Skip inline code", "Skip `inline code` spans."],
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
			["skipTags", "Skip tags", "Skip #tags."],
			["skipTables", "Skip tables", "Skip table rows."],
			["skipHeadings", "Skip headings", "Skip headings instead of reading them."],
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

/** The theme's highlight color as #rrggbb, for showing in the color swatch. */
function themeHighlightHex(near: HTMLElement): string | null {
	const probe = near.createDiv();
	probe.setCssStyles({ backgroundColor: "var(--text-highlight-bg)", display: "none" });
	const rgb = window.getComputedStyle(probe).backgroundColor;
	probe.remove();
	const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
	if (!m) return null;
	return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}
