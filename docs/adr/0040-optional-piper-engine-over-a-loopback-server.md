# 0040. An optional Piper engine over a loopback server

- Status: accepted
- Date: 2026-10-25
- Ticket: NRL-148
- Requirements: R-M02 (primary, unamended), R-M16, R-S01
- Authority for the destination: the owner's decision of 2026-10-22 (option A, "an
  optional built-in Piper engine" that talks "to a user-run Piper HTTP server on
  loopback"), and the ticket's constraint "only `fetch` to loopback, no new builtin".
  ADR 0036 is the precedent for an optional engine over 127.0.0.1.

## Context

The owner reads at 1.7x on Linux desktop and asked for a more natural voice. espeak-ng
is formant synthesis. Kokoro measured RTF 2.3-2.5 on the owner's machine (NRL-102) and
needs RTF <= 0.59 for 1.7x. Piper (`piper-tts` 1.8.0, `en_US-lessac-medium`) was set up
on the owner's machine as a speech-dispatcher `sd_generic` module, and the owner judged
it "much better". With the model kept loaded by `python -m piper.http_server`, a
141-character sentence took 0.28-0.40 s to a full WAV there (the ticket's measurement,
owner machine; nothing was measured in this pipeline).

That glue has three problems: `sd_generic` substitutes the text into an `sh -c` command
line, visible in `ps` (the reason behind non-negotiable 2); making it speechd's
`DefaultModule` changes the voice for every speechd client, screen readers included;
and the rate correction lives in a shell wrapper outside the plugin.

## Decision

1. **A new engine, `piper` (`src/engines/piper/piper.ts`), POSTs each sentence as JSON
   to `http://127.0.0.1:<piperPort>/synthesize` and plays the WAV it returns.** It is
   optional: no other engine changes, and it is never required.
2. **Constructed on Linux desktop only**, inside `shouldConstructLinuxDesktopEngines`,
   with `desktopOnly: true`. It needs no builtin: the default transport is Obsidian's
   `requestUrl`, chosen over `fetch` because the server probably sends no CORS headers
   (unverified), and over Node `http` because of non-negotiable 7.
3. **The host is a constant, `PIPER_HOST = "127.0.0.1"`; only the port is a setting**
   (`piperPort`, default 5011). The engine refuses any path but `/voices` and
   `/synthesize` (`ALLOWED_PATHS`), so it never calls the server's download, all-voices
   or info routes.
4. **The player owns the rate.** This is a buffer engine (`ownsPlayback: false`): it
   always renders at the voice's natural speed and the player sets `playbackRate`, so
   the rate is applied once (non-negotiable 9) and prefetch keeps working. The request
   carries no `length_scale` at all, so the voice's own default applies. The ticket's
   31% `length_scale` correction is therefore unnecessary.
5. **No request without a user action.** `isAvailable()`, `listVoices()` and
   `lastAvailability()` read a cache and never touch the server, because they run from
   onload, layout-ready prewarm and every settings render. The engine has no
   `prepare()`. The server is asked only by `check()`, which runs from Check connection
   (Advanced > Piper server), choosing Piper in the engine dropdown, and the start of a
   read with Piper pinned (`confirmManualEngine` in all three manual read paths), and by
   `synthesize()`. Before the first check the engine is listed but unavailable, with
   the reason "Not checked yet". This is how acceptance item 1 ("appears only when a
   loopback Piper server answers") is read: hiding it until a check runs would need a
   request at render time.
6. **No text to a port that has not just answered like Piper.** Every synthesis needs a
   cached Piper-shaped `/voices` answer for the configured port and probes first when
   there is none. Any failed synthesis (no answer, a non-200 status, a body that is not
   WAV) drops that answer, so the next sentence probes again.
7. **Manual-only.** `rankEngines` has no slot for `piper`, so automatic selection never
   reaches it.
8. **Messages are fixed strings.** No `trace()` in the engine; errors carry only the port
   or the HTTP status, and a server's error body is never read into a message
   (non-negotiable 1).

## Accepted limits

- **Upstream protocol is reviewer-read, not run.** Piper was not installed where this
  was written. The routes, the `{ text, voice }` body and the shape of `/voices` (an
  object keyed by voice name, read from local `.onnx.json` files) come from a reading of
  `OHF-Voice/piper1-gpl` `src/piper/http_server.py` at v1.8.0. They are isolated in one
  block of `piper.ts`. Older tags differ (v1.3.0 synthesizes on `POST /`).
- **The server's info route exposes the last sentence spoken** to any local process
  that asks. The plugin cannot change that. It is the same exposure class as the
  `sd_generic` problem, but narrower: one sentence, loopback, and it needs a request.
- **`--debug` makes the server log request text.** The recipe forbids it; the plugin
  cannot detect it.
- **`requestUrl` cannot be cancelled.** A timed-out or stopped request is abandoned
  (`withDeadline`) and may finish on the server; the engine's one-at-a-time queue moves
  on, so the server can briefly hold two requests.
- **Seeking back while prefetched sentences are queued** waits behind up to
  `bufferAhead` queued requests, because the player cancels pending work only on Stop.
  Not measured.
- **Bare-Node coverage stops at main.ts and the settings tab**, which import `obsidian`.
  The `requestUrl` mapping is tested through `makeRequestUrlTransport` with a stand-in;
  the real `requestUrl` is not exercised outside Obsidian.

## Consequences

- R-M02 needs no amendment: the engine is optional, manual-only and not a default.
  `srs.md` R-M02 carries a pointer here.
- The install recipe is `companion/piper/README.md`, including moving a machine off the
  `sd_generic` glue.
- `.claude/project.md`'s `outbound fetch` risk area and the Network rule texts in
  `.claude/overrides/` name the Hugging Face download and the bridge as the sanctioned
  destinations. They do not yet name the Piper loopback server; that wording is an
  owner follow-up recorded in NRL-148's PR.
- An older build reading `engine: "piper"` falls back to Automatic
  (`VALID_ENGINE_SELECTIONS`) and keeps `piperPort` as an unknown key (non-negotiable 10).
