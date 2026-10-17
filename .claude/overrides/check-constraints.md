# /check-constraints - Local TTS Reader detection table

Rules: `AGENTS.md` "Non-negotiables" (1-10) and "Verification rules" (11-15). Use these checks in
place of derived ones (Step 1). `BASE` as in the shared command. A hit is a candidate; read around
it. Cite by function or constant name, not line number: lines drift (`AGENTS.md` "Style").

| # | Grep (added `+` / changed `±` lines) | BLOCK when | N-A when |
|---|---|---|---|
| 1 | `+` in `src/`: `trace\(\|reportError\(\|new Notice\(\|console\.(log\|warn\|error)\|new Error\(\|throw ` | A payload carries `chunk.text`, `req.chunk.text`, `msg.text`, `source`, a selection, `cleaned.text`, or the bridge token, including inside an error message (`reportError` puts it in a `Notice` **and** the log). Also BLOCK if `trace()`'s 256 KiB tail slice in `src/diagnostics.ts` was removed. Ceiling: `${source.length} chars`. FP: test-file `new Error`, fixed-string `Notice`, `e.message` from a `which` failure | no `src/` change |
| 2 | `+` in `src/engines/`: `args\.push\|runner\.(run\|spawn)\(\|exec\|execSync\|shell:` | Chunk text in an `args` array or template-literal argument; `exec`, `execSync` or `shell: true` anywhere. `ProcessRunner.run(bin, args, stdin, signal)`: text is the third argument | no engine change |
| 3 | `+` `sendBeacon\|analytics\|telemetry\|sentry\|posthog\|mixpanel\|amplitude\|crashReport\|navigator\.connection` (`-i`) | Any hit that is not a comment saying there is none | |
| 4 | `+` `api[_-]?key\|apiKey\|elevenlabs\|azure\|polly\|openai\|speechify\|googleapis\|deepgram` (`-i`); `Authorization\|Bearer` outside `src/engines/bridge/` | A cloud endpoint, credential, account or automatic fallback. Sanctioned: `huggingface.co` in `src/ui/modelStore.ts` (model download), the loopback `BRIDGE_HOST` with its pairing token in `src/engines/bridge/readMe.ts` (ADR 0036) | |
| 5 | `±` in `src/engines/onnx/`: `isRemote\|assertLocal\|installFetchShim\|allowRemoteModels\|allowLocalModels\|useFS\|useBrowserCache\|wasmPaths\|localModelPath` | Read `kokoro.worker.ts`: `isRemote` still true for cross-origin http(s), not inverted, no host allowlist; `assertLocal` still called for model base, ORT glue module and ORT WASM binary in `initInner`; the fetch shim still throws on an unresolved remote URL; `env.allowRemoteModels`, `useFS`, `useFSCache`, `useBrowserCache` all still `false`. Fix the path, never the guard | nothing matched |
| 6 | `+` in `src/`: `fetch\(\|XMLHttpRequest\|requestUrl\|https?://` | A fetch reachable from `onload`, `onLayoutReady`, `warmUpEngine`, `prepare()`, `isAvailable()` or a settings render path, even to a legitimate host. Bridge fetches go only to `BRIDGE_HOST` and only on a user read | |
| 7 | `+` in `src/`: `(from \|require\()["'](child_process\|fs\|path\|os\|node:)`; `±` `isDesktopOnly` in `manifest.json` | Run the `require-list` gate from `project.md` `## Gates` after `npm run build`. BLOCK on any other `require`, `isDesktopOnly` true, a top-level `child_process` import replacing `loadChildProcess` in `spawn.ts`, an `import()` of a builtin, or Linux engines constructed outside `shouldConstructLinuxDesktopEngines` / the bridge outside `shouldConstructBridgeEngine` (`src/engines/platform.ts`) | no import or dependency change (say the bundle was not rebuilt) |
| 8 | `±` in `src/text/`, `src/audio/words.ts`, `src/ui/highlight.ts`: `sourceIndex\|pushSpace\|emit\(\|continue\|indexOf\|\.search\(` | Every added or moved `continue` in `cleanLine` emits or `pushSpace`s on purpose; every new synthetic join pushes a gap entry like `mergeShort` does. Prove it: `node build-tests.mjs tests/extract.test.ts && node tests/.build/extract.test.mjs`. BLOCK on `sourceIndex.length !== text.length` for any chunk, or highlighting by searching the document for spoken text | nothing matched |
| 9 | `±` in `src/audio/`, `src/engines/`: `ownsPlayback\|playbackRate\|\bspeed\b\|req\.rate\|setRate`; `±` in `tests/player.test.ts`: `1\.5\|seen\[0\]\|playbackRate` | `Player` no longer passes `rate: engine.capabilities.ownsPlayback ? this.rate : 1`; an engine declares `ownsPlayback: true` and returns `kind: "buffer"`; any expected value under `rate is applied once, not twice` in `tests/player.test.ts` changed | |
| 10 | `±` in `src/settings/`, `src/main.ts`, `deploy.mjs`: `normaliseSettings\|DEFAULT_SETTINGS\|saveData\|loadData\|Object\.keys\|delete \|KEEP_BY_NAME` | Normalisation drops keys it does not recognise; a new persisted key bypasses that; an added `delete`/`Object.keys` filter over stored data; `deploy.mjs` stops protecting `data.json` or dotfiles | |
| 13 | number with unit, as the shared measurement grep, plus `threads?\|chars/s` | as the shared rule | |
| 14 | `+` `which\(\|spawn\(\|npm run \|npx \|--version` | A dependency on a binary or script absent here: `which spd-say espeak-ng obsidian`, `node -e "console.log(Object.keys(require('./package.json').scripts).join(' '))"`. Check this machine; the history's install facts are dated | |

| 15 | `±` in `src/text/`; a ticket body or PR body this change files or cites | An extraction fix whose ticket has no `Vault evidence:` line and no owner report (WARN, not BLOCK, for a pre-ADR-0039 ticket); a ticket or PR body that quotes note text or a note path (BLOCK, rule 1); a BLOCK raised only from a generated input that the vault does not contain (strike it, list it as a residual) | no `src/text/` change |

The `\|` above is table escaping: in the shell it is a plain `|` inside `grep -E`.

Rule 11 probe (is the deployed build newer than the change). `<vault>` is the default vault in
`deploy.mjs`. A deploy older than the source, or no deploy, is **UNKNOWN**, never PASS or BLOCK:

```bash
SLOT="<vault>/.obsidian/plugins/local-tts-reader"
cat "$SLOT/.deployed-from" 2>/dev/null || echo "no marker"
find src manifest.json styles.css esbuild.config.mjs -newer "$SLOT/main.js" 2>/dev/null | head -5
```

Rule 12 is the shared reproduction row.
