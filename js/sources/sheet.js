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
//
// lh3.googleusercontent.com/d/ID requires a Google session even for
// "Anyone with the link" files. drive.google.com/thumbnail is the
// unauthenticated thumbnail API that works for link-shared files.
function rewritePhotoUrl(url) {
  if (!url) return "";
  const m1 = url.match(/drive\.google\.com\/file\/d\/([^/?]+)/);
  if (m1) return `https://drive.google.com/thumbnail?id=${m1[1]}&sz=w400`;
  const m2 = url.match(/[?&]id=([^&]+)/);
  if (m2 && url.includes("drive.google.com")) {
    return `https://drive.google.com/thumbnail?id=${m2[1]}&sz=w400`;
  }
  return url;
}

function normalizeStudentName(s) {
  return String(s || "").toLowerCase().trim().split(/\s+/).sort().join(" ");
}

export async function fetchStudentDirectory(url) {
  if (!url) return new Map();
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Student directory fetch failed: HTTP ${res.status}`);
  const rows = parseCsv(await res.text());
  const map = new Map();
  for (const r of rows) {
    const name = (r.name || "").trim();
    const photo = rewritePhotoUrl((r.photo_url || "").trim());
    if (name && photo) map.set(normalizeStudentName(name), photo);
  }
  console.log(`[students] directory: ${map.size} entries`);
  return map;
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
    const rawPhoto = (r.photo_url || r["photo url"] || r.photo || r.headshot || r.image || "").trim();
    const photo = rewritePhotoUrl(rawPhoto);
    if (rawPhoto && !photo) console.warn("[sheet] photo URL dropped by rewriter:", rawPhoto);
    out.push({
      date,
      shift,
      role,
      name,
      title: (r.title || "").trim(),
      notes: (r.notes || "").trim(),
      photo_url: photo,
      source: "sheet",
    });
  }
  const withPhoto = out.filter(r => r.photo_url);
  console.log(`[sheet] ${out.length} rows loaded, ${withPhoto.length} with photo_url`);
  if (withPhoto.length) console.log("[sheet] sample photo URLs:", withPhoto.slice(0, 3).map(r => `${r.name}: ${r.photo_url}`));
  return out;
}
