// Rig agent face (C4) — public entry.
//
//   const grant = createGrant({ prefixes: ['work'], scopes: ['fs:read','fs:write'] });
//   const opLog = createOpLog({ fs: logFs });
//   const face  = createAgentFace({ registry, grant, opLog, actor: 'agent' });
//   installWindowRig({ enabled: devSettingOn, face });   // off by default
export { createGrant } from './grant.mjs';
export { createOpLog, digestArgs, redactTokens } from './oplog.mjs';
export { createAgentFace } from './agent-face.mjs';
export { installWindowRig, wireWindowRig } from './window-rig.mjs';
