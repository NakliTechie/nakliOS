// Independent network-denial regression for actual disposable Kiln Worker runtimes.
// Caller supplies the actual createKiln facade backed by disposable real Workers.
const API_NAMES = ['fetch','XMLHttpRequest','WebSocket','EventSource','Request','importScripts','Worker','SharedWorker','WebTransport'];
const CACHE_METHODS = ['open','match','has','delete','keys'];
const DENIAL = 'network access is disabled in Kiln';
const assert = (value, why) => { if (!value) throw new Error(why); };

const pythonCalls = `import js, sys, json
_b13_rows=[]
_b13_url='http://127.0.0.1:8878/b13-never-transmit'
for _b13_style in ('python-call','python-new'):
    for _b13_name in ${JSON.stringify(API_NAMES)}:
        try:
            if _b13_style == 'python-call':
                getattr(js,_b13_name)((sys._clear_type_cache(),_b13_url)[1])
            else:
                getattr(js,_b13_name).new((sys._clear_type_cache(),_b13_url)[1])
            _b13_rows.append({'style':_b13_style,'api':_b13_name,'refused':False})
        except Exception as _b13_error:
            _b13_rows.append({'style':_b13_style,'api':_b13_name,'refused':True,'type':type(_b13_error).__name__,'text':str(_b13_error)})
for _b13_name in ${JSON.stringify(CACHE_METHODS)}:
    try:
        getattr(js.caches,_b13_name)((sys._clear_type_cache(),_b13_url)[1])
        _b13_rows.append({'style':'python-cache','api':_b13_name,'refused':False})
    except Exception as _b13_error:
        _b13_rows.append({'style':'python-cache','api':_b13_name,'refused':True,'type':type(_b13_error).__name__,'text':str(_b13_error)})
print(json.dumps(_b13_rows))`;

const javascriptCalls = `(()=>{
 const rows=[],url='http://127.0.0.1:8878/b13-never-transmit';
 for(const style of ['javascript-call','javascript-new'])for(const api of ${JSON.stringify(API_NAMES)}){
  try{if(style==='javascript-call')Reflect.apply(globalThis[api],globalThis,[url]);else Reflect.construct(globalThis[api],[url]);rows.push({style,api,refused:false});}
  catch(error){rows.push({style,api,refused:true,type:error?.name,text:String(error)});}
 }
 for(const api of ${JSON.stringify(CACHE_METHODS)}){
  try{Reflect.apply(globalThis.caches[api],globalThis.caches,[url]);rows.push({style:'javascript-cache',api,refused:false});}
  catch(error){rows.push({style:'javascript-cache',api,refused:true,type:error?.name,text:String(error)});}
 }
 if(typeof globalThis.navigator?.sendBeacon==='function'){
  try{globalThis.navigator.sendBeacon(url);rows.push({style:'javascript-beacon',api:'sendBeacon',refused:false});}
  catch(error){rows.push({style:'javascript-beacon',api:'sendBeacon',refused:true,type:error?.name,text:String(error)});}
 }
 return JSON.stringify(rows);
})()`;

export async function verifyNetworkDenialRegression(kiln) {
 const observations=[];
 for(const interpreter of ['python','sqlite']){
  const options={...(interpreter==='sqlite'?{interpreter:'sqlite'}:{}),outputCapBytes:2<<20};
  const native=await kiln.exec('b13-network-native-'+interpreter,pythonCalls,options);
  assert(native.status==='ok'&&!native.truncated,'real Python call-style probe completes');
  const pythonRows=JSON.parse(native.stdout);
  observations.push({interpreter,kind:'python',rows:pythonRows});
  assert(pythonRows.length===23,'exactly eighteen API styles plus five cache methods');
  for(const row of pythonRows){
   assert(row.refused===true,`${interpreter}/${row.style}/${row.api} must refuse`);
   assert(row.type==='PermissionError',`${interpreter}/${row.style}/${row.api} preserves native PermissionError after cache clearing`);
   assert(typeof row.text==='string'&&row.text.includes(DENIAL),`${interpreter}/${row.style}/${row.api} preserves denial text`);
  }
  const javascript=await kiln.exec('b13-network-javascript-'+interpreter,'import js\nprint(js.eval('+JSON.stringify(javascriptCalls)+'))',options);
  assert(javascript.status==='ok'&&!javascript.truncated,'real JavaScript call-style probe completes');
  const javascriptRows=JSON.parse(javascript.stdout);
  observations.push({interpreter,kind:'javascript',rows:javascriptRows});
  assert(javascriptRows.length===23||javascriptRows.length===24,'exact JavaScript matrix plus optional existing beacon');
  for(const row of javascriptRows){
   assert(row.refused===true,`${interpreter}/${row.style}/${row.api} must throw`);
   assert(typeof row.text==='string'&&row.text.includes(DENIAL),`${interpreter}/${row.style}/${row.api} preserves denial text`);
  }
  const usable=await kiln.exec('b13-network-followup-'+interpreter,"import sqlite3\n_b13_db=sqlite3.connect(':memory:')\nprint(_b13_db.execute('SELECT 6*7').fetchone()[0])\n_b13_db.close()",options);
  assert(usable.status==='ok'&&usable.stdout==='42\n','SQLite remains usable after every refused call style');
 }
 return observations;
}
