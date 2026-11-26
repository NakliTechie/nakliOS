/** Formats ReadStat reads. `sav` covers compressed `.zsav` too. */
export type StatFormat = 'dta' | 'sav' | 'por' | 'sas7bdat' | 'xpt';

/** A variable's display format (for example `%tm` or `F8.2`) and label, as stored in the file. */
export interface StatColumnMeta {
  format: string;
  label: string;
}

/** One parsed file. */
export interface StatTable {
  /** Rows as newline-delimited JSON, one object per row keyed by variable name. */
  ndjson: Uint8Array;
  rowCount: number;
  /** Variable names in file order. */
  columns: string[];
  /** Per variable, in file order. */
  meta: StatColumnMeta[];
}

/** The instantiated WebAssembly module. */
export interface ReadStatModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  ccall(name: string, returnType: 'number' | 'string' | null, argTypes: string[], args: unknown[]): unknown;
}

/** Instantiate the module from bytes or a URL; by default the readstat.wasm next to index.mjs. */
export function loadReadStat(options?: { wasm?: Uint8Array | ArrayBuffer | URL | string }): Promise<ReadStatModule>;

/** Map a file name or extension to a format, or null. */
export function formatFor(name: string): StatFormat | null;

/** Parse one file. `format` may also be a file name. */
export function readStat(
  bytes: Uint8Array,
  format: StatFormat | string,
  options?: { module?: ReadStatModule },
): Promise<StatTable>;

/** Parse one file into row objects. */
export function readStatRows(
  bytes: Uint8Array,
  format: StatFormat | string,
  options?: { module?: ReadStatModule },
): Promise<{ rows: Record<string, unknown>[]; columns: string[]; meta: StatColumnMeta[] }>;
