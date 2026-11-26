"""opendta-pyodide: a host bridge to OpenDTA (Stata 14 commands and Mata) in Pyodide.

The host (for example a Stata do-file interpreter in JavaScript) owns the
dataset, macros and scalars. For each mata block or mata: line it sends them here; this module runs
the code against a stand-in for OpenDTA's Session and returns the log and what
the code changed. The Mata engine (functions, globals, classes) lives until
the host asks for a reset.
"""

import json
import math

import numpy as np

# Pyodide's NumPy reports LAPACK failure through floating-point flags, which
# WebAssembly lacks, so cholesky, inv and solve return NaN instead of raising.
# OpenDTA catches LinAlgError in about 95 places, so restore the error.
if not getattr(np.linalg, "_mata_pyodide_shim", False):
    def _wrap(fn):
        def w(a, *args, **kw):
            r = fn(a, *args, **kw)
            arr = r[0] if isinstance(r, tuple) else r
            if np.isnan(np.asarray(arr, dtype=np.float64)).any() and not np.isnan(np.asarray(a, dtype=np.float64)).any():
                raise np.linalg.LinAlgError(fn.__name__ + ": matrix is singular or not positive definite")
            return r
        w.__name__ = fn.__name__
        return w
    for _n in ("cholesky", "inv", "solve"):
        setattr(np.linalg, _n, _wrap(getattr(np.linalg, _n)))
    np.linalg._mata_pyodide_shim = True

# Pyodide is 32-bit, so NumPy's index type (intp) is int32, and np.repeat refuses
# int64 repeat counts under its 'safe' casting rule. OpenDTA builds counts as
# int64 (expand, contract, fillin), so narrow them here; counts above 2**31 are
# out of range for a 32-bit array anyway.
if np.dtype(np.intp).itemsize < 8 and not getattr(np, "_opendta_repeat_shim", False):
    _np_repeat = np.repeat

    def _repeat(a, repeats, axis=None):
        r = np.asarray(repeats)
        if r.dtype.kind in "iu" and r.dtype.itemsize > np.dtype(np.intp).itemsize:
            repeats = r.astype(np.intp)
        return _np_repeat(a, repeats, axis=axis)

    np.repeat = _repeat
    np._opendta_repeat_shim = True

from opendta.core import formats as _formats
from opendta.core.dataset import Dataset, Variable, str_type_for
from opendta.core.errors import StataError
from opendta.core.missing import SYSMISS
from opendta.core.output import Output
from opendta.lang.lexer import split_commands
from opendta.lang.macros import MacroStore

_formats.set_superscript(False)
LINESIZE = 80


class _HostStata:
    """stata("cmd") runs cmd in the host. The host is
    asynchronous, so the call waits through Pyodide's run_sync, which needs
    WebAssembly stack switching (JSPI). Mata's changes so far are sent first,
    and the dataset, macros and scalars come back after the command."""

    def execute(self, cmd):
        s = _session
        try:
            from pyodide.ffi import can_run_sync, run_sync
        except ImportError:
            can_run_sync = None
        if s.host is None or can_run_sync is None or not can_run_sync():
            raise StataError(3000, "stata() needs WebAssembly stack switching (JSPI), which this browser lacks")
        state = _state()
        state["cmd"] = cmd
        reply = run_sync(s.host(json.dumps(state)))
        meta = json.loads(reply.json)
        cols = [c.to_py() if hasattr(c, "to_py") else c for c in reply.columns]
        for line in meta["log"]:
            s.output.write(line + "\n")
        _load(meta, cols)
        if meta.get("error"):
            raise StataError(int(meta["error"]["code"]), meta["error"]["message"])


class _Session:
    """The slice of OpenDTA's Session that the Mata package reads."""

    def __init__(self):
        self.data = Dataset()
        self.output = Output()
        self.output.linesize = lambda: LINESIZE
        self.macros = MacroStore()
        self.scalars = {}
        self.matrices = _MATRICES
        self.r = {}
        self.e = {}
        self.sret = {}
        self.scopes = []
        self.rc = 0
        self.interp = _HostStata()
        self.host = None
        self.evaluate = None
        self.settings = {"linesize": str(LINESIZE), "level": "95", "varabbrev": "on",
                         "hints": "off", "dp": "period"}
        self._mata = None
        self.dirty = False
        self.log = []
        self.output.add_listener(lambda text, style: self.log.append(text))

    @property
    def mata(self):
        if self._mata is None:
            from opendta.mata.interp import MataEngine
            self._mata = MataEngine(self)
        return self._mata

    @property
    def nobs(self):
        return self.data.nobs

    def notify_state(self):
        self.dirty = True

    def eval(self, text):
        """A Stata scalar expression, evaluated by the host (matrix command)."""
        try:
            from pyodide.ffi import can_run_sync, run_sync
        except ImportError:
            can_run_sync = None
        if self.evaluate is None or can_run_sync is None or not can_run_sync():
            raise StataError(3000, "this matrix expression needs WebAssembly stack switching (JSPI)")
        out = json.loads(run_sync(self.evaluate(text)))
        if out.get("error"):
            raise StataError(int(out["error"]["code"]), out["error"]["message"])
        v = out.get("value")
        return SYSMISS if v is None else v

    def expand_varlist(self, text):
        from opendta.core.varlist import expand
        return expand(self.data, text, abbrev=self.settings.get("varabbrev", "on") == "on")

    def set_rc(self, rc):
        self.rc = int(rc)

    def report_error(self, e, *, show_rc=True):
        self.output.error(e.message, e.rc, show_rc=show_rc)

    def creturn(self, name):
        values = {"pi": math.pi, "N": float(self.data.nobs), "k": float(self.data.nvars),
                  "rc": float(self.rc), "linesize": float(LINESIZE),
                  "maxdouble": 8.98846567431158e307, "mindouble": -8.98846567431158e307,
                  "epsdouble": 2.220446049250313e-16, "smallestdouble": 2.2250738585072014e-308,
                  "stata_version": 14.0, "version": 14.0, "os": "Unix",
                  "machine_type": "WebAssembly", "level": 95.0, "dp": "period"}
        return values.get(name, "")


_session = None
_engine = None
# Stata matrices, shared by the Mata session and the command session, so a
# matrix made by one (matrix M = ..., st_matrix("M", X)) is visible to the other.
_MATRICES = {}


def reset():
    """Start over: a new Mata session, no command session yet, no matrices."""
    global _session, _engine
    _MATRICES.clear()
    _session = _Session()
    _engine = None


def _variables(specs, columns):
    """Variables from the host columns: numbers as float64 with Stata's missing."""
    out = []
    for (name, kind, sqltype), col in zip(specs, columns):
        if kind == "str":
            vals = np.array([str(x) for x in col], dtype=object)
            longest = max((len(x.encode("utf-8")) for x in vals), default=1)
            out.append(Variable(name, str_type_for(longest), vals))
            continue
        if isinstance(col, list):
            a = np.array([np.nan if x is None else x for x in col], dtype=np.float64)
        else:
            a = np.asarray(col, dtype=np.float64).copy()
        a[np.isnan(a)] = SYSMISS
        t = sqltype.upper()
        fmt = ""
        if kind == "date":
            vt, fmt = "long", "%td"
        elif t in ("TINYINT", "BOOLEAN"):
            vt = "byte"
        elif t in ("SMALLINT", "UTINYINT"):
            vt = "int"
        elif t in ("INTEGER", "USMALLINT"):
            vt = "long"
        elif t == "FLOAT":
            vt = "float"
        else:
            vt = "double"
        out.append(Variable(name, vt, a, fmt))
    return out


def _export(before, nobs_before, sess=None):
    ds = (sess or _session).data
    names_before = [b[0] for b in before]
    names_now = [v.name for v in ds.vars]
    full = ds.nobs != nobs_before or any(n not in names_now for n in names_before) \
        or names_now[:len(names_before)] != names_before
    by_name = {b[0]: b for b in before}
    changed = []
    for v in ds.vars:
        old = by_name.get(v.name)
        if not full and old is not None and old[1] == v.is_string:
            if v.is_string and list(old[2]) == list(v.data):
                continue
            if not v.is_string and np.array_equal(old[2], v.data):
                continue
        changed.append(v)
    cols = []
    for v in (ds.vars if full else changed):
        if v.is_string:
            cols.append({"name": v.name, "kind": "str", "values": [str(x) for x in v.data]})
        else:
            a = np.asarray(v.data, dtype=np.float64)
            vals = [None if x >= SYSMISS or x != x else x for x in a.tolist()]
            kind = "date" if v.fmt.startswith("%td") else "num"
            cols.append({"name": v.name, "kind": kind,
                         "integer": v.vtype in ("byte", "int", "long"), "values": vals})
    return {"full": full, "nobs": int(ds.nobs), "order": names_now, "columns": cols}


def _chunks(source):
    def code(ln):
        # In Mata a star at the start of a line is not a comment (*p = 1).
        if ln.kind == "comment" and ln.echo_lines and ln.echo_lines[0].lstrip().startswith("*"):
            return "\n".join(ln.echo_lines)
        return ln.text if ln.kind == "cmd" else ""
    return [(code(ln), ln.echo_lines) for ln in split_commands(source)]


def _plain(d):
    out = {}
    for k, v in d.items():
        if isinstance(v, (bool, int, float, np.floating, np.integer)):
            x = float(v)
            out[k] = None if x >= SYSMISS or x != x else x
        elif isinstance(v, str):
            out[k] = v
    return out


_SUBCOMMANDS = ("clear", "describe", "d", "drop", "set", "mlib", "mosave", "which", "memory",
                "query", "rename")


def _load(meta, columns, sess=None):
    """Dataset, macros, scalars, results and generator state from the host."""
    s = sess or _session
    ds = Dataset()
    ds.nobs = int(meta["nobs"])
    ds.vars.extend(_variables(meta["vars"], columns))
    s.data = ds
    s.dirty = False
    s.macros = MacroStore()
    s.macros.locals.update(meta.get("locals", {}))
    s.macros.globals.update(meta.get("globals", {}))
    s.scalars = {k: (SYSMISS if v is None else v) for k, v in meta.get("scalars", {}).items()}
    s.r = {k: (SYSMISS if v is None else v) for k, v in meta.get("r", {}).items()}
    s.e = {k: (SYSMISS if v is None else v) for k, v in meta.get("e", {}).items()}
    if meta.get("rng"):
        from opendta.core import rng as _rng
        _rng.RNG.set_state(meta["rng"])
    em = meta.get("ematrix")
    if em:
        from opendta.commands.matrix import Matrix
        names = list(em["names"])
        s.e["b"] = Matrix(np.array([em["b"]], dtype=np.float64), ["y1"], names)
        s.e["V"] = Matrix(np.array(em["V"], dtype=np.float64), names, names)
    s.before = [(v.name, v.is_string, v.data.copy()) for v in ds.vars]
    s.nobs_before = ds.nobs
    s.r_before, s.e_before = dict(s.r), dict(s.e)


def _state(sess=None):
    """What changed since the last load, plus macros, scalars and results."""
    from opendta.core import rng as _rng
    s = sess or _session
    changed = s.dirty or s.data.nobs != s.nobs_before or getattr(s, "always_export", False)
    return {
        "data": _export(s.before, s.nobs_before, s) if changed else None,
        "locals": dict(s.macros.locals),
        "globals": dict(s.macros.globals),
        "scalars": _plain(s.scalars),
        "r": _plain(s.r) if _plain(s.r) != _plain(s.r_before) else None,
        "e": _plain(s.e) if _plain(s.e) != _plain(s.e_before) else None,
        "rng": _rng.RNG.state(),
    }


def run(meta, columns, host=None, evaluate=None):
    global LINESIZE
    if _session is None or meta.get("reset"):
        reset()
    s = _session
    s.host = host
    s.evaluate = evaluate
    LINESIZE = int(meta.get("linesize", 80))
    s.settings["linesize"] = str(LINESIZE)
    _load(meta, columns)
    s.log = []
    error = None
    from opendta.mata.interp import MataLeave
    try:
        if meta["kind"] == "matrix":
            from opendta.commands.matrix import cmd_matrix
            cmd_matrix(s, meta["code"])
        elif meta["kind"] == "line":
            text = meta["code"].strip()
            first = text.split()[0] if text else ""
            if first in _SUBCOMMANDS:
                s.mata.subcommand(text)
            elif text:
                s.mata.run_statement(text)
        else:
            title = " mata (type end to exit) "
            s.output.write("-" * 49 + title + "-" * max(0, LINESIZE - 49 - len(title)) + "\n")
            try:
                s.mata.run_block(_chunks(meta["code"]), echo=True,
                                 stop_on_error=bool(meta["colon"]))
            except StataError as e:
                e.message = (e.message + "\n" if e.message else "") + "-" * LINESIZE
                raise
            s.output.write(": end\n", "command")
            s.output.write("-" * LINESIZE + "\n")
    except MataLeave:
        pass
    except StataError as e:
        error = {"code": e.rc, "message": e.message}
    except Exception as e:  # an interpreter fault becomes a Stata-style error
        error = {"code": 3000, "message": "Mata internal error: " + type(e).__name__ + ": " + str(e)}
    out = _state()
    out["log"] = "".join(s.log)
    out["error"] = error
    s.host = None
    s.evaluate = None
    return out


# -- Stata commands on OpenDTA's own Session ----------------------------------

def _new_engine():
    import os
    os.environ.setdefault("MPLBACKEND", "agg")
    from opendta.session import Session
    e = Session()
    e.settings["hints"] = "off"
    e.always_export = True
    e.dirty = False
    e.log = []
    e.graphs = []
    e.output.add_listener(lambda text, style: e.log.append(text))
    e.ui_hooks["graph"] = lambda g: e.graphs.append(_svg(g))
    e.matrices = _MATRICES
    return e


def _svg(g):
    import io
    from opendta.graphics.render import export
    buf = io.BytesIO()
    export(g, buf, "svg")
    return buf.getvalue().decode("utf-8")


def _ematrix(s):
    from opendta.commands.matrix import Matrix
    b, V = s.e.get("b"), s.e.get("V")
    if not isinstance(b, Matrix) or not isinstance(V, Matrix):
        return None
    return {"names": list(b.colnames), "b": [float(x) for x in np.asarray(b.data)[0]],
            "V": [[float(x) for x in row] for row in np.asarray(V.data)]}


def _carry(prev, ds):
    """Keep what the host does not hold from the engine's previous dataset:
    variable and value labels, notes, formats, characteristics (where OpenDTA
    keeps tsset, xtset, stset, svyset and mi settings) and the sort order."""
    import copy
    if prev is None or not prev.vars:
        return
    old = {v.name: v for v in prev.vars}
    names = set()
    for v in ds.vars:
        names.add(v.name)
        o = old.get(v.name)
        if o is None or o.is_string != v.is_string:
            continue
        v.label, v.value_label, v.notes = o.label, o.value_label, list(o.notes)
        if not v.fmt.startswith("%t"):
            v.fmt = o.fmt
    ds.label, ds.notes = prev.label, list(prev.notes)
    ds.value_labels = copy.deepcopy(prev.value_labels)
    ds.chars = {k: dict(c) for k, c in prev.chars.items() if k == "_dta" or k in names}
    same = ds.nobs == prev.nobs and all(
        k in old and k in names and (
            list(old[k].data) == list(ds.get(k).data) if old[k].is_string
            else np.array_equal(np.asarray(old[k].data), np.asarray(ds.get(k).data))
        )
        for k in prev.sortlist
    )
    if same:
        ds.sortlist = list(prev.sortlist)


def run_command(meta, columns):
    """Run Stata command lines on OpenDTA's Session, starting from the host's state."""
    global _engine, LINESIZE
    if _session is None or meta.get("reset"):
        reset()
    if _engine is None:
        _engine = _new_engine()
    s = _engine
    LINESIZE = int(meta.get("linesize", 80))
    s.settings["linesize"] = str(LINESIZE)
    if meta.get("keepData"):
        # No host dataset: the engine keeps its own data, macros and results.
        s.before = [(v.name, v.is_string, v.data.copy()) for v in s.data.vars]
        s.nobs_before = s.data.nobs
        s.r_before, s.e_before = dict(s.r), dict(s.e)
    else:
        globals_before = dict(s.macros.globals)
        prev_data, prev_e = s.data, s.e
        _load(meta, columns, s)
        for k, v in globals_before.items():
            s.macros.globals.setdefault(k, v)
        # The host hands e() back as plain values. When they are what this engine
        # returned last time, keep the engine's own e() (matrices included) and its
        # estimation sample, so postestimation (margins, predict, test) still works.
        _carry(prev_data, s.data)
        if not meta.get("reset") and prev_e and _plain(prev_e) == _plain(s.e):
            s.e = prev_e
            s.e_before = dict(prev_e)
            es = getattr(prev_data, "esample", None)
            if es is not None and len(es) == s.data.nobs:
                s.data.esample = es.copy()
    s.log = []
    s.graphs = []
    error = None
    try:
        s.interp.run_lines(split_commands(meta["code"]), echo=bool(meta.get("echo", False)))
    except StataError as e:
        s.report_error(e)
        error = {"code": e.rc, "message": e.message}
    except Exception as e:  # an engine fault becomes a Stata-style error
        error = {"code": 3000, "message": "OpenDTA internal error: " + type(e).__name__ + ": " + str(e)}
    out = _state(s)
    out["ematrix"] = _ematrix(s)
    out["graphs"] = list(s.graphs)
    out["log"] = "".join(s.log)
    out["error"] = error
    return out


def run_json(meta_json, columns, host=None, evaluate=None):
    cols = [c.to_py() if hasattr(c, "to_py") else c for c in columns]
    meta = json.loads(meta_json)
    if meta.get("kind") == "command":
        return json.dumps(run_command(meta, cols))
    return json.dumps(run(meta, cols, host, evaluate))
