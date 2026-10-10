import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ConfigSchema, NS, resolveConfig, type ComputerUseConfig } from './config.js'
import { createBridgeClient, type BridgeClient } from './bridge/client.js'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { screenshotTool, setDeps as setScreenshotDeps } from './tools/screenshot.js'
import { mouseTool, keyboardTool, setDeps as setInputDeps } from './tools/input.js'
import { windowTool, clipboardTool, setDeps as setWindowDeps } from './tools/windows.js'
import { uiTool, setDeps as setUiDeps } from './tools/ui.js'
import { waitTool, setDeps as setWaitDeps } from './tools/wait.js'
import type { BlockLike, ToolDeps } from './types.js'

export const name = 'dsh-computer-use'
export const inject: string[] = []
export { ConfigSchema, NS }

const TOOLS = [screenshotTool, mouseTool, keyboardTool, windowTool, uiTool, clipboardTool, waitTool]

/** Directory of the compiled bundle; the PowerShell bridge ships next to it. */
function bridgeDir(): string {
  try {
    return join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bridge')
  } catch {
    return 'bridge'
  }
}

export function apply(ctx: Context, config: unknown): void {
  const lctx = ctx as unknown as {
    effect?: (fn: () => () => void) => void
    inject?: (names: string[], fn: (sctx: Context) => void) => void
  }
  const cfgRef: { current: ComputerUseConfig } = { current: resolveConfig(config) }
  let configSource: (() => ComputerUseConfig) | null = null
  const getConfig = (): ComputerUseConfig => {
    try { return configSource?.() ?? cfgRef.current } catch { return cfgRef.current }
  }

  // ── Settings page (optional host capability: absent → defaults still work).
  lctx.inject?.(['settings'], (sctx) => {
    const settings = (sctx as unknown as { settings?: {
      installSection?: (...a: unknown[]) => void
      register?: (ns: string, schema: unknown, init?: unknown) => { get(): unknown; watch(fn: () => void): () => void }
    } }).settings
    if (!settings) return
    if (typeof settings.installSection === 'function') {
      settings.installSection(ctx, NS, ConfigSchema, cfgRef.current, {
        setSource: (source: () => ComputerUseConfig) => { configSource = source },
        onChange: () => { /* tools read getConfig() live */ },
      } as never)
      return
    }
    if (typeof settings.register === 'function') {
      const scope = settings.register(NS, ConfigSchema, { base: cfgRef.current })
      cfgRef.current = resolveConfig(scope.get())
      const dispose = scope.watch(() => { cfgRef.current = resolveConfig(scope.get()) })
      lctx.effect?.(() => () => dispose())
    }
  })

  // ── Bridge lifecycle: one persistent PowerShell sidecar for all tools.
  let bridge: BridgeClient | null = null
  const getBridge = (): BridgeClient => {
    if (!bridge) {
      bridge = createBridgeClient({
        scriptPath: join(bridgeDir(), 'computer-bridge.ps1'),
        timeoutMs: getConfig().bridgeTimeoutMs,
      })
    }
    return bridge
  }

  // ── Hosting overlay ────────────────────────────────────────────────────
  // Shown on the first successful tool call and kept up while the agent is
  // driving the desktop; hidden when the plugin unloads, when the master switch
  // goes off, or after an idle stretch. Every overlay op is best-effort: a
  // bridge that cannot draw the strip must never fail a tool call.
  let overlayShown = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let activityGeneration = 0

  const hideOverlay = (): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (!overlayShown) return
    overlayShown = false
    void bridge?.call('overlay.hide').catch(() => undefined)
  }

  const noteActivity = (): void => {
    const cfg = getConfig()
    // Bumping the generation invalidates an idle callback that is already queued
    // in the event loop: without it that stale callback could hide the strip in
    // the middle of the call it was supposed to precede.
    activityGeneration += 1
    const generation = activityGeneration
    if (!cfg.enabled || !cfg.overlay) { hideOverlay(); return }
    if (!overlayShown) {
      overlayShown = true
      void getBridge().call('overlay.show', { text: cfg.overlayText }).catch(() => { overlayShown = false })
    }
    if (idleTimer) clearTimeout(idleTimer)
    if (cfg.overlayIdleHideMs > 0) {
      idleTimer = setTimeout(() => {
        if (activityGeneration === generation) hideOverlay()
      }, cfg.overlayIdleHideMs)
      ;(idleTimer as unknown as { unref?: () => void }).unref?.()
    }
  }

  const deps: ToolDeps = {
    call: <T,>(op: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }) =>
      getBridge().call<T>(op, args, opts).then((result) => { noteActivity(); return result }),
    config: () => getConfig(),
  }
  setScreenshotDeps(deps)
  setInputDeps(deps)
  setWindowDeps(deps)
  setUiDeps(deps)
  setWaitDeps(deps)

  lctx.effect?.(() => () => {
    hideOverlay()
    setScreenshotDeps(undefined)
    setInputDeps(undefined)
    setWindowDeps(undefined)
    setUiDeps(undefined)
    setWaitDeps(undefined)
    void bridge?.dispose().catch(() => undefined)
    bridge = null
  })

  // Warm the sidecar during load: the first op compiles Engine.cs (~0.9s), and
  // paying that here keeps the first real tool call responsive.
  if (getConfig().enabled) void getBridge().call('ping').catch(() => undefined)

  // ── Tool registration, guarded on the enabled switch at execution time.
  lctx.inject?.(['tools'], (sctx) => {
    const tools = (sctx as unknown as { tools?: { register(def: unknown): () => void } }).tools
    if (!tools || typeof tools.register !== 'function') {
      console.error(`[${name}] no tools registry mounted; computer-use tools unavailable`)
      return
    }
    for (const def of TOOLS) {
      const finalDef = def === screenshotTool ? withImageProjection(def as never, ctx) : def
      const dispose = tools.register(defineTool(finalDef as never))
      lctx.effect?.(() => dispose)
    }
    console.log(`[${name}] registered ${TOOLS.length} computer_* tools (enabled=${getConfig().enabled})`)
  })

  console.log(`[${name}] loaded · default off — enable "${NS}.enabled" in settings to let the agent drive the desktop`)
}

/**
 * Wrap the screenshot tool's canonical value so a validated capture carries a
 * durable image block when the route can see images. Mirrors the projection
 * dsh-mcp-client performs for MCP results: decode → admit by capability →
 * saveImages → attach. On any refusal the value stays image-free and the
 * agent still gets the file path.
 */
function withImageProjection(def: ToolDefinition, ctx: Context): ToolDefinition {
  // defineTool's execute is generic over ToolRunContext; narrow through unknown
  // to keep this wrapper independent of the registry's internal type plumbing.
  const original = def.execute as unknown as (args: unknown, exec: ToolExecView) => Promise<Record<string, unknown>>
  const wrapped = async (args: unknown, exec: ToolExecView): Promise<Record<string, unknown>> => {
    const value = await original(args, exec)
    if (!value?.path || exec.signal.aborted) return value
    if (value.returnImage === false) return value
    try {
      const image = await projectImage(ctx, exec, value.path as string)
      if (image) value.image = image
    } catch {
      // Capability or storage refusal: keep the text-only result. The path is
      // already in the value, so nothing is lost.
    }
    return value
  }
  return { ...def, execute: wrapped as unknown as typeof def.execute }
}

const MEDIA_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Route identity of the agent that made the call, as far as the host exposes it. */
interface ExecRoute {
  agent?: {
    session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } }
    options?: { provider?: string; model?: string }
  }
}

/** The slice of ToolRunContext this wrapper actually needs. */
interface ToolExecView {
  signal: AbortSignal
  agent?: ExecRoute['agent']
}

async function projectImage(
  ctx: Context,
  exec: { signal: AbortSignal; agent?: ExecRoute['agent'] },
  path: string,
): Promise<BlockLike | undefined> {
  const host = ctx as unknown as { get?: (key: string) => unknown }
  const attachments = host.get?.('attachments') as
    | { saveImages(images: ReadonlyArray<{ data: Buffer; mediaType: string }>): Promise<unknown[]> }
    | undefined
  if (!attachments) return undefined

  // Capability proof — never attach an image a model cannot see. Mirrors the
  // exact admission order dsh-mcp-client uses: route → resolveModelInfo →
  // inputModalities includes 'image'.
  const provider = exec.agent?.session?.requestHeader?.()?.config?.provider ?? exec.agent?.options?.provider
  const model = exec.agent?.session?.requestHeader?.()?.config?.model ?? exec.agent?.options?.model
  const llm = host.get?.('llm') as
    | { resolveModelInfo(provider: string, model: string, signal: AbortSignal): Promise<{ inputModalities?: readonly string[] }> }
    | undefined
  if (provider === undefined || model === undefined || llm === undefined) return undefined
  let info: { inputModalities?: readonly string[] }
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    return undefined
  }
  if (!info.inputModalities?.includes('image')) return undefined
  if (exec.signal.aborted) return undefined

  const { readFile } = await import('node:fs/promises')
  const mediaType = MEDIA_BY_EXT[path.toLowerCase().slice(path.lastIndexOf('.'))] ?? 'image/png'
  const data = await readFile(path)
  const refs = await attachments.saveImages([{ data, mediaType }])
  const ref = refs[0]
  if (!ref) return undefined
  return { type: 'image' as const, attachment: ref }
}
