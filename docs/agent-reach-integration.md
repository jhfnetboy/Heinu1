# Agent-Reach 集成分析

**仓库**：https://github.com/Panniantong/Agent-Reach  
**子模块路径**：`libs/agent-reach/`  
**Stars**：~34K（2026-06 爆火，单日+1161）

---

## 它是什么

Agent-Reach **不是爬虫库**，而是一个面向 AI Agent 的"工具链安装器 + 健康检查器"。

它做两件事：
1. **一键安装**底层平台工具（`twitter-cli`、`yt-dlp`、`gh`、`bili-cli`、`rdt-cli` 等）
2. **健康检查**已安装工具的状态（`agent-reach doctor`）

安装完之后，Agent 直接调用这些底层工具，不经过 Agent-Reach 本身。

```
Agent-Reach = npm install 的角色，不是 axios 的角色
```

---

## 支持平台

| 平台 | 底层工具 | 安装方式 |
|------|---------|---------|
| Twitter/X | twitter-cli | npm |
| Reddit | rdt-cli | pip |
| YouTube | yt-dlp | pip |
| GitHub | gh CLI | brew/pkg |
| Bilibili | bili-cli | pip |
| 小红书 | xiaohongshu-mcp | npm |
| 通用网页 | jina reader (curl) | 无需安装 |

---

## 嵌入 Heinu1 的方式

### 核心结论

**Heinu1 的代码不需要任何改动。**

Heinu1 的架构是：微信消息 → spawn `claude` → Claude Code 在工作区执行。Claude Code 本来就能 shell out，只要工作区机器上装了这些工具，Claude 可以直接调用。

Agent-Reach 解决的正是"工具没装"的问题。

### 集成步骤（一次性）

在工作区机器上运行：

```bash
pip install agent-reach
agent-reach install --env=auto   # 自动检测并安装所有底层工具
agent-reach doctor               # 验证安装状态
```

装完之后，在微信里发任务给 Claude 就能直接用：

```
你帮我搜索 Twitter 上关于 Claude Code 的最新讨论
你把这个 YouTube 视频的字幕提取出来：https://...
你查一下 B站 上 "AI编程" 相关的热门视频
```

Claude 会自己调用 `twitter search "..."`, `yt-dlp ...`, `bili search ...` 等命令。

### 可选：写入 workspace 的 SKILL.md

Agent-Reach 支持把使用说明写入 workspace 的 SKILL.md，让 Claude 自动知道有哪些工具可用：

```bash
cd /path/to/your/workspace
agent-reach skill install
```

这会在工作区根目录生成 `SKILL.md`，Claude Code 读取后会知道可以调用哪些平台工具。

### 可选：setup.sh 自动安装

在 `bot/setup.sh` 里加一步（可选，需要 Python 环境）：

```bash
if command -v pip &>/dev/null; then
  echo "🕸  安装 Agent-Reach 工具链..."
  pip install -q agent-reach
  agent-reach install --env=auto
fi
```

---

## 架构影响评估

| 维度 | 评估 |
|------|------|
| Heinu1 代码改动量 | 零 |
| 工具安装 | 一次性，在工作区机器上跑 |
| Claude 调用方式 | 已有的 shell out 能力，无需适配 |
| 风险 | 底层工具各有 auth 配置（twitter cookie 等），需要逐个配置 |
| 价值 | 让 Claude 获得"眼睛"——能主动搜索各平台内容，而不只是处理用户发来的内容 |

---

## 当前状态

- `libs/agent-reach/` 子模块已加入，供参考阅读
- 底层工具的 auth 配置文档：`libs/agent-reach/docs/` 或 `agent-reach configure --help`
