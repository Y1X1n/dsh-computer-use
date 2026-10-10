/**
 * Windows automation bridge — wire protocol contract.
 *
 * Transport: stdio, NDJSON (one JSON value per line, UTF-8, LF).
 * The PowerShell side (`bridge/computer-bridge.ps1`) is a persistent
 * single-threaded process that answers one request at a time.
 *
 *  request : {"id": number, "op": string, "args"?: {...}}
 *  response: {"id": n, "ok": true, "result": {...}}
 *          | {"id": n, "ok": false, "error": {"code": string, "message": string}}
 *
 * Handshake (first stdout line, no id):
 *          {"ready": true, "version": "1.0.0", "platform": "win32"}
 *
 * Unknown op        -> {"ok":false,"error":{"code":"UNKNOWN_OP",...}}, process stays alive.
 * Any thrown error  -> {"ok":false,"error":{"code":"OP_FAILED"|"INVALID_ARGS"|...}}.
 * stdin EOF         -> clean exit 0.
 *
 * Coordinate system: physical pixels. The bridge calls SetProcessDPIAware()
 * at startup, so all x/y/width/height values (windows, monitors, regions,
 * cursor) are true device pixels regardless of the display scale factor.
 *
 * `monitor` indexes are 1-based; monitor 1 is the primary.
 * `handle` values are HWNDs exposed as JS numbers (safe range).
 */

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface BridgeError {
  code: string
  message: string
}

export interface BridgeOkFrame {
  id: number
  ok: true
  result: unknown
}

export interface BridgeErrFrame {
  id: number | null
  ok: false
  error: BridgeError
}

export type BridgeFrame = BridgeOkFrame | BridgeErrFrame

export interface BridgeReadyFrame {
  ready: true
  version: string
  platform: string
}

export interface BridgeRequest {
  id: number
  op: string
  args?: Record<string, unknown>
}

export interface CallOptions {
  timeoutMs?: number
}

export interface BridgeClientOptions {
  /** Absolute path to bridge/computer-bridge.ps1. */
  scriptPath: string
  /** Default per-call timeout. */
  timeoutMs?: number
  /** PowerShell executable override; defaults to powershell.exe (5.1 is enough). */
  shellPath?: string
  /** Diagnostics sink; never called per request in the hot path. */
  log?: (message: string) => void
  /**
   * Process spawner; injectable so tests can drive the protocol without a real
   * PowerShell child. Must return a Node-like ChildProcess.
   */
  spawnImpl?: typeof import('node:child_process').spawn
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface MonitorInfo {
  index: number
  x: number
  y: number
  width: number
  height: number
  primary: boolean
}

export interface WindowInfo {
  handle: number
  pid: number
  title: string
  className: string
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
  foreground: boolean
}

/** Flat (non-nested) UIA tree node — keeps token cost low. */
export interface UiaNode {
  ref: number
  depth: number
  role: string
  name: string
  automationId: string
  rect: Rect
  patterns: string[]
}

export interface UiaMatch {
  ref: number
  role: string
  name: string
  automationId: string
  rect: Rect
  patterns: string[]
}

// ---------------------------------------------------------------------------
// Op args
// ---------------------------------------------------------------------------

export interface ScreenListArgs {}

export interface ScreenCaptureArgs {
  /** 1-based monitor index; omitted + no windowHandle/region => primary monitor. */
  monitor?: number
  /** HWND to capture via PrintWindow (PW_RENDERFULLCONTENT). */
  windowHandle?: number
  /**
   * Sub-region to crop. Absolute screen coords when no windowHandle is given,
   * otherwise offsets relative to the window's top-left corner.
   */
  region?: Rect
  /** Scale down so that max(width, height) <= maxEdge (aspect preserved). Default 1280. */
  maxEdge?: number
  /** Default 'jpeg'. */
  format?: 'png' | 'jpeg'
  /** JPEG quality 1..100 (default 72). Ignored for png. */
  quality?: number
}

export interface WindowListArgs {
  limit?: number
}

export interface WindowFocusArgs {
  handle: number
}

export type WindowStateAction = 'minimize' | 'maximize' | 'restore' | 'close'

export interface WindowStateArgs {
  handle: number
  state: WindowStateAction
}

export interface WindowLaunchArgs {
  command: string
  args?: string[]
  cwd?: string
}

export interface MouseMoveArgs {
  x: number
  y: number
}

export interface MouseClickArgs {
  x?: number
  y?: number
  button?: 'left' | 'right' | 'middle'
  count?: number
}

export interface MouseDragArgs {
  fromX: number
  fromY: number
  toX: number
  toY: number
  button?: 'left' | 'right' | 'middle'
  /** Default 350ms; the cursor is interpolated over this time. */
  durationMs?: number
}

export interface MouseScrollArgs {
  x?: number
  y?: number
  /** Positive = scroll up / forward. Notches are multiples of 120. */
  deltaY?: number
  /** Positive = scroll right. */
  deltaX?: number
}

export interface KeyboardTypeArgs {
  text: string
  /** Delay between characters in ms (default 0). */
  intervalMs?: number
}

export interface KeyboardPressArgs {
  keys: string[]
  action?: 'press' | 'down' | 'up'
}

export interface UiaTreeArgs {
  /** HWND to walk; omitted => desktop (top-level windows). */
  handle?: number
  /** Default 6. */
  maxDepth?: number
  /** Default 150, hard cap 400. */
  maxNodes?: number
}

export interface UiaFindArgs {
  handle?: number
  /** Case-insensitive substring match. */
  name?: string
  /** Case-insensitive exact match. */
  automationId?: string
  /** Case-insensitive ControlType name, e.g. "Button", "Edit". */
  controlType?: string
  /** Default 50, hard cap 200. */
  limit?: number
}

export type UiaAction =
  | 'invoke'
  | 'select'
  | 'toggle'
  | 'expand'
  | 'collapse'
  | 'setValue'
  | 'focus'

export interface UiaInvokeArgs {
  /** Cached element ref from uia.tree / uia.find. */
  ref?: number
  handle?: number
  name?: string
  automationId?: string
  action: UiaAction
  /** Required for action="setValue". */
  value?: string
}

export interface ClipboardGetArgs {}

export interface ClipboardSetArgs {
  text: string
}

// ---------------------------------------------------------------------------
// Op results
// ---------------------------------------------------------------------------

export interface PingResult {
  version: string
  platform: string
  os: string
  dpi: number
}

export interface ScreenListResult {
  monitors: MonitorInfo[]
  cursor: { x: number, y: number }
  dpi: number
}

export interface ScreenCaptureResult {
  path: string
  width: number
  height: number
  format: string
  bytes: number
  /** Screen-space top-left of the captured region (info only). */
  originX: number
  originY: number
}

export interface WindowListResult {
  windows: WindowInfo[]
}

export interface WindowFocusResult {
  handle: number
  title: string
}

export interface WindowStateResult {
  handle: number
  state: WindowStateAction
}

export interface WindowLaunchResult {
  pid: number
  /** 0 when no main window appeared within the wait budget. */
  handle: number
  title: string
}

export interface MouseMoveResult {
  x: number
  y: number
}

export interface MouseClickResult {
  x: number
  y: number
  button: string
  count: number
}

export interface MouseDragResult {
  fromX: number
  fromY: number
  toX: number
  toY: number
}

export interface MouseScrollResult {
  x: number
  y: number
}

export interface KeyboardTypeResult {
  chars: number
}

export interface KeyboardPressResult {
  keys: string[]
}

export interface UiaTreeResult {
  nodes: UiaNode[]
  truncated: boolean
}

export interface UiaFindResult {
  matches: UiaMatch[]
  count: number
}

/**
 * `ok:false` means the element resolved but no matching UIA pattern was
 * available for the requested action; a `message` field is added then.
 * action 'invoke' may report action:'toggle'/'select' when it fell back.
 */
export interface UiaInvokeResult {
  ref: number
  action: string
  ok: boolean
  message?: string
}

export interface ClipboardGetResult {
  text: string
}

export interface ClipboardSetResult {
  /** Intentionally empty object (ack). */
}

// ---------------------------------------------------------------------------
// Error code registry (single source of truth for dispatchers)
// ---------------------------------------------------------------------------

export const BRIDGE_ERRORS = {
  unknownOp: 'UNKNOWN_OP',
  invalidArgs: 'INVALID_ARGS',
  opFailed: 'OP_FAILED',
  badRequest: 'BAD_REQUEST',
  hwndNotFound: 'HWND_NOT_FOUND',
  staleRef: 'STALE_REF',
  notFound: 'NOT_FOUND',
  processExited: 'BRIDGE_EXITED',
  timeout: 'BRIDGE_TIMEOUT',
  disposed: 'BRIDGE_DISPOSED',
  startFailed: 'BRIDGE_SPAWN_FAILED',
} as const

/**
 * Table the tools layer can mirror in its own type signatures, kept here so
 * protocol and ops stay in one reviewable place.
 */
export const BRIDGE_OPS = [
  'ping',
  'screen.list',
  'screen.capture',
  'window.list',
  'window.focus',
  'window.state',
  'window.launch',
  'mouse.move',
  'mouse.click',
  'mouse.drag',
  'mouse.scroll',
  'keyboard.type',
  'keyboard.press',
  'uia.tree',
  'uia.find',
  'uia.invoke',
  'clipboard.get',
  'clipboard.set',
] as const
