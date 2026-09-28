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
 * Works line by line and tracks block state (frontmatter, code fences) because
 * that is the only context needed to know whether a `#` is a tag or a heading.
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
	let inFrontmatter = false;
	let frontmatterDone = false;
	let inFence = false;

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

		if (lineNo === 0 && raw.trim() === "---") {
			inFrontmatter = true;
			continue;
		}
		if (inFrontmatter) {
			if (raw.trim() === "---") {
				inFrontmatter = false;
				frontmatterDone = true;
			}
			continue;
		}
		void frontmatterDone;

		if (FENCE.test(raw)) {
			flushParagraph();
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
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
