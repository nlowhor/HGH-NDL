// Google Sheet "Publish to web" CSV adapter.
// Fetches the CSV and normalizes rows to the roster schema.

import { parseCsv } from "../parsers/csv.js";

const ROLE_ALIASES = {
  attending: "attending", att: "attending", md: "attending", doc: "attending",
  resident: "resident", res: "resident", pgy: "resident",
  student: "student", ms: "student", "med student": "student", "medical student": "student",
};
const SHIFT_ALIASES = {
  day: "day", d: "day", am: "day", morning: "day",
  evening: "evening", eve: "evening", e: "evening", pm: "evening", swing: "evening",
  night: "night", n: "night", overnight: "night", noc: "night",
};

function normRole(v) {
  const k = String(v || "").trim().toLowerCase();
  return ROLE_ALIASES[k] || (k in { attending:1, resident:1, student:1 } ? k : null);
}
function normShift(v) {
  const k = String(v || "").trim().toLowerCase();
  return SHIFT_ALIASES[k] || (["day","evening","night"].includes(k) ? k : null);
}

// Some photo links (e.g. Drive "open?id=..." or "file/d/.../view") need
// rewriting to a directly-embeddable URL. Pass through anything else.
function rewritePhotoUrl(url) {
  if (!url) return "";
  const m1 = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (m1) return `https://drive.google.com/uc?export=view&id=${m1[1]}`;
  const m2 = url.match(/[?&]id=([^&]+)/);
  if (m2 && url.includes("drive.google.com")) {
    return `https://drive.google.com/uc?export=view&id=${m2[1]}`;
  }
  return url;
}

export async function fetchSheetRoster(url) {
  if (!url) return [];
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Sheet fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  return normalizeRows(parseCsv(text));
}

export function normalizeRows(rows) {
  const out = [];
  for (const r of rows) {
    const role = normRole(r.role);
    const shift = normShift(r.shift);
    const name = (r.name || "").trim();
    const date = (r.date || "").trim();
    if (!role || !shift || !name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({
      date,
      shift,
      role,
      name,
      title: (r.title || "").trim(),
      notes: (r.notes || "").trim(),
      photo_url: rewritePhotoUrl((r.photo_url || r.photo || "").trim()),
      source: "sheet",
    });
  }
  return out;
}
