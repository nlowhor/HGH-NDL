'use strict';

/**
 * Medrez diagnostic — run locally to inspect page structure.
 * Usage:  node diagnose.js
 * Outputs HTML files and a link report so we can find where f= tokens live.
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');

const MEDREZ_URL      = 'https://www.medrez.net/view.php?a=9s733y77k';
const MEDREZ_PASSWORD = 'HGH5150';

async function allLinks(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map(a => ({
      href: a.href,
      text: a.textContent.trim().replace(/\s+/g, ' ').slice(0, 80),
    }))
  );
}

async function main() {
  const browser = await puppeteer.launch({
    headless: false,          // opens a real browser window so you can watch
    slowMo: 50,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // ── 1. Landing page ────────────────────────────────────────────────
  console.log('\n=== Step 1: landing page ===');
  await page.goto(MEDREZ_URL, { waitUntil: 'networkidle2' });
  fs.writeFileSync('diag-01-landing.html', await page.content());
  console.log('Saved diag-01-landing.html');

  // ── 2. Login ───────────────────────────────────────────────────────
  const pwInput = await page.$('input[type="password"]');
  if (pwInput) {
    console.log('\n=== Step 2: logging in ===');
    await pwInput.type(MEDREZ_PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click('input[type="submit"]'),
    ]);
    fs.writeFileSync('diag-02-after-login.html', await page.content());
    await page.screenshot({ path: 'diag-02-after-login.png', fullPage: true });
    console.log('Saved diag-02-after-login.html + .png');
  } else {
    console.log('No password form — already logged in or different page.');
  }

  // ── 3. Enumerate all links ─────────────────────────────────────────
  console.log('\n=== Step 3: all links on post-login page ===');
  const links = await allLinks(page);
  console.log(`Total links: ${links.length}`);
  links.forEach((l, i) => console.log(`  [${i}] ${l.href}  |  "${l.text}"`));

  // ── 4. Visit first 3 unique view.php sub-pages ────────────────────
  const landingUrl = page.url();
  const subPages = links
    .filter(l => l.href.includes('view.php') && l.href !== landingUrl)
    .filter((l, i, arr) => arr.findIndex(x => x.href === l.href) === i)
    .slice(0, 3);

  for (let i = 0; i < subPages.length; i++) {
    const { href, text } = subPages[i];
    console.log(`\n=== Step 4.${i + 1}: visiting "${text}" → ${href} ===`);
    await page.goto(href, { waitUntil: 'networkidle2', timeout: 15_000 });
    const fname = `diag-03-subpage-${i}.html`;
    fs.writeFileSync(fname, await page.content());
    await page.screenshot({ path: `diag-03-subpage-${i}.png`, fullPage: true });
    console.log(`Saved ${fname}`);

    const subLinks = await allLinks(page);
    console.log(`  Links on this page (${subLinks.length}):`);
    subLinks.forEach(l => console.log(`    ${l.href}  |  "${l.text}"`));
  }

  console.log('\n=== Done. Check the diag-*.html files. ===');
  // Leave browser open so you can poke around manually.
  // Press Ctrl-C when done.
}

main().catch(err => { console.error(err); process.exit(1); });
