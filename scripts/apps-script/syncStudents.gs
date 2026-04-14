/**
 * Student schedule sync for HGH ED Roster (canonical sheet).
 * ----------------------------------------------------------
 * Reads the Highland Hospital EM Clerkship Schedule (a 2D rotation
 * grid maintained elsewhere) and writes flat student rows into this
 * spreadsheet's `roster` tab.
 *
 * Runs under your Google identity, so it can open the clerkship sheet
 * directly with SpreadsheetApp as long as your account has view access.
 * No "Publish to web" or CSV export required.
 *
 * SETUP (do once, in the canonical sheet):
 *   1. Paste the clerkship spreadsheet ID into STUDENT_SHEET_ID below
 *      (the long string between /d/ and /edit in the sheet URL).
 *      Optionally set STUDENT_TAB_NAME to pin a specific tab; leave
 *      blank to use the first tab.
 *   2. Extensions -> Apps Script -> paste this file -> Save (disk icon).
 *   3. Run `syncStudentsNow` once from the Apps Script editor and
 *      authorize when prompted. This auto-creates the `students`
 *      lookup tab (headers: key, full_name, title, photo_url) and
 *      seeds it with one row per distinct name found in the grid.
 *   4. Fill in full_name / title / photo_url for each student in the
 *      `students` tab. You never edit the `key` column -- that's what
 *      matches back to the clerkship grid. Leave full_name blank to
 *      fall back to the raw key; leave photo_url blank to get initials.
 *   5. Triggers (clock icon) -> Add Trigger -> function
 *      `syncStudentsNow`, Time-driven, Hour timer, Every hour. Save.
 *   6. Reload the spreadsheet; a "Roster Sync" menu appears. Use
 *      "Pull students now" to run on demand.
 *
 * What it does when it runs:
 *   - Opens the clerkship spreadsheet via SpreadsheetApp
 *   - Parses week blocks anchored on "WEEK n" cells and date cells
 *   - Maps shift labels (DAY / DAY-BUP / RN DAY / SWING / RN SWING /
 *     NIGHT) to our schema (day / evening / night) with notes for
 *     BUP/RN rotations
 *   - Appends a row to the `students` tab for any new keys (never
 *     touches existing rows)
 *   - Looks up each student's display info in the `students` tab
 *   - Removes existing `role=student` rows from `roster` and appends
 *     the freshly parsed shifts (non-student rows are untouched)
 */

const STUDENT_SHEET_ID = '1NazVQvOHGpl0HVjeW76zGQUBbD1kDR7GX5t1nc8-Eio';
const STUDENT_TAB_NAME = ''; // optional: exact tab name; blank = first tab
const LOOKUP_TAB_NAME  = 'students';
const ROSTER_TAB_NAME  = 'roster';

const SHIFT_MAP = {
  'DAY':       { shift: 'day',     note: '' },
  'DAY-BUP':   { shift: 'day',     note: 'BUP' },
  'RN DAY':    { shift: 'day',     note: 'Nursing rotation' },
  'SWING':     { shift: 'evening', note: '' },
  'RN SWING':  { shift: 'evening', note: 'Nursing rotation' },
  'NIGHT':     { shift: 'night',   note: '' },
};

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Roster Sync')
    .addItem('Pull students now', 'syncStudentsNow')
    .addItem('Show parse report', 'showParseReport')
    .addToUi();
}

// Diagnostic: parse the clerkship sheet and show what was found per
// week (date columns, per-day entry counts). Use this when a day is
// missing from the roster to see what the parser actually saw.
function showParseReport() {
  const src = SpreadsheetApp.openById(STUDENT_SHEET_ID);
  const tab = STUDENT_TAB_NAME ? src.getSheetByName(STUDENT_TAB_NAME) : src.getSheets()[0];
  const rows = tab.getDataRange().getValues();
  const report = [];
  const entries = parseClerkshipSchedule(rows, function (weekInfo) {
    const dates = weekInfo.dateCols.map(function (dc) {
      return formatDate(dc.date) + '@col' + dc.col;
    }).join(', ');
    report.push('WEEK at row ' + (weekInfo.rowIndex + 1) + ': ' + (dates || '(no dates found)'));
  });
  const byDate = {};
  for (const e of entries) byDate[e.date] = (byDate[e.date] || 0) + 1;
  const dateLines = Object.keys(byDate).sort().map(function (d) {
    return '  ' + d + ': ' + byDate[d] + ' entries';
  }).join('\n');
  const text =
    'Parsed ' + entries.length + ' total entries.\n\n' +
    report.join('\n') + '\n\nPer-date counts:\n' + dateLines;
  SpreadsheetApp.getUi().alert('Parse report', text, SpreadsheetApp.getUi().ButtonSet.OK);
}

function syncStudentsNow() {
  const ui = (function () { try { return SpreadsheetApp.getUi(); } catch (e) { return null; } })();
  if (!STUDENT_SHEET_ID) {
    const msg = 'Set STUDENT_SHEET_ID at the top of the script first.';
    if (ui) ui.alert(msg); else throw new Error(msg);
    return;
  }
  let rows;
  try {
    const src = SpreadsheetApp.openById(STUDENT_SHEET_ID);
    const tab = STUDENT_TAB_NAME
      ? src.getSheetByName(STUDENT_TAB_NAME)
      : src.getSheets()[0];
    if (!tab) throw new Error('Tab not found: ' + STUDENT_TAB_NAME);
    rows = tab.getDataRange().getValues();
  } catch (err) {
    const msg = 'Failed to open clerkship sheet: ' + err.message +
      '\nMake sure this account has at least view access to the sheet.';
    if (ui) ui.alert(msg); else throw err;
    return;
  }
  const entries = parseClerkshipSchedule(rows);
  const added = ensureStudentsLookupRows(entries);
  const n = writeStudentsToRoster(entries);
  const extra = added ? ' (+' + added + ' new lookup rows)' : '';
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Synced ' + n + ' student shifts from clerkship sheet.' + extra,
    'Roster Sync', 5);
}

// ---------------------------------------------------------------
// Parser for the 2D rotation grid.
// ---------------------------------------------------------------

function parseClerkshipSchedule(rows, onWeek) {
  // Infer year from "Rotation Start Date" cell. Fallback: current year.
  let rotationYear = new Date().getFullYear();
  outer: for (const r of rows) {
    for (let i = 0; i < r.length; i++) {
      if (String(r[i]).trim().toLowerCase() === 'rotation start date' && r[i + 1]) {
        const dt = parseDateCell(r[i + 1], rotationYear);
        if (dt) { rotationYear = dt.getFullYear(); break outer; }
      }
    }
  }

  // Locate week blocks.
  const weekStarts = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < rows[i].length; j++) {
      if (/^\s*WEEK\s+\d+\s*$/i.test(String(rows[i][j]))) {
        weekStarts.push({ rowIndex: i, colIndex: j });
        break;
      }
    }
  }

  const entries = [];
  for (let w = 0; w < weekStarts.length; w++) {
    const ws = weekStarts[w];
    const endRow = (w + 1 < weekStarts.length) ? weekStarts[w + 1].rowIndex : rows.length;

    // Dates usually appear in the same row as "WEEK n", to the right.
    // If not, scan the next 2 rows too.
    let dateCols = findDateCols(rows[ws.rowIndex], ws.colIndex + 1, rotationYear);
    for (let probe = 1; probe <= 2 && dateCols.length === 0 && ws.rowIndex + probe < endRow; probe++) {
      dateCols = findDateCols(rows[ws.rowIndex + probe], ws.colIndex + 1, rotationYear);
    }
    if (typeof onWeek === 'function') onWeek({ rowIndex: ws.rowIndex, dateCols: dateCols });
    if (dateCols.length === 0) continue;

    // In each subsequent row, read (shift_label, name) pairs at the
    // discovered date columns. Label is in col C, name in col C+1.
    for (let r = ws.rowIndex + 1; r < endRow; r++) {
      const row = rows[r] || [];
      for (const dc of dateCols) {
        const label = String(row[dc.col] || '').trim().toUpperCase();
        const name  = String(row[dc.col + 1] || '').trim();
        if (!label || !name) continue;
        const mapped = SHIFT_MAP[label];
        if (!mapped) continue; // Skip "EM RESIDENCY CONFERENCE" etc.
        entries.push({
          date:   formatDate(dc.date),
          shift:  mapped.shift,
          role:   'student',
          name:   name,
          note:   mapped.note,
        });
      }
    }
  }
  return entries;
}

function findDateCols(row, startCol, rotationYear) {
  const out = [];
  for (let c = startCol; c < row.length; c++) {
    const dt = parseDateCell(row[c], rotationYear);
    if (dt) out.push({ col: c, date: dt });
  }
  return out;
}

function parseDateCell(s, year) {
  // getValues() returns real Date objects for date-formatted cells.
  if (s instanceof Date && !isNaN(s.getTime())) {
    return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  }
  s = String(s).trim();
  if (!s) return null;

  // "3/30/26", "03/30/2026"
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    return new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
  }
  // "Mar-30", "Apr-1"
  m = s.match(/^([A-Za-z]{3})[-\s](\d{1,2})$/);
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3));
    if (mo >= 0) return new Date(year, mo, parseInt(m[2], 10));
  }
  // "2026-04-12"
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  return null;
}

function formatDate(d) {
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// ---------------------------------------------------------------
// Writing to the canonical roster tab.
// ---------------------------------------------------------------

function writeStudentsToRoster(entries) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const roster = ss.getSheetByName(ROSTER_TAB_NAME);
  if (!roster) throw new Error("Missing '" + ROSTER_TAB_NAME + "' tab in this spreadsheet.");

  const data = roster.getDataRange().getValues();
  if (!data.length) throw new Error("'" + ROSTER_TAB_NAME + "' tab is empty (needs a header row).");
  const headers = data[0].map(function (h) { return String(h).trim().toLowerCase(); });

  const col = function (name) {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error("roster tab is missing column: " + name);
    return i;
  };
  const roleCol  = col('role');
  const dateCol  = col('date');
  const shiftCol = col('shift');
  const nameCol  = col('name');
  const titleCol = headers.indexOf('title');
  const photoCol = headers.indexOf('photo_url');
  const notesCol = headers.indexOf('notes');

  // Delete existing student rows (bottom-up so indices don't shift).
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][roleCol]).trim().toLowerCase() === 'student') {
      roster.deleteRow(i + 1); // 1-based
    }
  }

  const lookup = loadStudentsLookup(ss);

  if (!entries.length) return 0;

  const toAppend = entries.map(function (e) {
    const key = String(e.name || '').trim().toLowerCase();
    const info = lookup[key] || { full_name: e.name, title: '', photo_url: '' };
    const row = new Array(headers.length).fill('');
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = 'student';
    row[nameCol]  = info.full_name || e.name;
    if (titleCol >= 0) row[titleCol] = info.title || '';
    if (photoCol >= 0) row[photoCol] = info.photo_url || '';
    if (notesCol >= 0) row[notesCol] = e.note || '';
    return row;
  });

  const lastRow = roster.getLastRow();
  roster.getRange(lastRow + 1, 1, toAppend.length, headers.length).setValues(toAppend);
  return toAppend.length;
}

// Ensure the `students` lookup tab exists and has a row for every
// distinct key seen in this sync. Existing rows are never modified;
// only new keys get appended with blank full_name / title / photo_url
// for a human to fill in later. Returns the number of rows appended.
function ensureStudentsLookupRows(entries) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOOKUP_TAB_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOOKUP_TAB_NAME);
    sheet.getRange(1, 1, 1, 4).setValues([['key', 'full_name', 'title', 'photo_url']]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  }
  const data = sheet.getDataRange().getValues();
  const headers = (data[0] || []).map(function (h) { return String(h).trim().toLowerCase(); });
  let keyCol = headers.indexOf('key');
  if (keyCol < 0) {
    // Tab exists but has no `key` header; refuse to touch it to avoid
    // clobbering whatever the user has there.
    return 0;
  }

  const existing = {};
  for (let i = 1; i < data.length; i++) {
    const k = String(data[i][keyCol] || '').trim().toLowerCase();
    if (k) existing[k] = true;
  }

  // Unique keys, preserving first-seen order and original casing.
  const seen = {};
  const newKeys = [];
  for (const e of entries) {
    const raw = String(e.name || '').trim();
    const k = raw.toLowerCase();
    if (!k || seen[k] || existing[k]) continue;
    seen[k] = true;
    newKeys.push(raw);
  }
  if (!newKeys.length) return 0;

  const width = Math.max(headers.length, 4);
  const rowsToAppend = newKeys.map(function (raw) {
    const row = new Array(width).fill('');
    row[keyCol] = raw;
    return row;
  });
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rowsToAppend.length, width).setValues(rowsToAppend);
  return rowsToAppend.length;
}

function loadStudentsLookup(ss) {
  const sheet = ss.getSheetByName(LOOKUP_TAB_NAME);
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};
  const headers = data[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const keyCol   = headers.indexOf('key');
  const nameCol  = headers.indexOf('full_name');
  const titleCol = headers.indexOf('title');
  const photoCol = headers.indexOf('photo_url');
  if (keyCol < 0) return {};
  const map = {};
  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][keyCol] || '').trim().toLowerCase();
    if (!key) continue;
    map[key] = {
      full_name: nameCol  >= 0 ? String(data[i][nameCol]  || '').trim() : '',
      title:     titleCol >= 0 ? String(data[i][titleCol] || '').trim() : '',
      photo_url: photoCol >= 0 ? String(data[i][photoCol] || '').trim() : '',
    };
  }
  return map;
}
