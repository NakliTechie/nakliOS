// commands.mjs — every NakliAmp action, once (N1, N2, N3, K1, K2, K3).
//
// One list drives the buttons, the keyboard, the keymap overlay and the agent tools
// NakliAmp registers with NakliOS. `commands.json` at the repo root is generated from
// this list by `scripts/build-commands-json.mjs`, and a test checks they match.
//
// Entry: { name, label, description, scope, group, input (JSON Schema), keys? }
//   scope  'read'        runs without asking; changes nothing the person keeps
//          'reversible'  runs without asking; queue undo, a toggle or a new file undoes it
//          'destructive' stages a diff and runs only after the person approves
//   keys   [{ key, input?, label? }]: keyboard bindings. `key` is a canonical shortcut
//          ('Space', 'Shift+ArrowLeft', 'Alt+3', 'Mod+Z', '?'), `input` the command
//          input that key sends, `label` how the keymap overlay names it.
// `shortcut` (the list of keys) is derived from `keys` for each entry.
//
// Read results carry track ids and display fields, never file paths. Search and
// browse page by 20 (`offset`, `limit`).

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = description => ({ type: 'boolean', description });
const oneOf = (values, description) => ({ type: 'string', enum: values, description });
const trackIds = (description = 'Track ids. Omitted: the selected tracks, or the playing track') =>
  ({ type: 'array', items: { type: 'string', minLength: 1 }, description });
const page = () => ({
  offset: int('First result to return (default 0)', { minimum: 0 }),
  limit: int('Results per page (default 20)', { minimum: 1, maximum: 100 }),
});

export const SHUFFLE_MODES = ['off', 'tracks', 'albums'];
export const REPEAT_MODES = ['off', 'all', 'one'];
export const BROWSE_BY = ['albums', 'artists', 'albumArtists', 'genres', 'years', 'folders',
  'recentlyAdded', 'recentlyPlayed', 'mostPlayed', 'favourites', 'rated'];
export const VIEWS = ['library', 'albums', 'artists', 'albumArtists', 'genres', 'years', 'folders',
  'queue', 'playlists', 'search', 'lyrics', 'inspector', 'eq', 'settings', 'ai'];
export const EQ_PRESETS = ['flat', 'rock', 'pop', 'jazz', 'classical', 'bass-boost', 'treble-boost',
  'vocal', 'electronic', 'acoustic', 'custom'];
export const SMART_FIELDS = ['genre', 'artist', 'albumArtist', 'album', 'title', 'year', 'rating', 'playCount',
  'lastPlayedAt', 'addedAt', 'durationS', 'path', 'favourite'];
export const SMART_OPS = ['is', 'is-not', 'contains', 'not-contains', 'gt', 'lt', 'between', 'in-last-days', 'not-in-last-days'];
export const SORT_KEYS = ['title', 'artist', 'album', 'year', 'addedAt', 'playCount', 'lastPlayedAt', 'rating', 'durationS'];

/** File types NakliOS offers to open in NakliAmp. */
export const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.oga', '.wav', '.mka', '.webm',
  '.aiff', '.aif', '.aifc', '.caf', '.au', '.wma', '.ape', '.wv', '.mpc', '.tta', '.dsf', '.dff'];

const digitSeeks = Array.from({ length: 10 }, (_, n) => ({ key: String(n), input: { percent: n * 10 }, label: `Jump to ${n * 10}%` }));
const ratingKeys = Array.from({ length: 6 }, (_, n) => ({ key: `Alt+${n}`, input: { rating: n }, label: n ? `Rate ${n} star${n > 1 ? 's' : ''}` : 'Clear rating' }));

const RAW = [
  // ---------------------------------------------------------------- player ----
  { name: 'player.play', group: 'player', scope: 'reversible', label: 'Play',
    description: 'Start or resume playback of the current queue entry.', input: obj() },
  { name: 'player.pause', group: 'player', scope: 'reversible', label: 'Pause',
    description: 'Pause playback.', input: obj() },
  { name: 'player.toggle', group: 'player', scope: 'reversible', label: 'Play or pause',
    description: 'Play when paused, pause when playing.', input: obj(), keys: [{ key: 'Space' }] },
  { name: 'player.next', group: 'player', scope: 'reversible', label: 'Next track',
    description: 'Move to the next queue entry, following shuffle and repeat.', input: obj(), keys: [{ key: 'N' }] },
  { name: 'player.previous', group: 'player', scope: 'reversible', label: 'Previous track',
    description: 'Move to the previous queue entry.', input: obj(), keys: [{ key: 'P' }] },
  { name: 'player.seek', group: 'player', scope: 'reversible', label: 'Seek',
    description: 'Seek to a position in the playing track, in seconds or as a percentage of its length. Give one of the two.',
    input: { ...obj({ seconds: num('Position in seconds', { minimum: 0 }), percent: num('Position as a percentage', { minimum: 0, maximum: 100 }) }), minProperties: 1, maxProperties: 1 },
    keys: digitSeeks, keymapLabel: 'Jump to 0%, 10% and so on up to 90%' },
  { name: 'player.seek_relative', group: 'player', scope: 'reversible', label: 'Seek by',
    description: 'Seek forward (positive) or back (negative) by a number of seconds.',
    input: obj({ seconds: num('Seconds to move; negative moves back', { minimum: -3600, maximum: 3600 }) }, ['seconds']),
    keys: [
      { key: 'ArrowLeft', input: { seconds: -5 }, label: 'Back 5 seconds' },
      { key: 'ArrowRight', input: { seconds: 5 }, label: 'Forward 5 seconds' },
      { key: 'Shift+ArrowLeft', input: { seconds: -30 }, label: 'Back 30 seconds' },
      { key: 'Shift+ArrowRight', input: { seconds: 30 }, label: 'Forward 30 seconds' },
    ] },
  { name: 'player.volume', group: 'player', scope: 'reversible', label: 'Volume',
    description: 'Set the volume (0 to 1) or change it by a step (-1 to 1). Give one of the two.',
    input: { ...obj({ level: num('Volume from 0 (silent) to 1 (full)', { minimum: 0, maximum: 1 }), delta: num('Change in volume', { minimum: -1, maximum: 1 }) }), minProperties: 1, maxProperties: 1 },
    keys: [
      { key: 'ArrowUp', input: { delta: 0.05 }, label: 'Volume up' },
      { key: 'ArrowDown', input: { delta: -0.05 }, label: 'Volume down' },
    ] },
  { name: 'player.mute', group: 'player', scope: 'reversible', label: 'Mute',
    description: 'Mute or unmute. Without `muted` it toggles.', input: obj({ muted: bool('true mutes, false unmutes') }), keys: [{ key: 'M' }] },
  { name: 'player.status', group: 'player', scope: 'read', label: 'Player status',
    description: 'What is playing: track id, title, artist, album, position and duration in seconds, playing or paused, volume, muted, shuffle, repeat, and the decoder route.',
    input: obj() },

  // ----------------------------------------------------------------- queue ----
  { name: 'queue.read', group: 'queue', scope: 'read', label: 'Read queue',
    description: 'A page of the play queue: each entry\'s position, track id, title, artist, album and duration, plus the current position, shuffle and repeat.',
    input: obj(page()) },
  { name: 'queue.set', group: 'queue', scope: 'reversible', label: 'Replace queue',
    description: 'Replace the queue with these tracks and start at `startIndex` (default 0). Undo restores the previous queue.',
    input: obj({ ids: trackIds('Track ids in play order'), startIndex: int('Entry to start at', { minimum: 0 }), play: bool('Start playing (default true)') }, ['ids']) },
  { name: 'queue.add', group: 'queue', scope: 'reversible', label: 'Add to queue',
    description: 'Add tracks to the end of the queue.', input: obj({ ids: trackIds() }), keys: [{ key: 'Q' }] },
  { name: 'queue.play_next', group: 'queue', scope: 'reversible', label: 'Play next',
    description: 'Insert tracks right after the playing entry.', input: obj({ ids: trackIds() }), keys: [{ key: 'Shift+Q' }] },
  { name: 'queue.move', group: 'queue', scope: 'reversible', label: 'Move in queue',
    description: 'Move the entry at position `from` to position `to` (0-based).',
    input: obj({ from: int('Current position', { minimum: 0 }), to: int('New position', { minimum: 0 }) }, ['from', 'to']) },
  { name: 'queue.remove', group: 'queue', scope: 'reversible', label: 'Remove from queue',
    description: 'Remove entries by position (0-based). Omitted: the selected queue entries.',
    input: obj({ indices: { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'Positions to remove' } }),
    keys: [{ key: 'Delete' }] },
  { name: 'queue.clear', group: 'queue', scope: 'reversible', label: 'Clear queue',
    description: 'Empty the queue. Undo brings it back.', input: obj() },
  { name: 'queue.shuffle', group: 'queue', scope: 'reversible', label: 'Shuffle',
    description: 'Set shuffle to off, tracks or albums (albums keeps track order inside each album). Without `mode` it moves to the next mode.',
    input: obj({ mode: oneOf(SHUFFLE_MODES, 'Shuffle mode') }), keys: [{ key: 'S' }] },
  { name: 'queue.repeat', group: 'queue', scope: 'reversible', label: 'Repeat',
    description: 'Set repeat to off, all or one. Without `mode` it moves to the next mode.',
    input: obj({ mode: oneOf(REPEAT_MODES, 'Repeat mode') }), keys: [{ key: 'R' }] },
  { name: 'queue.undo', group: 'queue', scope: 'reversible', label: 'Undo queue edit',
    description: 'Undo the last queue or playlist edit.', input: obj(), keys: [{ key: 'Mod+Z' }] },
  { name: 'queue.save_playlist', group: 'queue', scope: 'reversible', label: 'Save queue as playlist',
    description: 'Save the queue as an M3U8 playlist file in the music folder. Refuses when a playlist with that name exists.',
    input: obj({ name: str('Playlist name', { minLength: 1, maxLength: 120 }) }, ['name']) },

  // --------------------------------------------------------------- library ----
  { name: 'library.search', group: 'library', scope: 'read', label: 'Search library',
    description: 'Fuzzy search over title, artist, album, album artist, file name and genre. Returns a page of tracks (id, title, artist, album, year, duration) and the total.',
    input: obj({ query: str('Search text', { minLength: 1, maxLength: 200 }), ...page() }, ['query']) },
  { name: 'library.browse', group: 'library', scope: 'read', label: 'Browse library',
    description: 'List groups (albums, artists, genres, years, folders) or, with `key`, the tracks in one group; or the recently added, recently played, most played, favourite and rated lists. Pages by 20.',
    input: obj({ by: oneOf(BROWSE_BY, 'What to browse'), key: str('Group key from a previous browse'), ...page() }, ['by']) },
  { name: 'track.read', group: 'library', scope: 'read', label: 'Read track',
    description: 'One track\'s tags and state: title, artist, album, album artist, track and disc, year, genre, duration, codec, rating, favourite, play count, last played, ReplayGain values.',
    input: obj({ id: str('Track id', { minLength: 1 }) }, ['id']) },
  { name: 'track.rate', group: 'library', scope: 'reversible', label: 'Rate',
    description: 'Rate tracks from 0 (no rating) to 5 stars. Stored in the index, not the file.',
    input: obj({ ids: trackIds(), rating: int('Stars', { minimum: 0, maximum: 5 }) }, ['rating']), keys: ratingKeys, keymapLabel: 'Rate 1 to 5 stars (Alt+0 clears)' },
  { name: 'track.favourite', group: 'library', scope: 'reversible', label: 'Favourite',
    description: 'Mark or unmark tracks as favourites. Without `favourite` it toggles.',
    input: obj({ ids: trackIds(), favourite: bool('true marks, false unmarks') }), keys: [{ key: 'F' }] },
  { name: 'track.edit_tags', group: 'library', scope: 'destructive', label: 'Edit tags',
    description: 'Write tags into the audio files (Chromium only). Shows the change and waits for approval; keeps a backup until the rewritten file reads back the same.',
    input: obj({
      ids: trackIds('Tracks to edit'),
      patch: obj({
        title: str('Title'), artist: str('Artist'), album: str('Album'), albumArtist: str('Album artist'),
        trackNo: int('Track number', { minimum: 0 }), trackTotal: int('Track total', { minimum: 0 }),
        discNo: int('Disc number', { minimum: 0 }), discTotal: int('Disc total', { minimum: 0 }),
        year: int('Year', { minimum: 0, maximum: 9999 }), genre: str('Genre'), rating: int('Stars', { minimum: 0, maximum: 5 }),
      }),
    }, ['ids', 'patch']) },

  // ------------------------------------------------------------- playlists ----
  { name: 'playlist.list', group: 'playlist', scope: 'read', label: 'List playlists',
    description: 'The playlists in the music folder (M3U, M3U8, PLS, XSPF, JSPF and smart playlists): name, kind and track count.',
    input: obj() },
  { name: 'playlist.create', group: 'playlist', scope: 'reversible', label: 'New playlist',
    description: 'Create an M3U8 playlist in the music folder, optionally with tracks.',
    input: obj({ name: str('Playlist name', { minLength: 1, maxLength: 120 }), ids: trackIds('Tracks to put in it') }, ['name']) },
  { name: 'playlist.add', group: 'playlist', scope: 'reversible', label: 'Add to playlist',
    description: 'Append tracks to a playlist. Omitted ids: the selected tracks, or the playing track.',
    input: obj({ name: str('Playlist name', { minLength: 1 }), ids: trackIds() }, ['name']) },
  { name: 'playlist.delete', group: 'playlist', scope: 'destructive', label: 'Delete playlist',
    description: 'Delete a playlist file from the music folder. Shows what goes and waits for approval.',
    input: obj({ name: str('Playlist name', { minLength: 1 }) }, ['name']) },
  { name: 'smart.create', group: 'playlist', scope: 'reversible', label: 'New smart playlist',
    description: 'Save a smart playlist rule as <name>.nakliamp-smart.json in the music folder. Rules match all or any; each is { field, op, value }.',
    input: obj({
      rule: obj({
        name: str('Name', { minLength: 1, maxLength: 120 }),
        match: oneOf(['all', 'any'], 'Match all rules or any rule'),
        rules: { type: 'array', items: obj({ field: oneOf(SMART_FIELDS, 'Field'), op: oneOf(SMART_OPS, 'Operator'), value: { description: 'Value: text, number, or [low, high] for between' } }, ['field', 'op']), description: 'Rules' },
        limit: int('Most tracks to include', { minimum: 1, maximum: 10000 }),
        sort: obj({ key: oneOf(SORT_KEYS, 'Sort key'), direction: oneOf(['asc', 'desc'], 'Direction') }),
      }, ['name', 'match', 'rules']),
    }, ['rule']) },
  { name: 'smart.list', group: 'playlist', scope: 'read', label: 'List smart playlists',
    description: 'The smart playlists in the music folder, with their rules and current track counts.', input: obj() },

  // ----------------------------------------------------------------- sound ----
  { name: 'eq.preset', group: 'sound', scope: 'reversible', label: 'EQ preset',
    description: 'Pick an equaliser preset, or set the custom curve (10 bands, -12 to 12 dB).',
    input: obj({ preset: oneOf(EQ_PRESETS, 'Preset'), custom: { type: 'array', items: { type: 'number', minimum: -12, maximum: 12 }, minItems: 10, maxItems: 10, description: 'Custom gains in dB, 70 Hz to 16 kHz' } }) },
  { name: 'eq.enable', group: 'sound', scope: 'reversible', label: 'Equaliser on or off',
    description: 'Turn the equaliser on or off. Without `enabled` it toggles.', input: obj({ enabled: bool('true turns it on') }), keys: [{ key: 'E' }] },
  { name: 'sound.replaygain', group: 'sound', scope: 'reversible', label: 'ReplayGain',
    description: 'Set ReplayGain: off, track, album or auto (album gain inside an album run, track gain otherwise), the preamp in dB, and clipping prevention.',
    input: obj({ mode: oneOf(['off', 'track', 'album', 'auto'], 'Mode'), preampDb: num('Preamp in dB', { minimum: -15, maximum: 15 }), preventClipping: bool('Lower the gain when the peak would clip') }) },
  { name: 'sound.crossfade', group: 'sound', scope: 'reversible', label: 'Crossfade',
    description: 'Crossfade length in seconds, 0 (off) to 12. Never applied between tracks of one album when gapless applies.',
    input: obj({ seconds: num('Seconds', { minimum: 0, maximum: 12 }) }, ['seconds']) },
  { name: 'sound.gapless', group: 'sound', scope: 'reversible', label: 'Gapless',
    description: 'Gapless playback: off, albums (within one album) or always.',
    input: obj({ mode: oneOf(['off', 'albums', 'always'], 'Mode') }, ['mode']) },

  // ------------------------------------------------------------ visualiser ----
  { name: 'visualiser.mode', group: 'visualiser', scope: 'reversible', label: 'Visualiser',
    description: 'Pick a visualiser mode by id, or move through the modes by `step`.',
    input: { ...obj({ mode: str('Mode id', { minLength: 1, maxLength: 40 }), step: int('Modes to move by', { minimum: -20, maximum: 20 }) }), minProperties: 1, maxProperties: 1 },
    keys: [{ key: 'V', input: { step: 1 }, label: 'Next visualiser' }] },
  { name: 'visualiser.full', group: 'visualiser', scope: 'reversible', label: 'Full-window visualiser',
    description: 'Show the visualiser over the whole window, or leave it. Without `on` it toggles.',
    input: obj({ on: bool('true enters full window') }), keys: [{ key: 'Shift+V' }] },

  // ------------------------------------------------------------------ view ----
  { name: 'view.open', group: 'view', scope: 'read', label: 'Open view',
    description: 'Open a view: the library, a browse view, the queue, playlists, search, lyrics, the track inspector, the equaliser, settings or the AI playlist dialog.',
    input: obj({ view: oneOf(VIEWS, 'View') }, ['view']),
    keys: [
      { key: 'L', input: { view: 'library' }, label: 'Library' },
      { key: '/', input: { view: 'search' }, label: 'Search' },
      { key: 'Y', input: { view: 'lyrics' }, label: 'Lyrics' },
      { key: 'I', input: { view: 'inspector' }, label: 'Track inspector' },
    ] },
  { name: 'view.close', group: 'view', scope: 'read', label: 'Close',
    description: 'Leave the full-window visualiser, or close the open overlay or dialog.', input: obj(), keys: [{ key: 'Escape' }] },
  { name: 'view.keymap', group: 'view', scope: 'read', label: 'Keyboard shortcuts',
    description: 'Show the keyboard map.', input: obj(), keys: [{ key: '?' }] },
  { name: 'ui.theme', group: 'view', scope: 'reversible', label: 'Theme',
    description: 'Light, dark, or system (inside NakliOS: the host theme).',
    input: obj({ theme: oneOf(['system', 'light', 'dark'], 'Theme') }, ['theme']) },
  { name: 'ui.mini', group: 'view', scope: 'reversible', label: 'Mini player',
    description: 'Switch to the compact mini player or back. Without `on` it toggles.',
    input: obj({ on: bool('true shows the mini player') }), keys: [{ key: 'Shift+M' }] },

  // -------------------------------------------------------------------- ai ----
  { name: 'ai.playlist', group: 'ai', scope: 'read', label: 'Playlist from a description',
    description: 'Make a playlist from a description using only tracks in the library. Returns track ids and a title as a preview; nothing is saved until playlist.create. Without a host model it filters by tags and search.',
    input: obj({ description: str('What to play', { minLength: 1, maxLength: 500 }), length: int('Tracks wanted (default 25)', { minimum: 1, maximum: 200 }) }, ['description']) },
];

function freezeDeep(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}

export const COMMANDS = freezeDeep(RAW.map(c => (c.keys ? { ...c, shortcut: c.keys.map(k => k.key) } : { ...c })));
export const commandByName = new Map(COMMANDS.map(c => [c.name, c]));
export const GROUP_LABELS = Object.freeze({
  player: 'Playback', queue: 'Queue', library: 'Library', playlist: 'Playlists',
  sound: 'Sound', visualiser: 'Visualiser', view: 'View', ai: 'AI',
});

/** The NakliOS rail knows read, write and destructive; NakliAmp's reversible commands are writes. */
export const railScope = c => (c.scope === 'reversible' ? 'write' : c.scope);

/** Refusal codes. A refusal is an Error with `code` set and a message that starts `[code]`. */
export const ERROR_CODES = Object.freeze([
  ['not-found', 'No command, track, playlist or handler by that name.'],
  ['invalid-input', 'The input does not match the command\'s JSON Schema.'],
  ['declined', 'The person did not approve a destructive command.'],
  ['unavailable', 'The command cannot run here (no music folder, no tag writing in this browser, no host model).'],
  ['refused', 'Any other refusal.'],
]);

/** The commands.json document. */
export function manifest() {
  return {
    accepts: [{ action: 'import', label: 'Open in NakliAmp', extensions: AUDIO_EXTENSIONS.slice() }],
    commands: COMMANDS.map(c => ({
      name: c.name,
      label: c.label,
      description: c.description,
      scope: railScope(c),
      approval: c.scope,
      group: c.group,
      input: c.input,
      ...(c.shortcut ? { shortcut: c.shortcut.slice() } : {}),
    })),
    errorCodes: ERROR_CODES.map(([code, meaning]) => ({ code, meaning })),
  };
}
