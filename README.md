# 3CX Bridge — Phase 1

A native macOS service that reads the 3CX call log and recordings, exposes a
clean REST API to the migration portal, and emits signed webhooks. Later phases
add local transcription, team metrics, the knowledge base and the ElevenLabs
AI receptionist.

Architecture and the full multi-phase design live in [`3cx.md`](./3cx.md).
Step-by-step installation, Laya/FluidVoice setup, backfill and verification are
in [`SETUP.md`](./SETUP.md).

## What works today (Phases 1–5)

- **Dashboard at `/ui`**: overview/health, call log with transcript, summary and
  recording playback, missed calls, team metrics + roster + presence, AI settings
  and conversations, and knowledge-base editing. It asks for `PORTAL_TOKEN` once
  and calls the same authenticated API.

- 3CX connector behind one interface (`bridge/src/threecx/`):
  - `mock` mode backed by fixtures — runs with no 3CX access (default).
  - `live` mode: persistent headless Chromium login + internal `/xapi` calls.
- Call-log poller with checkpointing and a 10-minute overlap; upserts by 3CX id.
- Recording downloader: SHA-256, `ffprobe` duration/channels, `recordings/YYYY/MM/`.
  Downloads are idempotent and link to calls by id or extension + start time.
- Outcome derivation: answered / missed / abandoned / ai_handled / outbound.
- E.164 normalisation (default region LK) and caller matching fields.
- **Transcription worker** (`transcriber/`): claims jobs over localhost HTTP,
  splits stereo caller/agent channels, converts to 16 kHz mono, runs a pluggable
  engine (`mock`, `fluidvoice`, `whisper`, `nemo`, `auto`), posts timestamped
  segments. `fluidvoice` uses FluidVoice's local Fluid Server.
- **Summaries**: Ollama or deterministic mock, JSON-schema validated with one
  retry, extracted fields (destination, service, next action, sentiment).
- `call.transcribed` fires only after both transcript and summary are ready.
- **Layer A call facts**: `disposition`, `is_missed`, separate queue/ring/talk
  seconds, agent user id, per-row recording retention, segment chain, and the raw
  3CX row are stored deterministically. Values 3CX does not expose stay null.
  `GET /v1/calls/:id/facts` and `GET /v1/export/calls` expose them; the latter is
  the CRM backfill pull surface.
- **Layer B Laya decisions**: native Laya `POST /predict` with the
  `typed-decisions` checkpoint. A second Laya pass selects verbatim evidence
  spans; the service rejects evidence that is absent or lacks the field's key
  terms, applies the PBX connection override, and stages the result in
  `call_decisions` + `decision_facts`. Nothing is written to leads.
  `GET /v1/decisions`, `GET /v1/calls/:id/decisions`, and
  `POST /v1/decisions/:id/review` provide the review path; `decision.*` events
  notify without triggering lead capture.
- Staged decisions are visible in the dashboard's **Decisions** tab with the
  evidence, validation errors, and approve/reject controls.
- Stale job reaper retries work left by a killed worker.
- **Team metrics (R3)**: SQL views over calls, per-agent and per-team, day/week
  buckets in Asia/Colombo time. Answer rate, average speed of answer, talk time,
  drops, callbacks (returned within 24h vs unreturned), AI-handled counts and
  active time from presence events. Definitions read from views and settings, so
  a change does not require a backfill.
- Agent roster `GET/PUT /v1/team/agents`, presence `GET /v1/team/presence`.
- **Knowledge base (R5)**: Markdown is the master copy in `kb_docs`. Seed folder,
  CRUD over `/v1/kb/docs`, content hashes, sync to ElevenLabs (create/update/
  delete, attach to agent), and stale review dates surfaced in `/v1/health`.
- **AI receptionist (R4)**: `/v1/ai/settings` maps off/overflow/always to the AI
  extension's DND status. The voice bridge opens an ElevenLabs Agents WebSocket,
  moves 16 kHz PCM both ways, runs `lookup_caller` / `create_enquiry` /
  `request_callback` / `end_call` as client tools against the portal, fetches
  post-call analysis, stores it, and emits `ai.conversation.completed`. A
  watchdog hangs up after 10 s of silence and emits `ai.call_failed`.
  The Playwright audio injection and softphone selectors are scaffolded behind
  the same interfaces and need Phase 0 recon to finish; the mock path exercises
  the whole flow today.
- **Hardening (Phase 5)**: external heartbeat, alert webhook, nightly SQLite +
  recordings backup with retention and a tested restore (`npm run restore`),
  Opus 32 kbps compression after transcription, audio retention job, and a stale
  claim reaper for stopped workers.
- Signed webhook outbox with retry backoff (1m, 5m, 30m, 2h, dead-letter) and
  `lead_id` capture from the portal response.
- REST: call log (cursor paginated), call detail with transcript/summary,
  short-lived signed recording stream, missed/unreturned calls, health, OpenAPI.
- Localhost-only internal job endpoints for the transcriber.
- SQLite in WAL mode with the full schema from the design doc.
- launchd, newsyslog and Cloudflare Tunnel scaffolding under `deploy/`.

Not implemented yet: live validation of the AI voice bridge and ElevenLabs
knowledge-base attach shape (both gated on Phase 0 recon), a second AI
extension for concurrent calls, and the CRM-side application of the 201/447
staged rows. The bridge exposes `/v1/export/calls`; the portal remains the
owner of people, leads, `consultant_assessment`, language capacity, and its
historical backfill.

Layer A cannot invent fields the PBX does not send. The live backfill showed
`hangup_party`, `queue_wait_seconds`, transfer fields, and a call-level user id
missing from `GetCallLogData`; those stay `null`. `agent_user_id` is joined from
the `/Users` presence payload when available.

## Quick start (mock mode)

```bash
cd bridge
cp .env.example .env          # TCX_MODE=mock works with no 3CX config
npm install
npm run migrate
npm test
npm run dev
```

In another terminal, run the transcriber against the mock engine:

```bash
TRANSCRIBER_ENGINE=mock python3 -m transcriber.main
```

```bash
curl -H "Authorization: Bearer dev-portal-token" localhost:8080/v1/health
curl -H "Authorization: Bearer dev-portal-token" "localhost:8080/v1/calls?limit=10"
curl -H "Authorization: Bearer dev-portal-token" \
  "localhost:8080/v1/team/metrics?from=2026-11-20&to=2026-11-22&group=agent&interval=day"

# Give the roster names and teams so per-team metrics are meaningful
curl -X PUT -H "Authorization: Bearer dev-portal-token" -H 'content-type: application/json' \
  -d '{"name":"Agent A","team":"sales"}' localhost:8080/v1/team/agents/102

# Knowledge base (seeded from ../kb in mock mode) and AI mode
curl -H "Authorization: Bearer dev-portal-token" localhost:8080/v1/kb/docs
curl -X PUT -H "Authorization: Bearer dev-portal-token" -H 'content-type: application/json' \
  -d '{"mode":"off"}' localhost:8080/v1/ai/settings
```

The bridge binds `127.0.0.1:8080`, seeds `../kb/*.md`, and starts with
`PORTAL_TOKEN=dev-portal-token` from the example env. Open
**http://127.0.0.1:8080/ui** and paste that token into the Connect field.

Auth header for direct API calls:
```bash
curl -H "Authorization: Bearer dev-portal-token" localhost:8080/v1/health
```

`AI_VOICE_ENABLED=1` starts the headless-browser call watcher; leave it off until
the Phase 0 recon has filled the softphone selectors and audio hooks. Backups run
nightly after `BACKUP_HOUR` (Asia/Colombo); verify one with
`npm run restore -- <backup-dir> <target-dir>`.

Active time needs presence polling: set `TCX_EP_PRESENCE` once the Phase 0 recon
finds the endpoint. Without it, `active_minutes` is `null` and every other metric
still works.

## Phase 0 recon (needed before live mode)

```bash
cd bridge
npm run recon      # visible Chromium, records data/recon/3cx-<ts>.har
npm run probe      # writes data/recon/contract.md (values omitted)
```

Fill the endpoint paths in `.env` and the mappers in
`bridge/src/threecx/live/xapi.ts` from that contract, then set `TCX_MODE=live`.
Run `npx playwright install chromium` once on the Mac Mini.

## Deploy

See [`deploy/README.md`](./deploy/README.md) for launchd, pmset, backups and the
Cloudflare Tunnel + Access setup. The bridge binds to `127.0.0.1` only; it opens
no inbound ports on the office network.

## Layout

```
bridge/       Node 22 + TypeScript service (Fastify, Playwright, better-sqlite3)
transcriber/  Python worker (ffmpeg + pluggable speech engines)
deploy/       launchd plists, newsyslog, cloudflared example
kb/           knowledge-base seed placeholder (Phase 4)
```
