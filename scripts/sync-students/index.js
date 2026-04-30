'use strict';

/**
 * HGH Student Photo Sync
 * ----------------------
 * Opens the Airtable shared view with Puppeteer, intercepts the JSON payload
 * that Airtable fetches to render the table, and extracts student names and
 * photo URLs.  Matches those names against student rows in the canonical
 * Google Sheet and writes the photo_url column for any matches.
 *
 * Runs in GitHub Actions on a daily schedule. Can also be run locally:
 *   CANONICAL_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...' node index.js
 */

const puppeteer  = require('puppeteer');
const { google } = require('googleapis');

const AIRTABLE_URL = 'https://airtable.com/appXHrYewBeH8Rwmh/shrXE7nBIQyO13XMz?1zeMd=sfsxe9QCVDzQPlLNf';

const ROSTER_TAB   = 'roster';
const STUDENT_ROLE = 'student';

// ── Airtable scraping ─────────────────────────────────────────────────────────

async function fetchStudentPhotos() {
  console.log('Launching Puppeteer…');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);

  // Collect Airtable API responses as the page loads.
  const apiPayloads = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('airtable.com')) return;
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    try {
      const json = await response.json();
      apiPayloads.push({ url, json });
    } catch (_) { /* ignore non-JSON */ }
  });

  try {
    console.log('Navigating to Airtable shared view…');
    await page.goto(AIRTABLE_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

    // Give late-loading XHR a moment to complete.
    await new Promise(r => setTimeout(r, 3000));

    // Save a screenshot for debugging in CI.
    await page.screenshot({ path: 'airtable-debug.png', fullPage: false });
    console.log('Screenshot saved: airtable-debug.png');

    // ── Strategy 1: parse intercepted JSON payloads ───────────────────────
    const students = extractFromApiPayloads(apiPayloads);
    if (students.length) {
      console.log(`Extracted ${students.length} student(s) from API payloads.`);
      return students;
    }
    console.log('No data from API payloads; falling back to DOM extraction…');

    // ── Strategy 2: extract from rendered DOM ─────────────────────────────
    const domStudents = await page.evaluate(() => {
      const results = [];
      // Airtable grid: each row is a <tr> or a div with role="row".
      // We look for cells that contain an image (attachment) alongside a text cell.
      const rows = Array.from(document.querySelectorAll('[data-rowindex], tr'));
      for (const row of rows) {
        const imgs = Array.from(row.querySelectorAll('img[src]'))
          .filter(img => img.src && !img.src.includes('airtable.com/brand'));
        if (!imgs.length) continue;
        // Take the first non-trivially-sized image as the headshot.
        const photoUrl = imgs[0].src;
        // Name: look for a text node in the row that isn't a number/date.
        const texts = Array.from(row.querySelectorAll('[data-columnindex="0"], .cell-wrapper, td'))
          .map(el => el.textContent.trim())
          .filter(t => t && t.length > 1 && !/^\d+$/.test(t));
        if (!texts.length) continue;
        results.push({ name: texts[0], photo_url: photoUrl });
      }
      return results;
    });

    if (domStudents.length) {
      console.log(`Extracted ${domStudents.length} student(s) from DOM.`);
      return domStudents;
    }

    // Save the full HTML for debugging if both strategies failed.
    const html = await page.content();
    require('fs').writeFileSync('airtable-debug.html', html);
    console.warn('Both extraction strategies found 0 students. Saved airtable-debug.html.');
    return [];

  } finally {
    await browser.close();
  }
}

function extractFromApiPayloads(payloads) {
  const students = [];
  for (const { json } of payloads) {
    // Airtable API responses nest records differently depending on the endpoint.
    // Try common shapes.
    const records = (
      json.data?.tableData?.rows ||       // shared view metadata
      json.data?.rows ||
      json.rows ||
      json.records ||
      []
    );
    if (!records.length) continue;

    for (const record of records) {
      // Fields can be under record.cellValuesByColumnId, record.fields, etc.
      const fields = record.cellValuesByColumnId || record.fields || record;
      if (typeof fields !== 'object') continue;

      const values = Object.values(fields);

      // Find name: a string field that looks like a person's name (two words, no numbers).
      const nameField = values.find(v =>
        typeof v === 'string' && /^[A-Za-z]+ [A-Za-z]/.test(v)
      );
      if (!nameField) continue;

      // Find photo: an attachment array or a string URL.
      let photoUrl = '';
      for (const v of values) {
        if (typeof v === 'string' && /^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)/i.test(v)) {
          photoUrl = v; break;
        }
        if (Array.isArray(v) && v[0]?.url) {
          photoUrl = v[0].url; break;
        }
        if (Array.isArray(v) && v[0]?.thumbnails?.large?.url) {
          photoUrl = v[0].thumbnails.large.url; break;
        }
      }

      if (nameField && photoUrl) {
        students.push({ name: nameField, photo_url: photoUrl });
      }
    }

    if (students.length) break; // stop at the first payload that yielded data
  }
  return students;
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

async function updateStudentPhotos(sheets, spreadsheetId, students) {
  if (!students.length) {
    console.log('No students to update.');
    return 0;
  }

  // Build a lookup: normalised name → photo_url.
  const photoByName = {};
  for (const { name, photo_url } of students) {
    photoByName[name.trim().toLowerCase()] = photo_url;
  }

  // Read the full sheet to find student rows.
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: ROSTER_TAB });
  const rows = res.data.values || [];
  if (!rows.length) { console.log('Sheet is empty.'); return 0; }

  const headers = rows[0].map(h => String(h).trim().toLowerCase());
  const roleCol  = headers.indexOf('role');
  const nameCol  = headers.indexOf('name');
  const photoCol = headers.indexOf('photo_url');

  if (roleCol < 0 || nameCol < 0 || photoCol < 0) {
    throw new Error(`Sheet missing required column(s). Found headers: ${headers.join(', ')}`);
  }

  // Collect batchUpdate data: one ValueRange per student row that needs updating.
  const data = [];
  let matched = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (String(row[roleCol] || '').trim().toLowerCase() !== STUDENT_ROLE) continue;

    const name    = String(row[nameCol] || '').trim().toLowerCase();
    const photoUrl = photoByName[name];
    if (!photoUrl) continue;

    const existing = String(row[photoCol] || '').trim();
    if (existing === photoUrl) continue; // already up-to-date

    // Sheets rows are 1-based; header is row 1, so data rows start at row 2.
    const sheetRow = i + 1;
    const colLetter = colToLetter(photoCol);
    data.push({
      range: `${ROSTER_TAB}!${colLetter}${sheetRow}`,
      values: [[photoUrl]],
    });
    matched++;
    console.log(`  ${row[nameCol]}: updating photo_url`);
  }

  if (!data.length) {
    console.log('All student photo URLs are already up-to-date (or no matching names found).');
    return 0;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });

  console.log(`Updated photo_url for ${matched} student row(s).`);
  return matched;
}

function colToLetter(idx) {
  let letter = '';
  let n = idx;
  while (n >= 0) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const spreadsheetId = process.env.CANONICAL_SHEET_ID;
  if (!spreadsheetId)
    throw new Error('CANONICAL_SHEET_ID env var is required.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required.');

  const students = await fetchStudentPhotos();
  console.log(`\nStudents found: ${students.length}`);
  for (const s of students) console.log(`  ${s.name}: ${s.photo_url}`);

  if (!students.length) {
    console.warn('No student data extracted — sheet will not be modified.');
    process.exit(0);
  }

  const sheets = await getSheetsClient();
  const n = await updateStudentPhotos(sheets, spreadsheetId, students);
  console.log(`\nDone. ${n} student photo URL(s) written to sheet.`);
}

main().catch(err => { console.error(err); process.exit(1); });
