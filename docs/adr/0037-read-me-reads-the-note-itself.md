# 0037. Read Me Offline reads the note itself

- Status: accepted
- Date: 2026-10-16
- Ticket: NRL-130 (follow-up); the Read Me side is Read Me's REA-39
- Requirements: R-M03, R-S03
- Amends: `docs/adr/0036` (the engine was a buffer engine at rate 1.0)
- Contract owner: the Read Me repo, its `srs.md` "Bridge contract (v1)" and its ADR 0014

## Context

`ReadMeBridgeEngine` fetched a WAV per chunk from Read Me Offline's `/synthesize` and the
Player played it in Obsidian's WebView. Read Me's REA-39 reproduced the owner's report on the
reference phone (Pixel 9 Pro XL, GrapheneOS, Android 17, 2026-10-08): about 5 s after Obsidian
left the foreground, Android logged `AudioHardening background playback muted for md.obsidian`
and blocked its audio focus, while the plugin went on reporting `playing`. Android 17 mutes
background media from an app with no foreground service, and a plugin cannot give Obsidian one.
Read Me Offline has a `mediaPlayback` foreground service, and its own reading was not muted.

## Decision

- The engine owns playback (`ownsPlayback: true`, `pause`/`resume` a pair). The Player passes
  the user's rate and, through `SynthRequest.following`, the chunks after the one asked for.
- The first `synthesize` of a read sends that chunk and the ones after it to `POST /play` in
  one request (U+001E between chunks, up to Read Me's 1 MiB and 10,000 chunks, stopping at a
  blank chunk). Read Me reads them in its own service, so the reading does not depend on
  Obsidian's JavaScript, which may be throttled in the background.
- Each `synthesize` resolves when `GET /status` is past its chunk (polled every 250 ms). Only
  the next chunk in order continues the session; any other chunk, or a new rate, is a jump and
  starts a new `/play`. An abort (Stop, or the Player moving) sends `/control?action=stop`.
- A session Read Me stopped (its lock screen, or an article started in Read Me) ends the read
  with `BridgeStoppedError`, which does not fall back.
- `isAvailable()` requires `"play": true` on `/health` and otherwise says to update Read Me
  Offline to 1.1.0 or later. The `/synthesize` route is no longer used by the plugin.

## Consequences

- A note read through Read Me goes on with the screen off and Obsidian in the background;
  the lock screen and headset controls are Read Me's (it shows "Obsidian note").
- An engine that owns playback is `playing` before its first request is answered (the
  Player's `announcePlaying`), so a refusal of the first chunk (busy, a rejected token) reaches
  the Player's error report instead of failing the fallback attempt: the read ends where it is
  and does not fall back to Kokoro. Before, a 401 fell back.
- A pause from Read Me's lock screen is not pushed to the plugin: its controls still show
  playing until the user acts, and Play/Pause from the plugin still reach the session.
- The highlight can lag Read Me by up to one poll, and catches up a chunk at a time when
  Obsidian returns from the background.
- Read Me Offline 1.0.x stops working with this plugin until it is updated.
