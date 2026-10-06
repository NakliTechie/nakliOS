// Per-project tool hooks — the "policy/format without core changes" lever. A
// workspace config at .anvil/hooks.json (roams with the workspace) declares
// shell commands to run around the agent's tool calls:
//
//   {
//     "postTool": [ { "on": "write|edit", "pathMatch": "*.py", "run": "python -m black {file}" } ],
//     "preTool":  [ { "on": "shell", "commandMatch": "rm -rf /", "block": "Refusing dangerous rm." } ]
//   }
//
// A postTool hook runs AFTER a matching tool succeeds (its output is fed back to
// the agent). A preTool hook with `block` REFUSES a matching tool before it runs
// (the block message goes back to the agent). Pure module — the app reads the
// config, matches, and runs the commands through the Rig shell.
//
// Trust model: postTool `run` is user-authored project config — same trust as
// the verify command; substituted values are shell-quoted so an agent-controlled
// path can't inject extra statements. preTool `block` is a POLICY guard that
// deters an honest agent, not a hard sandbox — the agent already reaches the
// grant-scoped Rig shell via its own `shell` tool.

import {utf8ByteLengthWithin} from './text-byte-bound.mjs';

export const HOOKS_FILE = '.anvil/hooks.json';
export const HOOK_LIMITS = Object.freeze({configBytes:65536,count:16,commandBytes:4096,messageChars:2000,notesChars:16384,notesBytes:16384,commandMs:5000,phaseMs:15000});
const bytes = s => utf8ByteLengthWithin(s,HOOK_LIMITS.configBytes) ?? Infinity;
const refused = reason => ({preTool:[{block:'Project hooks refused: '+reason}],postTool:[]});

// Invalid configured guards fail closed; absent configuration remains empty.
export function parseHooks(text){
  let cfg = {};
  const raw=String(text == null ? '{}' : text);
  if(raw.length>HOOK_LIMITS.configBytes || bytes(raw)>HOOK_LIMITS.configBytes) return refused('configuration exceeds 65536 bytes');
  try { cfg = JSON.parse(raw); } catch (_){ return refused('configuration is not valid JSON'); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return refused('configuration must be an object');
  const norm = arr => {
    if(arr==null) return [];
    if(!Array.isArray(arr)) throw new Error('hook phase must be an array');
    if(arr.length>HOOK_LIMITS.count) throw new Error('more than 16 hooks in one phase');
    const out=[];
    for(const h of arr){
      if(!h || typeof h!=='object' || Array.isArray(h)) throw new Error('hook entry must be an object');
      const clean={};
      for(const [key,limit] of [['on',256],['pathMatch',512],['commandMatch',512],['run',4096],['block',2000]]){
        if(h[key]==null) continue;
        if(typeof h[key]!=='string' || h[key].length>limit || bytes(h[key])>limit) throw new Error(key+' exceeds its byte bound or is not text');
        clean[key]=h[key];
      }
      out.push(clean);
    }
    return out;
  };
  try{return {preTool:norm(cfg.preTool),postTool:norm(cfg.postTool)};}catch(error){return refused(error.message);}
}

// Glob: * = one segment, ** = any, ? = one char. A pattern with no '/' also
// matches the basename (so "*.py" hits "src/app.py").
export function globMatch(pattern, path){
  if (pattern == null || pattern === '') return true;
  const p = String(pattern), s = String(path == null ? '' : path);
  const rx = '^' + p.split(/(\*\*|\*|\?)/).map(tok => {
    if (tok === '**') return '.*';
    if (tok === '*') return '[^/]*';
    if (tok === '?') return '[^/]';
    return tok.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('') + '$';
  let re; try { re = new RegExp(rx); } catch (_){ return false; }
  if (re.test(s)) return true;
  if (!p.includes('/')){ const base = s.split('/').pop() || s; return re.test(base); }
  return false;
}

// Does a hook apply to this tool call? `on` is a "|"-separated tool list;
// pathMatch tests the path/file arg; commandMatch is a substring of the command.
export function hookMatches(hook, toolName, args){
  if (!hook || typeof hook !== 'object') return false;
  const ons = String(hook.on || '').split('|').map(s => s.trim()).filter(Boolean);
  if (ons.length && !ons.includes(toolName)) return false;
  const a = args || {};
  if (hook.pathMatch){ const pth = a.path || a.file || ''; if (!globMatch(hook.pathMatch, pth)) return false; }
  if (hook.commandMatch){ const cmd = String(a.command || ''); if (!cmd.includes(String(hook.commandMatch))) return false; }
  return true;
}

// Single-quote a value for safe shell substitution (neutralizes ; && | > and
// spaces from an agent-controlled path/command). Embedded quotes are escaped.
function shq(s){ return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'"; }

// Build the shell command for a postTool hook, substituting {file}/{path}/{command}
// as SAFELY-QUOTED values so a crafted filename can't inject extra statements.
export function hookCommand(hook, args){
  const a = args || {};
  const file = a.path || a.file || '';
  const template=String((hook && hook.run) || '');
  if(template.length>HOOK_LIMITS.commandBytes || bytes(template)>HOOK_LIMITS.commandBytes) throw new Error('hook command exceeds byte bound');
  const quoted = value => {
    const raw=String(value || '');
    if(raw.length>HOOK_LIMITS.commandBytes) throw new Error('hook substitution exceeds byte bound');
    let quotes=0;for(const character of raw)if(character==="'")quotes++;
    if(bytes(raw)+2+quotes*3>HOOK_LIMITS.commandBytes)throw new Error('hook substitution exceeds byte bound');
    const result=shq(raw);
    if(bytes(result)>HOOK_LIMITS.commandBytes) throw new Error('hook substitution exceeds byte bound');
    return result;
  };
  let size=bytes(template);
  const slots=new Map();
  for(const match of template.matchAll(/\{file\}|\{path\}|\{command\}/g)){
    const key=match[0];
    if(!slots.has(key)) slots.set(key,quoted(key==='{command}' ? a.command : file));
    size += bytes(slots.get(key))-key.length;
    if(size>HOOK_LIMITS.commandBytes) throw new Error('expanded hook command exceeds byte bound');
  }
  return template.replace(/\{file\}|\{path\}|\{command\}/g,key=>slots.get(key));
}

// The pre-tool decision: the first matching preTool hook with a `block` message
// refuses the tool. Returns { blocked, message } — blocked:false when nothing matches.
export function preToolDecision(hooks, toolName, args){
  for (const h of ((hooks && hooks.preTool) || []).slice(0,HOOK_LIMITS.count)){
    if (hookMatches(h, toolName, args) && h.block){
      return { blocked: true, message: String(h.block).slice(0,HOOK_LIMITS.messageChars) };
    }
  }
  return { blocked: false, message: '' };
}

// The postTool commands to run for a tool call, in order (already substituted).
export function postToolCommands(hooks, toolName, args){
  const out = [];
  for (const h of ((hooks && hooks.postTool) || []).slice(0,HOOK_LIMITS.count)){
    if (hookMatches(h, toolName, args) && h.run) out.push(hookCommand(h, args));
  }
  return out;
}
