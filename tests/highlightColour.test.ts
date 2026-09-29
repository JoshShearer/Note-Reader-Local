/**
 * The highlight colour setting, from stored value to CSS custom property.
 *
 * `styles.css` reads `--local-tts-reader-word-highlight`. Until NRL-14 nothing
 * ever wrote it, so the colour setting was a control that did nothing. These
 * checks drive the same function main.ts calls, against a fake style object
 * that records what was set, so "the setting changes the highlight" is
 * something a test can see rather than assume.
 */

import {
	WORD_HIGHLIGHT_VAR,
	applyWordHighlightColour,
	highlightCssValue,
	isAcceptableColourInput,
	isStorableColour,
} from "../src/ui/highlightColour.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

/** Records setProperty/removeProperty like a CSSStyleDeclaration would hold them. */
class FakeStyle {
	props = new Map<string, string>();
	setProperty(name: string, value: string): void {
		this.props.set(name, value);
	}
	removeProperty(name: string): string {
		const old = this.props.get(name) ?? "";
		this.props.delete(name);
		return old;
	}
}

console.log("variable name leaves room for a sentence highlight");
check("word variable", WORD_HIGHLIGHT_VAR === "--local-tts-reader-word-highlight", WORD_HIGHLIGHT_VAR);

console.log("isStorableColour: hex 3/4/6/8 or empty");
for (const v of ["", "#abc", "#abcd", "#aabbcc", "#aabbccdd", "#ABCDEF"]) {
	check(`accepts ${JSON.stringify(v)}`, isStorableColour(v));
}
for (const v of ["not a colour", "#12345", "#1234567", "#ab", "red", "abc", "#ggg", " #abc", 7, null, undefined]) {
	check(`rejects ${JSON.stringify(v)}`, !isStorableColour(v));
}

console.log("highlightCssValue: empty means theme default");
check("\"\" -> null", highlightCssValue("") === null);
check("#aabbcc -> #aabbcc", highlightCssValue("#aabbcc") === "#aabbcc");
check("garbage -> null", highlightCssValue("not a colour") === null);

console.log("applyWordHighlightColour writes the variable the stylesheet reads");
{
	const style = new FakeStyle();
	applyWordHighlightColour(style, "#ff0000");
	check("set to #ff0000", style.props.get(WORD_HIGHLIGHT_VAR) === "#ff0000", JSON.stringify([...style.props]));
	applyWordHighlightColour(style, "#00ff00");
	check("changed to #00ff00", style.props.get(WORD_HIGHLIGHT_VAR) === "#00ff00", JSON.stringify([...style.props]));
	applyWordHighlightColour(style, "");
	check("theme default removes the override", !style.props.has(WORD_HIGHLIGHT_VAR), JSON.stringify([...style.props]));
	applyWordHighlightColour(style, "#00ff00");
	applyWordHighlightColour(style, "not a colour");
	check("an invalid value falls back to the theme, not a stale colour", !style.props.has(WORD_HIGHLIGHT_VAR),
		JSON.stringify([...style.props]));
}

console.log("isAcceptableColourInput: storable and, where available, CSS.supports");
{
	const yes = (): boolean => true;
	const no = (): boolean => false;
	check("hex with supports=true", isAcceptableColourInput("#abc", yes));
	check("hex with supports=false is rejected", !isAcceptableColourInput("#abc", no));
	check("\"\" never needs CSS.supports", isAcceptableColourInput("", no));
	check("named colour rejected even if CSS accepts it", !isAcceptableColourInput("red", yes));
	// Plain Node has no CSS global: the check must degrade to the hex rule
	// rather than throw, or the module could not be tested (or run) without a DOM.
	check("no CSS global: hex accepted", isAcceptableColourInput("#aabbcc"));
	check("no CSS global: garbage rejected", !isAcceptableColourInput("not a colour"));
}

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall highlight colour checks passed");
