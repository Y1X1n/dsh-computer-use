# Computer Use 调研报告：Codex (@oai/sky) 与 ZCode (zcode-cua)

> 调研日期：2026-02 · 调研对象版本：`@oai/sky@0.7.5`（Codex 26.930.31730 桌面端自带）、`zcode-cua@0.5.12` / `computer-use@0.6.3`（ZCode 官方插件）。
> 方法：REA 6.3.0（`rea analyze-javascript-application`）做整体结构与边界发现，grep/read 做代码级分析；全部素材为本机已安装产物。
> 本报告不包含任何截图、base64 或完整文件 dump；代码片段均 ≤40 行。

---

## 0. 一句话结论

**Codex 把 OS 自动化收进一个原生 helper 子进程，用 NDJSON-over-stdio/命名管道对模型暴露 12 个以 `window` 为锚点的动作；ZCode 把同一套动作拆成 30 个 MCP 工具 + 一层"绑定式"JS SDK，OS 层在 Python permission broker（helper）里，MCP server 经 socket 鉴权调用。两者本质都是"宿主外挂一个持久自动化进程"，但 Codex 走少工具+单进程强契约，ZCode 走多工具+分层（broker/SDK/skill）治理，安全与 token 治理明显更重。**

---

## 1. 架构分层（问题 1）

### 1.1 Codex / OpenAI

本机证据链（配置 → 运行时 → 协议）：

- `C:\Users\yixin\.codex\config.toml`：
  - `notify` 指向 `...\cua_node\...\node_modules\@oai\sky\bin\windows\codex-computer-use.exe`，`turn-ended` 事件；
  - `[mcp_servers.node_repl]`：`node_repl.exe` + env（`NODE_REPL_TRUSTED_SERVICES = {"browser": ..., "sky": "@oai/sky/service"}`）；
  - `SKY_CUA_NATIVE_PIPE = "1"`，`SKY_CUA_NATIVE_PIPE_DIRECTORY = \\.\pipe\codex-computer-use-<uuid>`；
  - `[mcp_servers.cua_repl]` 指向 `ChatGPT.exe`（`enabled = false`，遗留项）。
- `C:\Users\yixin\.codex\computer-use\config.json`：悬浮提示文案与颜色（见 §5）。

分层图：

```
Codex 桌面宿主 (Electron, ChatGPT.exe / codex.exe)
  └─ node_repl MCP server (node_repl.exe, stdio MCP)   ← 模型通过 mcp__node_repl__js 写 JS
       └─ Worker 内 import "@oai/sky"                   ← JS SDK（sky.js Proxy）
            ├─ [SKY_CUA_NATIVE_PIPE=1] → nodeRepl.rpc("sky", …) → 宿主持久的 native-pipe 通道
            │     → \\.\pipe\codex-computer-use-<uuid>  → codex-computer-use.exe（OS 驱动，Rust）
            └─ [默认] 直接 spawn codex-computer-use.exe（stdio 子进程）
```

代码级证据（`targets/windows/internal/computer_use_client.js`，传输选择）：

```js
const n = globalThis.nodeRepl;
if ("1" === n?.env?.SKY_CUA_NATIVE_PIPE)
  return { sharedTransportKey: null, transport: new I(n, t.timeoutMs) };   // 宿主持久管道
const a = function (t) {                                                   // 否则 spawn helper
  ... i = { refCount: 0, transport: new l(t) } ...
    helperCommand: t.helperCommand ?? t.helperPath ?? O(), timeoutMs: t.timeoutMs });
```

helper 路径与启动参数（`package_bin.js` + `computer_use_client.js`）：

```js
function O() { return o({ relative_path: ["bin", "windows",
  "arm64" === process.arch ? "codex-computer-use-arm64.exe" : "codex-computer-use.exe"] }) }
function K(t) { return [...t, "--parent-pid", String(process.pid)] }
```

要点：

1. **模型面 = node_repl（JS 代码模式）**，不是逐个 MCP 工具调用。模型写 `sky.click({...})`，一个 cell 可编排多动作。
2. **OS 驱动 = 单个原生 helper**（`codex-computer-use.exe`，约 1.5MB Rust 二进制；另有 56MB 的 `codex-computer-use-swift.exe` 副本带 sha256 manifest，供 Swift 绑定/独立升级）。JS 层不直接摸 Win32。
3. **传输二选一**：宿主持久命名管道（`SKY_CUA_NATIVE_PIPE=1` 时，helper 由宿主拉起，多 cell 复用）或 SDK 直接 spawn 的 stdio 子进程；协议同为 NDJSON。
4. 对等结构上，Codex 桌面端本身也是 Electron（REA 对 sky 包的模块图中出现 `electron-main` 节点；`bin/mac` 下还有独立 `.app` 服务），但 Windows 上模型只见到 node_repl + helper 两个进程。

### 1.2 ZCode (Z.ai)

本机证据链：

- `C:\Users\yixin\.zcode\cli\plugins\cache\zcode-plugins-official\zcode-cua\0.5.12\.zcode-plugin\plugin.json`：
  MCP server 命令是 **ZCode.exe 自己**以 `ELECTRON_RUN_AS_NODE=1` 跑 `zcode.cjs __zcode-plugin-host <dist/mcp/server.js>`。
- `computer-use@0.6.3/package.json`：`"description": "...execution is provided by the shared node_repl host."`
- `dist/mcp/server.js`（3.2MB esbuild bundle）内大量 `permission broker` RPC 代码：
  - Windows 管道名白名单：`/^\\\\\.\\pipe\\zcode-cua-helper-(?:[0-9a-f]{8,}|default)$/`
  - broker token 环境变量：`ZCODE_CUA_PERMISSION_BROKER_TOKEN`（由 `__zcode-plugin-host` 注入）
  - 保留注释直接指认 Python 侧实现：`Mirror Python _request_id() (broker.py:484-487)`、`Python's StateError path`、`state_id s-N matching Python f"s-{self._counter}"`。

分层图：

```
ZCode 桌面宿主 (Electron, ZCode.exe)
  ├─ __zcode-plugin-host (ELECTRON_RUN_AS_NODE)
  │    └─ zcode-cua MCP server (dist/mcp/server.js, stdio MCP)   ← 30 个 computer-use MCP 工具
  │         └─ PermissionBrokerClient (socket/命名管道 + token 鉴权)
  │              → zcode-cua-helper（Python permission broker，本机未随附、由宿主拉起）
  │                   → OS: UIA / SendInput / 截图
  └─ node_repl host 插件（共享 JS Worker 宿主）
       └─ 每个 js cell bootstrap 后 import computer-use-client.mjs（SDK，1208 行）
            → bridge = Symbol.for("zcode.node-repl.computer-use-bridge") 持久桥
            → agent.computerUse.*（绑定式 API）+ agent.computerUse.computer.*（30 工具透传）
```

要点：

1. **模型面有三层**：MCP 裸工具（30 个）→ SDK 绑定对象（`getApp → app.click(42)`）→ SKILL.md 的工作流纪律。SDK 是对 Codex `cua` 的"逐字同构移植"（源码头注释：R1 同名同签、R2 附加成员为 0、R3 安全语义只藏不删）。
2. **OS 驱动不在这两个 JS 包里**：MCP server 只做工具 schema、编排、图像管线；真正的输入注入在 Python permission broker（helper）。`computer-use` 插件里的 koffi + sharp 只承担图像编码，不是输入驱动。
3. **权限中枢在 broker**：所有变异动作经鉴权 socket，token 由宿主注入，管道名/属主/权限都校验（见 §5）。
4. 跨 cell 状态：node_repl 每个 js 调用都是新 Worker（全局不存活），state_id/frame_id/diff 基线由 shared host 的 runtime session 持有——这是 ZCode 与 Codex（持久 kernel）最关键的结构差异。

### 1.3 对照速览

| 维度 | Codex (@oai/sky 0.7.5) | ZCode (zcode-cua 0.5.12 / cu-plugin 0.6.3) |
|---|---|---|
| 模型入口 | node_repl JS 代码模式（`sky.*`） | MCP 30 工具 + node_repl SDK 双入口 |
| 驱动进程 | Rust helper `codex-computer-use.exe`（1 进程） | Python permission broker helper + MCP server（2 进程） |
| 传输 | NDJSON over stdio / 命名管道 | MCP stdio + 鉴权 socket（NDJSON 帧，auth 行先行） |
| 状态归属 | helper 进程内 + 宿主管道 | shared host session（跨 Worker）+ broker |
| 升级方式 | runtimes/cua_node 哈希目录整体换 | 插件 marketplace 版本目录 |

---

## 2. OS 自动化实现（问题 2）

### 2.1 Codex Windows

- **官方口径**（`docs/skills/oai_sky_lib/windows/SKILL.md` 第 14 行）：
  > Automates apps via **SendInput and UI Automation**, and takes screenshots of app windows via **Windows.Graphics.Capture** that works even if they are occluded.
- 截图：WGC（Windows.Graphics.Capture）为主，可截被遮挡窗口；`scripts/windows-wgc-e2e.ts` 的存在佐证 WGC 是一等后端。
- 输入：SendInput（鼠标/键盘），键盘 chord 为 X keysym 风格别名（`Control_L+a`、`KP_0`，见 SKILL.md `PressKeyInput.key` 注释）。
- 窗口管理：`list_apps / list_windows / get_window / launch_app / activate_window`；窗口对象 `{ app, id, title }`，`id` 为不透明整数。
- 语义动作：`set_value / perform_secondary_action`（UIA pattern 级：Expand/Collapse/Raise 等）。
- **这些实现全部在闭源 Rust helper 内**；JS 层只有类型与传输（`types/window2/*.d.ts` + `internal/*.js`）。

动作→结果（`get_window_state` 返回，`computer_use_client_base.js` 校验）：

```js
const l = {
  window: s,
  screenshots,           // [{ url: dataURL }]，自动展示
  accessibility: {       // null 容忍
    tree,                // 带元素索引与层级缩进的文本树
    focused_element, selected_text, selected_elements, document_text
  }
};
```

### 2.2 ZCode Windows

MCP server 侧可见的实现面（`dist/mcp/server.js`）：

- **图像管线在 JS**：sharp（libvips）负责 crop/resize/编码（见 §4）。
- **输入/UIA 在 Python broker**：bundle 内仅有对 broker 的 RPC 与错误码映射（`permission_denied / foreground_required / controller_busy / stale_socket …`），无任何 Win32 原生调用痕迹；koffi 是 native FFI 库依赖，但在 computer-use 插件中未见输入用途。
- **语义层级**：`strategy: auto | a11y | event`——`auto` 优先 UIA 命中，回退合成事件；`event` 要求目标已前台，否则 `FOREGROUND_REQUIRED` 且**不发任何事件**。这是 ZCode 特有的双通道设计。
- 独有的输入安全件：`left_mouse_down/left_mouse_up` 配对治理（谁按下谁释放、跨会话拒绝代放）、`input_busy` 串行闸门（"another physical desktop action is active or queued … action_sent=false"）。

Windows 特例（`docs/computer-use.md` Notes 节）：

> Nothing here fronts a window or takes the user's focus, except on Windows: launching a non-packaged app takes focus, and `include_screenshot=true` on a minimized window restores it.

即 ZCode 明确承认 Windows 上"启动非打包应用会抢焦点、截最小化窗口会还原窗口"，并在 SKILL 里教模型"最小化窗口的 AX 树仍完全可用，默认别开截图"来规避。

---

## 3. 工具面设计（问题 3）

### 3.1 Codex：单一 window2 面，12 个动作

`docs/skills/oai_sky_lib/windows/SKILL.md` 的 `Window2ComputerUseClient`：

```
list_windows / get_window / list_apps / launch_app
get_window_state            (include_screenshot / include_text / window)
click / press_key / type_text / scroll / set_value / drag
perform_secondary_action / activate_window
```

- 每个动作都带 `window` 对象锚点；元素坐标走 `element_index`（相对最近一次 `get_window_state` 的 AX 树），像素坐标走 `screenshotId`（相对本次会话某张窗口截图）。
- 动作全为 `Promise<void>`：成功无载荷，失败抛错（无"可能已下发"语义，见 §5.2 对比）。
- 暴露粒度：**一个 SDK 对象 = 一组细分动作**，但模型通过 JS 编排，没有 MCP schema 开销；对模型而言"工具"其实是 SKILL.md 里的 API 文档。

### 3.2 ZCode：三层暴露

**第 1 层：30 个 MCP 工具**（`dist/mcp/server.js` 的 `TOOL_NAMES`，按 OBSERVATION/POINTER/KEYBOARD/SEMANTIC/RUNTIME 五组 9/10/5/1/5 注释分组）：

```
list_apps open_application list_windows get_app_state screenshot zoom
list_displays switch_display cursor_position
left_click double_click triple_click right_click middle_click scroll
left_click_drag mouse_move left_mouse_down left_mouse_up
type set_value select_text key hold_key
perform_action
request_access stop_computer_control wait read_clipboard write_clipboard
```

分级治理（`ActionTier`）：`read_only` / `t1_input` / `safety_control`；restricted 模式下仅放行 read-only + safety。参数校验为 zod `.strict()`（未声明键即 `unrecognized_keys` 拒绝）。

**第 2 层：SDK 绑定面**（`agent.computerUse`，对齐 Codex `Target` 的 12 个成员）：

```js
// computer-use-client.mjs 的 COMPUTER_METHOD_NAMES（= cua.computer 逃逸口，14 个）
"list_apps", "list_windows", "get_app_state", "left_click", "scroll",
"left_click_drag", "type", "set_value", "select_text", "key",
"perform_action", "paste", "request_access", "stop_computer_control"
```

`getApp("Notes") → app.click(42) → app.getAXState()` 的目标绑定：

```js
function bindTarget(binding, target, what) {
  if (typeof target === "number")  {          // 元素索引 → {type:"element", index}
    if (!binding.stateId) throw new ComputerUseError(
      `${what} needs a fresh accessibility state ... Call getAXState() first`,
      { code: "STALE_STATE", details: { need: "getAXState" } });
    return { type: "element", index: target };
  }
  if (Array.isArray(target) && target.length === 2) {   // [x,y] → 栅格像素
    return binding.frameId ? { type: "coordinate", frame_id: binding.frameId, x, y }
                           : { type: "coordinate", x, y };
  }
  ...
}
```

**第 3 层：SKILL.md 行为纪律**（accessibility-first、observe-act-observe、"Main agent only, never delegate to a subagent"、错误码处置表）。

差异要点：ZCode 动作失败抛 `ComputerUseError`（带 `actionSent`/`retry` 字段）而 Codex 是裸 `Promise<void>`；ZCode 有 `paste`（借用剪贴板并恢复用户剪贴板）而 Codex 把 paste 放在 mac 面；ZCode 的 `return_state` 参数允许动作与观察合并成一次调用（token 优化，见 §6）。

---

## 4. 视觉回环（问题 4）

### 4.1 截图回传路径

- **Codex**：`get_window_state({include_screenshot:true})` 返回 `screenshots: [{url: dataURL}]`，node_repl 宿主**自动展示**图片（SKILL 明令"Do not decode, save, print, or emit screenshot payloads again"——一次观察只允许一张 raster，二次 emit 会被宿主整个丢弃）。SDK 侧 `sky.js` 把 dataURL 解回 `Uint8Array` 仅供 JS 使用。
- **ZCode**：MCP image block（`content: [{type:"image", data: base64}]`）。SDK 的 `projectToHost` 把图片与 frame authority 文本块（`{"image_ref":{"frame_id":...}}`）投给宿主 structured sink，文本走 `nodeRepl.write`；观察方法自带展示，`{emit:false}` 显式抑制。

### 4.2 尺寸/格式压缩（两家的核心工程量所在）

**ZCode（可读源码，参数完整）**——`encodeScreenshotRaw` 双产物管线：

| 参数 | 值 | 含义 |
|---|---|---|
| `MAX_EDGE` | 1280 | agent 图长边上限（Lanczos3 等比缩放，round-half-to-even） |
| `DEFAULT_MAX_EDGE` | 1568 | zoom 局部裁剪的长边上限 |
| JPEG quality | 75 | 默认；`encodeJpegFromSharp` 固定 4:2:0、关闭 mozjpeg/progressive/trellis，与 Pillow 基线对齐后注入 JFIF APP0 |
| `AGENT_B64_BUDGET` | 190KB | base64 预算（约 142KB 原始字节） |
| `MIN_QUALITY` / `QUALITY_STEP` | 40 / 15 | 预算超限时先降质量（75→60→45），再缩边 |
| `SHRINK_FACTOR` / `SHRINK_MIN_EDGE` | 0.8 / 320 | 每轮缩 0.8 倍，长边 320px 为底 |

预算收敛循环（`encodeUnderBudget`）：

```js
let q = quality;
while (b64Len(currentData.length) > maxB64 && q > MIN_QUALITY) {
  q = Math.max(MIN_QUALITY, q - QUALITY_STEP);
  currentData = await encodeJpegFromSharp(inputRgb, q);
}
let work = inputRgb, w = inputW, h = inputH;
while (b64Len(currentData.length) > maxB64 && Math.max(w, h) > SHRINK_MIN_EDGE) {
  w = Math.max(1, Math.floor(w * SHRINK_FACTOR));
  h = Math.max(1, Math.floor(h * SHRINK_FACTOR));
  work = await resizeLanczos(work, w, h);
  currentData = await encodeJpegFromSharp(work, q);
}
```

**Codex**：压缩实现在 Rust helper 内，JS 侧无参数暴露；可观察的契约只有"窗口级截图 + dataURL 自动展示 + screenshotId 帧锚点"。mac 侧 SKILL 提到 wait 约 1 秒、最长追加 5 秒的 settle 策略（ZCode 为 observation 内置 settle，禁 `setTimeout`）。

### 4.3 Accessibility 替代视觉

两家都把 **AX/UIA 树作为首选通道、视觉为回退**，且都做了"树文本"而非原始 dump：

- Codex：`get_window_state(include_text:true)` 返回格式化 `accessibility.tree`（带元素索引与 tab 层级缩进），另有 `document_text / focused_element / selected_text / selected_elements`；SKILL 示例即 `nodeRepl.write(state.accessibility.tree)`。
- ZCode：`get_app_state` 返回 `detail="compact"` 树（每元素 `index + kind + name + capability flags (pressable/editable/has_menu/focused)`），`detail="full"` 才带 bounds 与完整 actions；树支持 **diffing**（相对"模型见过的树"输出 removed/added/changed 增量，未展示过的树不能当基线——`tree_shown_to_model=false` 语义）；树过大按优先级裁剪（保祖先），header 标注 `indices are sparse`，`app.elements()` 可取全量行。
- 元素寻址都按"最新一次观察的整数索引"，观察一次重排一次；元素消失 fail-closed（`ELEMENT_UNAVAILABLE`）。

---

## 5. 权限与安全（问题 5）

### 5.1 悬浮提示（"ChatGPT is using your computer"）

实现在**桌面宿主的客户端配置**，不在任何 SDK/工具代码里。`C:\Users\yixin\.codex\computer-use\config.json`（全文）：

```json
{
  "accentColor": "#339cff",
  "direction": "ltr",
  "locale": "zh-CN",
  "strings": {
    "usingComputer": "ChatGPT is using your computer",
    "escToCancel": "Esc to cancel"
  }
}
```

`notify` 键把 `codex-computer-use.exe` 注册为 turn-ended 通知钩子；helper 在控制会话期间渲染悬浮条（accent 色 + 两条文案），**物理 Esc** 即打断——JS 传输层配套了 Esc 中断语义（`helper_transport.js`）：

```js
const I = "Computer Use was stopped by the user with the physical Escape key. " +
  "Stop your work, do not call further Computer Use tools in this turn, and send a final " +
  "message noting that the user stopped Computer Use.";
// 中断事件缓存目录: a.join("cache", "computer-use", "interrupts")
```

### 5.2 App 级 approval

Codex 首次控制一个 app 时由宿主弹 approval（`helper_transport.js`）：

```js
o({
  message: l ? "Allow Computer Use to record computer audio?" : `Allow Codex to use ${t.displayName}?`,
  meta: { codex_approval_kind: "mcp_tool_call", connector_id: "computer-use",
          persist: u ? ["session", "always"] : ["session"],
          riskLevel: t.riskLevel ?? "low",
          tool_params_display: [{ name: "app", display_name: "App", value: t.displayName }] },
});
if ("accept" !== c.action) throw new Error(`Computer Use was not approved to use ${t.displayName}`);
```

approval 可 persist 为 `session` / `always`。`possibly_sent` 防重放：传输层错误带"动作可能已下发"标记时，请求预算头 `x-oai-cua-request-budget-ms` 与 turn metadata（`x-codex-turn-metadata`）一起用于失败归类。

ZCode 侧：`request_access` 工具**永为只读**（"probes, not grants … Missing grants must be requested through the trusted ZCode host UI, outside the model-visible MCP surface"）；macOS 走 TCC，Windows/Linux 无 TCC 门，健康即可用。

### 5.3 ZCode 的 broker 鉴权链

`PermissionBrokerClient` 每次连接：解析 socket → 校验管道名白名单（`\\.\pipe\zcode-cua-helper-<hex|default>`）→ 校验属主 uid/非 world-writable（POSIX 分支）→ 发 auth 行（token）→ 收 authenticate 响应 → 发 method 行 → 逐帧 JSON（id 校验、`maxFrameBytes` 上限）。配套：

- `ZCODE_CUA_PERMISSION_BROKER_TOKEN` 必须由 `__zcode-plugin-host` 注入，缺失即拒启；
- `CONTROLLER_BUSY`：另一活跃会话持有输入租约，**永不重试**，要求模型报告 owner；
- kill switch（`stop_computer_control`）与 `input_busy` 串行闸门把"物理桌面动作"全局单飞。

### 5.4 其他

- Codex `[windows] sandbox = "elevated"`（config.toml）为宿主侧沙箱档位；`[projects.'…'] trust_level` 按项目授信。
- ZCode SKILL 纪律：拒绝后**禁止换用其他 UI 自动化技术**（AppleScript/PowerShell SendKeys 等），防止权限模型被绕过。

---

## 6. Token 成本控制（问题 6）

两家共识：**视觉贵、AX 便宜、往返贵**。具体机制：

| 机制 | Codex | ZCode |
|---|---|---|
| 树文本化 | `accessibility.tree` 格式化文本（索引+缩进） | compact 树：每元素一行 `index kind name flags` |
| 增量观察 | 无（每次全树） | diffing（相对模型见过的树，`disable_diffing` 强制全树；未展示的观察不占基线） |
| 树裁剪 | 未暴露参数 | 按优先级裁剪（保祖先）+ header 标注 + `elements()` 补取 |
| 截图预算 | helper 内部（不可见） | maxEdge 1280 / zoom 1568 → JPEG q75 → 预算 190KB base64 内降质→缩边（§4.2 表） |
| 动作+观察合并 | JS 里顺序写即可（无单工具合并语义） | `return_state: compact|full|none` 参数，动作结果直接带新状态 |
| 观察自动展示 | node_repl 自动展示，禁二次 emit | SDK `emitText/projectToHost` 自展示，`{emit:false}` 抑制 |
| 大结果落盘 | 截图经宿主附件（dataURL→附件），不进上下文 | structuredContent 里剥元素全表（`forDisplay`：`elements` → `element_count`），宿主展示面板 32KB 上限 |
| 一次一图 | one-raster rule（多图整帧丢弃） | 同规则（"a second raster in one result breaks the one-raster rule"） |
| 文档按需加载 | SKILL 常驻 + 完整文档 `agent.documentation.get("computer-use")` 按需 | 同（`documentationRoot` 懒加载） |

ZCode 特有的两个坑位修复也值得记录（都写在 `computer-use-client.mjs` 的注释里，是真实事故驱动）：

1. `getApp()` 绑定不再展示全树（8 cell 里 5 个吐两棵树，36% 输出是立刻作废的前序树）；
2. `computer.*` 返回值解封 MCP envelope（4964 字符里 65% 是信封与 app 图标 base64）。

---

## 7. 与本插件 MVP 的对照（问题 7）

本插件（dsh-computer-use 0.1.0）现状：PowerShell 桥（NDJSON stdio）+ 6 个 `computer_*` 工具（screenshot/mouse/keyboard/window/ui/clipboard），UIA ref 注册表，`maxEdge/maxNodes` 截断，默认关闭总开关。

### 7.1 对照表

| 维度 | Codex | ZCode | 本插件 MVP | 可借鉴 |
|---|---|---|---|---|
| 驱动进程 | Rust helper | Python broker + JS server | PowerShell 持久桥 | 形态一致；保持单进程、Add-Type 一次 |
| 协议 | NDJSON + id/ok/result + 事件流 | NDJSON 帧 + auth 行 + id 校验 | NDJSON `{"id","op","args"}` | 可加 ready 握手行与 UNKNOWN_OP 容错（已按 task-1 契约实现） |
| 工具面 | JS API（12 动作） | 30 MCP 工具 + SDK | 6 工具（action 子命令） | ZCode 的 Tier 分级（read_only/input/safety）值得抄进工具描述 |
| AX 优先 | 树文本 + element_index | compact 树 + diff + tree_shown_to_model | uia.tree/find/invoke（ref 注册表） | ZCode 的"树只相对模型看过的基线做 diff"与"未展示观察不算基线"语义 |
| 截图 | WGC（Rust 内） | sharp 管线（参数公开） | CopyFromScreen/PrintWindow + maxEdge | 抄 ZCode 的"降质→缩边"预算循环与 190KB 预算 |
| 视觉回传 | dataURL 自动展示 + one-raster rule | image block + structured sink | saveImages 附件投影 + 能力门控 | one-raster 规则与"路径兜底"已是本插件行为，保留 |
| 焦点礼貌 | 后台可用（WGC） | 后台 AX 优先，Windows 特例明示 | PrintWindow 后台截图 | 把"最小化窗口 AX 可用、截图会还原窗口"写进工具描述 |
| 安全 | app approval + 物理 Esc + 悬浮条 | broker token + 租约 + kill switch + Tier | enabled 总开关（默认关） | 二期可加"调用即计时悬浮提示"（WinForms toast）与 Esc 全局中断 |
| 防重放 | possibly_sent（传输层） | actionSent + dispatch_status（SDK 层） | 无 | **重点借鉴**：超时后 reject 但不杀进程时，应回传 `actionSent` 语义提示 |
| Token 治理 | maxEdge（隐藏） | diff、裁剪、预算、解封、按需文档 | maxEdge/maxNodes/spill | 抄 ZCode 的 compact 树格式与 return_state 合并语义 |

### 7.2 建议吸收的 5 件事（优先级序）

1. **预算收敛编码**（ZCode）：JPEG q75 起、超 190KB base64 先降质（步长 15、下限 40）再缩边（×0.8、下限 320），截图工具稳定输出可预期体积。
2. **观察基线纪律**（ZCode）：`uia.tree` 的结果若未随响应展示给模型，不得作为后续 diff/索引基线；本插件暂无 diff，但 ref 注册表失效策略应遵循同一原则。
3. **actionSent 语义**（两家）：桥接超时/异常时区分"未下发 / 可能已下发"，工具层据此给模型"先观察再重试"的指引，避免重复点击。
4. **one-raster rule**（Codex）：单次工具结果最多一张图；本插件 `returnImage` 已隐含，写进工具描述让模型不重复请求。
5. **工具描述即安全面**（ZCode Tier + Codex 措辞）：在 description 里固化"坐标只来自最新一张截图""元素/ref 失效先重观察""禁止绕开本工具用其他自动化手段"。

### 7.3 明确不抄的

- **30 个 MCP 工具**：本插件宿主为 DSH agent，工具 schema 常驻系统提示；6 个小工具 + action 词表比 30 个细分工具省得多（这正是 `input.ts` 头注释的设计依据）。
- **Python broker 双进程**：单机 Windows 场景下 PowerShell 直驱足矣；token 鉴权/租约只在多会话共存时才有价值。
- **Swift 副本 / mac 独立 .app**：与 Windows MVP 无关。

---

## 附录 A：素材清单与"未找到"记录

| 素材 | 状态 | 说明 |
|---|---|---|
| `C:\Users\yixin\.codex\config.toml` | ✅ | mcp_servers/notify/SKY_CUA_NATIVE_PIPE 等关键键齐全 |
| `C:\Users\yixin\.codex\computer-use\config.json` | ✅ | 悬浮提示文案与色值 |
| `...\cua_node\45309f9050f7314b\bin\node_modules\@oai\sky` | ✅ | 0.7.5；docs + window2 类型 + windows internal JS |
| `codex-computer-use.exe` | ✅ | 1.5MB，无版本信息；swift 副本 56.5MB + sha256 manifest |
| `C:\Users\yixin\.codex\plugins\cache\openai-bundled\browser\26.930.31730\scripts\browser-service.mjs` | ❌ 未找到 | `plugins\cache` 下实际只有 luna-personal / openai-curated / openai-primary-runtime / personal 四个市场，无 openai-bundled；browser 插件未随桌面端落地本机 |
| `C:\Users\yixin\.zcode\`（cli / v2 / skills / workspace / plugin-workspace） | ✅ | 插件缓存在 `cli\plugins\cache`，v2 为宿主配置与日志；skills 为通用技能包，与 computer-use 无关 |
| ZCode Electron 应用本体 | 部分 | `E:\ZCode\ZCode.exe` 被 plugin.json 引用；应用源码不随用户目录分发，仅能从 MCP bundle 反推宿主行为，未做原生逆向（超出本任务范围） |

## 附录 B：REA 使用记录

- `rea --help`：确认 6.3.0 命令面（CLI 与 MCP 同一工作流）。
- `rea analyze-javascript-application <@oai/sky> --json`：230 个源文件全量解析，产出 graph_id `jsrg_fa6d2f90088f7fd4fe46b1c2d0f3e7d6b45cec70d07013c08f11994ad6bb294c`（authority: shipped-artifact），模块图含 `electron-main` 节点，语义图识别出 3 处 `child-process spawns`（helper spawn 链）与 37 处 boundary 候选（JSON.parse/Number/String 强制转换边界）。
- `--filter-output` / `--format md` 用于把超大 Evidence 裁剪到可读规模；`--token-limit` 与结构化输出不兼容（UNSUPPORTED_OUTPUT_COMBINATION），已改用 filter。
- zcode-cua 的 `dist/mcp/server.js` 为 esbuild 单文件 bundle，REA 对打包产物的模块级拆分价值有限，改用 grep + read 做代码级分析（tier 表、broker RPC、图像管线均为直接证据）。
