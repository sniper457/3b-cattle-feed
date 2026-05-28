import { useState, useEffect, useCallback } from "react";

// ── SUPABASE ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://yjulmuqznduufxnbdbxw.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqdWxtdXF6bmR1dWZ4bmJkYnh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5OTkyMjEsImV4cCI6MjA5NTU3NTIyMX0.O3UpJQ1HChngX--uxRLj9imL35OCDZC9YVsgpuTsyeY";

const headers = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_ANON_KEY,
  "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
  "Prefer": "return=representation",
};

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const db = {
  getPens: () => sbFetch("/pens?select=*&order=id"),
  getRations: () => sbFetch("/rations?select=*&order=id"),
  getFeeders: () => sbFetch("/feeders?select=*&order=name"),
  getTodayEvents: () => {
    const today = new Date().toISOString().split("T")[0];
    return sbFetch(`/feed_events?select=*&date=eq.${today}&order=time_of_day`);
  },
  generateTodayEvents: () =>
    sbFetch("/rpc/generate_todays_events", { method: "POST", body: "{}" }),
  confirmEvent: (id, confirmedBy) =>
    sbFetch(`/feed_events?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "done",
        confirmed_by: confirmedBy,
        confirmed_at: new Date().toISOString(),
      }),
    }),
  updatePen: (id, updates) =>
    sbFetch(`/pens?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    }),
};

// ── REALTIME ──────────────────────────────────────────────────────────────────

function subscribeRealtime(table, onChange) {
  const url = `${SUPABASE_URL}/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;
  const ws = new WebSocket(url);
  const topic = `realtime:public:${table}`;

  ws.onopen = () => {
    ws.send(JSON.stringify({ topic, event: "phx_join", payload: {
      config: { broadcast: { self: false }, presence: { key: "" } }
    }, ref: "1" }));
  };

  ws.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data.event === "INSERT" || data.event === "UPDATE" || data.event === "DELETE") {
        onChange(data);
      }
      // Heartbeat
      if (data.event === "phx_reply" && data.payload?.status === "ok") {
        setInterval(() => ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "hb" })), 25000);
      }
    } catch (_) {}
  };

  return () => ws.close();
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function getTotalLbs(pen, ration) {
  if (pen.total_lbs_override !== null && pen.total_lbs_override !== undefined)
    return pen.total_lbs_override;
  return Math.round(pen.head_count * ration.lbs_per_head * 10) / 10;
}

function getIngredients(ration, useDdg, totalLbs) {
  const list = useDdg ? ration.ingredients : ration.ingredients_no_ddg;
  return list.map(i => ({ ...i, lbs: Math.round(i.pct * totalLbs * 10) / 10 }));
}

function todayStr() {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function fmtTime(isoStr) {
  if (!isoStr) return "";
  return new Date(isoStr).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// ── STYLES ────────────────────────────────────────────────────────────────────

const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #F5F2ED;
    --surface: #FDFCFA;
    --border: #E2DDD6;
    --border-light: #EDE9E3;
    --text: #1C1916;
    --text-2: #5C554C;
    --text-3: #9C9288;
    --accent: #2D5A27;
    --accent-light: #EAF2E8;
    --accent-text: #1E3D1A;
    --warn: #7A4A00;
    --warn-light: #FFF4E0;
    --fp: #1A3A5C;
    --fp-light: #E8EFF7;
    --cp: #4A1A5C;
    --cp-light: #F2E8F7;
    --danger: #8B1A1A;
    --mono: 'DM Mono', monospace;
    --sans: 'DM Sans', sans-serif;
  }

  body { background: var(--bg); font-family: var(--sans); color: var(--text); }
  .app { max-width: 480px; margin: 0 auto; min-height: 100vh; }

  /* Loading */
  .loading {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 60vh; gap: 12px;
  }
  .spinner {
    width: 28px; height: 28px; border: 2px solid var(--border);
    border-top-color: var(--accent); border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-text { font-family: var(--mono); font-size: 12px; color: var(--text-3); }

  /* Error */
  .error-bar {
    background: #FFF0F0; border: 1px solid #FFCACA;
    border-radius: 8px; padding: 10px 14px; margin: 12px 16px;
    font-size: 12px; font-family: var(--mono); color: var(--danger);
  }

  /* Header */
  .header {
    background: var(--text); color: var(--bg);
    padding: 16px 20px 14px;
    display: flex; align-items: center; justify-content: space-between;
    position: sticky; top: 0; z-index: 100;
  }
  .header-left { display: flex; flex-direction: column; gap: 2px; }
  .header-title { font-size: 16px; font-weight: 600; letter-spacing: -0.3px; }
  .header-date { font-size: 11px; font-family: var(--mono); color: #9C9288; }
  .role-badge {
    font-family: var(--mono); font-size: 10px;
    padding: 4px 10px; border-radius: 20px;
    border: 1px solid rgba(255,255,255,0.2);
    color: rgba(255,255,255,0.7); cursor: pointer; transition: all 0.15s;
    background: none;
  }
  .role-badge:hover { background: rgba(255,255,255,0.1); }

  /* Nav */
  .nav { display: flex; background: var(--surface); border-bottom: 1px solid var(--border); }
  .nav-tab {
    flex: 1; padding: 12px; text-align: center;
    font-size: 12px; font-weight: 500; font-family: var(--mono);
    color: var(--text-3); cursor: pointer; border: none; background: none;
    border-bottom: 2px solid transparent; transition: all 0.15s; letter-spacing: 0.03em;
  }
  .nav-tab.active { color: var(--text); border-bottom-color: var(--accent); }

  .content { padding: 16px; }

  /* Feeder bar */
  .feeder-bar {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 14px; margin-bottom: 14px;
    display: flex; align-items: center; gap: 10px;
  }
  .feeder-label { font-size: 11px; font-family: var(--mono); color: var(--text-3); flex-shrink: 0; }
  .feeder-select {
    font-family: var(--sans); font-size: 13px; font-weight: 500;
    border: none; background: none; color: var(--text); flex: 1; cursor: pointer; outline: none;
  }

  /* Progress */
  .progress-wrap { margin-bottom: 16px; }
  .progress-header { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .progress-label { font-size: 12px; font-family: var(--mono); color: var(--text-3); }
  .progress-count { font-size: 12px; font-family: var(--mono); color: var(--text-2); }
  .progress-track { height: 3px; background: var(--border); border-radius: 2px; }
  .progress-fill { height: 3px; background: var(--accent); border-radius: 2px; transition: width 0.4s ease; }

  /* Section label */
  .section-label {
    font-size: 10px; font-family: var(--mono); letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--text-3); margin: 18px 0 8px;
  }

  /* Feed card */
  .feed-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px; margin-bottom: 10px; transition: opacity 0.2s;
  }
  .feed-card.done { opacity: 0.6; }
  .feed-card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
  .feed-card-info { flex: 1; }

  .pen-tag {
    display: inline-block; font-family: var(--mono);
    font-size: 10px; font-weight: 500;
    padding: 3px 8px; border-radius: 5px; margin-bottom: 6px;
  }
  .pen-tag.fp { background: var(--fp-light); color: var(--fp); }
  .pen-tag.cp { background: var(--cp-light); color: var(--cp); }

  .feed-card-name { font-size: 14px; font-weight: 600; margin-bottom: 2px; letter-spacing: -0.2px; }
  .feed-card-meta { font-size: 12px; color: var(--text-2); font-family: var(--mono); }

  .check-btn {
    width: 38px; height: 38px; border-radius: 10px;
    border: 1.5px solid var(--border);
    background: none; cursor: pointer; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; transition: all 0.15s; color: var(--text-3);
  }
  .check-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-light); }
  .check-btn.done { background: var(--accent); border-color: var(--accent); color: white; }
  .check-btn:disabled { opacity: 0.5; cursor: default; }

  .status-badge {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; font-family: var(--mono);
    padding: 4px 9px; border-radius: 6px; margin-top: 8px;
  }
  .status-badge.pending { background: var(--warn-light); color: var(--warn); }
  .status-badge.done { background: var(--accent-light); color: var(--accent-text); }

  .expand-btn {
    background: none; border: none; cursor: pointer;
    font-size: 11px; font-family: var(--mono);
    color: var(--text-3); margin-top: 10px;
    display: flex; align-items: center; gap: 4px;
    padding: 0; transition: color 0.15s;
  }
  .expand-btn:hover { color: var(--text-2); }

  .ration-table { width: 100%; margin-top: 10px; border-collapse: collapse; }
  .ration-table th {
    text-align: left; font-size: 10px; font-family: var(--mono);
    letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--text-3); padding: 4px 6px; border-bottom: 1px solid var(--border-light);
  }
  .ration-table th:last-child { text-align: right; }
  .ration-table td {
    padding: 5px 6px; font-size: 12px; font-family: var(--mono);
    color: var(--text); border-bottom: 1px solid var(--border-light);
  }
  .ration-table td:last-child { text-align: right; }
  .ration-table tr:last-child td { border-bottom: none; font-weight: 500; color: var(--accent-text); }
  .ddg-note { font-size: 10px; font-family: var(--mono); color: var(--text-3); margin-top: 6px; }

  /* Admin */
  .admin-section { margin-bottom: 24px; }
  .admin-section-title {
    font-size: 10px; font-family: var(--mono); letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--text-3); margin-bottom: 10px;
  }

  .stat-row { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; margin-bottom: 16px; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px; text-align: center;
  }
  .stat-num { font-size: 22px; font-weight: 600; font-family: var(--mono); letter-spacing: -1px; }
  .stat-num.green { color: var(--accent); }
  .stat-num.amber { color: var(--warn); }
  .stat-lbl { font-size: 10px; font-family: var(--mono); color: var(--text-3); margin-top: 2px; }

  .pen-admin-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px; margin-bottom: 10px;
  }
  .pen-admin-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .pen-admin-name { font-size: 14px; font-weight: 600; }

  .field-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .field-label { font-size: 11px; font-family: var(--mono); color: var(--text-3); width: 90px; flex-shrink: 0; }
  .field-input {
    flex: 1; font-family: var(--mono); font-size: 12px;
    border: 1px solid var(--border); border-radius: 7px;
    padding: 6px 10px; background: var(--bg); color: var(--text);
    outline: none; transition: border-color 0.15s;
  }
  .field-input:focus { border-color: var(--accent); }
  .field-select {
    flex: 1; font-family: var(--mono); font-size: 12px;
    border: 1px solid var(--border); border-radius: 7px;
    padding: 6px 10px; background: var(--bg); color: var(--text);
    outline: none; cursor: pointer;
  }
  .toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .toggle-label { font-size: 11px; font-family: var(--mono); color: var(--text-3); }
  .toggle {
    width: 36px; height: 20px; border-radius: 10px;
    background: var(--border); cursor: pointer; position: relative;
    transition: background 0.2s; border: none; flex-shrink: 0;
  }
  .toggle.on { background: var(--accent); }
  .toggle::after {
    content: ''; position: absolute; top: 3px; left: 3px;
    width: 14px; height: 14px; border-radius: 50%;
    background: white; transition: left 0.2s;
  }
  .toggle.on::after { left: 19px; }

  .total-lbs-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .calc-lbs { font-size: 11px; font-family: var(--mono); color: var(--text-3); margin-bottom: 8px; }
  .override-clear {
    font-size: 10px; font-family: var(--mono); color: var(--warn);
    background: none; border: none; cursor: pointer; padding: 0;
  }

  .save-btn {
    width: 100%; margin-top: 10px; padding: 8px;
    background: var(--accent); color: white; border: none;
    border-radius: 8px; font-family: var(--mono); font-size: 12px;
    cursor: pointer; transition: opacity 0.15s;
  }
  .save-btn:hover { opacity: 0.85; }
  .save-btn:disabled { opacity: 0.5; cursor: default; }
  .saved-badge {
    text-align: center; font-size: 11px; font-family: var(--mono);
    color: var(--accent); margin-top: 6px;
  }

  /* Log */
  .log-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 0; border-bottom: 1px solid var(--border-light); font-size: 12px;
  }
  .log-row:last-child { border-bottom: none; }
  .log-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .log-dot.done { background: var(--accent); }
  .log-time { font-family: var(--mono); color: var(--text-3); width: 68px; flex-shrink: 0; }
  .log-pen { font-weight: 500; flex: 1; }
  .log-who { font-family: var(--mono); font-size: 11px; color: var(--text-3); }
  .empty-log { font-size: 12px; font-family: var(--mono); color: var(--text-3); padding: 12px 0; text-align: center; }

  .sync-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent); display: inline-block; margin-right: 6px;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
`;

// ── COMPONENTS ────────────────────────────────────────────────────────────────

function RationDetail({ ration, useDdg, totalLbs }) {
  const ingredients = getIngredients(ration, useDdg, totalLbs);
  return (
    <div>
      <table className="ration-table">
        <thead>
          <tr><th>Ingredient</th><th>%</th><th>Lbs</th></tr>
        </thead>
        <tbody>
          {ingredients.map(i => (
            <tr key={i.name}>
              <td>{i.name}</td>
              <td>{Math.round(i.pct * 100)}%</td>
              <td>{i.lbs}</td>
            </tr>
          ))}
          <tr>
            <td>Total</td><td>100%</td><td>{totalLbs}</td>
          </tr>
        </tbody>
      </table>
      {!useDdg && <div className="ddg-note">★ No DDG formula</div>}
    </div>
  );
}

function FeedCard({ pen, ration, event, onConfirm, feederName }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const totalLbs = getTotalLbs(pen, ration);
  const isDone = event.status === "done";

  async function handleConfirm() {
    if (isDone || confirming) return;
    setConfirming(true);
    await onConfirm(event.id, feederName);
    setConfirming(false);
  }

  return (
    <div className={`feed-card${isDone ? " done" : ""}`}>
      <div className="feed-card-top">
        <div className="feed-card-info">
          <div className={`pen-tag ${pen.type.toLowerCase()}`}>{pen.type}</div>
          <div className="feed-card-name">{pen.name}</div>
          <div className="feed-card-meta">
            {ration.name} · {totalLbs} lbs · {pen.head_count} head
          </div>
          <div className={`status-badge ${isDone ? "done" : "pending"}`}>
            {isDone
              ? `✓ ${event.confirmed_by} · ${fmtTime(event.confirmed_at)}`
              : "Pending"}
          </div>
          <button className="expand-btn" onClick={() => setExpanded(e => !e)}>
            {expanded ? "▴ Hide ration" : "▾ Show ration"}
          </button>
          {expanded && <RationDetail ration={ration} useDdg={pen.use_ddg} totalLbs={totalLbs} />}
        </div>
        <button
          className={`check-btn${isDone ? " done" : ""}`}
          onClick={handleConfirm}
          disabled={isDone || confirming}
          aria-label={isDone ? "Confirmed" : `Mark ${pen.name} done`}
        >
          {confirming ? "…" : "✓"}
        </button>
      </div>
    </div>
  );
}

// ── FEEDER VIEW ───────────────────────────────────────────────────────────────

function FeederView({ pens, rations, events, feeders, onConfirm }) {
  const [feederName, setFeederName] = useState(feeders[0] || "");

  const amEvents = events.filter(e => e.time_of_day === "AM");
  const pmEvents = events.filter(e => e.time_of_day === "PM");
  const doneCount = events.filter(e => e.status === "done").length;
  const total = events.length || 1;

  function renderCards(evts) {
    return evts.map(ev => {
      const pen = pens.find(p => p.id === ev.pen_id);
      const ration = rations.find(r => r.id === pen?.ration_id);
      if (!pen || !ration) return null;
      return (
        <FeedCard
          key={ev.id}
          pen={pen}
          ration={ration}
          event={ev}
          onConfirm={onConfirm}
          feederName={feederName}
        />
      );
    });
  }

  return (
    <div className="content">
      <div className="feeder-bar">
        <span className="feeder-label">Feeder:</span>
        <select
          className="feeder-select"
          value={feederName}
          onChange={e => setFeederName(e.target.value)}
        >
          {feeders.map(f => <option key={f}>{f}</option>)}
        </select>
        <span className="sync-dot" title="Live sync active" />
      </div>

      <div className="progress-wrap">
        <div className="progress-header">
          <span className="progress-label">Today's progress</span>
          <span className="progress-count">{doneCount} / {events.length} done</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${Math.round(doneCount / total * 100)}%` }} />
        </div>
      </div>

      {amEvents.length > 0 && (
        <>
          <div className="section-label">Morning · AM Feed</div>
          {renderCards(amEvents)}
        </>
      )}
      {pmEvents.length > 0 && (
        <>
          <div className="section-label">Afternoon · PM Feed</div>
          {renderCards(pmEvents)}
        </>
      )}
    </div>
  );
}

// ── ADMIN VIEW ────────────────────────────────────────────────────────────────

function PenCard({ pen, rations, onSave }) {
  const [local, setLocal] = useState({ ...pen });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(local) !== JSON.stringify(pen);

  const ration = rations.find(r => r.id === local.ration_id);
  const calcLbs = ration ? Math.round(local.head_count * ration.lbs_per_head * 10) / 10 : 0;
  const totalLbs = local.total_lbs_override !== null && local.total_lbs_override !== undefined
    ? local.total_lbs_override : calcLbs;

  function set(field, value) {
    setLocal(prev => ({ ...prev, [field]: value }));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    await onSave(pen.id, {
      head_count: local.head_count,
      ration_id: local.ration_id,
      use_ddg: local.use_ddg,
      total_lbs_override: local.total_lbs_override,
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="pen-admin-card">
      <div className="pen-admin-header">
        <div className="pen-admin-name">{pen.name}</div>
        <div className={`pen-tag ${pen.type.toLowerCase()}`}>{pen.type}</div>
      </div>

      <div className="field-row">
        <span className="field-label">Head count</span>
        <input
          className="field-input" type="number" min="1"
          value={local.head_count}
          onChange={e => set("head_count", parseInt(e.target.value) || 1)}
        />
      </div>

      <div className="field-row">
        <span className="field-label">Ration</span>
        <select
          className="field-select"
          value={local.ration_id}
          onChange={e => set("ration_id", e.target.value)}
        >
          {rations.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>

      <div className="toggle-row">
        <span className="field-label toggle-label">Use DDG</span>
        <button
          className={`toggle${local.use_ddg ? " on" : ""}`}
          onClick={() => set("use_ddg", !local.use_ddg)}
        />
        <span className="toggle-label" style={{ color: local.use_ddg ? "var(--accent)" : "var(--text-3)" }}>
          {local.use_ddg ? "Yes" : "No"}
        </span>
      </div>

      <div className="total-lbs-row">
        <span className="field-label">Total lbs</span>
        <input
          className="field-input" type="number" min="1" step="0.5"
          value={totalLbs}
          onChange={e => set("total_lbs_override", parseFloat(e.target.value) || calcLbs)}
        />
        {local.total_lbs_override !== null && local.total_lbs_override !== undefined && (
          <button className="override-clear" onClick={() => set("total_lbs_override", null)}>
            reset
          </button>
        )}
      </div>
      {local.total_lbs_override !== null && local.total_lbs_override !== undefined && (
        <div className="calc-lbs">Calculated: {calcLbs} lbs · override active</div>
      )}

      {dirty && (
        <button className="save-btn" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      )}
      {saved && <div className="saved-badge">✓ Saved</div>}
    </div>
  );
}

function AdminView({ pens, rations, events, onSavePen }) {
  const [tab, setTab] = useState("pens");
  const doneCount = events.filter(e => e.status === "done").length;
  const pendingCount = events.length - doneCount;
  const doneEvents = [...events].filter(e => e.status === "done")
    .sort((a, b) => new Date(a.confirmed_at) - new Date(b.confirmed_at));

  return (
    <div className="content">
      <div className="nav" style={{ margin: "0 -16px 16px", borderTop: "1px solid var(--border)" }}>
        {["pens", "log"].map(t => (
          <button
            key={t}
            className={`nav-tab${tab === t ? " active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "pens" ? "Pen Setup" : "Today's Log"}
          </button>
        ))}
      </div>

      {tab === "pens" && (
        <>
          <div className="stat-row">
            <div className="stat-card">
              <div className="stat-num">{events.length}</div>
              <div className="stat-lbl">Total</div>
            </div>
            <div className="stat-card">
              <div className="stat-num green">{doneCount}</div>
              <div className="stat-lbl">Done</div>
            </div>
            <div className="stat-card">
              <div className="stat-num amber">{pendingCount}</div>
              <div className="stat-lbl">Pending</div>
            </div>
          </div>

          <div className="admin-section">
            <div className="admin-section-title">Pen Configuration</div>
            {pens.map(pen => (
              <PenCard key={pen.id} pen={pen} rations={rations} onSave={onSavePen} />
            ))}
          </div>
        </>
      )}

      {tab === "log" && (
        <div className="admin-section">
          <div className="admin-section-title">
            <span className="sync-dot" />Completed feedings today
          </div>
          <div className="pen-admin-card">
            {doneEvents.length === 0 ? (
              <div className="empty-log">No feedings confirmed yet</div>
            ) : (
              doneEvents.map(ev => {
                const pen = pens.find(p => p.id === ev.pen_id);
                return (
                  <div className="log-row" key={ev.id}>
                    <div className="log-dot done" />
                    <span className="log-time">{fmtTime(ev.confirmed_at)}</span>
                    <span className="log-pen">{pen?.name} · {ev.time_of_day}</span>
                    <span className="log-who">{ev.confirmed_by}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ROOT APP ──────────────────────────────────────────────────────────────────

export default function App() {
  const [role, setRole] = useState("feeder");
  const [pens, setPens] = useState([]);
  const [rations, setRations] = useState([]);
  const [events, setEvents] = useState([]);
  const [feeders, setFeeders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Initial load
  useEffect(() => {
    async function load() {
      try {
        await db.generateTodayEvents();
        const [p, r, e, f] = await Promise.all([
          db.getPens(), db.getRations(), db.getTodayEvents(), db.getFeeders(),
        ]);
        setPens(p || []);
        setRations(r || []);
        setEvents(e || []);
        setFeeders((f || []).map(x => x.name));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Realtime: feed_events
  useEffect(() => {
    const unsub = subscribeRealtime("feed_events", () => {
      db.getTodayEvents().then(e => setEvents(e || []));
    });
    return unsub;
  }, []);

  // Realtime: pens
  useEffect(() => {
    const unsub = subscribeRealtime("pens", () => {
      db.getPens().then(p => setPens(p || []));
    });
    return unsub;
  }, []);

  const confirmEvent = useCallback(async (eventId, feederName) => {
    try {
      await db.confirmEvent(eventId, feederName);
      // Optimistic update
      setEvents(prev => prev.map(e =>
        e.id === eventId
          ? { ...e, status: "done", confirmed_by: feederName, confirmed_at: new Date().toISOString() }
          : e
      ));
    } catch (err) {
      setError("Failed to confirm feeding. Try again.");
      setTimeout(() => setError(null), 3000);
    }
  }, []);

  const savePen = useCallback(async (penId, updates) => {
    try {
      await db.updatePen(penId, updates);
      setPens(prev => prev.map(p => p.id === penId ? { ...p, ...updates } : p));
    } catch (err) {
      setError("Failed to save pen. Try again.");
      setTimeout(() => setError(null), 3000);
    }
  }, []);

  if (loading) {
    return (
      <>
        <style>{css}</style>
        <div className="app">
          <div className="loading">
            <div className="spinner" />
            <div className="loading-text">Loading feed schedule…</div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <div className="header">
          <div className="header-left">
            <div className="header-title">3B Cattle · Feed Schedule</div>
            <div className="header-date">{todayStr()}</div>
          </div>
          <button className="role-badge" onClick={() => setRole(r => r === "feeder" ? "admin" : "feeder")}>
            {role === "feeder" ? "Feeder ↓" : "Admin ↓"}
          </button>
        </div>

        {error && <div className="error-bar">{error}</div>}

        {role === "feeder" ? (
          <FeederView
            pens={pens} rations={rations} events={events}
            feeders={feeders} onConfirm={confirmEvent}
          />
        ) : (
          <AdminView
            pens={pens} rations={rations} events={events}
            onSavePen={savePen}
          />
        )}
      </div>
    </>
  );
}
