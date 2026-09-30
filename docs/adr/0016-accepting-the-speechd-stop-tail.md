# 0016. Accepting the speechd post-stop audio tail

- Status: accepted
- Date: 2026-09-30
- Ticket: NRL-43

## Context

`R-M07` (`srs.md:258`) requires a Stop control. On the `speechd` backend, Stop
does not produce silence: roughly 800 ms of speech continues after it.

NRL-41 reduced this from about 7.5 s to its current size by making the abort
reach the daemon (`spd-say -S`) instead of only killing the client process. It
recorded the remainder as a queued-message problem, on the following model:
`spd-say -w` is not an audio-end signal, so the Player runs one chunk ahead of
the audio; `-S` is SSIP `STOP ALL`, which stops the message being spoken but does
not flush a queue; and the queue-flushing verb `-C` (`CANCEL ALL`) is banned
because it would also flush a screen reader's queue.

That model implied a fix: talk SSIP over the daemon's unix socket instead of
shelling out to `spd-say`. One persistent connection makes `CANCEL self`
available, which is both queue-wide and scoped to our own client, and it makes
real `END` events available, so the Player need never run a chunk ahead again.
NRL-43 chose that option.

It was implemented in full and then measured. **It does not reduce the tail.**

## Measurement

Real `Player` driving the real `SpeechDispatcherEngine` against the real daemon
(speech-dispatcher 0.12.0-rc2, espeak-ng output module). Audio ground truth was
captured off the default sink monitor with `parec` (s16le / 16 kHz / mono); no
number here comes from a protocol reply. Four short chunks, **stopped twice**,
two runs each:

| transport | post-stop audio tail |
| --- | --- |
| `spd-say -S` (`STOP ALL`) | 810 ms, 800 ms |
| SSIP `CANCEL self` over one persistent connection | 810 ms, 800 ms |

Total audible audio during the read was ~6.0 s either side. The `-S` figure
reproduces the ~830 ms NRL-41 recorded, which is what calibrates the rig against
a previously known value.

Three further measurements explain why the transport is irrelevant here:

- With one message speaking and one queued, a single `CANCEL self` returns
  `213 OK CANCELED` and then `703 CANCELED` for **both** messages. The protocol
  does exactly what the model wanted, and the audible tail does not move.
- In a single-utterance probe, audio **began about 700 ms after** the cancel had
  already been acknowledged.
- `701 BEGIN` fires 3-10 ms after a message is queued, so it marks acceptance,
  not audio start. Nothing in SSIP reports when sound actually begins or ends
  relative to the device.

Taken together: by the time a stop is issued, the daemon has already committed
that speech to its output module and to PulseAudio, and it does not reclaim it.
The cancel verb was never the bottleneck.

## Decision

**Accept the ~800 ms tail on `speechd`, and keep `spd-say` as the transport.**

- The Stop path stays exactly as NRL-41 left it: `spd-say -S` on abort, only ever
  while one of our own utterances is in flight.
- `-C` / `CANCEL ALL` remains banned, unchanged, for the reason NRL-41 gave.
- The SSIP socket client is **not** merged.

## Consequences

The tail is a property of the backend, not of our code, and it bounds what
`R-M07` can mean on this engine. `srs.md` and `AGENTS.md` now say so with the
measured figure, so the next person does not re-derive the same dead end. The
three options NRL-43 listed as possible fixes are closed by construction:

1. Not running a chunk ahead does not help. The tail survives even when nothing
   of ours is queued, because the speech already handed to the output module is
   what plays on.
2. Sending one chunk at a time trades the same tail for gaps between sentences.
3. Narrowing the `-C` ban would change nothing, since `CANCEL self` is already
   strictly better than `-C` at the protocol level and does not help.

The only remaining levers are in the user's own speech-dispatcher or espeak-ng
module configuration (audio buffering), and a plugin must not silently rewrite a
daemon shared with a screen reader.

Two things this ADR deliberately does not do, because they are separate from
`R-M07` and should be argued on their own merits rather than smuggled in as a
performance fix:

- **The `STOP ALL` collateral damage stays.** Pressing Stop still cuts off
  whatever another client sharing the daemon is saying at that instant. A
  connection-scoped `CANCEL self` would fix that, and it is the strongest
  remaining argument for the socket transport. It is an accessibility concern,
  not a latency one.
- **The pacing stays approximate.** `synthesize()` still resolves on `-w`, so the
  Player can still run a chunk ahead of the audio after a stop. Real `END` events
  would fix that too.

The SSIP implementation that produced the measurements above is kept, unmerged,
on the local branch `fix/nrl-43-speechd-stop-queued-chunk` at commit `90e799b`.
It passed the full gate set and its own protocol suite, so it is a starting point
rather than a sketch if either bullet above is ever taken up.

## Notes for anyone measuring speechd again

The rig produced confident nonsense three times before it was right, and each
failure is easy to repeat:

- A silence test that requires N *consecutive* samples above a floor never fires
  on speech, because the waveform crosses zero constantly. Use a windowed peak
  envelope. The first version of the rig reported "no audio" while speech was
  audibly playing.
- `parec` on this machine's HDMI sink delivers its first sample ~2.0 s after
  launch from cold, and then emits a burst containing audio from before that
  point (4.00 s of samples over 3.48 s of wall time). A sample clock anchored on
  first-data is therefore ~2 s out, which manufactured a 1888 ms "reproduction"
  that did not exist. Wake the sink first, then capture.
- Calibrating that offset with a tone measures the sink *waking*, not pipeline
  latency, so it cannot be applied as a constant. Prefer a metric that needs no
  clock at all: total audible audio across the capture.
- A single-stop read does not reproduce the defect. `spd-say -w` blocks correctly
  for a message that is not queued behind another, so a plain serial read never
  overlaps; only the utterance submitted just after a stop returns early. The
  tail needs a **second** stop to appear, which is how NRL-41 measured it.
