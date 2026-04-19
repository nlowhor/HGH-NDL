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
    if (c == null) continue;
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

function personCard(row) {
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
  const meta = [row.title, row.notes].filter(Boolean).join(" · ");
  return el("div", { class: backup ? "card card--backup" : "card" }, [
    photo,
    el("div", { class: "card__name" }, row.name),
    meta ? el("div", { class: "card__meta" }, meta) : null,
  ]);
}

function renderColumn(targetKey, rows) {
  const host = document.querySelector(`[data-target="${targetKey}"]`);
  if (!host) return;
  host.innerHTML = "";
  if (!rows.length) {
    host.appendChild(el("div", { class: "empty" }, "No one listed."));
    return;
  }
  for (const r of rows) host.appendChild(personCard(r));
}

// ---------- Rendering ----------

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

  const curGroups = groupByRole(rosterForShift(state.rows, current));
  const nextGroups = groupByRole(rosterForShift(state.rows, next));

  for (const role of config.roles) {
    renderColumn(`current.${role.key}`, curGroups[role.key] || []);
    renderColumn(`next.${role.key}`, nextGroups[role.key] || []);
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
