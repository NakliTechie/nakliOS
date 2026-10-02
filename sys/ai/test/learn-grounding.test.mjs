import assert from 'node:assert/strict';
import { learningEvidence, checkProposalChronology, runLearnReview, reviewResultLine } from '../learn.mjs';

const raw = [
  { tool:'run.started', input:{messages:[{role:'system',content:'Use the available shell schema.'},{role:'user',content:'Fix the parser.'}],tools:[]}, output:{} },
  { tool:'turn.started', input:{step:0}, output:{} },
  { tool:'tool.called', input:{step:0,name:'shell',args:{command:'cat parser.js'}}, output:{} },
  { tool:'tool.responded', input:{step:0,name:'shell'}, output:{result:'Parser expects quoted input.'} },
  { tool:'turn.started', input:{step:1}, output:{} },
  { tool:'run.steered', input:{step:1}, output:{content:'Later owner feedback revealed another requirement.'} },
  { tool:'run.stopped', input:{}, output:{stop:'error',error:'parser failed'} },
].map((row,index)=>({ ...row, input_hash:`input-${index}`, output_hash:`output-${index}` }));
const record = { events:()=>raw, resolve:event=>({input:event.input,output:event.output}) };
const evidence = learningEvidence(record);
assert.deepEqual(evidence.turnStarts,[1,4]);
assert.deepEqual(evidence.turnBoundaries.map(boundary=>boundary.id),['e1','e4']);
const retriedTurn = { events:()=>[raw[0],raw[1],raw[3],{...raw[4],input:{step:0}}],
  resolve:event=>({input:event.input,output:event.output}) };
assert.deepEqual(learningEvidence(retriedTurn).turnBoundaries.map(boundary=>[boundary.turn,boundary.step]),[[0,0],[1,0]],
  'two turn boundaries remain distinct when context retry repeats the step');
assert.ok(evidence.entries.some(entry=>entry.id==='e3'));
assert.equal(checkProposalChronology({responsibleTurn:1,evidenceIds:['e3'],explanation:'The parser output showed quoted input.'},evidence).ok,true);
assert.match(checkProposalChronology({responsibleTurn:0,evidenceIds:['e3'],explanation:'The parser output showed quoted input.'},evidence).reason,/after responsible turn/);
assert.match(checkProposalChronology({responsibleTurn:0,evidenceIds:['e5'],explanation:'Later feedback.'},evidence).reason,/after responsible turn/);
assert.match(checkProposalChronology({responsibleTurn:8,evidenceIds:['e0'],explanation:'Initial schema.'},evidence).reason,/outside this run/);
assert.deepEqual(checkProposalChronology({responsibleTurn:8,evidenceIds:['e0'],explanation:'Initial schema.'},evidence).sourceRefs,['e0']);
assert.match(checkProposalChronology({responsibleTurn:1,evidenceIds:['e99'],explanation:'Invented event.'},evidence).reason,/unavailable/);
assert.match(checkProposalChronology({responsibleTurn:1,evidenceIds:[],explanation:'No source.'},evidence).reason,/citations/);
assert.equal(learningEvidence(record,{limit:1}).entries.length,1,'small catalogs remain bounded');
const longRecord = { events:()=>[
  raw[0], raw[1],
  ...Array.from({length:70},(_,i)=>({tool:'tool.responded',input_hash:`long-i${i}`,output_hash:`long-o${i}`,
    input:{step:0},output:{result:`result ${i}`}})),
  raw[4], raw[6],
], resolve:event=>({input:event.input,output:event.output}) };
const bounded = learningEvidence(longRecord);
assert.equal(bounded.entries.length,60);
assert.equal(bounded.omittedIds.has('e10'),true);
assert.match(checkProposalChronology({responsibleTurn:1,evidenceIds:['e10'],explanation:'Earlier result.'},bounded).reason,/outside the bounded review window/);
const blankFailure = { events:()=>[raw[0],{tool:'verify.failed',input:{},output:{}},raw[1]],
  resolve:event=>({input:event.input,output:event.output}) };
assert.equal(learningEvidence(blankFailure).entries.find(entry=>entry.id==='e1').resolved,false);
const checkpoint = { events:()=>[raw[0],{tool:'run.checkpoint',input:{step:0},output:{handoff:'Use parser rule.'}},raw[1]],
  resolve:event=>({input:event.input,output:event.output}) };
assert.equal(learningEvidence(checkpoint).entries.find(entry=>entry.id==='e1').summary,'Use parser rule.');

const staged=[];
const proposals=[
  {kind:'fact',name:'quoted-input',note:'Quote parser input.',responsibleTurn:1,evidenceIds:['e3'],explanation:'The earlier parser result named the quoting rule.'},
  {kind:'fact',name:'hindsight',note:'Use the later feedback.',responsibleTurn:0,evidenceIds:['e5'],explanation:'The owner revealed this only after the first turn.'},
  {kind:'skill',name:'missing-source',content:'Guess.',responsibleTurn:1,evidenceIds:['e99'],explanation:'No such event exists.'},
];
const result=await runLearnReview({record,infer:async()=>({content:JSON.stringify({proposals})}),
  propose:async proposal=>{staged.push(proposal);return {ok:true,staged:proposal.name}}});
assert.deepEqual(staged.map(p=>p.name),['quoted-input']);
assert.equal(result.quarantined.length,2);
assert.equal(result.quarantined[0].sourceRefs[0].id,'e5');
assert.match(result.quarantined[0].explanation,/owner revealed/);
assert.equal(result.activeWrites,0);
assert.match(result.prompt,/Citable run events/);
assert.match(result.prompt,/Turn 1 begins at e4/);
assert.equal(result.quarantinedCount,2);
assert.equal(result.chronologyCheckedCount,1);
assert.match(result.attempts[0].error,/after responsible turn/);
assert.match(reviewResultLine({staged:[],dropped:[],quarantined:result.quarantined}),/2 proposal\(s\) quarantined/);
assert.doesNotMatch(reviewResultLine({staged:[],dropped:[],quarantined:result.quarantined}),/nothing new worth staging/);
console.log('learning proposals require earlier run evidence; hindsight stays quarantined');
