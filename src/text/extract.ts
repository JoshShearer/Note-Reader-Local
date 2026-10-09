import type { BlockType, SpeechChunk } from "../audio/types";
// words.ts imports nothing but its own types, so this edge adds no node builtin
// and no new entry to main.js's require() list (non-negotiable 7).
import { findWords, hasCjkScript } from "../audio/words";
import { fallbackHtmlHidden, rendererHiddenText } from "./obsidianBlocks";
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

// U+FE0F (variation selector 16) is a lone alternative rather than a class
// member: inside a class lint reads it as a combining mark that could merge with
// a neighbour. With the `u` flag both forms match exactly the same single code
// points, checked over every code point and every lone UTF-16 code unit.
const EMOJI =
	/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]|\u{FE0F}/u;

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
	/**
	 * Set only beside an `openComment` of `-->`, and true when that comment was
	 * opened as a document-level HTML BLOCK - the line was raw HTML for the
	 * renderer - rather than by the paragraph-scoped term 2 (NRL-136). The line
	 * that closes it is then the last line of a raw HTML block too, so its
	 * remainder is raw and any later unclosed `<!--` on it opens a browser
	 * comment. extractChunks hands it back as `htmlContext: "raw"`.
	 */
	openCommentBlock?: boolean;
	/**
	 * Set only beside an `openComment` of `-->` that NRL-136's term opened: a
	 * BROWSER comment inside rendered output rather than an HTML block. The
	 * markdown under it is still parsed, so a fence it covers is still a fence,
	 * a `%%` block or an inline `%%...%%` pair it covers is still removed (and a
	 * `-->` inside one with it), and a line-start `<!--` under it still opens a
	 * markdown HTML block. extractChunks models those across the hidden lines.
	 */
	openCommentBrowser?: boolean;
}

/**
 * Where the view handed to cleanLine sits, for the one question NRL-136 adds:
 * can a LATER unclosed `<!--` on this line open a document-level comment even
 * though the slice before it is not blank?
 *
 * - `"none"`: no. Inline context only - a heading, a re-cleaned label, a
 *   frontmatter value, setext heading content, a line that is not an HTML
 *   block, or the remainder of a comment term 2 opened. This is byte-for-byte
 *   the pre-NRL-136 behaviour, and it is the default.
 * - `"block"`: the CALLER has established that this view is an HTML-block line
 *   for the renderer: it begins at a block-start position and its FIRST `<!--`
 *   starts a block (`htmlBlockLine`, on the list-stripped view). A later
 *   unclosed `<!--` opens a browser comment.
 * - `"raw"`: the view is the remainder of the last line of a raw HTML block,
 *   so every unclosed `<!--` on it opens, at any column.
 * - `"inline"`: the view is what follows a BROWSER comment's `-->` on a line
 *   that is not an HTML block, i.e. the rest of an ordinary line. Its `<!--`
 *   is inline, so only term 2 can open it; term 1's line-start test would be
 *   asking about a position that is not a line start for the renderer.
 *
 * `"block"` is decided by the caller rather than inside cleanLine because the
 * answer needs per-line document state cleanLine does not have: the setext
 * refusal (NRL-120) and the list-item strip (`listStrip`).
 */
type HtmlContext = "none" | "block" | "raw" | "inline";

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
 *
 * `setextContent` is NRL-120's, and it gates BOTH terms rather than either one.
 * Term 1 needs block position too: a line-start `<!--` reaches module 8776 only
 * if nothing earlier in `blockMethods` claims the block, and `setextHeading`
 * (index 10) runs before `html` (index 11), so a `<!--` line followed by an exact
 * underline is heading text. Measured: `<!--` / `===` / `HIDDENA` renders
 * `<h1 data-heading="<!--">&#x3C;!--</h1><p>HIDDENA</p>`. Term 2 is gated as well
 * because the heading is its own block and the inline regex cannot cross it
 * (decision Q7); in practice term 2 is already false there, since the underline
 * is a term-2 stop when it is a block's second line. Required, not defaulted, so
 * no caller keeps the old answer silently.
 *
 * `leadIndented` narrows TERM 1 ONLY, and is the correction to NRL-74's claim
 * that `.trim()` is right for `<!--` (NRL-115). Module 8776's skip loop does
 * accept any run of spaces and tabs, but module 8776 is never REACHED for a
 * paragraph continuation led by a tab or four columns (module 8607 absorbs it
 * as lazy prose without running the interrupt check) or for a fresh block
 * inside a container led by a tab or four spaces (module 134 makes it indented
 * code first). Both are judged after the renderer's own container dedent, which
 * a line-local predicate cannot see, so `rendererLeads` in extractChunks
 * decides it per line and it is handed in like `closesLater`. Term 2 is left
 * alone on purpose (decision Q3): a lazy `<!--` whose `-->` is later in the
 * same paragraph is still an inline comment for module 4839 and is hidden.
 *
 * NRL-115 and NRL-120 are two conjunctive refusals and they are deliberately
 * not the same shape: NRL-120's gates both terms because a setext content line
 * ENDS the paragraph (it is a heading), while NRL-115's gates term 1 only
 * because a lazy continuation line does NOT end it.
 *
 * It is a conjunctive refusal in front of term 1, so the new predicate implies
 * the old one for every argument: it can decline an opener the NRL-95 rule
 * accepted and can never accept one that rule declined. Checked exhaustively,
 * with this body read out of the file against NRL-120's four-argument body:
 * 0 violations over 291,272 tuples (every string on {space, tab, `<`, `x`} up
 * to length 6, every `at`, both values of all three flags), against 25,614 for
 * a deliberately widened variant.
 */
function opensHtmlBlock(view: string, at: number, closesLater: boolean, setextContent: boolean, leadIndented: boolean, leadSpace?: number): boolean {
	// `leadSpace`, when given, is the length of `view`'s leading whitespace run,
	// which answers the same question in O(1) for a caller asking about many
	// openers on one line (NRL-166 fix round 2).
	return !setextContent && ((!leadIndented && (leadSpace !== undefined ? at <= leadSpace : view.slice(0, at).trim() === "")) || closesLater);
}

/**
 * Text around an inline `<!--` that may hold an inline construct the renderer
 * displays as NOTHING (NRL-166 fix round 1): a raw tag, declaration, processing
 * instruction or CDATA (`<`; on a line of its own `<?`, `<!X` and `<![CDATA[` also
 * start an HTML block that interrupts the paragraph), a link or image label
 * (`[`), which a link destination or title also needs. Deliberately wide; a yes
 * only withholds a refinement, which keeps the comment hidden. Measured with the
 * harness: a `<!--` in a tag's attribute value, a link title or an image label
 * (which becomes the embed's `alt`) displays nothing, whether the construct
 * opens before the `<!--` or inside its would-be body. Narrowed by fix round 2,
 * which Verify 2 found withholding the refinements for constructs that hide
 * nothing: a backtick (a code span DISPLAYS its text) and a `](` (a link needs
 * its `[`, which already counts wherever the link could reach the `<!--`, since
 * a link cannot span the blank line that bounds the window; `> QCQ](u) --> QZQ`
 * with no `[` was a withheld closer).
 */
const INLINE_CONSTRUCT_MAY_HOLD = /<|\[/;
/**
 * A callout marker at the start of a line, behind its quote and list prefix:
 * `[!x]` there is no label, so it is taken out before the test above. Not when a
 * `(`, `[` or `:` follows it, which would make it a link or a definition.
 *
 * Each list-marker step is ONE space or tab and then `[ \t>]*`, never `[ \t]+`
 * then `[ \t>]*`: the two describe the same strings, but the second lets every
 * run of spaces split two ways, which is exponential on `-  -  -  ...` (measured
 * 382 ms at 24 markers, doubling per marker) and this runs on every line.
 */
const LEADING_CALLOUT_MARKER = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t][ \t>]*)*\[![^\]]*\][+-]?(?![([:])/;
/**
 * `INLINE_CONSTRUCT_MAY_HOLD` on `text`, a whole line or a line's leading part,
 * with a leading callout marker and every `<!--` taken out first. A `<!--` opens
 * no tag, declaration (that needs `<!` and a letter) or CDATA, and a comment that
 * really holds a later opener means our own comment state already owns that
 * line, so counting it would only withhold the rule from a second literal opener
 * (`P <!--> a` / `\tP <!--> b` / `--> c` lost b).
 */
function inlineConstructMayHold(text: string): boolean {
	return INLINE_CONSTRUCT_MAY_HOLD.test(text.replace(LEADING_CALLOUT_MARKER, "").replaceAll("<!--", ""));
}

/**
 * Whether one line's own backtick runs may pair differently for the renderer
 * than cleanLine pairs them (NRL-166 fix round 3). cleanLine pairs code spans
 * line by line; the renderer pairs them over the whole paragraph, left to
 * right, each run with the next run of the same length. The two agree on every
 * line exactly when no span the renderer makes crosses a line break, and the
 * first span that does starts at a run its own line leaves unpaired. So a line
 * is at risk when a run on it pairs with nothing on it (or a backslash stands
 * before a run, which may escape one of its backticks) AND a later line of the
 * same blank-bounded stretch holds a backtick it could pair with.
 *
 * Fix round 2 took the backtick out of `INLINE_CONSTRUCT_MAY_HOLD`, since a code
 * span displays its text, and Verify 3 found the cost: `P QAQ <!-- \`` /
 * `` ` <!-- QHQ ` --> QZQ`` displays `P QAQ <!-- QZQ` (the line-end backtick
 * pairs with the next line's first, so `<!-- QHQ ` -->` is a real comment), and
 * cleanLine, reading `` ` <!-- QHQ ` `` as code, spoke QHQ. A line this marks
 * counts as holding an inline construct, which keeps 44a037a's answer for the
 * window. Linear: one pass per line over its runs, and one backward pass.
 */
function backtickCrossRisk(lines: readonly string[]): boolean[] {
	const unsure = lines.map((line) => {
		if (!line.includes("`")) return false;
		const runs: number[] = [];
		for (let k = 0; k < line.length; ) {
			if (line.charCodeAt(k) !== 96) {
				k++;
				continue;
			}
			if (k > 0 && line.charCodeAt(k - 1) === 92) return true;
			let e = k;
			while (e < line.length && line.charCodeAt(e) === 96) e++;
			runs.push(e - k);
			k = e;
		}
		// The next run of the same length after each run, from the right.
		const nextSame = new Array<number>(runs.length).fill(-1);
		const seen = new Map<number, number>();
		for (let r = runs.length - 1; r >= 0; r--) {
			nextSame[r] = seen.get(runs[r]!) ?? -1;
			seen.set(runs[r]!, r);
		}
		for (let r = 0; r < runs.length; r = nextSame[r]! + 1) if (nextSame[r] === -1) return true;
		return false;
	});
	const out = new Array<boolean>(lines.length).fill(false);
	for (let k = lines.length - 1, tickBelow = false; k >= 0; k--) {
		const line = lines[k]!;
		if (line.trim() === "") {
			tickBelow = false;
			continue;
		}
		out[k] = unsure[k]! && tickBelow;
		if (line.includes("`")) tickBelow = true;
	}
	return out;
}

/**
 * cleanLine's three questions about one `<!--` at `at` on `raw`, answered in
 * O(1) after one O(line) pass (NRL-166 fix round 2). Asking them by slicing the
 * line at every `<!--` made one line of many literal openers quadratic: Verify
 * measured `P ` + `<!-- ` x 20,000 at 27,956 ms against 84 ms on main.
 *
 * - `prefixHolds(at)`: `inlineConstructMayHold(raw.slice(0, at))`.
 * - `suffixHolds(at)`: `inlineConstructMayHold(raw.slice(at + 4))`, except
 *   that no callout marker is taken off the front of the suffix: that removal
 *   only ever answered "no construct", so dropping it can only add a yes, the
 *   side on which the comment keeps hiding.
 * - `bodyStartOk(at)`: the opener line's share of the inline comment's body
 *   rule (NRL-166 fix round 1). The body after `<!--`, which holds no `-->`
 *   on this line, may not start with `>` or `->` (so `<!-->` and `<!--->` are
 *   literal) and may not hold `--`. Measured with the 1.13.7 parser:
 *   `P <!-- a -- b --> Z` and `P <!-- a` / `-- b --> Z` display every
 *   character, `P <!-- a -` / `--> Z` and `P <!--` / `-> a --> Z` hide the
 *   body, since the line break sits between the dashes. The later lines' share
 *   is `commentBodyOkAheadOf` in extractChunks.
 *
 * Both construct questions read one string: the line less its leading callout
 * marker and less every `<!--`. Every `<!--` there is removed (two cannot
 * overlap), so a prefix or a suffix of the line strips to a prefix or a suffix
 * of that string, and a construct lies in the part before `at` exactly when the
 * first match ends by `at`'s mapped position, and in the part after exactly when
 * the last match starts at or past it. A marker reaching past `at` answers yes.
 */
interface InlineCommentFacts {
	prefixHolds(at: number): boolean;
	suffixHolds(at: number): boolean;
	bodyStartOk(at: number): boolean;
}
function inlineCommentFacts(raw: string): InlineCommentFacts {
	const markerLen = LEADING_CALLOUT_MARKER.exec(raw)?.[0].length ?? 0;
	// strippedBefore[j]: the stripped string's length before raw position j.
	const strippedBefore = new Int32Array(raw.length + 1);
	const kept: string[] = [];
	for (let j = 0; j < raw.length; ) {
		strippedBefore[j] = kept.length;
		if (j >= markerLen && raw.startsWith("<!--", j)) {
			for (let k = 1; k < 4; k++) strippedBefore[j + k] = kept.length;
			j += 4;
			continue;
		}
		if (j >= markerLen) kept.push(raw[j]!);
		j++;
	}
	strippedBefore[raw.length] = kept.length;
	const stripped = kept.join("");
	const first = INLINE_CONSTRUCT_MAY_HOLD.exec(stripped);
	const firstEnd = first ? first.index + first[0].length : Infinity;
	let lastStart = -1;
	for (let p = stripped.length - 1; p >= 0; p--) {
		const c = stripped[p]!;
		if (c === "<" || c === "[") {
			lastStart = p;
			break;
		}
	}
	const lastDashes = raw.lastIndexOf("--");
	return {
		prefixHolds: (at) => markerLen > at || firstEnd <= strippedBefore[at]!,
		suffixHolds: (at) => markerLen > at || lastStart >= strippedBefore[at]!,
		bodyStartOk: (at) => !(raw[at + 4] === ">" || (raw[at + 4] === "-" && raw[at + 5] === ">")) && lastDashes < at + 4,
	};
}

/**
 * Is this line an HTML BLOCK for the renderer, because its FIRST `<!--` starts
 * one (NRL-136)? Asked about a line whose first comment CLOSES on it and whose
 * later `<!--` does not, a shape neither of opensHtmlBlock's terms can see: the
 * slice before the later opener is not blank, and the line is not in a
 * paragraph, so term 2's paragraph-scoped lookahead is the wrong question.
 *
 * Executed, not read: Obsidian 1.13.7's WT parser and GT renderer turn
 * `x` / blank / `<!-- y --> <!-- Q1Z` / `TAIL` into
 * `<p>x</p>\n<!-- y --> <!-- Q1Z\n<p>TAIL</p>`. Module 8776 opens an HTML block
 * at the line-start `<!--` and closes it on that same line at its `-->`, the
 * whole line passes through raw under `allowDangerousHtml`, and the second,
 * unclosed `<!--` then becomes a BROWSER comment that swallows the rendered
 * output up to the next `-->` anywhere later. That scope is the document, not
 * the paragraph.
 *
 * The lead test is CAPPED where opensHtmlBlock's term 1 uses an uncapped
 * `.trim()`, and the cap depends on `paraOpen`, whether a paragraph is open
 * above the line, because two different modules decide the two cases.
 * Measured with the same harness:
 *
 * - Paragraph open: module 8607 counts SPACES and treats a tab as four, and a
 *   continuation reaching four is lazy prose that never asks
 *   `interruptParagraph`. So at most three spaces and no tab: `Para` / four
 *   spaces + `<!-- y --> <!-- Q` / `TAIL` displays TAIL, and so does a list
 *   continuation stripped to `  \t<!--`.
 * - Fresh block: `indentedCode` (module 134) claims the line only when it
 *   STARTS with four spaces or a tab, and module 8776 skips any other mix of
 *   spaces and tabs uncapped. So ` \t<!-- y --> <!-- Q` after an HTML block is an
 *   HTML block line and hides what follows, where four spaces is code.
 *
 * `listStrip` is how many leading characters the renderer has already removed
 * from this line because it is list-item content (NRL-136 Q3, computed from
 * `containerViews`). It is applied only when those characters are whitespace,
 * so a caller holding an unpeeled line (a `>` prefix) gets the unstripped answer,
 * which is the pre-NRL-136 one. Replaces the first draft's `dedentedByList`
 * boolean with a fixed "at most four spaces or one tab" rule, which Verify
 * measured disclosing: the real strip depends on the item's own lines.
 *
 * One helper for every asker - cleanLine's caller, opensHiddenComment and the
 * browser-comment branch - because they are the same question (D-74-10).
 */
function htmlBlockLine(view: string, listStrip: number, paraOpen: boolean): boolean {
	const v = listStrip > 0 && /^[ \t]*$/.test(view.slice(0, listStrip)) ? view.slice(listStrip) : view;
	const first = v.indexOf("<!--");
	if (first === -1) return false;
	const lead = v.slice(0, first);
	return paraOpen ? /^ {0,3}$/.test(lead) : /^[ \t]*$/.test(lead) && !/^(?: {4}|\t)/.test(lead);
}

/**
 * Does a browser comment's `-->` on this line close inside the line's
 * `data-heading` attribute, so the reader sees the WHOLE line (NRL-136)? True
 * for an ATX heading: GT writes `<h1 data-heading="<raw heading text>">` before
 * the heading's own text, so `# S6 `c --> d` S7` closing a comment opened above
 * it renders `S6 c --> d S7` visible in full, measured with Obsidian 1.13.7's
 * own parser and renderer. The attribute holds the RAW text, `%%` pairs and
 * all, which is why the inline `%%` skip (`browserCloserAt`) never applies here.
 */
function closesInHeadingAttribute(raw: string): boolean {
	const p = containerPrefix(raw);
	return p.blockType === "heading" || HEADING.test(raw.slice(p.chars));
}

/**
 * The whitespace a list marker, a task checkbox or a callout title consumed in
 * front of this line's content, when that is all that separates the content
 * from them (NRL-136). The content is an HTML-block start only when it is one
 * to four spaces or a single tab, measured against Obsidian 1.13.7's own
 * parser for `-`, `*`, `+`, `1.`, `1)`, `- [ ]`, `- [x]`, `> - [ ]` and
 * `> [!note]`: five spaces, or a space then a tab, makes the line indented code
 * inside the item, which the renderer displays. A quote's own `>` and its one
 * optional space are not counted here - `htmlBlockLine` measures what follows
 * them on `body`.
 */
function containerLeadOk(raw: string, prefixChars: number): boolean {
	const q = raw.match(BLOCKQUOTE);
	const quoteChars = q ? q[0].length : 0;
	// `BLOCKQUOTE`'s optional `\s?` after the last `>` takes a TAB, where module
	// 6234 takes only a space and leaves the tab in the content, which is then
	// indented code: measured, `>\t<!-- y --> <!-- S2Z` / `S3Z` displays both lines.
	if (q && q[0].endsWith("\t")) return false;
	if (prefixChars <= quoteChars) return true;
	const prefix = raw.slice(0, prefixChars);
	const ws = prefix.slice(prefix.trimEnd().length);
	return /^(?: {1,4}|\t)$/.test(ws);
}

/**
 * Where a BROWSER comment's `-->` closes on this line, or -1 (NRL-136 Q1). A
 * `-->` inside an inline `%%...%%` pair does NOT close it, because the parser
 * removes the pair, `-->` and all, before anything is rendered; measured,
 * `<!-- y --> <!-- Q1Z` / blank / `A %%x --> SECRETZ%% B` / `TAIL` renders
 * nothing, so SECRETZ is hidden. That reverses the first NRL-136 draft's
 * decision to leave the pair unmodelled, which Verify measured disclosing the
 * contents of a user's `%%` comment in 60 fuzz cells.
 *
 * The pairing is the inline tokenizer's `/^%%(.*?)%%/`, on the SAME line only
 * and non-greedy: `%%%x --> S%%` hides S, and `S%%%% B` pairs the first two.
 * A backtick code span is paired FIRST, and a `-->` inside one DOES close,
 * because GT emits `>` raw inside `<code>`: `` A `%%x --> S%%` B `` and
 * `` A `%%`x --> S%% B `` both close. A backslash escape is honoured, so
 * `\%%x --> S` closes. All measured with Obsidian 1.13.7's own parser and
 * renderer.
 *
 * `skipPairs` is false where the `-->` is not markdown inline text: a fence
 * line or fenced code, a raw HTML line (`<!-- %%x --> S%% B` closes at the
 * first `-->` and shows S), and an ATX heading, whose raw text GT copies into
 * `data-heading`. Then this is a plain `indexOf`.
 */
/** Module 4839's `.T`, the inline HTML comment, anchored (NRL-136). */
const INLINE_HTML_COMMENT = /^<!--(?:-?[^>-])(?:-?[^-])*-->/;
function browserCloserAt(raw: string, from: number, skipPairs: boolean): number {
	if (!skipPairs) return raw.indexOf("-->", from);
	let i = from;
	while (i < raw.length) {
		const ch = raw[i];
		if (ch === "\\" && i + 1 < raw.length && /[!-/:-@[-`{-~]/.test(raw[i + 1]!)) {
			i += 2;
			continue;
		}
		if (ch === "`") {
			let run = 1;
			while (raw[i + run] === "`") run += 1;
			const close = firstRunOfLength(raw, run, i + run);
			if (close !== -1) {
				const inCode = raw.indexOf("-->", i + run);
				if (inCode !== -1 && inCode < close) return inCode;
				i = close + run;
				continue;
			}
			i += run;
			continue;
		}
		// A complete inline HTML comment binds before a `%%` pair inside it, as
		// module 4839's `.T` tokenizes it first: `<!-- %%x --> Z6Q%% Z7Q` closes at
		// that comment's `-->` and shows Z6Q, measured.
		if (ch === "<" && raw.startsWith("<!--", i)) {
			const inline = INLINE_HTML_COMMENT.exec(raw.slice(i));
			if (inline) return i + inline[0].length - 3;
		}
		if (ch === "%" && raw[i + 1] === "%") {
			const close = raw.indexOf("%%", i + 2);
			if (close !== -1) {
				i = close + 2;
				continue;
			}
			i += 2;
			continue;
		}
		if (ch === "-" && raw.startsWith("-->", i)) return i;
		i += 1;
	}
	return -1;
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
 *   has no closer and is displayed. In a FRESH block position a lead of four
 *   literal spaces, or of one literal tab, is indented code instead -
 *   `blockMethods` runs `indentedCode` before `comment`, and module 134 opens
 *   on either of those - which `extractChunks`' own INDENTED_CODE branch
 *   handles before this predicate is reached. Either way such a lead is not a
 *   comment opener.
 *
 * NRL-113 narrowed that: a lead of one to three spaces THEN a tab is no longer
 * indented code for us, because module 134 does no tab-stop expansion, so a
 * fresh-block ` \t%%` line now DOES reach this predicate. Term A declines it
 * correctly and for the renderer's own reason - the `%%` skip loop is charCode
 * 32 only - so the line is prose carrying a literal `%%`, which is exactly what
 * the renderer displays. So it is no longer true that "no tab can survive the
 * cap", and the earlier appeal to module 6058 snapping a tab to the next
 * multiple of four is CommonMark-shaped column arithmetic that module 134 does
 * not perform. What covers both halves is simply that term A's scan stops at
 * any non-space, so any lead containing a tab is refused outright regardless of
 * its length.
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
 *
 * `setextContent` is the same shape once more and is `opensHtmlBlock`'s fourth
 * argument (NRL-120): this line is the one content line of a setext heading, so
 * a `<!--` at its start is literal heading text. Like `dedentedByList` it
 * reaches only the `<!--` branch behind `blockComments`, so its default of false
 * is immaterial to the recursive call sites; `appendRemainder` passes false
 * explicitly, because the remainder of a comment's closing line is still inside
 * that raw HTML block for the renderer.
 *
 * `htmlLeadIndented` is `opensHtmlBlock`'s fifth argument and the same shape
 * again (NRL-115): the renderer never offers this line's content to its HTML
 * block tokenizer, so a line-start `<!--` here is literal. It defaults false,
 * the old answer, and that default is right for every site but the main per-line
 * one rather than merely harmless: it is a fact about the WHOLE line, and the
 * recursive label sites and `appendRemainder` pass a slice whose start is not the
 * line's start, where the claim would not hold.
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
	setextContent = false,
	htmlLeadIndented = false,
	containerCodeLine = false,
	htmlContext: HtmlContext = "none",
	htmlBodyOkLater: boolean | undefined = undefined,
	percentOpens: boolean | undefined = undefined,
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
	const closerRun = carrying ? firstRunOfLength(raw, incomingCode, 0) : -1;
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
	let openCommentBlock = false;
	let openCommentBrowser = false;
	// NRL-136's third way in: does a later unclosed `<!--` here open a
	// document-level comment? See HtmlContext.
	const htmlRawLine = htmlContext === "raw" || htmlContext === "block";
	// Built on the first `<!--` that asks (see `inlineCommentFacts`).
	let commentFacts: InlineCommentFacts | undefined;
	let leadSpace: number | undefined;
	let lastHtmlCloser: number | undefined;
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
			// The last `-->` on the line answers "none ahead" without a scan, so a
			// line of many literal `<!--` with no closer stays linear (NRL-166 fix
			// round 2); a closer that does lie ahead is consumed up to, so finding
			// it is paid for once.
			const close = htmlComment && (lastHtmlCloser ??= raw.lastIndexOf("-->")) < i + 4 ? -1 : raw.indexOf(closer, i + (htmlComment ? 4 : 2));
			if (close === -1 && obsidianComment && !(blockComments && !containerCodeLine && percentOpens !== false && opensObsidianBlock(raw, i, dedentedByList))) {
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
			let blockOpens = htmlContext === "inline" ? htmlClosesLater : opensHtmlBlock(raw, i, htmlClosesLater, setextContent, htmlLeadIndented, (leadSpace ??= /^\s*/.exec(raw)![0].length));
			// On a line the walker is sure is paragraph text, a `<!--` is INLINE for
			// the renderer: a paragraph line's content never starts a block, and a
			// lazy line led by a tab or four columns never reaches module 8776. An
			// inline comment exists only when its body - everything up to the first
			// `-->` - neither starts with `>` or `->` nor holds `--` nor ends with
			// `-` (CommonMark's comment rule, module 4839; NRL-166 fix round 1).
			// Otherwise `<!--` is literal text and the scan goes on, so a LATER
			// `<!--` may be the comment. This line's share of the body is checked
			// here; the later lines' share arrives as `htmlBodyOkLater`, on the same
			// bound as `htmlClosesLater`, and is undefined - nothing is checked -
			// on any line the walker is not sure of. Only a comment that term 2
			// says closes later is judged: one with no `-->` ahead keeps hiding.
			// And only where no inline construct can still be open around the
			// `<!--`: inside a raw tag's attribute value, a link title, a `<!...>`
			// declaration or CDATA the renderer consumes it as markup and displays
			// nothing, so speaking it would be a disclosure (/critique on the first
			// fix-round commit: `Note <span title="<!-- QAQ -- secret` /
			// `QBQ -->">QCQ</span>` shows only `Note QCQ`). Any `<` or `](` before
			// the opener on this line, or on an earlier line of the paragraph
			// (folded into `htmlBodyOkLater` as undefined), keeps it hidden.
			if (
				close === -1 &&
				htmlComment &&
				blockOpens &&
				blockComments &&
				!htmlRawLine &&
				htmlClosesLater &&
				htmlBodyOkLater !== undefined &&
				!(commentFacts ??= inlineCommentFacts(raw)).prefixHolds(i) &&
				!commentFacts.suffixHolds(i) &&
				!(htmlBodyOkLater && commentFacts.bodyStartOk(i))
			) {
				blockOpens = false;
			}
			if (close === -1 && htmlComment && blockComments && !blockOpens && !htmlRawLine) {
				for (let k = 0; k < 4; k++) emit(raw[i + k]!, rawStart + i + k);
				i += 4;
				continue;
			}
			if (close === -1) {
				openComment = closer;
				// Block, not term 2: the line was raw HTML for the renderer, so the
				// line that closes this comment is raw too. `blockComments` keeps a
				// recursive label out of it; the "block" test keeps a heading and a
				// term-2 remainder exactly as they were.
				//
				// Only a FIRST `<!--` that is itself an HTML-block start does that.
				// A later opener on a block line (the NRL-136 shape) or any opener in
				// a "raw" remainder is a BROWSER comment inside rendered output whose
				// HTML block already ended on this line, so the line that closes it
				// is ordinary markdown again: measured, `<!-- y --> <!-- Q1Z` /
				// `mid --> M2 <!-- Q2` / `TAIL` displays Q2 and TAIL.
				//
				// And only when module 8776's block does NOT end on this line too. It
				// ends at the first line that contains `-->` ANYWHERE from the `<`, so
				// `<!-->` and `<!--->` end it at once while the comment itself, by
				// cleanLine's and the reading-view oracle's count, is still open:
				// measured, `<!--> <!-- S2Z` / `S3Z --> S4Z <!-- S6Z` / `S7Z` shows
				// `<!-- S6Z` and S7Z as paragraph text. That comment is a browser one.
				openCommentBlock =
					htmlComment &&
					blockComments &&
					htmlContext === "block" &&
					raw.indexOf("<!--") === i &&
					raw.indexOf("-->", i + 2) === -1;
				openCommentBrowser = htmlComment && blockComments && htmlRawLine && !openCommentBlock;
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

	return { text: chars.join(""), index, openComment, openCode, openBracket, openBracketDepth, unclosedBracket, openCommentBlock, openCommentBrowser };
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

/** Sorted, disjoint `[start, end)` ranges covering exactly the union of `ranges`. */
function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
	const sorted = [...ranges].filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
	const out: Array<[number, number]> = [];
	for (const [a, b] of sorted) {
		const last = out[out.length - 1];
		if (last && a <= last[1]) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/**
 * `text` and its `index` less every character whose source offset lies in one
 * of `spans` (sorted, disjoint), in lockstep (NRL-166 fix round 2). Where a run
 * is dropped, whitespace on both sides of the seam collapses to one character,
 * and two words the run separated get one space, mapped to the character after
 * it as `sourceOffsetOfSpace` maps a synthetic one. `index` is monotone, so one
 * pointer walks the spans.
 */
function dropHiddenText(text: string, index: readonly number[], spans: ReadonlyArray<readonly [number, number]>): { text: string; index: number[] } {
	const chars: string[] = [];
	const out: number[] = [];
	// The first span that can hold any of `index`, by binary search, so a note of
	// many spans and many chunks stays linear (/critique on 383f85c, F6).
	let s = 0;
	if (index.length > 0) {
		let hi = spans.length;
		const first = index[0]!;
		while (s < hi) {
			const mid = (s + hi) >> 1;
			if (spans[mid]![1] <= first) s = mid + 1;
			else hi = mid;
		}
	}
	let seam = false;
	for (let k = 0; k < text.length; k++) {
		const o = index[k]!;
		while (s < spans.length && spans[s]![1] <= o) s++;
		if (s < spans.length && spans[s]![0] <= o) {
			seam = true;
			continue;
		}
		const ch = text[k]!;
		const space = /\s/.test(ch);
		if (seam && chars.length > 0) {
			const prevSpace = /\s/.test(chars[chars.length - 1]!);
			if (space && prevSpace) continue;
			if (!space && !prevSpace) {
				chars.push(" ");
				out.push(o);
			}
		}
		seam = false;
		chars.push(ch);
		out.push(o);
	}
	return { text: chars.join(""), index: out };
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
/**
 * `FENCE` narrowed to the three-space continuation cap (NRL-156, ADR 0025):
 * `interruptsParagraphExceptBareMarker`'s own callers (`codeSpanClosesLater`,
 * `bracketClosesLater`) only ever ask it of a line that, if it does not
 * interrupt, continues a paragraph the OPENER line already left open, so
 * `wasOpen` is always true there and `fenceOpensAt(lead, true)` collapses to
 * this fixed cap. HEADING/BLOCKQUOTE/HR already carry the matching `{0,3}`
 * cap in that function; only FENCE and LIST_BULLET did not, and LIST_BULLET
 * stays untouched (a NARROWING one-term change to a shared predicate has
 * measured a regression before, NRL-93; LIST_BULLET is NRL-109's).
 */
const FENCE_CONTINUATION = /^ {0,3}(```|~~~)/;
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
 * One level of the WIDE `BLOCKQUOTE` above, for COUNTING the levels the
 * `listDedented` pass peels (NRL-114 fix round 1). That pass keeps the wide peel
 * on purpose (see `QUOTE_LEVEL_PEEL`), so its count keeps the wide rule too.
 */
const BLOCKQUOTE_ONE_LEVEL = /^\s{0,3}>\s?/;
/**
 * A fenced code block's opening or closing LINE, as the body of a container
 * line (NRL-114 fix round 1): up to three spaces, then three or more backticks
 * with no backtick in the info string (CommonMark; a backtick there makes it
 * inline code), or three or more tildes. A lone CR before the end is a line
 * terminator for the renderer, so it is refused rather than read as one line.
 */
const CONTAINER_FENCE_LINE = /^ {0,3}(?:`{3,}[^`\r]*|~{3,}[^\r]*)\r?$/;
/**
 * A thematic break exactly as the reading-view renderer takes it, measured with
 * its parser run in Node (NRL-114 fix round 1): at most three leading spaces,
 * then three or more of one of `-`, `*`, `_` separated by SPACES only. A tab or
 * a vertical tab anywhere in it (`- \t---`, `*\t*\t*`, `---\t`) makes it
 * something else, a list item or a paragraph. The shared `HR` is wider (`\s`)
 * and is left alone because `interruptsParagraph` reads it.
 */
const RENDERER_HR = /^ {0,3}([-*_])(?: *\1){2,} *\r?$/;
/**
 * Whether the column-0 list marker on line `k` really starts an item for the
 * renderer (NRL-114 fix round 1): a bullet, or `1.` / `1)`, interrupts a
 * paragraph; any other ordered marker does so only at a block start (the note's
 * first line, after a blank line, an ATX heading or a thematic break). Measured
 * with the renderer: `x` / `2. ~~~ js` is ONE paragraph that displays `2. ~~~ js`,
 * and so is `- item` / `2. ~~~ js`, while `x` / `1) ~~~ js` is a list item.
 */
function itemStartsBlock(lines: readonly string[], k: number): boolean {
	if (/^(?:[-*+]|1[.)])[ \t]/.test(lines[k]!)) return true;
	if (k === 0) return true;
	const prev = lines[k - 1]!;
	return prev.trim() === "" || BLOCK_END_ATX.test(prev) || RENDERER_HR.test(prev);
}
/** A CR that does not end its line: a line terminator the `\n` split misses. */
const LONE_CR = /\r(?!\n?$)/;
/** A list marker at column 0, the line's outermost container. */
const TOP_ITEM_MARKER = /^(?:[-*+]|\d{1,9}[.)])[ \t]/;
/**
 * For each line, whether a raw HTML block or a `$$` math block may still be
 * open there, for the container-fence drop only (NRL-114 fix round 1), which must never
 * drop a line those blocks display. Errs toward true: any line back to the
 * previous blank line whose body starts with `<` (CommonMark HTML block types 6
 * and 7 end at a blank line) or holds `$$`, and any earlier line at all that
 * starts one of types 1, 3, 4 or 5, which do not. Type 2, the `<!--` comment, is
 * left out of both: if the renderer has one open it hides the fence line anyway,
 * so dropping that line cannot lose displayed text, and our own comment state
 * reaches the line before this test does.
 */
function rawOrMathBlockMayBeOpenTable(lines: readonly string[], withFences: boolean): boolean[] {
	// One forward pass rather than a backward scan per asking line, so a note of
	// many fence-shaped item lines stays linear.
	const out: boolean[] = new Array<boolean>(lines.length).fill(false);
	let longLived = false;
	let sinceBlank = false;
	for (let k = 0; k < lines.length; k++) {
		out[k] = longLived || sinceBlank;
		const raw = lines[k]!;
		const body = raw.replace(/^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?[ \t>]*/, "");
		if (/^<(?:pre|script|style|textarea)\b|^<\?|^<![A-Za-z]|^<!\[CDATA\[/i.test(body)) longLived = true;
		// For the fence drop, any fence-shaped line above at all, in any container
		// or as a callout title: this drop keeps no fence state, so a later line
		// may be that fence's CONTENT (`- ~~~ js` / `> [!tip] ~~~ x` is code).
		if (withFences && /^(?:\[![^\]]*\][+-]?[ \t]*)?(?:`{3,}|~{3,})/.test(body)) longLived = true;
		if (raw.trim() === "") sinceBlank = false;
		else if ((body.startsWith("<") && !body.startsWith("<!--")) || raw.includes("$$")) sinceBlank = true;
	}
	return out;
}
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
 * NRL-116's PEEL-LOCAL list marker, lead and task checkbox. The first two exist
 * because `containerPrefix` has to ask a DIFFERENT question from the one
 * `LIST_BULLET` answers for its other readers, and that one must stay
 * byte-identical for them: it is read by `interruptsParagraph`, by the
 * `listDedented` pass and by that pass's `inList` end test, all three as "is this
 * a list line at all". NRL-93's planned one-term change to a shared predicate
 * here measured a 6,144-cell regression, which is why this is a second set rather
 * than an edit.
 *
 * `PEEL_TASK` is the exception and the reason is worth stating rather than
 * inferring from the name: the old shared `TASK`, which was this pattern with a
 * trailing `\s*` run on the end, had
 * NO other reader once `containerPrefix` stopped using it, so it was DELETED
 * instead of being kept as dead code with a comment saying nothing reads it.
 * What it documented survives here. Any single status char, since Obsidian
 * renders `[ ]`, `[x]`, `[/]`, `[-]`, `[>]`, `[?]` and friends all as checkboxes;
 * the space-or-end lookahead keeps "- [x]text" and "- [ab]" as text; and checked
 * state is not spoken (NRL-8 Decisions, 2026-09-28), because a listener cannot
 * tell done from open and a reader who needs task state is looking at the screen.
 * If that proves wrong, add a setting.
 *
 * The question the PEEL asks is "how much of this line is container SYNTAX", and
 * the authority is Obsidian's own list tokenizer, module 745, read out of the
 * installed `obsidian.asar`:
 *
 *   /^([ \t]*)([*+-]|\d+[.)])( {1,4}(?! )| |\t|$|(?=\n))([^\n]*)/
 *
 * Group 3 is the whole point. It takes AT MOST FOUR SPACES NOT FOLLOWED BY A
 * FIFTH, or one space, or one tab - and everything past it is the item's CONTENT
 * INDENT, which the renderer then runs its block tokenizers over. So `- ` + tab
 * + `%%` leaves `\t%%` as content, a tab of content indent is indented code
 * inside the item, the `%%` is code text rather than a comment opener, and the
 * following item is DISPLAYED. `LIST_BULLET`'s trailing `\s+` ate the tab as
 * syntax and `TASK`'s trailing `\s*` did the same after a checkbox, so we handed
 * a bare `%%` to `opensObsidianBlock`, opened a note-scoped block and hid text
 * the reader can see. That was R-M08 prose loss, named by NRL-93 and measured
 * identical on both of its arms, so pre-existing rather than opened by it.
 *
 * TWO OMISSIONS ARE DELIBERATE. Group 3's `$` and `(?=\n)` alternatives are NOT
 * here, so a BARE marker (`- %%`, or `-` + tab with no space) peels exactly as it
 * did before. Those forms really do reduce to `%%` at the item's block start, so
 * the opener is already right and what diverges is the block's SCOPE - ours is
 * note-wide and container-blind where module 745 scopes an unterminated comment
 * to the item holding it. That is NRL-118, and widening the peel to cover them
 * would change nothing about it while enlarging this diff.
 *
 * `PEEL_MARKER` keeps `LIST_BULLET`'s leading `\s*` (any indent, because a nested
 * item's marker must be stripped rather than spoken) and replaces the trailing
 * `\s+` with a LOOKAHEAD, so the marker and its lead are consumed in two steps
 * and the lead can be bounded without changing what counts as a marker.
 */
const PEEL_MARKER = /^\s*([-*+]|\d+[.)])(?=\s)/;
/** Module 745's group 3; see PEEL_MARKER for why the `$` branch is omitted. */
const PEEL_LEAD = /^(?: {1,4}(?! )| |\t)/;
/** The old `TASK` with its trailing whitespace run removed; see above. */
const PEEL_TASK = /^\[[^\]]\](?=\s|$)/;
/**
 * THE PEEL'S OWN quote marker rule, one level and all levels: `>` plus at most
 * one SPACE, where the shared `BLOCKQUOTE` above allows any single whitespace
 * character. Obsidian's blockquote tokenizer (module 6234) consumes the `>` and
 * then advances over at most one character, and that character must be a space
 * (`t.charAt(D)===a&&D++` with `a = " "`). So for `>` + TAB + `%%` the renderer
 * hands `\t%%` to the block tokenizers, where a tab-led line is never a `%%`
 * opener and the text is DISPLAYED, while our `\s?` ate the tab, put `%%` at
 * offset 0 of the body and hid the rest (NRL-114). Measured with the real
 * parser, the same divergence covered five members of `\s` and not just the tab
 * the ticket named: a tab, a tab-then-space, an NBSP, a vertical tab and an
 * ideographic space. A lone CR is the sixth and is the exception, below.
 *
 * `\r` IS STILL CONSUMED, and that one character is a measured departure from
 * "a space only" rather than an oversight. A lone CR is a LINE TERMINATOR for
 * the renderer, not whitespace: measured, `> Plain prose` / `>\r%%` / `> SECRET`
 * renders as `<blockquote><p>Plain prose</p></blockquote>` with SECRET HIDDEN,
 * because the parser breaks the line at the CR and the `%%` that follows is at a
 * line start. Consuming the CR puts that `%%` at offset 0 of our body, which is
 * the same place, so the verdict agrees; leaving it in place made the line a
 * non-opener for us and newly SPOKE author-hidden text in 32,256 of the 5,160,960
 * sentinel-cells of a 3,150-shape census reconstruction (re-measured on 9132c3b)
 * - the disclosure direction, which is the one this change must
 * not move. A real CRLF file is untouched either way, its CR sitting at the end
 * of the line rather than after the marker; only a classic-Mac CR-only file
 * reaches this. The remaining non-space members of `\s` - tab, tab-then-space,
 * NBSP, vertical tab, ideographic space - are NOT line terminators for the
 * renderer and are left in the body, which is the fix.
 *
 * PEEL-LOCAL on purpose, which is the NRL-98 precedent verbatim: feed the
 * UNCHANGED predicate a different string rather than moving the shared
 * constant. `BLOCKQUOTE` stays byte-identical because `interruptsParagraph`
 * reads it, and narrowing that would move `codeSpanClosesLater` and collide
 * with ADR 0019's F5 guard. `BLOCKQUOTE_LEVEL` is renamed rather than
 * duplicated: its only two readers were this peel.
 *
 * THE ALL-LEVELS FORM MUST BE LITERALLY `^(?:<one level>)+`. `containerPrefix`
 * gates on it and then walks the one-level form across exactly what it matched,
 * and the loop's documented guarantee - "the iteration consumes exactly q[0]" -
 * is what licenses `quotes` as a peel budget. Narrow one and not the other and
 * it breaks measurably: with a wide gate and a narrow counter, `>\t>\tx` gives
 * `end = 4` while the walk stops at 3, so `chars` advances four characters that
 * no counted level consumed and the budget under-reports the prefix. That is
 * the "half a fix" this function's own comment warns about, and
 * tests/extract.test.ts pins it as a property rather than asserting it.
 *
 * The `listDedented` pass and the `setextContent` listInRun scan deliberately
 * keep the WIDE `BLOCKQUOTE` (ADR 0006 clause 2, NRL-114 amendment). They are
 * peels by shape, so the asymmetry is signed rather than overlooked: for
 * `>\t%%` the wide peel leaves `indented` false where a narrow one would leave
 * it true, and `indented` true keeps the item run alive, i.e. hides. Leaving
 * them wide is both the speak direction and unchanged behaviour. Do not
 * "align" them without measuring.
 */
const QUOTE_LEVEL_PEEL = /^\s{0,3}>[ \r]?/;
const QUOTE_PREFIX_PEEL = /^(?:\s{0,3}>[ \r]?)+/;

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
 *
 * A LOOP rather than one BLOCKQUOTE-then-LIST pass, because the two containers
 * nest in either order and the renderer honours every level (NRL-131). Measured
 * out of Obsidian 1.13.7's own renderer: `- > x` is
 * `<ul><li><blockquote><p>x`, with no `>` shown, and `- - > x` is
 * `<ul><li><ul><li><blockquote><p>x`, with neither the inner `-` nor the `>`
 * shown. One pass left those markers in the body and we spoke them, and a
 * single extra BLOCKQUOTE retry is not enough either: it fixes `- > x` and
 * leaves `- - > x` still saying its inner `-`. Hence the widening to a second
 * list marker, which also makes `- - x` speak `x` where it used to say `- x`.
 *
 * The nested `>` MUST be counted in `quotes`, not merely consumed. `peelQuotes`
 * spends `quotes` as NRL-98's same-or-shallower compatibility budget, so a peel
 * that grew `chars` without growing the budget would leave a continuation line
 * bearing that `>` rejected by the UNCHANGED BLOCKQUOTE arm of
 * `interruptsParagraph`, aborting the carry and leaving the destination leak in
 * place. That would be half a fix.
 */
function containerPrefix(line: string): {
	chars: number;
	quotes: number;
	blockType: BlockType;
	callout: boolean;
	outerList: boolean;
} {
	const h = line.match(HEADING);
	if (h) return { chars: h[0].length, quotes: 0, blockType: "heading", callout: false, outerList: false };
	// Peel prefixes in order, each adding to chars so cleanLine gets the true
	// raw offset of the first kept character: quote levels, then a callout
	// marker, or else a list marker and its task checkbox. Then round again,
	// because either can sit inside the other.
	let chars = 0;
	let quotes = 0;
	let blockType: BlockType = "paragraph";
	let sawQuote = false;
	let sawList = false;
	// "The OUTERMOST container is a list", which is what the call site's
	// `inList` actually means and what `blockType === "list"` used to stand in
	// for. It needs a field of its own now that a quote nested inside a list
	// item makes `blockType` "quote" on a line whose outer container is still
	// the list: without it the call site would stop setting `inList`, and
	// `inList` gates the indented-code opener, so a four-space continuation of
	// `- > x` would newly be read as code. That is prose loss, in the one
	// direction this change must not move.
	let outerList = false;
	for (;;) {
		const before = chars;
		let levelsHere = 0;
		const q = line.slice(chars).match(QUOTE_PREFIX_PEEL);
		if (q) {
			const end = chars + q[0].length;
			let at = chars;
			while (at < end) {
				const level = QUOTE_LEVEL_PEEL.exec(line.slice(at, end));
				if (!level || level[0].length === 0) break;
				levelsHere += 1;
				at += level[0].length;
			}
			quotes += levelsHere;
			chars = end;
			sawQuote = true;
			blockType = "quote";
		}
		// Gated on the levels consumed in THIS iteration, not on `quotes`
		// overall, and that is what keeps `- [!note] x` a plain list item:
		// measured, it renders as `<li>[!note] x</li>` with the marker shown,
		// while `- > [!note] Title` really is a callout
		// (`<div class="callout" data-callout="note">` with `[!note]` not
		// shown). So the marker is a callout exactly when a quote was just
		// peeled, at any depth rather than only on the first round.
		if (levelsHere > 0 && CALLOUT.test(line.slice(chars))) {
			chars += line.slice(chars).match(CALLOUT)![0].length;
			return { chars, quotes, blockType, callout: true, outerList };
		}
		// A list item whose CONTENT INDENT reaches indented-code depth ENDS the
		// peel, and that is load-bearing in both directions (NRL-131, found at
		// Ship review). The renderer puts the item's content into a `<pre><code>`
		// block once that indent passes the threshold, which makes a `>` or a
		// second `-` after it ORDINARY TEXT THE READER SEES rather than a
		// container. Measured out of Obsidian 1.13.7's real renderer, for `-`,
		// `*` and `1.` alike: `-    > x` is `<li><blockquote><p>x` while
		// `-     > x` and `- \t> x` are `<li><pre><code>> x`. Peeling there drops
		// a visible marker, and worse, it leaves a following `%%` at offset 0 of
		// the body, where `opensObsidianBlock`'s plain line-start rule fires and
		// `dedentedByList` is never consulted - so `- \t> %%` hid displayed prose
		// AND spoke the author-hidden text after the real opener, the exact
		// inversion.
		//
		// WHERE THAT TEST LOOKS IS NOT COSMETIC, and NRL-116 had to MOVE IT.
		// It used to read the PEELED string's own trailing whitespace run,
		// `INDENTED_CODE.test(b[0].match(/\s*$/)![0].slice(1))`, which worked only
		// because `LIST_BULLET`'s `\s+` had swallowed the entire lead into `b[0]`.
		// With the lead bounded to module 745's group 3 that run is at most four
		// spaces or one tab, `.slice(1)` leaves at most three spaces or nothing,
		// and the stop NEVER FIRES. Measured against real rendered HTML from
		// Obsidian's own renderer run in Node: leaving it in place newly loses
		// 314,880 cells of 3,096,576, every one of them an NRL-131 case
		// regressing, where the shipped form loses 0 and leaves the whole
		// nested-quote family BYTE-IDENTICAL to base. The corpus that found it had
		// to be corrected first - an earlier one reported the same arm clean
		// because it tracked a sentinel AFTER the `>` while the displayed `>`
		// itself was what got dropped. It now asks the same question of the place
		// the indent lives after the narrowing - the REMAINING BODY - and
		// `.slice(1)`'s job of discounting the marker's own required space is done
		// instead by `PEEL_LEAD` having consumed it.
		//
		// `INDENTED_CODE` is reused deliberately rather than a hand-rolled
		// "four or more, or a tab": it is this file's one definition of the
		// threshold. Stopping is FAIL-CLOSED - it leaves the line exactly as the
		// pre-NRL-131 tree had it.
		let stop = false;
		const b = line.slice(chars).match(PEEL_MARKER);
		if (b) {
			// Read before `chars` moves, so it records whether this marker is
			// the outermost container or one nested inside a quote.
			if (!sawQuote) outerList = true;
			chars += b[0].length;
			sawList = true;
			// The lead is a SEPARATE step from the marker, which is the whole of
			// NRL-116: `PEEL_MARKER` ends in a lookahead, so whatever `PEEL_LEAD`
			// declines to take stays in the body as the item's content indent.
			const lead = line.slice(chars).match(PEEL_LEAD);
			if (lead) chars += lead[0].length;
			if (INDENTED_CODE.test(line.slice(chars))) stop = true;
			const task = line.slice(chars).match(PEEL_TASK);
			if (task) {
				chars += task[0].length;
				// The old shared `TASK`'s trailing `\s*` ate the lead after a
				// checkbox exactly as `LIST_BULLET`'s `\s+` did after a marker, so
				// this is the second half of the same fix and not a repetition of
				// it: reverting only this half re-breaks every task shape and
				// loses a displayed `>` as well, measured.
				const taskLead = line.slice(chars).match(PEEL_LEAD);
				if (taskLead) chars += taskLead[0].length;
				if (INDENTED_CODE.test(line.slice(chars))) stop = true;
			}
		}
		if (stop) break;
		// Every matcher that can fire consumes a non-empty string - BLOCKQUOTE
		// needs a `>`, PEEL_MARKER a marker (its whitespace requirement is a
		// lookahead, but the marker itself is a character), PEEL_TASK a bracketed
		// status char, and CALLOUT returns - so an iteration that moves nothing
		// has nothing left to peel. That is the termination proof, and it is why
		// there is deliberately NO iteration cap: a cap would silently truncate
		// the prefix, which is the "two readings of the same thing" this
		// function exists to prevent. The shared regexes stay non-sticky for the
		// same reason the slice is paid for: `BLOCKQUOTE` and `LIST_BULLET` are
		// read by `interruptsParagraph` and by the `listDedented` pass too, so a
		// `lastIndex` on either would be a live bug there, and the same holds for
		// the three PEEL_* patterns, which this function reads twice per round.
		if (chars === before) break;
	}
	// Only a line that is not already a quote is a list. A quoted list item
	// matches both matchers, and the outer construct is the quote, because
	// BLOCKQUOTE is peeled above before LIST_BULLET is even tried.
	if (!sawQuote && sawList) blockType = "list";
	return { chars, quotes, blockType, callout: false, outerList };
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
/**
 * One quote level as the RENDERER strips it from a line: spaces and tabs, the
 * `>`, then ONE optional U+0020 space and nothing else (NRL-119 fix round 2).
 * Obsidian's blockquote tokenizer, transcribed in obsidianBlocks.ts and measured
 * out of obsidian.asar 1.13.7's WT/GT, does `if (t.charAt(D) === " ") D++` after
 * the `>`; a tab, a second space, an NBSP or a CR stays in the content. It skips
 * only spaces and tabs before the `>` too, so an NBSP there makes the line text.
 */
const QUOTE_CONTENT_LEVEL = /^[ \t]{0,3}> ?/;

/**
 * The renderer's reading of a quoted continuation line, for `BARE_LIST_MARKER`
 * alone (NRL-119 fix round 2).
 *
 * Round 1 tested `BARE_LIST_MARKER` on `peelQuotes`' output, whose `>\s?` eats a
 * TAB after the `>`. So `> A ![xx` / `>\t*` / `> yy](zdestz.png) B.` stopped the
 * carry on a bare `*`, although the renderer keeps `\t*` as a tab-led lazy
 * continuation and forms the image across it: the destination was newly spoken
 * (Verify, 53,248 cells). Testing the term on THIS string instead means it fires
 * only where the renderer's content line really is a bare marker, and on a line
 * where a tab (or NBSP, or CR) follows a `>` it cannot fire at all, so such a
 * line behaves exactly as on base.
 *
 * Deliberately NOT used for the other arms, which keep `peelQuotes`. Applying the
 * renderer's peel to them was built and measured in this round, three times: it
 * closes base leaks (`>\t-`, `>\t===`, `>\t<div>`), but each draft newly lost or
 * newly leaked somewhere else, because base's answer on a tab-after-`>` line is
 * right by ACCIDENT in many shapes - the eaten tab stands in for a quoted list
 * item's whole-item de-indent, for a lazy line's uncapped interrupters, and for a
 * lone CR's line ending. That is NRL-153's lesson (the whitespace predicates
 * compose and must move together), and NRL-114 owns the peel itself.
 *
 * Rebase note: NRL-114 has since narrowed `peelQuotes` to `>[ \r]?`, so it no
 * longer eats the tab either. The two peels now differ only where `peelQuotes`'
 * `\s{0,3}` lead accepts a non-tab, non-space whitespace (an NBSP) or where a CR
 * follows the `>`; this helper still answers the renderer's reading there.
 */
function quoteContent(line: string, budget: number): string {
	let rest = line;
	for (let n = 0; n < budget; n++) {
		const level = QUOTE_CONTENT_LEVEL.exec(rest);
		if (!level) break;
		rest = rest.slice(level[0].length);
	}
	return rest;
}

function peelQuotes(line: string, budget: number): string {
	let rest = line;
	for (let n = 0; n < budget; n++) {
		const level = QUOTE_LEVEL_PEEL.exec(rest);
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
 *
 * `lazyLead` is NRL-115's F1 correction: a line `rendererLeads` marks as a LAZY
 * paragraph continuation led by a tab or four columns never reaches the
 * renderer's HTML block tokenizer, so `HTML_BLOCK_OPEN` must not stop the carry
 * there (cleanLine already speaks such a line; stopping here while cleanLine
 * did not left the label unconfirmed and spoke its destination). It is the
 * lazy half of `htmlLeadIndented` only, deliberately: on a FRESH indented-code
 * line inside a container the renderer has a code block, which no label can
 * span, so the stop stays (crossing it was measured to newly lose a displayed
 * destination in the fuzz).
 */
function containerCarryStops(peeled: string, lazy: boolean, lazyLead: boolean): boolean {
	return (lazy && INDENTED_CODE.test(peeled)) || (!lazyLead && HTML_BLOCK_OPEN.test(peeled));
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
 * Since NRL-119 `TERM2_LIST` matches a bare `-` too, because its tail accepts
 * end of line, so the two patterns now OVERLAP on this shape and both stop it.
 * This one is deliberately kept separate rather than folded in: its comment
 * above records a distinct setext-position meaning (the `<h2>` case), and
 * folding it would move the NRL-95 and NRL-111 dash pins that cite it. The
 * overlap changes no answer, since both are ungated block ends in
 * `endsTerm2Block`.
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
 * Four literal spaces, or one literal tab, at offset 0. There is deliberately
 * NO tab-stop expansion here, and that is the renderer's rule rather than
 * CommonMark's.
 *
 * This used to read `/^(?: {4}| {0,3}\t)/` with a comment saying "a tab after
 * up to three spaces reaches the next tab stop, which is column four, so it
 * counts too". That is true of CommonMark and false of Obsidian. Module 134,
 * Obsidian 1.13.7's indented-code tokenizer, was RUN out of the installed asar
 * during NRL-113 rather than read: its opener arm is `l===a` plus the next
 * three characters also `a` (four LITERAL spaces, `a = " "`) or `l===o` (one
 * LITERAL tab, `o = "\t"`), tested at offset 0, with no column arithmetic
 * anywhere. The tokenizer is a SINGLE loop, so the continuation arm IS the
 * opener arm - the same test at each line start - which is why one constant
 * serves every read site here and is faithful rather than merely convenient.
 *
 * That count has moved since NRL-113 was planned and the number is deliberately
 * not written into this comment again. It was THREE at NRL-113's own base
 * (079cf0c); it is SIX at the base this landed on - `containerPrefix`'s list
 * and task content-indent stops (NRL-131, relocated onto the remaining body by
 * NRL-116), `containerCarryStops`' lazy arm, the setext pre-pass's raw-HTML
 * mask (NRL-155, keyed on this constant on purpose so it follows a narrowing),
 * and extractChunks' own continuation and opener tests. Each was re-measured
 * against the executed renderer before this landed. `MODULE134_INDENTED_CODE`
 * below holds the same pattern and stays a separate constant on purpose: it is
 * keyed on the RENDERER's rule for `isSetextContentLine`, where this one is
 * keyed on what extractChunks calls indented code, and the two are free to
 * diverge again.
 *
 * The cost of the old wider test was an R-M08 disclosure and an R-M09
 * destination disclosure at once. A ` \t<!--` line in a fresh-block position
 * is not indented code for the renderer, so `html` (module 8776) opens a raw
 * comment block and the body is HIDDEN, while we dropped the lead line as code
 * and spoke the body as prose. The same lead on a lazy continuation line does
 * not end a blockquote, so `containerCarryStops` wrongly aborted the label
 * carry and the destination fell out as prose.
 *
 * A fresh-block `\t<!--` is a different shape and is CORRECT as it stands: the
 * renderer really does make that line code, because `blockMethods` reaches
 * `indentedCode` (index 2) before `html` (index 11), so module 8776's
 * tab-tolerant skip loop never gets to decide it. Both facts came from running
 * the real parser and renderer; neither is verified in a live Obsidian, and
 * both are the reading-view path only.
 *
 * Whether the line is code still depends on state: indented code only starts
 * after a blank line or at the start of the document, and never inside a list
 * item.
 */
const INDENTED_CODE = /^(?: {4}|\t)/;
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
	/^ {0,3}\[(?!\^)(?:[^[\]\\]|\\.)+\]:[ \t]*(?:<(?:[^<>\\\n]|\\.)*>|[^\s<][^\s]*)(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*$/;

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
function opensHiddenComment(line: string, htmlClosesLater: boolean, dedentedByList: boolean, htmlLeadIndented: boolean, listStrip: number): boolean {
	const pct = line.indexOf("%%");
	if (pct !== -1 && opensObsidianBlock(line, pct, dedentedByList)) return true;
	const html = line.indexOf("<!--");
	if (html === -1) return false;
	const firstClose = line.indexOf("-->", html + 4);
	if (firstClose !== -1) {
		// The first comment closes on this line. Pair the rest in sequence, as
		// cleanLine's loop does, and ask about a trailing unclosed opener the one
		// question cleanLine's caller asks of it: is this line an HTML block
		// (NRL-136)? Measured: `Para` / `<!-- y --> <!-- Q` / `TAIL` renders
		// `<p>Para</p>` and a raw block hiding Q and TAIL, so the line DOES end
		// the paragraph, which NRL-120's "false when the first closes" missed.
		// Term 2 is deliberately NOT asked about a later opener here, which is
		// the pre-NRL-136 answer for it. The setext refusal stays out for the
		// reason given below.
		let at = line.indexOf("<!--", firstClose + 3);
		while (at !== -1) {
			const close = line.indexOf("-->", at + 4);
			if (close === -1) return htmlBlockLine(line, listStrip, true);
			at = line.indexOf("<!--", close + 3);
		}
		return false;
	}
	// `false`, deliberately, and not the setext answer cleanLine gets. This
	// predicate's job is "does this line END the paragraph", and a refused
	// `<!--` still does: the `interruptParagraph` walk fires `html` on that line
	// before `setextHeading` claims the new block, so `Intro. \`a` / `<!--` /
	// `===` / `b\` c` has no code span for the renderer either. Threading the
	// refusal in here would only make the code-span and label carries reach
	// further, the disclosure direction, for no fidelity gain (NRL-120).
	//
	// `htmlLeadIndented` IS threaded, and the asymmetry is the point (NRL-115).
	// A setext content line still ENDS the paragraph, as a heading; a line the
	// renderer takes as a lazy continuation does NOT, because module 8607 never
	// ran the interrupt check on it, so the carries must be allowed to cross it.
	return opensHtmlBlock(line, html, htmlClosesLater, false, htmlLeadIndented);
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
 * A MARKER ALONE ON ITS LINE IS A MARKER (NRL-119). Module 745's last test
 * above passes when the character after the marker is a newline or end of input,
 * so `*`, `+`, `1.` and `1)` alone on a line each start a list item and end the
 * paragraph. Measured against real rendered HTML: `Prose <!--` / `*` /
 * `HIDDENE` / `--> t.` renders `<p>Prose &#x3C;!--</p><ul><li>HIDDENE...`, and the
 * same for the other three, so HIDDENE is DISPLAYED. The tail was `[ \t]`, which
 * missed all four and hid that text (fail-closed prose loss). It is now
 * `(?:[ \t]|\r?$)`: `\r?` because `extractChunks` splits on `\n` alone, so a CRLF
 * note hands the line a trailing `\r` that the renderer reads as a line ending.
 *
 * The widening touches ONLY the tail. The indent cap and the digit rule above
 * still apply to a bare marker exactly as to a marker with content, and both are
 * load-bearing here too: measured, `    *`, `\t*`, `7.`, `7)` and `01.` alone on a
 * line each render as ONE `<p>` with HIDDENE inside the raw comment, so stopping
 * at any of them is a disclosure. An arm with `^[ \t]*` or `\d+[.)]` in front of
 * the widened tail reaches that disclosure; see ADR 0025's NRL-119 section.
 *
 * What this does NOT do: stop the marker GLYPH being spoken. The renderer does
 * not display a list marker, but this pattern only decides where the term-2 scan
 * stops. Dropping the glyph is `LIST_BULLET`'s block-level `\s+` strip, which
 * feeds `containerPrefix` and `blockType` and accepts any `\d+`, so it is left to
 * NRL-154 with its own position-gated measurement.
 *
 * A lone `-` is matched by `TERM2_LONE_DASH` as well, and stays there on purpose.
 */
/**
 * A list marker ALONE on its line, at exactly the shape that interrupts a
 * paragraph in Obsidian: the bare-marker half of `TERM2_LIST` (NRL-119 fix
 * round 1). `interruptsParagraph` reads this beside `LIST_BULLET`, whose `\s+`
 * tail needs whitespace after the marker and so never saw `*`, `+`, `1.` or
 * `1)` alone. Without it `codeSpanClosesLater` and `bracketClosesLater` carried a
 * soft-wrapped code span or label ACROSS a bare marker the renderer ends the
 * paragraph at, and silenced displayed text: `A `xx` / `*` / `HIDDENE` /
 * `yy` B.` renders `<p>A `xx</p><ul><li>HIDDENE<br>yy` B.</li></ul>` and spoke
 * `"A B."`. That was pre-existing (NRL-154's symptom 2); widening `TERM2_LIST`
 * unmasked it in the `<!--`-bearing shapes, because a narrower `<!--` block let
 * the opener line reach the carry at all, which is how Verify found it.
 *
 * Deliberately the PRECISE rule rather than `LIST_BULLET`'s loose one. The
 * cap (`^ {0,3}`) and the digit rule (`1` only) are load-bearing in the
 * disclosure direction here: past three columns, or with `7.` or `01.`, the line
 * is a lazy continuation, the renderer forms the image or link across it, and
 * stopping the carry speaks its destination. Measured: `a ![x` / `7.` /
 * `HIDDENE](dest.png) b` is one `<p>` with an `internal-embed`, and an arm with
 * `\d+[.)]` here speaks `](dest.png)`. A lone `-` matches too, harmlessly: it is
 * already `SETEXT`. A trailing `\r` is `\r?` for the CRLF reason on `TERM2_LIST`
 * (it also already matched `LIST_BULLET`'s `\s+`).
 *
 * The marker GLYPH is still spoken; that is NRL-154's block-level strip.
 */
const BARE_LIST_MARKER = /^ {0,3}(?:[-*+]|1[.)])\r?$/;
const TERM2_LIST = /^ {0,3}(?:[-*+]|1[.)])(?:[ \t]|\r?$)/;
/**
 * A display-math opening line, at the EXACT shape Obsidian's own math block
 * tokenizer accepts in the `interruptParagraph` walk (NRL-120). `math` is in
 * `u.interruptParagraph` unconditionally, with no `{commonmark}` option to gate
 * it, so a `$$` line ends the paragraph a mid-line `<!--` belongs to and module
 * 4839's inline comment regex cannot reach past it. Measured: `Prose <!--` /
 * `$$` / `HIDDENM --> t.` renders `<p>Prose &#x3C;!--</p>` and then a math block
 * holding `HIDDENM --> t.`, so `HIDDENM` is DISPLAYED, as math source.
 *
 * The shape is the executed parser's, not a reading of it. Two exhaustive runs
 * put a line between `Prose <!--` and three different tails and ran the real
 * `WT`/`GT` pair: every non-blank line of length up to six over {space, tab,
 * `$`, `y`} (5,334 lines, 16,002 cases), and every one up to five with a
 * backslash, a backtick and a trailing CR added (10,672 lines, 32,016 cases,
 * fence lines excluded as a separate term). This pattern disagrees with the
 * renderer in 0 of them. Whitespace-only lines are left out because they are
 * the blank-line term, and a tab-only line is NRL-111's recorded divergence.
 * Three things it pins that a guess would get wrong:
 *
 * - NO CLOSER IS NEEDED. The block runs to end of input when nothing closes it,
 *   so this is deliberately not `opensMathBlock`, whose later-closer search is
 *   right for the question THAT function answers (does extractChunks consume the
 *   block) and wrong for this one (does the paragraph end here).
 * - At most THREE spaces of lead, and no tab. A tab or four spaces makes the line
 *   a lazy paragraph continuation, so the comment regex crosses it and the text
 *   stays HIDDEN; stopping there would be a disclosure. An arm using
 *   `trimStart()` instead disagrees with the renderer in 1,173 and 468 cases.
 * - The rest of the line holds NO `$` at all, after a run of two or more. So
 *   `$$$` and `$$$$` open a block, while `$$y$$`, `$$ x $$ y` and `$$ $` are
 *   inline and do not. An arm testing `includes("$$")` disagrees in 2,952 and
 *   2,040.
 *
 * A container prefix is NOT peeled here, as for every other term in this set:
 * the term-2 pass reads raw lines, so `> $$` is not a stop and a quoted
 * paragraph keeps hiding across it. That is a fail-CLOSED residual (prose loss),
 * recorded in ADR 0025, and not a statement that the renderer agrees.
 *
 * It is a BLOCK end, so it sits in `endsTerm2Block` and resets the content-line
 * count, ungated by position: unlike a setext underline, a math line ends the
 * block it follows wherever it sits.
 */
const TERM2_MATH = /^ {0,3}\$\$+[^$]*$/;

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
		(fenceOpensAt(line.match(/^[ \t]*/)![0], paraLinesAbove > 0) && FENCE.test(line)) ||
		HEADING.test(line) ||
		HR.test(line) ||
		TERM2_LONE_DASH.test(line) ||
		TERM2_MATH.test(line) ||
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
 * One blockquote level as module 6234 consumes it, for the term-2 bound only
 * (NRL-114): at most three SPACES, the `>`, then at most one SPACE. Spaces only
 * on BOTH sides, and that is narrower than the peel's own `QUOTE_LEVEL_PEEL`,
 * whose `\s{0,3}` also takes a tab BEFORE the marker, on purpose. A `>` behind a
 * tab is not a nested quote for the renderer: inside a quote paragraph the
 * tab-led body is a lazy continuation (module 8607 never runs its interrupt
 * walk on it), so counting it as a deeper level would read a "deeper quote
 * starts here" stop the renderer does not have, which is the disclosure
 * direction for term 2.
 */
const TERM2_QUOTE_LEVEL = /^ {0,3}> ?/;
/** A callout title's marker as module 6234 matches it (see `walkLeadQuote`). */
const TERM2_CALLOUT_TITLE = /^\[![^\]]+\][+-]?(?:\s|$)/;

/**
 * The quote depth module 6234 would strip from `line` and the body it leaves.
 */
function term2QuoteView(line: string): { depth: number; body: string } {
	let depth = 0;
	let body = line;
	for (;;) {
		const m = TERM2_QUOTE_LEVEL.exec(body);
		if (!m) break;
		depth += 1;
		body = body.slice(m[0].length);
	}
	return { depth, body };
}

/**
 * The term-2 stop for a QUOTED line, read on its quote-peeled body (NRL-114,
 * ADR 0025's NRL-114 amendment). It WRAPS `endsTerm2Scan` and `endsTerm2Block`
 * rather than editing them, so their bodies stay byte-identical for every
 * unquoted line and for the other lanes that edit them.
 *
 * Before this, the term-2 pass read the RAW line, so `> ---` or `> -` was never
 * a stop and a `<!--` on a quoted line kept looking for its `-->` past a quoted
 * thematic break or list item that ends the renderer's paragraph. That was a
 * fail-closed residual (NRL-95 pinned it) until NRL-114's narrower peel left a
 * tab in the quote body and the hidden span started swallowing text Obsidian
 * displays: `> Plain` / `>\t<!-- ZCZ` / `> ---` / `> ZAZ -->` renders ZCZ and
 * ZAZ, and an arm without this wrapper spoke neither.
 *
 * Three rules, each measured against the executed renderer:
 *
 * - A body that is blank with SPACES only is a stop. A body whose first
 *   non-space character is any other whitespace (a tab, an NBSP, ...) or whose
 *   lead is four or more spaces is NOT a stop, blank or not (decisions Q4 and
 *   Q10): module 8607 reads such a line as a lazy continuation, and stopping
 *   there is the disclosure direction, since the comment really does cross it.
 *   It also keeps the shared stop terms, `FENCE`'s `\s*` and `HR`'s `\s{0,3}`,
 *   from ever seeing a non-space lead here.
 * - A callout TITLE on a quote's first line is a block of its own; see below.
 * - Anything else is `endsTerm2Scan(body, ...)`, unchanged.
 *
 * A change of quote DEPTH is deliberately NOT a stop, although decision Q3
 * planned one for a deeper level. It was built and measured: remark's
 * blockquote tokenizer keeps far more lines in one paragraph than CommonMark's
 * lazy-continuation rule suggests (`>>-` / `>> ---` / `> [!note]  ---` /
 * `   >    XDAZ <!-- YDAZ` / `> > CEAZ -->` is ONE list-item paragraph whose
 * inline comment hides YDAZ and CEAZ), so a depth rise read as "a new quote
 * starts" newly spoke hidden text in this ticket's fuzz. Not stopping there is
 * the fail-closed direction, and its cost - a quote STARTING after a `<!--`
 * keeps hiding, `pin-nrl95-quote-starting-after-opener-still-hidden` - is the
 * pre-existing one.
 *
 * Returns the stop and the content-line count for the NEXT line.
 */
function term2QuotedStop(body: string, quoteStart: boolean, paraLinesAbove: number): { stop: boolean; next: number } {
	if (/^ *\r?$/.test(body)) return { stop: true, next: 0 };
	// A callout TITLE is tokenized on its own, before the rest of the quote
	// (module 6234, the same rule `walkLeadQuote` follows), so it is a block of
	// its own and the content line under it is a block's FIRST line: a `===`
	// there is an underline under one content line. Counting the title made it
	// the second and kept the term-2 scan crossing a heading
	// (`> [!note] Title` / `>` + VT + `<!--` / `> ===` / `> SECRET` / `> -->`
	// is `<h1>` then a displayed SECRET for the renderer). Only on a quote's
	// certain first line - the note's first line or the line after a stop - since
	// anywhere else `[!note]` is paragraph text.
	if (quoteStart && TERM2_CALLOUT_TITLE.test(body)) return { stop: true, next: 0 };
	const lead = /^ */.exec(body)![0].length;
	if (lead >= 4 || /\s/.test(body.charAt(lead))) return { stop: false, next: paraLinesAbove + 1 };
	return {
		stop: endsTerm2Scan(body, paraLinesAbove),
		next: endsTerm2Block(body, paraLinesAbove) ? 0 : paraLinesAbove + 1,
	};
}

/**
 * If `body` opens a raw HTML block that is not a comment, the condition that
 * closes it: a pattern for CommonMark types 1, 3, 4 and 5, which may span blank
 * lines, or `"blank"` for everything else, which closes at a blank line. A
 * comment opener returns undefined because comments are extractChunks' own
 * `inComment` state and are never reached as a line here.
 *
 * Deliberately WIDER than CommonMark: any `<` at the start of the body counts,
 * with any lead, because the only use is to stop a setext refusal, and an
 * unneeded stop is the fail-closed direction (NRL-120).
 */
function rawHtmlBlockEnd(body: string): RegExp | "blank" | undefined {
	if (!/^\s*</.test(body) || /^\s*<!--/.test(body)) return undefined;
	if (/^\s*<(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(body)) return /<\/(?:script|pre|style|textarea)>/i;
	if (/^\s*<\?/.test(body)) return /\?>/;
	if (/^\s*<!\[CDATA\[/.test(body)) return /\]\]>/;
	if (/^\s*<![A-Za-z]/.test(body)) return />/;
	return "blank";
}

/**
 * The CommonMark block-tag names, types 6, as module 8776 builds its pattern
 * from `this.options.blocks`. Used by `rawBlockOpener` only.
 */
const HTML_BLOCK_TAGS = new Set(
	(
		"address article aside base basefont blockquote body caption center col colgroup dd details dialog dir " +
		"div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html " +
		"iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param pre section source " +
		"title summary table tbody td tfoot th thead tr track ul"
	).split(" "),
);
/**
 * If `view`, already stripped of its lead, opens a NON-comment raw HTML block,
 * the condition that ends it (NRL-136): types 1, 3, 4 and 5 by their closing
 * pattern, type 6 at a blank line. Narrow where `rawHtmlBlockEnd` is wide, for
 * the reason given at `htmlLineAt`. Type 6 is recognised whether or not a
 * paragraph is open, since it may interrupt one; type 7 never is.
 */
function rawBlockOpener(view: string): RegExp | "blank" | undefined {
	if (/^<(?:script|pre|style)(?:\s|>|$)/i.test(view)) return /<\/(?:script|pre|style)>/i;
	if (view.startsWith("<?")) return /\?>/;
	if (/^<![A-Za-z]/.test(view)) return />/;
	if (view.startsWith("<![CDATA[")) return /\]\]>/;
	const tag = view.match(/^<\/?([A-Za-z][A-Za-z0-9]*)(?:\s|\/?>|$)/);
	if (tag && HTML_BLOCK_TAGS.has(tag[1]!.toLowerCase())) return "blank";
	return undefined;
}

/**
 * An underline at the exact shape Obsidian's setextHeading tokenizer (module
 * 8671) accepts, both halves at once: no leading and no trailing whitespace, a
 * trailing CR tolerated. The same measurements as `TERM2_SETEXT_EQ` and
 * `TERM2_SETEXT_DASH`, which are its two halves; one pattern here because this
 * caller needs no position gate of its own (see `isSetextContentLine`).
 */
const SETEXT_UNDERLINE_EXACT = /^(?:=+|-+)\r?$/;
/**
 * A `<!--` at the start of the line, with at most three SPACES of lead. Read by
 * the QUOTE and LIST arms of `isSetextContentLine` only, where the cap stays
 * spaces-only on purpose (fail-closed): `> \t<!--` is code inside the quote only
 * through module 6234's one-character peel (NRL-114), and `- \t<!--` is code
 * inside the item. An arm using `^\s*` is the measured disclosure this cap
 * exists to prevent.
 *
 * NRL-155 corrects what this comment used to claim for the PLAIN arm, that a
 * tab is never setext content. Module 134 is literal (four spaces or one tab at
 * offset 0, no tab-stop expansion), so one to three spaces then a tab is NOT
 * indented code and does reach setextHeading in block position. The plain arm
 * therefore reads `PLAIN_SETEXT_HTML_OPENER` and `MODULE134_INDENTED_CODE`
 * below instead of this constant.
 */
const HTML_OPENER_AT_START = /^ {0,3}<!--/;
/**
 * Module 134's indented-code opener, LITERALLY: four spaces or one tab at
 * offset 0, with no tab-stop expansion (NRL-155). It is deliberately not
 * `INDENTED_CODE`, which when NRL-155 shipped also accepted one to three spaces
 * then a tab (NRL-113's defect). NRL-113 has since narrowed that constant to
 * this same pattern, so the two now coincide; they stay SEPARATE for the reason
 * NRL-155 gave below - this one is keyed on the renderer's rule and the other
 * on what extractChunks calls indented code - and merging them would re-couple
 * the setext refusal to a predicate that is free to move again. Measured against rendered HTML out of the installed obsidian.asar
 * 1.13.7 (app.js sha256 8efbf581...9898): ` \tTitle` / `===` is
 * `<h1>\tTitle</h1>`, while `\tTitle` / `===` and `    Title` / `===` are
 * `<pre><code>`. Keyed on the renderer's rule so the setext refusal stays right
 * before and after NRL-113 narrows our own constant.
 */
const MODULE134_INDENTED_CODE = /^(?: {4}|\t)/;
/**
 * A `<!--` at the start of a PLAIN line after any run of spaces and tabs. The
 * plain arm of `isSetextContentLine` pairs it with `MODULE134_INDENTED_CODE`,
 * so the lead it accepts is exactly the set that reaches module 8671 rather
 * than module 134. NRL-114 gives the QUOTE arm the same rule, read on the quote
 * body.
 */
const PLAIN_SETEXT_HTML_OPENER = /^[ \t]*<!--/;
/**
 * A lead that carries a tab before any other character. Such a `<!--` line is
 * setext content only in BLOCK position, never as a paragraph continuation (see
 * `inSetextBlockPosition`).
 */
const TAB_BEARING_LEAD = /^ *\t/;
/**
 * Predecessor lines that END a block, so the line after them starts a fresh one
 * (NRL-155). SPACES-ONLY capped on purpose, not the shared `HEADING`, `HR` and
 * `FENCE`, which accept `\s{0,3}` or `\s*`: a tab-led `# H` or `***` is a lazy
 * paragraph continuation for the renderer, so treating it as a block end
 * refuses a `<!--` the renderer keeps inside an HTML comment. Measured: with
 * the shared constants, `Intro.` / `\t***` / ` \t<!--` / `===` / `HIDDENA` /
 * `-->` newly spoke HIDDENA (1,792 predecessor-census cells).
 */
const BLOCK_END_ATX = /^ {0,3}#{1,6}(?:[ \t]|\r?$)/;
const BLOCK_END_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$/;
const BLOCK_END_FENCE = /^ {0,3}(?:`{3,}|~{3,})/;
/**
 * Is line k in BLOCK position for a tab-led setext content line: the first
 * line, after a blank (spaces-only) line, or right after an ATX heading, a
 * thematic break or a fence line? A ` \t<!--` anywhere else continues the
 * paragraph above it (the renderer makes one `<p>` and the inline comment hides
 * the rest), because a tab-led `<!--` cannot interrupt a paragraph the way a
 * space-led one can.
 *
 * An ALLOWLIST read off the raw lines, independent of the content options,
 * rather than extractChunks' `wasPara`: the skip paths (skipTables and friends)
 * reset that state, and the `wasPara` arm newly spoke hidden text in 3,584
 * cells of NRL-155's predecessor census (`| a |` / ` \t<!--` / `===` /
 * `HIDDENA` / `-->` under skipTables among them). Everything not on the list -
 * a math closer, the end of an indented code block, a setext underline, a
 * whitespace line holding a tab - answers false and keeps hiding, which is the
 * fail-closed direction.
 */
function inSetextBlockPosition(lines: readonly string[], k: number): boolean {
	if (k === 0) return true;
	const prev = lines[k - 1]!;
	// Blank means SPACES only. A whitespace line holding a tab does not end a
	// paragraph in module 8607 (the tab counts as four columns of indent, so the
	// line is a continuation), and `Intro.` / ` \t ` / ` \t<!--` / `===` /
	// `HIDDEN` / `-->` is one `<p>` that hides HIDDEN. Measured: accepting it
	// newly spoke HIDDEN in 1,792 predecessor-census cells on the NRL-113 arm.
	return /^ *\r?$/.test(prev) || BLOCK_END_ATX.test(prev) || BLOCK_END_HR.test(prev) || BLOCK_END_FENCE.test(prev);
}
/**
 * `inSetextBlockPosition` for a line `depth` quote levels deep (NRL-114): is a
 * tab-led body there in BLOCK position, so that the quote's content tokenizers
 * can make it setext content rather than a lazy continuation of a paragraph?
 *
 * Fail-closed in every branch it is unsure of, since answering true where the
 * renderer continues a paragraph refuses a `<!--` the renderer keeps inside an
 * inline comment, which is a disclosure.
 *
 * - The first line of the note, or a previous line at the SAME depth whose body
 *   is spaces-only blank or an ATX heading, a thematic break or a fence line
 *   (`inSetextBlockPosition`'s own allowlist, on the peeled body).
 * - A previous line at the same depth with any other body, or at a DEEPER
 *   depth, is a paragraph the line may continue: false.
 * - A SHALLOWER or unquoted previous line means the quote may start here, but
 *   only if that line does not continue an earlier paragraph at this depth or
 *   deeper, so the walk goes back until a block end (true) or a line at this
 *   depth or deeper (false). A callout or a list marker anywhere on the way
 *   fails closed.
 */
function inQuoteSetextBlockPosition(lines: readonly string[], k: number, depth: number): boolean {
	for (let j = k - 1; j >= 0; j--) {
		const raw = lines[j]!;
		const p = containerPrefix(raw);
		// A callout title right above, at this depth, is a block of its own (module
		// 6234 tokenizes it first), so the line under it starts the content.
		if (p.callout) return j === k - 1 && p.quotes === depth;
		if (p.blockType === "list") return false;
		const quotes = p.blockType === "quote" ? p.quotes : 0;
		if (quotes > 0) {
			const q = raw.match(QUOTE_PREFIX_PEEL);
			if (!q || q[0].length !== p.chars) return false;
		}
		const body = raw.slice(quotes > 0 ? p.chars : 0);
		const blockEnd = /^ *\r?$/.test(body) || BLOCK_END_ATX.test(body) || BLOCK_END_HR.test(body) || BLOCK_END_FENCE.test(body);
		if (quotes >= depth) return quotes === depth && j === k - 1 && blockEnd;
		if (blockEnd) return true;
	}
	return true;
}
/**
 * Any list marker, including a BARE one with nothing after it. `LIST_BULLET`
 * needs whitespace after the marker, so it misses `-` alone on its line, which
 * module 745 accepts as an empty item. Measured, and found by NRL-120's fuzz
 * rather than its census: `-` / `<!--` / `-` / `HIDDENE` is two items, the first
 * holding the raw `<!--`, so HIDDENE is hidden, and `listDedented` never saw a
 * list there to veto the refusal.
 */
const ANY_LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
/**
 * A list marker followed by exactly one space and then content, so the item's
 * content column is exactly the marker's width. Two or more spaces after the
 * marker are left to fail closed rather than modelling the content-indent rule.
 */
const ONE_SPACE_MARKER = /^(?:[-*+]|\d{1,9}[.)]) (?=\S)/;
/**
 * Module 745's `b` regex, which is how that module decides what an item's marker
 * prefix IS before module 5540 is told how much to remove. Kept separate from
 * `LIST_BULLET`, `ANY_LIST_MARKER`, `ONE_SPACE_MARKER` and `PEEL_MARKER`
 * deliberately, because each of those five answers a different question and the
 * NRL-66 precedent says not to merge scans that do: this one must capture the
 * lead, the marker and the gap as three separate groups, VERBATIM, since
 * `itemHeadCols` measures a string rebuilt from them.
 *
 * Two details are module 745's and not ours. The gap alternation is ordered, so
 * ` {1,4}(?! )` takes up to four spaces only when a fifth does not follow -
 * `-     x` therefore has a ONE-space gap and a content indent of two, not six.
 * And the final `$` stands in for module 745's `$|(?=\n)`, because every caller
 * here is handed one line with no newline in it.
 */
const ITEM_HEAD = /^([ \t]*)([*+-]|\d+[.)])( {1,4}(?! )| |\t|$)/;
/** See the `LIST_LEVEL_CAP` comment in extractChunks' listDedented pass. */
const LIST_LEVEL_CAP = 64;
/**
 * Is `line` the single content line of a setext heading whose underline is
 * `next`, with a `<!--` at the start of that content (NRL-120)?
 *
 * Three container shapes are recognised and every other one answers false,
 * which keeps the base behaviour of hiding. That is the failure direction this
 * function must have: answering true where the renderer opens an HTML block
 * after all is a disclosure, answering false where it makes a heading is the
 * prose loss this ticket started from.
 *
 * - PLAIN: the line is the `<!--` opener and `next` is an exact underline. The
 *   lead is any run of spaces and tabs that module 134 does not take as indented
 *   code, i.e. not four spaces or a tab at offset 0 (NRL-155; one to three
 *   spaces then a tab IS setext content, measured `<h1>\t&#x3C;!--</h1>`). For a
 *   spaces-only lead no block-start test is needed on the line ABOVE, because a
 *   `<!--` with at most three spaces of lead interrupts any paragraph (`html` is
 *   in `u.interruptParagraph`), and once the block starts `setextHeading` gets
 *   it before `html`. Measured: `Intro.` / `<!--` / `===` is `<p>Intro.</p>` and
 *   then `<h1>`. A tab-bearing lead does NOT interrupt: module 8607, the
 *   paragraph tokenizer, counts the lead's spaces, treats the first tab as
 *   reaching four columns, and continues the paragraph without walking
 *   `interruptParagraph` at all (read from app.js, matching `TAB_BEARING_LEAD`).
 *   So it needs block position, `inSetextBlockPosition`: `Intro.` / ` \t<!--` /
 *   `===` / `HIDDENA` / `-->` is one `<p>` whose inline comment hides HIDDENA.
 * - QUOTE: quote levels only, no list marker or callout, and `next` carries the
 *   SAME number of levels and nothing else before an exact underline.
 * - LIST: the line IS a column-0 marker line, one space after the marker, `next`
 *   is indented by exactly the marker's width before an exact underline, and no
 *   later line of the item is indented by less than that width.
 *
 * `lazyInListItem` says the line may be a lazy continuation of a list item
 * (`listDedented`, or a list marker earlier in its run of non-blank lines) and
 * it vetoes all three, measured rather than reasoned: `- item` / `<!--` / `-` /
 * `HIDDEN` is ONE list whose second item is `HIDDEN`, because inside a list a
 * lone `-` is a new item rather than an underline, so the `<!--` stays raw HTML
 * in the first item and hides the rest. Without the veto that shape newly spoke
 * the hidden text in 2,304 census cells. The veto also gives up the `===` and
 * `--` lazy shapes, which the renderer does make headings; that is a
 * fail-closed residual.
 *
 * The LIST shape is limited to a marker at column 0, and the scan below it is
 * load-bearing, for the dedent reason given at the scan. A nested marker is
 * dedented by its outer item first, by the same rule, and is left to fail
 * closed rather than modelled.
 */
/**
 * Module 6058, transcribed: the indent of a line in columns (a tab advances to
 * the next multiple of four) and, for every column up to it, the index of the
 * whitespace character that reaches it. Module 5540 strips list-item content
 * through these stops, which is why a strip can swallow a whole tab.
 */
function indentStops(line: string): { indent: number; stops: Map<number, number> } {
	let indent = 0;
	let u = 0;
	const stops = new Map<number, number>();
	for (let a = 0; a < line.length && (line[a] === " " || line[a] === "\t"); a++) {
		const size = line[a] === "\t" ? 4 : 1;
		indent += size;
		if (size > 1) indent = Math.floor(indent / size) * size;
		while (u < indent) stops.set(++u, a);
	}
	return { indent, stops };
}

/**
 * Module 745's list-item opening line, `b`, minus its newline lookahead: a lead,
 * a marker, then one to four spaces not followed by a fifth, OR one space (so
 * five or more leaves the content as indented code), OR one tab, OR nothing.
 */
const LIST_ITEM_OPEN = /^([ \t]*)([*+-]|\d+[.)])( {1,4}(?! )| |\t|$)(.*)$/;

/**
 * What kind of literal block a line is in for the renderer (NRL-136): fenced
 * code, display math or frontmatter. They differ only in which toggle governs
 * speaking their text: `skipCodeBlocks`, none (math is read as the base reads
 * unclosed math, as prose), and `skipFrontmatter`.
 */
type LiteralKind = "code" | "math" | "front";

/** One line as a level of the container parse sees it (NRL-136 Q3). */
interface LineView {
	/** The line number. */
	k: number;
	/** What this level's block tokenizers are handed for the line. */
	text: string;
	/** Where `text` starts in the raw line. */
	off: number;
}

/**
 * The renderer's own fence-OPENER lead rule (NRL-156/NRL-132, ADR 0025): a
 * continuation of an open paragraph (`wasOpen`) tolerates at most three spaces
 * and no tab (module 8607's own interrupt-check cap), while a fresh block
 * tolerates any lead but a leading four spaces or a tab, which module 134
 * reads as indented code instead. This is the gate only, not the fence-char
 * test: every call site still tests `FENCE` (or the capture it needs)
 * separately, exactly as `containerViews` already did before this was pulled
 * out of it.
 *
 * `wasOpen` is "a paragraph left open at this point by the line before":
 * `containerViews`' own per-level signal, `wasPara`/`prevPara` at the
 * document's top level, and `paraLinesAbove > 0` for term 2's forward scan.
 * Reused rather than re-derived at the three call sites measured to need it;
 * `interruptsParagraphExceptBareMarker`'s FENCE term always sees `wasOpen`
 * true (a carry only ever continues a paragraph the opener line already
 * started) and is narrowed to a fixed cap instead, not threaded through here.
 * The other three `FENCE.test()` call sites in this file never see a
 * non-empty lead at all and are proven no-ops, not touched.
 *
 * Do NOT collapse the two branches into one capped constant: the fresh-block
 * branch legitimately admits a lead `MODULE134_INDENTED_CODE` would reject on
 * its own terms were it tab-stop-aware (e.g. one space then a tab), because
 * module 134 is literal rather than tab-stop-expanding (NRL-113). A single
 * `{0,3}`-style cap would wrongly refuse that shape.
 */
function fenceOpensAt(lead: string, wasOpen: boolean): boolean {
	return wasOpen ? /^ {0,3}$/.test(lead) : !/^(?: {4}|\t)/.test(lead);
}

/**
 * Is this whitespace-only line the blank line that ends an open paragraph
 * (NRL-158, R-M08)? Harness-measured against Obsidian 1.13.7's real parser
 * (`WT`/`GT`, app.js sha256 8efbf581...9898): a SPACES-ONLY whitespace line
 * always ends an open paragraph, exactly like any other blank line. A
 * whitespace line holding a TAB anywhere in its run, while a paragraph is
 * open before it, is module 8607's lazy continuation instead - never the
 * blank line that would end it. Leading-space count before the tab does not
 * matter, and a CR-terminated tab line behaves identically (both are just
 * `line.includes("\t")`). With no paragraph open the same tab-bearing line is
 * ordinary blank, which is why `paragraphOpen` is a parameter rather than the
 * function testing the line alone.
 *
 * This names a fact `walkLeadFrame`'s "para" state already tested inline
 * (`blank && !view.includes("\t")`, a few hundred lines below) rather than
 * inventing one; this is that fact promoted to a shared predicate, in the
 * same two-argument, `wasOpen`-named house style `fenceOpensAt` established
 * (NRL-156/NRL-132). The two are not the same question - this decides
 * whether a WHITESPACE-ONLY line is blank, `fenceOpensAt` decides a FENCE
 * opener's lead cap - and must not be threaded through one another.
 *
 * Containers are NOT the same rule and are deliberately not modelled here:
 * the harness found a quote/list line carrying its OWN marker interacts with
 * the renderer's setext/html precedence differently from a bare continuation
 * line, and a bare line with no marker at all ends the container regardless
 * of a tab. `paragraphOpen` is only ever `true` from a plain top-level
 * paragraph line (`wasPara`/`prevPara`), never from a quote/list line
 * (`wasContainer`/`prevContainer` takes that branch instead), so every call
 * of this function from a quote/list line is a no-op that falls through to
 * the plain `line.trim() === ""` answer - unchanged, not merely unbroken.
 */
function blankEndsParagraph(line: string, paragraphOpen: boolean): boolean {
	return line.trim() === "" && (!paragraphOpen || !line.includes("\t"));
}

/**
 * Where each line's INNERMOST container content starts in the raw line, written
 * into `out` by line number (NRL-136 Q3), so `htmlBlockLine` can measure the lead
 * the renderer's HTML tokenizer really sees. `views` are the lines as one level
 * of the parse sees them; the call recurses into every quote and list item, so
 * nesting in either order composes. A deliberately small block parse rather than
 * a per-line regex, because both containers decide membership by looking at
 * whole runs of lines.
 *
 * Transcribed from Obsidian 1.13.7's own code and then checked against its parser
 * and renderer, rather than reasoned:
 *
 * - QUOTE (module 6234): a run starts at a `>` led by under four columns. A
 *   further `>` line continues it and gives up its `>` plus ONE optional space; a
 *   line with no `>` is a lazy line that stays, as it is, unless it is blank or
 *   an `interruptBlockquote` construct starts on it (indented code, a fence, a
 *   heading, a rule, a list marker, `$$`, `%%` or any `<`).
 * - LIST (module 745): a run starts at a marker led by under four columns. A line
 *   indented to the item's content column, or by more than four, continues the
 *   item; another marker line starts a sibling, and a marker of another kind
 *   ends the list; a non-blank line after a blank one, or a heading, fence, rule
 *   or `%%` line, ends the list; anything else is a lazy line of the item.
 *   Measured: `- A` / X / `Z5Q` ends the item for X a heading, fence, rule, `%%`
 *   line or other marker kind, and not for `$$`, raw HTML, a quote, a table row
 *   or indented text. Its `M` then hands the item to module 5540 with the BULLET
 *   PAD as the maximum: the lead, the marker turned into spaces, one more for a
 *   single-digit ordinal whose `N.` plus spacing is odd, and the spaces after it.
 *   5540 strips the SMALLEST positive indent over the pad and every non-blank
 *   line, zero-indent lines skipped, through 6058's stops (`indentStops`).
 *   Measured: after `- A`, `  Z1Q`, a `<!-- a --> <!-- Z2Q` led by five spaces is
 *   an HTML block and by six it is lazy prose; a lone tab or `\t ` is stripped
 *   to nothing, `  \t` and `   \t` keep their tab.
 * - A fence at this level holds its lines away from both.
 *
 * Everything else is approximate in either direction and is censused rather
 * than argued, which is why its errors are bounded by the callers: an answer
 * here only moves the `<!--` lead test and where a block ends, never a decision
 * on its own.
 *
 * `homes[k]` gets the line's container STACK, outermost first, as ids unique to
 * each quote run and each list item. A block NRL-136 tracks under a browser
 * comment ends at the first line whose stack no longer holds every container
 * its opening line was in (`browserBlockHolds`), which is the renderer's rule:
 * a block cannot outlive its container. `home` is the stack of the level being
 * parsed and `ids` the counter.
 *
 * `depth` caps the recursion at main's `RL_MAX_DEPTH` (NRL-115 F3): one frame per
 * container level threw RangeError on a few thousand `>` or `- `. Beyond the cap
 * the deeper content is not parsed, so its lines keep the outer level's offset,
 * which still starts with a container marker and so never reads as an HTML block
 * line: the pre-NRL-136 answer, fail-closed.
 */
function containerViews(
	views: LineView[],
	out: number[],
	homes: number[][],
	home: number[],
	ids: { next: number; quotes: Set<number> },
	literal: Array<LiteralKind | undefined>,
	fences: Array<"open" | "close" | undefined>,
	htmlLines: boolean[],
	depth = 0,
): void {
	let n = 0;
	// The literal block open at THIS level: a fence (its character and length)
	// or display math (its `$` run). Measured closers: a fence closes on a line
	// of at most three columns of lead holding only the SAME character, at least
	// as many; math closes on a line ENDING in at least as many `$` (`a $$` and
	// `  $$  ` close, `$$ b` does not), and otherwise runs to the end.
	let literalBlock: { fence: string; len: number } | { math: number } | undefined;
	// A paragraph left open at this level by the line before, so the fence lead
	// test below can be module 8607's (a continuation: at most three spaces, no
	// tab) or a fresh block's (anything but a leading four spaces or tab, which
	// is indented code). Measured: ` \t```` after an HTML block opens a fence.
	let paraOpen = false;
	// An HTML block or a `%%` comment block open at this level: its lines are
	// neither literal nor containers, so a `$$` or a fence inside one opens
	// nothing. Measured: `   <!-- Z3Q` / `  $$` / `  \t<!----> <!-- Z5Q` is one raw
	// block, not a math block.
	let rawUntil: RegExp | "blank" | undefined;
	while (n < views.length) {
		const t = views[n]!.text;
		const shallow = indentStops(t).indent < 4;
		const wasOpen: boolean = paraOpen;
		paraOpen = false;
		if (rawUntil !== undefined) {
			const k = views[n]!.k;
			if (rawUntil === "blank") {
				if (t.trim() === "") rawUntil = undefined;
				else htmlLines[k] = true;
			} else {
				// A `%%` block is removed by the parser rather than passed raw.
				if (rawUntil.source !== "%%") htmlLines[k] = true;
				if (rawUntil.test(t)) rawUntil = undefined;
			}
			n += 1;
			continue;
		}
		if (literalBlock !== undefined) {
			literal[views[n]!.k] = "fence" in literalBlock ? "code" : "math";
			if ("fence" in literalBlock) {
				const c = t.match(/^ {0,3}(`+|~+)[ \t]*\r?$/);
				if (c && c[1]![0] === literalBlock.fence && c[1]!.length >= literalBlock.len) {
					fences[views[n]!.k] = "close";
					literalBlock = undefined;
				}
			} else if (t.trimEnd().endsWith("$".repeat(literalBlock.math))) {
				literalBlock = undefined;
			}
			n += 1;
			continue;
		}
		const fenceLead = t.match(/^[ \t]*/)![0];
		const fence = fenceOpensAt(fenceLead, wasOpen) ? t.match(/^[ \t]*(`{3,}|~{3,})/) : null;
		if (fence) {
			literal[views[n]!.k] = "code";
			fences[views[n]!.k] = "open";
			literalBlock = { fence: fence[1]![0]!, len: fence[1]!.length };
			n += 1;
			continue;
		}
		// Display math opens on a fresh block, and on a paragraph line only at the
		// top level: measured, `  - Z1Q` / `   $$` inside a list item is the
		// paragraph's text, not a math block.
		const math = wasOpen && home.length > 0 ? null : t.match(/^ {0,3}(\$\$+)[^$]*$/);
		if (math) {
			literal[views[n]!.k] = "math";
			literalBlock = { math: math[1]!.length };
			n += 1;
			continue;
		}
		if (shallow && /^[ \t]*>/.test(t)) {
			const run: LineView[] = [];
			let m = n;
			for (; m < views.length; m++) {
				const v = views[m]!;
				const q = v.text.match(/^[ \t]*>/);
				if (q) {
					const cut = q[0].length + (v.text[q[0].length] === " " ? 1 : 0);
					run.push({ k: v.k, text: v.text.slice(cut), off: v.off + cut });
					continue;
				}
				const u = v.text;
				const next = views[m + 1]?.text ?? "";
				if (
					u.trim() === "" ||
					/^(?: {4}|\t)/.test(u) ||
					FENCE.test(u) ||
					HEADING.test(u) ||
					HR.test(u) ||
					LIST_BULLET.test(u) ||
					/^\s*(?:\$\$|<)/.test(u) ||
					// The comment tokenizer as an interrupter: spaces only, then `%%` with
					// no further `%` on the line (read off the bundle). A lazy
					// ` %%Z4Q --> Z5Q%% Z6Q` stays in the quote.
					(/^ *%%/.test(u) && u.indexOf("%", u.indexOf("%%") + 2) === -1) ||
					SETEXT_UNDERLINE_EXACT.test(next.replace(/^[ \t]*>[ ]?/, ""))
				) {
					break;
				}
				run.push(v);
			}
			const quoteHome = [...home, ids.next];
			ids.quotes.add(ids.next++);
			for (const r of run) {
				out[r.k] = r.off;
				homes[r.k] = quoteHome;
			}
			if (depth < RL_MAX_DEPTH) containerViews(run, out, homes, quoteHome, ids, literal, fences, htmlLines, depth + 1);
			n = m;
			continue;
		}
		const lead = t.match(/^[ \t]*/)![0];
		if (wasOpen ? /^ {0,3}$/.test(lead) : !/^(?: {4}|\t)/.test(lead)) {
			const body = t.slice(lead.length);
			// The app's comment tokenizer skips SPACES only before `%%` (read off the
			// bundle, the same rule the list loop below applies), so a lead holding a
			// tab is not a `%%` block: measured, `  \t%% Z0Q` displays `%% Z0Q` as a
			// paragraph. Reading it as a block swallowed the lines under it, and a
			// list item there lost its strip, so a reopening `<!--` in it was read
			// as inline and spoken (Ship fuzz, NRL-136).
			if (!lead.includes("\t") && body.startsWith("%%") && body.indexOf("%", 2) === -1) {
				rawUntil = /%%/;
				n += 1;
				continue;
			}
			// `setextHeading` runs before `html` (NRL-120), so a `<!--` line over an
			// exact underline is heading text; inside a container only the `=` form
			// is trusted, a `-` run there being the next item or a rule.
			const under = views[n + 1]?.text ?? "";
			const setext = home.length > 0 ? /^=+\r?$/.test(under) : SETEXT_UNDERLINE_EXACT.test(under);
			if (body.startsWith("<!--") && !setext) {
				htmlLines[views[n]!.k] = true;
				if (!/-->/.test(body.slice(1))) rawUntil = /-->/;
				n += 1;
				continue;
			}
			const end = rawBlockOpener(body);
			if (end !== undefined) {
				htmlLines[views[n]!.k] = true;
				if (end === "blank" || !end.test(body.slice(1))) rawUntil = end;
				n += 1;
				continue;
			}
		}
		// Module 745 asks `thematicBreak` about every marker line, the first
		// included, so `- - -` is a rule and never a list.
		const open = HR.test(t) ? null : t.match(LIST_ITEM_OPEN);
		if (!shallow || !open) {
			paraOpen =
				t.trim() !== "" &&
				!(wasOpen ? false : /^(?: {4}|\t)/.test(t)) &&
				!HEADING.test(t) &&
				!HR.test(t) &&
				!/^[ \t]*</.test(t);
			n += 1;
			continue;
		}
		const kind = open[2]!.slice(-1);
		const items: number[][] = [];
		let cur: number[] = [];
		let contentIndent = 0;
		let prevBlank = false;
		let k = n;
		for (; k < views.length; k++) {
			const v = views[k]!.text;
			const blank = v.trim() === "";
			const indent = indentStops(v).indent;
			const marker = items.length > 0 && indent >= contentIndent ? null : v.match(LIST_ITEM_OPEN);
			if (marker) {
				if (marker[2]!.slice(-1) !== kind || HR.test(v)) break;
				cur = [k];
				items.push(cur);
				const markerWidth = indentStops(marker[1]!).indent + marker[2]!.length;
				const after = marker[3]!;
				contentIndent = after === "\t" ? markerWidth + 4 - (markerWidth % 4) : markerWidth + after.length;
			} else if (indent >= contentIndent || indent > 4 || blank) {
				cur.push(k);
			} else {
				// A `%%` interrupts only as a BLOCK opener, which is the app's comment
				// tokenizer read off the bundle: spaces skipped (not tabs), `%%`, and no
				// further `%` on the line. `%%%Z3Q --> Z4Q%% Z5Q` is an inline pair and
				// stays a lazy line of the item; `  %% Z5Q` under `1. a` ends the list and
				// opens a top-level comment that runs to the end of the note, measured.
				const pct = v.match(/^ *%%/);
				if (prevBlank || HEADING.test(v) || FENCE.test(v) || HR.test(v) || (pct && v.indexOf("%", pct[0].length) === -1)) break;
				cur.push(k);
			}
			prevBlank = blank && !marker;
		}
		for (const item of items) {
			const first = views[item[0]!]!;
			const m = first.text.match(LIST_ITEM_OPEN)!;
			let digits = m[2]!;
			if (Number(digits) < 10 && (m[1]! + m[2]! + m[3]!).length % 2 === 1) digits = ` ${digits}`;
			const pad = m[1]! + " ".repeat(digits.length) + m[3]!;
			let p = Infinity;
			for (const l of [`${pad}!`, pad + m[4]!, ...item.slice(1).map((i) => views[i]!.text)]) {
				if (l.trim() === "") continue;
				const indent = indentStops(l).indent;
				if (indent > 0 && indent < p) p = indent;
			}
			const task = m[4]!.match(/^\[.\][ \t]/);
			const lead = m[1]!.length + m[2]!.length + m[3]!.length + (task ? task[0].length : 0);
			const content: LineView[] = [{ k: first.k, text: first.text.slice(lead), off: first.off + lead }];
			for (const i of item.slice(1)) {
				const v = views[i]!;
				let cut = 0;
				if (p !== Infinity) {
					const { stops } = indentStops(v.text);
					let s = p;
					while (s > 0 && !stops.has(s)) s -= 1;
					cut = s > 0 ? stops.get(s)! + 1 : 0;
				}
				content.push({ k: v.k, text: v.text.slice(cut), off: v.off + cut });
			}
			const itemHome = [...home, ids.next++];
			for (const c of content) {
				out[c.k] = c.off;
				homes[c.k] = itemHome;
			}
			if (depth < RL_MAX_DEPTH) containerViews(content, out, homes, itemHome, ids, literal, fences, htmlLines, depth + 1);
		}
		n = k;
	}
}

function isSetextContentLine(lines: readonly string[], k: number, lazyInListItem: boolean): boolean {
	if (lazyInListItem) return false;
	const line = lines[k]!;
	const next = lines[k + 1]!;
	const p = containerPrefix(line);
	if (p.callout || p.blockType === "heading") return false;
	const q = line.match(QUOTE_PREFIX_PEEL);
	const quoteChars = q ? q[0].length : 0;
	if (p.blockType === "quote") {
		// Quote levels only: a quoted list item or task is left to fail closed.
		if (p.chars !== quoteChars) return false;
		// The quote BODY gets the plain arm's lead rule (NRL-114): any run of
		// spaces and tabs that module 134 does not take as indented code, a
		// tab-bearing one only in block position. With the narrower peel the body
		// keeps the character after `>` + one space, so `>  \t<!--` / `> ===` has
		// the body ` \t<!--`, which is `<h1>` for the renderer and which the old
		// spaces-only `HTML_OPENER_AT_START` refused to recognise.
		const body = line.slice(p.chars);
		// ONE deliberate base-parity case, in the manner of the peel's lone CR: a
		// whitespace character other than a space or a tab directly after the `>`
		// (an NBSP, a vertical tab, a form feed, an ideographic space). The old
		// wide peel consumed it, so the old spaces-only test saw `<!--` at offset 0
		// and refused; with the narrower peel it stays in the body. For the
		// renderer such a line is paragraph text, not an HTML opener at all, and
		// the right fix is `opensHtmlBlock`'s term 1, whose `.trim()` accepts that
		// lead. That fix was built and measured: it closed these cells and
		// UNMASKED renderer behaviour nothing here models (an unreferenced footnote
		// definition, a raw HTML block, a `%%` inside a quoted list item), which
		// base had hidden only through the same over-wide term 1, 46 newly
		// disclosing cells in this ticket's fuzz. So this character position keeps
		// exactly the old answer, and the term-1 lead stays as it was (NRL-114).
		const exoticAfterMarker = /^[^\S \t\r\n]/.test(body) && line[p.chars - 1] === ">";
		if (exoticAfterMarker ? !HTML_OPENER_AT_START.test(body.slice(1)) : !PLAIN_SETEXT_HTML_OPENER.test(body) || MODULE134_INDENTED_CODE.test(body)) return false;
		const n = containerPrefix(next);
		if (n.blockType !== "quote" || n.quotes !== p.quotes || n.callout) return false;
		const nq = next.match(QUOTE_PREFIX_PEEL);
		if (!nq || n.chars !== nq[0].length) return false;
		if (!SETEXT_UNDERLINE_EXACT.test(next.slice(n.chars))) return false;
		return exoticAfterMarker || !TAB_BEARING_LEAD.test(body) || inQuoteSetextBlockPosition(lines, k, p.quotes);
	}
	if (p.blockType === "list") {
		const m = line.match(ONE_SPACE_MARKER);
		if (!m || m[0].length !== p.chars) return false;
		if (!HTML_OPENER_AT_START.test(line.slice(p.chars))) return false;
		const indent = next.match(/^ */)![0].length;
		if (indent !== p.chars || !SETEXT_UNDERLINE_EXACT.test(next.slice(indent))) return false;
		// Module 5540 does not strip the marker's width from each continuation
		// line. It strips the SMALLEST non-zero indent found across the item's
		// lines, so one later line indented by less than the marker re-indents the
		// underline and it stops being one. Measured: `- <!--` / `  -` / `HIDDENE` /
		// `<div>` / ` ===` puts ` -` in the item, the `<!--` stays raw HTML, and
		// HIDDENE is hidden; found by the fuzz, not the census. So refuse unless no
		// line up to the next blank one sits strictly between zero and the marker.
		for (let n = k + 2; n < lines.length; n++) {
			const l = lines[n]!;
			if (/^ *\r?$/.test(l)) break;
			const lead = l.match(/^[ \t]*/)![0];
			if (lead.length > 0 && lead.length < p.chars) return false;
		}
		return true;
	}
	if (!PLAIN_SETEXT_HTML_OPENER.test(line) || MODULE134_INDENTED_CODE.test(line)) return false;
	if (!SETEXT_UNDERLINE_EXACT.test(next)) return false;
	// A spaces-only lead needs no position test: `html` interrupts a paragraph,
	// so the line starts a block wherever it sits. A tab-bearing one does not
	// interrupt, so it is setext content only in block position (NRL-155).
	return !TAB_BEARING_LEAD.test(line) || inSetextBlockPosition(lines, k);
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
 *
 * `htmlLeadIndented` is required for the same reason (NRL-115). A line it marks
 * no longer interrupts here, which WIDENS codeSpanClosesLater and
 * bracketClosesLater: a carry can now cross a lazy indented `<!--` line. That is
 * the renderer's own behaviour, since module 8607 never ran the interrupt check
 * on such a line, and it was measured for disclosure over plain and container
 * shapes rather than assumed safe.
 *
 * FENCE is `FENCE_CONTINUATION` here, not the bare any-indent constant
 * (NRL-156): every call in this family asks about a line that, if it does
 * not interrupt, continues the carry's already-open paragraph, so `wasOpen`
 * is always true and the three-space cap applies unconditionally. This
 * NARROWS the predicate (fewer lines interrupt), matching HEADING/BLOCKQUOTE/
 * HR's existing `{0,3}` caps, and is not the widening ADR 0019's F5 guard
 * (HEADING/BLOCKQUOTE/LIST_BULLET/TABLE_ROW) exists to catch - FENCE is not
 * in that enumeration.
 */
function interruptsParagraph(line: string, htmlClosesLater: boolean, dedentedByList: boolean, htmlLeadIndented: boolean, listStrip: number): boolean {
	return interruptsParagraphExceptBareMarker(line, htmlClosesLater, dedentedByList, htmlLeadIndented, listStrip) || BARE_LIST_MARKER.test(line);
}

/**
 * Every arm of `interruptsParagraph` but `BARE_LIST_MARKER`, for the one caller
 * that must test that arm on a DIFFERENT string: `bracketClosesLater`, which tests
 * it on the renderer's reading of a quoted line (`quoteContent`) and every other
 * arm on the legacy peel (NRL-119 fix round 2, see `quoteContent`). Split out
 * rather than parameterised so `interruptsParagraph`'s other callers keep exactly
 * the answer they had.
 */
function interruptsParagraphExceptBareMarker(line: string, htmlClosesLater: boolean, dedentedByList: boolean, htmlLeadIndented: boolean, listStrip: number): boolean {
	return (
		line.trim() === "" ||
		FENCE_CONTINUATION.test(line) ||
		HEADING.test(line) ||
		HR.test(line) ||
		SETEXT.test(line) ||
		TABLE_ROW.test(line) ||
		LIST_BULLET.test(line) ||
		BLOCKQUOTE.test(line) ||
		opensHiddenComment(line, htmlClosesLater, dedentedByList, htmlLeadIndented, listStrip)
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
function codeSpanClosesLater(
	lines: string[],
	from: number,
	len: number,
	htmlCloserAhead: readonly boolean[],
	listDedented: readonly boolean[],
	htmlLeadIndented: readonly boolean[],
	listStrip: readonly number[],
): boolean {
	if (interruptsParagraph(lines[from]!, htmlCloserAhead[from]!, listDedented[from]!, htmlLeadIndented[from]!, listStrip[from]!)) return false;
	for (let n = from + 1; n < lines.length; n++) {
		const line = lines[n]!;
		if (interruptsParagraph(line, htmlCloserAhead[n]!, listDedented[n]!, htmlLeadIndented[n]!, listStrip[n]!)) return false;
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
function bracketClosesLater(
	lines: string[],
	from: number,
	htmlCloserAhead: readonly boolean[],
	listDedented: readonly boolean[],
	htmlLeadIndented: readonly boolean[],
	htmlLeadLazy: readonly boolean[],
	htmlLeadCode: readonly boolean[],
	listStrip: readonly number[],
): boolean {
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
	if (interruptsParagraph(lines[from]!.slice(op.chars), htmlCloserAhead[from]!, listDedented[from]!, htmlLeadIndented[from]!, listStrip[from]!) || opensMathBlock(lines, from, op.quotes)) return false;
	if (containerInPlay && containerCarryStops(lines[from]!.slice(op.chars), false, htmlLeadLazy[from]!)) return false;
	// A container line whose dedented body is module 134 indented code is a CODE
	// block for the renderer, so no label can open on it or run across it
	// (NRL-114). The wide peel used to hide this: it ate the tab in `>\t![alt`,
	// so the opener looked like a paragraph and the next `>\t<div>` line hit
	// `HTML_BLOCK_OPEN`. With the tab left in the body neither held, the carry
	// confirmed, and `[`, `](` and the destination - all displayed as code text
	// (`<blockquote><pre><code>![alt ZAZ...](ZDZ.png) ZBZ`) - went silent.
	if (containerInPlay && htmlLeadCode[from]!) return false;
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
		// Every arm on the legacy peel, as base had it; the bare-marker arm (round 1's)
		// on the renderer's reading of the line. See `quoteContent`.
		if (
			interruptsParagraphExceptBareMarker(line, htmlCloserAhead[n]!, listDedented[n]!, htmlLeadIndented[n]!, listStrip[n]!) ||
			BARE_LIST_MARKER.test(quoteContent(lines[n]!, op.quotes)) ||
			opensMathBlock(lines, n, op.quotes)
		)
			return false;
		if (containerInPlay && containerCarryStops(line, op.quotes > 0 && !ANY_QUOTE_MARKER.test(lines[n]!), htmlLeadLazy[n]!)) return false;
		if (containerInPlay && htmlLeadCode[n]!) return false;
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
/*
 * NRL-115: WHERE A LINE'S LEAD LANDS FOR THE RENDERER.
 *
 * `opensHtmlBlock`'s term 1 asks "does `<!--` begin its line, leading
 * whitespace allowed". Module 8776, Obsidian's HTML block tokenizer, really
 * does skip spaces and tabs with no cap, so that question is the right one
 * WHEN MODULE 8776 IS REACHED. For two kinds of line it never is, and the
 * pass below finds them:
 *
 * - A PARAGRAPH CONTINUATION indented a tab or four or more columns. Module
 *   8607 (paragraph), on the `commonmark: true` branch Obsidian always runs,
 *   counts each following line's indent, sets it to four on a tab
 *   (`if((h=t.charAt(c))===o){p=l;break}` with o = "\t", l = 4) and, when it
 *   reaches four, `continue`s WITHOUT running the `interruptParagraph` check
 *   at all. The line is absorbed as lazy prose and no block tokenizer sees it.
 * - A FRESH BLOCK INSIDE A CONTAINER that starts with a tab or four spaces.
 *   `blockMethods` runs `indentedCode` (module 134) before `html`, so the line
 *   is indented code, displayed. At the top level `extractChunks`' own
 *   INDENTED_CODE branch already handles this and is deliberately NOT
 *   touched (NRL-113 owns those positions); inside a quote or a list item no
 *   branch of ours does.
 *
 * "After container dedent" is the whole difficulty, and it is why this is a
 * pass and not a regex. Module 6234 (blockquote) strips `>` and ONE SPACE,
 * never a tab. Module 745 (list) hands each item's value to module 5540,
 * which removes `p` columns from every line, where `p` is the smaller of the
 * item's marker width (with module 745's odd-width bump for `1.`-style
 * markers) and the least indent of any indented line in the WHOLE ITEM, and
 * removes them by module 6058's tab stops, so a tab straddling the boundary
 * goes entirely. `- a` / tab / `<!--` therefore reaches the item's tokenizer
 * as `<!--` at column 0 and DOES open a comment, while `- a` / two spaces,
 * tab / `<!--` reaches it as tab, `<!--` and is lazy prose. Both measured.
 * Because `p` depends on lines AFTER the one being judged, each item is
 * collected whole before any of its lines is judged.
 *
 * Everything here is a model of the renderer's container structure and is
 * built to FAIL CLOSED. Its one output is a claim that a line is NOT an HTML
 * block opener, so the only harmful error is claiming that of a line the
 * renderer does open a block on - which would read author-hidden text aloud.
 * Wherever the model is unsure it records nothing (`unknown`), and a line
 * with no record keeps the old answer. Three choices carry that:
 *
 * - The default classification of a block is FRESH, never PARAGRAPH. A FRESH
 *   line is only ever claimed when it starts with a tab or four spaces, and
 *   the renderer shows such a line in both positions (code if fresh, lazy if
 *   a continuation), so mistaking a paragraph for a fresh block is harmless.
 *   The reverse mistake is not: ` \t<!--` is lazy prose after a paragraph and
 *   an HTML block opener at a block start. So only a line positively known to
 *   be paragraph text arms the continuation rule.
 * - Anything not modelled - a non-comment HTML block, a callout's quirks, a
 *   lazy line that might interrupt a list or a quote - puts the frame into
 *   `unknown`, which ends only at a TRULY EMPTY line followed by a column-0
 *   line. Not a whitespace-only line: an HTML block of kinds 6 and 7 ends at
 *   `/^$/`, so a line holding a tab does not end it. Relaxing that to
 *   `trim() === ""` was measured to produce a wrong claim in the fuzz.
 * - Constructs that can span blank lines (fences, `%%`, `$$`, and the HTML
 *   kinds with closers) are skipped to their closer in every state, so an
 *   empty line inside one cannot end `unknown` early.
 *
 * Measured, not argued: the model's claims were checked against Obsidian
 * 1.13.7's own parser and renderer executed out of the installed bundle, with
 * a causal oracle (the sentinel after a `<!--` line is hidden in the note but
 * shown once that one `<!--` is defused). 0 wrong claims over the 338-cell
 * position census and 24,000 fuzz notes with tabs, multi-space leads and
 * nested quotes and lists; dropping the item dedent gives 702 wrong claims,
 * lowering the lazy threshold to three columns gives 32, and resetting
 * `unknown` on a whitespace-only line gives 1, so the check can fail.
 * Those figures are PR #169's, on the model BEFORE the setext tiers in
 * walkLeadFrame, and that clean result was itself corpus-blind: neither the
 * census nor the fuzz put an indented `<!--` straight after a setext
 * underline, which is exactly where the model was wrong (it read the heading
 * as paragraph text). Verify found it end to end. The tiers were then measured
 * end to end rather than by claims: 0 newly disclosing and 0 newly lost
 * sentinel cells over a 1,232,896-cell position census and a 5,160,960-cell
 * after-setext census (all 512 option combinations each), with four
 * deliberately wrong arms each leaking there, so neither census is saturated.
 *
 * The arrays are kept per line rather than folded into one boolean so the
 * `%%` side can share them later (NRL-115 Q1). It does not today:
 * `opensObsidianBlock` keeps `listDedented`, because changing `%%` needs its
 * own invariance probe and the two predicates are deliberately separate.
 */

/** Columns a run of leading whitespace reaches; a tab advances to the next multiple of four (module 6058). */
function leadColumns(s: string): number {
	let c = 0;
	for (let k = 0; k < s.length; k++) {
		const ch = s[k];
		if (ch === "\t") c += 4 - (c % 4);
		else if (ch === " ") c += 1;
		else break;
	}
	return c;
}

/**
 * Module 5540's per-line slice: remove `p` columns of lead by module 6058's
 * stops. A tab that crosses column `p` is removed whole, and a line indented
 * less than `p` loses all of its lead, which is what `while (s && !(s in c))
 * s--` does; a line with no lead at all is left alone.
 */
function removeLeadColumns(line: string, p: number): string {
	const stops: number[] = [];
	let col = 0;
	let filled = 0;
	for (let a = 0; a < line.length; a++) {
		const ch = line[a];
		if (ch !== " " && ch !== "\t") break;
		col = ch === "\t" ? col + 4 - (col % 4) : col + 1;
		while (filled < col) stops[++filled] = a;
	}
	let s = p;
	while (s > 0 && stops[s] === undefined) s--;
	return s === 0 ? line : line.slice(stops[s]! + 1);
}

/*
 * A thematic break as Obsidian's thematic-break tokenizer
 * actually takes it: leading spaces and tabs, then three or more markers
 * separated and followed by SPACES ONLY. A tab between or after the markers
 * is not a break: `- \t---` is a list item whose content is indented code,
 * `***\t` is paragraph text, and `*\t*\t*` is three nested list items, all
 * measured on the executed parser. The first NRL-115 rework accepted tabs
 * there, read `> - \t---` / `>\t<!--` as a break followed by an indented-code
 * line and spoke a comment the renderer opens (the list item's dedent puts the
 * `<!--` at column 0), and read `***\t` as ending the paragraph in
 * the closer scan (now `closerAheadTable`) so a `-->` past it was missed. Both were disclosures
 * found by the implement-phase fuzz, not by the plan's corpora.
 */
const RL_HR = /^[ \t]*([-*_])(?: *\1){2,} *$/;
/*
 * The old, tab-tolerant shape, kept ONLY for mayInterruptQuote and
 * mayInterruptList. Those two must over-approximate (a false yes ends the
 * container early into `unknown`, which records nothing), so the wider test
 * is the safe one there and the strict one would not be.
 */
const RL_HR_LOOSE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RL_HEADING = /^[ \t]*#{1,6}(?:[ \t]|$)/;
const RL_QUOTE = /^[ \t]*>/;
// Any underline-SHAPED line, deliberately broader than module 8671's exact
// shape (`SETEXT_UNDERLINE_EXACT`): up to three spaces of lead, trailing
// whitespace, a trailing CR. Every use of it below is a fail-closed one - it
// classifies a line FRESH, ends a quote early, or ends a paragraph as `unknown`.
const RL_SETEXT = /^ {0,3}(?:=+|-+)[ \t]*\r?$/;
// Any list marker module 745 accepts at a block start.
const RL_LIST_ANY = /^[ \t]*(?:[*+-]|\d+[.)])(?:[ \t]|$)/;
// The subset its silent mode accepts, which is what `interruptParagraph` asks:
// a bullet, or an ordered marker whose digits are exactly "1".
const RL_LIST_INTERRUPT = /^[ \t]*(?:[*+-]|1[.)])(?:[ \t]|$)/;
// Module 745's own marker regex `b`, which decides what an item's first line is.
const RL_ITEM = /^([ \t]*)([*+-]|\d+[.)])( {1,4}(?! )| |\t|$)(.*)$/;
// Module 8776's HTML kinds that carry their own closer and so can span an
// empty line. Kinds 6 and 7 end at an empty line and are left to `unknown`.
const RL_SPAN_HTML: ReadonlyArray<readonly [RegExp, RegExp]> = [
	[/^<(script|pre|style)(?=(\s|>|$))/i, /<\/(script|pre|style)>/i],
	[/^<!--/, /-->/],
	[/^<\?/, /\?>/],
	[/^<![A-Za-z]/, />/],
	[/^<!\[CDATA\[/, /]]>/],
];

const RL_MAX_DEPTH = 32;
type LeadState = "fresh" | "para" | "unknown" | "unknownAfterEmpty";

interface LeadFrameLine {
	view: string;
	id: number;
}

/**
 * Per raw line: the lead the renderer's block tokenizers see once every
 * container has been stripped (`null` where the model is unsure), whether the
 * line is a paragraph continuation there, and whether it sits inside a quote
 * or a list item.
 */
interface RendererLeads {
	lead: (string | null)[];
	cont: boolean[];
	nested: boolean[];
	closerInPara: boolean[];
	/**
	 * A fresh-block line the walker classified as such only because the line
	 * above it was AMBIGUOUS (table-, definition-, block-id- or underline-shaped,
	 * which the renderer may have taken as paragraph text instead), or a line of
	 * an indented-code run that began on one. `nested && startsIndentedCode`
	 * there may be a lazy continuation for the renderer, so NRL-114's term-2
	 * code mask must not trust it (`htmlLeadCode` in extractChunks).
	 */
	unsureFresh: boolean[];
	/**
	 * A line the walker put in a PARAGRAPH whose first line it trusts (NRL-166
	 * fix round 1): that first line or one of its continuations. Its content
	 * never starts a block, so a `<!--` on it is inline for the renderer, which
	 * is what lets cleanLine apply the inline comment's body rule. False for
	 * every line the walker did not record, or recorded as anything else.
	 */
	para: boolean[];
	/**
	 * Whether this walk applies NRL-166 fix round 1's walker refinements (a
	 * quote ended by indented code is fresh; an uncertainly-ended last item's
	 * first line is walked; since fix round 2, a line of exactly the `%%`
	 * interrupting shape certainly ends a list). extractChunks runs the walk with
	 * and without them and takes each line's refined record only where that
	 * line's window is clean (`refineWindowClean`), which replaces round 1's
	 * note-wide gate: a comment the refinements correctly drop could be covering
	 * text that a tag attribute, a link title, an image label, a footnote or a
	 * frontmatter block hides (`> > a` / `>\t[r]: "<!-- b` / `![c` /
	 * `d -->](a.png)` spoke c and d, the embed's `alt`).
	 */
	refine: boolean;
	pending: { frame: LeadFrameLine[]; depth: number }[];
}

/**
 * Anything shaped like a footnote definition's label, anywhere on a line: a `[^`
 * whose first `]` after it is followed by `:` (the language of
 * `/\[\^[^\]]*\]:/`). A scan rather than that regex, which backtracks
 * quadratically on a line of many `[^` with no `]` and runs on every line of
 * every note here. Every `[^` before the same first `]` shares its answer, so
 * the scan resumes after that `]` and stays linear.
 */
function footnoteShaped(line: string): boolean {
	for (let i = line.indexOf("[^"); i !== -1; ) {
		const close = line.indexOf("]", i + 2);
		if (close === -1) return false;
		if (line.charCodeAt(close + 1) === 58) return true;
		i = line.indexOf("[^", close + 1);
	}
	return false;
}

function startsIndentedCode(view: string): boolean {
	return view.startsWith("\t") || view.startsWith("    ");
}

/**
 * If `rest` opens a construct that can span an empty line, the frame index
 * just past its closer (or the frame's end); otherwise -1.
 */
function spanningEnd(frame: readonly LeadFrameLine[], i: number, rest: string): number {
	const fence = /^(`{3,}|~{3,})/.exec(rest);
	if (fence) {
		// Module 1498's closer: at most three SPACES, the same character, at
		// least as long, then only whitespace.
		const run = fence[1]!;
		const closer = new RegExp(`^ {0,3}${run[0] === "`" ? "`" : "~"}{${run.length},}[ \\t]*$`);
		for (let j = i + 1; j < frame.length; j++) if (closer.test(frame[j]!.view)) return j + 1;
		return frame.length;
	}
	for (const open of ["%%", "$$"]) {
		if (!rest.startsWith(open)) continue;
		if (rest.indexOf(open, 2) !== -1) return -1;
		for (let j = i + 1; j < frame.length; j++) if (frame[j]!.view.includes(open)) return j + 1;
		return frame.length;
	}
	for (const [open, close] of RL_SPAN_HTML) {
		if (!open.test(rest)) continue;
		if (close.test(rest)) return i + 1;
		for (let j = i + 1; j < frame.length; j++) if (close.test(frame[j]!.view)) return j + 1;
		return frame.length;
	}
	return -1;
}

/**
 * Might a non-`>` line end the quote above it? Over-approximates module
 * 6234's `interruptBlockquote` walk on purpose: a false yes only ends the
 * quote early and puts the frame into `unknown`.
 */
function mayInterruptQuote(frame: readonly LeadFrameLine[], j: number): boolean {
	const v = frame[j]!.view;
	if (startsIndentedCode(v)) return true;
	if (/^[ \t]*(`{3,}|~{3,}|%%|\$\$|<|#)/.test(v)) return true;
	if (RL_HR_LOOSE.test(v) || RL_LIST_ANY.test(v)) return true;
	const next = frame[j + 1];
	return next !== undefined && RL_SETEXT.test(next.view);
}

/** The same over-approximation of module 745's `interruptList`. */
function mayInterruptList(view: string): boolean {
	return /^[ \t]*(`{3,}|~{3,}|%%|\$\$|#)/.test(view) || RL_HR_LOOSE.test(view);
}

/**
 * `closerInPara` for every line of one frame, in ONE backward pass (NRL-115 ship
 * critique, r3 F2). Entry `i` answers "scanning forward from line i + 1, is a
 * `-->` reached before the walker's lazy paragraph certainly ends", where it
 * ends at a whitespace-only line with no tab or at a line with under four
 * columns of tab-free lead that the walker's own interrupt set matches. The
 * scan used to be re-run from every lazy indented line, which is quadratic in
 * the paragraph's length: a quote of 20,000 `>\tlazy` lines took 22 s against
 * base's 0.27 s. The recurrence is exactly that loop read backwards - each
 * line either ends the scan (false), answers it (`-->`, true), or passes the
 * answer of the line after it through - so the result is unchanged.
 */
function closerAheadTable(frame: readonly LeadFrameLine[]): boolean[] {
	const ahead = new Array<boolean>(frame.length).fill(false);
	let rest = false; // the answer for a scan starting at line j + 1
	for (let j = frame.length - 1; j >= 1; j--) {
		const v = frame[j]!.view;
		if (v.trim() === "" && !v.includes("\t")) {
			rest = false;
		} else {
			const lead = /^[ \t]*/.exec(v)![0];
			const interrupts =
				!lead.includes("\t") && leadColumns(lead) < 4 &&
				(RL_HR.test(v) || RL_LIST_INTERRUPT.test(v) || RL_HEADING.test(v) ||
					/^(`{3,}|~{3,}|%%|\$\$|>|<)/.test(v.slice(lead.length)));
			if (interrupts) rest = false;
			else if (v.includes("-->")) rest = true;
		}
		ahead[j - 1] = rest;
	}
	return ahead;
}

function walkLeadFrame(frame: readonly LeadFrameLine[], depth: number, out: RendererLeads): void {
	const nested = depth > 0;
	let state: LeadState = "fresh";
	// Built on first use, so a frame with no lazy indented line pays nothing.
	let closerAhead: boolean[] | null = null;
	// The frame index of the line that put the frame into "para", so a setext
	// underline can be judged against exactly ONE content line above it.
	let paraStart = -1;
	// Whether the paragraph that began at `paraStart` began at a line the
	// renderer certainly starts a block on. False when the line before it was
	// one of the ambiguous shapes classified FRESH below (table-, definition-,
	// block-id- or underline-shaped), which the renderer may instead have taken
	// as paragraph text, so `paraStart` may undercount the content lines.
	let paraTrusted = true;
	let ambiguousAt = -2;
	const record = (k: number, cont: boolean): void => {
		const { view, id } = frame[k]!;
		out.lead[id] = /^[ \t]*/.exec(view)![0];
		out.cont[id] = cont;
		out.nested[id] = nested;
		out.para[id] = cont && paraTrusted;
	};
	let i = 0;
	while (i < frame.length) {
		const view = frame[i]!.view;
		const blank = view.trim() === "";
		if (state === "unknown" || state === "unknownAfterEmpty") {
			if (blank) {
				state = view === "" ? "unknownAfterEmpty" : "unknown";
				i++;
				continue;
			}
			const span = spanningEnd(frame, i, view.replace(/^[ \t>]*/, ""));
			if (span !== -1) {
				state = "unknown";
				i = span;
				continue;
			}
			if (state === "unknown" || /^[ \t]/.test(view)) {
				state = "unknown";
				i++;
				continue;
			}
			state = "fresh";
		}
		if (state === "para") {
			// Module 8607 reads a whitespace-only line holding a tab as a lazy
			// continuation, not as the blank line that would end the paragraph.
			if (blank && !view.includes("\t")) {
				state = "fresh";
				i++;
				continue;
			}
			const lead = /^[ \t]*/.exec(view)![0];
			if (lead.includes("\t") || leadColumns(lead) >= 4) {
				record(i, true);
				out.closerInPara[frame[i]!.id] = (closerAhead ??= closerAheadTable(frame))[i]!;
				i++;
				continue;
			}
			/*
			 * A setext underline ENDS the paragraph: module 8671 closes the block
			 * as a heading, so the next line is a block start and module 8776 IS
			 * reached for it. Without this the walker read `PROSEP` / `===` /
			 * ` \t<!--` as a three-line paragraph and claimed the `<!--` line was
			 * lazy, which spoke the comment body - the disclosure that blocked
			 * PR #169 at Verify (6,144 census cells), and wider than recorded there:
			 * `=`, `==`, `-` and `--` leak the same way. Two tiers, in this order
			 * and placed exactly here, and both orderings are load-bearing:
			 *
			 * - After the tab / four-column test above, because a tab-led or
			 *   four-column underline is a lazy continuation for module 8607 and
			 *   never an underline.
			 * - Tier 1 BEFORE the interrupt test: the exact module 8671 shape under
			 *   exactly one content line is a heading (NRL-120's measured case), and
			 *   it has to pre-empt RL_LIST_INTERRUPT and RL_HR because `-` and `---`
			 *   there are h2 in Obsidian, not a list item or a rule.
			 * - Tier 2 AFTER the interrupt test and only when it is false: any other
			 *   underline-shaped line (under two or more content lines, ` ===`,
			 *   `=== `, a count the walker may have wrong in a container view) ends
			 *   the paragraph as `unknown`, which records nothing, so the following
			 *   lines keep the old answer. Placing the broad test BEFORE the interrupt
			 *   test was measured wrong: it pre-empts walkLeadList, so `> PROSEP` /
			 *   `>    -` / `>\t<!--` leaked (20 cells over quote, nested quote,
			 *   list, ordered and callout), because the renderer opens a list item
			 *   there whose content `<!--` opens an HTML block.
			 */
			/*
			 * Tier 1 also needs `paraTrusted` (implement-phase fuzz). In
			 * `>>|` / `Z` / `>>-` / `>>\t<!--` / `ZLFZ` the `|` line is paragraph
			 * text for the renderer, so `-` sits under TWO content lines and is a
			 * list item whose dedent puts `<!--` at column 0; the walker had counted
			 * one line, read `-` as an h2 and claimed the next line as indented
			 * code, which spoke ZLFZ. An untrusted count falls through to the
			 * interrupt and tier-2 tests below, both fail-closed.
			 */
			if (SETEXT_UNDERLINE_EXACT.test(view) && i === paraStart + 1 && paraTrusted) {
				state = "fresh";
				i++;
				continue;
			}
			const interrupts =
				RL_HR.test(view) ||
				RL_LIST_INTERRUPT.test(view) ||
				RL_HEADING.test(view) ||
				/^(`{3,}|~{3,}|%%|\$\$|>|<)/.test(view.slice(lead.length));
			if (!interrupts && RL_SETEXT.test(view)) {
				state = "unknown";
				i++;
				continue;
			}
			if (!interrupts) {
				record(i, true);
				i++;
				continue;
			}
			// An interrupter starts a fresh block on this very line.
		}
		if (blank) {
			state = "fresh";
			i++;
			continue;
		}
		record(i, false);
		if (startsIndentedCode(view)) {
			const unsure = ambiguousAt === i - 1;
			if (unsure) out.unsureFresh[frame[i]!.id] = true;
			let j = i + 1;
			while (j < frame.length && (frame[j]!.view.trim() === "" || startsIndentedCode(frame[j]!.view))) {
				record(j, false);
				if (unsure) out.unsureFresh[frame[j]!.id] = true;
				j++;
			}
			state = "fresh";
			i = j;
			continue;
		}
		const lead = /^[ \t]*/.exec(view)![0];
		const rest = view.slice(lead.length);
		/*
		 * `setextHeading` precedes `html` in `blockMethods`, so a line-start HTML
		 * construct with an underline-shaped line under it may be heading content
		 * (NRL-120) rather than a block to skip to its closer. Skipping it as a
		 * comment made `><!--` / `>-` / `>1.` / `-->` / `>\t<!--` / `ZPJZ` read as
		 * a closed comment followed by a fresh indented-code line, where the
		 * renderer has an h2, then a list item whose dedent opens a comment at
		 * column 0: ZPJZ was spoken (implement-phase fuzz). Such a line now puts
		 * the frame into `unknown` instead, which records nothing.
		 */
		if (rest.startsWith("<") && i + 1 < frame.length && RL_SETEXT.test(frame[i + 1]!.view)) {
			state = "unknown";
			i++;
			continue;
		}
		const span = spanningEnd(frame, i, rest);
		if (span !== -1) {
			state = rest.startsWith("<!--") || /^(`{3,}|~{3,})/.test(rest) ? "fresh" : "unknown";
			i = span;
			continue;
		}
		// The rest follows `blockMethods`' own order: blockquote, atxHeading,
		// thematicBreak, list, setextHeading, html, ..., paragraph.
		if (RL_QUOTE.test(view)) {
			i = walkLeadQuote(frame, i, depth, out);
			// A line that ended the quote by starting indented code is a FRESH block
			// here, not a maybe (NRL-166 fix round 1): `indentedCode` is in module
			// 6234's `interruptBlockquote`, and `startsIndentedCode` is module 134's
			// literal test on the same view `mayInterruptQuote` read. The other
			// interrupters stay `unknown`, since that test over-approximates them.
			state = i < frame.length && (frame[i]!.view.trim() === "" || (out.refine && startsIndentedCode(frame[i]!.view))) ? "fresh" : "unknown";
			continue;
		}
		if (RL_HEADING.test(view) || RL_HR.test(view)) {
			state = "fresh";
			i++;
			continue;
		}
		if (RL_LIST_ANY.test(view)) {
			const r = walkLeadList(frame, i, depth, out);
			i = r.end;
			state = r.state;
			continue;
		}
		if (rest.startsWith("<")) {
			state = "unknown";
			i++;
			continue;
		}
		// A setext-shaped line, a table-shaped line, a definition and a block id
		// are all classified FRESH rather than paragraph: the safe default.
		if (RL_SETEXT.test(view) || rest.includes("|") || /^\[[^\]]*\]:/.test(rest) || /^\^[\w-]+\s*$/.test(rest)) {
			// Unless an underline-shaped line follows: then this line may be setext
			// heading content, and the next line its underline rather than the list
			// item or rule the walker would read it as (`>>=` / `>>-` /
			// `>>  \t<!--` is an h2 and then a comment for the renderer; the walker
			// read a list item and claimed the `<!--` line). Fail closed.
			if (i + 1 < frame.length && RL_SETEXT.test(frame[i + 1]!.view)) {
				state = "unknown";
				i++;
				continue;
			}
			state = "fresh";
			ambiguousAt = i;
			i++;
			continue;
		}
		state = "para";
		paraStart = i;
		paraTrusted = ambiguousAt !== i - 1;
		out.para[frame[i]!.id] = paraTrusted;
		i++;
	}
}

/**
 * Module 6234's collection of one blockquote, then its content as a frame of
 * its own. Returns the frame index of the first line not in the quote.
 */
function walkLeadQuote(frame: readonly LeadFrameLine[], start: number, depth: number, out: RendererLeads): number {
	const inner: LeadFrameLine[] = [];
	let title: LeadFrameLine | undefined;
	let j = start;
	for (; j < frame.length; j++) {
		const { view, id } = frame[j]!;
		const m = /^[ \t]*>/.exec(view);
		if (!m) {
			if (view.trim() === "" || mayInterruptQuote(frame, j)) break;
			// A lazy line joins the quote WHOLE, lead and all (`d = f === D ? p : ...`).
			inner.push({ view, id });
			continue;
		}
		// One SPACE after `>`, never a tab: `t.charAt(D)===a&&D++` with a = " ".
		let content = view.slice(m[0].length);
		if (content.startsWith(" ")) content = content.slice(1);
		if (j === start) {
			// A callout title is tokenized on its own, before the rest.
			const c = /^\[!([^\]]+)\]([+-]?)(?:\s|$)/.exec(content);
			if (c) {
				title = { view: content.slice(c[0].length), id };
				continue;
			}
		}
		inner.push({ view: content, id });
	}
	if (depth < RL_MAX_DEPTH) {
		if (title !== undefined && title.view !== "") out.pending.push({ frame: [title], depth: depth + 1 });
		out.pending.push({ frame: inner, depth: depth + 1 });
	}
	return j;
}

/**
 * Module 745's loop, ported for its item boundaries only, then each item as a
 * frame of its own. Returns where the list ends and the state that line is in.
 */
function walkLeadList(frame: readonly LeadFrameLine[], start: number, depth: number, out: RendererLeads): { end: number; state: LeadState } {
	interface Item {
		indent: number;
		lines: number[];
	}
	const items: Item[] = [];
	let item: Item | undefined;
	let pending: number[] = [];
	let bullet = "";
	let blankHere = false;
	let last = start;
	let end = -1;
	let state: LeadState = "fresh";
	for (let j = start; j < frame.length; j++) {
		const x = frame[j]!.view;
		let u = 0;
		let r = 0;
		for (; u < x.length; u++) {
			const ch = x[u];
			if (ch === "\t") r += 4 - (r % 4);
			else if (ch === " ") r += 1;
			else break;
		}
		let v = item !== undefined && r >= item.indent;
		let marker: string | null = null;
		if (!v) {
			const ch = x[u];
			if (ch === "*" || ch === "+" || ch === "-") {
				marker = ch;
				u++;
				r++;
			} else {
				let digits = "";
				while (u < x.length && x[u]! >= "0" && x[u]! <= "9") digits += x[u++];
				const d = x[u];
				u++;
				if (digits !== "" && (d === "." || d === ")")) {
					marker = d;
					r += digits.length + 1;
				}
			}
			if (marker !== null) {
				const next = x[u];
				if (next === "\t") {
					r += 4 - (r % 4);
					u++;
				} else if (next === " ") {
					const b = u + 4;
					while (u < b && x[u] === " ") {
						u++;
						r++;
					}
					if (u === b && x[u] === " ") {
						u -= 3;
						r -= 3;
					}
				} else if (next !== undefined) {
					marker = null;
				}
			}
		}
		let isItem = false;
		if (marker !== null) {
			if (bullet !== "" && bullet !== marker) {
				end = j;
				break;
			}
			bullet = marker;
			isItem = true;
		} else {
			// r is deliberately NOT reset: module 745 keeps the increments a
			// failed marker made, and so does this port.
			if (item !== undefined) v = r >= item.indent || r > 4;
			u = 0;
		}
		if ((marker === "*" || marker === "-") && RL_HR.test(x)) {
			end = j;
			break;
		}
		const prevBlank = blankHere;
		blankHere = !isItem && (u === 0 ? x : x.slice(u)).trim() === "";
		if (v && item !== undefined) {
			item.lines.push(...pending, j);
			pending = [];
			last = j;
		} else if (isItem) {
			item = { indent: r, lines: [j] };
			items.push(item);
			pending = [];
			last = j;
		} else if (blankHere) {
			pending.push(j);
		} else {
			if (prevBlank) {
				end = j;
				break;
			}
			if (mayInterruptList(x)) {
				end = j;
				// A line that is exactly the comment tokenizer's interrupting shape
				// (spaces, `%%`, no other `%` on the line) CERTAINLY ends the list:
				// `comment` is in module 745's interrupt set with no option gate, and
				// this branch is reached only where module 745 consults that set. So
				// the last item is known whole and is walked (NRL-166 fix round 2,
				// under the round-1 refinement gate): `- >> P <!--` / `> [!tip] b` /
				// `> \t--> c` / `%%` left the item unwalked, and the code line's `-->`
				// closed a comment the renderer shows as text. The other shapes the
				// regex takes stay a maybe.
				state = out.refine && /^ *%%[^%]*$/.test(x) ? "fresh" : "unknown";
				break;
			}
			item!.lines.push(...pending, j);
			pending = [];
			last = j;
		}
	}
	if (end === -1) end = last + 1;
	/*
	 * When the list ended at a line that MAY interrupt it (the over-approximation
	 * above), that line and the ones after it may in fact belong to the last
	 * item, and module 5540's dedent `p` is the least indent over the WHOLE item,
	 * so a line it really contains can lower `p`. Lowering `p` is not monotone in
	 * the safe direction: `  -` / `   \t<!--` / `  $$` has `p` = 2 for the
	 * renderer, which leaves ` \t<!--` (an HTML block opener); the walker, cut
	 * at `$$`, used 3 and left a bare tab, claimed indented code and spoke the
	 * comment body (implement-phase fuzz). So the last item is not walked then,
	 * and its lines keep the old answer.
	 *
	 * Except its FIRST line (NRL-166 fix round 1). `p` reaches only the lines
	 * after the marker line, whose content is the marker's own remainder, and a
	 * frame's first line is a fresh block whose record nothing below it changes.
	 * Skipping it left `- > \t<!-- QXQ` / `> QBQ -->` / `%%` with no record, so
	 * the code mask never saw that the `<!--` is indented code in the item's
	 * quote, and the comment hid `QBQ -->`, which the renderer displays.
	 */
	const walkable = state === "unknown" ? items.slice(0, -1) : items;
	if (depth < RL_MAX_DEPTH) for (const it of walkable) walkLeadItem(frame, it.lines, depth, out);
	if (out.refine && depth < RL_MAX_DEPTH && state === "unknown" && items.length > 0) walkLeadItem(frame, [items[items.length - 1]!.lines[0]!], depth, out);
	return { end, state };
}

/** Module 745's `M` plus module 5540, then the item's content as a frame. */
function walkLeadItem(frame: readonly LeadFrameLine[], lineIdx: readonly number[], depth: number, out: RendererLeads): void {
	const first = frame[lineIdx[0]!]!;
	const m = RL_ITEM.exec(first.view);
	if (!m) return;
	let marker = m[2]!;
	// `Number(n)<10&&a.length%2==1&&(n=p+n)`: a short odd-width ordered marker
	// gets one extra column of padding, so `1. ` pads to four, not three.
	if (Number(marker) < 10 && (m[1]! + m[2]! + m[3]!).length % 2 === 1) marker = " " + marker;
	const pad = m[1]! + " ".repeat(marker.length) + m[3]!;
	const replaced = [pad + m[4]!, ...lineIdx.slice(1).map((k) => frame[k]!.view)];
	let p = leadColumns(pad);
	for (const line of replaced) {
		if (line.trim() === "") continue;
		const c = leadColumns(line);
		if (c > 0 && c < p) p = c;
	}
	let rest = m[4]!;
	const task = /^\[(.)][ \t]/.exec(rest);
	if (task) rest = rest.slice(task[0].length);
	const inner: LeadFrameLine[] = [{ view: rest, id: first.id }];
	for (let n = 1; n < lineIdx.length; n++) {
		inner.push({ view: removeLeadColumns(replaced[n]!, p), id: frame[lineIdx[n]!]!.id });
	}
	out.pending.push({ frame: inner, depth: depth + 1 });
}

/** Run the model over `lines[from..]`. Lines before `from` (frontmatter) get no record. */
function rendererLeads(lines: readonly string[], from: number, refine: boolean): RendererLeads {
	const out: RendererLeads = {
		lead: new Array<string | null>(lines.length).fill(null),
		cont: new Array<boolean>(lines.length).fill(false),
		nested: new Array<boolean>(lines.length).fill(false),
		closerInPara: new Array<boolean>(lines.length).fill(false),
		unsureFresh: new Array<boolean>(lines.length).fill(false),
		para: new Array<boolean>(lines.length).fill(false),
		refine,
		pending: [],
	};
	const frame: LeadFrameLine[] = [];
	// One trailing `\r` is dropped from each view (NRL-115 ship critique, r3 F1).
	// `extractChunks` splits on `\n` only, so a CRLF note hands every line a
	// trailing `\r`, and the walker's thematic-break, heading and blank tests do
	// not allow for one: `___\r` read as paragraph text, the ` \t<!--` after it
	// as a lazy continuation, and a comment the renderer hides was spoken. The
	// renderer takes `\r\n` as a line ending. Only the walker's VIEW changes; a
	// lead is a prefix, so no offset it reports moves.
	for (let k = from; k < lines.length; k++) {
		const raw = lines[k]!;
		frame.push({ view: raw.endsWith("\r") ? raw.slice(0, -1) : raw, id: k });
	}
	walkLeadFrame(frame, 0, out);
	for (let f = out.pending.pop(); f !== undefined; f = out.pending.pop()) walkLeadFrame(f.frame, f.depth, out);
	return out;
}

/**
 * `opensHtmlBlock`'s fourth argument, per raw line: true when the renderer
 * never offers this line's content to module 8776. A continuation needs a tab
 * anywhere in its lead or four columns (module 8607); a fresh block needs to
 * START with a tab or four spaces (module 134), and only inside a container,
 * because a top-level fresh block is the INDENTED_CODE branch's and NRL-113's.
 * The two thresholds differ on purpose: ` \t` is four columns, lazy after a
 * paragraph, and NOT indented code at a block start, where it opens a comment.
 */
function leadIndentedForHtml(r: RendererLeads): boolean[] {
	return r.lead.map((lead, k) => {
		if (lead === null) return false;
		if (r.cont[k]) return (lead.includes("\t") || leadColumns(lead) >= 4) && !r.closerInPara[k];
		return r.nested[k]! && startsIndentedCode(lead);
	});
}

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
 * Module 6058's `indentation()`: how many COLUMNS of lead a line has, and which
 * character covers each of those columns.
 *
 * A tab advances to the next multiple of four - `s += 4` then
 * `s = Math.floor(s / 4) * 4` - so a tab at column 2 reaches column 4 and not 6.
 * `stops[col]` is the index of the character that covers column `col`, filled
 * contiguously for every column from 1 to `indent`, which is why module 5540's
 * "largest stop not past the budget" is simply `Math.min(budget, indent)`.
 *
 * Columns are 1-based here because the module they mirror numbers them that way
 * and `stops` is indexed by them; `stops[0]` is deliberately absent, and that
 * absence is load-bearing in `listDedentCut`.
 */
function leadStops(line: string): { indent: number; stops: number[] } {
	const stops: number[] = [];
	let col = 0;
	for (let i = 0; i < line.length; i++) {
		const c = line.charCodeAt(i);
		if (c !== 32 && c !== 9) break;
		let next = col + (c === 9 ? 4 : 1);
		if (c === 9) next = Math.floor(next / 4) * 4;
		while (col < next) stops[++col] = i;
	}
	return { indent: col, stops };
}

/**
 * Module 5540's per-line slice: how many CHARACTERS a list item's dedent removes
 * from the front of one of its lines, given a column budget.
 *
 * This is the whole reason NRL-117 could not be a column subtraction, and NRL-93
 * said as much before either was measured. The budget is in columns but the cut
 * is in characters, so a tab is removed WHOLE or not at all: with a budget of two
 * columns, `\t\tx` loses its first tab entirely and keeps four columns of lead,
 * not six. Module 5540 reaches that by `while (s && !(s in c)) s--` then
 * `slice(c[s] + 1)`, and when `s` falls to 0 it slices `c[0] + 1`, which is
 * `undefined + 1`, which is `NaN`, which `String.slice` reads as 0 - so a line
 * with no lead at all keeps every character. That is the `s <= 0` return here,
 * and it is what makes a lazy continuation at column 0 cost nothing.
 */
function listDedentCut(line: string, budgetCols: number): number {
	const { indent, stops } = leadStops(line);
	const s = Math.min(budgetCols, indent);
	return s <= 0 ? 0 : stops[s]! + 1;
}

/**
 * Module 745's `M`: the content indent of a list item, in columns, as the
 * budget it hands module 5540.
 *
 * It is NOT the marker's width plus one. `M` rewrites the item's first line as
 * `lead + " ".repeat(marker.length) + gap`, keeping the lead and the gap
 * VERBATIM - so a tab in either is still a tab, and module 6058 snaps it - and
 * pads a one-digit ordered marker with a leading space when the consumed prefix
 * has odd length (`Number(n) < 10 && a.length % 2 === 1`), which is why `1. x`
 * budgets five columns where `- x` budgets two.
 *
 * That `Number` call is handed the WHOLE marker, delimiter included, because
 * module 745's own `n` is group 2 of its `b` regex - the same group `ITEM_HEAD`
 * mirrors. So the pad is narrower than "a one-digit ordered marker" sounds:
 * `Number("-")` is NaN and `Number("1)")` is NaN too, while `Number("1.")` is 1.
 * Only the `.` form ever pads. **That asymmetry is the renderer's and must not be
 * "fixed"** by coercing the digits alone: doing so would pad `1)` where module 745
 * does not, over-dedent its lines by a column, and so keep hiding text the
 * renderer displays - a prose loss rather than a disclosure, but a divergence
 * either way, and the reason this helper takes the marker with its delimiter on.
 * Measured on the shipped form: `1)` flips at a seven-space lead where `1.` flips
 * at eight, and over 225 marker x lead cells and 760 nested cells graded against
 * real rendered HTML neither flip moves a cell in either direction.
 *
 * Takes the MATCH rather than the line, because the caller walks one line head by
 * head: `- - x` is TWO items and so two budgets, module 745 reaching the inner one
 * by tokenizing the outer item's first-line content, which `M` restores
 * undedented (`c[0] = s`). Measured before this took a match: pushing one level
 * for `- -` under-dedents every line below it and the predicate then DECLINES an
 * opener the renderer honours - 2,342 cells of newly SPOKEN hidden text in a
 * 219,300-cell exhaustive sweep, which is the one direction this change must not
 * move. Bare markers are the other half of that class and are why `ITEM_HEAD`'s
 * gap alternation ends in `$`.
 */
function itemHeadCols(m: RegExpExecArray): number {
	const lead = m[1]!;
	const gap = m[3]!;
	let marker = m[2]!;
	if (Number(marker) < 10 && (lead + marker + gap).length % 2 === 1) marker = " " + marker;
	return leadStops(lead + " ".repeat(marker.length) + gap).indent;
}

/**
 * Does this line's lead, AFTER its enclosing list items have taken their dedent,
 * still reach the block start that a `%%` opener needs?
 *
 * The two halves are the renderer's, and they are the same two
 * `opensObsidianBlock` applies to an undedented line: spaces only, because the
 * `%%` tokenizer's skip loop compares to charCode 32 and module 8607's paragraph
 * tokenizer breaks its own scan on a tab and declares the line a lazy
 * continuation; and at most three of them, because four columns is indented code
 * in a fresh block and is likewise absorbed as lazy prose after a paragraph line.
 */
function leadReachesBlockStart(line: string): boolean {
	let k = 0;
	while (k < line.length) {
		const c = line.charCodeAt(k);
		if (c === 32) {
			k++;
			continue;
		}
		if (c === 9) return false;
		break;
	}
	return k <= 3;
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
	// Whether line k may hold an inline construct that hides text, a code span
	// whose backticks may pair across a line break included (`backtickCrossRisk`,
	// NRL-166 fix round 3). A yes keeps 44a037a's answer wherever it is asked.
	const tickRisk = backtickCrossRisk(lines);
	const lineMayHold = (k: number): boolean => tickRisk[k]! || inlineConstructMayHold(lines[k]!);
	// What the reading view displays nothing of, from the transcription of its
	// block parser (NRL-166 fix round 2; see `rendererHiddenText`), or null where
	// that transcription has no answer. Every spoken character whose source
	// offset falls in one of its ranges is dropped before segmentation (`speak`), and
	// its `%%` block starts withhold our own block opener where the renderer has
	// none (`percentOpensAt`).
	const rendererHidden = rendererHiddenText(source, lines.length);
	const hiddenSpans = mergeRanges(rendererHidden?.ranges ?? fallbackHtmlHidden(source));
	const speak = (text: string, index: number[], start: number, blockType: BlockType): SpeechChunk[] => {
		const kept = hiddenSpans.length === 0 ? { text, index } : dropHiddenText(text, index, hiddenSpans);
		return splitSentences(kept.text, kept.index, start, segmentCtx, blockType);
	};
	// Whether the renderer opens a `%%` block on each line, where that answer may
	// overrule ours: our block opener on a line stands only where the renderer
	// opens one there too (NRL-166 fix round 2). Its comment tokenizer is the only
	// thing that makes a `%%` hide past its line (the inline one, `/^%%(.*?)%%/`,
	// never crosses a line break, ADR 0006), so a `%%` it does not open is text:
	// `> P` / `> [!note] %%` / `> b` is one quote paragraph whose second line is
	// lazy, so `[!note]` is no callout title and its `%%` no block, and the
	// renderer displays b, which our callout prefix used to hide.
	//
	// Withholding our block shows everything it would have hidden, up to the
	// next `%%` in the note, so it is done only where nothing in that reach is
	// an HTML block or follows one that leaves a browser comment open: there our
	// over-wide block was covering text the browser hides, which we do not model
	// line for line (`<div>` / `- > x <!-- QS` / `> \t%% QK` hides QK, and
	// `> - <!-- a` / `b <!-- c --> d <!-- e` / `\t%%` / `- f` hides f). Elsewhere,
	// and wherever the transcription has no answer, `undefined` keeps ours.
	//
	// Nor where an inline construct (`inlineConstructMayHold`) sits anywhere from
	// the opener's paragraph start, back to the last blank line, through that
	// reach, or a footnote definition does: a link title, a tag's attribute value
	// or a definition the renderer drops may be what hides the text there
	// (`> P <b title="a` / `> [!note] %% b` / `> c">d</b>` displays `P d`;
	// /critique on 383f85c, F1 and F2).
	const percentOpensAt: (boolean | undefined)[] = new Array<boolean | undefined>(lines.length).fill(undefined);
	if (rendererHidden !== null) {
		const constructSinceBlank: boolean[] = new Array<boolean>(lines.length).fill(false);
		for (let k = 0, seen = false; k < lines.length; k++) {
			if (lines[k]!.trim() === "") seen = false;
			if (lineMayHold(k)) seen = true;
			constructSinceBlank[k] = seen;
		}
		// Withholding our opener on one line also changes how every later `%%`
		// pairs: the next one, which closed our block, is now asked whether it
		// OPENS one. So a line's answer is the renderer's only when the next
		// `%%` line's is too, a chain to the note's end or to a line that keeps
		// ours, whose chain then keeps ours as well (NRL-166 fix round 3; Verify
		// 3: `> > P` / `> [!tip]- %% QAQ` / `> [!tip]- %% QBQ` / `    QEQ [x](u "QFQ`
		// took the renderer's "no block" on the first `%%` line and our opener on
		// the second, beside the link, which then hid QBQ through QFQ that the
		// renderer and 44a037a both display).
		// A withheld opener also exposes what lies in its reach to our own
		// comment model, so a `<!--` there that its line does not close, which our
		// term 2 may carry across lines the renderer's paragraph does not reach, is
		// a risk too; and the chain holds only through a next `%%` line with one
		// `%%`, since two or more there re-pair by our inline rule, which does not
		// know a line the renderer makes code (fix round 3's census: `> > \`\`\`\``
		// / `> > [!x]- %% QPQ` / ... / `    <!-- QQZQ --> QRQ <!-- QRZQ` /
		// `[!x]- %% QSQ` / `> > --> QSZQ` lost QSQ, and `>\`\`\`\`` / `>> [!x]- %%
		// QQQ` / `QQZQ - -->` / `> \tQRQ %% QRZQ %%` lost QRZQ, both shown by the
		// renderer and 44a037a).
		const openCommentOnLine = (line: string): boolean => {
			const at = line.lastIndexOf("<!--");
			return at !== -1 && line.indexOf("-->", at + 4) === -1;
		};
		const onePct = (line: string): boolean => {
			const at = line.indexOf("%%");
			return at !== -1 && line.indexOf("%%", at + 2) === -1;
		};
		let nextRisk = lines.length;
		let nextPct = -1;
		for (let k = lines.length - 1; k >= 0; k--) {
			if (rendererHidden.browserRiskLines[k]! || rendererHidden.footnoteLines[k]! || lineMayHold(k) || openCommentOnLine(lines[k]!)) nextRisk = k;
			const reach = nextPct === -1 ? lines.length - 1 : nextPct;
			const chained = nextPct === -1 || (percentOpensAt[nextPct] !== undefined && onePct(lines[nextPct]!));
			if (nextRisk > reach && !constructSinceBlank[k]! && chained) percentOpensAt[k] = rendererHidden.percentStarts.has(k);
			if (lines[k]!.includes("%%")) nextPct = k;
		}
	}
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
	//
	// NRL-114: a QUOTED line is asked on its quote-peeled body, through
	// `term2QuotedStop`; an unquoted line takes exactly the old path.
	//
	// `term2StopRaw` is the pre-NRL-114 pass, every line read raw, kept beside the
	// quote-aware one for the lines where the walker cannot say what the renderer
	// does with a quoted line (`unsureFresh`, below); those keep the old answer.
	const term2Stop: boolean[] = new Array<boolean>(lines.length).fill(false);
	const term2StopRaw: boolean[] = new Array<boolean>(lines.length).fill(false);
	// A `[!type]` line that STARTS a quote, and so is a real callout title for
	// the renderer rather than paragraph text (read for the container-fence drop
	// in the per-line loop; NRL-114 fix round 1).
	const calloutTitleAt: boolean[] = new Array<boolean>(lines.length).fill(false);
	{
		let paraLinesAbove = 0;
		let rawLinesAbove = 0;
		let prevDepth = 0;
		for (let k = 0; k < lines.length; k++) {
			const line = lines[k]!;
			// Both predicates are asked with the SAME count, before it is updated.
			// `endsTerm2Scan` is called rather than its one extra term inlined, so
			// the scan's stop set keeps exactly one definition.
			term2StopRaw[k] = endsTerm2Scan(line, rawLinesAbove);
			rawLinesAbove = endsTerm2Block(line, rawLinesAbove) ? 0 : rawLinesAbove + 1;
			const { depth, body } = term2QuoteView(line);
			// `prevDepth` is the previous line's CONTAINER depth, which counts a quote
			// behind a list marker (`- > x`, `1. > x`) through `containerPrefix`, the
			// one definition of the prefix. `term2QuoteView` cannot see that `>`, so
			// with its depth alone `- > Plain <!--` / `> [!tip] x` read as a quote
			// STARTING on the second line, a callout title, and a stop, where the
			// renderer continues the list item's quote paragraph lazily and its inline
			// comment hides the title (NRL-114 fix round 1). The larger of the two
			// counts is taken: a deeper previous line can only withhold a quote start,
			// which withholds a stop, the fail-closed direction.
			const quoteStart = depth > prevDepth && (k === 0 || term2Stop[k - 1]!);
			prevDepth = Math.max(depth, containerPrefix(line).quotes);
			if (depth === 0) {
				term2Stop[k] = endsTerm2Scan(line, paraLinesAbove);
				paraLinesAbove = endsTerm2Block(line, paraLinesAbove) ? 0 : paraLinesAbove + 1;
				continue;
			}
			calloutTitleAt[k] = quoteStart && TERM2_CALLOUT_TITLE.test(body);
			const r = term2QuotedStop(body, quoteStart, paraLinesAbove);
			term2Stop[k] = r.stop;
			paraLinesAbove = r.next;
		}
	}
	const closerAheadOf = (stops: readonly boolean[]): boolean[] => {
		const out: boolean[] = new Array<boolean>(lines.length).fill(false);
		let ahead = false;
		for (let k = lines.length - 1; k >= 0; k--) {
			out[k] = ahead;
			if (stops[k]!) {
				ahead = false;
				continue;
			}
			if (lines[k]!.includes("-->")) ahead = true;
		}
		return out;
	};
	const htmlCloserAhead = closerAheadOf(term2Stop);
	const htmlCloserAheadRaw = closerAheadOf(term2StopRaw);
	// For each line, whether the lines AFTER it, up to the first `-->` inside the
	// same term-2 bound, keep an inline comment's body valid: none of them holds
	// `--`, and the closing line does not put `-` right before its `-->`
	// (NRL-166 fix round 1; module 4839's rule, see `inlineCommentFacts`).
	// Raw lines are read, prefix and all. A container prefix holds no `-`, and a
	// list marker starts an item, which ends the paragraph and is a stop, so a
	// `--` here is a `--` in the renderer's paragraph text whenever the
	// renderer's closer is this one. When the bound runs past the renderer's
	// paragraph, the renderer has no closer in it and displays the text, so a
	// "not valid" here cannot hide what it shows nor show what it hides. A line
	// break joins lines, so dashes either side of one never pair.
	// The same bound again, for whether the would-be body holds an inline construct
	// (`inlineConstructMayHold`) from the next line up to the `-->`: then the body
	// rule is withheld and the comment keeps hiding, since the `-->` may sit in an
	// attribute or a title the renderer displays as nothing
	// (`P <!-- a -- <b title="x` / `y -->">z</b>` shows only `P <!-- a -- z`).
	// A `%%` on which our block opener keeps its own answer (`percentOpensAt` is
	// undefined) counts here too (NRL-166 fix round 3). A refinement that ends
	// or withholds a comment 44a037a opened exposes the `%%` behind it to that
	// opener, which may then hide what both the renderer and 44a037a display
	// (Verify 3: `1. > QGQ \`\`\` <!---> ` / `  > [!note] %%` / `\t--> QJZQ` /
	// `> > </pre>` lost QJZQ: the `<!--->` is rightly literal, and the `%%`, no
	// block for the renderer, opened ours, kept beside the HTML block).
	const pctUnsure = (k: number, line: string): boolean => percentOpensAt[k] === undefined && line.includes("%%");
	const constructInBodyAheadOf = (stops: readonly boolean[]): boolean[] => {
		const out: boolean[] = new Array<boolean>(lines.length).fill(false);
		let seen = false;
		for (let k = lines.length - 1; k >= 0; k--) {
			out[k] = seen;
			if (stops[k]!) {
				seen = false;
				continue;
			}
			const line = lines[k]!;
			const close = line.indexOf("-->");
			seen = close !== -1 ? tickRisk[k]! || inlineConstructMayHold(line.slice(0, close)) || pctUnsure(k, line.slice(0, close)) : seen || lineMayHold(k) || pctUnsure(k, line);
		}
		return out;
	};
	const commentBodyOkAheadOf = (stops: readonly boolean[]): boolean[] => {
		const out: boolean[] = new Array<boolean>(lines.length).fill(true);
		let ok = true;
		for (let k = lines.length - 1; k >= 0; k--) {
			out[k] = ok;
			if (stops[k]!) {
				ok = true;
				continue;
			}
			const line = lines[k]!;
			const close = line.indexOf("-->");
			if (close !== -1) {
				const before = line.slice(0, close);
				ok = !before.includes("--") && !before.endsWith("-");
			} else if (line.includes("--")) {
				ok = false;
			}
		}
		return out;
	};
	// `listDedented[n]` is "line n is the content of a list item AND the dedent
	// Obsidian applies to that item leaves its lead at the block start a `%%`
	// opener needs" (NRL-93 for the first half, NRL-117 for the second). It is the
	// third argument of opensObsidianBlock and the reason the `%%` line-start rule
	// cannot be a character class: see that predicate for the three modules that
	// do the dedenting.
	//
	// `listItemContent[n]` is the first half alone, which is all NRL-120's setext
	// pass wants, and it is the pre-NRL-117 array unchanged.
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
	//
	// NRL-117 narrowed the ANSWER without touching the question or the predicate.
	// `listItemContent[k]` below is the array this pass used to produce, bit for
	// bit; `listDedented[k]` is that value CONJOINED with "and the dedent really
	// does take this line's lead away", so the whole change is one extra term on
	// a boolean and the predicate's own structural guarantee is untouched. The
	// subset direction is therefore true by construction rather than by probe:
	// this pass can only ever answer `true` where the pre-NRL-117 pass did.
	//
	// Why the extra term needs a STACK and could not be an indent SUBTRACTION,
	// which is what NRL-93 named as the faithful rule and declined to
	// approximate. Measured, and the counter-example is `- outer` / `  - inner` /
	// `\t\t%%`: module 745 NESTS, so the item's dedent runs once per enclosing
	// level, and module 5540's budget is in COLUMNS while its cut is in
	// CHARACTERS, so a tab is removed whole or not at all. Two levels of a
	// two-column budget therefore take both tabs and leave column 0 - the block
	// really does open and the renderer really does hide the rest of the note -
	// where `8 - 4 = 4` says four columns survive. An arm built on that single
	// subtraction DISCLOSED 7,168 cells of a 3,021,824-cell census, in that one
	// shape. See `leadStops`, `listDedentCut` and `itemHeadCols`.
	//
	// Three things about the walk are load-bearing.
	//
	// NRL-162 CORRECTION (2026-10-03): this comment used to end with "the
	// budget at each level is the item's content indent, which is module
	// 5540's `maximum` rather than the `p` it actually uses ... Using the cap
	// over-estimates the dedent ... So the one approximation in here fails
	// toward hiding ... Measured cost, 22 cells of a 667-cell renderer-keyed
	// sweep, every one of them identical on both sides of this change." That
	// claim was FALSE: an over-dedent can also create a FALSE block-start
	// opener that pairs with a REAL later closer, producing simultaneous
	// disclosure (text after the real closer wrongly spoken) and prose loss
	// (text between the false opener and the real closer wrongly hidden). See
	// NRL-162's own repro - `- item ZA0Z` / ` x ZM1Z` / `      %% ZH1Z` /
	// `ZH2Z` / `     %% ZH3Z` / `ZH4Z` / `%%` / `ZT1Z` - where the max budget
	// (2, from `- `) over-dedents past the item's real minimum (1, from
	// ` x ZM1Z`), turning `     %% ZH3Z`'s residual from 4 columns (declines,
	// matching Obsidian) into 3 (wrongly accepts). The mechanism that replaces
	// the max with the item's real `p` - a two-phase record-then-refold pass,
	// the refusal-only proof, and the Fix-round correction that keeps a
	// `%%`-opener-shaped line itself from shrinking the budget - is on the
	// pass's own declarations a few lines down (`levelP`, `fallbackLevelIds`,
	// `chainIds`), not repeated here. See docs/adr/0006's NRL-162 amendment
	// for the re-measured census and the nested-tab counter-example this
	// proof was checked against (`guard-nrl117-nested-double-tab-correctly-hides`).
	//
	// A line SHALLOWER than the current level's budget stops the walk only when it
	// is itself a marker, because that is a new item at this level and module 745
	// restarts `L` there. A shallower NON-marker line is a lazy continuation and
	// module 5540 still slices it - to `stops[indent] + 1`, i.e. its whole lead -
	// so descending is right and the cut is naturally zero at column 0.
	//
	// An item head this file cannot parse pushes `MAX_SAFE_INTEGER` rather than
	// nothing. `LIST_BULLET`'s `\s*` admits a lead `ITEM_HEAD`'s `[ \t]*` does
	// not (a no-break space, a vertical tab), and a level left off the stack would
	// UNDER-dedent every line below it, which is the one direction that can speak
	// hidden text. A whole-lead budget reproduces the pre-NRL-117 answer instead.
	//
	// A blockquote nested inside a list item is not closed by the walk itself:
	// `BLOCKQUOTE` is peeled from `raw` BEFORE this walk runs, where the renderer
	// dedents the item first and peels the quote second, so for `- item` /
	// `  > \t%%` the tab is gone before any budget is applied and no indent
	// model can see it. NRL-114's fix round 1 closes it beside the walk instead,
	// through `dedentQuoteGate` (a line quoted deeper than its item's marker line
	// is not dedented by the item), conjoined with Phase 2's answer below.
	const listItemContent: boolean[] = new Array<boolean>(lines.length).fill(false);
	const listDedented: boolean[] = new Array<boolean>(lines.length).fill(false);
	// Phase 1: the structural walk, UNCHANGED - which lines belong to which
	// level, when a level pushes or pops, is still decided by the max budget
	// (`itemHeadCols`), mirroring `walkLeadList`'s own membership rule. What
	// is new is a side record, per pushed level (keyed by a STABLE id so a
	// later push reusing the same stack depth is never confused with an
	// earlier, already-popped one): `levelP`, seeded at the max and shrunk by
	// `walkLeadItem`'s own rule (`c > 0 && c < p`) from the residual each
	// content line sees BEFORE that level's own cut, and `chainIds[k]`, the
	// ordered list of level ids line `k` was cut through, so Phase 2 can
	// replay the identical sequence of cuts once every level's `p` is final.
	//
	// A `%%`-opener-shaped line is EXCLUDED from candidacy for the shrink,
	// deliberately, and this is the one term the prior round's attempt
	// lacked. CommonMark's own module 5540 has no notion of `%%` at all, but
	// empirically (`node ground_truth_nrl162b.cjs` against the installed
	// 1.13.7 bundle; see docs/adr/0006's NRL-162 amendment) letting a `%%`
	// line's OWN indent shrink its enclosing level's `p` breaks exactly the
	// multi-pair shape Ship's critique found: `- item` / `     %%` / `A` /
	// `  %%` / `B` / ` %%` / `C` / `   %%` / `D` / `E` has no non-`%%` content
	// line with positive indent at all (`A`..`E` are column 0, already
	// excluded by the `c > 0` term below), so the max-budget answer is
	// already correct there - "item B D E", `%%`-paired exactly as the
	// renderer pairs them - and a `p` shrunk from the `%%` lines' own indent
	// (1, from the third one) breaks the FIRST pair's own residual (3 under
	// the max, 4 under that shrunk `p`), making it literal and cascading into
	// "item %% A C". The ticket's own repro keeps working under this
	// exclusion because its shrink comes from a genuine PROSE line (` x
	// ZM1Z`, not a `%%` line) that this exclusion never touches.
	const levelP = new Map<number, number>();
	const fallbackLevelIds = new Set<number>();
	const chainIds: number[][] = new Array<number[]>(lines.length);
	// Phase 1's per-line quote-in-item gate (NRL-114 fix round 1), conjoined
	// with Phase 2's answer.
	const dedentQuoteGate: boolean[] = new Array<boolean>(lines.length).fill(true);
	{
		let inItem = false;
		let blankBefore = true;
		let levels: number[] = [];
		let levelIds: number[] = [];
		let nextLevelId = 0;
		// The quote depth of the line that opened the current item (NRL-114 fix
		// round 1). A line quoted DEEPER than that holds a blockquote nested INSIDE
		// the item, and the renderer dedents the item first and peels that quote
		// second, so the `%%` sits in a QUOTE BODY, where module 6234 dedents
		// nothing and the spaces-only rule applies. Without it `- item` /
		// `  > \t%%` (and `1.  text` / `   >  \t%%`) took the dedent's
		// any-whitespace rule, opened a block on a tab-led `%%` the renderer shows
		// as code or text, and hid the rest. A quote AROUND the list (`> - item` /
		// `> \t%%`) is the same depth as its marker line and is untouched.
		let markerQuotes = 0;
		let crSeen = false;
		// The quote depth the renderer may still hold open at this line: the
		// last quoted line's depth, carried over unquoted non-blank lines (a lazy
		// line inside an open quote) and dropped at a blank line. A marker line
		// with no `>` of its own after `>` or `> ---`, whose marker cannot
		// interrupt the quote (below), is an item INSIDE that quote
		// (`>` / `2. b` / `> \t%%` is `<blockquote><ol><li>b</li></ol>` and the
		// `%%` is dedented item content there), so the marker's depth is the
		// larger of the two, which keeps the dedent: the fail-closed side.
		let carryQuotes = 0;
		// Lines a raw HTML or `$$` block may hold keep the old answer too.
		const htmlMayHold = rawOrMathBlockMayBeOpenTable(lines, false);
		for (let k = 0; k < lines.length; k++) {
			const raw = lines[k]!;
			const body = raw.replace(BLOCKQUOTE, "");
			const quoted = BLOCKQUOTE.test(raw);
			if (LONE_CR.test(raw)) crSeen = true;
			let lineQuotes = 0;
			for (let rest = raw, q = BLOCKQUOTE_ONE_LEVEL.exec(rest); q !== null && q[0].length > 0; q = BLOCKQUOTE_ONE_LEVEL.exec(rest)) {
				lineQuotes += 1;
				rest = rest.slice(q[0].length);
			}
			const blank = body.trim() === "";
			// A thematic break is not an item, although `- - -` and `-    ---` match
			// `LIST_BULLET`: `thematicBreak` precedes `list` in `blockMethods`, so
			// module 745 never sees the line (NRL-114 fix round 1). Reading it as a
			// marker made `> -    ---` / `>   \t%%` dedented item content, and the
			// tab-led `%%` the renderer displays in a plain quote paragraph opened a
			// block and hid the rest. `RENDERER_HR`, not the shared `HR`: the
			// renderer's thematic break takes SPACES only, so `- \t---` and
			// `- \v---` are list items for it and must stay markers here.
			const marker = LIST_BULLET.test(body) && !RENDERER_HR.test(body);
			const indented = /^\s/.test(raw) || /^\s/.test(body);
			if (
				!blank &&
				!marker &&
				!indented &&
				(blankBefore || (!quoted && (HEADING.test(body) || FENCE.test(body) || HR.test(body))))
			) {
				inItem = false;
				levels = [];
				levelIds = [];
			}
			let view = body;
			let depth = 0;
			const chain: number[] = [];
			for (; depth < levels.length; depth++) {
				const residualHere = leadStops(view).indent;
				if (residualHere < levels[depth]! && ITEM_HEAD.test(view)) break;
				const id = levelIds[depth]!;
				chain.push(id);
				if (!blank && residualHere > 0 && !fallbackLevelIds.has(id)) {
					const isPercentLine = view.replace(/^[ \t]+/, "").startsWith("%%");
					if (!isPercentLine) {
						const prevP = levelP.get(id)!;
						if (residualHere < prevP) levelP.set(id, residualHere);
					}
				}
				view = view.slice(listDedentCut(view, levels[depth]!));
			}
			levels.length = depth;
			levelIds.length = depth;
			chainIds[k] = chain;
			listItemContent[k] = inItem && !marker;
			// NRL-114 fix round 1's quote-in-item gate, recorded here and conjoined
			// in Phase 2 below. A lone CR is a LINE TERMINATOR for the renderer, so
			// what follows it starts a physical line this pass never sees; from the
			// first one on, a line keeps the old answer (`> - x` / `>  ` + CR + `%%`
			// hides for the renderer). That is containment only: it preserves the
			// pre-NRL-114 answer and does not model the CR, which stays NRL-164's.
			// A line a raw HTML or `$$` block may hold keeps the old answer too.
			dedentQuoteGate[k] = lineQuotes <= markerQuotes || crSeen || htmlMayHold[k]!;
			if (marker) {
				inItem = true;
				// Only where the marker cannot interrupt the quote: a bullet or a
				// literal `1.` does (module 6234's interrupt walk, the same silent rule
				// `TERM2_LIST` transcribes), so `> \t%% x` / `- > y` ends the quote and
				// the item's own depth stands.
				markerQuotes = TERM2_LIST.test(raw) ? lineQuotes : Math.max(lineQuotes, carryQuotes);
			}
			if (raw.trim() === "") carryQuotes = 0;
			else if (lineQuotes > 0) carryQuotes = lineQuotes;
			let head = ITEM_HEAD.exec(view);
			if (head === null && marker) {
				const id = nextLevelId++;
				levels.push(Number.MAX_SAFE_INTEGER);
				levelIds.push(id);
				levelP.set(id, Number.MAX_SAFE_INTEGER);
				fallbackLevelIds.add(id);
			} else {
				for (let rest = view; head !== null; head = ITEM_HEAD.exec(rest)) {
					if (levels.length >= LIST_LEVEL_CAP) {
						// A bound on the walk, because `- - - - ...` pushes one level per
						// pair and every later line then walks all of them. The terminal
						// level is a whole-lead budget rather than a truncation: a stack
						// SHALLOWER than the renderer's under-dedents and can speak hidden
						// text, where a whole-lead budget reproduces the pre-NRL-117 answer.
						const id = nextLevelId++;
						levels.push(Number.MAX_SAFE_INTEGER);
						levelIds.push(id);
						levelP.set(id, Number.MAX_SAFE_INTEGER);
						fallbackLevelIds.add(id);
						break;
					}
					const id = nextLevelId++;
					const budget = itemHeadCols(head);
					levels.push(budget);
					levelIds.push(id);
					levelP.set(id, budget);
					rest = rest.slice(head[0].length);
				}
			}
			blankBefore = blank;
		}
	}
	// Phase 2: every level's real `p` is now final (it can only have
	// shrunk, never grown, from the max each was seeded at), so replay each
	// line's own recorded chain of level ids against `levelP` instead of the
	// max to get its real residual. This is refusal-only BY CONSTRUCTION, not
	// only by measurement: `levelP` only ever shrinks
	// (`if (residualHere < prevP) levelP.set(id, residualHere)`), so real-p
	// <= max always, for every level on every input. `listDedentCut`'s cut
	// length is monotone non-decreasing in its budget (`Math.min(budgetCols,
	// indent)` and `stops[s]` are both non-decreasing in `budgetCols`), so
	// cutting with the smaller real-p can only remove LESS than cutting with
	// the max, which leaves a residual with >= as much leading whitespace as
	// before. `leadReachesBlockStart` tests "indent <= 3, no tab", a property
	// a GROWING residual cannot newly satisfy - so `listDedented[k]` can only
	// move true -> false under this pass, never false -> true. The two
	// `MAX_SAFE_INTEGER` fallback pushes (an unparseable item head;
	// `LIST_LEVEL_CAP` overflow) are excluded from the shrink by
	// `fallbackLevelIds`, so Phase 2's cut for one is unchanged from the
	// pre-NRL-162, max-only answer. See docs/adr/0006's NRL-162 amendment for
	// the re-measured census and the nested-tab counter-example this proof
	// was checked against (`guard-nrl117-nested-double-tab-correctly-hides`).
	for (let k = 0; k < lines.length; k++) {
		if (!listItemContent[k]) continue;
		let view = lines[k]!.replace(BLOCKQUOTE, "");
		for (const id of chainIds[k]!) view = view.slice(listDedentCut(view, levelP.get(id)!));
		// The conjunction with Phase 1's quote-in-item gate can only move an
		// answer true -> false, so it keeps this pass's refusal-only proof.
		listDedented[k] = leadReachesBlockStart(view) && dedentQuoteGate[k]!;
	}
	// `setextContent[k]` is "line k is the one content line of a setext heading,
	// so a `<!--` at its start is heading TEXT and not an HTML block opener"
	// (NRL-120, ADR 0025). `blockMethods` runs `setextHeading` before `html`, so a
	// line-start `<!--` whose next line is an underline becomes
	// `<h1 data-heading="<!--">` and everything after it is displayed. It is
	// cleanLine's answer only: see `opensHiddenComment` for why the lookaheads do
	// not consult it.
	//
	// The forward pass carries two pieces of state, and each is a measured guard
	// rather than tidiness: each was added after a probe caught the pass without
	// it NEWLY SPEAKING text the renderer hides. Both only ever stop a refusal, so
	// an error in either leaves the base behaviour (hide) rather than speaking.
	//
	// - `rawHtml`: a raw HTML block that is not a comment (`<div>`,
	//   `<span>...`, `<script>`, `<?`, `<!X`) swallows the following lines as raw
	//   HTML until its own end condition, so a `<!--` inside it is still emitted
	//   raw and still hides what follows in the reading view. Without it, 22,656
	//   census cells after `<div>` / `</div>`. The end conditions lean toward
	//   STAYING open: types 6 and 7 close only on a line of spaces, not on any
	//   whitespace, and every `<` line counts as an opener.
	// - `listInRun`: a list marker, bare ones included, anywhere in the run of
	//   non-blank lines above. Inside a list a lone `-` is a new item rather than
	//   an underline, and `listDedented` misses a bare marker. Without it, the
	//   fuzz found `-` / `<!--` / `-` / `HIDDENE`. Also gives up the `===` lazy
	//   shapes the renderer does make headings; fail-closed.
	const setextContent: boolean[] = new Array<boolean>(lines.length).fill(false);
	// Whether line k sits inside a non-comment raw HTML block by that pass's
	// reckoning; kept for `setextLike` below (NRL-136).
	const inRawHtml: boolean[] = new Array<boolean>(lines.length).fill(false);
	// Whether line k is in, or opens, a list item by that pass's reckoning, so a
	// `-` underline under it would be the next item rather than an underline.
	const lazyList: boolean[] = new Array<boolean>(lines.length).fill(false);
	{
		let rawHtml: RegExp | "blank" | undefined;
		let listInRun = false;
		for (let k = 0; k < lines.length; k++) {
			const raw = lines[k]!;
			const insideHtml = rawHtml !== undefined;
			inRawHtml[k] = insideHtml;
			const prefix = containerPrefix(raw);
			// `listItemContent`, deliberately NOT `listDedented`. NRL-117 narrowed
			// `listDedented` with a term about how much lead survives the item's
			// dedent, which is a question about a `%%` opener and says nothing about
			// whether this line can be a setext heading's content, so the two arrays
			// are kept apart. NRL-120's behaviour is byte-identical across NRL-117.
			//
			// This comment used to say that reading the narrowed array here WOULD
			// make `lazyInList` false on a deeply indented item line, make
			// `setextContent` true there, and so make a `<!--` LITERAL and SPOKEN.
			// The rebase onto NRL-118 re-measured that and it is NOT observable
			// today, so the claim is corrected rather than left standing: an arm
			// with this line pointed at `listDedented` is byte-identical to this one
			// over 103,776 cells (22,176 structured plus 80,000 fuzz plus 1,600
			// targeted at the one lead shape that could discriminate). The reason is
			// that the two arrays differ ONLY where the surviving lead is four-plus
			// columns or tab-bearing, and `isSetextContentLine`'s plain path already
			// refuses exactly those through `MODULE134_INDENTED_CODE` and through
			// `TAB_BEARING_LEAD` plus `inSetextBlockPosition`, independently of
			// `lazyInListItem`. So the split is DEFENCE IN DEPTH, not the only guard,
			// and the direction of the hazard is still real: `MODULE134_INDENTED_CODE`
			// has already been narrowed once (NRL-113) and narrowing it again would
			// expose this. Keep the arrays apart, and do not re-state the disclosure
			// as measured.
			const lazyInList = listItemContent[k]! || (listInRun && prefix.blockType !== "list");
			lazyList[k] = lazyInList || prefix.blockType === "list" || ANY_LIST_MARKER.test(raw.replace(BLOCKQUOTE, ""));
			if (k + 1 < lines.length && !insideHtml) setextContent[k] = isSetextContentLine(lines, k, lazyInList);
			const quotePeeled = raw.replace(BLOCKQUOTE, "");
			if (/^ *\r?$/.test(quotePeeled)) listInRun = false;
			else if (ANY_LIST_MARKER.test(quotePeeled)) listInRun = true;
			const body = raw.slice(prefix.chars);
			if (rawHtml === "blank") {
				if (/^ *\r?$/.test(raw)) rawHtml = undefined;
			} else if (rawHtml !== undefined) {
				if (rawHtml.test(raw)) rawHtml = undefined;
			} else if (/^[ \t]*<!--/.test(body) && INDENTED_CODE.test(body) && body.indexOf("-->", body.indexOf("<!--") + 4) === -1) {
				// A `<!--` led by a tab or four columns is indented code to
				// extractChunks, but at least the ` \t` lead is an HTML comment BLOCK
				// to the renderer: measured, ` \t<!--` at document start and after an
				// indented code block both render as raw HTML, not `<pre>`. That
				// divergence is NRL-93's and NRL-115's, a pre-existing disclosure,
				// and it is not fixed here. What this does is stop the refusal
				// REACHING INTO it: a later `<!-- SECRETX` / `---` inside that block
				// is raw HTML for the renderer, and on base it happened to open our
				// own comment and hide the leaked text again. Without this the fuzz
				// found that mask removed. Stays open until a `-->`, fail-closed.
				// Keyed on INDENTED_CODE, "what extractChunks calls indented code",
				// rather than on the complement of HTML_OPENER_AT_START: the two are
				// identical today (checked over every space/tab lead up to six
				// characters), and only this form follows NRL-113's narrowing
				// (NRL-155).
				rawHtml = /-->/;
			} else {
				rawHtml = rawHtmlBlockEnd(body);
				if (rawHtml instanceof RegExp && rawHtml.test(body.slice(body.indexOf("<") + 1))) rawHtml = undefined;
			}
		}
	}
	// `listStrip[k]` is how many leading characters of line k's quote-peeled
	// body the renderer removes because the line is list-item CONTENT (NRL-136
	// Q3), so `htmlBlockLine` can measure the lead the HTML tokenizer really
	// sees: the innermost container view's start (`containerViews`) less what
	// `BLOCKQUOTE` peels, when the characters between are whitespace. Zero on a
	// marker line, whose content lead is `containerLeadOk`'s question, and
	// outside any list.
	//
	// Deliberately NOT a change to `listDedented`, which `opensObsidianBlock`
	// still reads as a boolean for the `%%` rule; the two answer different
	// questions about the same dedent.
	const listStrip: number[] = new Array<number>(lines.length).fill(0);
	// `containerHome[k]` is line k's container stack from the same parse; see
	// `containerViews` and `browserBlockHolds`.
	const containerHome: number[][] = lines.map(() => []);
	// Which of those ids are quote runs rather than list items.
	const quoteIds = new Set<number>();
	// `literalAt[k]`: line k is fenced code, display math or frontmatter for the
	// renderer, by the same parse, so nothing on it is markdown: no `%%`, no
	// HTML block, no heading, and a `-->` in it is text GT emits raw (NRL-136).
	// `fenceAt[k]` marks the fence delimiter lines among them.
	const literalAt: Array<LiteralKind | undefined> = new Array<LiteralKind | undefined>(lines.length).fill(undefined);
	const fenceAt: Array<"open" | "close" | undefined> = new Array<"open" | "close" | undefined>(lines.length).fill(undefined);
	// `htmlLineAt[k]`: line k is a line of a markdown HTML block (any type,
	// comments included) by the same parse, so it is raw HTML for the renderer.
	const htmlLineAt: boolean[] = new Array<boolean>(lines.length).fill(false);
	{
		const viewStart: number[] = new Array<number>(lines.length).fill(0);
		// Obsidian's frontmatter is a `---` on line 0 and the next `---`: its lines
		// are literal YAML whatever they hold. Measured: `---` / `<!----> <!-- Z1Q`
		// / ... / `---` renders the lines as `<pre class="frontmatter">`.
		let first = 0;
		if (lines[0] === "---") {
			const end = lines.indexOf("---", 1);
			if (end !== -1) {
				for (let k = 0; k <= end; k++) literalAt[k] = "front";
				first = end + 1;
			}
		}
		containerViews(
			lines.slice(first).map((text, i) => ({ k: i + first, text, off: 0 })),
			viewStart,
			containerHome,
			[],
			{ next: 0, quotes: quoteIds },
			literalAt,
			fenceAt,
			htmlLineAt,
		);
		for (let k = 0; k < lines.length; k++) {
			const raw = lines[k]!;
			const peel = raw.match(BLOCKQUOTE)?.[0].length ?? 0;
			const body = raw.slice(peel);
			const strip = viewStart[k]! - peel;
			listStrip[k] = !LIST_BULLET.test(body) && strip > 0 && /^[ \t]*$/.test(body.slice(0, strip)) ? strip : 0;
		}
	}
	// `paraBefore[k]` is "the lines above k leave a paragraph open that k would
	// continue", read off the markdown alone and NOT off our comment state,
	// because under NRL-136's browser comment the markdown is still parsed and
	// the per-line loop's own paragraph flags are not kept there. Only
	// `browserSetextText` reads it, to tell setext heading content (which must
	// START a block) from a paragraph's second line. A deliberately small model:
	// a fence, a blank line, indented code in a fresh block, a heading, a rule or
	// underline, and an HTML-block line each leave no paragraph open, and any
	// other line does.
	// `setextLike[k]` widens `setextContent` for NRL-136's block term ONLY: line
	// k is followed by an `=` underline on the quote-peeled, list-stripped view,
	// lazy or not, and is not inside a raw HTML block. A line the block term
	// would call an HTML block always ENDS the paragraph above it (`html` is in
	// `interruptParagraph`), so it starts a block and `setextHeading`, which runs
	// before `html`, takes it. Measured: `> <!-- y --> <!-- S2Z` / `===` / `S3Z`,
	// `- ...` / `===`, `1. S5Z` / `   <!-- y --> <!-- S2Z` / `===` and
	// `# S5Z` / ` \t<!-- y --> <!-- S2Z` / `---` all render a heading showing
	// `<!-- S2Z` and then S3Z. NRL-120's own refusal stays as it was: this is not
	// handed to cleanLine's `setextContent`. The `-` form is taken only outside
	// a list, where a lone `-` run is the next item (NRL-120's measured veto).
	// A lazy underline is one only while it stays in line k's quote run. When the
	// line after it is itself an exact underline, `containerViews` ends the quote
	// there and the would-be underline is setext content of its own heading, so
	// line k is a plain quoted paragraph. Measured: `<!-- y --> <!-- Z0Q` /
	// `> A Z1Q --> Z2Q B` / `=` / `===` / `TAIL` shows `Z2Q B`, then `=` as an
	// `<h1>`, and hides Z1Q; reading line k as a heading spoke it (Ship fuzz,
	// NRL-136). Without the second underline the lazy `=` does underline it.
	const underlineLeftQuote = (k: number): boolean =>
		k + 1 < lines.length && containerHome[k]!.some((id) => quoteIds.has(id) && !containerHome[k + 1]!.includes(id));
	const setextLike: boolean[] = new Array<boolean>(lines.length).fill(false);
	for (let k = 0; k < lines.length; k++) {
		const next = lines[k + 1];
		if (next === undefined || inRawHtml[k]!) {
			setextLike[k] = setextContent[k]!;
			continue;
		}
		const nextView = next.replace(BLOCKQUOTE, "").slice(listStrip[k + 1]);
		setextLike[k] =
			setextContent[k]! ||
			(!underlineLeftQuote(k) && (/^=+\r?$/.test(nextView) || (!lazyList[k]! && /^-+\r?$/.test(nextView))));
	}
	// Did line k leave a quote run line k-1 was in (lazy or not)? Then line k
	// was refused as a lazy quote line by one of `interruptBlockquote`'s
	// constructs and starts a block of its own.
	// A callout marker is one only on the FIRST line of its quote run; on a later
	// line `[!note]` is the paragraph's text, so what follows it is inline.
	// Measured: `> x` / `> [!note] <!-- y --> <!-- Z1Q` / `Z2Q` shows `[!note]`, the
	// second `<!--` escaped, and Z2Q. containerPrefix peels it on every line, so
	// NRL-136's block term asks this instead of trusting that peel.
	const lateCallout = (k: number): boolean => {
		if (k === 0 || !containerPrefix(lines[k]!).callout) return false;
		const own = containerHome[k]!.filter((id) => quoteIds.has(id));
		const quote = own[own.length - 1];
		return quote !== undefined && containerHome[k - 1]!.includes(quote);
	};
	const leftAQuote = (k: number): boolean =>
		containerHome[k - 1]!.some((id) => quoteIds.has(id) && !containerHome[k]!.includes(id));
	const paraBefore: boolean[] = new Array<boolean>(lines.length).fill(false);
	// `htmlParaOpen[k]` is the `paraOpen` answer `htmlBlockLine` needs for line k:
	// `paraBefore[k]`, except that a line with no `>` straight after a quoted one
	// is asked as a FRESH block. `html` is in `interruptBlockquote`, and the
	// blockquote tokenizer asks it with module 8776's uncapped lead, so the quote
	// ends there and the HTML block starts: measured, `> > Z2Q` / ` \t<!--> <!-- Z3Q`
	// renders the quote and then a raw block. Strict paragraph continuation
	// (module 8607) is the wrong question for that line.
	const htmlParaOpen: boolean[] = new Array<boolean>(lines.length).fill(false);
	{
		let open = false;
		let fenced = false;
		for (let k = 0; k < lines.length; k++) {
			paraBefore[k] = open;
			const p = containerPrefix(lines[k]!);
			// A marker line's content starts a new block, the item; its own lead is
			// containerLeadOk's question, and listStrip is zero there.
			const view = lines[k]!.slice(p.chars).slice(listStrip[k]);
			const wasOpen = open && p.blockType !== "list";
			const htmlOpen = wasOpen && !(k > 0 && leftAQuote(k));
			htmlParaOpen[k] = htmlOpen;
			open = false;
			if (literalAt[k]! || htmlLineAt[k]!) continue;
			// Fence toggle, capped the same way containerViews' own fence test is
			// (NRL-156): a line four-or-more-spaces or tab-led never opens a fence
			// here either, consistent with the array `literalAt`/`fenceAt` that
			// containerViews already built above and that the `continue` just
			// above this one is meant to make this branch redundant with - this is
			// the backstop for whatever containerViews did not reach (NRL_MAX_DEPTH).
			const fenceHere = fenceOpensAt(view.match(/^[ \t]*/)![0], wasOpen) && FENCE.test(view);
			if (fenced || fenceHere) {
				if (fenceHere) fenced = !fenced;
				continue;
			}
			// A heading as a list item's content (`- # Z2Q`) is a heading too, which
			// `containerPrefix` reports as "list": it leaves no paragraph open, so a
			// six-space line under it is indented code whose `-->` closes a browser
			// comment, `%%` pair and all. Measured: `- <!----> <!-- Z1Q` / `- # Z2Q` /
			// `      %%Z3Q --> Z4Q%% Z5Q` shows `Z4Q%% Z5Q` (Ship fuzz, NRL-136).
			if (p.blockType === "heading" || HEADING.test(view) || blankEndsParagraph(view, wasOpen) || (!wasOpen && /^(?: {4}|\t)/.test(view))) continue;
			if (HR.test(view) || HR.test(lines[k]!) || (wasOpen && SETEXT_UNDERLINE_EXACT.test(view))) continue;
			if (!setextLike[k]! && htmlBlockLine(view, 0, htmlOpen)) continue;
			open = true;
		}
	}
	const segmentCtx: SegmentContext = { locale: opts.locale, src };

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
	// A `%%` block ends where Obsidian's own parser ends it (NRL-118, ADR 0006
	// clause 5). The reading view tokenizes a blockquote, a list item or a
	// footnote definition as a fresh run of blocks over its own rewritten lines,
	// so a `%%` comment opened inside one stops at the container's last line,
	// closed or not; ours used to run on through the note to the next `%%` at
	// any depth, so `>> %%` / `%% SECRET` spoke SECRET, which the reader never
	// sees. `percentEnds` maps a line on which the RENDERER opens a `%%` comment
	// that runs out of container to the last line that comment covers, from a
	// transcription of the renderer's block tokenizer (obsidianBlocks.ts). It is
	// consulted only when WE open a block on that same line, which is the same
	// `%%` by construction (the opener is the last `%%` on its line, with no `%`
	// after it, in both); everywhere else, including every opener the renderer
	// does not have, the block stays note-scoped exactly as before. That keeps
	// the change to one direction it can be argued in: a block both parsers
	// agree on ends where the renderer ends it, and nothing else moves.
	const percentEnds = rendererHidden?.percentEnds ?? new Map<number, number>();
	let commentLastLine = -1;
	const scopeComment = (lineNo: number): void => {
		commentLastLine = inComment === "%%" ? (percentEnds.get(lineNo) ?? -1) : -1;
	};

	// Whether the open `-->` comment was opened as an HTML block (NRL-136), so
	// the line that closes it is raw HTML and its remainder is cleaned in the
	// "raw" context. Only read while inComment is "-->".
	let inCommentBlock = false;
	// Whether it is NRL-136's browser comment, under which fences, `%%` blocks,
	// inline `%%` pairs and line-start HTML comment blocks still count.
	let inCommentBrowser = false;
	// A `%%` block opened UNDER a browser comment: when it closes, the browser
	// comment is still open and its `-->` is still to be found (NRL-136).
	let resumeBrowser = false;
	// An inline HTML comment left open on a paragraph line under a browser
	// comment, see the browser branch.
	let browserInline = false;
	// The containers of the other blocks NRL-136 tracks under a browser comment:
	// a fence (which can outlive the comment, so the per-line loop reads it too)
	// and a `%%` block. Each ends with its container, as
	// Q2's does: measured, a `%%` block inside a list item ends where the item
	// does, and the heading after it closes the browser comment.
	let fenceHome: readonly number[] | undefined;
	let pctHome: readonly number[] | undefined;
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
	// A line's WINDOW for fix round 1's refinements (fix round 2 scopes to it
	// what round 1 gated note-wide): the line itself, every earlier line back to
	// the last blank one, and every later line up to the old bound's `-->`. A
	// refined answer can only stop a comment hiding text inside that window, so
	// the refined record is taken only where nothing in it can hide that text by
	// another means:
	// - no inline construct (`inlineConstructMayHold`) may be open around the
	//   `<!--` or sit between it and that `-->`. There the old over-hiding
	//   comment was also covering text that a DIFFERENT construct hides: a tag's
	//   attribute value, a link title, an image label (the embed's `alt`), or an
	//   `<!X` / `<?` / CDATA HTML block on a line of its own (/critique, two
	//   rounds: `Note <span title="<!-- a -- b` / `c -->">d</span>` and
	//   `P <!-- a` / `><!X b` / `    c` / `> \td --->` both spoke b). The old
	//   bound, `term2Stop`, reaches at least as far as the code-stopped one, so it
	//   covers both;
	// - the line is in no footnote definition, where the renderer may hold the
	//   `<!--` as an HTML node inside the footnote, which the walker does not
	//   model (`> [^1]: foot` / `>\t<!-- x` / `> ---`). An unreferenced
	//   definition is dropped whole by `rendererHiddenText` in any case, which is
	//   what round 1's note-wide footnote gate stood in for (`P <!-- QAAQ` /
	//   `> \t<div>` / `[^1]: QBAQ --> QCAQ` spoke QBAQ);
	// - the line is past the renderer's frontmatter and the line closing it,
	//   which the walker reads as paragraph text and a setext underline
	//   (/critique round 3, Q1);
	// - the line is past every line that text a browser hides beyond an HTML
	//   block may reach (`openRiskThrough`): a browser comment the block leaves
	//   open, or an attribute value, which runs on to a quote the renderer may
	//   write itself. Neither is in the hidden ranges, so a refinement on or
	//   before such text, which can stop one of our comments hiding everything to
	//   the note's end, would speak it (NRL-166 fix round 3; its census: `> P <!--
	//   a` / ... / `>\t<!--<!--<!-- QNQ` / `1. > <div title="QNZQ` / `  - > <span
	//   title='QOQ` spoke QOQ, which 44a037a's comment hid);
	// - and where the transcription has no answer (a lone CR, deep nesting),
	//   round 1's note-wide footnote and `---` gates stand.
	const inlineMayHoldAbove: boolean[] = new Array<boolean>(lines.length).fill(false);
	for (let k = 0, seen = false; k < lines.length; k++) {
		if (lines[k]!.trim() === "") seen = false;
		inlineMayHoldAbove[k] = seen;
		if (lineMayHold(k)) seen = true;
	}
	const constructInBody = constructInBodyAheadOf(term2Stop);
	const noteWideGate = rendererHidden === null && (/^---[ \t]*\r?$/.test(lines[0] ?? "") || lines.some(footnoteShaped));
	const frontmatterGateTo = rendererHidden === null ? -1 : rendererHidden.frontmatterLastLine === -1 ? -1 : rendererHidden.frontmatterLastLine + 1;
	const refineWindowClean = lines.map(
		(_line, k) =>
			!noteWideGate &&
			k > frontmatterGateTo &&
			!(rendererHidden?.footnoteLines[k] ?? false) &&
			k > (rendererHidden?.openRiskThrough ?? -1) &&
			!inlineMayHoldAbove[k]! &&
			!lineMayHold(k) &&
			!pctUnsure(k, lines[k]!) &&
			!constructInBody[k]!,
	);

	// `htmlLeadIndented[n]` is "the renderer never offers line n's content to its
	// HTML block tokenizer, because after its own container dedent the line is a
	// lazy paragraph continuation or indented code" (NRL-115). It is
	// opensHtmlBlock's fifth argument; the reasoning, the failure direction and
	// the measurements live on `rendererLeads`. Frontmatter lines get no record,
	// and the first line after it starts a fresh frame, which is the safe default.
	//
	// The walker runs twice, with and without NRL-166 fix round 1's two
	// refinements, and each line takes the refined record only where its
	// `refineWindowClean` holds (fix round 2). Round 1 withheld the refinements
	// from a WHOLE NOTE holding any `<`, backtick, `[`, `](`, `[^x]:` line or a
	// leading `---`, which nearly every real note has (a link is enough), and
	// Verify 2 measured 35,978 cells it lost that way. Each record is a fact
	// about its own line, so taking it line by line from one walk or the other
	// is sound; what the gate guards is the text a refined answer stops hiding,
	// which lies in that line's own window.
	const walkFrom = frontmatter ? frontmatter.endLine + 1 : 0;
	const leadsPlain = rendererLeads(lines, walkFrom, false);
	const leadsRefined = rendererLeads(lines, walkFrom, true);
	const pick = <T>(a: T[], b: T[]): T[] => a.map((v, k) => (refineWindowClean[k]! ? b[k]! : v));
	const leads: RendererLeads = {
		lead: pick(leadsPlain.lead, leadsRefined.lead),
		cont: pick(leadsPlain.cont, leadsRefined.cont),
		nested: pick(leadsPlain.nested, leadsRefined.nested),
		closerInPara: pick(leadsPlain.closerInPara, leadsRefined.closerInPara),
		unsureFresh: pick(leadsPlain.unsureFresh, leadsRefined.unsureFresh),
		para: pick(leadsPlain.para, leadsRefined.para),
		refine: true,
		pending: [],
	};
	// Built on first use by the container-fence drop in the per-line loop.
	let rawOrMathOpen: boolean[] | undefined;
	const htmlLeadIndented = leadIndentedForHtml(leads);
	// A lone CR before the line's first `<!--` (or `%%`, for the code-line veto
	// below) is a LINE TERMINATOR for the renderer, so that construct starts a
	// physical line of its own and
	// `rendererLeads`' verdict - which reads the lead of the line as we split it,
	// on `\n` only - says nothing about it. Its term-1 veto is dropped there and
	// `opensHtmlBlock`'s own lead test decides.
	// Measured, and found by this ticket's census rather than reasoned:
	// `> Plain prose` / `>\t>` + CR + `<!-- ZCZ` / `> ---` / `> SECRET -->` is
	// `<blockquote><p>Plain prose<br>></p></blockquote><!-- ZCZ> ---> SECRET -->`
	// for the renderer, and once the quoted `---` became a term-2 stop the veto
	// was the only thing deciding the line, which newly spoke ZCZ and SECRET.
	for (let k = 0; k < lines.length; k++) {
		if (!htmlLeadIndented[k]) continue;
		const line = lines[k]!;
		const html = line.indexOf("<!--");
		const pct = line.indexOf("%%");
		const at = html === -1 ? pct : pct === -1 ? html : Math.min(html, pct);
		if (at !== -1 && line.slice(0, at).includes("\r")) htmlLeadIndented[k] = false;
	}
	// Its lazy-continuation half, for containerCarryStops only (F1).
	const htmlLeadLazy = htmlLeadIndented.map((v, k) => v && leads.cont[k]!);
	// Its FRESH-BLOCK half: a line inside a quote or a list item whose dedented
	// body is module 134 indented code (`leadIndentedForHtml`'s `nested &&
	// startsIndentedCode(lead)` branch). Such a line is CODE for the renderer
	// (`indentedCode` is blockMethods index 2, `html` index 11), so its `<!--` is
	// neither a block opener nor an inline comment: term 1 already declines it
	// through `leadIndented`, and NRL-114 masks term 2 here, ONCE, so every reader
	// of the term-2 answer - cleanLine, opensHiddenComment through
	// interruptsParagraph, codeSpanClosesLater and bracketClosesLater - gets the
	// same masked value. Masking can only make term 2 false, so `opensHtmlBlock`'s
	// composed answer still implies its old one.
	//
	// It became reachable with NRL-114's narrower peel: `>\t<!-- ZCZ` / `> ===` /
	// `> ZAZ -->` keeps its tab in the quote body, the body is indented code, and
	// the term-2 `-->` two lines down hid `===` and `ZAZ`, which Obsidian displays
	// (`<blockquote><pre><code>&#x3C;!-- ZCZ</code></pre><p>===<br>ZAZ -->`).
	//
	// Only where the walker is SURE the line starts a block (`unsureFresh`): after
	// a table-shaped or definition-shaped line the walker says "fresh" as a safe
	// default for term 1, while the renderer may continue the paragraph, and
	// masking term 2 there newly spoke an inline comment's body
	// (`> | a |` / `> \t<!-- SECRETH` / `> =` / `> HIDDEN` / `> --> t.` is ONE
	// paragraph whose comment hides SECRETH and HIDDEN).
	// Every line from the first LONE CR on (a CR not ending its line) keeps the
	// pre-NRL-114 answers below, as an unsure line does (NRL-114 fix round 1). A
	// lone CR is a line terminator for the renderer and not for our `\n` split,
	// so after one the walker's view of which line starts which block is not the
	// renderer's: `    ` + CR + `%%` opens a comment there that hides a later
	// `> > \t\t<!-- x`, which the code mask alone newly spoke.
	const crAbove: boolean[] = new Array<boolean>(lines.length).fill(false);
	for (let k = 0, seen = false; k < lines.length; k++) {
		if (!seen && LONE_CR.test(lines[k]!)) seen = true;
		crAbove[k] = seen;
	}
	const htmlLeadCode = htmlLeadIndented.map((v, k) => v && !leads.cont[k]! && !leads.unsureFresh[k]! && !crAbove[k]!);
	// A line the walker is unsure of keeps the pre-NRL-114 term-2 answer whole:
	// after a definition-shaped line the renderer may have a FOOTNOTE whose
	// continuation it dedents (`> [^1]: foot` / `> \t<!-- SECRETH` / `> ---`
	// holds an html node `<!-- SECRETH` inside the footnote), after a
	// table-shaped one a plain paragraph, and the walker models neither, so
	// neither the quoted stop nor the code mask may decide such a line.
	//
	//
	// A line `htmlLeadCode` marks is also a term-2 STOP for an opener above it on
	// a line the walker is sure is paragraph text (NRL-166 fix round 1). The
	// walker calls the code line a FRESH block, so that paragraph does not run
	// into it, and a `-->` on it or past it closes nothing up there:
	// `> > P <!-- a` / `> b` / `>\t--> Z` displays `<!-- a` and puts `--> Z` in an
	// indented-code block of the outer quote, because `indentedCode` is in module
	// 6234's `interruptBlockquote`. Only for a PARAGRAPH opener, whose comment is
	// inline and so paragraph-scoped: an opener the walker does not place in a
	// paragraph may be a browser comment trailing a raw HTML line, which runs
	// through the rendered document and does not stop at a code block
	// (`1. ><!-- y --> QAQ <!--` / `>>> \t| a |` / `>> QCQ` hides QCQ), and an
	// arm without this condition spoke it in the 4,000-note fuzz.
	const term2StopOrCode = term2Stop.map((s, k) => s || htmlLeadCode[k]!);
	const htmlCloserAheadCode = closerAheadOf(term2StopOrCode);
	// Both of fix round 1's term-2 changes (the code-line stop here and the body
	// rule below) apply only on a line the walker is sure is paragraph text and
	// whose window is clean (`refineWindowClean`, which since fix round 2 replaces
	// round 1's note-wide footnote, inline-construct and leading `---` gates).
	const paraSure = leads.para.map((v, k) => v && !leads.unsureFresh[k]! && !crAbove[k]! && refineWindowClean[k]!);
	const refineAt = paraSure;
	const htmlClosesLaterAt = htmlCloserAhead.map((v, k) =>
		leads.unsureFresh[k]! || crAbove[k]! ? htmlCloserAheadRaw[k]! : (refineAt[k]! ? htmlCloserAheadCode[k]! : v) && !htmlLeadCode[k]!,
	);
	// The later lines' share of an inline comment's body rule, on the SAME bound
	// as `htmlClosesLaterAt` (see `inlineCommentFacts`), and only on a line
	// the walker is SURE is paragraph text (`leads.para`); anywhere else it is
	// undefined and the comment keeps hiding as before. That is not caution for
	// its own sake: after a definition-shaped line the renderer may hold the
	// `<!--` as an HTML node inside a footnote (`> [^1]: foot` / `>\t<!-- x` /
	// `> ---`), where the body rule does not apply, and an arm that checked
	// every line spoke x there. Read by cleanLine's comment branch only: the
	// carries keep the unchecked answer, which ends their paragraph sooner, the
	// fail-closed side for them.
	const bodyOkLater = commentBodyOkAheadOf(term2StopOrCode);
	const htmlBodyOkLaterAt: (boolean | undefined)[] = bodyOkLater.map((v, k) => (refineAt[k]! ? v : undefined));
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
	// Whether `paraText` ends in a space, kept beside it because asking the
	// string flattens a long concatenation once per line, which was quadratic in
	// a paragraph's length (NRL-166 fix round 2).
	let paraEndsSpace = false;
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
			chunks.push(...speak(paraText, paraIndex, paraStart, blockType));
		}
		paraText = "";
		paraIndex = [];
	};

	const appendToParagraph = (cleaned: Cleaned, start: number, blockType: BlockType = "paragraph"): void => {
		if (paraText === "") {
			paraText = cleaned.text;
			paraEndsSpace = cleaned.text.endsWith(" ");
			// A copy, since later lines are appended to it in place.
			paraIndex = cleaned.index.slice();
			paraStart = start;
			paraBlockType = blockType;
		} else if (paraEndsSpace) {
			// The line already ended in a real mapped space, because whatever
			// it ended with was dropped: a comment, an image, a tag, a URL, an
			// emoji or a CR. A second synthetic one would put two spaces in the
			// spoken text and a second index entry with it. cleanLine and
			// verbatimLine can never emit a leading space, so only this side
			// needs checking.
			paraText += cleaned.text;
			if (cleaned.text !== "") paraEndsSpace = cleaned.text.endsWith(" ");
			// Appended in place: rebuilding the array per line was quadratic in a
			// paragraph's length (20,000 lines of `P <!-- a`, each literal by the
			// body rule, took 27 s; NRL-166 fix round 2).
			for (const at of cleaned.index) paraIndex.push(at);
		} else {
			// Same join convention as mergeShort: the space between the two
			// lines is synthetic, so it is attributed to the character right
			// before whatever comes next.
			const gap = sourceOffsetOfSpace(
				(paraIndex[paraIndex.length - 1] ?? paraStart) + 1,
				cleaned.index[0] ?? start,
			);
			paraText = `${paraText} ${cleaned.text}`;
			paraEndsSpace = cleaned.text === "" || cleaned.text.endsWith(" ");
			paraIndex.push(gap);
			for (const at of cleaned.index) paraIndex.push(at);
		}
	};

	/**
	 * Is this whole line an HTML-block line for the renderer (NRL-136)? Its first
	 * `<!--` starts a block: not a heading's inline content, not setext heading
	 * content (NRL-120: `setextHeading` runs before `html`, so
	 * `<!-- y --> <!-- Q` / `===` renders an `<h1>` showing `<!-- Q`), a
	 * container lead the renderer accepts, and a lead of at most three spaces
	 * once list-item content is stripped.
	 */
	const htmlBlockLineAt = (raw: string, lineNo: number): boolean => {
		const p = containerPrefix(raw);
		return (
			p.blockType !== "heading" &&
			!literalAt[lineNo]! &&
			!setextLike[lineNo]! &&
			!lateCallout(lineNo) &&
			containerLeadOk(raw, p.chars) &&
			htmlBlockLine(raw.slice(p.chars), listStrip[lineNo]!, htmlParaOpen[lineNo]!)
		);
	};

	/**
	 * The context for what follows a BROWSER comment's `-->` (NRL-136). The
	 * comment lives in rendered output, so the line that closes it is whatever
	 * the markdown made it: a raw HTML block line when its own first `<!--`
	 * starts one (`<!-- a --> <!-- R` hides R), and otherwise an ordinary line
	 * whose remaining `<!--` is inline. The second case must NOT get term 1's
	 * line-start test on the remainder, which would treat `--> <!-- R` as a
	 * line-start opener: measured, that silenced text Obsidian displays as code
	 * in 10 of the first fuzz run's notes.
	 */
	const browserCloseContext = (raw: string, lineNo: number): HtmlContext =>
		htmlBlockLineAt(raw, lineNo) || (htmlLineAt[lineNo]! && !literalAt[lineNo]!) ? "raw" : "inline";

	/** The line as its innermost container's block tokenizers see it (NRL-136). */
	const blockView = (raw: string, lineNo: number): string => raw.slice(containerPrefix(raw).chars).slice(listStrip[lineNo]);

	/**
	 * The container stack a block opened on this line lives in, for a block
	 * NRL-136 tracks under a browser comment: `containerHome`, from the same
	 * parse that sets `listStrip`. A line with no `>` after a quoted one is not a
	 * lazy quote line there when it opens one of these blocks, since each (`html`,
	 * a fence, `%%`, `$$`) is in `interruptBlockquote`; measured,
	 * `> - <!-- y --> <!-- S2Z` / `<!-- S3Z` / `# S4Z --> S6Z` renders the quote
	 * and then a top-level raw block holding the heading line, so S4Z is hidden,
	 * while `1. <!-- y --> <!-- Z4Q` / `><!-- Z5Q` / `  \t%%` keeps the `%%` block
	 * inside the list item after the quote in it has ended.
	 */
	const blockHome = (lineNo: number): readonly number[] => containerHome[lineNo]!;

	/**
	 * Is line `lineNo` the content of a setext heading, so GT copies its RAW
	 * text into `data-heading` the way it does for an ATX heading (NRL-136 Q1)?
	 * Then a `-->` inside an inline `%%` pair still closes a browser comment,
	 * inside the attribute. Measured: `<!-- y --> <!-- Z0Q` / `A %%x --> Z1Q%% Z2Q`
	 * / `===` renders `<h1 data-heading="A %%x --> Z1Q%% Z2Q">`, so Z1Q is shown.
	 *
	 * The next line must be an exact underline (NRL-120's shape, on the
	 * quote-peeled and list-stripped view), the line itself must be led by at
	 * most three spaces, and it must START a block: Obsidian takes exactly one
	 * content line, so a line continuing a paragraph makes `===` text. The
	 * block-start test is deliberately narrow - a blank line, a heading, a fence,
	 * a rule or underline, an HTML-block line, or this line opening a list item
	 * or a quote - because answering true where the renderer has a paragraph
	 * skips no pair and so speaks a `%%` comment's content.
	 */
	const browserSetextText = (lineNo: number): boolean => {
		const next = lines[lineNo + 1];
		if (next === undefined) return false;
		const nextView = next.replace(BLOCKQUOTE, "").slice(listStrip[lineNo + 1]);
		if (!SETEXT_UNDERLINE_EXACT.test(nextView)) return false;
		if (underlineLeftQuote(lineNo)) return false;
		const raw = lines[lineNo]!;
		const cur = containerPrefix(raw);
		if (cur.callout) return false;
		// A `-` run under a container line is a rule (or, in a list, the next
		// item), not an underline: measured, `- [ ] Z5Q --> Z6Q` / `---` and
		// `> > Z4Q --> Z5Q` / `---` both render the line as text and then `<hr>`.
		if (nextView.startsWith("-") && (cur.blockType !== "paragraph" || lazyList[lineNo]! || BLOCKQUOTE.test(raw) || BLOCKQUOTE.test(next))) {
			return false;
		}
		if (!/^ {0,3}\S/.test(raw.slice(cur.chars).slice(listStrip[lineNo]))) return false;
		// A line that left the quote run the line above it was in cannot continue
		// that quote's paragraph, so it starts a block: measured, `- - Z3Q` / ... /
		// `> Z7Q` / `      %%%Z8Q --> Z9Q%% Z10Q` / `=` renders that line as an
		// `<h1>` inside the nested item (Ship fuzz, NRL-136).
		return (
			!paraBefore[lineNo]! ||
			cur.blockType === "list" ||
			(cur.blockType === "quote" && !BLOCKQUOTE.test(lines[lineNo - 1] ?? "")) ||
			(lineNo > 0 && leftAQuote(lineNo))
		);
	};

	/**
	 * Does a block opened under a browser comment still hold this line? Exactly
	 * while the line is still inside every container the block's opening line
	 * was in, by `containerHome`'s ids. Both directions disclose if wrong (an
	 * early end reads a raw `# H --> T` as a heading and speaks H; a late one reads
	 * a non-raw `A %%x --> S%% B` as raw and speaks S), which is why this is a
	 * parse rather than a quote-count. A blank line does NOT end a top-level
	 * block on its own: measured, `<!-- a --> <!-- Z0Q` / `<!-- Z1Q` / blank /
	 * `# Z2Q --> Z3Q` still hides Z2Q.
	 */
	const browserBlockHolds = (lineNo: number, home: readonly number[]): boolean =>
		home.every((id) => containerHome[lineNo]!.includes(id));

	/**
	 * A BROWSER comment closes at `close` on this line (NRL-136). Returns true
	 * when the line must then be processed as an ordinary line.
	 *
	 * On an ordinary line the remainder is cleaned in the context
	 * `browserCloseContext` gives it. On a heading - ATX, or setext content
	 * (`browserSetextText`) - the `-->` closes INSIDE the `data-heading`
	 * attribute GT writes before the heading's text, so what the reader sees is
	 * the rest of the RAW line, then the whole rendered heading: measured,
	 * `<!-- y --> <!-- Q1Z` / `# Head --> line` / `TAIL` renders visible text
	 * `line">Head --> line TAIL`. So the raw rest is spoken as its own chunk,
	 * cleaned with blockComments off because attribute text opens nothing, and
	 * the heading follows. The first NRL-136 draft read the heading alone and
	 * dropped that rest; this speaks it, and so also closes the residual its
	 * plan recorded for `# A %%x --> S%% B` (S is shown in that rest).
	 *
	 * A `<!--` that the rest leaves unclosed is handled below, where it is
	 * explained.
	 */
	const closeBrowserComment = (raw: string, close: number, lineStart: number, lineNo: number): boolean => {
		inComment = undefined;
		inCommentBrowser = false;
		if (!closesInHeadingAttribute(raw) && !browserSetextText(lineNo)) {
			appendRemainder(raw, close + 3, lineStart, lineNo, browserCloseContext(raw, lineNo));
			return false;
		}
		const from = close + 3;
		// The rest can open a NEW comment in data state. It runs to the next `-->`,
		// and the next one the reader's HTML holds is the heading's own text's
		// first, which is this very `-->` again, so everything after it in the
		// heading text is then shown, rendered inline (an unclosed `<!--` there is
		// escaped text). Measured: `- [ ] <!-- y --> <!-- Z6Q` / `===` under a browser
		// comment shows `<!-- Z6Q`. Only a comment the rest opens and does not
		// close takes this path; one it closes itself stays inside the attribute.
		let at = from;
		const shown: Array<[number, number]> = [];
		let open = false;
		while (at < raw.length) {
			const o = raw.indexOf("<!--", at);
			if (o === -1) {
				shown.push([at, raw.length]);
				break;
			}
			shown.push([at, o]);
			const c = raw.indexOf("-->", o + 4);
			if (c === -1) {
				open = true;
				break;
			}
			at = c + 3;
		}
		if (open) {
			for (const [a, b] of shown) {
				const part = cleanLine(raw.slice(a, b), lineStart + a, stripOpts);
				if (part.text.trim() !== "") appendToParagraph(part, lineStart + a);
			}
			flushParagraph();
			const tail = cleanLine(raw.slice(from), lineStart + from, stripOpts, true, undefined, undefined, undefined, undefined, false, 0, false, false, false, false, "inline");
			if (tail.text.trim() !== "") appendToParagraph(tail, lineStart + from);
			flushParagraph();
			return false;
		}
		const rest = cleanLine(raw.slice(from), lineStart + from, stripOpts);
		if (rest.text.trim() !== "") appendToParagraph(rest, lineStart + from);
		flushParagraph();
		return true;
	};

	/** Clean closing-line prose, including any further comments. */
	const appendRemainder = (raw: string, from: number, lineStart: number, lineNo: number, override?: HtmlContext): void => {
		// What the closed comment was decides what its closing line is (NRL-136).
		// An HTML block ends on this line, so the remainder is raw HTML; a `%%`
		// block's remainder is read as a fresh block start, which is the harness
		// verdict for `%%` / `a %% <!-- y --> <!-- Q` at under four columns; and
		// a comment term 2 opened was inline, so its remainder keeps the
		// pre-NRL-136 behaviour exactly.
		const htmlContext: HtmlContext =
			override ?? (inComment === "%%" ? (htmlBlockLine(raw.slice(from), 0, true) ? "block" : "none") : inCommentBlock ? "raw" : "none");
		const cleaned = cleanLine(
			raw.slice(from),
			lineStart + from,
			stripOpts,
			true,
			undefined,
			undefined,
			undefined,
			undefined,
			htmlClosesLaterAt[lineNo],
			0,
			listDedented[lineNo],
			false,
			false,
			false,
			htmlContext,
			htmlBodyOkLaterAt[lineNo],
		);
		inComment = cleaned.openComment;
		scopeComment(lineNo);
		inCommentBlock = cleaned.openCommentBlock === true;
		inCommentBrowser = cleaned.openCommentBrowser === true;
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

		// The renderer's comment ran out of container on an earlier line, so this
		// one is not hidden. It is processed FRESH, as if no block had been open,
		// which is what the reading view does with it: the container's parent
		// tokenizes it, and a line-start `%%` here opens a new block.
		if (inComment === "%%" && commentLastLine !== -1 && lineNo > commentLastLine) {
			inComment = undefined;
			commentLastLine = -1;
		}

		// Hidden lines must not change blank, paragraph, list, code or math state.
		// In particular, a different comment delimiter cannot close this one.
		// A block NRL-136 tracks under a browser comment ends with the container
		// it opened in, wherever the per-line loop is when that happens: a fence can
		// outlive the comment it opened under. Measured: `- Z0Q --> Z1Q` /
		// `     <!--> <!-- Z2Q` / `\t```` / ... / `* <!-- Z10Q` ends the fence with
		// the `-` item, and the `*` line starts a new list whose `<!--` hides.
		if (fenceHome !== undefined && (!inFence || !browserBlockHolds(lineNo, fenceHome))) {
			if (inFence) inFence = false;
			fenceHome = undefined;
		}
		if (pctHome !== undefined && (!resumeBrowser || !browserBlockHolds(lineNo, pctHome))) {
			if (resumeBrowser) {
				inComment = "-->";
				inCommentBrowser = true;
				resumeBrowser = false;
			}
			pctHome = undefined;
		}

		// Hidden lines must not change blank, paragraph, list, code or math state,
		// with one exception below: NRL-136's browser comment keeps the markdown
		// under it. In particular, a different comment delimiter cannot close this
		// one.
		if (inComment) {
			/*
			 * NRL-136's browser comment is the one exception, and the reason is
			 * that its region is RENDERED OUTPUT rather than markdown the parser
			 * skipped. The markdown under it is still parsed, so four of its
			 * constructs still act, all measured against Obsidian 1.13.7's own
			 * parser and renderer:
			 *
			 * - A fence is still a fence. One opened under the comment and closed
			 *   after it would otherwise be read as an OPENER at its closing line
			 *   and swallow the prose that follows; and a `-->` inside that
			 *   fence's code still closes the comment, because GT emits `>` raw in
			 *   `<pre>`, leaving the rest of the line as code.
			 * - A `%%` block still opens, and the parser REMOVES it, `-->` and
			 *   all. So the browser comment survives it and resumes looking for
			 *   its `-->` after the `%%` closer.
			 * - An inline `%%...%%` pair is removed the same way, so a `-->` inside
			 *   one does not close (Q1, `browserCloserAt`).
			 * - A line-start `<!--` that does not close on its line opens a markdown
			 *   HTML block (Q2, `htmlLineAt`). Its lines are raw, so a heading
			 *   or a fence inside it is text, and its `-->` closes the browser
			 *   comment too, leaving a raw remainder.
			 */
			let readWhole = false;
			if (inComment !== "-->" || !inCommentBrowser || term2Stop[lineNo]!) browserInline = false;
			if (inComment === "-->" && inCommentBrowser) {
				// A line of a markdown HTML block (Q2), by `containerViews`' parse, is raw
				// HTML under the comment too: the comment kind a line-start `<!--` opens
				// while the browser comment is already open, and a non-comment block
				// (`<div>` and the like). No heading, fence, `%%` or pair acts on it; its
				// `-->` closes the browser comment and the remainder is raw, so an
				// unclosed `<!--` there reopens. Measured: `<!-- a --> <!-- Z0Q` /
				// `<!-- Z1Q` / `# Z2Q --> Z3Q` shows only Z3Q, `... Z2Q --> Z3Q <!-- Z4Q`
				// / `Z5Q` inside such a block hides Z5Q, and the block ends with its
				// container, a blank line not ending a comment block. The first draft of
				// this kept a separate `browserHtmlBlock` state for the comment kind; it
				// became redundant with this, measured at 0 differing outputs over
				// 50,725 notes x 2 option sets, and was removed. For `<div>`, measured:
				// ` <!----> <!-- Z0Q` / `<div> <!-- Z1Q` / ... / `    <!-- a --><!-- Z6Q`
				// / `Z7Q` hides Z6Q and Z7Q, the whole run being one `<div>` block.
				if (!inFence && htmlLineAt[lineNo]! && !literalAt[lineNo]!) {
					const close = raw.indexOf("-->");
					if (close === -1) continue;
					inComment = undefined;
					inCommentBrowser = false;
					appendRemainder(raw, close + 3, lineStart, lineNo, "raw");
					continue;
				}
				const view = blockView(raw, lineNo);
				// Fenced code, display math, frontmatter (`literalAt`) and indented code
				// are text the renderer escapes, but GT emits `>` raw in all of them, so
				// a `-->` there closes the comment and the rest of the line is that
				// block's content. None of them runs a `%%` pair, a heading or an HTML
				// block. Measured: `- <!--> <!-- Z0Q` / ... / `   $$` / ... /
				// `> # Z6Q --> Z7Q` shows only Z7Q, the line being math source rather
				// than a heading. A fence's own delimiter lines are handled below, where
				// `inFence` is kept for the per-line loop.
				const literalKind: LiteralKind | undefined = inFence
					? "code"
					: fenceAt[lineNo] === undefined
						? literalAt[lineNo]
						: undefined;
				const codeLine = literalKind === undefined && !htmlParaOpen[lineNo]! && view.trim() !== "" && /^(?: {4}|\t)/.test(view);
				if (literalKind !== undefined || codeLine) {
					const close = raw.indexOf("-->");
					if (close === -1) continue;
					inComment = undefined;
					inCommentBrowser = false;
					const from = close + 3;
					const rest = raw.slice(from);
					const spoken =
						literalKind === "math" ? true : literalKind === "front" ? !opts.skipFrontmatter : !opts.skipCodeBlocks;
					if (spoken && rest.trim() !== "") appendToParagraph(verbatimLine(rest, lineStart + from), lineStart + from);
					continue;
				}
				const prefix = containerPrefix(raw);
				const peeled = raw.slice(prefix.chars);
				const fenceLine = fenceAt[lineNo] !== undefined;
				const blockLine = htmlBlockLineAt(raw, lineNo);
				const close = browserCloserAt(
					raw,
					0,
					!fenceLine &&
						!browserInline &&
						!blockLine &&
						!htmlLineAt[lineNo]! &&
						!closesInHeadingAttribute(raw) &&
						!browserSetextText(lineNo),
				);
				const pct = peeled.indexOf("%%");
				const pctAt = raw.length - peeled.length + pct;
				// A callout marker's `%%` is title text, not a block: module 6234 hands
				// the title line to the inline tokenizers alone, so the next line's
				// `-->` still reaches the HTML. Measured: `<!-- a --> x <!-- Z2Q` /
				// `> [!note] %%` / ` Z4Q --> Z5Q` / `  Z6Q` renders an empty title and
				// shows Z5Q and Z6Q. A late `[!note]` is paragraph text, so its `%%` is
				// mid-line and no block either. NRL-131's peel of a callout nested in a
				// list item (`- > [!note] %%`) is what made Ship's fuzz reach this.
				if (!fenceLine && !prefix.callout && pct !== -1 && (close === -1 || pctAt < close) && opensObsidianBlock(peeled, pct, listDedented[lineNo]!)) {
					inComment = "%%";
					inCommentBrowser = false;
					resumeBrowser = true;
					// The app's comment tokenizer, read off the bundle, ends an unclosed
					// block at the end of the text it was handed, which is its
					// container's content. Measured: `- a` / `  %%` / `* b` / `Z8Q` shows b
					// and Z8Q. Where the `%%` line is a lazy one that ends its list instead
					// (`1. a` / `  %% Z5Q` / `1) b`), `containerViews` already put it at the
					// top level, so the block runs to the end of the note.
					pctHome = blockHome(lineNo);
					continue;
				}
				// An inline `<!--` this paragraph line leaves open, with its `-->` later in
				// the same paragraph (term 2's lookahead), is module 4839's inline
				// comment: the `%%` pairs inside it are comment text, not pairs. Measured:
				// `- Z2Q` / `  \t<!-- Z3Q` / `   %%Z4Q --> Z5Q%% Z6Q` under a browser
				// comment closes at that `-->` and shows Z5Q.
				if (close === -1) {
					const lo = raw.lastIndexOf("<!--");
					if (lo !== -1 && raw.indexOf("-->", lo + 4) === -1 && htmlCloserAhead[lineNo]!) browserInline = true;
				}
				if (close === -1) {
					if (fenceLine) {
						flushParagraph();
						inFence = fenceAt[lineNo] === "open";
						fenceHome = inFence ? blockHome(lineNo) : undefined;
					}
					continue;
				}
				inComment = undefined;
				inCommentBrowser = false;
				readWhole = closeBrowserComment(raw, close, lineStart, lineNo);
				if (!readWhole) continue;
			} else {
				const close = raw.indexOf(inComment);
				if (close === -1) continue;
				if (!resumeBrowser) {
					appendRemainder(raw, close + inComment.length, lineStart, lineNo);
					continue;
				}
				// The `%%` block opened under a browser comment has closed; the
				// browser comment has not, unless its `-->` follows on this line
				// outside an inline `%%` pair.
				resumeBrowser = false;
				const browserClose = browserCloserAt(raw, close + 2, !closesInHeadingAttribute(raw) && !browserSetextText(lineNo));
				if (browserClose === -1) {
					inComment = "-->";
					inCommentBrowser = true;
					continue;
				}
				readWhole = closeBrowserComment(raw, browserClose, lineStart, lineNo);
				if (!readWhole) continue;
			}
			// Falls through only for readWhole: the heading is processed below as an
			// ordinary line, with no comment open.
		}

		const wasBlank = prevBlank;
		const wasPara = prevPara;
		const wasContainer = prevContainer;
		// NRL-158: read before computing `blank`, which needs to know whether
		// a paragraph is open to tell a tab-bearing lazy continuation from
		// the blank line that would end it (blankEndsParagraph).
		const blank = blankEndsParagraph(raw, wasPara);
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
		//
		// Opener and closer are tested separately (NRL-156/NRL-132, ADR 0025):
		// an opener after an open paragraph is module 8607's continuation (at
		// most three spaces, no tab), while a fresh-block opener is anything but
		// a leading four spaces or a tab (module 134's indented code) - exactly
		// containerViews' own fence test, reused here as `fenceOpensAt` rather
		// than re-derived. A closer never depends on an open paragraph, so it
		// keeps the renderer's plain three-space cap (`BLOCK_END_FENCE`)
		// unconditionally; char/length pairing with the opener is a separate,
		// pre-existing, out-of-scope simplification (NRL-132's own AC), not
		// touched here.
		if (!inFence) {
			const fenceLead = raw.match(/^[ \t]*/)![0];
			if (fenceOpensAt(fenceLead, wasPara) && FENCE.test(raw)) {
				flushParagraph();
				inFence = true;
				continue;
			}
		} else if (BLOCK_END_FENCE.test(raw)) {
			flushParagraph();
			inFence = false;
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
		//
		// The underline is Obsidian's EXACT shape, not CommonMark's: no leading
		// and no trailing whitespace, and exactly ONE content line above it
		// (the buffer started on the previous line). Read off Obsidian 1.13.7's
		// own MarkdownRenderer on 2026-10-01 (NRL-120): `x` / ` ===`, `x` /
		// `=== ` and `a` / `x` / `===` all render as one <p> showing the `===`,
		// while `x` / `===` and `x` / `=` render <h1>. Under skipHeadings the
		// wide `SETEXT` dropped those paragraphs as headings, which is what let
		// NRL-120's `$$` stop newly lose prose: once the stop kept a `<!--`
		// literal, the loose underline after it was reached. A shape refused
		// here falls through to HR (` ---` is a rule in Obsidian too) or to
		// the paragraph, both of which speak; this can only stop dropping text.
		// `SETEXT` itself is unchanged, because interruptsParagraph shares it.
		if (
			wasPara &&
			!wasInList &&
			paraText !== "" &&
			SETEXT_UNDERLINE_EXACT.test(raw) &&
			paraStart >= lineStarts[lineNo - 1]!
		) {
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
				// The synthetic word is kept or dropped WHOLE, by the opener's offset, and
				// so bypasses the per-character drop in `speak`: its last letter maps to
				// the closer, and dropping that alone spoke `equatio` (/critique on
				// 383f85c, F7).
				if (dropHiddenText("$", [open], hiddenSpans).text !== "") chunks.push(...splitSentences("equation", [open, open, open, open, open, open, open, last], open, segmentCtx, "other"));
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
		if (blockType === "quote" || blockType === "list") prevContainer = true;
		// Driven off `outerList` and NOT off `blockType === "list"` (NRL-131). A
		// quoted list ends with its quote, so it does not hold the list state
		// that shields later indented lines from being code - which is why the
		// question is "is the OUTERMOST container a list", not "what construct
		// does this line belong to". The two agreed until a quote nested inside
		// a list item started reporting blockType "quote"; reading blockType
		// here would stop setting `inList` for `- > x` and make a four-space
		// continuation of it newly read as indented code.
		if (prefix.outerList) inList = true;
		const body = raw.slice(prefixChars);

		if (body.trim() === "") {
			// NRL-158: a tab-bearing whitespace-only line, with the top-level
			// paragraph still open (wasPara), is module 8607's lazy
			// continuation rather than the blank line that would end it.
			// Gated on this line's OWN blockType === "paragraph", not only on
			// wasPara, so a fresh quote/list marker (whose body also happens
			// to be blank) is never misread as continuing whatever came
			// before it - blockType === "quote"/"list" already took the
			// prevContainer branch above regardless of what follows here.
			// Nothing to speak and no sourceIndex entry of its own: the next
			// real line's appendToParagraph call accounts for the swallowed
			// line through the same join-space synthesis every other
			// soft-wrapped continuation uses.
			if (blockType === "paragraph" && !blankEndsParagraph(body, wasPara)) {
				prevPara = true;
				continue;
			}
			flushParagraph();
			continue;
		}
		if (/^[-*_]{3,}$/.test(body.trim())) {
			flushParagraph();
			continue;
		}
		// A FENCE line that is the first content of a list item opened on this very
		// line at column 0 (`- ~~~ js`, `1. >    ~~~ js`): the fence and its info
		// string are never displayed, as the top-level `FENCE` branch above says of
		// an unquoted one, but that branch reads the RAW line, so these were spoken
		// as prose (NRL-114 fix round 1). Base spoke them too, but a `%%` above that
		// base wrongly read as an open block used to silence them, and the narrower
		// peel's correct reading of that `%%` exposed them. Only the fence LINE is
		// dropped; no fence state is kept, so the code inside stays spoken as prose
		// exactly as before.
		//
		// Deliberately this narrow, because every wider form was measured dropping
		// text the renderer DISPLAYS: a fence line inside a quote can be CONTENT of a
		// quoted fence opened above it (`>  ` + fence / `> -\t ~~~ x`), a `[!note]`
		// line is a callout title only on a quote's first line and paragraph text
		// anywhere else, and a raw HTML block or a `$$` block swallows what follows.
		// A marker at column 0 starts a new top-level item, which no quoted or
		// item-local fence can hold; `FENCE` on the raw line already handles a fence
		// at the top level; and the backward scan refuses whenever an HTML block or
		// a math block may still be open. A line holding a comment opener is left to
		// the old path, so no comment state moves here.
		//
		// The second arm is a callout whose TITLE is a fence (`> [!note] ~~~ js`):
		// module 6234 tokenizes the title on its own, so the fence there is a
		// block that displays nothing. Only on a `[!type]` line that STARTS a quote
		// (`calloutTitleAt`), since on any later line of a quote it is paragraph
		// text the renderer displays; the title is the text after the marker less
		// ONE whitespace character, which is how `[!note] \t%%` comes out as
		// indented code there.
		if (
			((TOP_ITEM_MARKER.test(raw) && !prefix.callout && CONTAINER_FENCE_LINE.test(body) && itemStartsBlock(lines, lineNo)) ||
				(prefix.callout && calloutTitleAt[lineNo]! && CONTAINER_FENCE_LINE.test(/\s*$/.exec(raw.slice(0, prefixChars))![0].slice(1) + body))) &&
			!body.includes("%%") &&
			!body.includes("<!--") &&
			!(rawOrMathOpen ??= rawOrMathBlockMayBeOpenTable(lines, true))[lineNo]!
		) {
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
		const htmlClosesLater = htmlClosesLaterAt[lineNo]!;
		const htmlBodyOkLater = htmlBodyOkLaterAt[lineNo]!;
		const percentOpens = percentOpensAt[lineNo];
		const dedentedByList = listDedented[lineNo]!;
		const isSetextContent = setextContent[lineNo]!;
		// A refused `<!--` line still STARTS a block: `html` fires on it in the
		// `interruptParagraph` walk before `setextHeading` claims it, so the
		// paragraph above ends here and only this line is the heading's content.
		// Without the flush the line joins the paragraph above, the underline then
		// turns that whole buffer into a heading, and under skipHeadings the earlier
		// prose is dropped. Found by the fuzz as NEWLY LOST text (34 cells), not by
		// the census, whose rows never put prose directly above the opener with
		// skipHeadings on (NRL-120).
		if (isSetextContent && blockType === "paragraph") flushParagraph();
		const leadIndented = htmlLeadIndented[lineNo]!;
		// A container line whose dedented body is module 134 indented code opens
		// no `%%` block either (NRL-114), for the same reason its `<!--` opens
		// none: the renderer has a code block there. Found by this ticket's census:
		// in `>\t> Plain prose` / `>\t> \t<!--` / ... / `>\t> %% TAILAFTERZ`
		// every line is code inside the quote, and once the `<!--` was correctly
		// declined the `%%` - put at offset 0 by the peel's between-levels tab
		// (NRL-114's residual (a)) - opened a block that silenced the rest.
		const codeLine = htmlLeadCode[lineNo]!;
		// NRL-136's block term is decided here, where the document state is. A
		// heading's content is inline, so it never reaches it (`# <!-- y --> <!-- Q`
		// renders the second `<!--` escaped and displays it), and neither does
		// setext heading content, which NRL-120 established wins over `html`.
		// Main's NRL-114 / NRL-115 facts say the renderer never offers this line to
		// its HTML block tokenizer at all (a lazy continuation, or module 134 code
		// in a container), so it cannot be an HTML block line either.
		const htmlContext: HtmlContext =
			blockType !== "heading" &&
			!leadIndented &&
			!codeLine &&
			!literalAt[lineNo]! &&
			!setextLike[lineNo]! &&
			!lateCallout(lineNo) &&
			containerLeadOk(raw, prefixChars) &&
			htmlBlockLine(body, listStrip[lineNo]!, htmlParaOpen[lineNo]!)
				? "block"
				: "none";
		let cleaned = cleanLine(body, lineStart + prefixChars, stripOpts, true, carriedCode, undefined, carriedBracket, undefined, htmlClosesLater, carriedBracketDepth, dedentedByList, isSetextContent, leadIndented, codeLine, htmlContext, htmlBodyOkLater, percentOpens);
		let confirmed: number | undefined;
		if (
			blockType === "paragraph" &&
			cleaned.openCode !== undefined &&
			codeSpanClosesLater(lines, lineNo, cleaned.openCode, htmlClosesLaterAt, listDedented, htmlLeadIndented, listStrip)
		) {
			confirmed = cleaned.openCode;
			cleaned = cleanLine(body, lineStart + prefixChars, stripOpts, true, carriedCode, confirmed, carriedBracket, undefined, htmlClosesLater, carriedBracketDepth, dedentedByList, isSetextContent, leadIndented, codeLine, htmlContext, htmlBodyOkLater, percentOpens);
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
			bracketClosesLater(lines, lineNo, htmlClosesLaterAt, listDedented, htmlLeadIndented, htmlLeadLazy, htmlLeadCode, listStrip)
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
				isSetextContent,
				leadIndented,
				codeLine,
				htmlContext,
				htmlBodyOkLater,
				percentOpens,
			);
		}
		// Taken from the SECOND pass on purpose. A comment delimiter inside the
		// confirmed tail is code content, so it opens nothing - which is the same
		// reading of ADR 0006 clause 4 that NRL-44 applied to continuation lines,
		// not a new hole. It cannot hide anything either: a line that leaves a
		// comment open is an opensHiddenComment line, and codeSpanClosesLater
		// rejects those at both ends, so no confirmation exists on such a line.
		inComment = cleaned.openComment;
		scopeComment(lineNo);
		// Only a TOP-LEVEL HTML block is trusted to run to its `-->` line. Inside
		// a list item or a quote the block ends with its container, so the line
		// that closes the comment need not be raw at all: measured, `- [ ] <!-- Q`
		// / a fence / ` x --> y <!-- Z` displays Z as code. Such an opener keeps
		// the pre-NRL-136 remainder behaviour.
		inCommentBlock = cleaned.openCommentBlock === true && prefixChars === 0 && !dedentedByList;
		inCommentBrowser = cleaned.openCommentBrowser === true;
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
			chunks.push(...speak(cleaned.text, cleaned.index, lineStart + prefixChars, blockType));
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
