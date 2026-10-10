# DEVELOPMENT — dsh-computer-use 开发文档

> 面向后续开发者：架构、协议契约、工具清单、token 策略与扩展指南。
> 协议契约以任务板 task-1 的 op 清单为准（NDJSON over stdio，PowerShell 桥）。
> 调研背景见 [research-computer-use.md](./research-computer-use.md)。

---

## 1. 架构

```
┌─────────────────────────────────────────────────────────────────┐
│ DSH 宿主 (cordis)                                               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ dsh-computer-use 插件 (src/index.ts)                       │  │
│  │   apply(ctx, config)                                      │  │
│  │     ├─ settings 注入：ConfigSchema（computer-use.* 命名空间）│  │
│  │     ├─ BridgeClient（惰性创建，单例，dispose 幂等）          │  │
│  │     └─ tools 注入：注册 6 个 computer_* 工具                │  │
│  └───────────────────────────────────────────────────────────┘  │
│            │  call(op, args)  NDJSON over stdio                 │
│  ┌───────────▼───────────────────────────────────────────────┐  │
│  │ bridge/computer-bridge.ps1（持久 PowerShell 子进程）        │  │
│  │   Add-Type 一次：System.Drawing / UIAutomationClient       │  │
│  │   op 分发 → OS：CopyFromScreen / PrintWindow / SendInput / │  │
│  │   SetCursorPos / System.Windows.Automation                 │  │
│  │   UIA ref 注册表（session 级，按 hwnd 分组失效）             │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

数据流（以"读树→点按钮"为例）：

```
模型 → computer_ui{action:"find"} → tools/ui.ts → client.call("uia.find")
  → 桥 uia.find → UIA 搜索 → ref 注册 → {matches:[{ref,...}]}
模型 → computer_ui{action:"invoke", ref:12} → client.call("uia.invoke")
  → 桥 uia.invoke → ref 解析 → InvokePattern.Invoke() → {ok:true}
模型 → computer_screenshot{} → tools/screenshot.ts → client.call("screen.capture")
  → 桥截图 → %TEMP%\dsh-computer-use\shot-<ts>.jpg → {path,...}
  → withImageProjection()：模型支持图像才附 image block，否则仅路径
```

设计原则（与调研结论对齐）：

1. **单驱动进程**（Codex 形态）：全部 OS 操作在桥内，JS 层零 Win32。
2. **少工具多动作**（`src/tools/input.ts` 头注释）：schema 常驻系统提示，6 个小工具比 30 个细分工具每个请求都省 token。
3. **AX/UIA 优先于视觉**：ref 便宜且可靠；截图是验证与兜底。
4. **礼貌原则**：PrintWindow 截后台窗口不抢焦点（Codex WGC 同款能力，Windows GDI 替代）。

## 2. 协议契约（与 task-1 一致）

### 2.1 传输与帧

- 传输：stdio，**NDJSON**（每行一个 JSON，UTF-8；`[Console]::InputEncoding/OutputEncoding` 显式设置）。
- 请求：`{"id": number, "op": string, "args": {...}}`（args 可省略）。
- 响应：`{"id": n, "ok": true, "result": {...}}` 或 `{"id": n, "ok": false, "error": {"code": string, "message": string}}`。
- 未识别 op：`{"ok":false,"error":{"code":"UNKNOWN_OP","message":...}}`，**进程不得退出**。
- 启动握手：进程就绪后先输出一行 `{"ready":true,"version":"1.0.0","platform":"win32"}`（无 id）。
- 异常必须捕获并以 ok:false 返回；stdin 关闭时干净退出。
- 每个响应后立即 Flush；进程常驻，Add-Type 只在首个 op 做一次——且**只在 Engine.cs 有新版本时**：编译产物按 `sha256(源码 + PS/CLR 版本 + 方案版本)` 缓存到 `%LOCALAPPDATA%\dsh-computer-use\engine-cache\engine-<hash>.dll`，命中即 `Add-Type -Path`（实测进程就绪 185ms、首次 op 258ms、后续 op 1–2ms）。缓存目录不可写或 DLL 损坏时**自动回落**到内存编译，绝不因为缓存问题弄坏桥。

### 2.2 op 清单

| op | args | result |
|---|---|---|
| ping | {} | {version, platform, os, dpi} |
| screen.list | {} | {monitors:[{index,x,y,width,height,primary}], cursor:{x,y}, dpi} |
| screen.capture | {monitor?, windowHandle?, region?, maxEdge?, format?:'png'\|'jpeg', quality?, budgetKb?, budgetPixels?} | {path, width, height, format, bytes, quality, base64Bytes} |
| window.list | {limit?} | {windows:[{handle,pid,title,className,x,y,width,height,minimized,foreground}]} |
| window.focus | {handle} | {handle, title} |
| window.state | {handle, state:'minimize'\|'maximize'\|'restore'\|'close'} | {handle, state} |
| window.launch | {command, args?, cwd?} | {pid, handle, title} |
| mouse.move | {x,y} | {x,y} |
| mouse.click | {x?,y?,button?,count?} | {x,y,button,count} |
| mouse.drag | {fromX,fromY,toX,toY,button?,durationMs?} | {fromX,fromY,toX,toY} |
| mouse.scroll | {x?,y?,deltaX?,deltaY?} | {x,y} |
| keyboard.type | {text, intervalMs?} | {chars} |
| keyboard.press | {keys:string[], action?:'press'\|'down'\|'up'} | {keys} |
| uia.tree | {handle?, maxDepth?, maxNodes?, view?:'control'\|'content'\|'raw', filter?:'interactive'\|'all'} | {nodes:[{ref,runtimeId,depth,role,name,automationId,enabled,offscreen,password,rect,patterns}], truncated, view, filter, hidden} |
| uia.find | {handle?, name?, automationId?, controlType?, limit?} | {matches:[{ref,role,name,automationId,rect,patterns}]} |
| uia.invoke | {ref?, handle?, name?, automationId?, action:'invoke'\|'select'\|'toggle'\|'expand'\|'collapse'\|'setValue'\|'focus', value?} | {ref, action, ok} |
| clipboard.get | {} | {text} |
| clipboard.set | {text} | {} |
| overlay.show | {text?} | {shown, text, width, height} |
| overlay.hide | {} | {shown:false} |
| overlay.state | {} | {shown, width, height, defaultText} |
| control.state | {} | {heldKeys:[], overlayVisible, overlaySuspended} |

> `screen.capture` 的 `budgetKb`（base64 字节）与 `budgetPixels`（宽×高）是**硬预算**：超限时先按步长 15 降质（下限 40），再按 ×0.8 缩边（下限 320），像素预算先一步精确适配。返回值里的 `quality`/`base64Bytes` 是**实际写入**的值；`overlaySuspended` 表示这次截图前把托管条藏起来了。
>
> `overlay.*` 由插件生命周期驱动（首次工具调用 show、插件卸载/空闲 hide），也可手动调用；窗口是分层置顶椭圆条，`WS_EX_TRANSPARENT|WS_EX_NOACTIVATE` 保证鼠标穿透且不抢焦点，桥进程退出即消失。截图期间会自动 `SuspendForCapture()` 隐藏、截完恢复——否则 agent 会把自己的指示条截进观察结果。
>
> `keyboard.press action:'down'` 进入**输入账本**：重复按下同一键报 `INPUT_HELD`，`action:'up'` 清除；桥进程退出时 `Engine.Shutdown()` 释放所有仍按住的键，绝不让按键留在用户键盘上。`control.state` 用于查看当前账本与指示条状态。

### 2.3 Node 侧客户端（src/bridge/client.ts）

```ts
createBridgeClient({ scriptPath, spawnImpl?, timeoutMs?, log? })
client.call<T>(op, args?, { timeoutMs? }): Promise<T>
client.dispose()   // 结束子进程，幂等
```

行为要点：请求 id 关联、**串行队列**（同一时间只发一条，PowerShell 单线程逐条处理）；超时 reject 该请求但**不杀进程**（桥可能仍在处理），连续 2 次超时才重启；进程意外退出 → pending 全部 reject，下次 call 自动重启。

## 3. 工具设计表（src/tools/）

| 工具 | 参数 | 返回 | 桥 op |
|---|---|---|---|
| computer_screenshot | target('screen'\|'window'\|'region'), windowHandle?, region?, monitor?, maxEdge?, returnImage? | {ok, path, width, height, bytes, format, target[, image]} | screen.capture |
| computer_mouse | action(move\|click\|double_click\|right_click\|middle_click\|drag\|scroll), x?, y?, toX?, toY?, deltaX?, deltaY?, durationMs? | {action, x, y, ...} | mouse.* |
| computer_keyboard | action('type'\|'press'), text?, keys?[] | {action, chars\|keys} | keyboard.* |
| computer_window | action(list\|focus\|minimize\|maximize\|restore\|close\|launch), handle?, title?, command?, args?, cwd? | {count, windows[]} / {handle,title} / {pid,handle,title} | window.* |
| computer_ui | action(tree\|find\|invoke\|set_value\|focus), handle?, name?, automationId?, controlType?, ref?, value?, maxDepth?, maxNodes? | {action, nodes[]\|matches[]\|ref,action,ok} | uia.* |
| computer_clipboard | action('get'\|'set'), text? | {length, preview?, text?} / {ok, length} | clipboard.* |
| computer_wait | condition('window'\|'control'), title?, handle?, name?, automationId?, controlType?, absent?, timeoutMs?, pollMs? | {condition, absent, satisfied, waitedMs, polls[, window][, control]} | window.list / uia.find（工具层轮询） |

公共约定：

- **enabled 门控**：`config.enabled`（默认 false）为 false 时所有工具直接抛错——总开关即权限模型的最外层。
- **hwnd/ref 货币**：`computer_window list` 产出的 handle 供 screenshot(window)/ui 使用；ui 产出的 ref 在窗口存活期内稳定。
- **渲染即裁剪**：每个工具的 `output.render` 决定模型可见文本。默认 **compact 渲染**（`src/tools/format.ts`）：UIA 树/查找每控件一行 `ref role "name" flags #automationId`、窗口清单每窗一行 `hwnd pid [min,fg] title`；`detail:"full"` 才回落到原始 JSON。实测 uia.tree −78%、window.list −69%（§4.2）。
- **图像投影**（src/index.ts `withImageProjection`）：截图结果先落盘，仅当路由 `resolveModelInfo().inputModalities` 含 `image` 时经 `attachments.saveImages` 附加 image block；任何一步拒绝都退回纯路径结果。模型看不见图时仍可拿路径做后续处理——token 永远不浪费在 base64 上。

## 4. Token 控制策略

### 4.1 图像

| 旋钮 | 默认 | 说明 |
|---|---|---|
| screenshotMaxEdge | 1280 | 长边上限，等比缩放后再编码（System.Drawing 重绘 Bitmap） |
| screenshotQuality | 72 | JPEG 质量；100 时改用 PNG（无损场景留给 OCR/精细对比） |
| maxEdge（参数） | 160–2560 | 单次调用覆盖设置，"lower saves image tokens" 写进参数描述 |
| screenshotBudgetPixels | 900000 | 宽×高硬上限；约 1200 图像 token（面积/750 计法），先一步精确适配 |
| screenshotBudgetKb | 190 | base64 字节硬上限（对齐 ZCode §4.2），超限走降质→缩边 |

**预算收敛编码（借鉴 ZCode，已实现）**：`screen.capture` 先按 `budgetPixels` 一步缩到目标像素，再按 `budgetKb` 迭代——降质（步长 15、下限 40）→ 缩边（×0.8、下限 320），返回值 `quality`/`base64Bytes` 是实际值。实测：2560×1600、q90 的请求被收敛成 1200×750 级、约 874 图像 token。

**compact 渲染（已实现，见 §4.2）**：UIA 树与窗口清单不再 `JSON.stringify` 整个结果，改为一行一条记录。实测 uia.tree 3350B → 726B（**−78.3%**）、window.list 2448B → 763B（**−68.8%**）；`detail:"full"` 保留原始 JSON 逃生门。

### 4.2 结构化结果

- **uia.tree**：扁平 nodes 数组（非嵌套，省缩进 token）；默认 `maxDepth=6`、`maxNodes=150`（配置 `uiaMaxDepth/uiaMaxNodes`）；`truncated:true` 明示被截断，模型可按需提高上限或用 `uia.find` 精确定位。模型看到的是 **compact 行**（`ref role "name" flags #automationId`，name 截 60），`detail:"full"` 才回原始 JSON（含 `runtimeId`）。
- **默认 ControlView**：`view` 默认 `control`（`TreeWalker.ControlViewWalker`），只列真控件、跳过纯布局容器；实测同一窗口比 `raw` 省 **5%–46%** 字节（Terminal 29.5%、NVIDIA overlay 46%），`view:'raw'` 是"控件好像不见了"时的逃生门。`uia.find` 仍是全子树匹配（按名/ID 精确定位，不受视图影响），两者产出的 ref 可混用。
- **ref 身份校验**：每个 ref 记下 UIA `RuntimeId`，`uia.invoke` 前比对——元素没了或**同一个 ref 现在指向别的控件**都报 `STALE_REF`，绝不把动作落到"顶替上来的那个控件"上。注意 ref 是**每次观察重新分配**的（跨调用要重读 ref，runtimeId 才是稳定身份）。
- **交互性过滤（默认开）**：`filter:'interactive'` 丢掉"没名字、没有可用 pattern"的节点，但**保留这些节点的祖先**，所以树仍然连贯可读；`hidden` 回报丢了几个（compact 行里会说明 `detail:"full"` 可看全）。`filter:'all'` 关掉过滤；工具层 `detail:'full'` 会自动切到 `all`。实测 ControlView 已经在前面挡掉了绝大多数容器，这一层主要兜底那些没有名字的叶子包装（Terminal 上还多滤掉 1 个）。
- **节点状态标记**：每个节点带 `enabled`/`offscreen`/`password`，compact 行渲染成 `[pw]`/`[dis]`/`[off]`——模型不用去点一个已禁用的按钮，也知道某个控件当前不在可视区。
- **密码字段脱敏**：`IsPassword` 为真的节点，名字一律替换成 `***redacted***`（凭据字段的标签也不外泄）。实测：本地 HTML 的 `<input type="password">` 在 Chrome 中暴露为 `password:true` 且名字已脱敏，相邻的普通输入框与地址栏不受影响。
- **先序遍历**：节点按真正的先序（访问即输出、子节点反序入栈）产生，缩进顺序与屏幕上的控件顺序一致——此前是"同层子节点成组先输出且顺序相反"，缩进层级会对不上。
- **HWND 兜底**：窗口不是桌面直接子元素时（工具窗、被别的进程托管的窗），`FindFirst(Children)` 找不到，改用 `AutomationElement.FromHandle` 直连；实测修掉了 `TextInputHost` 这类窗口的 `HWND_NOT_FOUND`。
- **spill（落盘）**：clipboard.get 超 4000 字符只回 preview；截图走文件路径而非 base64（最大单项节省）。
- **window.list**：`windowLimit` 默认 40 行，compact 行格式 `hwnd pid [min,fg] title`（title 截 70；`detail:"full"` 带 className/rect）。
- **Chromium 提示**：UIA 树为空且窗口是 Chromium 时，工具输出直接附上 `--force-renderer-accessibility` 的修复指引；`window.launch` 对 chrome/edge/brave/chromium/vivaldi **自动补该参数**（`computer-use.browserUiaFlags`，默认开）。
- **静态工具描述**：description/parameters 全为字面量（无运行时拼接），保证 prompt-cache 前缀稳定——这是 zcode-cua `sync-skill-from-zcode-cua.mjs` 那类"字符串两仓各写一遍必然漂移"事故的反面教材：**工具描述改动 = 缓存全失效**，须当作发版级变更。

### 4.3 观察纪律（借鉴 ZCode/Codex，写入工具描述的约定）

1. 坐标只来自"最新一张截图"，元素/ref 失效先重新 find/tree，不要猜。
2. 单次结果最多一张图（one-raster rule）；截图自带展示，模型不得要求重复回传。
3. 点了没反应：先 computer_ui find 或再截图验证，不要原样重试（非幂等动作）。

## 5. 安全模型

分层（由外到内）：

1. **enabled 总开关**（默认关）：插件加载即打印 `default off`，agent 不可静默接管桌面。
2. **工具级门控**：每个 execute 先查 `cfg.enabled`。
3. **进程边界**：桥只接受 NDJSON 请求，无 shell 插值；`window.launch` 是唯一会拉起新进程的 op，参数显式 `command/args/cwd`（不走 shell 字符串拼接）。
4. **焦点礼貌**：除 window.focus / window.launch 外无任何前台抢占；截图默认 PrintWindow（后台可截，不抢焦点）。
5. **托管可见**：agent 一旦开始操作，屏幕顶部出现黑底白字椭圆条「Deepseek Harness托管中」（`overlay.show`），鼠标穿透、不抢焦点、不进 Alt-Tab；插件卸载/总开关关闭/空闲超时即消失，桥进程退出时窗口随进程一起消失。文案与开关见 `computer-use.overlay*`。
6. **观察不被污染**：截图前 `Overlay.SuspendForCapture()` 把托管条藏起来（默认 70ms 让合成器跟上），截完恢复——否则 agent 会把自己的指示条截进画面，既浪费顶部像素也让模型误判。返回值 `overlaySuspended` 报告这次是否藏过。
7. **不留残留输入**：`keyboard.press action:'down'` 记入输入账本，重复按下报 `INPUT_HELD`；桥进程退出时 `Engine.Shutdown()` 释放所有仍按住的键。这条防的是"调用方死在 down 与 up 之间，用户的 Shift/Ctrl 被永久按住"（机制借鉴 Windows-MCP `control_ledger.py`，见 [borrow-mit-projects.md](./borrow-mit-projects.md)）。

二期候选（对照调研 §5）：

- ~~**悬浮提示条**~~：已实现为顶部托管条（`overlay.show/hide/state`，见 §5.5）。
- **物理 Esc 中断**：全局键盘钩子置一个取消标志，桥在动作间隙检查并返回 `{"event":"interrupt"}` 事件帧（协议已预留无 id 事件行）。
- **approval 事件**：`window.launch` 等敏感 op 可先发 `approval_request` 事件帧，由宿主 UI 决断后继续（对齐 codex `codex_approval_kind` 流）。

## 6. 扩展指南

### 6.1 新增一个 op

以 `display.info`（读取 DPI/多屏信息）为例：

1. **桥**（`bridge/computer-bridge.ps1`）：在 op 分发 switch 加分支，返回 PSCustomObject；任何异常 catch 成 ok:false。保持"响应后立即 Flush"。
2. **协议类型**（`src/bridge/protocol.ts`）：补 `DisplayInfoArgs/DisplayInfoResult` 接口，op 名进联合类型。
3. **客户端**：无需改动（`call(op, args)` 透传）。
4. **工具**（`src/tools/`）：新文件或挂进现有工具的 action；description 写清楚与其它工具的分工（"Prefer X over Y when …"）。
5. **测试**（`test/bridge.test.mjs`）：加一条真实 op 冒烟（参照 ping/screen.list 的写法）。
6. **文档**：更新本文档 §2.2 op 表与 §3 工具表；改动工具描述须在 PR 说明里标注"prompt-cache 失效"。

### 6.2 新增一个工具

- 小而正交优先：先考虑塞进现有工具的 action 词表（mouse/keyboard/ui 都是单工具多动作）。
- 新工具必须：description 静态字面量；`isConcurrencySafe` 诚实声明（有状态动作必须 false）；execute 里先 `cfg.enabled` 门控；render 决定模型可见文本并做长度裁剪。

### 6.3 加一个 client UI（设置页）

`src/index.ts` 的 settings 注入已兼容两种宿主能力（`installSection` / `register`+`watch`）。新增配置项步骤：

1. `src/config.ts`：`ComputerUseConfig` 加字段 + `ConfigSchema` 加 Schema（enum 用松散字符串，strict union 会让旧持久化值炸掉整个命名空间注册——见该文件头注释）。
2. `resolveConfig` 自动兜底；工具读 `getConfig()` 即时生效，无需重启桥。
3. 桥侧需要对应旋钮时（如悬浮条文案），随 op args 传递，桥不读 DSH 配置。

### 6.4 接入 MCP（把这套能力暴露给其它宿主）

两种路径：

- **薄封装**：写一个 stdio MCP server，tools ↔ 本插件 `createBridgeClient` 一一映射；NDJSON 帧可直接复用 `bridge/`，无需经过 cordis。适合给 Claude/Codex 等标准 MCP 宿主使用。
- **host 直连**：`exports['./bridge']` 已暴露 client 工厂；外部 Node 宿主 `import { createBridgeClient } from '@y1x1n/dsh-computer-use/bridge'` 后自行拉起 `bridge/computer-bridge.ps1`。

参照 zcode-cua 的教训（调研 §5.3）：若做多客户端并发，必须加输入租约（`CONTROLLER_BUSY` 语义）与进程互斥，否则两个会话会同时动鼠标。

### 6.5 版本与发布

- `npm run typecheck && npm run build && npm test`（test 含真实桥冒烟：ping/screen.list/window.list/mouse.move/keyboard.type/uia.tree）。有人正在用这台机器时用 `node test/bridge.test.mjs --safe` 跳过 9 个需要前台空闲的用例（见 [CONTRIBUTING.md](../CONTRIBUTING.md#本地校验)）。
- 所有 commit 走 PR（见 [PR-WORKFLOW.md](./PR-WORKFLOW.md)，任务板 task-3）。
- 桥脚本随 npm 包 `files` 里的 `bridge/` 分发，版本号与插件同版本（当前桥握手 version 固定 1.0.0，协议变更时同步 task-1 契约）。
- 借鉴第三方（尤其 MIT）机制时，同步登记到 [borrow-mit-projects.md](./borrow-mit-projects.md)，并在 commit message 里注明来源仓库。

## 7. 已知限制与路线图

| 项 | 现状 | 方向 |
|---|---|---|
| 截图预算 | ✅ 已实现（像素+字节双预算，实测 1200 token/张） | 按需微调默认值 |
| 观察污染 | ✅ 截图前自动隐藏托管条（`overlaySuspended` 回报） | — |
| 残留输入 | ✅ 输入账本 + 退出释放（`INPUT_HELD` / `Shutdown()`） | — |
| 观察噪声 | ✅ ControlView + 交互性过滤（默认丢无名无 pattern 的包装，保祖先）+ 密码字段脱敏 + 节点状态标记 | — |
| uia.tree diff | compact 树已实现（−78%），diff 未做 | compact 树 + "模型见过的树"基线 diff（ZCode tree_shown_to_model 语义） |
| actionSent | 无 | 超时/异常区分"未下发/可能已下发"，工具层给"先观察再重试"指引（Anionex 用「观察令牌 + 过期拒绝」实现，见借鉴清单） |
| 物理 Esc 中断 | 未做 | 低级钩子区分物理/注入输入（`LLKHF_INJECTED`），抑制窗口超时 **fail-open**；⚠️ 需要真实物理输入才能验收，不适合只靠 CI |
| 冷启动 | ✅ 插件加载预热 ping + **引擎汇编按源码 hash 缓存**（`%LOCALAPPDATA%\dsh-computer-use\engine-cache`）：冷启动 1090ms → **258ms**，第二次 ping 1–2ms | 若还要更快只剩换宿主（PS 进程本身占 185ms） |
| UIA 寻址 | ✅ 默认 ControlView（省 5–46% 字节）+ RuntimeId 身份校验（指向别的控件即 `STALE_REF`）+ `FromHandle` 兜底非桌面子窗口 | — |
| 多会话租约 | 无 | §6.4，接 MCP 前置条件 |
| 窗口还原副作用 | PrintWindow 规避 | 保持默认；若引入 WGC 后端（Windows.Graphics.Capture via WinRT），可后台截最小化窗口且零焦点干扰 |
