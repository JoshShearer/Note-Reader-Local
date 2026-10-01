# Local TTS Reader

Read your notes aloud with on-device text-to-speech and word highlighting. No cloud, no API keys, no subscriptions.

## Features

- **On-Device Speech Synthesis** - Four TTS backends, all running locally on your machine or
  device. Which ones you can actually use depends on the host; see
  [System Requirements](#system-requirements).
  - Linux desktop: Speech Dispatcher (eSpeak NG, Festival, Piper, etc.), or `espeak-ng` driven
    directly
  - macOS/Windows: System-provided voices (via Web Speech API)
  - All platforms including Android: Local neural TTS via Kokoro (WebGPU where the host offers an adapter, otherwise WASM. Android is always the WASM path, single-threaded - see [Android](#android))
- **Word-Level Highlighting** - Current word highlights as you read, driven by source offsets
- **Multiple Content Exclusions** - Skip code blocks, frontmatter, headings, tables, and more
- **Automatic Engine Selection** - Ranks available engines by confirmed real-time quality
- **Customizable Playback** - Speed, voice, highlight color, buffer-ahead sizing
- **Reading Position Memory** - Resume from where you left off

## Privacy

Your notes never leave your device. No telemetry, no crash reporting, no analytics. The plugin is entirely offline-first.

The one thing it will ever download is Kokoro model weights and a voice file, and only after you
click Download. Expect roughly 92 MB to 326 MB for the weights depending on the build you
choose, plus about 510 KB for the voice. The speech runtime itself is part of the plugin: there
is no runtime download, no CDN, and nothing fetched in the background or on first read. If you
never click "Download", nothing is ever fetched.

## Installation

**Not yet available through Community Plugins Browse.** This release has not been submitted to
or accepted into the Obsidian community directory, so searching for it will not find anything.

To install it manually, copy three files - `main.js`, `manifest.json` and `styles.css` - into
`<your vault>/.obsidian/plugins/local-tts-reader/`, then restart Obsidian and enable it under
Settings → Community plugins. There is nothing else to install; the ONNX runtime is inside
`main.js`.

## Usage

1. Open any note in Obsidian
2. Click the **Read this note aloud** button in the ribbon, or run **Read note aloud** from the
   command palette. No default hotkey ships - bind one yourself under Settings → Hotkeys if you
   want one.
3. Adjust playback speed, voice, and content preferences in Settings

## System Requirements

- **Desktop** (Linux, macOS, Windows): Obsidian 1.8.0+ declared in the manifest
- **Android**: Obsidian 1.8.0+ declared in the manifest

These minimums are the plugin's declared floor, not a tested matrix. Desktop has been exercised
on Obsidian 1.13.7 on Linux. Android has been exercised on a Pixel 9 Pro XL running Android 17,
whose WebView (`app.vanium.webview`, Chromium 154) has WebAssembly SIMD and
`DecompressionStream`; the bundle loads there, inflates the runtime, and speaks. It is also
noticeably slower than desktop, for a reason the plugin cannot change - see
[Android](#android) below. Older Android WebViews remain unmeasured, and the declared floor of
1.8.0 is not a claim that 1.8.0 works.

### Linux

Requires `speech-dispatcher` and at least one output module (e.g. `speech-dispatcher-espeak-ng`).

```bash
# Ubuntu/Debian
sudo apt-get install speech-dispatcher speech-dispatcher-espeak-ng

# Fedora
sudo dnf install speech-dispatcher espeak-ng
```

The separate `espeak-ng` engine skips the daemon and drives the `espeak-ng` binary directly;
install the `espeak-ng` package if you want it. Of the two Linux paths, Speech Dispatcher is the
one this repo's tests exercise against a real daemon - `espeak-ng` is covered against a fake
process runner only - so treat it as the less exercised of the two.

### macOS / Windows

Uses your system's built-in voice synthesis (Siri, Cortana, or equivalent).

### Android

Kokoro is the only engine available on Android. The device's native TTS engine is not
reachable: Obsidian exposes no TTS facility of its own, its bundled Capacitor bridge has no
`TextToSpeech` plugin compiled in, and Obsidian's Android WebView does not implement
`window.speechSynthesis` at all. This was confirmed by measurement on real hardware rather
than assumed. A diagnostic command, **Test Android native TTS**, reports the details and
lands on `BLOCKED_BY_HOST`; it exists so the finding can be rechecked, not because the path
works.

Kokoro on Android requires a WebView with **WebAssembly SIMD** support. Devices whose WebView
predates roughly 2021, or that ship a vendor-frozen WebView component with no Play Store
updates, do not have it. The bundled ONNX runtime is a SIMD build and there is no non-SIMD
fallback, so on those devices Kokoro will not run and no other engine is available. Test the
engine on your own device before relying on it.

#### Android is CPU-only and single-threaded

Obsidian's Android WebView runs with `crossOriginIsolated === false` and no
`SharedArrayBuffer` at all, so the ONNX runtime cannot use its thread pool and Kokoro falls
back to a single CPU thread no matter what the thread setting says. On the device measured
here, a 2.9-second sentence took 8 to 20 seconds to synthesise, so the model generates audio
several times slower than real time.

This is a property of the host, not a setting you can change: a plugin cannot set the
cross-origin isolation headers that would unlock threads. Playback is still correct, because
the player synthesises ahead of the playhead and the audio element then plays in real time -
you will simply wait longer for the first sentence, and a long note will keep a running
head start rather than speaking instantly. Expect desktop-class speed to be unavailable on
Android, and treat a first-sentence wait of several seconds as normal rather than as a fault.

## Troubleshooting

### "No speech engine is available"

1. **Linux**: Ensure `speech-dispatcher` is running: `systemctl --user start speech-dispatcher`
2. **All platforms**: Check Settings → Local TTS Reader → Engine Status
3. **Kokoro users**: The model is not downloaded automatically. Go to Settings → Local TTS
   Reader, pick a weight build, and click its **Download** button. The button states the size
   before you commit to it. Nothing is fetched on load, on prewarm, or on first read - the
   runtime is already inside the plugin, and only the weights and voice are a download.

### Voice not changing

Engine selection is per-voice-group. When you switch engines, your previous voice choice is not available (it was scoped to the old engine). Pick a new voice from the list.

### Plugin not responding

Try reloading Obsidian. If issues persist, check the console (Ctrl+Shift+I on desktop) for error messages.

## Settings

### Reader

- **Engine** - Choose your TTS backend or use automatic selection
- **Voice** - Select a voice for the active engine
- **Rate** - Playback speed (0.5x - 2x)
- **Buffer Ahead** - Number of sentences to synthesize in advance
- **Highlight Color** - Customize word highlight (or follow your theme)

### Content

Toggle which parts of your note are read:
- Skip Code Blocks, Inline Code, Frontmatter
- Speak URLs, Image Alt Text, Embeds
- Skip Headings, Tables

### Kokoro (Advanced)

For Kokoro users only. There are three weight builds, and the trade-off is not a straight
size-for-quality one:

- **GPU (fp32)** - ~326 MB. Highest quality, roughly ten times faster than playback on a
  discrete GPU. Requires WebGPU.
- **Fast (q4f16)** - ~155 MB. Moderate quality, about real-time synthesis on a desktop CPU.
  The desktop default, and the best balance.
- **Small (q8)** - ~92 MB. Lower quality and noticeably slower synthesis, meant for phones and
  bandwidth-constrained devices.

The smallest file is not the fastest one. On a four-thread desktop CPU, the int8 build
synthesises about 2.5x slower than real time while q4f16 runs at roughly 1x, which is the
difference between a pause after every sentence and continuous speech. So the small build is
offered for phones, where download size and the memory ceiling matter more than throughput.

On Android, weigh that more heavily still. The Android WebView never gets extra cores at all
(see [Android](#android)), so the small build's throughput disadvantage compounds rather than
being absorbed. If you have the bandwidth, the fast (q4f16) build is the better choice on a
phone; pick the small build when the download size is what actually stops you.

Whether desktop reliably gets those extra cores is itself not something to assume. On one
real desktop install exercised directly (Obsidian 1.13.7, Flatpak, Linux), the 4-thread WASM
load failed on every attempt - `Uncaught worker error at step loading model on wasm with 4
thread(s)` - and fell back to 1 thread, reproducing identically across a full process restart.
`crossOriginIsolated` was `false` there too; `SharedArrayBuffer` existed as a constructor
(Electron enables it independently of cross-origin isolation), but the threaded runtime still
would not load. A single-threaded run on that machine produced 4,925 ms of audio in about
13,100 ms, roughly 2.7x real time - in the same range as the Android figures above, not the
4-thread "roughly 1x" this section otherwise describes. Whether this is a Flatpak-specific
sandboxing effect or something broader has not been established; it just means the 4-thread
figure above should be read as the best case, not the default, until it is confirmed on more
than one install.

Whichever you pick, the first one you choose is a download you have to approve - anywhere from
~92 MB to ~326 MB, plus a ~510 KB voice file. English (US and UK) only: the phonemizer is
English, and a control to download other languages is deliberately absent rather than
present and broken.

The remaining Kokoro controls:

- **Device** - GPU (WebGPU) if available, CPU otherwise
- **Threads** - Number of CPU threads (multithreading may reduce latency)
- **Model** - Download and select among published Kokoro voice models

## Architecture

The plugin splits speech synthesis into four independent engines, each with its own backend:

- **Speech Dispatcher** (Linux desktop) - Interfaces with the system's configured speech engine
- **espeak-ng** (Linux desktop) - Drives the `espeak-ng` binary directly, with no daemon in
  between
- **Web Speech API** (Browser) - Uses browser voices (online/offline detection provided)
- **Kokoro** (All platforms) - Local neural synthesis via transformers.js + ONNX Runtime
  - The only engine available on Android, for the reasons above

Engine availability therefore depends on the host. Speech Dispatcher and `espeak-ng` are built
only on Linux desktop, and each additionally needs its own binary present - `spd-say` with a
running daemon and at least one output module, or `espeak-ng` on `PATH`. Web Speech needs a
browser or desktop runtime that implements `speechSynthesis`, and Kokoro needs a WebView with
WebAssembly SIMD.

Each engine advertises what it can do (pause, resume, pitch control, etc.) so the UI only enables controls that actually work.

### Where the ONNX runtime lives

Kokoro needs the ONNX Runtime, which is about 33 MB of WebAssembly. It ships inside the plugin bundle (gzipped, so about 10.6 MB of the 13.6 MB `main.js`) rather than being downloaded on first use. The reason is the Obsidian community plugin submission guidelines, which prohibit a plugin from installing or updating its own dependencies at runtime - a runtime fetched from a release URL is exactly that, however carefully it is verified.

The trade-off is real and worth stating plainly: every install is about 10.6 MB larger for the compressed runtime, whether or not you ever use Kokoro. What you get in exchange is that Kokoro works with no download step at all - the bundled files are inflated on load and verified against the publisher's SHA-256 after inflation - there is no URL to fail on a plane or behind a captive portal, and the three files Obsidian installs are the entire install. Model weights are still downloaded on demand, since those are data rather than executable code. Inflation uses `DecompressionStream`, which is verified on desktop Chromium but not on older Android WebViews.

## Contributing

This is a personal project maintained for the Obsidian community. Contributions are welcome via pull request.

## License

MIT - See LICENSE for details.

## Changelog

### 0.1.0 (Initial Release)

- Four speech backends - Speech Dispatcher, espeak-ng, Web Speech, and Kokoro - with automatic
  quality-ranked fallback selection. The two Linux backends are built only on Linux desktop;
  availability otherwise depends on the host; see System Requirements
- Word-level highlighting with source offset mapping
- Linux Speech Dispatcher backend (eSpeak NG, Festival, Piper, and other output modules)
- Web Speech backend (macOS, Windows, browsers)
- Kokoro local neural TTS (WebGPU/WASM), with the ONNX runtime bundled in rather than downloaded, in three weight builds
- Markdown processing with configurable exclusions
- Playback speed control
- Voice selection per engine
- Reading position memory

## See Also

- [Obsidian Plugin Documentation](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)
- [Speech Dispatcher](https://freebsoft.org/speechd)
- [Kokoro TTS](https://github.com/hexgrad/kokoro)
- [transformers.js](https://huggingface.co/docs/transformers.js)
