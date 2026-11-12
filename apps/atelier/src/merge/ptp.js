// Picture Transfer Protocol (PTP) over USB, for tethered capture (L50). Pure code: the container codec,
// dataset parsers and a session that talks to any transport with send / receive / event, so node tests
// drive it against a fake camera and the browser drives it over WebUSB (webUsbTransport below).
// Sources:
// - ISO 15740 / PIMA 15740:2000 "Picture Transfer Protocol": operation, response and event codes (§10–12),
//   DeviceInfo (§5.5.1) and ObjectInfo (§5.5.2) datasets, PTP strings (a count byte, then UTF-16LE
//   code units including the terminating NUL) and arrays (a uint32 count, then the elements).
// - USB Implementers Forum, "Universal Serial Bus Still Image Capture Device Definition" 1.0 (2000), §7:
//   the generic container: uint32 length (header included), uint16 type (1 command, 2 data, 3 response,
//   4 event), uint16 code, uint32 transaction id, then parameters (uint32 each) or data. Commands go on
//   the bulk-out pipe, data and responses come on bulk-in, events on the interrupt pipe. Interface class 6,
//   subclass 1, protocol 1.
// All values are little-endian.

export const OP = { GetDeviceInfo: 0x1001, OpenSession: 0x1002, CloseSession: 0x1003, GetStorageIDs: 0x1004, GetObjectInfo: 0x1008, GetObject: 0x1009, InitiateCapture: 0x100e };
export const RC = { OK: 0x2001, GeneralError: 0x2002, SessionNotOpen: 0x2003, OperationNotSupported: 0x2005, DeviceBusy: 0x2019, SessionAlreadyOpen: 0x201e };
export const EV = { ObjectAdded: 0x4002, CaptureComplete: 0x400d };
export const TYPE = { command: 1, data: 2, response: 3, event: 4 };
const RC_NAME = Object.fromEntries(Object.entries(RC).map(([k, v]) => [v, k]));
// Standard object formats (§6.2) for a fallback file extension; cameras name RAW files in ObjectInfo.
export const FORMAT = { 0x3801: 'jpg', 0x380d: 'tif', 0x3000: 'bin' };

export class PtpError extends Error { constructor(message, code) { super(message); this.code = code; } }

// ---- container codec ----------------------------------------------------------------------------
export function encodeContainer(type, code, transactionId, params = [], data = null) {
  const len = 12 + (data ? data.length : params.length * 4);
  const out = new Uint8Array(len); const dv = new DataView(out.buffer);
  dv.setUint32(0, len, true); dv.setUint16(4, type, true); dv.setUint16(6, code, true); dv.setUint32(8, transactionId, true);
  if (data) out.set(data, 12); else params.forEach((p, i) => dv.setUint32(12 + i * 4, p >>> 0, true));
  return out;
}
export function decodeContainer(bytes) {
  if (bytes.length < 12) throw new PtpError(`container shorter than its 12-byte header (${bytes.length} bytes)`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = dv.getUint32(0, true); const type = dv.getUint16(4, true); const code = dv.getUint16(6, true); const transactionId = dv.getUint32(8, true);
  const body = bytes.subarray(12, Math.min(length, bytes.length));
  const params = type === TYPE.data ? [] : Array.from({ length: Math.floor(body.length / 4) }, (_, i) => dv.getUint32(12 + i * 4, true));
  return { length, type, code, transactionId, params, payload: body };
}

// ---- dataset reader -----------------------------------------------------------------------------
export function reader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let o = 0;
  const need = (n) => { if (o + n > bytes.length) throw new PtpError(`dataset ends early at byte ${o}`); };
  const r = {
    u8: () => { need(1); return dv.getUint8(o++); },
    u16: () => { need(2); const v = dv.getUint16(o, true); o += 2; return v; },
    u32: () => { need(4); const v = dv.getUint32(o, true); o += 4; return v; },
    str: () => { const n = r.u8(); if (!n) return ''; need(n * 2); let s = ''; for (let i = 0; i < n; i++) { const c = dv.getUint16(o + i * 2, true); if (c) s += String.fromCharCode(c); } o += n * 2; return s; },
    a16: () => { const n = r.u32(); return Array.from({ length: n }, r.u16); },
    a32: () => { const n = r.u32(); return Array.from({ length: n }, r.u32); },
    get offset() { return o; },
  };
  return r;
}
// PTP string writer (for fakes and tests): count byte (characters plus NUL), UTF-16LE, NUL.
export function ptpString(s) {
  if (!s) return new Uint8Array([0]);
  const out = new Uint8Array(1 + (s.length + 1) * 2); out[0] = s.length + 1;
  for (let i = 0; i < s.length; i++) { out[1 + i * 2] = s.charCodeAt(i) & 255; out[2 + i * 2] = s.charCodeAt(i) >> 8; }
  return out;
}

export function parseDeviceInfo(bytes) {
  const r = reader(bytes);
  const info = { standardVersion: r.u16(), vendorExtensionId: r.u32(), vendorExtensionVersion: r.u16(), vendorExtensionDesc: r.str(), functionalMode: r.u16(),
    operations: r.a16(), events: r.a16(), properties: r.a16(), captureFormats: r.a16(), imageFormats: r.a16(),
    manufacturer: r.str(), model: r.str(), deviceVersion: r.str(), serialNumber: r.str() };
  info.canCapture = info.operations.includes(OP.InitiateCapture);
  return info;
}
export function parseObjectInfo(bytes) {
  const r = reader(bytes);
  return { storageId: r.u32(), format: r.u16(), protection: r.u16(), size: r.u32(), thumbFormat: r.u16(), thumbSize: r.u32(), thumbWidth: r.u32(), thumbHeight: r.u32(),
    width: r.u32(), height: r.u32(), bitDepth: r.u32(), parent: r.u32(), associationType: r.u16(), associationDesc: r.u32(), sequence: r.u32(),
    filename: r.str(), captureDate: r.str(), modificationDate: r.str(), keywords: r.str() };
}

// ---- session ------------------------------------------------------------------------------------
// transport: { send(Uint8Array), receive(maxLength) → Uint8Array, event(timeoutMs) → Uint8Array | null }.
// Limits on what a device may send: zero-length packets in a row, and the size of one container
// (512 MB, unless the ObjectInfo of a download declares a larger object).
export const MAX_EMPTY = 8;
export const MAX_CONTAINER = 512 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function createSession(transport, { chunk = 1 << 20 } = {}) {
  let tid = 0; let open = false; const queued = [];

  // Reads one container from bulk-in: the first transfer carries the header and its total length; more
  // transfers follow until that many bytes arrived. A device that keeps sending zero-length packets (more
  // than MAX_EMPTY in a row) or declares a length below the 12-byte header or above maxLength is refused,
  // so a broken camera can neither hang the page nor make it allocate gigabytes.
  async function receiveNonEmpty(n) {
    for (let empty = 0; empty < MAX_EMPTY; empty++) { const b = await transport.receive(n); if (b.length) return b; }
    throw new PtpError(`the camera sent ${MAX_EMPTY} empty USB packets in a row`);
  }
  async function readContainer(maxLength = MAX_CONTAINER) {
    const first = await receiveNonEmpty(chunk);
    if (first.length < 4) throw new PtpError(`container shorter than its 12-byte header (${first.length} bytes)`);
    const total = new DataView(first.buffer, first.byteOffset, 4).getUint32(0, true);
    if (total < 12) throw new PtpError(`camera declared a container of ${total} bytes, shorter than the 12-byte header`);
    if (total > maxLength) throw new PtpError(`camera declared a container of ${total} bytes, above the ${maxLength}-byte limit`);
    if (first.length >= total) return decodeContainer(first);
    const buf = new Uint8Array(total); buf.set(first); let got = first.length;
    while (got < total) { const part = await receiveNonEmpty(Math.min(chunk, total - got)); buf.set(part.subarray(0, total - got), got); got += part.length; }
    return decodeContainer(buf);
  }

  // One transaction: command, optional data from the device, response.
  // maxLength caps the data container (GetObject passes the ObjectInfo size plus the header).
  async function transaction(code, params = [], maxLength = MAX_CONTAINER) {
    const id = code === OP.OpenSession ? 0 : ++tid;
    await transport.send(encodeContainer(TYPE.command, code, id, params));
    let data = null; let c = await readContainer(maxLength);
    if (c.type === TYPE.data) { data = c.payload; c = await readContainer(); }
    if (c.type !== TYPE.response) throw new PtpError(`expected a response container, got type ${c.type}`);
    if (c.transactionId !== id) throw new PtpError(`response for transaction ${c.transactionId}, expected ${id}`);
    if (c.code !== RC.OK) throw new PtpError(`camera answered ${RC_NAME[c.code] || `0x${c.code.toString(16)}`} to operation 0x${code.toString(16)}`, c.code);
    return { params: c.params, data };
  }

  async function nextEvent(timeoutMs) {
    if (queued.length) return queued.shift();
    const b = await transport.event(timeoutMs); return b && b.length ? decodeContainer(b) : null;
  }

  return {
    get isOpen() { return open; },
    async deviceInfo() { return parseDeviceInfo((await transaction(OP.GetDeviceInfo)).data); },
    async open(sessionId = 1) {
      try { await transaction(OP.OpenSession, [sessionId]); } catch (e) { if (e.code !== RC.SessionAlreadyOpen) throw e; }
      open = true; tid = 0;
    },
    async close() { if (open) { try { await transaction(OP.CloseSession); } finally { open = false; } } },
    async storageIds() { const d = (await transaction(OP.GetStorageIDs)).data; return reader(d).a32(); },
    async objectInfo(handle) { return parseObjectInfo((await transaction(OP.GetObjectInfo, [handle])).data); },
    async object(handle, size = 0) { return (await transaction(OP.GetObject, [handle], Math.max(MAX_CONTAINER, size + 12))).data; },
    // InitiateCapture (StorageID 0 and ObjectFormatCode 0 let the camera choose), then wait for ObjectAdded
    // events until CaptureComplete for this transaction (or the timeout). Returns the new object handles.
    async capture({ timeoutMs = 30000 } = {}) {
      if (!open) throw new PtpError('no session is open', RC.SessionNotOpen);
      // Pictures are announced only on the interrupt pipe, so a transport without one cannot capture.
      if (transport.hasEvents === false) throw new PtpError('this camera has no event (interrupt) endpoint, so Atelier cannot learn when a picture is ready');
      const id = tid + 1;
      await transaction(OP.InitiateCapture, [0, 0]);
      const handles = []; const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const e = await nextEvent(Math.max(1, end - Date.now()));
        if (!e) { await sleep(50); continue; }   // a transport that answers "no event" at once must not spin the page
        if (e.code === EV.ObjectAdded) handles.push(e.params[0]);
        else if (e.code === EV.CaptureComplete && e.transactionId === id) return handles;
      }
      if (handles.length) return handles;
      throw new PtpError(`no picture arrived within ${Math.round(timeoutMs / 1000)} s`);
    },
    // Downloads one object: { handle, filename, format, size, bytes }.
    async download(handle) {
      const info = await this.objectInfo(handle);
      const bytes = await this.object(handle, info.size);
      return { handle, filename: info.filename || `capture-${handle}.${FORMAT[info.format] || 'bin'}`, format: info.format, size: info.size, bytes };
    },
  };
}

// ---- WebUSB transport (browser only) --------------------------------------------------------------
// Finds the Still Image interface (class 6, subclass 1, protocol 1), claims it and wraps its three endpoints.
export async function webUsbTransport(device) {
  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  let iface = null; let alt = null;
  for (const i of device.configuration.interfaces) for (const a of i.alternates) if (a.interfaceClass === 6 && a.interfaceSubclass === 1) { iface = i; alt = a; }
  if (!iface) throw new PtpError('this USB device has no PTP (still image) interface; set the camera to PTP or PC-remote USB mode');
  await device.claimInterface(iface.interfaceNumber);
  if (alt.alternateSetting) await device.selectAlternateInterface(iface.interfaceNumber, alt.alternateSetting);
  const ep = (dir, type) => alt.endpoints.find((e) => e.direction === dir && e.type === type)?.endpointNumber;
  const bulkIn = ep('in', 'bulk'); const bulkOut = ep('out', 'bulk'); const intr = ep('in', 'interrupt');
  if (bulkIn == null || bulkOut == null) throw new PtpError('the PTP interface lacks bulk endpoints');
  const bytes = (r) => new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  let pendingEvent = null;
  return {
    hasEvents: intr != null,
    async send(b) { const r = await device.transferOut(bulkOut, b); if (r.status !== 'ok') throw new PtpError(`USB send ${r.status}`); },
    async receive(n) { const r = await device.transferIn(bulkIn, n); if (r.status === 'stall') { await device.clearHalt('in', bulkIn); return new Uint8Array(0); } return bytes(r); },
    // One interrupt read stays pending across timeouts, so events are never lost between calls.
    async event(timeoutMs) {
      if (intr == null) return null;
      if (!pendingEvent) pendingEvent = device.transferIn(intr, 64).then(bytes, () => new Uint8Array(0));
      let timer;
      const t = new Promise((res) => { timer = setTimeout(() => res(undefined), timeoutMs); });
      const r = await Promise.race([pendingEvent, t]); clearTimeout(timer);
      if (r === undefined) return null;
      pendingEvent = null; return r;
    },
    async close() { try { await device.releaseInterface(iface.interfaceNumber); } finally { await device.close(); } },
  };
}
