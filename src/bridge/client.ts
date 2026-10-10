import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import type {
  BridgeClientOptions,
  BridgeFrame,
  BridgeOkFrame,
  BridgeReadyFrame,
  BridgeRequest,
  CallOptions,
} from './protocol.js'

export type { BridgeClientOptions, CallOptions } from './protocol.js'

/** Error shape thrown to callers on any bridge failure. */
export class BridgeCallError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BridgeCallError'
    this.code = code
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: BridgeCallError) => void
  timer: NodeJS.Timeout
  op: string
}

const RESTART_AFTER_CONSECUTIVE_TIMEOUTS = 2
const HANDSHAKE_TIMEOUT_MS = 20_000

/**
 * Node side of the persistent PowerShell bridge. One client owns one child
 * process; requests are strictly serial (the bridge answers in request order)
 * and every call is id-correlated with its own timeout.
 *
 * Failure policy:
 *  - a timed-out call is rejected but the child is left running (it may still
 *    be chewing on the request); only 2 consecutive timeouts trigger a restart
 *  - if the child exits unexpectedly, pending calls reject with BRIDGE_EXITED
 *    and the next call transparently starts a fresh process
 */
export interface BridgeClient {
  call<T = unknown>(op: string, args?: Record<string, unknown>, options?: CallOptions): Promise<T>
  dispose(): Promise<void>
  /** True while a child process is believed alive. */
  isRunning(): boolean
}

export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
  const defaultTimeoutMs = options.timeoutMs ?? 60_000
  const shellPath = options.shellPath ?? 'powershell.exe'
  const log = options.log ?? (() => undefined)

  let child: ChildProcess | null = null
  let childUsable = false
  let starting: Promise<void> | null = null
  let activeStartReject: ((error: BridgeCallError) => void) | null = null
  let disposed = false
  let nextId = 1
  let consecutiveTimeouts = 0

  const pending = new Map<number, Pending>()
  const queue: Array<() => void> = []
  let inFlight = false

  function pump(): void {
    if (inFlight || disposed) return
    const next = queue.shift()
    if (!next) return
    inFlight = true
    next()
  }

  function failPending(code: string, message: string): void {
    const entries = [...pending.values()]
    pending.clear()
    inFlight = false
    for (const entry of entries) {
      clearTimeout(entry.timer)
      entry.reject(new BridgeCallError(code, `${entry.op}: ${message}`))
    }
  }

  function killChild(): void {
    const proc = child
    if (!proc) return
    childUsable = false
    try { proc.kill() } catch { /* already gone */ }
  }

  function start(): Promise<void> {
    if (disposed) {
      return Promise.reject(new BridgeCallError('BRIDGE_DISPOSED', 'client was disposed'))
    }
    if (starting) return starting
    if (child && childUsable) return Promise.resolve()

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false
      const finishResolve = (): void => {
        if (settled) return
        settled = true
        starting = null
        activeStartReject = null
        resolve()
      }
      const finishReject = (error: BridgeCallError): void => {
        if (settled) return
        settled = true
        starting = null
        activeStartReject = null
        reject(error)
      }
      activeStartReject = finishReject

      if (!existsSync(options.scriptPath)) {
        finishReject(new BridgeCallError('BRIDGE_SCRIPT_MISSING', `bridge script not found: ${options.scriptPath}`))
        return
      }

      const spawnImpl = options.spawnImpl ?? spawn
      let proc: ChildProcess
      try {
        proc = spawnImpl(
          shellPath,
          ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', options.scriptPath],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        )
      } catch (error) {
        finishReject(new BridgeCallError('BRIDGE_SPAWN_FAILED', (error as Error).message))
        return
      }
      child = proc
      childUsable = true

      let ready = false
      let lineBuffer = ''
      let handshakeTimer: NodeJS.Timeout | null = setTimeout(() => {
        handshakeTimer = null
        if (!ready) {
          killChild()
          finishReject(new BridgeCallError('BRIDGE_HANDSHAKE_TIMEOUT', 'bridge did not send its ready line within 20s'))
        }
      }, HANDSHAKE_TIMEOUT_MS)

      const handleFrame = (line: string): void => {
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { return }
        if (!parsed || typeof parsed !== 'object') return
        const frame = parsed as Partial<BridgeFrame>
        if (typeof frame.id !== 'number') return
        const entry = pending.get(frame.id)
        if (!entry) return
        pending.delete(frame.id)
        clearTimeout(entry.timer)
        inFlight = false
        consecutiveTimeouts = 0
        if (frame.ok === false) {
          const error = frame.error
          entry.reject(new BridgeCallError(error?.code ?? 'BRIDGE_ERROR', error?.message ?? 'bridge reported failure'))
        } else {
          const okFrame = frame as Partial<BridgeOkFrame>
          entry.resolve(okFrame.result)
        }
        pump()
      }

      const onLine = (line: string): void => {
        if (ready) {
          handleFrame(line)
          return
        }
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { return }
        if (!parsed || typeof parsed !== 'object') return
        const frame = parsed as Partial<BridgeReadyFrame>
        if (frame.ready !== true) return
        ready = true
        if (handshakeTimer) {
          clearTimeout(handshakeTimer)
          handshakeTimer = null
        }
        log(`[bridge] ready v${String(frame.version)} (${String(frame.platform)})`)
        finishResolve()
      }

      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (chunk: string) => {
        lineBuffer += chunk
        let index = lineBuffer.indexOf('\n')
        while (index >= 0) {
          const line = lineBuffer.slice(0, index).replace(/\r$/, '')
          lineBuffer = lineBuffer.slice(index + 1)
          if (line.trim()) onLine(line)
          index = lineBuffer.indexOf('\n')
        }
      })

      proc.stderr?.setEncoding('utf8')
      proc.stderr?.on('data', (chunk: string) => {
        const text = chunk.trim()
        if (text) log(`[bridge:stderr] ${text}`)
      })

      // Prevent an EPIPE on a dying child from crashing the host process.
      proc.stdin?.on('error', (error: Error) => {
        log(`[bridge:stdin] ${error.message}`)
      })

      proc.on('exit', () => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer)
          handshakeTimer = null
        }
        if (child === proc) {
          child = null
          childUsable = false
        }
        if (!ready) {
          finishReject(new BridgeCallError('BRIDGE_EXITED', 'bridge exited before the ready handshake'))
        } else if (!disposed) {
          log('[bridge] exited unexpectedly')
          failPending('BRIDGE_EXITED', 'the bridge process exited before responding')
          pump()
        }
      })

      proc.on('error', (error) => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer)
          handshakeTimer = null
        }
        if (child === proc) {
          child = null
          childUsable = false
        }
        finishReject(new BridgeCallError('BRIDGE_SPAWN_FAILED', error.message))
        if (!disposed) {
          failPending('BRIDGE_SPAWN_FAILED', error.message)
          pump()
        }
      })
    })
    starting = promise
    return promise
  }

  async function call<T>(op: string, args?: Record<string, unknown>, callOptions?: CallOptions): Promise<T> {
    if (disposed) throw new BridgeCallError('BRIDGE_DISPOSED', 'client was disposed')
    await start()

    return await new Promise<T>((resolve, reject) => {
      const run = (): void => {
        if (disposed) {
          inFlight = false
          pump()
          reject(new BridgeCallError('BRIDGE_DISPOSED', 'client was disposed'))
          return
        }
        if (!child || !childUsable) {
          inFlight = false
          pump()
          reject(new BridgeCallError('BRIDGE_EXITED', 'bridge process is not running'))
          return
        }
        const id = nextId++
        const request: BridgeRequest = { id, op }
        if (args !== undefined) request.args = args
        const timeoutMs = callOptions?.timeoutMs ?? defaultTimeoutMs

        const timer = setTimeout(() => {
          pending.delete(id)
          consecutiveTimeouts++
          inFlight = false
          if (consecutiveTimeouts >= RESTART_AFTER_CONSECUTIVE_TIMEOUTS) {
            consecutiveTimeouts = 0
            log('[bridge] consecutive timeouts; restarting the child')
            killChild()
          }
          reject(new BridgeCallError('BRIDGE_TIMEOUT', `${op} did not answer within ${timeoutMs}ms`))
          pump()
        }, timeoutMs)

        pending.set(id, {
          resolve: resolve as unknown as (value: unknown) => void,
          reject,
          timer,
          op,
        })
        try {
          child.stdin?.write(JSON.stringify(request) + '\n')
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          inFlight = false
          killChild()
          reject(new BridgeCallError('BRIDGE_WRITE_FAILED', (error as Error).message))
          pump()
        }
      }
      queue.push(run)
      pump()
    })
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    const rejectStart = activeStartReject
    activeStartReject = null
    rejectStart?.(new BridgeCallError('BRIDGE_DISPOSED', 'client was disposed'))
    failPending('BRIDGE_DISPOSED', 'client was disposed')
    queue.length = 0
    const proc = child
    child = null
    childUsable = false
    starting = null
    if (!proc) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* gone */ }
        resolve()
      }, 1500)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try { proc.stdin?.end() } catch { /* already closed */ }
    })
  }

  return {
    call,
    dispose,
    isRunning: () => child !== null && childUsable,
  }
}
