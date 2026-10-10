import type { ToolDeps } from '../types.js'
import { clampInt } from './screenshot.js'
import { renderUi, detailOf } from './format.js'

/**
 * UI Automation tools. This is the accessibility-first path: reading a control
 * tree and invoking controls by ref is far cheaper and far more reliable than
 * screenshot-look-click. The bridge keeps a session-scoped element registry,
 * so `ref` integers stay valid across calls until the owning window goes away.
 */

const UIA_ACTIONS = 'tree | find | invoke | set_value | focus'
/** UIA tree views the bridge accepts; anything else falls back to its default. */
const UIA_VIEWS = new Set(['control', 'content', 'raw'])

export const uiTool = {
  name: 'computer_ui',
  description: `Read and drive UI through Windows UI Automation (works without vision). action: ${UIA_ACTIONS}. ` +
    "tree: dump a compact control tree for a window (use first to understand an app; unnamed layout wrappers are filtered out and password fields are redacted — detail:'full' shows every node); " +
    "find: locate controls by name/automationId and get their refs; " +
    "invoke/set_value/focus: act on a ref from a previous tree or find call. " +
    'Refs stay valid while the window lives. Prefer this over screenshots for buttons, fields and menus.',
  parameters: {
    action: { type: 'string', required: true, description: UIA_ACTIONS },
    handle: { type: 'integer', description: 'Window handle (hwnd). Optional for find when automationId is unique.' },
    name: { type: 'string', description: 'Control name substring to find.' },
    automationId: { type: 'string', description: 'Exact automationId to find.' },
    controlType: { type: 'string', description: 'Filter by role, e.g. Button, Edit, MenuItem.' },
    ref: { type: 'integer', description: 'Control ref from a previous tree/find, for invoke/set_value/focus.' },
    value: { type: 'string', description: "New value (action='set_value')." },
    maxDepth: { type: 'integer', description: "Tree depth cap (action='tree'). Default from settings." },
    maxNodes: { type: 'integer', description: 'Node cap; response is truncated beyond it.' },
    view: {
      type: 'string',
      description:
        "UIA view for action='tree'. 'control' (default) lists real controls and skips layout-only containers; " +
        "'content' keeps content elements; 'raw' exposes every provider element when something seems missing.",
    },
    detail: { type: 'string', description: "'compact' (default: one line per control) or 'full' (raw JSON with rects/runtime ids)." },
  },
  output: { schema: { type: 'object' }, render: (a: unknown, v: unknown) => [{ type: 'text', text: renderUi(a, v) }] },
  timeoutMs: 45_000,
  isConcurrencySafe: (args: unknown) => (args as { action?: string })?.action === 'tree',
  async execute(args: Record<string, unknown>) {
    const deps = currentDeps
    if (!deps) throw new Error('ui tool is not wired')
    const cfg = deps.config()
    if (!cfg.enabled) throw new Error('computer-use is disabled in settings')

    const action = String(args.action ?? '')
    const handle = typeof args.handle === 'number' ? args.handle : undefined

    if (action === 'tree') {
      // The stricter of the caller's cap and the configured cap wins: a model
      // can narrow a request but never widen it past the configured budget.
      const requestedDepth = clampInt(args.maxDepth, 1, 20)
      const requestedNodes = clampInt(args.maxNodes, 1, cfg.uiaMaxNodes)
      return {
        action,
        ...(await deps.call('uia.tree', {
          handle,
          maxDepth: Math.min(requestedDepth ?? cfg.uiaMaxDepth, cfg.uiaMaxDepth),
          maxNodes: Math.min(requestedNodes ?? cfg.uiaMaxNodes, cfg.uiaMaxNodes),
          view: typeof args.view === 'string' && UIA_VIEWS.has(args.view) ? args.view : undefined,
          // detail:'full' means "everything": no interactive filter either.
          filter: detailOf(args) === 'full' ? 'all' : undefined,
        })),
      }
    }
    if (action === 'find') {
      const requestedLimit = clampInt(args.maxNodes, 1, cfg.uiaMaxNodes)
      return {
        action,
        ...(await deps.call('uia.find', {
          handle,
          name: typeof args.name === 'string' ? args.name : undefined,
          automationId: typeof args.automationId === 'string' ? args.automationId : undefined,
          controlType: typeof args.controlType === 'string' ? args.controlType : undefined,
          limit: Math.min(requestedLimit ?? 50, cfg.uiaMaxNodes),
        })),
      }
    }
    if (action === 'invoke' || action === 'focus' || action === 'set_value') {
      const ref = typeof args.ref === 'number' ? args.ref : undefined
      const bridgeAction = action === 'set_value' ? 'setValue' : action
      const payload: Record<string, unknown> = {
        ref,
        handle,
        name: typeof args.name === 'string' ? args.name : undefined,
        automationId: typeof args.automationId === 'string' ? args.automationId : undefined,
        action: bridgeAction,
        value: typeof args.value === 'string' ? args.value : undefined,
      }
      return { action, ...(await deps.call('uia.invoke', payload)) }
    }
    throw new Error(`unknown ui action '${action}'; expected one of: ${UIA_ACTIONS}`)
  },
}

export let currentDeps: ToolDeps | undefined
export function setDeps(deps: ToolDeps | undefined): void {
  currentDeps = deps
}
