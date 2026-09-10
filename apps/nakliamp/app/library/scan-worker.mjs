// Worker adapter for the library scan pipeline.
//
// Thin by design: the pipeline lives in scan-core.mjs so it can be driven
// directly by the M1 scan gate. This file only bridges postMessage to it.

import { scanFolder } from './scan-core.mjs';

let cancelled = false;

self.addEventListener('message', async event => {
  const { type, rootHandle } = event.data ?? {};
  if (type === 'cancel') { cancelled = true; return; }
  if (type !== 'scan') return;
  cancelled = false;
  try {
    await scanFolder(rootHandle, {
      post: message => self.postMessage(message),
      isCancelled: () => cancelled,
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      code: error?.code ?? 'ERR_NAKLIAMP_SCAN_FAILED',
      message: String(error?.message ?? error),
    });
  }
});
