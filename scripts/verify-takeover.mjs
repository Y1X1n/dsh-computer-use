/**
 * Manual acceptance for the human-takeover guard.
 *
 * The positive path cannot be automated: SendInput always sets LLKHF_INJECTED, so
 * no script can produce a *physical* event. Run this, then use your keyboard or
 * mouse — that is the input the bridge is supposed to notice.
 *
 *   node scripts/verify-takeover.mjs
 *
 * It shows the hosting strip, waits up to 20s for a physical event, then checks
 * that an actuation op is refused with USER_TAKEOVER. Injected events never count,
 * so the script itself presses nothing that could confuse the result.
 */
import { createBridgeClient } from '../lib/bridge/client.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const bridgeDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bridge')
const client = createBridgeClient({
  scriptPath: join(bridgeDir, 'computer-bridge.ps1'),
  timeoutMs: 30_000,
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  await client.call('control.guard', { enabled: true })
  const shown = await client.call('overlay.show', {})
  console.log(`hosting strip: shown=${shown.shown} healthy=${shown.healthy}`)
  console.log('use your keyboard or mouse now (20s)...')

  let state = await client.call('control.state')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !state.physicalInput.takeover) {
    await sleep(250)
    state = await client.call('control.state')
  }

  const physical = state.physicalInput
  console.log(`watcher installed: ${physical.installed}`)
  console.log(`physical input seen: ${physical.lastPhysicalMsAgo >= 0 ? physical.lastPhysicalMsAgo + 'ms ago' : 'never'}`)
  console.log(`takeover active: ${physical.takeover}`)

  if (!physical.takeover) {
    console.log('\nRESULT: no physical input detected. Either nothing was pressed, or the')
    console.log('        hooks are not receiving events (try again with the strip shown).')
    process.exitCode = 1
  } else {
    const screen = await client.call('screen.list')
    let refused = null
    try {
      // Harmless actuation: move the cursor to where it already is.
      await client.call('mouse.move', { x: screen.cursor.x, y: screen.cursor.y })
    } catch (error) {
      refused = error
    }
    console.log(`actuation while the user is active: ${refused ? 'refused (' + refused.code + ')' : 'ALLOWED - guard is not working'}`)
    console.log('\nRESULT: ' + (refused?.code === 'USER_TAKEOVER' ? 'guard works' : 'guard did NOT block actuation'))
    process.exitCode = refused?.code === 'USER_TAKEOVER' ? 0 : 1
  }
} catch (error) {
  console.log('ERROR: ' + (error.code ?? '') + ' ' + error.message)
  process.exitCode = 1
} finally {
  await client.call('overlay.hide').catch(() => undefined)
  await client.dispose()
}
