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
  const today   = new Date();
  const from    = new Date(today); from.setDate(from.getDate() - DAYS_BEHIND);
  const to      = new Date(today); to.setDate(to.getDate() + DAYS_AHEAD);
  const fromIso = from.toISOString().slice(0, 10);
  const toIso   = to.toISOString().slice(0, 10);

  // Base URL without gid — fetch each block tab by GID.
  // Add new block GIDs here as new blocks are created each year.
  const baseUrl = STUDENT_SCHEDULE_CSV_URL.replace(/[?&]gid=[^&]*/, '');
  const gids = (process.env.STUDENT_SCHEDULE_GIDS || '1506284669,1930360382').split(',').map(g => g.trim());

  let allEntries = [];
  for (const gid of gids) {
    const url = `${baseUrl}&gid=${gid}`;
    console.log(`Fetching student schedule tab gid=${gid}…`);
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`  Tab gid=${gid} fetch failed: HTTP ${res.status}`); continue; }
      const rows = parseCsv(await res.text());
      const entries = parseScheduleTab(rows, gid);
      console.log(`  Tab gid=${gid}: ${entries.length} entries parsed`);
      allEntries.push(...entries);
    } catch (err) {
      console.warn(`  Tab gid=${gid} error:`, err.message);
    }
  }

  const inWindow = allEntries.filter(e => e.date >= fromIso && e.date <= toIso);
  const seen = new Set();
  const deduped = inWindow.filter(e => {
    const key = `${e.date}|${e.shift}|${e.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  console.log(`Students parsed: ${allEntries.length} total, ${inWindow.length} in window, ${deduped.length} deduped.`);
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
  const notesCol       = headers.indexOf('notes');
  const matchedNameCol  = await ensureRosterColumn(sheets, spreadsheetId, headers, 'matched_name');
  const matchedPhotoCol = await ensureRosterColumn(sheets, spreadsheetId, headers, 'matched_photo');

  // Read with FORMULA render so we can tell manually-typed cells (no leading "=") apart
  // from formula cells. This lets us preserve manual overrides across syncs.
  const allRes = await sheets.spreadsheets.values.get({
    spreadsheetId, range: ROSTER_TAB, valueRenderOption: 'FORMULA',
  });
  const rows = allRes.data.values || [];
  const kept = rows.slice(0, 1); // header always kept
  let removed = 0;

  // Student rows being removed: save manually-typed matched values keyed by schedule name.
  const savedMatched = {}; // schedule name (lower) → manually-typed matched_name
  const savedPhotos  = {}; // schedule name (lower) → manually-typed matched_photo

  // Non-student rows being kept: save manually-typed matched values keyed by index in 'kept'.
  const keptManualMN = {}; // 1-based index in kept → value or null
  const keptManualMP = {}; // 1-based index in kept → value or null

  for (let i = 1; i < rows.length; i++) {
    const isStudent = String(rows[i][roleCol] || '').trim().toLowerCase() === STUDENT_ROLE;

    if (isStudent) {
      removed++;
      const key = String(rows[i][nameCol] || '').trim().toLowerCase();
      if (matchedNameCol >= 0) {
        const mn = String(rows[i][matchedNameCol] || '').trim();
        if (key && mn && !mn.startsWith('=')) savedMatched[key] = mn;
      }
      if (matchedPhotoCol >= 0) {
        const mp = String(rows[i][matchedPhotoCol] || '').trim();
        if (key && mp && !mp.startsWith('=')) savedPhotos[key] = mp;
      }
      continue;
    }

    // Non-student row: record any manually-typed matched values before keeping it.
    const keptIdx = kept.length; // 1-based (kept[0] is the header)
    if (matchedNameCol >= 0) {
      const mn = String(rows[i][matchedNameCol] || '').trim();
      keptManualMN[keptIdx] = (mn && !mn.startsWith('=')) ? mn : null;
    }
    if (matchedPhotoCol >= 0) {
      const mp = String(rows[i][matchedPhotoCol] || '').trim();
      keptManualMP[keptIdx] = (mp && !mp.startsWith('=')) ? mp : null;
    }
    kept.push(rows[i]);
  }
  console.log(`Removed ${removed} existing student row(s).`);

  const width   = headers.length;
  const newRows = entries.map(e => {
    const row = new Array(width).fill('');
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = STUDENT_ROLE;
    row[nameCol]  = e.name;
    if (notesCol >= 0) row[notesCol] = e.notes || '';
    // matched_name and matched_photo are written by the batchUpdate below
    return row;
  });

  const allNewRows = [...kept, ...newRows];
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: ROSTER_TAB });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${ROSTER_TAB}!A1`, valueInputOption: 'RAW',
    requestBody: { values: allNewRows },
  });

  if (!entries.length) console.log('No student entries to write.');

  // Write matched_name and matched_photo for every non-header row.
  // For each cell: if a manually-typed override was saved, write that plain string;
  // otherwise write the INDEX/MATCH formula. USER_ENTERED handles both correctly.
  const totalDataRows = allNewRows.length - 1;
  if (totalDataRows > 0) {
    const rc = colLetter(roleCol), nc = colLetter(nameCol);
    const mnCol = colLetter(matchedNameCol), mpCol = colLetter(matchedPhotoCol);
    const keptDataLen = kept.length - 1; // number of non-header kept rows
    const mnValues = [], mpValues = [];

    for (let i = 0; i < totalDataRows; i++) {
      const r = i + 2; // 1-based sheet row (row 1 = header)
      const mnFormula =
        `=IFERROR(IF(${rc}${r}="resident",IFERROR(INDEX(residents!$A:$A,MATCH(${nc}${r},residents!$E:$E,0)),""),` +
        `IF(${rc}${r}="student",IFERROR(INDEX(students!$A:$A,MATCH(${nc}${r},students!$E:$E,0)),""),` +
        `IF(${rc}${r}="attending",IFERROR(INDEX(attendings!$A:$A,MATCH(${nc}${r},attendings!$E:$E,0)),""),""))),"")`
      const mpFormula =
        `=IFERROR(IF(${rc}${r}="resident",IFERROR(INDEX(residents!$B:$B,MATCH(${nc}${r},residents!$E:$E,0)),""),` +
        `IF(${rc}${r}="student",IFERROR(INDEX(students!$B:$B,MATCH(${nc}${r},students!$E:$E,0)),""),` +
        `IF(${rc}${r}="attending",IFERROR(INDEX(attendings!$B:$B,MATCH(${nc}${r},attendings!$E:$E,0)),""),""))),"")`

      let mnValue, mpValue;
      if (i < keptDataLen) {
        const keptIdx = i + 1;
        mnValue = keptManualMN[keptIdx] || mnFormula;
        mpValue = keptManualMP[keptIdx] || mpFormula;
      } else {
        const key = String(newRows[i - keptDataLen][nameCol] || '').toLowerCase();
        mnValue = savedMatched[key] || mnFormula;
        mpValue = savedPhotos[key]  || mpFormula;
      }
      mnValues.push([mnValue]);
      mpValues.push([mpValue]);
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${mnCol}2:${mnCol}${totalDataRows + 1}`, values: mnValues },
          { range: `${mpCol}2:${mpCol}${totalDataRows + 1}`, values: mpValues },
        ],
      },
    });
    console.log(`Wrote matched_name and matched_photo for ${totalDataRows} row(s).`);
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
