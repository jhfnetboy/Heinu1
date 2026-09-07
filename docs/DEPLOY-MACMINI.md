# 在 Mac mini 上 7×24 小时跑 Heinu1 微信机器人

这份文档是**从零到常驻**的完整操作手册：在一台新的 Mac mini 上把 Heinu1 装好、扫码登录、
交给 launchd 保活，断网/睡眠/重启后都能自己活过来。

按顺序照抄命令即可。全程约 30 分钟，其中大部分时间在装依赖。

> **一个账号同一时间只能有一台机器在线。**
> ClawBot 的 token 绑定在你的微信账号上，两台机器同时长轮询会互相抢消息（一条消息只会被
> 其中一台收到，表现为"有时候不回复"）。所以**迁移到 Mac mini 之前，务必先把原来那台机器停掉**
> （见文末「从旧机器迁移」）。

---

## 0. 先决条件清单

| 项目 | 要求 | 检查命令 |
|---|---|---|
| 机器 | Mac mini（Apple Silicon / Intel 都行），macOS 13+ | `sw_vers` |
| 用户 | 一个**能自动登录的桌面用户**（launchd GUI agent 需要图形登录会话） | — |
| Node.js | 18+（推荐 20/22） | `node -v` |
| Claude Code | 已安装并**已登录**（订阅或 API key） | `claude --version` && `claude -p "hi"` |
| 微信 | ≥ 2026.3.20（支持 iLink Bot），手机上能扫码 | 微信 → 关于微信 |
| 网络 | 能直连 `ilinkai.weixin.qq.com` 与 Anthropic API（必要时配代理，见第 6 节） | — |
| 磁盘 | ≥ 10 GB 可用（工作区 + 知识库 + 日志） | `df -h ~` |

---

## 1. 让 Mac mini 具备"永不下线"的体质

这一步比装软件更重要。默认设置下的 Mac mini 会睡觉，睡着了机器人就收不到消息。

```bash
# 1) 永不睡眠（接电源时）；关掉硬盘休眠
sudo pmset -c sleep 0 disksleep 0 displaysleep 10

# 2) 断电恢复后自动开机
sudo pmset -a autorestart 1

# 3) 系统崩溃后自动重启
sudo systemsetup -setrestartfreeze on

# 4) 确认结果（sleep 应为 0，autorestart 应为 1）
pmset -g custom
```

再到 **系统设置** 里手动打开两项（命令行改不了，必须点）：

1. **用户与群组 → 自动登录 → 选中你的用户**
   —— 否则重启后停在登录界面，launchd 的用户级 agent 不会启动，机器人也就不会起来。
2. **通用 → 共享 → 打开「远程登录 (SSH)」**（建议再开「屏幕共享」）
   —— 以后你要从 MacBook 上 `ssh macmini.local` 看日志、重启服务，不用每次走到机器跟前。

> 如果 Mac mini 用无线网，建议在「Wi-Fi → 高级」里把家里的网络设为**自动加入且优先级最高**。
> 有线网更稳，能插网线就插网线。

---

## 2. 装依赖

```bash
# Homebrew（已装可跳过）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js
brew install node          # 或者用 nvm 装 20/22

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude          # 走一遍登录流程（浏览器授权或填 API key）
claude -p "说一句你好"     # 必须能正常返回，否则机器人也跑不通
```

**Claude Code 一定要在这台机器上登录成功再往下走。** 机器人只是 `spawn("claude", ...)`，
它自己不管认证；`claude -p` 跑不通，机器人收到消息也只会回一句错误。

---

## 3. 拉代码

```bash
mkdir -p ~/Dev/tools && cd ~/Dev/tools
git clone --recurse-submodules https://github.com/jhfnetboy/Heinu1.git
cd Heinu1/bot
```

> 忘了 `--recurse-submodules` 的话补一条：`git submodule update --init --recursive`。
> 子模块里的 `libs/agent-reach` 是抓小红书/公众号链接正文用的；不初始化的话，
> 转发链接进来会抓不到内容（其他功能不受影响）。

---

## 4. 安装 + 首次扫码登录

```bash
cd ~/Dev/tools/Heinu1/bot
bash setup.sh
```

`setup.sh` 做四件事：`npm install` → 装 `~/bin/provider_balance.py` → 建 `~/.heinu1-bot/`
→ 把 `launchd/com.heinu1.wechat-bot.plist` 按**本机实际路径**渲染后写进 `~/Library/LaunchAgents/`
（模板里的 `__BOT_DIR__` / `__HOME__` 会被替换，所以换机器、换目录都不用手改 plist）。

然后配置工作区——告诉机器人你的项目在哪，第一个自动成为默认：

```bash
npm run ws -- add main  ~/Dev/myproject "主项目"
npm run ws -- add blog  ~/Dev/blog      "博客"
npm run ws -- list      # ★ 标记的是默认工作区
```

最后**在前台**跑一次，扫码：

```bash
npm start
```

终端会打印二维码 → 用手机微信扫 → 把 **ClawBot** 加为联系人 → 看到
`✅ 机器人已启动` 就成了。此时 token 已写进 `~/.heinu1-bot/token.json`（权限 600），
以后重启不用再扫。

在微信里给 ClawBot 发一句「你好，报一下当前工作区」验证链路通了，然后 `Ctrl-C` 停掉前台进程。

> 没有显示器？SSH 进去跑 `npm start` 也能在终端里看到二维码（用等宽字体的终端，字号别太小）。

---

## 5. 交给 launchd 常驻

```bash
cd ~/Dev/tools/Heinu1/bot
./ctl.sh autostart on      # 等价于 launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.heinu1.wechat-bot.plist
./ctl.sh status            # 应该看到「运行中」+「开机自启：已启用」
```

从此这台机器就是 24 小时在线的了。plist 里已经配好三层自愈：

| 机制 | 位置 | 作用 |
|---|---|---|
| `RunAtLoad` | plist | 开机 / 登录即启动 |
| `KeepAlive: true` | plist | **无条件保活**：崩溃、干净退出、睡眠被杀，一律拉起 |
| `ThrottleInterval: 10` | plist | 两次重启至少隔 10s，防止炸开循环 |
| 连接看门狗 | `src/config.ts` `WATCHDOG_TIMEOUT_MS` | 180s 没有一次成功的长轮询 → 主动 `exit(1)` 让 launchd 重启，解决"进程活着但收不到消息" |

日常查看：

```bash
./ctl.sh status                        # 状态一览
npm run logs                           # 实时日志（= tail -f ~/.heinu1-bot/bot.log）
tail -50 ~/.heinu1-bot/bot.error.log   # 错误日志
launchctl list | grep heinu1           # 第二列是上次退出码，0 正常
```

改完代码或改完 plist 之后重载：

```bash
./ctl.sh autostart off && ./ctl.sh autostart on
```

---

## 6. 网络需要走代理时

launchd 启动的进程**拿不到你 shell 里的环境变量**，代理必须写死在 `bot/start.sh` 里
（文件末尾已经留好了注释掉的三行，取消注释并改成你的端口）：

```bash
export HTTP_PROXY="http://127.0.0.1:7890"
export HTTPS_PROXY="http://127.0.0.1:7890"
export ALL_PROXY="socks5://127.0.0.1:7890"
```

同理，代理软件本身也得是开机自启的，否则 Mac mini 重启后机器人先起来、代理还没起，
第一轮请求会失败（有 KeepAlive 兜底，会重试，但日志会难看一阵）。

---

## 7. 知识库（可选但推荐）

转发进来的链接、图片、文件会自动进全局 MemPalace（`~/.mempalace/palace`）。
这台机器上要能用，需要有 MemPalace 的 venv：

```bash
ls ~/.mempalace/venv/bin/python    # 有就不用管
```

没有的话，按 `mempalace` 项目的说明装好，或者用环境变量指到别的解释器：
在 plist 的 `EnvironmentVariables` 里加 `MEMPALACE_PYTHON`。
**知识库不可用不影响机器人主功能**，只是入库那一步会失败并在日志里报错。

---

## 8. 从旧机器迁移

在**旧机器**上：

```bash
cd <旧机器上的 Heinu1>/bot
./ctl.sh autostart off     # 关掉开机自启，进程一并退出
./ctl.sh status            # 确认「未运行」
```

需要的话把这些状态文件拷到 Mac mini（`~/.heinu1-bot/` 全目录都可以直接拷）：

| 文件 | 内容 | 拷了有什么好处 |
|---|---|---|
| `token.json` | 微信登录态 | 不用重新扫码（**权限必须是 600**） |
| `workspaces.json` | 工作区配置 | 不用重新 `ws add` |
| `sessions.db` | 每个工作区的会话历史 | `/sessions`、`/resume` 还能翻到旧对话 |
| `media/`、`kb/raw/` | 历史图片文件 | 旧记录里的附件还在 |

```bash
# 在 Mac mini 上执行
rsync -av 旧机器用户@旧机器.local:~/.heinu1-bot/ ~/.heinu1-bot/
chmod 600 ~/.heinu1-bot/token.json
```

拷完在 Mac mini 上 `./ctl.sh autostart on`，微信里发条消息验证。

> token 拷过来后如果提示登录失效，跑 `npm run relogin` 重新扫码即可——旧机器上的 token 会作废，
> 这正是我们想要的（保证只有一台在线）。

---

## 9. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| `launchctl list` 里退出码是 1，进程反复重启 | 十有八九是 `claude` 跑不通或代理没配。**用 launchd 的干净环境复现**：`env -i HOME=$HOME /bin/bash -lc 'cd ~/Dev/tools/Heinu1/bot && ./start.sh'`，看真实报错 |
| 微信发消息没反应，但进程在跑 | 看 `bot.log` 有没有 `[monitor]` 长轮询记录；180s 没成功轮询看门狗会自杀重启。也确认没有第二台机器在抢消息 |
| 重启 Mac mini 后机器人没起来 | 没开自动登录（第 1 节）。用户级 launchd agent 必须有图形登录会话 |
| 提示 token 失效 / 要求重新扫码 | `./ctl.sh autostart off` → `npm run relogin` 扫码 → `./ctl.sh autostart on` |
| 回复很慢或超时 | 正常，`claude` 真在干活；`/status` 看进度，`/stop` 可中止当前任务 |
| 链接转发进来抓不到正文 | `git submodule update --init --recursive` 没跑，`libs/agent-reach` 是空的 |
| 想改权限模式 | 编辑 `~/Library/LaunchAgents/com.heinu1.wechat-bot.plist` 里的 `CLAUDE_PERMISSION_MODE`，然后 `./ctl.sh autostart off && ./ctl.sh autostart on` |

---

## 10. 两台机器的分工建议

| 机器 | 角色 | 怎么控制 |
|---|---|---|
| Mac mini | 7×24 常驻，真正接微信 | `./ctl.sh autostart on`，之后不用管 |
| MacBook（日常办公） | 开发调试用，**不常驻** | `./ctl.sh autostart off`，需要时 `./ctl.sh start` / `./ctl.sh stop` |

两台机器上的 `ctl.sh` 完全一样，区别只在 `autostart` 开没开。
**同一时间只让一台跑**，另一台调试前先把 Mac mini 上的停掉。
