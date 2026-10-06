import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrimeReadEvidence} from '../sys/ai/project-context.mjs';
const read='1  export function next(value) {\n2    return value + 1;\n3  }';
const fact={note:'The counter advances by one.',sourcePaths:['src/counter.js'],sourceSpans:[{path:'src/counter.js',startLine:2,endLine:2,quote:'return value + 1;'}]};
function evidence(){const bed=createPrimeReadEvidence();assert.equal(bed.observeRead({path:'src/counter.js'},read),true);return bed;}
test('exact inspected quote resolves with one-based coordinates',()=>{const result=evidence().checkRemember(fact);assert.equal(result.ok,true);assert.deepEqual(result.spans,fact.sourceSpans);});
test('fabricated quote and missing inspected line refuse fact',()=>{for(const span of [{...fact.sourceSpans[0],quote:'return value + 2;'}, {...fact.sourceSpans[0],endLine:4}])assert.equal(evidence().checkRemember({...fact,sourceSpans:[span]}).ok,false);});
test('head and tail samples cannot support intervening lines',()=>{const bed=createPrimeReadEvidence();assert.equal(bed.observeRead({path:'src/counter.js'},'1  header\n200  tail'),true);assert.equal(bed.checkRemember({...fact,sourceSpans:[{path:'src/counter.js',startLine:1,endLine:200,quote:'header'}]}).ok,false);});
test('truncated lines cannot support exact quotes',()=>{const bed=createPrimeReadEvidence();assert.equal(bed.observeRead({path:'src/counter.js'},'1  header\n2  return value … (line truncated)'),true);assert.equal(bed.checkRemember(fact).ok,false);});
test('hindsight, parent paths and failed reads never become evidence',()=>{const bed=createPrimeReadEvidence();for(const path of ['.anvil/memory/fact.md','../outside.js','/root.js'])assert.equal(bed.observeRead({path},read),false);assert.equal(bed.observeRead({path:'src/counter.js'},'Error reading: not found'),false);assert.equal(bed.checkRemember(fact).ok,false);});
test('each cited file requires its own explicit evidence span',()=>{const bed=evidence();bed.observeRead({path:'README.md'},'1  Counter project');assert.equal(bed.checkRemember({...fact,sourcePaths:['src/counter.js','README.md']}).ok,false);});
test('legacy source paths retain actual observed coordinates',()=>{const result=evidence().checkRemember({note:'Counter',sourcePaths:['src/counter.js']});assert.equal(result.ok,true);assert.equal(result.spans[0].startLine,1);assert.equal(result.spans[0].endLine,3);});
test('malformed numbering and evidence bounds fail closed',()=>{for(const value of ['2  later\n1  earlier','1  one\n1  duplicate','9007199254740992  overflow','x'.repeat(16001)])assert.equal(createPrimeReadEvidence().observeRead({path:'source.js'},value),false);});
