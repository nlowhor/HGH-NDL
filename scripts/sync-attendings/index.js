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
const fs         = require('fs');

const QGENDA_URL     = 'https://app.qgenda.com/Link/view?linkKey=f175f5fe-1111-4da4-8e80-09b3d6b90a98';
const FACULTY_URL    = 'https://www.highlandemergency.org/faculty/';
const ROSTER_TAB     = 'roster';
const SYNC_LOG_TAB   = 'sync_log';
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

// Map a start-time string like "7a", "3p", "11p", "9a" or "7:00 AM" → shift bucket.
function shiftFromTime(timeStr) {
  if (!timeStr) return 'day';
  const m = String(timeStr).match(/(\d{1,2})(?::(\d{2}))?\s*(a|p|am|pm)/i);
  if (!m) return 'day';
  let h = parseInt(m[1], 10);
  const ap = m[3].toLowerCase().startsWith('p');
  if (ap && h !== 12) h += 12;
  if (!ap && h === 12) h = 0;
  if (h >= 23 || h < 7) return 'night';
  if (h >= 15)           return 'evening';
  return 'day';
}

function shiftFromLabel(label) {
  const k = String(label || '').toLowerCase();
  if (/^night|^noc/.test(k))   return 'night';
  if (/^swing|^eve|^pm/.test(k)) return 'evening';
  return 'day';
}

// Normalise a name for photo lookup: strip credentials, sort words.
const CREDENTIAL_RE = /\b(md|do|phd|mph|facp|facep|rn|np|pa|ms|msed|macm|msc)\b\.?/gi;
function normalizeName(s) {
  return s
    .replace(/\.[^.]+$/, '')
    .replace(CREDENTIAL_RE, ' ')
    .replace(/[_,\-]+/g, ' ')
    .toLowerCase().trim()
    .split(/\s+/).filter(Boolean).sort()
    .join(' ');
}

// Extract last name (strip credentials first).
function lastName(s) {
  const words = s.replace(CREDENTIAL_RE, '').replace(/[.,]/g, '').trim().split(/\s+/).filter(Boolean);
  return (words[words.length - 1] || '').toLowerCase();
}

// Parse QGenda header text → "YYYY-MM-DD" or null.
const MONTH_NUM = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
function parseDateHeader(text) {
  // Optional day-of-week prefix (full or 3-letter) handles concatenated format
  // like "MONAPR27", "FRIDAYMAY1", "SATMAY2" where \b won't fire between letter runs.
  const m = text.match(/(Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{1,2})(?:[,\s]+(\d{4}))?/i);
  if (!m) return null;
  const mon = MONTH_NUM[m[2].toLowerCase().slice(0,3)];
  const day = parseInt(m[3], 10);
  let year  = m[4] ? parseInt(m[4], 10) : new Date().getFullYear();
  // Roll over to next year if date is far in the past.
  const probe = new Date(`${year}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`);
  if (probe < new Date(Date.now() - 90 * 86400_000)) year++;
  return `${year}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

// ── QGenda API response parser ────────────────────────────────────────────────

// Recursively walks any JSON value, threading parent context (date, label, time)
// downward. Records an entry whenever a node has both a date (from self or ancestor)
// and a staff name (in self).
function parseQGendaApiJson(json, fromDate, toDate) {
  const entries = [];
  const seen    = new Set();

  function get(obj, ...keys) {
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  }

  function extractDate(obj) {
    const raw = get(obj,
      'date', 'Date', 'taskDate', 'TaskDate', 'startDate', 'StartDate',
      'scheduleDate', 'ScheduleDate', 'calendarDate', 'CalendarDate',
      'shiftDate', 'ShiftDate', 'displayDate', 'DisplayDate'
    );
    return raw ? parseDateHeader(String(raw)) : null;
  }

  function extractName(obj) {
    // Direct name fields (camelCase + PascalCase)
    const direct = get(obj,
      'staffName', 'StaffName', 'fullName', 'FullName',
      'displayName', 'DisplayName', 'providerName', 'ProviderName',
      'employeeName', 'EmployeeName', 'staffDisplayName', 'StaffDisplayName'
    );
    if (direct && typeof direct === 'string') return direct.trim();

    // First + last name
    const first = get(obj, 'firstName', 'FirstName', 'staffFirstName', 'StaffFirstName', 'first', 'First');
    const last  = get(obj, 'lastName',  'LastName',  'staffLastName',  'StaffLastName',  'last',  'Last');
    if (first || last) return [first, last].filter(Boolean).join(' ').trim();

    return null;
  }

  function extractLabel(obj) {
    const task = get(obj, 'taskName', 'TaskName', 'shiftName', 'ShiftName', 'label', 'Label',
                     'taskAbbrev', 'TaskAbbrev', 'taskDisplayName', 'TaskDisplayName') || null;
    // QGenda may put the facility/location in a separate field — combine so OFFSITE_RE can filter it.
    const facility = get(obj,
      'facilityName', 'FacilityName', 'facilityAbbreviation', 'FacilityAbbreviation',
      'site', 'Site', 'location', 'Location', 'hospital', 'Hospital',
      'tagName', 'TagName', 'facilityTag', 'FacilityTag'
    );
    if (task && facility) return `${task} (${facility})`;
    return task || facility || null;
  }

  function extractTime(obj) {
    return get(obj, 'startTime', 'StartTime', 'start', 'Start', 'time', 'Time') || null;
  }

  function walk(val, ctx) {
    if (!val || typeof val !== 'object') return;
    if (Array.isArray(val)) {
      for (const item of val) walk(item, ctx);
      return;
    }
    const date  = extractDate(val)  || ctx.date;
    const label = extractLabel(val) || ctx.label;
    const time  = extractTime(val)  || ctx.time;
    const name  = extractName(val);

    if (date && name && date >= fromDate && date <= toDate) {
      const shift = time ? shiftFromTime(String(time)) : shiftFromLabel(String(label || ''));
      const key   = `${date}|${shift}|${name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ date, shift, name, shiftLabel: String(label || '') });
      }
    }

    for (const v of Object.values(val)) {
      if (v && typeof v === 'object') walk(v, { date, label, time });
    }
  }

  walk(json, {});
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return entries;
}

function parseQGendaApiResponses(apiResponses, fromDate, toDate) {
  const entries = [];
  const seen    = new Set();

  // Build lookup maps from LinkInitialData (loaded once per session).
  let staffMap = {};  // staffMemberKey → displayName
  let taskMap  = {};  // taskKey → taskName

  for (const { url, json } of apiResponses) {
    if (!url.includes('LinkInitialData')) continue;
    if (!json || typeof json !== 'object' || Array.isArray(json)) continue;
    const staff = json.staffMembers || json.StaffMembers || [];
    const tasks = json.tasks        || json.Tasks        || [];
    if (staff.length > 0) {
      console.log(`  LinkInitialData staff[0] keys: ${Object.keys(staff[0]).join(', ')}`);
    }
    for (const s of staff) {
      const key = s.staffMemberKey || s.StaffMemberKey || s.key || s.Key;
      const name = s.displayName || s.DisplayName || s.fullName || s.FullName ||
                   [s.firstName || s.FirstName, s.lastName || s.LastName].filter(Boolean).join(' ') ||
                   s.name || s.Name;
      if (key && name) staffMap[key] = name;
    }
    for (const t of tasks) {
      const key = t.taskKey || t.TaskKey || t.key || t.Key;
      const name = t.name || t.Name || t.taskName || t.TaskName || t.abbreviation || t.Abbreviation;
      if (key && name) taskMap[key] = name;
    }
    console.log(`  Built staffMap: ${Object.keys(staffMap).length} staff, taskMap: ${Object.keys(taskMap).length} tasks`);
    if (Object.keys(staffMap).length > 0) {
      const sample = Object.entries(staffMap).slice(0, 3).map(([k,v]) => `${k.slice(0,8)}→${v}`).join(', ');
      console.log(`    Sample staff: ${sample}`);
    }
    break; // Only need first LinkInitialData
  }

  // Parse GetQuickLinkScheduleDisplay items using the lookup maps.
  const seenScheduleUrls = new Set();
  for (const { url, json } of apiResponses) {
    if (!url.includes('ScheduleView')) continue;
    if (seenScheduleUrls.has(url)) continue; // all months return identical data; parse once
    seenScheduleUrls.add(url);
    if (!json || typeof json !== 'object' || Array.isArray(json)) continue;

    const items = json.items || json.Items || [];
    console.log(`  ScheduleView items: ${items.length}, staffMap: ${Object.keys(staffMap).length}`);
    if (items.length > 0) {
      const dates = [...new Set(items.map(i => (i.date || '').slice(0,10)))].sort();
      console.log(`    Date range in items: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} distinct dates)`);
    }

    for (const item of items) {
      const sKey   = item.staffMemberKey || item.StaffMemberKey;
      const tKey   = item.taskKey        || item.TaskKey;
      const rawDate = (item.date || item.Date || '').slice(0, 10); // ISO already: "YYYY-MM-DD"
      if (!rawDate || !sKey) continue;
      if (rawDate < fromDate || rawDate > toDate) continue;

      const name  = staffMap[sKey] || null;
      if (!name) continue; // skip if we can't resolve the name
      const label = taskMap[tKey] || '';
      const rawTime = item.startTime || item.StartTime || '';
      // startTime is like "2026-05-06T11:00:00" — extract just the time portion
      const timeStr = rawTime.includes('T') ? rawTime.split('T')[1] : rawTime;
      const shift = timeStr ? shiftFromTime(timeStr) : shiftFromLabel(label);

      const key = `${rawDate}|${shift}|${name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ date: rawDate, shift, name, shiftLabel: label });
      }
    }
  }

  // Fall back to generic walk parser if targeted parser found nothing.
  if (entries.length === 0) {
    for (const { url, json } of apiResponses) {
      const found = parseQGendaApiJson(json, fromDate, toDate);
      for (const e of found) {
        const key = `${e.date}|${e.shift}|${e.name.toLowerCase()}`;
        if (!seen.has(key)) { seen.add(key); entries.push(e); }
      }
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return entries;
}

// ── QGenda table parser ───────────────────────────────────────────────────────

function parseQGendaTables(tables, fromDate, toDate) {
  const entries = [];
  const seen    = new Set();

  for (const rows of tables) {
    if (rows.length < 2) continue;

    // Find the header row with date-like cells.
    let headerIdx = -1;
    let colDates  = [];
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const dates = rows[i].map(c => parseDateHeader(c.text));
      if (dates.filter(Boolean).length >= 3) {
        headerIdx = i;
        colDates  = dates;
        break;
      }
    }
    if (headerIdx < 0) continue;
    console.log(`QGenda table: header at row ${headerIdx}, dates: ${colDates.filter(Boolean).join(', ')}`);

    // Each subsequent row is a shift row; each cell has shift info for that day.
    const SHIFT_RE = /^(Backup|Day\s*[A-Z]?|PIT|Swing|Night|FST|SLH|Noc|Alameda|San\s+Leandro)/i;
    const TIME_RE  = /(\d{1,2}[ap])\s*[-–]\s*(\d{1,2}[ap])/i;
    // Abbreviated name: "C. Bailey" — note [a-z]* (zero or more lowercase after initial).
    const NAME_RE  = /^[A-Z][a-z]*\.?\s+[A-Z][a-z'\-]+(\s+[A-Z][a-z'\-]+)?$/;

    let currentLabel = '';
    let currentTime  = '';

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const cells = rows[r];
      for (let c = 0; c < cells.length; c++) {
        const date = colDates[c];
        if (!date || date < fromDate || date > toDate) continue;
        const text = cells[c].text.trim();
        if (!text) continue;

        // Multi-line cell: each line is a separate element.
        const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
        let cellLabel = '', cellTime = '';
        for (const line of lines) {
          if (SHIFT_RE.test(line)) { cellLabel = line; cellTime = ''; continue; }
          const tm = line.match(TIME_RE);
          if (tm) { cellTime = tm[1]; continue; }
          if (NAME_RE.test(line)) {
            const shift = cellTime ? shiftFromTime(cellTime)
                        : cellLabel ? shiftFromLabel(cellLabel) : 'day';
            const key = `${date}|${shift}|${line.toLowerCase()}`;
            if (!seen.has(key)) {
              seen.add(key);
              entries.push({ date, shift, name: line, shiftLabel: cellLabel });
            }
          }
        }
      }
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return entries;
}

// ── QGenda line-by-line text parser ──────────────────────────────────────────

// Parses the raw innerText of the page.
// QGenda renders each day column sequentially, so the text reads:
//   all Mon entries → all Tue entries → … (flex/column layout)
// Date headers are split: "MON APR" on one line, "27" on the next.
function parseQGendaText(text, fromDate, toDate) {
  const entries = [];
  const seen    = new Set();
  const lines   = text.split(/\n/).map(l => l.trim()).filter(Boolean);

  const SHIFT_LABEL_RE = /^(Backup|Day\s*[A-Z]?|PIT|Swing\s*[A-Z]?|Night|Noc|FST|SLH|Alameda|San\s+Leandro)/i;
  const TIME_RE        = /^(\d{1,2}[ap])\s*[-–]\s*(\d{1,2}[ap])/i;
  // Abbreviated name: "C. Bailey", "M. Montgomery", "A. Quinones-Rivera".
  // [a-z]* (not +) handles single-letter initials like "C.".
  const NAME_RE        = /^[A-Z][a-z]*\.?\s+[A-Z][a-z'\-]+(\s+[A-Z][a-z'\-]+)?$/;
  // Line has a month name but no digit → it's the first half of a split date header.
  const MONTH_ONLY_RE  = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i;

  let currentDate   = null;
  let currentLabel  = '';
  let currentTime   = '';
  let pendingMonth  = ''; // e.g. "MON APR" — waiting for day number on next line

  function addEntry(name) {
    const shift = currentTime  ? shiftFromTime(currentTime)
                : currentLabel ? shiftFromLabel(currentLabel) : 'day';
    const key = `${currentDate}|${shift}|${name.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push({ date: currentDate, shift, name, shiftLabel: currentLabel });
    }
  }

  for (const line of lines) {
    // ── Step 1: Try combining a pending "MON APR" with a standalone day number.
    if (pendingMonth && /^\d{1,2}$/.test(line)) {
      const d = parseDateHeader(`${pendingMonth} ${line}`);
      if (d) { currentDate = d; currentLabel = ''; currentTime = ''; }
      pendingMonth = '';
      continue;
    }
    pendingMonth = '';

    // ── Step 2: Try to parse current line as a full or partial date.
    const d = parseDateHeader(line);
    if (d) {
      currentDate = d; currentLabel = ''; currentTime = '';
      continue;
    }

    // Partial date: line has a month name but no digit.
    // e.g. "MON APR", "SAT MAY", "FRIDAY" (no month → ignored).
    if (MONTH_ONLY_RE.test(line) && !/\d/.test(line)) {
      pendingMonth = line;
      continue; // wait for the day number on the next line
    }

    if (!currentDate || currentDate < fromDate || currentDate > toDate) continue;

    // ── Step 3: Shift label, time, or provider name.
    if (SHIFT_LABEL_RE.test(line)) {
      currentLabel = line;
      // Extract embedded start time from label: "Day A7a - 4p" → "7a", "Night11p - 8a" → "11p".
      const tm = line.match(/(\d{1,2}[ap])\s*[-–]/i);
      currentTime = tm ? tm[1] : '';
      continue;
    }

    const tm = line.match(TIME_RE);
    if (tm) { currentTime = tm[1]; continue; }

    if (NAME_RE.test(line)) addEntry(line);
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return entries;
}

// ── QGenda scraper ────────────────────────────────────────────────────────────

// Extract all table data + full innerText from the current page state.
async function extractQGendaPageData(page) {
  return page.evaluate(() => {
    const tables = [];
    for (const table of document.querySelectorAll('table')) {
      const rows = [];
      for (const tr of table.querySelectorAll('tr')) {
        const cells = Array.from(tr.querySelectorAll('td,th'))
          .map(td => ({ text: td.innerText.trim() }));
        if (cells.some(c => c.text)) rows.push(cells);
      }
      if (rows.length > 1) tables.push(rows);
    }
    return { tables, text: document.body.innerText };
  });
}

// Navigate QGenda to a specific month by filling the Start date field and
// clicking Go. Returns true if navigation succeeded.
async function navigateQGendaToMonth(page, monthDate) {
  const mm = String(monthDate.getMonth() + 1).padStart(2, '0');
  const dd = String(monthDate.getDate()).padStart(2, '0');
  const yyyy = monthDate.getFullYear();
  const dateStr = `${mm}/${dd}/${yyyy}`;

  try {
    // Find the date input by its value — QGenda uses a plain text input with
    // no predictable class or placeholder, but it always holds MM/DD/YYYY.
    const dateInputHandle = await page.evaluateHandle(() => {
      const inputs = Array.from(
        document.querySelectorAll('input[type="text"], input:not([type])')
      );
      return inputs.find(el => /\d{1,2}\/\d{1,2}\/\d{4}/.test(el.value)) || null;
    });

    const el = dateInputHandle.asElement();
    if (!el) throw new Error('date input not found by value pattern');

    await el.click({ clickCount: 3 });
    await el.type(dateStr, { delay: 50 });

    // Find the Go button — use a for loop (find(async cb) doesn't work).
    let goBtn = null;
    const allBtns = await page.$$('button, input[type="submit"], input[type="button"]');
    for (const btn of allBtns) {
      const t = await btn.evaluate(b => (b.innerText || b.value || '').trim());
      if (/^go$/i.test(t)) { goBtn = btn; break; }
    }

    if (goBtn) {
      await goBtn.click();
    } else {
      await el.press('Enter');
    }

    await new Promise(r => setTimeout(r, 3000));
    return true;
  } catch (err) {
    console.warn(`QGenda navigation to ${dateStr} failed:`, err.message);
    return false;
  }
}

async function scrapeQGendaMonth(browser, monthDate, monthNum) {
  const mm   = String(monthDate.getMonth() + 1).padStart(2, '0');
  const yyyy = monthDate.getFullYear();
  const startDateParam = `${mm}%2F01%2F${yyyy}`;
  const url = `${QGENDA_URL}&startDate=${startDateParam}`;

  console.log(`QGenda month ${monthNum}: loading ${mm}/${yyyy}…`);
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  const apiResponses = [];
  page.on('response', async (response) => {
    try {
      const respUrl = response.url();
      if (!respUrl.includes('qgenda.com')) return;
      if (/\.(js|css|png|jpg|gif|ico|woff2?|svg|map)(\?|$)/.test(respUrl)) return;
      const text = await response.text().catch(() => '');
      const t = text.trim();
      if (!t || (t[0] !== '[' && t[0] !== '{')) return;
      const json = JSON.parse(t);
      apiResponses.push({ url: respUrl, json });
      console.log(`  API captured: ${respUrl.slice(0, 80)}`);
    } catch { /* skip */ }
  });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 4000));

  const data = await extractQGendaPageData(page);
  console.log(`QGenda month ${monthNum}: ${data.text.length} chars, ${data.tables.length} table(s)`);

  if (monthNum === 1) {
    const html = await page.content();
    fs.writeFileSync('qgenda-debug.html', html);
    fs.writeFileSync('qgenda-debug.txt', data.text);
    await page.screenshot({ path: 'qgenda-debug.png', fullPage: true }).catch(() => {});
  }

  await page.close();
  return { text: data.text, tables: data.tables, apiResponses };
}

async function scrapeQGenda(browser) {
  const { from, to } = dateWindow();

  console.log('QGenda: loading initial page…');
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  const apiResponses = [];
  let scheduleViewBaseUrl = null;

  page.on('response', async (response) => {
    try {
      const respUrl = response.url();
      if (!respUrl.includes('qgenda.com')) return;
      if (/\.(js|css|png|jpg|gif|ico|woff2?|svg|map)(\?|$)/.test(respUrl)) return;
      const text = await response.text().catch(() => '');
      const t = text.trim();
      if (!t || (t[0] !== '[' && t[0] !== '{')) return;
      const json = JSON.parse(t);
      apiResponses.push({ url: respUrl, json });
      if (respUrl.includes('ScheduleView') && !scheduleViewBaseUrl) {
        // Capture full URL so we can re-call it with different date params
        scheduleViewBaseUrl = respUrl;
        console.log(`  ScheduleView URL captured: ${respUrl.slice(0, 120)}`);
      }
    } catch { /* skip */ }
  });

  await page.goto(QGENDA_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 4000));

  // Save debug artifacts
  const html = await page.content();
  fs.writeFileSync('qgenda-debug.html', html);
  const data = await extractQGendaPageData(page);
  fs.writeFileSync('qgenda-debug.txt', data.text);
  await page.screenshot({ path: 'qgenda-debug.png', fullPage: true }).catch(() => {});

  // If we have the ScheduleView URL, re-fetch it for each month window
  // directly from within the page context (inherits cookies/session).
  if (scheduleViewBaseUrl) {
    const monthsToFetch = Math.ceil((DAYS_AHEAD + 31) / 28);
    const startMonth = new Date(from + 'T12:00:00');
    startMonth.setDate(1);

    for (let m = 1; m < monthsToFetch; m++) {
      const monthDate = new Date(startMonth);
      monthDate.setMonth(monthDate.getMonth() + m);
      const mm   = String(monthDate.getMonth() + 1).padStart(2, '0');
      const yyyy = monthDate.getFullYear();

      // Replace the date params in the captured URL.
      // QGenda uses startDate and endDate query params like "05/01/2026".
      const startStr = `${mm}/01/${yyyy}`;
      const endStr   = `${mm}/${new Date(yyyy, monthDate.getMonth() + 1, 0).getDate()}/${yyyy}`;
      let fetchUrl = scheduleViewBaseUrl
        .replace(/startDate=[^&]*/,  `startDate=${encodeURIComponent(startStr)}`)
        .replace(/endDate=[^&]*/,    `endDate=${encodeURIComponent(endStr)}`);
      // If no date params exist in URL, append them
      if (!fetchUrl.includes('startDate=')) {
        fetchUrl += `&startDate=${encodeURIComponent(startStr)}&endDate=${encodeURIComponent(endStr)}`;
      }

      console.log(`  Re-fetching ScheduleView for ${mm}/${yyyy}…`);
      try {
        const result = await page.evaluate(async (url) => {
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) return { error: r.status };
          return r.json();
        }, fetchUrl);

        if (result && !result.error) {
          apiResponses.push({ url: fetchUrl, json: result });
          const itemCount = Array.isArray(result.items) ? result.items.length : '?';
          console.log(`  Re-fetched ${mm}/${yyyy}: ${itemCount} items`);
        } else {
          console.log(`  Re-fetch ${mm}/${yyyy} failed: ${JSON.stringify(result)}`);
        }
      } catch (err) {
        console.warn(`  Re-fetch ${mm}/${yyyy} error:`, err.message);
      }
    }
  }

  await page.close();

  // Strategy 1: API responses (includes re-fetched months).
  console.log(`QGenda: captured ${apiResponses.length} API response(s) total`);
  if (apiResponses.length > 0) {
    const apiEntries = parseQGendaApiResponses(apiResponses, from, to);
    if (apiEntries.length > 0) {
      console.log(`QGenda entries from API: ${apiEntries.length}`);
      return apiEntries;
    }
  }

  // Strategy 2a: Table parsing from initial page load.
  if (data.tables.length > 0) {
    console.log(`QGenda: ${data.tables.length} table(s) found`);
    const tableEntries = parseQGendaTables(data.tables, from, to);
    if (tableEntries.length > 0) {
      console.log(`QGenda entries from tables: ${tableEntries.length}`);
      return tableEntries;
    }
  }

  // Strategy 2b: Line-by-line text parsing.
  console.log('QGenda: falling back to text parsing…');
  const textEntries = parseQGendaText(data.text, from, to);
  console.log(`QGenda entries from text: ${textEntries.length}`);
  return textEntries;
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

  // Wait for WordPress loading overlay to clear.
  try {
    await page.waitForFunction(
      () => {
        const spinners = document.querySelectorAll(
          '.loading,.loader,.spinner,[class*="loading"],[class*="spinner"],[class*="preloader"]'
        );
        for (const s of spinners) {
          const st = window.getComputedStyle(s);
          if (st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0') return false;
        }
        return true;
      },
      { timeout: 20_000 }
    );
  } catch { /* spinner check timed out */ }

  // Scroll to trigger lazy-loaded images.
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let pos = 0;
      const id = setInterval(() => {
        window.scrollBy(0, 800);
        if (document.body.scrollHeight <= pos + window.innerHeight) { clearInterval(id); resolve(); }
        pos += 800;
      }, 150);
      setTimeout(() => { clearInterval(id); resolve(); }, 6000);
    });
    window.scrollTo(0, 0);
  });

  // Save debug HTML.
  const html = await page.content();
  fs.writeFileSync('faculty-debug.html', html);
  await page.screenshot({ path: 'faculty-debug.png', fullPage: true }).catch(() => {});

  const photos = await page.evaluate((facultyUrl) => {
    const result = {};

    function absUrl(src) {
      try { return new URL(src || '', facultyUrl).href; } catch { return ''; }
    }

    // Find the best image src for an element (prefers data-src for lazy images).
    function bestSrc(el) {
      for (const img of el.querySelectorAll('img')) {
        const src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') ||
                    img.getAttribute('src') || '';
        if (!src || src.startsWith('data:') || src.endsWith('.svg') || src.includes('placeholder')) continue;
        // Skip tiny icons (<50px natural width if known).
        if (img.naturalWidth > 0 && img.naturalWidth < 50) continue;
        return absUrl(src);
      }
      // CSS background-image fallback.
      for (const node of [el, ...el.querySelectorAll('[style*="background"]')]) {
        const bg = (node.getAttribute('style') || '') + window.getComputedStyle(node).backgroundImage;
        const m  = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (m && !m[1].startsWith('data:') && !m[1].endsWith('.svg')) return absUrl(m[1]);
      }
      return '';
    }

    // Key insight for this WordPress theme: each faculty card has an <img> and
    // somewhere nearby a line of text with the person's name + credential.
    // Person names: every word starts with uppercase ("Kevin Gardner, MD").
    // Job titles: contain lowercase connectives ("Director of Critical Care").

    // Include all common EM credentials — missing FACEP/FAAEM was causing many names to be skipped.
    const CREDENTIAL_RE = /\b(MD|DO|PhD|MPH|MSEd?|MACM|MSc|FACEP|FAAEM|FACP|PA-?C|NP|RN|PA|MS)\b/i;

    // A person name has 2–5 words where EVERY word starts with an uppercase letter.
    // Strip trailing credentials first, then check each remaining word.
    function isPersonName(text) {
      // Remove credential suffix (",  MD" / ", PhD" etc.)
      const clean = text.replace(/[,;]\s*(MD|DO|PhD|MPH|MACM|MSEd?|MSc|MA|MS|PA|RN|NP)(\s+\S+)*$/gi, '').trim();
      // Remove standalone credential tokens left in the middle.
      const words = clean.split(/\s+/).filter(w => !/^(md|do|phd|mph|msed?|macm|msc|ma|ms|pa|rn|np)$/i.test(w));
      if (words.length < 2 || words.length > 5) return false;
      // Every word must start with uppercase — eliminates "Director of Critical Care".
      return words.every(w => /^[A-Z]/.test(w));
    }

    function textOf(el) {
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // Given an img element, walk up the DOM looking for a sibling or ancestor
    // text node that is a person name. Many WordPress themes put the name in an
    // <h4> and the credential in a separate <p> — so we accept a heading-only
    // name when the container has a credential anywhere in it.
    function nearbyName(imgEl) {
      let el = imgEl.parentElement;
      for (let depth = 0; depth < 7 && el; depth++) {
        // Skip containers that hold many images (too broad — would match wrong card).
        if (el.querySelectorAll('img').length > 4) { el = el.parentElement; continue; }

        const containerHasCredential = CREDENTIAL_RE.test(textOf(el));

        // Headings + bold: accept person name even without credential in same element,
        // as long as the enclosing card container has a credential somewhere.
        for (const tag of ['h1','h2','h3','h4','h5','h6','strong','b']) {
          for (const node of el.querySelectorAll(tag)) {
            const t = textOf(node).split('\n')[0].trim();
            if (t.length < 4 || t.length > 80) continue;
            if (isPersonName(t) && (CREDENTIAL_RE.test(t) || containerHasCredential)) return t;
          }
        }

        // Paragraphs: require credential in same element to avoid false positives.
        for (const node of el.querySelectorAll('p')) {
          const t = textOf(node).split('\n')[0].trim();
          if (t.length < 4 || t.length > 80) continue;
          if (CREDENTIAL_RE.test(t) && isPersonName(t)) return t;
        }

        // Check adjacent siblings.
        for (const sib of [el.nextElementSibling, el.previousElementSibling]) {
          if (!sib) continue;
          const t = textOf(sib).split('\n')[0].trim();
          if (t.length >= 4 && t.length <= 80 && CREDENTIAL_RE.test(t) && isPersonName(t)) return t;
        }

        el = el.parentElement;
      }
      return '';
    }

    // Fallback: scan all headings for person names; credential may be in a sibling element.
    function findByHeadings() {
      const found = {};
      for (const tag of ['h1','h2','h3','h4','h5','h6']) {
        for (const heading of document.querySelectorAll(tag)) {
          const t = textOf(heading).split('\n')[0].trim();
          if (!isPersonName(t) || t.length > 80) continue;
          // Require a credential somewhere in the card container (parent or grandparent).
          const container = heading.parentElement;
          if (!container) continue;
          const gp = container.parentElement;
          const hasCredential = CREDENTIAL_RE.test(textOf(container)) ||
                                (gp && CREDENTIAL_RE.test(textOf(gp)));
          if (!hasCredential) continue;

          // Look in parent and grandparent for an image.
          const src = bestSrc(container);
          if (src) { found[t] = src; continue; }

          if (gp && gp.querySelectorAll('img').length <= 4) {
            const gpSrc = bestSrc(gp);
            if (gpSrc) found[t] = gpSrc;
          }
        }
      }
      return found;
    }

    // Strategy A: scan all imgs, find nearby credential-bearing name.
    for (const img of document.querySelectorAll('img')) {
      const src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.src || '';
      if (!src || src.startsWith('data:') || src.endsWith('.svg')) continue;
      if (img.naturalWidth > 0 && img.naturalWidth < 50) continue;
      const abs = absUrl(src);
      if (!abs) continue;
      const name = nearbyName(img);
      if (name) result[name] = abs;
    }

    // Strategy B: heading-first scan — always run so cards missed by Strategy A are filled in.
    const headingResults = findByHeadings();
    for (const [n, u] of Object.entries(headingResults)) {
      if (!result[n]) result[n] = u;
    }

    // Strategy C: plain-text scan for any "First Last, Credential" pattern.
    // Builds name entries even when DOM photo-association fails.
    // Names found here get an empty URL so they contribute to displayByLast but not byLast.
    const pageText = document.body.innerText || '';
    const textRe = /([A-Z][a-z]+(?:(?:\s+|-)[A-Z][a-z'-]+)+)[,\s]+(?:MD|DO|PhD|FACEP|FAAEM|FACP|PA-?C|NP|RN|PA|MPH)/g;
    let tm;
    while ((tm = textRe.exec(pageText)) !== null) {
      const n = tm[1].trim();
      if (!result[n]) result[n] = ''; // empty URL — name only, used for display-name resolution
    }

    return result;
  }, FACULTY_URL);

  await page.close();

  // Build normalized lookup maps: full-name key, last-name key, and display name by last name.
  const byFull       = {};
  const byLast       = {};
  const displayByLast = {}; // last name → "Caitlin Bailey" (no credential suffix)
  for (const [name, url] of Object.entries(photos)) {
    const full = normalizeName(name);
    const last = lastName(name);
    const display = name.replace(CREDENTIAL_RE, '').replace(/[\s,;]+$/, '').replace(/\s+/g, ' ').trim();
    // displayByLast: built from all names including text-only (empty URL) — for display name resolution.
    if (last && !displayByLast[last]) displayByLast[last] = display;
    // byFull / byLast: only entries with a real photo URL.
    if (!url) continue;
    byFull[full] = url;
    if (last && !byLast[last]) byLast[last] = url;
  }

  console.log(`Faculty: ${Object.keys(displayByLast).length} display names, ${Object.keys(byLast).length} with photos`);
  if (Object.keys(displayByLast).length) {
    console.log('  Display names sample:', Object.values(displayByLast).slice(0, 6).join(', '));
  }
  return { byFull, byLast, displayByLast };
}

// ── GitHub Pages photo persistence ───────────────────────────────────────────

async function persistAttendingPhotos({ byFull, byLast, displayByLast }) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('GITHUB_TOKEN not set — skipping GitHub Pages photo persistence.');
    return { byFull, byLast, displayByLast };
  }

  const newFull = {};
  let hits = 0, skipped = 0;

  for (const [key, url] of Object.entries(byFull)) {
    const fileKey = key.replace(/ /g, '-');
    try {
      newFull[key] = await ensurePhotoInPages(fileKey, url, 'photos/attendings');
      hits++;
    } catch (err) {
      console.warn(`  Photo persistence failed for "${key}":`, err.message);
      newFull[key] = url;
      skipped++;
    }
  }

  // Rebuild byLast pointing to persisted URLs.
  const newLast = {};
  for (const [last, origUrl] of Object.entries(byLast)) {
    // Find the full key whose last word matches this last name.
    const fullKey = Object.keys(byFull).find(k => k.split(' ').includes(last));
    newLast[last] = fullKey ? (newFull[fullKey] || origUrl) : origUrl;
  }

  console.log(`Attending photos persisted: ${hits} stored, ${skipped} failed.`);
  return { byFull: newFull, byLast: newLast, displayByLast };
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

// Shifts at these locations are not Highland shifts — exclude from the roster.
const OFFSITE_RE = /\b(San\s+Leandro|SLH|Alameda|CHO)/i;

async function writeAttendingsToSheet(sheets, spreadsheetId, entries, photos) {
  const { byFull, byLast, displayByLast, savedPhotos } = photos;

  // Filter out off-site shifts before touching the sheet.
  const offsiteCount = entries.filter(e => OFFSITE_RE.test(e.shiftLabel || '')).length;
  if (offsiteCount) console.log(`Filtered out ${offsiteCount} off-site entry(s) (San Leandro/Alameda/CHO).`);
  entries = entries.filter(e => !OFFSITE_RE.test(e.shiftLabel || ''));

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${ROSTER_TAB}!1:1`,
  });
  const headers = (headerRes.data.values?.[0] || []).map(h => String(h).trim().toLowerCase());

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

  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: ROSTER_TAB });
  const rows   = allRes.data.values || [];

  const toDelete = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][roleCol] || '').trim().toLowerCase() === ATTENDING_ROLE) {
      toDelete.push(i + 1);
      if (photoCol >= 0 && !savedPhotos[normalizeName(String(rows[i][nameCol] || ''))]) {
        const key   = normalizeName(String(rows[i][nameCol] || ''));
        const photo = String(rows[i][photoCol] || '').trim();
        if (key && photo) savedPhotos[key] = photo;
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

  // QGenda uses abbreviated names ("C. Bailey"); resolve to full name and photo by last name.
  const resolvePhoto = (name) => {
    const last = lastName(name);
    const full = normalizeName(name);
    return byFull[full] || byLast[last] || savedPhotos[full] || savedPhotos[last] || '';
  };

  // Expand abbreviated QGenda name to full display name using faculty page data.
  // "C. Bailey" → "Caitlin Bailey" by last-name lookup; verifies first initial matches
  // to avoid mis-mapping when two people share a last name.
  const resolveDisplayName = (name) => {
    const last = lastName(name);
    const full = displayByLast && displayByLast[last];
    if (!full) return name;
    // If QGenda gave an initial ("C."), confirm it matches the faculty name's first letter.
    const initialMatch = name.match(/^([A-Z])\./);
    if (initialMatch && !full.startsWith(initialMatch[1])) return name;
    return full;
  };

  let photoHits = 0;
  const width   = headers.length;
  const newRows = entries.map(e => {
    const row         = new Array(width).fill('');
    const photo       = resolvePhoto(e.name);
    const displayName = resolveDisplayName(e.name);
    if (photo) photoHits++;
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = ATTENDING_ROLE;
    row[nameCol]  = displayName;
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

  console.log(`Appended ${newRows.length} attending rows (${photoHits} with photo_url).`);
  return newRows.length;
}

// ── Sync log ──────────────────────────────────────────────────────────────────

async function writeSyncTimestamp(sheets, spreadsheetId, role) {
  const now = new Date().toISOString();
  let rows = [];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: SYNC_LOG_TAB });
    rows = res.data.values || [];
  } catch {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SYNC_LOG_TAB } } }] },
    });
  }
  if (!rows.length) rows = [['role', 'updated_at']];
  const idx = rows.findIndex((r, i) => i > 0 && r[0] === role);
  if (idx >= 0) rows[idx][1] = now;
  else rows.push([role, now]);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${SYNC_LOG_TAB}!A1`,
    valueInputOption: 'RAW', requestBody: { values: rows },
  });
  console.log(`Sync log: ${role} updated_at ${now}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const spreadsheetId = process.env.CANONICAL_SHEET_ID;
  if (!spreadsheetId)    throw new Error('CANONICAL_SHEET_ID env var is required.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required.');

  console.log('Launching Puppeteer…');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });

  let entries = [], rawPhotos = { byFull: {}, byLast: {} };
  try {
    [entries, rawPhotos] = await Promise.all([
      scrapeQGenda(browser),
      scrapeFacultyPhotos(browser),
    ]);
  } finally {
    await browser.close();
  }

  if (!entries.length) {
    console.warn('WARNING: No attending entries found — check qgenda-debug.html/txt artifacts.');
  }

  const photos = await persistAttendingPhotos(rawPhotos).catch(err => {
    console.warn('GitHub Pages photo persistence failed:', err.message);
    return rawPhotos;
  });

  const auth   = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const n = await writeAttendingsToSheet(sheets, spreadsheetId, entries, {
    byFull: photos.byFull, byLast: photos.byLast,
    displayByLast: photos.displayByLast || {}, savedPhotos: {},
  });
  await writeSyncTimestamp(sheets, spreadsheetId, ATTENDING_ROLE);
  console.log(`\nDone. ${n} attending shift rows written to sheet.`);
}

main().catch(err => { console.error(err); process.exit(1); });
