// Top-level orchestration: load rosters, render current + next shifts
// for the selected time, update clock, and handle user interactions.

import { config } from "./config.js";
import { loadAllRosters, rosterForShift, groupByRole } from "./data.js";
import { shiftAt, nextShiftAfter, describeShift } from "./shifts.js";

const DEMO_STORAGE_KEY = "hghNdl.demoMode";

function hasLiveSource() {
  const s = config.sources;
  return !!s.sheetCsvUrl || !!s.docPubUrl || (s.websites && s.websites.length > 0);
}

function initialDemoMode() {
  const stored = localStorage.getItem(DEMO_STORAGE_KEY);
  if (stored === "true") return true;
  if (stored === "false") return false;
  // Default: demo ON until a live source is configured.
  return !hasLiveSource();
}

const state = {
  rows: [],
  diagnostics: [],
  // null => track real time; Date => user picked a time
  selectedWhen: null,
  demoMode: initialDemoMode(),
  tickTimer: null,
  reloadTimer: null,
};

// ---------- DOM helpers ----------

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "style") Object.assign(n.style, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === "") continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((s) => s[0].toUpperCase()).join("");
}

function isBackup(row) {
  return /backup/i.test(row.notes);
}

function isSeniorResident(row) {
  // Only pair students with residents on a standard shift. The notes field
  // holds the raw Medrez shift name; whitelist plain names and reject anything
  // with qualifiers like "E-Swing", "D-Swing", "Fast Track", etc.
  const standardShift = /^(day|swing|night|evening|noc(ht?)?|am|pm)?$/i
    .test((row.notes || "").trim());
  return (
    row.role === "resident" &&
    /\b(r[34]|pgy-?[34])\b/i.test(row.title || "") &&
    !isBackup(row) &&
    !/\bcho\b/i.test(row.notes || "") &&
    standardShift
  );
}

function personCard(row, seniorResidents = []) {
  const backup = isBackup(row);
  const photo = el("div", { class: "card__photo" });
  if (row.photo_url) {
    const img = el("img", { src: row.photo_url, alt: row.name, loading: "lazy" });
    img.addEventListener("error", () => {
      console.warn("[headshot] failed to load:", row.photo_url, "for", row.name);
      photo.innerHTML = "";
      photo.textContent = initials(row.name);
    });
    photo.appendChild(img);
  } else {
    photo.textContent = initials(row.name);
  }
  const [firstName, ...rest] = row.name.trim().split(/\s+/);
  const lastName = rest.join(" ");
  const meta = [row.title, row.notes].filter(Boolean).join(" · ");
  let pairLine = null;
  if (row.role === "student" && seniorResidents.length) {
    const names = seniorResidents.map((r) => r.name.split(/\s+/)[0]).join(" or ");
    pairLine = el("div", { class: "card__pair" }, `Paired with ${names}`);
  }
  return el("div", { class: backup ? "card card--backup" : "card" }, [
    photo,
    el("div", { class: "card__firstname" }, firstName),
    lastName ? el("div", { class: "card__lastname" }, lastName) : null,
    meta ? el("div", { class: "card__meta" }, meta) : null,
    pairLine,
  ]);
}

function renderColumn(targetKey, rows, seniorResidents = []) {
  const host = document.querySelector(`[data-target="${targetKey}"]`);
  if (!host) return;
  host.innerHTML = "";
  if (!rows.length) {
    host.appendChild(el("div", { class: "empty" }, "No one listed."));
    return;
  }
  for (const r of rows) host.appendChild(personCard(r, seniorResidents));
}

// ---------- Tabs ----------

function switchTab(tabName) {
  let panelId = null;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('tab-btn--active', active);
    btn.setAttribute('aria-selected', String(active));
    if (active) panelId = btn.getAttribute('aria-controls');
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('tab-panel--active', panel.id === panelId);
  });
}

// ---------- Off-site filter ----------

const OFFSITE_KEYWORDS = ['san leandro', 'slh', 'alameda', 'cho'];

function filterOffsite(rows) {
  return rows.filter(r => {
    if (r.role !== 'attending') return true;
    const text = Object.values(r).filter(v => typeof v === 'string').join(' ').toLowerCase();
    return !OFFSITE_KEYWORDS.some(kw => text.includes(kw));
  });
}

function currentWhen() {
  return state.selectedWhen ? new Date(state.selectedWhen) : new Date();
}

function renderClock() {
  const when = currentWhen();
  const live = state.selectedWhen == null;
  const fmt = when.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  document.getElementById("clock").textContent =
    live ? `Live · ${fmt}` : `Viewing · ${fmt}`;
}

function render() {
  renderClock();
  const when = currentWhen();
  const current = shiftAt(when);
  const next = nextShiftAfter(current);

  document.getElementById("current-meta").textContent = describeShift(current);
  document.getElementById("next-meta").textContent = describeShift(next);

  const curGroups = groupByRole(filterOffsite(rosterForShift(state.rows, current)));
  const nextGroups = groupByRole(filterOffsite(rosterForShift(state.rows, next)));

  const curSeniors = (curGroups["resident"] || []).filter(isSeniorResident);
  const nextSeniors = (nextGroups["resident"] || []).filter(isSeniorResident);

  for (const role of config.roles) {
    const cs = role.key === "student" ? curSeniors : [];
    const ns = role.key === "student" ? nextSeniors : [];
    renderColumn(`current.${role.key}`, curGroups[role.key] || [], cs);
    renderColumn(`next.${role.key}`, nextGroups[role.key] || [], ns);
  }

  renderStatus();
}

function renderStatus() {
  const parts = state.diagnostics.map((d) =>
    d.ok ? `${d.name}: ${d.count} rows` : `${d.name}: error — ${d.error}`
  );
  const total = state.rows.length;
  document.getElementById("status").textContent =
    `Sources — ${parts.join(" | ") || "(none configured)"}\nTotal roster entries loaded: ${total}`;
}

// ---------- Data loading ----------

async function reload() {
  try {
    const { rows, diagnostics } = await loadAllRosters({ demoMode: state.demoMode });
    state.rows = rows;
    state.diagnostics = diagnostics;

} catch (err) {
    state.diagnostics = [{ name: "loader", ok: false, error: String(err) }];
  }
  render();
}

// ---------- Wiring ----------

function toLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function wire() {
  const input = document.getElementById("when");
  const nowBtn = document.getElementById("now-btn");
  const refreshBtn = document.getElementById("refresh-btn");
  const demoToggle = document.getElementById("demo-toggle");

  input.value = toLocalInputValue(new Date());
  input.addEventListener("change", () => {
    if (!input.value) { state.selectedWhen = null; }
    else { state.selectedWhen = new Date(input.value); }
    render();
  });

  nowBtn.addEventListener("click", () => {
    state.selectedWhen = null;
    input.value = toLocalInputValue(new Date());
    render();
  });

  refreshBtn.addEventListener("click", () => { reload(); });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  demoToggle.checked = state.demoMode;
  demoToggle.addEventListener("change", () => {
    state.demoMode = demoToggle.checked;
    localStorage.setItem(DEMO_STORAGE_KEY, String(state.demoMode));
    reload();
  });

  // Tick: update clock + recompute shift on schedule while in live mode.
  state.tickTimer = setInterval(() => {
    if (state.selectedWhen == null) render();
    else renderClock();
  }, config.tickIntervalMs);

  // Periodic data reload.
  state.reloadTimer = setInterval(reload, config.reloadIntervalMs);
}

wire();
reload();
