import type { ToolDeps } from '../types.js'
import { clampInt } from './screenshot.js'
import { renderWait } from './format.js'

/**
 * Bounded waiting. An agent that polls by repeating a full observation pays for
 * that observation on every attempt; this asks the same question once, polls
 * cheaply inside the call, and hands back the element it found (ref included) so
 * the next call can act on it without re-observing first.
 *
 * The wait is bounded twice: by its own timeout and by the caller's abort signal.
 */

const CONDITIONS = "'window' | 'control'"
const MAX_TIMEOUT_MS = 30_000
const MIN_POLL_MS = 50

let currentDeps: ToolDeps | undefined

export function setDeps(deps: ToolDeps | undefined): void {
  currentDeps = deps
}

interface WaitHit {
  window?: { handle?: number; title?: string }
  control?: { ref?: number; role?: string; name?: string; automationId?: string }
}

function errorCode(error: unknown): string {
  return String((error as { code?: unknown })?.code ?? '')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(new Error('wait was cancelled'))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort)
  })
}

/** One polling attempt; returns null while the condition does not hold yet. */
async function probe(deps: ToolDeps, condition: string, args: Record<string, unknown>): Promise<WaitHit | null> {
  const cfg = deps.config()
  if (condition === 'window') {
    const title = String(args.title ?? '')
    if (!title) throw new Error("condition='window' requires a title substring")
    const listed = (await deps.call('window.list', { limit: cfg.windowLimit })) as {
      windows?: Array<{ handle?: number; title?: string }>
    }
    const wanted = title.toLowerCase()
    const found = (listed.windows ?? []).find((w) => String(w.title ?? '').toLowerCase().includes(wanted))
    return found ? { window: { handle: found.handle, title: found.title } } : null
  }

  const name = typeof args.name === 'string' ? args.name : undefined
  const automationId = typeof args.automationId === 'string' ? args.automationId : undefined
  const controlType = typeof args.controlType === 'string' ? args.controlType : undefined
  if (!name && !automationId && !controlType) {
    throw new Error("condition='control' requires one of name / automationId / controlType")
  }
  const handle = typeof args.handle === 'number' ? args.handle : undefined
  try {
    const found = (await deps.call('uia.find', { handle, name, automationId, controlType, limit: 5 })) as {
      matches?: Array<{ ref?: number; role?: string; name?: string; automationId?: string }>
    }
    const match = (found.matches ?? [])[0]
    if (!match) return null
    return {
      window: handle === undefined ? undefined : { handle },
      control: { ref: match.ref, role: match.role, name: match.name, automationId: match.automationId },
    }
  } catch (error) {
    // A window that closed while we waited is an answer, not a failure.
    if (errorCode(error) === 'HWND_NOT_FOUND' || errorCode(error) === 'NOT_FOUND') return null
    throw error
  }
}

export const waitTool = {
  name: 'computer_wait',
  description:
    'Wait for one UI condition with bounded polling, instead of re-reading the tree or taking screenshots in a loop. ' +
    `condition: ${CONDITIONS}. 'window' waits until a window whose title contains ` +
    "`title` exists; 'control' waits until a control matching name/automationId/controlType exists. " +
    'absent=true waits for it to disappear instead. On success the result carries the matched hwnd and control ref, ' +
    'so the next call can act immediately. Returns satisfied:false on timeout — it does not throw.',
  parameters: {
    condition: { type: 'string', required: true, description: CONDITIONS },
    title: { type: 'string', description: "condition='window': substring of the window title." },
    handle: { type: 'integer', description: "condition='control': limit the search to this window (hwnd)." },
    name: { type: 'string', description: "condition='control': control name substring." },
    automationId: { type: 'string', description: "condition='control': exact automationId." },
    controlType: { type: 'string', description: "condition='control': role filter, e.g. Button, Edit, Document." },
    absent: { type: 'boolean', description: 'Wait until the condition no longer holds. Default false.' },
    timeoutMs: { type: 'integer', description: 'Give up after this long (default from settings, max 30000).' },
    pollMs: { type: 'integer', description: 'Poll interval in ms (default from settings, min 50).' },
  },
  output: { schema: { type: 'object' }, render: (a: unknown, v: unknown) => [{ type: 'text', text: renderWait(a, v) }] },
  timeoutMs: MAX_TIMEOUT_MS + 10_000,
  isConcurrencySafe: () => false,
  async execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }) {
    const deps = currentDeps
    if (!deps) throw new Error('wait tool is not wired')
    const cfg = deps.config()
    if (!cfg.enabled) throw new Error('computer-use is disabled in settings')

    const condition = String(args.condition ?? '')
    if (condition !== 'window' && condition !== 'control') {
      throw new Error(`condition must be ${CONDITIONS}`)
    }
    const absent = args.absent === true
    const timeoutMs = Math.min(clampInt(args.timeoutMs, 1, MAX_TIMEOUT_MS) ?? cfg.waitTimeoutMs, MAX_TIMEOUT_MS)
    const pollMs = Math.max(clampInt(args.pollMs, MIN_POLL_MS, 5_000) ?? cfg.waitPollMs, MIN_POLL_MS)

    const started = Date.now()
    let polls = 0
    let last: WaitHit | null = null
    for (;;) {
      if (exec?.signal?.aborted) throw new Error('wait was cancelled')
      polls += 1
      const hit = await probe(deps, condition, args)
      if (hit) last = hit
      const satisfied = absent ? hit === null : hit !== null
      if (satisfied) {
        return { condition, absent, satisfied: true, waitedMs: Date.now() - started, polls, ...(hit ?? {}) }
      }
      const elapsed = Date.now() - started
      if (elapsed + pollMs > timeoutMs) {
        // A timeout is an answer the agent can act on, not an exception.
        return { condition, absent, satisfied: false, waitedMs: Date.now() - started, polls, ...(last ?? {}) }
      }
      await sleep(pollMs, exec?.signal)
    }
  },
}
