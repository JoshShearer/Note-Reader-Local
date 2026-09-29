import { setIcon } from "obsidian";
import type LocalTtsReaderPlugin from "../main";
import type { PlayerState } from "../audio/player";
import type { EngineCapabilities } from "../audio/types";
import { controlAffordances, type Affordance, type Affordances } from "./affordances";

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
	private readonly slowerBtn: HTMLButtonElement;
	private readonly fasterBtn: HTMLButtonElement;
	private readonly speedValueEl: HTMLElement;
	private readonly progressEl: HTMLElement;
	private readonly unsubscribers: Array<() => void> = [];
	/**
	 * What the active engine can do, and the last state the player reported.
	 *
	 * Both are held because the two reasons a button can be disabled arrive on
	 * different events: a capability when the engine changes, "preparing" when
	 * the player moves. Writing `.disabled` from whichever fired last let a
	 * state event re-enable a button the engine cannot honour, so both are kept
	 * and one refresh reads them together.
	 */
	private affordances: Affordances = controlAffordances(null, "This engine");
	private state: PlayerState;

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

		this.slowerBtn = speed.createEl("button", {
			cls: "local-tts-cb-speed-btn",
			text: "\u2212",
			attr: { "aria-label": "Read slower", type: "button" },
		});
		this.slowerBtn.addEventListener("click", () => this.nudgeRate(-RATE_STEP));

		this.speedValueEl = speed.createSpan({ cls: "local-tts-cb-speed-value" });

		this.fasterBtn = speed.createEl("button", {
			cls: "local-tts-cb-speed-btn",
			text: "+",
			attr: { "aria-label": "Read faster", type: "button" },
		});
		this.fasterBtn.addEventListener("click", () => this.nudgeRate(RATE_STEP));

		// Scrolling over the readout is a faster way to nudge speed than
		// hunting for the small +/- buttons.
		this.speedValueEl.addEventListener(
			"wheel",
			(event) => {
				// Bail before preventDefault: on an engine with no rate control
				// there is nothing to nudge, and swallowing the wheel event would
				// stop the note scrolling for no reason.
				if (!this.affordances.rate.enabled) return;
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
		this.state = player.getState();
		this.refresh();
	}

	/**
	 * Tell the bar which engine is now active, so it can stop offering what that
	 * engine cannot do.
	 *
	 * Called on construction and from the plugin's `setEngine`, which is the
	 * only writer of `settings.engine`. `caps` is null when no engine matched;
	 * see `controlAffordances` for why that leaves everything enabled.
	 */
	setEngine(caps: EngineCapabilities | null, label: string): void {
		this.affordances = controlAffordances(caps, label);
		this.refresh();
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
		this.state = state;
		this.refresh();
	}

	/**
	 * Mark a control unavailable, with the reason where the user can find it.
	 *
	 * `title` is the only room a toolbar this size has for an explanation, so a
	 * disabled button without one would be indistinguishable from a broken one.
	 */
	private apply(el: HTMLElement, affordance: Affordance, alsoDisabled = false): void {
		const disabled = !affordance.enabled || alsoDisabled;
		if (el instanceof HTMLButtonElement) el.disabled = disabled;
		el.toggleClass("is-unavailable", !affordance.enabled);
		// Spelled out rather than toggled: aria-disabled is a true/false token,
		// and a bare `aria-disabled=""` is read as false, which is the opposite
		// of what is meant. Needed on the speed readout in particular, which is
		// a span and so has no `disabled` property of its own.
		if (disabled) el.setAttribute("aria-disabled", "true");
		else el.removeAttribute("aria-disabled");
		if (affordance.reason) el.setAttribute("title", affordance.reason);
		else el.removeAttribute("title");
	}

	/** The single place either reason for a disabled control is written to the DOM. */
	private refresh(): void {
		const state = this.state;
		const active = state === "preparing" || state === "playing" || state === "paused";
		this.el.toggleClass("is-visible", active);

		setIcon(this.playPauseBtn, state === "preparing" ? "loader-2" : state === "playing" ? "pause" : "play");
		this.playPauseBtn.toggleClass("is-loading", state === "preparing");
		this.apply(this.playPauseBtn, this.affordances.playPause, state === "preparing");

		this.apply(this.slowerBtn, this.affordances.rate);
		this.apply(this.fasterBtn, this.affordances.rate);
		this.apply(this.speedValueEl, this.affordances.rate);

		if (!active) this.progressEl.setText("");
	}

	destroy(): void {
		for (const off of this.unsubscribers) off();
		this.el.remove();
	}
}
