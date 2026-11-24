# Setup

This repository runs a self-hosted 3CX bridge on macOS without a paid 3CX API
licence. It drives the 3CX v20 web client in headless Chromium, ingests calls and
recordings, transcribes and diarizes them locally, stores deterministic Layer A
call facts, and stages Layer B decisions produced by the local **Laya**
`typed-decisions` model.

The bridge owns calls. The portal/CRM owns people, leads,
`consultant_assessment`, language capacity, and its own historical backfill.
This service never writes a lead.

## What runs

| Process | Port | Purpose |
|---|---|---|
| `bridge` | `127.0.0.1:8080` | 3CX connector, REST API, dashboard, jobs, Layer A/B storage, webhooks |
| `transcriber` | outbound only | Pulls transcription jobs, calls FluidVoice, diarizes with FluidAudio |
| Laya server | `127.0.0.1:8000` | Native `/predict` typed decisions (`typed-decisions`) |
| FluidVoice Fluid Server | `127.0.0.1:8765` | Whisper Large Turbo ASR |
| 3CX web client | remote | Session/call log/recordings source |

Laya is **not** an OpenAI chat endpoint. Its request shape is `state` +
`questions` (`choice` / `score` / `noul`) and its response is calibrated answers.
The bridge calls `/predict`; see `bridge/src/decisions/laya.ts`.

## Prerequisites

- macOS on Apple Silicon (the FluidVoice/Laya stack is built for it).
- Node.js 22 or newer, npm.
- Python 3.12 or newer, `ffmpeg` and `ffprobe` (`brew install ffmpeg`).
- Xcode/Swift for the FluidAudio diarization CLI.
- FluidVoice installed and running, with **Whisper Large Turbo** selected and
  **Fluid Server** enabled on `127.0.0.1:8765`.
- A separate Laya checkout and its Python environment (the `/predict` server).
- A 3CX service login that can read the call log and recordings. A System Owner
  login is recommended; a System Administrator may receive `403` on some
  entity sets. The bridge falls back to the call log for recordings, but a
  download-by-id function still needs the right account.
- macOS firewall on. Do not expose ports 8000, 8080, or 8765 to the internet.

## 1. Clone and install the bridge

```bash
git clone https://github.com/Ravana-indus/3cx-crm-intel.git
cd 3cx-crm-intel/bridge
npm ci
cp .env.example .env
```

Edit `bridge/.env`. Start in mock mode first:

```ini
TCX_MODE=mock
PORTAL_TOKEN=dev-portal-token
WORKER_TOKEN=dev-worker-token
DB_PATH=./data/bridge.db
RECORDINGS_DIR=./data/recordings
DECISION_ENABLED=0
SUMMARISER=mock
```

Run migrations and tests:

```bash
npm run migrate
npm test
npm run build
npm start
```

The dashboard is at `http://127.0.0.1:8080/ui`. Enter
`PORTAL_TOKEN` in the header.

## 2. Start Laya

The Laya project is a separate local checkout. On this machine it is at
`~/DEV/004-RnD/037-laya`; adjust for your checkout.

```bash
cd ~/DEV/004-RnD/037-laya
./playground.sh
# or: PORT=8000 DEVICE=mps ./playground.sh
```

Check it:

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/models
```

The server lazy-loads checkpoints. The first `/predict` downloads/loads
`convaiinnovations/laya/typed-decisions` and can take a while. It is a local
service with no authentication; keep it on loopback.

Bridge settings:

```ini
DECISION_ENABLED=1
DECISION_MODEL=laya
DECISION_INTERVAL_MS=30000
DECISION_MAX_TRANSCRIPT_CHARS=48000
LAYA_BASE_URL=http://127.0.0.1:8000
LAYA_MODEL=typed-decisions
# LAYA_API_KEY=          # optional; the local server does not require one
LAYA_TIMEOUT_MS=120000
```

The adapter makes two Laya passes: one for the decision fields, then one to select
a verbatim transcript span for each field. A deterministic guard drops evidence
that is absent or does not contain the field's key terms. The result is staged;
it is never written to a lead.

## 3. Set up FluidVoice and the diarizer

FluidVoice provides the ASR. Enable its local server:

```bash
defaults write com.FluidApp.app LocalAPIEnabled -bool true
defaults write com.FluidApp.app LocalAPIPort -int 8765
# restart FluidVoice for the settings to take effect
curl http://127.0.0.1:8765/v1/health
```

Select **Whisper Large Turbo** in FluidVoice. The bridge/worker do not embed a
Whisper model; they use what FluidVoice has loaded.

Build the FluidAudio diarization CLI once:

```bash
git clone https://github.com/altic-dev/FluidAudio.git ~/Developer/FluidAudio
cd ~/Developer/FluidAudio
git checkout edee7154
swift build -c release --product fluidaudiocli
```

The binary should be at
`~/Developer/FluidAudio/.build/release/fluidaudiocli`.

## 4. Start the transcriber

From the repository root:

```bash
TRANSCRIBER_ENGINE=fluidvoice \
BRIDGE_URL=http://127.0.0.1:8080 \
WORKER_TOKEN=dev-worker-token \
FLUIDVOICE_URL=http://127.0.0.1:8765 \
FLUIDVOICE_TIMEOUT=240 \
FLUIDVOICE_ALLOWED_LANGUAGES=ta,en,si \
FLUIDVOICE_DIARIZE=1 \
FLUIDVOICE_DIARIZER=sortformer \
FLUIDVOICE_DIARIZER_CLI="$HOME/Developer/FluidAudio/.build/release/fluidaudiocli" \
FLUIDVOICE_SPEAKER_COUNT=2 \
TRANSCRIBER_DIARISE=1 \
python3 -m transcriber.main
```

What it does:

1. Claims a `transcribe` job from the bridge.
2. Downloads the recording and converts it to 16 kHz mono WAV.
3. For stereo recordings, splits caller/agent channels.
4. For mono calls, runs FluidAudio **Sortformer**, keeps the two speakers with
   the most talk time, and transcribes each merged speaker turn with FluidVoice.
5. Writes `{start,end,text,speaker,language,confidence}` segments back to the
   bridge.

If FluidVoice is not running, use `TRANSCRIBER_ENGINE=mock` for pipeline tests.
`faster-whisper` is only needed for the optional `whisper` engine in
`transcriber/requirements.txt`.

## 5. Configure 3CX live mode

Set the service login in `bridge/.env`:

```ini
TCX_MODE=live
TCX_URL=https://your-tenant.3cx.asia/
TCX_SERVICE_USER=...
TCX_SERVICE_PASSWORD=...
TCX_AI_EXT=199
CHROMIUM_PROFILE_DIR=./data/chromium
```

`TCX_ACCESS_TOKEN` is a **bootstrap/testing** shortcut; it expires. Normal
operation should use `TCX_SERVICE_USER` / `TCX_SERVICE_PASSWORD` so the
persistent Chromium session can log in again. The service user needs call-report
rights and recording access.

Start the bridge:

```bash
cd bridge
npm run build
npm start
```

Check:

```bash
curl -H 'Authorization: Bearer dev-portal-token' \
  http://127.0.0.1:8080/v1/health
```

The call-log poller runs every 2 minutes. The recording poller downloads new
audio and queues transcription. The dashboard's Overview tab shows connector,
poll, job, and decision state.

## 6. Layer A call facts

Migration `003_call_facts.sql` adds:

- `disposition` — answered / no_answer / busy / failed / voicemail / rejected
- `hangup_party`, `queue_wait_sec`, `agent_user_id`
- `is_missed` (stored as `missed_call` to avoid colliding with the metrics view)
- `raw_status`, `raw_json`
- per-recording `expires_at`
- `call_segments` for the 3CX segment chain
- `agents.user_id`

Values 3CX does not expose are **null**, never inferred. The live recon found
`hangup_party`, `queue_wait_seconds`, transfer fields, and a call-level user id
missing from `GetCallLogData`; `agent_user_id` is joined from `/Users` when
available.

Endpoints:

```bash
GET /v1/calls/:id/facts
GET /v1/calls?from&to&cursor&limit
GET /v1/export/calls?from&to&cursor&limit
```

`/v1/export/calls` is the CRM pull surface. It returns `facts`, `transcript`
(with `start_ms`/`end_ms`, speaker, language, confidence), and the latest
decision per call.

Backfill an existing 3CX window without downloading audio:

```bash
cd bridge
TOKEN=$(cat /tmp/3cx-access-token)
TCX_MODE=live TCX_URL=https://your-tenant.3cx.asia/ \
TCX_ACCESS_TOKEN="$TOKEN" TCX_AI_EXT=199 \
DB_PATH=./data/live.db \
npx tsx scripts/backfill-facts.ts --from 2026-11-01 --to 2026-11-30
```

## 7. Layer B decisions and review

Migration `004_call_decisions.sql` adds `call_decisions` and `decision_facts`.
A decision is staged with:

- `status` (`staged` / `approved` / `rejected` / `superseded` / `invalid`)
- model/provider/prompt version, transcript hash
- outcome, verdict, next action and confidences
- complete decision JSON and validation JSON
- per-fact evidence, confidence, speaker and transcript timestamps

Controls:

- `PBX disposition` overrides the model. A call that did not connect cannot be
  `connected`; the outcome/verdict/next action are cleared.
- `asked=false` means `value=null`; an unasked question is not a zero score.
- Evidence must be a verbatim transcript span; selected evidence must contain
  the field's key terms.
- Free-text facts (`visa_refusal_details`, exact score/date, intake), competitor
  names, and exact callback times are not generated by the typed Laya model; they
  remain unset rather than invented.

Queue decisions for existing transcripts:

```bash
cd bridge
DB_PATH=./data/live.db npx tsx scripts/enqueue-decisions.ts
```

Review in the dashboard's **Decisions** tab, or:

```bash
# list
curl -H 'Authorization: Bearer dev-portal-token' \
  'http://127.0.0.1:8080/v1/decisions?status=staged'

# approve/reject (does not write a lead)
curl -X POST -H 'Authorization: Bearer dev-portal-token' \
  -H 'content-type: application/json' \
  -d '{"status":"approved","reviewed_by":"Patu"}' \
  http://127.0.0.1:8080/v1/decisions/<decision_id>/review
```

`decision.*` events are deliberately not named `call.*`; the outbox's
`captureLeadId` only acts on `call.*` events, so a decision notification cannot
write `calls.lead_id`.

## 8. CRM pull and the 201/447 backfill

The bridge does not connect to the CRM database and does not create leads.
Instead:

1. The CRM calls `/v1/export/calls` (paged) for its date range.
2. It joins by `tcx_call_id`, or `from_number`/`to_number` + `started_at`.
3. It updates its own call facts from `facts.disposition`, `is_missed`, etc.
4. It pulls `/v1/decisions?status=approved` after human review.
5. It writes people/leads/`consultant_assessment` itself.

The bridge can only export calls it can read from 3CX and has transcribed.
Calls without audio/transcripts cannot receive a Layer B decision. The 201
unclassified rows and 339 `consultant_assessment` gaps remain CRM-side work.

## 9. API and UI

All `/v1` routes require `Authorization: Bearer <PORTAL_TOKEN>` (the UI's
token box stores it in sessionStorage). Internal worker routes require
`Authorization: Bearer <WORKER_TOKEN>` and are loopback-only.

| Endpoint | Purpose |
|---|---|
| `GET /v1/calls` | paged call log |
| `GET /v1/calls/:id` | facts + transcript + summary + latest decision |
| `GET /v1/calls/:id/facts` | Layer A facts |
| `GET /v1/calls/:id/transcript` | ms-level segments |
| `GET /v1/calls/:id/recording` | signed short-lived audio link |
| `GET /v1/decisions` | staged/approved/rejected decisions |
| `GET /v1/decisions/:id` | decision + facts + validation |
| `POST /v1/decisions/:id/review` | approve/reject |
| `GET /v1/export/calls` | CRM pull export |
| `GET /v1/health` | connector, polls, jobs, decisions |
| `GET /v1/openapi.json` | OpenAPI |
| `/ui` | dashboard |

The dashboard has **Decisions**, **Calls** (Disposition/Decision columns), and
call detail with Layer A facts + Laya decision + evidence + review buttons.
Static assets are versioned and served `no-store`.

## 10. Tests and verification

```bash
cd bridge
npm run typecheck
npm test          # 80 tests
npm run build

cd ..
python3 -m unittest discover -s transcriber/tests   # 16 tests
```

Browser smoke test (requires Playwright Chromium and a running bridge):

```bash
# The dashboard loads, Decisions shows staged rows, and the Calls table
# has Disposition/Decision columns.
```

End-to-end check:

1. `GET /v1/health` reports connector `ok`, 0 pending/failed jobs.
2. `GET /v1/export/calls` returns facts for the backfilled range.
3. `GET /v1/decisions?status=staged` returns the current staged decisions.
4. The Decisions tab shows evidence and validation; approve/reject changes status
   only.
5. `calls.lead_id` is unchanged after review; no portal enquiry is created.

## 11. Launchd / production notes

The launchd plists are in `deploy/launchd/`. Update their paths and environment
to your checkout, then load them with `launchctl`. The bridge and worker are
separate processes by design. Keep the Mac logged in (Chromium audio/WebRTC) and
disable sleep for production.

Laya, FluidVoice, and the bridge are all local. Do not expose 8000/8080/8765
through the router or a Cloudflare tunnel. Recordings and transcripts contain
client passport, financial, and family data; apply the same retention to
`call_decisions`/`decision_facts` as to transcripts.

## 12. Troubleshooting

**3CX returns 401 / token expired**
Use the service user credentials. `TCX_ACCESS_TOKEN` is only a bootstrap
shortcut. Re-login in the persistent Chromium profile if the refresh cookie is
invalid.

**3CX returns 403 on `/Recordings`**
The account lacks the entity set. The recording poller falls back to call-log
recording ids, but `Pbx.DownloadRecording` still needs permission. Use a System
Owner service account.

**FluidVoice says insufficient memory**
Whisper Large Turbo needs about 6 GB. Close other apps; the Fluid Server reports
the exact requirement. The model stays loaded after the first successful call.

**Diarizer not found**
Set `FLUIDVOICE_DIARIZER_CLI` to the built `fluidaudiocli`; rebuild with the
pinned FluidAudio commit if the model/CLI changed.

**Laya 503 / slow first request**
The checkpoint is loading or downloading. Wait and retry `/health`/`/predict`.
The server is lazy-loading; the first typed-decisions request is the slowest.

**No decisions**
Check `DECISION_ENABLED`, `LAYA_BASE_URL`, the Laya `/health`, and the job queue.
Run `npx tsx scripts/enqueue-decisions.ts` for transcripts that already exist.
Calls without a transcript cannot be decided.

**Dashboard looks stale**
The assets are versioned and `no-store`; hard reload the tab. Confirm the
**Layer A/B** badge and the **Decisions** tab are present.

## 13. Known limitations

- 3CX does not expose every Layer A field; nulls are intentional.
- Laya `typed-decisions` is zero-shot here. Confidence can be low and the
  Sinhala/mixed ASR quality limits evidence. Human review is required.
- Free-text facts, competitor names, and exact callback times are not produced
  by Laya; a separate extractor would be needed.
- The bridge only decides calls with transcripts; the CRM's historical 201/447
  rows need their own audio/transcripts or CRM-side processing.
- The 3CX internal API is undocumented and can change; the connector is isolated
  under `bridge/src/threecx/`.

## Repository layout

```text
bridge/                 Node 22 bridge, API, UI, migrations, scripts
  src/decisions/        Laya native adapter, schema, validator, runner
  src/threecx/          3CX connector (mock + live)
  src/repo/             SQLite repositories
  scripts/              backfill-facts, enqueue-decisions, retranscribe-last
transcriber/            Python worker (FluidVoice + FluidAudio diarization)
deploy/                 launchd/newsyslog/Cloudflare examples
kb/                     seed Markdown knowledge base
3cx.md                  architecture/spec
README.md               feature overview
SETUP.md                this guide
```
