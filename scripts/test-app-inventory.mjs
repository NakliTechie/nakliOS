import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditAppInventory } from './app-inventory-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(path.join(rootDir, 'index.html'), 'utf8');
const manifest = JSON.parse(await readFile(path.join(rootDir, 'apps', 'manifest.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(rootDir, 'apps', 'manifest.lock.json'), 'utf8'));

assert.deepEqual(await auditAppInventory(rootDir, html, manifest, lock), []);

const fixture = await mkdtemp(path.join(os.tmpdir(), 'naklios-inventory-'));
try {
  await cp(path.join(rootDir, 'apps'), path.join(fixture, 'apps'), { recursive: true });
  await writeFile(path.join(fixture, 'apps', 'tijori', 'stale.js'), 'stale');
  const errors = await auditAppInventory(fixture, html, manifest, lock);
  assert.ok(errors.some(error => error.includes('mirrored files differ')), 'extra mirror artifacts are rejected');

  // Derive the mutation from what the catalog ACTUALLY says. Pinning the absolute spelling
  // meant that when tijori moved to a relative embedUrl the replace() silently matched nothing,
  // the drift under test never happened, and the assertion failed for the wrong reason — a
  // mutation that no-ops is a test that proves nothing.
  const tijoriEmbed = html.match(/id:'tijori'[\s\S]*?embedUrl:'([^']+)'/);
  assert.ok(tijoriEmbed, 'the fixture catalog still carries a tijori embedUrl to mutate');
  const brokenHtml = html.replace(tijoriEmbed[1], tijoriEmbed[1].replace('tijori', 'not-tijori'));
  assert.notEqual(brokenHtml, html, 'the drift mutation actually changed the catalog');
  const catalogErrors = await auditAppInventory(rootDir, brokenHtml, manifest, lock);
  assert.ok(catalogErrors.some(error => error.includes('catalog embedUrl')), 'catalog/mirror path drift is rejected');

  // Forge shipped 2026-08-24: with a catalog entry (system app) and an on-disk
  // index, it audits clean — the planning-only exception is gone.
  const forgeAudit = await auditAppInventory(fixture, html, manifest, lock);
  assert.ok(!forgeAudit.some(error => error.startsWith('forge:')), 'shipped Forge audits clean');

  // An on-disk app with no catalog entry is still flagged.
  await mkdir(path.join(fixture, 'apps', 'ghostapp'), { recursive: true });
  await writeFile(path.join(fixture, 'apps', 'ghostapp', 'index.html'), '<!doctype html><title>Ghost</title>');
  const ghostErrors = await auditAppInventory(fixture, html, manifest, lock);
  assert.ok(
    ghostErrors.some(error => error.includes('ghostapp: on-disk app has no catalog entry')),
    'an uncatalogued on-disk app is flagged',
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log('NakliOS deterministic app inventory audit behavior: PASS');
