# 贡献指南（CONTRIBUTING）

> 本仓库实行**强制 PR 流程**：所有变更一律通过 Pull Request 进入 `main`，禁止直接 push。
> 双层防护与完整背景见 [docs/PR-WORKFLOW.md](docs/PR-WORKFLOW.md)。

## 快速开始

```powershell
# 1. 克隆 & 安装
git clone https://github.com/Y1X1n/dsh-computer-use.git
cd dsh-computer-use
npm install

# 2. 安装本地 pre-push 钩子（本机强制层）
node scripts/guard/install.mjs
node scripts/guard/install.mjs --status   # 验证安装

# 3. 开分支干活
git checkout -b feat/my-feature
```

## 分支命名

| 前缀 | 用途 | 示例 |
|---|---|---|
| `feat/` | 新功能 | `feat/uia-invoke` |
| `fix/` | 缺陷修复 | `fix/bridge-timeout` |
| `chore/` | 构建、配置、工具链 | `chore/ci-matrix` |
| `docs/` | 仅文档 | `docs/protocol-table` |
| `refactor/` | 重构（无行为变化） | `refactor/ops-split` |
| `test/` | 测试补充 | `test/tools-coverage` |

一个 PR 聚焦一件事；混杂多类变更时拆分 PR。

## Commit 规范（Conventional Commits）

格式：`<type>(<scope>)?: <subject>`，subject 用祈使句、不加句号。

```
feat(bridge): support window.launch with cwd
fix(uia): invalidate stale element cache on window close
docs: expand PR workflow degraded-mode section
chore(ci): add ubuntu canary to matrix
```

常用 type：`feat` `fix` `docs` `refactor` `perf` `test` `build` `ci` `chore`。
破坏性变更在 subject 末尾加 `!` 并在 body 中说明（如 `feat(bridge)!:`）。

## 提交 PR

```powershell
git push -u origin feat/my-feature
gh pr create --fill-first --web     # 模板自动载入 .github/pull_request_template.md
```

PR 描述请按模板填写：概述、变更类型、自查清单、测试方式。
所有 commit 须经过 CI（typecheck + build + test，见 `.github/workflows/ci.yml`）。

## Review 要求

- 单人项目：**0 个 approving review** 即可合并——但 PR 必须存在，且必须等 CI 绿。
- `CODEOWNERS` 将所有文件归属 `@Y1X1n`；启用分支保护后 GitHub 会自动请求 owner review。
- 合并方式：Squash merge（保持 main 历史一行一变更）。

## 本地校验

推送前请确保：

```powershell
npm run typecheck   # tsc --noEmit
npm run build       # scripts/build.mjs
npm test            # node test/bridge.test.mjs && node test/tools.test.mjs（Windows 真实环境）
```

套件里有一部分用例需要**空闲桌面**（真的移动鼠标、点击、向前台窗口打字、拖窗口）。
在有人正在使用这台机器时，用安全档跑其余部分，别抢别人的输入：

```powershell
node test/bridge.test.mjs --safe   # 跳过 9 个需要前台空闲的用例，其余照跑
node test/tools.test.mjs
```

CI 在干净的 runner 上跑完整套件，所以合并前的 `--safe` 只是本地快速自查，不能替代 CI。

## 禁止事项

- ❌ 直接 push 到 `main` / `master`（pre-push 钩子会拒绝；见下）
- ❌ force push 到受保护分支（`ALLOW_MAIN_PUSH=1` 也不允许 force）
- ❌ 跳过 CI 红灯合并

## 钩子拒绝了你的 push？

这是**设计如此**。请走分支 + PR：

```powershell
git checkout -b feat/what-you-wanted   # 从当前 commit 切分支
git push -u origin feat/what-you-wanted
gh pr create
```

确属正当绕过场景（如首次导入历史）见 [docs/PR-WORKFLOW.md § 恢复与绕过的正当场景](docs/PR-WORKFLOW.md)。
