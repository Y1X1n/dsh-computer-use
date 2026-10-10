# dsh-computer-use

**DeepSeek Harness 插件：让 DSH agent 自主操控电脑** —— 截图、鼠标、键盘、窗口、UI 自动化，达成 zcode / codex computer-use 同款效果。

[![License: MIT](https://img.shields.io/badge/License-MIT-f4c430?style=flat-square)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)

## 这是什么

DSH（DeepSeek Harness）本身无法"看到"或"操作"图形界面。本插件给 agent 装上手和眼睛：

- **computer_screenshot** — 截屏/截窗口/截区域，模型支持图像时直接"看"到画面，否则返回文件路径
- **computer_mouse** — move / click / double_click / drag / scroll
- **computer_keyboard** — 输入文字（中文安全）与按键组合
- **computer_window** — 列出/聚焦/最小化/启动应用
- **computer_ui** — 读 UI Automation 控件树、按 ref 点击/填值，**不用看图就能精准操作**
- **computer_clipboard** — 读写剪贴板（大文本搬运用剪贴板+粘贴，不烧 token）

## 快速开始

```powershell
# 1. 构建
npm install
npm run build

# 2. 打包进 profile（或直接用 git + tarball 安装到 ~/.dsh/profiles/desktop）
npm pack
# 然后在 %USERPROFILE%\.dsh\profiles\desktop\package.json 的 dependencies 里指向该 tgz，
# 并把 "@y1x1n/dsh-computer-use" 加入 dsh.profile.bundles

# 3. 在 DSH 设置页打开 "computer-use" 的总开关（默认关闭，安全第一）
```

之后对 agent 说"打开记事本写个 Hello"即可。

## 设计要点（为什么这样省 token）

| 策略 | 做法 |
|---|---|
| 截图压缩 | **双硬预算**：像素 ≤900k（≈1200 图像 token）+ base64 ≤190KB；超限自动降质（下限 40）再缩边（下限 320），长边默认 1280px |
| 紧凑观察 | UIA 树/窗口清单**一行一条**（不再 dump JSON）：实测 uia.tree −78%、window.list −69%，`detail:"full"` 保留逃生门 |
| 视觉降级 | 模型不支持图像 → 只返回路径+尺寸文本，不烧 base64 |
| UIA 优先 | 控件树/按 ref 调用比"看图点坐标"更准更便宜，描述里引导 agent 优先用它 |
| 浏览器可达 | Chromium 启动自动补 `--force-renderer-accessibility`，空树时直接给出修复指引 |
| 结果裁剪 | 窗口列表/控件树有硬上限（40 行/150 节点），名字截断 |
| 常驻桥接 | 单个 PowerShell 子进程常驻 + 插件加载预热；C# 引擎按源码 hash 编译一次并缓存成 DLL，冷启动 1090ms → 258ms，后续 op 1–2ms |
| 静态工具面 | 6 个工具描述固定不变 → prompt cache 稳定，重复请求不重算 |

## 安全模型

- **默认关闭**：`computer-use.enabled` 默认 `false`，不开就一个像素都不动
- **托管可见**：agent 操作期间屏幕顶部常驻黑底白字椭圆条「Deepseek Harness托管中」，鼠标穿透、不抢焦点、不进 Alt-Tab；托管结束（插件卸载/开关关闭/空闲超时/进程退出）自动消失
- **无凭据外传**：全部本地执行，不联网
- **操作可中断**：agent 取消（`exec.signal`）会中止截图等长操作

## 文档

- [开发文档](docs/DEVELOPMENT.md) — 架构、协议、扩展指南
- [调研报告](docs/research-computer-use.md) — zcode/codex computer-use 逆向分析
- [MIT 借鉴清单](docs/borrow-mit-projects.md) — 第三方项目来源、借鉴点与许可归属
- [PR 流程](docs/PR-WORKFLOW.md) — 本仓库强制 PR，禁止直接 push main
- [贡献指南](CONTRIBUTING.md)

## License

MIT
