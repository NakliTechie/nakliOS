import workerUrl from '@deepseek-ai/dsh-experimental-webworker-runtime/worker?worker&url'
import { connectWorkerHost } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
class DshWorker extends Worker {
  constructor(options?: WorkerOptions) {
    const url = new URL(workerUrl, import.meta.url)
    if (new URLSearchParams(location.search).get('dish-cold') === '1') url.searchParams.set('dish-cold', crypto.randomUUID())
    super(url, options)
  }
}
// Dish's bootstrap restores durable data and binds the NakliOS broker before DSH boots.
const { startDish } = await import(/* @vite-ignore */ '../host.mjs')
try { await startDish(DshWorker, connectWorkerHost) }
catch (error) { (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__?.reject(error); throw error }
