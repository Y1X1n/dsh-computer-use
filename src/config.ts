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
})

export function normalizeBackend(value: unknown): CaptureBackend {
  return value === 'gdi' ? 'gdi' : 'printwindow'
}

/** Fill defaults at runtime: cordis.patch.yml inserts carry no config, so the loader may pass `{}`. */
export function resolveConfig(input: unknown): ComputerUseConfig {
  return (ConfigSchema as unknown as (v: unknown) => ComputerUseConfig)(input ?? {})
}
