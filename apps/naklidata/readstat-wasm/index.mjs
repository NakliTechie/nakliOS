// readstat-wasm: read SPSS, Stata and SAS data files in the browser or Node.
// ReadStat (https://github.com/WizardMac/ReadStat) compiled to WebAssembly,
// with a small C wrapper (src/rs_wrapper.c) that returns each file as NDJSON.

import createReadStat from './readstat.mjs';

/** Integer codes that the C wrapper's rs_read switches on. */
const FORMAT_CODE = { dta: 0, sav: 1, por: 2, sas7bdat: 3, xpt: 4 };

/** File extension to format, for readStatFile(bytes, name). */
const EXTENSION = { dta: 'dta', sav: 'sav', zsav: 'sav', por: 'por', sas7bdat: 'sas7bdat', xpt: 'xpt' };

// WebAssembly is 32-bit here: the heap cannot hold an input of 2 GiB or more.
const MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1;

let defaultModule = null;

async function wasmBytes(source) {
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) return source;
  const url = source instanceof URL ? source : new URL(String(source), import.meta.url);
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return readFile(url);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`readstat-wasm: could not fetch ${url.href} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Instantiate the module. `wasm` is the readstat.wasm bytes, or a URL to them;
 * by default the copy next to this file. Call it once and reuse the result.
 */
export async function loadReadStat({ wasm } = {}) {
  const bytes = await wasmBytes(wasm ?? new URL('./readstat.wasm', import.meta.url));
  return createReadStat({
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(bytes, imports).then((r) => done(r.instance, r.module));
      return {};
    },
  });
}

/** Map a file name or extension to a format, or null when it is not one ReadStat reads. */
export function formatFor(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  return EXTENSION[ext] ?? null;
}

function countLines(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n;
}

/**
 * Parse one file. `format` is 'dta' | 'sav' | 'por' | 'sas7bdat' | 'xpt', or a
 * file name to take the format from. Returns { ndjson, rowCount, columns, meta }.
 */
export async function readStat(bytes, format, { module } = {}) {
  const fmt = FORMAT_CODE[format] !== undefined ? format : formatFor(format);
  if (fmt === null) throw new Error(`readstat-wasm: unknown format "${format}"`);
  if (bytes.length > MAX_BYTES) throw new Error('readstat-wasm: input is 2 GB or larger');
  if (!module) {
    defaultModule ??= loadReadStat().catch((err) => {
      defaultModule = null;
      throw err;
    });
  }
  const mod = module ?? (await defaultModule);

  const ptr = mod._malloc(bytes.length);
  if (ptr === 0) throw new Error(`readstat-wasm: out of memory for a ${bytes.length}-byte file`);
  let rc;
  try {
    mod.HEAPU8.set(bytes, ptr);
    rc = mod.ccall('rs_read', 'number', ['number', 'number', 'number'], [ptr, bytes.length, FORMAT_CODE[fmt]]);
  } finally {
    mod._free(ptr);
  }
  if (rc !== 0) {
    const msg = rc === -2 ? 'ran out of memory building the output' : mod.ccall('rs_errmsg', 'string', ['number'], [rc]);
    mod.ccall('rs_free', null, [], []);
    throw new Error(`readstat-wasm: could not read ${fmt} file: ${msg}`);
  }
  const columns = JSON.parse(mod.ccall('rs_columns', 'string', [], []));
  const meta = JSON.parse(mod.ccall('rs_meta', 'string', [], []));
  const at = mod.ccall('rs_ndjson', 'number', [], []);
  const len = mod.ccall('rs_ndjson_len', 'number', [], []);
  const ndjson = mod.HEAPU8.slice(at, at + len);
  const rows = mod.ccall('rs_rowcount', 'number', [], []);
  mod.ccall('rs_free', null, [], []);
  return { ndjson, rowCount: rows >= 0 ? rows : countLines(ndjson), columns, meta };
}

/** Parse one file and return its rows as objects. Convenient for small files. */
export async function readStatRows(bytes, format, options) {
  const t = await readStat(bytes, format, options);
  const text = new TextDecoder().decode(t.ndjson);
  const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { rows, columns: t.columns, meta: t.meta };
}
