'use strict';

// Persist a photo to the GitHub repo so it's served permanently via GitHub
// Pages, bypassing Airtable CDN expiry. On subsequent runs the existing file
// is reused (no re-download) unless FORCE_PHOTO_REFRESH=true.
//
// Requires these env vars (automatically set in GitHub Actions):
//   GITHUB_TOKEN              – repo write token
//   GITHUB_REPOSITORY         – "owner/repo"
//   GITHUB_REF_NAME           – branch name

async function getFileSha(apiBase, path, token) {
  const res = await fetch(`${apiBase}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub contents API ${res.status}`);
  return (await res.json()).sha;
}

async function putFile(apiBase, path, buffer, sha, token) {
  const body = {
    message: `chore: update headshot ${path}`,
    content: buffer.toString('base64'),
    branch: process.env.GITHUB_REF_NAME,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(`${apiBase}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub push failed: ${res.status} ${await res.text()}`);
}

// Returns the permanent GitHub Pages URL for the photo.
// Downloads and commits it if not already present (or if FORCE_PHOTO_REFRESH).
async function ensurePhotoInPages(key, sourceUrl, prefix = 'photos') {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY; // "owner/repo"
  if (!token) throw new Error('GITHUB_TOKEN not set');
  if (!repo)  throw new Error('GITHUB_REPOSITORY not set');

  const [owner, repoName] = repo.split('/');
  const path    = `${prefix}/headshot-${key}.jpg`;
  const apiBase = `https://api.github.com/repos/${repo}`;
  const pageUrl = `https://${owner}.github.io/${repoName}/${path}`;
  const force   = !!process.env.FORCE_PHOTO_REFRESH;

  const sha = await getFileSha(apiBase, path, token);
  if (sha && !force) return pageUrl; // already stored, reuse

  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Photo download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  await putFile(apiBase, path, buffer, sha, token);
  console.log(`  ${sha ? 'Refreshed' : 'Stored'} ${key} → ${pageUrl}`);
  return pageUrl;
}

function isAirtableUrl(url) {
  return /airtable\.com|airtableusercontent\.com/i.test(String(url));
}

module.exports = { ensurePhotoInPages, isAirtableUrl };
