/*
 * What the UI is allowed to offer, given what the active engine can do.
 *
 * R-M14 (srs.md:484) requires that controls the current backend cannot honour
 * are disabled, hidden, or clearly marked unavailable. This module picks
 * "disabled, with a reason": a button that vanishes when the engine changes is
 * more confusing than one that stays put and explains itself, and a tooltip is
 * the only place the explanation can live on a toolbar with no room for text.
 *
 * No obsidian or DOM import, for the same reason as highlightColour.ts: the
 * rules are the part worth testing, and the tests run in plain Node. The
 * control bar and the settings tab both read their answers from here so they
 * cannot drift apart about which engine can do what.
 *
 * Only controls that actually vary get an entry. Stop and replay work on every
 * engine (stop interrupts the daemon or cancels speechSynthesis; replay just
 * re-synthesises), so they have no capability field and no affordance here. A
 * constant-true entry would be the same dead advertisement this module exists
 * to remove.
 */

import type { EngineCapabilities } from "../audio/types";

/** A control whose availability depends on the engine. */
export type ControlId = "playPause" | "rate" | "pitch" | "highlightToggle";

export interface Affordance {
	enabled: boolean;
	/** Why not, in a sentence fit for a tooltip. Empty when enabled. */
	reason: string;
}

export type Affordances = Record<ControlId, Affordance>;

/**
 * One thing an engine cannot do, phrased for the settings engine list.
 *
 * `sentenceBoundary` and `offlineStatus` gate no control today, so this is
 * what keeps them from becoming two more capability fields nothing ever reads.
 */
export interface Limitation {
	id: ControlId | "sentenceBoundary" | "offlineStatus";
	text: string;
}

const able: Affordance = { enabled: true, reason: "" };

function gate(enabled: boolean, reason: string): Affordance {
	return enabled ? able : { enabled: false, reason };
}

/**
 * Which transport controls to offer for `caps`, and what to say about the rest.
 *
 * `caps` is null when no engine matched the stored id. Everything stays enabled
 * in that case: that failure already produces a loud notice of its own
 * (main.ts, "no engine named"), and grabbing the whole toolbar out from under
 * the user would hide the real problem rather than explain it.
 */
export function controlAffordances(caps: EngineCapabilities | null, engineLabel: string): Affordances {
	if (!caps) return { playPause: able, rate: able, pitch: able, highlightToggle: able };

	return {
		// Both halves are required. A pause the player cannot come back from is
		// not a pause. Deliberately read from `pause`/`resume` rather than from
		// `ownsPlayback`, even though the two coincide today: rate routing owns
		// `ownsPlayback` (AGENTS.md non-negotiable 9) and an engine that gains a
		// real pause must not have to lie about who applies the speed.
		playPause: gate(
			caps.pause && caps.resume,
			`${engineLabel} cannot pause. Stop and start again.`,
		),
		rate: gate(caps.rate, `${engineLabel} reads at a fixed speed.`),
		pitch: gate(caps.pitch, `${engineLabel} does not support pitch control.`),
		highlightToggle: gate(
			caps.timing !== "none",
			`${engineLabel} does not report word timings, so there is nothing to highlight.`,
		),
	};
}

/**
 * Everything `caps` cannot do, shortest first, for the engine status row.
 *
 * Ordered so the facts that change what the user can press come before the
 * ones that only describe the engine.
 */
export function engineLimitations(caps: EngineCapabilities, engineLabel: string): Limitation[] {
	const out: Limitation[] = [];
	const affordances = controlAffordances(caps, engineLabel);

	if (!affordances.highlightToggle.enabled) out.push({ id: "highlightToggle", text: "no word highlighting" });
	if (!affordances.playPause.enabled) out.push({ id: "playPause", text: "cannot pause" });
	if (!affordances.rate.enabled) out.push({ id: "rate", text: "fixed speed" });
	if (!affordances.pitch.enabled) out.push({ id: "pitch", text: "no pitch control" });
	if (!caps.sentenceBoundary) out.push({ id: "sentenceBoundary", text: "no sentence boundaries" });
	if (!caps.offlineStatus) {
		out.push({ id: "offlineStatus", text: "cannot tell which voices need the network" });
	}

	return out;
}
