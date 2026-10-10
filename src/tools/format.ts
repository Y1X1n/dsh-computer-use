/**
 * Model-facing renderers.
 *
 * The bridge answers with dense JSON, and JSON is the most expensive way to say
 * the same thing: a 150-node UIA tree JSON-encoded is thousands of tokens per
 * observation, while one line per node is hundreds. Every observation the agent
 * reads is rendered here instead of being passed through `JSON.stringify`, and
 * `detail: "full"` restores the raw value for the rare caller that wants every
 * field (rects, class names, the whole pattern list).
 *
 * Token rules of thumb baked in:
 *   - one line per record, no nested objects, no repeated key names;
 *   - drop fields that never change a decision (rect, className) unless asked;
 *   - clip free text instead of truncating the record away;
 *   - state the counts/truncation in a one-line header, so the agent knows
 *     whether it is looking at everything.
 */

export type Detail = 'compact' | 'full'

export function detailOf(args: unknown): Detail {
  const raw = (args as { detail?: unknown } | undefined)?.detail
  return raw === 'full' ? 'full' : 'compact'
}

export function compactJson(value: unknown): string {
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** Pattern name → the single verb the agent actually needs. */
const FLAG_BY_PATTERN: Record<string, string> = {
  Invoke: 'press',
  Toggle: 'toggle',
  SelectionItem: 'select',
  ExpandCollapse: 'expand',
  Value: 'edit',
  RangeValue: 'range',
  Text: 'text',
  Window: 'win',
  Transform: 'move',
  Focus: 'focus',
  ScrollItem: 'scroll',
  ItemContainer: 'item',
}

const NOISE = new Set(['scroll', 'move', 'item', 'text', 'range'])

function flagList(patterns: unknown): string {
  if (!Array.isArray(patterns)) return ''
  const flags: string[] = []
  for (const p of patterns) {
    const flag = FLAG_BY_PATTERN[String(p)]
    if (flag && !flags.includes(flag)) flags.push(flag)
  }
  const meaningful = flags.filter((f) => !NOISE.has(f))
  return (meaningful.length ? meaningful : flags.slice(0, 1)).slice(0, 4).join(',')
}

interface UiNode {
  ref?: number | string
  depth?: number
  role?: string
  name?: string
  automationId?: string
  patterns?: unknown
  enabled?: boolean
  offscreen?: boolean
  password?: boolean
}

/** State that changes how the agent should treat a control, not what it can do. */
function stateList(node: UiNode): string {
  const states: string[] = []
  if (node.password === true) states.push('pw')
  if (node.enabled === false) states.push('dis')
  if (node.offscreen === true) states.push('off')
  return states.length ? `[${states.join(',')}]` : ''
}

function nodeLine(node: UiNode, indent: boolean): string {
  const ref = node.ref ?? 0
  const role = node.role ?? '?'
  const name = clip(String(node.name ?? ''), 60)
  const flags = flagList(node.patterns)
  const states = stateList(node)
  const parts = [String(ref), role]
  if (name) parts.push(`"${name}"`)
  if (flags) parts.push(flags)
  if (states) parts.push(states)
  if (node.automationId) parts.push('#' + clip(String(node.automationId), 40))
  const prefix = indent ? '  '.repeat(Math.min(Math.max(node.depth ?? 0, 0), 6)) : ''
  return prefix + parts.join(' ')
}

/**
 * Chromium windows publish no web content to UI Automation until the browser is
 * started with renderer accessibility on. The empty tree is the only symptom the
 * agent can observe, so name the fix right there instead of letting it retry.
 */
const CHROMIUM_HINT =
  'hint: this window exposes no UIA tree. If it is a Chromium app (Chrome/Edge), ' +
  'relaunch it through computer_window launch, which adds --force-renderer-accessibility.'

export function renderUi(args: unknown, value: unknown): string {
  if (detailOf(args) === 'full') return compactJson(value)
  const v = (value ?? {}) as {
    action?: string
    nodes?: UiNode[]
    matches?: UiNode[]
    count?: number
    hidden?: number
    truncated?: boolean
    ref?: number
    ok?: boolean
  }

  if (Array.isArray(v.nodes)) {
    const rows = v.nodes.map((n) => nodeLine(n, true))
    const bits = [`nodes=${rows.length}`]
    const hidden = typeof v.hidden === 'number' ? v.hidden : 0
    if (hidden > 0) bits.push(`hidden=${hidden}`)
    if (v.truncated) bits.push('truncated=true')
    const header = `tree ${bits.join(' ')}`
    if (!rows.length) return [header, CHROMIUM_HINT].join('\n')
    const notes: string[] = []
    if (hidden > 0) notes.push(`${hidden} unnamed wrappers hidden (detail:"full" shows every node)`)
    if (v.truncated) notes.push('hit the node cap; raise maxNodes or narrow with find')
    const body = [header, ...rows].join('\n')
    return notes.length ? body + '\n(' + notes.join('; ') + ')' : body
  }

  if (Array.isArray(v.matches)) {
    if (!v.matches.length) return 'find matches=0' + '\n' + CHROMIUM_HINT
    return [`find matches=${v.matches.length}`, ...v.matches.map((n) => nodeLine(n, false))].join('\n')
  }

  // Action results (invoke/set_value/focus) are already tiny.
  return compactJson(value)
}

export function renderWindows(args: unknown, value: unknown): string {
  if (detailOf(args) === 'full') return compactJson(value)
  const v = (value ?? {}) as { count?: number; windows?: Array<Record<string, unknown>> }
  const rows = v.windows ?? []
  if (!rows.length) return 'windows: 0'
  const lines = rows.map((w) => {
    const flags = [w.minimized === true ? 'min' : '', w.foreground === true ? 'fg' : ''].filter(Boolean).join(',')
    const title = clip(String(w.title ?? ''), 70)
    return `${w.handle} ${w.pid}${flags ? ' [' + flags + ']' : ''} ${title}`.trimEnd()
  })
  return [`windows: ${v.count ?? rows.length} (hwnd pid [min,fg] title)`, ...lines].join('\n')
}

/**
 * A wait is one line: what was watched, whether it happened, how long it took and
 * what was found — the ref included, so the next call can act without observing
 * again.
 */
export function renderWait(args: unknown, value: unknown): string {
  if (detailOf(args) === 'full') return compactJson(value)
  const v = (value ?? {}) as {
    condition?: string
    absent?: boolean
    satisfied?: boolean
    waitedMs?: number
    polls?: number
    window?: { handle?: number; title?: string }
    control?: { ref?: number; role?: string; name?: string }
  }
  const a = (args ?? {}) as { title?: string; name?: string; automationId?: string; controlType?: string }
  const subject =
    v.condition === 'window'
      ? `window "${clip(String(a.title ?? ''), 40)}"`
      : `control ${[a.controlType, a.name ? `"${clip(a.name, 40)}"` : '', a.automationId ? '#' + a.automationId : '']
          .filter(Boolean)
          .join(' ')}`
  const verdict = v.satisfied ? 'ok' : 'timeout'
  const bits = [
    `wait ${v.absent ? 'absent ' : ''}${subject} -> ${verdict} in ${v.waitedMs ?? 0}ms polls=${v.polls ?? 0}`,
  ]
  if (v.window?.handle) bits.push(`hwnd=${v.window.handle}`)
  if (v.control?.ref !== undefined) {
    bits.push(`ref=${v.control.ref} ${v.control.role ?? ''} "${clip(String(v.control.name ?? ''), 40)}"`)
  }
  return bits.join(' ')
}

export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}
