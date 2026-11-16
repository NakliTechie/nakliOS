/* Page-shell logic with no DOM (index.html uses it; test/registry.test.mjs checks it in Node).
 * Batch 6 promo-capture defects 2, 3, 6 and 7 (docs/build/reel-v1-contract.md, "Batch 6"). */

/* Defect 2: the subtitle chip names every codec, counting repeats: "SRT · ASS · PGS", "SRT ×2 · PGS". */
export function subtitleSummary(tracks) {
  const counts = new Map();
  for (const track of tracks || []) {
    const codec = String(track?.codec || 'text').toUpperCase();
    counts.set(codec, (counts.get(codec) || 0) + 1);
  }
  return [...counts].map(([codec, count]) => (count > 1 ? `${codec} ×${count}` : codec)).join(' · ');
}

/* Defect 3: which decoder a track uses, as a string key under honesty.*.
 * Video: libav for tracks the libav backend demuxes, else WebCodecs (Reel has no other video path).
 * Audio: the route the engine reported (playback:audio-route); before that only a libav track is
 * known, so every other track reads "pending" until playback picks its route. */
export function decoderKey(track, route = null) {
  if (!track) return null;
  if (track.type === 'video') return track.backend === 'libav' ? 'honesty.libav' : 'honesty.webCodecs';
  if (route === 'software') return 'honesty.software';
  if (route === 'libav') return 'honesty.libav';
  if (route === 'webcodecs') return 'honesty.webCodecs';
  return track.backend === 'libav' ? 'honesty.libav' : 'honesty.pending';
}

/* Defect 7: a film counts as finished in its last 5 s or its last 5%, whichever starts first.
 * Very short clips use the 95% mark alone (never less than half the film), so a 6 s clip is not
 * "finished" at 1 s. */
export function finishedAtS(durationS) {
  const duration = Number(durationS);
  if (!(duration > 0)) return Infinity;
  return Math.max(duration * 0.5, Math.min(duration - 5, duration * 0.95));
}
/* The resume entry for a finished film (spec row L4): kept, at 0, marked finished. A later normal
 * save, which carries no `finished`, clears the mark. */
export function markFinished(entry, now = Date.now()) {
  return { ...entry, positionS: 0, finished: true, updatedAt: now };
}
export function isFinished(positionS, durationS) {
  const position = Number(positionS);
  return Number.isFinite(position) && position >= finishedAtS(durationS);
}

/* Defect 6: "9 s left" under a minute, "3 min left" from a minute up; null when the length is unknown. */
export function timeLeft(positionS, durationS) {
  const duration = Number(durationS);
  if (!(duration > 0)) return null;
  const leftS = Math.max(0, duration - Math.max(0, Number(positionS) || 0));
  if (leftS < 59.5) return { key: 'recent.secondsLeft', seconds: Math.max(1, Math.round(leftS)) };
  return { key: 'recent.minutesLeft', minutes: Math.round(leftS / 60) };
}
