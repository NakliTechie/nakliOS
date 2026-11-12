// Tethered capture controls (L50), shown only where the browser has WebUSB (navigator.usb): Connect camera
// (the person picks the camera in the browser's USB chooser; connect_camera is person-only), Capture
// (tether_capture) and Disconnect (disconnect_camera). Mounted in the header by src/ui/index.js.

import { h } from './dom.js';
import { connectCamera } from '../handlers/tether.js';

export function createTetherControls(ui) {
  if (typeof navigator === 'undefined' || !navigator.usb) return null;
  const connect = h('button', {
    dataset: { person: 'connect_camera' }, title: 'Connect a camera over USB (PTP) to shoot straight into the workspace',
    onclick: async () => {
      let device;
      // Still Image class (6); the chooser lists only cameras that expose PTP.
      try { device = await navigator.usb.requestDevice({ filters: [{ classCode: 6 }] }); } catch { ui.say('No camera chosen.'); return; }
      ui.say('Connecting…');
      try { const s = await connectCamera(ui.ctx, device); ui.say(`Connected ${s.camera.manufacturer} ${s.camera.model}${s.canCapture ? '' : ' (it does not accept the generic capture command)'}.`); } catch (e) { ui.say(`Could not connect: ${e.message}`); }
      draw();
    },
  }, 'Connect camera');
  const capture = h('button', {
    dataset: { command: 'tether_capture' }, title: 'Fire the shutter and open the picture',
    onclick: async () => {
      ui.say('Capturing…');
      const r = await ui.send('tether_capture', {});
      if (r.status === 'ok') { ui.say(`Saved ${r.result.files.map((f) => f.path).join(', ') || 'nothing'}.`); ui.filmstrip?.refresh(); ui.render(); }
    },
  }, 'Capture');
  const off = h('button', { dataset: { command: 'disconnect_camera' }, title: 'Release the camera', onclick: async () => { await ui.send('disconnect_camera', {}); draw(); } }, '×');
  const wrap = h('span', { class: 'tether' }, connect, capture, off);
  function draw() { const on = !!ui.ctx.tether; connect.hidden = on; capture.hidden = !on; off.hidden = !on; if (on) capture.textContent = `Capture (${ui.ctx.tether.info.model})`; }
  ui.ctx.onTether = draw;
  draw();
  return wrap;
}
