/**
 * Resident schedule sync for HGH ED Roster (canonical sheet).
 * ----------------------------------------------------------
 * Fetches individual calendar subscription ICS feeds from Medrez
 * (one per resident) and writes shifts into the `roster` tab.
 *
 * SETUP:
 *   1. In Medrez, open each resident's schedule and get their
 *      personal calendar subscription link (a persistent URL with
 *      an auth token — NOT the one-time export link).
 *   2. Add one entry per resident to MEDREZ_RESIDENTS below.
 *   3. Run `diagnoseMedrez` once to confirm the feeds work.
 *   4. Run `syncResidentsNow` to populate the roster.
 *   5. Triggers -> Add Trigger -> `syncResidentsNow`, Hour timer.
 */

var MEDREZ_RESIDENTS = [
  // { name: 'Smith, John',   title: 'R1', url: 'https://www.medrez.net/...' },
  // { name: 'Jones, Sarah',  title: 'R2', url: 'https://www.medrez.net/...' },
  // { name: 'Chen, Michael', title: 'R3', url: 'https://www.medrez.net/...' },
];

var ROSTER_TAB = 'roster';

// Shift detection from VEVENT SUMMARY / DESCRIPTION / start hour.
var ICS_SHIFT_PATTERNS = [
  { pattern: /night|noc|overnight/i, shift: 'night'   },
  { pattern: /swing|eve|pm/i,        shift: 'evening' },
  { pattern: /day|am|morning/i,      shift: 'day'     },
];

// ---------------------------------------------------------------
// Main sync.
// ---------------------------------------------------------------

function syncResidentsNow() {
  if (!MEDREZ_RESIDENTS.length) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'No residents configured in MEDREZ_RESIDENTS.', 'Roster Sync', 5);
    return;
  }
  var allEntries = [];
  var errors = [];
  for (var i = 0; i < MEDREZ_RESIDENTS.length; i++) {
    var r = MEDREZ_RESIDENTS[i];
    try {
      var ics = fetchIcs_(r.url);
      var entries = parseResidentIcs_(ics, r.name, r.title);
      allEntries = allEntries.concat(entries);
    } catch (err) {
      errors.push(r.name + ': ' + err.message);
    }
  }
  var n = writeRoleToRoster_(allEntries, 'resident');
  var msg = 'Synced ' + n + ' resident shifts (' + MEDREZ_RESIDENTS.length + ' residents).';
  if (errors.length) msg += '\nErrors: ' + errors.join('; ');
  SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Roster Sync', 8);
}

// ---------------------------------------------------------------
// Diagnostic: test the first resident's feed.
// ---------------------------------------------------------------

function diagnoseMedrez() {
  var ui = SpreadsheetApp.getUi();
  if (!MEDREZ_RESIDENTS.length) {
    ui.alert('Add at least one entry to MEDREZ_RESIDENTS first.');
    return;
  }
  var r = MEDREZ_RESIDENTS[0];
  var resp = UrlFetchApp.fetch(r.url, { muteHttpExceptions: true, followRedirects: true });
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  Logger.log('HTTP ' + code + '\n\n' + body.slice(0, 3000));

  if (body.trim().indexOf('BEGIN:VCALENDAR') !== 0) {
    ui.alert(
      'HTTP ' + code + ' — not an ICS file.\n\nResponse:\n' + body.slice(0, 600)
    );
    return;
  }

  var events = extractVevents_(body);
  var sample = events.slice(0, 5).map(function (e, i) {
    return '--- Event ' + (i + 1) + ' ---\n' +
      'SUMMARY: '  + (icsField_(e, 'SUMMARY')  || '(none)') + '\n' +
      'DTSTART: '  + (icsField_(e, 'DTSTART')  || '(none)') + '\n' +
      'DTEND: '    + (icsField_(e, 'DTEND')    || '(none)') + '\n' +
      'DESCRIPTION: ' + (icsField_(e, 'DESCRIPTION') || '(none)');
  }).join('\n\n');

  var parsed = parseResidentIcs_(body, r.name, r.title);
  Logger.log('=== Sample events ===\n' + sample);

  ui.alert(
    'Medrez ICS — ' + r.name,
    code + ' OK. ' + events.length + ' events, ' + parsed.length + ' mapped to shifts.\n\n' +
    'Sample events (see Execution Log for full output):\n\n' + sample.slice(0, 1200),
    ui.ButtonSet.OK
  );
}

// ---------------------------------------------------------------
// ICS fetch.
// ---------------------------------------------------------------

function fetchIcs_(url) {
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code !== 200) throw new Error('HTTP ' + code);
  if (body.trim().indexOf('BEGIN:VCALENDAR') !== 0) {
    throw new Error('Not an ICS file. Starts with: ' + body.slice(0, 80).replace(/\n/g, ' '));
  }
  return body;
}

// ---------------------------------------------------------------
// ICS parser — per-resident feed.
// Each event belongs to one person; name/title come from config.
// ---------------------------------------------------------------

function parseResidentIcs_(ics, residentName, title) {
  var events = extractVevents_(ics);
  var entries = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var summary  = icsField_(ev, 'SUMMARY')     || '';
    var dtstart  = icsField_(ev, 'DTSTART')      || '';
    var desc     = icsField_(ev, 'DESCRIPTION')   || '';

    // Skip Medrez "problem" placeholder events.
    if (/there was a problem/i.test(summary) || /there was a problem/i.test(desc)) continue;

    var date = parseIcsDate_(dtstart);
    if (!date) continue;

    var shift = detectShift_(summary + ' ' + desc, dtstart);

    entries.push({
      date:      date,
      shift:     shift,
      name:      residentName,
      title:     title || '',
      photo_url: '',
      notes:     '',
    });
  }
  return entries;
}

// ---------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------

function extractVevents_(ics) {
  var results = [];
  var re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
  var m;
  while ((m = re.exec(ics)) !== null) results.push(m[1]);
  return results;
}

function icsField_(block, field) {
  var re = new RegExp('(?:^|\\n)' + field + '[^:]*:([^\\n]*(?:\\n[ \\t][^\\n]*)*)');
  var m = block.match(re);
  if (!m) return null;
  return m[1].replace(/\r/g, '').replace(/\n[ \t]/g, '').trim();
}

function parseIcsDate_(dtstart) {
  if (!dtstart) return null;
  var m = dtstart.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return m[1] + '-' + m[2] + '-' + m[3];
}

function detectShift_(text, dtstart) {
  for (var i = 0; i < ICS_SHIFT_PATTERNS.length; i++) {
    if (ICS_SHIFT_PATTERNS[i].pattern.test(text)) return ICS_SHIFT_PATTERNS[i].shift;
  }
  var m = dtstart.match(/T(\d{2})/);
  if (m) {
    var h = parseInt(m[1], 10);
    if (h >= 23 || h < 7)  return 'night';
    if (h >= 15)            return 'evening';
    return 'day';
  }
  return 'day';
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
  var headers = data[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var idx = function (n) {
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

  var rows = entries.map(function (e) {
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
  roster.getRange(roster.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}
