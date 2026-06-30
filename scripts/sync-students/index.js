'use strict';

/**
 * HGH Student Schedule Sync
 * --------------------------
 * Reads rotation-block tabs from the student clerkship schedule Google Sheet
 * (visual calendar layout) and writes student shift rows to the roster tab
 * of the canonical Google Sheet. Also syncs the students person-data tab
 * from Airtable (names + headshots) so matched_name formulas resolve.
 *
 * Required env vars:
 *   CANONICAL_SHEET_ID          – roster sheet to write to
 *   GOOGLE_SERVICE_ACCOUNT_JSON – service account credentials
 * Optional:
 *   AIRTABLE_API_KEY            – Airtable personal access token (for photos)
 *   AIRTABLE_TABLE              – table name/ID (auto-detected if omitted)
 *   GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_REF_NAME – for photo persistence
 */

const { google } = require('googleapis');
const { ensurePhotoInPages, isAirtableUrl } = require('../lib/github-photos');

const AIRTABLE_BASE_ID = 'appXHrYewBeH8Rwmh';
const AIRTABLE_API     = 'https://api.airtable.com/v0';
const STUDENTS_TAB     = 'students';

// Published CSV of the student clerkship schedule Google Sheet.
// Override with STUDENT_SCHEDULE_CSV_URL env var if the URL changes.
const STUDENT_SCHEDULE_CSV_URL = process.env.STUDENT_SCHEDULE_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSm3KBhIKMDOIbhgrZxqCT963rMssxTyh9vzDZiLxy4vbPWX-8A5luNoyKhSbDT3gJU5vMat8Bo552j/pub?gid=1506284669&single=true&output=csv';

const ROSTER_TAB   = 'roster';
const STUDENT_ROLE = 'student';
const DAYS_BEHIND  = 1;
const DAYS_AHEAD   = 60;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Sort words so "James Smith" and "Smith James" normalise the same way.
function normalizeName(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[,_\-]+/g, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ');
}

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

  const SCHEDULE_BASE_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSm3KBhIKMDOIbhgrZxqCT963rMssxTyh9vzDZiLxy4vbPWX-8A5luNoyKhSbDT3gJU5vMat8Bo552j/pub';
  // Add new block GIDs here each year, or override via STUDENT_SCHEDULE_GIDS env var.
  const gids = (process.env.STUDENT_SCHEDULE_GIDS || '1506284669,1930360382,758292113').split(',').map(g => g.trim());

  let allEntries = [];
  for (const gid of gids) {
    const url = `${SCHEDULE_BASE_URL}?gid=${gid}&single=true&output=csv`;
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

// ── Airtable — fetch student names + photos ───────────────────────────────────

// Extract full name from various Airtable field layouts.
function extractAirtableName(fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (!/name/i.test(k)) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim();
  }
  // Fallback: first string field that looks like a name (two words, Title Case).
  for (const v of Object.values(fields)) {
    if (typeof v === 'string' && /^[A-Z][a-z]+ [A-Z]/.test(v.trim())) return v.trim();
  }
  return null;
}

async function fetchStudentPhotos() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) {
    console.warn('AIRTABLE_API_KEY not set — skipping Airtable photo fetch.');
    return { byFullName: new Map(), byLastName: new Map() };
  }

  const headers = { Authorization: `Bearer ${apiKey}` };

  let tableId = process.env.AIRTABLE_TABLE;
  let rosterTableId = null;

  if (!tableId) {
    console.log('AIRTABLE_TABLE not set — auto-discovering via metadata API…');
    const metaRes = await fetch(`${AIRTABLE_API}/meta/bases/${AIRTABLE_BASE_ID}/tables`, { headers });
    if (!metaRes.ok) throw new Error(`Airtable metadata ${metaRes.status}: ${await metaRes.text()}`);
    const { tables } = await metaRes.json();
    console.log(`Tables: ${tables.map(t => t.name).join(', ')}`);

    const photoRe = /photo|headshot|image|picture|portrait/i;
    let table = tables.find(t => t.fields.some(f => f.type === 'multipleAttachments' && photoRe.test(f.name)));
    if (!table) table = tables.find(t => t.fields.some(f => f.type === 'multipleAttachments'));
    if (!table) throw new Error(`Could not find a photo table. Set AIRTABLE_TABLE env var.`);
    tableId = table.id;
    console.log(`Auto-discovered photo table: "${table.name}"`);

    const rosterTable = tables.find(t => /student.roster/i.test(t.name));
    if (rosterTable) { rosterTableId = rosterTable.id; console.log(`Found Student Roster table: "${rosterTable.name}"`); }
  }

  // Build recordId → full name map from Student Roster table (for linked-record lookups).
  const rosterById = new Map();
  if (rosterTableId) {
    let offset;
    do {
      const url = new URL(`${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(rosterTableId)}`);
      if (offset) url.searchParams.set('offset', offset);
      const res = await fetch(url.toString(), { headers });
      if (!res.ok) { console.warn('Student Roster fetch failed:', res.status); break; }
      const data = await res.json();
      for (const r of data.records || []) {
        const name = extractAirtableName(r.fields);
        if (name) rosterById.set(r.id, name);
      }
      offset = data.offset;
    } while (offset);
    console.log(`Student Roster: ${rosterById.size} name(s).`);
  }

  const byFullName = new Map();
  const byLastName = new Map();
  let offset;
  let loggedFields = false;

  do {
    const url = new URL(`${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableId)}`);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) throw new Error(`Airtable records ${res.status}: ${await res.text()}`);
    const data = await res.json();

    for (const record of data.records || []) {
      const fields = record.fields;
      if (!loggedFields) {
        console.log('Airtable fields:', Object.keys(fields).join(', '));
        loggedFields = true;
      }

      const photoEntry = Object.entries(fields).find(([, v]) => Array.isArray(v) && v[0]?.url);
      if (!photoEntry) continue;
      const photoUrl = photoEntry[1][0].thumbnails?.large?.url || photoEntry[1][0].url;

      const linkedId = Array.isArray(fields['Student']) ? fields['Student'][0] : null;
      const name = (linkedId && rosterById.get(linkedId)) || extractAirtableName(fields);
      if (!name) continue;

      const entry = { name, url: photoUrl };
      byFullName.set(normalizeName(name), entry);
      for (const word of name.toLowerCase().split(/\s+/)) {
        if (word.length > 2) byLastName.set(word, entry);
      }
    }
    offset = data.offset;
  } while (offset);

  console.log(`Airtable: ${byFullName.size} student photo(s) fetched.`);
  return { byFullName, byLastName };
}

// Persist Airtable photo URLs to GitHub Pages so they don't expire.
async function persistPhotosToPages(photos) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('GITHUB_TOKEN not set — skipping photo persistence (Airtable URLs may expire).');
    return photos;
  }
  const { byFullName, byLastName } = photos;
  let persisted = 0, skipped = 0;
  for (const [key, entry] of byFullName) {
    if (!isAirtableUrl(entry.url)) { skipped++; continue; }
    try {
      entry.url = await ensurePhotoInPages(key.replace(/ /g, '-'), entry.url, 'photos/students');
      persisted++;
    } catch (err) {
      console.warn(`  Photo persistence failed for ${entry.name}:`, err.message);
    }
  }
  console.log(`Photos persisted: ${persisted} stored, ${skipped} already permanent.`);
  return { byFullName, byLastName };
}

// Update the `students` person-data tab with names and photos from Airtable.
// Preserves any manually-edited rows. schedule_name defaults to the Airtable
// display name (= what appears in the schedule) and is never overwritten.
async function writeStudentsTab(auth, spreadsheetId, photos) {
  const { byFullName } = photos;
  if (!byFullName.size) { console.log('No Airtable photos — skipping students tab update.'); return; }

  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === STUDENTS_TAB);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: STUDENTS_TAB } } }] },
    });
    console.log(`Created "${STUDENTS_TAB}" tab.`);
  }

  const existingByName = new Map();
  if (existing) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: STUDENTS_TAB });
    const vals = res.data.values || [];
    if (vals.length > 1) {
      const hdrs = vals[0].map(h => String(h).toLowerCase().trim());
      const ni = hdrs.indexOf('name'), pi = hdrs.indexOf('photo_url'),
            ti = hdrs.indexOf('title'), xi = hdrs.indexOf('notes'),
            si = hdrs.indexOf('schedule_name');
      for (let i = 1; i < vals.length; i++) {
        const r = vals[i];
        const name = (r[ni] || '').trim();
        if (!name) continue;
        existingByName.set(normalizeName(name), {
          name,
          photo_url:     pi >= 0 ? (r[pi] || '').trim() : '',
          title:         ti >= 0 ? (r[ti] || '').trim() : '',
          notes:         xi >= 0 ? (r[xi] || '').trim() : '',
          schedule_name: si >= 0 ? (r[si] || '').trim() : '',
        });
      }
    }
  }

  const merged = new Map(existingByName);
  for (const [, entry] of byFullName) {
    const key = normalizeName(entry.name);
    const ex  = existingByName.get(key) || {};
    const useNewPhoto = !ex.photo_url || /airtable\.com|airtableusercontent\.com/i.test(ex.photo_url);
    merged.set(key, {
      name:          entry.name,
      photo_url:     useNewPhoto ? (entry.url || ex.photo_url || '') : ex.photo_url,
      title:         ex.title || '',
      notes:         ex.notes || '',
      schedule_name: ex.schedule_name || entry.name,
    });
  }
  for (const [key, ex] of existingByName) {
    if (!merged.has(key)) merged.set(key, { ...ex, schedule_name: ex.schedule_name || ex.name || key });
  }

  const rows = [
    ['name', 'photo_url', 'title', 'notes', 'schedule_name'],
    ...Array.from(merged.values())
      .filter(e => e.name)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => [e.name, e.photo_url, e.title, e.notes, e.schedule_name]),
  ];

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: STUDENTS_TAB });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${STUDENTS_TAB}!A1`, valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
  console.log(`"${STUDENTS_TAB}" tab: wrote ${rows.length - 1} student record(s).`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.CANONICAL_SHEET_ID)          throw new Error('CANONICAL_SHEET_ID env var is required.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required.');

  const auth = await getAuth();

  const [entries, rawPhotos] = await Promise.all([
    fetchStudentSchedule(),
    fetchStudentPhotos().catch(err => {
      console.warn('Airtable fetch failed (continuing without photos):', err.message);
      return { byFullName: new Map(), byLastName: new Map() };
    }),
  ]);

  const photos = await persistPhotosToPages(rawPhotos).catch(err => {
    console.warn('Photo persistence failed (using Airtable URLs directly):', err.message);
    return rawPhotos;
  });

  const spreadsheetId = process.env.CANONICAL_SHEET_ID;
  const [n] = await Promise.all([
    writeStudentsToSheet(auth, spreadsheetId, entries),
    writeStudentsTab(auth, spreadsheetId, photos),
  ]);
  console.log(`\nDone. ${n} student shift rows written to roster.`);
}

main().catch(err => { console.error(err); process.exit(1); });
