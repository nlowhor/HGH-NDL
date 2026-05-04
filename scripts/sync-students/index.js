'use strict';

/**
 * HGH Student Schedule + Photo Sync
 * -----------------------------------
 * 1. Reads all rotation-block tabs of the student clerkship schedule Google
 *    Sheet (visual calendar layout) and extracts shift assignments for the
 *    configured date window.
 * 2. Fetches student headshot URLs from Airtable via the REST API.
 * 3. Persists each headshot to the GitHub repo (served via GitHub Pages) so
 *    the roster isn't broken by Airtable CDN expiry (~2 h). Existing files
 *    are reused; re-download only happens when FORCE_PHOTO_REFRESH=true.
 * 4. Replaces all student rows in the canonical roster Google Sheet.
 *
 * Required env vars:
 *   CANONICAL_SHEET_ID          – roster sheet to write to
 *   STUDENT_SCHEDULE_SHEET_ID   – clerkship schedule sheet to read from
 *   GOOGLE_SERVICE_ACCOUNT_JSON – service account credentials
 *   AIRTABLE_API_KEY            – Airtable personal access token
 */

const { google } = require('googleapis');
const { ensurePhotoInPages, isAirtableUrl } = require('../lib/github-photos');

const AIRTABLE_BASE_ID = 'appXHrYewBeH8Rwmh';
const AIRTABLE_API     = 'https://api.airtable.com/v0';

// Published CSV of the student clerkship schedule Google Sheet.
// Override with STUDENT_SCHEDULE_CSV_URL env var if the URL changes.
const STUDENT_SCHEDULE_CSV_URL = process.env.STUDENT_SCHEDULE_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSm3KBhIKMDOIbhgrZxqCT963rMssxTyh9vzDZiLxy4vbPWX-8A5luNoyKhSbDT3gJU5vMat8Bo552j/pub?gid=1506284669&single=true&output=csv';

const ROSTER_TAB   = 'roster';
const SYNC_LOG_TAB = 'sync_log';
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

// Schedule uses DAY-res, DAY-att, SWING-res, SWING-att etc. — strip the
// resident/attending suffix before looking up so these map correctly.
function lookupShift(rawLabel) {
  const upper = rawLabel.toUpperCase();
  return SHIFT_LABEL_MAP[upper] || SHIFT_LABEL_MAP[upper.replace(/-(RES|ATT)$/, '')];
}

const SKIP_LABEL = /^(orientation|bridge|conference|lecture|holiday|off|em |bup$)/i;
const SKIP_NAME  = /^(student|ucsf|ms|slot|resident|attending)\s*\d*$/i;

const DAY_NAMES = ['MON', 'TUES', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function parseDate(val, hintYear) {
  if (!val) return null;
  const s = String(val).trim();
  // "May 5" or "May-5"
  const monthDay = s.match(/^([A-Za-z]+)[\s\-](\d{1,2})$/);
  if (monthDay) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const m = months.indexOf(monthDay[1].toLowerCase());
    if (m < 0) return null;
    const d = parseInt(monthDay[2], 10);
    const year = hintYear || new Date().getFullYear();
    return `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  // "5/5/26" or "5/5/2026"
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const year = mdy[3].length === 2 ? 2000 + parseInt(mdy[3], 10) : parseInt(mdy[3], 10);
    return `${year}-${String(parseInt(mdy[1], 10)).padStart(2, '0')}-${String(parseInt(mdy[2], 10)).padStart(2, '0')}`;
  }
  // "5/5" (MM/DD without year) — use hintYear
  const md = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (md) {
    const year = hintYear || new Date().getFullYear();
    return `${year}-${String(parseInt(md[1], 10)).padStart(2, '0')}-${String(parseInt(md[2], 10)).padStart(2, '0')}`;
  }
  return null;
}

function yearFromTabName(name) {
  const m4 = name.match(/\b(20\d{2})\b/);
  if (m4) return parseInt(m4[1], 10);
  // Use the LAST "/YY" so "5/31/26" yields 26, not 31.
  const all = [...name.matchAll(/\/(\d{2})/g)];
  if (all.length) return 2000 + parseInt(all[all.length - 1][1], 10);
  return null;
}

// Minimal CSV parser — handles quoted fields with embedded commas/newlines.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { field += ch; }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      row.push(field.trim()); field = '';
    } else if (ch === '\n') {
      row.push(field.trim()); rows.push(row); row = []; field = '';
    } else if (ch === '\r') {
      // ignore bare CR
    } else {
      field += ch;
    }
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  return rows;
}

// ── Schedule parsing ──────────────────────────────────────────────────────────

function parseScheduleTab(rows, tabName) {
  const hintYear = yearFromTabName(tabName);
  const entries  = [];

  // Find rotation year: prefer tab name hint, then scan for "Rotation Start Date" cell.
  let rotationYear = hintYear;
  if (!rotationYear) {
    for (const row of rows) {
      for (let c = 0; c < row.length; c++) {
        if (/rotation start date/i.test(String(row[c] || ''))) {
          // Search remaining cells in this row for a parseable date.
          for (let k = c + 1; k < row.length; k++) {
            const raw = String(row[k] || '').trim();
            if (!raw) continue;
            const d = parseDate(raw, null);
            if (d) { rotationYear = parseInt(d.slice(0, 4), 10); break; }
          }
          break;
        }
      }
      if (rotationYear) break;
    }
  }
  console.log(`  rotationYear for "${tabName || 'CSV'}": ${rotationYear}`);

  let i = 0;
  while (i < rows.length) {
    const row = rows[i] || [];

    // Detect a "day header" row: ≥3 cells match known day abbreviations.
    const dayPositions = {};
    for (let c = 0; c < row.length; c++) {
      const v = String(row[c] || '').trim().toUpperCase();
      if (DAY_NAMES.includes(v)) dayPositions[v] = c;
    }
    if (Object.keys(dayPositions).length < 3) { i++; continue; }

    // Next row holds the dates.
    const dateRow = rows[i + 1] || [];
    const dateMap = {};
    for (const [day, col] of Object.entries(dayPositions)) {
      const d = parseDate(String(dateRow[col] || ''), rotationYear);
      if (d) dateMap[day] = d;
    }

    // Determine (labelCol, nameCol) for each day.
    // The schedule layout puts label+name in the two columns immediately
    // following a "wide" day header (MON), but for subsequent days the day
    // header sits at the NAME column and the label is one column to the left.
    // Detect which rule applies by looking at the gap to the next day.
    const sortedDays = Object.entries(dayPositions).sort((a, b) => a[1] - b[1]);
    const dayColMap = {}; // day → { labelCol, nameCol }
    for (let d = 0; d < sortedDays.length; d++) {
      const [day, col] = sortedDays[d];
      const nextCol = d + 1 < sortedDays.length ? sortedDays[d + 1][1] : null;
      if (nextCol !== null && nextCol - col >= 4) {
        // Wide section: data starts after the header column.
        dayColMap[day] = { labelCol: col + 1, nameCol: col + 2 };
      } else {
        // Narrow section: header is at the name column, label is one to the left.
        dayColMap[day] = { labelCol: col - 1, nameCol: col };
      }
    }

    // Consume data rows until the next week header (another row with ≥3 day names).
    let j = i + 2;
    while (j < rows.length) {
      const dataRow = rows[j] || [];
      const dayCount = dataRow.filter(v =>
        DAY_NAMES.includes(String(v || '').trim().toUpperCase())
      ).length;
      if (dayCount >= 3 && j > i + 2) break;

      for (const [day, { labelCol, nameCol }] of Object.entries(dayColMap)) {
        const date = dateMap[day];
        if (!date) continue;
        const rawLabel = String(dataRow[labelCol] || '').trim();
        const rawName  = String(dataRow[nameCol]  || '').trim();
        if (!rawLabel || !rawName) continue;
        if (SKIP_LABEL.test(rawLabel)) continue;
        if (SKIP_LABEL.test(rawName))  continue;
        if (SKIP_NAME.test(rawName))   continue;
        const mapped = lookupShift(rawLabel);
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

// ── CSV — read student schedule ───────────────────────────────────────────────

async function fetchStudentSchedule() {
  console.log(`Fetching student schedule from CSV: ${STUDENT_SCHEDULE_CSV_URL}`);
  const res = await fetch(STUDENT_SCHEDULE_CSV_URL);
  if (!res.ok) throw new Error(`Schedule CSV fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  console.log(`  CSV rows: ${rows.length}`);

  const today   = new Date();
  const from    = new Date(today); from.setDate(from.getDate() - DAYS_BEHIND);
  const to      = new Date(today); to.setDate(to.getDate() + DAYS_AHEAD);
  const fromIso = from.toISOString().slice(0, 10);
  const toIso   = to.toISOString().slice(0, 10);

  const entries   = parseScheduleTab(rows, '');
  const inWindow  = entries.filter(e => e.date >= fromIso && e.date <= toIso);
  console.log(`  Parsed: ${entries.length} total, ${inWindow.length} in window.`);

  const seen = new Set();
  const deduped = inWindow.filter(e => {
    const key = `${e.date}|${e.shift}|${e.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  console.log(`Total student entries in window (deduped): ${deduped.length}`);
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

  // Use AIRTABLE_TABLE env var if set (name or ID), otherwise auto-discover
  // via metadata API (requires schema.bases:read scope on the token).
  let tableId = process.env.AIRTABLE_TABLE;
  let studentRosterTableId = null;
  if (!tableId) {
    console.log('AIRTABLE_TABLE not set — fetching metadata to discover table…');
    console.log('(Add schema.bases:read scope to your token, or set AIRTABLE_TABLE secret to skip this.)');
    const metaRes = await fetch(`${AIRTABLE_API}/meta/bases/${AIRTABLE_BASE_ID}/tables`, { headers });
    if (!metaRes.ok) throw new Error(`Airtable metadata API ${metaRes.status}: ${await metaRes.text()}`);
    const { tables } = await metaRes.json();
    console.log(`Tables in base: ${tables.map(t => t.name).join(', ')}`);

    const photoFieldNames = /photo|headshot|image|picture|portrait|pic\b/i;
    const pdfFieldNames   = /^pdf$|^file$|^document$/i;

    // Prefer a table with an attachment field that looks like headshots.
    let table = tables.find(t =>
      t.fields.some(f => f.type === 'multipleAttachments' && photoFieldNames.test(f.name))
    );
    // Fall back to a table with any attachment field that isn't named PDF/File/Document.
    if (!table) {
      table = tables.find(t =>
        t.fields.some(f => f.type === 'multipleAttachments' && !pdfFieldNames.test(f.name))
      );
    }
    if (!table) throw new Error(
      `Could not auto-detect student photo table.\n` +
      `Tables found: ${tables.map(t => t.name).join(', ')}\n` +
      `Set AIRTABLE_TABLE secret to the exact table name or ID.`
    );
    tableId = table.id;
    console.log(`Auto-discovered table: "${table.name}" (${tableId})`);
    console.log(`Fields: ${table.fields.map(f => `${f.name} (${f.type})`).join(', ')}`);

    // Also find the Student Roster table so we can join full names via linked records.
    const rosterTable = tables.find(t => /^student.roster$/i.test(t.name));
    if (rosterTable) {
      studentRosterTableId = rosterTable.id;
      console.log(`Found Student Roster table: "${rosterTable.name}" (${studentRosterTableId})`);
    }
  } else {
    console.log(`Using table from AIRTABLE_TABLE env var: ${tableId}`);
  }

  // Fetch Student Roster records to build recordId → full name map.
  // Welcome Form records link to Student Roster via the "Student" field.
  const rosterById = new Map(); // Airtable record ID → full name string
  if (studentRosterTableId) {
    console.log('Fetching Student Roster for full name lookup…');
    let rosterOffset;
    let loggedRoster = false;
    do {
      const url = new URL(`${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(studentRosterTableId)}`);
      if (rosterOffset) url.searchParams.set('offset', rosterOffset);
      const res = await fetch(url.toString(), { headers });
      if (!res.ok) { console.warn('Student Roster fetch failed:', res.status); break; }
      const data = await res.json();
      for (const record of data.records || []) {
        if (!loggedRoster) {
          console.log('Student Roster first record fields:',
            Object.entries(record.fields).slice(0, 12)
              .map(([k, v]) => `"${k}": ${JSON.stringify(v).slice(0, 60)}`).join(', '));
          loggedRoster = true;
        }
        const name = extractRosterName(record.fields);
        if (name) rosterById.set(record.id, name);
      }
      rosterOffset = data.offset;
    } while (rosterOffset);
    console.log(`Student Roster: ${rosterById.size} name(s) loaded.`);
  }

  // Fetch all records, handling pagination.
  // Returns { byFullName: Map, byLastName: Map } so callers can try both.
  const byFullName = new Map(); // normalizeName(full name) → url
  const byLastName = new Map(); // single lowercased word → url

  let offset;
  do {
    const url = new URL(`${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableId)}`);
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) throw new Error(`Airtable records API ${res.status}: ${await res.text()}`);
    const data = await res.json();

    for (const record of data.records || []) {
      const fields = record.fields;

      // Log field names from the first record so we can see what Airtable exposes.
      if (byFullName.size === 0 && byLastName.size === 0) {
        console.log('Airtable field names in first record:',
          Object.entries(fields).map(([k, v]) => `"${k}" (${Array.isArray(v) ? 'array' : typeof v})`).join(', '));
        // Also log name-related field values to debug name extraction.
        for (const [k, v] of Object.entries(fields)) {
          if (/name/i.test(k)) {
            console.log(`  name field "${k}":`, JSON.stringify(v).slice(0, 120));
          }
        }
      }

      // Extract photo URL from the first attachment field found.
      const photoEntry = Object.entries(fields).find(([, v]) => Array.isArray(v) && v[0]?.url);
      if (!photoEntry) continue;
      const photoUrl = photoEntry[1][0].thumbnails?.large?.url || photoEntry[1][0].url;

      // Extract name: prefer Student Roster lookup (full name via linked record),
      // then fall back to Welcome Form field strategies.
      const linkedStudentId = Array.isArray(fields['Student']) ? fields['Student'][0] : null;
      const name = (linkedStudentId && rosterById.get(linkedStudentId)) || extractName(fields);
      if (!name) continue;

      console.log(`  ${name} → ${photoUrl.slice(0, 80)}`);
      const entry = { name, url: photoUrl };
      byFullName.set(normalizeName(name), entry);
      // Index every word so last-name-only schedule entries can match.
      // Share the same object so URL updates in persistPhotosToPages propagate here too.
      for (const word of name.toLowerCase().split(/\s+/)) {
        if (word.length > 2) byLastName.set(word, entry);
      }
    }

    offset = data.offset;
  } while (offset);

  console.log(`Airtable: ${byFullName.size} photo(s) fetched.`);
  return { byFullName, byLastName };
}

// Extract full name from a Student Roster record (primary field is usually the name).
function extractRosterName(fields) {
  // Try "Name", "Student Name", "Full Name" — common primary field names.
  for (const [k, v] of Object.entries(fields)) {
    if (/^(student\s+)?name$|^full\s+name$/i.test(k) && typeof v === 'string' && v.trim().length > 2) {
      return v.trim();
    }
  }
  // Fall back: first string field that looks like a name (has a space, no digits).
  for (const [, v] of Object.values(fields).map((v, i) => [i, v])) {
    if (typeof v === 'string' && /^[A-Za-z]+ [A-Za-z]/.test(v.trim())) return v.trim();
  }
  return null;
}

// Extract a clean student name from an Airtable record's fields object.
function extractName(fields) {
  // Strategy 1: "Preferred Name (optional)" when it has 2+ words (First Last).
  // Students sometimes enter their full name here; prefer it over the lookup
  // which often only contains the given name.
  const preferred = fields['Preferred Name (optional)'];
  if (typeof preferred === 'string') {
    const words = preferred.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return words.join(' ');
  }

  // Strategy 2: "Name (from Student)" lookup array — may be full name or just given name.
  const fromStudent = fields['Name (from Student)'];
  if (Array.isArray(fromStudent) && typeof fromStudent[0] === 'string' && fromStudent[0].trim()) {
    return fromStudent[0].trim();
  }

  // Strategy 3: "Name" formula field — strip block label and phone number patterns.
  // Format seen: "FirstName - Block X (dates)" or "Name (phone)"
  const nameFormula = fields['Name'];
  if (typeof nameFormula === 'string') {
    const clean = nameFormula
      .replace(/\s*-\s*Block.*$/i, '')              // strip " - Block ..." suffix
      .replace(/\s*\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}.*$/, '') // strip phone
      .trim();
    if (clean.length > 1) return clean;
  }

  // Strategy 4: "Preferred Name" even if just one word (nickname).
  if (typeof preferred === 'string' && preferred.trim().length > 1) return preferred.trim();

  return null;
}

// ── Google Sheets — write canonical roster ────────────────────────────────────

async function getAuth() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function writeStudentsToSheet(auth, spreadsheetId, entries, photos) {
  const { byFullName, byLastName } = photos instanceof Map
    ? { byFullName: photos, byLastName: new Map() }
    : photos;
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

  // Read all rows and find student row indices to delete.
  // Using deleteDimension (same as residents sync) instead of values.clear+update
  // to avoid clobbering concurrent writes from other service accounts (e.g. Medrez).
  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: ROSTER_TAB });
  const rows   = allRes.data.values || [];

  const toDelete = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][roleCol] || '').trim().toLowerCase() === STUDENT_ROLE) {
      toDelete.push(i + 1); // 1-based sheet row number
    }
  }
  console.log(`Deleting ${toDelete.length} existing student row(s)…`);

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

  if (!entries.length) { console.log('No student entries to append.'); return 0; }

  let photoHits = 0;
  const width   = headers.length;
  const newRows = entries.map(e => {
    const normalName = normalizeName(e.name);
    const lastWord   = e.name.trim().split(/\s+/).pop().toLowerCase();
    // Try full-name match first, then any-word match (handles first-name or last-name schedules).
    const match = byFullName.get(normalName) || byLastName.get(lastWord);
    const photo = match?.url || '';
    if (photo) photoHits++;
    // When we have an Airtable record, use that name — it's more complete/correct
    // than whatever abbreviation the schedule used.
    const rosterName = match ? match.name : e.name;
    const row = new Array(width).fill('');
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = STUDENT_ROLE;
    row[nameCol]  = rosterName;
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

  console.log(`Appended ${newRows.length} student row(s) (${photoHits} with photo_url).`);
  return newRows.length;
}

// ── Google Sheets — write students directory tab ──────────────────────────────

const STUDENTS_TAB = 'students';

async function writeStudentsTab(auth, spreadsheetId, photos) {
  const { byFullName } = photos instanceof Map
    ? { byFullName: new Map() }
    : photos;

  const sheets = google.sheets({ version: 'v4', auth });

  // Ensure the tab exists (create it if missing).
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === STUDENTS_TAB);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: STUDENTS_TAB } } }] },
    });
    console.log(`Created "${STUDENTS_TAB}" tab.`);
  }

  // Build rows: header + one per student (sorted by name).
  const entries = Array.from(byFullName.values()).sort((a, b) => a.name.localeCompare(b.name));
  const rows = [
    ['name', 'photo_url'],
    ...entries.map(e => [e.name, e.url]),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${STUDENTS_TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  // Clear any stale rows below the new data.
  if (existing) {
    const oldRowCount = existing.properties.gridProperties?.rowCount || 0;
    if (oldRowCount > rows.length) {
      const sheetId = existing.properties.sheetId;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: { sheetId, dimension: 'ROWS', startIndex: rows.length, endIndex: oldRowCount },
            },
          }],
        },
      });
    }
  }

  console.log(`"${STUDENTS_TAB}" tab: wrote ${entries.length} student record(s).`);
}

// ── GitHub Pages photo persistence ───────────────────────────────────────────

// Iterates byFullName, uploads any Airtable URLs to the GitHub repo for
// permanent serving, and updates both maps to use the stable Pages URL.
async function persistPhotosToPages(photos) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('GITHUB_TOKEN not set — skipping GitHub Pages photo persistence.');
    return photos;
  }

  const { byFullName, byLastName } = photos;
  let persisted = 0;
  let skipped   = 0;

  for (const [normalKey, entry] of byFullName) {
    if (!isAirtableUrl(entry.url)) { skipped++; continue; }
    const fileKey = normalKey.replace(/ /g, '-');
    try {
      const pageUrl = await ensurePhotoInPages(fileKey, entry.url, 'photos/students');
      entry.url = pageUrl;
      persisted++;
    } catch (err) {
      console.warn(`  Photo persistence failed for ${entry.name}:`, err.message);
    }
  }

  console.log(`Photos persisted to GitHub Pages: ${persisted} (${skipped} already permanent).`);
  return { byFullName, byLastName };
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
  if (!process.env.CANONICAL_SHEET_ID)          throw new Error('CANONICAL_SHEET_ID env var is required.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required.');

  const auth = await getAuth();

  const emptyPhotos = { byFullName: new Map(), byLastName: new Map() };
  const [entries, rawPhotos] = await Promise.all([
    fetchStudentSchedule(),
    fetchStudentPhotos().catch(err => {
      console.warn('Photo fetch failed (continuing without photos):', err.message);
      return emptyPhotos;
    }),
  ]);

  console.log(`\nSchedule entries: ${entries.length}, photos: ${rawPhotos.byFullName.size}`);
  const photos = await persistPhotosToPages(rawPhotos).catch(err => {
    console.warn('GitHub Pages photo persistence failed (falling back to Airtable URLs):', err.message);
    return rawPhotos;
  });

  const sheets = google.sheets({ version: 'v4', auth });
  await Promise.all([
    writeStudentsToSheet(auth, process.env.CANONICAL_SHEET_ID, entries, photos),
    writeStudentsTab(auth, process.env.CANONICAL_SHEET_ID, photos),
  ]);
  await writeSyncTimestamp(sheets, process.env.CANONICAL_SHEET_ID, STUDENT_ROLE);
  console.log(`\nDone.`);
}

main().catch(err => { console.error(err); process.exit(1); });
