# MIT 项目借鉴清单（第三方来源与归属）

> 本文件记录本插件从**第三方开源项目**借鉴的机制、来源与许可边界。
> 目的有二：一是让后续维护者知道某个设计不是凭空来的；二是把许可义务写清楚。
>
> 原则：**只借鉴机制与思路，所有实现均为本仓库用 C#/TypeScript 重写**（来源多为
> Python/Swift/PowerShell），不复制源码。若将来真的复制了任何代码片段，必须同时
> 补上该项目的版权声明与完整许可文本。

## 1. 检索方式与筛选

- 检索入口：GitHub 代码/仓库检索（`gh search repos --license mit`）+ 逐个用 API 核验
  `repos/{owner}/{repo}` 的 `license.spdx_id`，**不以搜索结果里的 license 标签为准**。
- 筛选标准：与本插件同类（Windows 桌面控制 / UIA / 计算机使用智能体），或解决了我们
  明确的待办（token 预算、指示器、输入安全、冷启动）。

## 2. 同宿主（DeepSeek Harness）同类插件

| 仓库 | ⭐ | License | 参考点 |
|---|---|---|---|
| [Anionex/dsh-computer-use](https://github.com/Anionex/dsh-computer-use) | 52 | MIT | 新鲜观测 + 过期状态拒绝、`computer_observe` 的 full/diff、`computer_wait` 有界轮询、`computer_confirm` 一次性令牌、按 Agent/Session/turn 的作用域租约、`cursorVisualization`（仅前台显示 agent 光标） |
| [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) | 32 | MIT | UIA 三视图 `control/content/raw`；元素身份用 **UIA RuntimeId**（刷新后稳定、过期显式 `stale`）；三级截图链 `PrintWindow → WGC → 屏幕区域`（带 `occludedPossible` 标记）；**C# P/Invoke 助手按 hash 编译并缓存 DLL**，重启免重编；测试**不发送物理输入** |
| [988hj7tczd-oss/dsh-computer-use](https://github.com/988hj7tczd-oss/dsh-computer-use) | 46 | MIT | 跨平台形态 |
| [wushi2333/dsh-computer-use_codex-style](https://github.com/wushi2333/dsh-computer-use_codex-style) | 20 | MIT | Codex 形态的工具面复刻 |
| [AzaiSakura/dsh-computer-use](https://github.com/AzaiSakura/dsh-computer-use) | 16 | MIT | OpenAI Computer Use 的复现参考 |
| [xiaoheizi1212/dsh-computer-use](https://github.com/xiaoheizi1212/dsh-computer-use) | 7 | MIT | 隔离浏览器方案 |
| [qphotoai/dsh-computer-use-windows](https://github.com/qphotoai/dsh-computer-use-windows) | 7 | MIT | 单例宿主设计 |
| [ZRui-C/dsh-computer-use](https://github.com/ZRui-C/dsh-computer-use) | 32 | **Apache-2.0** | text-first 观察思路；⚠️ 非 MIT，只借思路，复制代码需按 Apache-2.0 附 NOTICE 与变更声明 |

## 3. Windows 平台能力库

| 仓库 | ⭐ | License | 参考点 |
|---|---|---|---|
| [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | 8.5k | MIT | `control_ledger.py` 输入账本（记录 AI 按下的键/鼠标键、物理接管时 `block_new()`、`release_all()`）；`control_hooks.py` 低级钩子用 `LLKHF_INJECTED` 区分物理/注入输入、抑制窗口超时 **fail-open**；`control_overlay.py` 指示器的 **generation 防陈旧**、状态变更等线程确认、`suspend_for_capture()` 截图前隐藏、多显示器分层 |
| [FlaUI/FlaUI](https://github.com/FlaUI/FlaUI) | 3.2k | MIT | `ControlViewWalker`（跳过装饰性容器）；UIA 属性表 `IsPassword / IsEnabled / IsOffscreen / AcceleratorKey / AccessKey`；XPath 寻址 |
| [microsoft/axe-windows](https://github.com/microsoft/axe-windows) | 160 | MIT | `TreeTracker` 的 TreeWalker + 导航锁；扫描配置与元素数据模型 |
| [sbroenne/mcp-windows](https://github.com/sbroenne/mcp-windows) | 110 | MIT | Windows MCP 服务形态 |
| [shanselman/FlaUI-MCP](https://github.com/shanselman/FlaUI-MCP) | 103 | MIT | FlaUI + UIA 的 MCP 封装 |

## 4. Token 与序列化

| 仓库 | ⭐ | License | 参考点 |
|---|---|---|---|
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | 117k | MIT | `dom/serializer/clickable_elements.py` 的四层交互性打分（AX role / ARIA role / 标签 / 交互属性）；`_SENSITIVE_INPUT_TYPES`（password/file/hidden）与 `cc-*`、`one-time-code` 前缀**脱敏**；`enhanced_snapshot.py` 的索引快照与「只取需要的样式」 |

## 5. 其他参考（形态/工程）

| 仓库 | ⭐ | License | 参考点 |
|---|---|---|---|
| [microsoft/UFO](https://github.com/microsoft/UFO) | 9.9k | MIT | Windows UI 智能体的截图与控件融合 |
| [trycua/cua](https://github.com/trycua/cua) | 29k | MIT | 跨 OS 驱动与轨迹产物 |
| [microsoft/fara](https://github.com/microsoft/fara) | 6.2k | MIT | 计算机使用模型侧的观察纪律 |
| [OpenAdaptAI/OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) | 1.8k | MIT | GUI 过程 → 可验证程序 |
| [microsoft/OmniParser](https://github.com/microsoft/OmniParser) | 25k | **CC-BY-4.0** | ⚠️ 不是软件许可（也非 MIT）：只读思路，**不得复制代码** |

## 6. 落地映射（借鉴 → 本仓库落点）

| 借鉴内容 | 来源 | 落点 |
|---|---|---|
| 截图前隐藏指示器（`suspend_for_capture`） | Windows-MCP | `bridge/Engine.cs` `Overlay.SuspendForCapture` + `ScreenCapture` |
| 输入账本 / 关机释放 / 拒绝重复按下 | Windows-MCP | `bridge/Engine.cs` `InputLedger` + `Engine.Shutdown()` + `computer-bridge.ps1` |
| 指示器 generation 与健康门控 | Windows-MCP | 待办：`Overlay.change(generation)` |
| 物理接管检测 + fail-open | Windows-MCP | 待办（需真实物理输入验证） |
| 缓存编译产物（Add-Type → DLL） | Yu-tao-Li-win | 待办：`computer-bridge.ps1` |
| UIA ControlView + RuntimeId 寻址 | Yu-tao-Li-win / FlaUI | 待办：`Engine.cs` `uia.tree` / ref 注册表 |
| 观察令牌 + 过期拒绝 + diff | Anionex | 待办（对应 `docs/DEVELOPMENT.md` §7 的 `actionSent`） |
| `computer_wait` 有界轮询 | Anionex | 待办 |
| 交互性打分筛选 + 敏感字段脱敏 | browser-use / FlaUI | 待办：`src/tools/format.ts` 的紧凑渲染 |

> 已落地项在本文件更新时同步勾掉，并在 commit message 里注明来源仓库。
