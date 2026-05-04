// Shift logic. Shifts are fixed blocks (see config). Given any Date,
// determine which shift block contains it and the following block.
// A "shift instance" is keyed by (calendar date of its start, name).

import { config } from "./config.js";

const pad = (n) => String(n).padStart(2, "0");

export function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

// Build the shift start Date for a given calendar date + shift def.
function shiftStartDate(dateStr, shift) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, shift.start, 0, 0, 0);
}

// Shift end Date. If it wraps midnight, end belongs to the next day.
function shiftEndDate(dateStr, shift) {
  const wraps = shift.end <= shift.start;
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(y, m - 1, d + (wraps ? 1 : 0), shift.end, 0, 0, 0);
  return base;
}

// Returns { name, label, date } — the shift instance active at `when`.
export function shiftAt(when) {
  const shifts = config.shifts;
  const hour = when.getHours() + when.getMinutes() / 60;

  for (const s of shifts) {
    const wraps = s.end <= s.start;
    if (!wraps) {
      if (hour >= s.start && hour < s.end) {
        return { name: s.name, label: s.label, date: isoDate(when) };
      }
    } else {
      // Wrapping shift: matches [start..24) ∪ [0..end)
      if (hour >= s.start) {
        // same calendar day (e.g. 23:30 Monday -> night shift dated Monday)
        return { name: s.name, label: s.label, date: isoDate(when) };
      }
      if (hour < s.end) {
        // early-morning hours belong to the previous day's night shift
        return { name: s.name, label: s.label, date: isoDate(addDays(when, -1)) };
      }
    }
  }
  // Should not happen if shifts cover 24h. Fallback: first shift today.
  return { name: shifts[0].name, label: shifts[0].label, date: isoDate(when) };
}

// Returns the shift instance that follows the given one.
export function nextShiftAfter(instance) {
  const shifts = config.shifts;
  const idx = shifts.findIndex((s) => s.name === instance.name);
  if (idx === -1) return instance;
  const nextIdx = (idx + 1) % shifts.length;
  const nextDef = shifts[nextIdx];

  // If the current shift's end wraps past midnight, the next shift
  // is on the following calendar day. Otherwise same day.
  // Parse as local midnight (not UTC) to avoid date-offset bugs.
  const current = shifts[idx];
  const wraps = current.end <= current.start;
  const [y, m, d] = instance.date.split("-").map(Number);
  const localDate = new Date(y, m - 1, d); // local midnight
  const nextDate = wraps ? isoDate(addDays(localDate, 1)) : instance.date;
  return { name: nextDef.name, label: nextDef.label, date: nextDate };
}

// Human-readable "Mon Apr 12 · Day (07:00–15:00)"
export function describeShift(instance) {
  const def = config.shifts.find((s) => s.name === instance.name);
  if (!def) return `${instance.date} · ${instance.name}`;
  const d = new Date(instance.date + "T00:00:00");
  const weekday = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const s = `${pad(def.start)}:00`;
  const e = `${pad(def.end)}:00`;
  return `${weekday} · ${def.label} (${s}–${e})`;
}

// Returns the shift instance that precedes the given one.
export function prevShiftBefore(instance) {
  const shifts = config.shifts;
  const idx = shifts.findIndex((s) => s.name === instance.name);
  if (idx === -1) return instance;
  const prevIdx = (idx - 1 + shifts.length) % shifts.length;
  const prevDef = shifts[prevIdx];
  // Wrapping backward (day→night) means the previous shift is on the prior calendar day.
  const [y, m, d] = instance.date.split("-").map(Number);
  const localDate = new Date(y, m - 1, d);
  const prevDate = prevIdx > idx ? isoDate(addDays(localDate, -1)) : instance.date;
  return { name: prevDef.name, label: prevDef.label, date: prevDate };
}

export { shiftStartDate, shiftEndDate };
