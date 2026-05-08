'use strict';

/**
 * HGH Resident Schedule Sync
 * ---------------------------
 * Logs into Medrez with Puppeteer, then calls two authenticated JSON APIs:
 *   - getstaffs: all staff with IDs, names, and PGY levels
 *   - getschedule: all shifts with dates, times, names, and assigned staff IDs
 *
 * Writes resident shift rows to the roster tab of the canonical Google Sheet.
 * Person data (photo_url, display name, title) lives in the "residents" tab
 * and is managed manually — this script never touches that tab.
 *
 * Runs in GitHub Actions on a daily schedule. Can also be run locally:
 *   CANONICAL_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...' node index.js
 */

const puppeteer  = require('puppeteer');
const { google } = require('googleapis');

const MEDREZ_GROUP = '9s733y77k';
const MEDREZ_URL   = `https://www.medrez.net/view.php?a=${MEDREZ_GROUP}`;
const MEDREZ_PASS  = 'HGH5150';

const ROSTER_TAB    = 'roster';
const RESIDENT_ROLE = 'resident';
const DAYS_BEHIND   = 1;   // include yesterday so nothing is missed
const DAYS_AHEAD    = 60;  // fetch two months ahead

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Medrez keys PGY levels by the ending calendar year of the academic year
// (e.g. the 2025-2026 year uses key "2026").
function medrezYear() {
  const now   = new Date();
  const month = now.getMonth() + 1; // 1-12
  return month >= 7 ? now.getFullYear() + 1 : now.getFullYear();
}

function detectShift(startHour) {
  const h = parseInt(startHour, 10);
  if (h >= 23 || h < 7) return 'night';
  if (h >= 15)           return 'evening';
  return 'day';
}

function pgyLabel(pgyStr) {
  const m = String(pgyStr).match(/(\d+)/);
  return m ? `R${m[1]}` : '';
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

// ── Medrez API calls ──────────────────────────────────────────────────────────

async function fetchMedrezData() {
  console.log('Launching Puppeteer…');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);

  try {
    console.log('Navigating to Medrez…');
    await page.goto(MEDREZ_URL, { waitUntil: 'networkidle2' });

    const pwInput = await page.$('input[type="password"]');
    if (pwInput) {
      console.log('Password form found — submitting…');
      await pwInput.type(MEDREZ_PASS);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('input[type="submit"]'),
      ]);
    }

    const loggedIn = await page.$('a[href*="logout"]');
    if (!loggedIn) throw new Error('Login does not appear to have succeeded.');
    console.log('Logged in.');

    const staffsUrl = `https://www.medrez.net/view.php?reqdata=getstaffs&a=${MEDREZ_GROUP}&async=yes&need=account`;
    console.log('Fetching staff list…');
    const staffsData = await page.evaluate(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`getstaffs HTTP ${res.status}`);
      return res.json();
    }, staffsUrl);

    const today = new Date();
    const from  = new Date(today); from.setDate(from.getDate() - DAYS_BEHIND);
    const to    = new Date(today); to.setDate(to.getDate() + DAYS_AHEAD);
    const schedUrl = `https://www.medrez.net/view.php?reqdata=getschedule&a=${MEDREZ_GROUP}&from_0=${isoDate(from)}&to_0=${isoDate(to)}&num_range=1&async=yes&curstaffonly=no`;
    console.log(`Fetching schedule ${isoDate(from)} → ${isoDate(to)}…`);
    const schedData = await page.evaluate(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`getschedule HTTP ${res.status}`);
      return res.json();
    }, schedUrl);

    return { staffsData, schedData };

  } finally {
    await browser.close();
  }
}

// ── Parse JSON into roster entries ────────────────────────────────────────────

function buildEntries(staffsData, schedData) {
  const year = medrezYear();

  const staffMap = {};
  for (const [id, s] of Object.entries(staffsData.staffs || {})) {
    const name = (s.staff_name?.str || '').trim();
    if (!name) continue;
    const pgyRaw = s.level?.years?.[year] || s.level?.years?.[String(year)] || '';
    staffMap[id] = { name, title: pgyLabel(pgyRaw) };
  }
  console.log(`Staff mapped: ${Object.keys(staffMap).length}`);

  const entries = [];
  for (const [date, shifts] of Object.entries(schedData.sched || {})) {
    for (const shift of shifts) {
      const shiftName = shift.name?.str || '';
      const startHour = shift.start_time?.hour ?? '7';
      for (const staffId of (shift.staffs || [])) {
        const staff = staffMap[staffId];
        if (!staff) continue;
        entries.push({
          date,
          shift: detectShift(startHour),
          role:  RESIDENT_ROLE,
          name:  staff.name,
          title: staff.title,
          notes: shiftName,
        });
      }
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  console.log(`Shift entries parsed: ${entries.length}`);
  return entries;
}

// ── Google Sheets write ───────────────────────────────────────────────────────

async function getAuth() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function writeResidentsToSheet(sheets, spreadsheetId, entries) {
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
  const roleCol        = col('role');
  const dateCol        = col('date');
  const shiftCol       = col('shift');
  const nameCol        = col('name');
  const titleCol       = headers.indexOf('title');
  const notesCol       = headers.indexOf('notes');
  const matchedNameCol  = await ensureRosterColumn(sheets, spreadsheetId, headers, 'matched_name');
  const matchedPhotoCol = await ensureRosterColumn(sheets, spreadsheetId, headers, 'matched_photo');

  // Read all rows; preserve matched_name and matched_photo overrides already in the sheet.
  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: ROSTER_TAB });
  const rows   = allRes.data.values || [];

  const toDelete      = [];
  const savedMatched  = {}; // schedule name (lower) → matched_name value
  const savedPhotos   = {}; // schedule name (lower) → matched_photo value
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][roleCol] || '').trim().toLowerCase() === RESIDENT_ROLE) {
      toDelete.push(i + 1);
      const key = String(rows[i][nameCol] || '').trim().toLowerCase();
      if (matchedNameCol >= 0) {
        const mn = String(rows[i][matchedNameCol] || '').trim();
        if (key && mn) savedMatched[key] = mn;
      }
      if (matchedPhotoCol >= 0) {
        const mp = String(rows[i][matchedPhotoCol] || '').trim();
        if (key && mp) savedPhotos[key] = mp;
      }
    }
  }

  if (toDelete.length) {
    console.log(`Deleting ${toDelete.length} existing resident rows…`);
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
  }

  if (!entries.length) { console.log('No entries to append.'); return 0; }

  const width   = headers.length;
  const newRows = entries.map(e => {
    const key = e.name.toLowerCase();
    const row = new Array(width).fill('');
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = RESIDENT_ROLE;
    row[nameCol]  = e.name;
    if (titleCol >= 0)        row[titleCol]        = e.title || '';
    if (notesCol >= 0)        row[notesCol]         = e.notes || '';
    if (matchedNameCol >= 0)  row[matchedNameCol]   = savedMatched[key] || '';
    if (matchedPhotoCol >= 0) row[matchedPhotoCol]  = savedPhotos[key]  || '';
    return row;
  });

  // Determine where new rows will land so we can write formulas into the right cells.
  const preAppendRows = rows.length - toDelete.length;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: ROSTER_TAB,
    valueInputOption: 'RAW',
    requestBody: { values: newRows },
  });

  // Write matched_name and matched_photo formulas for all newly appended rows.
  const rc = colLetter(roleCol), nc = colLetter(nameCol);
  const mnCol = colLetter(matchedNameCol), mpCol = colLetter(matchedPhotoCol);
  const startRow = preAppendRows + 1; // 1-based sheet row of first new entry
  const mnFormulas = [], mpFormulas = [];
  for (let i = 0; i < newRows.length; i++) {
    const r = startRow + i;
    mnFormulas.push([
      `=IFERROR(IF(${rc}${r}="resident",IFERROR(INDEX(residents!$A:$A,MATCH(${nc}${r},residents!$E:$E,0)),""),` +
      `IF(${rc}${r}="student",IFERROR(INDEX(students!$A:$A,MATCH(${nc}${r},students!$E:$E,0)),""),` +
      `IF(${rc}${r}="attending",IFERROR(INDEX(attendings!$A:$A,MATCH(${nc}${r},attendings!$E:$E,0)),""),""))),"")`
    ]);
    mpFormulas.push([
      `=IFERROR(IF(${rc}${r}="resident",IFERROR(INDEX(residents!$B:$B,MATCH(${nc}${r},residents!$E:$E,0)),""),` +
      `IF(${rc}${r}="student",IFERROR(INDEX(students!$B:$B,MATCH(${nc}${r},students!$E:$E,0)),""),` +
      `IF(${rc}${r}="attending",IFERROR(INDEX(attendings!$B:$B,MATCH(${nc}${r},attendings!$E:$E,0)),""),""))),"")`
    ]);
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${mnCol}${startRow}:${mnCol}${startRow + newRows.length - 1}`, values: mnFormulas },
        { range: `${mpCol}${startRow}:${mpCol}${startRow + newRows.length - 1}`, values: mpFormulas },
      ],
    },
  });

  console.log(`Appended ${newRows.length} resident shift rows.`);
  return newRows.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const spreadsheetId = process.env.CANONICAL_SHEET_ID;
  if (!spreadsheetId)
    throw new Error('CANONICAL_SHEET_ID env var is required.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required.');

  const { staffsData, schedData } = await fetchMedrezData();
  const entries = buildEntries(staffsData, schedData);

  if (!entries.length) {
    console.error('No entries parsed from Medrez API — aborting.');
    process.exit(1);
  }

  const auth   = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const n      = await writeResidentsToSheet(sheets, spreadsheetId, entries);
  console.log(`\nDone. ${n} resident shift rows written to roster.`);
}

main().catch(err => { console.error(err); process.exit(1); });
