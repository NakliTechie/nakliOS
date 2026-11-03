"""Apply the tracked integration to an extracted, immutable upstream release."""
from pathlib import Path
import sys
source = Path(sys.argv[1]); here = Path(__file__).resolve().parent
worker = source / 'packages/experimental/webworker-runtime/src/worker.ts'
s = worker.read_text(); anchor = 'let host: { handleMessage(data: unknown): void } | undefined'
assert anchor in s and '__dishInference' not in s
s = s.replace(anchor, (here/'worker-bridge.txt').read_text()+'\n'+anchor)
s = s.replace('    const created = createWorkerHost({', '    dishGlobal.__dishSnapshot = data.snapshot || [];\n    const created = createWorkerHost({')
s = s.replace('    dishGlobal.__dishSnapshot = data.snapshot || [];', '    dishGlobal.__dishSnapshot = data.snapshot || [];\n    (globalThis as typeof globalThis & { __dishColdBoot?: boolean }).__dishColdBoot = data.coldBoot === true;')
worker.write_text(s)
host = source / 'packages/experimental/webworker-runtime/src/worker-host.ts'
s = host.read_text(); anchor = '      setActiveVfs(mounted)'; assert anchor in s
s = s.replace(anchor, (here/'vfs-bridge.txt').read_text()+'\n'+anchor)
# The snapshot bridge seeds parent directories; upstream dropped dirname from this import.
anchor = "import { join } from './module-system/posix-path.ts'"; assert anchor in s
s = s.replace(anchor, "import { dirname, join } from './module-system/posix-path.ts'")
assert '  const response = await fetch(image)' in s and '  return await inflateImageStream(response.body, image)' in s
s = s.replace('  const response = await fetch(image)', '''  const imageStart = performance.now()
  const cold = (globalThis as typeof globalThis & { __dishColdBoot?: boolean }).__dishColdBoot === true
  const response = await fetch(image, { cache: cold ? 'no-store' : 'default' })''')
s = s.replace('  return await inflateImageStream(response.body, image)', '''  const bytes = await inflateImageStream(response.body, image)
  const resource = performance.getEntriesByName(image).at(-1) as PerformanceResourceTiming | undefined
  self.postMessage({ t: 'dish-image-metrics', metrics: {
    cold, fetchAndInflateMs: performance.now() - imageStart, inflatedBytes: bytes.byteLength,
    resource: resource ? { startTime: resource.startTime, duration: resource.duration,
      transferSize: resource.transferSize, encodedBodySize: resource.encodedBodySize,
      decodedBodySize: resource.decodedBodySize } : null,
  } })
  return bytes''')
host.write_text(s)
(source/'apps/web/src/preview.ts').write_text((here/'preview.ts').read_text())

# Vite 8/Rolldown exposes module IDs instead of Rollup's getWatchFiles.
p = source / 'apps/web/product-isolation.ts'
p.write_text(p.read_text().replace('this.getWatchFiles()', '[...this.getModuleIds()]'))
p = source / 'scripts/web-product-bundle-isolation.ts'
p.write_text(p.read_text().replace('...item.implicitlyLoadedBefore', '...(item.implicitlyLoadedBefore ?? [])'))
p.write_text(p.read_text().replace('...item.referencedFiles', '...(item.referencedFiles ?? [])'))
p.write_text(p.read_text().replace('      const info = moduleInfo(id)', "      if (id === '\\0rolldown/runtime.js') return\n      const info = moduleInfo(id)"))

# The Worker's node:os has no userInfo, so dsh's terminal (`process.env.SHELL || userInfo().shell`) threw when Dish
# opened a terminal (2026-11-04). A browser user has no OS account: the values are fixed, the shell is the Worker's.
p = source / 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/os.ts'
s = p.read_text()
anchor = '  networkInterfaces, constants,\n} satisfies NodeFace'
assert anchor in s and 'userInfo' not in s
# Node types userInfo with Buffer overloads; this one answers the string form only, which is what dsh asks for.
s = s.replace(anchor, '  networkInterfaces, constants, userInfo: userInfo as unknown as typeof import(\'node:os\').userInfo,\n} satisfies NodeFace')
s = s.replace('/** CommonJS default export:', '''/**
 * The current user.
 * @returns a fixed browser user whose home is `$DSH_HOME` and whose shell is the Worker's.
 */
export function userInfo(): { username: string, uid: number, gid: number, shell: string, homedir: string } {
  return { username: 'dish', uid: -1, gid: -1, shell: '/bin/sh', homedir: DSH_HOME }
}

/** CommonJS default export:''', 1)
p.write_text(s)

# Signal readiness only after the unchanged client has activated and mounted.
p = source / 'apps/web/src/main.ts'
s = p.read_text()
anchor = '  void entry.run(desktop === undefined ? undefined : reportFailure)'
assert anchor in s
s = s.replace(anchor, """  let dishFailed = false
  void entry.run(reason => {
    dishFailed = true
    document.dispatchEvent(new CustomEvent('dish-ui-error', { detail: reason instanceof Error ? reason.message : String(reason) }))
    if (desktop !== undefined) reportFailure(reason)
  }).then(() => {
    if (!dishFailed) document.dispatchEvent(new Event('dish-ui-mounted'))
  })""")
p.write_text(s)
