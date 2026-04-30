'use strict';

/**
 * HGH Student Schedule + Photo Sync
 * -----------------------------------
 * 1. Reads all tabs of the student clerkship schedule Google Sheet.
 *    Each tab is a rotation block laid out as a visual calendar.
 *    Parses shift assignments into flat { date, shift, role, name, notes }
 *    rows for the configured date window.
 * 2. Opens the Airtable shared view with Puppeteer and extracts student
 *    headshot URLs.  Attaches photos to matching schedule entries.
 * 3. Replaces all student rows in the canonical roster Google Sheet.
 *
 * Required env vars:
 *   CANONICAL_SHEET_ID          – roster sheet to write to
 *   STUDENT_SCHEDULE_SHEET_ID   – clerkship schedule sheet to read from
 *   GOOGLE_SERVICE_ACCOUNT_JSON – service account credentials
 *
 * Runs in GitHub Actions on a daily schedule. Can also be run locally.
 */

const puppeteer  = require('puppeteer');
const { google } = require('googleapis');

const AIRTABLE_URL = 'https://airtable.com/appXHrYewBeH8Rwmh/shrXE7nBIQyO13XMz?1zeMd=sfsxe9QCVDzQPlLNf';

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

// Map shift label text → canonical shift name + notes string.
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

// Labels that occupy a shift-type cell but are NOT student assignments.
const SKIP_LABEL = /^(orientation|bridge|conference|lecture|holiday|off|em |bup$)/i;

const DAY_NAMES = ['MON', 'TUES', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

// Parse a cell value into an ISO date string, given a hint year.
function parseDate(val, hintYear) {
  if (!val) return null;
  const s = String(val).trim();

  // "May-4" or "May 4"
  const monthDay = s.match(/^([A-Za-z]+)[\s\-](\d{1,2})$/);
  if (monthDay) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const m = months.indexOf(monthDay[1].toLowerCase());
    if (m < 0) return null;
    const d = parseInt(monthDay[2], 10);
    const year = hintYear || new Date().getFullYear();
    return `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // "5/4/26" or "5/4/2026"
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const year = mdy[3].length === 2 ? 2000 + parseInt(mdy[3], 10) : parseInt(mdy[3], 10);
    return `${year}-${String(parseInt(mdy[1], 10)).padStart(2, '0')}-${String(parseInt(mdy[2], 10)).padStart(2, '0')}`;
  }

  return null;
}

// Guess the year from a tab name like "#Block 1 (5/4-5/31/26)" or "2026 #Block 12".
function yearFromTabName(name) {
  const m4 = name.match(/\b(20\d{2})\b/);
  if (m4) return parseInt(m4[1], 10);
  // "/YY" at end of a date range
  const m2 = name.match(/\/(\d{2})\b/);
  if (m2) return 2000 + parseInt(m2[1], 10);
  return null;
}

// ── Schedule parsing ──────────────────────────────────────────────────────────

function parseScheduleTab(rows, tabName) {
  const hintYear = yearFromTabName(tabName);
  const entries  = [];

  // Find "Rotation Start Date" to use as year anchor.
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

    // Detect a day-header row: contains ≥ 3 recognised day-of-week names.
    const dayPositions = {}; // 'MON' → column index
    for (let c = 0; c < row.length; c++) {
      const v = String(row[c] || '').trim().toUpperCase();
      if (DAY_NAMES.includes(v)) dayPositions[v] = c;
    }

    if (Object.keys(dayPositions).length < 3) { i++; continue; }

    // The row immediately after the day headers contains the dates.
    // (Sometimes "WEEK N" appears in col B of that row — skip it.)
    const dateRow = rows[i + 1] || [];
    const dateMap = {}; // 'MON' → ISO date
    for (const [day, col] of Object.entries(dayPositions)) {
      const d = parseDate(String(dateRow[col] || ''), rotationYear);
      if (d) dateMap[day] = d;
    }

    // Scan data rows until the next day-header block.
    let j = i + 2;
    while (j < rows.length) {
      const dataRow = rows[j] || [];

      // Stop if this row looks like another day-header row.
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

        const mapped = SHIFT_LABEL_MAP[rawLabel.toUpperCase()];
        if (!mapped) continue;

        entries.push({
          date,
          shift:     mapped.shift,
          role:      STUDENT_ROLE,
          name:      rawName,
          title:     '',
          notes:     mapped.notes,
          photo_url: '',
        });
      }

      j++;
    }

    i = j;
  }

  return entries;
}

// ── Google Sheets — read student schedule ────────────────────────────────────

async function fetchStudentSchedule(auth) {
  const scheduleSheetId = process.env.STUDENT_SCHEDULE_SHEET_ID;
  if (!scheduleSheetId) throw new Error('STUDENT_SCHEDULE_SHEET_ID env var is required.');

  const sheets = google.sheets({ version: 'v4', auth });

  // List all tabs.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: scheduleSheetId });
  const tabs  = meta.data.sheets.map(s => ({
    id:    s.properties.sheetId,
    title: s.properties.title,
  }));
  console.log(`Schedule sheet has ${tabs.length} tab(s): ${tabs.map(t => t.title).join(', ')}`);

  // Date window.
  const today = new Date();
  const from  = new Date(today); from.setDate(from.getDate() - DAYS_BEHIND);
  const to    = new Date(today); to.setDate(to.getDate() + DAYS_AHEAD);
  const fromIso = from.toISOString().slice(0, 10);
  const toIso   = to.toISOString().slice(0, 10);

  const allEntries = [];

  for (const tab of tabs) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: scheduleSheetId,
      range: tab.title,
    });
    const rows    = res.data.values || [];
    const entries = parseScheduleTab(rows, tab.title);

    // Filter to the date window.
    const inWindow = entries.filter(e => e.date >= fromIso && e.date <= toIso);
    console.log(`  ${tab.title}: ${entries.length} entries parsed, ${inWindow.length} in window.`);
    allEntries.push(...inWindow);
  }

  // Deduplicate by date+shift+name.
  const seen = new Set();
  const deduped = allEntries.filter(e => {
    const key = `${e.date}|${e.shift}|${e.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  console.log(`Total student entries in window: ${deduped.length}`);
  return deduped;
}

// ── Airtable photo scraping ───────────────────────────────────────────────────

async function fetchStudentPhotos() {
  console.log('\nLaunching Puppeteer for Airtable photos…');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);

  const apiPayloads = [];
  page.on('response', async (response) => {
    if (!response.url().includes('airtable.com')) return;
    if (!(response.headers()['content-type'] || '').includes('application/json')) return;
    try { apiPayloads.push(await response.json()); } catch (_) {}
  });

  try {
    console.log('Navigating to Airtable shared view…');
    await page.goto(AIRTABLE_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: 'airtable-debug.png', fullPage: false });

    // Strategy 1: intercept API payloads.
    const photos = extractPhotosFromPayloads(apiPayloads);
    if (photos.size) {
      console.log(`Airtable: ${photos.size} photo(s) from API payloads.`);
      return photos;
    }

    // Strategy 2: DOM extraction.
    const domPhotos = await page.evaluate(() => {
      const out = {};
      const rows = Array.from(document.querySelectorAll('[data-rowindex], tr'));
      for (const row of rows) {
        const imgs = Array.from(row.querySelectorAll('img[src]'))
          .filter(img => !/brand|logo|icon/i.test(img.src));
        if (!imgs.length) continue;
        const texts = Array.from(row.querySelectorAll('[data-columnindex="0"], .cell-wrapper, td'))
          .map(el => el.textContent.trim())
          .filter(t => t && /^[A-Za-z]+ [A-Za-z]/.test(t));
        if (!texts.length) continue;
        out[texts[0]] = imgs[0].src;
      }
      return out;
    });

    const domMap = new Map(Object.entries(domPhotos));
    if (domMap.size) {
      console.log(`Airtable: ${domMap.size} photo(s) from DOM.`);
      return domMap;
    }

    const html = require('fs').readFileSync ? null : null;
    require('fs').writeFileSync('airtable-debug.html', await page.content());
    console.warn('Airtable: no photos found. Saved airtable-debug.html for inspection.');
    return new Map();

  } finally {
    await browser.close();
  }
}

function extractPhotosFromPayloads(payloads) {
  const photos = new Map(); // normalised name → url
  for (const json of payloads) {
    const records = (
      json.data?.tableData?.rows ||
      json.data?.rows ||
      json.rows ||
      json.records ||
      []
    );
    if (!records.length) continue;
    for (const record of records) {
      const fields = record.cellValuesByColumnId || record.fields || record;
      if (typeof fields !== 'object') continue;
      const values = Object.values(fields);
      const nameField = values.find(v => typeof v === 'string' && /^[A-Za-z]+ [A-Za-z]/.test(v));
      if (!nameField) continue;
      let url = '';
      for (const v of values) {
        if (typeof v === 'string' && /^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)/i.test(v)) { url = v; break; }
        if (Array.isArray(v) && v[0]?.thumbnails?.large?.url) { url = v[0].thumbnails.large.url; break; }
        if (Array.isArray(v) && v[0]?.url) { url = v[0].url; break; }
      }
      if (url) photos.set(normalizeName(nameField), url);
    }
    if (photos.size) break;
  }
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

  // Read headers.
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${ROSTER_TAB}!1:1`,
  });
  const headers = (headerRes.data.values?.[0] || [])
    .map(h => String(h).trim().toLowerCase());

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

  // Delete existing student rows.
  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: ROSTER_TAB });
  const rows   = allRes.data.values || [];
  const toDelete = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][roleCol] || '').trim().toLowerCase() === STUDENT_ROLE)
      toDelete.push(i + 1);
  }

  if (toDelete.length) {
    const meta    = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetId = meta.data.sheets
      .find(s => s.properties.title === ROSTER_TAB).properties.sheetId;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: toDelete.reverse().map(rowNum => ({
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum },
          },
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
    spreadsheetId,
    range: ROSTER_TAB,
    valueInputOption: 'RAW',
    requestBody: { values: newRows },
  });

  console.log(`Wrote ${newRows.length} student row(s) (${photoHits} with photo_url).`);
  return newRows.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.CANONICAL_SHEET_ID)
    throw new Error('CANONICAL_SHEET_ID env var is required.');
  if (!process.env.STUDENT_SCHEDULE_SHEET_ID)
    throw new Error('STUDENT_SCHEDULE_SHEET_ID env var is required.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required.');

  const auth = await getAuth();

  // Run schedule fetch and photo scrape concurrently.
  const [entries, photoMap] = await Promise.all([
    fetchStudentSchedule(auth),
    fetchStudentPhotos().catch(err => {
      console.warn('Photo scrape failed (continuing without photos):', err.message);
      return new Map();
    }),
  ]);

  console.log(`\nSchedule entries: ${entries.length}, photos found: ${photoMap.size}`);

  const n = await writeStudentsToSheet(auth, process.env.CANONICAL_SHEET_ID, entries, photoMap);
  console.log(`\nDone. ${n} student row(s) written to canonical sheet.`);
}

main().catch(err => { console.error(err); process.exit(1); });
