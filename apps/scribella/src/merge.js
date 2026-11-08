// Three-way merge by lines: changes from both sides apply when they touch different lines, and where they collide the
// result holds both, between conflict markers, so nothing is lost.
import { diffLists } from './changes.js';

function hunks(base, side) {
  const out = [];
  let at = 0, open = null;
  for (const [kind, line] of diffLists(base, side)) {
    if (kind === '=') { if (open) { out.push(open); open = null; } at += 1; continue; }
    open ||= { from:at, to:at, lines:[] };
    if (kind === '-') { at += 1; open.to = at; } else open.lines.push(line);
  }
  if (open) out.push(open);
  return out;
}

const same = (a, b) => a.from === b.from && a.to === b.to && a.lines.join('\n') === b.lines.join('\n');

export function merge3(baseText, mineText, theirsText, theirLabel = 'outside') {
  const base = baseText.split('\n'), mine = hunks(base, mineText.split('\n')), theirs = hunks(base, theirsText.split('\n'));
  const all = [...mine.map(hunk => ({ ...hunk, side:'mine' })), ...theirs.map(hunk => ({ ...hunk, side:'theirs' }))].sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [];
  let at = 0, conflicts = 0;
  for (let index = 0; index < all.length;) {
    const group = [all[index]];
    let end = all[index].to;
    for (index += 1; index < all.length && (all[index].from < end || (all[index].from === end && all[index].from === group[0].from)); index += 1) { group.push(all[index]); end = Math.max(end, all[index].to); }
    const start = group[0].from;
    out.push(...base.slice(at, start));
    const sides = new Set(group.map(hunk => hunk.side));
    if (sides.size === 1 || (group.length === 2 && same(group[0], group[1]))) {
      // One side alone, or both made the same change: apply each hunk over the base range.
      let cursor = start;
      for (const hunk of sides.size === 1 ? group : [group[0]]) { out.push(...base.slice(cursor, hunk.from), ...hunk.lines); cursor = hunk.to; }
      out.push(...base.slice(cursor, end));
    } else {
      const text = side => {
        let cursor = start;
        const lines = [];
        for (const hunk of group.filter(item => item.side === side)) { lines.push(...base.slice(cursor, hunk.from), ...hunk.lines); cursor = hunk.to; }
        return [...lines, ...base.slice(cursor, end)];
      };
      conflicts += 1;
      out.push('<<<<<<< yours', ...text('mine'), '=======', ...text('theirs'), `>>>>>>> ${theirLabel}`);
    }
    at = end;
  }
  out.push(...base.slice(at));
  return { text:out.join('\n'), conflicts };
}
