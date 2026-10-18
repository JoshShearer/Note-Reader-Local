# /verify override - Local TTS Reader

Rules: `AGENTS.md` "Verification rules" 11-15. CDP traps: `docs/agent-history.md` "Driving a real
Obsidian over CDP". `<vault>` is the default vault in `deploy.mjs`;
`SLOT=<vault>/.obsidian/plugins/local-tts-reader`.

## Step 3: reading the gates

`npm test` runs every registered suite and prints a per-suite `ok` / `FAIL` / `CRASH` table,
aggregate check counts and, on failure, a final `FAILING SUITES:` line. Report those lines
verbatim. A red `engine` suite: check `spd-say --version` and `spd-say -O` first; with
`NRL_SKIP_REAL_SPEECHD` set, report the SKIP lines as partial coverage.

## Step 4: take the slot and deploy

1. **Don't take `.claude/deploy.lock/`.** It binds `/run-tickets` lanes only. If it is held, a
   lane is mid-deploy to the same folder: wait for it to clear or report the deploy as not run,
   naming the holder. Never deploy over a held lock. Preconditions: the vault exists
   (`deploy.mjs` exits 1 with `Not a vault` otherwise) and Obsidian is installed. **Re-check how,
   on this machine** (rule 14): `which obsidian`, `flatpak list --app | grep -i obsidian`. The
   history records the Flatpak `md.obsidian.Obsidian`; on 2026-10-12 this machine had the Arch
   `obsidian` package instead and no Flatpak, so its `user-flags.conf` lives in that install's
   config directory, not under `.var/app`.
2. `npm run deploy` (builds, copies `main.js`, `manifest.json`, `styles.css`, prunes other
   top-level entries except `data.json` and dotfiles). Then write the marker:

   ```bash
   printf '%s\nbranch=%s commit=%s at=%s\n' "$(git rev-parse --show-toplevel)" \
     "$(git branch --show-current)" "$(git rev-parse --short HEAD)" "$(date -u +%FT%TZ)" \
     > "$SLOT/.deployed-from"
   ```

3. **Reload** (Ctrl+P, `Reload app without saving`, or toggle the plugin). A copied `main.js`
   does nothing until reloaded; without it the observation is of the previous build.
4. Record the instance: Obsidian version, platform, engine, and for Kokoro the weights build and
   whether it landed on WebGPU or WASM. A GPU claim needs `--enable-features=Vulkan` in the
   install's `user-flags.conf`; absent, the run says nothing about the GPU path.

## Step 5: drive it

The UI surface is the ribbon icon `Read this note aloud`, the `addCommand` names in `src/main.ts`
(`Read note aloud`, `Read selection`, `Read from cursor`, `Pause or resume reading`, `Stop
reading`, `Repeat current sentence`, `Next sentence`, `Previous sentence`, `Test Android native
TTS`, as of 2026-10-12), the control bar's `n / total`, and Settings -> Local TTS Reader.

Baseline checks, plus the issue's acceptance criteria:

| Check | Do | Watch for |
|---|---|---|
| Reading starts | `Read note aloud` on a real note | Audible speech; time to first sound by stopwatch if you quote it |
| Highlight tracks | Watch the editor through a heading, a list and a code fence | The highlighted word is the spoken word; drift means `sourceIndex` is out of lockstep (8) |
| Pause / stop | `Pause or resume reading` twice, then `Stop reading` | Name the engine; no orphan subprocess, no overlapping audio on restart |
| Rate | Change rate mid-read, at 1x and 1.5x | Applied once; 1.5x that sounds like 2.25x is rule 9 broken |
| Settings survive | Change a setting, reload Obsidian | It survived **and** nothing else in `data.json` was lost (10) |
| Kokoro | Read cold | No network request (DevTools Network, all), no first-utterance stall beyond what you measured |
| Engine coverage | Settings engine dropdown | Name which of `kokoro`, `espeak`, `speechd`, `webspeech`, `readme` you used. A pass on one is not a pass on all |

`readme` (bridge) and mobile behaviour need Obsidian on the Android phone over CDP with Read Me
Offline running; that phone is the Read-Me repo's one-phone slot, so respect its lock
(`.claude/device.lock/` in that repo). Unavailable: that row is `NOT RUN`.

`npm run test:obsidian` needs Obsidian started with `--remote-debugging-port=9222`, the plugin
enabled and a Kokoro model installed. Confirm the port (`curl -s --max-time 2
http://127.0.0.1:9222/json/version`) and its owner (`ss -ltnp | grep 9222`) before trusting a
result. Not reachable: `NOT RUN`, never passing.

## Spikes and recorded answers

A ticket whose deliverable is a recorded answer (`SPIKE-ANDROID-001`, a measurement in
`docs/spikes/` or `docs/agent-history.md`) is verified by checking the answer names date, device
or host, build and what was not established.
