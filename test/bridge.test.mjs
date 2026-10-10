/**
 * Bridge integration tests. These talk to real Windows APIs through the
 * persistent PowerShell bridge, so they only run meaningfully on Windows.
 *
 * Run: node test/bridge.test.mjs   (after `node scripts/build.mjs`)
 *
 * The client is imported from the built lib when present (CI runs Node 22,
 * which cannot strip TS types); locally Node 24 falls back to ../src.
 */
import assert from 'node:assert/strict'
import { execSync, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const scriptPath = join(here, '..', 'bridge', 'computer-bridge.ps1')

const builtClient = join(here, '..', 'lib', 'bridge', 'client.js')
const clientModule = existsSync(builtClient) ? pathToFileURL(builtClient).href : '../src/bridge/client.ts'
const { createBridgeClient } = await import(clientModule)

const results = []
const launchedPids = []
let client
let launchedHandle = 0

/**
 * `--safe` skips the cases that need an idle desktop: they move the real mouse,
 * click, type into the foreground window or drag a window, so running them while
 * somebody is working (or playing) hijacks their input. Everything else — the
 * wire protocol, captures, UIA reads, the overlay and the input ledger — still
 * runs, which is what a shared machine or a quick local check needs.
 * CI runs the full suite on a clean runner.
 */
const SAFE = process.argv.includes('--safe')
const NEEDS_FOREGROUND = new Set([
  'window.focus: focus the launched window',
  'mouse.move: cursor lands on target (physical pixels)',
  'mouse.click + focus: clicks into the text editor',
  'keyboard.type: unicode text lands in the focused editor',
  'keyboard.press: ctrl combo works (copy nothing, no crash)',
  'uia.find + uia.invoke: focus a control by type',
  'mouse.scroll: returns cursor position',
  'mouse.drag: drags a window by its title bar',
  'window.state: minimize then restore the window',
])

function test(name, fn) {
  if (SAFE && NEEDS_FOREGROUND.has(name)) {
    results.push({ name, ok: true, skipped: true })
    console.log(`  skip ${name} (--safe: needs an idle desktop)`)
    return Promise.resolve()
  }
  return (async () => {
    const started = Date.now()
    try {
      await fn()
      results.push({ name, ok: true, ms: Date.now() - started })
      console.log(`  ok   ${name} (${Date.now() - started}ms)`)
    } catch (error) {
      results.push({ name, ok: false, ms: Date.now() - started, error: error.message })
      console.log(`  FAIL ${name}: ${error.message}`)
    }
  })()
}

async function killLaunchedPids() {
  for (const pid of launchedPids) {
    try {
      execSync(
        `powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`,
        { stdio: 'ignore', timeout: 10_000 },
      )
    } catch { /* best effort cleanup */ }
  }
}

function expectCallError(promise, code) {
  return assert.rejects(
    promise,
    (error) => {
      assert.equal(error.code, code, `expected error code ${code}, got ${error.code}: ${error.message}`)
      return true
    },
  )
}

console.log('bridge tests')

try {
  client = createBridgeClient({
    scriptPath,
    timeoutMs: 30_000,
    log: (message) => console.error(`    [client] ${message}`),
  })

  await test('ping: handshake + version + dpi', async () => {
    const r = await client.call('ping')
    assert.equal(r.platform, 'win32')
    assert.ok(r.version, 'version missing')
    assert.ok(r.os && String(r.os).includes('Windows'), `os looks wrong: ${r.os}`)
    assert.ok(r.dpi > 0, `dpi looks wrong: ${r.dpi}`)
  })

  await test('unknown op -> UNKNOWN_OP, bridge survives', async () => {
    await expectCallError(client.call('no.such.op'), 'UNKNOWN_OP')
    const ping = await client.call('ping')
    assert.equal(ping.platform, 'win32')
  })

  await test('screen.list: monitors + cursor + dpi', async () => {
    const r = await client.call('screen.list')
    assert.ok(Array.isArray(r.monitors) && r.monitors.length >= 1)
    const primary = r.monitors.find((m) => m.primary) ?? r.monitors[0]
    assert.ok(primary.width > 0 && primary.height > 0)
    assert.equal(primary.index, 1, 'primary should be index 1 (1-based)')
    assert.ok(typeof r.cursor.x === 'number' && typeof r.cursor.y === 'number')
    assert.ok(r.dpi >= 96, `dpi looks wrong: ${r.dpi}`)
  })

  await test('window.list: visible windows with handles/pids', async () => {
    const r = await client.call('window.list', { limit: 20 })
    assert.ok(Array.isArray(r.windows) && r.windows.length >= 1, 'expected at least one visible window')
    const row = r.windows[0]
    assert.ok(typeof row.handle === 'number' && row.handle !== 0)
    assert.ok(typeof row.pid === 'number' && row.pid > 0)
    assert.ok(typeof row.title === 'string' && row.title.length > 0)
    assert.ok(typeof row.className === 'string')
    assert.ok(typeof row.minimized === 'boolean')
    assert.ok(typeof row.foreground === 'boolean')
  })

  await test('window.launch: opens a window and reports handle', async () => {
    const r = await client.call('window.launch', { command: 'notepad.exe', args: [] })
    assert.ok(r.pid > 0, 'no pid returned')
    launchedPids.push(r.pid)
    launchedHandle = r.handle
    assert.ok(r.handle !== 0, `no main window handle (pid=${r.pid}, title='${r.title}')`)
    assert.ok(r.title && r.title.length > 0)
  })

  await test('window.focus: focus the launched window', async () => {
    const r = await client.call('window.focus', { handle: launchedHandle })
    assert.equal(r.handle, launchedHandle)
    assert.ok(typeof r.title === 'string')
  })

  await test('mouse.move: cursor lands on target (physical pixels)', async () => {
    const screen = await client.call('screen.list')
    const primary = screen.monitors.find((m) => m.primary) ?? screen.monitors[0]
    const targetX = primary.x + Math.floor(primary.width / 2)
    const targetY = primary.y + Math.floor(primary.height / 2)
    const r = await client.call('mouse.move', { x: targetX, y: targetY })
    assert.ok(Math.abs(r.x - targetX) <= 2, `x drift: ${r.x} vs ${targetX}`)
    assert.ok(Math.abs(r.y - targetY) <= 2, `y drift: ${r.y} vs ${targetY}`)
  })

  await test('mouse.click + focus: clicks into the text editor', async () => {
    const list = await client.call('window.list', { limit: 50 })
    const mine = list.windows.find((w) => w.handle === launchedHandle)
    assert.ok(mine && !mine.minimized, 'launched window should be visible')
    // Click into the editor body, then re-focus, so typed keys land there.
    const cx = mine.x + Math.floor(mine.width * 0.5)
    const cy = mine.y + Math.floor(mine.height * 0.6)
    // Real input injection races with anything else moving the cursor on this
    // desktop (the developer is usually using it while tests run), so one
    // retry keeps the assertion about the bridge's accuracy, not the desktop's.
    let r = await client.call('mouse.click', { x: cx, y: cy })
    if (!(Math.abs(r.x - cx) <= 2 && Math.abs(r.y - cy) <= 2)) {
      r = await client.call('mouse.click', { x: cx, y: cy })
    }
    assert.equal(r.button, 'left')
    assert.equal(r.count, 1)
    assert.ok(Math.abs(r.x - cx) <= 2 && Math.abs(r.y - cy) <= 2)
    await client.call('window.focus', { handle: launchedHandle })
    await new Promise((resolve) => setTimeout(resolve, 200))
  })

  await test('keyboard.type: unicode text lands in the focused editor', async () => {
    await client.call('keyboard.type', { text: 'dsh-bridge 中文 123', intervalMs: 2 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    // Read the text back straight from the control via UIA Value — typing
    // injects keys and must not detour through the clipboard.
    let found = await client.call('uia.find', { handle: launchedHandle, controlType: 'Document', limit: 5 })
    if (found.count < 1) {
      found = await client.call('uia.find', { handle: launchedHandle, controlType: 'Edit', limit: 5 })
    }
    assert.ok(found.count >= 1, 'expected a Document/Edit control to read back from')
    const got = await client.call('uia.invoke', { ref: found.matches[0].ref, action: 'getValue' })
    assert.equal(got.ok, true, `read-back failed: ${got.message ?? ''}`)
    assert.ok(
      String(got.value).includes('dsh-bridge 中文 123'),
      `typed text should land intact, got: ${JSON.stringify(got.value).slice(0, 80)}`,
    )
  })

  await test('keyboard.press: unknown key reports an error', async () => {
    await expectCallError(client.call('keyboard.press', { keys: ['definitely-not-a-key'] }), 'INVALID_ARGS')
    const ping = await client.call('ping')
    assert.equal(ping.platform, 'win32')
  })

  await test('keyboard.press: ctrl combo works (copy nothing, no crash)', async () => {
    const r = await client.call('keyboard.press', { keys: ['ctrl', 'a'] })
    assert.deepEqual(r.keys, ['ctrl', 'a'])
  })

  await test('uia.tree: flat bounded node list with refs', async () => {
    const r = await client.call('uia.tree', { handle: launchedHandle, maxDepth: 4, maxNodes: 60 })
    assert.ok(Array.isArray(r.nodes) && r.nodes.length >= 1)
    assert.ok(r.nodes.length <= 60, 'maxNodes must bound the output')
    assert.equal(typeof r.truncated, 'boolean')
    const node = r.nodes[0]
    for (const key of ['ref', 'depth', 'role', 'name', 'automationId', 'rect', 'patterns']) {
      assert.ok(key in node, `node missing ${key}`)
    }
    assert.ok(Array.isArray(node.patterns))
    assert.ok(node.rect.width >= 0 && node.rect.height >= 0)
  })

  await test('uia.find + uia.invoke: focus a control by type', async () => {
    // Win11 notepad exposes its editor as Document (WinUI3), classic builds
    // as Edit — accept either so the test holds on both.
    let found = await client.call('uia.find', { handle: launchedHandle, controlType: 'Document', limit: 5 })
    if (found.count < 1) {
      found = await client.call('uia.find', { handle: launchedHandle, controlType: 'Edit', limit: 5 })
    }
    assert.ok(Array.isArray(found.matches) && found.count >= 1, 'expected a Document/Edit control in the editor')
    const target = found.matches[0]
    const invoked = await client.call('uia.invoke', { ref: target.ref, action: 'focus' })
    assert.equal(invoked.ref, target.ref)
    assert.equal(invoked.action, 'focus')
    assert.equal(invoked.ok, true)
  })

  await test('uia.invoke: stale ref reports STALE_REF', async () => {
    await expectCallError(client.call('uia.invoke', { ref: 99999999, action: 'focus' }), 'STALE_REF')
  })

  await test('clipboard round-trips CJK through set/get', async () => {
    const put = await client.call('clipboard.set', { text: 'dsh-computer-use 你好' })
    assert.equal(put.ok, true)
    const r = await client.call('clipboard.get')
    assert.equal(r.text, 'dsh-computer-use 你好')
  })

  await test('mouse.scroll: returns cursor position', async () => {
    const r = await client.call('mouse.scroll', { deltaY: -120 })
    assert.ok(typeof r.x === 'number' && typeof r.y === 'number')
  })

  await test('mouse.drag: drags a window by its title bar', async () => {
    const before = await client.call('window.list', { limit: 50 })
    const mine = before.windows.find((w) => w.handle === launchedHandle)
    assert.ok(mine, 'window gone before drag')
    const fromX = mine.x + Math.floor(mine.width / 2)
    const fromY = mine.y + 12
    const toX = fromX + 40
    const toY = fromY + 25
    const r = await client.call('mouse.drag', { fromX, fromY, toX, toY, durationMs: 300 })
    assert.deepEqual(
      { fromX: r.fromX, fromY: r.fromY, toX: r.toX, toY: r.toY },
      { fromX, fromY, toX, toY },
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = await client.call('window.list', { limit: 50 })
    const moved = after.windows.find((w) => w.handle === launchedHandle)
    assert.ok(moved, 'window gone after drag')
    if (!(Math.abs(moved.x - mine.x) >= 15 || Math.abs(moved.y - mine.y) >= 15)) {
      // The desktop owner's real mouse can swallow one drag; try once more.
      await client.call('mouse.drag', { fromX, fromY, toX, toY, durationMs: 300 })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const retry = await client.call('window.list', { limit: 50 })
      const retried = retry.windows.find((w) => w.handle === launchedHandle)
      assert.ok(retried, 'window gone after drag retry')
      assert.ok(
        Math.abs(retried.x - mine.x) >= 15 || Math.abs(retried.y - mine.y) >= 15,
        `window did not move: (${mine.x},${mine.y}) -> (${retried.x},${retried.y})`,
      )
      return
    }
    assert.ok(
      Math.abs(moved.x - mine.x) >= 15 || Math.abs(moved.y - mine.y) >= 15,
      `window did not move: (${mine.x},${mine.y}) -> (${moved.x},${moved.y})`,
    )
  })

  await test('window.state: minimize then restore the window', async () => {
    const r1 = await client.call('window.state', { handle: launchedHandle, state: 'minimize' })
    assert.equal(r1.state, 'minimize')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after1 = await client.call('window.list', { limit: 50 })
    const min1 = after1.windows.find((w) => w.handle === launchedHandle)
    assert.ok(min1?.minimized, 'window should be minimized')
    const r2 = await client.call('window.state', { handle: launchedHandle, state: 'restore' })
    assert.equal(r2.state, 'restore')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after2 = await client.call('window.list', { limit: 50 })
    const min2 = after2.windows.find((w) => w.handle === launchedHandle)
    assert.ok(!min2?.minimized, 'window should be restored')
  })

  await test('screen.capture: png with maxEdge budget', async () => {
    const r = await client.call('screen.capture', { format: 'png', maxEdge: 800 })
    assert.ok(r.path && r.path.endsWith('.png'))
    assert.ok(r.width > 0 && r.height > 0 && r.width <= 800 && r.height <= 800)
    assert.ok(r.bytes > 1000, `suspiciously small capture: ${r.bytes}B`)
  })

  await test('screen.capture: jpeg with quality', async () => {
    const r = await client.call('screen.capture', { format: 'jpeg', quality: 60, maxEdge: 640 })
    assert.ok(r.path && r.path.endsWith('.jpg'))
    assert.ok(r.width <= 640 && r.height <= 640)
    assert.ok(r.bytes > 1000 && r.bytes < 400_000, `jpeg size out of budget: ${r.bytes}B`)
  })

  await test('screen.capture: region capture is exact', async () => {
    const r = await client.call('screen.capture', {
      region: { x: 10, y: 10, width: 120, height: 80 },
      format: 'png',
      maxEdge: 800,
    })
    assert.equal(r.width, 120)
    assert.equal(r.height, 80)
    assert.equal(r.originX, 10)
    assert.equal(r.originY, 10)
  })

  await test('overlay: show / state / hide round-trip', async () => {
    const shown = await client.call('overlay.show', { text: 'Deepseek Harness托管中' })
    assert.equal(shown.shown, true)
    assert.equal(shown.text, 'Deepseek Harness托管中')
    assert.equal(shown.width, 320)
    const state = await client.call('overlay.state')
    assert.equal(state.shown, true)
    const hidden = await client.call('overlay.hide')
    assert.equal(hidden.shown, false)
    const after = await client.call('overlay.state')
    assert.equal(after.shown, false)
  })

  await test('overlay: a capture hides the strip and restores it afterwards', async () => {
    await client.call('overlay.show', {})
    const shot = await client.call('screen.capture', { format: 'jpeg', maxEdge: 640, quality: 60 })
    assert.equal(shot.overlaySuspended, true, 'the capture must report the strip was hidden')
    const state = await client.call('control.state')
    assert.equal(state.overlaySuspended, false, 'the strip must be back after the capture')
    assert.equal(state.overlayVisible, true)
    await client.call('overlay.hide')
  })

  await test('input ledger: held keys are tracked, duplicates rejected, up clears', async () => {
    const start = await client.call('control.state')
    assert.deepEqual(start.heldKeys, [], 'no key should be held at rest')
    await client.call('keyboard.press', { keys: ['shift'], action: 'down' })
    assert.deepEqual((await client.call('control.state')).heldKeys, ['shift'])
    await expectCallError(client.call('keyboard.press', { keys: ['shift'], action: 'down' }), 'INPUT_HELD')
    await client.call('keyboard.press', { keys: ['shift'], action: 'up' })
    assert.deepEqual((await client.call('control.state')).heldKeys, [], 'up must clear the hold')
  })

  await test('input ledger: a held key is released when the bridge exits', async () => {
    // The bug this guards: a caller that dies between keyboard.press down and up
    // would leave the modifier physically held on the user's keyboard.
    const temp = createBridgeClient({ scriptPath, timeoutMs: 30_000 })
    try {
      await temp.call('keyboard.press', { keys: ['shift'], action: 'down' })
      assert.deepEqual((await temp.call('control.state')).heldKeys, ['shift'])
    } finally {
      await temp.dispose()
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    const probe =
      'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int v);\' ' +
      '-Name KeyState -Namespace DshProbe; [DshProbe.KeyState]::GetAsyncKeyState(0x10)'
    const raw = execFileSync('powershell', ['-NoProfile', '-Command', probe], { encoding: 'utf8', timeout: 30_000 }).trim()
    const value = Number.parseInt(raw, 10)
    assert.ok(Number.isFinite(value), `unexpected GetAsyncKeyState output: ${raw}`)
    // Only the high bit means "currently down"; the low bit merely says the key
    // was pressed at some point since the previous query, which a correct
    // press-then-release also produces.
    assert.equal(
      value & 0x8000,
      0,
      `shift must not be held after the bridge exits (GetAsyncKeyState=${raw})`,
    )
  })

  await test('screen.capture: budgets bound both bytes and pixels', async () => {
    // Deliberately oversized request: the bridge must trade quality (floored at
    // 40) and then edges until both budgets are met.
    const r = await client.call('screen.capture', {
      format: 'jpeg',
      maxEdge: 2560,
      quality: 90,
      budgetKb: 190,
      budgetPixels: 900_000,
    })
    assert.ok(r.width * r.height <= 900_000, `pixels ${r.width}x${r.height} exceed the budget`)
    assert.ok(r.base64Bytes <= 190 * 1024, `base64 ${r.base64Bytes} exceeds the budget`)
    assert.ok(r.quality >= 40, `quality ${r.quality} fell below the floor`)
    assert.ok(r.bytes > 0 && r.path.endsWith('.jpg'))
  })

  await test('screen.capture: bad monitor index -> INVALID_ARGS', async () => {
    await expectCallError(client.call('screen.capture', { monitor: 9 }), 'INVALID_ARGS')
  })

  await test('window.focus: bogus handle -> HWND_NOT_FOUND', async () => {
    await expectCallError(client.call('window.focus', { handle: 123456 }), 'HWND_NOT_FOUND')
  })

  await test('timeout: slow op rejects with BRIDGE_TIMEOUT, bridge stays usable', async () => {
    await expectCallError(
      client.call('window.launch', { command: 'cmd.exe', args: ['/k', 'timeout', '/t', '5'] }, { timeoutMs: 800 }),
      'BRIDGE_TIMEOUT',
    )
    const ping = await client.call('ping')
    assert.equal(ping.platform, 'win32')
  })

  await test('serial queue: parallel calls all resolve in order', async () => {
    const calls = await Promise.all([
      client.call('ping'),
      client.call('ping'),
      client.call('screen.list'),
      client.call('ping'),
    ])
    assert.equal(calls[0].platform, 'win32')
    assert.equal(calls[1].platform, 'win32')
    assert.ok(calls[2].monitors.length >= 1)
    assert.equal(calls[3].platform, 'win32')
  })
} finally {
  try { await client?.dispose() } catch { /* already disposed */ }
  await killLaunchedPids()
}

const failed = results.filter((r) => !r.ok)
const skipped = results.filter((r) => r.skipped).length
console.log(`\n${results.length - failed.length}/${results.length} passed${skipped ? ` (${skipped} skipped by --safe)` : ''}`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.error}`)
  process.exit(1)
}
