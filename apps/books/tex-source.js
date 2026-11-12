// Unpacks a LaTeX source (an arXiv .tar.gz, a plain .tar, a gzipped .tex or one .tex) and picks what to compile.
// The compile itself is the host's: naklios.experimental_tex.
export const TEX_SOURCE_MAX_FILES = 5000;
export const TEX_SOURCE_MAX_BYTES = 256 * 1024 * 1024; // the host's project limit

const ARXIV_NEW_ID = /^\d{4}\.\d{4,5}(v\d+)?$/;
const ARXIV_OLD_ID = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/;
const TAR_BLOCK = 512;

// Accepts a bare ID, an arXiv: prefix, or an abs, pdf, src or e-print URL.
export function parseArxivId(input) {
  const id = String(input || '').trim()
    .replace(/^https?:\/\/(www\.)?(export\.)?arxiv\.org\/(abs|pdf|src|e-print)\//i, '')
    .replace(/^arxiv:/i, '')
    .replace(/\.pdf$/i, '')
    .replace(/\/$/, '');
  return ARXIV_NEW_ID.test(id) || ARXIV_OLD_ID.test(id) ? id : null;
}

export function arxivSourceUrl(id) {
  return 'https://arxiv.org/src/' + id;
}

function isGzip(bytes) {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isPdf(bytes) {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

async function gunzip(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > TEX_SOURCE_MAX_BYTES) {
      await reader.cancel();
      throw new Error('This source unpacks to more than 256 MB.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function tarText(bytes, start, length) {
  const end = bytes.subarray(start, start + length).indexOf(0);
  return new TextDecoder().decode(bytes.subarray(start, end < 0 ? start + length : start + end));
}

function tarHeaderIsValid(bytes, start) {
  if (bytes.length < start + TAR_BLOCK) return false;
  const stored = parseInt(tarText(bytes, start + 148, 8).trim(), 8);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 32 : bytes[start + i];
  }
  return stored === sum;
}

// Keeps project-relative paths only: an entry that climbs out of the project is dropped, not repaired.
function safeSourcePath(value) {
  const segs = String(value).replace(/\\/g, '/').split('/').filter(seg => seg && seg !== '.');
  if (!segs.length || String(value).startsWith('/') || segs.includes('..')) return null;
  if (segs.some(seg => seg.startsWith('.'))) return null; // the host does not send dotfiles to TeX
  return segs.join('/');
}

function readTar(bytes) {
  const files = [];
  let offset = 0;
  let longName = null;
  let total = 0;
  while (offset + TAR_BLOCK <= bytes.length && bytes[offset] !== 0) {
    if (!tarHeaderIsValid(bytes, offset)) throw new Error('This archive is damaged.');
    const size = parseInt(tarText(bytes, offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(bytes[offset + 156] || 48);
    const prefix = tarText(bytes, offset + 345, 155);
    const start = offset + TAR_BLOCK;
    if (type === 'L') {
      longName = tarText(bytes, start, size);
    } else {
      if (type === '0' || type === '7') {
        const name = longName || tarText(bytes, offset, 100);
        const path = safeSourcePath(!longName && prefix ? prefix + '/' + name : name);
        if (path) {
          total += size;
          if (files.length >= TEX_SOURCE_MAX_FILES) throw new Error('This source has more than 5,000 files.');
          if (total > TEX_SOURCE_MAX_BYTES) throw new Error('This source unpacks to more than 256 MB.');
          files.push({ path, bytes:bytes.slice(start, start + size) });
        }
      }
      longName = null;
    }
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return files;
}

export async function unpackTexSource(input, name = 'main.tex') {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isPdf(bytes)) throw new Error('This is a PDF, with no LaTeX source to compile. Add it as a book instead.');
  if (isGzip(bytes)) bytes = await gunzip(bytes);
  if (tarHeaderIsValid(bytes, 0)) return readTar(bytes);
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, 65536));
  if (!/\\(documentclass|documentstyle|begin|input|section)\b/.test(text)) {
    throw new Error('Choose a .tar.gz, .tar, .gz or .tex source.');
  }
  const single = /\.(tex|ltx)$/i.test(name) ? safeSourcePath(name.replace(/^.*[\\/]/, '')) : null;
  return [{ path:single || 'main.tex', bytes }];
}

function texBody(file) {
  return new TextDecoder('latin1').decode(file.bytes)
    .split('\n')
    .map(line => line.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n');
}

const MAIN_NAMES = /^(main|ms|paper|article|manuscript)\.(tex|ltx)$/i;

// The files that can be compiled, the likeliest first: a whole document, not a figure, near the top of the project.
export function texMainCandidates(files) {
  return files
    .filter(file => /\.(tex|ltx)$/i.test(file.path))
    .map(file => ({ file, body:texBody(file) }))
    .filter(({ body }) => /\\(documentclass|documentstyle)\b/.test(body) && /\\begin\s*\{document\}/.test(body))
    .filter(({ body }) => !/\\documentclass(\[[^\]]*\])?\s*\{standalone\}/.test(body))
    .map(({ file, body }) => ({
      path:file.path,
      engine:texEngineFor(body),
      depth:file.path.split('/').length,
      named:MAIN_NAMES.test(file.path.replace(/^.*\//, '')) ? 0 : 1,
      size:file.bytes.byteLength,
    }))
    .sort((a, b) => a.depth - b.depth || a.named - b.named || b.size - a.size)
    .map(({ path, engine }) => ({ path, engine }));
}

export function texEngineFor(body) {
  if (/\\usepackage(\[[^\]]*\])?\s*\{[^}]*\b(luacode|luatextra)\b/.test(body)) return 'lualatex';
  if (/\\usepackage(\[[^\]]*\])?\s*\{[^}]*\b(fontspec|xeCJK|polyglossia|unicode-math)\b/.test(body)) return 'xelatex';
  return 'pdflatex';
}

export function texProjectName(name) {
  const stem = String(name).replace(/^.*[\\/]/, '').replace(/\.(tar\.gz|tgz|tar|gz|tex|ltx)$/i, '');
  return stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'paper';
}
