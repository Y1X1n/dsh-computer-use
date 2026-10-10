# docs 索引

本目录是 dsh-computer-use 插件的调研与开发文档。源码契约以仓库内代码与任务板 task-1 为准。

## 文档一览

| 文档 | 内容 | 读者 |
|---|---|---|
| [research-computer-use.md](./research-computer-use.md) | Codex (@oai/sky 0.7.5) 与 ZCode (zcode-cua 0.5.12) computer-use 的架构分层、OS 驱动、工具面、视觉回环、权限安全、token 控制的代码级调研；含与本插件 MVP 的对照表 | 想理解"为什么这样设计"的人 |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 本插件架构图（bridge → ops → tools → agent）、NDJSON 协议契约与 op 清单、6 个 computer_* 工具的参数/返回表、token 控制策略、扩展指南（新增 op / 工具 / 设置项 / 接 MCP） | 后续开发者 |
| [PR-WORKFLOW.md](./PR-WORKFLOW.md) | 强制 PR 流程：本地 pre-push 钩子 + 远端分支保护双层防护、正当绕过场景（task-3 交付） | 所有提交者 |

## 快速上手

```powershell
npm run typecheck   # tsc --noEmit
npm run build       # esbuild 打包到 lib/
npm test            # 桥冒烟（ping/screen.list/window.list/mouse.move/keyboard.type/uia.tree）+ 工具测试
```

插件默认关闭（`computer-use.enabled = false`）；在 DSH 设置里开启后 agent 才能调用 computer_* 工具。

## 设计原则（30 秒版）

1. 单驱动进程：所有 Win32 操作在 PowerShell 桥内，Node 层零原生依赖。
2. 少工具多动作：6 个 `computer_*` 工具 + action 词表，schema 常驻提示词。
3. UIA 优先于视觉：ref 便宜可靠；截图用于验证与兜底。
4. 礼貌操作：截图走 PrintWindow 不抢焦点；除显式 focus/launch 外不动前台。
5. token 纪律：maxEdge/maxNodes/spill 截断；工具描述全静态保 prompt-cache。
