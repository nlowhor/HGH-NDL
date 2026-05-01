'use strict';

/**
 * HGH Student Schedule + Photo Sync
 * -----------------------------------
 * 1. Reads all rotation-block tabs of the student clerkship schedule Google
 *    Sheet (visual calendar layout) and extracts shift assignments for the
 *    configured date window.
 * 2. Fetches student headshot URLs from Airtable via the REST API.
 * 3. Replaces all student rows in the canonical roster Google Sheet.
 *
 * Required env vars:
 *   CANONICAL_SHEET_ID          – roster sheet to write to
 *   STUDENT_SCHEDULE_SHEET_ID   – clerkship schedule sheet to read from
 *   GOOGLE_SERVICE_ACCOUNT_JSON – service account credentials
 *   AIRTABLE_API_KEY            – Airtable personal access token
 */

const { google } = require('googleapis');

const AIRTABLE_BASE_ID = 'appXHrYewBeH8Rwmh';
const AIRTABLE_API     = 'https://api.airtable.com/v0';

const ROSTER_TAB   = 'roster';
const STUDENT_ROLE = 'student';
const DAYS_BEHIND  = 1;
const DAYS_AHEAD   = 60;

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeName(s) {
  return String(s || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_,\-]+/g, ' ')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .sort()
    .join(' ');
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
  const m2 = name.match(/\/(\d{2})\b/);
  if (m2) return 2000 + parseInt(m2[1], 10);
  return null;
}

// ── Schedule parsing ──────────────────────────────────────────────────────────

function parseScheduleTab(rows, tabName) {
  const hintYear = yearFromTabName(tabName);
  const entries  = [];

  let rotationYear = hintYear;
  for (const row of rows) {
    for (let c = 0; c < row.length - 1; c++) {
      if (/rotation start date/i.test(String(row[c] || ''))) {
        const d = parseDate(String(row[c + 1] || ''), hintYear);
        if (d) { rotationYear = parseInt(d.slice(0, 4), 10); break; }
      }
    }
    if (rotationYear) break;
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

    let j = i + 2;
    while (j < rows.length) {
      const dataRow = rows[j] || [];
      const dayCount = dataRow.filter(v =>
        DAY_NAMES.includes(String(v || '').trim().toUpperCase())
      ).length;
      if (dayCount >= 3 && j > i + 2) break;

      for (const [day, col] of Object.entries(dayPositions)) {
        const date = dateMap[day];
        if (!date) continue;
        const rawLabel = String(dataRow[col]     || '').trim();
        const rawName  = String(dataRow[col + 1] || '').trim();
        if (!rawLabel || !rawName) continue;
        if (SKIP_LABEL.test(rawLabel)) continue;
        if (SKIP_LABEL.test(rawName))  continue;
        if (SKIP_NAME.test(rawName))   continue;
        const mapped = SHIFT_LABEL_MAP[rawLabel.toUpperCase()];
        if (!mapped) continue;
        entries.push({ date, shift: mapped.shift, role: STUDENT_ROLE,
          name: rawName, title: '', notes: mapped.notes, photo_url: '' });
      }
      j++;
    }
    i = j;
  }

  return entries;
}

// ── Google Sheets — read student schedule ─────────────────────────────────────

async function fetchStudentSchedule(auth) {
  const scheduleSheetId = process.env.STUDENT_SCHEDULE_SHEET_ID;
  if (!scheduleSheetId) throw new Error('STUDENT_SCHEDULE_SHEET_ID env var is required.');

  const sheets = google.sheets({ version: 'v4', auth });
  const meta   = await sheets.spreadsheets.get({ spreadsheetId: scheduleSheetId });
  const allTabs = meta.data.sheets.map(s => ({ id: s.properties.sheetId, title: s.properties.title }));
  console.log(`Schedule sheet tabs: ${allTabs.map(t => t.title).join(', ')}`);

  const tabs = allTabs.filter(t => /block/i.test(t.title));
  console.log(`Rotation block tabs: ${tabs.map(t => t.title).join(', ')}`);

  const today   = new Date();
  const from    = new Date(today); from.setDate(from.getDate() - DAYS_BEHIND);
  const to      = new Date(today); to.setDate(to.getDate() + DAYS_AHEAD);
  const fromIso = from.toISOString().slice(0, 10);
  const toIso   = to.toISOString().slice(0, 10);

  const allEntries = [];
  for (const tab of tabs) {
    const res     = await sheets.spreadsheets.values.get({ spreadsheetId: scheduleSheetId, range: tab.title });
    const entries = parseScheduleTab(res.data.values || [], tab.title);
    const inWindow = entries.filter(e => e.date >= fromIso && e.date <= toIso);
    console.log(`  ${tab.title}: ${entries.length} parsed, ${inWindow.length} in window.`);
    allEntries.push(...inWindow);
  }

  const seen = new Set();
  const deduped = allEntries.filter(e => {
    const key = `${e.date}|${e.shift}|${e.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  console.log(`Total student entries in window: ${deduped.length}`);
  return deduped;
}

// ── Airtable REST API — fetch student photos ──────────────────────────────────

async function fetchStudentPhotos() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) {
    console.warn('AIRTABLE_API_KEY not set — skipping photo fetch.');
    return new Map();
  }

  const headers = { Authorization: `Bearer ${apiKey}` };

  // Discover the table that has attachment fields (headshots).
  console.log('\nFetching Airtable table metadata…');
  const metaRes = await fetch(`${AIRTABLE_API}/meta/bases/${AIRTABLE_BASE_ID}/tables`, { headers });
  if (!metaRes.ok) throw new Error(`Airtable metadata API ${metaRes.status}: ${await metaRes.text()}`);
  const { tables } = await metaRes.json();

  const table = tables.find(t => t.fields.some(f => f.type === 'multipleAttachments'));
  if (!table) throw new Error('No table with attachment fields found in Airtable base.');
  console.log(`Using table: "${table.name}" (${table.id})`);

  // Log field names for debugging.
  console.log(`Fields: ${table.fields.map(f => `${f.name} (${f.type})`).join(', ')}`);

  // Fetch all records, handling pagination.
  const photos = new Map();
  let offset;
  do {
    const url = new URL(`${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${table.id}`);
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) throw new Error(`Airtable records API ${res.status}: ${await res.text()}`);
    const data = await res.json();

    for (const record of data.records || []) {
      const fields = record.fields;

      // Find the primary name field (a non-empty string).
      const nameEntry = Object.entries(fields).find(([, v]) =>
        typeof v === 'string' && v.trim().length > 1
      );
      // Find the attachment field.
      const photoEntry = Object.entries(fields).find(([, v]) =>
        Array.isArray(v) && v[0]?.url
      );

      if (!nameEntry || !photoEntry) continue;
      const name = nameEntry[1].trim();
      const url  = photoEntry[1][0].thumbnails?.large?.url || photoEntry[1][0].url;
      console.log(`  ${name} → ${url.slice(0, 80)}`);
      photos.set(normalizeName(name), url);
    }

    offset = data.offset;
  } while (offset);

  console.log(`Airtable: ${photos.size} photo(s) fetched.`);
  return photos;
}

// ── Google Sheets — write canonical roster ────────────────────────────────────

async function getAuth() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function writeStudentsToSheet(auth, spreadsheetId, entries, photoMap) {
  const sheets = google.sheets({ version: 'v4', auth });

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ROSTER_TAB}!1:1` });
  const headers   = (headerRes.data.values?.[0] || []).map(h => String(h).trim().toLowerCase());

  const col = name => {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error(`roster tab missing column: "${name}"`);
    return i;
  };
  const roleCol  = col('role');
  const dateCol  = col('date');
  const shiftCol = col('shift');
  const nameCol  = col('name');
  const titleCol = headers.indexOf('title');
  const photoCol = headers.indexOf('photo_url');
  const notesCol = headers.indexOf('notes');

  const allRes   = await sheets.spreadsheets.values.get({ spreadsheetId, range: ROSTER_TAB });
  const rows     = allRes.data.values || [];
  const toDelete = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][roleCol] || '').trim().toLowerCase() === STUDENT_ROLE)
      toDelete.push(i + 1);
  }

  if (toDelete.length) {
    const meta    = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetId = meta.data.sheets.find(s => s.properties.title === ROSTER_TAB).properties.sheetId;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: toDelete.reverse().map(rowNum => ({
          deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum } },
        })),
      },
    });
    console.log(`Deleted ${toDelete.length} existing student row(s).`);
  }

  if (!entries.length) { console.log('No student entries to write.'); return 0; }

  let photoHits = 0;
  const width   = headers.length;
  const newRows = entries.map(e => {
    const photo = photoMap.get(normalizeName(e.name)) || '';
    if (photo) photoHits++;
    const row = new Array(width).fill('');
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = STUDENT_ROLE;
    row[nameCol]  = e.name;
    if (titleCol >= 0) row[titleCol] = e.title || '';
    if (photoCol >= 0) row[photoCol] = photo;
    if (notesCol >= 0) row[notesCol] = e.notes || '';
    return row;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId, range: ROSTER_TAB, valueInputOption: 'RAW',
    requestBody: { values: newRows },
  });

  console.log(`Wrote ${newRows.length} student row(s) (${photoHits} with photo_url).`);
  return newRows.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.CANONICAL_SHEET_ID)        throw new Error('CANONICAL_SHEET_ID env var is required.');
  if (!process.env.STUDENT_SCHEDULE_SHEET_ID) throw new Error('STUDENT_SCHEDULE_SHEET_ID env var is required.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required.');

  const auth = await getAuth();

  const [entries, photoMap] = await Promise.all([
    fetchStudentSchedule(auth),
    fetchStudentPhotos().catch(err => {
      console.warn('Photo fetch failed (continuing without photos):', err.message);
      return new Map();
    }),
  ]);

  console.log(`\nSchedule entries: ${entries.length}, photos: ${photoMap.size}`);
  const n = await writeStudentsToSheet(auth, process.env.CANONICAL_SHEET_ID, entries, photoMap);
  console.log(`\nDone. ${n} student row(s) written to canonical sheet.`);
}

main().catch(err => { console.error(err); process.exit(1); });
