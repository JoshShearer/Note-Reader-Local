import type { BlockType, SpeechChunk } from "../audio/types";
// words.ts imports nothing but its own types, so this edge adds no node builtin
// and no new entry to main.js's require() list (non-negotiable 7).
import { findWords, hasCjkScript } from "../audio/words";
import {
	type SegmenterSource,
	graphemeBoundaries,
	platformSegmenters,
	sentenceBoundaries,
	wordBoundaries,
} from "./segment";

/**
 * Markdown to speakable text, preserving a mapping back to source offsets.
 *
 * Highlighting has to land on characters the user can actually see, so every
 * character we keep records where it came from. Stripping syntax therefore
 * costs us a parallel index array rather than correctness.
 */

const MAX_CHUNK_CHARS = 220;
const MIN_CHUNK_CHARS = 40;

const EMOJI =
	/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

type CommentCloser = "-->" | "%%";

interface Cleaned {
	text: string;
	/** index[i] is the raw markdown offset that produced text[i]. */
	index: number[];
	/**
	 * The line opened a comment it did not close. extractChunks hides
	 * the following lines until this delimiter. Only meaningful for a top-level
	 * line, not a re-cleaned link label.
	 */
	openComment?: CommentCloser;
	/**
	 * Length of the code span still open at the end of the line: either a run
	 * opened here that nothing on the line closes, or one carried in that this
	 * line does not close either. A later line may close it (CommonMark lets a
	 * code span cross a soft line break), in which case the text between is
	 * literal code. Only
	 * extractChunks may act on this, and only after confirming a closer
	 * exists: an unmatched run is just literal text, and treating it as an
	 * open span would stop a real `%%` block opener on the next line being
	 * recognised, which would read hidden text aloud. Only meaningful for a
	 * top-level line, not a re-cleaned link label.
	 */
	openCode?: number;
	/**
	 * A CONFIRMED markdown image or link label, carried in from an earlier line
	 * and still open at the end of this one. extractChunks hands it straight to
	 * the next line; the confirmation was made where the label opened and is
	 * monotone, so it is not re-asked (NRL-63).
	 */
	openBracket?: BracketKind;
	/**
	 * The FIRST `![` or `[` on this line whose `]` is missing. Unconfirmed, and
	 * therefore not yet acted on: exactly like `openCode`, only extractChunks may
	 * act on it and only after `bracketClosesLater` has found the closing `](` or
	 * `][`. An unmatched `[` is ordinary text, and treating it as a label would
	 * silence visible prose. Only meaningful for a top-level line, not a
	 * re-cleaned label.
	 */
	unclosedBracket?: BracketKind;
	/**
	 * How many inner `[` opened inside a CONFIRMED carried label are still
	 * waiting for their `]` at the end of this line. Handed on beside
	 * `openBracket` so the next line's scan resumes where this one stopped,
	 * which is what lets a bracket pair straddle a soft line break (NRL-88).
	 * 0 unless one does.
	 */
	openBracketDepth?: number;
}

/**
 * Which construct a soft-wrapped label belongs to. The two differ in exactly one
 * way - an image's label is governed by `speakImageAlt` and a link's is always
 * spoken - and in nothing else, which is why one carry covers both (NRL-63).
 */
type BracketKind = "image" | "link";

function isWordChar(ch: string): boolean {
	return /[\p{L}\p{N}'’-]/u.test(ch);
}

/** Letters and digits only: what makes an underscore intraword. */
const isAlnum = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isSpaceOrEdge = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * Inline HTML tag. Two guards stop prose in angle brackets being eaten as a
 * tag, which would silently drop words:
 *
 * - The element name must be in a whitelist, because `x<y and z>w` is
 *   otherwise a tag named "y", and comparisons are far more common in notes
 *   than unknown elements.
 * - Every attribute must be HTML-shaped: `name="v"`, `name='v'` or
 *   `name=v` with no space, or a bare name only when it is a known boolean
 *   attribute. Without this, `a <b and c> d` is a `<b>` tag with bare
 *   attributes "and" and "c" and reads "a d". Anything else is left as text:
 *   leaked markup costs less than a lost sentence.
 */
const BOOLEAN_ATTRIBUTES = [
	"hidden", "open", "disabled", "checked", "selected", "readonly", "required", "multiple",
	"autofocus", "novalidate", "reversed", "nowrap", "compact", "inert", "itemscope",
	"controls", "autoplay", "loop", "muted", "async", "defer",
];
const HTML_ATTRIBUTE =
	`(?:[A-Za-z_:][-A-Za-z0-9_:.]*=(?:"[^"]*"|'[^']*'|[^\\s"'=<>\`]+)` +
	`|(?:${BOOLEAN_ATTRIBUTES.join("|")})(?=[\\s/>]))`;
const HTML_TAG = new RegExp(`^<\\/?([A-Za-z][A-Za-z0-9]*)(?:\\s+${HTML_ATTRIBUTE})*\\s*\\/?>`, "i");
const INLINE_ELEMENTS = new Set([
	"b", "i", "u", "s", "em", "strong", "mark", "sub", "sup", "small", "big", "span", "font",
	"a", "abbr", "kbd", "del", "ins", "q", "cite", "code",
]);
/** Elements that break the flow of text, so they separate the words either side. */
const BREAKING_ELEMENTS = new Set(["br", "hr", "p", "div", "img", "center", "details", "summary"]);

/**
 * CommonMark autolinks. Obsidian renders `<https://x.com>` and
 * `<me@example.com>` as a plain link with no brackets, so the brackets are
 * markup and are never spoken; the content follows the bare-URL rule of
 * docs/adr/0003. See docs/adr/0007 for why these are matched here rather
 * than left to the HTML and bare-URL branches.
 *
 * Both patterns are anchored at the cursor and forbid whitespace, `<` and
 * `>` inside, which is what leaves `a < b` and `x<y and z>w` alone, and both
 * require a complete closing `>` on the same line.
 *
 * The URI scheme is 2 to 32 characters, as CommonMark requires. A
 * one-character scheme would make `x<y://z>w` an autolink here while Obsidian
 * renders it literally, so the text would be deleted from the speech and the
 * join between `x` and `w` lost with it.
 *
 * The email form additionally requires a domain with at least one dot. That
 * is positive evidence of a real address, so `<a@b>` stays text: the same
 * trade the HTML element whitelist makes, where leaked markup costs less
 * than a swallowed word. The local part excludes `/`, `?` and `#`, which
 * would otherwise be read as the end of the authority when the host is
 * reduced.
 */
const AUTOLINK_URI = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/[^\s<>]+>/;
const AUTOLINK_EMAIL =
	/^<(?:mailto:)?[A-Za-z0-9!$%&'*+=^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+>/i;

/**
 * Half-open offsets of the speakable host inside `url`, or an empty span when
 * there is nothing to say. There is no full-address fallback at any call
 * site: an empty span means silence.
 *
 * Userinfo (`user:secret@`) is credentials and must never be read aloud. The
 * authority ends at the first "/", "?" or "#"; the host starts after the last
 * "@" before that, since a password may itself contain "@". An "@" in a path
 * or query is not userinfo and is left alone.
 *
 * The scheme prefix is generic rather than http-only so `<ftp://...>` reduces
 * by the same rule. It is anchored and needs "://", so a bare `www.` host and
 * a bare `addr@host` both leave it empty and start the authority at 0, which
 * is why the email forms need no special case: the last "@" of the whole
 * string already lands on the domain, for `mailto:` too.
 */
function hostSpan(url: string): { start: number; end: number } {
	const scheme = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?/.exec(url)![0].length;
	const authEnd = url.slice(scheme).search(/[/?#]/);
	const authority = url.slice(scheme, authEnd === -1 ? url.length : scheme + authEnd);
	const at = authority.lastIndexOf("@");
	const hostStart = at === -1 ? scheme : scheme + at + 1;
	const start = hostStart + /^(?:www\.)?/i.exec(url.slice(hostStart))![0].length;
	let end = start;
	while (end < url.length && /[\p{L}\p{N}.-]/u.test(url[end]!)) end += 1;
	// A sentence period glued to the URL ("see https://x.com.") would
	// otherwise be read as part of the host.
	while (end > start && /[.-]/.test(url[end - 1]!)) end -= 1;
	return { start, end };
}

const FOOTNOTE_REF = /^\[\^[^\]\s]+\]/;

/**
 * An embed alias that is display sizing rather than prose: `200` or `200x100`.
 * Obsidian reads those as pixel dimensions, so they are layout and say nothing.
 */
const EMBED_SIZING_ALIAS = /^\d+(?:[xX]\d+)?$/;

/**
 * Does an embed target name a file rather than a note?
 *
 * `![[pic.png]]` and `![[report.pdf]]` transclude content this module cannot
 * reach, and their target is a destination, not prose: an image path must never
 * be read aloud (R-M09). So for those only a meaningful alias is speakable,
 * which is also where Obsidian puts an image embed's alt text. A note target
 * (`![[Some Note]]`, `![[Some Note.md]]`) is a title the author wrote, and
 * reduces exactly as a wikilink target does.
 *
 * The test is deliberately crude: a dot anywhere in the final path segment
 * means a file unless what follows the LAST dot is `md` or `markdown`. No list
 * of media types, no cap on the extension's length and no alphanumeric-only
 * restriction, because every one of those is a way for a filename to slip
 * through and be read aloud. An earlier version tested
 * `/\.([A-Za-z0-9]{1,8})$/`, which spoke `document.webmanifest` and
 * `archive.tar-gz` verbatim - the one direction ADR 0008 clause 5 says this
 * must not fail in, since silence on a filename is recoverable and reading out
 * a path is what R-M09 forbids.
 *
 * The cost is accepted on purpose: a note whose *title* holds a dot
 * (`![[Version 1.2 notes]]`) is classified as a file and an embed of it says
 * nothing, with an alias as the way to speak it. A `[[wikilink]]` to the same
 * note is unaffected, because only an embed classifies its target.
 *
 * A target with no dot at all is a note name and is spoken: an extensionless
 * file (`![[Dockerfile]]`) is indistinguishable from a note title, and
 * silencing every dotless target would break the wikilink parity srs.md
 * promises for a note embed.
 *
 * Classification trims, emission does not, so a stray space inside the
 * brackets cannot turn `![[Some Note.md ]]` into a file.
 *
 * The final segment ends at the last separator of EITHER kind, `/` or `\`, so a
 * Windows-style target is split the same way a vault-relative one is (ADR 0017).
 * That moves one shape in the DISCLOSING direction, which is the direction ADR
 * 0008 clause 5 says this must not fail in, so it is recorded here rather than
 * left to be discovered: `![[C:\v1.2\Note]]` used to have `C:\v1.2\Note` as its
 * whole "final segment", the last dot put `2\Note` after it, and the target was
 * classified a file and silenced. Splitting on `\` makes the leaf `Note`, which
 * has no dot, so the target is now a note and IS spoken. It is only acceptable
 * because emitWikiLabel reduces the label to that same final segment in the same
 * change: what becomes newly spoken is `Note`, never the drive or the folder.
 * The two must land together, and a probe over the whole target matrix in all
 * 512 option combinations confirmed the reclassification set is exactly the
 * targets whose only dot lives in a backslash-separated non-final segment.
 *
 * It classifies whatever finalSegment() will SPEAK, never a different slice of
 * the target. The first cut of this change split here and in emitWikiLabel
 * separately, and the probe caught them disagreeing: for `![[f\pic.png\#Head]]`
 * this saw the empty segment after the trailing `\`, called it a note, and the
 * label's own trailing-separator fallback then said `pic.png` - a filename newly
 * spoken where the base was silent. One shared helper makes that class of
 * disagreement unrepresentable rather than merely fixed.
 */
function isFileTarget(target: string): boolean {
	const path = target.split("#")[0]!;
	const name = finalSegment(path).text.trim();
	const dot = name.lastIndexOf(".");
	return dot !== -1 && !/^(?:md|markdown)$/i.test(name.slice(dot + 1));
}

/**
 * The part of a path that is a name rather than folder structure: everything
 * after the last separator, where both `/` and `\` count (see isFileTarget).
 *
 * A trailing separator leaves that empty, so it falls back to the last non-empty
 * segment - `folder/sub/` is a reference to `sub`, not to nothing. A path that is
 * nothing but separators has no name at all and yields the empty string.
 *
 * `start` is the offset of `text` within `path`, which is what lets the caller
 * emit each character at its true raw offset (AGENTS.md rule 8).
 */
function finalSegment(path: string): { start: number; text: string } {
	let text = path;
	let start = 0;
	for (;;) {
		const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
		if (cut === -1) return { start, text };
		if (cut === text.length - 1) {
			// A trailing separator: drop it and look again for a real name.
			text = text.slice(0, cut);
			continue;
		}
		return { start: start + cut + 1, text: text.slice(cut + 1) };
	}
}

/**
 * The comment spans inside a link target, as half-open raw ranges that include
 * both delimiters, in order and never overlapping.
 *
 * A `[[wikilink]]` target is emitted raw rather than re-cleaned, so
 * `cleanLine`'s comment branch never runs on it and a `%%...%%` or `<!-- -->`
 * written inside the brackets used to be spoken, markers and all - a disclosure
 * of text the author hid (NRL-67, R-M08, docs/adr/0021). This is the smallest
 * thing that can undo that without touching the emission itself: the caller
 * skips these ranges by advancing its own index, so every surviving character
 * is still emitted at its own raw offset and `sourceIndex` stays in lockstep by
 * construction rather than by a second check (AGENTS.md rule 8).
 *
 * Comments do not nest and the two delimiter kinds cannot close each other's
 * spans (ADR 0006 clause 3). An UNMATCHED opener runs to `to` and no further.
 * The result is a local array and `openComment` is never assigned from here, so
 * a comment opened inside brackets can never consume a later source line
 * (ADR 0006 clause 5). Silencing it at all is a deliberate divergence from
 * clause 2's rule that an unmatched INLINE opener stays literal: what it
 * silences here is a path fragment bounded by the closing bracket rather than
 * prose, so the visible-text loss clause 2 weighs is bounded to one target
 * while the disclosure it would otherwise allow is not.
 *
 * `from` is the start of the whole target, NOT of the segment that will be
 * spoken, and both halves of that were measured rather than reasoned. It starts
 * at the target because `[[a%%/%%b]]` reduces to the final segment `%%b`, so a
 * segment-local scan would open on that CLOSING `%%`, call it unmatched and
 * silence the visible `b`. It ends at the target rather than at the `#` because
 * the heading fragment leaks too: `[[a/b#Section%%x%%]]` spoke `b Section%%x%%`.
 */
function commentSpans(raw: string, from: number, to: number): Array<{ start: number; end: number }> {
	const spans: Array<{ start: number; end: number }> = [];
	for (let i = from; i < to; i++) {
		const html = raw.startsWith("<!--", i);
		if (!html && !raw.startsWith("%%", i)) continue;
		const closer: CommentCloser = html ? "-->" : "%%";
		const close = raw.indexOf(closer, i + (html ? 4 : 2));
		// A closer found past the target is no closer: the span is unmatched
		// here and stops at the bracket, never reaching into the rest of the line.
		const end = close === -1 || close >= to ? to : Math.min(close + closer.length, to);
		spans.push({ start: i, end });
		i = end - 1;
	}
	return spans;
}

/**
 * Start of a bare URL. One definition, shared by the bare-URL branch in prose
 * and by the URL rule for a link target, so the two cannot drift apart into
 * disagreeing about what a URL is.
 */
const BARE_URL_START = /^(https?:\/\/|www\.)/i;

/**
 * Math is spoken as the single word "equation" (docs/adr/0004).
 *
 * Size rule: display math (`$$...$$`) always says "equation". Inline math
 * (`$...$`) says it only when the span has 4 or more tokens, where a `\name`
 * command is one token and each other non-space, non-brace character is one.
 * A span of 3 or fewer (`$x$`, `$x_1$`, `$\alpha$`) is dropped, because a
 * maths-heavy note otherwise says "equation" after every symbol.
 */
const INLINE_MATH_MIN_TOKENS = 4;
const MATH_TOKEN = /\\[A-Za-z]+|\\.|[^\s{}]/g;
/** Characters that are evidence of LaTeX rather than a price. */
const LATEX_SHAPE = /[\\^_{}=+<>]/;

/**
 * Where an inline `$` span closes, or -1 if the `$` at `open` is not math.
 *
 * Currency heuristic: `$` is a price far more often than it is maths, and
 * reading "I paid equation later" eats a sentence, which is worse than
 * reading a symbol. So a span needs positive evidence: no space after the
 * opening `$`, a closing `$` on the same line with no space before it and no
 * digit after it (`$5-$10`), and LaTeX-shaped content or a single letter
 * (`$5$` stays text). When in doubt it is left as text.
 */
function inlineMathClose(raw: string, open: number): number {
	if (isSpaceOrEdge(raw[open + 1]) || raw[open + 1] === "$") return -1;
	let close = open + 1;
	while (close < raw.length && !(raw[close] === "$" && raw[close - 1] !== "\\")) close += 1;
	if (close >= raw.length) return -1;
	if (/\s/.test(raw[close - 1]!) || /\d/.test(raw[close + 1] ?? "")) return -1;
	const content = raw.slice(open + 1, close);
	if (!LATEX_SHAPE.test(content) && !/^\p{L}$/u.test(content)) return -1;
	return close;
}

/** Offset of the first backtick run of exactly `len` at or after `from`, or -1. */
function firstRunOfLength(raw: string, len: number, from: number): number {
	let next = from;
	while ((next = raw.indexOf("`", next)) !== -1) {
		let end = next + 1;
		while (raw[end] === "`") end += 1;
		if (end - next === len) return next;
		next = end;
	}
	return -1;
}

/** A code span closes on a run of the same length, not on an inner backtick. */
function inlineCodeBounds(raw: string, open: number): { start: number; close: number; end: number } {
	let start = open + 1;
	while (raw[start] === "`") start += 1;
	const len = start - open;
	const close = firstRunOfLength(raw, len, start);
	if (close === -1) return { start, close: -1, end: start };
	return { start, close, end: close + len };
}

/**
 * A hidden or literal delimiter cannot end its enclosing label/highlight.
 * Otherwise recursive cleaning sees half a comment and speaks the other half.
 * Unclosed comments remain local to the label, as in cleanLine.
 */
function inlineContainerClose(raw: string, from: number, delimiter: string): number {
	let i = from;
	while (i < raw.length) {
		if (raw[i] === "\\") {
			i += 2;
			continue;
		}
		if (raw[i] === "`") {
			i = inlineCodeBounds(raw, i).end;
			continue;
		}
		const html = raw.startsWith("<!--", i);
		if (html || raw.startsWith("%%", i)) {
			const closer = html ? "-->" : "%%";
			const close = raw.indexOf(closer, i + (html ? 4 : 2));
			if (close !== -1) {
				i = close + closer.length;
				continue;
			}
		}
		if (raw.startsWith(delimiter, i)) return i;
		i += 1;
	}
	return -1;
}

/**
 * Where a `[[wikilink]]` or `![[embed]]` target closes, or -1 if it does not
 * close on this line.
 *
 * A near-copy of inlineContainerClose, and the one difference is the whole
 * reason it exists: this does NOT honour `\` as an escape. A target ending in a
 * backslash puts `\]]` on the line; the shared helper ate the `\]`, never found
 * a `]]`, and the construct fell through to prose with its vault path intact -
 * so `[[private/folder/Note\]]` read the folder segments aloud, which is the
 * one thing R-M09 and ADR 0017 promise it will not (NRL-66). Recognising it
 * instead needs no new reduction code at all: `finalSegment` already steps back
 * over a trailing separator and the emission loop already drops it.
 *
 * Inside a wikilink target a backslash is a path separator far more often than
 * an escape - isFileTarget and finalSegment both already split on it - so this
 * is not a parameter on the shared helper but a separate function, deliberately
 * local to these two branches. For a markdown image, link or highlight, `\]`
 * failing to close the label is CommonMark-correct, and their destination sits
 * after the `]` and is already dropped, so changing them would diverge from the
 * renderer for no privacy gain.
 *
 * Code spans and complete comment spans are skipped exactly as
 * inlineContainerClose skips them: a `]]` that is hidden or literal cannot end
 * the target.
 */
function wikiTargetClose(raw: string, from: number): number {
	let i = from;
	while (i < raw.length) {
		if (raw[i] === "`") {
			i = inlineCodeBounds(raw, i).end;
			continue;
		}
		const html = raw.startsWith("<!--", i);
		if (html || raw.startsWith("%%", i)) {
			const closer = html ? "-->" : "%%";
			const close = raw.indexOf(closer, i + (html ? 4 : 2));
			if (close !== -1) {
				i = close + closer.length;
				continue;
			}
		}
		if (raw.startsWith("]]", i)) return i;
		i += 1;
	}
	return -1;
}

/**
 * Is the `%%` at `at` really an Obsidian block-comment opener?
 *
 * Two conditions, and the second is the one we used to miss (NRL-73). Obsidian's
 * `%%` tokenizer is a *block* tokenizer: it skips leading spaces, requires `%%`
 * at the block start, and then scans forward aborting on `if (37 === a) return`
 * where 37 is `%`. So a single further percent anywhere before the newline means
 * Obsidian never treats the line as a comment at all and renders it visibly.
 * Testing only the line-start half made `%% 50% off` silence every remaining
 * line of the note, which is prose loss rather than leaked markup - the failure
 * direction ADR 0007 clause 6 says to prefer the other way round, and a discount,
 * a battery level or a coverage figure is ordinary content rather than a corner
 * case.
 *
 * The forward scan deliberately has no escape awareness, because the tokenizer
 * it mirrors compares bytes to 37 and has none either: `%% 50\% off` is
 * displayed by Obsidian, so it must be spoken here (ADR 0006 clause 2, read out
 * of the installed obsidian.asar rather than observed live).
 *
 * One predicate rather than two call-site expressions because `cleanLine` and
 * `opensHiddenComment` are the same question asked from two places, and asking
 * it twice is exactly how the two drifted: `opensHiddenComment` matched
 * `cleanLine` on the line-start half and nothing has ever kept them in step.
 */
/**
 * Does a `<!--` at `at` open a document-level HTML comment block, rather than
 * being literal text?
 *
 * Two terms, and neither is sufficient alone. `<!--` begins its line (leading
 * whitespace allowed), OR some later line OF THE SAME PARAGRAPH carries `-->`.
 * Anything else - a mid-line `<!--` with no closer in its own paragraph - is
 * literal text that CommonMark renders and Obsidian displays, so it is spoken
 * (NRL-74, ADR 0025; term 2's paragraph bound is NRL-95).
 *
 * Deliberately a SECOND predicate rather than a widened opensObsidianBlock, and
 * the two bodies show why: `%%` carries the lone-`%` disqualifier and no
 * lookahead, `<!--` carries a lookahead and no disqualifier. Merging them would
 * import `if (37 === a) return` into `<!--`, which D-73-4, ADR 0006 clause 2 and
 * srs.md's `%%` bullet all forbid in as many words, and the NRL-66 precedent
 * says not to merge two scans that answer different questions.
 *
 * `closesLater` is handed in, never computed here: this function is line-local
 * and the second term is not. The two terms have DIFFERENT scopes and that is
 * the renderer's own asymmetry, not an inconsistency. Term 1 is module 8776's
 * HTML BLOCK rule, which really does walk to end of input once it has opened,
 * so it keeps its EOF scan. Term 2 has no block counterpart at all: a mid-line
 * `<!--` never reaches 8776, it reaches module 4839's inline `.T` regex applied
 * to ONE paragraph's inline text, so its closer must be in the same paragraph.
 * `closesLater` therefore arrives already bounded - see `endsTerm2Scan` and the
 * `htmlCloserAhead` pass in extractChunks (NRL-95, ADR 0025 decisions 3 and 4).
 */
function opensHtmlBlock(view: string, at: number, closesLater: boolean): boolean {
	return view.slice(0, at).trim() === "" || closesLater;
}

/**
 * `dedentedByList` is NRL-93's third term, and it is the renderer's own
 * context-sensitivity rather than a convenience. It says the lines of this
 * construct have ALREADY had their leading whitespace removed by the time
 * Obsidian's block tokenizers run, because they are the content of a list item:
 * module 745's `M` hands each item's value to module 5540's remove-indentation
 * with the item's own content indent, and module 6058 counts a tab as four
 * columns. `- item` / `\t%%` / `SECRET` therefore reaches the `%%` tokenizer as
 * `item` / `%%` / `SECRET`, so the tab is GONE and the block really does open.
 * When it is true the old any-whitespace test is kept, which is exactly the
 * pre-NRL-93 behaviour and is what stops this narrowing silencing a list item's
 * hidden text; `extractChunks`' `listDedented` pass decides it per line, and the
 * failure direction when the pass is unsure is `true`, i.e. hide.
 *
 * When it is false the lead must be at most three SPACES, and both halves of
 * that are the renderer's, read out of app.js in this session:
 *
 * - SPACES only. The `%%` block tokenizer's own skip loop is
 *   `for(var i=t.length,r=0;r<i&&32===t.charCodeAt(r);)r++;` - charCode 32, with
 *   no tab alternative. A tab-led `%%` is not an opener for it at all.
 * - At most THREE of them. The tokenizer has no cap of its own, but it never
 *   gets the line: module 8607's paragraph tokenizer skips the whole
 *   `interruptParagraph` check for a continuation line indented a tab or four
 *   or more columns (`if((h=t.charAt(c))===o){p=l;break}` ... `if(p>=l&&h!==a)
 *   {y=t.indexOf(a,y+1);continue}` with `l=4`), so such a line is absorbed as
 *   lazy prose and its `%%` falls to the anchored inline `/^%%(.*?)%%/`, which
 *   has no closer and is displayed. In a FRESH block position the same four
 *   columns are indented code instead - `blockMethods` runs `indentedCode`
 *   before `comment`, and module 134 opens on one tab - which `extractChunks`'
 *   own INDENTED_CODE branch already handles before this predicate is reached.
 *   Either way four columns is not a comment opener.
 *
 * Note that no tab can survive the cap: module 6058 advances a tab to the next
 * multiple of four, so any lead containing one is at least four columns, which
 * is why one spaces-only scan plus a length test covers both halves.
 *
 * The one guarantee this predicate offers unconditionally, and the only one worth
 * relying on, is STRUCTURAL: it can decline an opener the pre-NRL-93 rule
 * accepted, and it can never accept one the pre-NRL-93 rule declined. Both added
 * terms are conjunctive refusals in front of a body that is otherwise the old
 * `trim() === ""` test, so `opensObsidianBlock(view, at, d)` implies the old
 * `view.slice(0, at).trim() === "" && view.indexOf("%", at + 2) === -1` for every
 * argument triple. Proved exhaustively rather than sampled: 0 violations over
 * 263,672 triples spanning every string over {space, tab, `%`, `x`, `>`} up to
 * length 6 with every `at` in range and both values of `dedentedByList`, with a
 * deliberately widened variant giving 575 violations on a 7,422-triple subset to
 * show the check can fail. Note what that does NOT say: it bounds the direction
 * this predicate can move, and it says nothing about `listDedented`'s own
 * approximations, which is where NRL-93's Verify pass found a real disclosure.
 */
function opensObsidianBlock(view: string, at: number, dedentedByList: boolean): boolean {
	if (view.indexOf("%", at + 2) !== -1) return false;
	if (dedentedByList) return view.slice(0, at).trim() === "";
	if (at > 3) return false;
	for (let k = 0; k < at; k++) if (view.charCodeAt(k) !== 32) return false;
	return true;
}

/**
 * Strip inline markdown from a single line, recording source offsets.
 *
 * `incomingCode` is the length of a backtick run opened on an earlier line
 * that extractChunks has already confirmed a later line closes. Everything
 * before that closing run on this line is code content, so a comment
 * delimiter in it is literal text rather than a comment, exactly as it
 * already is inside a single-line span.
 *
 * `outgoingCode` is the mirror of it, and it is what makes the OPENING line of
 * a soft-wrapped span behave like every other line of that span (NRL-64). It is
 * the length of the first unmatched run ON THIS LINE that extractChunks has
 * already confirmed a later line closes, so everything after that run is code
 * content too. It is a second pass: extractChunks cleans the line once to learn
 * the run length, asks codeSpanClosesLater, and only then re-cleans with the
 * answer. cleanLine therefore stays line-local - it is handed one scalar, not a
 * lookahead into the document.
 *
 * `incomingBracket` and `outgoingBracket` are the second confirmed-carry kind,
 * and they attach at exactly the site NRL-64 built for one (NRL-63). They are
 * the same two halves seen from either end: `incomingBracket` says this line
 * starts inside a markdown image or link label opened earlier, and
 * `outgoingBracket` says the `![`/`[` this line leaves unmatched really is a
 * label that a later line closes. Both are confirmed by extractChunks before
 * cleanLine is told, for the same reason the code carry is - an unmatched `[`
 * is ordinary text, and acting on it unconfirmed would silence visible prose.
 *
 * The two carries are mutually exclusive for the NEXT line, and the rule is
 * "whichever opened first keeps the carry". A code span binds tighter than a
 * label in CommonMark, so when both open on one line the code carry wins and no
 * label carry is armed; while a label carry is live, it holds and no code carry
 * is armed inside it. Consequence, measured and recorded in ADR 0023: an image
 * whose label contains a soft-wrapped code span still speaks its destination.
 *
 * `htmlClosesLater` is the third scalar of this kind and the only one that is
 * not a confirmed carry (NRL-74, ADR 0025). It says "some line AFTER this one
 * carries `-->`", which is the document-scoped half of the HTML-comment block
 * rule that no line can answer about itself. It mirrors `outgoingCode` and
 * `outgoingBracket` in SHAPE - one scalar computed by extractChunks and handed
 * in, never a lookahead callback, so cleanLine stays line-local - but not in
 * TIMING: it asks nothing about this line, so it is known before the first pass
 * and adds no pass. It defaults false, the fail-toward-hiding direction, which
 * is what the recursive-label and frontmatter call sites want.
 *
 * `dedentedByList` is the same shape again and is `opensObsidianBlock`'s third
 * term (NRL-93): this line is the content of a list item, so Obsidian removed its
 * leading whitespace before any block tokenizer saw it. It reaches only the `%%`
 * branch, and only behind `blockComments`, so the five recursive label call sites
 * and the frontmatter one never consult it and its default is immaterial to them;
 * it is defaulted rather than required because those six sites would otherwise
 * each have to state an answer to a question they do not ask.
 */
function cleanLine(
	raw: string,
	rawStart: number,
	opts: StripOptions,
	blockComments = false,
	incomingCode?: number,
	outgoingCode?: number,
	incomingBracket?: BracketKind,
	outgoingBracket?: BracketKind,
	htmlClosesLater = false,
	incomingBracketDepth = 0,
	dedentedByList = false,
): Cleaned {
	const chars: string[] = [];
	const index: number[] = [];

	// Where the carried code span closes on this line, and how far the literal
	// region reaches. -1 for closerRun means the span continues past this line,
	// so the whole line is literal; literalCodeEnd of -1 means no carried span
	// at all, and every `i >= literalCodeEnd` test below is then vacuously true.
	// A carried span is honoured in BOTH toggle positions (NRL-44, ADR 0019):
	// under skipInlineCode the region is silenced whole, which is what the
	// toggle's name says and what a single-line span already does, and it is the
	// safe direction - a silenced region cannot disclose anything.
	const carrying = incomingCode !== undefined;
	const closerRun = carrying ? firstRunOfLength(raw, incomingCode!, 0) : -1;
	const literalCodeEnd = !carrying ? -1 : closerRun === -1 ? raw.length : closerRun;

	const emit = (ch: string, srcOffset: number): void => {
		chars.push(ch);
		index.push(srcOffset);
	};

	/**
	 * Dropped syntax leaves a gap; record exactly one space for it so words
	 * either side do not run together. chars and index must stay in lockstep.
	 */
	const pushSpace = (at: number): void => {
		if (chars.length > 0 && chars[chars.length - 1] !== " ") {
			emit(" ", at);
		}
	};

	/**
	 * "equation" is synthetic, so it has no raw character of its own. Its
	 * first seven letters map to the opening `$` and the last to the final
	 * closing `$`, which makes the word highlight exactly the math span and
	 * keeps the index non-decreasing.
	 */
	const emitEquation = (open: number, lastDollar: number): void => {
		pushSpace(open);
		const word = "equation";
		for (let k = 0; k < word.length - 1; k++) emit(word[k]!, open);
		emit(word[word.length - 1]!, lastDollar);
	};

	/**
	 * The spoken label of a `[[wikilink]]` or `![[embed]]`, given the offsets of
	 * the content between the brackets.
	 *
	 * Shared by both constructs so a target reduces the same way in each; the
	 * unchanged `[[` branch is what keeps this honest. An embed differs in two
	 * ways only, and both are about not speaking layout or paths: a numeric
	 * alias is pixel sizing, and a file target is a destination.
	 */
	const emitWikiLabel = (innerStart: number, close: number, isEmbed: boolean): void => {
		const pipe = raw.indexOf("|", innerStart);
		const hasPipe = pipe !== -1 && pipe < close;
		const alias = hasPipe ? raw.slice(pipe + 1, close) : "";
		const useAlias =
			hasPipe && alias.trim() !== "" && !(isEmbed && EMBED_SIZING_ALIAS.test(alias.trim()));
		if (useAlias) {
			// The alias is display text the author wrote, so nested markup in
			// it is stripped the same way as a markdown link label.
			const inner = cleanLine(alias, rawStart + pipe + 1, opts);
			for (let k = 0; k < inner.text.length; k++) {
				emit(inner.text[k]!, inner.index[k] ?? rawStart + pipe + 1);
			}
			return;
		}
		const targetEnd = hasPipe ? pipe : close;
		if (isEmbed && isFileTarget(raw.slice(innerStart, targetEnd))) return;
		// Only the part before `#` is a path, so only that part is reduced -
		// the same split isFileTarget makes. What follows is a heading or a
		// block id and its handling below is unchanged.
		const hash = raw.indexOf("#", innerStart);
		const pathEnd = hash !== -1 && hash < targetEnd ? hash : targetEnd;
		const path = raw.slice(innerStart, pathEnd);

		// A URL target has no meaningful final segment, so it reduces by the one
		// destination rule this repo already wrote down: hostSpan, exactly as a
		// bare URL in prose does (docs/adr/0003). Unconditional, NOT gated on
		// opts.speakUrls, because a wikilink label is spoken regardless of that
		// setting - the reduction is what keeps the path and the userinfo out of
		// the speech, and gating it would put them back. Any `#fragment` is
		// suppressed rather than read as a pause: a fragment is destination-
		// shaped for the same reason the path is (ADR 0017).
		const lead = path.length - path.trimStart().length;
		const trimmedPath = path.trim();
		if (BARE_URL_START.test(trimmedPath)) {
			const host = hostSpan(trimmedPath);
			for (let k = host.start; k < host.end; k++) {
				emit(trimmedPath[k]!, rawStart + innerStart + lead + k);
			}
			return;
		}

		// Otherwise the label is the final path segment only: the segments above
		// it are vault folder structure, which is a destination and must never be
		// read aloud (R-M09, ADR 0017). The same finalSegment() the embed guard
		// classified with, so the two can never disagree about which part of the
		// target is a name. The dropped prefix needs no space of its own - both
		// call sites pushSpace before the label, so the words either side are
		// already separated.
		const seg = finalSegment(path);
		const segStart = innerStart + seg.start;
		const segEnd = segStart + seg.text.length;

		// A comment span inside the target is hidden text and is never spoken,
		// delimiters included (NRL-67, ADR 0021). It is scanned over the WHOLE
		// target - see commentSpans for why not the segment, and why not just
		// the path - and skipped from inside the emission loop below rather than
		// by cleaning the target first, so nothing about the raw emission, and
		// so nothing about sourceIndex, changes. Classification above stays on
		// the RAW target on purpose (ADR 0021 decision Q4): on a stripped view
		// `![[a/b%%x.y%%]]` would lose its dot, become a note and START
		// speaking, and a silent-to-spoken move is the one direction ADR 0008
		// clause 5 forbids. Keeping it raw means this can only ever remove
		// spoken characters.
		const hidden = commentSpans(raw, innerStart, targetEnd);
		let nextSpan = 0;

		// `#^id` is a block id, opaque and unspeakable, and it ends the label.
		// WHERE it ends is decided on the RAW target, for the same reason
		// isFileTarget and finalSegment are (ADR 0021 decision 5): a `#^`
		// written inside a comment span still ends the label. Letting the span
		// skip below hide it instead would make the tail after the span audible
		// where the previous behaviour silenced it - `[[a/b%%x#^%%SECRET]]` said
		// `b%%x` and would say `bSECRET` - and this exclusion must only ever be
		// able to remove spoken characters, never to add one.
		const blockId = raw.indexOf("#^", segStart);
		const labelEnd = blockId !== -1 && blockId < targetEnd ? blockId : targetEnd;

		// The target is a path, not prose, so it is emitted directly rather
		// than re-cleaned: the tag branch would otherwise eat `#Section`
		// when stripTags is on. A `#` separates note from heading and is
		// read as a pause.
		for (let k = segStart; k < labelEnd; k++) {
			// The trailing separator run finalSegment() stepped back over.
			if (k >= segEnd && k < pathEnd) continue;
			// `k` only ever increases, and the spans are in order, so one
			// forward pointer is enough to place it.
			while (nextSpan < hidden.length && hidden[nextSpan]!.end <= k) nextSpan += 1;
			const span = hidden[nextSpan];
			if (span !== undefined && k >= span.start) {
				// Nothing is emitted and no space is pushed: both call sites
				// already pushSpace either side of the label.
				k = span.end - 1;
				continue;
			}
			const c = raw[k]!;
			if (c === "#" || /\s/.test(c)) pushSpace(rawStart + k);
			else emit(c, rawStart + k);
		}
	};

	/**
	 * A confirmed code span's literal region, `[from, to)`.
	 *
	 * One emitter, two call sites, because the two halves of a soft-wrapped span
	 * are the same rule seen from either end: `[0, literalCodeEnd)` for a span
	 * carried IN from an earlier line, and `[runEnd, raw.length)` for one opened
	 * on this line and carried OUT (NRL-64). Keeping it in one place is what
	 * makes those two provably identical rather than merely similar, and it is
	 * where a third confirmed-carry kind would attach.
	 */
	const emitLiteralRegion = (from: number, to: number): void => {
		if (opts.skipInlineCode) {
			// Silenced whole. Exactly one space for the gap, the same shape as the
			// unmatched-run drop below, so the words either side do not run
			// together and never double up.
			pushSpace(rawStart + to);
			return;
		}
		// verbatimLine's emit rule, applied here rather than by calling
		// verbatimLine: that function pops its own trailing space for the
		// paragraph join, which is wrong mid-line. Each whitespace RUN
		// collapses to one mapped space carrying the offset of the run's first
		// character, which is what keeps the index non-decreasing.
		for (let k = from; k < to; k++) {
			const c = raw[k]!;
			if (/\s/.test(c)) pushSpace(rawStart + k);
			else emit(c, rawStart + k);
		}
	};

	/**
	 * A confirmed image or link label's content, `[from, to)`.
	 *
	 * The mirror of emitLiteralRegion, and deliberately the same shape: one
	 * emitter, called from the label's opening line and from every continuation
	 * line, so the two halves of a soft-wrapped label are provably the same rule
	 * rather than merely similar (NRL-63).
	 *
	 * Label content is re-cleaned rather than emitted raw, exactly as the
	 * single-line image and link branches already re-clean theirs, so nested
	 * markup, escapes and complete comment spans inside a soft-wrapped label go
	 * through the existing recursion rather than a second implementation. The
	 * recursion is line-local: it is handed a slice with its true rawStart and
	 * its openComment/openCode are discarded, which is what stops a label opening
	 * a document-level comment.
	 *
	 * The silenced branch emits no space of its own. Every call site already
	 * pushSpace's either side of the label, and a space mapped at `to` would be
	 * `raw.length` at end of line, which is not an offset in this line.
	 */
	const emitLabelRegion = (from: number, to: number, kind: BracketKind): void => {
		if (kind === "image" && !opts.speakImageAlt) return;
		pushSpace(rawStart + from);
		const inner = cleanLine(raw.slice(from, to), rawStart + from, opts);
		for (let k = 0; k < inner.text.length; k++) {
			emit(inner.text[k]!, inner.index[k] ?? rawStart + from);
		}
	};

	let openComment: CommentCloser | undefined;
	// A carried span that this line does not close stays open, so a span may
	// cross several soft line breaks. It owns the carry ahead of any run opened
	// on this line, being the outer and earlier opener.
	let openCode: number | undefined = carrying && closerRun === -1 ? incomingCode : undefined;
	// The label carry's two halves. `openBracket` is only ever set from a
	// CONFIRMED label - one carried in, or one this line opens and outgoingBracket
	// has already confirmed - so extractChunks can hand it on without re-asking.
	// `unclosedBracket` is the unconfirmed discovery pass 1 exists to make.
	let openBracket: BracketKind | undefined;
	// Only ever non-zero on the carried-label path below, where a bracket pair
	// opened inside the label straddles this line's end (NRL-88).
	let openBracketDepth = 0;
	let unclosedBracket: BracketKind | undefined;
	let i = 0;

	/*
	 * The carried span's literal region, `[0, literalCodeEnd)`, handled ONCE here
	 * rather than by an `i >= literalCodeEnd` guard inside each branch below.
	 *
	 * That is the whole point of NRL-44. Before it, the comment branch was the
	 * only branch in this loop that tested literalCodeEnd, so every other one
	 * still read code content as markdown: an enumeration probe against the
	 * single-line-span oracle found 18 of 21 inline constructs re-interpreted
	 * here - emphasis, highlight, math, HTML, embeds, wikilinks, footnotes,
	 * images, links, bare URLs, autolinks, tags, strikethrough and both backslash
	 * escapes. Eighteen individual guards is eighteen chances to miss one, and it
	 * is not a closed set. A single-line span has always been fully verbatim and
	 * fully option-independent, so this is that same rule finally reaching
	 * continuation lines, not a new rule being invented for them (ADR 0019).
	 *
	 * Consequence worth stating: openComment can no longer be set from inside the
	 * region, which is the correct reading of ADR 0006 clause 4. The
	 * `i >= literalCodeEnd` test on the comment branch below becomes vacuous for
	 * the region because the loop never enters it; it is left in place because it
	 * still guards the closerRun === -1 case and removing it would be a silent
	 * behaviour change.
	 */
	if (carrying && literalCodeEnd > 0) {
		emitLiteralRegion(0, literalCodeEnd);
		i = literalCodeEnd;
	}

	/*
	 * A confirmed label carried in from an earlier line (NRL-63).
	 *
	 * This line starts inside the label, so the text up to its `]` is label
	 * content and nothing in it is a fresh construct at this level - the same
	 * reading a carried code span gets, for the same reason. What follows the
	 * `]` is the destination or the reference tail, consumed and never spoken by
	 * the identical two-shape test the single-line branches use, and the rest of
	 * the line is ordinary prose scanned by the loop below.
	 *
	 * It can never be reached with a code carry live: extractChunks arms at most
	 * one carry for a line (see cleanLine's header), so `incomingCode` and
	 * `incomingBracket` are mutually exclusive. The block is placed after the
	 * code region anyway, so the ordering is stated rather than implied.
	 *
	 * `labelClose` and not a bare `inlineContainerClose` here, and the two sites
	 * that call it must change together (NRL-88, D-88-10). This site used to
	 * close the carry at the FIRST `]` on the line, unconditionally, while
	 * bracketClosesLater tested that same `]` for a `](`/`][` tail. Teaching
	 * only the confirmation to walk past an inner bracket pair was built and
	 * measured and is strictly WORSE than leaving both alone: the confirmation
	 * says yes, this site then ends the label at the stray `]` anyway, and the
	 * real `](dest)` falls out as prose - the destination still leaked and the
	 * alt text was silenced on top of it. One question, one helper, one answer.
	 */
	if (incomingBracket !== undefined) {
		const found = labelClose(raw, 0, incomingBracketDepth);
		const close = found.close;
		if (close === -1) {
			// The label has not closed yet, so the whole line is label content and
			// the carry continues. Confirmation was made where the label opened and
			// is monotone - the closing line is still ahead and no interrupting line
			// can have appeared between - so it is not re-asked here. The residual
			// bracket depth goes out with the carry, so the next line resumes this
			// scan rather than restarting it.
			emitLabelRegion(0, raw.length, incomingBracket);
			openBracket = incomingBracket;
			openBracketDepth = found.depth;
			i = raw.length;
		} else {
			emitLabelRegion(0, close, incomingBracket);
			let after = close + 1;
			if (raw[after] === "(") {
				const paren = raw.indexOf(")", after);
				after = paren === -1 ? after + 1 : paren + 1;
			} else if (raw[after] === "[") {
				const refClose = raw.indexOf("]", after);
				after = refClose === -1 ? after : refClose + 1;
			}
			i = after;
			// Clamped, because a destination may be the last thing on the last line
			// of the note and `rawStart + raw.length` is then one past the end of
			// the source. Every sourceIndex entry must be a real offset in it.
			pushSpace(rawStart + Math.min(i, raw.length - 1));
		}
	}

	while (i < raw.length) {
		const ch = raw[i]!;

		// The closing run of a carried span. Consumed here rather than through
		// inlineCodeBounds, which would pair it with a later run on this line
		// and read the text between them as a fresh span. Byte for byte what
		// the branch below already does for an unmatched run: drop the run and
		// separate the words either side.
		if (ch === "`" && i === closerRun) {
			i += incomingCode!;
			pushSpace(rawStart + i);
			continue;
		}

		// Backslash escape: keep the escaped character, drop the slash.
		if (ch === "\\" && i + 1 < raw.length) {
			emit(raw[i + 1]!, rawStart + i + 1);
			i += 2;
			continue;
		}

		// Inline code: dropped unless skipInlineCode is off, in which case the
		// content is read verbatim. Code is not markdown, so it is not re-cleaned:
		// `a_b` or `#x` inside backticks mean exactly what they say. A backtick
		// run with no matching closer is dropped in both positions, so it never
		// swallows the rest of the line; its length is reported as openCode so
		// extractChunks can check whether a later line closes it.
		if (ch === "`") {
			const { start, close, end } = inlineCodeBounds(raw, i);
			// Does this run open the span extractChunks has already confirmed?
			// Only the FIRST unmatched run can, which is what `openCode === undefined`
			// says, and only when its length is the confirmed one - a second,
			// differently sized run is content of the span this one opens.
			let opensConfirmed = false;
			if (close !== -1 && !opts.skipInlineCode) {
				pushSpace(rawStart + i);
				for (let k = start; k < close; k++) {
					if (/\s/.test(raw[k]!)) pushSpace(rawStart + k);
					else emit(raw[k]!, rawStart + k);
				}
			} else if (close === -1) {
				// CommonMark's first-unmatched-opener rule: a later run on the
				// same line never takes the carry from an earlier one.
				//
				// Reported in BOTH toggle positions (NRL-44): the length of an
				// unmatched run is a fact about the source, not about whether we
				// speak it, and under skipInlineCode it is what arms the carry
				// that then silences the rest of the span.
				opensConfirmed = openCode === undefined && outgoingCode === start - i;
				openCode ??= start - i;
			}
			i = end;
			pushSpace(rawStart + i);
			if (opensConfirmed) {
				// The rest of the line is inside the span, so it is code content
				// and nothing in it is markdown - the same region, the same
				// emitter and the same two toggle positions as a carried-in span
				// (NRL-64). Scanning stops here: there is no more line to clean.
				emitLiteralRegion(i, raw.length);
				i = raw.length;
			}
			continue;
		}

		// Math. Checked before everything but escapes and code, and consumed
		// from the opening `$`, so a `\\` inside it never reaches the escape
		// branch and an `_` inside it is never emphasis.
		if (ch === "$") {
			if (raw[i + 1] === "$") {
				const close = raw.indexOf("$$", i + 2);
				if (close !== -1 && raw.slice(i + 2, close).trim() !== "") {
					emitEquation(rawStart + i, rawStart + close + 1);
					i = close + 2;
					continue;
				}
				// A lone `$$` is either a block extractChunks already took, or text.
				emit("$", rawStart + i);
				emit("$", rawStart + i + 1);
				i += 2;
				continue;
			}
			const close = inlineMathClose(raw, i);
			if (close !== -1) {
				const tokens = raw.slice(i + 1, close).match(MATH_TOKEN)?.length ?? 0;
				// No space is pushed after either form: the source's own
				// whitespace separates words, and a pushed one would read
				// "equation ." before a full stop.
				if (tokens >= INLINE_MATH_MIN_TOKENS) emitEquation(rawStart + i, rawStart + close);
				i = close + 1;
				continue;
			}
			emit(ch, rawStart + i);
			i += 1;
			continue;
		}

		// Comments own their content: only their own first closer matters, even
		// if the content looks like code or the other comment syntax. Obsidian
		// treats an unmatched inline %% as text, but a block opener hides to EOF
		// (ADR 0006). Recursive labels cannot open a document-level block.
		// Inside a carried code span (i < literalCodeEnd) neither delimiter is a
		// comment, so both fall through to the plain emit at the end of the loop
		// with their true raw offsets.
		const htmlComment = ch === "<" && raw.startsWith("<!--", i);
		const obsidianComment = ch === "%" && raw.startsWith("%%", i);
		if ((htmlComment || obsidianComment) && i >= literalCodeEnd) {
			const closer: CommentCloser = htmlComment ? "-->" : "%%";
			const close = raw.indexOf(closer, i + (htmlComment ? 4 : 2));
			if (close === -1 && obsidianComment && !(blockComments && opensObsidianBlock(raw, i, dedentedByList))) {
				emit("%", rawStart + i);
				emit("%", rawStart + i + 1);
				i += 2;
				continue;
			}
			// The `<!--` twin of the escape above, and the `blockComments` gate is
			// POSITIVE here where that one is negated. That asymmetry looks like a
			// typo and is not: it is measured, and it is what keeps the recursive
			// label call unaffected. A label is cleaned with blockComments false,
			// and `local-html-state` plus srs.md's non-nesting bullet require an
			// unmatched `<!--` inside a label to go on truncating locally rather
			// than becoming literal. `%%` can afford the symmetric form because
			// literal is the right answer for it in both modes; `<!--` in a label
			// is not, and changing that is a different ticket (NRL-74, D-74-11).
			//
			// All four characters are emitted with their true raw offsets and `i`
			// advances past them, mirroring the two-and-two above. Emitting only
			// `<` would re-enter the loop at `!--` and risk another branch (the
			// autolink or raw-HTML one) claiming it.
			if (close === -1 && htmlComment && blockComments && !opensHtmlBlock(raw, i, htmlClosesLater)) {
				for (let k = 0; k < 4; k++) emit(raw[i + k]!, rawStart + i + k);
				i += 4;
				continue;
			}
			if (close === -1) {
				openComment = closer;
				// The space before the comment would double with the line join.
				if (chars[chars.length - 1] === " ") {
					chars.pop();
					index.pop();
				}
				break;
			}
			pushSpace(rawStart + i);
			i = close + closer.length;
			continue;
		}

		// Autolink `<https://x.com>` or `<me@example.com>`: the brackets are
		// never spoken, and the address inside obeys speakUrls exactly as a
		// bare URL does (docs/adr/0003, docs/adr/0007). Recognised before the
		// HTML branch, and therefore long before the bare-URL branch, which
		// otherwise leaves the opening "<" behind as a spoken word.
		//
		// Consumption stops at the closing ">", so unlike a bare URL a glued
		// sentence period is prose and is still spoken: the bracket tells us
		// where the address ends, so nothing has to be guessed from it.
		if (ch === "<") {
			const link = AUTOLINK_URI.exec(raw.slice(i)) ?? AUTOLINK_EMAIL.exec(raw.slice(i));
			if (link) {
				if (opts.speakUrls) {
					// Offsets are into `inner`, which starts one char after
					// the "<", so every emitted char keeps its true raw
					// offset and index stays in lockstep with chars.
					const inner = raw.slice(i + 1, i + link[0].length - 1);
					const { start, end } = hostSpan(inner);
					if (end > start) {
						pushSpace(rawStart + i);
						for (let k = start; k < end; k++) emit(inner[k]!, rawStart + i + 1 + k);
					}
				}
				i += link[0].length;
				pushSpace(rawStart + i);
				continue;
			}
		}

		// Inline HTML: the tag is dropped and the text between tags is kept,
		// because the scanner simply carries on. Formatting tags drop with no
		// space so "un<b>bold</b>ed" stays one word; breaking tags separate.
		if (ch === "<") {
			const m = HTML_TAG.exec(raw.slice(i));
			const name = m?.[1]!.toLowerCase();
			if (m && name !== undefined && (INLINE_ELEMENTS.has(name) || BREAKING_ELEMENTS.has(name))) {
				if (BREAKING_ELEMENTS.has(name)) pushSpace(rawStart + i);
				i += m[0].length;
				continue;
			}
		}

		// Obsidian embed `![[...]]`. Must precede the image branch, which would
		// stop at the first `]` of `]]` and speak the second; that ordering is
		// also what keeps the two constructs on their own settings, since an
		// embed obeys speakEmbeds and a markdown image obeys speakImageAlt.
		//
		// With speakEmbeds on, what is spoken is a label for the local
		// reference, never the transcluded file's contents: extractChunks holds
		// only this note's source, and sourceIndex is an offset into it, so text
		// from another file has nowhere to map back to.
		if (ch === "!" && raw[i + 1] === "[" && raw[i + 2] === "[") {
			const close = wikiTargetClose(raw, i + 3);
			if (close !== -1) {
				if (opts.speakEmbeds) {
					pushSpace(rawStart + i);
					emitWikiLabel(i + 3, close, true);
				}
				i = close + 2;
				pushSpace(rawStart + i);
				continue;
			}
			// Unterminated: drop the `!` and let the `[[` branch drop the brackets.
			i += 1;
			continue;
		}

		// Obsidian wikilink `[[target|alias]]`: speak the alias, else the target.
		// Only a double bracket lands here, so a single `[` (including callouts
		// like `[!note]`) still reaches the link branch below.
		if (ch === "[" && raw[i + 1] === "[") {
			const close = wikiTargetClose(raw, i + 2);
			if (close === -1) {
				// No closer on this line (wikilinks never span lines). Drop just the
				// brackets so the rest of the line is still read as prose.
				pushSpace(rawStart + i);
				i += 2;
				continue;
			}
			pushSpace(rawStart + i);
			emitWikiLabel(i + 2, close, false);
			i = close + 2;
			pushSpace(rawStart + i);
			continue;
		}

		// Footnote reference `[^1]`: dropped with no space, so "word[^1]." reads
		// "word." At the start of a line followed by `:` it is a definition, and
		// only the marker goes; whether footnote text is read is out of scope.
		if (ch === "[" && raw[i + 1] === "^") {
			const m = FOOTNOTE_REF.exec(raw.slice(i));
			if (m) {
				const atLineStart = i === 0;
				i += m[0].length;
				if (atLineStart && raw[i] === ":") {
					i += 1;
					while (i < raw.length && /\s/.test(raw[i]!)) i += 1;
				}
				continue;
			}
		}

		// Markdown image `![alt](dest "title")`, `![alt][ref]` or `![alt]`.
		//
		// The destination and any quoted title are a path, so neither is ever
		// spoken, in either position. The alt text is the image's accessible
		// description, which is exactly what a reading feature should be able to
		// offer, so speakImageAlt reads it (R-M09, ADR 0008). It is re-cleaned
		// the way the link branch re-cleans a label, so nested markup, escapes
		// and complete comment spans inside the alt go through the existing
		// recursion rather than a second implementation, and
		// inlineContainerClose has already refused to end the label on a
		// delimiter hidden inside a comment or a code span.
		if (ch === "!" && raw[i + 1] === "[") {
			const close = inlineContainerClose(raw, i + 2, "]");
			if (close === -1) {
				// No `]` on this line. If extractChunks has confirmed that a later
				// line closes this label, the rest of the line is label content and
				// the carry goes out (NRL-63); only the FIRST unmatched opener can
				// take it, which is what `unclosedBracket === undefined` says.
				// Otherwise this is the pre-NRL-63 behaviour unchanged: drop the `!`
				// and let the `[` below emit itself as the text it is.
				if (unclosedBracket === undefined && outgoingBracket === "image") {
					emitLabelRegion(i + 2, raw.length, "image");
					openBracket = "image";
					i = raw.length;
					continue;
				}
				unclosedBracket ??= "image";
				i += 1;
				continue;
			}
			let after = close + 1;
			if (raw[after] === "(") {
				const paren = raw.indexOf(")", after);
				after = paren === -1 ? after + 1 : paren + 1;
			} else if (raw[after] === "[") {
				// Reference form. The tail names a link reference, not prose, and
				// consuming it here is what stops `![alt][ref]` reaching the link
				// branch below and speaking "ref".
				const refClose = raw.indexOf("]", after);
				after = refClose === -1 ? after : refClose + 1;
			}
			if (opts.speakImageAlt) {
				pushSpace(rawStart + i);
				const inner = cleanLine(raw.slice(i + 2, close), rawStart + i + 2, opts);
				for (let k = 0; k < inner.text.length; k++) {
					emit(inner.text[k]!, inner.index[k] ?? rawStart + i + 2);
				}
			}
			i = after;
			pushSpace(rawStart + i);
			continue;
		}

		// Link: keep the label, drop the target. Covers inline and reference form.
		if (ch === "[") {
			const close = inlineContainerClose(raw, i + 1, "]");
			if (close === -1) {
				// The same soft-wrap carry the image branch above takes, by the same
				// scanner, because a link label crosses a break the same way (NRL-63).
				// Unconfirmed, the `[` is still emitted as the text it is.
				if (unclosedBracket === undefined && outgoingBracket === "link") {
					emitLabelRegion(i + 1, raw.length, "link");
					openBracket = "link";
					i = raw.length;
					continue;
				}
				unclosedBracket ??= "link";
				emit(ch, rawStart + i);
				i += 1;
				continue;
			}
			const label = raw.slice(i + 1, close);
			let after = close + 1;
			if (raw[after] === "(") {
				const paren = raw.indexOf(")", after);
				after = paren === -1 ? after + 1 : paren + 1;
			} else if (raw[after] === "[") {
				const refClose = raw.indexOf("]", after);
				after = refClose === -1 ? after : refClose + 1;
			}
			// Re-clean the label so nested markup inside link text is handled too.
			const inner = cleanLine(label, rawStart + i + 1, opts);
			for (let k = 0; k < inner.text.length; k++) {
				emit(inner.text[k]!, inner.index[k] ?? rawStart + i + 1);
			}
			i = after;
			pushSpace(rawStart + i);
			continue;
		}

		// Bare URLs: dropped, or with speakUrls on, reduced to the host. A path
		// or query read aloud is noise, and the host is the part a listener can
		// recognise; see docs/adr/0003. Markdown links and wikilinks never reach
		// here, their branches above consume them first.
		if ((ch === "h" || ch === "w") && BARE_URL_START.test(raw.slice(i, i + 8))) {
			let end = i;
			while (end < raw.length && !/\s/.test(raw[end]!)) end += 1;
			if (opts.speakUrls) {
				const url = raw.slice(i, end);
				const host = hostSpan(url);
				if (host.end > host.start) {
					pushSpace(rawStart + i);
					for (let k = host.start; k < host.end; k++) emit(url[k]!, rawStart + i + k);
				}
			}
			i = end;
			pushSpace(rawStart + i);
			continue;
		}

		// Obsidian tags: dropped. Requires a tag char and a boundary before.
		if (ch === "#" && opts.stripTags && (i === 0 || !isWordChar(raw[i - 1]!))) {
			let end = i + 1;
			while (end < raw.length && /[\w/-]/.test(raw[end]!)) end += 1;
			if (end > i + 1) {
				i = end;
				pushSpace(rawStart + i);
				continue;
			}
		}

		// Emoji: dropped.
		if (EMOJI.test(ch)) {
			i += ch.length;
			pushSpace(rawStart + i);
			continue;
		}

		// Highlight `==text==`. Both inner edges must be non-space and neither
		// run may be part of a longer `=` run, so `a == b` and `===` stay text.
		if (
			ch === "=" &&
			raw[i + 1] === "=" &&
			raw[i - 1] !== "=" &&
			raw[i + 2] !== "=" &&
			!isSpaceOrEdge(raw[i + 2])
		) {
			const close = inlineContainerClose(raw, i + 2, "==");
			if (close !== -1 && !/\s/.test(raw[close - 1]!) && raw[close + 2] !== "=") {
				const inner = cleanLine(raw.slice(i + 2, close), rawStart + i + 2, opts);
				for (let k = 0; k < inner.text.length; k++) {
					emit(inner.text[k]!, inner.index[k] ?? rawStart + i + 2);
				}
				i = close + 2;
				continue;
			}
		}

		// Emphasis and strikethrough markers: dropped, contents kept. A marker
		// run with whitespace or a line edge on both sides cannot be emphasis
		// ("2 * 3", "a _ b") and is kept.
		if (ch === "*" || ch === "_" || ch === "~") {
			let end = i;
			while (raw[end] === ch) end += 1;
			const before = raw[i - 1];
			const after = raw[end];
			const spaced = isSpaceOrEdge(before) && isSpaceOrEdge(after);
			let markup = !spaced;
			if (ch === "_") {
				// An underscore between letters or digits is part of an
				// identifier (snake_case_name), not emphasis. It is markup only
				// when it opens or closes a word, as CommonMark's flanking rule
				// has it. No open/close pairing: "__init__" drops both runs,
				// which is also how Obsidian renders it.
				const leftFlank = !isSpaceOrEdge(after) && !isAlnum(before);
				const rightFlank = !isSpaceOrEdge(before) && !isAlnum(after);
				markup = leftFlank || rightFlank;
			} else if (ch === "~") {
				// Obsidian has no single-tilde strikethrough, and "~5 min" or
				// "~/dir" are common, so only an exact `~~` is markup.
				markup = markup && end - i === 2;
			}
			if (!markup) {
				for (let k = i; k < end; k++) emit(ch, rawStart + k);
			}
			i = end;
			continue;
		}

		if (/\s/.test(ch)) {
			pushSpace(rawStart + i);
			i += 1;
			continue;
		}

		emit(ch, rawStart + i);
		i += 1;
	}

	return { text: chars.join(""), index, openComment, openCode, openBracket, openBracketDepth, unclosedBracket };
}

interface StripOptions {
	stripTags: boolean;
	skipInlineCode: boolean;
	speakUrls: boolean;
	speakImageAlt: boolean;
	speakEmbeds: boolean;
}

/**
 * A code line emitted as written. Code is not markdown, so nothing is stripped;
 * only whitespace runs collapse, since indentation is not speech. Every char
 * keeps its true raw offset.
 */
function verbatimLine(raw: string, rawStart: number): Cleaned {
	const chars: string[] = [];
	const index: number[] = [];
	for (let k = 0; k < raw.length; k++) {
		const c = raw[k]!;
		if (/\s/.test(c)) {
			if (chars.length > 0 && chars[chars.length - 1] !== " ") {
				chars.push(" ");
				index.push(rawStart + k);
			}
			continue;
		}
		chars.push(c);
		index.push(rawStart + k);
	}
	// A trailing space would double up with the paragraph join space.
	if (chars[chars.length - 1] === " ") {
		chars.pop();
		index.pop();
	}
	return { text: chars.join(""), index };
}

/**
 * Everything the splitters need that is not the text itself.
 *
 * One object rather than two extra parameters on three call sites, so a
 * future addition cannot reach two of them and miss the third.
 */
interface SegmentContext {
	/** Obsidian's UI language, from appLocale(). Never a detected language. */
	locale: string;
	src: SegmenterSource;
}

/** A candidate chunk, plus how the boundary that opens it was found. */
interface Piece {
	chunk: SpeechChunk;
	/**
	 * The legacy regex produced the boundary at this piece's start. Only such
	 * a boundary may be erased by mergeShort; see there for why.
	 */
	legacyOpen: boolean;
}

/**
 * Split cleaned text into sentence-ish pieces with offsets preserved.
 *
 * Known gap, recorded rather than fixed: a boundary is used where it is
 * found. `splitOversized` snaps its cuts back to a grapheme cluster boundary
 * and this does not, so a sentence boundary that ICU supplies immediately
 * before a `SpacingMark` or a combining mark ends a piece inside a combining
 * sequence. Found in NRL-28 verification; degenerate text only, since it
 * needs a terminator followed directly by a combining mark, and no surrogate
 * pair was split across 32,000 fuzz cases. Closing it means snapping here
 * too, which moves where every boundary lands and wants its own fail-first
 * change.
 *
 * `blockType` is a parameter rather than part of `ctx` on purpose: `ctx` is one
 * object per document, and the block kind is a property of the line being
 * turned into chunks, not of the document. It is labelled here, at the point
 * the chunk is built, so every route into a chunk carries a real value.
 */
function splitSentences(
	text: string,
	index: number[],
	rawStart: number,
	ctx: SegmentContext,
	blockType: BlockType,
): SpeechChunk[] {
	const pieces: Piece[] = [];
	const bounds: Array<{ from: number; to: number; legacyOpen: boolean }> = [];

	let last = 0;
	// The first piece has no opening boundary at all. It can never be folded
	// backwards, so the flag it carries is never read.
	let legacyOpen = true;
	for (const boundary of sentenceBoundaries(text, ctx.locale, ctx.src)) {
		if (boundary.at <= last) continue;
		bounds.push({ from: last, to: boundary.at, legacyOpen });
		last = boundary.at;
		legacyOpen = boundary.legacy;
	}
	if (last < text.length) bounds.push({ from: last, to: text.length, legacyOpen });

	for (const bound of bounds) {
		// Trim, keeping offsets aligned to the trimmed region. The flag travels
		// on the same object, so a whitespace-only piece drops it along with
		// itself rather than leaving two arrays to drift apart.
		let s = bound.from;
		let e = bound.to;
		while (s < e && /\s/.test(text[s]!)) s += 1;
		while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
		if (e <= s) continue;
		pieces.push({
			chunk: {
				id: "",
				sequence: 0,
				blockType,
				filePath: "",
				text: text.slice(s, e),
				sourceIndex: index.slice(s, e),
				sourceStart: index[s] ?? rawStart,
				sourceEnd: (index[e - 1] ?? rawStart) + 1,
			},
			legacyOpen: bound.legacyOpen,
		});
	}

	return mergeShort(pieces, ctx);
}

/**
 * Fold runt fragments forward so we do not synthesise a word at a time.
 *
 * Only a boundary the legacy regex also found may be erased. ICU segments a
 * Chinese paragraph into sentences of six or seven characters, every one of
 * them under MIN_CHUNK_CHARS, so a merge that did not check this would fold
 * all of them straight back into the single chunk that R-M10 exists to
 * prevent. That is the half of this fix that a regex swap alone cannot do.
 *
 * English is untouched by the check wherever the terminator is ASCII, which
 * is the guard in `sentenceBoundaries` doing its job: no ICU-only boundary
 * survives it there, so every boundary is a legacy one and still merges
 * exactly as before. A note that really does end a sentence with `．` or `。`
 * gets the new pacing, which is the point.
 */
function mergeShort(pieces: Piece[], ctx: SegmentContext): SpeechChunk[] {
	const out: SpeechChunk[] = [];
	for (const piece of pieces) {
		const chunk = piece.chunk;
		const prev = out[out.length - 1];
		if (prev && piece.legacyOpen && chunk.text.length < MIN_CHUNK_CHARS) {
			// The join inserts a space that exists in neither input, so the
			// offset map needs an entry for it too. Without this every position
			// after the join shifts by one and highlights land mid-word.
			const gap = sourceOffsetOfSpace(prev.sourceEnd, chunk.sourceIndex[0] ?? chunk.sourceStart);
			prev.text = `${prev.text} ${chunk.text}`;
			prev.sourceIndex = [...prev.sourceIndex, gap, ...chunk.sourceIndex];
			prev.sourceEnd = chunk.sourceEnd;
			continue;
		}
		out.push({ ...chunk });
	}
	return out.flatMap((chunk) => splitOversized(chunk, ctx));
}

/**
 * Best guess at which source character a synthesised space came from.
 *
 * Prefers the character just before the next chunk, since that is normally the
 * whitespace in the original text.
 */
function sourceOffsetOfSpace(afterPrev: number, firstOfNext: number): number {
	if (firstOfNext > 0) return firstOfNext - 1;
	return afterPrev;
}

/**
 * Every offset inside `text` where a word may begin, for the word-highlight
 * layer rather than for chunking (NRL-47, ADR 0014).
 *
 * The policy lives here, next to the rest of the segmentation policy, and
 * `findWords` receives a plain sorted number[] so that words.ts keeps importing
 * nothing but its own types.
 *
 * Two rules, and the second is not redundant. ICU supplies the Han and Kana
 * boundaries. It supplies no Korean ones at all: measured on node v24.21.0,
 * `안녕하세요세계반갑습니다` comes back as ONE word segment under "ko", "en" and
 * "und" alike, because V8's ICU ships no Korean word dictionary. So a Hangul
 * run is additionally cut at its own grapheme boundaries, one span per syllable
 * block, which is both a real syllable and the same granularity ICU already
 * gives Han. Grapheme boundaries and not code points, so a syllable written
 * with conjoining jamo (U+1100 U+1161 U+11A8, verified one cluster) is never
 * split.
 *
 * Presence of a segmenter is tested as `src.word(locale) !== undefined` and
 * must stay that way. An empty boundary list does NOT mean there is no
 * segmenter - unspaced Hangul returns exactly that from a working one - so
 * reading the list as the test would silently disable the Hangul rule for the
 * one case it exists for.
 *
 * The locale is passed through for consistency with `sentenceBoundaries` and
 * `splitOversized`, but nothing here depends on it: measured, `这是第一句`,
 * `日本語のテキストを読み上げます` and `안녕하세요세계반갑습니다` segment
 * identically under "zh"/"ja"/"ko", "en" and "und" on this V8.
 */
const HANGUL_RUN = /\p{scx=Hangul}+/gu;

function wordCutPoints(text: string, ctx: SegmentContext): number[] {
	// Nothing outside these scripts can gain a span, because `findWords` only
	// subdivides a span holding one of their code points. Checking first keeps
	// an English note from segmenting every chunk to produce cuts that are then
	// all discarded.
	if (!hasCjkScript(text)) return [];
	if (ctx.src.word(ctx.locale) === undefined) return [];

	const cuts = new Set(wordBoundaries(text, ctx.locale, ctx.src));

	HANGUL_RUN.lastIndex = 0;
	let run: RegExpExecArray | null;
	let graphemes: number[] | undefined;
	while ((run = HANGUL_RUN.exec(text)) !== null) {
		const from = run.index;
		const to = from + run[0].length;
		if (to - from <= 1) continue;
		// Computed once and only when a multi-unit Hangul run exists, since a
		// note in any other script would pay for nothing.
		graphemes ??= graphemeBoundaries(text, ctx.src);
		for (const at of graphemes) {
			if (at > from && at < to) cuts.add(at);
		}
	}

	return [...cuts].sort((a, b) => a - b);
}

/**
 * Hard-split anything past the engine's comfort zone, at a word boundary.
 *
 * MAX_CHUNK_CHARS is a target, not a guarantee, and it has to be: a single
 * extended grapheme cluster can be longer than it - "a" followed by 300
 * combining acutes is 301 UTF-16 units and exactly one cluster - so a strict
 * cap is unsatisfiable without destroying the character. Where the two
 * conflict the cluster wins, which is the one place a piece may exceed the
 * cap, and it still makes forward progress because the piece it emits is that
 * whole cluster.
 *
 * Three preferences, in order: the last space past the halfway mark, as
 * before; then the last word boundary in the window, which is the only thing
 * that helps a script with no spaces at all; then the raw cap. Whichever wins
 * is snapped back to a grapheme boundary, so no piece can end inside a
 * surrogate pair, an emoji sequence or a combining sequence.
 *
 * The first two preferences are floored against the same constant and, since
 * NRL-28's verification, against the same *measurement*: the number of units
 * the piece would actually carry, counting no trailing space. The space
 * branch has always measured that, because it cuts at the space rather than
 * after it and the loop below then skips the space entirely. The word branch
 * did not, and that one-unit difference was the whole of finding B1; see the
 * comment on the trim below.
 */
function splitOversized(chunk: SpeechChunk, ctx: SegmentContext): SpeechChunk[] {
	if (chunk.text.length <= MAX_CHUNK_CHARS) return [chunk];

	const length = chunk.text.length;
	// A flag per position beats a binary search here: the scan is O(n) once,
	// and snapping walks backwards over a cluster whose length is the only
	// thing bounding it.
	const isGraphemeBoundary = new Uint8Array(length + 1);
	isGraphemeBoundary[0] = 1;
	isGraphemeBoundary[length] = 1;
	for (const at of graphemeBoundaries(chunk.text, ctx.src)) isGraphemeBoundary[at] = 1;
	const words = wordBoundaries(chunk.text, ctx.locale, ctx.src);

	const out: SpeechChunk[] = [];
	let cursor = 0;
	let wordCursor = 0;
	while (cursor < length) {
		let end = Math.min(cursor + MAX_CHUNK_CHARS, length);
		if (end < length) {
			const window = chunk.text.slice(cursor, end);
			const breakAt = window.lastIndexOf(" ");
			if (breakAt > MAX_CHUNK_CHARS * 0.5) {
				end = cursor + breakAt;
			} else {
				// No late space. `words` is sorted, so one shared cursor walks
				// it across every iteration rather than rescanning it.
				while (wordCursor < words.length && words[wordCursor]! <= cursor) wordCursor += 1;
				let candidate = -1;
				for (let w = wordCursor; w < words.length && words[w]! <= end; w++) candidate = words[w]!;
				// A word starts immediately *after* a space, so a candidate
				// sitting behind one is the same cut the space branch just
				// looked at, one unit later. Moving it back onto the space run
				// makes the two branches name the same offset for the same
				// cut, and only then is the shared floor comparing like with
				// like. Without this, a space at exactly cursor + 110 was
				// rejected at 110 by the space branch and re-accepted at 111
				// by this one, so `"a" * 110 + " " + "b" * 300` split as
				// 111/220/80 where the merge base gave 220/191 (NRL-28 B1,
				// measured against fb71812). Only " " is trimmed, because
				// " " is the only thing the space branch looks for and the
				// only thing the cursor loop below skips.
				while (candidate > cursor && chunk.text[candidate - 1] === " ") candidate -= 1;
				// The same halfway floor the space branch uses, and needed for
				// the same reason. Without it `"hi "` followed by 300 unbroken
				// characters breaks at the only word boundary in the window and
				// emits a three-unit chunk, where the cap alone gave 220.
				//
				// No cursor can turn this into a runt. Both floors are
				// measured from `cursor`, so the position of the piece in the
				// chunk cannot enter into it, and the trim above only ever
				// moves a candidate earlier - so the word branch can accept
				// nothing the space branch rejected, and what it does accept
				// is more than half the cap of real content with a non-space
				// character at its end. The one thing that can still take a
				// piece below the floor is the grapheme snap below walking
				// back inside a single cluster, which is bounded by that
				// cluster's length and is the deliberate exception this
				// function exists to make. That exception is not theoretical,
				// so do not quote the floor as an invariant of this function:
				// over 924 fixtures placing one indivisible 301-unit cluster
				// after an `a`-run of 0 to 230, with and without a space
				// before it, 478 non-final pieces come in under 111 units, the
				// shortest 1 unit, and 240 end in a space - 120 in each
				// segmenter position, so it is the snap and not this branch.
				if (candidate - cursor > MAX_CHUNK_CHARS * 0.5) end = candidate;
			}
			while (end > cursor && isGraphemeBoundary[end] !== 1) end -= 1;
			if (end <= cursor) {
				// The piece opens with a cluster longer than the cap. Emit the
				// whole cluster: it cannot be divided, and stopping short would
				// mean no progress at all.
				end = cursor + 1;
				while (end < length && isGraphemeBoundary[end] !== 1) end += 1;
			}
		}
		out.push({
			id: chunk.id,
			sequence: chunk.sequence,
			blockType: chunk.blockType,
			filePath: chunk.filePath,
			text: chunk.text.slice(cursor, end),
			sourceIndex: chunk.sourceIndex.slice(cursor, end),
			sourceStart: chunk.sourceIndex[cursor] ?? chunk.sourceStart,
			sourceEnd: (chunk.sourceIndex[end - 1] ?? chunk.sourceEnd - 1) + 1,
		});
		cursor = end;
		while (cursor < length && chunk.text[cursor] === " ") cursor += 1;
	}
	return out;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
/**
 * Any indent: inside a list, "    - item" is a nested item, and its marker
 * must be stripped rather than spoken. Indented code is told apart by state
 * (see INDENTED_CODE), not by this pattern.
 */
const LIST_BULLET = /^\s*([-*+]|\d+[.)])\s+/;
/** Every nesting level at once, so "> > x" does not speak the inner ">". */
const BLOCKQUOTE = /^(?:\s{0,3}>\s?)+/;
/**
 * Obsidian callout marker, `[!type]` with an optional fold `+` or `-`. Only
 * recognised straight after a blockquote prefix, because a bare `[!note]` line
 * renders literally in Obsidian. Requiring `[!` keeps `> [link](x)` and
 * `> [text]` on the normal path.
 *
 * The type is dropped silently, not announced as "Note:". That was a
 * deliberate call (NRL-8 Decisions, 2026-09-28): prose flow matters more than
 * the callout kind when listening. If it proves wrong the fix is a setting,
 * not a hardcoded prefix.
 */
const CALLOUT = /^\[![A-Za-z][\w-]*\][+-]?\s*/;
/**
 * Task checkbox after a list marker. Any single status char, since Obsidian
 * renders `[ ]`, `[x]`, `[/]`, `[-]`, `[>]`, `[?]` and friends all as
 * checkboxes. The trailing space-or-end keeps "- [x]text" and "- [ab]" as
 * text.
 *
 * Checked state is not spoken (NRL-8 Decisions, 2026-09-28). A listener cannot
 * tell done from open; that is the accepted trade, because a reader who needs
 * task state is looking at the screen. If it proves wrong, add a setting.
 */
const TASK = /^\[[^\]]\](?=\s|$)\s*/;
/** One quote level, for counting. See containerPrefix. */
const BLOCKQUOTE_LEVEL = /^\s{0,3}>\s?/;

/**
 * The container prefix this line carries: how many characters of it there are,
 * how many quote LEVELS, which block it belongs to, and whether a callout
 * marker was consumed.
 *
 * Extracted from the per-line loop by NRL-98 so there is ONE definition of
 * "the prefix". `cleanLine` is already handed `raw.slice(prefixChars)`, and
 * `bracketClosesLater` now evaluates its paragraph bound on a peeled line, so
 * the confirmation and the consumption would otherwise be two separate
 * readings of the same thing and free to disagree about where the prefix ends.
 *
 * PURE on purpose. The three side effects the inline block had - `prevContainer
 * = true`, `inList = true` and the "only a non-quote line is a list" write -
 * stay at the call site and are driven off the returned fields, because a
 * lookahead must be able to ask this question about a line it is not consuming.
 *
 * `quotes` is counted by iterating a SINGLE-level pattern over what the
 * all-levels BLOCKQUOTE already matched, not by a second independent scan, so
 * the two cannot disagree: the loop is asserted to consume exactly `q[0]`.
 * That assertion is why the count can be trusted as a peel budget.
 */
function containerPrefix(line: string): { chars: number; quotes: number; blockType: BlockType; callout: boolean } {
	const h = line.match(HEADING);
	if (h) return { chars: h[0].length, quotes: 0, blockType: "heading", callout: false };
	// Peel prefixes in order, each adding to chars so cleanLine gets the true
	// raw offset of the first kept character: quote levels, then a callout
	// marker, or else a list marker and its task checkbox.
	let chars = 0;
	let quotes = 0;
	let blockType: BlockType = "paragraph";
	const q = line.match(BLOCKQUOTE);
	if (q) {
		chars = q[0].length;
		blockType = "quote";
		let at = 0;
		while (at < chars) {
			const level = BLOCKQUOTE_LEVEL.exec(line.slice(at, chars));
			if (!level || level[0].length === 0) break;
			quotes += 1;
			at += level[0].length;
		}
	}
	const callout = q ? CALLOUT.test(line.slice(chars)) : false;
	if (callout) {
		chars += line.slice(chars).match(CALLOUT)![0].length;
		return { chars, quotes, blockType, callout: true };
	}
	const b = line.slice(chars).match(LIST_BULLET);
	if (b) {
		chars += b[0].length;
		// Only a line that is not already a quote is a list. A quoted list item
		// matches both matchers, and the outer construct is the quote, because
		// BLOCKQUOTE is peeled above before LIST_BULLET is even tried.
		if (blockType === "paragraph") blockType = "list";
		const task = line.slice(chars).match(TASK);
		if (task) chars += task[0].length;
	}
	return { chars, quotes, blockType, callout: false };
}

/**
 * Strip at most `budget` quote levels from `line`, and nothing else.
 *
 * This is NRL-98's compatibility rule between a label's opener line and its
 * continuations, and the budget IS the rule rather than a performance bound.
 * Obsidian's `interruptParagraph` holds a `blockquote` and a `list` entry, so
 * any container marker BEYOND the opener's own opens a new container and ends
 * the paragraph, while a MISSING prefix is a lazy continuation that
 * `interruptBlockquote` and `interruptList` tolerate for plain prose. The rule
 * is therefore SAME OR SHALLOWER, including the fully-lazy empty prefix.
 *
 * Expressing it as a budget means no second predicate is needed. A deeper
 * continuation still has a leading `>` after the budget is spent, so the
 * UNCHANGED BLOCKQUOTE arm of interruptsParagraph rejects it; a continuation
 * bearing a list marker after quote-peeling is rejected by the UNCHANGED
 * LIST_BULLET arm, which is right in every case because a marker on a
 * continuation line always starts a new item. Every rejection is the
 * pre-NRL-63 outcome: no confirmation, no carry, the line left exactly as it
 * was, destination-only and prose-safe (ADR 0023 clause 3).
 *
 * Quote levels ONLY, and not the list marker the opener may also have had: a
 * list continuation's indent is whitespace, which every arm of
 * interruptsParagraph already tolerates, and peeling a marker would accept the
 * new item the renderer starts there.
 */
function peelQuotes(line: string, budget: number): string {
	let rest = line;
	for (let n = 0; n < budget; n++) {
		const level = BLOCKQUOTE_LEVEL.exec(rest);
		if (!level || level[0].length === 0) break;
		rest = rest.slice(level[0].length);
	}
	return rest;
}

/**
 * Any quote marker at all, with an UNBOUNDED leading-whitespace skip.
 *
 * Deliberately not `BLOCKQUOTE`, whose `\s{0,3}` cap is the CommonMark one.
 * Obsidian's blockquote tokenizer skips spaces and tabs with no cap at all
 * (`for(;D<E&&((c=t.charAt(D))===a||c===o);)D++;`), so a six-space-indented `>`
 * is still a quote line there while `peelQuotes` leaves it alone. This predicate
 * answers "is this line LAZY", i.e. does it carry no `>` for the renderer
 * either, and it has to use the renderer's rule or a line the renderer keeps
 * inside the quote would be judged lazy and stopped for nothing.
 */
const ANY_QUOTE_MARKER = /^\s*>/;
/**
 * A line opening a block-level HTML construct, approximated deliberately WIDE.
 *
 * `interruptsParagraph` covers Obsidian's `html` interrupter only through
 * `opensHiddenComment`, i.e. `%%` and `<!--`. The real entry fires on any block
 * tag, so a `<div>` on a continuation line ends the paragraph and swallows the
 * rest of the construct into raw HTML that Obsidian DISPLAYS. This is a wide
 * approximation rather than CommonMark's seven conditions because every error it
 * can make is in the fail-closed direction: an extra stop leaves the line exactly
 * as the pre-NRL-63 tree had it, destination spoken and no prose lost.
 *
 * The one false positive worth excluding is an AUTOLINK, `<https://x.example>`.
 * Requiring a tag name followed by whitespace, `/`, `>` or end of line does it:
 * `https` is followed by `:`, which is in none of those, so the branch fails for
 * every prefix of it.
 */
const HTML_BLOCK_OPEN = /^ {0,3}<(?:[!?/]|[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$))/;

/**
 * The paragraph-ending constructs the container peel newly EXPOSES, and only
 * those. Found at NRL-98's ship review by executing Obsidian's own remark parser
 * out of the installed asar rather than reading it.
 *
 * Once a `>` is peeled, correctness needs `interruptBlockquote` modelled and not
 * only `interruptParagraph`, and the two sets differ. Obsidian's, read verbatim
 * and with module 6047's option gate applied at `commonmark: true`:
 *
 *   interruptParagraph  thematicBreak list atxHeading fencedCode comment math
 *                       blockquote html
 *   interruptBlockquote indentedCode fencedCode comment math atxHeading
 *                       setextHeading thematicBreak html list
 *
 * `interruptsParagraph` already covers every one of those except two.
 * `indentedCode` has no arm at all, and it is in `interruptBlockquote` only - so
 * a LAZY continuation (no `>`) indented four spaces or led by a tab ENDS the
 * blockquote and becomes an indented CODE block, while the same line WITH its `>`
 * is an ordinary paragraph continuation and must stay carried. That asymmetry is
 * why `lazy` is a parameter rather than being folded in. And `html` is covered
 * only for `%%`/`<!--`, which `HTML_BLOCK_OPEN` widens here.
 *
 * Gated at the call site on a container being in play, which is what keeps this
 * to the cells the peel newly reaches: the PLAIN form of the html shape
 * (`A ![alt` / `<div>` / `words](dest.png) B`) is already carried before NRL-98
 * and is a pre-existing defect recorded as a leftover, not opened here.
 */
function containerCarryStops(peeled: string, lazy: boolean): boolean {
	return (lazy && INDENTED_CODE.test(peeled)) || HTML_BLOCK_OPEN.test(peeled);
}

/**
 * Setext underline. Only an underline when a paragraph line sits directly
 * above it; otherwise "---" is a rule and "===" is text, so this is checked
 * against parse state before HR.
 */
const SETEXT = /^ {0,3}(?:=+|-+)\s*$/;
/**
 * The `=` half of `SETEXT`, at the EXACT shape Obsidian's own setextHeading
 * block tokenizer accepts, for the one caller that needs the renderer's rule
 * rather than CommonMark's (`endsTerm2Scan`, NRL-111).
 *
 * No leading whitespace and no trailing whitespace, where `SETEXT` allows up to
 * three leading spaces and any trailing run. Measured against real rendered
 * HTML out of the installed obsidian.asar 1.13.7 in this session: `Title` /
 * `===` is `<h1>`, while `Title` / ` ===`, `Title` / `===  `, `Title` / `===\t`
 * and `Title` / `\t===` are each one `<p>` with the `===` as prose. A single
 * `=` is enough, so the run length is unbounded downward.
 *
 * `\r?` is there because `extractChunks` splits on `\n` alone, so a CRLF note
 * hands every line a trailing `\r`; measured, `Prose` / `=\r` still renders as
 * a heading, so the `\r` is a line ending to the renderer and not content.
 *
 * The DASH half deliberately keeps `SETEXT`'s wide shape instead of being given
 * an exact twin, because a dash-only line stops the term-2 scan for a reason
 * that does not depend on being an underline at all. See `TERM2_LONE_DASH` and
 * `TERM2_DASH_RUN`.
 */
const TERM2_SETEXT_EQ = /^=+\r?$/;
/**
 * A dash-only line with exactly ONE dash. It ends the block it follows, and
 * therefore resets `endsTerm2Scan`'s paragraph-line count, for a reason that has
 * nothing to do with setext: module 745's list tokenizer accepts a marker with
 * NOTHING after it (`if (next!==" " && next!=="\t" && (pedantic || next!=="\n"
 * && next!=="")) return;` - a newline or end of input passes), so a bare `-` is
 * a list item starting, and `list` is in `u.interruptParagraph`
 * unconditionally. Measured: `Prose <!--` / `more` / `-` / `HIDDENE` /
 * `--> t.` renders `<p>Prose &#x3C;!--<br>more</p><ul><li>HIDDENE...`, so the
 * paragraph really does end there and `HIDDENE` is DISPLAYED.
 *
 * When such a line IS the block's second line the setextHeading tokenizer gets
 * it first and it is an `<h2>` instead - measured as well - which ends the block
 * too, so the stop holds in both positions and needs no gate.
 *
 * `TERM2_LIST` does not cover it: that pattern requires `[ \t]` after the
 * marker. Widening `TERM2_LIST` to end-of-line would cover `*`, `+`, `1.` and
 * `1)` alone on a line as well, all four of which are measured interrupters, but
 * that is a widening NRL-111 is not scoped for and those four stay fail-closed.
 */
const TERM2_LONE_DASH = /^ {0,3}-\s*$/;
/**
 * A dash-only line with TWO OR MORE dashes. This one is a term-2 stop WITHOUT
 * being a block end, and that distinction is the whole reason it is separate.
 *
 * Why it stops: module 4839's inline comment regex is
 * `<!--(?:-?[^>-])(?:-?[^-])*-->`, and neither branch of the body can consume
 * two consecutive dashes, so a `--` anywhere between the opener and the closer
 * makes the whole construct fail to match and the `<!--` literal. Measured:
 * `Prose <!--` / `more` / `--` / `HIDDENE` / `--> t.` renders as ONE paragraph
 * with every line visible, `HIDDENE` included.
 *
 * Why it must not reset the paragraph-line count BY ITSELF: that same
 * measurement shows the renderer treats `--` as paragraph CONTENT in that
 * position. `--` / `Prose <!--` / `===` / `HIDDENE` / `--> t.` therefore gives
 * the `===` two content lines above it, so it is not an underline and `HIDDENE`
 * is HIDDEN - measured. An arm that reset the count here unconditionally would
 * call that `===` a second line, stop, and speak `HIDDENE`: a disclosure of
 * exactly the kind NRL-111 exists to remove.
 *
 * BUT NOT NEVER, and this is NRL-111's second pass correcting its own first.
 * The first draft gated the `=` run on block position and left the dash run
 * UNCONDITIONALLY not-a-block-end, which repeats for dashes the exact
 * position-independent error it had just fixed for `=`. A dash run that IS its
 * block's second line is a setext `<h2>` and therefore a real block end.
 * Measured on real rendered HTML: `Lead.` / `--` is
 * `<h2 data-heading="Lead.">Lead.</h2>`, so `Lead.` / `--` / `Prose <!--` /
 * `===` / `HIDDENE` / `--> t.` DISPLAYS `HIDDENE` and the first draft dropped
 * it, 512 cells of prose loss. `TERM2_SETEXT_DASH` carries that position-gated
 * block end; this constant keeps the ungated SCAN stop, which is why the two are
 * separate rather than one pattern with one gate.
 *
 * Three or more dashes are also `HR`, so only the two-dash case is reachable
 * through this constant alone; it is written as a run rather than a pair so the
 * union of this and `TERM2_LONE_DASH` is `SETEXT`'s dash half exactly, leaving
 * every dash shape's stop byte-for-byte where NRL-95 put it.
 */
const TERM2_DASH_RUN = /^ {0,3}--+\s*$/;
/**
 * The dash twin of `TERM2_SETEXT_EQ`: a dash run at the EXACT shape Obsidian's
 * setextHeading block tokenizer accepts, so a real block end when it is the
 * block's second line. Same no-leading-and-no-trailing-whitespace shape as the
 * `=` half, and measured the same way rather than assumed symmetric:
 * `Lead.` / `--` is `<h2>`, while `Lead.` / ` --`, `Lead.` / `-- ` and
 * `Lead.` / `--\t` are each one `<p>` with the dashes as prose. `\r?` for the
 * same CRLF reason, measured: `Lead.\r\n--\r\n` is still an `<h2>`.
 *
 * Gated on `paraLinesAbove === 1` at its call site, exactly as the `=` half is.
 * Three or more dashes are `HR` as well, so the only shape this adds over what
 * `endsTerm2Block` already had is a bare `--` on a block's second line.
 */
const TERM2_SETEXT_DASH = /^--+\r?$/;
/**
 * Four columns of indent. A tab after up to three spaces reaches the next tab
 * stop, which is column four, so it counts too. Whether the line is code
 * depends on state: CommonMark only starts indented code after a blank line
 * or at the start of the document, and never inside a list item.
 */
const INDENTED_CODE = /^(?: {4}| {0,3}\t)/;
const TABLE_ROW = /^\s*\|/;
/**
 * Thematic break: three or more of the same marker, optionally spaced. Checked
 * before LIST_BULLET because "- - -" would otherwise read as a bullet whose
 * body is "- -", and the dashes would be spoken.
 */
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
/**
 * A CommonMark link reference definition, the whole construct on one line.
 * It renders as nothing at all, so nothing in it is spoken (docs/adr/0018).
 *
 * Every half is there to stop a false positive, because a miss here swallows a
 * sentence and ADR 0007 clause 6 prefers leaked markup to a lost word:
 *
 * - `^ {0,3}` - four spaces is indented code, which never reaches this point.
 * - `(?!\^)` - `[^1]:` is a footnote definition, whose body IS displayed, so
 *   it keeps cleanLine's own branch that drops only the marker.
 * - `(?:[^\[\]\\]|\\.)+` - a non-empty label with no unescaped bracket in it,
 *   so `[a [b] c]: x.png` is prose.
 * - a destination is REQUIRED, either `<...>` or a run of non-space
 *   characters. `[theref]:` alone is not a definition.
 * - the optional title must be the last thing on the line. That is what keeps
 *   `[see also]: not a definition, just a sentence` spoken: its destination
 *   ends at the first space and the rest is neither a title nor nothing.
 *
 * A definition whose destination sits on the following line is out of scope -
 * this scanner is per-line, and picking that up means the same refactor the
 * whole soft-wrap family needs.
 */
const LINK_REF_DEF =
	/^ {0,3}\[(?!\^)(?:[^\[\]\\]|\\.)+\]:[ \t]*(?:<(?:[^<>\\\n]|\\.)*>|[^\s<][^\s]*)(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*$/;

/**
 * Does this line leave a comment open, so that the lines after it are hidden?
 *
 * Two shapes, matching the branch in cleanLine: an Obsidian block opener, which
 * is `opensObsidianBlock`'s question and is asked through that shared predicate
 * rather than restated here (NRL-73), because a line this says opens a hidden
 * block is by definition a line cleanLine will hide from; and an HTML `<!--`
 * with no `-->` after it on the line. A `%%...%%` pair or a `<!--...-->` pair
 * closes on its own line and hides nothing beyond it, so neither counts.
 *
 * The `<!--` half is routed through its own shared predicate, opensHtmlBlock,
 * for the same reason and NOT through opensObsidianBlock: the lone-`%`
 * disqualifier is a rule of Obsidian's `%%` tokenizer specifically and has no
 * HTML-comment equivalent (NRL-74, ADR 0025).
 *
 * BOTH of opensHtmlBlock's terms are asked here, or neither. Asking only the
 * line-start term - the one answerable from `line` alone - is a MEASURED
 * DISCLOSURE and is forbidden (D-74-10): it would answer false for a mid-line
 * `<!--` that a later `-->` genuinely closes, so codeSpanClosesLater would
 * confirm a carry across a line that really does open a hidden block and the
 * hidden text would be read aloud as code content. That is why
 * `htmlClosesLater` is threaded down here through interruptsParagraph rather
 * than left to the caller.
 *
 * This is a paragraph-ending condition, which is why it lives next to
 * interruptsParagraph. Obsidian 1.13.7's Reading-view parser puts `comment` in
 * `interruptParagraph` and already has `html` there, so an opening comment line
 * terminates the paragraph before any inline tokenizing happens and a code span
 * can never contain one. Read off the installed parser, not observed live.
 */
function opensHiddenComment(line: string, htmlClosesLater: boolean, dedentedByList: boolean): boolean {
	const pct = line.indexOf("%%");
	if (pct !== -1 && opensObsidianBlock(line, pct, dedentedByList)) return true;
	const html = line.indexOf("<!--");
	if (html === -1 || line.indexOf("-->", html + 4) !== -1) return false;
	return opensHtmlBlock(line, html, htmlClosesLater);
}

/**
 * A list-item line that the renderer's OWN list tokenizer accepts as
 * interrupting a paragraph. Deliberately NOT `LIST_BULLET`, and the difference
 * is the whole reason this constant exists.
 *
 * Transcribed from module 745 of the installed obsidian.asar 1.13.7 (app.js
 * sha256 8efbf58...), silent-mode entry, which is the path
 * `interruptParagraph` takes:
 *
 *   for (;U<_ && (t[U]==="\t" || t[U]===" ");) U++;      // NO three-space cap
 *   if (t[U]==="*"||t[U]==="+"||t[U]==="-") { ... }      // any bullet, always
 *   else { o = digits;
 *          if (!o || !(t[U]==="." || commonmark && t[U]===")")) return;
 *          if (silent && o !== "1") return; }            // silent needs "1"
 *   if (next!==" " && next!=="\t" && (pedantic || next!=="\n" && next!=="")) return;
 *
 * So a bullet at ANY indent interrupts a paragraph, and an ordered marker
 * interrupts when its digit string is exactly `"1"` and its delimiter is `.`
 * OR `)`.
 *
 * NRL-95 wrote `1\.` here on the premise that "Obsidian runs with `commonmark`
 * falsy, so `)` is not a marker either". **That premise was BACKWARDS and the
 * `)` half of this pattern was wrong** (NRL-111). `VT.globalOptions` is
 * `{breaks:!0, commonmark:!0}` and the sole parse entry applies it, so
 * `options.commonmark` is TRUE; what the `{commonmark:!1}` entries in
 * `u.interruptParagraph` mean is that module 6047's gate
 * (`o.commonmark === n.options.commonmark`) DISABLES them. Module 745's marker
 * test is `y === h || z && y === v` with `z = options.commonmark` and `v = ")"`,
 * so with `commonmark` true `1)` IS a marker and DOES interrupt. Measured
 * against real rendered HTML in this session: `Prose <!--` / `1) HIDDENE` /
 * `more -->` renders `<p>Prose &#x3C;!--</p><ol><li>HIDDENE...`, so the
 * paragraph ends at the marker and `HIDDENE` is DISPLAYED. `7.`, `7)`, `01.` and
 * `01)` all render as one paragraph with `HIDDENE` inside the comment, so
 * `if (silent && o !== "1") return` really does gate on the digit string and
 * excluding them is right. Each case is pinned in tests/extract.test.ts.
 *
 * THE INDENT CAP IS LOAD-BEARING AND THE REASON THIS PATTERN IS NOT
 * `^[ \t]*`. NRL-95 wrote `^[ \t]*` and its own comment said "a bullet at ANY
 * indent interrupts a paragraph", which is false: module 745's list tokenizer
 * gives up past three columns of indent, and a tab reaches column four on its
 * own. Measured against real rendered HTML across the whole indent axis, with
 * all five markers (`-`, `*`, `+`, `1.`, `1)`) and a `Prose <!--` opener above:
 * indent 0, 2 and 3 spaces DISPLAY the sentinel, while 4 spaces, 5 spaces,
 * `\t`, ` \t`, `  \t`, `   \t` and `\t\t` all HIDE it - the line is a lazy
 * paragraph continuation there, so the inline comment regex crosses it. The
 * split is total, 15 shown cells and 35 hidden with no mixed row.
 *
 * So `^[ \t]*` made this a stop on 35 shapes the renderer HIDES, which is a
 * live DISCLOSURE and not a fail-closed gap. It was inherited from NRL-95 and
 * NRL-111's first draft widened it further by adding `1)` to it, taking the
 * disclosure from 4 markers to 5 before this second pass capped it. A tab is
 * Obsidian's own default indent for a nested list item, so the leaking shape is
 * the ordinary one, not an exotic one. Closing it here closes NRL-119's first
 * half as well as NRL-111's own.
 *
 * Narrower than remark in one direction only, deliberately: a marker alone on
 * its line (`1.`, `*`) is not matched here, because `[ \t]` is required rather
 * than end-of-line. All four of `*`, `+`, `1.` and `1)` alone on a line are
 * measured interrupters, so that is a real fail-CLOSED gap and not a statement
 * about the renderer; widening it is NRL-119's second half and deliberately not
 * done here. A lone `-` is the one that is covered, by `TERM2_LONE_DASH` rather
 * than by this pattern.
 */
const TERM2_LIST = /^ {0,3}(?:[-*+]|1[.)])[ \t]/;

/**
 * Does this line end the paragraph a `<!--` on an earlier line belongs to, for
 * the purpose of term 2 of the HTML-comment block rule?
 *
 * THE TRAP, and the reason this is a separate function rather than a call to
 * interruptsParagraph: interruptsParagraph -> opensHiddenComment ->
 * opensHtmlBlock CONSUMES the very answer this predicate is used to produce, so
 * reusing it here is MUTUALLY RECURSIVE - unbounded, or needing a sentinel
 * argument threaded through four functions to break the cycle. This helper is
 * therefore comment-blind BY CONSTRUCTION rather than by a flag (NRL-95, ADR
 * 0025 decision 4).
 *
 * The stop set is interruptsParagraph's terms with `BLOCKQUOTE` and `TABLE_ROW`
 * dropped and `LIST_BULLET` REPLACED by `TERM2_LIST`. All three departures are
 * measured, and they are three different reasons rather than one:
 *
 * - `BLOCKQUOTE` is dropped because the renderer's blockquote tokenizer PEELS
 *   the `>` prefix and re-runs the paragraph tokenizer on the stripped content,
 *   so a continuation line of the SAME quote is not a quote STARTING. Module
 *   4839's inline regex therefore does find a `-->` there and Obsidian really
 *   does hide that text. `blockquote` being in `u.interruptParagraph` is about
 *   the other case - a quote starting mid-paragraph - and the two are not the
 *   same question. Measured: stopping here newly SPOKE the hidden sentinel in
 *   every quote shape tried, `> Prose <!--` / `> HIDDENQ` / `> more -->` among
 *   them.
 * - `TABLE_ROW` is dropped because NO table row can interrupt a paragraph in
 *   Obsidian at all: `table` appears nowhere in `u.interruptParagraph`, and the
 *   only two terms ever inserted into that list are `math` and `comment`. So a
 *   `| a |` line is a paragraph continuation for the renderer whether or not a
 *   delimiter row follows it, and a REAL GFM table between opener and closer is
 *   hidden too. Do not "fix" `TABLE_ROW` to require a delimiter row and then
 *   add it here; that reopens the disclosure on the real-table shape.
 * - `LIST_BULLET` is replaced rather than dropped, because it is right for
 *   bullets and wrong for ordered markers. See `TERM2_LIST`.
 *
 * Omitting a term only ever makes term 2 TRUE more often, i.e. fail-closed
 * toward hiding, so the set of lines this answers `true` for stays a strict
 * subset of the document-scoped predicate it replaces. ADDING one is the
 * dangerous direction and is what the guards above exist to hold.
 *
 * NRL-111 split `SETEXT` into three terms and gave the `=` half a POSITION
 * GATE, because `SETEXT` as a whole was a stop the renderer does not have and
 * the `=` half was a live 2,048-cell disclosure. `setextHeading` IS in
 * `u.interruptParagraph`, but it carries `{commonmark:!1}` and module 6047 gates
 * an entry on `o.commonmark === n.options.commonmark` with
 * `options.commonmark === true`, so it and `definition` are both DISABLED as
 * interrupters. A setext underline ends a paragraph only through the
 * setextHeading BLOCK tokenizer (module 8671), which takes exactly ONE content
 * line - so only when the underline is the block's second line. That is why
 * `paraLinesAbove` is a parameter: a LINE-LOCAL predicate cannot answer it at
 * all, and the caller supplies it from a forward pass.
 *
 * `endsTerm2Block` is split out from `endsTerm2Scan` rather than folded in
 * because the two sets are genuinely different, and conflating them is a
 * measured disclosure. Every term here ends a BLOCK for the renderer, so the
 * caller's content-line count resets on it; `TERM2_DASH_RUN`, the one term
 * `endsTerm2Scan` adds, stops the scan without ending a block, and resetting the
 * count on it unconditionally would call a later `===` a second line when it is
 * not. See that constant for the measurement.
 *
 * The dash run is therefore in BOTH functions and in neither one the same way:
 * ungated in the scan set, and position-gated here through
 * `TERM2_SETEXT_DASH`, because a `--` on a block's second line is a setext
 * `<h2>` and a real block end while the same `--` anywhere else is prose. The
 * `=` and dash halves get the identical `paraLinesAbove === 1` gate, which is
 * the symmetry NRL-111's first draft lacked.
 */
function endsTerm2Block(line: string, paraLinesAbove: number): boolean {
	return (
		line.trim() === "" ||
		FENCE.test(line) ||
		HEADING.test(line) ||
		HR.test(line) ||
		TERM2_LONE_DASH.test(line) ||
		(paraLinesAbove === 1 &&
			(TERM2_SETEXT_EQ.test(line) || TERM2_SETEXT_DASH.test(line))) ||
		TERM2_LIST.test(line)
	);
}

/**
 * The term-2 scan's own stop set: every line that ends the opener's block, plus
 * the one line shape that stops the scan without ending anything.
 *
 * `paraLinesAbove` is how many lines immediately above this one are neither
 * stops nor block ends, i.e. how many content lines the block this line would
 * continue already has. Only the value `1` matters, and it is module 8671's
 * one-content-line rule rather than a heuristic.
 */
function endsTerm2Scan(line: string, paraLinesAbove: number): boolean {
	return endsTerm2Block(line, paraLinesAbove) || TERM2_DASH_RUN.test(line);
}

/**
 * A line that starts its own block, so a paragraph, and with it any code span
 * inside that paragraph, cannot continue across it. A blank line counts too,
 * and so does a line that opens a comment: the text it hides is not code
 * content, and treating it as such reads that text aloud.
 *
 * `htmlClosesLater` is NOT optional and is passed down to opensHiddenComment
 * (NRL-74). A required parameter is deliberate: six call sites reach this
 * predicate and a default would let one of them silently keep the old answer,
 * which is the dead-toggle shape CONTEXT.md warns about. It also means this is
 * no longer a pure line predicate - the in-file precedent is opensMathBlock,
 * already document-aware and already called beside this one.
 */
function interruptsParagraph(line: string, htmlClosesLater: boolean, dedentedByList: boolean): boolean {
	return (
		line.trim() === "" ||
		FENCE.test(line) ||
		HEADING.test(line) ||
		HR.test(line) ||
		SETEXT.test(line) ||
		TABLE_ROW.test(line) ||
		LIST_BULLET.test(line) ||
		BLOCKQUOTE.test(line) ||
		opensHiddenComment(line, htmlClosesLater, dedentedByList)
	);
}

/**
 * Does a backtick run of length `len`, left unmatched on line `from`, have a
 * real closing run on a later line of the same paragraph?
 *
 * This confirmation is mandatory, not an optimisation. An unmatched backtick
 * run is literal text in CommonMark, so assuming a span stays open would make
 * the next line's `%%` literal instead of a block-comment opener, and the
 * hidden text after it would be read aloud. Silence over disclosure (ADR
 * 0006): with no closer found there is no carry and nothing changes.
 *
 * Both ends are checked against interruptsParagraph, the opening line as well
 * as every line scanned, because a table row reaches the carry site as plain
 * paragraph text when tables are spoken and a span cannot leave its own row.
 */
function codeSpanClosesLater(lines: string[], from: number, len: number, htmlCloserAhead: readonly boolean[], listDedented: readonly boolean[]): boolean {
	if (interruptsParagraph(lines[from]!, htmlCloserAhead[from]!, listDedented[from]!)) return false;
	for (let n = from + 1; n < lines.length; n++) {
		const line = lines[n]!;
		if (interruptsParagraph(line, htmlCloserAhead[n]!, listDedented[n]!)) return false;
		if (firstRunOfLength(line, len, 0) !== -1) return true;
	}
	return false;
}

/**
 * Does line `n` open a display-math block that a later line closes?
 *
 * The same test extractChunks makes at its `$$` branch, deliberately duplicated
 * rather than shared, because what matters here is not that the line looks like
 * math but that extractChunks will *consume the whole block with a `continue`*
 * that never reaches the carry site. A label carry armed on the line before such
 * a block is therefore read into `carriedBracket` and then dropped, which
 * silences the label's words and still leaves the destination spoken - strictly
 * worse than either recognising the label or not recognising it. So the
 * lookahead refuses to confirm across one and the label is left exactly as it
 * was before NRL-63, which is the same fail-closed direction clause 3 of ADR
 * 0023 takes everywhere else.
 *
 * The closer search is part of the test and not an optimisation: with no `$$`
 * anywhere later the line is not a block, extractChunks does not consume it, and
 * the carry works, so stopping there would give up a destination for nothing.
 *
 * `interruptsParagraph` is deliberately NOT widened to cover this. It is shared
 * with codeSpanClosesLater, and widening it would move NRL-64's just-landed
 * carry as well. The identical gap exists for that carry and is pre-existing;
 * it is not opened or closed here.
 *
 * `quoteBudget` is NRL-98's, and it is the one place the container peel has to
 * reach INSIDE this test rather than being applied to its argument. This stop is
 * the only one of the label carry's four that is not an arm of
 * `interruptsParagraph`, so peeling the line the predicate sees does nothing for
 * it: `> $$` fails `trimStart().startsWith("$$")` and the block is missed.
 * Left unthreaded, the carry CROSSED a quoted math block where it aborts across
 * a plain one, so a container prefix changed the answer in the prose-loss
 * direction - Obsidian renders `$$` inside a blockquote as a display-math block,
 * which ends the paragraph, so the closing line is math source it displays. The
 * budget keeps the shape in root 3: destination spoken, fail-closed, nothing
 * silenced. It defaults to 0, so codeSpanClosesLater's call is unchanged and the
 * pre-existing gap for THAT carry is neither opened nor closed, exactly as the
 * paragraph above says. The CLOSER search deliberately still scans the RAW lines,
 * because peeling never removes a `$$`.
 */
function opensMathBlock(lines: string[], n: number, quoteBudget = 0): boolean {
	const raw = quoteBudget === 0 ? lines[n]! : peelQuotes(lines[n]!, quoteBudget);
	const open = raw.indexOf("$$");
	if (!raw.trimStart().startsWith("$$") || raw.indexOf("$$", open + 2) !== -1) return false;
	for (let k = n + 1; k < lines.length; k++) if (lines[k]!.includes("$$")) return true;
	return false;
}

/**
 * Where a soft-wrapped label closes on this line, given `depth` inner `[`
 * already outstanding from earlier lines, and the depth left outstanding if it
 * does not close here.
 *
 * The one rule is CommonMark's own: a bracket may appear inside a link or image
 * label only as a matched pair. So a `]` is walked past ONLY while an inner `[`
 * opened after our own opener is still waiting for it, which makes a skipped
 * `]` provably not ours. A `]` reached at depth 0 IS ours and is returned, for
 * the caller to accept or reject on its own terms.
 *
 * That distinction is the whole of NRL-88 and it is not "skip any `]` that is
 * not followed by `(`". The naive skip was built and measured: it fixes the
 * leak and loses real prose, because a shortcut label's own closer gets skipped
 * and the scan runs on to adopt an unrelated later `](`, swallowing every word
 * between. `A ![shortcut` / `more] text` / `and [link](dest) here` became
 * `"A here"`. With depth, that `]` is at depth 0, the caller's `](`/`][` test
 * fails, and the confirmation returns false - the same fail-closed outcome
 * ADR 0023 clause 3 takes everywhere else.
 *
 * THE EARLY RETURN AT `shut === -1` IS DELIBERATE AND MUST NOT BE "COMPLETED".
 * It looks like an oversight: a line holding a trailing `[` and no further `]`
 * leaves that opener uncounted. Counting it was built and measured as its own
 * arm, and it is wrong here. It newly leaked a destination in 10 of 4,000 fuzz
 * notes and moved the pinned fixture guard-nrl63-nested-label, because this
 * codebase's carry takes the FIRST unmatched opener on a line (see the image
 * and link branches above) where CommonMark's inline parser takes the LAST.
 * Full accounting binds the outer opener and then refuses the closer the inner
 * opener owns. Conservative depth agrees with the first-opener convention
 * instead: 0 new leaks and 0 fixtures moved. The cost is one named residual,
 * pinned by guard-nrl88-unbalanced-open-residual.
 *
 * Two inlineContainerClose calls per step rather than a second scanner of its
 * own, so the escape, code-span and complete-comment-span skipping is byte for
 * byte what the single-line branches already do. A `[` or `]` hidden inside a
 * code span or a comment cannot move the depth.
 */
function labelClose(line: string, from: number, depth: number): { close: number; depth: number } {
	let d = depth;
	let i = from;
	while (i < line.length) {
		const open = inlineContainerClose(line, i, "[");
		const shut = inlineContainerClose(line, i, "]");
		if (shut === -1) return { close: -1, depth: d };
		if (open !== -1 && open < shut) {
			d += 1;
			i = open + 1;
			continue;
		}
		if (d > 0) {
			d -= 1;
			i = shut + 1;
			continue;
		}
		return { close: shut, depth: d };
	}
	return { close: -1, depth: d };
}

/**
 * Does an `![` or `[` left unmatched on line `from` have its `]` on a later line
 * of the same paragraph, followed by a destination or a reference tail?
 *
 * The same stopping rules as codeSpanClosesLater, through the SAME
 * interruptsParagraph predicate at both ends - but NOT on the same input, and
 * that is NRL-98. A code span cannot leave its own block; a paragraph CAN span a
 * container's lines, because the blockquote and list tokenizers strip their
 * prefix per line and tokenize the JOINED remainder. So this carry evaluates the
 * bound on a container-PEELED line where codeSpanClosesLater evaluates it on the
 * raw one, and the two can now disagree about where a paragraph ends,
 * deliberately. ADR 0023 clause 2 said they could not and is amended; ADR 0029
 * records why. The predicate itself is untouched and shared byte for byte, which
 * is what keeps ADR 0019's F5 disclosure guard green by construction.
 *
 * The `](` / `][` requirement is the difference from codeSpanClosesLater, and it
 * is what keeps this fix on the prose-loss side of the line. The defect is that
 * a destination is spoken, and only the inline and reference forms carry one. A
 * shortcut `[text\nmore]` with no such tail renders literally when no reference
 * defines it, so confirming it would silence visible prose to fix a leak that is
 * not there - the trade ADR 0007 clause 6 refuses. With no confirmation there is
 * no carry and nothing changes, which is also what a label that never closes
 * gets: it cannot swallow the rest of the note because it is never recognised.
 *
 * Where the label closes is decided by `labelClose`, the SAME helper the
 * consumption site in cleanLine uses, so the two can never disagree about which
 * `]` is the label's own (NRL-88, D-88-10).
 */
function bracketClosesLater(lines: string[], from: number, htmlCloserAhead: readonly boolean[], listDedented: readonly boolean[]): boolean {
	// `htmlCloserAhead` is indexed by RAW line number and stays so under the peel
	// (NRL-95 landing under NRL-98). That is sound rather than an oversight: the
	// array answers "is there a `-->` later in THIS line's paragraph", and
	// `endsTerm2Scan` deliberately drops BLOCKQUOTE from its stop set for exactly
	// the reason the peel exists - the renderer strips the `>` and re-runs the
	// paragraph tokenizer on the joined remainder, so a quote continuation is not
	// a new paragraph for either of them. The two changes agree; nothing is
	// recomputed on the peeled string.
	const op = containerPrefix(lines[from]!);
	// A CALLOUT TITLE line fails closed. Module 6234 matches the `[!type]`
	// marker only at the blockquote's first line and then runs tokenizeBlock on
	// THAT stripped line alone, before tokenizing the rest of the quote, so a
	// callout title can never join the paragraph below it: Obsidian displays the
	// destination and silencing it would be prose loss. A callout BODY line as
	// the opener has no marker and is carried.
	if (op.callout) return false;
	// An ATX heading is ONE line and cannot soft-wrap, so peeling its `#` run and
	// then asking whether the paragraph continues would be asking the wrong
	// question. Stated here as well as at the arming site because this function
	// must answer correctly about a line on its own terms; the arming guard below
	// never passes a heading, and guard-nrl63-opening-line-is-heading pins it.
	if (op.blockType === "heading") return false;
	// Only where the peel exposed them. A plain-paragraph opener is left exactly
	// as it was, pre-existing holes included.
	const containerInPlay = op.quotes > 0 || op.blockType === "list";
	if (interruptsParagraph(lines[from]!.slice(op.chars), htmlCloserAhead[from]!, listDedented[from]!) || opensMathBlock(lines, from, op.quotes)) return false;
	if (containerInPlay && containerCarryStops(lines[from]!.slice(op.chars), false)) return false;
	// Starts at 0 rather than at a depth read off the opener line, and that is
	// provable rather than an approximation: the carry is armed only when
	// `inlineContainerClose(raw, openerAt, "]")` is -1, so there is no `]` after
	// the opener at all, so `labelClose` seeded there would return on its first
	// step with the depth it was given. Threading an openerAt argument through
	// five sites to compute a constant 0 would be dead weight a later reader has
	// to re-derive.
	let depth = 0;
	for (let n = from + 1; n < lines.length; n++) {
		// Peeled for the predicate AND for labelClose, from the same string, so
		// the bound and the closer search cannot disagree about what this line
		// is. opensMathBlock is handed the same budget rather than the peeled
		// string, because its own closer search must still see the RAW lines; a
		// container-prefixed `$$` therefore still aborts the carry, which is root
		// 3's territory and can only fail closed. An earlier revision of this
		// change left the budget off and that claim was FALSE - measured during
		// critique, the carry crossed a quoted math block where the plain twin
		// aborts, silencing a line Obsidian displays as math source.
		const line = peelQuotes(lines[n]!, op.quotes);
		if (interruptsParagraph(line, htmlCloserAhead[n]!, listDedented[n]!) || opensMathBlock(lines, n, op.quotes)) return false;
		if (containerInPlay && containerCarryStops(line, op.quotes > 0 && !ANY_QUOTE_MARKER.test(lines[n]!))) return false;
		const found = labelClose(line, 0, depth);
		if (found.close === -1) {
			depth = found.depth;
			continue;
		}
		const next = line[found.close + 1];
		return next === "(" || next === "[";
	}
	return false;
}

/**
 * A `key:` line. Keys may be quoted or contain any character but a colon, so
 * non-English property names (`título:`, `日付:`) and names like
 * `created (date):` count. The trailing space-or-end stops "http://x" counting
 * as a key. A leading `-` or `#` is a list item or a comment, not a key.
 */
const FM_KEY = /^(?:"[^"]*"|'[^']*'|[^\s#:\-"'][^:]*?)\s*:(\s|$)/;
const FM_LIST_ITEM = /^\s*-(\s|$)/;
const FM_CONTINUATION = /^\s+\S/;
const FM_COMMENT = /^\s*#/;

// trim, not trimEnd, and a leading BOM tolerated: the positional check this
// replaced accepted both, and narrowing either would start reading
// frontmatter aloud on notes that are silent about it today.
const isFrontmatterFence = (line: string): boolean => line.replace(/^\uFEFF/, "").trim() === "---";

/**
 * Net open `[` / `{` on a line, ignoring quoted strings. A flow collection
 * such as `tags: [a,` may continue on unindented lines until it closes.
 */
function flowDepthDelta(line: string): number {
	const bare = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "");
	let delta = 0;
	for (const ch of bare) {
		if (ch === "[" || ch === "{") delta += 1;
		else if (ch === "]" || ch === "}") delta -= 1;
	}
	return delta;
}

/**
 * Find a YAML frontmatter block by its shape, not only its position.
 *
 * The opening fence is the first non-blank line and the block must close, and
 * every line inside must look like YAML metadata with at least one `key:` line.
 * Anything else is a horizontal rule and the note is read normally. An
 * unterminated fence is never frontmatter, so it cannot swallow the document.
 *
 * Returns the line numbers of both fences, or null. The opening fence is
 * reported as well as the closing one because spoken frontmatter has to tell a
 * fence line from an interior line, and leading blank lines mean the opener is
 * not necessarily line 0.
 */
function detectFrontmatter(lines: string[]): { startLine: number; endLine: number } | null {
	let open = 0;
	while (open < lines.length && lines[open]!.replace(/^\uFEFF/, "").trim() === "") open += 1;
	if (open >= lines.length || !isFrontmatterFence(lines[open]!)) return null;

	let sawKey = false;
	let flowDepth = 0;
	for (let n = open + 1; n < lines.length; n++) {
		const line = lines[n]!;
		if (isFrontmatterFence(line)) return sawKey ? { startLine: open, endLine: n } : null;
		if (flowDepth > 0) {
			flowDepth = Math.max(0, flowDepth + flowDepthDelta(line));
			continue;
		}
		if (line.trim() === "" || FM_COMMENT.test(line)) continue;
		if (FM_KEY.test(line)) {
			sawKey = true;
			flowDepth = Math.max(0, flowDepthDelta(line));
			continue;
		}
		// Lists and indented continuations only make sense as a key's value.
		if (sawKey && (FM_LIST_ITEM.test(line) || FM_CONTINUATION.test(line))) {
			flowDepth = Math.max(0, flowDepthDelta(line));
			continue;
		}
		return null;
	}
	return null;
}

/**
 * Key names and polarity match the stored Settings, so the call site passes
 * them straight through. A negation at the boundary is how skipUrls and
 * speakUrls drifted apart once already.
 */
export interface ExtractOptions {
	stripTags: boolean;
	/** Bare URLs are spoken as their host only (docs/adr/0003). */
	speakUrls: boolean;
	/** Fenced and indented code blocks. */
	skipCodeBlocks: boolean;
	skipInlineCode: boolean;
	skipTables: boolean;
	skipHeadings: boolean;
	/** The YAML frontmatter block, as docs/adr/0002 defines one. */
	skipFrontmatter: boolean;
	/** A markdown image's alt text. Its destination is never spoken. */
	speakImageAlt: boolean;
	/** An Obsidian embed, spoken as a label for its local reference. */
	speakEmbeds: boolean;
	/**
	 * The language Obsidian's UI is in, from appLocale(). Not a setting and not
	 * a detected language: nothing here inspects the note to guess what it is
	 * written in, and nothing here chooses a voice. It is only the locale the
	 * sentence and word segmenters are built with, and it is required rather
	 * than optional for the reason the nine content keys are - an optional
	 * field with a default is how a dead option hides (see CONTEXT.md).
	 */
	locale: string;
}

/**
 * Turn a markdown note into speakable chunks.
 *
 * Frontmatter is located up front by shape (see detectFrontmatter) and then
 * either skipped or spoken as source-mapped metadata, per skipFrontmatter. The rest
 * works line by line. It tracks fence state, because that decides whether a
 * `#` is a tag or a heading, and a little block state (list, indented code,
 * whether the previous line was blank or paragraph text), because that
 * decides whether an indented line is code and whether `---` underlines a
 * heading or is a rule.
 *
 * Plain paragraph lines are buffered and joined before sentence-splitting.
 * Markdown soft-wraps a paragraph across multiple source lines with no blank
 * line between them, and without this a normally-written note would pause at
 * every wrap point as if each line were its own sentence, not just at actual
 * paragraph breaks. A blank line, a heading, a list item, a blockquote or a
 * table row still flushes the buffer: those keep their own pacing rather than
 * being folded into surrounding prose.
 */
export function extractChunks(
	source: string,
	opts: ExtractOptions,
	src: SegmenterSource = platformSegmenters,
	filePath: string = "",
): SpeechChunk[] {
	const chunks: SpeechChunk[] = [];
	const lines = source.split("\n");
	// `htmlCloserAhead[n]` is "some line AFTER n, and before the first line that
	// ends n's paragraph, carries `-->`" - term 2 of the HTML-comment block rule
	// (NRL-74, ADR 0025), bounded by the paragraph as module 4839's inline `.T`
	// is (NRL-95). One backward pass, still O(L) time once and O(1) per test,
	// now with O(L) booleans of state. NOT a helper that rescans `lines` per
	// test: that would be an O(L) scan inside codeSpanClosesLater's O(L) loop
	// inside this O(L) loop, so O(L^3) on a long note.
	//
	// Three details are load-bearing. The assignment PRECEDES folding line k in,
	// which is the old scalar's strict `>` - a `-->` on line n cannot close an
	// opener later on n, and the caller has already ruled out one after the
	// opener on that line. `ahead` is reset at a stop line, because a paragraph
	// cannot see past its own end. And a `-->` sitting ON a stop line is
	// deliberately unreachable from earlier lines, while the stop line itself
	// still gets the following run's answer.
	//
	// NRL-111 added `term2Stop`, a FORWARD pass, because one term of the stop set
	// is no longer answerable from the line alone. A setext `=` underline ends a
	// paragraph only when it is the block's SECOND line (module 8671 takes exactly
	// one content line, and `setextHeading` is disabled as an interrupter), so
	// `endsTerm2Scan` needs the count of content lines above. That count depends
	// on lines BEFORE k and the `-->` carry depends on lines AFTER k, so the two
	// cannot share one loop in either direction; both are O(L) and the pair is
	// still O(L).
	//
	// `paraLinesAbove` resets on `endsTerm2Block` and NOT on `endsTerm2Scan`. The
	// difference is a dash run OFF a block's second line, which is a stop without
	// being a block end: resetting there would make `--` / `Prose <!--` / `===` /
	// `HIDDENE` / `--> t.` treat its `===` as a second line and speak `HIDDENE`,
	// which the renderer hides. ON a block's second line the same dash run IS an
	// `<h2>` and does reset, through `TERM2_SETEXT_DASH`. Both directions measured
	// against real rendered HTML.
	const term2Stop: boolean[] = new Array<boolean>(lines.length).fill(false);
	{
		let paraLinesAbove = 0;
		for (let k = 0; k < lines.length; k++) {
			const line = lines[k]!;
			// Both predicates are asked with the SAME count, before it is updated.
			// `endsTerm2Scan` is called rather than its one extra term inlined, so
			// the scan's stop set keeps exactly one definition.
			term2Stop[k] = endsTerm2Scan(line, paraLinesAbove);
			paraLinesAbove = endsTerm2Block(line, paraLinesAbove) ? 0 : paraLinesAbove + 1;
		}
	}
	const htmlCloserAhead: boolean[] = new Array<boolean>(lines.length).fill(false);
	let ahead = false;
	for (let k = lines.length - 1; k >= 0; k--) {
		const line = lines[k]!;
		htmlCloserAhead[k] = ahead;
		if (term2Stop[k]!) {
			ahead = false;
			continue;
		}
		if (line.includes("-->")) ahead = true;
	}
	// `listDedented[n]` is "line n is the CONTENT of a list item, so Obsidian has
	// already removed its leading whitespace before any block tokenizer sees it"
	// (NRL-93). It is the third argument of opensObsidianBlock and the reason the
	// `%%` line-start rule cannot be a character class: see that predicate for the
	// three modules that do the dedenting.
	//
	// A forward O(L) pass with O(L) booleans, in the shape of the backward
	// htmlCloserAhead pass above and for the same reason - codeSpanClosesLater and
	// bracketClosesLater ask about lines they are not consuming, so a scalar
	// carried by the per-line loop could not answer them.
	//
	// Four things are load-bearing. The run is tracked on the QUOTE-PEELED view,
	// because a list inside a blockquote dedents its item content exactly as a
	// top-level one does while `containerPrefix` calls that line a quote rather
	// than a list - without the peel, `> - item` / `> \t%%` newly speaks the
	// hidden text. The MARKER line itself is false, because module 745's `M`
	// assigns the item's first line (`c[0] = s`) the text after the marker
	// UNDEDENTED; in practice `at` is 0 there, LIST_BULLET having eaten the whole
	// lead, so this is a statement of the rule rather than a live branch. The
	// run is ended by roughly the condition the per-line loop uses for `inList`,
	// minus its BLOCKQUOTE arm, which the peel makes wrong here: a quote line
	// after a list item is item content for module 745, since `interruptList`
	// holds no blockquote entry.
	//
	// And the two run-ending terms must each consult the view the renderer
	// actually decides on, which is NOT the peeled body in either case. This is
	// the correction NRL-93's own Verify pass blocked the PR for: a first draft
	// asked both questions of `body` alone and so DISCLOSED author-hidden text in
	// 1,780 cells of a 3,360-cell corpus, measured against real rendered HTML.
	//
	// - HEADING / FENCE / HR may end the run only when the line is NOT quoted.
	//   `> ---` inside a list item is a thematic break inside a BLOCKQUOTE nested
	//   in that item; it ends neither the item nor the list, so the next line is
	//   still dedented item content and a tab-led `%%` there really does open a
	//   comment block. Peeling first turns it into a bare `---`, which really
	//   would end the list, and the construct is mistaken for one it is not.
	//   Measured: 1,480 of 2,464 cells leaked without this term, 0 with it.
	// - `blankBefore` may end the run only when the line's RAW indent is empty as
	//   well as its peeled body's. `- item` / blank / `  > q` keeps the quote
	//   inside the item because two columns reach its content indent, where the
	//   same quote at column 0 genuinely does end the list. The peel removes the
	//   indent along with the marker, so the peeled body cannot tell the two
	//   apart. Measured: 368 of 896 cells leaked without this term, 0 with it.
	//
	// The remaining approximations err toward TRUE, which is the pre-NRL-93
	// behaviour: an indented non-item line that really did end the renderer's
	// list (`- item` / ` # Head`) keeps the run alive here, and a line whose
	// indent survives the dedent because an enclosing construct re-indents it is
	// likewise left hidden. Both are measured, named divergences rather than new
	// ones. What this pass does NOT claim is that erring toward TRUE is an
	// invariant of the whole pass: the two terms above are precisely the places
	// where it did not hold, they were found by measurement and not by reading,
	// and the guarantee that survives is the structural one stated on
	// `opensObsidianBlock` instead.
	const listDedented: boolean[] = new Array<boolean>(lines.length).fill(false);
	{
		let inItem = false;
		let blankBefore = true;
		for (let k = 0; k < lines.length; k++) {
			const raw = lines[k]!;
			const body = raw.replace(BLOCKQUOTE, "");
			const quoted = BLOCKQUOTE.test(raw);
			const blank = body.trim() === "";
			const marker = LIST_BULLET.test(body);
			const indented = /^\s/.test(raw) || /^\s/.test(body);
			if (
				inItem &&
				!blank &&
				!marker &&
				!indented &&
				(blankBefore || (!quoted && (HEADING.test(body) || FENCE.test(body) || HR.test(body))))
			) {
				inItem = false;
			}
			listDedented[k] = inItem && !marker;
			if (marker) inItem = true;
			blankBefore = blank;
		}
	}
	const segmentCtx: SegmentContext = { locale: opts.locale, src };
	let chunkSequence = 0;

	// Per-line raw offsets, because a math block skips ahead several lines at
	// once and every sourceIndex entry must still be a true raw offset.
	const lineStarts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineStarts.push(offset);
		offset += line.length + 1;
	}

	let inFence = false;
	let inComment: CommentCloser | undefined;
	// Length of a confirmed inline code span left open by the previous line.
	// Armed only on the plain-paragraph path and only once codeSpanClosesLater
	// has found the closing run, so every other path clears it.
	let openCode: number | undefined;
	// The image or link label left open by the previous line, on the same terms
	// and cleared by the same paths as openCode (NRL-63). Only one of the two is
	// ever armed for a given line; see cleanLine's header for which wins.
	let openBracket: BracketKind | undefined;
	// Travels with openBracket and is cleared by exactly the same paths, being
	// part of the same carry rather than state of its own (NRL-88).
	let openBracketDepth = 0;
	let inIndentedCode = false;
	// Inside a list item, an indented line is item content or a nested item,
	// never code. Kept across blank lines, since loose lists have them.
	let inList = false;
	// Document start counts as a blank line for indented code, and so does the
	// line right after frontmatter, which is skipped without updating these.
	let prevBlank = true;
	// The previous line was plain paragraph text, so a setext underline here
	// turns the buffered paragraph into a heading.
	let prevPara = false;
	// The previous line was a list item or quote line, or a lazy continuation
	// of one. A plain line after it continues that container, and CommonMark
	// does not let a setext underline follow a lazy line: "---" there is a
	// rule. Getting this wrong let skipHeadings drop the continuation text.
	let prevContainer = false;
	const frontmatter = detectFrontmatter(lines);
	const stripOpts: StripOptions = {
		stripTags: opts.stripTags,
		skipInlineCode: opts.skipInlineCode,
		speakUrls: opts.speakUrls,
		speakImageAlt: opts.speakImageAlt,
		speakEmbeds: opts.speakEmbeds,
	};
	/*
	 * Frontmatter is metadata, not markdown prose, so a spoken line is cleaned
	 * with its own options. Tags are never stripped, because a `#` in a value is
	 * part of that value rather than an Obsidian tag, and inline code is never
	 * skipped, because a backtick in a YAML string is a character. URLs still
	 * follow speakUrls, so a `source:` field does not read out a path. Nothing
	 * is reserialised: the line's own characters are emitted with their true raw
	 * offsets, so `tags: [a, b]` is heard exactly as it was written.
	 */
	const frontmatterOpts: StripOptions = {
		...stripOpts,
		stripTags: false,
		skipInlineCode: false,
	};

	let paraText = "";
	let paraIndex: number[] = [];
	let paraStart = 0;
	// The kind of block the buffer is holding, so a buffered paragraph is not
	// hardcoded to one value at flush time. Every appendToParagraph call site
	// today takes the default, so this is "paragraph" in practice; the setext
	// route does not go through here either, it passes "heading" to
	// flushParagraph directly. The parameter exists so a future route that
	// reclassifies a buffered line has one place to do it in.
	let paraBlockType: BlockType = "paragraph";

	const flushParagraph = (blockType: BlockType = paraBlockType): void => {
		if (paraText.trim() !== "") {
			chunks.push(...splitSentences(paraText, paraIndex, paraStart, segmentCtx, blockType));
		}
		paraText = "";
		paraIndex = [];
	};

	const appendToParagraph = (cleaned: Cleaned, start: number, blockType: BlockType = "paragraph"): void => {
		if (paraText === "") {
			paraText = cleaned.text;
			paraIndex = cleaned.index;
			paraStart = start;
			paraBlockType = blockType;
		} else if (paraText.endsWith(" ")) {
			// The line already ended in a real mapped space, because whatever
			// it ended with was dropped: a comment, an image, a tag, a URL, an
			// emoji or a CR. A second synthetic one would put two spaces in the
			// spoken text and a second index entry with it. cleanLine and
			// verbatimLine can never emit a leading space, so only this side
			// needs checking.
			paraText += cleaned.text;
			paraIndex = [...paraIndex, ...cleaned.index];
		} else {
			// Same join convention as mergeShort: the space between the two
			// lines is synthetic, so it is attributed to the character right
			// before whatever comes next.
			const gap = sourceOffsetOfSpace(
				(paraIndex[paraIndex.length - 1] ?? paraStart) + 1,
				cleaned.index[0] ?? start,
			);
			paraText = `${paraText} ${cleaned.text}`;
			paraIndex = [...paraIndex, gap, ...cleaned.index];
		}
	};

	/** Clean closing-line prose, including any further comments. */
	const appendRemainder = (raw: string, from: number, lineStart: number, lineNo: number): void => {
		const cleaned = cleanLine(
			raw.slice(from),
			lineStart + from,
			stripOpts,
			true,
			undefined,
			undefined,
			undefined,
			undefined,
			htmlCloserAhead[lineNo]!,
			0,
			listDedented[lineNo]!,
		);
		inComment = cleaned.openComment;
		if (cleaned.text.trim() !== "") appendToParagraph(cleaned, lineStart + from);
	};

	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const raw = lines[lineNo]!;
		const lineStart = lineStarts[lineNo]!;
		// Read and cleared up front, so every path that does not re-arm it
		// below drops the carry: a blank line, a fence, indented code, a
		// heading, a list, a quote, a table row, a rule, a setext underline, a
		// comment-hidden line and appendRemainder all end the paragraph the
		// span was in, and a span cannot outlive its paragraph.
		const carriedCode = openCode;
		openCode = undefined;
		// Read and cleared on exactly the same terms as carriedCode above, and for
		// the same reason: a label cannot outlive its paragraph either.
		const carriedBracket = openBracket;
		openBracket = undefined;
		const carriedBracketDepth = openBracketDepth;
		openBracketDepth = 0;

		// This deliberately diverges from Obsidian, which only honours a `---`
		// on line 1. A note that starts with blank lines and then a `key: value`
		// block renders in Obsidian as a rule and visible text, and we stay
		// silent on it. That is intended: silence on visible text is
		// recoverable, reading someone's frontmatter aloud is not. Do not "fix"
		// this back to a positional check; see docs/adr/0002.
		//
		// Skipped lines are dropped whole. lineStarts are fixed up front, so
		// every later sourceIndex entry is still a true raw offset.
		//
		// Nothing here touches prevBlank/prevPara/inList/inFence, in either
		// position: the block is its own paragraph, and leaving prevBlank at its
		// initial true is what lets an indented line right after the fence still
		// be recognised as code.
		if (frontmatter && lineNo <= frontmatter.endLine) {
			// The closing fence ends the block, so buffered metadata becomes its
			// own chunk rather than merging into the first prose line.
			if (lineNo === frontmatter.endLine) flushParagraph();
			// Both fences are markup and are never spoken, in either position.
			if (
				opts.skipFrontmatter ||
				lineNo === frontmatter.startLine ||
				lineNo === frontmatter.endLine
			) {
				continue;
			}
			// A blank line and a YAML `#` comment carry no metadata.
			if (raw.trim() === "" || FM_COMMENT.test(raw)) continue;
			// blockComments stays false and the returned openComment/openCode are
			// deliberately discarded: a frontmatter value must never be able to
			// open a document-level comment or code span and silence the note
			// body, which is the one direction ADR 0006 exists to prevent. An
			// unmatched delimiter in a value is YAML text, which Obsidian shows
			// in its properties table, so it is not hidden content. A *complete*
			// `%%` or `<!--` span inside a value is still suppressed, by the same
			// branch that suppresses one in prose (ADR 0008).
			const meta = cleanLine(raw, lineStart, frontmatterOpts);
			if (meta.text.trim() !== "") appendToParagraph(meta, lineStart);
			continue;
		}

		// Hidden lines must not change blank, paragraph, list, code or math state.
		// In particular, a different comment delimiter cannot close this one.
		if (inComment) {
			const close = raw.indexOf(inComment);
			if (close === -1) continue;
			appendRemainder(raw, close + inComment.length, lineStart, lineNo);
			continue;
		}

		const blank = raw.trim() === "";
		const wasBlank = prevBlank;
		const wasPara = prevPara;
		const wasContainer = prevContainer;
		// Read before the list-end check below, which ends the list on this very
		// "---" line and would otherwise hide that the paragraph was in it.
		const wasInList = inList;
		prevBlank = blank;
		prevPara = false;
		prevContainer = false;

		if (!inFence) {
			// A list ends at an unindented line that is not an item, when a blank
			// line precedes it or it opens another block. Without a blank line an
			// unindented line is lazy continuation of the item.
			if (
				inList &&
				!blank &&
				!/^\s/.test(raw) &&
				!LIST_BULLET.test(raw) &&
				(wasBlank || HEADING.test(raw) || FENCE.test(raw) || HR.test(raw) || BLOCKQUOTE.test(raw))
			) {
				inList = false;
			}

			// Indented code. Checked before fences, rules, math and tables: an
			// indented "```" or "| a |" is code content, not a block opener. Blank
			// lines stay inside the block; a less-indented line ends it and is then
			// read normally. Spoken like a fenced block when skipCodeBlocks is off,
			// through verbatimLine, which drops the indent with true offsets.
			if (inIndentedCode) {
				if (blank) continue;
				if (INDENTED_CODE.test(raw)) {
					if (!opts.skipCodeBlocks) appendToParagraph(verbatimLine(raw, lineStart), lineStart);
					continue;
				}
				inIndentedCode = false;
				flushParagraph();
			} else if (!blank && !inList && wasBlank && INDENTED_CODE.test(raw)) {
				flushParagraph();
				inIndentedCode = true;
				if (!opts.skipCodeBlocks) appendToParagraph(verbatimLine(raw, lineStart), lineStart);
				continue;
			}
		}

		// The fence line itself, including an info string like "js", is never
		// spoken. Flushing at both fences paces a spoken block as one paragraph.
		if (FENCE.test(raw)) {
			flushParagraph();
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			if (opts.skipCodeBlocks || raw.trim() === "") continue;
			appendToParagraph(verbatimLine(raw, lineStart), lineStart);
			continue;
		}
		// Setext heading: the whole buffered paragraph is the heading, as in
		// CommonMark, and the underline is never spoken. Before HR, since "---"
		// under a paragraph line is an underline, not a rule. Never inside a
		// list: an unindented underline is outside the item, so it is a rule,
		// and erring that way speaks the text instead of dropping it.
		if (wasPara && !wasInList && paraText !== "" && SETEXT.test(raw)) {
			if (opts.skipHeadings) {
				paraText = "";
				paraIndex = [];
			} else {
				flushParagraph("heading");
			}
			continue;
		}
		if (HR.test(raw)) {
			flushParagraph();
			continue;
		}

		// Display math block: a line starting `$$` with no closer on it, closed
		// by a `$$` on a later line. It is one chunk, the word "equation"
		// (docs/adr/0004), mapped like the inline form: the opening `$` for
		// all but the last letter, the final closing `$` for the last. With no
		// closer anywhere it is not a block, so a stray `$$` cannot swallow the
		// rest of the note.
		const mathOpen = raw.indexOf("$$");
		if (raw.trimStart().startsWith("$$") && raw.indexOf("$$", mathOpen + 2) === -1) {
			let closeLine = lineNo + 1;
			while (closeLine < lines.length && !lines[closeLine]!.includes("$$")) closeLine += 1;
			if (closeLine < lines.length) {
				const closeAt = lines[closeLine]!.indexOf("$$");
				const open = lineStart + mathOpen;
				const last = lineStarts[closeLine]! + closeAt + 1;
				flushParagraph();
				chunks.push(...splitSentences("equation", [open, open, open, open, open, open, open, last], open, segmentCtx, "other"));
				lineNo = closeLine;
				appendRemainder(lines[closeLine]!, closeAt + 2, lineStarts[closeLine]!, closeLine);
				continue;
			}
		}
		// The block scan already knows which construct this line belongs to, so
		// it says so rather than setting a boolean and throwing the answer away.
		// "paragraph" is the else: a plain prose line, and also a lazy
		// continuation of a list or quote, which matches nothing on its own line.
		//
		// The peel itself lives in containerPrefix (NRL-98), so the lookahead and
		// this consumption read one definition of where the prefix ends. Only the
		// three SIDE EFFECTS stay here, because a lookahead must be able to ask
		// the question about a line it is not consuming.
		const prefix = containerPrefix(raw);
		const prefixChars = prefix.chars;
		const blockType: BlockType = prefix.blockType;
		if (blockType === "quote") prevContainer = true;
		if (blockType === "list") {
			prevContainer = true;
			// A quoted list ends with its quote, so it does not hold the list
			// state that shields later indented lines from being code. blockType
			// is "list" only when BLOCKQUOTE did NOT match, which is the same
			// `if (!q)` this used to spell out: containerPrefix leaves a quoted
			// list item as "quote".
			inList = true;
		}
		const body = raw.slice(prefixChars);

		if (body.trim() === "") {
			flushParagraph();
			continue;
		}
		if (/^[-*_]{3,}$/.test(body.trim())) {
			flushParagraph();
			continue;
		}

		/*
		 * Two passes, and the order is the whole of NRL-64.
		 *
		 * The first pass learns one fact this line cannot know on its own: the
		 * length of an unmatched backtick run it leaves open. codeSpanClosesLater
		 * then answers whether a later line in this paragraph really closes it,
		 * with the IDENTICAL call the two old arming sites made - the call moved,
		 * the function did not. Only then is the line cleaned again, now knowing
		 * its own tail is code content rather than prose.
		 *
		 * Before this, cleanLine ran once and ran first, so on a span's OPENING
		 * line the text after the run was cleaned as markdown while every other
		 * line of the same span was verbatim. That was NRL-44's N1 sub-shape.
		 *
		 * The `blockType === "paragraph"` guard is HOISTED here from the two old
		 * arming sites, where it was explicit at one and left to the
		 * `blockType !== "paragraph"` early return at the other. It is kept
		 * deliberately, and it is deliberately NOT the only thing stopping a carry
		 * being armed off a heading, a quote or a list line: `blockType` leaves
		 * "paragraph" only when HEADING, BLOCKQUOTE or LIST_BULLET matched this
		 * same raw line, and codeSpanClosesLater runs interruptsParagraph over
		 * `lines[from]` first, which tests all three. Measured: deleting this test
		 * changed 0 of 9,792 extractions across those shapes. So it is redundant
		 * belt-and-braces today, cheap, and the thing that keeps the intent -
		 * a span cannot leave its own block - stated where the carry is armed
		 * rather than only inside a helper two hundred lines away.
		 *
		 * Not a lookahead callback into cleanLine: that would make cleanLine
		 * document-aware. The cost is one redundant clean of a line with a
		 * confirmed unmatched run, which is rare, and provably a no-op on a line
		 * wholly inside an already-carried span.
		 */
		const htmlClosesLater = htmlCloserAhead[lineNo]!;
		const dedentedByList = listDedented[lineNo]!;
		let cleaned = cleanLine(body, lineStart + prefixChars, stripOpts, true, carriedCode, undefined, carriedBracket, undefined, htmlClosesLater, carriedBracketDepth, dedentedByList);
		let confirmed: number | undefined;
		if (
			blockType === "paragraph" &&
			cleaned.openCode !== undefined &&
			codeSpanClosesLater(lines, lineNo, cleaned.openCode, htmlCloserAhead, listDedented)
		) {
			confirmed = cleaned.openCode;
			cleaned = cleanLine(body, lineStart + prefixChars, stripOpts, true, carriedCode, confirmed, carriedBracket, undefined, htmlClosesLater, carriedBracketDepth, dedentedByList);
		}
		/*
		 * The second confirmed-carry kind, attached at the site NRL-64 built and
		 * consumed through the same emit-a-region shape (NRL-63). One more pass, on
		 * the same terms: pass 1 discovers an `![`/`[` this line leaves unmatched,
		 * bracketClosesLater answers whether a later line really closes it with a
		 * destination, and only then is the line cleaned again knowing its tail is
		 * label content rather than prose.
		 *
		 * `confirmed === undefined` is the precedence rule, not an optimisation. A
		 * code span binds tighter than a label in CommonMark, so when a line opens
		 * both the code carry takes it and the label is not recognised - which
		 * leaves NRL-64's path untouched and leaves the mixed shape exactly as it
		 * was rather than half-changed. ADR 0023 records the residual.
		 */
		/*
		 * `blockType` HERE is the one conjunct NRL-98 relaxed, and it is the
		 * second of this fix's two edits rather than tidying. Measured, not read:
		 * teaching bracketClosesLater to peel a container prefix at both ends and
		 * leaving this test alone left ALL EIGHT root-1 container shapes still
		 * speaking their destination, because for `> A ![alt` or `- A ![alt`
		 * blockType is "quote"/"list" and this arm is gated independently of the
		 * predicate. So the carry has to be armable off a quote or a list line.
		 *
		 * NEVER "heading": an ATX heading is one line and cannot soft-wrap, which
		 * guard-nrl63-opening-line-is-heading pins. The CODE arm above keeps the
		 * bare `blockType === "paragraph"`, so `confirmed` stays undefined on a
		 * container line and the `confirmed === undefined` precedence rule below
		 * is satisfied for free. The comment on the first pass calls that guard
		 * "redundant belt-and-braces today"; that remains true of the CODE arm and
		 * is NOT true of this copy, which is now load-bearing in the opposite
		 * direction - widening it is what arms the carry at all.
		 */
		let confirmedBracket: BracketKind | undefined;
		if (
			(blockType === "paragraph" || blockType === "quote" || blockType === "list") &&
			confirmed === undefined &&
			cleaned.unclosedBracket !== undefined &&
			bracketClosesLater(lines, lineNo, htmlCloserAhead, listDedented)
		) {
			confirmedBracket = cleaned.unclosedBracket;
			cleaned = cleanLine(
				body,
				lineStart + prefixChars,
				stripOpts,
				true,
				carriedCode,
				undefined,
				carriedBracket,
				confirmedBracket,
				htmlClosesLater,
				carriedBracketDepth,
				dedentedByList,
			);
		}
		// Taken from the SECOND pass on purpose. A comment delimiter inside the
		// confirmed tail is code content, so it opens nothing - which is the same
		// reading of ADR 0006 clause 4 that NRL-44 applied to continuation lines,
		// not a new hole. It cannot hide anything either: a line that leaves a
		// comment open is an opensHiddenComment line, and codeSpanClosesLater
		// rejects those at both ends, so no confirmation exists on such a line.
		inComment = cleaned.openComment;
		// A link reference definition renders as nothing, so the whole line goes
		// (docs/adr/0018). Deliberately AFTER cleanLine and after `inComment` is
		// assigned, for the same reason the skipTables branch below is: a title
		// or destination can carry an unclosed `<!--`, and dropping the line
		// before that was parsed would stop the comment opening and make text
		// the author hid audible.
		//
		// Tested on `body`, post-prefix-peel, so a definition on the first line
		// of a quote or list item is caught too - it renders as nothing there
		// as well. The rest of the guard is what CommonMark's "may not
		// interrupt a paragraph" needs from a per-line scanner: an empty
		// paragraph buffer, no paragraph line before it, and no container line
		// before it either, since a lazy continuation inside a quote or list
		// reaches here with the global buffer still empty. A heading is
		// excluded because a leaf block cannot sit inside one, so `# [a]: x.png`
		// is inline content the renderer shows.
		//
		// No flushParagraph: `paraText === ""` is a precondition, so it would
		// provably be a no-op. And when `carriedCode` is live the previous line
		// was a buffered paragraph line, so `paraText !== ""` and this branch
		// cannot fire - a soft-wrapped code span can never be cut short here.
		if (blockType !== "heading" && paraText === "" && !wasPara && !wasContainer && LINK_REF_DEF.test(body)) {
			continue;
		}
		// Output exclusions do not exclude parsing: an HTML or Obsidian comment
		// opened in a skipped heading/table must still hide its following lines.
		if ((opts.skipTables && TABLE_ROW.test(raw)) || (opts.skipHeadings && blockType === "heading")) {
			flushParagraph();
			continue;
		}
		// The single arming site, replacing the two NRL-44 left behind. Its
		// position is load-bearing in both directions. It is AFTER the
		// LINK_REF_DEF drop and the skipTables/skipHeadings drop, because a line
		// those remove renders as nothing and must hand on no carry - a next line
		// treated as the continuation of a span whose opener was never spoken.
		// And it is BEFORE the empty-output continue below, because NRL-44 made
		// that path reachable: under skipInlineCode a line lying wholly inside a
		// span is silenced whole and cleans to the empty string, and dropping the
		// carry there would leave the span's closing line read as fresh prose.
		// The label carry is armed here too, for every one of those reasons, and
		// the order between the two is the other half of the precedence rule: a
		// label already live holds the carry, because it opened first and the run
		// inside it is part of its content. Only one of the two is ever set.
		openBracket = cleaned.openBracket;
		openBracketDepth = cleaned.openBracketDepth ?? 0;
		if (confirmed !== undefined && openBracket === undefined) openCode = confirmed;

		if (cleaned.text.trim() === "") {
			continue;
		}

		if (blockType !== "paragraph") {
			flushParagraph();
			chunks.push(...splitSentences(cleaned.text, cleaned.index, lineStart + prefixChars, segmentCtx, blockType));
			continue;
		}

		appendToParagraph(cleaned, lineStart + prefixChars);
		if (wasContainer) prevContainer = true;
		else prevPara = true;
	}

	flushParagraph();

	// Inject identity fields into chunks
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!;
		const hash = (str: string) => {
			let h = 0;
			for (let j = 0; j < str.length; j++) {
				const char = str.charCodeAt(j);
				h = ((h << 5) - h) + char;
				h = h & h; // Convert to 32-bit integer
			}
			return Math.abs(h).toString(16);
		};
		chunk.id = `${hash(filePath + i + chunk.sourceStart)}`;
		chunk.sequence = i;
		chunk.filePath = filePath;
		/*
		 * Word spans for the highlight layer (NRL-47). This post-pass is the
		 * only correct place for them: `mergeShort` mutates `prev.text` and
		 * `prev.sourceIndex` in place and `splitOversized` re-slices both, so a
		 * span computed any earlier would index text that no longer exists. By
		 * here every chunk's `text` is final.
		 *
		 * Set only when subdivision actually changed something, so an English
		 * note gains neither the field nor the array and the `?? findWords(...)`
		 * fallback in `allocateWordTimings` stays the default path rather than
		 * becoming dead code.
		 */
		const cuts = wordCutPoints(chunk.text, segmentCtx);
		if (cuts.length > 0) {
			const spans = findWords(chunk.text, cuts);
			if (spans.length !== findWords(chunk.text).length) chunk.wordSpans = spans;
		}
		// blockType is deliberately not set here. It is decided by the block scan
		// and labelled in the SpeechChunk literal inside splitSentences, so it
		// is already real by the time this post-pass runs. Overwriting it here
		// is what made every chunk read "paragraph" (NRL-17, closed in NRL-50).
	}

	return chunks;
}
