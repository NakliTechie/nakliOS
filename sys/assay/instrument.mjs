// The harness owns sealed cases and scoring. Models author the initial cases,
// but cannot supply a pass rate or replace them after candidate construction.
import { contentHash } from '../history/ledger.mjs';

export async function sealInstrument(input) {
  if (!Array.isArray(input?.cases) || !input.cases.length || input.cases.length > 128) throw new Error('Checker must provide 1–128 executable cases');
  const ids=new Set();
  const cases=input.cases.map(c=>{
    if (!c || typeof c.id!=='string' || !c.id || ids.has(c.id)) throw new Error('Case ids must be unique');
    ids.add(c.id);
    if (typeof c.command!=='string' || !c.command || c.command.length>4096) throw new Error('Case command is missing or too long');
    if (!Number.isInteger(c.expected?.exitCode) || (typeof c.expected.stdout!=='string' && typeof c.expected.stderr!=='string')) throw new Error('Each case needs an exit code and exact stdout or stderr');
    const weight=c.weight ?? 1;
    if (!Number.isFinite(weight) || weight<=0 || weight>1000) throw new Error('Invalid case weight');
    const expected={exitCode:c.expected.exitCode};
    for (const key of ['stdout','stderr']) if (c.expected[key]!==undefined) {
      if (typeof c.expected[key]!=='string' || c.expected[key].length>65536) throw new Error('Invalid expected output');
      expected[key]=c.expected[key];
    }
    return {id:c.id,area:typeof c.area==='string'?c.area:'candidate',command:c.command,expected,weight};
  });
  return {cases,hash:await contentHash(cases)};
}

export async function measureInstrument(instrument, runCheck, {round}={}) {
  if (!instrument || typeof runCheck!=='function') throw new Error('No sealed instrument or harness checker');
  let passed=0,total=0;const failed=new Map();
  for (const c of instrument.cases) {
    const actual=await runCheck(structuredClone(c),{round});
    if (!Number.isInteger(actual?.exitCode) || typeof actual.stdout!=='string' || typeof actual.stderr!=='string') throw new Error('Checker runner returned no execution receipt');
    total+=c.weight;
    const ok=Object.entries(c.expected).every(([k,v])=>actual[k]===v);
    if(ok)passed+=c.weight;
    else failed.set(c.area,(failed.get(c.area)||0)+c.weight);
  }
  const clusters=[...failed].map(([area,weight],i)=>({id:`failure-${i}`,area,weight}));
  const blocks=[{type:'assay.measure',round,pass_mass:passed/total,cluster_count:clusters.length,
    provenance:'harness-executed',instrument_hash:instrument.hash,cases_executed:instrument.cases.length}];
  if(clusters.length)blocks.push({type:'assay.finding.v1',round,clusters});
  return blocks;
}
