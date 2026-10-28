// Real case execution against a disposable copy-on-write candidate view.
// No changes, Git operations, or generated files reach the user's base store.
import { createFileops, MemoryBackend } from '../rig/fileops/index.mjs';
import { OverlayBackend } from '../rig/fileops/overlay-backend.mjs';
import { createGitCore } from '../rig/git/git-core.mjs';
import { buildRigRegistry } from '../rig/registry/index.mjs';
import { createGrant, createAgentFace, createOpLog } from '../rig/agent/index.mjs';
import { createShell } from '../rig/cli/shell.mjs';

export function createWorkspaceChecker({backend,root='',timeoutMs=10000}) {
  return async testCase=>{
    const overlay=new OverlayBackend(backend);
    const fs=createFileops({backend:overlay,root});
    const registry=buildRigRegistry({fs,git:createGitCore({fs,dir:'/'})});
    const grant=createGrant({prefixes:[''],scopes:['fs:read','fs:write','fs:remove','git:read','git:write'],
      readOnlyPrefixes:['.anvil/skills','.anvil/gate']});
    const face=createAgentFace({registry,grant,opLog:createOpLog({fs:createFileops({backend:new MemoryBackend()})}),actor:'checker'});
    const ctl=new AbortController();
    const timeout=setTimeout(()=>{ctl.abort();grant.revoke();},timeoutMs);
    const shell=createShell({registry,face,signal:()=>ctl.signal});
    try {
      const actual=await shell.feed(testCase.command);
      if(shell.awaitingConfirm) { await shell.cancel(); throw new Error('Checker case requires operator approval'); }
      if(ctl.signal.aborted)throw new Error('Checker case timed out');
      return {exitCode:shell.lastCode,stdout:actual.stdout || '',stderr:actual.stderr || ''};
    } finally {clearTimeout(timeout);grant.revoke();}
  };
}
