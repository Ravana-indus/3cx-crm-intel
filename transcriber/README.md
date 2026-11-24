# Transcriber (Phase 2)

A separate Python process that pulls transcription jobs from the bridge over
localhost HTTP, converts 3CX audio, runs a speech engine, and posts the result
back. It never touches the bridge's SQLite database.

## Engines

Set `TRANSCRIBER_ENGINE`:

| Value   | What it does                                                | Needs |
|---------|-------------------------------------------------------------|-------|
| `mock`  | Deterministic placeholder transcripts; real ffmpeg path.    | ffmpeg |
| `fluidvoice` | Uses FluidVoice's local Fluid Server (`POST /v1/transcribe`). | FluidVoice app |
| `whisper` | faster-whisper (Whisper large-v3 by default).             | `pip install faster-whisper` |
| `nemo`  | NVIDIA Parakeet via NeMo.                                   | NeMo + model |
| `auto`  | Detects language on a 30s clip; Tamil -> Parakeet, else Whisper. | Whisper (+ NeMo if available) |

## FluidVoice (local app)

1. Open FluidVoice → **Settings → Experimental → Fluid Server**, enable it and
   note the port (8765 in this setup).
2. Check it:

```bash
curl http://127.0.0.1:8765/v1/health
# {"status":"ok","version":"1.6.13"}
```

3. Point the worker at it:

```bash
TRANSCRIBER_ENGINE=fluidvoice \
FLUIDVOICE_URL=http://127.0.0.1:8765 \
python3 -m transcriber.main --check
```

The worker sends the 16 kHz mono WAV as the raw request body. If FluidVoice
rejects the raw body, it retries with JSON `{audioBase64, filename}`.

**Language caveat:** FluidVoice uses the speech model selected in the app. This
setup selects **Whisper Large Turbo**, which handles Tamil, English and Sinhala.
The engine reads the transcript script: Tamil Unicode → `ta`, Sinhala → `si`,
Latin → `en`. `FLUIDVOICE_ALLOWED_LANGUAGES=ta,en,si` keeps those three; other
languages are reported as `skipped` and the existing transcript is kept.
Set `FLUIDVOICE_LANGUAGE=ta|si|en` only if you need to force a label.

### Speaker labels on mono calls

3CX call recordings here are mono, so the stereo channel split cannot attribute
speakers. The worker instead uses FluidAudio's diarizer, then transcribes each
speaker turn with FluidVoice:

```bash
git clone https://github.com/altic-dev/FluidAudio.git ~/Developer/FluidAudio
cd ~/Developer/FluidAudio
git checkout edee7154
swift build -c release --product fluidaudiocli
```

Then enable it in the environment:

```bash
FLUIDVOICE_DIARIZE=1
FLUIDVOICE_DIARIZER=sortformer
FLUIDVOICE_DIARIZER_CLI=~/Developer/FluidAudio/.build/release/fluidaudiocli
FLUIDVOICE_SPEAKER_COUNT=2
```

Sortformer is overlap-aware and caps itself at four speakers. `FLUIDVOICE_SPEAKER_COUNT`
keeps the two speakers with the most talk time, which is right for 3CX two-party
calls. The transcript stores one segment per merged speaker turn, so the UI can
show `Speaker 1`, `Speaker 2` and timestamps. Short turns are padded before ASR,
and turns whose script is outside `FLUIDVOICE_ALLOWED_LANGUAGES` (for example
CJK hallucinations on a noisy phone line) are dropped. If the CLI is missing or
diarization fails, the worker falls back to the unlabeled full transcript.

The Sinhala/English mixed calls still expose a model limit: Whisper Turbo
auto-detects short Sinhala turns as English and can hallucinate. The English
calls separate cleanly.

**Security:** Fluid Server listens on all interfaces (`*:<port>`) with no API
key. It rejects non-loopback `Host` headers and browser requests, but do not
expose that port through the router or Cloudflare. Keep the macOS firewall on.
FluidVoice must be running for transcription; enable “Launch at login” in
FluidVoice on the Mac Mini.

Fluid Server can also be enabled without the UI:

```bash
defaults write com.FluidApp.app LocalAPIEnabled -bool true
defaults write com.FluidApp.app LocalAPIPort -int 8765
# restart FluidVoice for the config to take effect
```

`auto` implements the Phase 0 decision: Tamil to your Parakeet model, Sinhala
and English to Whisper large-v3.

## Run

```bash
# from the repo root
python3 -m transcriber.main --check          # load engine, print identity
python3 -m transcriber.main --once           # process one job then exit
python3 -m transcriber.main                  # long-running poll loop
```

Mock engine smoke test with the bridge running:

```bash
TRANSCRIBER_ENGINE=mock python3 -m transcriber.main --once
```

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `BRIDGE_URL` | `http://127.0.0.1:8080` | Bridge base URL |
| `WORKER_TOKEN` | `dev-worker-token` | Internal endpoint token |
| `TRANSCRIBER_ENGINE` | `fluidvoice` | `fluidvoice` / `mock` / `whisper` / `nemo` / `auto` |
| `FLUIDVOICE_URL` | `http://127.0.0.1:8765` | Fluid Server base URL |
| `FLUIDVOICE_TIMEOUT` | `180` | Seconds per transcription request |
| `FLUIDVOICE_LANGUAGE` | unset | Override the language label (`ta`, `si`, `en`) |
| `FLUIDVOICE_ALLOWED_LANGUAGES` | `ta,en,si` | Keep only these; others are skipped and the old transcript is preserved |
| `FLUIDVOICE_DIARIZE` | `1` | Diarize mono calls and transcribe each turn |
| `FLUIDVOICE_DIARIZER` | `sortformer` | `sortformer` or `process` |
| `FLUIDVOICE_DIARIZER_CLI` | `~/Developer/FluidAudio/.build/release/fluidaudiocli` | FluidAudio CLI binary |
| `FLUIDVOICE_DIARIZER_TIMEOUT` | `900` | Seconds allowed for one diarization run |
| `FLUIDVOICE_SPEAKER_COUNT` | `2` | Keep the N speakers with the most talk time |
| `WHISPER_MODEL` | `large-v3` | faster-whisper model |
| `WHISPER_DEVICE` | `auto` | `auto` / `cpu` / `mps` |
| `WHISPER_COMPUTE_TYPE` | `int8` | faster-whisper compute type |
| `TRANSCRIBER_LANGUAGE` | unset | Force a language instead of detecting |
| `PARAKEET_MODEL` | unset | Path to a `.nemo` Parakeet checkpoint |
| `MOCK_LANGUAGE` | `ta` | Language reported by the mock engine |
| `TRANSCRIBER_DIARISE` | `1` | Split stereo recordings into caller/agent |
| `TRANSCRIBER_POLL_SECONDS` | `5` | Idle poll interval |
| `TRANSCRIBER_MAX_JOBS` | `0` | Stop after N jobs (0 = forever) |
| `FFMPEG` / `FFPROBE` | `ffmpeg` / `ffprobe` | Binary paths |

## Job contract

1. `POST /internal/jobs/claim` → job with `audio_url` and `hints` (domain terms
   from the knowledge base).
2. `GET /internal/audio/{job}` → WAV (Bearer `WORKER_TOKEN`).
3. ffprobe → channels/duration. Stereo recordings are split by channel:
   channel 0 = caller, channel 1 = agent (3CX writes the two legs separately).
4. Convert to 16 kHz mono with ffmpeg.
5. Transcribe.
6. `POST /internal/jobs/{id}/result` with `status`, `engine`, `model`,
   `language`, `text`, `segments[]`.
7. On failure, post `status: error`; the bridge retries three times, then marks
   the job failed. A killed worker's stale claim is requeued by the bridge after
   `JOB_STALE_MS`.

## Tests

```bash
python3 -m unittest discover -s transcriber/tests -t . -v
```

Tests use the mock engine and a stub HTTP bridge; they do exercise real ffmpeg
and ffprobe.
