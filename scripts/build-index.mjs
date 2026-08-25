#!/usr/bin/env node
/**
 * Builds data/labs.json by indexing lab front matter across every repo listed
 * in repos.yml.
 *
 * Strategy: GitHub git-trees API to list Instructions markdown, then
 * raw.githubusercontent to fetch content. Authenticated with GITHUB_TOKEN when
 * available to avoid rate limits.
 *
 * Resilience is the point: a single bad repo, missing branch, unparsable file
 * or transient network error is logged and skipped, never fatal.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'repos.yml');
const OUT_PATH = path.join(ROOT, 'data', 'labs.json');

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

/** Front matter keys promoted to the top-level normalized record. */
const CORE_KEYS = new Set([
  'title',
  'description',
  'level',
  'duration',
  'status',
  'islab',
  'primarytopics',
  'topics',
]);

/** Locale suffixes we deliberately ignore (e.g. 01-lab.ja-jp.md). */
const LOCALE_RE = /\.[a-z]{2}-[a-z]{2}$/i;

const warnings = [];
function warn(msg) {
  warnings.push(msg);
  console.warn(`  ! ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghFetch(url, { raw = false, retries = 3 } = {}) {
  const headers = {
    'User-Agent': 'lab-explorer-indexer',
    Accept: raw ? 'text/plain' : 'application/vnd.github+json',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 403 || res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
        const waitMs = Math.min(Math.max(reset - Date.now(), 1000), 60_000);
        lastErr = new Error(`rate limited (${res.status}) on ${url}`);
        if (attempt < retries) {
          console.warn(`  ... rate limited, waiting ${Math.round(waitMs / 1000)}s`);
          await sleep(waitMs);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return raw ? await res.text() : await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * attempt);
    }
  }
  throw lastErr;
}

/** Splits a markdown document into its YAML front matter block. */
function extractFrontMatter(text) {
  // Tolerate a UTF-8 BOM and leading blank lines.
  const src = text.replace(/^\uFEFF/, '').replace(/^\s*\n/, '');
  if (!src.startsWith('---')) return null;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(src);
  return match ? match[1] : null;
}

/** `30`, `"30"`, `30 minutes`, `~45 min` -> 30 / 30 / 30 / 45. null otherwise. */
function normalizeDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? Math.round(value) : null;
  }
  if (typeof value === 'string') {
    const m = /(\d+(?:\.\d+)?)/.exec(value);
    if (m) {
      const n = Math.round(Number(m[1]));
      return n > 0 ? n : null;
    }
  }
  return null;
}

/** `300`, `"300"`, `L300` -> 300. null otherwise. */
function normalizeLevel(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const m = /(\d{3})/.exec(value);
    if (m) return Number(m[1]);
  }
  return null;
}

function normalizeString(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Accepts a YAML list, a comma-separated string, or a single value. */
function normalizeTopics(value) {
  const out = [];
  const push = (v) => {
    const s = normalizeString(v);
    if (s) out.push(s);
  };
  if (Array.isArray(value)) value.forEach(push);
  else if (typeof value === 'string') value.split(',').forEach(push);
  else push(value);
  return [...new Set(out.filter(Boolean))];
}

/** Plain-object check that also rejects arrays and null. */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function toHostedUrl(repoName, filePath) {
  return `https://microsoftlearning.github.io/${repoName}/${encodePath(filePath.replace(/\.md$/i, '.html'))}`;
}

function toSourceUrl(fullName, branch, filePath) {
  return `https://github.com/${fullName}/blob/${encodeURIComponent(branch)}/${encodePath(filePath)}`;
}

function parseLabFile({ text, filePath, repoName, repoTitle, fullName, branch }) {
  const fm = extractFrontMatter(text);
  if (fm === null) return { skipped: 'no front matter' };

  let doc;
  try {
    doc = yaml.load(fm, { json: true });
  } catch (err) {
    return { skipped: `unparsable YAML (${String(err.message).split('\n')[0]})` };
  }
  if (!isObject(doc)) return { skipped: 'front matter is not a mapping' };

  const lab = doc.lab;
  if (!isObject(lab)) return { skipped: 'no lab: block' };
  if (lab.islab === false) return { skipped: 'islab: false' };

  const title = normalizeString(lab.title) || normalizeString(doc.title);
  if (!title) return { skipped: 'no lab title' };

  const extra = {};
  for (const [key, value] of Object.entries(lab)) {
    if (CORE_KEYS.has(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    extra[key] = value;
  }

  return {
    lab: {
      id: `${repoName}/${filePath}`,
      repo: repoName,
      repoTitle,
      title,
      description: normalizeString(lab.description) || '',
      level: normalizeLevel(lab.level),
      duration: normalizeDuration(lab.duration),
      status: normalizeString(lab.status),
      // `primarytopics` is sparse; several repos express the same idea via a
      // comma-joined `concepts` string, so both feed the topic facet.
      topics: [
        ...new Set([
          ...normalizeTopics(lab.primarytopics ?? lab.topics),
          ...normalizeTopics(lab.concepts),
        ]),
      ],
      path: filePath,
      sourceUrl: toSourceUrl(fullName, branch, filePath),
      hostedUrl: toHostedUrl(repoName, filePath),
      extra,
    },
  };
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function indexRepo(entry) {
  const fullName = String(entry?.repo || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
    warn(`skipping malformed repos.yml entry: ${JSON.stringify(entry)}`);
    return null;
  }
  const repoName = fullName.split('/')[1];
  const repoTitle = normalizeString(entry.title) || repoName;

  console.log(`\n> ${fullName}`);

  let branch = normalizeString(entry.branch);
  if (!branch) {
    try {
      const meta = await ghFetch(`${API}/repos/${fullName}`);
      branch = meta.default_branch || 'main';
    } catch (err) {
      warn(`${fullName}: could not read repo metadata (${err.message}); assuming "main"`);
      branch = 'main';
    }
  }

  let tree;
  try {
    tree = await ghFetch(`${API}/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  } catch (err) {
    warn(`${fullName}: could not list tree on "${branch}" (${err.message}); repo skipped`);
    return null;
  }

  if (tree.truncated) {
    warn(`${fullName}: git tree response was truncated; some labs may be missing`);
  }

  const candidates = (tree.tree || [])
    .filter((n) => n.type === 'blob')
    .map((n) => n.path)
    .filter((p) => /^Instructions\//i.test(p) && /\.md$/i.test(p))
    .filter((p) => !LOCALE_RE.test(p.replace(/\.md$/i, '')))
    .sort();

  const results = await mapWithConcurrency(candidates, 8, async (filePath) => {
    const url = `${RAW}/${fullName}/${encodeURIComponent(branch)}/${encodePath(filePath)}`;
    try {
      const text = await ghFetch(url, { raw: true });
      return { filePath, ...parseLabFile({ text, filePath, repoName, repoTitle, fullName, branch }) };
    } catch (err) {
      return { filePath, skipped: `fetch failed (${err.message})` };
    }
  });

  const labs = [];
  const skipped = [];
  for (const r of results) {
    if (r.lab) labs.push(r.lab);
    else skipped.push({ path: r.filePath, reason: r.skipped });
  }

  console.log(`  ${labs.length} labs, ${skipped.length} skipped (of ${candidates.length} markdown files)`);
  for (const s of skipped) {
    // Non-lab pages (READMEs, indexes) are expected; anything else is worth surfacing.
    if (!/no front matter|no lab: block|islab: false/.test(s.reason)) {
      warn(`${fullName}/${s.path}: ${s.reason}`);
    }
  }

  if (labs.length === 0) {
    warn(`${fullName}: indexed 0 labs — check the Instructions folder layout`);
  }

  return { repo: repoName, fullName, repoTitle, branch, labs, skipped: skipped.length };
}

async function main() {
  console.log(`Lab Explorer indexer${TOKEN ? ' (authenticated)' : ' (unauthenticated - rate limits apply)'}`);

  let config;
  try {
    config = yaml.load(await readFile(CONFIG_PATH, 'utf8'), { json: true });
  } catch (err) {
    console.error(`FATAL: cannot read ${CONFIG_PATH}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const entries = Array.isArray(config?.repos) ? config.repos : [];
  if (entries.length === 0) {
    console.error('FATAL: repos.yml contains no `repos:` entries.');
    process.exitCode = 1;
    return;
  }

  const indexed = [];
  for (const entry of entries) {
    try {
      const result = await indexRepo(entry);
      if (result) indexed.push(result);
    } catch (err) {
      warn(`unexpected failure for ${entry?.repo}: ${err.message}`);
    }
  }

  const labs = indexed.flatMap((r) => r.labs);
  labs.sort(
    (a, b) =>
      a.repoTitle.localeCompare(b.repoTitle) ||
      a.path.localeCompare(b.path) ||
      a.title.localeCompare(b.title)
  );

  const payload = {
    generated_at: new Date().toISOString(),
    repo_count: indexed.length,
    lab_count: labs.length,
    repos: indexed.map((r) => ({
      repo: r.repo,
      fullName: r.fullName,
      title: r.repoTitle,
      branch: r.branch,
      labCount: r.labs.length,
      skippedCount: r.skipped,
      url: `https://github.com/${r.fullName}`,
    })),
    labs,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log('\n=== Summary ===');
  for (const r of payload.repos) {
    console.log(`  ${String(r.labCount).padStart(3)}  ${r.repo} (${r.title})`);
  }
  console.log('  ---');
  console.log(`  ${labs.length} labs across ${indexed.length}/${entries.length} repos`);
  console.log(`  ${warnings.length} warning(s)`);
  console.log(`  wrote ${path.relative(ROOT, OUT_PATH)}`);

  if (labs.length === 0) {
    console.error('FATAL: no labs indexed - refusing to publish an empty index.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack || err.message}`);
  process.exitCode = 1;
});
