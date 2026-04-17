/**
 * Resident schedule sync for HGH ED Roster (canonical sheet).
 * ----------------------------------------------------------
 * Fetches per-resident calendar subscription ICS feeds from Medrez
 * and writes shifts into the `roster` tab as role=resident.
 *
 * SETUP:
 *   1. In Medrez, get each resident's calendar subscription link
 *      (the permanent URL, e.g. http://www.medrez.net/view.php?f=...).
 *   2. Add one entry per resident to MEDREZ_RESIDENTS below.
 *   3. Run `diagnoseMedrezIcs` to confirm the feed works.
 *   4. Run `syncResidentsNow` to populate the roster.
 *   5. Add an hourly trigger for `syncResidentsNow`.
 */

// Populated automatically by discoverResidentLinks() — or fill in manually.
var MEDREZ_RESIDENTS = [
  { name: 'Alberto Romo Valenzuela', title: 'R2', url: 'http://www.medrez.net/view.php?f=2b1yqpgbj971' },
];

var MEDREZ_VIEW_URL = 'https://www.medrez.net/view.php?a=9s733y77k';
var MEDREZ_PASSWORD = 'HGH5150';

var ROSTER_TAB = 'roster';

// ---------------------------------------------------------------
// Auto-discovery: find all resident subscription links from the
// Medrez schedule page and fetch name/title from their ICS feeds.
// Run this once (or each July when the new class starts) to rebuild
// MEDREZ_RESIDENTS automatically.
//
// Results are written to a `residents_config` tab so you can review
// before committing — then paste the generated array into the script.
// ---------------------------------------------------------------

function discoverResidentLinks() {
  var ui = SpreadsheetApp.getUi();

  // Step 1: log in and get the page HTML.
  var resp = UrlFetchApp.fetch(MEDREZ_VIEW_URL, { muteHttpExceptions: true, followRedirects: true });
  var body = resp.getContentText();
  if (resp.getResponseCode() !== 200) {
    ui.alert('Login GET failed: HTTP ' + resp.getResponseCode()); return;
  }

  // POST password if needed.
  if (body.toLowerCase().indexOf('type="password"') >= 0) {
    var cookie = extractCookies_(resp);
    resp = UrlFetchApp.fetch(MEDREZ_VIEW_URL, {
      method: 'post',
      payload: { password: MEDREZ_PASSWORD },
      headers: cookie ? { Cookie: cookie } : {},
      muteHttpExceptions: true, followRedirects: true,
    });
    body = resp.getContentText();
    if (body.toLowerCase().indexOf('type="password"') >= 0) {
      ui.alert('Password rejected.'); return;
    }
  }

  // Step 2: scan entire response for view.php?f= tokens.
  var tokenRe = /[?&]f=([a-z0-9]{8,})/gi;
  var seen = {};
  var tokens = [];
  var m;
  while ((m = tokenRe.exec(body)) !== null) {
    var tok = m[1].toLowerCase();
    if (!seen[tok]) { seen[tok] = true; tokens.push(tok); }
  }
  Logger.log('Found ' + tokens.length + ' unique f= tokens in page HTML.');

  if (!tokens.length) {
    ui.alert(
      'No f= subscription tokens found in the page source.\n\n' +
      'Medrez may load them via JavaScript after page render.\n' +
      'You\'ll need to copy each link manually from the browser.'
    );
    return;
  }

  // Step 3: fetch each ICS to get the resident name from DESCRIPTION.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('residents_config')
    || ss.insertSheet('residents_config');
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 4).setValues([['name', 'title', 'url', 'raw_description']]);
  sheet.getRange(1, 1, 1, 4).setFontWeight('bold');

  var rows = [];
  for (var i = 0; i < tokens.length; i++) {
    var url = 'http://www.medrez.net/view.php?f=' + tokens[i];
    try {
      var ics = fetchIcs_(url);
      var events = extractVevents_(ics);
      var name = '', title = '', rawDesc = '';
      for (var j = 0; j < events.length; j++) {
        rawDesc = icsField_(events[j], 'DESCRIPTION') || '';
        // DESCRIPTION: "FirstName LastName  shift, ..."
        var nameMatch = rawDesc.match(/^(.+?)\s{2,}shift/i)
                     || rawDesc.match(/^(.+?)\s+shift/i);
        if (nameMatch) { name = nameMatch[1].trim(); }
        // Extract R-level from schedule name.
        var schedMatch = rawDesc.match(/\b(R[1-4])\b/i);
        if (schedMatch) { title = schedMatch[1].toUpperCase(); }
        if (name) break;
      }
      rows.push([name || '(unknown)', title || '', url, rawDesc.slice(0, 120)]);
      Logger.log('Token ' + tokens[i] + ': ' + name + ' ' + title);
    } catch (err) {
      rows.push(['(error: ' + err.message + ')', '', url, '']);
      Logger.log('Token ' + tokens[i] + ': ERROR ' + err.message);
    }
    Utilities.sleep(200); // be gentle with the server
  }

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 4).setValues(rows);
  }

  // Step 4: generate a ready-to-paste JS array in the log.
  var jsArray = 'var MEDREZ_RESIDENTS = [\n' +
    rows.map(function(r) {
      return "  { name: '" + r[0] + "', title: '" + r[1] + "', url: '" + r[2] + "' },";
    }).join('\n') +
    '\n];';
  Logger.log('=== PASTE THIS INTO THE SCRIPT ===\n' + jsArray);

  sheet.autoResizeColumns(1, 4);
  ui.alert(
    'Found ' + tokens.length + ' resident link(s).\n\n' +
    'Results written to the "residents_config" tab — review names/titles there.\n\n' +
    'The full MEDREZ_RESIDENTS array is in the Execution Log, ready to paste.'
  );
}

var SHIFT_PATTERNS = [
  { pattern: /night|noc|overnight/i, shift: 'night'   },
  { pattern: /swing|eve|pm/i,        shift: 'evening' },
  { pattern: /day|am|morning/i,      shift: 'day'     },
];

// ---------------------------------------------------------------
// Diagnostic: test the first resident's subscription feed.
// ---------------------------------------------------------------

function diagnoseMedrezIcs() {
  var ui = SpreadsheetApp.getUi();
  if (!MEDREZ_RESIDENTS.length) {
    ui.alert('Add at least one entry to MEDREZ_RESIDENTS first.');
    return;
  }
  var r = MEDREZ_RESIDENTS[0];
  Logger.log('Fetching: ' + r.url);
  var resp = UrlFetchApp.fetch(r.url, { muteHttpExceptions: true, followRedirects: true });
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  var len = body.length;
  Logger.log('HTTP ' + code + ', ' + len + ' bytes');
  Logger.log('First 2000 chars:\n' + body.slice(0, 2000));

  var isIcs = body.indexOf('BEGIN:VCALENDAR') >= 0;
  if (!isIcs) {
    ui.alert('HTTP ' + code + ', ' + len + ' bytes — NOT ICS.\n\nStarts with:\n' +
      body.slice(0, 400));
    return;
  }

  var events = extractVevents_(body);
  // Show first 5 events.
  var sample = events.slice(0, 5).map(function(e, i) {
    return 'Event ' + (i+1) + ':\n' +
      '  SUMMARY: '  + (icsField_(e, 'SUMMARY')  || '?') + '\n' +
      '  DTSTART: '  + (icsField_(e, 'DTSTART')  || '?') + '\n' +
      '  DTEND: '    + (icsField_(e, 'DTEND')    || '?') + '\n' +
      '  DESCRIPTION: ' + (icsField_(e, 'DESCRIPTION') || '?');
  }).join('\n');
  Logger.log('Events: ' + events.length + '\n' + sample);

  // Unique summaries.
  var sums = {};
  for (var i = 0; i < events.length; i++) {
    var s = icsField_(events[i], 'SUMMARY') || '(none)';
    sums[s] = (sums[s] || 0) + 1;
  }
  var sumList = Object.keys(sums).sort().map(function(k) {
    return '  ' + k + ' (' + sums[k] + ')';
  }).join('\n');
  Logger.log('Unique SUMMARYs:\n' + sumList);

  ui.alert(
    r.name + ': HTTP ' + code + ', ' + events.length + ' events.\n\n' +
    sample.slice(0, 800) + '\n\nUnique SUMMARYs:\n' + sumList.slice(0, 600)
  );
}

// ---------------------------------------------------------------
// Main sync.
// ---------------------------------------------------------------

function syncResidentsNow() {
  if (!MEDREZ_RESIDENTS.length) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'No residents configured.', 'Roster Sync', 5);
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
// ICS fetch.
// ---------------------------------------------------------------

function fetchIcs_(url) {
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code !== 200) throw new Error('HTTP ' + code);
  if (body.indexOf('BEGIN:VCALENDAR') < 0) {
    throw new Error('Not ICS. Starts with: ' + body.slice(0, 80));
  }
  return body;
}

// ---------------------------------------------------------------
// ICS parser.
// ---------------------------------------------------------------

function parseResidentIcs_(ics, residentName, title) {
  var events = extractVevents_(ics);
  var entries = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var summary = icsField_(ev, 'SUMMARY') || '';
    var dtstart = icsField_(ev, 'DTSTART') || '';
    var desc    = icsField_(ev, 'DESCRIPTION') || '';

    if (/there was a problem/i.test(summary)) continue;

    var date = parseIcsDate_(dtstart);
    if (!date) continue;

    var shift = detectShift_(summary + ' ' + desc, dtstart);

    entries.push({
      date:      date,
      shift:     shift,
      name:      residentName,
      title:     title || '',
      photo_url: '',
      notes:     summary || '',
    });
  }
  return entries;
}

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
  var m = dtstart.match(/(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return m[1] + '-' + m[2] + '-' + m[3];
}

function extractCookies_(resp) {
  try {
    var h = resp.getAllHeaders();
    return h['Set-Cookie'] || h['set-cookie'] || '';
  } catch (e) { return ''; }
}

function detectShift_(text, dtstart) {
  // Prefer DTSTART time — it's unambiguous. Some summaries like
  // "Backup (Day/E Swing/Swing)" contain mixed keywords that confuse
  // text matching, but the start hour is always definitive.
  var m = dtstart.match(/T(\d{2})/);
  if (m) {
    var h = parseInt(m[1], 10);
    if (h >= 23 || h < 7)  return 'night';
    if (h >= 15)            return 'evening';
    return 'day';
  }
  // No time component (all-day event) — fall back to text patterns.
  for (var i = 0; i < SHIFT_PATTERNS.length; i++) {
    if (SHIFT_PATTERNS[i].pattern.test(text)) return SHIFT_PATTERNS[i].shift;
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
  roster.getRange(roster.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}
