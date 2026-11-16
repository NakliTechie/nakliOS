/* Core commands: the transport, volume and view controls that existed before the parity build.
 * Handlers are bound in index.html, because they use its local UI functions. `repeat: true` lets a
 * held key run the command again (review V34). */

const none = { type: 'object', properties: {}, required: [] };

export const COMMANDS = [
  { name: 'playback.toggle', label: 'Play or pause', scope: 'write', input: none,
    description: 'Play if paused, pause if playing.', readTwin: 'state.read', shortcuts: [{ key: 'space' }] },
  { name: 'playback.play', label: 'Play', scope: 'write', input: none,
    description: 'Start or resume playback.', readTwin: 'state.read' },
  { name: 'playback.pause', label: 'Pause', scope: 'write', input: none,
    description: 'Pause playback.', readTwin: 'state.read' },
  { name: 'playback.seek', label: 'Seek', scope: 'write', readTwin: 'state.read',
    description: 'Seek to a position in seconds from the start.',
    input: { type: 'object', properties: { positionS: { type: 'number', minimum: 0, description: 'Seconds' } }, required: ['positionS'] } },
  { name: 'playback.skip', label: 'Skip', scope: 'write', readTwin: 'state.read', repeat: true,
    description: 'Move the position forward or back by a number of seconds.',
    input: { type: 'object', properties: { seconds: { type: 'number', description: 'Negative goes back' } }, required: ['seconds'] },
    shortcuts: [
      { key: 'arrowleft', input: { seconds: -10 } }, { key: 'arrowright', input: { seconds: 10 } },
      { key: 'shift+arrowleft', input: { seconds: -3 } }, { key: 'shift+arrowright', input: { seconds: 3 } },
    ] },
  { name: 'playback.rate', label: 'Speed', scope: 'write', readTwin: 'state.read',
    description: 'Set the playback speed from 0.25 to 4, or step it by a delta.',
    input: { type: 'object', properties: {
      rate: { type: 'number', minimum: 0.25, maximum: 4 },
      delta: { type: 'number', description: 'Change from the current speed' } }, required: [] },
    shortcuts: [{ key: '[', input: { delta: -0.25 } }, { key: ']', input: { delta: 0.25 } }, { key: 'z', input: { rate: 1 } }] },
  { name: 'audio.volume', label: 'Volume', scope: 'write', readTwin: 'state.read', repeat: true,
    description: 'Set the volume from 0 to 2 (above 1 boosts up to 200%), or step it by a delta.',
    input: { type: 'object', properties: {
      volume: { type: 'number', minimum: 0, maximum: 2 },
      delta: { type: 'number' } }, required: [] },
    shortcuts: [{ key: 'arrowup', input: { delta: 0.05 } }, { key: 'arrowdown', input: { delta: -0.05 } }] },
  { name: 'audio.mute', label: 'Mute', scope: 'write', readTwin: 'state.read',
    description: 'Mute or unmute; with no input it toggles.',
    input: { type: 'object', properties: { muted: { type: 'boolean' } }, required: [] }, shortcuts: [{ key: 'm' }] },
  { name: 'view.fullscreen', label: 'Fullscreen', scope: 'write', readTwin: 'state.read',
    description: 'Enter or leave fullscreen; with no input it toggles.',
    input: { type: 'object', properties: { on: { type: 'boolean' } }, required: [] }, shortcuts: [{ key: 'f' }] },
  { name: 'media.open', label: 'Open file', scope: 'write', readTwin: 'state.read',
    description: 'Ask the person to pick a video file and play it.', input: none },
  { name: 'media.close', label: 'Close video', scope: 'write', readTwin: 'state.read',
    description: 'Stop the current video and return to the start screen.', input: none },
  { name: 'state.read', label: 'Player state', scope: 'read', input: none,
    description: 'Read the player state: media, tracks, clock (position, playing, rate, volume, muted) and playback.' },
  { name: 'caps.read', label: 'Capabilities', scope: 'read', input: none,
    description: 'Read what this browser can do: WebCodecs, File System Access and codec support.' },
];
