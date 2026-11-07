// What TeX numbered: reads \newlabel lines from the .aux, and the warnings and errors from the bibliography log.
export function parseLabels(aux) {
  const labels = new Map();
  for (const [, key, number, page] of (aux || '').matchAll(/\\newlabel\{([^}]+)\}\{\{([^}]*)\}\{([^}]*)\}/g)) labels.set(key, { number, page });
  return labels;
}

export function parseBlg(blg) {
  const found = [];
  for (const line of (blg || '').split('\n')) {
    const warning = /^Warning--(.+)$/.exec(line.trim());
    if (warning) found.push({ severity:'warning', kind:'bib', message:warning[1] });
    else if (/^(Repeated entry|This database file appears|You're missing|I couldn't open database file|I was expecting)/.test(line.trim())) found.push({ severity:'error', kind:'bib', message:line.trim() });
  }
  return found;
}
