// The bench's solver endpoints, by name. A run names one (`--endpoint`), and its summary records the
// base and model, because a harness fix is model-specific (plan/pending.md, HarnessBank entry).
// Keys are never in the repo: `keyFrom` says where to read one at run time —
//   opencode:<provider>  opencode's credential store (~/.local/share/opencode/auth.json)
//   file:<path>          the whole file, trimmed (~ is the home directory)
//   env:<VAR>            an environment variable
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ENDPOINTS = Object.freeze({
  // OpenRouter's free stealth model (Chirag 2026-10-01: "Its free for now"); key on the Desktop.
  'openrouter-bunny': Object.freeze({ base: 'https://openrouter.ai/api/v1', model: 'stealth/space-bunny-alpha', keyFrom: 'file:~/Desktop/or-key.txt' }),
  // Space Bunny through opencode's Zen gateway, with opencode's stored key (whether Zen serves the same
  // weights as OpenRouter's alpha is not verified — record which endpoint a number came from). Zen's other
  // free models answer 403 "OpenCode's free tier can only be used from within OpenCode" to a direct
  // call (probed 2026-10-01): reaching them means opencode's own agent loop, which would measure that
  // harness and not Anvil's, so they are not endpoints here.
  'opencode-bunny': Object.freeze({ base: 'https://opencode.ai/zen/v1', model: 'space-bunny-free', keyFrom: 'opencode:opencode' }),
  // DeepSeek V4.1 Flash, the app's configured fuel; the first calibration ran on it.
  'deepseek-flash': Object.freeze({ base: 'https://api.deepseek.com/v1', model: 'deepseek-flash', keyFrom: 'opencode:deepseek' }),
});
export const DEFAULT_ENDPOINT = 'openrouter-bunny';

export async function readKey(spec) {
  const i = String(spec).indexOf(':');
  const kind = spec.slice(0, i), arg = spec.slice(i + 1);
  if (kind === 'opencode') {
    const auth = JSON.parse(await readFile(join(homedir(), '.local/share/opencode/auth.json'), 'utf8'));
    if (!auth?.[arg]?.key) throw new Error(`opencode has no key for ${arg}`);
    return auth[arg].key;
  }
  if (kind === 'file') return (await readFile(arg.replace(/^~(?=\/)/, homedir()), 'utf8')).trim();
  if (kind === 'env') { if (!process.env[arg]) throw new Error(`environment variable ${arg} is not set`); return process.env[arg]; }
  throw new Error(`unknown key source "${spec}" — opencode:<provider>, file:<path> or env:<VAR>`);
}

// { base, model, key, name } from a named endpoint, with any explicit --base / --model / --key-from /
// --key overriding its fields. The key comes last in preference from --key (it lands on the process list).
export async function resolveEndpoint({ endpoint = null, base = null, model = null, keyFrom = null, key = null } = {}) {
  const name = endpoint || (base ? null : DEFAULT_ENDPOINT);
  const preset = name ? ENDPOINTS[name] : null;
  if (name && !preset) throw new Error(`no endpoint "${name}" — one of ${Object.keys(ENDPOINTS).join(', ')}`);
  const spec = keyFrom || (key ? null : preset?.keyFrom) || null;
  return {
    name: name || 'custom',
    base: base || preset?.base,
    model: model || preset?.model,
    key: spec ? await readKey(spec) : (key || process.env.BENCH_KEY || 'local'),
  };
}

// What the provider says this key has spent, read before and after a run: DeepSeek's balance, or
// OpenRouter's usage counter. null where the provider has no such endpoint.
export async function spend({ base, key }) {
  try {
    if (/api\.deepseek\.com/.test(base)) {
      const j = await (await fetch(base.replace(/\/v1\/?$/, '') + '/user/balance', { headers: { authorization: `Bearer ${key}` } })).json();
      const b = (j.balance_infos || []).find((x) => x.currency === 'USD') || (j.balance_infos || [])[0];
      return b ? { kind: 'balance', currency: b.currency, total: Number(b.total_balance) } : null;
    }
    if (/openrouter\.ai/.test(base)) {
      const j = await (await fetch(base.replace(/\/+$/, '') + '/key', { headers: { authorization: `Bearer ${key}` } })).json();
      return j?.data ? { kind: 'usage', currency: 'USD', total: Number(j.data.usage) || 0 } : null;
    }
  } catch (_) {}
  return null;
}
