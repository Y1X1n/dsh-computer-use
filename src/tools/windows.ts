import type { ToolDeps } from '../types.js'
import { clampInt } from './screenshot.js'
import { renderWindows } from './format.js'

/**
 * Window management and clipboard tools: enumerate, focus, resize, launch,
 * plus clipboard get/set. Window handles (hwnd) are the stable currency
 * between computer_window, computer_screenshot (target=window) and computer_ui.
 */

/**
 * Chromium browsers hide their page from UI Automation until renderer
 * accessibility is switched on, which is the difference between "the agent can
 * read and click real controls" and "the agent sees nothing but empty panes".
 * The flag is added here rather than demanded from the caller so the common
 * case just works; `computer-use.browserUiaFlags` turns it off.
 */
const CHROMIUM_BROWSERS = new Set(['chrome.exe', 'msedge.exe', 'brave.exe', 'chromium.exe', 'vivaldi.exe'])
const A11Y_FLAG = '--force-renderer-accessibility'

function isChromiumBrowser(command: string): boolean {
  const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return CHROMIUM_BROWSERS.has(base)
}

export const windowTool = {
  name: 'computer_window',
  description: 'Manage desktop windows: list, focus, minimize/maximize/restore/close, launch an app. ' +
    'Returns handles (hwnd) used by computer_screenshot and computer_ui. ' +
    'Focus a window before typing into it.',
  parameters: {
    action: { type: 'string', required: true, description: "'list' | 'focus' | 'minimize' | 'maximize' | 'restore' | 'close' | 'launch'" },
    handle: { type: 'integer', description: 'Window handle (hwnd) for focus/state actions.' },
    title: { type: 'string', description: "Substring match for focus when no handle is known." },
    command: { type: 'string', description: "Executable or shell command to launch (action='launch')." },
    args: { type: 'array', description: "Launch arguments (action='launch')." },
    cwd: { type: 'string', description: "Working directory (action='launch')." },
    detail: { type: 'string', description: "'compact' (default: 'hwnd pid [min,fg] title' per line) or 'full' (raw JSON incl. className/rect)." },
  },
  output: { schema: { type: 'object' }, render: (a: unknown, v: unknown) => [{ type: 'text', text: renderWindows(a, v) }] },
  timeoutMs: 30_000,
  isConcurrencySafe: (args: unknown) => (args as { action?: string })?.action === 'list',
  async execute(args: Record<string, unknown>) {
    const deps = currentDeps
    if (!deps) throw new Error('window tool is not wired')
    const cfg = deps.config()
    if (!cfg.enabled) throw new Error('computer-use is disabled in settings')

    const action = String(args.action ?? '')
    switch (action) {
      case 'list': {
        const r = (await deps.call('window.list', { limit: cfg.windowLimit })) as {
          windows?: Array<Record<string, unknown>>
        }
        const rows = (r.windows ?? []).map((w) => ({
          handle: w.handle,
          pid: w.pid,
          title: clip(String(w.title ?? ''), 120),
          className: clip(String(w.className ?? ''), 60),
          rect: [w.x, w.y, w.width, w.height],
          minimized: w.minimized === true,
          foreground: w.foreground === true,
        }))
        return { count: rows.length, windows: rows }
      }
      case 'focus': {
        const handle = typeof args.handle === 'number' ? args.handle : 0
        const title = typeof args.title === 'string' ? args.title : undefined
        if (!handle && !title) throw new Error('focus requires handle or title')
        return { action, ...(await deps.call('window.focus', handle ? { handle } : { title })) }
      }
      case 'minimize':
      case 'maximize':
      case 'restore':
      case 'close': {
        const handle = typeof args.handle === 'number' ? args.handle : 0
        if (!handle) throw new Error(`${action} requires handle`)
        return { action, ...(await deps.call('window.state', { handle, state: action })) }
      }
      case 'launch': {
        const command = typeof args.command === 'string' ? args.command.trim() : ''
        if (!command) throw new Error('launch requires command')
        const launchArgs = Array.isArray(args.args) ? args.args.map(String) : []
        // A Chromium browser started without renderer accessibility publishes no
        // page content to UIA; add the flag unless the caller already decided.
        if (cfg.browserUiaFlags && isChromiumBrowser(command) && !launchArgs.includes(A11Y_FLAG)) {
          launchArgs.push(A11Y_FLAG)
        }
        const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : undefined
        return { action, launchArgs, ...(await deps.call('window.launch', { command, args: launchArgs, cwd })) }
      }
      default:
        throw new Error(`unknown window action '${action}'`)
    }
  },
}

export const clipboardTool = {
  name: 'computer_clipboard',
  description: 'Read or write the system clipboard. Useful for moving large text into an app ' +
    '(set, then press ctrl+v) instead of typing it character by character.',
  parameters: {
    action: { type: 'string', required: true, description: "'get' | 'set'" },
    text: { type: 'string', description: "Text to place on the clipboard (action='set')." },
  },
  output: { schema: { type: 'object' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: compact(v) }] },
  timeoutMs: 10_000,
  isConcurrencySafe: (args: unknown) => (args as { action?: string })?.action === 'get',
  async execute(args: Record<string, unknown>) {
    const deps = currentDeps
    if (!deps) throw new Error('clipboard tool is not wired')
    if (!deps.config().enabled) throw new Error('computer-use is disabled in settings')

    const action = String(args.action ?? '')
    if (action === 'get') {
      const r = (await deps.call('clipboard.get')) as { text?: string }
      const text = r.text ?? ''
      return { length: text.length, preview: clip(text, 4000), text: text.length <= 4000 ? text : undefined }
    }
    if (action === 'set') {
      const text = typeof args.text === 'string' ? args.text : ''
      if (!text) throw new Error('set requires text')
      await deps.call('clipboard.set', { text })
      return { ok: true, length: text.length }
    }
    throw new Error(`unknown clipboard action '${action}'`)
  },
}

function compact(value: unknown): string {
  try { return JSON.stringify(value) } catch { return String(value) }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

export let currentDeps: ToolDeps | undefined
export function setDeps(deps: ToolDeps | undefined): void {
  currentDeps = deps
}
