#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeManifest, sha256 } from './mirror-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(rootDir, 'apps', 'manifest.json');
const lockPath = path.join(rootDir, 'apps', 'manifest.lock.json');

function selectedIds(argv) {
  const ids = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--app' || !argv[i + 1]) {
      throw new Error(`usage: node scripts/sync-mirrors.mjs [--app <id>]`);
    }
    ids.add(argv[++i]);
  }
  return ids;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

class HttpError extends Error {
  constructor(status, statusText, url) {
    super(`${status} ${statusText}: ${url}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function fetchBytes(url, headers) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new HttpError(response.status, response.statusText, url);
  return Buffer.from(await response.arrayBuffer());
}

// A mirror whose source repository the token cannot read. FOUR of the nine sources are private
// (reel, nakliamp, reckon, draft — measured 2026-09-10, not the "two of three" this comment
// claimed), and the workflow's default repo-scoped github.token cannot see them, so GitHub
// answers 404 rather than 403. Those mirrors keep their existing lock entry and on-disk
// artifacts, so one unreadable source does not stop every other mirror from syncing.
//
// The skip itself is now loud: annotated per mirror, surfaced as a job output the workflow
// fails on, and fatal under --strict. It used to be a console.warn on a process that exited 0
// inside a step that then went green, which is how nakliamp sat at 0.1.0-m0 for two weeks.
function isUnreadable(error) {
  return error instanceof HttpError && (error.status === 404 || error.status === 403);
}

async function fetchJson(url, headers) {
  return JSON.parse((await fetchBytes(url, headers)).toString('utf8'));
}

// GitHub Actions only surfaces a line on the run summary if it is annotated; an ordinary
// console.warn is buried in a log nobody opens on a green run. Locally this is just a prefix.
function annotate(level, message) {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level}::${message}`);
  else console.warn(`  ${level.toUpperCase()} ${message}`);
}

function encodeSourcePath(source) {
  return source.split('/').map(encodeURIComponent).join('/');
}

async function writeIfChanged(file, bytes) {
  try {
    if (Buffer.compare(await readFile(file), bytes) === 0) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
  return true;
}

const argv = process.argv.slice(2);
// A skip must not be able to pass for a success. `--strict` turns any tolerated skip into a
// non-zero exit so CI goes red; `--allow-skip` names the mirrors whose skip is a KNOWN,
// declared state rather than a surprise. Silence then means "everything synced", which is the
// only thing that makes a green run worth trusting.
const strict = argv.includes('--strict');
const allowSkip = new Set(
  argv.filter(a => a.startsWith('--allow-skip'))
    .flatMap(a => (a.split('=')[1] || '').split(','))
    .map(s => s.trim()).filter(Boolean),
);
const ids = selectedIds(argv.filter(a => a !== '--strict' && !a.startsWith('--allow-skip')));
const manifest = normalizeManifest(await readJson(manifestPath));
const unknownIds = [...ids].filter(id => !manifest.apps.some(app => app.id === id));
if (unknownIds.length) throw new Error(`unknown mirror id(s): ${unknownIds.join(', ')}`);
const targets = ids.size ? manifest.apps.filter(app => ids.has(app.id)) : manifest.apps;
const oldLock = await readJson(lockPath, { version: 1, apps: [] });
const lockById = new Map((oldLock.apps || []).map(app => [app.id, app]));
// MIRROR_SYNC_TOKEN first: the workflow's default `github.token` is scoped to THIS repo, so
// GitHub answers 404 (never 403) for a private source and the sync cannot tell "no such repo"
// from "not allowed to see it". A PAT with read access to the source repos is what makes a
// private mirror syncable at all.
const token = process.env.MIRROR_SYNC_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'NakliOS-mirror-sync',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

console.log(`Resolving ${targets.length} mirror(s) to immutable commits…`);
const resolved = [];
const skipped = [];
for (const app of targets) {
  try {
    const commitApi = `https://api.github.com/repos/${app.repo}/commits/${encodeURIComponent(app.requestedRef)}`;
    const commit = await fetchJson(commitApi, headers);
    if (!/^[0-9a-f]{40}$/.test(commit.sha || '')) {
      throw new Error(`${app.id}: GitHub did not return a full commit SHA`);
    }
    const files = [];
    for (const file of app.files) {
      const rawUrl = `https://raw.githubusercontent.com/${app.repo}/${commit.sha}/${encodeSourcePath(file.source)}`;
      const bytes = await fetchBytes(rawUrl, headers);
      files.push({
        ...file,
        bytes,
        sha256: sha256(bytes),
      });
    }
    resolved.push({ app, commit: commit.sha, files });
  } catch (error) {
    // Asking for one mirror by name and not being able to read it is an
    // error; skipping is only for the unattended sweep over every mirror.
    if (ids.size || !isUnreadable(error)) throw error;
    if (!lockById.has(app.id)) {
      throw new Error(`${app.id}: ${error.message} — and no lock entry to fall back on`);
    }
    skipped.push(app.id);
    const locked = lockById.get(app.id);
    const why = error.status === 404
      ? `${app.repo} is unreadable with this token (private sources answer 404, not 403)`
      : error.message;
    annotate(allowSkip.has(app.id) ? 'warning' : 'error',
      `${app.id}: NOT synced — ${why}. Serving the copy locked at ${String(locked?.resolvedCommit || '?').slice(0, 12)}, `
      + 'which may be any age. Set MIRROR_SYNC_TOKEN to a PAT that can read it, or add it to --allow-skip '
      + 'to declare the staleness deliberate.');
  }
}

let changed = 0;
for (const item of resolved) {
  for (const file of item.files) {
    const destination = path.join(rootDir, 'apps', item.app.id, ...file.destination.split('/'));
    if (await writeIfChanged(destination, file.bytes)) changed += 1;
    console.log(`  ${item.app.id}/${file.destination} ← ${item.commit.slice(0, 12)}:${file.source}`);
  }
  lockById.set(item.app.id, {
    id: item.app.id,
    repo: item.app.repo,
    requestedRef: item.app.requestedRef,
    resolvedCommit: item.commit,
    files: item.files.map(file => ({
      source: file.source,
      destination: file.destination,
      sha256: file.sha256,
      bytes: file.bytes.byteLength,
    })),
  });
}

const lock = {
  version: 1,
  apps: manifest.apps.filter(app => lockById.has(app.id)).map(app => lockById.get(app.id)),
};
const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
if (await writeIfChanged(lockPath, lockBytes)) changed += 1;
console.log(`Synced ${resolved.length} of ${targets.length} mirror(s).`);
console.log(`Done. ${changed} file(s) changed; validate with node scripts/validate-mirrors.mjs.`);

if (skipped.length) {
  const undeclared = skipped.filter(id => !allowSkip.has(id));
  console.warn(`${skipped.length} skipped (source unreadable): ${skipped.join(', ')}`);
  if (undeclared.length) {
    // validate-mirrors cannot catch this: a skipped mirror keeps its lock entry, so the lock
    // and the files still agree. Staleness is only visible HERE, at the moment of the skip.
    annotate('error', `${undeclared.length} mirror(s) silently kept an old copy: ${undeclared.join(', ')}. `
      + 'validate-mirrors will still pass — it checks the lock, not the age.');
    // Reported as a job OUTPUT rather than a non-zero exit here, so the readable mirrors still
    // get written and their PR still opens. The workflow fails at the END on this output: a
    // skip must not also cost us the syncs that did work.
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `skipped=${undeclared.join(',')}\n`);
    }
    if (strict) {
      console.error('sync-mirrors: --strict and an undeclared skip; failing so this is not read as "up to date".');
      process.exitCode = 1;
    }
  }
}
