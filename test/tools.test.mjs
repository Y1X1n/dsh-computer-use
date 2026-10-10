/**
 * Tool-layer unit tests. These exercise the argument validation and mapping
 * logic in src/tools/* without touching real Windows APIs, so they run on any
 * OS. Run: node test/tools.test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn as realSpawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createBridgeClient } from '../lib/bridge/client.js'
import {
  screenshotTool,
  setDeps as setScreenshotDeps,
} from '../lib/tools/screenshot.js'
import {
  mouseTool,
  keyboardTool,
  setDeps as setInputDeps,
} from '../lib/tools/input.js'
import {
  windowTool,
  clipboardTool,
  setDeps as setWindowDeps,
} from '../lib/tools/windows.js'
import { uiTool, setDeps as setUiDeps } from '../lib/tools/ui.js'
import { waitTool, setDeps as setWaitDeps } from '../lib/tools/wait.js'

/** Fake bridge: records calls, returns canned results keyed by op. */
function fakeBridge(handlers) {
  const calls = []
  return {
    calls,
    call: async (op, args) => {
      calls.push({ op, args })
      const handler = handlers[op]
      if (!handler) throw new Error(`unexpected op ${op}`)
      return handler(args ?? {})
    },
  }
}

const config = {
  enabled: true,
  screenshotMaxEdge: 1280,
  screenshotQuality: 72,
  uiaMaxNodes: 150,
  uiaMaxDepth: 6,
  windowLimit: 40,
  bridgeTimeoutMs: 30_000,
  captureDir: '',
  captureBackend: 'printwindow',
  screenshotBudgetKb: 190,
  screenshotBudgetPixels: 900_000,
  browserUiaFlags: true,
  overlay: true,
  overlayText: 'Deepseek Harness托管中',
  overlayIdleHideMs: 180_000,
  waitTimeoutMs: 5000,
  waitPollMs: 250,
  observationTtlMs: 180_000,
  takeoverGuard: true,
}

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

console.log('tool tests')

await test('mouse tool maps double_click to count=2', async () => {
  const bridge = fakeBridge({ 'mouse.click': (a) => ({ x: a.x ?? 0, y: a.y ?? 0, button: a.button, count: a.count }) })
  setInputDeps({ call: bridge.call, config: () => config })
  const r = await mouseTool.execute({ action: 'double_click', x: 10, y: 20 }, { signal: new AbortController().signal })
  assert.equal(r.count, 2)
  assert.equal(bridge.calls[0].op, 'mouse.click')
})

await test('mouse tool rejects unknown actions', async () => {
  const bridge = fakeBridge({})
  setInputDeps({ call: bridge.call, config: () => config })
  await assert.rejects(
    () => mouseTool.execute({ action: 'teleport' }, { signal: new AbortController().signal }),
    /unknown mouse action/,
  )
})

await test('keyboard tool refuses oversized text before hitting the bridge', async () => {
  let called = 0
  const bridge = fakeBridge({ 'keyboard.type': () => { called++; return { chars: 1 } } })
  setInputDeps({ call: bridge.call, config: () => config })
  await assert.rejects(
    () => keyboardTool.execute({ action: 'type', text: 'x'.repeat(20_001) }, { signal: new AbortController().signal }),
    /too long/,
  )
  assert.equal(called, 0)
})

await test('window tool clips long titles in list output', async () => {
  const longTitle = 'w'.repeat(500)
  const bridge = fakeBridge({
    'window.list': () => ({ windows: [{ handle: 1, pid: 2, title: longTitle, className: 'C', x: 0, y: 0, width: 10, height: 10, minimized: false, foreground: true }] }),
  })
  setWindowDeps({ call: bridge.call, config: () => config })
  const r = await windowTool.execute({ action: 'list' }, { signal: new AbortController().signal })
  assert.equal(r.count, 1)
  assert.ok(r.windows[0].title.length <= 121, 'title should be clipped to 120 chars + ellipsis')
})

await test('ui tool forwards depth/node caps and maps set_value', async () => {
  const bridge = fakeBridge({
    'uia.tree': (a) => ({ nodes: [], truncated: false, maxDepth: a.maxDepth, maxNodes: a.maxNodes }),
    'uia.invoke': (a) => ({ ref: a.ref, action: a.action, ok: true }),
  })
  setUiDeps({ call: bridge.call, config: () => config })
  const tree = await uiTool.execute({ action: 'tree', maxDepth: 99, maxNodes: 9999 }, { signal: new AbortController().signal })
  assert.equal(tree.maxDepth, 6, 'maxDepth should clamp to the configured cap')
  assert.equal(tree.maxNodes, 150, 'maxNodes should clamp to the configured cap')
  const setValue = await uiTool.execute({ action: 'set_value', ref: 3, value: 'hi' }, { signal: new AbortController().signal })
  assert.equal(setValue.action, 'setValue')
})

await test('ui tool forwards the requested UIA view and rejects unknown ones', async () => {
  const bridge = fakeBridge({ 'uia.tree': (a) => ({ nodes: [], truncated: false, view: a.view }) })
  setUiDeps({ call: bridge.call, config: () => config })
  await uiTool.execute({ action: 'tree', view: 'raw' }, { signal: new AbortController().signal })
  assert.equal(bridge.calls[0].args.view, 'raw')
  await uiTool.execute({ action: 'tree', view: 'nonsense' }, { signal: new AbortController().signal })
  assert.equal(bridge.calls[1].args.view, undefined, 'an unknown view must fall back to the bridge default')
})

await test('ui tool asks for every node when detail is full', async () => {
  const bridge = fakeBridge({ 'uia.tree': (a) => ({ nodes: [], truncated: false, filter: a.filter }) })
  setUiDeps({ call: bridge.call, config: () => config })
  await uiTool.execute({ action: 'tree', detail: 'full' }, { signal: new AbortController().signal })
  assert.equal(bridge.calls[0].args.filter, 'all', "detail:'full' must disable the interactive filter")
  await uiTool.execute({ action: 'tree' }, { signal: new AbortController().signal })
  assert.equal(bridge.calls[1].args.filter, undefined, 'the bridge default filter applies otherwise')
})

await test('ui tree renders state flags and the hidden count', async () => {
  const nodes = [
    { ref: 1, depth: 0, role: 'Window', name: 'App' },
    { ref: 2, depth: 1, role: 'Edit', name: '***redacted***', password: true, patterns: ['Value'] },
    { ref: 3, depth: 1, role: 'Button', name: 'Save', enabled: false, patterns: ['Invoke'] },
    { ref: 4, depth: 1, role: 'Text', name: 'Below the fold', offscreen: true },
  ]
  const text = uiTool.output.render(
    { action: 'tree' },
    { action: 'tree', nodes, truncated: false, hidden: 7, filter: 'interactive' },
  )[0].text
  assert.ok(text.startsWith('tree nodes=4 hidden=7'), text)
  assert.ok(text.includes('edit [pw]'), text)
  assert.ok(text.includes('press [dis]'), text)
  assert.ok(text.includes('[off]'), text)
  assert.ok(/detail:"full" shows every node/.test(text), 'the hidden count must be explained')
})

await test('screenshot tool refuses to run while disabled', async () => {
  const bridge = fakeBridge({ 'screen.capture': () => ({ path: 'x' }) })
  setScreenshotDeps({ call: bridge.call, config: () => ({ ...config, enabled: false }) })
  await assert.rejects(
    () => screenshotTool.execute({ target: 'screen' }, { signal: new AbortController().signal }),
    /disabled/,
  )
})

await test('screenshot tool requires a window handle for window captures', async () => {
  const bridge = fakeBridge({ 'screen.capture': () => ({ path: 'x' }) })
  setScreenshotDeps({ call: bridge.call, config: () => config })
  await assert.rejects(
    () => screenshotTool.execute({ target: 'window' }, { signal: new AbortController().signal }),
    /windowHandle/,
  )
})

await test('clipboard tool returns a preview and the full text only when small', async () => {
  const bridge = fakeBridge({ 'clipboard.get': () => ({ text: 'a'.repeat(5000) }) })
  setWindowDeps({ call: bridge.call, config: () => config })
  const r = await clipboardTool.execute({ action: 'get' }, { signal: new AbortController().signal })
  assert.equal(r.text, undefined, 'large payloads must not travel inline')
  assert.equal(r.preview.length, 4001, 'preview is clipped')
})

// The bridge client must surface protocol errors as typed rejections. This
// uses a tiny Node echo child instead of the real bridge, so the wire protocol
// (handshake → request → id-correlated response) is tested without Windows.
await test('bridge client maps UNKNOWN_OP frames to typed errors', async () => {
  const client = createBridgeClient({
    scriptPath: 'bridge/computer-bridge.ps1',
    timeoutMs: 15_000,
    spawnImpl: (command, args, options) => {
      const echoPath = fileURLToPath(new URL('./echo-child.mjs', import.meta.url))
      writeFileSync(
        echoPath,
        [
          "process.stdout.write(JSON.stringify({ ready: true, version: 'echo', platform: 'win32' }) + '\\n')",
          "let buffer = ''",
          "process.stdin.setEncoding('utf8')",
          "process.stdin.on('data', (chunk) => {",
          "  buffer += chunk",
          '  let i',
          "  while ((i = buffer.indexOf('\\n')) >= 0) {",
          "    const line = buffer.slice(0, i).trim()",
          '    buffer = buffer.slice(i + 1)',
          '    if (!line) continue',
          '    const req = JSON.parse(line)',
          "    process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: { code: 'UNKNOWN_OP', message: 'nope' } }) + '\\n')",
          '  }',
          '})',
        ].join('\n'),
        'utf8',
      )
      return realSpawn(process.execPath, [echoPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    },
  })
  await assert.rejects(
    () => client.call('no.such.op'),
    (error) => error.code === 'UNKNOWN_OP' && /nope/.test(error.message),
  )
  await client.dispose()
})

// ── compact renderers + budgets (the token-budget release) ───────────────────

await test('window list renders one compact line per window, not JSON', async () => {
  const value = {
    count: 1,
    windows: [{ handle: 11, pid: 22, title: 'x'.repeat(200), className: 'Chrome_WidgetWin_1', minimized: true, foreground: false }],
  }
  const compact = windowTool.output.render({ action: 'list' }, value)[0].text
  assert.ok(!compact.trimStart().startsWith('{'), 'compact render must not be raw JSON')
  assert.ok(compact.includes('11 22 [min]'), compact)
  assert.ok(compact.split('\n')[1].length < 100, 'title must be clipped, not echoed whole')
  assert.ok(windowTool.output.render({ detail: 'full' }, value)[0].text.trimStart().startsWith('{'), 'detail=full keeps the raw value')
})

await test('ui tree renders compact rows and names the Chromium fix when empty', async () => {
  const nodes = [{ ref: 7, depth: 1, role: 'Button', name: '保存', automationId: 'save', patterns: ['Invoke', 'ScrollItem'] }]
  const text = uiTool.output.render({ action: 'tree' }, { action: 'tree', nodes, truncated: false })[0].text
  assert.ok(text.startsWith('tree nodes=1'), text)
  assert.ok(text.includes('7 Button "保存" press #save'), text)
  const empty = uiTool.output.render({ action: 'tree' }, { action: 'tree', nodes: [], truncated: false })[0].text
  assert.ok(/force-renderer-accessibility/.test(empty), 'an empty tree must name the Chromium fix')
})

await test('window launch adds renderer accessibility for Chromium browsers', async () => {
  const bridge = fakeBridge({ 'window.launch': (a) => ({ pid: 1, handle: 2, title: 't', args: a.args }) })
  setWindowDeps({ call: bridge.call, config: () => config })
  const r = await windowTool.execute(
    { action: 'launch', command: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { signal: new AbortController().signal },
  )
  assert.ok(r.launchArgs.includes('--force-renderer-accessibility'), JSON.stringify(r.launchArgs))
  assert.ok(bridge.calls[0].args.args.includes('--force-renderer-accessibility'), 'the flag must reach the bridge')
})

await test('window launch leaves non-browser commands untouched', async () => {
  const bridge = fakeBridge({ 'window.launch': () => ({ pid: 1, handle: 2, title: 't' }) })
  setWindowDeps({ call: bridge.call, config: () => config })
  const r = await windowTool.execute({ action: 'launch', command: 'notepad.exe' }, { signal: new AbortController().signal })
  assert.deepEqual(r.launchArgs, [], 'plain apps must not get browser flags')
})

await test('window launch respects the browserUiaFlags switch', async () => {
  const bridge = fakeBridge({ 'window.launch': () => ({ pid: 1, handle: 2, title: 't' }) })
  setWindowDeps({ call: bridge.call, config: () => ({ ...config, browserUiaFlags: false }) })
  const r = await windowTool.execute({ action: 'launch', command: 'chrome.exe' }, { signal: new AbortController().signal })
  assert.deepEqual(r.launchArgs, [])
})

await test('screenshot tool forwards both capture budgets', async () => {
  const bridge = fakeBridge({ 'screen.capture': (a) => ({ path: 'x', budgetKb: a.budgetKb, budgetPixels: a.budgetPixels }) })
  setScreenshotDeps({ call: bridge.call, config: () => config })
  await screenshotTool.execute({ target: 'screen' }, { signal: new AbortController().signal })
  assert.equal(bridge.calls[0].args.budgetKb, 190)
  assert.equal(bridge.calls[0].args.budgetPixels, 900_000)
})

await test('screenshot tool reports whether the strip was hidden for the capture', async () => {
  const bridge = fakeBridge({ 'screen.capture': () => ({ path: 'x', overlaySuspended: true }) })
  setScreenshotDeps({ call: bridge.call, config: () => config })
  const r = await screenshotTool.execute({ target: 'screen' }, { signal: new AbortController().signal })
  assert.equal(r.overlaySuspended, true)
})

await test('wait tool polls until a control appears and returns its ref', async () => {
  let polls = 0
  const bridge = fakeBridge({
    'uia.find': () => {
      polls += 1
      return polls < 3
        ? { matches: [], count: 0 }
        : { matches: [{ ref: 42, role: 'Button', name: 'Save', automationId: 'save' }], count: 1 }
    },
  })
  setWaitDeps({ call: bridge.call, config: () => config })
  const r = await waitTool.execute(
    { condition: 'control', name: 'Save', pollMs: 50, timeoutMs: 3000 },
    { signal: new AbortController().signal },
  )
  assert.equal(r.satisfied, true)
  assert.equal(r.polls, 3)
  assert.equal(r.control.ref, 42)
  const text = waitTool.output.render({ condition: 'control', name: 'Save' }, r)[0].text
  assert.match(text, /^wait control "Save" -> ok in \d+ms polls=3 ref=42 Button "Save"$/)
})

await test('wait tool reports a timeout instead of throwing', async () => {
  const bridge = fakeBridge({ 'uia.find': () => ({ matches: [], count: 0 }) })
  setWaitDeps({ call: bridge.call, config: () => config })
  const r = await waitTool.execute(
    { condition: 'control', name: 'Never', pollMs: 50, timeoutMs: 200 },
    { signal: new AbortController().signal },
  )
  assert.equal(r.satisfied, false)
  assert.ok(r.waitedMs >= 150, `waitedMs=${r.waitedMs}`)
  assert.ok(r.polls >= 2, `polls=${r.polls}`)
  assert.match(waitTool.output.render({ condition: 'control', name: 'Never' }, r)[0].text, /timeout/)
})

await test('wait tool treats a vanished window as satisfied when absent', async () => {
  const bridge = fakeBridge({
    'uia.find': () => {
      const error = new Error('no UIA element for that handle')
      error.code = 'HWND_NOT_FOUND'
      throw error
    },
  })
  setWaitDeps({ call: bridge.call, config: () => config })
  const r = await waitTool.execute(
    { condition: 'control', handle: 99, name: 'x', absent: true, pollMs: 50, timeoutMs: 1000 },
    { signal: new AbortController().signal },
  )
  assert.equal(r.satisfied, true, 'a window that is gone satisfies an absent wait')
  assert.equal(r.polls, 1, 'no need to poll again once the condition holds')
})

await test('wait tool matches a window title case-insensitively', async () => {
  let polls = 0
  const bridge = fakeBridge({
    'window.list': () => {
      polls += 1
      return polls < 2 ? { count: 0, windows: [] } : { count: 1, windows: [{ handle: 777, title: 'Save As - Notepad' }] }
    },
  })
  setWaitDeps({ call: bridge.call, config: () => config })
  const r = await waitTool.execute(
    { condition: 'window', title: 'save as', pollMs: 50, timeoutMs: 2000 },
    { signal: new AbortController().signal },
  )
  assert.equal(r.satisfied, true)
  assert.equal(r.window.handle, 777)
})

await test('wait tool validates its conditions', async () => {
  const bridge = fakeBridge({ 'uia.find': () => ({ matches: [] }) })
  setWaitDeps({ call: bridge.call, config: () => config })
  const exec = { signal: new AbortController().signal }
  await assert.rejects(() => waitTool.execute({ condition: 'nonsense' }, exec), /condition must be/)
  await assert.rejects(() => waitTool.execute({ condition: 'control' }, exec), /requires one of name/)
  await assert.rejects(() => waitTool.execute({ condition: 'window' }, exec), /requires a title/)
})

await test('wait tool stops on the abort signal', async () => {
  const bridge = fakeBridge({ 'uia.find': () => ({ matches: [], count: 0 }) })
  setWaitDeps({ call: bridge.call, config: () => config })
  const controller = new AbortController()
  const pending = waitTool.execute(
    { condition: 'control', name: 'x', pollMs: 50, timeoutMs: 5000 },
    { signal: controller.signal },
  )
  setTimeout(() => controller.abort(), 120)
  await assert.rejects(() => pending, /cancelled/)
})

await test('ui tool forwards the observation ttl when acting on a ref', async () => {
  const bridge = fakeBridge({ 'uia.invoke': (a) => ({ ref: a.ref, action: a.action, ok: true, ttlMs: a.ttlMs }) })
  setUiDeps({ call: bridge.call, config: () => config })
  const r = await uiTool.execute({ action: 'invoke', ref: 5 }, { signal: new AbortController().signal })
  assert.equal(bridge.calls[0].args.ttlMs, config.observationTtlMs)
  assert.equal(r.ttlMs, config.observationTtlMs)
})

for (const set of [setScreenshotDeps, setInputDeps, setWindowDeps, setUiDeps, setWaitDeps]) set(undefined)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exit(1)
