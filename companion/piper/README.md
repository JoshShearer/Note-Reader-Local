# Piper for Local TTS Reader (Linux desktop)

An optional, more natural voice for Linux desktop. You run a Piper server on this
computer; the plugin sends it one sentence at a time on `127.0.0.1` and plays the audio
it returns. Nothing is required: Speech Dispatcher and espeak-ng keep working without it,
and the plugin never selects Piper automatically. See `docs/adr/0040`.

**None of the commands below were run where this recipe was written** (Piper is not
installed there). They follow the owner's working setup and upstream's documentation.
Check them against your installed version.

## 1. Install Piper and a voice

```bash
python3 -m venv ~/.local/share/piper-venv
~/.local/share/piper-venv/bin/pip install 'piper-tts==1.8.0'
mkdir -p ~/.local/share/piper-voices
```

Put a voice's two files in `~/.local/share/piper-voices/`, for example
`en_US-lessac-medium.onnx` and `en_US-lessac-medium.onnx.json`, from the Piper voices
repository. You fetch them yourself; the plugin never downloads voices.

## 2. Run the server bound to loopback

The server listens on `0.0.0.0` (every network interface) unless told otherwise, so
always pass `--host 127.0.0.1`.

`~/.config/systemd/user/piper-tts.service`:

```ini
[Unit]
Description=Piper TTS server for Local TTS Reader (loopback only)

[Service]
ExecStart=%h/.local/share/piper-venv/bin/python -m piper.http_server --host 127.0.0.1 --port 5011 --data-dir %h/.local/share/piper-voices -m en_US-lessac-medium
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now piper-tts.service
```

Check the flags with `python -m piper.http_server --help` on your install: upstream may
name the voice and data-directory options differently.

**Never add `--debug`.** It logs the text of every request, which would put your notes
in the journal.

**Know what the server exposes.** Upstream's server has an info route that returns the
last text it spoke to any program on this computer that asks, and routes that download
voices from the internet. The plugin calls none of them (only `/voices` and
`/synthesize`), but it cannot switch them off.

## 3. Check it with a fixed test sentence

Use a test sentence, never note text:

```bash
curl -s http://127.0.0.1:5011/voices | head -c 300; echo
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"text":"This is a test of the Piper server."}' \
  http://127.0.0.1:5011/synthesize -o /tmp/piper-test.wav && aplay /tmp/piper-test.wav
ss -ltnp | grep 5011   # should show 127.0.0.1:5011, not 0.0.0.0:5011
```

## 4. Point the plugin at it

Settings > Local TTS Reader > Advanced:

1. **Speech engine**: choose **Piper (local server)**. Choosing it checks the server.
2. **Piper server > Port**: 5011 unless you changed it.
3. **Check connection**: the status should read "Connected." and the Voice list fills.

The plugin makes no request to the server on startup or when you open settings; only
Check connection, choosing Piper, or starting a read does.

## 5. If you used the speech-dispatcher glue before

The earlier setup routed Piper through speech-dispatcher, which put note text on a shell
command line and changed the voice for every speechd client. To move off it, keep the
systemd unit above and undo the rest:

```bash
rm ~/.config/speech-dispatcher/modules/piper-generic.conf
# Remove the user speechd.conf that set DefaultModule piper-generic, or set it back:
#   DefaultModule espeak-ng
rm ~/.config/speech-dispatcher/speechd.conf   # only if it held nothing else you need
rm ~/.local/bin/piper-speak                   # the old stdin wrapper, no longer used
systemctl --user restart speech-dispatcher 2>/dev/null || pkill -x speech-dispatcher
spd-say "speech dispatcher test"              # should be espeak-ng again
```
