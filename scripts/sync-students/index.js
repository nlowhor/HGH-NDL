'use strict';

/**
 * HGH Student Schedule Sync
 * --------------------------
 * Reads rotation-block tabs from the student clerkship schedule Google Sheet
 * (visual calendar layout) and writes student shift rows to the roster tab
 * of the canonical Google Sheet.
 *
 * Person data (display name, photo_url, title) lives in the "students" tab
 * and is managed manually — this script never touches that tab.
 *
 * Required env vars:
 *   CANONICAL_SHEET_ID          – roster sheet to write to
 *   GOOGLE_SERVICE_ACCOUNT_JSON – service account credentials
 */

const { google } = require('googleapis');

// Published CSV of the student clerkship schedule Google Sheet.
// Override with STUDENT_SCHEDULE_CSV_URL env var if the URL changes.
const STUDENT_SCHEDULE_CSV_URL = process.env.STUDENT_SCHEDULE_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSm3KBhIKMDOIbhgrZxqCT963rMssxTyh9vzDZiLxy4vbPWX-8A5luNoyKhSbDT3gJU5vMat8Bo552j/pub?gid=1506284669&single=true&output=csv';

const ROSTER_TAB   = 'roster';
const STUDENT_ROLE = 'student';
const DAYS_BEHIND  = 1;
const DAYS_AHEAD   = 60;

// ── Helpers ───────────────────────────────────────────────────────────────────

const SHIFT_LABEL_MAP = {
  'RN DAY':     { shift: 'day',     notes: 'RN Day' },
  'DAY-BUP':    { shift: 'day',     notes: 'Day-BUP' },
  'DAY':        { shift: 'day',     notes: '' },
  'FT':         { shift: 'day',     notes: 'Fast Track' },
  'FAST TRACK': { shift: 'day',     notes: 'Fast Track' },
  'SWING':      { shift: 'evening', notes: '' },
  'NIGHT':      { shift: 'night',   notes: '' },
  'NIGHTS':     { shift: 'night',   notes: '' },
};

function lookupShift(rawLabel) {
  const upper = rawLabel.toUpperCase();
  if (SHIFT_LABEL_MAP[upper]) return SHIFT_LABEL_MAP[upper];
  // Preserve -res/-att markers (e.g. DAY-RES → day shift, notes "-res").
  const slotMatch = upper.match(/^(.*?)-(RES|ATT)$/);
  if (slotMatch) {
    const base = SHIFT_LABEL_MAP[slotMatch[1]];
    if (base) {
      const marker = `-${slotMatch[2].toLowerCase()}`;
      return { shift: base.shift, notes: [base.notes, marker].filter(Boolean).join(' ') };
    }
  }
  return null;
}

const SKIP_LABEL = /^(orientation|bridge|conference|lecture|holiday|off|em |bup$)/i;
const SKIP_NAME  = /^(student|ucsf|ms|slot|resident|attending)\s*\d*$/i;

const DAY_NAMES = ['MON', 'TUES', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function parseDate(val, hintYear) {
  if (!val) return null;
  const s = String(val).trim();
  const monthDay = s.match(/^([A-Za-z]+)[\s\-](\d{1,2})$/);
  if (monthDay) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const m = months.indexOf(monthDay[1].toLowerCase());
    if (m < 0) return null;
    const d = parseInt(monthDay[2], 10);
    const year = hintYear || new Date().getFullYear();
    return `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const year = mdy[3].length === 2 ? 2000 + parseInt(mdy[3], 10) : parseInt(mdy[3], 10);
    return `${year}-${String(parseInt(mdy[1], 10)).padStart(2, '0')}-${String(parseInt(mdy[2], 10)).padStart(2, '0')}`;
  }
  return null;
}

function yearFromTabName(name) {
  const m4 = name.match(/\b(20\d{2})\b/);
  if (m4) return parseInt(m4[1], 10);
  const all = [...name.matchAll(/\/(\d{2})/g)];
  if (all.length) return 2000 + parseInt(all[all.length - 1][1], 10);
  return null;
}

// Convert a 0-based column index to a spreadsheet letter (A, B, …, AA, …).
function colLetter(idx) {
  let r = '', i = idx + 1;
  while (i > 0) { i--; r = String.fromCharCode(65 + (i % 26)) + r; i = Math.floor(i / 26); }
  return r;
}

// Ensure a column exists in the roster header; add it if missing.
async function ensureRosterColumn(sheets, spreadsheetId, headers, colName) {
  let idx = headers.indexOf(colName);
  if (idx >= 0) return idx;
  idx = headers.length;
  headers.push(colName);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${ROSTER_TAB}!1:1`,
    valueInputOption: 'RAW', requestBody: { values: [headers] },
  });
  console.log(`Added "${colName}" column to ${ROSTER_TAB} header.`);
  return idx;
}

// Minimal CSV parser — handles quoted fields with embedded commas/newlines.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { field += ch; }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      row.push(field.trim()); field = '';
    } else if (ch === '\n') {
      row.push(field.trim()); rows.push(row); row = []; field = '';
    } else if (ch === '\r') {
      // ignore bare CR
    } else {
      field += ch;
    }
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  return rows;
}

// ── Schedule parsing ──────────────────────────────────────────────────────────

function parseScheduleTab(rows, tabName) {
  const hintYear = yearFromTabName(tabName);
  const entries  = [];

  let rotationYear = hintYear;
  if (!rotationYear) {
    for (const row of rows) {
      for (let c = 0; c < row.length; c++) {
        if (/rotation start date/i.test(String(row[c] || ''))) {
          for (let k = c + 1; k < row.length; k++) {
            const raw = String(row[k] || '').trim();
            if (!raw) continue;
            const d = parseDate(raw, null);
            if (d) { rotationYear = parseInt(d.slice(0, 4), 10); break; }
          }
          break;
        }
      }
      if (rotationYear) break;
    }
  }

  let i = 0;
  while (i < rows.length) {
    const row = rows[i] || [];

    const dayPositions = {};
    for (let c = 0; c < row.length; c++) {
      const v = String(row[c] || '').trim().toUpperCase();
      if (DAY_NAMES.includes(v)) dayPositions[v] = c;
    }
    if (Object.keys(dayPositions).length < 3) { i++; continue; }

    const dateRow = rows[i + 1] || [];
    const dateMap = {};
    for (const [day, col] of Object.entries(dayPositions)) {
      const d = parseDate(String(dateRow[col] || ''), rotationYear);
      if (d) dateMap[day] = d;
    }

    const sortedDays = Object.entries(dayPositions).sort((a, b) => a[1] - b[1]);
    const dayColMap = {};
    for (let d = 0; d < sortedDays.length; d++) {
      const [day, col] = sortedDays[d];
      const nextCol = d + 1 < sortedDays.length ? sortedDays[d + 1][1] : null;
      if (nextCol !== null && nextCol - col >= 3) {
        dayColMap[day] = { labelCol: col + 1, nameCol: col + 2 };
      } else {
        dayColMap[day] = { labelCol: col, nameCol: col + 1 };
      }
    }

    let j = i + 2;
    while (j < rows.length) {
      const dataRow = rows[j] || [];
      const dayCount = dataRow.filter(v =>
        DAY_NAMES.includes(String(v || '').trim().toUpperCase())
      ).length;
      if (dayCount >= 3 && j > i + 2) break;

      for (const [day, { labelCol, nameCol }] of Object.entries(dayColMap)) {
        const date = dateMap[day];
        if (!date) continue;
        const rawLabel = String(dataRow[labelCol] || '').trim();
        const rawName  = String(dataRow[nameCol]  || '').trim();
        if (!rawLabel || !rawName) continue;
        if (SKIP_LABEL.test(rawLabel)) continue;
        if (SKIP_LABEL.test(rawName))  continue;
        if (SKIP_NAME.test(rawName))   continue;
        const mapped = lookupShift(rawLabel);
        if (!mapped) continue;
        entries.push({ date, shift: mapped.shift, role: STUDENT_ROLE,
          name: rawName, title: '', notes: mapped.notes });
      }
      j++;
    }
    i = j;
  }

  return entries;
}

// ── CSV — read student schedule ───────────────────────────────────────────────

async function fetchStudentSchedule() {
  console.log(`Fetching student schedule from CSV: ${STUDENT_SCHEDULE_CSV_URL}`);
  const res = await fetch(STUDENT_SCHEDULE_CSV_URL);
  if (!res.ok) throw new Error(`Schedule CSV fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);

  const today   = new Date();
  const from    = new Date(today); from.setDate(from.getDate() - DAYS_BEHIND);
  const to      = new Date(today); to.setDate(to.getDate() + DAYS_AHEAD);
  const fromIso = from.toISOString().slice(0, 10);
  const toIso   = to.toISOString().slice(0, 10);

  const entries  = parseScheduleTab(rows, '');
  const inWindow = entries.filter(e => e.date >= fromIso && e.date <= toIso);

  const seen = new Set();
  const deduped = inWindow.filter(e => {
    const key = `${e.date}|${e.shift}|${e.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  console.log(`Students parsed: ${entries.length} total, ${inWindow.length} in window, ${deduped.length} deduped.`);
  return deduped;
}

// ── Google Sheets write ───────────────────────────────────────────────────────

async function getAuth() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function writeStudentsToSheet(auth, spreadsheetId, entries) {
  const sheets = google.sheets({ version: 'v4', auth });

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ROSTER_TAB}!1:1` });
  const headers   = (headerRes.data.values?.[0] || []).map(h => String(h).trim().toLowerCase());

  const col = name => {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error(`roster tab missing column: "${name}"`);
    return i;
  };
  const roleCol        = col('role');
  const dateCol        = col('date');
  const shiftCol       = col('shift');
  const nameCol        = col('name');
  const notesCol        = headers.indexOf('notes');
  const matchedNameCol  = headers.indexOf('matched_name');
  const matchedPhotoCol = await ensureRosterColumn(sheets, spreadsheetId, headers, 'matched_photo');

  // Read entire sheet; preserve non-student rows and any saved matched_name/matched_photo values.
  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: ROSTER_TAB });
  const rows   = allRes.data.values || [];
  const kept   = rows.slice(0, 1); // header always kept
  let removed  = 0;
  const savedMatched = {}; // schedule name (lower) → matched_name value
  const savedPhotos  = {}; // schedule name (lower) → matched_photo value
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][roleCol] || '').trim().toLowerCase() === STUDENT_ROLE) {
      removed++;
      const key = String(rows[i][nameCol] || '').trim().toLowerCase();
      if (matchedNameCol >= 0) {
        const mn = String(rows[i][matchedNameCol] || '').trim();
        if (key && mn) savedMatched[key] = mn;
      }
      if (matchedPhotoCol >= 0) {
        const mp = String(rows[i][matchedPhotoCol] || '').trim();
        if (key && mp) savedPhotos[key] = mp;
      }
      continue;
    }
    kept.push(rows[i]);
  }
  console.log(`Removed ${removed} existing student row(s).`);

  if (!entries.length) {
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: ROSTER_TAB });
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${ROSTER_TAB}!A1`, valueInputOption: 'RAW',
      requestBody: { values: kept },
    });
    console.log('No student entries to write.');
    return 0;
  }

  const width   = headers.length;
  const newRows = entries.map(e => {
    const key = e.name.toLowerCase();
    const row = new Array(width).fill('');
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = STUDENT_ROLE;
    row[nameCol]  = e.name;
    if (notesCol >= 0)        row[notesCol]        = e.notes || '';
    if (matchedNameCol >= 0)  row[matchedNameCol]  = savedMatched[key] || '';
    if (matchedPhotoCol >= 0) row[matchedPhotoCol] = savedPhotos[key]  || '';
    return row;
  });

  const allNewRows = [...kept, ...newRows];
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: ROSTER_TAB });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${ROSTER_TAB}!A1`, valueInputOption: 'RAW',
    requestBody: { values: allNewRows },
  });

  // Write matched_photo formulas for any new rows that didn't have a saved value.
  if (matchedPhotoCol >= 0 && newRows.length) {
    const startRow    = kept.length + 1; // 1-based sheet row of first student entry
    const rc = colLetter(roleCol), nc = colLetter(nameCol), mc = colLetter(matchedPhotoCol);
    const formulaRows = [];
    for (let i = 0; i < newRows.length; i++) {
      const key = entries[i].name.toLowerCase();
      if (savedPhotos[key]) { formulaRows.push([savedPhotos[key]]); continue; }
      const r = startRow + i;
      formulaRows.push([
        `=IFERROR(IF(${rc}${r}="resident",IFERROR(INDEX(residents!$B:$B,MATCH(${nc}${r},residents!$E:$E,0)),""),` +
        `IF(${rc}${r}="student",IFERROR(INDEX(students!$B:$B,MATCH(${nc}${r},students!$E:$E,0)),""),` +
        `IF(${rc}${r}="attending",IFERROR(INDEX(attendings!$B:$B,MATCH(${nc}${r},attendings!$E:$E,0)),""),""))),"")`
      ]);
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${mc}${startRow}:${mc}${startRow + newRows.length - 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: formulaRows },
    });
  }

  console.log(`Wrote ${newRows.length} student row(s).`);
  return newRows.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.CANONICAL_SHEET_ID)          throw new Error('CANONICAL_SHEET_ID env var is required.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required.');

  const auth    = await getAuth();
  const entries = await fetchStudentSchedule();
  const n       = await writeStudentsToSheet(auth, process.env.CANONICAL_SHEET_ID, entries);
  console.log(`\nDone. ${n} student shift rows written to roster.`);
}

main().catch(err => { console.error(err); process.exit(1); });
