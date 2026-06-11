# 微信机器人深度调研报告
> 面向构建「基于 iLink 协议的 Claude Code 微信机器人（小龙虾）」
> 调研日期：2026-06-11

---

## 一、三个参考库的定位与能力

### 1. `node-webot/webot` ★160
**定位：** 面向**微信公众号**的 Node.js 规则引擎中间件，不是个人账号 Bot。

**能力：**
- 基于 RegExp 或自定义函数的消息规则匹配
- 支持同步/异步 handler，session 状态管理，对话链（续接上轮）
- YAML 配置规则、`beforeReply`/`afterReply` 钩子
- 作为 Express 中间件挂载，接收微信公众号推送的 HTTP 回调

**协议基础：** 微信**公众平台官方 API**（`api.weixin.qq.com`，开放 Webhook 回调），非个人账号协议。

**维护状态：** 基本**废弃**，无近期提交，依赖老旧。

---

### 2. `node-webot/webot-example` ★(示例库)
**定位：** `webot` 的完整示例工程，展示如何在 Heroku/Cloud Foundry 部署一个公众号 Bot。

**能力：** 无独立协议能力，完全依赖 `webot`/`weixin-robot`。展示规则目录组织、`.env` 配置、`webot-cli` 本地调试。

**协议基础：** 同上，公众号 Webhook。**维护状态：** 同样**废弃**。

---

### 3. `SnapdragonLee/ChatGPT-weBot` ★651
**定位：** Windows 平台微信个人账号 + ChatGPT 的对话机器人。

**能力：**
- 通过 `wxinject.dll` 注入 WeChat Windows 客户端进程来截获和发送消息
- 多线程调用 GPT-3.5/4 API 回复消息
- 支持 Stable Diffusion 画图、群聊触发词激活、上下文记忆

**协议基础：** **Windows DLL 注入 + 逆向工程**，挂钩 WeChat 私有内存函数。严格绑定 WeChat Windows 版本 3.9.5.81，**极易因微信升级失效**，存在封号风险。

**维护状态：** 最后发版 2023年10月，实质上**已停更**。

---

## 二、底层协议真相：三库 vs. iLink 的对比

| 库 | 底层协议 | 官方支持 | 稳定性 | 适用账号类型 |
|---|---|---|---|---|
| webot | 公众平台官方 Webhook API | ✅ 官方 | 稳定但限公众号 | 公众号（服务号/订阅号） |
| webot-example | 同上 | ✅ 官方 | 同上 | 同上 |
| ChatGPT-weBot | Windows DLL 注入逆向 | ❌ 非官方 | 极不稳定 | 个人微信（仅 Windows） |
| **iLink Bot API** | **腾讯官方个人账号 Bot API** | **✅ 官方** | **高（官方维护）** | **个人微信账号** |

---

## 三、iLink 协议技术规范

**发布时间：** 2026年3月22日 — 微信历史上第一个面向**个人账号**的官方 Bot API。

**主域：** `https://ilinkai.weixin.qq.com`
**媒体：** 腾讯 CDN（AES-128-ECB + PKCS7 加密）

### 认证流程

```
GET /get_bot_qrcode?bot_type=3
  → { qrcode_url, qrcode_key }

轮询 GET /get_qrcode_status?qrcode_key=<key>  (每2s)
  → { status: "wait" | "scanned" | "confirmed", bot_token? }

confirmed 后 → 保存 bot_token 到本地文件
```

### 消息接收（长轮询，非 WebSocket）

```
POST /getupdates
Body: { "get_updates_buf": "<cursor>" }  // 首次为空串
服务端持连接最长 35s

Response: {
  "ret": 0,
  "msg_list": [{
    "msg_id": "...",
    "from_user_openid": "...",
    "msg_type": 1,       // 1=text, 3=image, 34=voice, 43=video, 49=file
    "content": "...",
    "context_token": "...",  // ← 必须缓存并回传！
    "create_time": 1234567890
  }],
  "next_get_updates_buf": "<next_cursor>"
}

ret: -14 → session 过期，需要重新登录
```

### 消息发送

```
POST /sendmessage
Headers:
  Content-Type: application/json
  AuthorizationType: ilink_bot_token
  Authorization: Bearer <bot_token>
  X-WECHAT-UIN: base64(String(random_uint32))  // 每次随机生成

Body: {
  "to_user_openid": "...",
  "context_token": "...",  // ← 从收到的消息中取
  "msg_type": 1,
  "content": "Hello"
}
```

### 媒体处理

```
上传：POST /getuploadurl → POST <CDN_URL>（AES-128-ECB + PKCS7 加密）
下载：GET CDN 链接，自行解密
```

### 关键约束

- **1:1 绑定**：每个 iLink Bot 与创建者个人微信账号 1:1 绑定
- **仅私聊**：当前不支持群聊
- **无封号风险**：官方协议

---

## 四、全网调研：WeChat + Claude Code 现有实现

### 推荐项目列表

| 项目 | 语言 | 特点 | Stars |
|---|---|---|---|
| [AliceLJY/wechat-ai-bridge](https://github.com/AliceLJY/wechat-ai-bridge) | JS/Bun | 最完整：会话管理+工具审批+文件中继 | — |
| [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) | Node.js | Claude Code Skill，launchd集成 | — |
| [nightsailer/wechat-clawbot](https://github.com/nightsailer/wechat-clawbot) | Python | 多用户网关，MCP SSE | — |
| [openilink/openilink-hub](https://github.com/openilink/openilink-hub) | Go+React | 全功能平台，20+应用接入 | 1300+ |
| [corespeed-io/wechatbot](https://github.com/corespeed-io/wechatbot) | TS/Py/Go/Rust | 多语言 iLink SDK | 485 |
| [the-yex/wechat-ilink-sdk](https://github.com/the-yex/wechat-ilink-sdk) | Go | 官方授权 Go SDK | 9 |
| [epiral/weixin-bot](https://github.com/epiral/weixin-bot) | Node.js | 零配置 iLink SDK | — |
| [formulahendry/wechat-acp](https://github.com/formulahendry/wechat-acp) | Node.js | ACP协议桥接，支持多AI | — |

### wechat-ai-bridge 架构（最推荐参考）

```
手机微信 ↔ iLink Server ↔ wechat-ai-bridge (Bun) ↔ Claude Code / Codex / Gemini
```

亮点：
- 会话持久化（SQLite），重启不丢失，`/new` `/resume <n>` `/sessions`
- 工具审批流：每次工具调用发到微信，用户回复 1/2/3/4 审批
- 双向文件中继：AES 解密/加密 CDN 文件
- 多后端切换：`/backend claude|codex|gemini`
- FlushGate 消息批合并（800ms），滑动窗口限流，指数退避重试

---

## 五、本项目实现方案

见 `../bot/` 目录。

架构：

```
手机微信 → iLink API (long-poll) → Node.js 守护进程 → Claude Code CLI (stream-json)
```

关键设计决策：
- **会话管理**：SQLite 存储，`--resume <session-id>` 续接 Claude Code 会话
- **工具权限**：默认 `bypassPermissions`（家用机信任本机），可配置
- **消息分片**：超过 1800 字自动分段发送
- **macOS 自启**：launchd plist，开机自动启动，崩溃自动重启
- **重登录**：iLink session 过期（ret: -14）→ 进程退出 → launchd 重启 → 重新 QR 登录

---

## 六、参考资料

- [什么是 iLink？| AllClaw 博客](https://allclaw.org/blog/what-is-ilink)
- [iLink 协议技术规范](https://www.wechatbot.dev/en/protocol)
- [WeChatBot 多语言 SDK](https://github.com/corespeed-io/wechatbot)
- [WeChat iLink SDK (Go)](https://github.com/the-yex/wechat-ilink-sdk)
- [wechat-ai-bridge](https://github.com/AliceLJY/wechat-ai-bridge)
- [wechat-claude-code Skill](https://github.com/Wechat-ggGitHub/wechat-claude-code)
- [wechat-clawbot Python 网关](https://github.com/nightsailer/wechat-clawbot)
- [OpeniLink Hub 平台](https://github.com/openilink/openilink-hub)
- [epiral/weixin-bot](https://github.com/epiral/weixin-bot)
- [wechat-acp ACP 桥接](https://github.com/formulahendry/wechat-acp)
