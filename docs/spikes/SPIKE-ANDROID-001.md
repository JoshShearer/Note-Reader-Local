# SPIKE-ANDROID-001: Android System TTS Access

## Result
**BLOCKED_BY_HOST** - demonstrated on a real device, not assumed.

---

## Hardware & Environment

| Property | Value |
|----------|-------|
| Device | Huawei P30 Pro (model `VRD-W09`) |
| Android Version | 10 (SDK 29) |
| Obsidian Version | 1.13.8 |
| Obsidian Platform | Android, Capacitor-based |
| WebView | Android System WebView, Chrome/88.0.4324.93 |
| Test Date | 2026-09-29 |
| Access method | `adb` over USB + Chrome DevTools Protocol against the live `webview_devtools_remote_<pid>` socket Obsidian already exposes. No companion APK, no root, no patched Obsidian, no custom build - the socket is one Obsidian's own Capacitor/WebView stack opens for any USB-debugging-enabled host. |

---

## Investigation Order (per srs.md:1197-1207)

### Step 1: Existing Obsidian mobile facility
**Result: none found.**

`app` (Obsidian's public API object) was enumerated for the live session; no key
matching `speech`, `tts`, `voice`, or `audio` exists. Obsidian does not document
or expose a TTS-related API to plugins.

### Step 2: Native bridge already exposed by the Obsidian runtime
**Result: none found.**

Two objects that look bridge-shaped are injected into the page: `window.androidBridge`
(a plain `postMessage`/`addEventListener` port, the standard Android
`addJavascriptInterface` shape, with no TTS-related methods) and
`window.nativeBridge` (empty, a Capacitor internal placeholder - see step 4). Neither
exposes anything resembling `android.speech.tts.TextToSpeech`.

### Step 3: WebView/Web Speech access to installed system voices
**Result: the API does not exist in this WebView.**

```js
typeof window.speechSynthesis        // "undefined"
typeof window.SpeechSynthesisUtterance // "undefined"
```

Measured directly in the live page via `Runtime.evaluate`. This is a known limitation
of Android's stock WebView component (distinct from full Chrome for Android): the Web
Speech *synthesis* API has historically not shipped in WebView regardless of the
underlying Chromium version. Because the API is absent outright, none of the six
`srs.md:1256-1263` conditions (speech output, voice availability, long-form playback,
rate changes, repeated-utterance reliability, background/foreground safety) are
reachable to test - there is nothing to call.

### Step 4: Safe plugin-accessible Capacitor facilities
**Result: Capacitor is present; no TTS plugin is compiled into this Obsidian build.**

Obsidian's Android app is a Capacitor app. `window.Capacitor` and
`window.Capacitor.Plugins` are live and enumerable:

```js
Object.keys(Capacitor.Plugins)
// ["App", "KeepAwake", "Device", "Keyboard", "SecureStorage", "StatusBar",
//  "RateApp", "SplashScreen", "Clipboard", "Haptics", "CapacitorCookies",
//  "WebView", "Filesystem", "Preferences", "CapacitorHttp", "Browser"]
```

No TTS plugin is on that list, and `Capacitor.Plugins` is a fixed whitelist compiled
into the native APK at build time, not something a plugin can extend at runtime.
Confirmed directly rather than inferred:

```js
Capacitor.isPluginAvailable('TextToSpeech')
// false

const p = Capacitor.registerPlugin('TextToSpeech');
await p.speak({ text: 'test' });
// throws: '"TextToSpeech" plugin is not implemented on android'
```

`registerPlugin` lets JavaScript *declare* a plugin interface, but calling any method
on it round-trips to the native side and fails there, because there is no matching
Kotlin/Java implementation bundled into Obsidian's APK. Adding one would mean shipping
a custom Obsidian build, which the spike explicitly forbids.

---

## Findings

All four investigation routes were exercised against the real Obsidian Android
runtime, not assumed:

1. No documented or undocumented Obsidian-exposed TTS facility.
2. No native bridge to `android.speech.tts.TextToSpeech` reachable from plugin JS.
3. `window.speechSynthesis` does not exist in this WebView; Web Speech is not merely
   unreliable here, it is entirely absent.
4. Capacitor is the app's native bridge, but its plugin set is fixed at build time and
   contains no TTS plugin; a community plugin cannot add one without patching Obsidian.

None of the four routes available to an ordinary Community Plugin reach Android
system TTS or any system-voice-backed synthesis. Per `srs.md`'s Spike Failure clause,
this is not an architectural failure of the core plugin - it is the trigger for the
local neural (Kokoro) backend already implemented for Android.

**Caveat on generality:** this was one Huawei device on Android 10, and Web Speech's
absence in Android WebView is a documented general limitation rather than a
device-specific quirk (unlike, say, Chrome for Android itself, which does implement
it). The Capacitor plugin whitelist and the absence of any TTS bridge in the running
Obsidian binary are true of the shipped app itself, not of this device, so they should
reproduce on any Android build of Obsidian at the same version. A second device is not
expected to change the result, but has not been run.

---

## Verification method

This was run twice, at two different levels of confidence:

1. **Direct API probing.** With Obsidian already open on the device and USB debugging
   on, `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` exposes the
   live page's Chrome DevTools Protocol endpoint. `Runtime.evaluate` calls against it
   produced every snippet quoted above, executed in the actual WebView Obsidian users
   run in, not a bare-Node approximation.
2. **The command itself, end to end.** The `TTS: Test Android native TTS` command
   (added to `src/main.ts` by this same change) was built with `npm run build`, pushed
   into this device's real vault via `app.vault.adapter.write()` (the same API the
   plugin itself uses), loaded with `app.plugins.loadManifests()` +
   `app.plugins.enablePluginAndSave('local-tts-reader')`, and invoked with
   `app.commands.executeCommandById('local-tts-reader:test-android-native-tts')` -
   the same call the command palette makes. The plugin's own diagnostics log recorded
   the result:

   ```text
   [2026-09-29T23:20:43.008Z] .obsidian/plugins/local-tts-reader: android TTS spike
   BLOCKED_BY_HOST
   ```

   matching the direct probes exactly. The test deployment (plugin folder, enablement,
   diagnostics log) was removed from the device afterward; nothing from this
   investigation was left installed in the vault used to run it.

---

## Impact on Codebase

Two previously unproven claims are now corrected to the demonstrated result:

1. **`src/engines/onnx/kokoro.ts`** (top-of-file comment): now states that Android
   system TTS was investigated on real hardware (SPIKE-ANDROID-001) and found
   unreachable through every route available to a community plugin, so the Kokoro
   WebView engine is the only viable on-device path today, not "the only engine that
   works" by assumption.
2. **`src/ui/settingsTab.ts`** (Kokoro model setting description): no longer claims the
   plugin "attempts to use system TTS on Android" - no such attempt exists in the
   codebase and none is possible given this finding.

---

## Next Steps

- None required to close R-M03/SPIKE-ANDROID-001: BLOCKED_BY_HOST is a valid, demonstrated
  terminal result per `srs.md`'s Spike Failure clause.
- If Obsidian ever ships a TTS-capable Capacitor plugin in a future release, this spike
  should be re-run against that version before revisiting the architecture.
