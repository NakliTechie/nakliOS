import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrgPolicy } from '../policy.mjs'

test('unmanaged policy allows everything with zero friction', () => {
  const p = createOrgPolicy(null)
  assert.equal(p.managed, false)
  assert.equal(p.checkFsBackend('browser').ok, true)
  assert.equal(p.checkAiRequest({ runtime: 'endpoint', modelId: 'any' }).ok, true)
  assert.equal(p.checkCommand('anvil.shell.exec').outcome, 'allow')
  assert.equal(p.allowDoor(), true)
  assert.equal(p.allowRig(), true)
  assert.equal(p.allowThirdPartyApps(), true)
  assert.equal(p.allowNetEgress(), true)
})

test('managed policy enforces FS, AI, and Agent rails with EPOLICY codes', () => {
  const p = createOrgPolicy({
    org_id: 'org_1',
    seat_id: 'seat_1',
    policy_version: 2,
    rails: {
      fs: {
        allowed_backends: ['fsa', 'crate'],
        required_backend: 'fsa',
        folder_label: 'Company Share',
        managed_crate: false,
        storage_quota_mb: 0,
        audit_fs: true,
        templates: [{ name: 'Letterhead', app: 'draft', path: 'Templates/letterhead.docx', sha256: 'a'.repeat(64) }],
      },
      ai: {
        mode: 'gateway_only',
        unified_inference: true,
        allowed_models: ['openai/gpt-4o-mini'],
        per_seat_budget: { calls: 10, tokens: 50000, spend_usd: 2.5 },
        audit_ai: true,
      },
      agent: {
        apps_allowlist: ['draft', 'reckon', 'notes', 'anvil'],
        deny_commands: ['anvil.shell.*'],
        force_review_commands: ['notes.delete'],
        allow_door: false,
        allow_rig: false,
        allow_third_party_apps: false,
        allow_net_egress: false,
        audit_sync: true,
      },
    },
  })

  // FS rail
  assert.equal(p.checkFsBackend('fsa').ok, true)
  assert.equal(p.checkFsBackend('browser').code, 'EPOLICY')
  assert.equal(p.checkFsBackend('crate').code, 'EPOLICY') // required_backend is fsa
  assert.equal(p.folderLabel(), 'Company Share')
  assert.equal(p.shouldAuditFs(), true)

  // AI rail
  assert.equal(p.checkAiRequest({ runtime: 'endpoint', modelId: 'openai/gpt-4o-mini', isOrgGateway: true, usage: { calls: 2, tokens: 1000, spend_usd: 0.1 } }).ok, true)
  assert.equal(p.checkAiRequest({ runtime: 'local', modelId: 'LFM3', isOrgGateway: false }).code, 'EPOLICY')
  assert.equal(p.checkAiRequest({ runtime: 'endpoint', modelId: 'anthropic/claude', isOrgGateway: true }).code, 'EPOLICY')
  assert.equal(p.checkAiRequest({ runtime: 'endpoint', modelId: 'openai/gpt-4o-mini', isOrgGateway: true, usage: { calls: 10 } }).code, 'EPOLICY')

  // Agent rail
  assert.equal(p.isAppAllowed('draft'), true)
  assert.equal(p.isAppAllowed('books'), false)
  assert.equal(p.checkCommand('books.reader.open').outcome, 'deny')
  assert.equal(p.checkCommand('anvil.shell.run').outcome, 'deny')
  assert.equal(p.checkCommand('anvil.shell.run').code, 'EPOLICY')
  assert.equal(p.checkCommand('notes.delete').outcome, 'review')
  assert.equal(p.checkCommand('notes.list.add').outcome, 'allow')
  assert.equal(p.allowDoor(), false)
  assert.equal(p.allowRig(), false)
  assert.equal(p.allowThirdPartyApps(), false)
  assert.equal(p.allowNetEgress(), false)
  assert.equal(p.shouldSyncAudit(), true)
})
