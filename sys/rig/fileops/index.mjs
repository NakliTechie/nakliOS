// Rig fileops (C0) — public entry.
//
// Browser:  import { createFileops } from '/sys/rig/fileops/index.mjs';
//           const fs = createFileops({ backend: BACKENDS[bound], root: mountPrefix });
// Tests:    createFileops({ backend: new MemoryBackend() });
export { createFileops } from './fileops.mjs';
export { MemoryBackend } from './memory-backend.mjs';
export { normalizeMountPath, joinRoot, EINVAL_PATH } from './pathguard.mjs';
export { applyPatch, reversePatch, parsePatch, createPatch, EPATCH } from './patch.mjs';
