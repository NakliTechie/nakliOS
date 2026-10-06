import assert from 'node:assert/strict';
import { inspectLessonEvidence, validLessonDeclaration } from '../lesson-evidence.mjs';

const row = (tool, input, output, index) => ({ tool, input_hash:`i${index}`, output_hash:`o${index}`, input, output });
const run = (events) => ({ events:()=>events, resolve:event=>({ input:event.input, output:event.output }) });
const start = row('run.started', { model:{ id:'first-model', provider:'test' }, messages:[], tools:[] }, {}, 0);
const reply = row('llm.responded', { step:0 }, { model:'fallback-model', content:'' }, 1);
const called = row('tool.called', { id:'call-1', name:'skill', args:{ name:'review-fix' }, step:0 }, {}, 2);
const answered = row('tool.responded',{id:'call-1',name:'skill'},{result:'Skill: review-fix'},4);
const stopped = row('run.stopped', {}, { stop:'done' }, 3);
const declaration = { tool:'skill', args:{ name:'review-fix' } };

const observed = inspectLessonEvidence(run([start, reply, called, answered, stopped]), declaration,
  { validatedFuelKey:'first-model', currentFuelKey:'first-model', validatedModelId:'first-model' });
assert.equal(observed.activation, 'observed');
assert.equal(observed.freshness, 'stale');
assert.equal(observed.gain, 'unmeasured');
assert.deepEqual(observed.configuredModels.map(model=>model.id), ['first-model']);
assert.deepEqual(observed.answeredModels, ['fallback-model']);
assert.deepEqual(observed.matches.map(match=>match.eventId), ['e2']);
const refused=row('tool.responded',{id:'call-1',name:'skill'},{result:'No skill named "review-fix".'},5);
assert.equal(inspectLessonEvidence(run([start,called,refused,stopped]),declaration).activation,'attempted-failed');
const staged=row('tool.responded',{id:'call-1',name:'skill'},{result:'Draft skill "review-fix" (staged — NOT active)'},6);
assert.equal(inspectLessonEvidence(run([start,called,staged,stopped]),declaration).activation,'attempted-failed');
const activeWithFailureWords=row('tool.responded',{id:'call-1',name:'skill'},
  {result:'Skill: review-fix\n\nDescribe why access was denied and a file was not found.'},8);
assert.equal(inspectLessonEvidence(run([start,called,activeWithFailureWords,stopped]),declaration).activation,'observed');
const readCall=row('tool.called',{id:'read-1',name:'read',args:{path:'README.md'}},{},9);
const readResult=row('tool.responded',{id:'read-1',name:'read'},
  {result:'    1  A missing skill was not found and access was denied.'},10);
assert.equal(inspectLessonEvidence(run([start,readCall,readResult,stopped]),
  {tool:'read',args:{path:'README.md'}}).activation,'observed');
assert.equal(inspectLessonEvidence(run([start,called,stopped]),declaration).activation,'insufficient-evidence',
  'a call without a paired result cannot establish activation');
const extraArgs = row('tool.called', {name:'skill',args:{name:'review-fix',extra:'unexpected'},step:0}, {}, 7);
assert.equal(inspectLessonEvidence(run([start,extraArgs,stopped]),declaration).activation,'unobserved',
  'a call with extra arguments does not match an exact declaration');

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
assert(validLessonDeclaration(declaration),'an exact tool and scalar args form a declaration');
assert(!validLessonDeclaration({tool:'skill',args:{}}),'an empty argument set cannot establish activation');
const declaredStale=inspectLessonEvidence(run([start, firstReply, stopped]),declaration,
  {declaredFuelKey:'provider/model-a',currentFuelKey:'provider/model-b',fuelIdentityComplete:false});
assert.equal(declaredStale.freshness,'stale','a changed model selection invalidates the declaration');
assert.equal(inspectLessonEvidence(run([start, firstReply, stopped]),declaration,
  {declaredFuelKey:'unconfigured',currentFuelKey:'provider/model-a'}).freshness,'stale',
  'configuring a model after the declaration makes it stale');
assert.equal(inspectLessonEvidence(run([start, firstReply, stopped]),declaration,
  {declaredFuelKey:'provider/model-a',currentFuelKey:'unconfigured'}).freshness,'stale',
  'losing a configured model after the declaration makes it stale');
const incomplete=inspectLessonEvidence(run([start, firstReply, stopped]),declaration,
  {declaredFuelKey:'provider/model-a',currentFuelKey:'provider/model-a',
    validatedFuelKey:'provider/model-a',validatedModelId:'first-model',fuelIdentityComplete:false});
assert.equal(incomplete.freshness,'unknown','matching a partial identity cannot establish full fuel freshness');
console.log('lesson activation keeps model identity, fuel freshness, and unknown outcomes distinct');
