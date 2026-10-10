import type { BlockLike, ToolDeps } from '../types.js'

/**
 * Screenshot tool. Captures a monitor, a window, or a region through the
 * bridge, persists the PNG/JPEG to disk, and — only when the current model
 * route declares image input — projects it as a durable image block. When the
 * model cannot see images, the result degrades to the file path plus metadata
 * so the agent can still act on it (open, attach, diff) without burning
 * base64 tokens.
 */

export const screenshotTool = {
  name: 'computer_screenshot',
  description:
    'Capture the screen, a window, or a region. Returns the saved image path with dimensions, ' +
    'and attaches the image itself when the current model accepts image input. ' +
    'Use it to see what the user sees before/after acting, and to verify your own clicks. ' +
    'Prefer computer_ui (read-tree / invoke) over vision when a control is exposed via accessibility, ' +
    'because it is cheaper and more reliable than reading pixels.',
  parameters: {
    target: {
      type: 'string',
      description: "'screen' (whole monitor), 'window', or 'region'. Default 'screen'.",
    },
    windowHandle: {
      type: 'integer',
      description: "Native window handle (hwnd) when target='window'. Get one from computer_window list.",
    },
    region: {
      type: 'object',
      description: "x/y/width/height in virtual-screen coordinates when target='region'.",
    },
    monitor: {
      type: 'integer',
      description: '1-based monitor index when target=screen. Default 1.',
    },
    maxEdge: {
      type: 'integer',
      description: 'Longest-edge cap in px before encoding. Lower saves image tokens. Default from settings.',
    },
    returnImage: {
      type: 'boolean',
      description: 'Attach the image to the reply. Default true; set false to only get the path.',
    },
  },
  output: {
    schema: {
      type: 'object',
    },
    render: (_args: unknown, value: unknown) => renderValue(value),
  },
  timeoutMs: 30_000,
  isConcurrencySafe: () => false,
  async execute(args: Record<string, unknown>, exec: { signal: AbortSignal }) {
    return runScreenshot(args, exec.signal)
  },
}

async function runScreenshot(args: Record<string, unknown>, signal: AbortSignal) {
  const deps = currentDeps
  if (!deps) throw new Error('screenshot tool is not wired')
  const cfg = deps.config()
  if (!cfg.enabled) throw new Error('computer-use is disabled in settings (enable it to allow desktop control)')

  const target = typeof args.target === 'string' ? args.target : 'screen'
  const bridgeArgs: Record<string, unknown> = {
    maxEdge: clampInt(args.maxEdge, 160, 2560) ?? cfg.screenshotMaxEdge,
    format: cfg.screenshotQuality >= 100 ? 'png' : 'jpeg',
    quality: cfg.screenshotQuality,
  }
  if (cfg.captureDir) bridgeArgs.dir = cfg.captureDir
  if (cfg.screenshotBudgetKb > 0) bridgeArgs.budgetKb = cfg.screenshotBudgetKb
  if (cfg.screenshotBudgetPixels > 0) bridgeArgs.budgetPixels = cfg.screenshotBudgetPixels
  if (cfg.captureBackend === 'gdi' && target === 'window') bridgeArgs.forceGdi = true

  if (target === 'window') {
    const handle = typeof args.windowHandle === 'number' ? args.windowHandle : 0
    if (!handle) throw new Error("target='window' requires windowHandle from computer_window")
    bridgeArgs.windowHandle = handle
  } else if (target === 'region') {
    const r = asRegion(args.region)
    if (!r) throw new Error("target='region' requires region={x,y,width,height}")
    bridgeArgs.region = r
  } else {
    bridgeArgs.monitor = clampInt(args.monitor, 1, 9) ?? 1
  }

  const result = (await deps.call('screen.capture', bridgeArgs, { timeoutMs: 30_000 })) as {
    path?: string
    width?: number
    height?: number
    bytes?: number
    format?: string
  }

  return {
    ok: true as const,
    path: result.path ?? '',
    width: result.width ?? 0,
    height: result.height ?? 0,
    bytes: result.bytes ?? 0,
    format: result.format ?? 'jpeg',
    target,
  }
}

function renderValue(value: unknown) {
  const v = (value ?? {}) as {
    ok?: boolean
    path?: string
    width?: number
    height?: number
    bytes?: number
    format?: string
    target?: string
    image?: BlockLike
  }
  const summary =
    `captured ${v.target ?? 'screen'} ${v.width}x${v.height} ` +
    `${v.format} ${(v.bytes ?? 0)}B -> ${v.path}`
  const blocks: BlockLike[] = [{ type: 'text', text: summary }]
  if (v.image && v.image.type === 'image') blocks.push(v.image)
  return blocks
}

export function clampInt(raw: unknown, min: number, max: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return Math.min(max, Math.max(min, Math.round(raw)))
}

function asRegion(raw: unknown): { x: number; y: number; width: number; height: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const x = r.x
  const y = r.y
  const width = r.width
  const height = r.height
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return undefined
  return { x, y, width, height }
}

/** Wired by the entry after config resolution; tools read it lazily. */
export let currentDeps: ToolDeps | undefined
export function setDeps(deps: ToolDeps | undefined): void {
  currentDeps = deps
}
