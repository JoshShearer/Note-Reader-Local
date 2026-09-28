/**
 * Exercises the real pipeline against engines that exist on this machine.
 *
 * speech-dispatcher is present with an espeak-ng output module, so this covers
 * a genuine end-to-end run: markdown in, audio out, word timings computed.
 */

import { extractChunks } from "../src/text/extract.ts";
import { parseWav, pcmToWav } from "../src/audio/wav.ts";
import { allocateWordTimings, wordAt } from "../src/audio/words.ts";
import { getProcessRunner } from "../src/engines/system/spawn.ts";
import { SpeechDispatcherEngine } from "../src/engines/system/speechd.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

console.log("speech-dispatcher is usable here");
const runner = getProcessRunner();
const spd = new SpeechDispatcherEngine(runner);
check("spd-say on PATH", (await runner.which("spd-say")) !== null);
check("reports available", await spd.isAvailable());

console.log("voice list parses");
{
	const voices = await spd.listVoices();
	check("voices found", voices.length > 0, `got ${voices.length}`);
	const en = voices.filter((v) => v.lang.startsWith("en"));
	check("has english voices", en.length > 0, `got ${en.length}`);
	console.log(`       (${voices.length} total, ${en.length} english)`);
	if (en[0]) {
		await spd.selectVoice(en[0]);
		const result = await spd.synthesize(
			{
				chunk: { text: "Testing one two three.", sourceIndex: [], sourceStart: 0, sourceEnd: 22 },
				rate: 1,
				pitch: 0,
			},
			new AbortController().signal,
		);
		check("returns streamed result", result.kind === "streamed");
		check("estimates a duration", result.kind === "streamed" && result.estimatedMs > 200);
	}
}

console.log("wav round-trip");
{
	const pcm = new Int16Array(24000).fill(1000);
	const wav = pcmToWav(pcm.buffer, 24000);
	check("is RIFF", Buffer.from(wav).subarray(0, 4).toString() === "RIFF");
	const info = parseWav(wav);
	check("sample rate round-trips", info.sampleRate === 24000, `got ${info.sampleRate}`);
	check("duration is ~1s", Math.abs(info.durationMs - 1000) < 2, `got ${info.durationMs}`);
}

console.log("word timings cover the sentence");
{
	// "a" needs to stand alone for the weight comparison to mean anything;
	// in "lazy" the a is part of a longer word.
	const src = "The quick brown fox jumps over a lazy dog.";
	const EXPECTED_WORDS = 9; // The quick brown fox jumps over a lazy dog.
	const chunks = extractChunks(src, {
		stripTags: true,
		skipUrls: true,
		skipCode: true,
		skipTables: true,
		skipHeadings: false,
	});
	const chunk = chunks[0]!;
	const words = allocateWordTimings(chunk, 2000);

	check("one timing per word", words.length === EXPECTED_WORDS, `got ${words.length}`);
	check("monotonic offsets", words.every((w, i) => i === 0 || w.offsetMs >= words[i - 1]!.offsetMs));
	check("last ends near duration", Math.abs((words.at(-1)!.offsetMs + words.at(-1)!.durationMs) - 2000) < 60);
	check("no overlap", words.every((w, i) => i === 0 || w.offsetMs >= words[i - 1]!.offsetMs + words[i - 1]!.durationMs - 0.001));

	// Heavier words should get a wider slot than light ones. "quick" has a
	// diphthong; "a" is a single vowel and the shortest word in the sentence.
	const byText = (want: string) =>
		words.find((w) => src.slice(w.sourceStart, w.sourceEnd) === want)!;
	const quick = byText("quick");
	const a = byText("a");
	check("found 'quick'", quick !== undefined);
	check("found 'a'", a !== undefined);
	if (quick && a) {
		check(
			"multi-syllable word outranks single vowel",
			quick.durationMs > a.durationMs,
			`${quick.durationMs} vs ${a.durationMs}`,
		);
	}

	// Every timing must land on real source text.
	const bad = words.filter((w) => {
		const got = src.slice(w.sourceStart, w.sourceEnd);
		return got !== chunk.text.slice(w.start, w.end);
	});
	check("timings land on matching source text", bad.length === 0, `${bad.length} mismatched`);

	check("lookup before first word is -1", wordAt(words, 0) === -1);
	check("lookup mid-sentence finds a word", wordAt(words, 1000) >= 0);
	check("lookup past end holds last word", wordAt(words, 99999) === words.length - 1);
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all engine tests passed");
