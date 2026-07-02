import { useState, useEffect, useCallback, useMemo } from "react";

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
  // Conflict target includes time_of_day so AM and PM schedules for the same
  // pen+date are separate rows instead of overwriting each other. Requires the
  // pen_schedule table to have a unique constraint on (pen_id, date, time_of_day).
  upsertPenSchedule: (rows) =>
    sbFetch("/pen_schedule?on_conflict=pen_id,date,time_of_day", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(rows),
    }),
  deletePenSchedule: (penId, dates, timeOfDay) => {
    const todFilter = timeOfDay ? `&time_of_day=eq.${timeOfDay}` : "";
    return sbFetch(`/pen_schedule?pen_id=eq.${penId}&date=in.(${dates.join(",")})${todFilter}`, {
      method: "DELETE",
    });
  },
  updateRation: (id, updates) =>
    sbFetch(`/rations?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    }),
  createRation: (payload) =>
    sbFetch("/rations", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteRation: (id) =>
    sbFetch(`/rations?id=eq.${id}`, {
      method: "DELETE",
    }),
  getTodaySchedule: () => {
    const today = new Date().toLocaleDateString("en-CA");
    return sbFetch(`/pen_schedule?select=*&date=eq.${today}`);
  },
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

function sumIngredientAmount(list) {
  return (list || []).reduce((s, i) => s + (i.lbs ?? i.pct ?? 0), 0);
}

// Choose the DDG or No-DDG list for a lbs-mode ration. If the preferred variant
// was never filled in (sums to 0) but the other variant has real amounts, fall
// back to that one — guards against a ration where only one variant got edited
// while a pen/schedule's "Use DDG" flag points at the empty one.
function pickRationList(ration, preferDdg) {
  const primary = preferDdg ? ration.ingredients : ration.ingredients_no_ddg;
  const fallback = preferDdg ? ration.ingredients_no_ddg : ration.ingredients;
  if (sumIngredientAmount(primary) === 0 && sumIngredientAmount(fallback) > 0) {
    return { list: fallback || [], usedDdg: !preferDdg };
  }
  return { list: primary || [], usedDdg: preferDdg };
}

function getTotalLbs(pen, ration) {
  if (ration?.mode === "lbs") {
    // lbs Direct: total is sum of stored ingredient lbs
    const { list } = pickRationList(ration, pen.use_ddg);
    return Math.round(sumIngredientAmount(list) * 10) / 10;
  }
  return pen.total_lbs || 0;
}

function getIngredients(ration, useDdg, totalLbs) {
  if (ration.mode === "lbs") {
    // lbs Direct: stored lbs are the exact amounts — no calculation needed
    const { list } = pickRationList(ration, useDdg);
    return (list || []).map(i => ({ ...i, lbs: i.lbs || 0 }));
  }
  // pct mode: calculate from pen total lbs × percentage
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
    padding: 12px 20px 10px;
    display: flex; align-items: center; justify-content: space-between;
    position: sticky; top: 0; z-index: 100;
  }
  .header-left { display: flex; flex-direction: column; gap: 3px; }
  .header-logo { height: 28px; width: auto; display: block; }
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

  /* ── RATION EDITOR ── */
  .ration-editor-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; margin-bottom: 10px; overflow: hidden;
  }
  .ration-editor-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; cursor: pointer; user-select: none;
  }
  .ration-editor-header:hover { background: var(--bg); }
  .ration-editor-title { font-size: 14px; font-weight: 600; }
  .ration-editor-meta { font-size: 11px; font-family: var(--mono); color: var(--text-3); margin-top: 2px; }
  .ration-editor-chevron { font-size: 12px; color: var(--text-3); transition: transform 0.2s; }
  .ration-editor-chevron.open { transform: rotate(180deg); }
  .ration-editor-body { padding: 0 14px 14px; border-top: 1px solid var(--border-light); }

  .ration-field-row {
    display: grid; grid-template-columns: 1fr 72px 72px 28px;
    gap: 6px; align-items: center; padding: 6px 0;
    border-bottom: 1px solid var(--border-light);
    font-size: 12px; font-family: var(--mono);
  }
  .ration-field-row:last-of-type { border-bottom: none; }
  .ration-field-row.header { color: var(--text-3); font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; padding-top: 10px; }
  .ration-ing-name { color: var(--text); font-size: 12px; }
  .ration-ing-input {
    width: 100%; font-family: var(--mono); font-size: 12px;
    border: 1px solid var(--border); border-radius: 6px;
    padding: 5px 7px; background: var(--bg); color: var(--text);
    outline: none; text-align: right;
  }
  .ration-ing-input:focus { border-color: var(--accent); }
  .ration-remove-btn {
    background: none; border: none; cursor: pointer;
    color: var(--text-3); font-size: 14px; padding: 0;
    line-height: 1; transition: color 0.15s;
  }
  .ration-remove-btn:hover { color: var(--danger); }
  .ration-add-btn {
    margin-top: 10px; width: 100%; padding: 7px;
    background: none; border: 1px dashed var(--border);
    border-radius: 7px; font-family: var(--mono); font-size: 11px;
    color: var(--text-3); cursor: pointer; transition: all 0.15s;
  }
  .ration-add-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-light); }
  .ration-lbs-row {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 0 4px; border-top: 1px solid var(--border-light); margin-top: 6px;
  }
  .ration-lbs-label { font-size: 11px; font-family: var(--mono); color: var(--text-3); flex: 1; }
  .pct-warning { font-size: 10px; font-family: var(--mono); margin-top: 4px; }
  .pct-warning.ok { color: var(--accent); }
  .pct-warning.warn { color: var(--warn); }
  .input-mode-toggle {
    display: flex; gap: 4px; margin-bottom: 10px; margin-top: 4px;
  }
  .input-mode-btn {
    flex: 1; padding: 5px 8px; font-size: 10px; font-family: var(--mono);
    border-radius: 6px; border: 1px solid var(--border);
    background: none; color: var(--text-3); cursor: pointer; transition: all 0.15s;
    letter-spacing: 0.04em;
  }
  .input-mode-btn.active { background: var(--fp-light); color: var(--fp); border-color: var(--fp-light); }

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

  /* ── RATION EDITOR ── */
  .ration-editor-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; margin-bottom: 10px; overflow: hidden;
  }
  .ration-editor-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; cursor: pointer; user-select: none;
  }
  .ration-editor-header:hover { background: var(--bg); }
  .ration-editor-title { font-size: 14px; font-weight: 600; }
  .ration-editor-meta { font-size: 11px; font-family: var(--mono); color: var(--text-3); margin-top: 2px; }
  .ration-editor-chevron { font-size: 12px; color: var(--text-3); transition: transform 0.2s; }
  .ration-editor-chevron.open { transform: rotate(180deg); }
  .ration-editor-body { padding: 0 14px 14px; border-top: 1px solid var(--border-light); }

  .ration-field-row {
    display: grid; grid-template-columns: 1fr 80px 80px 28px;
    gap: 6px; align-items: center; padding: 6px 0;
    border-bottom: 1px solid var(--border-light);
    font-size: 12px; font-family: var(--mono);
  }
  .ration-field-row:last-of-type { border-bottom: none; }
  .ration-field-row.header { color: var(--text-3); font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; padding-top: 10px; }
  .ration-ing-name { color: var(--text); font-size: 12px; }
  .ration-ing-input {
    width: 100%; font-family: var(--mono); font-size: 12px;
    border: 1px solid var(--border); border-radius: 6px;
    padding: 5px 7px; background: var(--bg); color: var(--text);
    outline: none; text-align: right;
  }
  .ration-ing-input:focus { border-color: var(--accent); }
  .ration-remove-btn {
    background: none; border: none; cursor: pointer;
    color: var(--text-3); font-size: 14px; padding: 0;
    line-height: 1; transition: color 0.15s;
  }
  .ration-remove-btn:hover { color: var(--danger); }
  .ration-add-btn {
    margin-top: 10px; width: 100%; padding: 7px;
    background: none; border: 1px dashed var(--border);
    border-radius: 7px; font-family: var(--mono); font-size: 11px;
    color: var(--text-3); cursor: pointer; transition: all 0.15s;
  }
  .ration-add-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-light); }
  .ration-lbs-row {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 0 4px; border-top: 1px solid var(--border-light); margin-top: 6px;
  }
  .ration-lbs-label { font-size: 11px; font-family: var(--mono); color: var(--text-3); flex: 1; }
  .pct-warning { font-size: 10px; font-family: var(--mono); margin-top: 4px; }
  .pct-warning.ok { color: var(--accent); }
  .pct-warning.warn { color: var(--warn); }

  /* ── RATION CARD (merged DDG / No-DDG) ── */
  .ration-editor-card.new { border: 1px dashed var(--accent); }

  .ration-time-tag {
    display: inline-block; font-family: var(--mono); font-size: 10px; font-weight: 500;
    padding: 3px 8px; border-radius: 5px; flex-shrink: 0;
  }
  .ration-time-tag.am { background: var(--fp-light); color: var(--fp); }
  .ration-time-tag.pm { background: var(--cp-light); color: var(--cp); }

  .ration-delete-btn {
    background: none; border: none; cursor: pointer; color: var(--text-3);
    font-size: 14px; padding: 4px; line-height: 1; transition: color 0.15s; flex-shrink: 0;
  }
  .ration-delete-btn:hover:not(:disabled) { color: var(--danger); }
  .ration-delete-btn:disabled { opacity: 0.5; cursor: default; }

  .variant-toggle { display: flex; gap: 4px; margin: 10px 0; }
  .variant-btn {
    flex: 1; padding: 6px 8px; font-size: 11px; font-family: var(--mono); font-weight: 500;
    border-radius: 6px; border: 1px solid var(--border); background: none; color: var(--text-3);
    cursor: pointer; transition: all 0.15s;
  }
  .variant-btn.active { background: var(--accent-light); color: var(--accent-text); border-color: var(--accent-light); }

  .new-ration-btn {
    width: 100%; margin-top: 4px; padding: 12px;
    background: var(--accent-light); color: var(--accent-text);
    border: 1px dashed var(--accent); border-radius: 10px;
    font-family: var(--mono); font-size: 12px; font-weight: 500;
    cursor: pointer; transition: all 0.15s;
  }
  .new-ration-btn:hover { background: var(--accent); color: white; border-style: solid; }

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

  // Pre-mark dates that already have a schedule for this AM/PM period.
  // Prefer the schedule row's own time_of_day (set at scheduling time); fall back
  // to the linked ration's time_of_day for older rows saved before that column existed.
  const scheduledMap = {};
  (existingSchedule || [])
    .filter(s => s.pen_id === pen.id && (s.time_of_day || rations.find(r => r.id === s.ration_id)?.time_of_day) === timeOfDay)
    .forEach(s => { scheduledMap[s.date] = s; });

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
      pen_id: pen.id, date, ration_id: rationId, use_ddg: useDdg, time_of_day: timeOfDay,
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
            {ration.name} · {totalLbs} lbs{ration.mode !== "lbs" && ` · ${pen.head_count} head`}
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

function FeederView({ pens, rations, events, feeders, todaySchedule, onConfirm }) {
  const [feederName, setFeederName] = useState(feeders[0] || "");
  const [feedPeriod, setFeedPeriod] = useState(getCurrentFeedPeriod);

  useEffect(() => {
    const timer = setInterval(() => setFeedPeriod(getCurrentFeedPeriod()), 60000);
    return () => clearInterval(timer);
  }, []);

  const isAM = feedPeriod === "AM";
  const periodLabel = isAM ? "Morning · AM Feed" : "Afternoon · PM Feed";
  const periodTime = isAM ? "12:01 AM – 12:59 PM" : "1:00 PM – 12:00 AM";

  // Only show active pens that have a schedule entry for today matching the feed period
  const visibleSchedule = todaySchedule.filter(s => {
    const pen = pens.find(p => p.id === s.pen_id);
    if (!pen || !pen.is_active) return false;
    const ration = rations.find(r => r.id === s.ration_id);
    const period = s.time_of_day || ration?.time_of_day;
    return period === feedPeriod;
  });

  // Match schedule entries to feed events for confirmation state
  const visibleCards = visibleSchedule.map(s => {
    const pen = pens.find(p => p.id === s.pen_id);
    const ration = rations.find(r => r.id === s.ration_id);
    const event = events.find(e => e.pen_id === s.pen_id && e.time_of_day === feedPeriod);
    // Use schedule entry's use_ddg, not pen's current setting
    const useDdg = s.use_ddg ?? pen?.use_ddg ?? true;
    return { pen: pen ? { ...pen, use_ddg: useDdg } : pen, ration, event, scheduleId: s.id };
  }).filter(c => c.pen && c.ration);

  const doneCount = visibleCards.filter(c => c.event?.status === "done").length;
  const total = visibleCards.length || 1;

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
          <span className="progress-count">{doneCount} / {visibleCards.length} done</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${Math.round(doneCount / total * 100)}%` }} />
        </div>
        <div style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-3)", marginTop: 4 }}>
          {periodTime}
        </div>
      </div>

      {visibleCards.length > 0
        ? visibleCards.map(({ pen, ration, event }) => (
            <FeedCard
              key={`${pen.id}-${feedPeriod}`}
              pen={pen}
              ration={ration}
              event={event || { id: `${pen.id}-${feedPeriod}`, pen_id: pen.id, time_of_day: feedPeriod, status: "pending", confirmed_by: null, confirmed_at: null }}
              onConfirm={onConfirm}
              feederName={feederName}
            />
          ))
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

  // Sync if pen id changes (switching pens)
  useEffect(() => { setLocal({ ...pen }); }, [pen.id]);
  const dirty = JSON.stringify(local) !== JSON.stringify(pen);

  const amRations = rations.filter(r => r.time_of_day === "AM");
  const pmRations = rations.filter(r => r.time_of_day === "PM");
  const totalLbs = parseFloat(local.total_lbs) || 0;

  function set(field, value) { setLocal(prev => ({ ...prev, [field]: value })); setSaved(false); }

  async function handleSave() {
    setSaving(true);
    await onSave(pen.id, {
      head_count: local.head_count,
      use_ddg: local.use_ddg,
      total_lbs: local.total_lbs || 0,
      is_active: local.is_active,
    });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const amUpcoming = (schedule || []).filter(s => (s.time_of_day || rations.find(r => r.id === s.ration_id)?.time_of_day) === "AM").length;
  const pmUpcoming = (schedule || []).filter(s => (s.time_of_day || rations.find(r => r.id === s.ration_id)?.time_of_day) === "PM").length;

  return (
    <>
      <div className="pen-admin-card">
        <div className="pen-admin-header">
          <div className="pen-admin-name">{pen.name}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: local.is_active ? "var(--accent)" : "var(--text-3)" }}>
              {local.is_active ? "Active" : "Inactive"}
            </span>
            <button
              className={`toggle${local.is_active ? " on" : ""}`}
              onClick={() => set("is_active", !local.is_active)}
              aria-label={local.is_active ? "Deactivate pen" : "Activate pen"}
            />
            <div className={`pen-tag ${pen.type.toLowerCase()}`}>{pen.type}</div>
          </div>
        </div>

        <div className="field-row">
          <span className="field-label">Head count</span>
          <input className="field-input" type="number" min="1"
            value={local.head_count}
            onChange={e => set("head_count", parseInt(e.target.value) || 1)} />
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
          <input className="field-input" type="number" min="0" step="0.5"
            value={totalLbs}
            onChange={e => set("total_lbs", parseFloat(e.target.value) || 0)} />
        </div>

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


// Legacy rations may still have %-based ingredients (pct of a pen's total lbs).
// We only ever edit in fixed lbs now — this gives old % entries a starting lbs
// number (pct × 100) so an admin can review and correct the real amount.
function toLbsIngredient(i) {
  return {
    name: i.name || "",
    lbs: i.lbs !== undefined ? Math.round((parseFloat(i.lbs) || 0) * 10) / 10 : Math.round((i.pct || 0) * 1000) / 10,
  };
}

function RationCard({ ration, onSave, onDelete, isNew, onCancelNew, knownIngredients }) {
  const [open, setOpen] = useState(!!isNew);
  const [variant, setVariant] = useState("ddg"); // "ddg" | "no-ddg"
  const [rationName, setRationName] = useState(ration.name || "");
  const [timeOfDay, setTimeOfDay] = useState(ration.time_of_day || "AM");
  const [ddgIngredients, setDdgIngredients] = useState((ration.ingredients || []).map(toLbsIngredient));
  const [noDdgIngredients, setNoDdgIngredients] = useState((ration.ingredients_no_ddg || []).map(toLbsIngredient));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Sync from parent when this (existing) ration changes externally
  useEffect(() => {
    if (isNew) return;
    setRationName(ration.name);
    setTimeOfDay(ration.time_of_day);
    setDdgIngredients((ration.ingredients || []).map(toLbsIngredient));
    setNoDdgIngredients((ration.ingredients_no_ddg || []).map(toLbsIngredient));
  }, [ration.id, ration.name, ration.time_of_day]);

  const ingredients = variant === "ddg" ? ddgIngredients : noDdgIngredients;
  const setIngredients = variant === "ddg" ? setDdgIngredients : setNoDdgIngredients;
  const baseIngredients = variant === "ddg" ? ration.base_ingredients : ration.base_ingredients_no_ddg;
  const hasBase = !isNew && !!baseIngredients;

  // Strip the transient "_custom" UI flag (marks a row as free-text entry) before
  // saving or comparing against stored data.
  function cleanIng(i) { return { name: i.name, lbs: parseFloat(i.lbs) || 0 }; }

  const isModified = !isNew && (
    (!!ration.base_ingredients && JSON.stringify(ddgIngredients.map(cleanIng)) !== JSON.stringify(ration.base_ingredients.map(toLbsIngredient))) ||
    (!!ration.base_ingredients_no_ddg && JSON.stringify(noDdgIngredients.map(cleanIng)) !== JSON.stringify(ration.base_ingredients_no_ddg.map(toLbsIngredient)))
  );

  function updateName(idx, name) {
    setIngredients(prev => prev.map((i, n) => n === idx ? { ...i, name } : i));
    setSaved(false);
  }

  function setCustomRow(idx) {
    setIngredients(prev => prev.map((i, n) => n === idx ? { ...i, name: "", _custom: true } : i));
    setSaved(false);
  }

  function updateLbs(idx, val) {
    setIngredients(prev => prev.map((i, n) => n === idx ? { ...i, lbs: parseFloat(val) || 0 } : i));
    setSaved(false);
  }

  function removeIng(idx) {
    setIngredients(prev => prev.filter((_, n) => n !== idx));
    setSaved(false);
  }

  function addIng() {
    setIngredients(prev => [...prev, { name: "", lbs: 0 }]);
    setSaved(false);
  }

  const nameOk = rationName.trim().length > 0;
  const readyToCreate = isNew && nameOk && ddgIngredients.length > 0 && ddgIngredients.every(i => i.name.trim());

  const dirty = isNew ||
    rationName.trim() !== ration.name ||
    timeOfDay !== ration.time_of_day ||
    JSON.stringify(ddgIngredients.map(cleanIng)) !== JSON.stringify((ration.ingredients || []).map(toLbsIngredient)) ||
    JSON.stringify(noDdgIngredients.map(cleanIng)) !== JSON.stringify((ration.ingredients_no_ddg || []).map(toLbsIngredient));

  async function handleSave() {
    setSaving(true);
    const payload = {
      name: rationName.trim() || (isNew ? "Untitled ration" : ration.name),
      time_of_day: timeOfDay,
      mode: "lbs",
      ingredients: ddgIngredients.map(cleanIng),
      ingredients_no_ddg: noDdgIngredients.map(cleanIng),
    };

    try {
      if (isNew) {
        await onSave(payload);
      } else {
        await onSave(ration.id, payload);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!confirmReset) { setConfirmReset(true); return; }
    setResetting(true);
    const field = variant === "ddg" ? "ingredients" : "ingredients_no_ddg";
    const resetLbs = baseIngredients.map(toLbsIngredient);
    await onSave(ration.id, { [field]: resetLbs, mode: "lbs" });
    setIngredients(resetLbs);
    setResetting(false);
    setConfirmReset(false);
    setSaved(false);
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    await onDelete(ration.id);
  }

  const totalLbs = Math.round(ingredients.reduce((s, i) => s + (parseFloat(i.lbs) || 0), 0) * 10) / 10;

  return (
    <div className={`ration-editor-card${isNew ? " new" : ""}`}>
      <div
        className="ration-editor-header"
        style={isNew ? { cursor: "default" } : undefined}
        onClick={() => { if (isNew) return; setOpen(o => !o); setConfirmReset(false); setConfirmDelete(false); }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {!isNew && <span className={`ration-time-tag ${(timeOfDay || "").toLowerCase()}`}>{timeOfDay}</span>}
          <div>
            <div className="ration-editor-title">
              {isNew ? "New ration" : rationName}
              {isModified && <span style={{ marginLeft: 8, fontSize: 10, fontFamily: "var(--mono)", color: "var(--warn)", background: "var(--warn-light)", padding: "2px 6px", borderRadius: 4 }}>modified</span>}
            </div>
            {!isNew && (
              <div className="ration-editor-meta">{ddgIngredients.length} DDG · {noDdgIngredients.length} No DDG</div>
            )}
          </div>
        </div>
        {isNew ? (
          <button className="ration-delete-btn" onClick={onCancelNew}>✕</button>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              className="ration-delete-btn"
              onClick={e => { e.stopPropagation(); handleDelete(); }}
              disabled={deleting}
              title="Delete ration"
            >
              {confirmDelete ? "⚠" : "🗑"}
            </button>
            <span className={`ration-editor-chevron${open ? " open" : ""}`}>▼</span>
          </div>
        )}
      </div>

      {(open || isNew) && (
        <div className="ration-editor-body">
          <div className="field-row" style={{ marginTop: 10 }}>
            <span className="field-label">Ration name</span>
            <input
              className="field-input"
              value={rationName}
              onChange={e => { setRationName(e.target.value); setSaved(false); }}
              placeholder="e.g. Starter"
            />
          </div>
          <div className="field-row">
            <span className="field-label">Feed time</span>
            <select className="field-select" value={timeOfDay} onChange={e => { setTimeOfDay(e.target.value); setSaved(false); }}>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
          </div>

          <div className="variant-toggle">
            <button className={`variant-btn${variant === "ddg" ? " active" : ""}`} onClick={() => setVariant("ddg")}>With DDG</button>
            <button className={`variant-btn${variant === "no-ddg" ? " active" : ""}`} onClick={() => setVariant("no-ddg")}>No DDG</button>
          </div>

          {variant === "no-ddg" && noDdgIngredients.length === 0 && ddgIngredients.length > 0 && (
            <button className="ration-add-btn" style={{ marginBottom: 10 }}
              onClick={() => setNoDdgIngredients(ddgIngredients.map(i => ({ ...i })))}>
              ⧉ Copy ingredients from "With DDG"
            </button>
          )}

          <div className="ration-field-row header" style={{ gridTemplateColumns: "1fr 90px 28px" }}>
            <span>Ingredient</span>
            <span style={{textAlign:"right"}}>Lbs</span>
            <span></span>
          </div>

          {ingredients.map((ing, idx) => {
            const isCustomRow = ing._custom || (ing.name !== "" && !knownIngredients.includes(ing.name));
            return (
              <div className="ration-field-row" style={{ gridTemplateColumns: "1fr 90px 28px" }} key={idx}>
                {isCustomRow ? (
                  <input
                    className="ration-ing-input" style={{ textAlign: "left" }}
                    value={ing.name}
                    autoFocus
                    placeholder="New ingredient name"
                    onChange={e => updateName(idx, e.target.value)}
                  />
                ) : (
                  <select
                    className="ration-ing-input" style={{ textAlign: "left" }}
                    value={ing.name}
                    onChange={e => {
                      if (e.target.value === "__custom__") setCustomRow(idx);
                      else updateName(idx, e.target.value);
                    }}
                  >
                    <option value="" disabled>Select ingredient…</option>
                    {knownIngredients.map(name => <option key={name} value={name}>{name}</option>)}
                    <option value="__custom__">+ Add new ingredient…</option>
                  </select>
                )}
                <input
                  className="ration-ing-input"
                  type="number" min="0" step="0.1"
                  value={ing.lbs}
                  onChange={e => updateLbs(idx, e.target.value)}
                />
                <button className="ration-remove-btn" onClick={() => removeIng(idx)}>×</button>
              </div>
            );
          })}

          <button className="ration-add-btn" onClick={addIng}>+ Add ingredient</button>

          <div className="pct-warning ok">Total: {totalLbs} lbs · exact amounts, no pen total needed</div>

          {isNew ? (
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="modal-cancel" style={{ flex: 1 }} onClick={onCancelNew}>Cancel</button>
              <button className="save-btn" style={{ flex: 2, marginTop: 0 }} onClick={handleSave} disabled={saving || !readyToCreate}>
                {saving ? "Creating…" : "Create ration"}
              </button>
            </div>
          ) : (
            <>
              {dirty && (
                <button className="save-btn" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : "Save ration"}
                </button>
              )}
              {saved && <div className="saved-badge">✓ Saved</div>}

              {hasBase && (
                <button
                  onClick={handleReset}
                  disabled={resetting}
                  style={{
                    width: "100%", marginTop: 8, padding: "8px",
                    background: "none", border: `1px solid ${confirmReset ? "#8B1A1A" : "var(--border)"}`,
                    borderRadius: 8, fontFamily: "var(--mono)", fontSize: 12,
                    color: confirmReset ? "#8B1A1A" : "var(--text-3)",
                    cursor: "pointer", transition: "all 0.15s",
                  }}
                >
                  {resetting ? "Resetting…" : confirmReset ? `⚠ Tap again to confirm reset (${variant === "ddg" ? "DDG" : "No DDG"})` : `↩ Reset ${variant === "ddg" ? "DDG" : "No DDG"} to base`}
                </button>
              )}

              {confirmDelete && (
                <div style={{ marginTop: 8, fontSize: 11, fontFamily: "var(--mono)", color: "var(--danger)", textAlign: "center" }}>
                  Tap 🗑 again to permanently delete this ration
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AdminView({ pens, rations, events, penSchedules, onSavePen, onSaveSchedule, onSaveRation, onCreateRation, onDeleteRation }) {
  const [tab, setTab] = useState("pens");
  const [creatingNew, setCreatingNew] = useState(false);

  // Known ingredient names across every ration (DDG, No-DDG, and base formulas) —
  // powers the ingredient dropdown so admins pick from what's already in use.
  const knownIngredients = useMemo(() => {
    const set = new Set();
    rations.forEach(r => {
      [r.ingredients, r.ingredients_no_ddg, r.base_ingredients, r.base_ingredients_no_ddg].forEach(list => {
        (list || []).forEach(i => { if (i?.name) set.add(i.name); });
      });
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rations]);
  const doneCount = events.filter(e => e.status === "done").length;
  const pendingCount = events.length - doneCount;
  const doneEvents = [...events].filter(e => e.status === "done")
    .sort((a, b) => new Date(a.confirmed_at) - new Date(b.confirmed_at));

  return (
    <div className="content">
      <div className="nav" style={{ margin: "0 -16px 16px", borderTop: "1px solid var(--border)" }}>
        {[["pens","Pen Setup"],["rations","Rations"],["log","Today's Log"]].map(([t,label]) => (
          <button key={t} className={`nav-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {label}
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

      {tab === "rations" && (
        <div className="admin-section">
          <div className="admin-section-title">Ration formulas</div>

          {creatingNew && (
            <RationCard
              ration={{ name: "", time_of_day: "AM", mode: "lbs", ingredients: [], ingredients_no_ddg: [] }}
              isNew
              knownIngredients={knownIngredients}
              onSave={async payload => { await onCreateRation(payload); setCreatingNew(false); }}
              onCancelNew={() => setCreatingNew(false)}
            />
          )}

          {rations.map(r => (
            <RationCard key={r.id} ration={r} onSave={onSaveRation} onDelete={onDeleteRation} knownIngredients={knownIngredients} />
          ))}

          {!creatingNew && (
            <button className="new-ration-btn" onClick={() => setCreatingNew(true)}>+ New ration</button>
          )}
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
  const [todaySchedule, setTodaySchedule] = useState([]);
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
        const [p, r, e, f, ts] = await Promise.all([
          db.getPens(), db.getRations(), db.getTodayEvents(), db.getFeeders(), db.getTodaySchedule(),
        ]);
        setPens(p || []);
        setRations(r || []);
        setEvents(e || []);
        setFeeders((f || []).map(x => x.name));
        setTodaySchedule(ts || []);
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

  // Realtime: rations — so feeder sees updated numbers immediately when admin changes a ration
  useEffect(() => {
    const unsub = subscribeRealtime("rations", () => {
      db.getRations().then(r => { if (r) setRations(r); });
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

  const saveRation = useCallback(async (rationId, updates) => {
    try {
      await db.updateRation(rationId, updates);
      // Re-fetch all rations to ensure fresh state — avoids stale merge issues
      const fresh = await db.getRations();
      if (fresh) setRations(fresh);
    } catch (err) {
      setError("Failed to save ration. Try again.");
      setTimeout(() => setError(null), 3000);
    }
  }, []);

  const createRation = useCallback(async (payload) => {
    try {
      await db.createRation(payload);
      const fresh = await db.getRations();
      if (fresh) setRations(fresh);
    } catch (err) {
      setError("Failed to create ration. Try again.");
      setTimeout(() => setError(null), 3000);
      throw err;
    }
  }, []);

  const deleteRation = useCallback(async (rationId) => {
    try {
      await db.deleteRation(rationId);
      setRations(prev => prev.filter(r => r.id !== rationId));
    } catch (err) {
      setError("Failed to delete ration. Try again.");
      setTimeout(() => setError(null), 3000);
    }
  }, []);

  const saveSchedule = useCallback(async (penId, rows) => {
    try {
      await db.upsertPenSchedule(rows);
      setPenSchedules(prev => {
        const existing = prev[penId] || [];
        // Key on date + time_of_day, not just date — AM and PM are separate
        // schedule slots for the same day and must not evict each other.
        const newKeys = new Set(rows.map(r => `${r.date}|${r.time_of_day}`));
        const merged = existing.filter(r => !newKeys.has(`${r.date}|${r.time_of_day}`)).concat(rows);
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
            <img src="/logo-white.png" alt="Triple B Farms" className="header-logo" />
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
          <FeederView pens={pens} rations={rations} events={events} feeders={feeders} todaySchedule={todaySchedule} onConfirm={confirmEvent} />
        ) : (
          <AdminView pens={pens} rations={rations} events={events} penSchedules={penSchedules} onSavePen={savePen} onSaveSchedule={saveSchedule} onSaveRation={saveRation} onCreateRation={createRation} onDeleteRation={deleteRation} />
        )}
      </div>
    </>
  );
}
