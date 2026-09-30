import assert from 'node:assert/strict';
import { inspectLessonEvidence } from '../lesson-evidence.mjs';

const row = (tool, input, output, index) => ({ tool, input_hash:`i${index}`, output_hash:`o${index}`, input, output });
const run = (events) => ({ events:()=>events, resolve:event=>({ input:event.input, output:event.output }) });
const start = row('run.started', { model:{ id:'first-model', provider:'test' }, messages:[], tools:[] }, {}, 0);
const reply = row('llm.responded', { step:0 }, { model:'fallback-model', content:'' }, 1);
const called = row('tool.called', { name:'skill', args:{ name:'review-fix' }, step:0 }, {}, 2);
const stopped = row('run.stopped', {}, { stop:'done' }, 3);
const declaration = { tool:'skill', args:{ name:'review-fix' } };

const observed = inspectLessonEvidence(run([start, reply, called, stopped]), declaration,
  { validatedFuelKey:'first-model', currentFuelKey:'first-model', validatedModelId:'first-model' });
assert.equal(observed.activation, 'observed');
assert.equal(observed.freshness, 'stale');
assert.equal(observed.gain, 'unmeasured');
assert.deepEqual(observed.configuredModels.map(model=>model.id), ['first-model']);
assert.deepEqual(observed.answeredModels, ['fallback-model']);
assert.deepEqual(observed.matches.map(match=>match.eventId), ['e2']);

const firstReply = row('llm.responded', {step:0}, {model:'first-model',content:''}, 5);
const unobserved = inspectLessonEvidence(run([start, firstReply, stopped]), declaration,
  { validatedFuelKey:'first-model', currentFuelKey:'first-model', validatedModelId:'first-model' });
assert.equal(unobserved.activation, 'unobserved');
assert.equal(unobserved.freshness, 'current');
assert.equal(unobserved.gain, 'unmeasured');
assert.equal(inspectLessonEvidence(run([start, reply, stopped]), declaration,
  { validatedFuelKey:'first-model', currentFuelKey:'first-model', validatedModelId:'first-model' }).freshness,'stale');
assert.equal(inspectLessonEvidence(run([start, stopped]), declaration,
  { validatedFuelKey:'first-model', currentFuelKey:'first-model', validatedModelId:'first-model' }).freshness,'unknown');
assert.equal(inspectLessonEvidence(run([start, firstReply, row('llm.responded',{step:1},{content:''},6), stopped]), declaration,
  { validatedFuelKey:'first-model', currentFuelKey:'first-model', validatedModelId:'first-model' }).freshness,'unknown');

assert.equal(inspectLessonEvidence(run([start, reply]), declaration).activation, 'insufficient-evidence');
assert.equal(inspectLessonEvidence(run([start, called, stopped]), null).activation, 'insufficient-evidence');
assert.equal(inspectLessonEvidence(run([start, called, stopped]), {tool:'skill',args:{}}).activation, 'insufficient-evidence');
assert.equal(inspectLessonEvidence(run([start, called, stopped]), declaration).freshness, 'unknown');
assert.equal(inspectLessonEvidence(run([start, stopped, row('run.started', {messages:[]}, {}, 4)]), declaration).activation,
  'insufficient-evidence', 'a re-entered unfinished loop does not establish absence');
console.log('lesson activation keeps model identity, fuel freshness, and unknown outcomes distinct');
