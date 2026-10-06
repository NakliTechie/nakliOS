// Validate JSON shape and a conservative byte bound before serialization.
import {utf8ByteLengthWithin} from './text-byte-bound.mjs';
export function codemodeJson(value,limit){
 let budget=limit,nodes=0;const seen=new Set();
 const take=n=>{budget-=n;if(budget<0)throw Error('JSON byte limit')};
 const string=s=>{const n=utf8ByteLengthWithin(s,budget);if(n===null)throw Error('JSON byte limit');take(n+2);for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c===34||c===92)take(1);else if(c<32)take([8,9,10,12,13].includes(c)?1:5);else if(c>=55296&&c<=57343){if(c<=56319&&s.charCodeAt(i+1)>=56320&&s.charCodeAt(i+1)<=57343)i++;else take(3);}}};
 function walk(v,depth){
  if(++nodes>8192||depth>32)throw Error('JSON structure limit');
  if(v===null){take(4);return}if(typeof v==='string'){string(v);return}if(typeof v==='boolean'){take(v?4:5);return}
  if(typeof v==='number'){if(!Number.isFinite(v))throw Error('JSON number invalid');take(String(v).length);return}
  if(typeof v!=='object'||seen.has(v))throw Error('JSON value invalid');
  const array=Array.isArray(v),proto=Object.getPrototypeOf(v);if(!array&&proto!==Object.prototype&&proto!==null)throw Error('JSON object invalid');
  if(Object.getOwnPropertyDescriptor(v,'toJSON'))throw Error('JSON custom serialization refused');
  if(array&&v.length>8192)throw Error('JSON array limit');seen.add(v);take(2);let count=0;
  if(array){for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!Object.hasOwn(d,'value'))throw Error('JSON array entry invalid');if(count++)take(1);walk(d.value,depth+1);}}
  else for(const key in v){if(!Object.hasOwn(v,key))continue;if(count++>=8192)throw Error('JSON key limit');if(count>1)take(1);string(key);take(1);const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!Object.hasOwn(d,'value'))throw Error('JSON accessor refused');walk(d.value,depth+1);}
  seen.delete(v);
 }
 walk(value,0);const text=JSON.stringify(value);if(utf8ByteLengthWithin(text,limit)===null)throw Error('JSON byte limit');return text;
}
