# Retired: the prototype native-TTS bridge

The bridge the `local-tts-reader` plugin speaks to on Android is now **Read Me Offline**,
a standalone Android reader in its own repo:
<https://github.com/JoshShearer/Read-Me>. Its `srs.md` R-M12 and "Bridge contract (v1)"
are the contract, and the plugin's engine is `src/engines/bridge/readMe.ts`
(`docs/adr/0036`, NRL-130).

This directory used to hold `io.loopstring.ttsbridge`, a one-Activity prototype used to
take the 2026-09-30 / 2026-10-01 measurements in `AGENTS.md` ("Android playback
throughput, and the native-TTS bridge"). It was removed so two bridge implementations
cannot drift. The source, `build.sh` and `measure.sh` that produced those numbers are in
commit `591ce17` (`git show 591ce17 -- companion/android/`).
