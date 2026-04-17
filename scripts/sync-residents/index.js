/**
 * HGH Resident Schedule Sync
 * ---------------------------
 * Uses Puppeteer (headless Chrome) to log into the Medrez schedule
 * viewer, extract all resident calendar subscription links from the
 * rendered DOM, fetch each resident's ICS feed, and write the parsed
 * shifts into the canonical Google Sheet's `roster` tab.
 *
 * Runs in GitHub Actions on a daily schedule. Can also be run locally:
 *   CANONICAL_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...' node index.js
 *
 * Required environment variables:
 *   CANONICAL_SHEET_ID          — spreadsheet ID (from /d/<ID>/ in the URL)
 *   GOOGLE_SERVICE_ACCOUNT_JSON — full JSON of a service account key that
 *                                 has been granted Editor access to the sheet
 */

'use strict';

const puppeteer  = require('puppeteer');
const { google } = require('googleapis');
const https      = require('https');
const fs         = require('fs');

const MEDREZ_URL      = 'https://www.medrez.net/view.php?a=9s733y77k';
const MEDREZ_PASSWORD = 'HGH5150';
const ROSTER_TAB      = 'roster';
const RESIDENT_ROLE   = 'resident';

// ── Shift detection ───────────────────────────────────────────────
function detectShift(dtstart) {
  const m = dtstart.match(/T(\d{2})/);
  if (!m) return 'day';
  const h = parseInt(m[1], 10);
  if (h >= 23 || h < 7)  return 'night';
  if (h >= 15)            return 'evening';
  return 'day';
}

function parseIcsDate(dtstart) {
  const m = dtstart.match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ── ICS helpers ───────────────────────────────────────────────────
function extractVevents(ics) {
  const results = [];
  const re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
  let m;
  while ((m = re.exec(ics)) !== null) results.push(m[1]);
  return results;
}

function icsField(block, field) {
  const re = new RegExp(`(?:^|\\n)${field}[^:]*:([^\\n]*(?:\\n[ \\t][^\\n]*)*)`);
  const m  = block.match(re);
  if (!m) return null;
  return m[1].replace(/\r/g, '').replace(/\n[ \t]/g, '').trim();
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function parseResidentIcs(ics, name, title) {
  const events = extractVevents(ics);
  const entries = [];
  for (const ev of events) {
    const summary = icsField(ev, 'SUMMARY') || '';
    const dtstart = icsField(ev, 'DTSTART') || '';
    if (/there was a problem/i.test(summary)) continue;
    const date = parseIcsDate(dtstart);
    if (!date) continue;
    entries.push({
      date,
      shift:     detectShift(dtstart),
      role:      RESIDENT_ROLE,
      name,
      title:     title || '',
      photo_url: '',
      notes:     summary,
    });
  }
  return entries;
}

// Extract resident name from ICS DESCRIPTION field.
// Format: "FirstName LastName  shift, ..." or "Name shift, ..."
function nameFromDescription(desc) {
  if (!desc) return null;
  const m = desc.match(/^(.+?)\s{2,}shift/i) || desc.match(/^(.+?)\s+shift/i);
  return m ? m[1].trim() : null;
}

// ── Puppeteer helpers ─────────────────────────────────────────────

// Extract all f= tokens visible on the current page.
async function extractFTokens(page) {
  return page.evaluate(() => {
    const results = {};
    for (const a of document.querySelectorAll('a[href*="f="]')) {
      const m = a.href.match(/[?&]f=([a-z0-9]+)/i);
      if (!m) continue;
      const token = m[1].toLowerCase();
      if (results[token]) continue;
      const row  = a.closest('tr');
      const cell = a.closest('td') || a.closest('li') || a.parentElement;
      const nearbyText = (row?.textContent || cell?.textContent || '').trim()
        .replace(/\s+/g, ' ');
      results[token] = nearbyText;
    }
    return results;
  });
}

// ── Puppeteer: get all f= tokens from Medrez DOM ──────────────────
async function scrapeResidentTokens() {
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

    // Submit password if login form is present.
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) {
      console.log('Password form found — submitting…');
      await pwInput.type(MEDREZ_PASSWORD);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('input[type="submit"]'),
      ]);
    }

    console.log('Waiting for schedule to render…');
    await page.waitForFunction(
      () => document.querySelector('a[href]') !== null,
      { timeout: 15_000 }
    ).catch(() => console.warn('Page may not have fully rendered.'));

    // Save debug artifacts.
    await page.screenshot({ path: 'medrez-debug.png', fullPage: true });
    console.log('Screenshot saved to medrez-debug.png');
    fs.writeFileSync('medrez-debug.html', await page.content());
    console.log('HTML saved to medrez-debug.html');

    // Step 1: try to find f= tokens directly on the landing page.
    let found = await extractFTokens(page);
    console.log(`f= links on landing page: ${Object.keys(found).length}`);

    // Step 2: if none found, navigate to each resident sub-page.
    if (Object.keys(found).length === 0) {
      console.log('No f= links on landing page — checking resident sub-pages…');

      // Collect every link that looks like a resident profile page.
      // Medrez resident links typically carry a numeric or alphanumeric
      // id parameter (r=, p=, id=, u=) but NOT the group token (a=).
      const residentLinks = await page.evaluate((baseUrl) => {
        const seen = new Set();
        const links = [];
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.href;
          // Must be same host, contain view.php, and have a param other than a=
          if (!href.includes('medrez.net')) continue;
          if (!href.includes('view.php')) continue;
          if (/[?&]a=/.test(href)) continue; // skip the group viewer itself
          if (seen.has(href)) continue;
          seen.add(href);
          links.push({ href, text: a.textContent.trim().replace(/\s+/g, ' ') });
        }
        return links;
      }, MEDREZ_URL);

      console.log(`Found ${residentLinks.length} candidate resident link(s).`);

      for (const { href, text } of residentLinks) {
        try {
          console.log(`  Visiting: ${href}`);
          await page.goto(href, { waitUntil: 'networkidle2', timeout: 15_000 });
          const subFound = await extractFTokens(page);
          for (const [token, nearby] of Object.entries(subFound)) {
            if (!found[token]) found[token] = text || nearby;
          }
        } catch (err) {
          console.warn(`  Could not load ${href}: ${err.message}`);
        }
      }
    }

    const tokens = Object.entries(found); // [[token, nearbyText], ...]
    console.log(`Found ${tokens.length} unique resident token(s) total.`);
    return tokens;

  } finally {
    await browser.close();
  }
}

// ── Google Sheets ─────────────────────────────────────────────────
async function getSheetsClient() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function writeResidentsToSheet(sheets, spreadsheetId, entries) {
  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${ROSTER_TAB}!1:1`,
  });
  const headers = (sheetRes.data.values?.[0] || [])
    .map(h => String(h).trim().toLowerCase());

  const col = name => {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error(`roster tab missing column: ${name}`);
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
  const allRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: ROSTER_TAB,
  });
  const rows = allRes.data.values || [];

  // Find 1-based row indices of existing resident rows (skip header).
  const toDelete = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][roleCol] || '').trim().toLowerCase() === RESIDENT_ROLE) {
      toDelete.push(i + 1); // 1-based sheet row
    }
  }

  // Delete bottom-up via batchUpdate.
  if (toDelete.length) {
    console.log(`Deleting ${toDelete.length} existing resident rows…`);
    const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId });
    const rosterSheet = sheetMeta.data.sheets.find(
      s => s.properties.title === ROSTER_TAB
    );
    const sheetId = rosterSheet.properties.sheetId;
    const requests = toDelete.reverse().map(rowNum => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: rowNum - 1,
          endIndex: rowNum,
        },
      },
    }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }

  if (!entries.length) { console.log('No entries to append.'); return 0; }

  // Build rows to append.
  const width = headers.length;
  const newRows = entries.map(e => {
    const row = new Array(width).fill('');
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = RESIDENT_ROLE;
    row[nameCol]  = e.name;
    if (titleCol >= 0) row[titleCol] = e.title     || '';
    if (photoCol >= 0) row[photoCol] = e.photo_url || '';
    if (notesCol >= 0) row[notesCol] = e.notes     || '';
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

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const spreadsheetId = process.env.CANONICAL_SHEET_ID;
  if (!spreadsheetId)  throw new Error('CANONICAL_SHEET_ID env var is required.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required.');

  // Step 1: get resident subscription tokens from Medrez DOM.
  const tokens = await scrapeResidentTokens();

  if (!tokens.length) {
    console.error('No resident links found. Check medrez-debug.png for the page state.');
    process.exit(1);
  }

  // Step 2: fetch ICS for each token and parse shifts.
  const allEntries = [];
  const errors     = [];

  for (const [token, nearbyText] of tokens) {
    const url = `http://www.medrez.net/view.php?f=${token}`;
    try {
      const { status, body } = await fetchUrl(url);
      if (status !== 200 || body.indexOf('BEGIN:VCALENDAR') < 0) {
        throw new Error(`HTTP ${status} / not ICS`);
      }

      // Extract name: prefer ICS DESCRIPTION, fall back to DOM nearby text.
      const firstEvent = extractVevents(body)[0] || '';
      const desc       = icsField(firstEvent, 'DESCRIPTION') || '';
      const name       = nameFromDescription(desc) || nearbyText.slice(0, 60) || token;

      // Extract R-level from DESCRIPTION if possible.
      const titleMatch = desc.match(/\b(R[1-4])\b/i);
      const title      = titleMatch ? titleMatch[1].toUpperCase() : '';

      const entries = parseResidentIcs(body, name, title);
      console.log(`  ${name} (${title || '?'}): ${entries.length} shifts`);
      allEntries.push(...entries);

      // Brief pause to be gentle with the server.
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      errors.push(`${token}: ${err.message}`);
      console.warn(`  WARNING ${token}: ${err.message}`);
    }
  }

  if (errors.length) {
    console.warn(`\n${errors.length} feed error(s):\n${errors.join('\n')}`);
  }

  // Step 3: write to canonical sheet.
  const sheets = await getSheetsClient();
  const n = await writeResidentsToSheet(sheets, spreadsheetId, allEntries);

  console.log(`\nDone. ${n} resident shift rows written to sheet.`);
}

main().catch(err => { console.error(err); process.exit(1); });
