// Wait for a reply to this host handshake, rather than accepting the SDK's initial defaults.
export function waitForCapabilities(sdk, { timeoutMs = 3000, timers = globalThis } = {}) {
  return new Promise((resolve, reject) => {
    let initial = true;
    const stop = sdk.onCapabilitiesChange(capabilities => {
      if (initial) { initial = false; return; }
      timers.clearTimeout(timer);
      stop();
      resolve(capabilities);
    });
    const timer = timers.setTimeout(() => {
      stop();
      reject(new Error('NakliOS did not reply. Reload Dish from its NakliOS window.'));
    }, timeoutMs);
    sdk.requestCapabilities();
  });
}
