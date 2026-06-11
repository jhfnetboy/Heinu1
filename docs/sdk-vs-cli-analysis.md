# Claude Code 接入方式分析：CLI vs SDK

**背景**：Heinu1 bot 需要在家用笔记本上执行真实的编码任务（文件读写、Bash、git 等），通过微信远程触发。

---

## 三条路线

### 路线 A：CLI subprocess（当前方案）

每条消息 `spawn claude --print ... --resume <session-id>`，读 stdout JSONL，进程完成即退出。

**优点**
- 稳定，Anthropic 官方维护 CLI 行为兜底
- `--resume` 开箱即用，session 历史存 `~/.claude/projects/`，不需要自己管对话历史
- Claude Code 内置工具（Bash、Read、Write、Edit、glob…）全部可用
- 不需要额外 API Key，复用 Claude Code 登录状态

**缺点**
- 每条消息有 0.5–2s 进程启动开销
- 只能通过 JSONL 间接拿结果，控制粒度粗

---

### 路线 B：Anthropic API SDK（`@anthropic-ai/sdk`）

直接调 Anthropic API，自己维护 `messages[]` 数组。

**优点**
- 无进程开销，延迟最低
- 完全控制 system prompt、temperature、工具定义

**缺点（对本项目致命）**
- **没有 Claude Code 内置工具**——Bash 执行、文件读写、git 操作全部要自己实现
- 需要单独 API Key，按 token 计费，与 Claude Code 订阅是两套账单
- 对话历史要自己存、自己传，相当于重造 Claude Code 的一半

**结论：不适合。** 核心诉求是"让 Claude 在笔记本上干活"，干活靠的就是内置工具，API SDK 给不了这个。

---

### 路线 C：Claude Code SDK（编程接口，非 CLI）

`@anthropic-ai/claude-code` 包暴露 `query()` 等函数，在 Node.js 进程内直接调用 Claude Code，无需 spawn。

**优点**
- 无 subprocess 开销
- 保留 Claude Code 全部内置工具
- 同进程通信，可以更细粒度拿到流式事件
- 复用 Claude Code auth，无需额外 API Key

**缺点**
- 编程接口比 CLI 更新，文档少，社区案例少
- Claude Code 版本升级时接口可能变动
- `--resume` 等价行为需要验证是否完整支持

---

## 对比总结

| | 路线 A（当前 CLI） | 路线 B（API SDK） | 路线 C（CC SDK） |
|---|---|---|---|
| 内置工具（Bash/文件/git） | ✅ | ❌ | ✅ |
| 无额外 API Key | ✅ | ❌ | ✅ |
| 进程启动开销 | 有（0.5–2s） | 无 | 无 |
| 稳定性 / 文档 | ✅ 成熟 | ✅ 成熟 | ⚠️ 较新 |
| 适合本项目 | ✅ | ❌ | ✅（但有风险） |

---

## 结论与建议

**现阶段继续使用路线 A（CLI subprocess），不迁移。**

理由：
1. 进程开销在本场景不是瓶颈——Claude 推理本身需要几十秒，2s 启动可以忽略
2. CLI 方案稳定可靠，内置工具完整，无额外成本
3. 路线 C（Claude Code SDK）成熟后是有意义的优化方向，但不是现在的问题

**待观察时机**：当 `@anthropic-ai/claude-code` 编程接口文档完善、有社区实践案例时，可以做一次迁移评估。
