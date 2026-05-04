// ER Staff Display — configuration
// -------------------------------------------------------------
// Fill these values in once you have the real URLs. Each data
// source is optional; leave as null/empty to disable it. Until
// real sources are configured, the app falls back to the sample
// roster in /sample-data/roster.csv so the UI is viewable.
// -------------------------------------------------------------

export const config = {
  // Shift block definitions. Hours use the local browser time zone.
  // "end" is exclusive. A shift whose end <= start (e.g. night) is
  // treated as crossing midnight.
  shifts: [
    { name: "day",     label: "Day",     start: 7,  end: 15 },
    { name: "evening", label: "Swing",   start: 15, end: 23 },
    { name: "night",   label: "Night",   start: 23, end: 7  }, // wraps midnight
  ],

  // Roles shown as columns, in display order.
  roles: [
    { key: "attending", label: "Attendings" },
    { key: "resident",  label: "Residents"  },
    { key: "student",   label: "Medical Students" },
  ],

  // Refresh interval for the clock + "now" recomputation (ms).
  tickIntervalMs: 30_000,
  // How often to re-fetch source data (ms).
  reloadIntervalMs: 5 * 60_000,

  // ----- Data sources -----
  // Expected CSV columns (header row required; extra columns OK):
  //   date        YYYY-MM-DD   (calendar date the shift starts)
  //   shift       day|evening|night
  //   role        attending|resident|student
  //   name        Full name
  //   photo_url   Public URL to a photo (optional)
  //   title       e.g. "PGY-2", "MS4", "Chief" (optional)
  //   notes       Freeform (optional)
  sources: {
    // Google Sheet "Publish to web" CSV URL.
    // File -> Share -> Publish to web -> CSV. Paste the URL here.
    sheetCsvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmwF87H6dQZvru4z3JfUFFASk9a8xheUgwPxY5w_TGGiD-oVr2xWpnipqnRqSQ8zr8XBi0RTyR8UJ/pub?gid=0&single=true&output=csv",

    // Google Doc "Publish to web" URL (the /pub link). Optional.
    // The adapter tries to parse the first <table> in the document.
    docPubUrl: null,

    // Any additional public websites whose schedule tables should
    // also be pulled in. Each entry: { url, adapter }.
    // Adapter names are resolved in js/sources/web.js.
    websites: [
      // { url: "https://example.org/er-schedule", adapter: "genericTable" },
    ],

    // Published CSV URLs for per-person data tabs (students, residents, attendings).
    // In Google Sheets: File → Share → Publish to web → select each tab → CSV → copy URL.
    // When set, the app reads photo_url and title from these tabs and joins them onto
    // roster rows by name, so editing a person here updates every shift they appear in.
    personSheetUrls: {
      student:   null,
      resident:  null,
      attending: null,
    },

    // Local fallback used when no remote sources return data.
    // Keep this as a relative path so the static site works offline.
    sampleCsvUrl: "sample-data/roster.csv",
  },
};
