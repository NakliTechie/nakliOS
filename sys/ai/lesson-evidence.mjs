// A run can show that a declared lesson trigger appeared. It cannot attribute a
// better outcome to the lesson without a controlled, same-fuel comparison.
import { foldModels, joined } from '../history/run-record.mjs';
import { isSuccessfulReadToolResult } from './tool-result-kind.mjs';

const unique = values => [...new Set(values.filter(Boolean))];
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value);

function failedToolResponse(name, result) {
  if(name==='read') return !isSuccessfulReadToolResult(result);
  if(name==='skill') return !result.startsWith('Skill: ');
  if(name==='shell') {
    const exit=/\[exit (-?\d+)\](?:\s*\[expect\][^\n]*)?\s*$/.exec(result);
    if(exit) return Number(exit[1])!==0;
  }
  // These are control prefixes. Payload prose later in a successful result
  // cannot turn an activation into a failed call.
  return /^(?:Error\b|Refused:|Not available during\b)/i.test(result);
}

export function validLessonDeclaration(declaration) {
  return declaration && typeof declaration.tool === 'string' && declaration.tool.trim() &&
    declaration.args && typeof declaration.args === 'object' && !Array.isArray(declaration.args) &&
    Object.keys(declaration.args).length > 0 && Object.values(declaration.args).every(scalar);
}

function freshnessOf({ declaredFuelKey, validatedFuelKey, currentFuelKey, validatedModelId, fuelIdentityComplete = true }, answeredModels, unattributedReplies = 0) {
  if (declaredFuelKey && currentFuelKey && declaredFuelKey !== currentFuelKey)
    return { freshness:'stale', freshnessReason:'model selection changed since the activation declaration' };
  if (validatedFuelKey && currentFuelKey && validatedFuelKey !== currentFuelKey)
    return { freshness:'stale', freshnessReason:'fuel configuration changed' };
  if (!validatedFuelKey || !currentFuelKey)
    return { freshness:'unknown', freshnessReason:'fuel configuration identity is unavailable' };
  if (!validatedModelId) return { freshness:'unknown', freshnessReason:'validated model identity is unavailable' };
  if (answeredModels.some(id => id !== validatedModelId))
    return { freshness:'stale', freshnessReason:'a reported responder differs from the validated model' };
  if (unattributedReplies) return { freshness:'unknown', freshnessReason:'some responding model identities are unavailable' };
  if (!answeredModels.length) return { freshness:'unknown', freshnessReason:'responding model identity is unavailable' };
  if (!fuelIdentityComplete) return { freshness:'unknown', freshnessReason:'full fuel configuration identity is unavailable' };
  return { freshness:'current', freshnessReason:'reported responders match the validated model' };
}

// Exact scalar argument matching keeps this an observation, not a semantic guess.
export function inspectLessonEvidence(record, declaration, {
  declaredFuelKey = null, validatedFuelKey = null, currentFuelKey = null,
  validatedModelId = null, fuelIdentityComplete = true,
} = {}) {
  if (!record || typeof record.events !== 'function' || typeof record.resolve !== 'function')
    return { activation:'insufficient-evidence', reason:'run record is unavailable',
      configuredModels:[], answeredModels:[], unattributedReplies:0,
      ...freshnessOf({declaredFuelKey,validatedFuelKey,currentFuelKey,validatedModelId,fuelIdentityComplete},[]),
      gain:'unmeasured', matches:[] };
  const events = joined(record.events(), record.resolve);
  const configuredModels = foldModels(record.events(), record.resolve);
  const replies = events.filter(event => event.tool === 'llm.responded');
  const answeredModels = unique(replies
    .map(event => typeof event.output?.model === 'string' ? event.output.model.trim() : ''));
  const unattributedReplies = replies.filter(event => typeof event.output?.model !== 'string' || !event.output.model.trim()).length;
  const base = { configuredModels, answeredModels, unattributedReplies,
    ...freshnessOf({declaredFuelKey,validatedFuelKey,currentFuelKey,validatedModelId,fuelIdentityComplete},answeredModels,unattributedReplies), gain:'unmeasured' };
  if (!validLessonDeclaration(declaration))
    return { ...base, activation:'insufficient-evidence', reason:'no valid activation declaration', matches:[] };
  const calls = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.tool === 'tool.called');
  const matches = calls.filter(({ event }) => event.input?.name === declaration.tool &&
    event.input?.args && typeof event.input.args === 'object' && !Array.isArray(event.input.args) &&
    Object.keys(event.input.args).length === Object.keys(declaration.args).length &&
    Object.entries(declaration.args).every(([key, value]) => Object.hasOwn(event.input.args,key) && event.input.args[key] === value))
    .map(({ event, index }) => ({ eventId:`e${index}`, hash:event.input_hash || null }));
  const successful=[], failed=[];
  for(const match of matches){
    const at=Number(match.eventId.slice(1)), id=events[at].input?.id;
    if(!id) continue;
    const answer=events.slice(at+1).find(event=>
      (event.tool==='tool.responded'||event.tool==='tool.failed') && event.input?.id===id);
    if(!answer) continue;
    if(answer.tool==='tool.failed' || typeof answer.output?.result!=='string' ||
       failedToolResponse(declaration.tool,answer.output.result)) failed.push(match);
    else successful.push(match);
  }
  if(successful.length) return { ...base, activation:'observed', reason:'declared tool call completed without a recorded failure', matches:successful };
  if(failed.length) return { ...base, activation:'attempted-failed', reason:'declared tool call failed or was refused', matches:failed };
  if(matches.length) return { ...base, activation:'insufficient-evidence', reason:'declared tool call has no paired result', matches };
  const lastStart = events.findLastIndex(event => event.tool === 'run.started');
  const lastStop = events.findLastIndex(event => event.tool === 'run.stopped');
  if (lastStart < 0 || lastStop <= lastStart || calls.some(({ event }) => !event.input))
    return { ...base, activation:'insufficient-evidence', reason:'run or tool-call evidence is incomplete', matches:[] };
  return { ...base, activation:'unobserved', reason:'declared tool call did not appear in the completed run', matches:[] };
}
