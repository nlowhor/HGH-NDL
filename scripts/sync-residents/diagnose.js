'use strict';

/**
 * Medrez network diagnostic — captures all API/XHR calls the page makes
 * after login so we can find the schedule data endpoints.
 * Run via GitHub Actions "Diagnose Medrez Page Structure" workflow.
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');

const MEDREZ_URL      = 'https://www.medrez.net/view.php?a=9s733y77k';
const MEDREZ_PASSWORD = 'HGH5150';

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // ── Capture every network response ────────────────────────────────
  const captured = [];
  page.on('response', async res => {
    const url    = res.url();
    const status = res.status();
    const ct     = res.headers()['content-type'] || '';
    // Capture HTML and JSON responses (skip images, fonts, css)
    if (ct.includes('html') || ct.includes('json') || ct.includes('text')) {
      try {
        const body = await res.text();
        captured.push({ url, status, ct, body: body.slice(0, 5000) });
      } catch (_) {}
    }
  });

  // ── 1. Landing / login ────────────────────────────────────────────
  console.log('Navigating to Medrez…');
  await page.goto(MEDREZ_URL, { waitUntil: 'networkidle2' });

  const pwInput = await page.$('input[type="password"]');
  if (pwInput) {
    console.log('Submitting password…');
    await pwInput.type(MEDREZ_PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click('input[type="submit"]'),
    ]);
  }

  // Wait a moment for any lazy-loaded data
  await new Promise(r => setTimeout(r, 3000));

  // ── 2. Save post-login page ───────────────────────────────────────
  fs.writeFileSync('diag-main.html', await page.content());
  await page.screenshot({ path: 'diag-main.png', fullPage: true });
  console.log('Saved diag-main.html + diag-main.png');

  // ── 3. Extract all links on the page ─────────────────────────────
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map(a => ({
      href: a.href,
      text: a.textContent.trim().replace(/\s+/g, ' ').slice(0, 80),
    }))
  );
  console.log(`\nAll links on post-login page (${links.length}):`);
  links.forEach((l, i) => console.log(`  [${i}] "${l.text}"  →  ${l.href}`));

  // ── 4. Click each "view schedule" link and capture results ────────
  const scheduleLinks = links.filter(l =>
    l.text.toLowerCase().includes('view schedule') ||
    l.text.toLowerCase().includes('schedule')
  );
  console.log(`\nSchedule-like links found: ${scheduleLinks.length}`);

  for (let i = 0; i < scheduleLinks.length; i++) {
    const { href, text } = scheduleLinks[i];
    console.log(`\n--- Clicking schedule link [${i}]: "${text}" ---`);
    captured.length = 0; // reset captures for this click

    try {
      // Click the link but intercept navigation — we want to stay logged in.
      // If it's a same-page anchor or triggers AJAX, great.
      // If it navigates away, we catch the new page content.
      const [navResponse] = await Promise.all([
        page.waitForNavigation({ timeout: 5000 }).catch(() => null),
        page.evaluate((url) => { window.location.href = url; }, href),
      ]);

      await new Promise(r => setTimeout(r, 2000));

      const slug  = text.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 30);
      const fname = `diag-sched-${String(i).padStart(2, '0')}-${slug}.html`;
      fs.writeFileSync(fname, await page.content());
      await page.screenshot({ path: fname.replace('.html', '.png'), fullPage: true });
      console.log(`  Saved ${fname}`);

      // Show the visible text content (truncated)
      const bodyText = await page.evaluate(() =>
        document.body.innerText.slice(0, 2000).replace(/\s+/g, ' ')
      );
      console.log(`  Page text preview: ${bodyText}`);

      // Go back to main page
      await page.goto(MEDREZ_URL, { waitUntil: 'networkidle2' });
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.warn(`  ERROR: ${err.message}`);
    }
  }

  // ── 5. Report all captured network responses ──────────────────────
  console.log('\n\n=== CAPTURED NETWORK RESPONSES ===');
  for (const r of captured) {
    console.log(`\n[${r.status}] ${r.url}`);
    console.log(`  Content-Type: ${r.ct}`);
    console.log(`  Body preview: ${r.body.slice(0, 500).replace(/\s+/g, ' ')}`);
  }

  // Save full capture log
  fs.writeFileSync('diag-network.json', JSON.stringify(captured, null, 2));
  console.log('\nFull network log saved to diag-network.json');
  console.log('\n=== Done ===');

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
