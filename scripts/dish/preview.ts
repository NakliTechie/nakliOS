import DshWorker from '@deepseek-ai/dsh-experimental-webworker-runtime/worker?worker'
import { connectWorkerHost } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
// Dish's bootstrap restores durable data and binds the NakliOS broker before DSH boots.
const { startDish } = await import(/* @vite-ignore */ '../host.mjs')
try { await startDish(DshWorker, connectWorkerHost) }
catch (error) { (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__?.reject(error); throw error }
