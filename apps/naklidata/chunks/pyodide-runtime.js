var R={statsmodels:"statsmodels",scipy:"scipy",patsy:"patsy"};function y(e){let t=new Set;for(let n of e){let a=R[n.split(".")[0]??""];a&&t.add(a)}return[...t].sort()}var l="/opendta_pyodide",h=new WeakSet,v=new WeakSet,N=/^\s*(?:(?:quietly|qui|noisily|noi|capture|cap)\s+)*(?:gr(?:a(?:ph?)?)?|tw(?:o(?:w(?:ay?)?)?)?|sc(?:a(?:t(?:t(?:er?)?)?)?)?|line|connected|area|bar|hist(?:o(?:g(?:r(?:am?)?)?)?)?|kdensity|kdens|qnorm|pnorm|qqplot|lowess|marginsplot|rvfplot|avplots?|lvr2plot)\b/m,q=/^\s*(?:(?:quietly|qui|noisily|noi|capture|cap)\s+)*(?:imp(?:o(?:r(?:t)?)?)?\s+exc(?:e(?:l)?)?|exp(?:o(?:r(?:t)?)?)?\s+exc(?:e(?:l)?)?|putexcel)\b/m;function O(e){return N.test(e)}var I=`
import glob
import json
import os
import numpy as np
import opendta_bridge as _ob
from opendta.commands.matrix import Matrix
from opendta.core.missing import SYSMISS

if np.dtype(np.intp).itemsize < 8 and not getattr(np, "_opendta_index_shim", False):
    _orig_bincount = np.bincount

    def _narrow_intp(x):
        a = np.asarray(x)
        if a.dtype.kind in "iu" and a.dtype.itemsize > np.dtype(np.intp).itemsize:
            return a.astype(np.intp)
        return x

    def _bincount(x, weights=None, minlength=0):
        return _orig_bincount(_narrow_intp(x), weights=weights, minlength=int(minlength))

    np.bincount = _bincount
    np._opendta_index_shim = True

if not getattr(_ob, "_naklidata_kx_ext", False):
    _orig_load = _ob._load
    _orig_state = _ob._state
    _orig_reset = _ob.reset
    _orig_new_engine = _ob._new_engine

    def _clean_odta_files():
        for p in glob.glob("odta_*"):
            try:
                if os.path.isfile(p):
                    os.remove(p)
            except OSError:
                pass

    def _kx_reset():
        _clean_odta_files()
        _orig_reset()

    def _kx_new_engine():
        e = _orig_new_engine()
        e.settings["numerics"] = "stata"
        return e

    def _apply_host_meta(meta, ds):
        vlabels = meta.get("valueLabels")
        if vlabels is not None:
            ds.value_labels = {
                str(name): {int(k): str(v) for k, v in table.items()}
                for name, table in vlabels.items()
            }
        var_vl = meta.get("varValueLabels")
        var_lbl = meta.get("varLabels")
        var_fmt = meta.get("varFormats")
        for v in ds.vars:
            if var_lbl is not None and v.name in var_lbl:
                v.label = str(var_lbl[v.name])
            if var_vl is not None:
                v.value_label = str(var_vl.get(v.name, ""))
            if var_fmt is not None and v.name in var_fmt and var_fmt[v.name]:
                v.fmt = str(var_fmt[v.name])
        if "xtset" in meta:
            xt = meta.get("xtset")
            dta_chars = ds.chars.setdefault("_dta", {})
            if xt and (xt.get("id") or xt.get("t")):
                if xt.get("id"):
                    dta_chars["_TSpanel"] = str(xt["id"])
                else:
                    dta_chars.pop("_TSpanel", None)
                if xt.get("t"):
                    dta_chars["_TStvar"] = str(xt["t"])
                    dta_chars.setdefault("_TSdelta", "+1.0000000000000X+000")
                else:
                    dta_chars.pop("_TStvar", None)
            elif xt is None:
                dta_chars.pop("_TSpanel", None)
                dta_chars.pop("_TStvar", None)

    def _ser_matrix(m):
        arr = np.asarray(m.data, dtype=np.float64)
        rows = []
        for row in arr.tolist():
            rows.append([None if (x >= SYSMISS or x != x) else float(x) for x in row])
        return {
            "rows": int(m.rows),
            "cols": int(m.cols),
            "rownames": list(m.rownames),
            "colnames": list(m.colnames),
            "roweq": list(m.roweq),
            "coleq": list(m.coleq),
            "data": rows,
        }

    def _export_matrices(s):
        out = {}
        for k, m in _ob._MATRICES.items():
            if isinstance(m, Matrix):
                out[str(k)] = _ser_matrix(m)
        src_s = _ob._engine if (_ob._engine is not None and s is _ob._session) else s
        for prefix, store in (("r", s.r), ("e", s.e)):
            for k, m in store.items():
                if isinstance(m, Matrix):
                    out[f"{prefix}({k})"] = _ser_matrix(m)
        if src_s is not s:
            for prefix, store in (("r", src_s.r), ("e", src_s.e)):
                for k, m in store.items():
                    if isinstance(m, Matrix) and f"{prefix}({k})" not in out:
                        out[f"{prefix}({k})"] = _ser_matrix(m)
        return out

    def _kx_load(meta, columns, sess=None):
        _orig_load(meta, columns, sess)
        s = sess or _ob._session
        _apply_host_meta(meta, s.data)

    def _kx_state(sess=None):
        st = _orig_state(sess)
        s = sess or _ob._session
        ds = s.data
        st["matrices"] = _export_matrices(s)
        st["valueLabels"] = {
            str(name): {str(k): str(v) for k, v in table.items()}
            for name, table in ds.value_labels.items()
        }
        st["varValueLabels"] = {v.name: v.value_label for v in ds.vars if v.value_label}
        st["varLabels"] = {v.name: v.label for v in ds.vars if v.label}
        st["varFormats"] = {v.name: v.fmt for v in ds.vars if v.fmt}
        dta_chars = ds.chars.get("_dta", {})
        panel = dta_chars.get("_TSpanel")
        tvar = dta_chars.get("_TStvar")
        st["xtset"] = {"id": panel or None, "t": tvar or None} if (panel or tvar) else None
        return st

    def _kx_run_command(meta, columns):
        if _ob._session is None or meta.get("reset"):
            _ob.reset()
        if _ob._engine is None:
            _ob._engine = _ob._new_engine()
        s = _ob._engine
        _ob.LINESIZE = int(meta.get("linesize", 80))
        s.settings["linesize"] = str(_ob.LINESIZE)
        if meta.get("keepData"):
            s.before = [(v.name, v.is_string, v.data.copy()) for v in s.data.vars]
            s.nobs_before = s.data.nobs
            s.r_before, s.e_before = dict(s.r), dict(s.e)
        else:
            globals_before = dict(s.macros.globals)
            prev_data, prev_e, prev_r = s.data, s.e, s.r
            _orig_load(meta, columns, s)
            for k, v in globals_before.items():
                s.macros.globals.setdefault(k, v)
            _ob._carry(prev_data, s.data)
            _apply_host_meta(meta, s.data)
            if not meta.get("reset") and prev_e and _ob._plain(prev_e) == _ob._plain(s.e):
                s.e = prev_e
                s.e_before = dict(prev_e)
                es = getattr(prev_data, "esample", None)
                if es is not None and len(es) == s.data.nobs:
                    s.data.esample = es.copy()
            if not meta.get("reset") and prev_r and _ob._plain(prev_r) == _ob._plain(s.r):
                s.r = prev_r
                s.r_before = dict(prev_r)
        s.log = []
        s.graphs = []
        error = None
        from opendta.core.errors import StataError
        from opendta.lang.lexer import split_commands
        try:
            s.interp.run_lines(split_commands(meta["code"]), echo=bool(meta.get("echo", False)))
        except StataError as e:
            s.report_error(e)
            error = {"code": e.rc, "message": e.message}
        except Exception as e:
            error = {"code": 3000, "message": "OpenDTA internal error: " + type(e).__name__ + ": " + str(e)}
        out = _ob._state(s)
        out["ematrix"] = _ob._ematrix(s)
        out["graphs"] = list(s.graphs)
        out["log"] = "".join(s.log)
        out["error"] = error
        return out

    def _apply_vfs(files):
        if not files:
            return
        d = files.to_py() if hasattr(files, "to_py") else files
        for name, data in d.items():
            base = os.path.basename(str(name))
            if not base:
                continue
            if data is None:
                try:
                    os.remove(base)
                except OSError:
                    pass
            else:
                b = bytes(data.to_py() if hasattr(data, "to_py") else data)
                with open(base, "wb") as fh:
                    fh.write(b)

    def _kx_run_json(meta_json, columns, host=None, evaluate=None, files=None):
        cols = [c.to_py() if hasattr(c, "to_py") else c for c in columns]
        meta = json.loads(meta_json)
        if meta.get("reset"):
            _ob.reset()
            meta = dict(meta, reset=False)
        _apply_vfs(files)
        if meta.get("kind") == "command":
            return json.dumps(_kx_run_command(meta, cols))
        return json.dumps(_ob.run(meta, cols, host, evaluate))

    _ob.reset = _kx_reset
    _ob._new_engine = _kx_new_engine
    _ob._load = _kx_load
    _ob._state = _kx_state
    _ob.run_command = _kx_run_command
    _ob.run_json_kx = _kx_run_json
    _ob._naklidata_kx_ext = True
`;async function w(e,t,n){await e.loadPackage(["numpy","scipy"]);for(let[a,o]of Object.entries(t.files))e.FS.mkdirTree(`${l}/${a}`.replace(/\/[^/]+$/,"")),e.FS.writeFile(`${l}/${a}`,o);e.FS.mkdirTree(l),e.FS.writeFile(`${l}/opendta_bridge.py`,n),e.runPython(`import sys
if ${JSON.stringify(l)} not in sys.path: sys.path.insert(0, ${JSON.stringify(l)})
import opendta_bridge`),e.runPython(I)}async function x(e,t){let{columns:n,stata:a,evaluate:o,vfsFiles:s,...r}=t;r.kind==="command"&&!h.has(e)&&O(r.code)&&(await e.loadPackage(["matplotlib"]),h.add(e)),r.kind==="command"&&!v.has(e)&&q.test(r.code)&&(await e.loadPackage(["openpyxl"]).catch(()=>{}),v.add(e)),e.globals.set("__od_meta",JSON.stringify(r)),e.globals.set("__od_cols",n),e.globals.set("__od_host",a??null),e.globals.set("__od_eval",o??null),e.globals.set("__od_files",s??null);try{let g=await e.runPythonAsync("opendta_bridge.run_json_kx(__od_meta, __od_cols, __od_host, __od_eval, __od_files)");return JSON.parse(g)}finally{e.globals.set("__od_files",void 0),e.globals.set("__od_host",void 0),e.globals.set("__od_eval",void 0),e.globals.set("__od_cols",void 0),e.globals.set("__od_meta",void 0)}}var P=2e6,d=class extends Error{constructor(t){super(t),this.name="PythonRunError"}},_=null,c=null;function S(e){return c||(c=(async()=>{let t=new URL("./pyodide/",document.baseURI).href;return e?.("Loading Python runtime\u2026"),(await import(`${t}pyodide.mjs`)).loadPyodide({indexURL:t})})(),c.catch(()=>{c=null})),c}function A(e){return _||(_=(async()=>{let t=await S(e);return e?.("Loading pandas + pyarrow\u2026"),await t.loadPackage(["pandas","pyarrow"]),e?.("Warming up\u2026"),t.runPython("import pandas as pd, pyarrow as pa, numpy as np"),e?.("Ready"),t})(),_.catch(()=>{_=null})),_}async function M(e,t){e.globals.set("__nd_code",t);let n=e.runPython(`from pyodide.code import find_imports as _nd_fi
_nd_fi(__nd_code)`),a=n.toJs();n.destroy?.();let o=y(a);o.length>0&&await e.loadPackage(o)}var m=null;function F(e){return m||(m=(async()=>{let t=await S(e);e?.("Loading OpenDTA runtime\u2026");let n=s=>new URL(`./opendta/${s}`,document.baseURI).href,[a,o]=await Promise.all([fetch(n("opendta.json")),fetch(n("opendta_bridge.py"))]);if(!a.ok||!o.ok)throw new Error(`OpenDTA failed to load (HTTP ${a.ok?o.status:a.status})`);return await w(t,await a.json(),await o.text()),t})(),m.catch(()=>{m=null})),m}async function B(e,t){let n=await F(t);return t?.("Running OpenDTA command\u2026"),x(n,e)}function U(){return _!==null}async function $(e,t){let n=await A();n.globals.set("__nd_pq_in",e);try{try{n.runPython(["import pyarrow as pa, pyarrow.parquet as pq, pandas as pd, numpy as np, io as _io","df = pq.read_table(_io.BytesIO(bytes(__nd_pq_in.to_py()))).to_pandas()"].join(`
`))}catch(s){throw new d(`Failed to load the input table into pandas: ${f(s)}`)}try{await M(n,t)}catch(s){throw new d(`Failed to load a statistics package: ${f(s)}`)}try{n.runPython(t)}catch(s){throw new d(f(s))}let a;try{a=n.runPython(["if not isinstance(df, pd.DataFrame):","    raise TypeError('the cell must leave a pandas DataFrame in `df` (got %s)' % type(df).__name__)","_nd_sink = _io.BytesIO()","pq.write_table(pa.Table.from_pandas(df, preserve_index=False), _nd_sink)","_nd_sink.getvalue()"].join(`
`))}catch(s){throw new d(`Could not read the result back: ${f(s)}`)}let o=a.toJs();return a.destroy?.(),o}finally{n.globals.set("__nd_pq_in",void 0)}}async function G(e,t){let n=`cell_${k(t.inputTable)}`,a=`cell_${k(t.cellId)}`;i(t.signal,"Python");let o=await e.query(`SELECT count(*) AS n FROM ${u(n)}`);i(t.signal,"Python");let s=Number(o[0]?.n??0);if(s>P)throw new Error(`Input has ${s.toLocaleString()} rows \u2014 Python cells are capped at ${P.toLocaleString()} to keep the tab within memory. Filter or aggregate upstream first.`);let r=await e.queryToParquetBuffer(`SELECT * FROM ${u(n)}`);i(t.signal,"Python"),await A(t.onProgress),i(t.signal,"Python");let g=await $(r,t.code);i(t.signal,"Python");let b=!1;try{await e.registerParquetBuffer(a,g),b=!0,i(t.signal,"Python")}catch(E){throw b&&t.signal?.aborted&&await e.drop(a).catch(()=>{}),E}let p=await e.query(`SELECT * FROM ${u(a)} LIMIT 50`);i(t.signal,"Python");let T=await e.query(`SELECT count(*) AS n FROM ${u(a)}`);return{columns:p.length>0?Object.keys(p[0]):[],rows:p,rowCount:Number(T[0]?.n??p.length)}}function k(e){return e.replace(/[^A-Za-z0-9_]/g,"_")}function u(e){return`"${e.replace(/"/g,'""')}"`}function i(e,t){if(e?.aborted)throw new DOMException(`${t} run cancelled.`,"AbortError")}function f(e){let t=e instanceof Error?e.message:String(e),n=t.split(`
`).map(o=>o.trimEnd()).filter(Boolean),a=n[n.length-1]??t;return typeof console<"u"&&console.error("[python-cell]",t),a}export{P as PYTHON_MAX_ROWS,d as PythonRunError,U as isRuntimeLoaded,A as loadPythonRuntime,B as runOpenDTARequest,G as runPythonCell,$ as runPythonParquet};
