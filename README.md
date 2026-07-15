# HGH ED Staff Board

A display board showing who is working in the Emergency Department right now —
attendings, residents, and medical students — with names, photos, and shifts.

**Live site:** hosted on GitHub Pages from the `live` branch of this repository.

This guide is written for a non-technical administrator. You should not need to
touch any code for day-to-day upkeep.

---

## How it works (the 30-second version)

```
QGenda (attendings)  ──┐
Medrez (residents)   ──┼──▶  daily sync robots  ──▶  canonical Google Sheet  ──▶  the website
Clerkship schedule   ──┤     (GitHub Actions,
  + Airtable photos ───┘      run every morning)
```

- Three **sync robots** run automatically every morning (~6:00–6:30 AM Pacific).
  They read the source schedules and rewrite the **roster** tab of the canonical
  Google Sheet.
- The **website** reads the canonical Google Sheet (published as CSV) every
  5 minutes and displays whoever is on shift.
- **Photos** are downloaded once and saved permanently into this repository
  (the `photos/` folder), so they keep working even if the original link expires.

### The one spreadsheet that matters

The **canonical Google Sheet** has these tabs:

| Tab | What it is | Safe to edit by hand? |
|---|---|---|
| `roster` | Every shift (date, shift, role, name) | Yes — see below |
| `students` | Student display names + photo links | Yes |
| `residents` | Resident display names + photo links | Yes |
| `attendings` | Attending display names + photo links | Yes |
| `sync_log` | Timestamps written by the robots | No — leave alone |

---

## Common tasks

### A person's name or photo is wrong on the board

Open the canonical sheet, find their row in the `roster` tab, and **type the
correct name into the `matched_name` cell and/or a photo link into the
`matched_photo` cell**. Hand-typed values are remembered — the nightly sync
will never overwrite them.

Alternatively, fix it once in the person tab (`students` / `residents` /
`attendings`): put the schedule's spelling of their name in `schedule_name`,
their nice display name in `name`, and a photo link in `photo_url`. That fixes
every shift they appear on.

### A new block of medical students started

Usually **nothing to do** — the sync auto-discovers every tab in the published
clerkship schedule spreadsheet. Just make sure the clerkship schedule's new
block tab exists in that spreadsheet (it's published to the web already; new
tabs are included automatically). Student names and photos come from Airtable
(the Welcome Form / Student Roster base).

If a new student shows without a name/photo, check that they've submitted the
Airtable Welcome Form and that their Student Roster record has First/Last/Full
Name filled in. You can always hand-type into `matched_name`/`matched_photo`
as an immediate fix.

### Someone should never appear on the board

Edit `js/config.js` in this repository (GitHub lets you edit a file in the
browser — pencil icon), find `excludedNames`, and add their **full name** in
quotes, e.g. `excludedNames: ["nelson", "jane doe"]`. Commit to the `live`
branch. Careful: a single word hides *everyone* with that word in their name.

### The board looks stale / someone says the schedule is wrong

1. Look at the bottom of the website — it shows **"Data last updated"** for
   each role. Anything marked **⚠ STALE** means that sync hasn't run
   successfully in 36+ hours.
2. Go to this repository on GitHub → **Actions** tab. You'll see the three
   sync workflows. A red ✗ means a failure — click it, then click the job, and
   read the last lines of the log; they usually say exactly what's wrong.
3. You can re-run any sync manually: Actions → pick the workflow → **Run
   workflow** button (leave settings as-is) → wait a couple of minutes.

### Run a sync right now (e.g. schedule just changed)

GitHub → **Actions** → choose *Sync Student Schedule*, *Sync Attendings from
QGenda*, or *Sync Residents from Medrez* → **Run workflow**.

---

## When something breaks: the usual suspects

| Symptom | Likely cause | Fix |
|---|---|---|
| One role stale, its Action failing with `401`/`403` | An expired credential (see table below) | Renew the credential and update the GitHub Secret |
| Students missing photos | Airtable token expired, or student not in Airtable | Renew token / have student fill the Welcome Form |
| Attendings sync failing | QGenda changed its page layout or login | Needs a developer (or Claude) to update the scraper |
| Residents sync failing | Medrez password or URL changed | Update the constants in `scripts/sync-residents/index.js` |
| Whole site blank | Google Sheet no longer "published to web", or Pages build failed | File → Share → Publish to web in the sheet; check Actions → pages build |
| Offsite (SLH/ALH/CHO) shifts appearing | New offsite label the filter doesn't know | Add it to `OFFSITE_RE` in `js/data.js` and the sync scripts |

### Credentials that can expire

All secrets live in GitHub → repository **Settings → Secrets and variables →
Actions**. Whoever owns the repo can update them.

| Secret | What it is | Where to renew |
|---|---|---|
| `AIRTABLE_API_KEY` | Airtable personal access token (student photos) | airtable.com → account → Developer hub → personal access tokens |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Robot account that edits the canonical sheet | Google Cloud console (rarely expires; don't touch unless broken) |
| `CANONICAL_SHEET_ID` | The ID of the canonical Google Sheet (from its URL) | Only changes if you move to a new spreadsheet |
| Medrez password | Hardcoded in `scripts/sync-residents/index.js` | Edit that file if the group password changes |

**Recommended:** the repository owner should turn on email notifications for
failed workflow runs (GitHub → your profile → Settings → Notifications →
Actions → "Send notifications for failed workflows only"). That way a broken
sync emails you instead of failing silently.

---

## Handoff checklist for a new administrator

- [ ] Get added as a collaborator (or owner) of this GitHub repository
- [ ] Get edit access to the canonical Google Sheet
- [ ] Get access to the Airtable base (Student Roster + Welcome Form)
- [ ] Turn on GitHub email notifications for failed Actions (see above)
- [ ] Bookmark: the live site, the canonical sheet, the repo's Actions tab
- [ ] Know where the source schedules live: QGenda (attendings),
      Medrez (residents), the clerkship schedule sheet (students)

## For developers

- Frontend: static site, no build step — `index.html` + `js/` + `styles.css`.
  `js/config.js` holds all data-source URLs and display settings.
- Syncs: `scripts/sync-attendings` (Puppeteer + QGenda), `scripts/sync-residents`
  (Puppeteer + Medrez JSON APIs), `scripts/sync-students` (published CSV parsing
  + Airtable photos). Shared photo/status persistence in `scripts/lib/github-photos.js`.
- Each sync commits `data/sync-status-<role>.json`; the frontend footer reads
  these to show freshness.
- Branches: `live` is production (GitHub Pages + scheduled syncs). `dev` exists
  for previews.
- Manual-override rule: any non-formula value typed in `matched_name` /
  `matched_photo` in the roster is preserved by all syncs.
