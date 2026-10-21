// ipSAE: a score for how well a structure prediction believes two chains touch.
//
// Dunbrack lab, 2025. Reference implementation: https://github.com/DunbrackLab/IPSAE
//
// The input is a predicted aligned error matrix. A structure predictor such as AlphaFold2 or
// AlphaFold3 produces one alongside the coordinates: `pae[i][j]` is how far off, in angstroms, it
// expects residue j to be when the structure is aligned on residue i. Low numbers across a chain
// boundary mean the predictor is confident about how the two chains sit relative to each other.
//
// ipSAE takes the pTM transform of those errors, but only over residue pairs that cross the
// interface and only where the error is below a cutoff, so a large well-predicted chain cannot
// drown out a small contact the way whole-complex ipTM does.
//
// This file is the arithmetic only. It needs no coordinates, no structure file and no network:
// a matrix and one chain label per row. Reading those out of a predictor's output files belongs
// with the compute bridge, because the file layout depends on which predictor produced them.
//
// Checked against ipsae.py (DunbrackLab/IPSAE) on its AURKA/TPX2 AlphaFold3 example at a PAE
// cutoff of 10. Both directions match to the 6 decimal places the reference prints: ipSAE,
// ipSAE_d0chn, ipSAE_d0dom and ipTM_d0chn, along with every count and every d0.
//
// One trap, if you build a test matrix from an AlphaFold3 JSON yourself. AlphaFold3 gives most
// residues one entry in the matrix, but gives a modified or non-standard residue one entry per
// atom. In that example, residues 160 and 161 of chain A have eleven entries each. The entry to
// use is the one for the CA atom; taking the first entry instead moved the score by 3e-5, which
// is small enough to look like rounding and is not.
//
// One known labelling difference: the reference's combined row reports its two residue-count
// columns per chain, while `scoreInterfaces` reports them per role. Same numbers, different
// headings.

/** The pTM transform: an error of d0 scores 0.5, smaller errors approach 1. */
function ptm(error, d0) {
  const r = error / d0;
  return 1 / (1 + r * r);
}

/**
 * d0 from a residue count, after Yang and Skolnick (2004). Short chains are pinned to 1.0, which
 * is what keeps the transform from going negative on tiny interfaces.
 */
export function calcD0(length) {
  const l = Math.max(26, Number(length));
  return Math.max(1, 1.24 * Math.cbrt(l - 15) - 1.8);
}

function mean(values) {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

/**
 * Score one ordered chain pair. Asymmetric by design: aligning on the big chain and scoring the
 * small one is a different question from the reverse, and the two answers often differ a lot.
 */
function scorePair(pae, rows, cols, paeCutoff) {
  const n0chn = rows.length + cols.length;
  const d0chn = calcD0(n0chn);

  // For each residue of chain 1, which residues of chain 2 it is confident about.
  const valid = rows.map((i) => cols.filter((j) => pae[i][j] < paeCutoff));

  const partners = new Set();
  let anchors = 0;
  for (let r = 0; r < rows.length; r++) {
    if (valid[r].length > 0) {
      anchors++;
      for (const j of valid[r]) partners.add(j);
    }
  }

  const n0dom = anchors + partners.size;
  const d0dom = calcD0(n0dom);

  const iptmD0chn = rows.map((i) => mean(cols.map((j) => ptm(pae[i][j], d0chn))));
  const ipsaeD0chn = rows.map((i, r) => mean(valid[r].map((j) => ptm(pae[i][j], d0chn))));
  const ipsaeD0dom = rows.map((i, r) => mean(valid[r].map((j) => ptm(pae[i][j], d0dom))));

  // The headline figure: d0 is set per residue, from how many partners that one residue is
  // confident about. A residue with few good partners is judged on a tighter scale.
  const n0res = valid.map((v) => v.length);
  const d0res = n0res.map(calcD0);
  const ipsae = rows.map((i, r) => mean(valid[r].map((j) => ptm(pae[i][j], d0res[r]))));

  const best = argmax(ipsae);

  return {
    ipsae: ipsae[best],
    ipsaeD0chn: ipsaeD0chn[argmax(ipsaeD0chn)],
    ipsaeD0dom: ipsaeD0dom[argmax(ipsaeD0dom)],
    iptmD0chn: iptmD0chn[argmax(iptmD0chn)],
    n0res: n0res[best],
    d0res: d0res[best],
    n0chn,
    d0chn,
    n0dom,
    d0dom,
    nres1: anchors,
    nres2: partners.size,
  };
}

/**
 * Score every chain pair in a prediction.
 *
 * @param {number[][]} pae square matrix, angstroms
 * @param {ArrayLike<string>} chainIds one chain label per row of `pae`
 * @param {{paeCutoff?: number}} options
 * @returns {Array<object>} one row per ordered pair, plus a 'max' row per unordered pair
 */
export function scoreInterfaces(pae, chainIds, { paeCutoff = 10 } = {}) {
  const n = pae.length;
  if (chainIds.length !== n) {
    throw new Error(`Got ${n} matrix rows but ${chainIds.length} chain labels; they have to match.`);
  }

  const byChain = new Map();
  for (let i = 0; i < n; i++) {
    const c = chainIds[i];
    if (!byChain.has(c)) byChain.set(c, []);
    byChain.get(c).push(i);
  }

  const names = [...byChain.keys()].sort();
  const asym = new Map();
  const out = [];

  for (const c1 of names) {
    for (const c2 of names) {
      if (c1 === c2) continue;
      const row = scorePair(pae, byChain.get(c1), byChain.get(c2), paeCutoff);
      asym.set(`${c1}\u0000${c2}`, row);
      out.push({ chain1: c1, chain2: c2, type: 'asym', paeCutoff, ...row });
    }
  }

  // One summary row per unordered pair: the better of the two directions, metric by metric.
  for (let a = 0; a < names.length; a++) {
    for (let b = a + 1; b < names.length; b++) {
      const forward = asym.get(`${names[a]}\u0000${names[b]}`);
      const reverse = asym.get(`${names[b]}\u0000${names[a]}`);
      if (!forward || !reverse) continue;

      const winner = forward.ipsae >= reverse.ipsae ? forward : reverse;
      out.push({
        chain1: names[a],
        chain2: names[b],
        type: 'max',
        paeCutoff,
        ipsae: winner.ipsae,
        ipsaeD0chn: Math.max(forward.ipsaeD0chn, reverse.ipsaeD0chn),
        ipsaeD0dom: Math.max(forward.ipsaeD0dom, reverse.ipsaeD0dom),
        iptmD0chn: Math.max(forward.iptmD0chn, reverse.iptmD0chn),
        // These describe the direction that won, so they are carried over rather than maxed.
        n0res: winner.n0res,
        d0res: winner.d0res,
        n0chn: winner.n0chn,
        d0chn: winner.d0chn,
        n0dom: winner.n0dom,
        d0dom: winner.d0dom,
        nres1: Math.max(forward.nres1, reverse.nres1),
        nres2: Math.max(forward.nres2, reverse.nres2),
      });
    }
  }

  return out;
}
