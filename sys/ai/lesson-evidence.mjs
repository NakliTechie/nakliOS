// A run can show that a declared lesson trigger appeared. It cannot attribute a
// better outcome to the lesson without a controlled, same-fuel comparison.
import { foldModels, joined } from '../history/run-record.mjs';

const unique = values => [...new Set(values.filter(Boolean))];
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value);

function validDeclaration(declaration) {
  return declaration && typeof declaration.tool === 'string' && declaration.tool.trim() &&
    declaration.args && typeof declaration.args === 'object' && !Array.isArray(declaration.args) &&
    Object.keys(declaration.args).length > 0 && Object.values(declaration.args).every(scalar);
}

function freshnessOf({ validatedFuelKey, currentFuelKey, validatedModelId }, answeredModels, unattributedReplies = 0) {
  if (validatedFuelKey && currentFuelKey && validatedFuelKey !== currentFuelKey)
    return { freshness:'stale', freshnessReason:'fuel configuration changed' };
  if (!validatedFuelKey || !currentFuelKey)
    return { freshness:'unknown', freshnessReason:'fuel configuration identity is unavailable' };
  if (!validatedModelId) return { freshness:'unknown', freshnessReason:'validated model identity is unavailable' };
  if (answeredModels.some(id => id !== validatedModelId))
    return { freshness:'stale', freshnessReason:'a reported responder differs from the validated model' };
  if (unattributedReplies) return { freshness:'unknown', freshnessReason:'some responding model identities are unavailable' };
  if (!answeredModels.length) return { freshness:'unknown', freshnessReason:'responding model identity is unavailable' };
  return { freshness:'current', freshnessReason:'reported responders match the validated model' };
}

// Exact scalar argument matching keeps this an observation, not a semantic guess.
export function inspectLessonEvidence(record, declaration, {
  validatedFuelKey = null, currentFuelKey = null, validatedModelId = null,
} = {}) {
  if (!record || typeof record.events !== 'function' || typeof record.resolve !== 'function')
    return { activation:'insufficient-evidence', reason:'run record is unavailable',
      configuredModels:[], answeredModels:[], unattributedReplies:0,
      ...freshnessOf({validatedFuelKey,currentFuelKey,validatedModelId},[]),
      gain:'unmeasured', matches:[] };
  const events = joined(record.events(), record.resolve);
  const configuredModels = foldModels(record.events(), record.resolve);
  const replies = events.filter(event => event.tool === 'llm.responded');
  const answeredModels = unique(replies
    .map(event => typeof event.output?.model === 'string' ? event.output.model.trim() : ''));
  const unattributedReplies = replies.filter(event => typeof event.output?.model !== 'string' || !event.output.model.trim()).length;
  const base = { configuredModels, answeredModels, unattributedReplies,
    ...freshnessOf({validatedFuelKey,currentFuelKey,validatedModelId},answeredModels,unattributedReplies), gain:'unmeasured' };
  if (!validDeclaration(declaration))
    return { ...base, activation:'insufficient-evidence', reason:'no valid activation declaration', matches:[] };
  const calls = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.tool === 'tool.called');
  const matches = calls.filter(({ event }) => event.input?.name === declaration.tool &&
    Object.entries(declaration.args || {}).every(([key, value]) => event.input?.args?.[key] === value))
    .map(({ event, index }) => ({ eventId:`e${index}`, hash:event.input_hash || null }));
  if (matches.length) return { ...base, activation:'observed', reason:'declared tool call appeared in the record', matches };
  const lastStart = events.findLastIndex(event => event.tool === 'run.started');
  const lastStop = events.findLastIndex(event => event.tool === 'run.stopped');
  if (lastStart < 0 || lastStop <= lastStart || calls.some(({ event }) => !event.input))
    return { ...base, activation:'insufficient-evidence', reason:'run or tool-call evidence is incomplete', matches:[] };
  return { ...base, activation:'unobserved', reason:'declared tool call did not appear in the completed run', matches:[] };
}
