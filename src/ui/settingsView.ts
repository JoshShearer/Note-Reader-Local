import { ItemView, PluginSettingTab, Setting, type App, type WorkspaceLeaf } from "obsidian";
import type LocalTtsReaderPlugin from "../main";
import { SettingsPanel } from "./settingsTab";
import type { ControlBar } from "./controlBar";

export const SETTINGS_VIEW_TYPE = "local-tts-settings";

/**
 * The plugin's settings as a sidebar pane, beside the file explorer.
 *
 * The rows are drawn by `SettingsPanel`; this class only owns the pane's
 * lifecycle. Closing the pane does not stop a read in progress, unlike
 * closing the Settings dialog, because the pane is meant to stay open
 * alongside a note while it is being read.
 */
export class SettingsView extends ItemView {
	private readonly panel: SettingsPanel;
	private controls: ControlBar | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: LocalTtsReaderPlugin,
	) {
		super(leaf);
		this.panel = new SettingsPanel(plugin.app, plugin);
	}

	getViewType(): string {
		return SETTINGS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Local TTS";
	}

	override getIcon(): string {
		return "audio-lines";
	}

	override async onOpen(): Promise<void> {
		this.contentEl.addClass("local-tts-settings-view");
		// Playback controls first, outside any section, then the settings. The
		// panel empties its own container on every redraw, so it gets a
		// container of its own and leaves the controls alone.
		// The controls are pinned: they sit outside the scrolling area, so the
		// settings (and an engine page's own pinned ribbon) scroll beneath them.
		const controlsHost = this.contentEl.createDiv({ cls: "local-tts-settings-controls" });
		this.controls = this.plugin.createInlineControlBar(controlsHost);
		this.panel.mount(this.contentEl.createDiv({ cls: "local-tts-settings-scroll" }));
		await Promise.resolve();
	}

	override async onClose(): Promise<void> {
		this.panel.unmount();
		if (this.controls) this.plugin.releaseInlineControlBar(this.controls);
		this.controls = null;
		this.contentEl.empty();
		await Promise.resolve();
	}
}

/**
 * The entry in Obsidian's Settings dialog. It holds no settings itself: it
 * points at the sidebar pane, because a plugin with settings in two places
 * has two places to keep in step.
 */
export class LocalTtsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: LocalTtsReaderPlugin,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Settings live in the sidebar")
			.setDesc("Voice, speed, content, highlighting, timer and engine options are in the Local TTS pane next to the file explorer.")
			.addButton((button) =>
				button
					.setButtonText("Open Local TTS settings")
					.setCta()
					.onClick(() => {
						void this.plugin.openSettingsView();
					}),
			);
	}
}
