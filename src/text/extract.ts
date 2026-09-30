import type { BlockType, SpeechChunk } from "../audio/types";
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
}

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
 * Windows-style target is split the same way a vault-relative one is (ADR 0014).
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
 * Strip inline markdown from a single line, recording source offsets.
 *
 * `incomingCode` is the length of a backtick run opened on an earlier line
 * that extractChunks has already confirmed a later line closes. Everything
 * before that closing run on this line is code content, so a comment
 * delimiter in it is literal text rather than a comment, exactly as it
 * already is inside a single-line span.
 */
function cleanLine(
	raw: string,
	rawStart: number,
	opts: StripOptions,
	blockComments = false,
	incomingCode?: number,
): Cleaned {
	const chars: string[] = [];
	const index: number[] = [];

	// Where the carried code span closes on this line, and how far the literal
	// region reaches. -1 for closerRun means the span continues past this line,
	// so the whole line is literal; literalCodeEnd of -1 means no carried span
	// at all, and every `i >= literalCodeEnd` test below is then vacuously true.
	// A carried span is honoured only when code is spoken: silencing a
	// soft-wrapped span is a separate defect, so the skipInlineCode path stays
	// byte for byte as it was.
	const carrying = incomingCode !== undefined && !opts.skipInlineCode;
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
		// shaped for the same reason the path is (ADR 0014).
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
		// read aloud (R-M09, ADR 0014). The same finalSegment() the embed guard
		// classified with, so the two can never disagree about which part of the
		// target is a name. The dropped prefix needs no space of its own - both
		// call sites pushSpace before the label, so the words either side are
		// already separated.
		const seg = finalSegment(path);
		const segStart = innerStart + seg.start;
		const segEnd = segStart + seg.text.length;

		// The target is a path, not prose, so it is emitted directly rather
		// than re-cleaned: the tag branch would otherwise eat `#Section`
		// when stripTags is on. A `#` separates note from heading and is
		// read as a pause. `#^id` is a block id, opaque and unspeakable.
		for (let k = segStart; k < targetEnd; k++) {
			// The trailing separator run finalSegment() stepped back over.
			if (k >= segEnd && k < pathEnd) continue;
			const c = raw[k]!;
			if (c === "#" && raw[k + 1] === "^") break;
			if (c === "#" || /\s/.test(c)) pushSpace(rawStart + k);
			else emit(c, rawStart + k);
		}
	};

	let openComment: CommentCloser | undefined;
	// A carried span that this line does not close stays open, so a span may
	// cross several soft line breaks. It owns the carry ahead of any run opened
	// on this line, being the outer and earlier opener.
	let openCode: number | undefined = carrying && closerRun === -1 ? incomingCode : undefined;
	let i = 0;

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
			if (close !== -1 && !opts.skipInlineCode) {
				pushSpace(rawStart + i);
				for (let k = start; k < close; k++) {
					if (/\s/.test(raw[k]!)) pushSpace(rawStart + k);
					else emit(raw[k]!, rawStart + k);
				}
			} else if (close === -1 && !opts.skipInlineCode) {
				// CommonMark's first-unmatched-opener rule: a later run on the
				// same line never takes the carry from an earlier one.
				openCode ??= start - i;
			}
			i = end;
			pushSpace(rawStart + i);
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
			if (close === -1 && obsidianComment && !(blockComments && raw.slice(0, i).trim() === "")) {
				emit("%", rawStart + i);
				emit("%", rawStart + i + 1);
				i += 2;
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
			const close = inlineContainerClose(raw, i + 3, "]]");
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
			const close = inlineContainerClose(raw, i + 2, "]]");
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

	return { text: chars.join(""), index, openComment, openCode };
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
/**
 * Setext underline. Only an underline when a paragraph line sits directly
 * above it; otherwise "---" is a rule and "===" is text, so this is checked
 * against parse state before HR.
 */
const SETEXT = /^ {0,3}(?:=+|-+)\s*$/;
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
 * Does this line leave a comment open, so that the lines after it are hidden?
 *
 * Two shapes, matching the branch in cleanLine: an Obsidian block opener, which
 * is `%%` with only whitespace before it and no `%%` closer later on the line;
 * and an HTML `<!--` with no `-->` after it on the line. A `%%...%%` pair or a
 * `<!--...-->` pair closes on its own line and hides nothing beyond it, so
 * neither counts.
 *
 * This is a paragraph-ending condition, which is why it lives next to
 * interruptsParagraph. Obsidian 1.13.7's Reading-view parser puts `comment` in
 * `interruptParagraph` and already has `html` there, so an opening comment line
 * terminates the paragraph before any inline tokenizing happens and a code span
 * can never contain one. Read off the installed parser, not observed live.
 */
function opensHiddenComment(line: string): boolean {
	const pct = line.indexOf("%%");
	if (pct !== -1 && line.slice(0, pct).trim() === "" && line.indexOf("%%", pct + 2) === -1) return true;
	const html = line.indexOf("<!--");
	return html !== -1 && line.indexOf("-->", html + 4) === -1;
}

/**
 * A line that starts its own block, so a paragraph, and with it any code span
 * inside that paragraph, cannot continue across it. A blank line counts too,
 * and so does a line that opens a comment: the text it hides is not code
 * content, and treating it as such reads that text aloud.
 */
function interruptsParagraph(line: string): boolean {
	return (
		line.trim() === "" ||
		FENCE.test(line) ||
		HEADING.test(line) ||
		HR.test(line) ||
		SETEXT.test(line) ||
		TABLE_ROW.test(line) ||
		LIST_BULLET.test(line) ||
		BLOCKQUOTE.test(line) ||
		opensHiddenComment(line)
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
function codeSpanClosesLater(lines: string[], from: number, len: number): boolean {
	if (interruptsParagraph(lines[from]!)) return false;
	for (let n = from + 1; n < lines.length; n++) {
		const line = lines[n]!;
		if (interruptsParagraph(line)) return false;
		if (firstRunOfLength(line, len, 0) !== -1) return true;
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
	const appendRemainder = (raw: string, from: number, lineStart: number): void => {
		const cleaned = cleanLine(raw.slice(from), lineStart + from, stripOpts, true);
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
			appendRemainder(raw, close + inComment.length, lineStart);
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
				appendRemainder(lines[closeLine]!, closeAt + 2, lineStarts[closeLine]!);
				continue;
			}
		}
		let body = raw;
		let prefixChars = 0;
		// The block scan already knows which construct this line belongs to, so
		// it says so rather than setting a boolean and throwing the answer away.
		// "paragraph" is the else: a plain prose line, and also a lazy
		// continuation of a list or quote, which matches nothing on its own line.
		let blockType: BlockType = "paragraph";
		const m = raw.match(HEADING);
		if (m) {
			prefixChars = m[0].length;
			blockType = "heading";
		} else {
			// Peel prefixes in order, each adding to prefixChars so cleanLine gets
			// the true raw offset of the first kept character: quote levels, then
			// a callout marker, or else a list marker and its task checkbox.
			const q = raw.match(BLOCKQUOTE);
			if (q) {
				prefixChars = q[0].length;
				blockType = "quote";
				prevContainer = true;
			}
			const callout = q ? raw.slice(prefixChars).match(CALLOUT) : null;
			if (callout) {
				prefixChars += callout[0].length;
			} else {
				const b = raw.slice(prefixChars).match(LIST_BULLET);
				if (b) {
					prefixChars += b[0].length;
					// Only a line that is not already a quote is a list. A quoted
					// list item matches both matchers, and the outer construct is
					// the quote, because BLOCKQUOTE is peeled above before
					// LIST_BULLET is even tried - the same order the `if (!q)
					// inList = true` below already draws. Without the guard the
					// two writes would race and the inner one would win.
					if (blockType === "paragraph") blockType = "list";
					prevContainer = true;
					// A quoted list ends with its quote, so it does not hold the
					// list state that shields later indented lines from being code.
					if (!q) inList = true;
					const task = raw.slice(prefixChars).match(TASK);
					if (task) prefixChars += task[0].length;
				}
			}
		}
		body = raw.slice(prefixChars);

		if (body.trim() === "") {
			flushParagraph();
			continue;
		}
		if (/^[-*_]{3,}$/.test(body.trim())) {
			flushParagraph();
			continue;
		}

		const cleaned = cleanLine(body, lineStart + prefixChars, stripOpts, true, carriedCode);
		inComment = cleaned.openComment;
		// Output exclusions do not exclude parsing: an HTML or Obsidian comment
		// opened in a skipped heading/table must still hide its following lines.
		if ((opts.skipTables && TABLE_ROW.test(raw)) || (opts.skipHeadings && m)) {
			flushParagraph();
			continue;
		}
		if (cleaned.text.trim() === "") continue;

		if (blockType !== "paragraph") {
			flushParagraph();
			chunks.push(...splitSentences(cleaned.text, cleaned.index, lineStart + prefixChars, segmentCtx, blockType));
			continue;
		}

		appendToParagraph(cleaned, lineStart + prefixChars);
		// Only a plain paragraph line can carry a span forward, and only when a
		// later line in the same paragraph really closes it.
		if (cleaned.openCode !== undefined && codeSpanClosesLater(lines, lineNo, cleaned.openCode)) {
			openCode = cleaned.openCode;
		}
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
		// blockType is deliberately not set here. It is decided by the block scan
		// and labelled in the SpeechChunk literal inside splitSentences, so it
		// is already real by the time this post-pass runs. Overwriting it here
		// is what made every chunk read "paragraph" (NRL-17, closed in NRL-50).
	}

	return chunks;
}
