/*
 * The highlight colour setting, from stored value to CSS custom property.
 *
 * No obsidian or DOM import: settings normalisation imports the storage rule
 * from here, and both have to run in plain Node for the tests.
 *
 * Storage is hex or "" and nothing else. "" means "follow the theme", which
 * styles.css resolves to Obsidian's --text-highlight-bg, so the default is
 * legible on light and dark themes without the user touching it. Named and
 * rgb() colours are refused even where CSS accepts them, so the settings tab
 * and the loader never disagree about what is valid; the colour picker covers
 * everything a text field would.
 *
 * See docs/adr/0005.
 */

/**
 * The property styles.css reads for the spoken sentence.
 */
export const SENTENCE_HIGHLIGHT_VAR = "--local-tts-reader-sentence-highlight";

/**
 * The property styles.css reads for the spoken word. Named for the word so a
 * sentence highlight can sit beside it as --local-tts-reader-sentence-highlight.
 */
export const WORD_HIGHLIGHT_VAR = "--local-tts-reader-word-highlight";

const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Whether `value` may be written to settings.highlight.color. */
export function isStorableColour(value: unknown): value is string {
	return value === "" || (typeof value === "string" && HEX_COLOUR.test(value));
}

/** The CSS value to set, or null to leave the theme default in charge. */
export function highlightCssValue(stored: string): string | null {
	return stored !== "" && isStorableColour(stored) ? stored : null;
}

type Supports = (property: string, value: string) => boolean;

/**
 * Whether the settings tab should accept `value` from the text field.
 *
 * CSS.supports is a second opinion on top of the hex rule, taken only where
 * it exists: it is absent in plain Node and has been missing from some
 * embedded WebViews, and a missing global must not reject every colour.
 */
export function isAcceptableColourInput(value: string, supports?: Supports): boolean {
	if (!isStorableColour(value)) return false;
	if (value === "") return true;
	const check = supports ?? defaultSupports();
	return check ? check("color", value) : true;
}

function defaultSupports(): Supports | null {
	const css = (globalThis as { CSS?: { supports?: Supports } }).CSS;
	return typeof css?.supports === "function" ? (p, v) => css.supports!(p, v) : null;
}

/** The part of CSSStyleDeclaration this needs, so a test can pass a fake. */
export interface StyleTarget {
	setProperty(name: string, value: string): void;
	removeProperty(name: string): string;
}

/**
 * Point the stylesheet at the stored colour, or back at the theme.
 *
 * Removing the property rather than setting it to the theme variable keeps
 * the fallback in one place (styles.css) and leaves nothing behind on unload.
 */
export function applySentenceHighlightColour(style: StyleTarget, stored: string): void {
	const value = highlightCssValue(stored);
	if (value === null) style.removeProperty(SENTENCE_HIGHLIGHT_VAR);
	else style.setProperty(SENTENCE_HIGHLIGHT_VAR, value);
}

export function applyWordHighlightColour(style: StyleTarget, stored: string): void {
	const value = highlightCssValue(stored);
	if (value === null) style.removeProperty(WORD_HIGHLIGHT_VAR);
	else style.setProperty(WORD_HIGHLIGHT_VAR, value);
}
