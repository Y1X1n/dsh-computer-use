import Schema from '@deepseek-ai/schemastery'

/**
 * Plugin config. Schemas carry enums as loose strings on purpose: the settings
 * document persists to ~/.dsh/settings.yaml and a strict union blows up the
 * whole namespace registration when it meets an old persisted value.
 */
export interface ComputerUseConfig {
  /** Master switch: tools refuse every call while false. Default false — the agent must not silently take over the desktop. */
  enabled: boolean
  /** Screenshot long-edge cap in px before encoding. Lower = fewer image tokens. */
  screenshotMaxEdge: number
  /** JPEG quality for screenshots (PNG when 100). */
  screenshotQuality: number
  /** Hard cap on UIA nodes returned by one tree/find call. */
  uiaMaxNodes: number
  /** Default UIA traversal depth. */
  uiaMaxDepth: number
  /** Cap on window list rows. */
  windowLimit: number
  /** Bridge call timeout in ms. */
  bridgeTimeoutMs: number
  /** Where screenshots land; empty resolves to %TEMP%\dsh-computer-use. */
  captureDir: string
  /** Screen-capture backend: printwindow keeps background windows, gdi copies the visible screen. */
  captureBackend: string
  /** Base64 budget for one screenshot (KB); the bridge trades quality then edges to fit it. */
  screenshotBudgetKb: number
  /** Pixel budget for one screenshot; ~1200 image tokens at the 1/750 area ratio. */
  screenshotBudgetPixels: number
  /** Append --force-renderer-accessibility when launching a Chromium browser, so UIA can read its pages. */
  browserUiaFlags: boolean
  /** Show the top-of-screen hosting overlay while the agent drives the desktop. */
  overlay: boolean
  /** Overlay label text. */
  overlayText: string
  /** Hide the overlay after this many ms without a tool call (0 = never). */
  overlayIdleHideMs: number
  /** Default give-up time for computer_wait (ms). */
  waitTimeoutMs: number
  /** Default poll interval for computer_wait (ms). */
  waitPollMs: number
  /** How long a ref from an observation may still be acted on (ms, 0 = never). */
  observationTtlMs: number
}

export const NS = 'computer-use'

export type CaptureBackend = 'printwindow' | 'gdi'

export const ConfigSchema: Schema<ComputerUseConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('总开关(默认关):开启后 agent 才能调用 computer_* 工具操控本机'),
  screenshotMaxEdge: Schema.number().min(320).max(2560).default(1280).description('截图长边上限(px),越小越省图像 token'),
  screenshotQuality: Schema.number().min(40).max(100).default(72).description('截图 JPEG 质量(100 时用 PNG)'),
  uiaMaxNodes: Schema.number().min(20).max(2000).default(150).description('单次 UI 树/查找返回的控件上限'),
  uiaMaxDepth: Schema.number().min(1).max(20).default(6).description('UI 树默认遍历深度'),
  windowLimit: Schema.number().min(5).max(200).default(40).description('窗口清单上限'),
  bridgeTimeoutMs: Schema.number().min(2000).max(300000).default(60000).description('桥接单次调用超时(ms)'),
  captureDir: Schema.string().default('').description('截图输出目录(留空用 %TEMP%\\dsh-computer-use)'),
  captureBackend: Schema.string().default('printwindow').description('截图后端:printwindow(可截后台窗口)· gdi(屏幕原图)'),
  screenshotBudgetKb: Schema.number().min(0).max(2048).default(190).description('单张截图的 base64 预算(KB):超限则先降质再缩边,0 表示不限'),
  screenshotBudgetPixels: Schema.number().min(0).max(20000000).default(900000).description('单张截图的像素预算(宽×高):约等于 1200 图像 token,0 表示不限'),
  browserUiaFlags: Schema.boolean().default(true).description('启动 Chrome/Edge 等 Chromium 浏览器时自动补 --force-renderer-accessibility,否则 UIA 读不到网页内容'),
  overlay: Schema.boolean().default(true).description('托管时在屏幕顶部显示状态悬浮条(黑底白字,鼠标穿透)'),
  overlayText: Schema.string().default('Deepseek Harness托管中').description('悬浮条文案'),
  overlayIdleHideMs: Schema.number().min(0).max(3600000).default(180000).description('多久没有工具调用后自动隐藏悬浮条(ms),0 表示不自动隐藏'),
  waitTimeoutMs: Schema.number().min(100).max(30000).default(5000).description('computer_wait 默认放弃时间(ms)'),
  waitPollMs: Schema.number().min(50).max(5000).default(250).description('computer_wait 默认轮询间隔(ms)'),
  observationTtlMs: Schema.number().min(0).max(3600000).default(180000).description('观察过期时间(ms):超过后按旧 ref 施动作会被拒绝,0 表示不过期'),
})

export function normalizeBackend(value: unknown): CaptureBackend {
  return value === 'gdi' ? 'gdi' : 'printwindow'
}

/** Fill defaults at runtime: cordis.patch.yml inserts carry no config, so the loader may pass `{}`. */
export function resolveConfig(input: unknown): ComputerUseConfig {
  return (ConfigSchema as unknown as (v: unknown) => ComputerUseConfig)(input ?? {})
}
