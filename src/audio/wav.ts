/**
 * Just enough WAV to get a duration and hand bytes to an <audio> element.
 *
 * espeak-ng and piper both emit plain RIFF/PCM. We only need the format
 * header, so there is no reason to pull in an audio library.
 */

export interface WavInfo {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	durationMs: number;
}

function readTag(view: DataView, offset: number): string {
	return String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3),
	);
}

/** Parse a RIFF/WAVE buffer. Throws if the header is not usable. */
export function parseWav(buffer: ArrayBuffer): WavInfo {
	const view = new DataView(buffer);
	if (view.byteLength < 12) throw new Error("WAV too short");
	if (readTag(view, 0) !== "RIFF" || readTag(view, 8) !== "WAVE") {
		throw new Error("Not a RIFF/WAVE buffer");
	}

	let offset = 12;
	let sampleRate = 0;
	let channels = 0;
	let bitsPerSample = 0;
	let byteRate = 0;
	let dataSize = 0;

	while (offset + 8 <= view.byteLength) {
		const tag = readTag(view, offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;

		if (tag === "fmt " && body + 16 <= view.byteLength) {
			channels = view.getUint16(body + 2, true);
			sampleRate = view.getUint32(body + 4, true);
			byteRate = view.getUint32(body + 8, true);
			bitsPerSample = view.getUint16(body + 14, true);
		} else if (tag === "data") {
			// Some writers leave data size as 0 when streaming to a pipe.
			dataSize = size > 0 ? Math.min(size, view.byteLength - body) : view.byteLength - body;
			if (size > 0) break;
		}

		// Chunks are word-aligned.
		offset = body + size + (size % 2);
	}

	if (sampleRate === 0 || channels === 0) {
		throw new Error("WAV missing fmt chunk");
	}
	if (byteRate === 0) byteRate = (sampleRate * channels * bitsPerSample) / 8;

	return {
		sampleRate,
		channels,
		bitsPerSample,
		durationMs: byteRate > 0 ? (dataSize / byteRate) * 1000 : 0,
	};
}

/** Wrap raw PCM in a WAV header so a browser can play it. */
export function pcmToWav(
	pcm: ArrayBuffer,
	sampleRate: number,
	channels = 1,
	bitsPerSample = 16,
): ArrayBuffer {
	const headerBytes = 44;
	const out = new ArrayBuffer(headerBytes + pcm.byteLength);
	const view = new DataView(out);
	const byteRate = (sampleRate * channels * bitsPerSample) / 8;
	const blockAlign = (channels * bitsPerSample) / 8;

	const tag = (offset: number, text: string): void => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};

	tag(0, "RIFF");
	view.setUint32(4, 36 + pcm.byteLength, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);
	tag(36, "data");
	view.setUint32(40, pcm.byteLength, true);

	new Uint8Array(out, headerBytes).set(new Uint8Array(pcm));
	return out;
}

/** Blob MIME type for a PCM WAV. Browsers sniff the container, so plain is fine. */
export const WAV_MIME = "audio/wav";
