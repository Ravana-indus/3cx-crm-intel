(() => {
  'use strict';

  const state = {
    token: sessionStorage.getItem('bridge.token') || '',
    tab: 'overview',
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const view = $('#view');
  const toastEl = $('#toast');

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character]));
  }

  function attr(value) {
    return esc(value);
  }

  function fmtTime(value) {
    return value ? String(value).replace('T', ' ').slice(0, 16) : '—';
  }

  function num(value) {
    return value === null || value === undefined ? '—' : String(value);
  }

  function secs(value) {
    if (value === null || value === undefined) return '—';
    const total = Number(value);
    if (!Number.isFinite(total)) return '—';
    if (total < 60) return `${Math.round(total)}s`;
    return `${Math.floor(total / 60)}m ${Math.round(total % 60)}s`;
  }

  function pct(value) {
    return value === null || value === undefined
      ? '—'
      : `${(Number(value) * 100).toFixed(1)}%`;
  }

  function mmss(value) {
    const total = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(total / 60);
    const seconds = Math.floor(total % 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function badge(value) {
    if (!value) return '<span class="badge unknown">—</span>';
    const className = String(value)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '-');
    return `<span class="badge ${className}">${esc(value)}</span>`;
  }

  function speakerClass(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
  }

  function flag(ok) {
    return `<span class="badge ${ok ? 'answered' : 'internal'}">${ok ? 'ready' : 'none'}</span>`;
  }

  function toast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.classList.toggle('error', isError);
    toastEl.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastEl.classList.add('hidden'), 4500);
  }

  function setConnected(ok) {
    const label = $('#conn-state');
    label.textContent = ok ? 'connected' : 'token required';
    label.className = `status ${ok ? 'ok' : 'bad'}`;
    $('#brand-dot').className = `dot ${ok ? 'ok' : 'bad'}`;
  }

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    if (options.body && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(path, { ...options, headers });

    if (response.status === 401) {
      setConnected(false);
      throw new Error('Unauthorized — check PORTAL_TOKEN');
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = JSON.stringify(await response.json());
      } catch {
        detail = await response.text().catch(() => '');
      }
      throw new Error(
        `HTTP ${response.status}${detail ? ` — ${detail.slice(0, 240)}` : ''}`,
      );
    }

    if (response.status === 204) return null;
    return response.json();
  }

  function authPanel() {
    return `<section class="panel auth-panel">
      <h2>Connect to the bridge</h2>
      <p class="muted">Enter the <code>PORTAL_TOKEN</code> from <code>.env</code> in the field above, then press Connect. It stays in this browser session only.</p>
    </section>`;
  }

  function errorPanel(error) {
    return `<section class="panel">
      <h2>Request failed</h2>
      <pre class="json">${esc(error instanceof Error ? error.message : String(error))}</pre>
      <p class="muted">Check that the bridge is running and the token is correct.</p>
    </section>`;
  }

  function card(label, value, extraClass = '') {
    return `<div class="card">
      <div class="label">${esc(label)}</div>
      <div class="value ${extraClass}">${value}</div>
    </div>`;
  }

  function panelHead(title, right = '') {
    return `<div class="panel-head"><h2>${esc(title)}</h2>${right}</div>`;
  }

  function options(values, current, blankLabel) {
    const blank = blankLabel
      ? `<option value="">${esc(blankLabel)}</option>`
      : '';
    return (
      blank +
      values
        .map(
          (value) =>
            `<option value="${attr(value)}"${value === current ? ' selected' : ''}>${esc(value)}</option>`,
        )
        .join('')
    );
  }

  function extractedHtml(extracted) {
    if (!extracted || typeof extracted !== 'object') {
      return '<p class="muted">No extracted fields.</p>';
    }

    const entries = Object.entries(extracted).map(([key, value]) => {
      let rendered;
      if (Array.isArray(value)) rendered = value.length ? value.join(', ') : '—';
      else if (value === null || value === undefined || value === '') rendered = '—';
      else if (typeof value === 'object') rendered = JSON.stringify(value);
      else rendered = String(value);

      return `<dt>${esc(key.replace(/_/g, ' '))}</dt><dd>${esc(rendered)}</dd>`;
    });

    return `<dl class="extracted">${entries.join('')}</dl>`;
  }

  function transcriptHtml(transcript) {
    if (!transcript) return '<p class="muted">Transcript not ready yet.</p>';

    const segments = Array.isArray(transcript.segments)
      ? transcript.segments
      : [];

    if (!segments.length) {
      return transcript.text
        ? `<p>${esc(transcript.text)}</p>`
        : '<p class="muted">No transcript text.</p>';
    }

    return `<div class="seg-list">${segments
      .map(
        (segment) => `<div class="seg">
          <span class="t">${esc(mmss(segment.start))}</span>
          <span class="spk ${esc(speakerClass(segment.speaker))}">${esc(segment.speaker || '')}</span>
          <span>${esc(segment.text)}</span>
        </div>`,
      )
      .join('')}</div>`;
  }

  function factsHtml(facts) {
    if (!facts) return '<p class="muted">No Layer A facts.</p>';
    const rows = [
      ['Call ID', facts.call_id],
      ['3CX call ID', facts.tcx_call_id],
      ['Direction', facts.direction],
      ['From', facts.from_number],
      ['To', facts.to_number],
      ['Disposition', facts.disposition],
      ['Hangup party', facts.hangup_party],
      ['Queue wait', facts.queue_wait_seconds === null ? null : `${facts.queue_wait_seconds}s`],
      ['Ring', facts.ring_seconds === null ? null : `${facts.ring_seconds}s`],
      ['Talk', facts.talk_seconds === null ? null : `${facts.talk_seconds}s`],
      ['Missed', facts.is_missed],
      ['Agent ext', facts.agent_extension],
      ['Agent user', facts.agent_user_id],
      ['Transfer to', facts.transfer_to],
      ['Transferred at', facts.transferred_at],
      ['Recording expires', facts.recording_expires_at],
      ['Raw status', facts.raw_status],
    ];
    return `<dl class="extracted">${rows
      .map(
        ([label, value]) =>
          `<dt>${esc(label)}</dt><dd>${esc(
            value === null || value === undefined || value === '' ? '—' : value,
          )}</dd>`,
      )
      .join('')}</dl>`;
  }

  function decisionHtml(decision) {
    if (!decision) return '<p class="muted">No Laya decision staged yet.</p>';

    const d = decision.decision || {};
    const dimensions = d.dimension_signals || {};
    const facts = Array.isArray(decision.facts) ? decision.facts : [];
    const validation = decision.validation || {};
    const rejected = Array.isArray(validation.rejected)
      ? validation.rejected
      : [];

    const dimensionRows = Object.entries(dimensions)
      .map(([name, signal]) => {
        const asked = signal && signal.asked;
        const value = asked ? signal.value : 'not asked';
        const evidence = signal && signal.evidence ? signal.evidence : '—';
        return `<tr>
          <td>${esc(name.replace(/_/g, ' '))}</td>
          <td class="num">${esc(value)}</td>
          <td class="small">${evidence === '—' ? '—' : `<q>${esc(evidence)}</q>`}</td>
        </tr>`;
      })
      .join('');

    const factRows = facts
      .map(
        (fact) => `<tr>
          <td>${esc(fact.field)}</td>
          <td>${esc(JSON.stringify(fact.value))}</td>
          <td class="num">${fact.confidence === null ? '—' : esc(fact.confidence)}</td>
          <td class="small"><q>${esc(fact.evidence)}</q></td>
          <td class="small">${esc(fact.confirmed_by || '—')}</td>
          <td class="small">${esc(fact.evidence_speaker || '—')}</td>
        </tr>`,
      )
      .join('');

    const objections = (Array.isArray(d.objections) ? d.objections : [])
      .map(
        (objection) => `<li>${esc(objection.type)} — <q>${esc(objection.quote)}</q> ${
          objection.resolved ? '(resolved)' : '(open)'
        }</li>`,
      )
      .join('');

    const rejectedHtml = rejected.length
      ? `<ul class="small stale">${rejected
          .map(
            (entry) =>
              `<li>${esc(entry.field)}: ${esc(entry.reason)}</li>`,
          )
          .join('')}</ul>`
      : '<p class="muted small">No rejected fields.</p>';

    const review =
      decision.status === 'staged' || decision.status === 'invalid'
        ? `<div class="actions" style="margin-top:12px">
            <button class="primary small-btn" type="button" data-review-decision="${attr(decision.id)}" data-review-status="approved">Approve</button>
            <button class="danger small-btn" type="button" data-review-decision="${attr(decision.id)}" data-review-status="rejected">Reject</button>
          </div>`
        : '';

    return `<div class="decision">
      <div class="grid">
        ${card('Status', badge(decision.status))}
        ${card('Outcome', badge(d.outcome || 'unknown'))}
        ${card('Verdict', badge(d.verdict || 'none'))}
        ${card('Next action', esc(d.next_action || '—'), 'small-value')}
        ${card('Outcome confidence', esc(pct(d.outcome_confidence)), 'small-value')}
        ${card('Next confidence', esc(pct(d.next_action_confidence)), 'small-value')}
        ${card('Model', esc(`${decision.provider || '—'} · ${decision.model || '—'}`), 'small-value')}
      </div>
      <p class="muted small">${esc(d.verdict_reason || 'No verdict reason.')}</p>
      <div class="panel-head" style="margin-top:16px"><h4>Dimensions</h4><span class="muted">asked=false is not a low score</span></div>
      <div class="table-wrap"><table><thead><tr><th>Dimension</th><th class="num">Value</th><th>Evidence</th></tr></thead><tbody>${dimensionRows || '<tr><td colspan="3" class="muted">No dimensions.</td></tr>'}</tbody></table></div>
      <div class="panel-head" style="margin-top:16px"><h4>Facts</h4><span class="muted">staged, not written to leads</span></div>
      <div class="table-wrap"><table><thead><tr><th>Field</th><th>Value</th><th class="num">Conf.</th><th>Evidence</th><th>Confirmed by</th><th>Speaker</th></tr></thead><tbody>${factRows || '<tr><td colspan="6" class="muted">No facts extracted.</td></tr>'}</tbody></table></div>
      <div class="panel-head" style="margin-top:16px"><h4>Objections</h4></div>
      ${objections ? `<ul class="small">${objections}</ul>` : '<p class="muted small">No objections.</p>'}
      <div class="panel-head" style="margin-top:16px"><h4>Callback</h4></div>
      <p class="small">${d.callback && d.callback.requested
        ? `requested${d.callback.at ? ` for ${esc(d.callback.at)}` : ''}${d.callback.spoken_as ? ` — <q>${esc(d.callback.spoken_as)}</q>` : ''}`
        : 'Not requested.'}</p>
      <div class="panel-head" style="margin-top:16px"><h4>Validation</h4></div>
      ${validation.pbx_override ? `<p class="small stale">PBX override: ${esc(validation.pbx_override)}</p>` : ''}
      ${validation.error ? `<p class="small stale">${esc(validation.error)}</p>` : ''}
      ${rejectedHtml}
      ${review}
      ${decision.reviewed_by ? `<p class="muted small">Reviewed by ${esc(decision.reviewed_by)} at ${esc(decision.reviewed_at)}</p>` : ''}
    </div>`;
  }

  function bindDecisionReview(root, onDone) {
    root.querySelectorAll('[data-review-decision]').forEach((button) => {
      button.addEventListener('click', async () => {
        const status = button.dataset.reviewStatus;
        const id = button.dataset.reviewDecision;
        const reviewer = window.prompt('Reviewer name');
        if (!reviewer || !reviewer.trim()) return;
        try {
          await api(`/v1/decisions/${encodeURIComponent(id)}/review`, {
            method: 'POST',
            body: JSON.stringify({
              status,
              reviewed_by: reviewer.trim(),
            }),
          });
          toast(`Decision ${status}`);
          if (onDone) await onDone();
        } catch (error) {
          toast(String(error), true);
        }
      });
    });
  }

  function overviewHtml(health) {
    const connector = health.connector || {};
    const jobs = health.jobs || {};
    const polls = health.polls || {};
    const maintenance = health.maintenance || {};
    const summariser = health.summariser || {};
    const stale = (health.stale_kb_docs || [])
      .map((doc) => `<li>${esc(doc.title)} — review by ${esc(doc.review_by)}</li>`)
      .join('');

    return `${panelHead(
      'Overview',
      `<div class="muted">${esc(fmtTime(health.now))} · auto-refresh 15s</div>`,
    )}
      <div class="grid">
        ${card('Status', badge(health.status))}
        ${card('Connector', `${esc(connector.mode || '—')} · ${badge(connector.state)}`, 'small-value')}
        ${card('Jobs pending', esc(num(jobs.pending)))}
        ${card('Jobs failed', esc(num(jobs.failed)))}
        ${card('Outbox pending', esc(num(health.outbox_pending)))}
        ${card('AI mode', esc(maintenance.ai_mode || '—'), 'small-value')}
        ${card('Last call poll', esc(fmtTime(polls.calls)), 'small-value')}
        ${card('Last recording poll', esc(fmtTime(polls.recordings)), 'small-value')}
        ${card('Last backup', esc(maintenance.last_backup_date || '—'), 'small-value')}
        ${card('Heartbeat', esc(fmtTime(maintenance.last_heartbeat)), 'small-value')}
        ${card('Summariser', `${esc(summariser.provider || '—')} · ${esc(summariser.model || '—')}`, 'small-value')}
        ${card('Jobs done', esc(num(jobs.done)))}
      </div>
      <div class="panel-head" style="margin-top:18px">
        <h3>Stale knowledge documents</h3>
        <span class="muted">past review date</span>
      </div>
      ${stale ? `<ul class="small stale">${stale}</ul>` : '<p class="muted small">None. Knowledge is current.</p>'}
      <p class="muted small">Running jobs: ${esc(num(jobs.running))} · connector error: ${esc(connector.last_error || 'none')}</p>`;
  }

  async function renderOverview(silent = false) {
    if (!state.token) {
      view.innerHTML = authPanel();
      return;
    }
    if (!silent) {
      view.innerHTML = `<section class="panel"><p class="muted">Loading…</p></section>`;
    }

    const health = await api('/v1/health');
    view.innerHTML = `<section class="panel">${overviewHtml(health)}</section>`;
  }

  const OUTCOMES = ['answered', 'missed', 'abandoned', 'ai_handled', 'outbound'];

  function callsShell() {
    return `<section class="panel">
      ${panelHead('Calls', '<span class="muted">newest first</span>')}
      <form id="call-filters" class="filters">
        <label>From<input name="from" type="date" /></label>
        <label>To<input name="to" type="date" /></label>
        <label>Outcome<select name="outcome">${options(OUTCOMES, '', 'all')}</select></label>
        <label>Ext<input name="ext" placeholder="102" size="6" /></label>
        <label>Lead<input name="lead_id" placeholder="LEAD-0042" size="12" /></label>
        <button class="primary" type="submit">Search</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Started</th><th>Dir</th><th>From</th><th>Ext</th><th>Queue</th>
            <th>Outcome</th><th>Disposition</th><th>Transcript</th><th>Decision</th>
            <th class="num">Ring</th><th class="num">Talk</th><th>Lead</th>
          </tr></thead>
          <tbody id="calls-body"></tbody>
        </table>
      </div>
      <button id="more-calls" class="secondary hidden" type="button" data-cursor="">Load more</button>
    </section>
    <section id="call-detail" class="panel hidden"></section>`;
  }

  function callRowHtml(call) {
    return `<tr class="clickable" data-call-id="${attr(call.id)}">
      <td class="nowrap">${esc(fmtTime(call.started_at))}</td>
      <td>${esc(call.direction)}</td>
      <td class="nowrap">${esc(call.from_e164 || call.from_raw || '—')}</td>
      <td>${esc(call.ext || call.agent || '—')}</td>
      <td>${esc(call.queue || '—')}</td>
      <td>${badge(call.outcome)}</td>
      <td>${badge(call.facts?.disposition || 'unknown')}</td>
      <td>${flag(call.has_transcript)}</td>
      <td>${call.decision ? `${badge(call.decision.status)} ${badge(call.decision.verdict || 'none')}` : '—'}</td>
      <td class="num">${esc(num(call.ring_sec))}</td>
      <td class="num">${esc(secs(call.talk_sec))}</td>
      <td>${esc(call.lead_id || '—')}</td>
    </tr>`;
  }

  async function loadCalls(cursor) {
    const form = $('#call-filters');
    const parameters = new URLSearchParams();
    for (const [key, value] of new FormData(form).entries()) {
      if (value) parameters.set(key, value);
    }
    parameters.set('limit', '100');
    if (cursor) parameters.set('cursor', cursor);

    const data = await api(`/v1/calls?${parameters.toString()}`);
    const body = $('#calls-body');
    if (!body) return;

    const rows = data.items.map(callRowHtml).join('');
    if (cursor) {
      body.insertAdjacentHTML('beforeend', rows);
    } else {
      body.innerHTML =
        rows ||
        '<tr><td colspan="12" class="muted">No calls in this range.</td></tr>';
    }

    const more = $('#more-calls');
    if (more) {
      more.classList.toggle('hidden', !data.next_cursor);
      more.dataset.cursor = data.next_cursor || '';
    }
  }

  async function showCall(id) {
    const panel = $('#call-detail');
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.innerHTML = '<p class="muted">Loading call…</p>';

    try {
      const call = await api(`/v1/calls/${encodeURIComponent(id)}`);

      panel.innerHTML = `<div class="panel-head">
          <h2>Call ${esc(call.id)}</h2>
          <button class="secondary small-btn" type="button" data-close-detail>Close</button>
        </div>
        <div class="grid">
          ${card('Outcome', badge(call.outcome))}
          ${card('Direction', esc(call.direction), 'small-value')}
          ${card('From', esc(call.from_e164 || call.from_raw || '—'), 'small-value')}
          ${card('To', esc(call.to_e164 || call.to_raw || '—'), 'small-value')}
          ${card('Agent', esc(call.agent || call.ext || '—'), 'small-value')}
          ${card('Queue', esc(call.queue || '—'), 'small-value')}
          ${card('Started', esc(fmtTime(call.started_at)), 'small-value')}
          ${card('Ring / Talk', `${esc(secs(call.ring_sec))} / ${esc(secs(call.talk_sec))}`, 'small-value')}
          ${card('Lead', esc(call.lead_id || '—'), 'small-value')}
        </div>
        ${call.recording_url
          ? `<audio controls preload="none" src="${attr(call.recording_url)}"></audio>`
          : '<p class="muted">No recording.</p>'}
        <div class="panel-head" style="margin-top:16px">
          <h3>Transcript</h3>
          ${call.transcript ? `<span class="muted">${esc(call.transcript.language || '')} · ${esc(call.transcript.model || '')}</span>` : ''}
        </div>
        ${transcriptHtml(call.transcript)}
        <div class="panel-head" style="margin-top:16px"><h3>Summary</h3></div>
        ${call.summary
          ? `<p>${esc(call.summary.summary || '')}</p>${extractedHtml(call.summary.extracted)}`
          : '<p class="muted">Summary not ready yet.</p>'}
        <div class="panel-head" style="margin-top:16px"><h3>Layer A facts</h3><span class="muted">deterministic PBX data</span></div>
        ${factsHtml(call.facts)}
        <div class="panel-head" style="margin-top:16px"><h3>Laya decision</h3><span class="muted">staged, not written to leads</span></div>
        ${decisionHtml(call.decision)}`;

      const close = panel.querySelector('[data-close-detail]');
      if (close) close.onclick = () => panel.classList.add('hidden');
      bindDecisionReview(panel, () => showCall(id));
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      panel.innerHTML = errorPanel(error);
    }
  }

  async function renderCalls() {
    view.innerHTML = callsShell();

    $('#call-filters').addEventListener('submit', (event) => {
      event.preventDefault();
      void loadCalls();
    });
    $('#more-calls').addEventListener('click', (event) => {
      const cursor = event.currentTarget.dataset.cursor;
      if (cursor) void loadCalls(cursor);
    });
    $('#calls-body').addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-call-id]');
      if (row) void showCall(row.dataset.callId);
    });

    await loadCalls();
  }

  function transcriptRowHtml(call) {
    return `<tr class="clickable" data-call-id="${attr(call.id)}">
      <td class="nowrap">${esc(fmtTime(call.started_at))}</td>
      <td class="nowrap">${esc(call.from_e164 || call.from_raw || '—')}</td>
      <td>${esc(call.agent || call.ext || '—')}</td>
      <td>${esc(call.queue || '—')}</td>
      <td>${badge(call.outcome)}</td>
      <td class="num">${esc(secs(call.talk_sec))}</td>
    </tr>`;
  }

  async function renderTranscripts() {
    view.innerHTML = `<section class="panel">
      ${panelHead('Transcripts', '<span class="muted">completed transcriptions</span>')}
      <form id="transcript-filters" class="filters">
        <label>From<input name="from" type="date" /></label>
        <label>To<input name="to" type="date" /></label>
        <button class="primary" type="submit">Refresh</button>
      </form>
      <p class="muted small">Select a call to read the transcript, summary and extracted fields.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Started</th><th>From</th><th>Agent</th><th>Queue</th><th>Outcome</th><th class="num">Talk</th></tr></thead>
        <tbody id="transcript-body"></tbody>
      </table></div>
    </section>
    <section id="call-detail" class="panel hidden"></section>`;

    const load = async () => {
      const form = $('#transcript-filters');
      const parameters = new URLSearchParams();
      for (const [key, value] of new FormData(form).entries()) {
        if (value) parameters.set(key, value);
      }
      parameters.set('limit', '100');

      const data = await api(`/v1/calls?${parameters.toString()}`);
      const items = data.items.filter((call) => call.has_transcript);
      const body = $('#transcript-body');
      body.innerHTML = items.length
        ? items.map(transcriptRowHtml).join('')
        : '<tr><td colspan="6" class="muted">No completed transcripts yet. Recordings are transcribed automatically in the background.</td></tr>';

      if (items.length > 0) {
        await showCall(items[0].id);
      } else {
        $('#call-detail').classList.add('hidden');
      }
    };

    $('#transcript-filters').addEventListener('submit', (event) => {
      event.preventDefault();
      void load();
    });
    $('#transcript-body').addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-call-id]');
      if (row) void showCall(row.dataset.callId);
    });

    await load();
  }

  function decisionRowHtml(row) {
    return `<tr class="clickable" data-decision-id="${attr(row.id)}">
      <td class="nowrap">${esc(fmtTime(row.created_at))}</td>
      <td class="mono small">${esc(row.call_id)}</td>
      <td>${badge(row.outcome || 'unknown')}</td>
      <td>${badge(row.verdict || 'none')}</td>
      <td>${badge(row.status)}</td>
      <td class="small">${esc(row.model || '—')}</td>
    </tr>`;
  }

  async function renderDecisions() {
    view.innerHTML = `<section class="panel">
      ${panelHead('Laya decisions', '<span class="muted">staged with evidence; no lead writes</span>')}
      <form id="decision-filters" class="filters">
        <label>Status
          <select name="status">
            <option value="staged" selected>staged</option>
            <option value="invalid">invalid</option>
            <option value="approved">approved</option>
            <option value="rejected">rejected</option>
            <option value="superseded">superseded</option>
            <option value="">all</option>
          </select>
        </label>
        <label>From<input name="from" type="date" /></label>
        <label>To<input name="to" type="date" /></label>
        <button class="primary" type="submit">Refresh</button>
      </form>
      <p class="muted small">A decision is a proposal. Approving it only changes staging; the CRM pulls approved rows and writes its own leads.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Created</th><th>Call</th><th>Outcome</th><th>Verdict</th><th>Status</th><th>Model</th></tr></thead>
          <tbody id="decision-body"></tbody>
        </table>
      </div>
    </section>
    <section id="decision-detail" class="panel hidden"></section>`;

    const load = async () => {
      const form = $('#decision-filters');
      const parameters = new URLSearchParams();
      for (const [key, value] of new FormData(form).entries()) {
        if (value) parameters.set(key, value);
      }
      parameters.set('limit', '100');

      const data = await api(`/v1/decisions?${parameters.toString()}`);
      const body = $('#decision-body');
      body.innerHTML = data.items.length
        ? data.items.map(decisionRowHtml).join('')
        : '<tr><td colspan="6" class="muted">No decisions in this state.</td></tr>';

      if (data.items.length > 0) {
        await showDecision(data.items[0].id);
      } else {
        $('#decision-detail').classList.add('hidden');
      }
    };

    const showDecision = async (id) => {
      const panel = $('#decision-detail');
      panel.classList.remove('hidden');
      panel.innerHTML = '<p class="muted">Loading decision…</p>';
      try {
        const decision = await api(`/v1/decisions/${encodeURIComponent(id)}`);
        panel.innerHTML = `<div class="panel-head">
            <h2>Decision ${esc(decision.id)}</h2>
            <span class="muted">${esc(decision.call_id)}</span>
          </div>
          ${decisionHtml(decision)}`;
        bindDecisionReview(panel, load);
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) {
        panel.innerHTML = errorPanel(error);
      }
    };

    $('#decision-filters').addEventListener('submit', (event) => {
      event.preventDefault();
      void load();
    });
    $('#decision-body').addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-decision-id]');
      if (row) void showDecision(row.dataset.decisionId);
    });

    await load();
  }

  async function renderMissed() {
    view.innerHTML = `<section class="panel">
      ${panelHead('Missed & abandoned calls', '<span class="muted">callback status</span>')}
      <form id="missed-filters" class="filters">
        <label>Since<input name="since" type="date" /></label>
        <label>Unreturned only
          <select name="unreturned"><option value="">all</option><option value="true">unreturned</option></select>
        </label>
        <button class="primary" type="submit">Search</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Started</th><th>From</th><th>Ext</th><th>Queue</th>
            <th>Outcome</th><th>Callback</th>
          </tr></thead>
          <tbody id="missed-body"></tbody>
        </table>
      </div>
    </section>
    <section id="call-detail" class="panel hidden"></section>`;

    const load = async () => {
      const form = $('#missed-filters');
      const parameters = new URLSearchParams();
      for (const [key, value] of new FormData(form).entries()) {
        if (value) parameters.set(key, value);
      }
      const data = await api(`/v1/missed?${parameters.toString()}`);
      const body = $('#missed-body');
      body.innerHTML =
        data.items
          .map(
            (call) => `<tr class="clickable" data-call-id="${attr(call.id)}">
              <td class="nowrap">${esc(fmtTime(call.started_at))}</td>
              <td class="nowrap">${esc(call.from_e164 || call.from_raw || '—')}</td>
              <td>${esc(call.ext || '—')}</td>
              <td>${esc(call.queue || '—')}</td>
              <td>${badge(call.outcome)}</td>
              <td>${badge(call.callback_status)}</td>
            </tr>`,
          )
          .join('') ||
        '<tr><td colspan="6" class="muted">No missed calls.</td></tr>';
    };

    $('#missed-filters').addEventListener('submit', (event) => {
      event.preventDefault();
      void load();
    });
    $('#missed-body').addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-call-id]');
      if (row) void showCall(row.dataset.callId);
    });

    await load();
  }

  function teamShell() {
    return `<section class="panel">
      ${panelHead('Team metrics', '<span class="muted">Asia/Colombo time</span>')}
      <form id="team-filters" class="filters">
        <label>From<input name="from" type="date" /></label>
        <label>To<input name="to" type="date" /></label>
        <label>Group
          <select name="group"><option value="agent">agent</option><option value="team">team</option></select>
        </label>
        <label>Interval
          <select name="interval"><option value="day">day</option><option value="week">week</option></select>
        </label>
        <button class="primary" type="submit">Refresh</button>
      </form>
      <div id="metrics-results"><p class="muted">Loading…</p></div>
    </section>
    <section class="panel">
      ${panelHead('Agents', '<span class="muted">roster used for team grouping</span>')}
      <form id="add-agent" class="filters">
        <label>Ext<input name="ext" required placeholder="102" size="5" /></label>
        <label>Name<input name="name" placeholder="Agent name" /></label>
        <label>Team<input name="team" placeholder="sales" /></label>
        <label>Email<input name="email" type="email" placeholder="agent@example.com" /></label>
        <button class="primary" type="submit">Add / update</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Ext</th><th>Name</th><th>Team</th><th>Email</th><th></th></tr></thead>
          <tbody id="roster-body"></tbody>
        </table>
      </div>
    </section>
    <section class="panel">
      ${panelHead('Presence', '<span class="muted">latest observed status</span>')}
      <div id="presence-list"><p class="muted">Loading…</p></div>
    </section>`;
  }

  function metricRowHtml(row, group) {
    const label =
      group === 'team'
        ? row.team || row.group_key
        : row.agent || row.ext || row.group_key;
    return `<tr>
      <td class="nowrap">${esc(row.period)}</td>
      <td>${esc(label)}</td>
      <td class="num">${esc(num(row.offered))}</td>
      <td class="num">${esc(num(row.answered))}</td>
      <td class="num">${esc(num(row.missed))}</td>
      <td class="num">${esc(num(row.abandoned))}</td>
      <td class="num">${esc(num(row.ai_handled))}</td>
      <td class="num">${esc(pct(row.answer_rate))}</td>
      <td class="num">${esc(num(row.avg_speed_of_answer_sec))}</td>
      <td class="num">${esc(secs(row.talk_sec_total))}</td>
      <td class="num">${esc(num(row.drops))}</td>
      <td class="num">${esc(num(row.outbound_calls))}</td>
      <td class="num">${esc(num(row.callback_unreturned))}</td>
      <td class="num">${esc(num(row.active_minutes))}</td>
    </tr>`;
  }

  async function loadTeamMetrics() {
    const form = $('#team-filters');
    const parameters = new URLSearchParams();
    for (const [key, value] of new FormData(form).entries()) {
      if (value) parameters.set(key, value);
    }

    const data = await api(`/v1/team/metrics?${parameters.toString()}`);
    const group = parameters.get('group') || 'agent';
    const container = $('#metrics-results');
    container.innerHTML = `<div class="table-wrap">
      <table>
        <thead><tr>
          <th>Period</th><th>${group === 'team' ? 'Team' : 'Agent'}</th>
          <th class="num">Offered</th><th class="num">Answered</th><th class="num">Missed</th>
          <th class="num">Abandoned</th><th class="num">AI</th><th class="num">Answer rate</th>
          <th class="num">Avg answer s</th><th class="num">Talk</th><th class="num">Drops</th>
          <th class="num">Outbound</th><th class="num">Unreturned</th><th class="num">Active min</th>
        </tr></thead>
        <tbody>${data.rows.map((row) => metricRowHtml(row, group)).join('') ||
          '<tr><td colspan="14" class="muted">No metrics in this range.</td></tr>'}</tbody>
      </table>
    </div>`;
  }

  async function loadRoster() {
    const data = await api('/v1/team/agents');
    const body = $('#roster-body');
    if (!body) return;

    body.innerHTML =
      data.items
        .map(
          (agent) => `<tr data-ext="${attr(agent.ext)}">
            <td class="mono">${esc(agent.ext)}</td>
            <td><input data-field="name" value="${attr(agent.name || '')}" placeholder="name" /></td>
            <td><input data-field="team" value="${attr(agent.team || '')}" placeholder="team" /></td>
            <td><input data-field="email" value="${attr(agent.email || '')}" placeholder="email" /></td>
            <td><button class="small-btn" type="button" data-save-agent="${attr(agent.ext)}">Save</button></td>
          </tr>`,
        )
        .join('') ||
      '<tr><td colspan="5" class="muted">No agents yet. Add one above.</td></tr>';
  }

  async function loadPresence() {
    const data = await api('/v1/team/presence');
    const container = $('#presence-list');
    if (!container) return;

    container.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Ext</th><th>Name</th><th>Team</th><th>Status</th><th>At</th></tr></thead>
      <tbody>${data.items.map(
        (entry) => `<tr>
          <td class="mono">${esc(entry.ext)}</td>
          <td>${esc(entry.name || '—')}</td>
          <td>${esc(entry.team || '—')}</td>
          <td>${badge(entry.status)}</td>
          <td class="nowrap">${esc(fmtTime(entry.at))}</td>
        </tr>`,
      ).join('') || '<tr><td colspan="5" class="muted">No presence data.</td></tr>'}</tbody>
    </table></div>`;
  }

  async function renderTeam() {
    view.innerHTML = teamShell();

    $('#team-filters').addEventListener('submit', (event) => {
      event.preventDefault();
      void loadTeamMetrics();
    });

    $('#add-agent').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const ext = String(form.get('ext') || '').trim();
      if (!ext) return;
      try {
        await api(`/v1/team/agents/${encodeURIComponent(ext)}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: String(form.get('name') || '') || null,
            team: String(form.get('team') || '') || null,
            email: String(form.get('email') || '') || null,
          }),
        });
        toast(`Agent ${ext} saved`);
        event.currentTarget.reset();
        await Promise.all([loadRoster(), loadPresence()]);
      } catch (error) {
        toast(String(error), true);
      }
    });

    $('#roster-body').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-save-agent]');
      if (!button) return;
      const row = button.closest('tr');
      const ext = button.dataset.saveAgent;
      const payload = {
        name: row.querySelector('[data-field="name"]').value || null,
        team: row.querySelector('[data-field="team"]').value || null,
        email: row.querySelector('[data-field="email"]').value || null,
      };
      try {
        await api(`/v1/team/agents/${encodeURIComponent(ext)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        toast(`Agent ${ext} saved`);
        await loadPresence();
      } catch (error) {
        toast(String(error), true);
      }
    });

    await Promise.all([loadTeamMetrics(), loadRoster(), loadPresence()]);
  }

  function aiShell(settings) {
    return `<section class="panel">
      ${panelHead('AI answering', '<span class="muted">extension 199</span>')}
      <form id="ai-settings" class="filters">
        <label>Mode
          <select name="mode">
            <option value="off"${settings.mode === 'off' ? ' selected' : ''}>off (DND)</option>
            <option value="overflow"${settings.mode === 'overflow' ? ' selected' : ''}>overflow</option>
            <option value="always"${settings.mode === 'always' ? ' selected' : ''}>always</option>
          </select>
        </label>
        <label>Schedule<input name="schedule" value="${attr(settings.schedule || '')}" placeholder="Mon-Fri 09:00-17:00" size="28" /></label>
        <button class="primary" type="submit">Save</button>
      </form>
      <p class="muted small"><strong>off</strong> puts the AI extension in Do Not Disturb so 3CX skips it. <strong>overflow</strong> keeps it available for no-answer and after-hours routing.</p>
    </section>
    <section class="panel">
      ${panelHead('AI conversations', '<span class="muted">ElevenLabs post-call</span>')}
      <form id="conv-filters" class="filters">
        <label>From<input name="from" type="date" /></label>
        <label>To<input name="to" type="date" /></label>
        <button class="primary" type="submit">Refresh</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Created</th><th>Caller</th><th>Lead</th><th>Call</th><th>Conversation</th></tr></thead>
          <tbody id="conv-body"></tbody>
        </table>
      </div>
      <div id="conv-detail"></div>
    </section>`;
  }

  async function loadConversations() {
    const form = $('#conv-filters');
    const parameters = new URLSearchParams();
    for (const [key, value] of new FormData(form).entries()) {
      if (value) parameters.set(key, value);
    }

    const data = await api(`/v1/ai/conversations?${parameters.toString()}`);
    $('#conv-body').innerHTML =
      data.items
        .map(
          (conversation) => `<tr class="clickable" data-conv-id="${attr(conversation.id)}">
            <td class="nowrap">${esc(fmtTime(conversation.created_at))}</td>
            <td>${esc(conversation.caller || '—')}</td>
            <td>${esc(conversation.lead_id || '—')}</td>
            <td>${esc(conversation.call_id || '—')}</td>
            <td class="mono small">${esc(conversation.id)}</td>
          </tr>`,
        )
        .join('') ||
      '<tr><td colspan="5" class="muted">No AI conversations yet.</td></tr>';
  }

  async function renderAi() {
    const settings = await api('/v1/ai/settings');
    view.innerHTML = aiShell(settings);

    $('#ai-settings').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        await api('/v1/ai/settings', {
          method: 'PUT',
          body: JSON.stringify({
            mode: form.get('mode'),
            schedule: String(form.get('schedule') || '') || null,
          }),
        });
        toast('AI settings saved');
      } catch (error) {
        toast(String(error), true);
      }
    });

    $('#conv-filters').addEventListener('submit', (event) => {
      event.preventDefault();
      void loadConversations();
    });

    $('#conv-body').addEventListener('click', async (event) => {
      const row = event.target.closest('tr[data-conv-id]');
      if (!row) return;
      try {
        const conversation = await api(
          `/v1/ai/conversations/${encodeURIComponent(row.dataset.convId)}`,
        );
        $('#conv-detail').innerHTML = `<div class="panel-head" style="margin-top:16px"><h3>${esc(conversation.id)}</h3></div>
          <pre class="json">${esc(JSON.stringify({ analysis: conversation.analysis, collected: conversation.collected, transcript: conversation.transcript }, null, 2))}</pre>`;
        $('#conv-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) {
        toast(String(error), true);
      }
    });

    await loadConversations();
  }

  function kbShell(docs) {
    const today = new Date().toISOString().slice(0, 10);

    const rows = docs
      .map((doc) => {
        const stale = doc.review_by && doc.review_by < today;
        return `<tr>
          <td>${esc(doc.title)}</td>
          <td class="small">${esc(doc.tags || '—')}</td>
          <td class="small">${esc(doc.owner || '—')}</td>
          <td class="small ${stale ? 'stale' : ''}">${esc(doc.review_by || '—')}</td>
          <td class="small">${doc.synced_at ? badge('done') : badge('pending')}</td>
          <td class="nowrap">
            <button class="small-btn" type="button" data-edit-doc="${attr(doc.id)}">Edit</button>
            <button class="small-btn danger" type="button" data-delete-doc="${attr(doc.id)}">Delete</button>
          </td>
        </tr>`;
      })
      .join('');

    return `<section class="panel">
      ${panelHead('Knowledge base', '<button class="secondary small-btn" type="button" id="sync-kb">Sync to ElevenLabs</button>')}
      <p class="muted small">Markdown is the master copy. Edits trigger a sync; unchanged documents are skipped by content hash.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Title</th><th>Tags</th><th>Owner</th><th>Review by</th><th>Synced</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="muted">No documents yet.</td></tr>'}</tbody>
        </table>
      </div>
    </section>
    <section class="panel">
      ${panelHead('Document editor', '<span class="muted" id="kb-editor-mode">new document</span>')}
      <form id="kb-form" class="editor">
        <div class="row">
          <label>Title<input name="title" required placeholder="Germany Opportunity Card" /></label>
          <label>Tags<input name="tags" placeholder="germany, work visa" /></label>
          <label>Owner<input name="owner" placeholder="Patu" /></label>
          <label>Review by<input name="review_by" type="date" /></label>
        </div>
        <label>Body (Markdown)<textarea name="body_md" rows="10" required placeholder="Eligibility, fees, documents, what we never promise…"></textarea></label>
        <div class="actions">
          <button class="primary" type="submit">Save</button>
          <button class="secondary" type="button" id="kb-cancel">Clear</button>
        </div>
      </form>
    </section>`;
  }

  async function renderKb() {
    const data = await api('/v1/kb/docs');
    state.kbEditing = null;
    view.innerHTML = `<div id="kb-root">${kbShell(data.items)}</div>`;
    const root = $('#kb-root');

    const form = $('#kb-form');
    const modeLabel = $('#kb-editor-mode');

    const clear = () => {
      state.kbEditing = null;
      form.reset();
      modeLabel.textContent = 'new document';
    };

    $('#kb-cancel').addEventListener('click', clear);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = new FormData(form);
      const payload = {
        title: String(values.get('title') || '').trim(),
        body_md: String(values.get('body_md') || ''),
        tags: String(values.get('tags') || '') || null,
        owner: String(values.get('owner') || '') || null,
        review_by: String(values.get('review_by') || '') || null,
      };
      if (!payload.title || !payload.body_md) return;

      try {
        if (state.kbEditing) {
          await api(`/v1/kb/docs/${encodeURIComponent(state.kbEditing)}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
          });
        } else {
          await api('/v1/kb/docs', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        }

        const sync = await api('/v1/kb/sync', { method: 'POST' });
        const result = sync.result || {};
        toast(
          `Saved. Sync: ${result.created || 0} created, ${result.updated || 0} updated, ${result.skipped || 0} skipped`,
        );
        await renderKb();
      } catch (error) {
        toast(String(error), true);
      }
    });

    root.addEventListener('click', async (event) => {
      const edit = event.target.closest('[data-edit-doc]');
      const remove = event.target.closest('[data-delete-doc]');
      const sync = event.target.closest('#sync-kb');

      if (edit) {
        const doc = data.items.find((entry) => entry.id === edit.dataset.editDoc);
        if (!doc) return;
        state.kbEditing = doc.id;
        form.elements.title.value = doc.title || '';
        form.elements.tags.value = doc.tags || '';
        form.elements.owner.value = doc.owner || '';
        form.elements.review_by.value = doc.review_by || '';
        form.elements.body_md.value = doc.body_md || '';
        modeLabel.textContent = `editing: ${doc.title}`;
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      if (remove) {
        const doc = data.items.find((entry) => entry.id === remove.dataset.deleteDoc);
        if (!doc) return;
        if (!confirm(`Delete “${doc.title}” locally and in ElevenLabs?`)) return;
        try {
          await api(`/v1/kb/docs/${encodeURIComponent(doc.id)}`, {
            method: 'DELETE',
          });
          toast('Document deleted');
          await renderKb();
        } catch (error) {
          toast(String(error), true);
        }
        return;
      }

      if (sync) {
        try {
          const result = (await api('/v1/kb/sync', { method: 'POST' })).result || {};
          toast(
            `Sync: ${result.created || 0} created, ${result.updated || 0} updated, ${result.deleted || 0} deleted, ${result.skipped || 0} unchanged`,
          );
          await renderKb();
        } catch (error) {
          toast(String(error), true);
        }
      }
    });
  }

  const renderers = {
    overview: renderOverview,
    calls: renderCalls,
    transcripts: renderTranscripts,
    decisions: renderDecisions,
    missed: renderMissed,
    team: renderTeam,
    ai: renderAi,
    kb: renderKb,
  };

  async function renderTab(tab) {
    state.tab = tab;
    document
      .querySelectorAll('#tabs button')
      .forEach((button) =>
        button.classList.toggle('active', button.dataset.tab === tab),
      );

    if (!state.token) {
      setConnected(false);
      view.innerHTML = authPanel();
      return;
    }

    try {
      await renderers[tab]();
      setConnected(true);
    } catch (error) {
      setConnected(false);
      view.innerHTML = errorPanel(error);
    }
  }

  function connect() {
    state.token = $('#token').value.trim();
    if (state.token) sessionStorage.setItem('bridge.token', state.token);
    else sessionStorage.removeItem('bridge.token');
    void renderTab(state.tab);
  }

  $('#save-token').addEventListener('click', connect);
  $('#token').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') connect();
  });

  $('#tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (button) void renderTab(button.dataset.tab);
  });

  setInterval(() => {
    if (state.tab === 'overview' && state.token && !document.hidden) {
      void renderOverview(true).catch(() => undefined);
    }
  }, 15_000);

  $('#token').value = state.token;
  if (state.token) void renderTab('overview');
  else {
    setConnected(false);
    view.innerHTML = authPanel();
  }
})();
