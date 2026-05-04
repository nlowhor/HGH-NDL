// Top-level orchestration: load rosters, render current + next shifts
// for the selected time, update clock, and handle user interactions.

import { config } from "./config.js";
import { loadAllRosters, rosterForShift, groupByRole, loadSyncLog } from "./data.js";
import { shiftAt, nextShiftAfter, prevShiftBefore, describeShift, shiftStartDate } from "./shifts.js";

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
  lastLoaded: null,
  syncLog: { attending: null, resident: null, student: null },
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
  // Exclude residents on specialty sub-shifts (e-swing, d-swing, fast track, etc.).
  // Use a blacklist so unknown-but-normal shift names still qualify.
  const subShift = /fast.?track|[a-z][- ]swing\b/i.test(row.notes || "");
  return (
    row.role === "resident" &&
    /\b(r[34]|pgy-?[34])\b/i.test(row.title || "") &&
    !isBackup(row) &&
    !/\bcho\b/i.test(row.notes || "") &&
    !subShift
  );
}

function shiftLabel(notes) {
  if (!notes) return null;
  // Strip time ranges like "7a - 4p", "7a-4p", "7:00-15:00"
  const stripped = notes
    .replace(/\s*\d{1,2}(?::\d{2})?\s*[ap]m?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*[ap]m?/gi, '')
    .replace(/\s+/g, ' ').trim();
  return stripped || null;
}

function personCard(row, seniorResidents = []) {
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
  let levelLine = null;
  if (row.role === "resident" && row.title) {
    const m = row.title.match(/\b(R[1-4]|PGY-?[1-4])\b/i);
    if (m) levelLine = el("div", { class: "card__level" }, m[1].toUpperCase().replace("PGY", "PGY-"));
  }
  let pairLine = null;
  if (row.role === "student" && seniorResidents.length) {
    const names = seniorResidents.map((r) => r.name.split(/\s+/)[0]).join(" or ");
    pairLine = el("div", { class: "card__pair" }, `Paired with ${names}`);
  }
  const label = shiftLabel(row.notes);
  const info = el("div", { class: "card__info" }, [
    el("div", { class: "card__firstname" }, firstName),
    lastName ? el("div", { class: "card__lastname" }, lastName) : null,
    levelLine,
    label ? el("div", { class: "card__shift" }, label) : null,
    pairLine,
  ]);
  return el("div", { class: "card" }, [photo, info]);
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

// ---------- Shift relative label ----------

function shiftRelativeLabel(viewed, nowShift) {
  if (viewed.date === nowShift.date && viewed.name === nowShift.name) return { text: "Current Shift", current: true };
  const next = nextShiftAfter(nowShift);
  if (viewed.date === next.date && viewed.name === next.name) return { text: "Next Shift", current: false };
  const prev = prevShiftBefore(nowShift);
  if (viewed.date === prev.date && viewed.name === prev.name) return { text: "Previous Shift", current: false };
  const viewStart = shiftStartDate(viewed.date, config.shifts.find(s => s.name === viewed.name));
  const nowStart  = shiftStartDate(nowShift.date, config.shifts.find(s => s.name === nowShift.name));
  return { text: viewStart > nowStart ? "Future Shift" : "Past Shift", current: false };
}

// ---------- Off-site filter (secondary safety net) ----------

const OFFSITE_KEYWORDS = ['san leandro', 'slh', 'alameda', 'cho'];

function filterOffsite(rows) {
  return rows.filter(r => {
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
  document.getElementById("now-btn").classList.toggle("is-live", live);
}

function render() {
  renderClock();
  const when = currentWhen();
  const viewed = shiftAt(when);
  const nowShift = shiftAt(new Date());

  const rel = shiftRelativeLabel(viewed, nowShift);
  const labelEl = document.getElementById("shift-relative");
  labelEl.textContent = rel.text;
  labelEl.className = "shift-section__label" + (rel.current ? " is-current" : "");
  document.getElementById("shift-meta").textContent = describeShift(viewed);

  const groups = groupByRole(filterOffsite(rosterForShift(state.rows, viewed)));
  const seniors = (groups["resident"] || []).filter(isSeniorResident);

  for (const role of config.roles) {
    const sr = role.key === "student" ? seniors : [];
    renderColumn(`shift.${role.key}`, groups[role.key] || [], sr);
  }

  renderStatus();
}

function fmtSyncTime(d) {
  if (!d) return "never synced";
  return d.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function renderStatus() {
  const log = state.syncLog;
  const lines = [
    `Attendings last synced: ${fmtSyncTime(log.attending)}`,
    `Residents last synced: ${fmtSyncTime(log.resident)}`,
    `Students last synced: ${fmtSyncTime(log.student)}`,
  ];
  document.getElementById("status").textContent = lines.join("\n");
}

// ---------- Data loading ----------

async function reload() {
  try {
    const [{ rows, diagnostics }, syncLog] = await Promise.all([
      loadAllRosters({ demoMode: state.demoMode }),
      loadSyncLog(),
    ]);
    state.rows = rows;
    state.diagnostics = diagnostics;
    state.syncLog = syncLog;
    state.lastLoaded = new Date();
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

function navigateShift(direction) {
  const current = shiftAt(currentWhen());
  const target = direction === "prev" ? prevShiftBefore(current) : nextShiftAfter(current);
  const shiftDef = config.shifts.find((s) => s.name === target.name);
  state.selectedWhen = shiftStartDate(target.date, shiftDef);
  document.getElementById("when").value = toLocalInputValue(state.selectedWhen);
  render();
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

  refreshBtn.addEventListener("click", () => {
    reload();
    document.querySelector('.settings-panel')?.removeAttribute('open');
  });

  // Close settings panel when clicking outside of it.
  document.addEventListener("click", (e) => {
    const panel = document.querySelector('.settings-panel');
    if (panel && panel.open && !panel.contains(e.target)) {
      panel.removeAttribute('open');
    }
  });

  document.getElementById("prev-shift-btn").addEventListener("click", () => navigateShift("prev"));
  document.getElementById("next-shift-btn").addEventListener("click", () => navigateShift("next"));

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
