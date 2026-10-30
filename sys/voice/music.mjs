// music.mjs — the voice assistant plays the person's own music files from the connected Folder or Crate.
// Music is about a tenth of what people ask voice assistants (research note, 2026-10-30); NakliAmp plays only from a
// folder picked in its own window, so the assistant keeps a small player of its own and can still open NakliAmp.
//
// files   — { list(prefix) → paths (directories end with '/'), read(path) → Uint8Array } on the connected store, or null
// makeAudio — () → an HTMLAudioElement (a stand-in in tests)

export const AUDIO_EXT = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav)$/i;
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav' };
const LIMIT = 3000, DEPTH = 6;
const words = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
export const trackName = (path) => path.split('/').pop().replace(AUDIO_EXT, '').replace(/[_]+/g, ' ').trim();

// Tracks whose path holds every word of the query (artist folder, album folder, file name); no query → every track.
export function matchTracks(paths, query) {
  const q = words(query || '').filter((w) => !['play', 'some', 'song', 'songs', 'music', 'by', 'the', 'a', 'me', 'my'].includes(w));
  if (!q.length) return paths;
  return paths.filter((p) => { const w = new Set(words(p)); return q.every((x) => w.has(x) || [...w].some((y) => y.startsWith(x) && x.length >= 4)); });
}

export function createMusic({ files = () => null, makeAudio = () => new Audio(), shuffle = (a) => a.sort(() => Math.random() - 0.5) } = {}) {
  let index = null, queue = [], at = -1, audio = null, url = null, volume = 0.8, ducked = false;
  async function scan() {
    const fs = files();
    if (!fs) throw new Error('connect a Folder or Crate with your music in Settings → Storage, or open NakliAmp');
    const out = [];
    async function walk(prefix, depth) {
      if (depth > DEPTH || out.length >= LIMIT) return;
      let entries = [];
      try { entries = await fs.list(prefix); } catch (_) { return; }
      for (const e of entries) {
        if (out.length >= LIMIT) return;
        const name = e.split('/').filter(Boolean).pop() || '';
        if (name.startsWith('.') || /^(apps|skills|assistant|node_modules)$/.test(name)) continue;
        if (e.endsWith('/')) await walk(e.replace(/\/$/, ''), depth + 1);
        else if (AUDIO_EXT.test(e)) out.push(e);
      }
    }
    await walk('', 0);
    index = out.sort();
    return index;
  }
  async function start(i) {
    const fs = files();
    at = i;
    const path = queue[at];
    const bytes = await fs.read(path);
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([bytes], { type: MIME[path.split('.').pop().toLowerCase()] || 'audio/mpeg' }));
    if (!audio) { audio = makeAudio(); audio.onended = () => { if (at + 1 < queue.length) start(at + 1).catch(() => {}); }; }
    audio.src = url;
    audio.volume = ducked ? volume * 0.2 : volume;
    await audio.play();
    return { playing: trackName(path), from: path, queued: queue.length - at - 1 };
  }
  const playing = () => !!audio && !audio.paused && !audio.ended;
  return {
    get playing() { return playing(); },
    async play(query = '') {
      const all = index || (await scan());
      if (!all.length) throw new Error('no music files (mp3, m4a, flac, ogg, opus, wav) were found in the connected storage');
      const hits = matchTracks(all, query);
      if (!hits.length) throw new Error(`no music matches "${query}"`);
      queue = query ? hits : shuffle([...hits]);
      return start(0);
    },
    async next() { if (at + 1 >= queue.length) throw new Error('nothing queued after this track'); return start(at + 1); },
    pause() { if (!audio) throw new Error('no music is playing'); audio.pause(); return { paused: trackName(queue[at]) }; },
    async resume() { if (!audio) throw new Error('no music to resume'); await audio.play(); return { resumed: trackName(queue[at]) }; },
    stop() { if (audio) { audio.pause(); audio.removeAttribute?.('src'); } if (url) { URL.revokeObjectURL(url); url = null; } queue = []; at = -1; return { stopped: true }; },
    setVolume({ level, change } = {}) {
      if (level != null) volume = Math.min(1, Math.max(0, Number(level) / 100));
      else if (change === 'up') volume = Math.min(1, volume + 0.15);
      else if (change === 'down') volume = Math.max(0, volume - 0.15);
      if (audio) audio.volume = ducked ? volume * 0.2 : volume;
      return { volume: Math.round(volume * 100), note: 'This is the assistant\'s music volume; the device volume is outside NakliOS.' };
    },
    nowPlaying: () => (playing() ? { playing: trackName(queue[at]), queued: queue.length - at - 1 } : { playing: null }),
    // Quieter while the person talks, so the mic hears them and not the song.
    duck(on) { ducked = !!on; if (audio) audio.volume = ducked ? volume * 0.2 : volume; },
    rescan: () => { index = null; },
  };
}

export function musicTools({ music, host }) {
  return [
    {
      name: 'play_music',
      description: 'Play the person\'s own music from their NakliOS storage, by artist, album or song words, or shuffle everything when no words are given.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Artist, album or song words (optional)' } }, required: [] },
      run: ({ query = '' }) => music.play(query),
    },
    {
      name: 'control_music',
      description: 'Pause, resume, skip to the next track, or stop the music the assistant is playing.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'resume', 'next', 'stop'] } }, required: ['action'] },
      run: ({ action }) => (action === 'pause' ? music.pause() : action === 'resume' ? music.resume() : action === 'next' ? music.next() : music.stop()),
    },
    {
      name: 'set_volume',
      description: 'Change the volume of the assistant\'s music: a level from 0 to 100, or up or down a step.',
      parameters: { type: 'object', properties: {
        level: { type: 'number', minimum: 0, maximum: 100, description: 'Volume level 0 to 100' },
        change: { type: 'string', enum: ['up', 'down'] },
      }, required: [] },
      run: (args) => music.setVolume(args),
    },
    {
      name: 'now_playing',
      description: 'Say which track is playing.',
      parameters: { type: 'object', properties: {}, required: [] },
      run: () => music.nowPlaying(),
    },
    {
      name: 'open_music_player',
      description: 'Open NakliAmp, the NakliOS music player, for browsing a music folder.',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() { await host.openApp('nakliamp'); return { opened: 'NakliAmp' }; },
    },
  ];
}
