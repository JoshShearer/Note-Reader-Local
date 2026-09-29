# SPIKE-ANDROID-001: Android System TTS Access

## Result
**BLOCKED_BY_HOST** - Investigation requires physical Android device with Obsidian installed

---

## Hardware & Environment

| Property | Value |
|----------|-------|
| Device | Not available |
| Android Version | N/A |
| Obsidian Version | N/A |
| Obsidian Platform | Android |
| Test Date | N/A |
| Blocker | No physical Android device available on this desktop Linux system |

---

## Investigation Plan

Per R-M03 (srs.md:1197-1207), the following investigation order was planned:

1. **Existing Obsidian mobile facility**: Check if Obsidian exposes a built-in TTS API or bridge to Android TextToSpeech
2. **Native bridge from Obsidian runtime**: Verify whether the Obsidian runtime exposes system TTS capabilities to plugins
3. **WebView/Web Speech API**: Test if the Web Speech API works in Obsidian's Android WebView and can access system voices
4. **Safe plugin-accessible Capacitor facilities**: Investigate any Capacitor bridges or other safe native access available to community plugins

---

## Web Speech Test Conditions (Deferred)

If Web Speech API is available on Android WebView (per srs.md:1256-1263), the following six conditions must be established:

| Condition | Acceptance | Evidence Required |
|-----------|-----------|---|
| Speech output works | Pass | Audible output from `speechSynthesis.speak()` |
| Installed voices are available | Pass | `speechSynthesis.getVoices()` returns system voices with `localService: true` |
| Long-form segmented playback works | Pass | 30-50 sequential utterances play smoothly without dropouts |
| Rate changes work | Pass | `SpeechSynthesisUtterance.rate` adjustment changes playback speed audibly |
| Repeated utterances remain reliable | Pass | Same text played 10 times consecutively without crashes/dropouts/voice selection failures |
| Background/foreground safe | Pass | App minimize/restore, notifications, lock/unlock do not permanently break synthesis |

**Status:** Not tested. All six conditions must pass for Web Speech to be viable as a primary backend on Android.

---

## Investigation Results

### Step 1: Obsidian Mobile API Check
**Status:** Not performed - no device available

### Step 2: Runtime Bridge Check
**Status:** Not performed - no device available

### Step 3: Web Speech API Check
**Status:** Not performed - no device available

### Step 4: Capacitor Check
**Status:** Not performed - no device available

---

## Findings

No physical Android device with Obsidian installed is available for testing. The investigation cannot proceed without hardware.

---

## Impact on Codebase

Two unproven claims existed in the codebase and have been corrected to reflect this uncertainty:

1. **src/engines/onnx/kokoro.ts** (lines 14-20): Updated comment to acknowledge that Android system TTS availability is unknown and requires device testing.

2. **src/ui/settingsTab.ts** (line 232): Updated description to note that system TTS availability on Android is unknown.

No code functionality was changed - only comments and descriptions were updated to be factual about current knowledge.

---

## Next Steps

1. Obtain access to an Android device with Obsidian installed
2. Deploy the plugin to the device's Obsidian instance
3. Follow the investigation order and test conditions above
4. Document results in this spike file
5. Update comments in kokoro.ts and settingsTab.ts based on actual findings
6. If Web Speech API is unavailable, update srs.md R-M03 with evidence

---

## Technical Notes

- The plugin currently asserts that Kokoro is "the only engine that works on Android" - this is contradicted by the codebase itself, which unconditionally pushes WebSpeech with `desktopOnly: false` on mobile.
- Android WebView system TTS availability on Obsidian mobile has never been tested.
- This spike was blocked before investigation could begin due to host hardware constraints.
