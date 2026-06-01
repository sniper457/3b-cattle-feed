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
  // Schedule: upsert pen config for specific dates
  getPenSchedule: (penId) =>
    sbFetch(`/pen_schedule?pen_id=eq.${penId}&date=gte.${new Date().toISOString().split("T")[0]}&order=date`),
  upsertPenSchedule: (rows) =>
    sbFetch("/pen_schedule", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(rows),
    }),
  deletePenSchedule: (penId, dates) =>
    sbFetch(`/pen_schedule?pen_id=eq.${penId}&date=in.(${dates.join(",")})`, {
      method: "DELETE",
    }),
};

// ── REALTIME ──────────────────────────────────────────────────────────────────

function subscribeRealtime(table, onChange) {
  const url = `${SUPABASE_URL}/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;
  const ws = new WebSocket(url);
  const topic = `realtime:public:${table}`;
  let heartbeat;

  ws.onopen = () => {
    ws.send(JSON.stringify({ topic, event: "phx_join", payload: {
      config: { broadcast: { self: false }, presence: { key: "" } }
    }, ref: "1" }));
  };

  ws.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (["INSERT","UPDATE","DELETE"].includes(data.event)) onChange(data);
      if (data.event === "phx_reply" && data.payload?.status === "ok") {
        heartbeat = setInterval(() =>
          ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "hb" }))
        , 25000);
      }
    } catch (_) {}
  };

  return () => { clearInterval(heartbeat); ws.close(); };
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

function toLocalDateStr(date) {
  return date.toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
}

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
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

  .error-bar {
    background: #FFF0F0; border: 1px solid #FFCACA;
    border-radius: 8px; padding: 10px 14px; margin: 12px 16px;
    font-size: 12px; font-family: var(--mono); color: var(--danger);
  }

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
    color: rgba(255,255,255,0.7); cursor: pointer; transition: all 0.15s; background: none;
  }
  .role-badge:hover { background: rgba(255,255,255,0.1); }

  .nav { display: flex; background: var(--surface); border-bottom: 1px solid var(--border); }
  .nav-tab {
    flex: 1; padding: 12px; text-align: center;
    font-size: 12px; font-weight: 500; font-family: var(--mono);
    color: var(--text-3); cursor: pointer; border: none; background: none;
    border-bottom: 2px solid transparent; transition: all 0.15s; letter-spacing: 0.03em;
  }
  .nav-tab.active { color: var(--text); border-bottom-color: var(--accent); }

  .content { padding: 16px; }

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

  .progress-wrap { margin-bottom: 16px; }
  .progress-header { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .progress-label { font-size: 12px; font-family: var(--mono); color: var(--text-3); }
  .progress-count { font-size: 12px; font-family: var(--mono); color: var(--text-2); }
  .progress-track { height: 3px; background: var(--border); border-radius: 2px; }
  .progress-fill { height: 3px; background: var(--accent); border-radius: 2px; transition: width 0.4s ease; }

  .section-label {
    font-size: 10px; font-family: var(--mono); letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--text-3); margin: 18px 0 8px;
  }

  .feed-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px; margin-bottom: 10px; transition: opacity 0.2s;
  }
  .feed-card.done { opacity: 0.6; }
  .feed-card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
  .feed-card-info { flex: 1; }

  .pen-tag {
    display: inline-block; font-family: var(--mono);
    font-size: 10px; font-weight: 500; padding: 3px 8px; border-radius: 5px; margin-bottom: 6px;
  }
  .pen-tag.fp { background: var(--fp-light); color: var(--fp); }
  .pen-tag.cp { background: var(--cp-light); color: var(--cp); }

  .feed-card-name { font-size: 14px; font-weight: 600; margin-bottom: 2px; letter-spacing: -0.2px; }
  .feed-card-meta { font-size: 12px; color: var(--text-2); font-family: var(--mono); }

  .check-btn {
    width: 38px; height: 38px; border-radius: 10px; border: 1.5px solid var(--border);
    background: none; cursor: pointer; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; transition: all 0.15s; color: var(--text-3);
  }
  .check-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-light); }
  .check-btn.done { background: var(--accent); border-color: var(--accent); color: white; }
  .check-btn:disabled { opacity: 0.5; cursor: default; }

  .status-badge {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; font-family: var(--mono); padding: 4px 9px; border-radius: 6px; margin-top: 8px;
  }
  .status-badge.pending { background: var(--warn-light); color: var(--warn); }
  .status-badge.done { background: var(--accent-light); color: var(--accent-text); }

  .expand-btn {
    background: none; border: none; cursor: pointer;
    font-size: 11px; font-family: var(--mono); color: var(--text-3); margin-top: 10px;
    display: flex; align-items: center; gap: 4px; padding: 0; transition: color 0.15s;
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

  /* ── MIXER MODE ── */
  .mixer { margin-top: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .mixer-step { padding: 16px; }
  .mixer-progress-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .mixer-step-label { font-size: 10px; font-family: var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
  .mixer-step-count { font-size: 10px; font-family: var(--mono); color: var(--text-3); }
  .mixer-track { height: 2px; background: var(--border); border-radius: 2px; margin-bottom: 16px; }
  .mixer-fill { height: 2px; background: var(--accent); border-radius: 2px; transition: width 0.3s ease; }
  .mixer-ingredient-name { font-size: 22px; font-weight: 600; letter-spacing: -0.5px; color: var(--text); margin-bottom: 4px; line-height: 1.2; }
  .mixer-ingredient-lbs { font-size: 36px; font-weight: 600; font-family: var(--mono); color: var(--accent); letter-spacing: -1px; line-height: 1; }
  .mixer-ingredient-unit { font-size: 14px; font-weight: 400; color: var(--text-3); margin-left: 4px; }
  .mixer-cumulative { margin-top: 12px; padding: 10px 12px; background: var(--surface); border-radius: 8px; }
  .mixer-cumulative-label { font-size: 11px; font-family: var(--mono); color: var(--text-3); }
  .mixer-cumulative-val { font-size: 13px; font-family: var(--mono); font-weight: 500; color: var(--text); margin-top: 2px; }
  .mixer-cumulative-bar { height: 3px; background: var(--border); border-radius: 2px; margin-top: 8px; }
  .mixer-cumulative-fill { height: 3px; background: var(--fp); border-radius: 2px; transition: width 0.4s ease; }
  .mixer-done-screen { padding: 24px 16px; text-align: center; }
  .mixer-done-icon { font-size: 40px; margin-bottom: 12px; }
  .mixer-done-title { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
  .mixer-done-sub { font-size: 12px; font-family: var(--mono); color: var(--text-3); margin-bottom: 16px; }
  .mixer-nav { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border-light); }
  .mixer-btn { flex: 1; padding: 12px; border-radius: 8px; border: none; font-family: var(--mono); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
  .mixer-btn.start { background: var(--accent); color: white; }
  .mixer-btn.next { background: var(--fp-light); color: var(--fp); }
  .mixer-btn.finish { background: var(--accent); color: white; }
  .mixer-btn.back { background: var(--bg); color: var(--text-3); border: 1px solid var(--border); flex: 0 0 52px; }
  .mixer-btn:hover { opacity: 0.85; }
  .start-btn { width: 100%; margin-top: 12px; padding: 11px; background: var(--accent-light); color: var(--accent-text); border: 1px solid var(--accent-light); border-radius: 8px; font-family: var(--mono); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s; text-align: center; }
  .start-btn:hover { background: var(--accent); color: white; }

  /* ── MIXER MODE ── */
  .mixer {
    margin-top: 12px; background: var(--bg);
    border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
  }
  .mixer-step {
    padding: 16px;
  }
  .mixer-progress-row {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
  }
  .mixer-step-label {
    font-size: 10px; font-family: var(--mono); letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
  }
  .mixer-step-count {
    font-size: 10px; font-family: var(--mono); color: var(--text-3);
  }
  .mixer-track { height: 2px; background: var(--border); border-radius: 2px; margin-bottom: 16px; }
  .mixer-fill { height: 2px; background: var(--accent); border-radius: 2px; transition: width 0.3s ease; }

  .mixer-ingredient-name {
    font-size: 22px; font-weight: 600; letter-spacing: -0.5px;
    color: var(--text); margin-bottom: 4px; line-height: 1.2;
  }
  .mixer-ingredient-lbs {
    font-size: 36px; font-weight: 600; font-family: var(--mono);
    color: var(--accent); letter-spacing: -1px; line-height: 1;
  }
  .mixer-ingredient-unit {
    font-size: 14px; font-weight: 400; color: var(--text-3); margin-left: 4px;
  }
  .mixer-cumulative {
    margin-top: 12px; padding: 10px 12px;
    background: var(--surface); border-radius: 8px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .mixer-cumulative-label { font-size: 11px; font-family: var(--mono); color: var(--text-3); }
  .mixer-cumulative-val { font-size: 13px; font-family: var(--mono); font-weight: 500; color: var(--text); }
  .mixer-cumulative-bar {
    height: 3px; background: var(--border); border-radius: 2px; margin-top: 8px;
  }
  .mixer-cumulative-fill {
    height: 3px; background: var(--fp); border-radius: 2px; transition: width 0.4s ease;
  }

  .mixer-done-screen {
    padding: 24px 16px; text-align: center;
  }
  .mixer-done-icon { font-size: 40px; margin-bottom: 12px; }
  .mixer-done-title { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
  .mixer-done-sub { font-size: 12px; font-family: var(--mono); color: var(--text-3); margin-bottom: 16px; }

  .mixer-nav { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border-light); }
  .mixer-btn {
    flex: 1; padding: 12px; border-radius: 8px; border: none;
    font-family: var(--mono); font-size: 13px; font-weight: 500;
    cursor: pointer; transition: all 0.15s;
  }
  .mixer-btn.start { background: var(--accent); color: white; }
  .mixer-btn.next { background: var(--fp-light); color: var(--fp); }
  .mixer-btn.finish { background: var(--accent); color: white; }
  .mixer-btn.back { background: var(--bg); color: var(--text-3); border: 1px solid var(--border); flex: 0 0 52px; }
  .mixer-btn:hover { opacity: 0.85; }
  .mixer-btn:disabled { opacity: 0.4; cursor: default; }

  .start-btn {
    width: 100%; margin-top: 12px; padding: 11px;
    background: var(--accent-light); color: var(--accent-text);
    border: 1px solid var(--accent-light); border-radius: 8px;
    font-family: var(--mono); font-size: 12px; font-weight: 500;
    cursor: pointer; transition: all 0.15s; text-align: center;
  }
  .start-btn:hover { background: var(--accent); color: white; }

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
    padding: 6px 10px; background: var(--bg); color: var(--text); outline: none; transition: border-color 0.15s;
  }
  .field-input:focus { border-color: var(--accent); }
  .field-select {
    flex: 1; font-family: var(--mono); font-size: 12px;
    border: 1px solid var(--border); border-radius: 7px;
    padding: 6px 10px; background: var(--bg); color: var(--text); outline: none; cursor: pointer;
  }
  .toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .toggle-label { font-size: 11px; font-family: var(--mono); color: var(--text-3); }
  .toggle {
    width: 36px; height: 20px; border-radius: 10px; background: var(--border);
    cursor: pointer; position: relative; transition: background 0.2s; border: none; flex-shrink: 0;
  }
  .toggle.on { background: var(--accent); }
  .toggle::after {
    content: ''; position: absolute; top: 3px; left: 3px;
    width: 14px; height: 14px; border-radius: 50%; background: white; transition: left 0.2s;
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
  .saved-badge { text-align: center; font-size: 11px; font-family: var(--mono); color: var(--accent); margin-top: 6px; }

  /* AM/PM tabs */
  .ampm-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
  .ampm-tab {
    flex: 1; padding: 7px; text-align: center;
    font-size: 12px; font-weight: 500; font-family: var(--mono);
    border-radius: 8px; cursor: pointer; border: 1.5px solid var(--border);
    background: none; color: var(--text-3); transition: all 0.15s;
  }
  .ampm-tab.active.am { background: var(--fp-light); color: var(--fp); border-color: var(--fp-light); }
  .ampm-tab.active.pm { background: var(--cp-light); color: var(--cp); border-color: var(--cp-light); }
  .ampm-tab:not(.active):hover { background: var(--bg); }

  /* Schedule button */
  .schedule-btn {
    width: 100%; margin-top: 8px; padding: 8px;
    background: var(--fp-light); color: var(--fp); border: 1px solid var(--fp-light);
    border-radius: 8px; font-family: var(--mono); font-size: 12px;
    cursor: pointer; transition: all 0.15s;
  }
  .schedule-btn:hover { opacity: 0.8; }

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
    width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
    display: inline-block; margin-right: 6px; animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

  /* Offline banner */
  .offline-bar {
    background: #7A4A00; color: #FFF4E0;
    padding: 8px 16px; font-size: 11px; font-family: var(--mono);
    display: flex; align-items: center; justify-content: space-between;
  }
  .offline-dot {
    width: 6px; height: 6px; border-radius: 50%; background: #FFB84D;
    display: inline-block; margin-right: 6px;
  }
  .sync-pending {
    background: rgba(255,255,255,0.15); border-radius: 10px;
    padding: 2px 8px; font-size: 10px;
  }

  /* ── CALENDAR MODAL ── */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    z-index: 200; display: flex; align-items: flex-end; justify-content: center;
  }
  .modal {
    background: var(--surface); border-radius: 20px 20px 0 0;
    width: 100%; max-width: 480px; padding: 20px 20px 36px;
    animation: slideUp 0.25s ease;
  }
  @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }

  .modal-handle { width: 36px; height: 4px; background: var(--border); border-radius: 2px; margin: 0 auto 16px; }
  .modal-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .modal-sub { font-size: 12px; font-family: var(--mono); color: var(--text-3); margin-bottom: 16px; }

  .cal-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .cal-month { font-size: 13px; font-weight: 500; font-family: var(--mono); }
  .cal-arrow {
    background: none; border: 1px solid var(--border); border-radius: 6px;
    width: 28px; height: 28px; cursor: pointer; font-size: 14px;
    display: flex; align-items: center; justify-content: center; color: var(--text-2);
  }
  .cal-arrow:hover { background: var(--bg); }

  .cal-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 4px; }
  .cal-dow {
    text-align: center; font-size: 10px; font-family: var(--mono);
    color: var(--text-3); padding-bottom: 6px; letter-spacing: 0.05em;
  }
  .cal-day {
    aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
    border-radius: 8px; font-size: 13px; font-family: var(--mono);
    cursor: pointer; border: 1.5px solid transparent; transition: all 0.1s;
    color: var(--text);
  }
  .cal-day:hover:not(.past):not(.empty) { background: var(--bg); border-color: var(--border); }
  .cal-day.past { color: var(--text-3); cursor: default; }
  .cal-day.today { border-color: var(--border); font-weight: 500; }
  .cal-day.selected { background: var(--accent); color: white; border-color: var(--accent); }
  .cal-day.today.selected { background: var(--accent); }
  .cal-day.empty { cursor: default; }
  .cal-day.has-schedule { position: relative; }
  .cal-day.has-schedule::after {
    content: ''; position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%);
    width: 4px; height: 4px; border-radius: 50%; background: var(--accent);
  }
  .cal-day.selected.has-schedule::after { background: white; }

  .cal-ration-row { display: flex; align-items: center; gap: 8px; margin: 14px 0 6px; }
  .cal-ration-label { font-size: 11px; font-family: var(--mono); color: var(--text-3); width: 70px; flex-shrink: 0; }

  .modal-actions { display: flex; gap: 8px; margin-top: 16px; }
  .modal-cancel {
    flex: 1; padding: 10px; background: none; border: 1px solid var(--border);
    border-radius: 8px; font-family: var(--mono); font-size: 12px; cursor: pointer; color: var(--text-2);
  }
  .modal-save {
    flex: 2; padding: 10px; background: var(--accent); border: none; color: white;
    border-radius: 8px; font-family: var(--mono); font-size: 12px; cursor: pointer;
  }
  .modal-save:disabled { opacity: 0.5; cursor: default; }

  .selected-count {
    font-size: 11px; font-family: var(--mono); color: var(--accent);
    margin-top: 10px; text-align: center; min-height: 16px;
  }
`;

// ── CALENDAR MODAL ────────────────────────────────────────────────────────────

function CalendarModal({ pen, rations, existingSchedule, timeOfDay, onSave, onClose }) {
  const today = new Date();
  today.setHours(0,0,0,0);
  const todayStr = toLocalDateStr(today);

  const filteredRations = rations.filter(r => r.time_of_day === timeOfDay);
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedDates, setSelectedDates] = useState(new Set());
  const [rationId, setRationId] = useState(filteredRations[0]?.id || pen.ration_id);
  const [useDdg, setUseDdg] = useState(pen.use_ddg);
  const [saving, setSaving] = useState(false);

  // Pre-mark dates that already have a schedule
  const scheduledMap = {};
  (existingSchedule || []).filter(s => s.pen_id === pen.id && rations.find(r => r.id === s.ration_id)?.time_of_day === timeOfDay).forEach(s => { scheduledMap[s.date] = s; });

  const monthName = new Date(viewYear, viewMonth).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();

  function toggleDate(dateStr) {
    if (dateStr < todayStr) return;
    setSelectedDates(prev => {
      const next = new Set(prev);
      next.has(dateStr) ? next.delete(dateStr) : next.add(dateStr);
      return next;
    });
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  }

  async function handleSave() {
    if (selectedDates.size === 0) return;
    setSaving(true);
    const rows = [...selectedDates].map(date => ({
      pen_id: pen.id, date, ration_id: rationId, use_ddg: useDdg,
    }));
    await onSave(pen.id, rows);
    setSaving(false);
    onClose();
  }

  const days = [];
  for (let i = 0; i < firstDow; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${viewYear}-${String(viewMonth+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    days.push(dateStr);
  }

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <div className="modal-title">Schedule {timeOfDay} rations - {pen.name}</div>
        <div className="modal-sub">Tap days to apply a ration. Dots = already scheduled.</div>

        <div className="cal-nav">
          <button className="cal-arrow" onClick={prevMonth}>‹</button>
          <span className="cal-month">{monthName}</span>
          <button className="cal-arrow" onClick={nextMonth}>›</button>
        </div>

        <div className="cal-grid">
          {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => (
            <div key={d} className="cal-dow">{d}</div>
          ))}
          {days.map((dateStr, i) => {
            if (!dateStr) return <div key={`e${i}`} className="cal-day empty" />;
            const isPast = dateStr < todayStr;
            const isToday = dateStr === todayStr;
            const isSelected = selectedDates.has(dateStr);
            const hasSchedule = !!scheduledMap[dateStr];
            let cls = "cal-day";
            if (isPast) cls += " past";
            if (isToday) cls += " today";
            if (isSelected) cls += " selected";
            if (hasSchedule) cls += " has-schedule";
            return (
              <div key={dateStr} className={cls} onClick={() => toggleDate(dateStr)}>
                {parseInt(dateStr.split("-")[2])}
              </div>
            );
          })}
        </div>

        {selectedDates.size > 0 && (
          <div className="selected-count">
            {selectedDates.size} day{selectedDates.size > 1 ? "s" : ""} selected
          </div>
        )}

        <div className="cal-ration-row">
          <span className="cal-ration-label">Ration</span>
          <select className="field-select" value={rationId} onChange={e => setRationId(e.target.value)}>
            {filteredRations.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>

        <div className="toggle-row" style={{ marginTop: 8 }}>
          <span className="cal-ration-label toggle-label">Use DDG</span>
          <button className={`toggle${useDdg ? " on" : ""}`} onClick={() => setUseDdg(v => !v)} />
          <span className="toggle-label" style={{ color: useDdg ? "var(--accent)" : "var(--text-3)" }}>
            {useDdg ? "Yes" : "No"}
          </span>
        </div>

        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>Cancel</button>
          <button
            className="modal-save"
            onClick={handleSave}
            disabled={selectedDates.size === 0 || saving}
          >
            {saving ? "Saving…" : `Apply to ${selectedDates.size || 0} day${selectedDates.size !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── COMPONENTS ────────────────────────────────────────────────────────────────

function RationDetail({ ration, useDdg, totalLbs }) {
  const ingredients = getIngredients(ration, useDdg, totalLbs);
  return (
    <div>
      <table className="ration-table">
        <thead><tr><th>Ingredient</th><th>%</th><th>Lbs</th></tr></thead>
        <tbody>
          {ingredients.map(i => (
            <tr key={i.name}>
              <td>{i.name}</td>
              <td>{Math.round(i.pct * 100)}%</td>
              <td>{i.lbs}</td>
            </tr>
          ))}
          <tr><td>Total</td><td>100%</td><td>{totalLbs}</td></tr>
        </tbody>
      </table>
      {!useDdg && <div className="ddg-note">★ No DDG formula</div>}
    </div>
  );
}

function MixerMode({ ingredients, totalLbs, onFinish, onCancel }) {
  const [step, setStep] = useState(0); // 0 = not started, 1..n = ingredient, n+1 = done

  const started = step > 0;
  const finished = step > ingredients.length;
  const current = started && !finished ? ingredients[step - 1] : null;

  const cumulativeLbs = ingredients
    .slice(0, step - 1)
    .reduce((sum, i) => sum + i.lbs, 0);
  const cumulativePct = Math.round((cumulativeLbs / totalLbs) * 100);

  if (!started) {
    return (
      <div className="mixer">
        <div className="mixer-step">
          <div className="mixer-progress-row">
            <span className="mixer-step-label">Ready to mix</span>
            <span className="mixer-step-count">{ingredients.length} ingredients · {totalLbs} lbs total</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--text-2)", fontFamily: "var(--mono)", lineHeight: 1.6 }}>
            {ingredients.map((i, idx) => (
              <div key={i.name} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid var(--border-light)" }}>
                <span style={{ color: "var(--text-3)" }}>{idx + 1}. {i.name}</span>
                <span>{i.lbs} lbs</span>
              </div>
            ))}
          </div>
        </div>
        <div className="mixer-nav">
          <button className="mixer-btn back" onClick={onCancel}>✕</button>
          <button className="mixer-btn start" onClick={() => setStep(1)}>Start mixing →</button>
        </div>
      </div>
    );
  }

  if (finished) {
    return (
      <div className="mixer">
        <div className="mixer-done-screen">
          <div className="mixer-done-icon">✓</div>
          <div className="mixer-done-title">Mix complete</div>
          <div className="mixer-done-sub">{totalLbs} lbs total · {ingredients.length} ingredients</div>
        </div>
        <div className="mixer-nav">
          <button className="mixer-btn back" onClick={() => setStep(0)}>↩</button>
          <button className="mixer-btn finish" onClick={onFinish}>Mark as done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mixer">
      <div className="mixer-step">
        <div className="mixer-progress-row">
          <span className="mixer-step-label">Step {step} of {ingredients.length}</span>
          <span className="mixer-step-count">{ingredients.length - step} remaining</span>
        </div>
        <div className="mixer-track">
          <div className="mixer-fill" style={{ width: `${Math.round((step - 1) / ingredients.length * 100)}%` }} />
        </div>

        <div className="mixer-ingredient-name">{current.name}</div>
        <div style={{ marginTop: 8 }}>
          <span className="mixer-ingredient-lbs">{current.lbs}</span>
          <span className="mixer-ingredient-unit">lbs</span>
          <span style={{ marginLeft: 12, fontSize: 12, fontFamily: "var(--mono)", color: "var(--text-3)" }}>
            ({Math.round(current.pct * 100)}%)
          </span>
        </div>

        <div className="mixer-cumulative">
          <div>
            <div className="mixer-cumulative-label">Running total after this step</div>
            <div className="mixer-cumulative-val">
              {Math.round((cumulativeLbs + current.lbs) * 10) / 10} lbs
              <span style={{ color: "var(--text-3)", marginLeft: 8 }}>
                of {totalLbs} lbs
              </span>
            </div>
            <div className="mixer-cumulative-bar">
              <div className="mixer-cumulative-fill"
                style={{ width: `${Math.round((cumulativeLbs + current.lbs) / totalLbs * 100)}%` }} />
            </div>
          </div>
        </div>
      </div>

      <div className="mixer-nav">
        <button className="mixer-btn back" onClick={() => setStep(s => Math.max(1, s - 1))}>←</button>
        <button className="mixer-btn next" onClick={() => setStep(s => s + 1)}>
          {step === ingredients.length ? "Finish →" : `Next →`}
        </button>
      </div>
    </div>
  );
}

function FeedCard({ pen, ration, event, onConfirm, feederName }) {
  const [mode, setMode] = useState("card"); // "card" | "overview" | "mixing"
  const [confirming, setConfirming] = useState(false);
  const totalLbs = getTotalLbs(pen, ration);
  const isDone = event.status === "done";
  const ingredients = getIngredients(ration, pen.use_ddg, totalLbs);

  async function handleConfirm() {
    if (isDone || confirming) return;
    setConfirming(true);
    await onConfirm(event.id, feederName);
    setConfirming(false);
    setMode("card");
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
            {isDone ? `✓ ${event.confirmed_by} · ${fmtTime(event.confirmed_at)}` : "Pending"}
          </div>
          {!isDone && mode === "card" && (
            <button className="start-btn" onClick={() => setMode("mixing")}>
              ▶ Start mixing
            </button>
          )}
          {!isDone && mode === "mixing" && (
            <MixerMode
              ingredients={ingredients}
              totalLbs={totalLbs}
              onFinish={handleConfirm}
              onCancel={() => setMode("card")}
            />
          )}
        </div>
        <button
          className={`check-btn${isDone ? " done" : ""}`}
          onClick={handleConfirm}
          disabled={isDone || confirming}
        >
          {confirming ? "…" : "✓"}
        </button>
      </div>
    </div>
  );
}

// ── FEEDER VIEW ───────────────────────────────────────────────────────────────

function getCurrentFeedPeriod() {
  const hour = new Date().getHours();
  const minute = new Date().getMinutes();
  if (hour === 0 && minute === 0) return "PM";
  if (hour < 13) return "AM";
  return "PM";
}

function FeederView({ pens, rations, events, feeders, onConfirm }) {
  const [feederName, setFeederName] = useState(feeders[0] || "");
  const [feedPeriod, setFeedPeriod] = useState(getCurrentFeedPeriod);

  useEffect(() => {
    const timer = setInterval(() => setFeedPeriod(getCurrentFeedPeriod()), 60000);
    return () => clearInterval(timer);
  }, []);

  const visibleEvents = events.filter(e => e.time_of_day === feedPeriod);
  const doneCount = visibleEvents.filter(e => e.status === "done").length;
  const total = visibleEvents.length || 1;

  const isAM = feedPeriod === "AM";
  const periodLabel = isAM ? "Morning · AM Feed" : "Afternoon · PM Feed";
  const periodTime = isAM ? "12:01 AM – 12:59 PM" : "1:00 PM – 12:00 AM";

  function renderCards(evts) {
    return evts.map(ev => {
      const pen = pens.find(p => p.id === ev.pen_id);
      const ration = rations.find(r => r.id === pen?.ration_id);
      if (!pen || !ration) return null;
      return <FeedCard key={ev.id} pen={pen} ration={ration} event={ev} onConfirm={onConfirm} feederName={feederName} />;
    });
  }

  return (
    <div className="content">
      <div className="feeder-bar">
        <span className="feeder-label">Feeder:</span>
        <select className="feeder-select" value={feederName} onChange={e => setFeederName(e.target.value)}>
          {feeders.map(f => <option key={f}>{f}</option>)}
        </select>
        <span className="sync-dot" title="Live sync active" />
      </div>

      <div className="progress-wrap">
        <div className="progress-header">
          <span className="progress-label">{periodLabel}</span>
          <span className="progress-count">{doneCount} / {visibleEvents.length} done</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${Math.round(doneCount / total * 100)}%` }} />
        </div>
        <div style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-3)", marginTop: 4 }}>
          {periodTime}
        </div>
      </div>

      {visibleEvents.length > 0
        ? renderCards(visibleEvents)
        : <div style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)", paddingTop: 40 }}>
            No {feedPeriod} feedings scheduled for today
          </div>
      }
    </div>
  );
}

// ── ADMIN PEN CARD ────────────────────────────────────────────────────────────

function PenCard({ pen, rations, schedule, onSave, onSaveSchedule }) {
  const [local, setLocal] = useState({ ...pen });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showCal, setShowCal] = useState(null); // null | "AM" | "PM"
  const dirty = JSON.stringify(local) !== JSON.stringify(pen);

  const amRations = rations.filter(r => r.time_of_day === "AM");
  const pmRations = rations.filter(r => r.time_of_day === "PM");

  // Default ration dropdowns per tab
  const [amRationId, setAmRationId] = useState(
    amRations.find(r => r.id === pen.ration_id)?.id || amRations[0]?.id || ""
  );
  const [pmRationId, setPmRationId] = useState(
    pmRations.find(r => r.id === pen.ration_id)?.id || pmRations[0]?.id || ""
  );

  const ration = rations.find(r => r.id === local.ration_id);
  const calcLbs = ration ? Math.round(local.head_count * ration.lbs_per_head * 10) / 10 : 0;
  const totalLbs = (local.total_lbs_override !== null && local.total_lbs_override !== undefined)
    ? local.total_lbs_override : calcLbs;

  function set(field, value) { setLocal(prev => ({ ...prev, [field]: value })); setSaved(false); }

  async function handleSave() {
    setSaving(true);
    await onSave(pen.id, {
      head_count: local.head_count,
      ration_id: local.ration_id,
      use_ddg: local.use_ddg,
      total_lbs_override: local.total_lbs_override,
    });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const amUpcoming = (schedule || []).filter(s => rations.find(r => r.id === s.ration_id)?.time_of_day === "AM").length;
  const pmUpcoming = (schedule || []).filter(s => rations.find(r => r.id === s.ration_id)?.time_of_day === "PM").length;

  return (
    <>
      <div className="pen-admin-card">
        <div className="pen-admin-header">
          <div className="pen-admin-name">{pen.name}</div>
          <div className={`pen-tag ${pen.type.toLowerCase()}`}>{pen.type}</div>
        </div>

        <div className="field-row">
          <span className="field-label">Head count</span>
          <input className="field-input" type="number" min="1"
            value={local.head_count}
            onChange={e => set("head_count", parseInt(e.target.value) || 1)} />
        </div>

        <div className="field-row">
          <span className="field-label">Ration</span>
          <select className="field-select" value={local.ration_id}
            onChange={e => set("ration_id", e.target.value)}>
            <optgroup label="AM">
              {amRations.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </optgroup>
            <optgroup label="PM">
              {pmRations.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </optgroup>
          </select>
        </div>

        <div className="toggle-row">
          <span className="field-label toggle-label">Use DDG</span>
          <button className={`toggle${local.use_ddg ? " on" : ""}`}
            onClick={() => set("use_ddg", !local.use_ddg)} />
          <span className="toggle-label" style={{ color: local.use_ddg ? "var(--accent)" : "var(--text-3)" }}>
            {local.use_ddg ? "Yes" : "No"}
          </span>
        </div>

        <div className="total-lbs-row">
          <span className="field-label">Total lbs</span>
          <input className="field-input" type="number" min="1" step="0.5"
            value={totalLbs}
            onChange={e => set("total_lbs_override", parseFloat(e.target.value) || calcLbs)} />
          {local.total_lbs_override !== null && local.total_lbs_override !== undefined && (
            <button className="override-clear" onClick={() => set("total_lbs_override", null)}>reset</button>
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

        <div style={{ marginTop: 10 }}>
          <div className="admin-section-title" style={{ marginBottom: 6 }}>Schedule rations</div>
          <div className="ampm-tabs">
            <button className={`ampm-tab am${showCal === "AM" ? " active" : ""}`}
              onClick={() => setShowCal(c => c === "AM" ? null : "AM")}>
              📅 AM{amUpcoming > 0 ? ` · ${amUpcoming}` : ""}
            </button>
            <button className={`ampm-tab pm${showCal === "PM" ? " active" : ""}`}
              onClick={() => setShowCal(c => c === "PM" ? null : "PM")}>
              📅 PM{pmUpcoming > 0 ? ` · ${pmUpcoming}` : ""}
            </button>
          </div>
        </div>
      </div>

      {showCal && (
        <CalendarModal
          pen={pen}
          rations={rations}
          existingSchedule={schedule}
          timeOfDay={showCal}
          onSave={onSaveSchedule}
          onClose={() => setShowCal(null)}
        />
      )}
    </>
  );
}

// ── ADMIN VIEW ────────────────────────────────────────────────────────────────

function AdminView({ pens, rations, events, penSchedules, onSavePen, onSaveSchedule }) {
  const [tab, setTab] = useState("pens");
  const doneCount = events.filter(e => e.status === "done").length;
  const pendingCount = events.length - doneCount;
  const doneEvents = [...events].filter(e => e.status === "done")
    .sort((a, b) => new Date(a.confirmed_at) - new Date(b.confirmed_at));

  return (
    <div className="content">
      <div className="nav" style={{ margin: "0 -16px 16px", borderTop: "1px solid var(--border)" }}>
        {["pens","log"].map(t => (
          <button key={t} className={`nav-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {t === "pens" ? "Pen Setup" : "Today's Log"}
          </button>
        ))}
      </div>

      {tab === "pens" && (
        <>
          <div className="stat-row">
            <div className="stat-card"><div className="stat-num">{events.length}</div><div className="stat-lbl">Total</div></div>
            <div className="stat-card"><div className="stat-num green">{doneCount}</div><div className="stat-lbl">Done</div></div>
            <div className="stat-card"><div className="stat-num amber">{pendingCount}</div><div className="stat-lbl">Pending</div></div>
          </div>
          <div className="admin-section">
            <div className="admin-section-title">Pen Configuration</div>
            {pens.map(pen => (
              <PenCard
                key={pen.id} pen={pen} rations={rations}
                schedule={penSchedules[pen.id] || []}
                onSave={onSavePen}
                onSaveSchedule={onSaveSchedule}
              />
            ))}
          </div>
        </>
      )}

      {tab === "log" && (
        <div className="admin-section">
          <div className="admin-section-title"><span className="sync-dot" />Completed feedings today</div>
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

// ── OFFLINE QUEUE ─────────────────────────────────────────────────────────────

const QUEUE_KEY = "3b_offline_queue";

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
  catch { return []; }
}

function saveQueue(queue) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); }
  catch {}
}

function addToQueue(item) {
  const queue = loadQueue();
  queue.push(item);
  saveQueue(queue);
}

function removeFromQueue(eventId) {
  const queue = loadQueue().filter(q => q.eventId !== eventId);
  saveQueue(queue);
}

async function flushQueue(setEvents) {
  const queue = loadQueue();
  if (queue.length === 0) return;
  for (const item of queue) {
    try {
      await db.confirmEvent(item.eventId, item.confirmedBy);
      removeFromQueue(item.eventId);
      setEvents(prev => prev.map(e =>
        e.id === item.eventId
          ? { ...e, status: "done", confirmed_by: item.confirmedBy, confirmed_at: item.confirmedAt }
          : e
      ));
    } catch {}
  }
}

// ── ROOT APP ──────────────────────────────────────────────────────────────────

export default function App() {
  const [role, setRole] = useState("feeder");
  const [pens, setPens] = useState([]);
  const [rations, setRations] = useState([]);
  const [events, setEvents] = useState([]);
  const [feeders, setFeeders] = useState([]);
  const [penSchedules, setPenSchedules] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [offlinePending, setOfflinePending] = useState(() => loadQueue().length);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  async function loadSchedules(penList) {
    const schedules = {};
    await Promise.all(penList.map(async pen => {
      try {
        const rows = await db.getPenSchedule(pen.id);
        schedules[pen.id] = rows || [];
      } catch (_) { schedules[pen.id] = []; }
    }));
    setPenSchedules(schedules);
  }

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
        await loadSchedules(p || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Online/offline detection + auto-sync queue on reconnect
  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
      flushQueue(setEvents).then(() => setOfflinePending(loadQueue().length));
    }
    function handleOffline() { setIsOnline(false); }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    // Flush any queued items from previous session on load
    if (navigator.onLine) {
      flushQueue(setEvents).then(() => setOfflinePending(loadQueue().length));
    }
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const unsub = subscribeRealtime("feed_events", () => {
      db.getTodayEvents().then(e => setEvents(e || []));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = subscribeRealtime("pens", () => {
      db.getPens().then(p => { setPens(p || []); loadSchedules(p || []); });
    });
    return unsub;
  }, []);

  const confirmEvent = useCallback(async (eventId, feederName) => {
    const confirmedAt = new Date().toISOString();
    // Optimistic update immediately — works online or offline
    setEvents(prev => prev.map(e =>
      e.id === eventId
        ? { ...e, status: "done", confirmed_by: feederName, confirmed_at: confirmedAt }
        : e
    ));
    if (navigator.onLine) {
      try {
        await db.confirmEvent(eventId, feederName);
        removeFromQueue(eventId);
      } catch {
        // Online but request failed — queue it
        addToQueue({ eventId, confirmedBy: feederName, confirmedAt });
        setOfflinePending(prev => prev + 1);
      }
    } else {
      // Offline — queue for later
      addToQueue({ eventId, confirmedBy: feederName, confirmedAt });
      setOfflinePending(prev => prev + 1);
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

  const saveSchedule = useCallback(async (penId, rows) => {
    try {
      await db.upsertPenSchedule(rows);
      setPenSchedules(prev => {
        const existing = prev[penId] || [];
        const newDates = new Set(rows.map(r => r.date));
        const merged = existing.filter(r => !newDates.has(r.date)).concat(rows);
        return { ...prev, [penId]: merged.sort((a,b) => a.date.localeCompare(b.date)) };
      });
    } catch (err) {
      setError("Failed to save schedule. Try again.");
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

        {!isOnline && (
          <div className="offline-bar">
            <span><span className="offline-dot" />No signal — changes saved locally</span>
            {offlinePending > 0 && (
              <span className="sync-pending">{offlinePending} pending sync</span>
            )}
          </div>
        )}
        {isOnline && offlinePending > 0 && (
          <div className="offline-bar" style={{ background: "#2D5A27", color: "#EAF2E8" }}>
            <span>⟳ Syncing {offlinePending} offline confirmation{offlinePending > 1 ? "s" : ""}…</span>
          </div>
        )}
        {error && <div className="error-bar">{error}</div>}

        {role === "feeder" ? (
          <FeederView pens={pens} rations={rations} events={events} feeders={feeders} onConfirm={confirmEvent} />
        ) : (
          <AdminView pens={pens} rations={rations} events={events} penSchedules={penSchedules} onSavePen={savePen} onSaveSchedule={saveSchedule} />
        )}
      </div>
    </>
  );
}
