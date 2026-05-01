'use strict';

/**
 * HGH Attending Schedule Sync
 * ----------------------------
 * Uses Puppeteer to scrape two sites:
 *   1. QGenda public schedule link → attending shifts (date, time/shift, name)
 *   2. highlandemergency.org/faculty/ → attending headshots
 *
 * Persists headshots to GitHub Pages (bypassing CDN expiry), then writes
 * attending shift rows to the canonical Google Sheet roster tab.
 *
 * Runs in GitHub Actions on a daily schedule. Can also be run locally:
 *   CANONICAL_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...' node index.js
 */

const { ensurePhotoInPages } = require('../lib/github-photos');
const puppeteer  = require('puppeteer');
const { google } = require('googleapis');

const QGENDA_URL    = 'https://app.qgenda.com/Link/view?linkKey=f175f5fe-1111-4da4-8e80-09b3d6b90a98';
const FACULTY_URL   = 'https://www.highlandemergency.org/faculty/';
const ROSTER_TAB    = 'roster';
const ATTENDING_ROLE = 'attending';
const DAYS_BEHIND   = 1;
const DAYS_AHEAD    = 60;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Returns a date range [from, to] as ISO strings.
function dateWindow() {
  const today = new Date();
  const from  = new Date(today); from.setDate(from.getDate() - DAYS_BEHIND);
  const to    = new Date(today); to.setDate(to.getDate() + DAYS_AHEAD);
  return { from: isoDate(from), to: isoDate(to) };
}

// Detect shift bucket from an hour integer (0-23) or a time string.
function detectShiftFromHour(h) {
  const hour = parseInt(h, 10);
  if (isNaN(hour)) return 'day';
  if (hour >= 23 || hour < 7) return 'night';
  if (hour >= 15)              return 'evening';
  return 'day';
}

function detectShiftFromTimeStr(timeStr) {
  if (!timeStr) return 'day';
  const s = String(timeStr).trim();
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const ampm = m[3].toLowerCase();
    if (ampm === 'pm' && h !== 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    return detectShiftFromHour(h);
  }
  // 24-hour "HH:MM"
  const m2 = s.match(/^(\d{1,2}):/);
  if (m2) return detectShiftFromHour(m2[1]);
  // Named shifts
  const lower = s.toLowerCase();
  if (/night|noc|overnight/i.test(lower)) return 'night';
  if (/eve|pm|swing/i.test(lower))        return 'evening';
  return 'day';
}

// Normalize a name for fuzzy matching: strip credentials, separators → spaces,
// lowercase, sort words so "Smith, John MD" ≡ "John Smith".
const CREDENTIAL_RE = /\b(md|do|phd|mph|facp|facep|ms|rn|np|pa|c)\b\.?/gi;
function normalizeName(s) {
  return s
    .replace(/\.[^.]+$/, '')
    .replace(CREDENTIAL_RE, ' ')
    .replace(/[_,\-]+/g, ' ')
    .toLowerCase().trim()
    .split(/\s+/).filter(Boolean).sort()
    .join(' ');
}

// Parse a date string in various formats → "YYYY-MM-DD" or null.
function parseAnyDate(s) {
  if (!s) return null;
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`;
  // "Mon Jan 5 2026", "Monday, January 5, 2026", etc.
  const d = new Date(s);
  if (!isNaN(d.getTime())) return isoDate(d);
  return null;
}

// ── QGenda scraper ────────────────────────────────────────────────────────────

async function scrapeQGenda(browser) {
  console.log('Navigating to QGenda…');
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  await page.goto(QGENDA_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

  // Wait for schedule content — QGenda uses Angular/React; elements vary by
  // view. Try several selectors that cover the list/grid views.
  const SCHEDULE_SELECTORS = [
    '[class*="schedule"]',
    '[class*="Schedule"]',
    '[class*="shift"]',
    '[class*="Shift"]',
    '[class*="task"]',
    '[class*="Task"]',
    'table',
    '.calendar',
  ];
  for (const sel of SCHEDULE_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 8_000 });
      console.log(`QGenda: found selector "${sel}"`);
      break;
    } catch { /* try next */ }
  }

  // Screenshot for debugging.
  await page.screenshot({ path: 'qgenda-debug.png', fullPage: false }).catch(() => {});

  // --- Strategy 1: extract from Angular/React in-memory store ---
  const storeEntries = await page.evaluate(() => {
    // QGenda sometimes exposes schedule data on the window or Angular scopes.
    const results = [];

    // Try Angular scope
    try {
      const elements = document.querySelectorAll('[ng-controller], [data-ng-controller]');
      for (const el of elements) {
        const scope = window.angular?.element(el)?.scope?.();
        if (!scope) continue;
        const sched = scope.schedule || scope.tasks || scope.shifts || scope.events;
        if (Array.isArray(sched)) {
          for (const item of sched) {
            results.push({ _src: 'angular', ...item });
          }
        }
      }
    } catch { /* not Angular */ }

    // Try window.__DATA__ / window.initialData style stores
    for (const key of ['__DATA__', '__INITIAL_STATE__', '__APP_STATE__', 'qgendaData', 'scheduleData']) {
      try {
        const d = window[key];
        if (d) results.push({ _src: key, data: JSON.stringify(d).slice(0, 2000) });
      } catch { /* skip */ }
    }

    return results;
  });

  // --- Strategy 2: parse visible DOM table/list rows ---
  const domEntries = await page.evaluate(() => {
    const rows = [];

    // Look for table rows
    const trEls = document.querySelectorAll('tr');
    for (const tr of trEls) {
      const cells = Array.from(tr.querySelectorAll('td,th')).map(c => c.innerText.trim());
      if (cells.length >= 2) rows.push({ _src: 'table', cells });
    }

    // Look for named shift/event elements
    const eventEls = document.querySelectorAll(
      '[class*="event"],[class*="Event"],[class*="task"],[class*="Task"],' +
      '[class*="shift"],[class*="Shift"],[class*="schedule-item"],[class*="ScheduleItem"],' +
      '[class*="assignment"],[class*="Assignment"]'
    );
    for (const el of eventEls) {
      rows.push({ _src: 'event', text: el.innerText.trim(), html: el.innerHTML.slice(0, 500) });
    }

    return rows;
  });

  // --- Strategy 3: intercept any XHR/JSON response from QGenda API ---
  // We also try to capture any network responses that look like schedule JSON.
  // (These were captured via requestfinished events if we set up interception.)

  // Dump raw page text for analysis.
  const pageText = await page.evaluate(() => document.body.innerText);
  await page.close();

  console.log(`QGenda DOM rows: ${domEntries.length}, store entries: ${storeEntries.length}`);
  console.log('QGenda page text sample:', pageText.slice(0, 800).replace(/\s+/g, ' '));

  // Parse entries from DOM data.
  const { from, to } = dateWindow();
  const entries = parseQGendaDom(domEntries, storeEntries, pageText, from, to);
  console.log(`QGenda entries parsed: ${entries.length}`);
  return entries;
}

// Parse raw DOM data from QGenda into canonical shift entries.
function parseQGendaDom(domEntries, _storeEntries, pageText, fromDate, toDate) {
  const entries = [];
  const seen    = new Set();

  // Try to pull structured date + name + time from event elements.
  // QGenda's list view typically renders rows like:
  //   "Mon Jan  5\nDay Shift\nDr. Jane Smith\n7:00 AM – 3:00 PM"
  // or a table with columns: Date | Provider | Task | Start | End
  const ISO_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
  const DATE_FRAG_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?/i;

  let currentDate = null;

  // Walk the event elements looking for dates and names.
  for (const row of domEntries) {
    if (row._src === 'table') {
      // Table row: cells[0] might be date, cells[1] might be name, cells[2] time, etc.
      const cells = row.cells || [];
      let date = null, name = null, timeStr = '';
      for (const cell of cells) {
        if (!date) { date = parseAnyDate(cell); }
        if (!name && cell.length > 2 && cell.length < 80 &&
            !/^\d/.test(cell) && !parseAnyDate(cell)) {
          // Likely a name cell.
          name = cell;
        }
        if (!timeStr && /\d{1,2}:\d{2}|\bam\b|\bpm\b/i.test(cell)) timeStr = cell;
      }
      if (date && name && date >= fromDate && date <= toDate) {
        const shift = detectShiftFromTimeStr(timeStr);
        const key   = `${date}|${shift}|${normalizeName(name)}`;
        if (!seen.has(key)) {
          seen.add(key);
          entries.push({ date, shift, name: name.trim(), timeStr });
        }
      }
      continue;
    }

    // Event/text elements — parse free-form text.
    const text = (row.text || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 3) continue;

    // Try to extract a date from the text.
    const isoMatch = text.match(ISO_RE);
    if (isoMatch) {
      currentDate = isoMatch[1];
    } else {
      const fragMatch = text.match(DATE_FRAG_RE);
      if (fragMatch) currentDate = parseAnyDate(fragMatch[0]);
    }

    if (!currentDate || currentDate < fromDate || currentDate > toDate) continue;

    // Extract time (for shift detection).
    const timeMatch = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
    const timeStr   = timeMatch ? timeMatch[1] : '';
    const shift     = detectShiftFromTimeStr(timeStr);

    // Extract names — look for "Dr. Firstname Lastname" patterns or just
    // multi-word capitalized sequences that aren't dates/times.
    const nameMatches = text.match(/(?:Dr\.?\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){1,3})(?:\s*(?:MD|DO|PhDd|MPH|FACEP)\.?)?/g) || [];
    for (const nm of nameMatches) {
      const clean = nm.replace(/^Dr\.?\s+/i, '').replace(CREDENTIAL_RE, '').trim();
      if (!clean || clean.split(/\s+/).length < 2) continue;
      // Skip if it looks like a date phrase.
      if (/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i.test(clean)) continue;
      const key = `${currentDate}|${shift}|${normalizeName(clean)}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ date: currentDate, shift, name: clean.trim(), timeStr });
      }
    }
  }

  // Also parse the raw page text as a fallback using the same line-by-line approach.
  if (entries.length === 0) {
    console.log('Falling back to full page text parsing…');
    const lines = pageText.split(/\n/).map(l => l.trim()).filter(Boolean);
    let lineDate = null;
    let lineTime = '';
    for (const line of lines) {
      const isoM = line.match(ISO_RE);
      if (isoM) { lineDate = isoM[1]; lineTime = ''; continue; }
      const fragM = line.match(DATE_FRAG_RE);
      if (fragM) { lineDate = parseAnyDate(fragM[0]); lineTime = ''; continue; }
      const timeM = line.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
      if (timeM) { lineTime = timeM[1]; continue; }
      if (!lineDate || lineDate < fromDate || lineDate > toDate) continue;
      // Name candidate: 2–4 capitalized words, 5–50 chars, not a known UI label.
      if (/^[A-Z][a-z]+(\s+[A-Z][a-z'-]+){1,3}$/.test(line) && line.length <= 50) {
        const shift = detectShiftFromTimeStr(lineTime);
        const key   = `${lineDate}|${shift}|${normalizeName(line)}`;
        if (!seen.has(key)) {
          seen.add(key);
          entries.push({ date: lineDate, shift, name: line, timeStr: lineTime });
        }
      }
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return entries;
}

// ── Faculty photo scraper ─────────────────────────────────────────────────────

async function scrapeFacultyPhotos(browser) {
  console.log('Navigating to Highland Emergency faculty page…');
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  // Some faculty pages block headless bots; set realistic headers.
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });

  await page.goto(FACULTY_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

  // Screenshot for debugging.
  await page.screenshot({ path: 'faculty-debug.png', fullPage: false }).catch(() => {});

  // Wait for faculty cards to render.
  const FACULTY_SELECTORS = [
    '[class*="faculty"]', '[class*="Faculty"]',
    '[class*="team"]',    '[class*="Team"]',
    '[class*="staff"]',   '[class*="Staff"]',
    '[class*="provider"]','[class*="Provider"]',
    '.person', '.people-item', '.member',
    'article', '.card',
  ];
  for (const sel of FACULTY_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 6_000 });
      console.log(`Faculty: found selector "${sel}"`);
      break;
    } catch { /* try next */ }
  }

  const photos = await page.evaluate(() => {
    const result = {};

    // Walk every element that might be a faculty card.
    const candidates = document.querySelectorAll(
      '[class*="faculty"],[class*="Faculty"],[class*="team"],[class*="Team"],' +
      '[class*="staff"],[class*="Staff"],[class*="person"],[class*="provider"],' +
      'article,.card,.people-item,.member-item'
    );

    // Helper: given an element, find the best image src within it.
    function bestImg(el) {
      const imgs = el.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.getAttribute('data-src') || img.getAttribute('src') || '';
        // Skip tiny icons (likely < 50px) and SVG placeholders.
        if (!src || src.startsWith('data:') || src.endsWith('.svg')) continue;
        if (img.naturalWidth > 0 && img.naturalWidth < 30) continue;
        return src;
      }
      // Also look for CSS background-image.
      const bg = window.getComputedStyle(el).backgroundImage;
      const m  = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
      return m ? m[1] : '';
    }

    // Helper: find the best name text in a card element.
    function bestName(el) {
      // Prefer heading tags.
      for (const tag of ['h1','h2','h3','h4','h5','strong','b']) {
        const node = el.querySelector(tag);
        if (node) {
          const t = node.innerText.trim();
          if (t && t.length > 2 && t.length < 80) return t;
        }
      }
      // Fall back to the element's own text, taking only the first line.
      return el.innerText.split('\n')[0].trim();
    }

    for (const card of candidates) {
      const name = bestName(card);
      const img  = bestImg(card);
      if (!name || !img) continue;
      // Skip very generic or UI labels.
      if (/^(home|about|menu|nav|header|footer|contact)$/i.test(name)) continue;
      result[name] = img;
    }

    // If no card-level matches, scan for any img with an alt that looks like a name.
    if (Object.keys(result).length === 0) {
      const allImgs = document.querySelectorAll('img[alt]');
      for (const img of allImgs) {
        const alt = img.alt.trim();
        const src = img.getAttribute('data-src') || img.src || '';
        if (!src || src.startsWith('data:') || alt.length < 3 || alt.length > 80) continue;
        // Alt text that looks like a person name (2+ words, mostly letters).
        if (/^[A-Za-z][a-zA-Z'\-]+(\s+[A-Za-z'\-]+){1,4}$/.test(alt)) {
          result[alt] = src;
        }
      }
    }

    return result;
  });

  await page.close();

  // Resolve relative URLs to absolute.
  const base = new URL(FACULTY_URL);
  const normalized = {};
  for (const [name, src] of Object.entries(photos)) {
    try {
      const abs = new URL(src, base).href;
      normalized[normalizeName(name)] = abs;
    } catch { /* skip invalid URLs */ }
  }

  console.log(`Faculty photos scraped: ${Object.keys(normalized).length}`);
  if (Object.keys(normalized).length) {
    console.log('  Sample:', Object.entries(normalized).slice(0, 3)
      .map(([k, v]) => `${k}: ${v}`).join(', '));
  }
  return normalized;
}

// ── GitHub Pages photo persistence ───────────────────────────────────────────

async function persistAttendingPhotos(photoMap) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('GITHUB_TOKEN not set — skipping GitHub Pages photo persistence.');
    return photoMap;
  }

  const persisted = {};
  let hits = 0, skipped = 0;

  for (const [key, url] of Object.entries(photoMap)) {
    if (!url) { persisted[key] = url; skipped++; continue; }
    const fileKey = key.replace(/ /g, '-');
    try {
      persisted[key] = await ensurePhotoInPages(fileKey, url, 'photos/attendings');
      hits++;
    } catch (err) {
      console.warn(`  Photo persistence failed for "${key}":`, err.message);
      persisted[key] = url; // fall back to source URL
    }
  }

  console.log(`Attending photos persisted to GitHub Pages: ${hits} (${skipped} skipped).`);
  return persisted;
}

// ── Google API ────────────────────────────────────────────────────────────────

async function getAuth() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// ── Google Sheets write ───────────────────────────────────────────────────────

async function writeAttendingsToSheet(sheets, spreadsheetId, entries, photoMap) {
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

  // Read all existing rows to find and delete attending rows.
  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: ROSTER_TAB });
  const rows   = allRes.data.values || [];

  const toDelete    = [];
  const savedPhotos = {}; // normalised name → existing photo_url
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][roleCol] || '').trim().toLowerCase() === ATTENDING_ROLE) {
      toDelete.push(i + 1);
      if (photoCol >= 0) {
        const name  = normalizeName(String(rows[i][nameCol] || ''));
        const photo = String(rows[i][photoCol] || '').trim();
        if (name && photo) savedPhotos[name] = photo;
      }
    }
  }
  console.log(`Preserved photo_url for ${Object.keys(savedPhotos).length} attending(s) already in sheet.`);

  // Delete existing attending rows bottom-up.
  if (toDelete.length) {
    console.log(`Deleting ${toDelete.length} existing attending rows…`);
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

  if (!entries.length) { console.log('No attending entries to append.'); return 0; }

  // Build last-name index for fuzzy photo matching.
  const photoByLast = {};
  for (const [key, url] of Object.entries(photoMap)) {
    const words = key.split(' ');
    const last  = words[words.length - 1];
    if (last && !photoByLast[last]) photoByLast[last] = url;
  }

  const resolvePhoto = (name) => {
    const key  = normalizeName(name);
    const last = name.trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g, '');
    return photoMap[key] || photoByLast[last] || savedPhotos[key] || '';
  };

  let photoHits = 0;
  const width   = headers.length;
  const newRows = entries.map(e => {
    const row   = new Array(width).fill('');
    const photo = resolvePhoto(e.name);
    if (photo) photoHits++;
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = ATTENDING_ROLE;
    row[nameCol]  = e.name;
    if (titleCol >= 0) row[titleCol] = '';
    if (photoCol >= 0) row[photoCol] = photo;
    if (notesCol >= 0) row[notesCol] = e.timeStr || '';
    return row;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: ROSTER_TAB,
    valueInputOption: 'RAW',
    requestBody: { values: newRows },
  });

  console.log(`Appended ${newRows.length} attending shift rows (${photoHits} with photo_url).`);
  return newRows.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const spreadsheetId = process.env.CANONICAL_SHEET_ID;
  if (!spreadsheetId)
    throw new Error('CANONICAL_SHEET_ID env var is required.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required.');

  console.log('Launching Puppeteer…');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });

  let entries = [], rawPhotos = {};

  try {
    [entries, rawPhotos] = await Promise.all([
      scrapeQGenda(browser),
      scrapeFacultyPhotos(browser),
    ]);
  } finally {
    await browser.close();
  }

  if (!entries.length) {
    console.warn('WARNING: No attending entries found in QGenda — check qgenda-debug.png.');
    // Continue anyway so we don't wipe the sheet if scraping failed silently.
  }

  // Persist faculty headshots to GitHub Pages.
  const photoMap = await persistAttendingPhotos(rawPhotos).catch(err => {
    console.warn('GitHub Pages photo persistence failed (falling back to source URLs):', err.message);
    return rawPhotos;
  });

  const auth   = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const n = await writeAttendingsToSheet(sheets, spreadsheetId, entries, photoMap);
  console.log(`\nDone. ${n} attending shift rows written to sheet.`);
}

main().catch(err => { console.error(err); process.exit(1); });
