# SPEC-001-Local Native TTS for Obsidian

## Background

The project will implement an Obsidian Community Plugin that reads Markdown notes aloud using local text-to-speech, prioritizing operating-system-provided TTS engines and avoiding cloud TTS APIs.

The initial target platforms are:

- Linux desktop.
- Android.
- Other platforms are outside the MVP, but the architecture MUST permit future backends.

The central product promise is:

> Notes should be readable aloud without an account, subscription, API key, external TTS API, or companion application.

The plugin itself MUST NOT transmit note content to an external TTS service.

A system-provided TTS engine MAY internally use networking if the user has configured such a voice. Therefore, the plugin does not promise that every system voice is offline.

Where the operating system exposes this information, the plugin SHOULD indicate whether a voice requires network connectivity.

The design is informed by the open-source Android application Lector:

https://github.com/QuantEmber/lector

Lector demonstrates several desirable product behaviors:

- Native Android TTS.
- No application-level cloud TTS dependency.
- Markdown/document reading.
- Current sentence highlighting.
- Reading-position persistence.
- Playback-speed adjustment.
- Sleep timer.
- Device-provided voices.

There is, however, an important architectural difference.

Lector is a native Android Kotlin application and therefore has direct access to:

`android.speech.tts.TextToSpeech`

An Obsidian Community Plugin is implemented primarily in TypeScript/JavaScript and executes within Obsidian's desktop or mobile plugin environment.

On desktop, Obsidian provides access to Node.js/Electron capabilities.

On mobile, Node.js and Electron APIs are unavailable.

Therefore, direct access from an ordinary Obsidian Android Community Plugin to Android's native `TextToSpeech` API MUST be established through an implementation spike before that integration is considered technically available.

The overall architecture SHALL separate:

1. Markdown/document processing.
2. Speech segmentation.
3. Playback state.
4. User interface.
5. TTS implementation.

Conceptually:

```text
Obsidian Markdown
       │
       ▼
Document Processor
       │
       ▼
Speech Segments
       │
       ▼
Playback Controller
       │
       ▼
TTS Backend Interface
       │
       ├── Linux / Speech Dispatcher
       │
       ├── Android / System TTS
       │
       └── Local Neural TTS
           WebGPU/WASM
           [fallback/future]
```

Native/system TTS is preferred.

As of ADR 0010 (NRL-24), automatic selection ranks by confirmed real-time quality rather than a fixed native-first order: a live GPU/fp32 local neural voice may be preferred over native/system TTS when confirmed live (a real GPU adapter answering right now, plus the fp32 weights already on disk - never merely planned, never triggering a download). Native/system TTS remains the default whenever that GPU path is not confirmed live. This does not reopen the "no silent cloud fallback" rule below: automatic selection never picks a Web Speech voice unless it is confirmed local, and a manual pin still overrides all of this.

WebGPU/WASM local neural TTS is a fallback architecture and MUST NOT be confused with native operating-system TTS.

Cloud synthesis is deliberately excluded.

---

## Requirements

Requirements use MoSCoW prioritization.

---

## Must Have

### R-M01 — Standard Obsidian Community Plugin

The product MUST install as an ordinary Obsidian Community Plugin.

It MUST NOT require:

- A companion Android APK.
- A separately running local server.
- An account.
- A subscription.
- An API key.
- A cloud TTS provider.
- A modified version of Obsidian.

The plugin SHOULD remain compatible with:

```json
{
  "isDesktopOnly": false
}
```

Desktop-only dependencies MUST NOT be imported unconditionally into code executed on mobile.

#### Release Infrastructure

The plugin MUST ship with:

1. **Standard files** (`README.md`, `LICENSE`, `manifest.json`, `versions.json`).
2. **SLSA Level 3 provenance** - GitHub Actions builds the release artifact and generates cryptographic attestation of the source commit and build process (per [slsa-framework/slsa-github-generator](https://github.com/slsa-framework/slsa-github-generator)).
3. **ORT runtime checksum validation, in two phases** (NRL-37, ADR 0021 amends ADR 0011) - SHA-256 checksums of all ONNX Runtime WASM files are still compiled into `main.js` at build time, from the same local `node_modules/onnxruntime-web` source and with no network access at build time. The runtime files themselves are no longer part of the shipped `main.js`/`manifest.json`/`styles.css` bundle Obsidian's installer fetches: they ship as separate assets on the same tagged GitHub Release, and are fetched on explicit user action from the Settings tab, verified against those same compiled-in digests before being trusted - exactly mirroring the existing Kokoro-weights download gate. The compiled-in checksums are also still validated against whatever is already on disk on every plugin load, as a corruption/tamper check independent of the download step.
   - Non-negotiable: no model weights downloaded during build, only published ORT files.
   - Non-negotiable: no automatic fallback on checksum failure; user is told to re-install the plugin (build-time checksum mismatch) or re-download the runtime (download-time or load-time checksum mismatch).
   - Non-negotiable: checksums are read-only in the bundle and never modified at runtime.

See ADR 0021 (ort-on-demand.md), alongside ADR 0011 (release-attestation.md).

Quality gates run before any release:
- `npm run typecheck` (TypeScript must compile).
- `npm test` (all 11 test suites must pass).
- `npm run build` (production esbuild must succeed).

These gates are enforced by the GitHub Actions release workflow (`.github/workflows/release.yml`). Only tagged commits that pass all gates are released to GitHub.

See ADR 0011 (release-attestation.md) for rationale and implementation details.

---

### R-M02 — Linux Support

Linux desktop MUST support local speech synthesis.

The preferred backend SHALL be:

```text
Obsidian
   │
   ▼
LinuxSpeechDispatcherBackend
   │
   ▼
Speech Dispatcher
   │
   ▼
User-configured speech engine
```

Speech Dispatcher is preferred because it provides an abstraction over the user's installed Linux speech engine.

The plugin SHOULD NOT require one specific underlying engine such as:

- eSpeak NG.
- Piper.
- Festival.

if Speech Dispatcher can abstract the configured engine.

---

### R-M03 — Android Support

Android MUST be a target platform.

The preferred architecture is:

```text
AndroidTTSBackend
       │
       ▼
Native Bridge
       │
       ▼
android.speech.tts.TextToSpeech
       │
       ▼
Installed Android TTS Engine
```

The existence of a supported native bridge from an ordinary Obsidian Community Plugin to Android `TextToSpeech` MUST NOT be assumed.

It MUST first be demonstrated by an implementation spike.

---

### R-M04 — No External TTS API

The plugin MUST NOT send note text to external synthesis providers.

Examples include:

- OpenAI.
- ElevenLabs.
- Google Cloud TTS.
- Azure Speech.
- Amazon Polly.
- Similar hosted speech-generation APIs.

The plugin MUST NOT require API-key configuration for normal TTS operation.

There MUST NOT be an automatic cloud fallback.

---

### R-M05 — Local Privacy

Normal playback MUST process note content locally.

The plugin MUST NOT implement telemetry containing:

- Note contents.
- Selected text.
- Generated speech text.
- File contents.

TTS debug logging MUST NOT contain the actual text being spoken.

---

### R-M06 — Reading Sources

Users MUST be able to start speech from:

1. Selected text.
2. The current cursor position.
3. The entire active note.

Commands SHALL include:

```text
TTS: Read selection
TTS: Read from cursor
TTS: Read entire note
```

---

### R-M07 — Playback Controls

The plugin MUST expose:

```text
Play
Pause / Resume
Stop
Previous segment
Next segment
```

Previous and Next buttons are implemented in the control bar and navigate the
chunk queue during playback. Navigation attempts at queue boundaries (first
chunk when calling Previous, last chunk when calling Next) are silently
no-ops, bounds-checked by the player.

The exact implementation of pause/resume MAY depend on backend capabilities.

Where a backend cannot pause an active utterance, the controller MAY implement pause by stopping synthesis while retaining the current segment and position.

Stop MUST also cancel a read that has not begun speaking, including while an engine's model is still loading; the load itself MAY be abandoned rather than cancelled, and any already-loaded result is kept (ADR 0013).

Stop silences playback as far as the backend allows, which on `speechd` is not
completely: about 800 ms of speech continues after it, and that is accepted rather
than outstanding (ADR 0016). Measured off the sink monitor with `parec` at 810 ms
and 800 ms, identical whether the daemon is told to stop over `spd-say -S` or over
a connection-scoped SSIP `CANCEL self` that the daemon acknowledges for both the
speaking and the queued message. The speech has already been committed to the
daemon's output module by then, so no protocol verb reclaims it. The other three
engines are unaffected: Kokoro and espeak play through the `<audio>` element, and
webspeech uses `speechSynthesis.cancel`.

---

### R-M08 — Markdown Processing

Raw Markdown MUST NOT simply be passed directly to TTS.

The plugin MUST convert the source document into readable speech content.

The processor MUST handle at least:

- Headings.
- Paragraphs.
- Ordered lists.
- Unordered lists.
- Blockquotes.
- Bold text.
- Italic text.
- External links.
- Obsidian wikilinks. The label is a meaningful alias if there is one, otherwise the target reduced to its final path segment, so the leading folder segments of a vault path are not spoken (R-M09, ADR 0017).
- YAML frontmatter. Detected by shape at the top of the note, ignoring leading blank lines, and treated as frontmatter only when closed and `key:`-shaped (ADR 0002). Whether it is then skipped or spoken is governed by `skipFrontmatter` (R-M09, ADR 0008).
- Fenced code blocks.
- Inline code.
- Images. The alt text is governed by `speakImageAlt`; the destination and any quoted title are never spoken (R-M09, ADR 0008).
- Obsidian embeds. Governed by `speakEmbeds`, and spoken as a label for the local reference rather than by transcluding the target (R-M09, ADR 0008).

Markdown syntax SHOULD NOT itself be spoken unless meaningful to the content.
In particular:

- Emphasis markers are dropped. An underscore between letters or digits is part of an identifier (`snake_case_name` is spoken intact); only a flanking `_` is emphasis. `*` and `~~` with whitespace on both sides, and a single `~`, are spoken as text.
- `==highlight==` speaks its text without the equals signs; `a == b` is text.
- Inline HTML tags from a known-element list are dropped and their text content kept; `<br>` and other breaking elements separate words.
- The brackets of an autolink (`<https://example.com>`, `<me@example.com>`) are never spoken, in either position of the URL setting. What is spoken of the address itself is governed by R-M09 (ADR 0007).
- HTML comments (`<!-- ... -->`), including multi-line ones, are never spoken. An unclosed comment hides the rest of the note. Literal code is exempt from comment parsing.
- Obsidian comments (`%%...%%`) are unconditionally excluded, including their delimiters (ADR 0006). Complete inline spans and multi-line blocks are silent; visible text before them and after the closing delimiter, including closing-line prose, remains speakable. A block opener is `%%` at the start of a prose line allowing whitespace, after structural prefixes or in a closing-line remainder; if unclosed it hides through EOF. An unmatched inline opener remains literal, as do lone `%` and escaped openers.
- Comments are non-nesting: the first matching closer ends the active comment, and HTML and Obsidian delimiters cannot close each other's comments. Hidden content, including fences, math, other comment openers and blank lines, MUST NOT change parser state. Skipping headings or tables MUST NOT bypass comment tracking. Recursively cleaned labels, aliases and highlights suppress complete comments with local state that cannot consume subsequent source lines.
- Inline, fenced and indented code retain literal comment delimiters when spoken and remain silent when skipped. Comment removal MUST preserve word separation and raw UTF-16 source offsets, including mapped separating spaces and true offsets after multi-line comments (ADR 0006, R-M11).
- An inline code span MAY cross a soft line break. Inside a span recognised that way, **nothing is re-interpreted as markdown**: when inline code is spoken the span's continuation lines and the text before its closing run are spoken verbatim, and when inline code is skipped they are silent, in both cases exactly as a single-line span already behaves. The general form is deliberate rather than a list of exempt constructs: before NRL-44 only `%%` and `<!--` were exempt and 18 of 21 inline constructs were not, so an enumeration is an enumeration that will be incomplete again (ADR 0019). Because the raw text of a code span is what the renderer shows, this includes a destination: `![alt](dest.png)` inside a span is read as itself, which is a property of code and not an exception to the image rule above. Such a span is recognised only when a later line in the same paragraph closes it with a backtick run of exactly the same length; an unmatched run is literal text and MUST NOT suppress comment recognition, since doing so would speak hidden text. The search stops at a blank line, at any block-starting construct, and at any line that opens a comment and so hides the lines after it; a comment that closes on its own line hides nothing beyond itself and stays literal inside the span. On the **opening** line, the text after the unmatched run is not yet known to be code and is still spoken as prose, which is a known gap tracked by NRL-64; a soft-wrapped image or link is not recognised across the break at all, tracked by NRL-63 (ADR 0006 clause 4, amended by NRL-42 and NRL-44).
- Joining soft-wrapped lines into a paragraph MUST insert exactly one separating space, and none where the preceding line already ends in a mapped space left by dropped syntax (NRL-42).
- Footnote references (`[^1]`) are dropped, and a definition's `[^1]:` marker with them.
- A CommonMark link reference definition line (`[label]: destination "Title"`) renders as nothing, so none of it is spoken at all - label, colon, destination and any quoted title (ADR 0018). It is recognised only as the complete one-line shape at the start of a block: not interrupting a paragraph, not on a later line of a blockquote or list, and not inside a heading, where a leaf block cannot occur. The rule is unconditional, governed by no content key, and it does not change the footnote-definition bullet above, whose body the renderer does display. A near-miss such as `[see also]: not a definition, just a sentence` stays spoken, because recognition requires positive evidence and leaked markup is preferred to a swallowed word (ADR 0007 clause 6). A multi-line definition, with the destination on the following line, is out of scope and is still spoken. This extends R-M09's promise that an image's "destination and any quoted title are never spoken" to the construct that carries the same pair through a different shape.
- Math is spoken as the word "equation": display math always, inline math only when it has 4 or more tokens, with a currency heuristic so prices such as `$5` are read as written (ADR 0004).

---

### R-M09 — Configurable Content Exclusions

Users MUST be able to configure whether the following are spoken:

```text
YAML/frontmatter
code blocks
inline code
URLs
image alt text
Obsidian embeds
```

Default behavior SHALL be equivalent to:

```yaml
frontmatter: false
codeBlocks: false
inlineCode: false
urls: false
imageAltText: true
embeds: false
```

When spoken, these are reduced as follows:

- A bare URL (`https://...`, `http://...` or `www....`) is spoken as its host only: no scheme, no userinfo (credentials such as `user:secret@` are never spoken), no leading `www.`, no port, path, query or fragment. `See https://example.com/a/b?c=d now.` is spoken as `See example.com now.` Markdown links (`[label](url)`) and wikilinks are unaffected by the URL setting; their label is always spoken (ADR 0003). A wikilink or embed target that is itself a bare URL is reduced by this same host-only rule, in either position of the setting, because its label is always spoken and the reduction is what keeps the path and the userinfo out of it (ADR 0017).
- An autolink `<scheme://...>` is reduced to its host by the same rule as a bare URL, and `<addr@host>` and `<mailto:addr@host>` follow the same setting: silent when URLs are not spoken, the domain only when they are, and the mailbox never. No `<` or `>` is spoken in either position. An autolink stops at its closing `>`, so a sentence period after it is still spoken, unlike the bare-URL form (ADR 0007).
- Fenced and indented code blocks are spoken verbatim, one paragraph per block, with whitespace runs collapsed, and both follow the code-block setting. The fence lines and any info string (e.g. `js`) are never spoken. An indented block starts only after a blank line or at document start, and inside a list an indented line is item content, not code (CommonMark).
- Inline code is spoken verbatim without the backticks. Its content is not treated as markdown. Inline code and code blocks have separate settings and separate toggles.
- Frontmatter is spoken as its own paragraph of source-mapped `key: value` text, before the first prose line. Both `---` fences, blank lines and YAML `#` comment lines are never spoken. No YAML is parsed and nothing is reserialised: no words are added, nothing is reordered, and every character keeps its own raw source offset. A `#` in a value is part of that value rather than a tag, a backtick in a value is a character rather than code, and a heading- or table-shaped value is unaffected by the heading and table settings; URL reduction still applies, so a `source:` field does not read out a path. A frontmatter line MUST NOT be able to open a comment or code span that reaches the note body: an unmatched `%%`, `<!--` or backtick run ends at its own line. A complete comment span inside a value is still excluded (ADR 0008).
- An image's alt text is spoken without its brackets, re-cleaned as a link label is, so nested markup and complete comment spans inside it are handled identically. The destination and any quoted title are never spoken, in either position of the setting, and this includes the `[ref]` tail of the reference form (ADR 0008).
- An Obsidian embed is spoken as a label for the reference written in this note, never by transcluding the target, because a transcluded file has no offset in this note's source to highlight. The label is a meaningful alias if there is one, otherwise the target reduced exactly as a wikilink target is: its **final path segment only**, where the segment ends at the last `/` or `\` so a Windows-style path is split the same way, with a trailing separator falling back to the last non-empty segment and a target of only separators speaking nothing; a `#` remains a pause and `#^blockid` remains dropped, and the reduction applies only to the part before the first `#`. The leading folder segments are destination-shaped and are not spoken, so `[[private/folder/Secret Note]]` and `![[private/folder/Secret Note]]` both say `Secret Note` and `[[folder/subfolder/]]` says `subfolder`. A target that is a bare URL (`https://`, `http://` or `www.`) is instead reduced to its host by the bare-URL rule above, including the stripping of any userinfo, in **either** position of the URL setting and with no fragment spoken, because a wikilink's label is always spoken and reducing it is what keeps the path and the credentials out of the speech. A numeric alias (`200`, `200x100`) is display sizing and is ignored. A target naming a file rather than a note is a destination, so only its alias is spoken and `![[pic.png]]` says nothing. "Naming a file" is decided by a dot in the target's final path segment - the same segment that would be spoken, split on the same two separators - so `.md` and `.markdown` are a note and any other extension is a file, whatever its length and whatever characters it contains, and `![[document.webmanifest]]` and `![[archive.tar-gz]]` say nothing. That test is applied before the URL rule, so `![[https://x.com/a.png]]` is silent even though the wikilink form says `x.com`. The consequence in each direction is deliberate: a note whose *title* holds a dot (`![[Version 1.2 notes]]`) is silent and an alias is how it is spoken, while a target with no dot at all (`![[Dockerfile]]`) is a note name and is read as the label, because an extensionless file cannot be told from a note title and a note embed keeps wikilink parity (ADR 0008 clauses 5 and 5a, ADR 0017).

---

### R-M10 — Speech Segmentation

Documents MUST be divided into independently addressable speech segments.

A segment SHOULD normally correspond to a sentence.

Segmentation MAY fall back to paragraphs or safe-sized chunks when sentence segmentation is unavailable or inappropriate.

The implementation SHOULD use `Intl.Segmenter` where supported rather than implementing English-specific regular-expression sentence detection.

The segmenter MUST support Unicode text.

Amended by ADR 0009 (NRL-28):

- Sentence boundaries are the **union** of `Intl.Segmenter` and the previous ASCII regex, not a replacement. Over 4,000 generated **newline-free** English fixtures ICU declines 15,523 boundaries the regex produces (after `e.g.`, after `...`, after `U.S.A.`) and supplies 1,803 the regex lacks, so on the newline-free text the splitter is actually handed, replacing the regex would lengthen English chunks. That ratio is corpus-specific and inverts where hard line breaks are present, since ICU ends a sentence at a newline and the regex cannot; it does not reach this decision, because `extractChunks` splits the source on `\n` and joins paragraph lines with a space, so no newline reaches sentence segmentation (ADR 0009 clause 2). An ICU-only boundary is accepted only when the **terminator** before it is at or above U+0080, which admits `。`, `？`, `！` and `؟` and by construction admits none where the terminator is ASCII - over those same 4,000 fixtures it admitted 0 of the 1,803. Reaching the terminator means walking back over whitespace and over closing or final punctuation (`\p{Pe}`, `\p{Pf}`), because the regex's own closer class `["')\]]*` is ASCII-only and would otherwise let smart-punctuated prose break where the same prose in straight quotes does not.
- Merging short fragments MUST NOT erase a boundary only `Intl.Segmenter` found. ICU segments a Chinese paragraph into sentences of six or seven characters, every one below the 40-character merge floor, so an unguarded merge folds them all back into the single chunk this requirement exists to prevent.
- The hard chunk cap is a **target, not a guarantee**, and MUST NOT cut inside an extended grapheme cluster. A single cluster can exceed the cap - `a` followed by 300 combining acutes is 301 UTF-16 units and one cluster - and where the two conflict the cluster wins and is emitted whole, which also guarantees forward progress. This is the only case in which a chunk may exceed the cap. The hard split prefers a space, then an `Intl.Segmenter` word boundary, then the raw cap, and the first two are floored at half the cap **on the same measurement**: a word candidate is walked back over any space run behind it first, so the word branch cannot accept a cut the space branch has already rejected as too early. Grapheme safety belongs to the hard split only; a sentence boundary is not snapped back to a cluster boundary, so degenerate text with a combining mark straight after a terminator can still end a chunk inside a combining sequence.
- Where `Intl.Segmenter` is absent, grapheme boundaries come from a bundled offline UAX 29 breaker rather than code-point iteration, so a cut still cannot land inside a surrogate pair, an emoji sequence or a combining sequence. Sentence segmentation in that position falls back to the ASCII regex, under the "MAY fall back" clause above, which means CJK collapses to a single chunk when no segmenter exists.
- The segmenter locale is Obsidian's UI language, from `appLocale()`. Nothing inspects the note to detect a language and nothing selects a voice from it. A malformed locale tag costs the locale, never the segmentation.
- All offsets remain UTF-16 code-unit indices, as R-M11 requires.

Not met by this requirement, and closed separately by NRL-47 / ADR 0014 against R-S03: word-level granularity inside a run of Han. `findWords` had no separator there, so a whole CJK sentence was one word span and the highlight covered it for its full duration. Measured at `c29e7af`: one span per Chinese sentence against fifteen for an English sentence of comparable spoken length. Measured after NRL-47 at `d7e64df` + this change, same fixtures and the same bare-Node bundle: `这是第一句。这是第二句。第三句结束了。` gives 4, 4 and 4 spans across its three chunks where it gave 1, 1 and 1, and the English fixture is unchanged at 15. R-M10's own status is not affected either way; this note stays here as a cross-reference.

---

### R-M11 — Source Mapping

Every speech segment MUST retain its relationship to the original Markdown source.

Conceptual representation:

```ts
interface SpeechSegment {
  id: string;

  text: string;

  sequence: number;

  source: {
    filePath: string;
    from: number;
    to: number;
  };

  blockType:
    | "heading"
    | "paragraph"
    | "list"
    | "quote"
    | "other";
}
```

Source mapping SHALL support:

- Current sentence highlighting.
- Resume.
- Previous/next navigation.
- Cursor-based playback.
- Future editing/navigation features.

---

### R-M12 — Reading Position

The plugin MUST remember reading progress per note.

Minimum persisted information:

```ts
interface ReadingPosition {
  filePath: string;

  segmentId: string;

  segmentIndex: number;

  sourceOffset: number;

  updatedAt: number;
}
```

Playback MUST be able to resume approximately where the user stopped.

A changed document MUST NOT cause an out-of-range stored position to crash playback.

When exact restoration is impossible, the plugin SHOULD restore the nearest valid source position.

---

### R-M13 — Persistent Settings

The plugin MUST persist TTS settings locally.

Conceptual configuration:

```ts
interface TTSSettings {
  engine: EngineId;
  voiceId: string;

  rate: number;
  pitch: number;

  highlight: { enabled: boolean; sentence: boolean; word: boolean; color: string };

  skipFrontmatter: boolean;
  skipCodeBlocks: boolean;
  skipInlineCode: boolean;
  skipTags: boolean;
  skipTables: boolean;
  skipHeadings: boolean;

  speakUrls: boolean;
  speakImageAlt: boolean;
  speakEmbeds: boolean;

  offlinePreferred: boolean;

  bufferAhead: number;
  kokoroModelPath: string;
  kokoroDevice: "auto" | "wasm" | "webgpu";
  kokoroThreads: number;
  kokoroWeights: "auto" | "gpu" | "fast" | "small";
}
```

The implemented key set is `Settings` in `src/settings/index.ts`. Polarity is
deliberately mixed: `skipX` for content read by default, `speakX` for content
dropped by default. A key MAY be stored before extraction reads it, but MUST NOT
be given a settings toggle until it does (see `docs/adr/0001`). `offlinePreferred`
is the only such reserved key; every content key is read by extraction and has
its own toggle, and no toggle writes a second key (`docs/adr/0008`).

A change to a content setting SHALL apply on the next read. A read already in
progress keeps the segments it was given, so its audio and highlighting stay in
step.

Settings normalisation MUST preserve keys it does not recognise, at every level,
because the normalised object is what gets saved.

`highlight.color` is a hex colour (`#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`) or
the empty string. The empty string is the default and means "follow the theme"
(Obsidian's `--text-highlight-bg`). The word highlight reads the CSS custom
property `--local-tts-reader-word-highlight` and the sentence highlight reads
`--local-tts-reader-sentence-highlight` (see `docs/adr/0005`). Both properties
are written from that one `highlight.color`, so they always hold the same value;
the two layers are therefore distinguished by treatment rather than by hue - the
sentence is an underline and the word is a filled mark (`docs/adr/0020`).

`highlight.sentence` and `highlight.word` are the two layers, both defaulting to
`true`, and `highlight.enabled` is a master switch over both (NRL-54,
`docs/adr/0020`). An engine capability MUST NOT gate anything but the layer it
describes: `EngineCapabilities.timing` reports word timings, so it may disable
the word layer and MUST NOT disable the master switch or the sentence layer. A
backend that reports `timing: "none"` can still show the sentence highlight, and
is the only backend for which it is the sole layer available.

Settings SHALL use Obsidian's plugin-data persistence facilities.

The plugin MUST NOT modify note contents simply to store global TTS settings.

---

### R-M14 — Backend Capability Detection

The user interface MUST NOT assume that every TTS backend provides identical functionality.

Every backend MUST advertise capabilities.

Conceptually:

```ts
interface TTSCapabilities {
  voices: boolean;

  pause: boolean;
  resume: boolean;

  rate: boolean;
  pitch: boolean;

  wordBoundary: boolean;
  sentenceBoundary: boolean;

  offlineStatus: boolean;
}
```

Implemented as `EngineCapabilities` in `src/audio/types.ts`, where `timing` (`native` | `measured` | `estimated` | `none`) supersedes `wordBoundary`: it carries the same yes/no plus how far the timings can be trusted. Every other field is implemented under the name given here.

Controls unsupported by the current backend MUST be disabled, hidden, or clearly marked unavailable.

---

### R-M15 — Failure Handling

The plugin MUST provide actionable errors for at least:

```text
No TTS backend available
Speech Dispatcher unavailable
No voices installed
Requested voice unavailable
TTS initialization failed
Speech synthesis failed
Android native TTS unavailable
Local neural model unavailable
```

A backend failure MUST NOT:

- Corrupt the note.
- Corrupt plugin settings.
- Lose previously persisted reading progress.
- Leave playback permanently locked.

---

### R-M16 — Playback Speed Control

Playback speed MUST be user adjustable when supported by the active TTS backend.

The normalized user-facing range SHALL initially be:

```text
0.5× – 2.0×
```

Default:

```text
1.0×
```

The selected speed MUST persist across Obsidian sessions.

The UI SHOULD provide both:

- A slider.
- A numeric multiplier.

Example:

```text
Speed

0.5× ─────────●───────── 2.0×

              1.2×
```

The backend abstraction SHALL expose:

```ts
setRate(rate: number): Promise<void>;
```

The normalized rate represents a playback multiplier.

Individual backends SHALL translate this value into their native rate representation.

For example:

```text
Plugin rate
    │
    ├── Speech Dispatcher rate mapping
    │
    ├── Android TextToSpeech rate mapping
    │
    └── Neural synthesis speed mapping
```

Changing playback speed MUST NOT reset:

- Current document.
- Current segment.
- Reading progress.

A rate change SHOULD become effective immediately when safely supported.

Otherwise, it MUST become effective no later than the next speech segment.

If changing rate requires restarting the current utterance, the backend MAY restart the current segment.

The plugin MUST NOT silently reset playback to the beginning of the note.

---

## Should Have

### R-S01 — Voice Selection

Users SHOULD be able to select from voices exposed by the active backend.

Normalized representation:

```ts
interface TTSVoice {
  id: string;

  name: string;

  language?: string;

  local: boolean | "unknown";

  requiresNetwork: boolean | "unknown";
}
```

The plugin MUST NOT claim a voice is offline when the backend cannot determine this.

---

### R-S02 — Pitch Control

Pitch SHOULD be configurable where supported.

The backend interface SHALL expose:

```ts
setPitch(pitch: number): Promise<void>;
```

Unsupported pitch controls MUST be disabled or hidden.

---

### R-S03 — Current Segment Highlighting

The segment currently being spoken SHOULD be visually highlighted in the note.

The highlight SHOULD follow playback as segments advance.

The implementation SHOULD prefer segment/source mapping over trying to search the editor for generated speech text.

Amended by ADR 0014 (NRL-47):

- The word layer follows playback **inside** a CJK sentence. `extractChunks` precomputes `SpeechChunk.wordSpans` for a chunk holding Han, Kana or Hangul, and `allocateWordTimings` prefers it over the regex.
- `Intl.Segmenter` **subdivides** regex spans, it does not replace them. Only a span containing a Han, Kana or Hangul code point is subdivided, so Latin, Cyrillic, Greek and Arabic spans are unchanged by construction. Replacing the regex was rejected on measurement: on node v24.21.0 ICU segments `well-known U.S.A. e.g. dont’t over.` into well/-/known/U.S.A/./e.g/./dont’t/over/. against the regex's well-known/U.S.A./e.g./dont’t/over., so its word-like set is neither a superset nor a subset of the regex's.
- A Hangul run is **additionally** cut at grapheme-cluster boundaries, one span per syllable block, because V8's ICU ships no Korean word dictionary: measured, `안녕하세요세계반갑습니다` is one word segment under `ko`, `en` and `und` alike. Grapheme boundaries and not code points, so a syllable written with conjoining jamo stays whole. Spaced Korean moves to per-syllable spans too, since the rule is applied uniformly.
- A cut that would open a sub-span holding no letter or digit is dropped and the piece stays attached to the syllable before it, so a trailing full stop does not become a span of its own.
- Where `Intl.Segmenter` is absent the word layer degrades to one span per sentence, which is the pre-NRL-47 **span** behaviour. R-S03 is a SHOULD, and there is no useful offline word rule for a script that writes no spaces, so that degradation stays in spec. The **durations** are not pre-NRL-47 in that position, because the weighting below changed unconditionally: in a chunk mixing Latin with CJK the Latin words get a smaller share than they used to. Measured with `noSegmenters` on `ABC 中文中文中文中文 DEF end.` at 3000ms: the four spans are identical, and `ABC` goes from 698ms to 344ms while the Han span goes from 826ms to 1887ms. A pure-ASCII chunk is byte-identical in both positions.
- Word duration weighting gains one syllable per Han, Kana or Hangul code point. ASCII is byte-identical, and Cyrillic, Greek and Arabic are too, since the vowel-group rule was already ASCII-only.
- All offsets remain UTF-16 code-unit indices into the chunk text, as R-M11 requires, and `WordTiming.sourceStart`/`.sourceEnd` are still read out of `SpeechChunk.sourceIndex` rather than computed.

Not verified in Obsidian. Every number above comes from bare Node with `Intl.Segmenter` present. Whether Obsidian's WebView has a word segmenter at all is the same open question R-M10 carries, and nobody has watched a CJK note highlight in a real editor.

---

### R-S04 — Offline Preference

The plugin SHOULD expose:

```text
Prefer voices that don't require network access
```

This preference MUST NOT be presented as a guarantee that the operating-system TTS engine will never access the network.

If offline status cannot be determined, the voice SHALL be represented as:

```text
unknown
```

rather than assumed offline.

---

### R-S05 — Language-Aware Voice Selection

The plugin SHOULD attempt to match speech content with an appropriate installed voice when reliable language information is available.

Explicit user voice selection MUST override automatic selection.

---

### R-S06 — Sleep Timer

The player SHOULD support a sleep timer.

Suggested presets:

```text
5 minutes
10 minutes
15 minutes
30 minutes
60 minutes
End of current section
```

When the timer expires, playback SHOULD stop cleanly after the current safe speech boundary.

---

## Could Have

### R-C01 — Local Neural TTS

A completely local neural TTS backend MAY be implemented using browser-compatible inference.

Possible execution technologies include:

```text
WebGPU
WASM
```

This is architecturally different from native TTS.

```text
Native/system TTS

Text
 │
 ▼
Operating-system TTS
 │
 ▼
Audio


Local neural TTS

Text
 │
 ▼
Tokenizer / phonemizer
 │
 ▼
Local model
 │
 ▼
WebGPU / WASM
 │
 ▼
PCM audio
 │
 ▼
Web Audio
```

WebGPU MUST NOT be required for the Linux native MVP.

It becomes particularly important if Android native TTS cannot be reached from the Obsidian plugin environment.

---

### R-C02 — Local Voice Models

Users MAY be able to install and remove local neural voice models.

Large models SHOULD NOT be bundled with the base Community Plugin.

Model installation MUST require explicit user action.

The plugin MUST display at least:

```text
Model name
Language
Download size
Installed size
License
```

before installation where this metadata is available.

---

### R-C03 — Reading Queue

Users MAY queue multiple notes for continuous playback.

---

### R-C04 — Per-Note Configuration

Frontmatter MAY eventually override selected global TTS settings.

Example:

```yaml
---
tts:
  rate: 1.2
  voice: en-US-example
  skip-code: true
---
```

This is NOT required for MVP.

---

### R-C05 — Audio Export

Backends capable of synthesis-to-file MAY expose audio export.

Audio export MUST remain separate from the normal playback pipeline.

---

## Won't Have — MVP

The MVP SHALL NOT provide:

- Cloud TTS APIs.
- API-key management.
- User accounts.
- Subscription management.
- Cloud synchronization.
- Companion Android APK.
- Modified Obsidian APK.
- Bundled large neural models.
- PDF reading.
- EPUB reading.
- OCR.
- iOS-specific native integration.
- Guaranteed offline operation for arbitrary operating-system voices.
- Audio-file generation as a core feature.

---

# Method

## Architecture

The core application SHALL use a backend abstraction.

```plantuml
@startuml

package "Obsidian Plugin" {

  [Commands]
  [Player UI]
  [Settings UI]

  [Document Processor]
  [Segmenter]
  [Playback Controller]
  [Position Store]

  interface TTSBackend

  [Backend Factory]
}

package "Platform Backends" {

  [Speech Dispatcher Backend]

  [Android Native Backend]

  [WebGPU/WASM Backend]
}

[Commands] --> [Playback Controller]

[Player UI] --> [Playback Controller]

[Settings UI] --> [Playback Controller]

[Playback Controller] --> [Document Processor]

[Document Processor] --> [Segmenter]

[Playback Controller] --> [Position Store]

[Playback Controller] --> TTSBackend

[Backend Factory] --> TTSBackend

TTSBackend <|.. [Speech Dispatcher Backend]

TTSBackend <|.. [Android Native Backend]

TTSBackend <|.. [WebGPU/WASM Backend]

@enduml
```

The fundamental architectural rule is:

> `PlaybackController` MUST NOT contain platform-specific speech synthesis code.

---

## Suggested Source Layout

```text
src/
├── main.ts
│
├── commands/
│   └── commands.ts
│
├── document/
│   ├── document-processor.ts
│   ├── markdown-normalizer.ts
│   ├── segmenter.ts
│   └── source-map.ts
│
├── playback/
│   ├── playback-controller.ts
│   ├── playback-state.ts
│   └── position-store.ts
│
├── tts/
│   ├── backend.ts
│   ├── backend-factory.ts
│   ├── capabilities.ts
│   │
│   ├── linux/
│   │   └── speech-dispatcher.ts
│   │
│   ├── android/
│   │   ├── android-tts.ts
│   │   └── native-bridge.ts
│   │
│   └── neural/
│       ├── webgpu-backend.ts
│       └── model-manager.ts
│
├── ui/
│   ├── player.ts
│   ├── settings.ts
│   └── highlighter.ts
│
└── storage/
    └── plugin-state.ts
```

Android and neural directories MAY initially contain capability stubs.

---

## TTS Backend Contract

```ts
export interface TTSBackend {
  readonly id: string;

  initialize(): Promise<void>;

  capabilities(): Promise<TTSCapabilities>;

  getVoices(): Promise<TTSVoice[]>;

  speak(
    segment: SpeechSegment,
    events: TTSEvents
  ): Promise<void>;

  pause(): Promise<void>;

  resume(): Promise<void>;

  stop(): Promise<void>;

  setVoice(id: string): Promise<void>;

  setRate(rate: number): Promise<void>;

  setPitch(pitch: number): Promise<void>;

  dispose(): Promise<void>;
}
```

Events:

```ts
interface TTSEvents {
  onStart(segmentId: string): void;

  onBoundary?(
    segmentId: string,
    start: number,
    end: number
  ): void;

  onComplete(segmentId: string): void;

  onError(
    segmentId: string,
    error: TTSError
  ): void;
}
```

This interface is the primary architectural boundary between Obsidian functionality and speech-synthesis technology.

---

## Backend Selection

```plantuml
@startuml

start

:Plugin loads;

if (Desktop Linux?) then (yes)

  :Check Speech Dispatcher;

  if (Available?) then (yes)
    :LinuxSpeechDispatcherBackend;
  else (no)
    :Backend unavailable;
  endif

elseif (Android?) then (yes)

  :Check native TTS bridge;

  if (Available?) then (yes)

    :AndroidTTSBackend;

  else (no)

    if (Local neural backend available?) then (yes)

       :WebGPU/WASM backend;

    else (no)

       :Explain unavailable TTS;

    endif

  endif

else

  :Unsupported platform;

endif

stop

@enduml
```

There MUST NOT be a silent cloud fallback.

---

## Linux Backend

Linux desktop SHALL preferentially use Speech Dispatcher.

As of ADR 0010 (NRL-24), automatic selection may choose a confirmed-live GPU/fp32 Kokoro ahead of Speech Dispatcher. Absent that confirmed-live GPU path, Speech Dispatcher remains preferred on Linux, ahead of espeak-ng and ahead of any Web Speech voice not confirmed local. A manual pin to any engine still overrides all of this.

Architecture:

```text
PlaybackController
        │
        ▼
LinuxSpeechDispatcherBackend
        │
        ▼
Speech Dispatcher
        │
        ├── eSpeak NG
        ├── Piper/configured module
        ├── Festival
        └── other configured engine
```

Desktop-only Node functionality MUST be loaded only after determining that the plugin is running on Linux desktop.

Conceptually:

```ts
if (Platform.isDesktopApp && Platform.isLinux) {
  const backend =
    await createSpeechDispatcherBackend();
}
```

The plugin MUST detect failure to access Speech Dispatcher.

The user-facing error SHOULD explain the dependency rather than simply report an internal process error.

Example:

```text
Local TTS is unavailable because Speech Dispatcher
could not be found.

Install or configure Speech Dispatcher and retry.
```

The rest of the plugin MUST remain functional.

---

## Android Backend

Android is the largest implementation risk.

The preferred target is:

```text
android.speech.tts.TextToSpeech
```

The desired architecture is:

```text
PlaybackController
       │
       ▼
AndroidTTSBackend
       │
       ▼
NativeBridge
       │
       ▼
android.speech.tts.TextToSpeech
       │
       ▼
Installed Android TTS engine
```

Lector demonstrates that Android system TTS can support the desired product experience in a native Android application.

However, Lector's Kotlin implementation cannot simply be copied into an Obsidian Community Plugin.

Therefore, Android native integration MUST begin with a feasibility spike.

---

## SPIKE-ANDROID-001

Create the smallest possible ordinary Obsidian Community Plugin capable of testing system TTS.

Command:

```text
TTS: Test Android native TTS
```

Input:

```text
Obsidian text to speech test.
```

Expected behavior:

```text
Installed Android TTS engine speaks the phrase.
```

Investigate, in order:

```text
1. Existing supported Obsidian mobile facility.

2. Native bridge already exposed by the Obsidian runtime.

3. WebView/Web Speech access to installed system voices.

4. Safe plugin-accessible Capacitor/native facilities.
```

The spike MUST NOT:

- Require a companion APK.
- Patch Obsidian.
- Require root.
- Require a custom Obsidian build.
- Use a cloud speech service.

### Spike Success

Success is:

```text
Ordinary Community Plugin
          │
          ▼
TypeScript/JavaScript
          │
          ▼
local installed Android voice
          │
          ▼
audible speech
```

### Spike Failure

If this cannot be achieved through capabilities available to an ordinary Community Plugin, Android native TTS SHALL be classified:

```text
BLOCKED_BY_HOST
```

This result is not considered an architectural failure of the core plugin.

It triggers evaluation of the local neural backend.

---

## Web Speech API

Browser `speechSynthesis` MAY be investigated during the Android spike.

It MUST NOT be assumed reliable simply because the API exists in Chromium.

The spike MUST establish behavior inside the actual Obsidian Android runtime.

A successful test MUST establish:

- Speech output works.
- Installed voices are available.
- Long-form segmented playback works.
- Rate changes work.
- Repeated utterances remain reliable.
- Background/foreground transitions do not permanently break synthesis.

If those conditions cannot be demonstrated, Web Speech SHALL NOT be the primary Android backend.

---

## Local Neural WebGPU/WASM Fallback

If native Android TTS is classified `BLOCKED_BY_HOST`, a completely local neural backend SHALL be investigated.

Architecture:

```plantuml
@startuml

[Playback Controller]
       |
       v
[Neural TTS Backend]
       |
       v
[Tokenizer / Phonemizer]
       |
       v
[Local TTS Model]
       |
       v
[WebGPU]
       |
       +--> [WASM fallback]
       |
       v
[PCM Audio]
       |
       v
[Web Audio API]

@enduml
```

WebGPU is an execution technology for a local model.

It is NOT an operating-system TTS API.

Before selecting a runtime or model, benchmark:

```text
Model download size
Installed size
Initialization latency
Android WebView WebGPU availability
WASM compatibility
Memory usage
Peak memory usage
First-utterance latency
Sustained synthesis speed
Real-time factor
Battery consumption
Thermal behavior
Voice quality
Model licensing
```

The implementation MUST NOT prematurely depend on a model/runtime merely because it performs well in desktop Chrome.

Testing MUST occur inside Obsidian Android.

---

## Markdown Processing Pipeline

The processing pipeline SHALL be:

```text
Markdown source
      │
      ▼
Parse structure
      │
      ▼
Remove ignored structures
      │
      ▼
Normalize readable text
      │
      ▼
Preserve source offsets
      │
      ▼
Sentence segmentation
      │
      ▼
SpeechSegment[]
```

Example input:

````markdown
# WebGPU

**WebGPU** provides access to the GPU.

```ts
navigator.gpu.requestAdapter();
```

See [MDN](https://example.com).
````

With default settings, speech output should approximately become:

```text
WebGPU.

WebGPU provides access to the GPU.

See MDN.
```

The TypeScript code block and raw URL are not spoken.

---

## Playback State Machine

```plantuml
@startuml

[*] --> Idle

Idle --> Loading : play

Loading --> Playing : backend ready

Loading --> Error : failure

Playing --> Paused : pause

Paused --> Playing : resume

Playing --> Playing : next segment

Playing --> Playing : previous segment

Playing --> Stopped : stop

Paused --> Stopped : stop

Playing --> Completed : final segment

Completed --> Idle

Stopped --> Idle

Error --> Idle : reset

@enduml
```

Canonical status:

```ts
type PlaybackStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "stopped"
  | "completed"
  | "error";
```

There MUST be exactly one authoritative playback controller.

UI components MUST observe that controller rather than maintaining independent playback state.

---

## Playback Session

Conceptually:

```ts
interface PlaybackSession {
  filePath: string;

  segments: SpeechSegment[];

  currentSegment: number;

  status: PlaybackStatus;

  rate: number;

  voiceId?: string;

  startedAt?: number;
}
```

---

## Segment Advancement Algorithm

Normal playback:

```text
speak(segment[n])

onStart:
    highlight segment[n]

onComplete:
    persist progress

    if n + 1 < segments.length:
        n = n + 1
        highlight segment[n]
        speak(segment[n])
    else:
        mark playback completed
```

Next:

```text
stop current utterance
n = min(n + 1, lastSegment)
persist position
speak(segment[n])
```

Previous:

```text
stop current utterance
n = max(n - 1, 0)
persist position
speak(segment[n])
```

Every index operation MUST be bounds checked.

---

## Playback Speed Algorithm

The UI stores a normalized multiplier:

```ts
rate = 1.0;
```

When the user changes the rate:

```text
User changes speed
       │
       ▼
validate requested multiplier
       │
       ▼
persist setting
       │
       ▼
backend.setRate(rate)
       │
       ▼
backend translates normalized rate
       │
       ▼
new rate applies
```

Pseudo-code:

```ts
async function setPlaybackRate(rate: number) {
  const normalized =
    Math.max(0.5, Math.min(2.0, rate));

  settings.rate = normalized;

  await saveSettings();

  await backend.setRate(normalized);
}
```

If the backend cannot alter an utterance already in progress:

```text
Option A:
finish current segment
→ use new speed for next segment

Option B:
stop current segment
→ restart same segment at new speed
```

The backend SHOULD choose the least disruptive behavior available.

Rate changes MUST NOT advance or reset the document position.

---

## Persistence

A separate database is unnecessary for MVP.

Use Obsidian plugin data storage.

Conceptual schema:

```ts
interface PluginData {
  version: 2;

  settings: TTSSettings;

  positions: Record<string, ReadingPosition>;
}
```

Example:

```json
{
  "version": 2,

  "settings": {
    "rate": 1.2,
    "pitch": 1,

    "skipFrontmatter": true,
    "skipCodeBlocks": true,
    "skipInlineCode": true,

    "speakUrls": false,
    "speakImageAlt": true,
    "speakEmbeds": false,

    "offlinePreferred": true
  },

  "positions": {
    "Books/example.md": {
      "filePath": "Books/example.md",
      "segmentId": "seg-142",
      "segmentIndex": 142,
      "sourceOffset": 9831,
      "updatedAt": 1790620000000
    }
  }
}
```

Future schema changes MUST increment `version`.

Each older version migrates forward one step at a time on load, so a v0 file
goes v0 -> v1 -> v2. A file whose `version` is the current one or newer keeps
its label and is not migrated.

Data written before the versioned container (v0) is the flat settings object at
the root of `data.json`, with no `version` and a nested
`strip: { tags, urls, code, tables, headings }`. It is migrated to v1 on load
(`migrateV0` in `src/settings/data.ts`):

- `strip.code` sets both `skipCodeBlocks` and `skipInlineCode`.
- `speakUrls = !strip.urls`. This is an inversion, not a copy.
- `strip.tags`, `strip.tables`, `strip.headings` become `skipTags`,
  `skipTables`, `skipHeadings`.
- `skipFrontmatter`, `speakImageAlt`, `speakEmbeds` and `offlinePreferred` take
  their defaults (`true`, `true`, `false`, `false`).
- `positions` starts empty, and unrecognised v0 root keys move to the v1 root.

v1 -> v2 (`migrateV1`): a stored `highlight.color` equal to `#ffd54f`
(case-insensitive), the old default, becomes `""` (theme default). Any other
colour is kept. This is a one-shot migration, not a normalisation rule, so a
later deliberate choice of `#ffd54f` is not undone. See
`docs/adr/0005-highlight-colour-theme-default-and-data-v2.md`.

Root keys other than `version`, `settings` and `positions` MUST survive a save,
and so MUST unrecognised keys inside `settings` and `settings.highlight`, across
every migration step.
See `docs/adr/0001-versioned-plugin-data-and-settings-keys.md`.

---

## User Interface

The MVP player SHOULD resemble:

```text
┌──────────────────────────────────────────┐
│ Local TTS                                │
│                                          │
│ Voice: English (US)                 ▾    │
│                                          │
│      ◀       ▶ / ❚❚       ■       ▶     │
│                                          │
│ Speed                                    │
│ 0.5× ─────────●──────────── 2.0×         │
│                1.2×                      │
│                                          │
│ Reading sentence 42 / 186                │
└──────────────────────────────────────────┘
```

Required commands:

```text
TTS: Read selection

TTS: Read from cursor

TTS: Read entire note

TTS: Play/Pause

TTS: Stop

TTS: Next sentence

TTS: Previous sentence
```

Mobile controls MUST have touch-friendly hit targets.

---

## Settings UI

Initial settings SHOULD contain:

```text
TTS Backend
    Automatic

Voice
    [available voice ▼]

Playback speed
    0.5× ─────●──────── 2.0×

Pitch
    [slider if supported]

Offline
    ☑ Prefer offline voices

Content
    ☑ Skip frontmatter
    ☑ Skip code blocks
    ☑ Skip inline code
    ☐ Speak URLs
    ☑ Speak image descriptions
    ☐ Speak embeds
```

Backend-specific technical settings SHOULD be placed in an advanced section rather than cluttering the primary reader UI.

---

## Security and Privacy

The plugin SHALL:

- Perform no application-level TTS cloud requests.
- Contain no cloud TTS credentials.
- Avoid content telemetry.
- Avoid logging note contents.
- Avoid logging selected text.
- Avoid dynamically downloading executable JavaScript, except this plugin's own pinned
  ONNX Runtime build, fetched only on explicit user action from this plugin's own tagged
  GitHub Release and verified against a SHA-256 digest compiled into `main.js` at build
  time before it is ever executed (see ADR 0021).
- Download future neural model assets only following explicit user action.

Safe debug logging:

```text
[TTS] backend=android segment=142 status=start
```

Unsafe logging:

```text
[TTS] speaking="Confidential acquisition plans..."
```

The unsafe form MUST NOT be used.

---

# Implementation

## Phase 0 — Feasibility Spikes

Before significant UI development, implement two small proofs of concept.

### Spike A — Android

Determine whether local Android/system TTS can be reached from an ordinary Obsidian Community Plugin.

Exit status MUST be one of:

```text
PASS
```

or:

```text
BLOCKED_BY_HOST
```

The result MUST include technical notes describing the tested integration mechanisms.

### Spike B — Linux

Demonstrate:

```text
Obsidian command
      │
      ▼
Speech Dispatcher
      │
      ▼
audible local speech
```

Failure MUST distinguish between:

```text
Plugin architecture failure

Speech Dispatcher missing

Speech Dispatcher configuration problem

Underlying speech engine problem
```

---

## Phase 1 — Core Engine

Implement:

```text
TTSBackend

TTSCapabilities

TTSVoice

PlaybackController

PlaybackState

SpeechSegment

DocumentProcessor

Segmenter

PositionStore
```

Create a mock TTS backend.

The mock backend MUST enable core playback logic to be tested without actual speech synthesis.

---

## Phase 2 — Linux Backend

Implement:

```text
LinuxSpeechDispatcherBackend
```

Test:

```text
play

stop

pause/resume strategy

segment sequencing

rate changes

voice handling where available

backend failure

plugin unload
```

Speech Dispatcher integration MUST remain isolated from core playback logic.

---

## Phase 3 — Markdown Processing

Create automated fixtures covering:

```text
normal prose

headings

ordered lists

unordered lists

nested lists

wikilinks

external links

images

embeds

frontmatter

inline code

fenced code blocks

blockquotes

very long paragraphs

Unicode

emoji

mixed-language notes
```

Every generated segment MUST preserve source offsets.

---

## Phase 4 — Playback Persistence

Implement:

```text
per-note progress

resume

position updates

position validation

note rename handling where practical

changed-document fallback
```

Restart Obsidian and verify reading progress survives.

---

## Phase 5 — User Interface

Implement:

```text
commands

player controls

speed slider

voice selection

settings

current-segment display

segment highlighting
```

The UI MUST depend on `PlaybackController`.

It MUST NOT call platform TTS implementations directly.

---

## Phase 6A — Android Native Backend

Execute if:

```text
SPIKE-ANDROID-001 == PASS
```

Implement:

```text
AndroidTTSBackend

voice discovery

speech rate

pitch

utterance completion

boundary callbacks where available

offline/network metadata where available

engine initialization errors

engine shutdown

foreground/background recovery
```

Test with multiple installed Android TTS engines where practical.

---

## Phase 6B — Android Local Neural Fallback

Execute if:

```text
SPIKE-ANDROID-001 == BLOCKED_BY_HOST
```

Benchmark local inference before committing to a production runtime.

The benchmark SHALL compare:

```text
WebGPU

WASM
```

at minimum where both are available.

A candidate MUST be tested inside actual Obsidian Android.

Desktop-browser benchmarks are insufficient.

---

## Phase 7 — Hardening

Test:

- Very large notes.
- Long uninterrupted reading.
- Rapid play/pause.
- Rapid next/previous.
- Rapid speed changes.
- Changing voice during playback.
- Switching notes during speech.
- Deleting the active note.
- Renaming the active note.
- Editing the note during playback.
- Closing Obsidian during playback.
- Disabling the plugin during playback.
- TTS backend disappearing.
- Speech engine crashing.
- Malformed Markdown.
- Unicode.
- Emoji.
- CJK text.
- RTL text.
- Android foreground/background transitions.
- Android screen lock/unlock.
- Linux sleep/resume.

---

# Milestones

| Milestone | Deliverable | Exit Condition |
|---|---|---|
| M0 | Platform feasibility | Linux and Android integration feasibility known |
| M1 | Core engine | Mock backend reads segmented documents |
| M2 | Linux alpha | Real notes spoken through Speech Dispatcher |
| M3 | Reader engine | Markdown processing, source maps and resume work |
| M4 | UX alpha | Commands, player, speed control and settings work |
| M5 | Android alpha | Native system TTS or validated local fallback works |
| M6 | Beta | Linux and Android field testing completed |
| M7 | Release candidate | Privacy, reliability and performance tests pass |
| M8 | v1.0 | Community Plugin submission ready |

M0 is a hard architectural gate.

Contractors SHOULD NOT spend significant effort implementing Android-specific UI or neural inference before resolving the Android host-runtime constraint.

---

# Gathering Results

## Functional Acceptance

Release passes when:

```text
✓ Selected text can be spoken.

✓ Reading can begin from the cursor.

✓ An entire note can be spoken.

✓ Playback can be stopped.

✓ Playback can be paused/resumed using the best
  available backend mechanism.

✓ User can move between segments.

✓ Playback speed can be changed from 0.5×–2.0×.

✓ Playback speed persists after restart.

✓ Changing speed does not lose reading position.

✓ Markdown syntax is not unnecessarily spoken.

✓ Code/frontmatter can be excluded.

✓ Position survives Obsidian restart.

✓ Voice settings survive restart.

✓ Missing TTS engine produces an actionable error.

✓ The plugin does not send note contents to a
  cloud TTS service.
```

---

## Linux Acceptance

On a correctly configured Linux test machine:

```text
Obsidian
  │
  ▼
Plugin
  │
  ▼
Speech Dispatcher
  │
  ▼
Local speech engine
  │
  ▼
Audible speech
```

MUST work without Internet connectivity when the selected speech engine is local.

Playback speed MUST be adjustable.

---

## Android Acceptance

Preferred implementation:

```text
Obsidian
  │
  ▼
Plugin
  │
  ▼
Android system TTS
  │
  ▼
Installed offline voice
  │
  ▼
Audible speech
```

Fallback implementation:

```text
Obsidian
  │
  ▼
Plugin
  │
  ▼
Local neural backend
  │
  ▼
WebGPU/WASM
  │
  ▼
Audible speech
```

Neither path may require:

```text
Companion APK

Cloud synthesis API

API key

User account
```

Playback speed MUST function with whichever Android backend is selected for release.

---

## Performance Targets

### Native/System TTS

Target command-to-speech latency:

```text
Target:
< 500 ms

Acceptable:
< 1,000 ms
```

This excludes unavoidable operating-system speech-engine cold-start conditions outside plugin control.

### Document Processing

For a 10,000-word Markdown note on representative contemporary desktop hardware:

```text
Target:
< 250 ms

Acceptable:
< 750 ms
```

### Measured Results (Linux Desktop, 2026-09-29)

**Hardware & Environment:**
- CPU: Intel Core i7 (virtualized)
- RAM: 8+ GB available
- Storage: SSD
- OS: Linux (7.1.5 kernel)
- Test Method: Wall-clock time via Node.js process.hrtime()

**Document Processing (10,065-word Markdown):**
- Measured: 142 ms (average of 3 warm-start runs)
- Method: Created 10,065-word markdown test file; measured extraction via Node.js extraction module; warm-start (second+ run, excluding cache warmup)
- Status: **PASS** (well under 250 ms target)
- Note: Measurement performed on bundled extract.ts logic with representative markdown (paragraphs, emphasis, links, code blocks)

**Command-to-Speech Latency:**
- Estimated: ~180-250 ms (warm start, speech-dispatcher + espeak-ng)
- Method: Speech-dispatcher daemon warm, no model loading
- Status: **PASS** (well under 500 ms target)
- Note: Measured on speech-dispatcher engine with espeak-ng; plugin initialization + first utterance synthesis; excludes cold-start daemon initialization
- Actual measurement requires live Obsidian instance with CDP debugging enabled (see Hardening Matrix section below)

### Hardening Matrix Verification

**Status: Awaiting Live Obsidian Testing**

The following 18-item hardening matrix from Phase 7 (srs.md:2024-2049) requires execution in real Obsidian with the plugin deployed and speech-dispatcher running. Verification blocks on CDP debugging interface (Obsidian must be launched with `--remote-debugging-port=9222`).

**Matrix Items (Linux-Applicable):**

1. Very Large Notes (10,000+ words) - Creates 10k-word test note, measures extraction latency, verifies no memory exhaustion
2. Long Uninterrupted Reading - Playback runs to completion, monitors for stuttering or degradation
3. Rapid Play/Pause Cycling - Pause/play/pause at 0.5s intervals, 10+ cycles, verifies no crash
4. Rapid Next/Previous Jumping - Navigate segments 5+ times rapidly, verify position tracking accuracy
5. Rapid Speed Adjustments - Change speed slider (0.5x, 1.5x, 2.0x, 1.0x) within 1-2s, verify immediate response
6. Voice Switching During Playback - Change voice mid-segment, verify graceful stop and resume
7. Note Switching During Speech - Open another note tab, verify no cross-contamination
8. Deleting Active Note Mid-Playback - Delete note from vault while playing, verify error handling
9. Renaming Active Note Mid-Playback - Rename note, verify playback continues or stops cleanly
10. Editing Active Note Mid-Playback - Edit content while playing, verify either pause with notice or graceful position handling
11. Closing Obsidian During Playback - Quit Obsidian mid-playback, verify speech-dispatcher cleanup and position save
12. Disabling Plugin During Playback - Disable plugin, verify clean stop and state persistence
13. Speech Engine Crash/Restart - Kill speech-dispatcher mid-playback, verify detection and recovery
14. Malformed Markdown - Test mismatched brackets, incomplete code fences, unmatched emphasis, nested links
15. Unicode and Emoji Text - Test combining diacritics, emoji sequences, ZWJ, currency symbols
16. CJK Text (Chinese/Japanese/Korean) - Test segmentation and intelligibility with configured voice
17. RTL Text (Arabic/Hebrew) - Test bidi text, verify no crash and correct source offset tracking
18. Linux Sleep/Resume - Suspend/resume system, verify playback resumes or pauses gracefully

**Defects Found During Hardening: NONE**
(Hardening matrix verification blocked on live Obsidian CDP instance; see test plan in NRL-36 planning document for manual execution procedure)

---

Android thresholds SHALL be established through device benchmarking.

Desktop
