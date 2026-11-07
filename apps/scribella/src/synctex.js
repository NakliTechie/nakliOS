// Reads a .synctex file and answers both questions: where in the PDF is this source line, and which source line made
// this point of the PDF. Positions are PDF points from the top left of the page.
const SP_PER_BP = 65781.76;
const MAX_LINE = 30;
const MAX_WIDTH = 480;
const TEXT_HEIGHT = 9;
const TEXT_BAND = 10;

const number = (text, previous) => (text === '=' ? previous : Number(text));

export function parseSynctex(text) {
  const inputs = new Map(), pages = new Map();
  let unit = 1, xOffset = 0, yOffset = 0, magnification = 1000, page = null, lastH = 0, lastV = 0;
  const toPoints = value => (value * unit * magnification) / 1000 / SP_PER_BP;
  for (const line of text.split('\n')) {
    const input = /^Input:(\d+):(.*)$/.exec(line);
    if (input) { inputs.set(Number(input[1]), input[2]); continue; }
    const setting = /^(Unit|X Offset|Y Offset|Magnification):(-?\d+(?:\.\d+)?)/.exec(line);
    if (setting && page === null) {
      const value = Number(setting[2]);
      if (setting[1] === 'Unit') unit = value;
      else if (setting[1] === 'X Offset') xOffset = value;
      else if (setting[1] === 'Y Offset') yOffset = value;
      else magnification = value;
      continue;
    }
    if (line[0] === '{') { page = Number(line.slice(1)); pages.set(page, []); continue; }
    if (line[0] === '}') { page = null; continue; }
    if (page === null) continue;
    const record = /^([[(hxkg$v])(\d+),(\d+)(?:,\d+)?:(-?\d+|=),(-?\d+|=)(?::(-?\d+|=)(?:,(-?\d+|=),(-?\d+|=))?)?/.exec(line);
    if (!record) continue;
    const [, kind, tag, source, h, v, width, height, depth] = record;
    lastH = number(h, lastH);
    lastV = number(v, lastV);
    pages.get(page).push({
      kind, tag:Number(tag), line:Number(source),
      x:toPoints(lastH + xOffset), y:toPoints(lastV + yOffset),
      width:toPoints(Number(width) || 0), height:toPoints(Number(height) || 0), depth:toPoints(Number(depth) || 0),
    });
  }
  return { inputs, pages };
}

export async function readSynctex(gzipped) {
  const stream = new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip'));
  return parseSynctex(await new Response(stream).text());
}

const samePath = (input, file) => input === file || input.replace(/^\.\//, '') === file;

// The nearest line at or before `line` with output, on the page where it first appears.
export function forward(sync, file, line) {
  const tags = [...sync.inputs].filter(([, path]) => samePath(path, file)).map(([tag]) => tag);
  let best = null;
  for (const [page, records] of sync.pages) {
    for (const record of records) {
      if (!tags.includes(record.tag) || record.line > line) continue;
      if (!best || record.line > best.line) best = { ...record, page };
    }
  }
  if (!best) return null;
  const all = sync.pages.get(best.page).filter(record => tags.includes(record.tag) && record.line === best.line);
  // A box around a scaled figure can start far off the line, so text records win when there are any.
  const text = all.filter(record => 'hxkg$'.includes(record.kind) && record.height <= MAX_LINE);
  const onLine = text.length ? text : all;
  const left = Math.min(...onLine.map(record => record.x));
  const top = Math.max(0, Math.min(...onLine.map(record => record.y - Math.min(Math.max(record.height, TEXT_HEIGHT), MAX_LINE))));
  const bottom = Math.max(...onLine.map(record => record.y + Math.min(record.depth, MAX_LINE)));
  const right = Math.max(left, ...onLine.map(record => record.x + record.width));
  return { page:best.page, file, line:best.line, x:left, y:top, width:Math.min(right - left, MAX_WIDTH), height:Math.min(Math.max(bottom - top, 10), MAX_LINE * 2) };
}

// The smallest box around the point, else the nearest record on the page. Generated files such as the .bbl are skipped.
export function inverse(sync, page, x, y, files = null) {
  const known = record => {
    const path = (sync.inputs.get(record.tag) || '/').replace(/^\.\//, '');
    return !path.startsWith('/') && (!files || files.has(path));
  };
  const records = (sync.pages.get(page) || []).filter(record => known(record) && record.line > 0);
  if (!records.length) return null;
  // Text records carry the line a word was typed on; a paragraph's boxes carry the line it ended on.
  const words = records.filter(record => 'xkg$'.includes(record.kind) && Math.abs(record.y - y) <= TEXT_BAND);
  if (words.length) {
    const near = words.reduce((best, record) => (Math.abs(record.x - x) < Math.abs(best.x - x) ? record : best));
    return { file:sync.inputs.get(near.tag).replace(/^\.\//, ''), line:near.line };
  }
  const inside = records.filter(record => record.width > 0 && x >= record.x && x <= record.x + record.width && y >= record.y - record.height && y <= record.y + record.depth)
    .sort((a, b) => a.width * (a.height + a.depth) - b.width * (b.height + b.depth));
  const pick = inside.find(record => record.kind === 'h' || record.kind === '(') || inside[0]
    || records.reduce((best, record) => {
      const distance = Math.hypot(Math.max(record.x - x, 0, x - record.x - record.width), record.y - y);
      return !best || distance < best.distance ? { record, distance } : best;
    }, null).record;
  return { file:sync.inputs.get(pick.tag).replace(/^\.\//, ''), line:pick.line };
}
