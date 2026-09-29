import { setIcon } from "obsidian";
import type LocalTtsReaderPlugin from "../main";
import type { PlayerState } from "../audio/player";

const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.05;

/**
 * A small floating toolbar with playback controls.
 *
 * Fixed to the top of the app rather than embedded in a single note: reading
 * carries on across note switches and scrolling, so the controls have to stay
 * reachable regardless of which view is focused. It only shows itself while
 * something is actually happening (preparing, playing or paused) and stays
 * out of the way the rest of the time.
 */
export class ControlBar {
	private readonly el: HTMLElement;
	private readonly playPauseBtn: HTMLButtonElement;
	private readonly speedValueEl: HTMLElement;
	private readonly progressEl: HTMLElement;
	private readonly unsubscribers: Array<() => void> = [];

	constructor(private readonly plugin: LocalTtsReaderPlugin) {
		this.el = document.body.createDiv({ cls: "local-tts-control-bar" });

		const replayBtn = this.el.createEl("button", {
			cls: "local-tts-cb-btn",
			attr: { "aria-label": "Replay current sentence", type: "button" },
		});
		setIcon(replayBtn, "rotate-ccw");
		replayBtn.addEventListener("click", () => {
			void this.plugin.getPlayer().replayCurrent();
		});

		this.playPauseBtn = this.el.createEl("button", {
			cls: "local-tts-cb-btn local-tts-cb-btn-primary",
			attr: { "aria-label": "Pause or resume reading", type: "button" },
		});
		this.playPauseBtn.addEventListener("click", () => this.plugin.getPlayer().toggle());

		const stopBtn = this.el.createEl("button", {
			cls: "local-tts-cb-btn",
			attr: { "aria-label": "Stop reading", type: "button" },
		});
		setIcon(stopBtn, "square");
		stopBtn.addEventListener("click", () => this.plugin.stopReading());

		const speed = this.el.createDiv({ cls: "local-tts-cb-speed" });

		const slowerBtn = speed.createEl("button", {
			cls: "local-tts-cb-speed-btn",
			text: "\u2212",
			attr: { "aria-label": "Read slower", type: "button" },
		});
		slowerBtn.addEventListener("click", () => this.nudgeRate(-RATE_STEP));

		this.speedValueEl = speed.createSpan({ cls: "local-tts-cb-speed-value" });

		const fasterBtn = speed.createEl("button", {
			cls: "local-tts-cb-speed-btn",
			text: "+",
			attr: { "aria-label": "Read faster", type: "button" },
		});
		fasterBtn.addEventListener("click", () => this.nudgeRate(RATE_STEP));

		// Scrolling over the readout is a faster way to nudge speed than
		// hunting for the small +/- buttons.
		this.speedValueEl.addEventListener(
			"wheel",
			(event) => {
				event.preventDefault();
				this.nudgeRate(event.deltaY < 0 ? RATE_STEP : -RATE_STEP);
			},
			{ passive: false },
		);

		this.progressEl = this.el.createSpan({ cls: "local-tts-cb-progress" });

		const player = this.plugin.getPlayer();
		this.unsubscribers.push(
			player.on("state", (state) => this.onState(state)),
			player.on("progress", ({ chunkIndex, total }) => {
				this.progressEl.setText(`${chunkIndex + 1} / ${total}`);
			}),
			// The readout follows the player, whoever changed the rate: these
			// buttons, the settings slider, or a new play() at a stored rate.
			player.on("rate", (rate) => this.setRateDisplay(rate)),
		);

		this.setRateDisplay(player.getRate());
		this.onState(player.getState());
	}

	private setRateDisplay(rate: number): void {
		this.speedValueEl.setText(`${rate.toFixed(2)}\u00d7`);
	}

	private nudgeRate(delta: number): void {
		const next =
			Math.round(
				Math.min(RATE_MAX, Math.max(RATE_MIN, this.plugin.getPlayer().getRate() + delta)) * 100,
			) / 100;
		void this.plugin.setRate(next);
	}

	private onState(state: PlayerState): void {
		const active = state === "preparing" || state === "playing" || state === "paused";
		this.el.toggleClass("is-visible", active);

		setIcon(this.playPauseBtn, state === "preparing" ? "loader-2" : state === "playing" ? "pause" : "play");
		this.playPauseBtn.toggleClass("is-loading", state === "preparing");
		this.playPauseBtn.disabled = state === "preparing";

		if (!active) this.progressEl.setText("");
	}

	destroy(): void {
		for (const off of this.unsubscribers) off();
		this.el.remove();
	}
}
