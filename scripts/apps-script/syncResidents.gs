/**
 * Resident schedule sync for HGH ED Roster (canonical sheet).
 * ----------------------------------------------------------
 * Fetches ICS (iCalendar) feeds from Medrez for each residency
 * class, parses the VEVENT entries into flat roster rows, and
 * writes them into the `roster` tab as role=resident.
 *
 * SETUP (in the canonical sheet's Apps Script project):
 *   1. Paste this file alongside syncStudents.gs.
 *      Extensions -> Apps Script -> + (new file) -> paste -> Save.
 *   2. Add each class's ICS URL to the MEDREZ_ICS_FEEDS array below.
 *      You get these URLs from Medrez: schedule view → export →
 *      static ICS file → copy link.
 *   3. Run `diagnoseMedrez` once to verify the fetch works and
 *      inspect the VEVENT structure.
 *   4. Run `syncResidentsNow` to pull shifts into the roster.
 *   5. Triggers (clock icon) -> Add Trigger -> `syncResidentsNow`,
 *      Time-driven, Hour timer, Every hour. Save.
 *   6. Reload the spreadsheet; "Roster Sync" menu gains
 *      "Pull residents now".
 */

// Add one entry per residency class (R1, R2, R3, etc.).
// Each object: { label: "R1", url: "https://www.medrez.net/..." }
var MEDREZ_ICS_FEEDS = [
  {
    label: 'R1',
    url: 'https://www.medrez.net/view.php?a=9s733y77k&s=br4v200xm&from_date=2025-06-23&to_date=2026-06-21&theme=ical&salt=0.7418443263884366',
  },
  {
    label: 'resident',  // fallback if R-level not found in event summary
    url: 'https://www.medrez.net/view.php?a=9s733y77k&s=le9u5c4n6&from_date=2025-07-28&to_date=2026-07-26&theme=ical&salt=0.15048210449681',
  },
];

var MEDREZ_PASSWORD = 'HGH5150';
var RESIDENT_ROLE   = 'resident';
var ROSTER_TAB      = 'roster';

// Shift name mapping from ICS event summaries.
// Keys are tested as substrings (case-insensitive) against the
// SUMMARY field. First match wins. Adjust if Medrez uses different labels.
var ICS_SHIFT_PATTERNS = [
  { pattern: /night|noc|overnigh/i,       shift: 'night'   },
  { pattern: /swing|eve|pm|afternoon/i,   shift: 'evening' },
  { pattern: /day|am|morning/i,           shift: 'day'     },
];

// ---------------------------------------------------------------
// Main entry points.
// ---------------------------------------------------------------

function syncResidentsNow() {
  var allEntries = [];
  var errors = [];
  for (var i = 0; i < MEDREZ_ICS_FEEDS.length; i++) {
    var feed = MEDREZ_ICS_FEEDS[i];
    try {
      var ics = fetchMedrezIcs_(feed.url);
      var entries = parseIcsToEntries(ics, feed.label);
      allEntries = allEntries.concat(entries);
    } catch (err) {
      errors.push(feed.label + ': ' + err.message);
    }
  }
  var n = writeRoleToRoster(allEntries, RESIDENT_ROLE);
  var msg = 'Synced ' + n + ' resident shifts from ' + MEDREZ_ICS_FEEDS.length + ' feed(s).';
  if (errors.length) msg += '\nErrors: ' + errors.join('; ');
  SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Roster Sync', 8);
}

function diagnoseMedrez() {
  if (!MEDREZ_ICS_FEEDS.length) {
    SpreadsheetApp.getUi().alert('No ICS feeds configured. Add URLs to MEDREZ_ICS_FEEDS.');
    return;
  }
  var feed = MEDREZ_ICS_FEEDS[0];

  // Raw fetch — show exactly what the server returns before any parsing.
  var resp = UrlFetchApp.fetch(feed.url, { muteHttpExceptions: true, followRedirects: true });
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  Logger.log('HTTP ' + code + '\n\n' + body.slice(0, 3000));

  var isIcs = body.trim().indexOf('BEGIN:VCALENDAR') === 0;
  var snippet = body.slice(0, 600);

  if (!isIcs) {
    SpreadsheetApp.getUi().alert(
      'Medrez returned HTTP ' + code + ' but NOT an ICS file.\n\n' +
      'Response starts with:\n' + snippet + '\n\n' +
      'Full response in Execution Log.'
    );
    return;
  }

  var events = extractVevents_(body);
  var summaries = {};
  for (var i = 0; i < events.length; i++) {
    var s = icsField_(events[i], 'SUMMARY');
    if (s) summaries[s] = (summaries[s] || 0) + 1;
  }
  var summaryList = Object.keys(summaries).sort().map(function (k) {
    return '  ' + k + ' (' + summaries[k] + ')';
  }).join('\n');

  var sample = events.slice(0, 3).map(function (e, i) {
    return '--- Event ' + (i + 1) + ' ---\n' + e;
  }).join('\n\n');
  Logger.log('=== Sample events ===\n' + sample);

  SpreadsheetApp.getUi().alert(
    'Medrez ICS diagnosis',
    feed.label + ': HTTP ' + code + ', ' + events.length + ' events.\n\n' +
    'Unique SUMMARYs:\n' + summaryList.slice(0, 1500),
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ---------------------------------------------------------------
// ICS fetch — handles optional password gate.
// ---------------------------------------------------------------

function fetchMedrezIcs_(url) {
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
  });
  var body = resp.getContentText();
  var code = resp.getResponseCode();

  // If we got the ICS directly (starts with BEGIN:VCALENDAR), done.
  if (code === 200 && body.trim().indexOf('BEGIN:VCALENDAR') === 0) {
    return body;
  }

  // Might be a password-gated HTML page. Try submitting the password.
  if (code === 200 && body.toLowerCase().indexOf('type="password"') >= 0) {
    var field = detectPasswordField_ics_(body);
    var cookies = resp.getAllHeaders()['Set-Cookie'] || '';
    resp = UrlFetchApp.fetch(url, {
      method: 'post',
      payload: buildPayload_(field),
      headers: { 'Cookie': cookies },
      muteHttpExceptions: true,
      followRedirects: true,
    });
    body = resp.getContentText();
    code = resp.getResponseCode();
    if (code === 200 && body.trim().indexOf('BEGIN:VCALENDAR') === 0) {
      return body;
    }
  }

  throw new Error('HTTP ' + code + '; response does not look like ICS (' +
    body.slice(0, 120).replace(/\n/g, ' ') + '...)');
}

function detectPasswordField_ics_(html) {
  var m = html.match(/<input[^>]+type=["']password["'][^>]*name=["']([^"']+)["']/i)
       || html.match(/<input[^>]+name=["']([^"']+)["'][^>]*type=["']password["']/i);
  return m ? m[1] : 'password';
}

function buildPayload_(field) {
  var p = {};
  p[field] = MEDREZ_PASSWORD;
  return p;
}

// ---------------------------------------------------------------
// ICS parser — extract VEVENTs and map to roster entries.
// ---------------------------------------------------------------

function parseIcsToEntries(ics, feedLabel) {
  var events = extractVevents_(ics);
  var entries = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var summary  = icsField_(ev, 'SUMMARY')     || '';
    var dtstart  = icsField_(ev, 'DTSTART')      || '';
    var dtend    = icsField_(ev, 'DTEND')         || '';
    var desc     = icsField_(ev, 'DESCRIPTION')   || '';
    var location = icsField_(ev, 'LOCATION')      || '';

    // Parse resident name from SUMMARY.
    // Common patterns: "LastName, FirstName - Day", "FirstName LastName",
    // or just the event title. Adapt after running diagnoseMedrez().
    var name = extractResidentName_(summary);
    if (!name) continue;

    // Parse date from DTSTART (format: 20260413 or 20260413T070000 or 20260413T070000Z).
    var date = parseIcsDate_(dtstart);
    if (!date) continue;

    // Determine shift from SUMMARY, DESCRIPTION, or time.
    var shift = detectShift_(summary + ' ' + desc, dtstart);

    // PGY level from the event itself; fall back to feed label.
    var title = extractPgyLevel_(summary) || feedLabel || '';

    entries.push({
      date:      date,
      shift:     shift,
      role:      RESIDENT_ROLE,
      name:      name,
      title:     title,
      photo_url: '',
      notes:     location || '',
    });
  }
  Logger.log('parseIcsToEntries(' + feedLabel + '): ' + entries.length +
    ' entries from ' + events.length + ' events.');
  return entries;
}

function extractVevents_(ics) {
  var results = [];
  var re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
  var m;
  while ((m = re.exec(ics)) !== null) {
    results.push(m[1]);
  }
  return results;
}

function icsField_(block, field) {
  // Handles folded lines (continuation lines start with space or tab).
  var re = new RegExp('(?:^|\\n)' + field + '[^:]*:([^\\n]*(?:\\n[ \\t][^\\n]*)*)');
  var m = block.match(re);
  if (!m) return null;
  return m[1].replace(/\r/g, '').replace(/\n[ \t]/g, '').trim();
}

function extractResidentName_(summary) {
  if (!summary) return null;
  // Strip PGY level tokens so they don't end up in the name.
  var name = summary
    .replace(/\bR[1-4]\b/gi, '')
    .replace(/\bPGY[-\s]?[1-4]\b/gi, '')
    // Strip shift suffixes: " - Day Shift", " (Night)", etc.
    .replace(/\s*[-–—]\s*(day|swing|evening|night|noc|overnight).*$/i, '')
    .replace(/\s*\((day|swing|evening|night|noc|overnight)[^)]*\)\s*$/i, '')
    // Clean up leftover punctuation/whitespace.
    .replace(/[-–—,]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return name || null;
}

// Extract R1/R2/R3/R4 label from the event SUMMARY.
// Returns null if not found (caller falls back to feed label).
function extractPgyLevel_(summary) {
  if (!summary) return null;
  var m = summary.match(/\b(R[1-4])\b/i)
       || summary.match(/\bPGY[-\s]?([1-4])\b/i);
  if (!m) return null;
  // Normalise to "R1" / "R2" etc.
  var raw = m[1].toUpperCase();
  return raw.length === 1 ? 'R' + raw : raw; // handle PGY match group
}

function parseIcsDate_(dtstart) {
  if (!dtstart) return null;
  // "20260413", "20260413T070000", "20260413T070000Z"
  var m = dtstart.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return m[1] + '-' + m[2] + '-' + m[3];
}

function detectShift_(text, dtstart) {
  // Try text-based patterns first.
  for (var i = 0; i < ICS_SHIFT_PATTERNS.length; i++) {
    if (ICS_SHIFT_PATTERNS[i].pattern.test(text)) {
      return ICS_SHIFT_PATTERNS[i].shift;
    }
  }
  // Fall back to start hour if available.
  var m = dtstart.match(/T(\d{2})/);
  if (m) {
    var hour = parseInt(m[1], 10);
    if (hour >= 23 || hour < 7)  return 'night';
    if (hour >= 15)              return 'evening';
    return 'day';
  }
  return 'day';
}

// ---------------------------------------------------------------
// Generic write function: replaces all rows with a given role in
// the roster tab.
// ---------------------------------------------------------------

function writeRoleToRoster(entries, role) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var roster = ss.getSheetByName(ROSTER_TAB);
  if (!roster) throw new Error("Missing '" + ROSTER_TAB + "' tab.");

  var data = roster.getDataRange().getValues();
  if (!data.length) throw new Error('roster tab is empty.');
  var headers = data[0].map(function (h) { return String(h).trim().toLowerCase(); });

  var idx = function (name) {
    var i = headers.indexOf(name);
    if (i < 0) throw new Error('roster tab missing column: ' + name);
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
    if (String(data[i][roleCol]).trim().toLowerCase() === role.toLowerCase()) {
      roster.deleteRow(i + 1);
    }
  }

  if (!entries.length) return 0;

  var rows = entries.map(function (e) {
    var row = new Array(headers.length).fill('');
    row[dateCol]  = e.date;
    row[shiftCol] = e.shift;
    row[roleCol]  = role;
    row[nameCol]  = e.name;
    if (titleCol >= 0) row[titleCol] = e.title  || '';
    if (photoCol >= 0) row[photoCol] = e.photo_url || '';
    if (notesCol >= 0) row[notesCol] = e.notes  || '';
    return row;
  });

  var lastRow = roster.getLastRow();
  roster.getRange(lastRow + 1, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}
