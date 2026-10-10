import type { ToolDeps } from '../types.js'
import { clampInt } from './screenshot.js'

/**
 * Mouse + keyboard input tools. Deliberately two small tools with a narrow
 * action vocabulary instead of one mega-tool: shorter schemas cost fewer
 * tokens on every single request for the whole session.
 */

const MOUSE_ACTIONS = 'move | click | double_click | right_click | middle_click | drag | scroll'

export const mouseTool = {
  name: 'computer_mouse',
  description: `Control the mouse. action: ${MOUSE_ACTIONS}. ` +
    'Coordinates are absolute virtual-screen pixels; get them from computer_screenshot or computer_ui. ' +
    'After clicking an unfamiliar UI, verify with computer_ui find or another screenshot.',
  parameters: {
    action: { type: 'string', required: true, description: MOUSE_ACTIONS },
    x: { type: 'number', description: 'Absolute screen X in pixels.' },
    y: { type: 'number', description: 'Absolute screen Y in pixels.' },
    toX: { type: 'number', description: "Drag destination X (action='drag')." },
    toY: { type: 'number', description: "Drag destination Y (action='drag')." },
    deltaY: { type: 'number', description: "Vertical scroll amount; positive scrolls up (action='scroll')." },
    deltaX: { type: 'number', description: "Horizontal scroll amount (action='scroll')." },
    durationMs: { type: 'number', description: "Drag duration in ms. Default 350." },
  },
  output: { schema: { type: 'object' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v) }] },
  timeoutMs: 20_000,
  isConcurrencySafe: () => false,
  async execute(args: Record<string, unknown>) {
    const deps = currentDeps
    if (!deps) throw new Error('mouse tool is not wired')
    const cfg = deps.config()
    if (!cfg.enabled) throw new Error('computer-use is disabled in settings')

    const action = String(args.action ?? '')
    const x = typeof args.x === 'number' ? args.x : undefined
    const y = typeof args.y === 'number' ? args.y : undefined

    switch (action) {
      case 'move': {
        if (x === undefined || y === undefined) throw new Error('move requires x and y')
        return { action, ...(await deps.call('mouse.move', { x, y })) }
      }
      case 'click':
      case 'double_click':
      case 'right_click':
      case 'middle_click': {
        const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left'
        const count = action === 'double_click' ? 2 : 1
        return {
          action,
          ...(await deps.call('mouse.click', { x, y, button, count })),
        }
      }
      case 'drag': {
        const toX = typeof args.toX === 'number' ? args.toX : undefined
        const toY = typeof args.toY === 'number' ? args.toY : undefined
        if (x === undefined || y === undefined || toX === undefined || toY === undefined) {
          throw new Error('drag requires x, y, toX, toY')
        }
        return {
          action,
          ...(await deps.call('mouse.drag', {
            fromX: x, fromY: y, toX, toY,
            button: 'left',
            durationMs: clampInt(args.durationMs, 50, 5000) ?? 350,
          })),
        }
      }
      case 'scroll': {
        return {
          action,
          ...(await deps.call('mouse.scroll', {
            x, y,
            deltaX: typeof args.deltaX === 'number' ? args.deltaX : 0,
            deltaY: typeof args.deltaY === 'number' ? args.deltaY : 0,
          })),
        }
      }
      default:
        throw new Error(`unknown mouse action '${action}'; expected one of: ${MOUSE_ACTIONS}`)
    }
  },
}

const KEY_NAMES =
  'ctrl, shift, alt, win, enter, esc, tab, space, backspace, delete, insert, home, end, ' +
  'pageup, pagedown, up, down, left, right, f1-f12, 0-9, a-z'

export const keyboardTool = {
  name: 'computer_keyboard',
  description: 'Type text or press key combinations. ' +
    "action='type' sends literal text (Unicode, CJK-safe) into the focused window; " +
    "action='press' sends a key combination such as [\"ctrl\",\"s\"]. " +
    'Focus the right window/control first (computer_window focus, or computer_ui focus on a control).',
  parameters: {
    action: { type: 'string', required: true, description: "'type' | 'press'" },
    text: { type: 'string', description: "Text to type (action='type')." },
    keys: {
      type: 'array',
      description: `Key names, lowest first, e.g. ["ctrl","shift","s"] (action='press'). Names: ${KEY_NAMES}.`,
    },
  },
  output: { schema: { type: 'object' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v) }] },
  timeoutMs: 60_000,
  isConcurrencySafe: () => false,
  async execute(args: Record<string, unknown>) {
    const deps = currentDeps
    if (!deps) throw new Error('keyboard tool is not wired')
    if (!deps.config().enabled) throw new Error('computer-use is disabled in settings')

    const action = String(args.action ?? '')
    if (action === 'type') {
      const text = typeof args.text === 'string' ? args.text : ''
      if (!text) throw new Error("type requires text")
      if (text.length > 20_000) throw new Error(`text too long (${text.length} chars); split it or use the clipboard`)
      const r = (await deps.call('keyboard.type', { text })) as { chars?: number }
      return { action, chars: r.chars ?? text.length }
    }
    if (action === 'press') {
      const keys = Array.isArray(args.keys) ? args.keys.map(String) : []
      if (keys.length === 0) throw new Error("press requires keys, e.g. [\"ctrl\",\"c\"]")
      const r = (await deps.call('keyboard.press', { keys })) as { keys?: string[] }
      return { action, keys: r.keys ?? keys }
    }
    throw new Error(`unknown keyboard action '${action}'; expected 'type' or 'press'`)
  },
}

export let currentDeps: ToolDeps | undefined
export function setDeps(deps: ToolDeps | undefined): void {
  currentDeps = deps
}
