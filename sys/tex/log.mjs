// Reads a TeX log into diagnostics, and rewrites SyncTeX paths from the engine's folder to the project's.
const PROJECT_DIR = '/home/web_user/project_dir/';
const FILE_OR_PAREN = /\(([^\s()]+\.[A-Za-z0-9]+)|[()]/g;
const MAX_DIAGNOSTICS = 200;

const projectPath = file => file.replace(PROJECT_DIR, '').replace(/^(\.\/)+/, '');
const isProjectFile = file => !file.startsWith('/');

function missingFile(text) {
  return /^! LaTeX Error: File `([^']+)' not found/.exec(text)?.[1] ||
    /^! I can't find file `([^']+)'/.exec(text)?.[1] || null;
}

// TeX breaks log lines at 79 columns, which can split a file name and lose track of the open file. Only a line ending
// inside a file name is rejoined, so a full-width line of another kind never swallows the error after it.
function rejoinLines(lines) {
  const out = [];
  for (const line of lines) {
    const last = out.at(-1) ?? '';
    if (last.length && last.length % 79 === 0 && /\([^\s()]+$/.test(last) && !line.startsWith('!')) out[out.length - 1] += line;
    else out.push(line);
  }
  return out;
}

// `stack` holds each open file (or null for a plain parenthesis), so an error belongs to the innermost file.
export function parseTexLog(log, main) {
  const diagnostics = [], stack = [], lines = rejoinLines(String(log || '').split(/\r?\n/));
  const where = () => {
    const open = stack.filter(Boolean);
    const inner = open.at(-1);
    if (inner === undefined || isProjectFile(inner)) return { file:inner ?? main, inProject:true };
    return { file:open.findLast(isProjectFile) ?? main, inProject:false };
  };
  for (let i = 0; i < lines.length && diagnostics.length < MAX_DIAGNOSTICS; i += 1) {
    const text = lines[i];
    if (text.startsWith('! ')) {
      const { file, inProject } = where();
      const at = lines.slice(i + 1, i + 30).map(line => /^l\.(\d+)/.exec(line)).find(Boolean);
      const missing = missingFile(text);
      diagnostics.push(missing
        ? { severity:'error', kind:'missing-file', name:missing, file, line:at && inProject ? Number(at[1]) : null,
            message:`${missing} is not in your project or the TeX packs. Add the file to your project folder.` }
        : { severity:'error', kind:'tex', file, line:at && inProject ? Number(at[1]) : null, message:text.slice(2).trim() });
    } else {
      const warning = /^(?:LaTeX|Package \S+|Class \S+) Warning: (.*)$/.exec(text);
      if (warning) {
        const message = /[.!]$/.test(warning[1]) ? warning[1] : `${warning[1]} ${(lines[i + 1] || '').trim()}`;
        const { file, inProject } = where();
        const line = /on input line (\d+)/.exec(message)?.[1];
        diagnostics.push({ severity:'warning', kind:'tex', file, line:line && inProject ? Number(line) : null, message:message.trim() });
      }
    }
    for (const token of text.matchAll(FILE_OR_PAREN)) {
      if (token[0] === ')') stack.pop();
      else stack.push(token[1] ? projectPath(token[1]) : null);
    }
  }
  return diagnostics;
}

async function pipeBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// SyncTeX names each input as `Input:<n>:<path>`. Project files become paths relative to the project folder.
export async function mapSynctex(gzipped) {
  const text = new TextDecoder().decode(await pipeBytes(gzipped, new DecompressionStream('gzip')));
  const mapped = text.replace(/^(Input:\d+:)(.*)$/gm, (_, label, path) => label + projectPath(path));
  return pipeBytes(new TextEncoder().encode(mapped), new CompressionStream('gzip'));
}
