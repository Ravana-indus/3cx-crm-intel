3CX Bridge — Architecture & Build Plan
Nov 23, 2026 · @Patu
Read this first
The plan needs no SIP trunk and no Docker. The AI agent answers as an ordinary 3CX extension running in a headless browser, and the bridge passes the call's audio to ElevenLabs and back, the way open-wa drives WhatsApp Web. Five consequences shape the build:
1.  The AI agent is a softphone bridge, not a trunk. A dedicated extension ("AI Receptionist") stays logged in to the 3CX web client inside headless Chromium. The bridge sends the caller's audio to an ElevenLabs agent and plays the agent's voice into the call as that extension's microphone. The provider only has to route calls to the extension.
2.  The Mac Mini is now in the live audio path. If it is off or offline, the AI extension is unregistered, and 3CX must fall through to voicemail. Set that fallback before go-live so an outage means voicemail, not dead air.
3.  One AI call at a time per AI extension. A browser softphone carries one live call. A second caller at the same moment falls through to the fallback, unless a second AI extension is added (it uses one of the 8 user slots).
4.  Transcription uses your NVIDIA Parakeet Tamil model, run natively in Python. Confirm whether it also covers Sinhala. If it doesn't, Sinhala calls need a second engine (Whisper large-v3), chosen per call by detected language.
5.  3CX has no supported API on this license. The connector and the AI extension both use the 3CX web client and the internal endpoints it calls (/xapi/v1/...). 3CX staff describe this API as internal and not for public use (forum), so a 3CX update can break either. The design isolates that risk in one module.
Requirements
One service on the Mac Mini, "3cx-bridge", gives the migration portal five things over an API. The portal stays the source of truth for leads; the bridge owns calls.
#
Capability
Done when
R1
Recordings and transcripts
Every recorded call is downloaded, transcribed locally and summarised. GET /v1/calls/{id} returns the transcript within 10 minutes of the call ending.
R2
Call log, caller matching, missed calls
Every call, including calls to other departments, appears in the API within 5 minutes with caller number, extension and outcome. The portal links it to a lead by phone number. A missed call raises a callback task.
R3
Team performance
The API returns per-agent and per-team metrics for any date range: answered, missed, drops, ring time, talk time, active time. They match the 3CX call log for a sample day.
R4
AI answering agent
When AI mode is on, or outside office hours, an ElevenLabs agent answers. It captures the enquiry and the bridge forwards it to the portal within 2 minutes of hang-up. Mode can be read and changed over the API.
R5
Knowledge base
Company knowledge lives in one place, editable over the API. It is synced to the ElevenLabs agent and used by the call summariser.
Non-functional: runs natively on the Mac Mini under launchd (no Docker), opens no inbound ports on the office network, loses nothing after a power cut or reboot, and keeps call audio and transcripts on the Mac Mini. During AI-answered calls, the live audio also passes through ElevenLabs.
Architecture overview
3CX rings people first, and sends overflow and after-hours calls to AI extension 199. The bridge answers 199 in headless Chromium and streams its audio to ElevenLabs, so the Mac Mini is in the live call path. If the Mac Mini is down, 3CX falls through to voicemail.
3CX connector
The connector works the way open-wa does for WhatsApp. It logs in once with a headless browser, keeps the session token, and then calls the same internal endpoints the 3CX web console uses. It never clicks through the UI.
Session
• Use two dedicated 3CX logins, both stored in .env: a service user for the call log and recordings, and the AI extension (see AI answering agent). Neither is a person's login.
• Each login gets its own persistent Chromium context (Playwright launchPersistentContext), so cookies and storage survive restarts.
• The service context logs in, captures the bearer token from network traffic, and then makes plain HTTPS calls with it. The AI context stays on the web client page, because it is the softphone.
• On a 401 or an expired token, log in again once. After three failures in a row, mark the connector degraded and fire connector.degraded.
Endpoints to confirm in Phase 0. Community reports show these on V20 (1, 2, 3). Whether the free Basic license allows them is unknown until recon:
Need
Endpoint seen in the wild
Recordings list
GET /xapi/v1/Recordings
Recording audio
GET /xapi/v1/Recordings/Pbx.DownloadRecording(recId={id})
Call log
GET /xapi/v1/ReportCallLogData/Pbx.GetCallLogData(periodFrom=…,periodTo=…,…)
Older call log
CallHistoryView (reportedly stale since V20 Update 6)
Agent presence
Unknown. Find it in the HAR.
Office-hours override
Unknown. Find it in the HAR; needed for the R4 toggle.
Polling
• Every 2 minutes, fetch the call log from the last checkpoint minus 10 minutes (an overlap that catches late writes). Upsert by the 3CX segment or call id, so repeats are harmless.
• Every 2 minutes, list recordings, download any not yet stored, check the size and store a SHA-256 hash, then queue a transcription job.
• Every 1 minute, poll agent presence if an endpoint exists (feeds "active time" in R3).
• Link each recording to its call using the call-log fields; a community post points to a cdrrecordings link table on newer builds (forum). If no ID link is exposed, fall back to extension plus a start-time window of ±5 seconds.
• Checkpoints live in the database, so a reboot resumes where it stopped.
Isolation rule. All 3CX knowledge sits in one module (src/threecx/) behind a small interface. Data: listCalls(since), listRecordings(since), downloadRecording(id), getPresence(). Softphone: onIncomingCall(cb), answer(callId), hangup(callId), setStatus(status). If the provider later grants SFTP or a real API, only this module changes.
Transcription worker
Transcription is a separate Python process on the Mac Mini. It pulls jobs from the bridge over localhost HTTP and never touches the bridge's database, so a crash in either process leaves the other running.
Engine. Primary: your NVIDIA Parakeet Tamil model, loaded with NeMo, or with MLX if a converted checkpoint exists (faster on Apple Silicon). The worker hides the engine behind transcribe(audioPath, hints) → {language, text, segments[]}, so adding or swapping engines is a config change.
Language routing. Parakeet models are usually trained for one language or a fixed set of languages. If yours is Tamil-only:
• Run a fast language-ID pass on the first 30 seconds (Whisper's language detection works for this).
• Tamil → Parakeet. Sinhala or English → Whisper large-v3 (or an English Parakeet for English).
• Code-switched calls go to the engine for the dominant language. Review a sample weekly.
Phase 0 benchmark on 20 real calls (Tamil, Sinhala, English, mixed): word error rate (WER) on names, numbers, visa types and countries, plus seconds of compute per minute of audio on the actual Mac Mini.
Job loop (a small Python or Swift process under launchd, with KeepAlive on):
1.  POST /internal/jobs/claim → job id plus a signed URL for the audio.
2.  Download the audio and convert it to 16 kHz mono with ffmpeg. Detect channels: if the recording is stereo (caller and agent on separate channels), transcribe each channel and label the speakers.
3.  Transcribe with language detection on. Pass a prompt of domain terms taken from the knowledge base (country names, visa types, brand names) to improve spelling.
4.  POST /internal/jobs/{id}/result with language, full text, timestamped segments and the model name.
5.  On failure, report the error. The bridge retries 3 times with backoff, then marks the job failed and shows it in /v1/health.
Summary and extraction. After a transcript lands, the bridge runs one LLM call that returns JSON: summary (3 sentences), caller intent, destination country, service, documents mentioned, next action, follow-up date and sentiment. Use a local model through Ollama running natively, or a cloud model. That choice depends on Phase 0 quality and on how much client data may leave the Mac. Validate the output against a JSON schema and retry once.
Throughput (guessing until benchmarked): with 8 users and at most 4 simultaneous calls, volume is likely under 200 calls a day. One worker processing jobs in sequence should keep up, but measure it on the actual Mac Mini.
Caller matching and team metrics
The bridge normalises numbers; the portal decides which lead a number belongs to. Leads live in one place.
Matching
• Normalise every number to E.164 with libphonenumber, default region LK (0771234567 → +94771234567). Store both raw and normalised forms.
• On call.completed and call.missed, the portal replies {lead_id} or {lead_id: null}. The bridge stores the lead_id on the call, so later API reads include it.
• Unknown caller: the portal creates a lead with source "Phone" and status "Unqualified". That rule lives in the portal, not the bridge.
• Internal calls (extension to extension) are logged but never matched.
Call outcomes (one per call, derived from the call log):
Outcome
Rule
answered
An agent extension connected
missed
Rang an agent or queue and nobody answered; caller reached voicemail or the ring timeout
abandoned
Caller hung up while ringing or queued, before the timeout
ai_handled
Answered by AI extension 199
outbound
Placed by an agent
Metrics (per agent and per team, for any date range, Asia/Colombo time):
Metric
Definition
Calls offered
Inbound calls that rang the agent or their queue
Answered, missed, abandoned
Counts by outcome
Answer rate
answered ÷ offered
Avg speed of answer
Mean ring time of answered calls, in seconds
Talk time
Sum and mean of connected seconds
Drops
Answered calls that ended within 10 s (threshold configurable)
Callback time
Minutes from a missed call to the first outbound call to the same number; "unreturned" if more than 24 h
Outbound calls
Count and talk time
Active time
Minutes in an available status, from presence polling. Only if 3CX exposes presence (Phase 0)
AI handled
Calls answered by the agent, and how many produced a lead
Compute the metrics with SQL views over the calls table, not stored totals, so a definition can change without a backfill. Callback time is the metric that matters most for sales: a missed lead called back in 5 minutes is worth more than one called back tomorrow.
AI answering agent
The AI agent is a 3CX extension like any colleague. 3CX rings it, the bridge answers it in headless Chromium, and the extension's speaker and microphone are wired to an ElevenLabs agent. No SIP trunk is needed, and the provider does nothing beyond routing.
How the audio bridge works (open-wa style)
1.  A dedicated extension (for example 199, "AI Receptionist") is logged in to the 3CX web client in its own Chromium context. Launch Chromium with --use-fake-ui-for-media-stream and --autoplay-policy=no-user-gesture-required.
2.  Before the page loads, the bridge injects a script (Playwright addInitScript) that:
    ◦ replaces navigator.mediaDevices.getUserMedia, so the softphone's "microphone" is a WebAudio stream fed by the bridge;
    ◦ wraps RTCPeerConnection, so the caller's incoming audio track runs through an AudioWorklet that emits 16 kHz mono PCM frames.
3.  Frames move between the page and Node through Playwright exposeBinding or a localhost WebSocket: caller audio out, agent audio in.
4.  For each call, Node opens one ElevenLabs Agents WebSocket (wss://api.elevenlabs.io/v1/convai/conversation, signed URL). Caller PCM goes up as user_audio_chunk, and the agent's audio comes back and is written into the fake microphone. ElevenLabs confirms its formats at session start, for example pcm_16000 for the input audio.
5.  On an interruption event, flush the playback buffer so the agent stops talking when the caller talks.
Fallback if in-page audio injection proves unreliable: run the web client in a visible Chromium window and route audio through virtual audio devices (BlackHole). It is simpler to debug, but only one session fits per audio device.
Call lifecycle
1.  Detect the incoming call from the web client's own event channel (its WebSocket frames, seen in the Phase 0 HAR), or from the ringing state on the page.
2.  Read the caller ID and normalise it to E.164. Call the portal's GET /api/leads/by-phone.
3.  Open the ElevenLabs session first, passing dynamic variables (caller_number, lead_name, case_stage). Then answer in the web client.
4.  When the agent calls end_call, the bridge hangs up in the web client. When the caller hangs up, the remote track ends and the bridge closes the ElevenLabs session.
5.  Watchdog: if no audio flows in either direction for 10 seconds, play a short apology, hang up and log ai.call_failed.
Tools run inside the bridge, not on the internet. Over the same WebSocket, ElevenLabs sends a client_tool_call with the tool name, a tool call ID and parameters, and the client replies with a client_tool_result. So lookup_caller, create_enquiry and request_callback run locally against the portal, and the agent needs no public endpoint or tunnel.
After the call. The bridge already holds the live transcript from the socket events. It then fetches the conversation's analysis (summary and data-collection fields) from the ElevenLabs conversations API, stores it, and links it to the 3CX call (3CX logs it as a call answered by extension 199). It then sends ai.conversation.completed. 3CX also records the call, so it goes through the normal transcription pipeline too.
Routing and the on/off switch
Mode
How it's set
off
The bridge sets extension 199 to Do Not Disturb; 3CX skips it and the call goes to voicemail
overflow (default)
Ring group or each agent: on no answer after 20 s, forward to 199. Office closed: route to 199
always
Inbound route points straight at 199 (admin change, made once by hand)
The bridge switches between off and overflow by changing extension 199's own status in the web client, which any extension user can do (likely; confirm in Phase 0). The rule "if 199 is unavailable, go to voicemail" must be set, so a Mac Mini outage degrades to voicemail.
Limits
• One live AI call per AI extension. For two at once, add extension 198 in a second browser context; it uses one more of the 8 user slots.
• Phone audio is narrowband (8 kHz). Test ElevenLabs recognition of Tamil and Sinhala on real calls, not on studio audio.
• Latency runs caller → 3CX → Mac Mini → ElevenLabs → back. Measure it in Phase 4. Aim for under 1.5 s to the agent's first word (guessing at a usable threshold).
• A 3CX web client update can break the injection or the answer logic. Run an automated test call after every 3CX update.
Knowledge base
The bridge holds the master copy of company knowledge as Markdown documents; ElevenLabs gets a synced copy. Nobody edits knowledge inside ElevenLabs.
• Storage: a kb_docs table (title, body in Markdown, tags, updated_at), one document per topic. For example: "Germany Opportunity Card — eligibility and fees", "Office hours and locations", "How payment works", "What we never promise".
• Editing: CRUD over /v1/kb/docs, so the portal can add a simple editor later. Also support a seed folder (./kb/*.md) that loads on first start.
• Sync: on change, or on POST /v1/kb/sync, upsert each document into the ElevenLabs knowledge base as a text document, attach it to the agent and enable RAG. Store el_doc_id and synced_at. Delete removed documents. Use content hashes so unchanged documents are skipped.
• Reuse: the summariser and the transcription prompt both read from the same table, so names and terms are spelled the same everywhere.
• Guardrail: every fee, processing time or eligibility rule has an owner and a "review by" date. /v1/health lists documents past their review date. An AI agent quoting last year's fee is a real liability.
API contract
The portal reads from the bridge's REST API and receives webhooks for anything that should trigger work. All /v1 routes need Authorization: Bearer <PORTAL_TOKEN>. Publish an OpenAPI spec at /v1/openapi.json.
REST (portal → bridge)
Method
Path
Returns
GET
/v1/calls?from&to&ext&outcome&lead_id&cursor
Paged call log, newest first
GET
/v1/calls/{id}
Call plus transcript, summary, extracted fields, lead_id, recording link
GET
/v1/calls/{id}/recording
Audio stream (signed, short-lived link)
GET
/v1/calls/{id}/transcript
Text plus timestamped segments
GET
/v1/missed?since&unreturned=true
Missed calls, with callback status
GET
/v1/team/metrics?from&to&group=agent|team&interval=day|week
R3 metrics
GET
/v1/team/agents/{ext}/metrics?from&to
One agent
GET
/v1/team/presence
Current status per agent (if available)
GET, PUT
/v1/ai/settings
{mode: off|overflow|always, schedule}
GET
/v1/ai/conversations?from&to and /{id}
AI calls with collected data
GET, POST, PUT, DELETE
/v1/kb/docs and /{id}
Knowledge base
POST
/v1/kb/sync
Force a sync to ElevenLabs
GET
/v1/health
Connector state, last poll, job queue depth, failed jobs, stale KB documents
Webhooks (bridge → portal). POST to PORTAL_WEBHOOK_URL, signed with X-Bridge-Signature: sha256=<HMAC of body>. Delivered through an outbox table with retries (1 m, 5 m, 30 m, 2 h, then dead-letter). Each event has an id so the portal can ignore duplicates.
Event
When
Portal should
call.completed
Call log row is final
Match the lead; reply {lead_id}
call.missed
Missed or abandoned inbound
Match the lead; create a callback task
call.transcribed
Transcript and summary ready
Add to the lead timeline
ai.conversation.completed
ElevenLabs post-call data stored
Create or update the lead, then the task
connector.degraded
3CX login or polling failing
Alert an admin
Nothing comes in from ElevenLabs. Agent tools run as client tools over the call's own WebSocket, and the bridge fetches post-call analysis itself. The portal is the only outside caller of this API.
Internal (localhost only, never exposed): POST /internal/jobs/claim, POST /internal/jobs/{id}/result, GET /internal/audio/{job}.
Portal must expose: GET /api/leads/by-phone?e164=, the webhook receiver, and POST /api/enquiries.
Example call.transcribed payload:
{
  "id": "evt_01J…",
  "event": "call.transcribed",
  "call": {
    "id": "call_8f2c",
    "direction": "inbound",
    "from": "+94771234567",
    "ext": "102",
    "agent": "Agent name",
    "queue": "sales",
    "outcome": "answered",
    "started_at": "2026-11-23T17:58:00+05:30",
    "ring_sec": 9,
    "talk_sec": 312,
    "lead_id": "LEAD-0042"
  },
  "transcript": { "language": "ta", "model": "whisper-large-v3", "text": "…" },
  "summary": "…",
  "extracted": {
    "destination": "Germany",
    "service": "work visa",
    "next_action": "send fee list",
    "follow_up_at": "2026-11-25",
    "sentiment": "positive"
  }
}
Data model
One SQLite database in WAL mode (better-sqlite3), owned by the bridge process alone. The Python transcriber goes through localhost HTTP, never the database file. Store times in UTC and return them in Asia/Colombo time from the API.
Table
Key fields
calls
id, tcx_call_id (unique), tcx_segment_ids, direction, from_raw, from_e164, to_raw, ext, agent_ext, queue, outcome, started_at, answered_at, ended_at, ring_sec, talk_sec, lead_id, ai_conversation_id
recordings
id, call_id, tcx_rec_id (unique), file_path, sha256, bytes, duration_sec, channels, downloaded_at
jobs
id, type (transcribe, summarise, kb_sync), ref_id, status, attempts, claimed_at, error, next_run_at
transcripts
call_id, engine, model, language, text, segments_json, created_at
summaries
call_id, model, summary, extracted_json, created_at
agents
ext, name, email, team, active
presence_events
ext, status, at
ai_conversations
el_conversation_id (unique), call_id, caller_e164, transcript_json, analysis_json, collected_json, lead_id, created_at
kb_docs
id, title, body_md, tags, owner, review_by, content_hash, el_doc_id, updated_at, synced_at
outbox
id, event, payload_json, attempts, next_attempt_at, delivered_at, last_error
checkpoints
name, value, updated_at
settings
key, value (AI mode, schedule, drop threshold)
Metrics are SQL views over calls and presence_events. Recordings are stored as recordings/YYYY/MM/<tcx_rec_id>.wav. After transcription, convert them to Opus at 32 kbps; 3CX writes uncompressed audio at about 1 MB per minute (forum).
Deployment on the Mac Mini
Everything runs natively on macOS under launchd: two long-running processes, plus one optional. There is no Docker.
Process
Stack
Purpose
bridge
Node 22 + TypeScript: Fastify, Playwright (Chromium), better-sqlite3, ws
3CX connector, AI voice bridge, REST API, webhook outbox, scheduler
transcriber
Python 3.11+: Parakeet (NeMo or MLX), Whisper large-v3 fallback, ffmpeg
Pulls transcription jobs from the bridge over localhost
ollama (optional)
Native app
Local LLM for summaries, if Phase 0 picks local
Node suits the bridge because Playwright, WebSockets and audio streaming are first-class there and ElevenLabs ships a JavaScript SDK. Python suits transcription because the speech-model tools (NeMo, MLX, Whisper) live there. Keeping them as two processes means a model crash can't take down the phones.
Layout
/opt/3cx-bridge/
  bridge/          Node app
  transcriber/     Python app + venv
  data/            bridge.db, recordings/, chromium/, logs/
  kb/              seed Markdown for the knowledge base
  .env
~/Library/LaunchAgents/lk.ravana.bridge.plist
~/Library/LaunchAgents/lk.ravana.transcriber.plist
Each plist sets RunAtLoad and KeepAlive to true and writes stdout and stderr to data/logs/, rotated with newsyslog. Use LaunchAgents (user session) rather than LaunchDaemons, because Chromium's audio and WebRTC behave best in a logged-in session. This means automatic login must be on.
Portal access. The portal reaches the API over Tailscale, or over a Cloudflare Tunnel protected by Cloudflare Access (open question). Nothing else is exposed.
.env keys: TCX_URL, TCX_SERVICE_USER, TCX_SERVICE_PASSWORD, TCX_AI_EXT, TCX_AI_PASSWORD, PORTAL_TOKEN, PORTAL_API_URL, PORTAL_WEBHOOK_URL, PORTAL_WEBHOOK_SECRET, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, WORKER_TOKEN, TZ=Asia/Colombo.
Keeping it alive
• sudo pmset -a sleep 0 disksleep 0 autorestart 1, so the Mac never sleeps and restarts by itself after a power cut.
• Put the Mac Mini and the router on a UPS. With the Mac Mini in the live audio path, this matters more than before.
• After an outage, the poller catches up from its checkpoint, and the AI extension re-registers when the bridge starts. While it is down, 3CX sends calls to voicemail.
• Send a heartbeat to an external monitor (for example Healthchecks.io) every 5 minutes. Alert by email or WhatsApp when it stops, when the connector is degraded, or when an AI call fails.
Backups: a nightly sqlite3 .backup plus the recordings folder, copied to an external drive and to encrypted cloud storage (restic or similar). Keep 30 days. Test a restore once in Phase 5.
Security: the API binds to 127.0.0.1 (plus the Tailscale interface, if used). Recordings are served through signed links that expire in 15 minutes. Turn on FileVault. Recordings contain clients' passport, financial and family details, so set and document retention (for example, audio for 12 months and transcripts while the lead is active).
Build phases
Build in six phases, each ending in a test the build agent must pass before starting the next. Phase 0 is mostly yours, not the agent's: it settles the three unknowns everything else rests on.
Phase 0 — Recon (owner: Patu, 1–2 days)
[ ] Record a HAR file of the 3CX web console as the service user: log in, open call history, open recordings, play one. Strip passwords before sharing it.
[ ] Record a second HAR as the AI extension in the web client: receive a test call, answer, hang up, set DND. This shows the call-event channel and the answer request.
[ ] From the HARs, confirm the login flow, the token, the data endpoints, and whether the free license returns data for each.
[ ] Spike, 1 day: Playwright plus injected getUserMedia and RTCPeerConnection hooks. Answer a test call on the AI extension, play a WAV into it, and record the caller's audio out. This proves or kills the voice bridge before anything else is built.
[ ] Ask the provider to create the AI extension and service user, set no-answer and office-closed routing to it, and set its unavailable fallback to voicemail.
[ ] Benchmark your Parakeet Tamil model (and Whisper large-v3 for Sinhala) on 20 real calls; record WER and compute time.
[ ] Note the Mac Mini's chip, RAM and free disk.
Phase 1 — Connector and call log (R2)
[ ] Repo with bridge/ (Node) and transcriber/ (Python), launchd plists, SQLite migrations, /v1/health, OpenAPI.
[ ] 3CX service session with automatic re-login; call-log poller with checkpoint; recording downloader.
[ ] /v1/calls, /v1/missed, plus call.completed and call.missed webhooks via the outbox.
• Pass: a test call shows in /v1/calls within 5 minutes; restarting the container mid-poll creates no duplicates; a forced token expiry recovers without help.
Phase 2 — Transcription and summary (R1)
[ ] Native transcriber under launchd; job claim and result endpoints; retries.
[ ] Summariser with JSON-schema output; call.transcribed webhook.
• Pass: a Tamil test call has a transcript and summary in the API within 10 minutes; killing the worker mid-job leads to a clean retry.
Phase 3 — Team metrics (R3)
[ ] SQL views, /v1/team/*, presence polling (if available).
• Pass: for one real day, answered, missed and talk-time totals match the 3CX call log exactly.
Phase 4 — Knowledge base and AI agent (R4, R5)
[ ] kb_docs CRUD, seed folder, sync to the ElevenLabs knowledge base.
[ ] ElevenLabs agent: prompt, voice, languages, data-collection fields, the client tools lookup_caller, create_enquiry, request_callback and end_call.
[ ] Voice bridge: AI extension context, audio injection, call lifecycle, watchdog, post-call analysis fetch, ai.conversation.completed.
[ ] /v1/ai/settings: off and overflow through the extension's DND status.
• Pass: 20 test calls (Tamil, Sinhala, English) are answered by the agent with under 1.5 s to the first word. Each enquiry reaches the portal during the call. Setting mode off sends the next call to voicemail. Stopping the bridge mid-day sends calls to voicemail, not dead air.
Phase 5 — Hardening
[ ] Heartbeat and alerts, nightly backups with a tested restore, audio compression, retention job, UPS and pmset settings.
• Pass: pull the power for 10 minutes; after it returns, the system recovers by itself and loses no calls.
Open questions and risks
Risk
Likelihood
Fallback
Audio injection in headless Chromium is unreliable (no audio, one-way audio, echo)
Medium; the Phase 0 spike decides
Visible Chromium window plus BlackHole virtual audio devices
Free Basic license blocks the /xapi call-log or recording endpoints
Unknown until Phase 0
Ask the provider for read-only SFTP to the recordings folder, or move to a self-managed 3CX
A 3CX web client update breaks the connector or the voice bridge
High over a year
Isolated src/threecx/ module, automated test call after every update, connector.degraded alert
Mac Mini or office internet goes down during business hours
Medium in Sri Lanka
UPS; the AI extension's unavailable fallback is voicemail; the poller catches up afterwards
Two callers need the AI at the same moment
Low to medium
A second AI extension in a second browser context (uses one of the 8 user slots)
ElevenLabs recognises narrowband Tamil or Sinhala phone audio poorly
Medium
Test in Phase 0; English-first greeting with a callback offer; tune the agent's language settings
Parakeet model doesn't cover Sinhala
Likely
Route Sinhala calls to Whisper large-v3 by detected language
The AI agent gives wrong fee or eligibility information
Medium
KB review dates, "never promise" rules, every AI call transcribed and logged for review
Decisions needed from you
[ ] Where does the portal run, and how should it reach the bridge (Tailscale or Cloudflare Access)?
[ ] Summaries: local LLM or cloud?
[ ] Retention periods for audio and transcripts.
[ ] Office hours, and the no-answer timeout before the AI takes over (default 20 s).
[ ] The AI extension's number and display name, and whether a second AI extension is worth a user slot.
[ ] Which ElevenLabs voice and languages the agent uses.
Sources
• ElevenLabs: Agents WebSocket API
• ElevenLabs: client events (client_tool_call, audio formats)
• ElevenLabs: post-call data and webhooks
• FluidVoice README
• 3CX forum: XAPI is internal
• 3CX forum: recordings and call-log endpoints
• 3CX forum: DownloadRecording
• 3CX forum: recordings folder and rsync
• 3CX forum: linking recordings to the call log
