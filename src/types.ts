import type {
  ToolDefinition,
} from '@deepseek-ai/dsh-tools'

/**
 * Narrow view of the services this plugin reads off the cordis context.
 * Declared locally instead of importing broad cordis types so the bundle stays
 * dependency-light and the surface stays explicit.
 */
export interface HostServices {
  attachments?: {
    saveImages(images: ReadonlyArray<{ data: Buffer; mediaType: string }>): Promise<unknown[]>
  }
  llm?: {
    resolveModelInfo(provider: string, model: string, signal: AbortSignal): Promise<{ inputModalities?: readonly string[] }>
  }
}

export interface ImageBlockLike {
  type: 'image'
  attachment: unknown
}

export interface TextBlockLike {
  type: 'text'
  text: string
}

export type BlockLike = TextBlockLike | ImageBlockLike

/** Minimal shape of what defineTool returns; keeps the tool table type-safe. */
export type AnyTool = ToolDefinition

/** A tool factory receives resolved config and the shared bridge accessor. */
export interface ToolDeps {
  call<T = Record<string, unknown>>(op: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>
  config(): Readonly<{
    enabled: boolean
    screenshotMaxEdge: number
    screenshotQuality: number
    uiaMaxNodes: number
    uiaMaxDepth: number
    windowLimit: number
    bridgeTimeoutMs: number
    captureDir: string
    captureBackend: string
  }>
  /** Resolved lazily by the entry; may be undefined when no attachment store is mounted. */
  deps?: never
}
