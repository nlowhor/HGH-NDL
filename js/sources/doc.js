// Google Doc "Publish to web" adapter.
// Strategy: fetch the /pub HTML and look for the first <table>. If the
// table has a header row matching the roster schema (date, shift,
// role, name, photo_url), rows are parsed; otherwise the doc is
// skipped with a warning. For non-tabular Docs, this adapter will
// need customization once we see the actual document's format.

import { normalizeRows } from "./sheet.js";

export async function fetchDocRoster(url) {
  if (!url) return [];
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Doc fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) {
    console.warn("[doc] no <table> found in published doc; skipping");
    return [];
  }

  const rows = Array.from(table.querySelectorAll("tr"))
    .map((tr) => Array.from(tr.querySelectorAll("th,td")).map((c) => c.textContent.trim()));
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.toLowerCase());
  const objs = rows.slice(1).map((cells) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = cells[i] ?? ""; });
    return o;
  });

  const normalized = normalizeRows(objs);
  return normalized.map((r) => ({ ...r, source: "doc" }));
}
