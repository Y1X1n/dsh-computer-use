# PR 工作流（强制 PR 流程）

> 目标：`main` 分支上的每一个 commit 都经过 PR + CI，杜绝直接 push。
> 本文是完整说明；日常操作速查见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 1. 双层防护架构

强制 PR 流程由两个独立层次构成，互为冗余：

| 层 | 机制 | 拦截点 | 强度 | 失效条件 |
|---|---|---|---|---|
| **第一层：本机钩子** | `scripts/guard/pre-push.mjs`（git `pre-push`） | `git push` 发起时，本地 | 硬拦截（非零退出） | 换机器 / 钩子未安装 / 显式绕过 |
| **第二层：远端分支保护** | GitHub Branch Protection（`scripts/guard/set-branch-protection.ps1` 配置） | GitHub 服务端 | 硬拦截（API 拒绝） | private 仓库无付费计划（403，降级模式） |

```
 开发者                    本机                        GitHub
   │                        │                           │
   │  git push origin main  │                           │
   ├───────────────────────►│  ① pre-push 钩子           │
   │                        │  读 stdin ref 行            │
   │                        │  main/master ⇒ 拒绝 ✖      │
   │                        │  (ALLOW_MAIN_PUSH=1 例外)   │
   │                        │                           │
   │  git push origin feat/x│                           │
   ├───────────────────────►│  放行 ✔                    │
   │                        ├──────────────────────────►│  ② 分支保护
   │                        │                           │  PR 必须存在(0 approve)
   │                        │                           │  enforce_admins
   │                        │                           │  禁 force push/删除
   │                        │                           │  ③ CI: typecheck+build+test
   └────────────────────────┴───────────────────────────┘
```

第一层挡住 99% 的误操作（顺手 push 到 main）；第二层保证即使本机钩子缺失
（新克隆、换机器、恶意绕过）服务端仍会拒绝。两层都不可用时进入降级模式（§6）。

## 2. 第一层：本地 pre-push 钩子

### 工作原理

git 在每次 push 前调用 `pre-push <remote> <url>`，并把要更新的 ref 以
`<local_ref> <local_sha> <remote_ref> <remote_sha>` 格式写入钩子 stdin（可多行）。
钩子解析每行的 `remote_ref`：

- `refs/heads/main` 或 `refs/heads/master` → 打印原因、退出码 1 → **push 被取消**
- 其他分支 / tag → 退出码 0 → 正常放行
- `ALLOW_MAIN_PUSH=1` 环境变量 → 放行 main push，但打印黄色警告并写审计日志
- 删除远程分支的 push（local_sha 全零）同样被拦截

### 安装

```powershell
node scripts/guard/install.mjs            # 默认：core.hooksPath=scripts/guard
node scripts/guard/install.mjs --status   # 查看当前安装状态
node scripts/guard/install.mjs --copy     # 备用：复制到 .git/hooks/pre-push
node scripts/guard/install.mjs --remove   # 卸载
```

安装器优先使用 `git config core.hooksPath scripts/guard`：一条配置即可让 git
直接使用仓库内的钩子文件，钩子更新无需重新安装。备用方案是复制到
`.git/hooks/pre-push`（注意：复制件不会随源文件自动更新，需重跑安装器）。

### 手动验证钩子（不实际 push）

```powershell
# 场景 1：push 到 main → 应拒绝
"refs/heads/main abc1234 refs/heads/main 0000000" | node scripts/guard/pre-push.mjs; echo "exit=$LASTEXITCODE"

# 场景 2：push 到 feature 分支 → 应放行
"refs/heads/feat/x abc1234 refs/heads/feat/x 0000000" | node scripts/guard/pre-push.mjs; echo "exit=$LASTEXITCODE"

# 场景 3：ALLOW_MAIN_PUSH=1 → 应放行并告警
$env:ALLOW_MAIN_PUSH="1"; "refs/heads/main abc1234 refs/heads/main 0000000" | node scripts/guard/pre-push.mjs; echo "exit=$LASTEXITCODE"; Remove-Item Env:ALLOW_MAIN_PUSH
```

## 3. 第二层：远端分支保护

### 一键配置

```powershell
# 预览将要调用的 gh api（不改动任何远端设置）
pwsh scripts/guard/set-branch-protection.ps1 -DryRun

# 实际应用（main 分支）
pwsh scripts/guard/set-branch-protection.ps1
# 指定仓库 / 分支 / 必须通过的 CI check：
pwsh scripts/guard/set-branch-protection.ps1 -Owner Y1X1n -Repo dsh-computer-use -Branch main -RequireCiChecks ci/windows,ci/ubuntu
```

前置条件：`gh` 已安装并 `gh auth login`（需要 `repo` 权限的 token）。

### 应用的规则

| 规则 | 值 | 说明 |
|---|---|---|
| `required_pull_request_reviews.required_approving_review_count` | `0` | 单人项目：PR 必须存在，但不要求他人 approve |
| `allow_force_pushes` | `false` | 禁止强推（历史不可改写） |
| `allow_deletions` | `false` | 禁止删除受保护分支 |
| `enforce_admins` | `true` | 管理员同样受限（单人项目里这条最关键） |
| `required_status_checks` | 空 | CI 未稳定前不阻塞合并；稳定后用 `-RequireCiChecks` 收紧 |

### 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 配置成功（或 DryRun 预览完成） |
| `1` | gh 缺失 / 未认证 / 404 / 422 / 其他 API 错误 |
| `2` | **HTTP 403** — 当前计划不支持（见 §6 降级模式） |

## 4. CI（`.github/workflows/ci.yml`）

- **触发**：PR → main/master；push → main/master 及 `feat/** fix/** chore/** docs/**`。
- **矩阵**：`windows-latest`（主门禁，必须绿）+ `ubuntu-latest`（金丝雀，Windows 专属桥接测试允许失败并显式告警）。
- **Node**：22（`actions/setup-node@v4`）。
- **步骤**：checkout → setup-node → `npm ci`（有 lockfile）/ `npm install`（无 lockfile）→ `npm run typecheck` → `npm run build` → `npm test` → 钩子脚本 `node --check` 冒烟。
- **容错**：所有 npm-script 步骤都会在脚本缺失时告警跳过而非报错——首版 package.json 字段不全时 CI 仍可用；随脚本定稿自动生效。
- **CI 与保护的关系**：CI 当前不作为合并前置条件（required_status_checks 为空）。它先建立信任基线，待测试稳定后再通过 `-RequireCiChecks ci/windows,ci/ubuntu` 收紧。

## 5. 日常流程（唯一正确的路径）

```powershell
# 0. 一次性：安装本机钩子
node scripts/guard/install.mjs

# 1. 从最新 main 切出功能分支
git checkout main
git pull
git checkout -b feat/awesome-op

# 2. 开发 & 本地校验
npm run typecheck && npm run build && npm test
git commit -m "feat(bridge): add awesome-op"

# 3. 推送 + 开 PR
git push -u origin feat/awesome-op
gh pr create --fill-first --web

# 4. 等 CI 绿（PR 页面 checks），然后 Squash merge
gh pr merge --squash --delete-branch

# 5. 同步本地 main
git checkout main && git pull
```

## 6. 降级模式（private 仓库无分支保护权限时）

GitHub 的分支保护对 **private 仓库需要 Pro/Team/Enterprise 计划**（public 仓库免费可用）。
`set-branch-protection.ps1` 收到 403 时会打印降级说明并以退出码 2 结束。此时：

| 层 | 状态 | 补偿措施 |
|---|---|---|
| 本机钩子 | ✅ 完全可用 | 常驻主力：`node scripts/guard/install.mjs` |
| 分支保护 | ❌ 403 | 由以下组合部分替代 |
| CODEOWNERS | ✅ 文件在 | 文档化 ownership；配合保护后自动请求 review |
| CI | ✅ 照常跑 | PR 页面上强制可见的绿灯基线 |

降级模式下的纪律性约定：

1. **永远不**在 main 上直接 commit（哪怕本地改完顺手 push 被钩子拦了也不许改历史绕过）；
2. 钩子意外缺失时，`node scripts/guard/install.mjs --status` 是每次克隆后的第一件事；
3. 升级到 GitHub Pro 后第一件事：重跑 `pwsh scripts/guard/set-branch-protection.ps1` 补上服务端层。

## 7. 恢复与绕过的正当场景

绕过机制本身是为了在极少数正当场景下不被自己锁死。**所有绕过都会被审计记录**。

### 场景 A：首次导入历史 / 仓库初始化

main 还没有任何 commit，或需要把既有历史一次性导入：

```powershell
$env:ALLOW_MAIN_PUSH = "1"
git push origin main
Remove-Item Env:ALLOW_MAIN_PUSH
```

钩子会放行，但打印黄色警告，并把 `[bypass]` 条目追加到 `scripts/guard/bypass.log`
（含时间戳、分支、sha、用户、cwd）。⚠️ 注意 `bypass.log` 当前不进版本库前请自行留存，
或将其加入 git 以形成可追溯记录。

### 场景 B：钩子损坏 / 误报导致 push 失败

先诊断，不要直接卸载：

```powershell
node scripts/guard/install.mjs --status
node scripts/guard/pre-push.mjs < script/guard/test-input.txt   # 复现
```

确认是钩子自身问题 → 修 `pre-push.mjs` 或用 `--remove` 临时卸载并立即开 PR 修复。
**不要**把"卸载钩子"当作常规操作。

### 场景 C：紧急热修（production hotfix）

流程不变，但加速：分支 → push → `gh pr create` → 自查 CI → 立即 squash merge。
0-approve 策略保证单人即可完成全流程，热修不比直接 push 慢几分钟。

### 场景 D：管理员需要修改保护规则本身

```powershell
pwsh scripts/guard/set-branch-protection.ps1 -DryRun   # 先预览
# 按需加 -RequireCiChecks 收紧
```

修改保护规则的 commit 同样走 PR（钩子不拦 `scripts/guard/` 的文件变更）。

### 什么不算正当绕过

- ❌ "CI 慢，先 push 了再说" → 用 `gh pr merge` 的 draft/加速流程
- ❌ "就改一行文档" → docs PR 也走模板，成本 < 1 分钟
- ❌ "钩子烦人" → 先 `--status` 诊断，而不是卸载了事

## 8. 常见问题

**Q: 钩子会不会拦 tag push？**
不会。只匹配 `refs/heads/main|master`；`refs/tags/*` 直接放行。

**Q: 分支名含 main 子串（如 `remain-fix`）会误伤吗？**
不会。钩子精确匹配整个 `refs/heads/<name>`，`refs/heads/remain-fix` ≠ `refs/heads/main`。

**Q: 为什么 enforce_admins 要开？单人项目我就是管理员。**
正因为只有管理员能绕过保护，不开 enforce_admins 等于整个保护形同虚设。

**Q: 换了新机器要注意什么？**
克隆后立即 `node scripts/guard/install.mjs`。远端分支保护自动生效，无需重配。

## 9. 相关文件索引

| 文件 | 角色 |
|---|---|
| `scripts/guard/pre-push.mjs` | 第一层：本地 pre-push 钩子（本文件 §2） |
| `scripts/guard/install.mjs` | 钩子安装器（hooksPath / 复制双策略） |
| `scripts/guard/set-branch-protection.ps1` | 第二层：gh api 配置分支保护 |
| `.github/workflows/ci.yml` | CI（typecheck + build + test 矩阵） |
| `.github/CODEOWNERS` | 文件 ownership（`* @Y1X1n`） |
| `.github/pull_request_template.md` | PR 模板 |
| `CONTRIBUTING.md` | 贡献速查（分支命名 / commit 规范） |
