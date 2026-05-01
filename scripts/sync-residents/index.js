'use strict';

const { ensurePhotoInPages, isAirtableUrl } = require('../lib/github-photos');

/**
 * HGH Resident Schedule Sync
 * ---------------------------
 * Logs into Medrez with Puppeteer, then calls two authenticated JSON APIs:
 *   - getstaffs: all staff with IDs, names, and PGY levels
 *   - getschedule: all shifts with dates, times, names, and assigned staff IDs
 *
 * Maps the results and writes resident shift rows to the canonical Google Sheet.
 * Also looks up resident headshots from the Google Drive folder that contains
 * the sheet (or from DRIVE_FOLDER_ID if set) and populates photo_url.
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

// Normalise a name for fuzzy matching: strip extension, replace separators,
// lowercase, sort words so "Smith, John" matches "John Smith".
function normalizeName(s) {
  return s
    .replace(/\.[^.]+$/, '')          // remove file extension
    .replace(/[_,\-]+/g, ' ')         // separators → spaces
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .sort()
    .join(' ');
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

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  console.log(`Shift entries parsed: ${entries.length}`);
  return entries;
}

// ── Google Drive photo lookup ─────────────────────────────────────────────────

async function getDriveFolderId(drive, spreadsheetId) {
  if (process.env.DRIVE_FOLDER_ID) {
    console.log(`Using DRIVE_FOLDER_ID: ${process.env.DRIVE_FOLDER_ID}`);
    return process.env.DRIVE_FOLDER_ID;
  }
  console.log('Looking up parent folder of the sheet…');
  const meta = await drive.files.get({ fileId: spreadsheetId, fields: 'parents' });
  const parents = meta.data.parents || [];
  if (!parents.length) throw new Error('Sheet has no parent Drive folder.');
  console.log(`Parent folder ID: ${parents[0]}`);
  return parents[0];
}

// Returns { photos, folderId } — photos maps normalised name → Drive thumbnail URL.
async function fetchDrivePhotos(auth, spreadsheetId) {
  const drive    = google.drive({ version: 'v3', auth });
  let   folderId;
  try {
    folderId = await getDriveFolderId(drive, spreadsheetId);
  } catch (err) {
    console.warn('Could not find Drive folder — skipping Drive photo lookup:', err.message);
    return { photos: {}, folderId: null };
  }

  // List image files in the folder.
  const imageTypes = [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
  ];
  const mimeQuery = imageTypes.map(t => `mimeType='${t}'`).join(' or ');
  const query = `'${folderId}' in parents and (${mimeQuery}) and trashed=false`;

  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: query,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 200,
      ...(pageToken ? { pageToken } : {}),
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`Found ${files.length} image file(s) in Drive folder.`);

  // Build normalised-name → thumbnail URL map.
  const photoMap = {};
  for (const f of files) {
    const key = normalizeName(f.name);
    photoMap[key] = `https://drive.google.com/thumbnail?id=${f.id}&sz=w400`;
  }
  return { photos: photoMap, folderId };
}

// ── Airtable resident photo lookup ───────────────────────────────────────────

// Fetches the "Resident Roster" table from the ReST Airtable base and returns
// a map of normalised name → attachment URL. Attachment URLs expire (~2 hours)
// so this must run at sync time and the URL written directly to the sheet.
async function fetchAirtableResidentPhotos() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_RESIDENTS_BASE_ID || 'appKUhwYWruLxO7p2';
  if (!apiKey) {
    console.warn('AIRTABLE_API_KEY not set — skipping Airtable photo lookup.');
    return {};
  }

  const table = encodeURIComponent('Resident Roster');
  const fieldParams = ['Full Name', 'Photo']
    .map(f => `fields[]=${encodeURIComponent(f)}`).join('&');

  const photos = {};
  let offset;
  do {
    const url = `https://api.airtable.com/v0/${baseId}/${table}?${fieldParams}` +
                (offset ? `&offset=${offset}` : '');
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Airtable resident fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    for (const record of (data.records || [])) {
      const name        = record.fields['Full Name'];
      const attachments = record.fields['Photo'];
      if (!name || !Array.isArray(attachments) || !attachments.length) continue;
      const photoUrl = attachments[0].url;
      if (photoUrl) photos[normalizeName(name)] = photoUrl;
    }
    offset = data.offset;
  } while (offset);

  console.log(`Airtable resident photos: ${Object.keys(photos).length} record(s) indexed.`);
  return photos;
}

// ── Google API clients ────────────────────────────────────────────────────────

async function getAuth() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
}

// ── Google Sheets write ───────────────────────────────────────────────────────

async function writeResidentsToSheet(sheets, spreadsheetId, entries, drivePhotos, airtablePhotos = {}) {
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

  // Read all rows; preserve any photo_url already in the sheet for residents
  // (e.g. manually entered URLs that the Drive lookup wouldn't cover).
  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: ROSTER_TAB });
  const rows   = allRes.data.values || [];

  const toDelete    = [];
  const savedPhotos = {}; // normalised name → photo_url
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][roleCol] || '').trim().toLowerCase() === RESIDENT_ROLE) {
      toDelete.push(i + 1);
      if (photoCol >= 0) {
        const name  = normalizeName(String(rows[i][nameCol] || ''));
        const photo = String(rows[i][photoCol] || '').trim();
        if (name && photo) savedPhotos[name] = photo;
      }
    }
  }
  console.log(`Preserved photo_url for ${Object.keys(savedPhotos).length} resident(s) already in sheet.`);

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

  // Photo priority: Airtable > Drive folder > previously saved in sheet.
  const resolvePhoto = (name) => {
    const key = normalizeName(name);
    return airtablePhotos[key] || drivePhotos[key] || savedPhotos[key] || '';
  };

  let photoHits = 0;
  const width   = headers.length;
  const newRows = entries.map(e => {
    const row   = new Array(width).fill('');
    const photo = resolvePhoto(e.name);
    if (photo) photoHits++;
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = RESIDENT_ROLE;
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

  console.log(`Appended ${newRows.length} resident shift rows (${photoHits} with photo_url).`);
  return newRows.length;
}

// ── GitHub Pages photo persistence ───────────────────────────────────────────

// Takes the airtablePhotos map (normalizedName → url) and returns a new map
// where Airtable URLs have been replaced with permanent GitHub Pages URLs.
async function persistResidentPhotos(airtablePhotos) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('GITHUB_TOKEN not set — skipping GitHub Pages photo persistence.');
    return airtablePhotos;
  }

  const persisted = {};
  let hits    = 0;
  let skipped = 0;

  for (const [key, url] of Object.entries(airtablePhotos)) {
    if (!isAirtableUrl(url)) { persisted[key] = url; skipped++; continue; }
    const fileKey = key.replace(/ /g, '-');
    try {
      persisted[key] = await ensurePhotoInPages(fileKey, url, 'photos/residents');
      hits++;
    } catch (err) {
      console.warn(`  Photo persistence failed for key "${key}":`, err.message);
      persisted[key] = url; // fall back to expiring URL
    }
  }

  console.log(`Resident photos persisted to GitHub Pages: ${hits} (${skipped} already permanent).`);
  return persisted;
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

  let drivePhotos = {};
  try {
    const result = await fetchDrivePhotos(auth, spreadsheetId);
    drivePhotos  = result.photos;
    console.log(`Drive photo lookup: ${Object.keys(drivePhotos).length} image(s) indexed.`);
  } catch (err) {
    console.warn('Drive photo lookup failed (photos will fall back to saved values):', err.message);
  }

  let airtablePhotos = {};
  try {
    const raw = await fetchAirtableResidentPhotos();
    airtablePhotos = await persistResidentPhotos(raw).catch(err => {
      console.warn('GitHub Pages photo persistence failed (falling back to Airtable URLs):', err.message);
      return raw;
    });
  } catch (err) {
    console.warn('Airtable resident photo lookup failed:', err.message);
  }

  const n = await writeResidentsToSheet(sheets, spreadsheetId, entries, drivePhotos, airtablePhotos);
  console.log(`\nDone. ${n} resident shift rows written to sheet.`);
}

main().catch(err => { console.error(err); process.exit(1); });
