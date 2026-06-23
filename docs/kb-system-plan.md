# 个人知识库系统（KB）建设计划

## 目标

通过微信 bot 发图片/文字，**30 秒内**完成一条知识库记录的全流程：

```
微信发消息（图片 + 文字）
  → 下载原始文件（raw/）
  → Claude skill 分析、信息提取
  → 写结构化记录（records/）
  → 同步 SQLite 全文索引 + RAG 向量库
  → 若带后续指令 → 触发对应 skill（发 blog / 深度分析 / 发公众号 / 配图等）
```

核心理念：**信息流会忘，知识库会记** —— 把采集到的内容沉淀为可检索、可被其他
skill 调用的第二大脑。

## 参考项目（GitHub Top 个人知识库系统调研）

| 项目 | Stars | 借鉴点 |
|------|-------|--------|
| [llm-wiki-agent](https://github.com/SamurAIGPT/llm-wiki-agent) | 3k | 流程 / 目录结构最干净，raw→wiki 范式，Claude Code skill |
| [chubbyskills](https://github.com/chubbyguan/chubbyskills) | 443 | 中文多渠道采集 skill + KB MCP server，可直接复用 |
| [atomic](https://github.com/kenforthewin/atomic) | 1.5k | RAG 底层（chunking + embedding + 语义搜索）设计思路 |
| [second-brain](https://github.com/NicholasSpisak/second-brain) | 410 | Karpathy LLM Wiki 模式，Obsidian 浏览 |
| TriliumNext/Trilium | 36k | 传统笔记应用，非 skill，仅作对照 |

## 目录结构

```
Heinu1/kb/
├── raw/              # 原始文件（图片、文本、语音转写）按日期/uuid 归档
├── records/          # 每条记录的 JSON（metadata + 分析结果）
├── wiki/             # 概念 / 实体页面（llm-wiki-agent 风格，可选）
├── db/
│   ├── kb.db         # SQLite：records 表 + FTS5 全文搜索
│   └── vectors.db    # sqlite-vec：向量 RAG
└── skills-trigger.md # 入库后可触发的 skill 映射表
```

## Git 工作流

- **主 feature 分支**：`feature/kb`
- 每个阶段开 **git worktree** 并行/隔离开发 → PR 合并回 `feature/kb`
- 每次合并前：**自我挑战式 review** + **Codex adversarial review**
- 全部阶段完成后：`feature/kb` → `main` 最终 PR 发布

## 阶段拆分

### Phase 1 — kb-ingest（最小可行流水线）
接收图片 + 文字 → 存 `raw/` → 写 SQLite 基础记录（含 FTS5 全文索引）。
跑通 30 秒入库闭环，**先不上 RAG**。

### Phase 2 — RAG 检索
引入 `sqlite-vec`，对记录做 embedding，提供语义搜索接口。

### Phase 3 — skill 触发
解析入库后的后续指令（"发 blog"、"深度分析"等），路由到对应 skill。
部分 skill 在其他仓库（如 blog 在 `~/Dev/mycelium/blog`），需跨仓库调用。

### Phase 4 — KB MCP server
暴露知识库查询能力为 MCP server，让任意 skill 能检索知识库。

## 设计原则

- **借鉴优先级**：流程结构 → llm-wiki-agent；中文多模态采集 → chubbyskills；
  RAG 底层 → atomic 的轻量 sqlite-vec 实现。
- **30 秒约束**：Phase 1 入库必须快，重分析（embedding、wiki 合成）可异步补做。
- **Claude Code 原生**：所有能力优先做成 skill，复用现有生态而非重造轮子。
