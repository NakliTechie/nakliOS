// Tethered capture (L50): a camera on USB, driven over PTP (src/merge/ptp.js) through WebUSB in Chrome.
// Connecting needs the person's click (the browser's USB device chooser), so connect_camera is person-only
// and the UI calls connectCamera below. tether_capture fires the shutter (InitiateCapture), waits for the
// camera's ObjectAdded events, downloads each new picture (GetObjectInfo, GetObject), saves it in the
// workspace under tether/<date>/ (never replacing a file) and opens the last one.
// Built to the device boundary and tested against a fake camera; generic PTP only (cameras that need a
// vendor operation to release the shutter answer OperationNotSupported, reported as unsupported).

import { createSession, webUsbTransport, PtpError, RC } from '../merge/ptp.js';
import { photoKind } from '../files/workspace.js';
import { fail, stageOrRun } from './util.js';

const usbAvailable = () => typeof navigator !== 'undefined' && !!navigator.usb;

function status(ctx) {
  const t = ctx.tether;
  return {
    usb: usbAvailable(), connected: !!t,
    ...(t ? { camera: { manufacturer: t.info.manufacturer, model: t.info.model, serial: t.info.serialNumber, version: t.info.deviceVersion }, canCapture: t.info.canCapture } : {}),
    captures: (t?.captures || ctx.tetherCaptures || []).slice(-20),
  };
}

// Called by the UI with the device the person picked (navigator.usb.requestDevice), or by tests with a
// transport. Reads DeviceInfo, opens a session and keeps it on ctx.tether.
export async function connectCamera(ctx, device, { transport } = {}) {
  await disconnect(ctx);
  const t = transport || await webUsbTransport(device);
  const session = createSession(t);
  const info = await session.deviceInfo();
  await session.open();
  ctx.tether = { transport: t, session, info, captures: [] };
  ctx.onTether?.();
  return status(ctx);
}
async function disconnect(ctx) {
  const t = ctx.tether; if (!t) return false;
  ctx.tetherCaptures = t.captures; ctx.tether = null;
  try { await t.session.close(); } catch { /* the camera may already be gone */ }
  try { await t.transport.close?.(); } catch { /* same */ }
  ctx.onTether?.();
  return true;
}

export function register(bus, ctx) {
  bus.register('tether.status', async () => status(ctx));

  bus.register('tether.disconnect', async (a, { viewOnly }) => { viewOnly(); return { disconnected: await disconnect(ctx), ...status(ctx) }; });

  bus.register('tether.capture', async (a, opts) => {
    const t = ctx.tether;
    if (!t) fail('unsupported', usbAvailable() ? 'no camera is connected; the person connects one with Connect camera' : 'this browser has no WebUSB (navigator.usb); tethering works in Chrome or Edge', 'use_ui_control', 'connect_camera');
    if (!t.info.canCapture) fail('unsupported', `${t.info.model} does not list InitiateCapture among its PTP operations; it needs a vendor operation Atelier does not send yet`, 'change_target', 'camera_status');
    const s = ctx.storage(); if (!s) fail('unsupported', 'no workspace folder is open', 'use_ui_control', 'grant_folder');
    const folder = (a.folder ?? `tether/${new Date().toISOString().slice(0, 10)}`).replace(/^\/+|\/+$/g, '');
    if (folder.split('/').some((p) => p === '..' || p === '.')) fail('invalid', 'folder must stay inside the workspace', 'fix_argument', 'tether_capture');
    return stageOrRun(ctx, opts, 'tether_capture', `fire the shutter of ${t.info.manufacturer} ${t.info.model} and save the picture to ${folder}/`, async () => {
      let handles;
      try { handles = await t.session.capture({ timeoutMs: (a.timeoutSeconds ?? 30) * 1000 }); } catch (e) {
        if (e instanceof PtpError && e.code === RC.OperationNotSupported) fail('unsupported', e.message, 'change_target', 'camera_status');
        fail('outcome_unknown', `the capture may or may not have happened: ${e.message}`, 'get_state', 'camera_status');
      }
      const files = [];
      for (const h of handles) {
        const dl = await t.session.download(h);
        const name = dl.filename.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_');
        let path = `${folder}/${name}`; let k = 1;
        while (await s.exists(path)) path = `${folder}/${name.replace(/(\.[^.]+)?$/, `-${k++}$1`)}`;   // never replace a file
        await s.write(path, dl.bytes);
        const row = { path, bytes: dl.bytes.length, handle: h, at: new Date().toISOString() };
        files.push(row); t.captures.push(row);
      }
      ctx.onTether?.();
      const result = { camera: t.info.model, files };
      const last = [...files].reverse().find((f) => photoKind(f.path));
      if (last && a.open !== false) {
        const o = await bus.dispatch('open_photo', { path: last.path }, { door: opts.door, caller: opts.caller });
        result.opened = o.status === 'ok' ? last.path : null;
      }
      return result;
    });
  });
}
