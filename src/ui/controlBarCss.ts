/*
 * The two names the floating control bar and styles.css have to agree on.
 *
 * No obsidian and no DOM import, for the same reason highlightColour.ts has
 * none: `src/ui/controlBar.ts` imports `obsidian` at line 1 and therefore has
 * no runtime in the bare-Node suite at all, so nothing about the bar's
 * behaviour is testable. Holding the two strings here recovers the one part
 * that is - that the TypeScript writing them and the stylesheet reading them
 * cannot drift by a character and silently produce no padding. That is exactly
 * why SENTENCE_HIGHLIGHT_VAR and WORD_HIGHLIGHT_VAR live in their own module
 * and are pinned against styles.css by block 12 of tests/highlight.test.ts.
 *
 * See docs/adr/0032 (NRL-112, amended by NRL-129).
 */

/**
 * Set on `document.body` for exactly as long as the bar is shown.
 *
 * Named for what it tracks - the bar element's own `.is-visible` - rather than
 * a bare `is-visible`, which on `document.body` would say nothing about what is
 * visible. `local-tts-` is the prefix every other class in styles.css uses.
 *
 * styles.css uses it to reserve the band the bar occupies at the top of the
 * mobile editor pane, because the bar is `position: fixed` and so out of flow:
 * it cannot push content down by itself, and on a note too short to scroll
 * there is nowhere for the auto-scroll to move the spoken sentence to (NRL-129).
 */
export const CONTROL_BAR_VISIBLE_CLASS = "local-tts-control-bar-visible";

/**
 * The bar's measured height, published by `controlBar.ts` for styles.css.
 *
 * Measured and published rather than derived in CSS, because the bar's height
 * depends on how many rows `flex-wrap` produced, and a CSS expression cannot
 * ask that - it would have to freeze a row count, which is wrong on a narrower
 * phone (under-pads, so the defect partly returns) and on a tablet
 * (over-pads). docs/adr/0032's NRL-129 amendment records the trade.
 */
export const CONTROL_BAR_HEIGHT_VAR = "--local-tts-control-bar-height";
