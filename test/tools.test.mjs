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

for (const set of [setScreenshotDeps, setInputDeps, setWindowDeps, setUiDeps]) set(undefined)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exit(1)
