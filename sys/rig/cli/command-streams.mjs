import { concatData, toBytes } from './io.mjs';

export const lineData = (data = '') => typeof data === 'string' && data !== '' && !data.endsWith('\n') ? data + '\n' : data;
// Explicit channels are exact data. Legacy line-oriented errors remain diagnostics;
// data-bearing nonzero statuses opt in with stdout (or the existing raw contract).
export function commandStreams(result = {}) {
  let stdout, stderr;
  if (Object.hasOwn(result, 'stdout') || Object.hasOwn(result, 'stderr')) {
    stdout = result.stdout ?? (result.raw ? result.text ?? '' : lineData(result.text ?? ''));
    stderr = result.stderr ?? '';
  } else if (!result.raw && result.code && result.text) {
    stdout = ''; stderr = lineData(result.text);
  } else { stdout = result.raw ? result.text ?? '' : lineData(result.text ?? ''); stderr = ''; }
  return { ...result, stdout, stderr };
}
export function streamResult(events, code = 0, extra = {}) {
  const stdout = concatData(events.filter((event) => event.channel === 1).map((event) => event.data));
  const stderr = concatData(events.filter((event) => event.channel === 2).map((event) => event.data));
  return { text: stdout, stdout, stderr, combined: concatData(events.map((event) => event.data)), events, code, raw: true, ...extra };
}
export function resultEvents(result) {
  const normalized = commandStreams(result);
  return normalized.events ?? [{ channel: 1, data: normalized.stdout }, { channel: 2, data: normalized.stderr }]
    .filter((event) => toBytes(event.data).length);
}
