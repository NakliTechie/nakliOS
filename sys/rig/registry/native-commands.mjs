// Native execution exists only when the owner supplies a paired gate host.
// It uses the same registry, grant, and operation log as the browser commands.
export function buildNativeCommands(host) {
  if (!host || typeof host.run !== 'function') throw new Error('A native gate host is required');
  return [{
    name: 'native.gate', summary: 'Run the owner-paired native gate in its disposable checkout',
    description: 'Run the fixed full workflow or frozen criterion. No arbitrary command, environment, path, or production commit is accepted.',
    scope: 'native:gate', destructive: false, annotations: { readOnlyHint: false },
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['full', 'criterion'] } }, additionalProperties: false },
    returnSchema: { type: 'object', properties: { data: { type: 'string' }, exitCode: { type: 'integer' } } },
    async run(input = {}) {
      if (Object.keys(input).some(k => k !== 'mode') || !['full', 'criterion'].includes(input.mode || 'full')) {
        return { ok: false, code: 'EINVAL', message: 'Use native-gate full or native-gate criterion' };
      }
      const result = await host.run(input.mode || 'full');
      if (!Number.isInteger(result?.code) || result.code < 0 || result.code > 255 || typeof result.output !== 'string') {
        return { ok: false, code: 'EIO', message: 'Invalid native gate result' };
      }
      return { ok: result.code === 0, exitCode: result.code, data: result.output,
        code: result.code === 0 ? undefined : 'EGATE', message: result.output };
    },
  }];
}
