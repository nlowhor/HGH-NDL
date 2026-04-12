// Adapter for miscellaneous public web pages that publish the schedule.
// Each configured site specifies an `adapter` name; add new functions
// to the ADAPTERS map as the real sites are identified. All adapters
// must return rows in the common roster shape (see sheet.js).
//
// NOTE: browser fetch() is subject to CORS. If a target site does not
// send Access-Control-Allow-Origin, the fetch will fail and this
// adapter will return []. In that case, either (a) route through a
// small proxy/serverless function, or (b) mirror the data into the
// Google Sheet, which is CORS-friendly.

import { normalizeRows } from "./sheet.js";

const ADAPTERS = {
  // Parses any page whose first <table> has a header row compatible
  // with the roster schema. Works for many simple schedule pages.
  async genericTable(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const table = doc.querySelector("table");
    if (!table) return [];
    const rows = Array.from(table.querySelectorAll("tr"))
      .map((tr) => Array.from(tr.querySelectorAll("th,td")).map((c) => c.textContent.trim()));
    if (rows.length < 2) return [];
    const headers = rows[0].map((h) => h.toLowerCase());
    const objs = rows.slice(1).map((cells) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = cells[i] ?? ""; });
      return o;
    });
    return normalizeRows(objs);
  },
};

export async function fetchWebsiteRoster({ url, adapter }) {
  const fn = ADAPTERS[adapter];
  if (!fn) {
    console.warn(`[web] no adapter named "${adapter}" for ${url}`);
    return [];
  }
  const rows = await fn(url);
  return rows.map((r) => ({ ...r, source: `web:${adapter}` }));
}
