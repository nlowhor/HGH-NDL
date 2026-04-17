/**
 * Resident schedule sync for HGH ED Roster (canonical sheet).
 * ----------------------------------------------------------
 * Scrapes the Medrez schedule viewer, parses resident shifts,
 * and writes them into the `roster` tab as role=resident rows.
 *
 * SETUP (in the canonical sheet's Apps Script project):
 *   1. Paste this file alongside syncStudents.gs (or merge them).
 *      Extensions -> Apps Script -> + (new file) -> paste -> Save.
 *   2. Run `diagnoseMedrez` once from the editor to confirm the
 *      fetch + login works and to inspect the raw HTML structure.
 *      Check the Execution Log (View -> Logs or Executions) for output.
 *   3. Once the parser is confirmed, set up a trigger:
 *      Triggers (clock icon) -> Add Trigger -> `syncResidentsNow`,
 *      Time-driven, Hour timer, Every hour. Save.
 *   4. Reload the spreadsheet; "Roster Sync" menu gains
 *      "Pull residents now".
 */

const MEDREZ_URL      = 'https://www.medrez.net/view.php?a=9s733y77k';
const MEDREZ_PASSWORD = 'HGH5150';
const RESIDENT_ROLE   = 'resident';

// Column in the canonical roster tab.
const ROSTER_TAB = 'roster';

// ---------------------------------------------------------------
// Menu registration — called from onOpen() in syncStudents.gs.
// Add this line to the createMenu() chain there:
//   .addItem('Pull residents now', 'syncResidentsNow')
// ---------------------------------------------------------------

function syncResidentsNow() {
  const html = fetchMedrez_();
  if (!html) return;
  const entries = parseMedrezHtml(html);
  const n = writeRoleToRoster(entries, RESIDENT_ROLE);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Synced ' + n + ' resident shifts from Medrez.',
    'Roster Sync', 5);
}

// Diagnostic: fetch Medrez and pop up the first 3000 chars of HTML
// so you can see the login/schedule structure without guessing.
function diagnoseMedrez() {
  const html = fetchMedrez_();
  if (!html) return;
  const preview = html.slice(0, 3000);
  Logger.log('=== MEDREZ HTML (first 3000 chars) ===\n' + preview);
  SpreadsheetApp.getUi().alert(
    'Medrez fetch OK — ' + html.length + ' bytes.\n\n' +
    'Check Execution Log (Apps Script → Executions) for first 3000 chars.\n\n' +
    'Snippet:\n' + preview.slice(0, 500)
  );
}

// ---------------------------------------------------------------
// HTTP: fetch the Medrez schedule, handling the password gate.
// ---------------------------------------------------------------

function fetchMedrez_() {
  const ui = SpreadsheetApp.getUi();

  // Step 1: GET the page to pick up any session cookie + form fields.
  let resp = UrlFetchApp.fetch(MEDREZ_URL, {
    muteHttpExceptions: true,
    followRedirects: true,
  });

  let html = resp.getContentText();
  const code = resp.getResponseCode();

  if (code !== 200) {
    ui.alert('Medrez fetch failed: HTTP ' + code);
    return null;
  }

  // If the page already shows schedule content (no password form),
  // we're done.
  if (!looksLikeLoginPage_(html)) return html;

  // Step 2: submit the password form.
  // Medrez typically uses a simple POST with field `password` or `pw`.
  // We try the most common field names; diagnoseMedrez() will show you
  // the actual form if this step fails.
  const passwordField = detectPasswordField_(html);
  Logger.log('Detected password field name: ' + passwordField);

  const cookies = resp.getAllHeaders()['Set-Cookie'] || '';
  resp = UrlFetchApp.fetch(MEDREZ_URL, {
    method: 'post',
    payload: buildPasswordPayload_(passwordField),
    headers: { 'Cookie': cookies },
    muteHttpExceptions: true,
    followRedirects: true,
  });

  html = resp.getContentText();
  if (resp.getResponseCode() !== 200) {
    ui.alert('Medrez POST failed: HTTP ' + resp.getResponseCode());
    return null;
  }
  if (looksLikeLoginPage_(html)) {
    ui.alert(
      'Medrez password was rejected or form field name is unexpected.\n' +
      'Run "Diagnose Medrez fetch" and share the HTML snippet so the\n' +
      'field name can be identified.'
    );
    return null;
  }
  return html;
}

function looksLikeLoginPage_(html) {
  const lower = html.toLowerCase();
  return lower.includes('type="password"') || lower.includes("type='password'");
}

function detectPasswordField_(html) {
  // Try to pull the name attribute off the password input.
  const m = html.match(/<input[^>]+type=["']password["'][^>]*name=["']([^"']+)["']/i)
         || html.match(/<input[^>]+name=["']([^"']+)["'][^>]*type=["']password["']/i);
  if (m) return m[1];
  // Common fallbacks.
  if (html.toLowerCase().includes('name="pw"')) return 'pw';
  return 'password';
}

function buildPasswordPayload_(field) {
  const payload = {};
  payload[field] = MEDREZ_PASSWORD;
  return payload;
}

// ---------------------------------------------------------------
// HTML parser: extract shifts from the Medrez schedule table.
//
// NOTE: This is written against the typical Medrez layout where the
// schedule is rendered as an HTML table with date headers and resident
// names. Run diagnoseMedrez() first to verify the structure matches;
// if the selectors don't line up the function returns [] and logs
// details so we can adjust.
// ---------------------------------------------------------------

function parseMedrezHtml(html) {
  const entries = [];

  // Find all <table> elements.
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  Logger.log('Found ' + tables.length + ' table(s) in Medrez HTML.');

  for (const table of tables) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (rows.length < 2) continue;

    // Try to interpret the first row as a header with date cells.
    const headerCells = extractCells_(rows[0]);
    const dateCols = [];
    for (let c = 0; c < headerCells.length; c++) {
      const d = parseMedrezDate_(headerCells[c]);
      if (d) dateCols.push({ col: c, date: d });
    }
    if (dateCols.length < 2) continue; // Not a schedule table.
    Logger.log('Schedule table found. Dates: ' +
      dateCols.map(function (dc) { return dc.date; }).join(', '));

    // Remaining rows: each row is a shift block or a resident entry.
    let currentShift = 'day';
    for (let r = 1; r < rows.length; r++) {
      const cells = extractCells_(rows[r]);
      if (!cells.length) continue;

      // If the first cell looks like a shift label, update currentShift.
      const maybeShift = normalizeShiftLabel_(cells[0]);
      if (maybeShift) { currentShift = maybeShift; continue; }

      // Otherwise treat as a data row: name in col 0, presence flags
      // or names in date columns.
      const nameCell = cells[0];
      if (!nameCell) continue;

      for (const dc of dateCols) {
        const cell = (cells[dc.col] || '').trim();
        if (!cell || cell === '-' || cell === '0') continue;
        // Cell may contain an 'x', a checkmark, or the resident's name.
        const residentName = (cell.toLowerCase() === 'x' || cell === '✓')
          ? nameCell
          : cell;
        entries.push({
          date:  dc.date,
          shift: currentShift,
          role:  RESIDENT_ROLE,
          name:  residentName.trim(),
          title: '',
          photo_url: '',
          notes: '',
        });
      }
    }
  }

  Logger.log('parseMedrezHtml: ' + entries.length + ' entries extracted.');
  return entries;
}

// ---------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------

function extractCells_(rowHtml) {
  const cells = rowHtml.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
  return cells.map(function (c) {
    return c.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&')
             .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
             .replace(/&nbsp;/g,' ').trim();
  });
}

function parseMedrezDate_(s) {
  if (!s) return null;
  // "Mon 4/13", "4/13/26", "Apr 13", "2026-04-13"
  let m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    let y = m[3] ? parseInt(m[3]) : new Date().getFullYear();
    if (y < 100) y += 2000;
    return formatIso_(new Date(y, parseInt(m[1]) - 1, parseInt(m[2])));
  }
  m = s.match(/([A-Za-z]{3})[.\s-]+(\d{1,2})/);
  if (m) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mo = months.indexOf(m[1].toLowerCase());
    if (mo >= 0) return formatIso_(new Date(new Date().getFullYear(), mo, parseInt(m[2])));
  }
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  return null;
}

function normalizeShiftLabel_(s) {
  if (!s) return null;
  const u = s.toUpperCase().trim();
  if (/\bDAY\b/.test(u))     return 'day';
  if (/SWING|EVE|PM/.test(u)) return 'evening';
  if (/NIGHT|NOC|OVERNIGH/.test(u)) return 'night';
  return null;
}

function formatIso_(d) {
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// ---------------------------------------------------------------
// Generic write function: replaces all rows with a given role in
// the roster tab. Shared with student sync if you like.
// ---------------------------------------------------------------

function writeRoleToRoster(entries, role) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const roster = ss.getSheetByName(ROSTER_TAB);
  if (!roster) throw new Error("Missing '" + ROSTER_TAB + "' tab.");

  const data = roster.getDataRange().getValues();
  if (!data.length) throw new Error("roster tab is empty.");
  const headers = data[0].map(function (h) { return String(h).trim().toLowerCase(); });

  const idx = function (name) {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error('roster tab missing column: ' + name);
    return i;
  };
  const roleCol  = idx('role');
  const dateCol  = idx('date');
  const shiftCol = idx('shift');
  const nameCol  = idx('name');
  const titleCol = headers.indexOf('title');
  const photoCol = headers.indexOf('photo_url');
  const notesCol = headers.indexOf('notes');

  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][roleCol]).trim().toLowerCase() === role.toLowerCase()) {
      roster.deleteRow(i + 1);
    }
  }

  if (!entries.length) return 0;

  const rows = entries.map(function (e) {
    const row = new Array(headers.length).fill('');
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = role;
    row[nameCol]  = e.name;
    if (titleCol >= 0) row[titleCol] = e.title  || '';
    if (photoCol >= 0) row[photoCol] = e.photo_url || '';
    if (notesCol >= 0) row[notesCol] = e.notes  || '';
    return row;
  });

  const lastRow = roster.getLastRow();
  roster.getRange(lastRow + 1, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}
