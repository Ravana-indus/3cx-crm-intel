# Deploying the 3CX bridge on the Mac Mini

Everything runs natively under launchd. There is no Docker.

## Layout

```
/opt/3cx-bridge/
  bridge/          Node app (this repo's bridge/)
  transcriber/     Python app + venv
  data/            bridge.db, recordings/, chromium/, logs/, recon/
  kb/              seed Markdown for the knowledge base
  .env
~/Library/LaunchAgents/lk.ravana.bridge.plist
~/Library/LaunchAgents/lk.ravana.transcriber.plist
```

## First run

```bash
cd /opt/3cx-bridge/bridge
cp .env.example .env          # fill in credentials and paths
npm ci
npx playwright install chromium
npm run migrate
npm run dev                   # smoke test in mock mode first
```

Switch `.env` to `TCX_MODE=live` only after Phase 0 recon (`npm run recon`, `npm run probe`).

## 3CX live mode requirements

The service account must be **System Owner** (or have the call-report and
recording permissions). The connector uses the v20 xapi:

- `GET /xapi/v1/ReportCallLogData/Pbx.GetCallLogData(periodFrom=…,periodTo=…,sourceType=0,sourceFilter='',destinationType=0,destinationFilter='',callsType=0,callTimeFilterType=0,callTimeFilterFrom='',callTimeFilterTo='',hidePcalls=false)`
- `GET /xapi/v1/Recordings` and `GET /xapi/v1/Recordings/Pbx.DownloadRecording(recId=…)`
- `GET /xapi/v1/Users` for presence
- `GET /xapi/v1/Groups` / `Users` for roster enrichment

A normal extension, even a System Administrator, returns `403` for
`Parameters`, `Recordings` and `ActiveCalls`, and the call-log function returns
no rows. Create a dedicated **System Owner** extension for the bridge (for
example `199`/`svc-bridge`), then put `TCX_SERVICE_USER` and
`TCX_SERVICE_PASSWORD` in `.env`. Do not reuse a personal login.

## Dashboard

The bridge serves its own dashboard at `/ui` (for example
`http://127.0.0.1:8080/ui`). It asks for `PORTAL_TOKEN` once, then reads the same
authenticated `/v1` API. The static HTML/CSS/JS contain no data or secrets;
Cloudflare Access can protect the hostname while the token still gates the API.

Dashboard sections: overview/health, calls with transcripts/summaries/recordings,
missed calls, team metrics + roster + presence, AI mode and conversations,
knowledge-base editing.

## Transcriber

```bash
cd /opt/3cx-bridge
python3 -m venv transcriber/venv
source transcriber/venv/bin/activate
pip install -r transcriber/requirements.txt
python3 -m transcriber.main --check      # prints engine + model
```

`TRANSCRIBER_ENGINE=auto` routes Tamil to your Parakeet model when
`PARAKEET_MODEL` is set, otherwise Whisper handles everything. Start with
`mock`, then `whisper`, then `auto` after the Phase 0 benchmark.

The current setup uses FluidVoice's local Fluid Server instead:

1. FluidVoice → Settings → Experimental → Fluid Server → enable, port `8765`.
2. Verify: `curl http://127.0.0.1:8765/v1/health`.
3. The transcriber plist sets `TRANSCRIBER_ENGINE=fluidvoice` and
   `FLUIDVOICE_URL=http://127.0.0.1:8765`.

FluidVoice must be running on the Mac Mini (enable Launch at login). Fluid
Server listens on all interfaces without auth but rejects non-loopback hosts;
do not expose port 8765 through the router or Cloudflare, and keep the macOS
firewall on. The speech model selected in FluidVoice determines languages.

For summaries, install Ollama natively and pull a model:

```bash
brew install ollama
ollama serve &
ollama pull llama3.2
```

Set `SUMMARISER=ollama` and `OLLAMA_MODEL` in `.env`.

## Team metrics and presence

Metric definitions live in `bridge/src/db/migrations/002_metrics.sql` (views over
`calls`), so changing a definition does not require a backfill. Populate the
agent roster once the bridge is up (the portal can call these too):

```bash
curl -X PUT -H "Authorization: Bearer $PORTAL_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Agent A","team":"sales","email":"a@example.com"}' \
  https://bridge.example.com/v1/team/agents/102
```

`active_minutes` is computed from `presence_events`. Set `TCX_EP_PRESENCE` after
Phase 0 recon; leave it blank and active time is reported as `null` while all
call metrics keep working. `ACTIVE_STATUSES` (default `available,ready,online`)
decides which presence strings count as active.

## Knowledge base and AI receptionist

On first start the bridge loads `kb/*.md` (frontmatter: title, tags, owner,
review_by) into `kb_docs`. Edits go through the API, never directly in
ElevenLabs:

```bash
curl -X POST -H "Authorization: Bearer $PORTAL_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Fees","body_md":"...","owner":"Patu","review_by":"2026-12-31"}' \
  https://bridge.example.com/v1/kb/docs
curl -X POST -H "Authorization: Bearer $PORTAL_TOKEN" \
  https://bridge.example.com/v1/kb/sync
```

Set `ELEVENLABS_MODE=live`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_AGENT_ID` to
push documents to the agent. The attach payload in
`bridge/src/elevenlabs/live.ts` is isolated for easy correction against the live
API.

AI mode:

```bash
curl -X PUT -H "Authorization: Bearer $PORTAL_TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"off"}' https://bridge.example.com/v1/ai/settings
```

`off` sets extension 199 to Do Not Disturb; `overflow`/`always` make it
available. `AI_VOICE_ENABLED=1` starts the headless softphone watcher. Fill the
selectors in `bridge/src/threecx/softphone/live.ts` from the Phase 0 HAR, make a
test call, then watch `/v1/ai/conversations` and `/v1/health`. Set extension 199's
unavailable fallback to voicemail before enabling, so a bridge outage is not
dead air.

## Backups, retention, heartbeat

- `BACKUP_HOUR` (Asia/Colombo, default 03:00), `BACKUP_DIR`,
  `BACKUP_RETENTION_DAYS` (30). Backups contain `bridge.db`, `manifest.json` and
  a copy of `recordings/`.
- Test a restore before go-live and after every backup change:

```bash
cd /opt/3cx-bridge/bridge
npm run restore -- /path/to/backup-<stamp> /tmp/restored
# integrity_check + row counts are printed; swap the files only after checking
```

- `RETENTION_AUDIO_DAYS` (365) deletes old audio files and rows once per day.
- `HEARTBEAT_URL` (Healthchecks.io or similar) is pinged every
  `HEARTBEAT_INTERVAL_MS`; `ALERT_WEBHOOK_URL` receives `connector.degraded`,
  `ai.call_failed`, `heartbeat.failed`.
- `COMPRESS_AUDIO=1` converts recordings to Opus `COMPRESS_BITRATE` (32k) after
  transcription.

## launchd

```bash
cp deploy/launchd/lk.ravana.bridge.plist ~/Library/LaunchAgents/
cp deploy/launchd/lk.ravana.transcriber.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/lk.ravana.bridge.plist
launchctl load ~/Library/LaunchAgents/lk.ravana.transcriber.plist
launchctl list | grep lk.ravana
```

Use LaunchAgents, not LaunchDaemons: Chromium audio and WebRTC behave best in a
logged-in user session. Automatic login must be enabled.

```bash
sudo cp deploy/newsyslog.d/3cx-bridge.conf /etc/newsyslog.d/
```

## Cloudflare Tunnel + Access

The API binds to `127.0.0.1` only. `cloudflared` proxies a hostname to it:

```bash
cloudflared tunnel create 3cx-bridge
cloudflared tunnel route dns 3cx-bridge bridge.example.com
cloudflared tunnel run 3cx-bridge
```

Then protect `bridge.example.com` with a Cloudflare Access application (service
token for the portal). Cloudflare Access is not a substitute for the
`Authorization: Bearer <PORTAL_TOKEN>` header the bridge requires.

## Keep it alive

```bash
sudo pmset -a sleep 0 disksleep 0 autorestore 1 autorestart 1
```

- Put the Mac Mini and the router on a UPS (the Mac is in the live audio path in Phase 4).
- Send a heartbeat to an external monitor every 5 minutes (Healthchecks.io or similar).
- Nightly `sqlite3 .backup` plus the recordings folder, copied off-box encrypted
  (restic). Keep 30 days and test one restore per phase.
- Turn on FileVault. Recordings contain client passport, financial and family data.

## Recovery

After a power cut, launchd restarts the bridge, the poller resumes from its
checkpoint, and the AI extension (Phase 4) re-registers. While the bridge is down,
3CX routes AI calls to voicemail — set that fallback before go-live.
