# Heinu1 — 基于 iLink 协议的微信 Claude Code 机器人

用微信远程控制家里笔记本上的 Claude Code，随时随地让它帮你干活。

---

## 架构原理

```
手机微信
  │
  │  (iLink Bot API — 官方，HTTP Long-poll，零封号风险)
  ▼
ilinkai.weixin.qq.com
  │
  │  GET /getupdates  (服务端保持连接最长35秒，有新消息才返回)
  ▼
bot/src/main.ts  (本地守护进程，运行在家里的笔记本)
  ├── Monitor  → 长轮询接收消息，解析 context_token
  ├── Router   → 解析命令 / 把普通消息转发给 Claude Code
  │                ↓
  │           claude --print "消息" \
  │                  --resume <session-id> \
  │                  --output-format stream-json \
  │                  --permission-mode bypassPermissions
  │                ↓
  │           逐行解析 JSONL 事件流
  │           (session_id / text / tool_use / result)
  │                ↓
  └── Sender   → POST /sendmessage 把结果发回微信
```

### Claude Code 是怎么被调用的

```
Router.runTask("帮我重构 xxx 文件")
  │
  └─ runClaude(prompt, sessionId)
       │
       ├─ spawn("claude", [
       │    "--print", "帮我重构 xxx 文件",
       │    "--resume", "abc-123",          ← 续接上次会话
       │    "--output-format", "stream-json",
       │    "--permission-mode", "bypassPermissions"
       │  ])
       │
       └─ 逐行读取 stdout（JSONL 格式）：
          {"type":"system","subtype":"init","session_id":"abc-123"}
          {"type":"assistant","message":{"content":[{"type":"text","text":"我来看看..."}]}}
          {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{...}}]}}
          {"type":"assistant","message":{"content":[{"type":"text","text":"重构完成，主要改动是..."}]}}
          {"type":"result","result":"...","session_id":"abc-123","cost_usd":0.02}
            │
            └─ 把 text 块拼起来 + 工具调用摘要发回微信
```

**关键点：**
- `--resume <session-id>` 让 Claude Code 继续上一次的对话上下文（工作目录、已打开的文件等都还在）
- `--output-format stream-json` 让进程输出结构化 JSONL，我们可以实时解析而不是等所有输出
- `--permission-mode bypassPermissions` 家用机信任自己，所有文件读写/Bash 命令全自动执行不弹权限框
- 会话 ID 存在 SQLite 里，重启 bot 也可以 `/resume` 续接之前的工作

### iLink 协议真实 API 路径（已验证）

所有端点都在 `/ilink/bot/` 前缀下（早期文档漏掉了这个前缀，会导致 HTTP 404）：

```bash
# 获取登录二维码
GET  https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3
# → { qrcode: "轮询用的key", qrcode_img_content: "显示用的URL" }

# 轮询扫码状态
GET  https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=<key>
# → { status: "wait|scanned|confirmed", bot_token?, baseurl? }

# 长轮询接收消息（服务端 hold 35秒，有消息才返回）
POST https://ilinkai.weixin.qq.com/ilink/bot/getupdates
Body: { "get_updates_buf": "<cursor>", "base_info": { "channel_version": "1.0.2" } }
# → { msgs: [{from_user_id, context_token, item_list:[{type:1,text_item:{text:"..."}}]}], get_updates_buf }

# 发送消息（嵌套结构，每条消息需要 client_id 去重）
POST https://ilinkai.weixin.qq.com/ilink/bot/sendmessage
Body: {
  "msg": {
    "to_user_id": "...", "context_token": "...",
    "message_type": 2, "message_state": 2,
    "client_id": "唯一ID防重",
    "item_list": [{ "type": 1, "text_item": { "text": "你好" } }]
  },
  "base_info": { "channel_version": "1.0.2" }
}
# → {} 空对象代表成功
```

**注意：** 登录完成后服务器可能返回不同的 `baseurl`，后续请求必须用这个 baseurl 而不是默认的。

---

## 快速开始

### 前置要求

- macOS（有 launchd 支持自动启动）
- Node.js 18+（`node -v` 确认）
- Claude Code 已安装并登录（`claude --version` 确认）
- 微信版本 ≥ 2026.3.20

### 安装

```bash
# 1. 克隆项目
git clone https://github.com/jhfnetboy/Heinu1.git
cd Heinu1/bot

# 2. 安装依赖 + 注册 macOS 开机自启服务
bash setup.sh

# 3. 首次登录（扫码）
npm start
```

终端会显示二维码，用微信扫一扫，添加 **ClawBot** 为联系人。
登录成功后 bot 自动在后台运行，重启电脑也会自动启动。

### 日常使用

在微信里找到 **ClawBot** 联系人，直接发消息：

| 发什么 | 效果 |
|---|---|
| `帮我看看 ~/project/main.py 有没有 bug` | Claude Code 读文件分析 |
| `把刚才的代码提交一下` | Claude Code 执行 git 操作 |
| `现在在做什么进展怎么样` | Claude Code 报告当前状态 |
| `/status` | 查看 bot 运行状态 |
| `/sessions` | 查看历史会话列表 |
| `/resume 2` | 切换到第2个历史会话 |
| `/new` | 开启全新会话（清空上下文） |
| `/help` | 完整命令帮助 |

---

## 配置

权限模式在 `bot/launchd/com.heinu1.wechat-bot.plist` 里调整：

```xml
<key>CLAUDE_PERMISSION_MODE</key>
<string>bypassPermissions</string>  <!-- 改成 acceptEdits 或 default -->
```

| 模式 | 说明 |
|---|---|
| `bypassPermissions` | 全自动，家用机推荐 |
| `acceptEdits` | 编辑文件自动批准，Bash 命令需审批 |
| `default` | 每个操作都弹窗确认 |

修改后重载：
```bash
launchctl unload ~/Library/LaunchAgents/com.heinu1.wechat-bot.plist
launchctl load   ~/Library/LaunchAgents/com.heinu1.wechat-bot.plist
```

---

## 常用命令

```bash
npm start                   # 手动启动（或首次登录）
npm run relogin             # 清除 token 重新扫码
npm run logs                # 实时查看运行日志

launchctl start com.heinu1.wechat-bot   # 后台启动
launchctl stop  com.heinu1.wechat-bot   # 停止
launchctl list | grep heinu1            # 查看服务状态
```

---

## 项目结构

```
Heinu1/
├── bot/                        ← 机器人实现
│   ├── src/
│   │   ├── main.ts             ← 入口：启动 Monitor + Router
│   │   ├── config.ts           ← 配置（路径、API、权限模式）
│   │   ├── router.ts           ← 命令解析 + 任务调度
│   │   ├── ilink/
│   │   │   ├── auth.ts         ← QR 登录，token 持久化
│   │   │   ├── client.ts       ← iLink HTTP 客户端
│   │   │   ├── monitor.ts      ← 长轮询消息接收
│   │   │   ├── sender.ts       ← 发送消息（含分片）
│   │   │   └── types.ts        ← iLink 协议类型定义
│   │   └── claude/
│   │       ├── runner.ts       ← 调用 claude CLI，解析 stream-json
│   │       └── store.ts        ← SQLite 会话管理
│   ├── launchd/
│   │   └── com.heinu1.wechat-bot.plist  ← macOS 开机自启配置
│   ├── start.sh                ← launchd 启动包装脚本（处理 PATH/nvm）
│   └── setup.sh                ← 安装脚本
│
├── docs/
│   └── wechat-bot-research.md  ← iLink 协议调研报告
│
└── libs/                       ← 参考库（git submodule）
    ├── webot/                  ← 微信公众号规则引擎（历史参考）
    ├── webot-example/          ← webot 示例（历史参考）
    ├── ChatGPT-weBot/          ← Windows DLL 注入方案（反面教材）
    └── refs/                   ← iLink 生态参考项目
        ├── openilink-hub/      ← Go+React 全功能平台
        ├── wechatbot-sdk/      ← 多语言 iLink SDK
        ├── wechat-ai-bridge/   ← 最接近本项目的参考实现
        ├── wechat-clawbot/     ← Python 多用户网关
        ├── wechat-ilink-sdk/   ← Go 官方授权 SDK
        ├── weixin-bot-ilink/   ← 零配置 Node SDK
        ├── wechat-acp/         ← ACP 协议桥接
        └── wechat-claude-code/ ← Claude Code Skill 方案
```

---

## iLink 协议说明

iLink 是腾讯于 2026年3月正式发布的**微信个人账号官方 Bot API**，终结了 DLL 注入、Web 协议逆向等非官方方案的时代。

详细技术规范见 `docs/wechat-bot-research.md`。

**核心端点：**
```
Base: https://ilinkai.weixin.qq.com

GET  /get_bot_qrcode?bot_type=3   → 获取登录二维码
GET  /get_qrcode_status           → 轮询扫码状态
POST /getupdates                  → 长轮询接收消息（35s hold）
POST /sendmessage                 → 发送消息
POST /sendtyping                  → 发送"正在输入"指示符
```

**限制：**
- 每个 bot 与创建者个人微信 1:1 绑定
- 当前仅支持私聊，不支持群聊

---

## 故障排查

**`iLink API 返回空响应`** — 可能原因：
1. API 域名不通，检查网络（可能需要代理）
2. iLink 账号未开通，确认微信已更新到 2026.3.20+
3. `bot_type` 参数有变化，参考 `docs/wechat-bot-research.md`

**`Session 过期`** — bot 进程会自动退出，launchd 重启后重新弹出二维码扫码即可。

**日志查看：**
```bash
tail -f ~/.heinu1-bot/bot.log        # 标准输出
tail -f ~/.heinu1-bot/bot.error.log  # 错误日志
```
