/**
 * Resident schedule sync for HGH ED Roster (canonical sheet).
 * ----------------------------------------------------------
 * Logs into the Medrez shared schedule viewer (password-protected)
 * and scrapes the HTML schedule table to extract resident shifts.
 *
 * SETUP:
 *   1. Paste this file into the canonical sheet's Apps Script project.
 *   2. Run `diagnoseMedrezLogin` first — it shows what the page
 *      returns before and after the password POST so we can confirm
 *      the login works and inspect the schedule HTML structure.
 *   3. Once confirmed, run `syncResidentsNow` and set an hourly trigger.
 */

var MEDREZ_VIEW_URL  = 'https://www.medrez.net/view.php?a=9s733y77k';
var MEDREZ_PASSWORD  = 'HGH5150';
var ROSTER_TAB       = 'roster';

var ICS_SHIFT_PATTERNS = [
  { pattern: /night|noc|overnight/i, shift: 'night'   },
  { pattern: /swing|eve|pm/i,        shift: 'evening' },
  { pattern: /day|am|morning/i,      shift: 'day'     },
];

// ---------------------------------------------------------------
// Main sync.
// ---------------------------------------------------------------

function syncResidentsNow() {
  var html = loginAndFetch_();
  if (!html) return;
  var entries = parseMedrezSchedule_(html);
  if (!entries.length) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'No resident shifts found — run "Diagnose Medrez login" to check HTML structure.',
      'Roster Sync', 8);
    return;
  }
  var n = writeRoleToRoster_(entries, 'resident');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Synced ' + n + ' resident shifts from Medrez.', 'Roster Sync', 5);
}

// ---------------------------------------------------------------
// Diagnostic: show login flow and raw HTML structure.
// ---------------------------------------------------------------

function diagnoseMedrezLogin() {
  var ui = SpreadsheetApp.getUi();

  // Step 1: GET the page.
  Logger.log('Step 1: GET ' + MEDREZ_VIEW_URL);
  var resp1 = UrlFetchApp.fetch(MEDREZ_VIEW_URL, {
    muteHttpExceptions: true, followRedirects: true,
  });
  var code1 = resp1.getResponseCode();
  var body1 = resp1.getContentText();
  Logger.log('GET response: HTTP ' + code1 + ' (' + body1.length + ' bytes)\n' +
    body1.slice(0, 2000));

  var hasPasswordForm = body1.toLowerCase().indexOf('type="password"') >= 0
                     || body1.toLowerCase().indexOf("type='password'") >= 0;

  if (!hasPasswordForm) {
    // Already past login — may be showing the schedule.
    ui.alert(
      'Step 1: HTTP ' + code1 + ', NO password form detected.\n\n' +
      'First 800 chars:\n' + body1.slice(0, 800)
    );
    analyzeScheduleHtml_(body1);
    return;
  }

  // Show the form so we can confirm field names.
  var formSnippet = extractFormHtml_(body1);
  Logger.log('Password form HTML:\n' + formSnippet);

  // Step 2: POST the password.
  var field = detectPasswordField_(body1);
  Logger.log('Using password field name: ' + field);
  var cookie1 = extractCookies_(resp1);

  var payload = {};
  payload[field] = MEDREZ_PASSWORD;

  Logger.log('Step 2: POST with field "' + field + '"');
  var resp2 = UrlFetchApp.fetch(MEDREZ_VIEW_URL, {
    method: 'post',
    payload: payload,
    headers: cookie1 ? { Cookie: cookie1 } : {},
    muteHttpExceptions: true,
    followRedirects: true,
  });
  var code2 = resp2.getResponseCode();
  var body2 = resp2.getContentText();
  Logger.log('POST response: HTTP ' + code2 + ' (' + body2.length + ' bytes)\n' +
    body2.slice(0, 3000));

  var stillLoginPage = body2.toLowerCase().indexOf('type="password"') >= 0;
  if (stillLoginPage) {
    ui.alert(
      'Login FAILED (still seeing password form after POST).\n\n' +
      'Form HTML found:\n' + formSnippet.slice(0, 600) + '\n\n' +
      'Check Execution Log for full details.'
    );
    return;
  }

  ui.alert(
    'Login OK! HTTP ' + code2 + ', ' + body2.length + ' bytes.\n\n' +
    'First 800 chars of schedule page:\n' + body2.slice(0, 800) + '\n\n' +
    'Check Execution Log for full HTML and parse analysis.'
  );
  analyzeScheduleHtml_(body2);
}

// Log a structural breakdown of the schedule page.
function analyzeScheduleHtml_(html) {
  // Strip <head> — we care about the body.
  var bodyStart = html.toLowerCase().indexOf('<body');
  var body = bodyStart >= 0 ? html.slice(bodyStart) : html;

  Logger.log('Body length: ' + body.length);

  // Log 4 evenly-spaced 600-char chunks so we see the whole page.
  var chunkSize = 600;
  var positions = [0, Math.floor(body.length * 0.25),
                   Math.floor(body.length * 0.5), Math.floor(body.length * 0.75)];
  positions.forEach(function(p, i) {
    Logger.log('=== Body chunk ' + (i+1) + ' (offset ' + p + ') ===\n' +
      body.slice(p, p + chunkSize));
  });

  // Search for embedded JSON data objects (schedule apps often bootstrap data this way).
  var jsonMatches = body.match(/(?:window\.\w+|var \w+)\s*=\s*(\{[\s\S]{20,500}?\});/g) || [];
  Logger.log('Embedded JS assignments found: ' + jsonMatches.length);
  jsonMatches.slice(0, 5).forEach(function(m, i) {
    Logger.log('JS assignment ' + (i+1) + ': ' + m.slice(0, 300));
  });

  // Look for date patterns anywhere in the body.
  var dateMatches = body.match(/\b(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2})\b/g) || [];
  Logger.log('Date-like strings found: ' + dateMatches.length +
    (dateMatches.length ? (' — sample: ' + dateMatches.slice(0,10).join(', ')) : ''));

  // Any <div> or <table> elements.
  var divCount   = (body.match(/<div/gi) || []).length;
  var tableCount = (body.match(/<table/gi) || []).length;
  Logger.log('div count: ' + divCount + ', table count: ' + tableCount);

  // Log the last 1000 chars (often where lazy-loaded content appears).
  Logger.log('=== Body tail (last 1000 chars) ===\n' + body.slice(-1000));
}

// ---------------------------------------------------------------
// Login flow.
// ---------------------------------------------------------------

function loginAndFetch_() {
  var ui = SpreadsheetApp.getUi();

  var resp = UrlFetchApp.fetch(MEDREZ_VIEW_URL, {
    muteHttpExceptions: true, followRedirects: true,
  });
  var body = resp.getContentText();
  var code = resp.getResponseCode();

  if (code !== 200) {
    ui.alert('Medrez GET failed: HTTP ' + code);
    return null;
  }

  // Already past login.
  var hasForm = body.toLowerCase().indexOf('type="password"') >= 0;
  if (!hasForm) return body;

  // POST password.
  var field = detectPasswordField_(body);
  var cookie = extractCookies_(resp);
  var payload = {};
  payload[field] = MEDREZ_PASSWORD;

  resp = UrlFetchApp.fetch(MEDREZ_VIEW_URL, {
    method: 'post',
    payload: payload,
    headers: cookie ? { Cookie: cookie } : {},
    muteHttpExceptions: true,
    followRedirects: true,
  });
  body = resp.getContentText();
  code = resp.getResponseCode();

  if (code !== 200) {
    ui.alert('Medrez POST failed: HTTP ' + code);
    return null;
  }
  if (body.toLowerCase().indexOf('type="password"') >= 0) {
    ui.alert('Medrez password rejected. Run "Diagnose Medrez login" for details.');
    return null;
  }
  return body;
}

// ---------------------------------------------------------------
// Schedule HTML parser.
// Adjust after running diagnoseMedrezLogin() to confirm layout.
// ---------------------------------------------------------------

function parseMedrezSchedule_(html) {
  var entries = [];
  var tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  Logger.log('parseMedrezSchedule_: ' + tables.length + ' tables in page.');

  for (var t = 0; t < tables.length; t++) {
    var rows = tables[t].match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (rows.length < 2) continue;

    // Look for a header row with recognisable dates.
    var headerCells = extractCells_(rows[0]);
    var dateCols = [];
    for (var c = 0; c < headerCells.length; c++) {
      var d = parseMedrezDate_(headerCells[c]);
      if (d) dateCols.push({ col: c, date: d });
    }
    if (dateCols.length < 2) continue;

    Logger.log('Schedule table found (table ' + (t+1) + '). Dates: ' +
      dateCols.map(function(dc){ return dc.date; }).join(', '));

    var currentShift = 'day';
    for (var r = 1; r < rows.length; r++) {
      var cells = extractCells_(rows[r]);
      if (!cells.length) continue;

      var maybeShift = detectShiftFromLabel_(cells[0]);
      if (maybeShift) { currentShift = maybeShift; continue; }

      var residentName = cells[0].trim();
      if (!residentName) continue;

      for (var dc = 0; dc < dateCols.length; dc++) {
        var cell = (cells[dateCols[dc].col] || '').trim();
        if (!cell || cell === '-' || cell === '' || cell === '0') continue;
        // Cell might be 'x', a checkmark, a shift label, or the name again.
        var name = (cell.toLowerCase() === 'x' || cell === '✓' || cell === '•')
          ? residentName : cell;
        entries.push({
          date:      dateCols[dc].date,
          shift:     currentShift,
          name:      name,
          title:     '',
          photo_url: '',
          notes:     '',
        });
      }
    }
  }
  Logger.log('parseMedrezSchedule_: ' + entries.length + ' entries.');
  return entries;
}

// ---------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------

function detectPasswordField_(html) {
  var m = html.match(/<input[^>]+type=["']password["'][^>]*name=["']([^"']+)["']/i)
       || html.match(/<input[^>]+name=["']([^"']+)["'][^>]*type=["']password["']/i);
  return m ? m[1] : 'password';
}

function extractCookies_(resp) {
  try {
    var h = resp.getAllHeaders();
    return (h['Set-Cookie'] || h['set-cookie'] || '');
  } catch (e) { return ''; }
}

function extractFormHtml_(html) {
  var m = html.match(/<form[\s\S]*?<\/form>/i);
  return m ? m[0] : '(no <form> found)';
}

function extractCells_(rowHtml) {
  var cells = rowHtml.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
  return cells.map(function(c) {
    return c.replace(/<[^>]+>/g, '')
             .replace(/&amp;/g,'&').replace(/&lt;/g,'<')
             .replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
             .replace(/\s+/g,' ').trim();
  });
}

function parseMedrezDate_(s) {
  if (!s) return null;
  var m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    var y = m[3] ? parseInt(m[3]) : new Date().getFullYear();
    if (y < 100) y += 2000;
    return formatIso_(new Date(y, parseInt(m[1])-1, parseInt(m[2])));
  }
  m = s.match(/([A-Za-z]{3})[.\s-]+(\d{1,2})/);
  if (m) {
    var months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    var mo = months.indexOf(m[1].toLowerCase());
    if (mo >= 0) return formatIso_(new Date(new Date().getFullYear(), mo, parseInt(m[2])));
  }
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  return null;
}

function detectShiftFromLabel_(s) {
  for (var i = 0; i < ICS_SHIFT_PATTERNS.length; i++) {
    if (ICS_SHIFT_PATTERNS[i].pattern.test(s)) return ICS_SHIFT_PATTERNS[i].shift;
  }
  return null;
}

function formatIso_(d) {
  var pad = function(n) { return String(n).padStart(2,'0'); };
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}

// ---------------------------------------------------------------
// Write roster rows for a given role (replaces existing).
// ---------------------------------------------------------------

function writeRoleToRoster_(entries, role) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var roster = ss.getSheetByName(ROSTER_TAB);
  if (!roster) throw new Error("Missing '" + ROSTER_TAB + "' tab.");
  var data = roster.getDataRange().getValues();
  if (!data.length) throw new Error('roster tab is empty.');
  var headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var idx = function(n) {
    var i = headers.indexOf(n);
    if (i < 0) throw new Error('roster missing column: ' + n);
    return i;
  };
  var roleCol  = idx('role');
  var dateCol  = idx('date');
  var shiftCol = idx('shift');
  var nameCol  = idx('name');
  var titleCol = headers.indexOf('title');
  var photoCol = headers.indexOf('photo_url');
  var notesCol = headers.indexOf('notes');

  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][roleCol]).trim().toLowerCase() === role) roster.deleteRow(i + 1);
  }
  if (!entries.length) return 0;

  var rows = entries.map(function(e) {
    var row = new Array(headers.length).fill('');
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = role;
    row[nameCol]  = e.name;
    if (titleCol >= 0) row[titleCol] = e.title     || '';
    if (photoCol >= 0) row[photoCol] = e.photo_url || '';
    if (notesCol >= 0) row[notesCol] = e.notes     || '';
    return row;
  });
  roster.getRange(roster.getLastRow()+1, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}
