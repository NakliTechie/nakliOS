"""Apply the tracked integration to an extracted, immutable upstream release."""
from pathlib import Path
import sys
source = Path(sys.argv[1]); here = Path(__file__).resolve().parent
worker = source / 'packages/experimental/webworker-runtime/src/worker.ts'
s = worker.read_text(); anchor = 'let host: { handleMessage(data: unknown): void } | undefined'
assert anchor in s and '__dishInference' not in s
s = s.replace(anchor, (here/'worker-bridge.txt').read_text()+'\n'+anchor)
s = s.replace('    const created = createWorkerHost({', '    dishGlobal.__dishSnapshot = data.snapshot || [];\n    const created = createWorkerHost({')
worker.write_text(s)
host = source / 'packages/experimental/webworker-runtime/src/worker-host.ts'
s = host.read_text(); anchor = '      setActiveVfs(mounted)'; assert anchor in s
s = s.replace(anchor, (here/'vfs-bridge.txt').read_text()+'\n'+anchor)
s = s.replace('mounted.seedFile(target,', 'mounted.seed(target,')
host.write_text(s)
(source/'apps/web/src/preview.ts').write_text((here/'preview.ts').read_text())

# Vite 8/Rolldown exposes module IDs instead of Rollup's getWatchFiles.
p = source / 'apps/web/product-isolation.ts'
p.write_text(p.read_text().replace('this.getWatchFiles()', '[...this.getModuleIds()]'))
p = source / 'scripts/web-product-bundle-isolation.ts'
p.write_text(p.read_text().replace('...item.implicitlyLoadedBefore', '...(item.implicitlyLoadedBefore ?? [])'))
p.write_text(p.read_text().replace('...item.referencedFiles', '...(item.referencedFiles ?? [])'))
p.write_text(p.read_text().replace('      const info = moduleInfo(id)', "      if (id === '\\0rolldown/runtime.js') return\n      const info = moduleInfo(id)"))

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
