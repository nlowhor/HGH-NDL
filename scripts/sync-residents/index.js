'use strict';

/**
 * HGH Resident Schedule Sync
 * ---------------------------
 * Logs into Medrez with Puppeteer, then calls two authenticated JSON APIs:
 *   - getstaffs: all staff with IDs, names, and PGY levels
 *   - getschedule: all shifts with dates, times, names, and assigned staff IDs
 *
 * Maps the results and writes resident shift rows to the canonical Google Sheet.
 *
 * Runs in GitHub Actions on a daily schedule. Can also be run locally:
 *   CANONICAL_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...' node index.js
 */

const puppeteer  = require('puppeteer');
const { google } = require('googleapis');

const MEDREZ_GROUP = '9s733y77k';
const MEDREZ_URL   = `https://www.medrez.net/view.php?a=${MEDREZ_GROUP}`;
const MEDREZ_PASS  = 'HGH5150';

const ROSTER_TAB     = 'roster';
const RESIDENT_ROLE  = 'resident';
const DAYS_BEHIND    = 1;   // include yesterday so nothing is missed
const DAYS_AHEAD     = 60;  // fetch two months ahead

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
  // "pgy1" → "R1", "pgy2" → "R2", etc.
  const m = String(pgyStr).match(/(\d+)/);
  return m ? `R${m[1]}` : '';
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

    // Verify login succeeded
    const loggedIn = await page.$('a[href*="logout"]');
    if (!loggedIn) throw new Error('Login does not appear to have succeeded.');
    console.log('Logged in.');

    // ── getstaffs API ──────────────────────────────────────────────────────
    const staffsUrl = `https://www.medrez.net/view.php?reqdata=getstaffs&a=${MEDREZ_GROUP}&async=yes&need=account`;
    console.log('Fetching staff list…');
    const staffsData = await page.evaluate(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`getstaffs HTTP ${res.status}`);
      return res.json();
    }, staffsUrl);

    // ── getschedule API ────────────────────────────────────────────────────
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

  // Map: staffId → { name, title }
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
          shift:     detectShift(startHour),
          role:      RESIDENT_ROLE,
          name:      staff.name,
          title:     staff.title,
          photo_url: '',
          notes:     shiftName,
        });
      }
    }
  }

  // Sort by date then name for deterministic sheet order.
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  console.log(`Shift entries parsed: ${entries.length}`);
  return entries;
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

async function getSheetsClient() {
  const key  = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function writeResidentsToSheet(sheets, spreadsheetId, entries) {
  // Read header row.
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

  // Read all rows to find existing resident rows.
  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: ROSTER_TAB });
  const rows   = allRes.data.values || [];

  // Collect 1-based row indices of resident rows (skip header at row 1).
  // Also capture any existing photo_url values so they survive the rewrite.
  const toDelete = [];
  const savedPhotos = {}; // name (lowercase) → photo_url
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][roleCol] || '').trim().toLowerCase() === RESIDENT_ROLE) {
      toDelete.push(i + 1);
      if (photoCol >= 0) {
        const name  = String(rows[i][nameCol] || '').trim().toLowerCase();
        const photo = String(rows[i][photoCol] || '').trim();
        if (name && photo) savedPhotos[name] = photo;
      }
    }
  }
  console.log(`Preserved photo_url for ${Object.keys(savedPhotos).length} resident(s).`);

  // Delete existing resident rows bottom-up.
  if (toDelete.length) {
    console.log(`Deleting ${toDelete.length} existing resident rows…`);
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
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
    const row = new Array(width).fill('');
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = RESIDENT_ROLE;
    row[nameCol]  = e.name;
    if (titleCol >= 0) row[titleCol] = e.title || '';
    if (photoCol >= 0) row[photoCol] = e.photo_url || savedPhotos[e.name.toLowerCase()] || '';
    if (notesCol >= 0) row[notesCol] = e.notes || '';
    return row;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: ROSTER_TAB,
    valueInputOption: 'RAW',
    requestBody: { values: newRows },
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

  const sheets = await getSheetsClient();
  const n = await writeResidentsToSheet(sheets, spreadsheetId, entries);
  console.log(`\nDone. ${n} resident shift rows written to sheet.`);
}

main().catch(err => { console.error(err); process.exit(1); });
