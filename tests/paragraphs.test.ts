import { extractChunks } from "../src/text/extract.ts";
import { platformSegmenters } from "../src/text/segment.ts";
import { nextParagraphStart, previousParagraphStart, startsParagraph } from "../src/audio/paragraphs.ts";
import type { SpeechChunk } from "../src/audio/types.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
	if (!ok) failed += 1;
}

const make = (start: number, end: number, blockType: SpeechChunk["blockType"] = "paragraph"): SpeechChunk => ({
	id: `c${start}`,
	sequence: 0,
	blockType,
	filePath: "n.md",
	text: "x",
	sourceIndex: [start],
	sourceStart: start,
	sourceEnd: end,
});

// "A. B.\n\nC. D.\n\nE."  -> two sentences, a blank line, two more, a blank line, one.
const chunks = [make(0, 2), make(3, 5), make(7, 9), make(10, 12), make(14, 16)];

console.log("paragraph boundaries");
check("the first chunk starts a paragraph", startsParagraph(chunks, 0));
check("a sentence after a space does not", !startsParagraph(chunks, 1));
check("a sentence after a blank line does", startsParagraph(chunks, 2));
check("next from the start is the second paragraph", nextParagraphStart(chunks, 0) === 2);
check("next from mid-paragraph is the following paragraph", nextParagraphStart(chunks, 3) === 4);
check("next from the last paragraph is nowhere", nextParagraphStart(chunks, 4) === null);
check("previous from mid-paragraph is that paragraph's start", previousParagraphStart(chunks, 3) === 2);
check("previous from a start is the paragraph before", previousParagraphStart(chunks, 2) === 0);
check("a quick second press skips the current paragraph's start", previousParagraphStart(chunks, 3, false) === 0);
check("a quick second press from a start still goes back", previousParagraphStart(chunks, 4, false) === 2);
check("previous from the first is nowhere", previousParagraphStart(chunks, 0) === null);
check("a heading followed by prose starts a paragraph", startsParagraph([make(0, 5, "heading"), make(6, 9)], 1));

console.log("numbered blocks");
{
	const numbered = (start: number, end: number, paragraph: number): SpeechChunk => ({ ...make(start, end), paragraph });
	// A quote hard-wrapped over two lines: the gap is wide, but it is one block.
	const quote = [numbered(0, 10, 0), numbered(14, 24, 0), numbered(26, 36, 1)];
	check("sentences of one block are one paragraph whatever the gap", !startsParagraph(quote, 1));
	check("a new block starts a paragraph even with a narrow gap", startsParagraph(quote, 2));
	check("next paragraph follows the block numbers", nextParagraphStart(quote, 0) === 2);
}

console.log("the extractor numbers blocks");
{
	const note = "First sentence of the paragraph." + "\n" + "  Second sentence, indented." + "\n\n" + "A separate paragraph follows here.";
	const real = extractChunks(note, {} as never, platformSegmenters, "n.md");
	check("three sentences", real.length === 3, String(real.length));
	check("an indented wrapped line stays in its paragraph", !startsParagraph(real, 1), JSON.stringify(real.map((c) => c.paragraph)));
	check("the next block is another", startsParagraph(real, 2));
}

if (failed) {
	console.log(`${failed} paragraph checks failed`);
	process.exit(1);
}
console.log("all paragraph tests passed");
