# Local TTS Reader

Read your notes aloud with on-device text-to-speech and word highlighting. No cloud, no API keys, no subscriptions.

## Features

- **On-Device Speech Synthesis** - Four TTS backends, all running locally on your machine or device
  - Linux: Speech Dispatcher (eSpeak NG, Festival, Piper, etc.)
  - macOS/Windows: System-provided voices (via Web Speech API)
  - All platforms: Local neural TTS via Kokoro (WebGPU/WASM, GPU-accelerated where available)
- **Word-Level Highlighting** - Current word highlights as you read, driven by source offsets
- **Multiple Content Exclusions** - Skip code blocks, frontmatter, headings, tables, and more
- **Automatic Engine Selection** - Ranks available engines by confirmed real-time quality
- **Customizable Playback** - Speed, voice, highlight color, buffer-ahead sizing
- **Reading Position Memory** - Resume from where you left off (planned)

## Privacy

Your notes never leave your device. No telemetry, no crash reporting, no analytics. The plugin is entirely offline-first.

## Installation

1. Open Obsidian Settings → Community Plugins → Browse
2. Search for "Local TTS Reader"
3. Click Install, then Enable

## Usage

1. Open any note in Obsidian
2. Click the speaker icon in the ribbon (or use `Ctrl+Shift+R` / `Cmd+Shift+R` on macOS)
3. Adjust playback speed, voice, and content preferences in Settings

## System Requirements

- **Desktop** (Linux, macOS, Windows): Obsidian 1.8.0+
- **Android**: Obsidian 1.8.0+

### Linux

Requires `speech-dispatcher` and at least one output module (e.g. `speech-dispatcher-espeak-ng`).

```bash
# Ubuntu/Debian
sudo apt-get install speech-dispatcher speech-dispatcher-espeak-ng

# Fedora
sudo dnf install speech-dispatcher espeak-ng
```

### macOS / Windows

Uses your system's built-in voice synthesis (Siri, Cortana, or equivalent).

### Android

Uses your device's native TTS engine. Kokoro is also available as an on-device fallback.

## Troubleshooting

### "No speech engine is available"

1. **Linux**: Ensure `speech-dispatcher` is running: `systemctl --user start speech-dispatcher`
2. **All platforms**: Check Settings → Local TTS Reader → Engine Status
3. **Kokoro users**: First use requires downloading model weights (automatic after one click)

### Voice not changing

Engine selection is per-voice-group. When you switch engines, your previous voice choice is not available (it was scoped to the old engine). Pick a new voice from the list.

### Plugin not responding

Try reloading Obsidian. If issues persist, check the console (Ctrl+Shift+I on desktop) for error messages.

## Settings

### Reader

- **Engine** - Choose your TTS backend or use automatic selection
- **Voice** - Select a voice for the active engine
- **Rate** - Playback speed (0.5x - 2.5x)
- **Buffer Ahead** - Number of sentences to synthesize in advance
- **Highlight Color** - Customize word highlight (or follow your theme)

### Content

Toggle which parts of your note are read:
- Skip Code Blocks, Inline Code, Frontmatter
- Speak URLs, Image Alt Text, Embeds
- Skip Headings, Tables

### Kokoro (Advanced)

For Kokoro users only. Choose between quality-focused (GPU) and speed-focused (CPU) synthesis.

- **Device** - GPU (WebGPU) if available, CPU otherwise
- **Threads** - Number of CPU threads (multithreading may reduce latency)
- **Model** - Download and select among published Kokoro voice models

## Architecture

The plugin splits speech synthesis into four independent engines, each with its own backend:

- **Speech Dispatcher** (Linux) - Interfaces with the system's configured speech engine
- **Web Speech API** (Browser) - Uses browser voices (online/offline detection provided)
- **Kokoro** (All platforms) - Local neural synthesis via transformers.js + ONNX Runtime
- **Android TTS** (Android only) - Native Android `TextToSpeech` API

Each engine advertises what it can do (pause, resume, pitch control, etc.) so the UI only enables controls that actually work.

## Contributing

This is a personal project maintained for the Obsidian community. Contributions are welcome via pull request.

## License

MIT - See LICENSE for details.

## Changelog

### 0.1.0 (Initial Release)

- Four TTS engines with automatic fallback selection
- Word-level highlighting with source offset mapping
- Linux Speech Dispatcher backend
- Web Speech API fallback (macOS, Windows, browsers)
- Kokoro local neural TTS (WebGPU/WASM)
- Markdown processing with configurable exclusions
- Playback speed control
- Voice selection per engine

## See Also

- [Obsidian Plugin Documentation](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)
- [Speech Dispatcher](https://freebsoft.org/speechd)
- [Kokoro TTS](https://github.com/hexgrad/kokoro)
- [transformers.js](https://huggingface.co/docs/transformers.js)
