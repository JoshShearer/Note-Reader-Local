import { setIcon } from "obsidian";
import type LocalTtsReaderPlugin from "../main";
import type { PlayerState } from "../audio/player";
import type { EngineCapabilities } from "../audio/types";
import { controlAffordances, type Affordance, type Affordances } from "./affordances";
import { trace } from "../diagnostics";
import { CONTROL_BAR_HEIGHT_VAR, CONTROL_BAR_VISIBLE_CLASS } from "./controlBarCss";

const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.05;
/** Where the floating bar was last dragged to, in this device's local storage. */
const CONTROL_BAR_POSITION_KEY = "local-tts-control-bar-position";

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
	/**
	 * True for a copy drawn inside a container (the settings pane) rather than
	 * the floating bar. It is always shown, takes part in normal layout, and
	 * leaves the body-level class and height variable to the floating one.
	 */
	private readonly inline: boolean;
	private readonly el: HTMLElement;
	private readonly playPauseBtn: HTMLButtonElement;
	/** Holds the play button and the outline drawn around it while audio is being generated. */
	private readonly playWrap: HTMLElement;
	/** Only means something while a read is running. */
	private readonly stopBtn: HTMLButtonElement;
	private groups: HTMLElement[] = [];
	private resizeObserver: ResizeObserver | null = null;
	private readonly slowerBtn: HTMLButtonElement;
	private readonly fasterBtn: HTMLButtonElement;
	private readonly speedValueEl: HTMLElement;
	private readonly progressEl: HTMLElement;
	/** The section's text, shown only on the inline copy. */
	private readonly previewEl: HTMLElement | null;
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
	/** The player is waiting for audio with nothing sounding. */
	private generating = false;
	/** A remembered spot, applied the first time the bar is shown (when its size is known). */
	private pendingPosition: { x: number; y: number } | null = null;
	/** The floating bar has been dragged away from its default place. */
	private moved = false;

	constructor(
		private readonly plugin: LocalTtsReaderPlugin,
		host?: HTMLElement,
	) {
		this.inline = host !== undefined;
		this.el = host
			? host.createDiv({ cls: "local-tts-control-bar local-tts-control-bar-inline" })
			: document.body.createDiv({ cls: "local-tts-control-bar" });
		if (host) {
			// A copy made after the engine was chosen would otherwise offer
			// controls the engine cannot honour until the next engine change.
			const engine = plugin.activeEngine();
			this.affordances = controlAffordances(
				engine?.capabilities ?? null,
				engine?.label ?? "This engine",
			);
		}

		const beginningBtn = this.el.createEl("button", {
			cls: "local-tts-cb-btn",
			attr: { "aria-label": "Return to the beginning of the note", type: "button" },
		});
		setIcon(beginningBtn, "chevrons-up");
		beginningBtn.addEventListener("click", () => {
			void this.plugin.restartFromBeginning();
		});

		const paraPrevBtn = this.el.createEl("button", {
			cls: "local-tts-cb-btn",
			attr: { "aria-label": "Read previous paragraph", type: "button" },
		});
		setIcon(paraPrevBtn, "local-tts-para-prev");
		paraPrevBtn.addEventListener("click", () => this.plugin.jumpParagraph(-1));

		const previousBtn = this.el.createEl("button", {
			cls: "local-tts-cb-btn",
			attr: { "aria-label": "Read previous sentence", type: "button" },
		});
		setIcon(previousBtn, "skip-back");
		previousBtn.addEventListener("click", () => {
			// Idle, the skip buttons move where the next read starts.
			if (this.startIsAdjustable()) this.plugin.nudgeStart(-1);
			else void this.plugin.getPlayer().previous();
		});

		// The outline lives beside the button, not in it: setIcon() empties the
		// button every refresh, which would take an overlay with it.
		this.playWrap = this.el.createDiv({ cls: "local-tts-cb-play-wrap" });
		if (!this.inline) this.addDragHandle();
		this.playPauseBtn = this.playWrap.createEl("button", {
			cls: "local-tts-cb-btn local-tts-cb-btn-primary",
			attr: { "aria-label": "Pause or resume reading", type: "button" },
		});
		const outline = this.playWrap.createSvg("svg", {
			cls: "local-tts-cb-generating",
			attr: { viewBox: "0 0 36 36", preserveAspectRatio: "none" },
		});
		outline.createSvg("rect", { attr: { x: "1", y: "1", width: "34", height: "34", rx: "7" } });
		this.playPauseBtn.addEventListener("click", () => {
			const player = this.plugin.getPlayer();
			const state = player.getState();
			// The floating bar only exists while a read is running, so toggle()
			// has never needed to start one. The inline copy is always there.
			if (this.inline && (state === "idle" || state === "finished")) {
				void this.plugin.readActiveNote();
				return;
			}
			player.toggle();
		});

		// Play from the cursor, or the selection when there is one.
		const cursorBtn = this.el.createEl("button", {
			cls: "local-tts-cb-btn",
			attr: { "aria-label": "Play from cursor or selection", type: "button" },
		});
		setIcon(cursorBtn, "local-tts-play-ibeam");
		cursorBtn.addEventListener("click", () => this.plugin.playFromCursorOrSelection());

		const stopBtn = this.el.createEl("button", {
			cls: "local-tts-cb-btn",
			attr: { "aria-label": "Stop reading", type: "button" },
		});
		this.stopBtn = stopBtn;
		setIcon(stopBtn, "square");
		stopBtn.addEventListener("click", () => this.plugin.stopReading());

		const nextBtn = this.el.createEl("button", {
			cls: "local-tts-cb-btn",
			attr: { "aria-label": "Read next sentence", type: "button" },
		});
		setIcon(nextBtn, "skip-forward");
		nextBtn.addEventListener("click", () => {
			if (this.startIsAdjustable()) this.plugin.nudgeStart(1);
			else void this.plugin.getPlayer().next();
		});

		const paraNextBtn = this.el.createEl("button", {
			cls: "local-tts-cb-btn",
			attr: { "aria-label": "Read next paragraph", type: "button" },
		});
		setIcon(paraNextBtn, "local-tts-para-next");
		paraNextBtn.addEventListener("click", () => this.plugin.jumpParagraph(1));

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
		this.previewEl = this.inline
			? this.el.createDiv({ cls: "local-tts-cb-preview" })
			: null;
		// Three groups, the same in the floating bar and the settings copy: the
		// transport buttons, the speed readout, and the section controls. Each is
		// kept whole, so when the width runs out a whole group wraps to the next
		// row, at the separators.
		const transport = this.el.createDiv({ cls: "local-tts-cb-group" });
		transport.append(this.playWrap, cursorBtn, stopBtn);
		const sections = this.el.createDiv({ cls: "local-tts-cb-group local-tts-cb-section-group" });
		sections.append(beginningBtn, paraPrevBtn, previousBtn, this.progressEl, nextBtn, paraNextBtn);
		speed.addClass("local-tts-cb-group");
		// The drag grip leads the first group.
		const grip = this.el.querySelector(".local-tts-cb-handle");
		if (grip) transport.prepend(grip);
		this.el.append(transport, speed, sections);
		// The section's text goes on a row of its own below (settings copy only).
		if (this.previewEl) this.el.append(this.previewEl);
		this.groups = [transport, speed, sections];
		if (typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(() => this.updateRowStarts());
			this.resizeObserver.observe(this.el);
		}

		const player = this.plugin.getPlayer();
		this.unsubscribers.push(
			player.on("state", (state) => this.onState(state)),
			this.plugin.onReadInfoChange(() => {
				if (this.inline) this.syncSection();
			}),
			player.on("generating", (generating) => {
				this.generating = generating;
				if (this.inline) this.syncSection();
				this.refresh();
			}),
			player.on("progress", ({ chunkIndex, total }) => {
				if (this.inline) {
					this.syncSection();
					return;
				}
				this.progressEl.setText(`${chunkIndex + 1} / ${total}`);
			}),
			// The readout follows the player, whoever changed the rate: these
			// buttons, the settings slider, or a new play() at a stored rate.
			player.on("rate", (rate) => this.setRateDisplay(rate)),
		);

		this.setRateDisplay(player.getRate());
		this.state = player.getState();
		if (this.inline) this.syncSection();
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

	/**
	 * Show the section the player is on, of how many, and what it says.
	 *
	 * While a read is in flight this is the player's own queue. Otherwise it
	 * is where a read of the open note would start, from its stored position,
	 * so the line is never empty because nothing is playing. Read on demand
	 * rather than taken from an event, so it is right whenever it is called:
	 * the pane can be opened mid-read, and a finished read leaves the index one
	 * past the end. The text goes to the screen only, never to a log.
	 */
	private syncSection(): void {
		const player = this.plugin.getPlayer();
		const state = player.getState();
		const inFlight = state === "preparing" || state === "playing" || state === "paused";
		const count = player.getChunkCount();

		let index: number;
		let total: number;
		let text: string;
		const playing = inFlight && count > 0;
		if (inFlight && count > 0) {
			index = Math.min(Math.max(player.getIndex(), 0), count - 1);
			total = count;
			text = player.getChunk(index)?.text ?? "";
		} else {
			const next = this.plugin.previewStart();
			if (next) {
				({ index, total, text } = next);
			} else if (count > 0) {
				index = Math.min(Math.max(player.getIndex(), 0), count - 1);
				total = count;
				text = player.getChunk(index)?.text ?? "";
			} else {
				this.progressEl.setText("No note open");
				this.previewEl?.empty();
				this.previewEl?.createSpan({ cls: "local-tts-cb-preview-label", text: "Preview: nothing to read" });
				return;
			}
		}
		this.progressEl.setText(`Section ${index + 1} of ${total}`);
		// One line, cut by CSS at whatever width the pane has; the full text is
		// the hover title. While a read is running the status takes its place: the
		// highlighted note already shows what is being said.
		const preview = this.previewEl;
		if (!preview) return;
		preview.empty();
		preview.removeAttribute("title");
		if (playing) {
			// In the preview's place, in the same muted italic as its label.
			// The read's details arrive a moment after its state does; until they
			// do, a placeholder keeps the line (and the layout below it) in place.
			const status = this.plugin.readStatusLine() ?? "Starting...";
			preview.createSpan({ cls: "local-tts-cb-preview-label", text: status });
		} else if (text) {
			preview.createSpan({ cls: "local-tts-cb-preview-label", text: "Preview: " });
			preview.createSpan({ text });
			preview.setAttribute("title", text);
		} else {
			// Keep the line (and the layout below it) even with nothing to preview.
			preview.createSpan({ cls: "local-tts-cb-preview-label", text: "Preview: nothing to read" });
		}
	}

	/**
	 * A separator belongs between two groups on one row. A group that has wrapped
	 * to the start of a row has nothing to its left, so it drops its separator.
	 * Measured with every separator in place, so the answer depends only on the
	 * width and cannot flip back and forth as the separators come and go.
	 */
	private updateRowStarts(): void {
		for (const group of this.groups) group.removeClass("local-tts-cb-row-start");
		// Groups on one row are centred on it and so overlap vertically even when
		// their heights differ; a wrapped group starts below the previous one ends.
		for (let i = 1; i < this.groups.length; i += 1) {
			const before = this.groups[i - 1]!;
			if (this.groups[i]!.offsetTop >= before.offsetTop + before.offsetHeight) {
				this.groups[i]!.addClass("local-tts-cb-row-start");
			}
		}
		// The floating bar's height changes with the rows, and the band reserved
		// for it follows.
		if (!this.inline && !this.moved && this.el.hasClass("is-visible") && this.el.offsetHeight > 0) {
			document.body.style.setProperty(CONTROL_BAR_HEIGHT_VAR, `${this.el.offsetHeight}px`);
		}
	}

	/** Redraw the section line; called when the open note changes. */
	refreshSection(): void {
		if (this.inline) this.syncSection();
	}

	/** The inline copy with nothing running: the skip buttons pick the start. */
	private startIsAdjustable(): boolean {
		return this.inline && (this.state === "idle" || this.state === "finished");
	}

	private onState(state: PlayerState): void {
		this.state = state;
		if (this.inline) this.syncSection();
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
		if (el.instanceOf(HTMLButtonElement)) el.disabled = disabled;
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

	/** Visibility and the reserved band, which only the floating bar has. */
	private refreshFloating(active: boolean): void {
		this.el.toggleClass("is-visible", active);
		// NRL-129, in the same statement group as the line above so the two can
		// never disagree about whether the bar is up. The bar is
		// `position: fixed` and cannot push content down itself, and on a note
		// too short to scroll the auto-scroll has nowhere to move the spoken
		// sentence to, so styles.css reserves the band off this class.
		//
		// The height is measured and published rather than derived in CSS,
		// because it depends on how many rows `flex-wrap` produced and a CSS
		// expression cannot ask that - see docs/adr/0032's NRL-129 amendment.
		// The `> 0` guard is load-bearing: refresh() also runs from the
		// constructor, before the element has been laid out, and a published
		// `0px` would stick as a wrong value where the property's ABSENCE is
		// the fail-safe styles.css falls back on.
		// Not once the bar has been dragged elsewhere: it no longer sits in that band.
		if (active && this.pendingPosition && !this.moved) {
			const saved = this.pendingPosition;
			this.pendingPosition = null;
			this.placeBar(saved.x, saved.y);
		}
		document.body.toggleClass(CONTROL_BAR_VISIBLE_CLASS, active && !this.moved);
		if (this.moved && active) this.placeBar(parseFloat(this.el.style.left), parseFloat(this.el.style.top));
		if (active && !this.moved && this.el.offsetHeight > 0) {
			document.body.style.setProperty(CONTROL_BAR_HEIGHT_VAR, `${this.el.offsetHeight}px`);
		}
	}

	/**
	 * A grip at the left of the floating bar that drags it anywhere in the
	 * window. The spot is remembered on this device (local storage, not the
	 * synced settings: a window position means nothing on another screen), and
	 * double-clicking the grip puts the bar back where it started.
	 */
	private addDragHandle(): void {
		const handle = this.el.createSpan({ cls: "local-tts-cb-handle" });
		setIcon(handle, "grip-vertical");
		// First in the bar, ahead of the controls.
		this.el.insertBefore(handle, this.el.firstChild);

		this.pendingPosition = this.readSavedPosition();

		let drag: { dx: number; dy: number } | null = null;
		handle.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			const rect = this.el.getBoundingClientRect();
			drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
			handle.setPointerCapture(event.pointerId);
			this.el.addClass("is-dragging");
		});
		handle.addEventListener("pointermove", (event) => {
			if (drag) this.placeBar(event.clientX - drag.dx, event.clientY - drag.dy);
		});
		const end = (event: PointerEvent): void => {
			if (!drag) return;
			drag = null;
			this.el.removeClass("is-dragging");
			// Saved before anything that could throw.
			this.writeSavedPosition({ x: parseFloat(this.el.style.left), y: parseFloat(this.el.style.top) });
			try {
				handle.releasePointerCapture(event.pointerId);
			} catch {
				// Already released.
			}
		};
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
		handle.addEventListener("dblclick", () => {
			this.moved = false;
			this.el.removeClass("is-moved");
			this.el.style.removeProperty("left");
			this.el.style.removeProperty("top");
			this.pendingPosition = null;
			this.writeSavedPosition(null);
		});
	}

	/**
	 * Where the floating bar is remembered. Plain localStorage keyed by vault:
	 * it is device-local on purpose (a window position means nothing on another
	 * screen), and it does not depend on any Obsidian wrapper behaving.
	 */
	private positionKey(): string {
		return `${CONTROL_BAR_POSITION_KEY}:${this.plugin.app.vault.getName()}`;
	}

	private readSavedPosition(): { x: number; y: number } | null {
		try {
			const raw = window.localStorage.getItem(this.positionKey());
			const parsed = raw ? (JSON.parse(raw) as { x?: unknown; y?: unknown }) : null;
			if (parsed && typeof parsed.x === "number" && typeof parsed.y === "number") {
				return { x: parsed.x, y: parsed.y };
			}
		} catch {
			// An unreadable saved position just means the default one.
		}
		return null;
	}

	private writeSavedPosition(position: { x: number; y: number } | null): void {
		try {
			if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
				window.localStorage.setItem(this.positionKey(), JSON.stringify(position));
			} else {
				window.localStorage.removeItem(this.positionKey());
			}
			trace(this.plugin.app, this.plugin.manifest.dir!, "control bar position saved", JSON.stringify(position));
		} catch (err) {
			trace(this.plugin.app, this.plugin.manifest.dir!, "control bar position not saved", String(err));
		}
	}

	/** Put the bar at (x, y), kept inside the window. */
	private placeBar(x: number, y: number): void {
		if (!Number.isFinite(x) || !Number.isFinite(y)) return;
		const rect = this.el.getBoundingClientRect();
		const left = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - rect.width));
		const top = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - rect.height));
		this.el.style.left = `${left}px`;
		this.el.style.top = `${top}px`;
		this.moved = true;
		this.el.addClass("is-moved");
	}

	/** The single place either reason for a disabled control is written to the DOM. */
	private refresh(): void {
		const state = this.state;
		const active = state === "preparing" || state === "playing" || state === "paused";
		if (!this.inline) this.refreshFloating(active);

		// Preparing shows the pause icon: a click then holds the first sentence
		// back, so the button is live from the moment reading starts.
		const player = this.plugin.getPlayer();
		const waitOnly = state === "preparing" && !player.canPauseWhilePreparing();
		setIcon(this.playPauseBtn, waitOnly ? "loader-2" : state === "playing" || state === "preparing" ? "pause" : "play");
		this.playPauseBtn.toggleClass("is-loading", waitOnly);
		this.apply(this.playPauseBtn, this.affordances.playPause, waitOnly);
		// A yellow dashed outline while audio is being made and none is sounding.
		this.playWrap.toggleClass("is-generating", this.generating && (state === "preparing" || state === "playing"));

		// Nothing to stop unless a read is running (paused counts).
		this.stopBtn.disabled = !active;
		if (active) this.stopBtn.removeAttribute("aria-disabled");
		else this.stopBtn.setAttribute("aria-disabled", "true");

		this.apply(this.slowerBtn, this.affordances.rate);
		this.apply(this.fasterBtn, this.affordances.rate);
		this.apply(this.speedValueEl, this.affordances.rate);

		// The inline copy keeps showing the last section it reached.
		if (!active && !this.inline) this.progressEl.setText("");
	}

	destroy(): void {
		this.resizeObserver?.disconnect();
		for (const off of this.unsubscribers) off();
		this.el.remove();
		if (this.inline) return;
		// Both, or a plugin unload during a read leaves the mobile editor
		// permanently padded for a bar that no longer exists - the class alone
		// would be enough to keep the rule matching, and the property alone
		// would be a stale height waiting for the next install.
		document.body.removeClass(CONTROL_BAR_VISIBLE_CLASS);
		document.body.style.removeProperty(CONTROL_BAR_HEIGHT_VAR);
	}
}
