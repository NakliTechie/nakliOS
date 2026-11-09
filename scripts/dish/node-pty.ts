/**
 * Dish's `node-pty`: a line-oriented pseudo-terminal over the Worker's own shell, so dsh's persistent terminals and
 * the sidebar terminal work in the browser. prepare.py puts this file in place of upstream's stub.
 *
 * It is not a kernel PTY. It keeps a line editor (echo, backspace, Ctrl-C, Ctrl-D), runs each entered line through the
 * Worker's shell interpreter (`bash -c`, the same one the agent's bash tool uses), and keeps the working directory
 * between lines. Before every prompt it prints what dsh's terminal-bash waits for: PROMPT_COMMAND's OSC 133;D marker
 * with the last exit status, then PS1. Exported variables, functions and full-screen programs do not carry over;
 * dsh's terminal contract is line-oriented already.
 */
import { spawn as spawnCommand } from '../builtin_modules/implemented/child_process.ts'

type Listener<T> = (value: T) => void
type Disposable = { dispose(): void }
type Options = { cwd?: string, env?: Record<string, string | undefined>, cols?: number, rows?: number, name?: string }
type Child = ReturnType<typeof spawnCommand>

const SENTINEL = '\u001e'
let nextPid = 70000
// Sessions by shell pid, for the process inspector below.
const sessions = new Map<number, WorkerPty>()

function quote(text: string): string { return `'${text.replace(/'/g, `'\\''`)}'` }

function emitter<T>(): { on(listener: Listener<T>): Disposable, fire(value: T): void } {
  const listeners = new Set<Listener<T>>()
  return {
    on(listener) { listeners.add(listener); return { dispose: () => { listeners.delete(listener) } } },
    fire(value) { for (const listener of [...listeners]) listener(value) },
  }
}

/** One shell session. */
export class WorkerPty {
  readonly pid = nextPid++
  readonly process: string
  readonly handleFlowControl = false
  cols: number
  rows: number
  #cwd: string
  #env: Record<string, string>
  #prompt: string
  #marker: boolean
  #line = ''
  #child: Child | undefined
  #exited = false
  #lastNewline = ''
  readonly started = String(Date.now())
  // A runaway exchange (each prompt answered with Enter) froze the whole tab on 2026-11-09; more than 20 prompts in a
  // second ends the session and logs what was being written.
  #prompts: number[] = []
  #recentInput = ''
  readonly #data = emitter<string>()
  readonly #exit = emitter<{ exitCode: number, signal?: number }>()
  readonly onData = (listener: Listener<string>): Disposable => this.#data.on(listener)
  readonly onExit = (listener: Listener<{ exitCode: number, signal?: number }>): Disposable => this.#exit.on(listener)

  constructor(file: string, _args: readonly string[], options: Options = {}) {
    this.process = file.split('/').pop() || 'sh'
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    this.#cwd = options.cwd || '/'
    this.#env = Object.fromEntries(Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    const command = this.#env.PROMPT_COMMAND ?? ''
    this.#marker = command.includes('133;D;')
    this.#prompt = /PS1='([^']*)'/.exec(command)?.[1] ?? this.#env.PS1 ?? '$ '
    sessions.set(this.pid, this)
    setTimeout(() => this.#showPrompt(0), 0)
  }

  /** The foreground process group: the running command's pid, else the shell's. */
  get foreground(): number { return (this.#child as { pid?: number } | undefined)?.pid ?? this.pid }
  /** True while the shell waits at its prompt for input. */
  get idle(): boolean { return !this.#exited && this.#child === undefined }
  get exited(): boolean { return this.#exited }
  get childPid(): number | undefined { return (this.#child as { pid?: number } | undefined)?.pid }
  interrupt(): void { this.#interrupt() }

  #out(text: string): void { if (!this.#exited && text) this.#data.fire(text.replace(/\r?\n/g, '\r\n')) }
  #showPrompt(status: number): void {
    if (this.#exited) return
    const now = Date.now()
    this.#prompts = this.#prompts.filter(at => now - at < 1000)
    this.#prompts.push(now)
    if (this.#prompts.length > 20) {
      console.warn(`dish terminal ${this.pid}: ${this.#prompts.length} prompts in one second; closing it. Recent input: ${JSON.stringify(this.#recentInput.slice(-200))}`)
      this.#finish(1)
      return
    }
    this.#data.fire(`${this.#marker ? `\u001b]133;D;${status}\u0007` : ''}${this.#prompt}`)
  }

  write(data: string | Uint8Array): void {
    if (this.#exited) return
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    this.#recentInput = (this.#recentInput + text).slice(-400)
    for (const char of text) {
      if (this.#child) { if (char === '\u0003') this.#interrupt(); continue }
      if (char === '\r' || char === '\n') {
        // "\r\n" from one Enter counts once.
        if (char === '\n' && this.#lastNewline === '\r') { this.#lastNewline = ''; continue }
        this.#lastNewline = char
        this.#out('\n')
        const line = this.#line; this.#line = ''
        this.#run(line)
        continue
      }
      this.#lastNewline = ''
      if (char === '\u0003') { this.#line = ''; this.#out('^C\n'); this.#showPrompt(130) }
      else if (char === '\u0004') { if (!this.#line) this.#finish(0) }
      else if (char === '\u007f' || char === '\b') { if (this.#line) { this.#line = this.#line.slice(0, -1); this.#data.fire('\b \b') } }
      else if (char >= ' ' || char === '\t') { this.#line += char; this.#data.fire(char) }
    }
  }

  #run(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) { this.#showPrompt(0); return }
    if (/^exit(\s+\d+)?$/.test(trimmed)) { this.#finish(Number(trimmed.split(/\s+/)[1] ?? 0)); return }
    // The Worker's shell separates commands with ';' (not newlines) and has no /dev/null; the trailing printf reports
    // the line's exit status and the directory it ended in.
    const script = `cd ${quote(this.#cwd)} ; ${line} ; printf '${SENTINEL}%s${SENTINEL}%s${SENTINEL}' "$?" "$(pwd)"`
    const child = spawnCommand('bash', ['-c', script], { cwd: this.#cwd, env: { ...this.#env, COLUMNS: String(this.cols), LINES: String(this.rows) } })
    this.#child = child
    let pending = ''
    child.stdout?.on('data', (chunk: unknown) => {
      pending += String(chunk)
      const at = pending.indexOf(SENTINEL)
      if (at < 0) { this.#out(pending); pending = ''; return }
      this.#out(pending.slice(0, at)); pending = pending.slice(at)
    })
    child.stderr?.on('data', (chunk: unknown) => this.#out(String(chunk)))
    child.on('close', (code: unknown) => {
      if (this.#child !== child) return
      this.#child = undefined
      const tail = pending.split(SENTINEL)
      let status = typeof code === 'number' ? code : 130
      if (tail.length >= 3) {
        status = Number(tail[1]) || 0
        if (tail[2]) this.#cwd = tail[2]
      } else this.#out(pending)
      this.#showPrompt(status)
    })
    child.on('error', (error: unknown) => {
      if (this.#child !== child) return
      this.#child = undefined
      this.#out(`${error instanceof Error ? error.message : String(error)}\n`)
      this.#showPrompt(127)
    })
  }

  #interrupt(): void {
    const child = this.#child
    if (!child) return
    this.#child = undefined
    try { child.kill('SIGINT') } catch { /* already finished */ }
    this.#out('^C\n')
    this.#showPrompt(130)
  }

  #finish(exitCode: number, signal?: number): void {
    if (this.#exited) return
    if (this.#child) { try { this.#child.kill('SIGKILL') } catch { /* already finished */ } }
    this.#exited = true
    sessions.delete(this.pid)
    this.#exit.fire(signal === undefined ? { exitCode } : { exitCode, signal })
  }

  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows }
  clear(): void { /* no scrollback is kept here */ }
  pause(): void { /* output is pushed as it arrives */ }
  resume(): void { /* output is pushed as it arrives */ }
  kill(signal?: string): void {
    // SIGINT stops the running command, or clears the line at an idle prompt; it never ends the shell.
    if (signal === 'SIGINT') { if (this.#child) this.#interrupt(); else { this.#line = ''; this.#out('^C\n'); this.#showPrompt(130) } return }
    this.#finish(signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : 0, signal === 'SIGKILL' ? 9 : 15)
  }
}

type Identity = { pid: number, started: string }
function owner(pid: number): WorkerPty | undefined {
  for (const session of sessions.values()) if (session.pid === pid || session.childPid === pid) return session
  return undefined
}
function members(session: WorkerPty): Identity[] {
  const child = session.childPid
  return [{ pid: session.pid, started: session.started }, ...child === undefined ? [] : [{ pid: child, started: session.started }]]
}
const alive = (identity: Identity): boolean => {
  const session = owner(identity.pid)
  return session !== undefined && !session.exited && (identity.pid === session.pid || identity.pid === session.childPid)
}
/**
 * dsh's subprocess-local inspects OS processes (process trees, the foreground group, stdin waits) to know when a
 * terminal is ready and to clean it up. The Worker has no OS processes, so prepare.py makes createProcessInspector()
 * return this, which answers from the sessions above: idle at the prompt means the shell is waiting on stdin.
 */
export const dishProcessInspector = {
  foregroundPgid: (shellPid: number): number | undefined => sessions.get(shellPid)?.foreground,
  isStdinWaiting: (pgid: number, shellPid: number): boolean => { const session = sessions.get(shellPid); return session !== undefined && pgid === shellPid && session.idle },
  snapshot: () => ({
    complete: true,
    tree: (rootPid: number): Identity[] => { const session = sessions.get(rootPid); return session ? members(session) : [] },
    session: (sessionId: number): Identity[] => { const session = sessions.get(sessionId); return session ? members(session) : [] },
    alive,
  }),
  isAlive: alive,
  signalGroup(pgid: number, signal: string): void {
    const session = owner(pgid)
    if (!session) return
    if (pgid === session.childPid && signal !== 'SIGKILL') session.interrupt()
    else session.kill(signal)
  },
  signalProcess(identity: Identity, signal: 'SIGTERM' | 'SIGKILL'): void { owner(identity.pid)?.kill(signal) },
}

/**
 * Start a shell session.
 * @param file - the shell, kept for display.
 * @param args - its arguments (the Worker's interpreter takes none).
 * @param options - cwd, env (PROMPT_COMMAND and PS1 included), cols and rows.
 * @returns the session.
 */
export function spawn(file: string, args: readonly string[] | string = [], options: Options = {}): WorkerPty {
  return new WorkerPty(file, typeof args === 'string' ? [args] : args, options)
}

/**
 * Open a pseudo-terminal pair (unavailable: Dish has no device files).
 * @returns Never.
 */
export function open(): never {
  throw new Error('node-pty.open is not available in Dish')
}

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default { spawn, open }
