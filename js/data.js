// Aggregates roster rows across all configured sources. Later sources
// do NOT overwrite earlier ones; duplicates (same date+shift+role+name)
// are deduplicated so a staffer appearing in multiple feeds shows once.

// Rows mentioning these off-site locations are never shown (any role).
const OFFSITE_KEYWORDS = ["san leandro", "slh", "alameda", "cho"];
function isOffsite(r) {
  const text = [r.name, r.title, r.notes, r.shift, r.date]
    .join(" ").toLowerCase();
  return OFFSITE_KEYWORDS.some((kw) => text.includes(kw));
}

function isBackupRow(r) {
  return /backup/i.test(r.notes || "");
}

// Names (case-insensitive word match) that should never appear in the roster.
const EXCLUDED_NAME_WORDS = ["nelson"];
function isExcludedName(r) {
  const nameLower = r.name.toLowerCase();
  return EXCLUDED_NAME_WORDS.some((word) =>
    nameLower.split(/\s+/).includes(word)
  );
}

import { config } from "./config.js";
import { fetchSheetRoster, fetchStudentDirectory } from "./sources/sheet.js";
import { fetchDocRoster } from "./sources/doc.js";
import { fetchWebsiteRoster } from "./sources/web.js";
import { parseCsv } from "./parsers/csv.js";

function dedupe(rows) {
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.date}|${r.shift}|${r.role}|${r.name.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, r);
    else {
      // Merge: fill missing photo/title/notes from later rows.
      const prev = seen.get(key);
      if (!prev.photo_url && r.photo_url) prev.photo_url = r.photo_url;
      if (!prev.title && r.title) prev.title = r.title;
      if (!prev.notes && r.notes) prev.notes = r.notes;
    }
  }
  return Array.from(seen.values());
}

// Returns { rows, diagnostics[] }. Diagnostics describe per-source
// success/failure so the UI can show a friendly status line.
//
// Options:
//   demoMode — if true, load ONLY the sample CSV (ignores live sources).
//              If false, load configured live sources; fall back to
//              sample only when no live source is configured AND sample
//              is available.
export async function loadAllRosters({ demoMode = false } = {}) {
  const diagnostics = [];
  const buckets = [];
  const src = config.sources;

  async function tryOne(name, fn) {
    try {
      const rows = await fn();
      diagnostics.push({ name, ok: true, count: rows.length });
      buckets.push(rows);
    } catch (err) {
      diagnostics.push({ name, ok: false, error: String(err.message || err) });
    }
  }

  if (demoMode) {
    if (src.sampleCsvUrl) {
      await tryOne("Demo data (sample CSV)", () => fetchSheetRoster(src.sampleCsvUrl));
    } else {
      diagnostics.push({ name: "Demo data", ok: false, error: "no sampleCsvUrl configured" });
    }
    return { rows: dedupe(buckets.flat()), diagnostics };
  }

  const hasLiveSource =
    !!src.sheetCsvUrl || !!src.docPubUrl || (src.websites && src.websites.length > 0);

  if (src.sheetCsvUrl) await tryOne("Google Sheet", () => fetchSheetRoster(src.sheetCsvUrl));
  if (src.docPubUrl)   await tryOne("Google Doc",   () => fetchDocRoster(src.docPubUrl));
  for (const site of src.websites || []) {
    await tryOne(`Website: ${site.url}`, () => fetchWebsiteRoster(site));
  }

  // Only fall back to sample when there are NO live sources configured
  // at all. If a live source is configured but returned zero rows,
  // show that honestly rather than masking it with demo data.
  if (!hasLiveSource && src.sampleCsvUrl) {
    await tryOne("Sample data (no live sources configured)", () => fetchSheetRoster(src.sampleCsvUrl));
  }

  const rows = dedupe(buckets.flat())
    .filter((r) => !isOffsite(r))
    .filter((r) => !isBackupRow(r))
    .filter((r) => !isExcludedName(r));

  // Enrich student rows with photos from the student directory tab.
  if (src.studentsCsvUrl) {
    try {
      const studentDir = await fetchStudentDirectory(src.studentsCsvUrl);
      if (studentDir.size) {
        for (const r of rows) {
          if (r.role === "student" && !r.photo_url) {
            const words = r.name.toLowerCase().trim().split(/\s+/);
            // Try sorted full name first, then last word only (schedule may use last name only).
            const fullKey = [...words].sort().join(" ");
            const lastKey = words[words.length - 1];
            r.photo_url = studentDir.get(fullKey) || studentDir.get(lastKey) || "";
          }
        }
      }
    } catch (err) {
      console.warn("[students] directory load failed:", err.message);
    }
  }

  return { rows, diagnostics };
}

// Filter the full roster down to a specific (date, shift) instance.
export function rosterForShift(rows, instance) {
  return rows.filter((r) => r.date === instance.date && r.shift === instance.name);
}

// Non-primary / specialty shift patterns — sorted after main shift doctors.
const SUB_SHIFT_RE = /fast.?track|[a-z][- ]?swing|pit\b/i;

function normalizedShiftName(notes) {
  if (!notes) return "";
  // Strip time ranges so "Day A7a - 4p" → "Day A"
  return notes
    .replace(/\s*\d{1,2}(?::\d{2})?\s*[ap]m?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*[ap]m?/gi, "")
    .replace(/\s+/g, " ").trim();
}

function residentYear(r) {
  // Returns 4/3/2/1 for R4–R1; 0 for unrecognised (sorts last).
  const m = (r.title || "").match(/\b(?:R|PGY-?)([1-4])\b/i);
  return m ? parseInt(m[1], 10) : 0;
}

function attendingSortKey(r) {
  const name = normalizedShiftName(r.notes);
  return [SUB_SHIFT_RE.test(name) ? 1 : 0, name.toLowerCase()];
}

function residentSortKey(r) {
  const name = normalizedShiftName(r.notes);
  // Year descending (4→1), then shift name ascending.
  return [SUB_SHIFT_RE.test(name) ? 1 : 0, 5 - residentYear(r), name.toLowerCase()];
}

function cmpArrays(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? "", bi = b[i] ?? "";
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

// Group rows by role, preserving roles order from config.
export function groupByRole(rows) {
  const byRole = {};
  for (const role of config.roles) byRole[role.key] = [];
  for (const r of rows) {
    if (byRole[r.role]) byRole[r.role].push(r);
  }
  byRole["attending"]?.sort((a, b) => cmpArrays(attendingSortKey(a), attendingSortKey(b)));
  byRole["resident"]?.sort((a, b) => cmpArrays(residentSortKey(a), residentSortKey(b)));
  byRole["student"]?.sort((a, b) => (normalizedShiftName(a.notes) < normalizedShiftName(b.notes) ? -1 : 1));
  return byRole;
}

// Fetch per-role sync timestamps from the sync_log tab.
// Returns { attending: Date|null, resident: Date|null, student: Date|null }
export async function loadSyncLog() {
  const result = { attending: null, resident: null, student: null };
  const url = config.sources.syncLogCsvUrl;
  if (!url) return result;
  try {
    const res = await fetch(url);
    if (!res.ok) return result;
    const rows = parseCsv(await res.text());
    for (const row of rows) {
      const role = (row.role || "").trim();
      const ts   = (row.updated_at || "").trim();
      if (result.hasOwnProperty(role) && ts) result[role] = new Date(ts);
    }
  } catch { /* sync log is optional — silently ignore */ }
  return result;
}
