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

function isJuniorResident(row) {
  return (
    row.role === "resident" &&
    /\b(r[12]|pgy-?[12])\b/i.test(row.title || "") &&
    !isBackup(row) &&
    !/\bcho\b/i.test(row.notes || "")
  );
}

function shiftLabel(notes) {
  if (!notes) return null;
  // Strip time ranges and pairing markers (-res/-att) — markers are only
  // for pairing logic and should not be shown on the card.
  const stripped = notes
    .replace(/\s*\d{1,2}(?::\d{2})?\s*[ap]m?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*[ap]m?/gi, '')
    .replace(/\s+-(?:res|att)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  return stripped || null;
}

function extractTimeRange(notes) {
  if (!notes) return null;
  const m = notes.match(/\d{1,2}(?::\d{2})?\s*[ap]m?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*[ap]m?/i);
  return m ? m[0] : null;
}

function shiftDisplayName(shiftKey) {
  const def = config.shifts.find((s) => s.name === shiftKey);
  return def ? def.label : shiftKey.charAt(0).toUpperCase() + shiftKey.slice(1);
}

function isFastTrack(row) {
  return /fast.?track/i.test(row.notes || "");
}

// Returns Map<studentRow, partnerRow[]>.
// Fast-track students pair with fast-track R3/R4s by position.
// Main-shift students follow four rules:
//   1 student + 1 senior resident  → pairs to that senior
//   1 student + 2 seniors          → pairs to either (show both names)
//   2 students + 2 seniors         → student[0] → senior[0], student[1] → senior[1]
//   2 students + 1 senior + ≥1 R2  → -res student → senior, -att student → first main attending
function computeStudentPairings(students, residents, attendings) {
  const pairings = new Map();

  // Fast-track sub-shift: pair by position. Any resident on fast track qualifies.
  const ftStudents   = students.filter(isFastTrack);
  const ftResidents  = residents.filter((r) => !isBackup(r) && isFastTrack(r));
  ftStudents.forEach((st, i) => { if (ftResidents[i]) pairings.set(st, [ftResidents[i]]); });

  // Main-shift: apply the four rules.
  const mainStudents  = students.filter((s) => !isFastTrack(s));
  const mainSeniors   = residents.filter(isSeniorResident);
  const juniors       = residents.filter(isJuniorResident);
  const mainAttending = attendings.filter(
    (r) => !isBackup(r) && !/fast.?track|[a-z][- ]swing\b/i.test(r.notes || "")
  );

  const n = mainStudents.length;
  const s = mainSeniors.length;

  if (n === 1 && s === 1) {
    pairings.set(mainStudents[0], [mainSeniors[0]]);
  } else if (n === 1 && s >= 2) {
    pairings.set(mainStudents[0], mainSeniors.slice(0, 2));
  } else if (n === 2 && s >= 2) {
    pairings.set(mainStudents[0], [mainSeniors[0]]);
    pairings.set(mainStudents[1], [mainSeniors[1]]);
  } else if (n === 2 && s === 1 && juniors.length >= 1) {
    const resStudent = mainStudents.find((s) => /-res\b/i.test(s.notes || "")) || mainStudents[0];
    const attStudent = mainStudents.find((s) => /-att\b/i.test(s.notes || "")) || mainStudents[1];
    pairings.set(resStudent, [mainSeniors[0]]);
    if (mainAttending.length) pairings.set(attStudent, [mainAttending[0]]);
  }

  return pairings;
}

// Returns [photoEl, infoEl] — the two halves of a card, without the card wrapper.
// Used directly by personCard and by pairedCard.
function personCardContent(row, partners = []) {
  const displayName = (row.matched_name || row.name).trim();
  const photo = el("div", { class: "card__photo" });
  if (row.photo_url) {
    const img = el("img", { src: row.photo_url, alt: displayName, loading: "lazy" });
    img.addEventListener("error", () => {
      console.warn("[headshot] failed to load:", row.photo_url, "for", displayName);
      photo.innerHTML = "";
      photo.textContent = initials(displayName);
    });
    photo.appendChild(img);
  } else {
    photo.textContent = initials(displayName);
  }

  const [firstName, ...rest] = displayName.split(/\s+/);
  const lastName = rest.join(" ");

  let levelLine = null;
  if (row.role === "resident" && row.title) {
    const m = row.title.match(/\b(R[1-4]|PGY-?[1-4])\b/i);
    if (m) levelLine = el("div", { class: "card__level" }, m[1].toUpperCase().replace("PGY", "PGY-"));
  } else if (row.role === "student") {
    const roleLabel = (row.title && /\bms[1-4]\b/i.test(row.title))
      ? row.title.trim().toUpperCase()
      : "MS";
    levelLine = el("div", { class: "card__level" }, roleLabel);
  }

  let pairLine = null;
  if (partners.length) {
    const names = partners
      .map((p) => (p.matched_name || p.name).trim().split(/\s+/)[0])
      .join(" or ");
    pairLine = el("div", { class: "card__pair" }, `Paired with ${names}`);
  }

  // For students: "{label} · {time}" when notes contain a time range, or
  // just the config shift label when notes are absent / time-range-only.
  let labelText = shiftLabel(row.notes);
  if (row.role === "student") {
    const time = extractTimeRange(row.notes);
    const base = labelText || shiftDisplayName(row.shift);
    labelText = time ? `${base} · ${time}` : base;
  }

  const info = el("div", { class: "card__info" }, [
    el("div", { class: "card__firstname" }, firstName),
    lastName ? el("div", { class: "card__lastname" }, lastName) : null,
    levelLine,
    labelText ? el("div", { class: "card__shift" }, labelText) : null,
    pairLine,
  ]);

  return [photo, info];
}

// Colors cycled through for each student↔resident pair.
const PAIR_COLORS = ['#4ea3ff', '#7ee6c6', '#ffb057', '#c084fc', '#f87171'];

function personCard(row, partners = [], pairColor = null) {
  const [photo, info] = personCardContent(row, partners);
  const card = el("div", { class: pairColor ? "card is-paired" : "card" }, [photo, info]);
  if (pairColor) card.style.setProperty("--pair-color", pairColor);
  return card;
}

// pairInfoMap: Map<row, { partners: row[], color: string|null }>
function renderColumn(targetKey, rows, pairInfoMap = new Map()) {
  const host = document.querySelector(`[data-target="${targetKey}"]`);
  if (!host) return;
  host.innerHTML = "";
  if (!rows.length) {
    host.appendChild(el("div", { class: "empty" }, "No one listed."));
    return;
  }
  for (const r of rows) {
    const info = pairInfoMap.get(r) || {};
    host.appendChild(personCard(r, info.partners || [], info.color || null));
  }
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

// Off-site and backup filtering is applied in data.js at load time.
// This pass is a secondary safety net covering any rows that slipped through
// (e.g. loaded from a source that bypasses loadAllRosters filtering).
const OFFSITE_KEYWORDS = ['san leandro', 'slh', 'alameda', 'cho'];

function filterOffsite(rows) {
  return rows.filter(r => {
    const text = [r.name, r.title, r.notes].filter(Boolean).join(' ').toLowerCase();
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
  const pairings = computeStudentPairings(
    groups["student"]   || [],
    groups["resident"]  || [],
    groups["attending"] || [],
  );

  // Assign a shared color to each pairing group (student + all their partners).
  const pairInfoMap = new Map();
  let colorIdx = 0;
  for (const [student, partners] of pairings) {
    if (!partners.length) continue;
    const color = PAIR_COLORS[colorIdx % PAIR_COLORS.length];
    colorIdx++;
    pairInfoMap.set(student, { partners, color });
    for (const partner of partners) {
      if (!pairInfoMap.has(partner)) pairInfoMap.set(partner, { partners: [], color });
    }
  }

  renderColumn("shift.student",   groups["student"]   || [], pairInfoMap);
  renderColumn("shift.resident",  groups["resident"]  || [], pairInfoMap);
  renderColumn("shift.attending", groups["attending"] || [], pairInfoMap);

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
      loadSyncLog().catch(() => state.syncLog),
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
