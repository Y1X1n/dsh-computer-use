<!--
  提交 PR 前请确认：
  - 分支不是 main/master，命名符合 feat/… fix/… chore/… docs/… 规范
  - 已通过本地钩子检查（node scripts/guard/install.mjs --status）
  - CI 通过（typecheck + build + test）
-->

## 概述

<!-- 这个 PR 做了什么？为什么需要它？（一两句话 + 必要的背景） -->

## 变更类型

<!-- 勾选所有适用项 -->

- [ ] ✨ feat — 新功能
- [ ] 🐛 fix — 缺陷修复
- [ ] 📝 docs — 仅文档
- [ ] ♻️ refactor — 重构（无行为变化）
- [ ] 🔧 chore — 构建 / 配置 / 工具链
- [ ] ⚡️ perf — 性能优化
- [ ] ✅ test — 测试补充

## 自查清单

- [ ] commit message 遵循 Conventional Commits（`feat: …` / `fix(scope): …`）
- [ ] 已在本地跑过 `npm run typecheck && npm run build`（或说明跳过原因）
- [ ] 涉及桥接协议 / op 清单的改动已同步更新 `docs/DEVELOPMENT.md` 的协议表
- [ ] 未直接 push 到 main（本 PR 即为唯一入口 🙂）

## 测试方式

<!-- 如何验证？在真实 Windows 环境跑过哪些 op？粘贴关键输出片段。 -->

```text
（测试命令与结果摘要）
```

## 相关问题

<!-- 关联 issue / 任务板编号，如：Closes #12 -->
