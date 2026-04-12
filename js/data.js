// Aggregates roster rows across all configured sources. Later sources
// do NOT overwrite earlier ones; duplicates (same date+shift+role+name)
// are deduplicated so a staffer appearing in multiple feeds shows once.

import { config } from "./config.js";
import { fetchSheetRoster } from "./sources/sheet.js";
import { fetchDocRoster } from "./sources/doc.js";
import { fetchWebsiteRoster } from "./sources/web.js";

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
export async function loadAllRosters() {
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

  if (src.sheetCsvUrl) await tryOne("Google Sheet", () => fetchSheetRoster(src.sheetCsvUrl));
  if (src.docPubUrl)   await tryOne("Google Doc",   () => fetchDocRoster(src.docPubUrl));
  for (const site of src.websites || []) {
    await tryOne(`Website: ${site.url}`, () => fetchWebsiteRoster(site));
  }

  const totalLive = buckets.reduce((n, b) => n + b.length, 0);
  if (totalLive === 0 && src.sampleCsvUrl) {
    await tryOne("Sample data", () => fetchSheetRoster(src.sampleCsvUrl));
  }

  const rows = dedupe(buckets.flat());
  return { rows, diagnostics };
}

// Filter the full roster down to a specific (date, shift) instance.
export function rosterForShift(rows, instance) {
  return rows.filter((r) => r.date === instance.date && r.shift === instance.name);
}

// Group rows by role, preserving roles order from config.
export function groupByRole(rows) {
  const byRole = {};
  for (const role of config.roles) byRole[role.key] = [];
  for (const r of rows) {
    if (byRole[r.role]) byRole[r.role].push(r);
  }
  // Sort alphabetically by name within each role.
  for (const k of Object.keys(byRole)) {
    byRole[k].sort((a, b) => a.name.localeCompare(b.name));
  }
  return byRole;
}
