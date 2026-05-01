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

const QGENDA_URL     = 'https://app.qgenda.com/Link/view?linkKey=f175f5fe-1111-4da4-8e80-09b3d6b90a98';
const FACULTY_URL    = 'https://www.highlandemergency.org/faculty/';
const ROSTER_TAB     = 'roster';
const ATTENDING_ROLE = 'attending';
const DAYS_BEHIND    = 1;
const DAYS_AHEAD     = 60;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function dateWindow() {
  const today = new Date();
  const from  = new Date(today); from.setDate(from.getDate() - DAYS_BEHIND);
  const to    = new Date(today); to.setDate(to.getDate() + DAYS_AHEAD);
  return { from: isoDate(from), to: isoDate(to) };
}

// Map a start-time string from QGenda (e.g. "7a", "3p", "11p", "9a") → shift bucket.
function shiftFromTime(timeStr) {
  if (!timeStr) return 'day';
  const m = String(timeStr).match(/(\d{1,2})(a|p)/i);
  if (!m) return 'day';
  let h = parseInt(m[1], 10);
  if (m[2].toLowerCase() === 'p' && h !== 12) h += 12;
  if (m[2].toLowerCase() === 'a' && h === 12) h = 0;
  if (h >= 23 || h < 7) return 'night';
  if (h >= 15)           return 'evening';
  return 'day';
}

// Map a QGenda shift label to a shift bucket when there's no reliable time.
const SHIFT_LABEL_MAP = {
  'backup':  'day',
  'day':     'day',
  'pit':     'day',
  'swing':   'evening',
  'night':   'night',
  'noc':     'night',
  'evening': 'evening',
  'eve':     'evening',
};
function shiftFromLabel(label) {
  const k = String(label || '').toLowerCase();
  for (const [prefix, bucket] of Object.entries(SHIFT_LABEL_MAP)) {
    if (k.startsWith(prefix)) return bucket;
  }
  return 'day';
}

// Normalise a name for photo lookup: lowercase + sort words.
// QGenda names are abbreviated ("S. Miller"); faculty names are full ("Sarah Miller").
// We index faculty photos by last name only as the primary key.
const CREDENTIAL_RE = /\b(md|do|phd|mph|facp|facep|rn|np|pa)\b\.?/gi;
function normalizeName(s) {
  return s
    .replace(/\.[^.]+$/, '')
    .replace(CREDENTIAL_RE, ' ')
    .replace(/[_,\-]+/g, ' ')
    .toLowerCase().trim()
    .split(/\s+/).filter(Boolean).sort()
    .join(' ');
}

// Extract the last word of a name as a last-name key (strips credentials first).
function lastName(s) {
  const clean = s.replace(CREDENTIAL_RE, '').replace(/[.,]/g, '').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  return (words[words.length - 1] || '').toLowerCase();
}

// Parse QGenda header text ("MON APR 27", "FRIDAY MAY 1") → "YYYY-MM-DD" or null.
const MONTH_NUM = {
  jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
};
function parseDateHeader(text) {
  const m = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if (!m) return null;
  const mon = MONTH_NUM[m[1].toLowerCase().slice(0, 3)];
  const day = parseInt(m[2], 10);
  // If the year is not in the header, infer it from today (handle year boundary).
  let year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  // If the parsed date (without year) is far in the past, assume next year.
  const probe = new Date(`${year}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`);
  if (probe < new Date(Date.now() - 90 * 86400_000)) year++;
  return `${year}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
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

  // QGenda is Angular — wait for the calendar grid to appear.
  // The date headers contain day-of-week text (MON, TUE, etc.).
  try {
    await page.waitForFunction(
      () => document.body.innerText.match(/\b(MON|TUE|WED|THU|FRI|SAT|SUN)\b/),
      { timeout: 30_000 }
    );
  } catch {
    console.warn('QGenda: timed out waiting for calendar text; proceeding anyway.');
  }

  await page.screenshot({ path: 'qgenda-debug.png', fullPage: true }).catch(() => {});

  // Extract structured calendar data from the DOM.
  // QGenda renders a grid: column per day, shift blocks within each column.
  // We walk every element looking for date-header and shift-block patterns.
  const rawCells = await page.evaluate(() => {
    const results = [];

    // ── Try structured column extraction ──────────────────────────────────
    // QGenda typically renders something like:
    //   <div class="...day-column...">
    //     <div class="...day-header...">MON APR 27</div>
    //     <div class="...task...">
    //       <span class="label">Day A</span>
    //       <span class="time">7a - 4p</span>
    //       <span class="staff">C. Bailey</span>
    //     </div>
    //     ...
    //   </div>
    //
    // We collect every leaf text node and its bounding rect to later group
    // by x-position (column).

    function textLeaves(root) {
      const out = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent.trim();
        if (!t) continue;
        const el = n.parentElement;
        if (!el) continue;
        const tag = el.tagName.toLowerCase();
        if (['script','style','noscript','head'].includes(tag)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        out.push({ text: t, x: Math.round(rect.left), y: Math.round(rect.top) });
      }
      return out;
    }

    return textLeaves(document.body);
  });

  await page.close();

  const { from, to } = dateWindow();
  const entries = parseQGendaCells(rawCells, from, to);
  console.log(`QGenda entries parsed: ${entries.length}`);
  return entries;
}

// Group text leaves by x-column (±20px tolerance), then parse each column
// as a vertical list of: date header → (shift label, time, name) triplets.
function parseQGendaCells(cells, fromDate, toDate) {
  if (!cells.length) return [];

  // Cluster by x-position into columns.
  const COL_TOLERANCE = 25;
  const columns = []; // [{ x, items[] }]
  for (const cell of cells) {
    let col = columns.find(c => Math.abs(c.x - cell.x) <= COL_TOLERANCE);
    if (!col) { col = { x: cell.x, items: [] }; columns.push(col); }
    col.items.push(cell);
  }

  // Sort columns left-to-right, items top-to-bottom.
  columns.sort((a, b) => a.x - b.x);
  for (const col of columns) col.items.sort((a, b) => a.y - b.y);

  const entries = [];
  const seen    = new Set();

  for (const col of columns) {
    // Find the date header for this column.
    let colDate = null;
    for (const item of col.items) {
      const d = parseDateHeader(item.text);
      if (d) { colDate = d; break; }
    }
    if (!colDate || colDate < fromDate || colDate > toDate) continue;

    // Walk items looking for shift blocks.
    // Pattern: a shift-label line (e.g. "Day A"), an optional time line
    // (e.g. "7a - 4p"), then a name line (e.g. "C. Bailey").
    const SHIFT_LABEL_RE = /^(Backup|Day\s*[A-Z]?|PIT|Swing\s*[A-Z]?|Night|Day Shift|SLH PIT|FST|HGH|Noc)/i;
    const TIME_RE        = /(\d{1,2}[ap])\s*[-–]\s*(\d{1,2}[ap])/i;
    const NAME_RE        = /^[A-Z][a-z]+\.?\s+[A-Z][a-z']+/; // "C. Bailey" or "Sarah Miller"

    let pendingLabel = null;
    let pendingTime  = null;

    for (const item of col.items) {
      const t = item.text.trim();
      if (!t || t.length > 60) continue;

      if (SHIFT_LABEL_RE.test(t)) {
        pendingLabel = t;
        pendingTime  = null;
        continue;
      }

      const timeMatch = t.match(TIME_RE);
      if (timeMatch && pendingLabel) {
        pendingTime = timeMatch[1]; // start time, e.g. "7a"
        continue;
      }

      // Name line: "C. Bailey", "M. Montgomery", "A. Herring", etc.
      if (NAME_RE.test(t) && pendingLabel) {
        const shift = pendingTime
          ? shiftFromTime(pendingTime)
          : shiftFromLabel(pendingLabel);
        const key = `${colDate}|${shift}|${t.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          entries.push({
            date:      colDate,
            shift,
            name:      t,
            shiftLabel: pendingLabel,
          });
        }
        // Reset: keep label for the next name if time was just updated.
        pendingTime = null;
        pendingLabel = null;
        continue;
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
  page.setDefaultTimeout(90_000);

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });

  await page.goto(FACULTY_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

  // WordPress sites often continue loading after networkidle2 fires.
  // Wait for the loading spinner to disappear or for actual content to appear.
  try {
    // Wait for any WordPress loading overlay to go away.
    await page.waitForFunction(
      () => {
        const spinners = document.querySelectorAll(
          '.loading,.loader,.spinner,[class*="loading"],[class*="spinner"],[class*="preloader"]'
        );
        for (const s of spinners) {
          const style = window.getComputedStyle(s);
          if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
            return false;
          }
        }
        return true;
      },
      { timeout: 30_000 }
    );
  } catch { /* spinner check timed out — proceed anyway */ }

  // Also wait for at least one image with a person-like alt text or an
  // element that looks like a faculty card.
  const CONTENT_SELECTORS = [
    '[class*="faculty"]', '[class*="Faculty"]',
    '[class*="team-member"]', '[class*="TeamMember"]',
    '[class*="staff"]', '[class*="people"]',
    '.et_pb_team_member', // Divi theme
    '.elementor-widget-team-member', // Elementor
    'img[alt*="MD"]', 'img[alt*="DO"]',
    '.wp-block-group img',
    'article img',
  ];
  for (const sel of CONTENT_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 8_000 });
      console.log(`Faculty: content ready via "${sel}"`);
      break;
    } catch { /* try next */ }
  }

  // Scroll to the bottom to trigger lazy-loaded images.
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let last = 0;
      const id = setInterval(() => {
        window.scrollBy(0, 600);
        if (document.body.scrollTop === last) { clearInterval(id); resolve(); }
        last = document.body.scrollTop;
      }, 200);
      setTimeout(() => { clearInterval(id); resolve(); }, 5000);
    });
    window.scrollTo(0, 0);
  });

  await page.screenshot({ path: 'faculty-debug.png', fullPage: true }).catch(() => {});

  const photos = await page.evaluate((facultyUrl) => {
    const result = {};

    function absoluteUrl(src) {
      if (!src) return '';
      try { return new URL(src, facultyUrl).href; } catch { return ''; }
    }

    function bestImg(el) {
      // Prefer data-src (lazy-loaded) then src.
      const imgs = el.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') ||
                    img.getAttribute('data-srcset') || img.src || '';
        if (!src || src.startsWith('data:') || src.includes('placeholder') || src.endsWith('.svg')) continue;
        // Skip very small icons.
        if (img.naturalWidth > 0 && img.naturalWidth < 40) continue;
        return src;
      }
      // CSS background image fallback.
      const all = [el, ...el.querySelectorAll('*')];
      for (const node of all) {
        const bg = window.getComputedStyle(node).backgroundImage || '';
        const m  = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (m && !m[1].startsWith('data:') && !m[1].endsWith('.svg')) return m[1];
      }
      return '';
    }

    function bestName(el) {
      // Prefer heading tags, then strong/b, then first line of text.
      for (const tag of ['h1','h2','h3','h4','h5','h6','strong','b']) {
        for (const node of el.querySelectorAll(tag)) {
          const t = node.innerText.replace(/\s+/g, ' ').trim();
          if (t.length >= 4 && t.length <= 80) return t;
        }
      }
      return el.innerText.split(/\n/)[0].replace(/\s+/g, ' ').trim();
    }

    // ── Strategy 1: look for Divi / Elementor / Genesis team-member blocks ──
    const CARD_SELECTORS = [
      '.et_pb_team_member',
      '.elementor-widget-team-member',
      '[class*="team-member"]',
      '[class*="TeamMember"]',
      '[class*="faculty-member"]',
      '[class*="faculty_member"]',
      '[class*="faculty-card"]',
      '[class*="staff-member"]',
      '.person',
      '.people-item',
      '.member',
    ];
    for (const sel of CARD_SELECTORS) {
      const cards = document.querySelectorAll(sel);
      if (!cards.length) continue;
      for (const card of cards) {
        const name = bestName(card);
        const img  = absoluteUrl(bestImg(card));
        if (name && img) result[name] = img;
      }
      if (Object.keys(result).length > 0) break;
    }

    // ── Strategy 2: generic article/section blocks that contain a person image + heading ──
    if (Object.keys(result).length === 0) {
      const blocks = document.querySelectorAll('article, section, .wp-block-group, li');
      for (const block of blocks) {
        const img  = absoluteUrl(bestImg(block));
        const name = bestName(block);
        if (!img || !name || name.length < 4 || name.length > 80) continue;
        // Must look like a person name: 2+ words, starts uppercase.
        if (/^[A-Z][a-z]/.test(name) && name.split(/\s+/).length >= 2) {
          result[name] = img;
        }
      }
    }

    // ── Strategy 3: scan all imgs whose alt text looks like a person name ──
    if (Object.keys(result).length === 0) {
      for (const img of document.querySelectorAll('img[alt]')) {
        const alt = img.alt.trim();
        const src = absoluteUrl(img.getAttribute('data-src') || img.src || '');
        if (!src || src.startsWith('data:') || alt.length < 4 || alt.length > 80) continue;
        if (/^[A-Z][a-z]+(\s+[A-Za-z'\-]+){1,4}$/.test(alt)) {
          result[alt] = src;
        }
      }
    }

    return result;
  }, FACULTY_URL);

  await page.close();

  // Normalize keys: build both full-name and last-name indexes.
  const byFull = {};
  const byLast = {};
  for (const [name, url] of Object.entries(photos)) {
    if (!url) continue;
    const full = normalizeName(name);
    const last = lastName(name);
    byFull[full] = url;
    if (last && !byLast[last]) byLast[last] = url;
  }

  console.log(`Faculty photos scraped: ${Object.keys(byFull).length} (${Object.keys(byLast).length} by last name)`);
  if (Object.keys(byLast).length) {
    console.log('  Last-name index sample:', Object.keys(byLast).slice(0, 5).join(', '));
  }
  return { byFull, byLast };
}

// ── GitHub Pages photo persistence ───────────────────────────────────────────

async function persistAttendingPhotos({ byFull, byLast }) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('GITHUB_TOKEN not set — skipping GitHub Pages photo persistence.');
    return { byFull, byLast };
  }

  const newFull = {};
  const newLast = {};
  let hits = 0, skipped = 0;

  for (const [key, url] of Object.entries(byFull)) {
    const fileKey = key.replace(/ /g, '-');
    let pageUrl = url;
    try {
      pageUrl = await ensurePhotoInPages(fileKey, url, 'photos/attendings');
      hits++;
    } catch (err) {
      console.warn(`  Photo persistence failed for "${key}":`, err.message);
      skipped++;
    }
    newFull[key] = pageUrl;
    // Update byLast to point to the same persisted URL.
    const last = key.split(' ').pop(); // normalized key words are sorted; last alphabetically
    // Rebuild byLast from byFull correctly below.
  }

  // Rebuild byLast from persisted byFull.
  for (const [name, url] of Object.entries(byFull)) {
    // `name` here is the normalized (sorted words) key; reconstruct last name
    // from byLast entries that map to this photo.
  }
  // Simpler: rebuild byLast directly.
  for (const [last, origUrl] of Object.entries(byLast)) {
    // Find the corresponding full key.
    const fullKey = Object.keys(byFull).find(k => k.split(' ').includes(last));
    newLast[last] = fullKey ? (newFull[fullKey] || origUrl) : origUrl;
  }

  console.log(`Attending photos persisted to GitHub Pages: ${hits} stored, ${skipped} failed/skipped.`);
  return { byFull: newFull, byLast: newLast };
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

async function writeAttendingsToSheet(sheets, spreadsheetId, entries, photoIndex) {
  const { byFull, byLast, savedPhotos } = photoIndex;

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

  // Read all rows; preserve existing attending photo_urls.
  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: ROSTER_TAB });
  const rows   = allRes.data.values || [];

  const toDelete = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][roleCol] || '').trim().toLowerCase() === ATTENDING_ROLE) {
      toDelete.push(i + 1);
      if (photoCol >= 0) {
        const key   = normalizeName(String(rows[i][nameCol] || ''));
        const photo = String(rows[i][photoCol] || '').trim();
        if (key && photo && !savedPhotos[key]) savedPhotos[key] = photo;
      }
    }
  }
  console.log(`Deleting ${toDelete.length} existing attending rows…`);

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
  }

  if (!entries.length) { console.log('No attending entries to append.'); return 0; }

  // QGenda names are abbreviated (e.g. "C. Bailey") — resolve photos primarily
  // by last name, with full-name lookup as a secondary check.
  const resolvePhoto = (name) => {
    const last = lastName(name);                    // "bailey"
    const full = normalizeName(name);               // "bailey c" (sorted)
    return byFull[full] || byLast[last] || savedPhotos[full] || savedPhotos[last] || '';
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
    if (notesCol >= 0) row[notesCol] = e.shiftLabel || '';
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

  let entries = [], rawPhotos = { byFull: {}, byLast: {} };

  try {
    // Run both scrapers in parallel — they use separate pages.
    [entries, rawPhotos] = await Promise.all([
      scrapeQGenda(browser),
      scrapeFacultyPhotos(browser),
    ]);
  } finally {
    await browser.close();
  }

  if (!entries.length) {
    console.warn('WARNING: No attending entries found from QGenda — check qgenda-debug.png artifact.');
  }

  // Persist faculty headshots to GitHub Pages.
  const photos = await persistAttendingPhotos(rawPhotos).catch(err => {
    console.warn('GitHub Pages photo persistence failed:', err.message);
    return rawPhotos;
  });

  const auth   = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const n = await writeAttendingsToSheet(sheets, spreadsheetId, entries, {
    byFull:      photos.byFull,
    byLast:      photos.byLast,
    savedPhotos: {},
  });
  console.log(`\nDone. ${n} attending shift rows written to sheet.`);
}

main().catch(err => { console.error(err); process.exit(1); });
