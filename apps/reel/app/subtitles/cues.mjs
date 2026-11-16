/* Cue lookup by time. Pure. Cues are sorted by start; maxEnd[i] is the largest end time among
 * cues 0..i, so a backward walk from the last started cue stops as soon as nothing earlier can
 * still be showing. Finding the start point is a binary search. */

export class CueIndex {
  constructor(cues) {
    this.cues = [...cues].sort((a, b) => a.startS - b.startS);
    this.maxEnd = new Float64Array(this.cues.length);
    let max = -Infinity;
    this.cues.forEach((cue, i) => { max = Math.max(max, cue.endS); this.maxEnd[i] = max; });
  }

  get length() { return this.cues.length; }

  /* Index of the last cue with startS <= t, or -1. */
  lastStartedAt(t) {
    let lo = 0;
    let hi = this.cues.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].startS <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found;
  }

  /* Indices of the cues showing at time t (start inclusive, end exclusive), in start order. */
  activeAt(t) {
    const out = [];
    for (let i = this.lastStartedAt(t); i >= 0 && this.maxEnd[i] > t; i -= 1) {
      if (this.cues[i].endS > t) out.push(i);
    }
    return out.reverse();
  }
}
