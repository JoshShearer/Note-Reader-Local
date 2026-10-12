# Override: /start-issue - Local TTS Reader

Architecture and module paths: `CONTEXT.md`. Known defects per area: `docs/agent-history.md`
"Known state"; before touching extraction, playback, engines, highlighting, settings, persistence
or the test runner, search that file for the function, requirement or ticket (`AGENTS.md` "Read on
demand").

## Step 1

The picker also lists `Backlog` issues.

## Step 7: area hazards beyond the rule text

Print the matching non-negotiables (numbers in `overrides/create-issue.md` Step 4), plus:

| Area | Also know |
|---|---|
| `src/text/**` | Stripping and `sourceIndex` change together, or highlighting corrupts silently. Fixtures are real notes |
| `src/engines/system/**` | `spawn.ts` does no platform gating; `registry.ts` decides construction via `shouldConstructLinuxDesktopEngines` (Linux desktop, not merely non-mobile) |
| `src/engines/onnx/**` | transformers.js and kokoro-js default to CDN URLs, which is why the guards exist. Weights live in the vault outside the plugin folder, so an update keeps them |
| `src/engines/bridge/**` | Optional, Android-only (`shouldConstructBridgeEngine`); the contract is owned by the Read-Me repo (ADR 0036) |
| `src/audio/player.ts` | `Player` knows its file but holds no document or vault handle; see `CONTEXT.md` before adding per-note state |
| `src/settings/**` | Plugin data holds reading positions too (ADR 0001); a whitelist rebuild erases them |
| `manifest.json`, `package.json`, `esbuild.config.mjs` | `npm run build` and the `require-list` gate are mandatory |
| New test suite | Register it in `package.json` `pretest`, the `AGENTS.md` gate line and `srs.md`'s release-gate bullet together |

## Step 8: reproduction

Bundle and run the real module: `node build-tests.mjs tests/<suite>.test.ts && node
tests/.build/<suite>.test.mjs`, with a temporary failing case. Only-visible-in-Obsidian bugs:
deploy per `overrides/verify.md` Step 4 and say you took the slot.
