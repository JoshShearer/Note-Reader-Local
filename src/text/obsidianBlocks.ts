/*
 * Third-party notices. Parts of this file are transcriptions of MIT-licensed
 * code as Obsidian bundles it:
 *
 *   remark-parse 8 (block tokenizers, interrupt sets, remove-indentation)
 *     Copyright (c) Titus Wormer <tituswormer@gmail.com>
 *   remark-math 3 (the `$$` block tokenizer, identified by structure)
 *     Copyright (c) Junyoung Choi <fluke8259@gmail.com>
 *   remark-footnotes 2 (the footnote definition tokenizer, identified by structure)
 *     Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * The `%%` comment tokenizer, the block-id pattern, the `[^` definition refusal
 * and the frontmatter rule reproduce Obsidian's own behaviour; see ADR 0006
 * clause 5's provenance note.
 */

/**
 * Where Obsidian's reading view ENDS a `%%` comment block (NRL-118, ADR 0006
 * clause 5).
 *
 * Obsidian 1.13.7 parses a note with remark-parse 8 (`commonmark: true`,
 * `gfm: true`, `pedantic: false`) plus block tokenizers it registers for
 * frontmatter, `$$` math, `%%` comments, footnote definitions and block ids.
 * That parser is recursive: a blockquote, a list item or a footnote definition
 * first COLLECTS its lines by a line-based loop, rewrites them (a quote drops
 * its `>`, a list item drops its marker and dedents the rest), and only then
 * tokenizes the rewritten text as a fresh run of blocks. So a `%%` block that
 * opens inside a container can never see past the container's last line: it
 * ends there, closed or not, and the next line belongs to whatever the
 * container's parent makes of it.
 *
 * Earlier attempts at NRL-118 approximated that with a per-line column model
 * (peel a `>`, compare an indent with a content column, test a handful of
 * interrupter regexes). Every one of them ended a block somewhere the renderer
 * does not, because the renderer's rules are not column rules: a list item's
 * content is dedented by the SMALLEST indent among its non-blank lines (so the
 * same line reads differently depending on its neighbours), a lazy line is
 * judged by the parent's text and not the item's, a tab is removed whole, and
 * an ordered marker below ten with an odd-length prefix gains a phantom space.
 * Independent Verify found seven shapes the column model got wrong.
 *
 * So this module does not approximate. It re-runs the renderer's block
 * tokenizer, transcribed from the shipped bundle (`app.js` sha256
 * `8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898`): the
 * same method order, the same interrupt sets with the same option gates, the
 * same container collection loops and content rewrites, recursing exactly where
 * the renderer recurses. It records every `%%` block comment the renderer
 * would create, with the note line it starts on and the note line holding its
 * last character. It does not decide what is spoken; `extractChunks` uses it
 * only to END a `%%` block that the extractor itself opened on the same line
 * and that the renderer also opened there, at the line where the renderer's
 * comment runs out of container (see `percentBlockEnds`).
 *
 * The tokenizers are transcriptions, so their odd spellings (the `v + 1` in the
 * math closer search, `slice(k, 1024)` in the footnote interrupt) are the
 * renderer's own and are kept on purpose, and so is Obsidian's wrapper that
 * refuses a `[^` definition label. Two places compute the bundle's answer more
 * cheaply than the bundle does (a table row's pipe search, a definition label's
 * close), because the bundle's way is quadratic on long notes; each says so
 * where it happens. Validated differentially against the real parser executed
 * out of the bundle (ADR 0006 clause 5 records the corpora). An Obsidian update
 * can change any tokenizer here, so that differential must be re-run against a
 * new bundle before this is trusted again. Reading view only; Live Preview is
 * separate code. Nothing here logs, and nothing here touches note text beyond
 * reading it.
 */

/** One `%%` block comment as the reading view's parser creates it. */
export interface RendererPercentBlock {
	/** 0-based note line the comment starts on (its opening `%%` is there). */
	startLine: number;
	/** 0-based note line holding the comment's last eaten character. */
	lastLine: number;
	/** 0-based note line of the position just past the comment (the parser's own `end.line`, 0-based). */
	endLine: number;
	/** True when a closing `%%` ended it; false when its container (or the note) ran out. */
	closed: boolean;
}

type Tokenizer = (t: string, silent: boolean, line: number) => number;
type InterruptEntry = readonly [string, { pedantic?: boolean; commonmark?: boolean }?];

/** Deepest container nesting scanned before giving up (see BlockScanner.depth). */
const MAX_DEPTH = 64;

// Obsidian's effective option set, as `VT.globalOptions` plus the defaults.
const OPT_PEDANTIC = false;
const OPT_COMMONMARK = true;

// The block-level HTML names (`options.blocks`), read off the running parser.
const HTML_BLOCK_NAMES =
	"address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|" +
	"fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hgroup|hr|html|iframe|legend|" +
	"li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|pre|section|source|title|summary|table|" +
	"tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_OPEN_TAG =
	"<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^\"'=<>`\\u0000-\\u0020]+|'[^']*'|\"[^\"]*\"))?)*\\s*\\/?>";
const HTML_CLOSE_TAG = "<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>";
const HTML_KINDS: ReadonlyArray<readonly [RegExp, RegExp, boolean]> = [
	[/^<(script|pre|style)(?=(\s|>|$))/i, /<\/(script|pre|style)>/i, true],
	[/^<!--/, /-->/, true],
	[/^<\?/, /\?>/, true],
	[/^<![A-Za-z]/, />/, true],
	[/^<!\[CDATA\[/, /]]>/, true],
	[new RegExp("^</?(" + HTML_BLOCK_NAMES + ")(?=(\\s|/?>|$))", "i"), /^$/, true],
	[new RegExp("^(?:" + HTML_OPEN_TAG + "|" + HTML_CLOSE_TAG + ")\\s*$"), /^$/, false],
];

/** The definition label's closing `]`, walking from `from` with a backslash consuming the next character. */
function labelCloseScan(t: string, from: number): number {
	let D = from;
	while (D < t.length) {
		const c = t.charCodeAt(D);
		if (c === 93) return D;
		D += c === 92 ? 2 : 1;
	}
	return -1;
}

const isDigit = (ch: string): boolean => {
	const c = ch.charCodeAt(0);
	return c >= 48 && c <= 57;
};
const isWhitespaceChar = (ch: string): boolean => /\s/.test(ch);

/** Indent of a line's leading whitespace, a tab rounding up to a stop of four (remark's `get-indentation`). */
function indentation(value: string): number {
	let indent = 0;
	for (let k = 0; k < value.length; k++) {
		const ch = value.charCodeAt(k);
		if (ch === 32) indent += 1;
		else if (ch === 9) indent = Math.floor((indent + 4) / 4) * 4;
		else break;
	}
	return indent;
}

/**
 * Remove `cols` columns of leading whitespace the way remark's
 * `remove-indentation` does: whole characters only, so a tab that covers
 * column `cols` is removed whole, and a line indented less than `cols` loses
 * all of its leading whitespace. (remark builds a column-to-character map for
 * every line and walks it back; this computes the same cut without the map.)
 */
function sliceIndent(line: string, cols: number): string {
	if (cols <= 0) return line;
	let col = 0;
	let k = 0;
	for (; k < line.length; k++) {
		const ch = line.charCodeAt(k);
		if (ch === 32) col += 1;
		else if (ch === 9) col = Math.floor((col + 4) / 4) * 4;
		else break;
		if (col >= cols) return line.slice(k + 1);
	}
	return line.slice(k);
}

/** remark's `remove-indentation`, called by the list item rewrite with `maximum` and no hard stop. */
function removeIndentation(value: string, maximum: number): string {
	const values = value.split("\n");
	// The bundle seeds the minimum with a sentinel line indented `maximum`
	// columns, so the cut never exceeds the item's own content column, and it
	// ignores blank lines and lines with no indent at all.
	let minIndent = maximum > 0 ? maximum : Infinity;
	for (const line of values) {
		if (line.trim().length === 0) continue;
		const indent = indentation(line);
		if (indent > 0 && indent < minIndent) minIndent = indent;
	}
	if (minIndent === Infinity) return value;
	return values.map((line) => sliceIndent(line, minIndent)).join("\n");
}

const LIST_ITEM_HEAD = /^([ \t]*)([*+-]|\d+[.)])( {1,4}(?! )| |\t|$|(?=\n))([^\n]*)/;
const TASK_BOX = /^\[(.)][ \t]/;

/** The list item content rewrite (remark's normal-mode `normalListItem` plus the gfm task box). */
function listItemContent(item: string, line: number, stripped: number[]): string {
	let rest = "";
	let bullet = "";
	const replaced = item.replace(LIST_ITEM_HEAD, (_m, lead: string, marker: string, spacing: string, content: string) => {
		const whole = lead + marker + spacing;
		rest = content;
		if (Number(marker) < 10 && whole.length % 2 === 1) marker = " " + marker;
		bullet = lead + " ".repeat(marker.length) + spacing;
		return bullet + content;
	});
	const before = replaced.split("\n");
	const lines = removeIndentation(replaced, indentation(bullet)).split("\n");
	lines[0] = rest;
	stripped[line] = (stripped[line] ?? 0) + (item.length - item.replace(LIST_ITEM_HEAD, (_m, _l, _k, _s, c: string) => c).length);
	for (let k = 1; k < before.length; k++) stripped[line + k] = (stripped[line + k] ?? 0) + before[k]!.length - lines[k]!.length;
	let out = lines.join("\n");
	const task = TASK_BOX.exec(out);
	if (task) {
		out = out.slice(task[0].length);
		stripped[line] += task[0].length;
	}
	return out;
}

class BlockScanner {
	readonly found: RendererPercentBlock[] = [];
	private atStart = true;
	// Container nesting depth of the current tokenizeBlock call. Each level
	// rescans its own rewritten content, so the cost is O(depth x length); past
	// MAX_DEPTH the scan gives up and the caller keeps its own behaviour, which
	// bounds a pathological note (hundreds of nested items) instead of stalling.
	private depth = 0;
	// The content string and offset the driver is tokenizing right now, so the
	// definition tokenizer can use a memoized label-close table for it.
	private curValue = "";
	private curPos = 0;
	private readonly closeTables = new Map<string, Int32Array>();
	// remark's per-line offset table: how many leading characters of each note
	// line the enclosing containers stripped before handing it on (a quote's `>`,
	// an item's marker and dedent, a footnote's label). It is what maps a
	// position in a container's rewritten text back onto the note, and a comment
	// that ends at the start of a stripped line ends ON that line in the note.
	private readonly stripped: number[] = [];
	private readonly tokenizers: Record<string, Tokenizer>;
	private readonly methods = [
		"frontmatter",
		"blankLine",
		"indentedCode",
		"math",
		"comment",
		"fencedCode",
		"blockquote",
		"atxHeading",
		"thematicBreak",
		"list",
		"setextHeading",
		"html",
		"footnoteDefinition",
		"definition",
		"table",
		"blockid",
		"paragraph",
	];
	private readonly interruptParagraph: InterruptEntry[] = [
		["thematicBreak"],
		["list"],
		["atxHeading"],
		["fencedCode"],
		["comment"],
		["math"],
		["blockquote"],
		["html"],
		["setextHeading", { commonmark: false }],
		["definition", { commonmark: false }],
	];
	private readonly interruptList: InterruptEntry[] = [
		["atxHeading", { pedantic: false }],
		["fencedCode", { pedantic: false }],
		["comment"],
		["math"],
		["thematicBreak", { pedantic: false }],
		["definition", { commonmark: false }],
	];
	private readonly interruptBlockquote: InterruptEntry[] = [
		["indentedCode", { commonmark: true }],
		["fencedCode", { commonmark: true }],
		["comment"],
		["math"],
		["atxHeading", { commonmark: true }],
		["setextHeading", { commonmark: true }],
		["thematicBreak", { commonmark: true }],
		["html", { commonmark: true }],
		["list", { commonmark: true }],
		["definition", { commonmark: false }],
	];
	// Built by Obsidian from blockMethods with no option entries, and run by its
	// own loop that applies no option gate (setextHeading and definition count).
	private readonly interruptFootnote: string[] = [
		"blankLine",
		"math",
		"fencedCode",
		"blockquote",
		"atxHeading",
		"thematicBreak",
		"list",
		"setextHeading",
		"html",
		"definition",
		"table",
		"footnoteDefinition",
	];

	constructor() {
		this.tokenizers = {
			frontmatter: (t, s) => this.frontmatter(t, s),
			blankLine: (t, s) => this.blankLine(t, s),
			indentedCode: (t, s) => this.indentedCode(t, s),
			math: (t, s) => this.math(t, s),
			comment: (t, s, l) => this.comment(t, s, l),
			fencedCode: (t, s) => this.fencedCode(t, s),
			blockquote: (t, s, l) => this.blockquote(t, s, l),
			atxHeading: (t, s) => this.atxHeading(t, s),
			thematicBreak: (t, s) => this.thematicBreak(t, s),
			list: (t, s, l) => this.list(t, s, l),
			setextHeading: (t, s) => this.setextHeading(t, s),
			html: (t, s) => this.html(t, s),
			footnoteDefinition: (t, s, l) => this.footnoteDefinition(t, s, l),
			definition: (t, s) => this.definition(t, s),
			table: (t, s) => this.table(t, s),
			blockid: (t, s) => this.blockid(t, s),
			paragraph: (t, s) => this.paragraph(t, s),
		};
	}

	/** The block tokenizer driver: first method to eat wins; nothing eaten is the bundle's "Infinite loop" failure. */
	tokenizeBlock(value: string, line: number): void {
		if (++this.depth > MAX_DEPTH) throw new Error("renderer block scan nested too deeply");
		let pos = 0;
		while (pos < value.length) {
			const rest = value.slice(pos);
			let eaten = 0;
			for (const name of this.methods) {
				if (name === "frontmatter" && !this.atStart) continue;
				this.curValue = value;
				this.curPos = pos;
				eaten = this.tokenizers[name]!(rest, false, line);
				if (eaten > 0) break;
			}
			if (eaten <= 0) throw new Error("renderer block scan made no progress");
			this.atStart = false;
			for (let k = pos; k < pos + eaten; k++) if (value.charCodeAt(k) === 10) line++;
			pos += eaten;
		}
		this.depth--;
	}

	private interrupts(set: readonly InterruptEntry[], text: string): boolean {
		for (const [name, opts] of set) {
			if (opts?.pedantic !== undefined && opts.pedantic !== OPT_PEDANTIC) continue;
			if (opts?.commonmark !== undefined && opts.commonmark !== OPT_COMMONMARK) continue;
			if (this.tokenizers[name]!(text, true, 0) > 0) return true;
		}
		return false;
	}

	private frontmatter(t: string, silent: boolean): number {
		if (t.slice(0, 3) !== "---" || t.charAt(3) !== "\n") return 0;
		let r = t.indexOf("---", 3);
		while (r !== -1 && t.charAt(r - 1) !== "\n") r = t.indexOf("---", r + 3);
		if (r === -1) return 0;
		return silent ? 1 : r + 3;
	}

	private blankLine(t: string, silent: boolean): number {
		const re = /^[ \t]*(\n|$)/;
		let a = 0;
		const s = t.length;
		let r: RegExpExecArray | null;
		while (a < s && (r = re.exec(t.slice(a))) !== null) {
			if (r[0].length === 0) break;
			a += r[0].length;
		}
		if (a === 0) return 0;
		return silent ? 1 : a;
	}

	private indentedCode(t: string, silent: boolean): number {
		let l: string;
		let u = false;
		let h = -1;
		const p = t.length;
		let d = "";
		let f = "";
		let v = "";
		let m = "";
		while (++h < p) {
			l = t.charAt(h);
			if (u) {
				u = false;
				d += v;
				f += m;
				v = "";
				m = "";
				if (l === "\n") {
					v = l;
					m = l;
				} else {
					d += l;
					f += l;
					while (++h < p) {
						l = t.charAt(h);
						if (!l || l === "\n") {
							m = l;
							v = l;
							break;
						}
						d += l;
						f += l;
					}
				}
			} else if (l === " " && t.charAt(h + 1) === l && t.charAt(h + 2) === l && t.charAt(h + 3) === l) {
				v += "    ";
				h += 3;
				u = true;
			} else if (l === "\t") {
				v += l;
				u = true;
			} else {
				let c = "";
				while (l === "\t" || l === " ") {
					c += l;
					l = t.charAt(++h);
				}
				if (l !== "\n") break;
				v += c + l;
				m += l;
			}
		}
		if (!f) return 0;
		return silent ? 1 : d.length;
	}

	private math(t: string, silent: boolean): number {
		const f = t.length;
		let v = 0;
		while (v < f && t.charCodeAt(v) === 32) v++;
		const s = v;
		while (v < f && t.charCodeAt(v) === 36) v++;
		const l = v - s;
		if (l < 2) return 0;
		while (v < f && t.charCodeAt(v) === 32) v++;
		while (v < f) {
			const i = t.charCodeAt(v);
			if (i === 36) return 0;
			if (i === 10) break;
			v++;
		}
		if (t.charCodeAt(v) !== 10) return 0;
		if (silent) return 1;
		v++;
		let o = t.indexOf("\n", v + 1);
		if (o === -1) o = f;
		while (v < f) {
			let a = o;
			let h = 0;
			while (a > v && t.charCodeAt(a - 1) === 32) a--;
			while (a > v && t.charCodeAt(a - 1) === 36) {
				h++;
				a--;
			}
			if (l <= h && t.indexOf("$", v) === a) break;
			v = o + 1;
			o = t.indexOf("\n", v + 1);
			if (o === -1) o = f;
		}
		return o;
	}

	private comment(t: string, silent: boolean, line: number): number {
		const i = t.length;
		let r = 0;
		while (r < i && t.charCodeAt(r) === 32) r++;
		if (!(t.charCodeAt(r) === 37 && t.charCodeAt(r + 1) === 37)) return 0;
		r += 2;
		while (r < i) {
			const a = t.charCodeAt(r);
			if (a === 37) return 0;
			if (a === 10) break;
			r++;
		}
		if (silent) return 1;
		let s = i;
		let closed = false;
		while (r < i) {
			if (t.charCodeAt(r) === 37 && t.charCodeAt(r + 1) === 37) {
				s = r + 2;
				closed = true;
				break;
			}
			r++;
		}
		let lastLine = line;
		for (let k = 0; k < s - 1; k++) if (t.charCodeAt(k) === 10) lastLine++;
		const endsAtLineStart = s > 0 && t.charCodeAt(s - 1) === 10;
		const endLine = endsAtLineStart ? lastLine + 1 : lastLine;
		// Eaten text that ends with a newline ends at the start of the next
		// rewritten line, which in the note is just past that line's stripped
		// prefix. When the prefix is not empty (a `>`, or an item indent removed
		// from a whitespace-only line) the comment's last character is on that
		// line, so the line is the comment's, exactly as the parser's positions say.
		if (endsAtLineStart && (this.stripped[endLine] ?? 0) > 0) lastLine = endLine;
		this.found.push({ startLine: line, lastLine, endLine, closed });
		return s;
	}

	private fencedCode(t: string, silent: boolean): number {
		const S = t.length + 1;
		let x = 0;
		let T = "";
		let p: string;
		while (x < S && ((p = t.charAt(x)) === " " || p === "\t")) {
			T += p;
			x++;
		}
		const k = x;
		p = t.charAt(x);
		if (p !== "~" && p !== "`") return 0;
		x++;
		const h = p;
		let u = 1;
		T += p;
		while (x < S && (p = t.charAt(x)) === h) {
			T += p;
			u++;
			x++;
		}
		if (u < 3) return 0;
		while (x < S && ((p = t.charAt(x)) === " " || p === "\t")) {
			T += p;
			x++;
		}
		let d = "";
		let m = "";
		while (x < S && (p = t.charAt(x)) !== "\n" && (h !== "`" || p !== h)) {
			if (p === " " || p === "\t") m += p;
			else {
				d += m + p;
				m = "";
			}
			x++;
		}
		p = t.charAt(x);
		if (p && p !== "\n") return 0;
		if (silent) return 1;
		T += d;
		if (m) T += m;
		m = "";
		let b = "";
		let w = "";
		let g = "";
		let first = true;
		while (x < S) {
			g += b;
			b = "";
			w = "";
			p = t.charAt(x);
			if (p === "\n") {
				if (first) {
					T += p;
					first = false;
				} else {
					b += p;
					w += p;
				}
				m = "";
				x++;
				while (x < S && (p = t.charAt(x)) === " ") {
					m += p;
					x++;
				}
				b += m;
				w += m.slice(k);
				if (!(m.length >= 4)) {
					m = "";
					while (x < S && (p = t.charAt(x)) === h) {
						m += p;
						x++;
					}
					b += m;
					w += m;
					if (!(m.length < u)) {
						m = "";
						while (x < S && ((p = t.charAt(x)) === " " || p === "\t")) {
							b += p;
							w += p;
							x++;
						}
						if (!p || p === "\n") break;
					}
				}
			} else {
				g += p;
				x++;
			}
		}
		T += g + b;
		return T.length;
	}

	private blockquote(t: string, silent: boolean, line: number): number {
		const E = t.length;
		let D = 0;
		let c: string;
		while (D < E && ((c = t.charAt(D)) === " " || c === "\t")) D++;
		if (t.charAt(D) !== ">") return 0;
		if (silent) return 1;
		D = 0;
		let callout = false;
		const raw: string[] = [];
		const content: string[] = [];
		const strip: number[] = [];
		while (D < E) {
			const f = D;
			let v = false;
			let h = t.indexOf("\n", D);
			if (h === -1) h = E;
			while (D < E && ((c = t.charAt(D)) === " " || c === "\t")) D++;
			if (t.charAt(D) === ">") {
				D++;
				v = true;
				if (t.charAt(D) === " ") D++;
			} else D = f;
			let p = t.slice(D, h);
			if (!v && !p.trim()) break;
			if (!v && this.interrupts(this.interruptBlockquote, t.slice(D))) break;
			if (f === 0) {
				const P = p.match(/^\[!([^\]]+)\]([+\-]?)(?:\s|$)/);
				if (P) {
					callout = true;
					D += P[0].length;
					p = p.substr(P[0].length);
				}
			}
			raw.push(f === D ? p : t.slice(f, h));
			content.push(p);
			strip.push(D - f);
			D = h + 1;
		}
		const eaten = raw.join("\n").length;
		this.atStart = false;
		for (let k = 0; k < strip.length; k++) this.stripped[line + k] = (this.stripped[line + k] ?? 0) + strip[k]!;
		let at = line;
		if (callout && content[0]) {
			this.tokenizeBlock(content.shift()!, at);
			at += 1;
		}
		this.tokenizeBlock(content.join("\n"), at);
		return eaten;
	}

	private atxHeading(t: string, silent: boolean): number {
		const p = t.length + 1;
		let d = -1;
		let l = "";
		while (++d < p) {
			l = t.charAt(d);
			if (l !== " " && l !== "\t") {
				d--;
				break;
			}
		}
		let u = 0;
		while (++d <= p) {
			l = t.charAt(d);
			if (l !== "#") {
				d--;
				break;
			}
			u++;
		}
		if (u > 6) return 0;
		if (!u || t.charAt(d + 1) === "#") return 0;
		let c = "";
		while (++d < p) {
			l = t.charAt(d);
			if (l !== " " && l !== "\t") {
				d--;
				break;
			}
			c += l;
		}
		if (c.length === 0 && l && l !== "\n") return 0;
		if (silent) return 1;
		const nl = t.indexOf("\n");
		return nl === -1 ? t.length : nl;
	}

	private thematicBreak(t: string, silent: boolean): number {
		let f = -1;
		const v = t.length + 1;
		let u = "";
		while (++f < v && ((u = t.charAt(f)) === "\t" || u === " ")) {
			/* leading whitespace */
		}
		if (u !== "*" && u !== "-" && u !== "_") return 0;
		const h = u;
		let count = 1;
		let eaten = f + 1;
		let pending = 0;
		while (++f < v) {
			u = t.charAt(f);
			if (u === h) {
				count++;
				eaten = f + 1;
				pending = 0;
			} else {
				if (u !== " ") {
					if (count >= 3 && (!u || u === "\n")) return silent ? 1 : eaten + pending;
					return 0;
				}
				pending++;
			}
		}
		return 0;
	}

	private list(t: string, silent: boolean, line: number): number {
		let U = 0;
		const len = t.length;
		let y2 = "";
		while (U < len && ((y2 = t.charAt(U)) === "\t" || y2 === " ")) U++;
		y2 = t.charAt(U);
		let bulletKind: string;
		if (y2 === "*" || y2 === "+" || y2 === "-") bulletKind = y2;
		else {
			let digits = "";
			while (U < len && isDigit((y2 = t.charAt(U)))) {
				digits += y2;
				U++;
			}
			y2 = t.charAt(U);
			if (!digits || !(y2 === "." || (OPT_COMMONMARK && y2 === ")"))) return 0;
			if (silent && digits !== "1") return 0;
			bulletKind = y2;
		}
		y2 = t.charAt(++U);
		if (y2 !== " " && y2 !== "\t" && (OPT_PEDANTIC || (y2 !== "\n" && y2 !== ""))) return 0;
		if (silent) return 1;

		interface Item {
			value: string[];
			indent: number;
			line: number;
		}
		const items: Item[] = [];
		let pending: string[] = [];
		const all: string[] = [];
		let item: Item | null = null;
		let prevBlank = false;
		let blank = false;
		let at = line;
		U = 0;
		while (U < len) {
			const start = U;
			let isItem = false;
			let continued = false;
			let lineEnd = t.indexOf("\n", U);
			if (lineEnd === -1) lineEnd = len;
			let size = 0;
			while (U < len) {
				y2 = t.charAt(U);
				if (y2 === "\t") size += 4 - (size % 4);
				else if (y2 === " ") size++;
				else break;
				U++;
			}
			if (item && size >= item.indent) continued = true;
			y2 = t.charAt(U);
			let marker: string | null = null;
			if (!continued) {
				if (y2 === "*" || y2 === "+" || y2 === "-") {
					marker = y2;
					U++;
					size++;
				} else {
					let digits = "";
					while (U < len && isDigit((y2 = t.charAt(U)))) {
						digits += y2;
						U++;
					}
					y2 = t.charAt(U);
					U++;
					if (digits && (y2 === "." || (OPT_COMMONMARK && y2 === ")"))) {
						marker = y2;
						size += digits.length + 1;
					}
				}
				if (marker) {
					y2 = t.charAt(U);
					if (y2 === "\t") {
						size += 4 - (size % 4);
						U++;
					} else if (y2 === " ") {
						const end = U + 4;
						while (U < end && t.charAt(U) === " ") {
							U++;
							size++;
						}
						if (U === end && t.charAt(U) === " ") {
							U -= 3;
							size -= 3;
						}
					} else if (y2 !== "\n" && y2 !== "") marker = null;
				}
			}
			if (marker) {
				if (!OPT_PEDANTIC && bulletKind !== marker) break;
				isItem = true;
			} else {
				if (OPT_COMMONMARK && item) continued = size >= item.indent || size > 4;
				isItem = false;
				U = start;
			}
			const x = t.slice(start, lineEnd);
			const S = start === U ? x : t.slice(U, lineEnd);
			if ((marker === "*" || marker === "_" || marker === "-") && this.thematicBreak(x, true) > 0) break;
			prevBlank = blank;
			blank = !isItem && !S.trim();
			if (continued && item) {
				item.value.push(...pending, x);
				all.push(...pending, x);
				pending = [];
			} else if (isItem) {
				if (pending.length !== 0 && item) item.value.push("");
				item = { value: [x], indent: size, line: at };
				items.push(item);
				all.push(...pending, x);
				pending = [];
			} else if (blank) {
				if (prevBlank && !OPT_COMMONMARK) break;
				pending.push(x);
			} else {
				if (prevBlank) break;
				if (this.interrupts(this.interruptList, x)) break;
				item!.value.push(...pending, x);
				all.push(...pending, x);
				pending = [];
			}
			U = lineEnd + 1;
			at++;
		}
		const eaten = all.join("\n").length;
		this.atStart = false;
		for (const it of items) this.tokenizeBlock(listItemContent(it.value.join("\n"), it.line, this.stripped), it.line);
		return eaten;
	}

	private setextHeading(t: string, silent: boolean): number {
		const g = t.length;
		let y = -1;
		let b = "";
		let d = "";
		while (++y < g) {
			d = t.charAt(y);
			if (d !== " " || y >= 3) {
				y--;
				break;
			}
			b += d;
		}
		let h = "";
		let p = "";
		while (++y < g) {
			d = t.charAt(y);
			if (d === "\n") {
				y--;
				break;
			}
			if (d === " " || d === "\t") p += d;
			else {
				h += p + d;
				p = "";
			}
		}
		b += h + p;
		d = t.charAt(++y);
		const f = t.charAt(++y);
		if (d !== "\n" || (f !== "=" && f !== "-")) return 0;
		b += d;
		p = f;
		while (++y < g) {
			d = t.charAt(y);
			if (d !== f) {
				if (d !== "\n") return 0;
				y--;
				break;
			}
			p += d;
		}
		return silent ? 1 : (b + p).length;
	}

	private html(t: string, silent: boolean): number {
		const D = t.length;
		let A = 0;
		let C: string;
		while (A < D && ((C = t.charAt(A)) === "\t" || C === " ")) A++;
		if (t.charAt(A) !== "<") return 0;
		let nl = t.indexOf("\n", A + 1);
		if (nl === -1) nl = D;
		let w = t.slice(A, nl);
		const kind = HTML_KINDS.find((k) => k[0].test(w));
		if (!kind) return 0;
		if (silent) return kind[2] ? 1 : 0;
		A = nl;
		if (!kind[1].test(w)) {
			while (A < D) {
				nl = t.indexOf("\n", A + 1);
				if (nl === -1) nl = D;
				w = t.slice(A + 1, nl);
				if (kind[1].test(w)) {
					if (w) A = nl;
					break;
				}
				A = nl;
			}
		}
		return A;
	}

	private footnoteDefinition(t: string, silent: boolean, line: number): number {
		const w0 = t.length + 1;
		let k = 0;
		let s: number;
		while (k < w0 && ((s = t.charCodeAt(k)) === 9 || s === 32)) k++;
		if (t.charCodeAt(k++) !== 91 || t.charCodeAt(k++) !== 94) return 0;
		const r = k;
		let o: number | undefined;
		while (k < w0) {
			s = t.charCodeAt(k);
			if (s !== s || s === 10 || s === 9 || s === 32) return 0;
			if (s === 93) {
				o = k;
				k++;
				break;
			}
			k++;
		}
		if (o === undefined || r === o || t.charCodeAt(k++) !== 58) return 0;
		if (silent) return 1;
		interface Seg {
			start: number;
			contentStart: number;
			contentEnd: number;
			end: number;
		}
		let p = 0;
		let d: number | undefined = 0;
		let f: number | undefined = k;
		const v: Seg[] = [];
		let m: Seg | undefined;
		for (; k < w0; k++) {
			s = t.charCodeAt(k);
			if (s !== s || s === 10) {
				m = { start: p, contentStart: f || k, contentEnd: k, end: k };
				v.push(m);
				if (s === 10) {
					p = k + 1;
					d = 0;
					f = undefined;
					m.end = p;
				}
			} else if (d !== undefined) {
				if (s === 32 || s === 9) {
					d += s === 32 ? 1 : 4 - (d % 4);
					if (d > 4) {
						d = undefined;
						f = k;
					}
				} else {
					if (d < 4 && m && (m.contentStart === m.contentEnd || this.footnoteInterrupts(t.slice(k, 1024)))) break;
					d = undefined;
					f = k;
				}
			}
		}
		let n = v.length;
		while (n > 0 && (m = v[n - 1]!).contentStart === m.contentEnd) n--;
		const eaten = m!.contentEnd;
		const parts: string[] = [];
		for (let q = 0; q < n; q++) {
			parts.push(t.slice(v[q]!.contentStart, v[q]!.end));
			this.stripped[line + q] = (this.stripped[line + q] ?? 0) + v[q]!.contentStart - v[q]!.start;
		}
		this.atStart = false;
		this.tokenizeBlock(parts.join(""), line);
		return eaten;
	}

	private footnoteInterrupts(text: string): boolean {
		for (const name of this.interruptFootnote) if (this.tokenizers[name]!(text, true, 0) > 0) return true;
		return false;
	}

	private definition(t: string, silent: boolean): number {
		const A = t.length;
		let D = 0;
		let k = "";
		let P = "";
		while (D < A && ((k = t.charAt(D)) === " " || k === "\t")) {
			P += k;
			D++;
		}
		k = t.charAt(D);
		if (k !== "[") return 0;
		// Obsidian wraps remark's definition tokenizer and refuses a label that
		// starts with `^`, which is footnote syntax (`a.definition = function ...`
		// in the bundle). Without this, `[^id` / ... / `x]:y` parses as one
		// definition and swallows a `%%` block the reader is shown as hidden.
		if (t.charAt(D + 1) === "^") return 0;
		D++;
		// The label runs to the first `]` not consumed by a backslash, across
		// lines. The bundle walks there char by char at every `[`-led block, which
		// is quadratic on a note full of `[` and short of `]`; the driver's calls
		// read a backward table computed once per content string instead, with
		// the same answer. The footnote interrupt passes at most 1,024 characters,
		// so it keeps the plain walk.
		const labelEnd = silent ? labelCloseScan(t, D) : this.labelCloseAt(D);
		if (labelEnd === -1 || labelEnd === D || t.charAt(labelEnd + 1) !== ":") return 0;
		P = t.slice(0, labelEnd + 2);
		D = P.length;
		let w = "";
		while (D < A && ((k = t.charAt(D)) === "\t" || k === " " || k === "\n")) {
			P += k;
			D++;
		}
		k = t.charAt(D);
		w = "";
		if (k === "<") {
			for (D++; D < A && (k = t.charAt(D)) !== ">" && k !== "[" && k !== "]"; ) {
				w += k;
				D++;
			}
			k = t.charAt(D);
			if (k === ">") {
				P += "<" + w + k;
				D++;
			} else {
				if (OPT_COMMONMARK) return 0;
				D -= w.length + 1;
				w = "";
			}
		}
		if (!w) {
			while (D < A && (k = t.charAt(D)) !== "[" && k !== "]" && !isWhitespaceChar(k)) {
				w += k;
				D++;
			}
			P += w;
		}
		if (!w) return 0;
		w = "";
		while (D < A && ((k = t.charAt(D)) === "\t" || k === " " || k === "\n")) {
			w += k;
			D++;
		}
		k = t.charAt(D);
		let close: string | null = null;
		if (k === '"') close = '"';
		else if (k === "'") close = "'";
		else if (k === "(") close = ")";
		if (close) {
			if (!w) return 0;
			P += w + k;
			D = P.length;
			w = "";
			while (D < A && (k = t.charAt(D)) !== close) {
				if (k === "\n") {
					D++;
					k = t.charAt(D);
					if (k === "\n" || k === close) return 0;
					w += "\n";
				}
				w += k;
				D++;
			}
			k = t.charAt(D);
			if (k !== close) return 0;
			P += w + k;
			D++;
			w = "";
		} else {
			w = "";
			D = P.length;
		}
		while (D < A && ((k = t.charAt(D)) === "\t" || k === " ")) {
			P += k;
			D++;
		}
		k = t.charAt(D);
		if (!k || k === "\n") return silent ? 1 : P.length;
		return 0;
	}

	/** Where a definition label opened before `from` (in the driver's current text) closes, or -1. */
	private labelCloseAt(from: number): number {
		const value = this.curValue;
		let table = this.closeTables.get(value);
		if (table === undefined) {
			const n = value.length;
			table = new Int32Array(n + 2).fill(-1);
			for (let j = n - 1; j >= 0; j--) {
				const c = value.charCodeAt(j);
				table[j] = c === 93 ? j : c === 92 ? table[j + 2]! : table[j + 1]!;
			}
			this.closeTables.set(value, table);
		}
		const at = table[this.curPos + from]!;
		return at === -1 ? -1 : at - this.curPos;
	}

	private table(t: string, silent: boolean): number {
		let r2 = 0;
		let rows = 0;
		const w0 = t.length + 1;
		const lines: string[] = [];
		let noLeadPipe = false;
		while (r2 < w0) {
			let O = t.indexOf("\n", r2);
			if (O === -1) O = t.length;
			// The bundle searches for the pipe to the END OF THE NOTE and then
			// compares with the line end, which is quadratic on a long note with no
			// pipe. Only "is there a pipe after the row's first character and before
			// its newline" matters, so the search stops at the line end; the answer
			// is the same and the cost is the line's.
			let F = -1;
			for (let k = r2 + 1; k < O; k++) {
				if (t.charCodeAt(k) === 124) {
					F = k;
					break;
				}
			}
			if (F === -1) {
				if (rows < 2) return 0;
				break;
			}
			const P = t.slice(r2, O);
			if (rows === 0) noLeadPipe = P[0] !== "|";
			else if ((noLeadPipe && P[0] === "|") || (!noLeadPipe && P[0] !== "|")) break;
			lines.push(P);
			rows++;
			r2 = O + 1;
		}
		const whole = lines.join("\n");
		const align = lines.length > 1 ? lines[1]! : "";
		let g: string | null | false = false;
		let sawDash: boolean | null = null;
		let R: boolean | undefined;
		const cols: Array<string | null> = [];
		for (let i = 0; i < align.length; i++) {
			const E = align.charAt(i);
			if (E === "|") {
				sawDash = null;
				if (g === false) {
					if (R === false) return 0;
				} else {
					cols.push(g);
					g = false;
				}
				R = false;
			} else if (E === "-") {
				sawDash = true;
				g = g || null;
			} else if (E === ":") {
				g = g === "left" ? "center" : sawDash && g === null ? "right" : "left";
			} else if (!isWhitespaceChar(E)) return 0;
		}
		if (g !== false) cols.push(g);
		if (cols.length < 1) return 0;
		return silent ? 1 : whole.length;
	}

	private blockid(t: string, silent: boolean): number {
		const m = /^\^([a-zA-Z0-9\-]+)(?=$|\n$|\n\n)/.exec(t);
		if (!m) return 0;
		return silent ? 1 : m[0].length;
	}

	private paragraph(t: string, silent: boolean): number {
		const b = t.length;
		let y = t.indexOf("\n");
		let h = "";
		while (y < b) {
			if (y === -1) {
				y = b;
				break;
			}
			if (t.charAt(y + 1) === "\n") break;
			let p = 0;
			let c = y + 1;
			while (c < b) {
				h = t.charAt(c);
				if (h === "\t") {
					p = 4;
					break;
				}
				if (h !== " ") break;
				p++;
				c++;
			}
			if (p >= 4 && h !== "\n") {
				y = t.indexOf("\n", y + 1);
				continue;
			}
			if (this.interrupts(this.interruptParagraph, t.slice(y + 1))) break;
			c = y;
			y = t.indexOf("\n", y + 1);
			if (y !== -1 && t.slice(c, y).trim() === "") {
				y = c;
				break;
			}
		}
		if (silent) return 1;
		return t.slice(0, y).replace(/\n+$/, "").length;
	}
}

/**
 * Every `%%` block comment Obsidian's reading view creates for `source`, or
 * `null` when the scan cannot speak for the renderer (a lone carriage return,
 * which the renderer turns into a line break the extractor does not count, a
 * note the bundle itself would refuse to parse, or containers nested deeper
 * than MAX_DEPTH). `null` means "no answer":
 * callers keep their own behaviour.
 */
export function rendererPercentBlocks(source: string): RendererPercentBlock[] | null {
	if (/\r(?!\n)/.test(source)) return null;
	let value = source.replace(/\r\n/g, "\n");
	if (value.charCodeAt(0) === 0xfeff) value = value.slice(1);
	const scanner = new BlockScanner();
	try {
		scanner.tokenizeBlock(value, 0);
	} catch {
		return null;
	}
	return scanner.found;
}

/**
 * For each line on which the reading view opens a `%%` comment that runs out of
 * container before any closing `%%`, the last line that comment covers. A
 * comment closed by a `%%` is left out on purpose: the extractor finds that
 * same closer itself, since a container's content lines are suffixes of the
 * note's lines and the prefix a container strips never holds a `%%`. So is one
 * that reaches the end of the note, where there is nothing to end.
 */
export function percentBlockEnds(source: string, lineCount: number): Map<number, number> {
	const ends = new Map<number, number>();
	const found = rendererPercentBlocks(source);
	if (found === null) return ends;
	for (const b of found) if (!b.closed && b.lastLine < lineCount - 1) ends.set(b.startLine, b.lastLine);
	return ends;
}
