import type { SpeechChunk } from "../audio/types";

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

interface Cleaned {
	text: string;
	/** index[i] is the raw markdown offset that produced text[i]. */
	index: number[];
}

function isWordChar(ch: string): boolean {
	return /[\p{L}\p{N}'’-]/u.test(ch);
}

/** Strip inline markdown from a single line, recording source offsets. */
function cleanLine(raw: string, rawStart: number, opts: StripOptions): Cleaned {
	const chars: string[] = [];
	const index: number[] = [];

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

	let i = 0;

	while (i < raw.length) {
		const ch = raw[i]!;

		// Backslash escape: keep the escaped character, drop the slash.
		if (ch === "\\" && i + 1 < raw.length) {
			emit(raw[i + 1]!, rawStart + i + 1);
			i += 2;
			continue;
		}

		// Inline code: dropped entirely.
		if (ch === "`") {
			const close = raw.indexOf("`", i + 1);
			i = close === -1 ? i + 1 : close + 1;
			pushSpace(rawStart + i);
			continue;
		}

		// Obsidian embed `![[...]]`: dropped. Must precede the image branch, which
		// would stop at the first `]` of `]]` and speak the second. Whether embeds
		// should be spoken is a setting that extract does not read yet (NRL-21).
		if (ch === "!" && raw[i + 1] === "[" && raw[i + 2] === "[") {
			const close = raw.indexOf("]]", i + 3);
			if (close !== -1) {
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
			const close = raw.indexOf("]]", i + 2);
			if (close === -1) {
				// No closer on this line (wikilinks never span lines). Drop just the
				// brackets so the rest of the line is still read as prose.
				pushSpace(rawStart + i);
				i += 2;
				continue;
			}
			const innerStart = i + 2;
			const pipe = raw.indexOf("|", innerStart);
			const hasAlias = pipe !== -1 && pipe < close && raw.slice(pipe + 1, close).trim() !== "";
			pushSpace(rawStart + i);
			if (hasAlias) {
				// The alias is display text the author wrote, so nested markup in
				// it is stripped the same way as a markdown link label.
				const inner = cleanLine(raw.slice(pipe + 1, close), rawStart + pipe + 1, opts);
				for (let k = 0; k < inner.text.length; k++) {
					emit(inner.text[k]!, inner.index[k] ?? rawStart + pipe + 1);
				}
			} else {
				// The target is a path, not prose, so it is emitted directly rather
				// than re-cleaned: the tag branch would otherwise eat `#Section`
				// when stripTags is on. A `#` separates note from heading and is
				// read as a pause. `#^id` is a block id, opaque and unspeakable.
				const targetEnd = pipe !== -1 && pipe < close ? pipe : close;
				for (let k = innerStart; k < targetEnd; k++) {
					const c = raw[k]!;
					if (c === "#" && raw[k + 1] === "^") break;
					if (c === "#" || /\s/.test(c)) pushSpace(rawStart + k);
					else emit(c, rawStart + k);
				}
			}
			i = close + 2;
			pushSpace(rawStart + i);
			continue;
		}

		// Image: dropped entirely, alt text is not prose.
		if (ch === "!" && raw[i + 1] === "[") {
			const close = raw.indexOf("]", i + 2);
			if (close === -1) {
				i += 1;
				continue;
			}
			let after = close + 1;
			if (raw[after] === "(") {
				const paren = raw.indexOf(")", after);
				after = paren === -1 ? after + 1 : paren + 1;
			}
			i = after;
			pushSpace(rawStart + i);
			continue;
		}

		// Link: keep the label, drop the target. Covers inline and reference form.
		if (ch === "[") {
			const close = raw.indexOf("]", i + 1);
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

		// Bare URLs: dropped.
		if (
			(ch === "h" || ch === "w") &&
			/^(https?:\/\/|www\.)/i.test(raw.slice(i, i + 8))
		) {
			let end = i;
			while (end < raw.length && !/\s/.test(raw[end]!)) end += 1;
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

		// Emphasis and strikethrough markers: dropped, contents kept.
		if (ch === "*" || ch === "_" || ch === "~") {
			i += 1;
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

	return { text: chars.join(""), index };
}

interface StripOptions {
	stripTags: boolean;
}

/** Split cleaned text into sentence-ish pieces with offsets preserved. */
function splitSentences(text: string, index: number[], rawStart: number): SpeechChunk[] {
	const chunks: SpeechChunk[] = [];
	const bounds: Array<[number, number]> = [];

	const re = /[.!?…]+["')\]]*\s+/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		bounds.push([last, m.index + m[0].length]);
		last = m.index + m[0].length;
	}
	if (last < text.length) bounds.push([last, text.length]);

	for (const [from, to] of bounds) {
		// Trim, keeping offsets aligned to the trimmed region.
		let s = from;
		let e = to;
		while (s < e && /\s/.test(text[s]!)) s += 1;
		while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
		if (e <= s) continue;
		chunks.push({
			text: text.slice(s, e),
			sourceIndex: index.slice(s, e),
			sourceStart: index[s] ?? rawStart,
			sourceEnd: (index[e - 1] ?? rawStart) + 1,
		});
	}

	return mergeShort(chunks);
}

/** Fold runt fragments forward so we do not synthesise a word at a time. */
function mergeShort(chunks: SpeechChunk[]): SpeechChunk[] {
	const out: SpeechChunk[] = [];
	for (const chunk of chunks) {
		const prev = out[out.length - 1];
		if (prev && chunk.text.length < MIN_CHUNK_CHARS) {
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
	return out.flatMap(splitOversized);
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

/** Hard-split anything past the engine's comfort zone, at a word boundary. */
function splitOversized(chunk: SpeechChunk): SpeechChunk[] {
	if (chunk.text.length <= MAX_CHUNK_CHARS) return [chunk];

	const out: SpeechChunk[] = [];
	let cursor = 0;
	while (cursor < chunk.text.length) {
		let end = Math.min(cursor + MAX_CHUNK_CHARS, chunk.text.length);
		if (end < chunk.text.length) {
			const window = chunk.text.slice(cursor, end);
			const breakAt = window.lastIndexOf(" ");
			if (breakAt > MAX_CHUNK_CHARS * 0.5) end = cursor + breakAt;
		}
		const piece = chunk.text.slice(cursor, end);
		out.push({
			text: piece,
			sourceIndex: chunk.sourceIndex.slice(cursor, end),
			sourceStart: chunk.sourceIndex[cursor] ?? chunk.sourceStart,
			sourceEnd: (chunk.sourceIndex[end - 1] ?? chunk.sourceEnd - 1) + 1,
		});
		cursor = end;
		while (cursor < chunk.text.length && chunk.text[cursor] === " ") cursor += 1;
	}
	return out;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const LIST_BULLET = /^\s{0,3}([-*+]|\d+[.)])\s+/;
const BLOCKQUOTE = /^\s{0,3}>\s?/;
const TABLE_ROW = /^\s*\|/;
/**
 * Thematic break: three or more of the same marker, optionally spaced. Checked
 * before LIST_BULLET because "- - -" would otherwise read as a bullet whose
 * body is "- -", and the dashes would be spoken.
 */
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

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
 * Returns the line number of the closing fence, or null.
 */
function detectFrontmatter(lines: string[]): { endLine: number } | null {
	let open = 0;
	while (open < lines.length && lines[open]!.replace(/^\uFEFF/, "").trim() === "") open += 1;
	if (open >= lines.length || !isFrontmatterFence(lines[open]!)) return null;

	let sawKey = false;
	let flowDepth = 0;
	for (let n = open + 1; n < lines.length; n++) {
		const line = lines[n]!;
		if (isFrontmatterFence(line)) return sawKey ? { endLine: n } : null;
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

export interface ExtractOptions {
	stripTags: boolean;
	skipUrls: boolean;
	skipCode: boolean;
	skipTables: boolean;
	skipHeadings: boolean;
}

/**
 * Turn a markdown note into speakable chunks.
 *
 * Frontmatter is located up front by shape (see detectFrontmatter). The rest
 * works line by line and tracks code-fence state, because that is the only
 * context needed to know whether a `#` is a tag or a heading.
 *
 * Plain paragraph lines are buffered and joined before sentence-splitting.
 * Markdown soft-wraps a paragraph across multiple source lines with no blank
 * line between them, and without this a normally-written note would pause at
 * every wrap point as if each line were its own sentence, not just at actual
 * paragraph breaks. A blank line, a heading, a list item, a blockquote or a
 * table row still flushes the buffer: those keep their own pacing rather than
 * being folded into surrounding prose.
 */
export function extractChunks(source: string, opts: ExtractOptions): SpeechChunk[] {
	const chunks: SpeechChunk[] = [];
	const lines = source.split("\n");

	let rawOffset = 0;
	let inFence = false;
	const frontmatter = detectFrontmatter(lines);

	let paraText = "";
	let paraIndex: number[] = [];
	let paraStart = 0;

	const flushParagraph = (): void => {
		if (paraText.trim() !== "") {
			chunks.push(...splitSentences(paraText, paraIndex, paraStart));
		}
		paraText = "";
		paraIndex = [];
	};

	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const raw = lines[lineNo]!;
		const lineStart = rawOffset;
		rawOffset += raw.length + 1;

		// This deliberately diverges from Obsidian, which only honours a `---`
		// on line 1. A note that starts with blank lines and then a `key: value`
		// block renders in Obsidian as a rule and visible text, and we stay
		// silent on it. That is intended: silence on visible text is
		// recoverable, reading someone's frontmatter aloud is not. Do not "fix"
		// this back to a positional check; see docs/adr/0002.
		//
		// Skipped lines are dropped whole. rawOffset has already advanced past
		// them, so every later sourceIndex entry is still a true raw offset.
		if (frontmatter && lineNo <= frontmatter.endLine) continue;

		if (FENCE.test(raw)) {
			flushParagraph();
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (HR.test(raw)) {
			flushParagraph();
			continue;
		}
		if (opts.skipTables && TABLE_ROW.test(raw)) {
			flushParagraph();
			continue;
		}

		let body = raw;
		let prefixChars = 0;
		let isStructural = false;
		const m = raw.match(HEADING);
		if (m) {
			if (opts.skipHeadings) {
				flushParagraph();
				continue;
			}
			prefixChars = m[0].length;
			isStructural = true;
		} else {
			const b = raw.match(BLOCKQUOTE) ?? raw.match(LIST_BULLET);
			if (b) {
				prefixChars = b[0].length;
				isStructural = true;
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

		const cleaned = cleanLine(body, lineStart + prefixChars, {
			stripTags: opts.stripTags,
		});
		if (cleaned.text.trim() === "") continue;

		if (isStructural) {
			flushParagraph();
			chunks.push(...splitSentences(cleaned.text, cleaned.index, lineStart + prefixChars));
			continue;
		}

		if (paraText === "") {
			paraText = cleaned.text;
			paraIndex = cleaned.index;
			paraStart = lineStart + prefixChars;
		} else {
			// Same join convention as mergeShort: the space between the two
			// lines is synthetic, so it is attributed to the character right
			// before whatever comes next.
			const gap = sourceOffsetOfSpace(
				(paraIndex[paraIndex.length - 1] ?? paraStart) + 1,
				cleaned.index[0] ?? lineStart + prefixChars,
			);
			paraText = `${paraText} ${cleaned.text}`;
			paraIndex = [...paraIndex, gap, ...cleaned.index];
		}
	}

	flushParagraph();

	return chunks;
}
