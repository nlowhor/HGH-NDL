// Aggregates roster rows across all configured sources. Later sources
// do NOT overwrite earlier ones; duplicates (same date+shift+role+name)
// are deduplicated so a staffer appearing in multiple feeds shows once.

import { config } from "./config.js";
import { parseCsv } from "./parsers/csv.js";
import { fetchSheetRoster } from "./sources/sheet.js";
import { fetchDocRoster } from "./sources/doc.js";
import { fetchWebsiteRoster } from "./sources/web.js";

// Sort words so "James Nelson" and "Nelson James" both normalise the same way.
function normalizeName(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[,_\-]+/g, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ');
}

// Fetch a person-data tab published as CSV and return a Map:
//   normalizeName(name) → { name, photo_url, title, notes }
// Expected CSV columns: name, photo_url, title, notes (extras are ignored).
async function fetchPersonSheet(url) {
  if (!url) return new Map();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return new Map();
    const rows = parseCsv(await res.text());
    const map = new Map();
    for (const r of rows) {
      const name = (r.name || '').trim();
      if (!name) continue;
      map.set(normalizeName(name), {
        name,
        photo_url: (r.photo_url || '').trim(),
        title:     (r.title     || '').trim(),
        notes:     (r.notes     || '').trim(),
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

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

  const rows = dedupe(buckets.flat());

  // Merge per-person data (photo_url, title) from dedicated role tabs when URLs
  // are configured. Person-tab values are authoritative: they override whatever
  // the roster row already has, so editing a person in one place updates all shifts.
  const personUrls = src.personSheetUrls || {};
  if (Object.values(personUrls).some(Boolean)) {
    const [studentMap, residentMap, attendingMap] = await Promise.all([
      fetchPersonSheet(personUrls.student),
      fetchPersonSheet(personUrls.resident),
      fetchPersonSheet(personUrls.attending),
    ]);
    const maps = { student: studentMap, resident: residentMap, attending: attendingMap };
    for (const r of rows) {
      const person = maps[r.role]?.get(normalizeName(r.name));
      if (!person) continue;
      if (person.photo_url) r.photo_url = person.photo_url;
      if (person.title)     r.title     = person.title;
    }
  }

  return { rows, diagnostics };
}

// Filter the full roster down to a specific (date, shift) instance.
export function rosterForShift(rows, instance) {
  return rows.filter((r) => r.date === instance.date && r.shift === instance.name);
}

// Returns last-synced timestamps per role by reading the sync_log CSV if
// configured, or falls back to nulls (displayed as "never synced").
export async function loadSyncLog() {
  const url = config.sources?.syncLogCsvUrl;
  if (!url) return { attending: null, resident: null, student: null };
  try {
    const res = await fetch(url);
    if (!res.ok) return { attending: null, resident: null, student: null };
    const text = await res.text();
    const log = { attending: null, resident: null, student: null };
    for (const line of text.split('\n').slice(1)) {
      const [role, ts] = line.split(',').map(s => s.trim());
      if (role && ts && log[role] !== undefined) log[role] = new Date(ts);
    }
    return log;
  } catch {
    return { attending: null, resident: null, student: null };
  }
}

// Group rows by role, preserving roles order from config.
export function groupByRole(rows) {
  const byRole = {};
  for (const role of config.roles) byRole[role.key] = [];
  for (const r of rows) {
    if (byRole[r.role]) byRole[r.role].push(r);
  }
  // Sort: backup entries last, then alphabetically by name.
  const isBackup = (r) => /backup/i.test(r.notes);
  for (const k of Object.keys(byRole)) {
    byRole[k].sort((a, b) => {
      const ba = isBackup(a), bb = isBackup(b);
      if (ba !== bb) return ba ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }
  return byRole;
}
