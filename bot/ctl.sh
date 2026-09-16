#!/bin/bash
# Heinu1 WeChat Bot —— 手动启停控制脚本
#
# 用于「不开机自启、我说启动才启动」的机器（例如日常办公的 MacBook）。
# 24 小时常驻请用 launchd（见 docs/DEPLOY-MACMINI.md），不要用这个脚本。
#
#   ./ctl.sh start            后台启动
#   ./ctl.sh fg               前台启动（首次扫码登录用，Ctrl-C 退出）
#   ./ctl.sh stop             停止
#   ./ctl.sh restart          重启
#   ./ctl.sh status           查看状态
#   ./ctl.sh logs             实时日志（Ctrl-C 退出）
#   ./ctl.sh autostart status|off|on   开机自启开关（launchd）

set -euo pipefail

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$HOME/.heinu1-bot"
PID_FILE="$DATA_DIR/bot.pid"
LOG_FILE="$DATA_DIR/bot.log"
ERR_FILE="$DATA_DIR/bot.error.log"
PLIST_NAME="com.heinu1.wechat-bot"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

mkdir -p "$DATA_DIR"

# 进程的当前工作目录（用来判断相对路径启动的实例属不属于本目录）
proc_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

# 进程是不是我们的 bot：PID 存在，且跑的确实是本目录的 src/main.ts。
# 注意有两种启动方式，命令行长得不一样，两种都要认：
#   launchd / ctl.sh start → 绝对路径  tsx /path/to/bot/src/main.ts
#   npm start             → 相对路径  tsx src/main.ts   （cwd 才是 bot 目录）
# 只匹配绝对路径的话，手动 npm start 起的实例是隐形的，会出现两个实例同时
# 长轮询、每条微信消息被回两遍，而 status 只报告得出一个。
is_our_bot() {
  local pid="$1" cmd
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  case "$cmd" in
    *"$BOT_DIR/src/main.ts"*) return 0 ;;
    *src/main.ts*) [ "$(proc_cwd "$pid")" = "$BOT_DIR" ] && return 0 ;;
  esac
  return 1
}

# 列出所有属于本目录的 bot 进程 pid（含 tsx fork 出来的子进程），按启动顺序
all_bot_pids() {
  local pid
  for pid in $(pgrep -f "src/main.ts" 2>/dev/null); do
    is_our_bot "$pid" && echo "$pid"
  done
}

# 找出正在跑的 bot 主进程 pid（先看 pid 文件，再全局扫一遍，兼容 launchd 起的）
running_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if is_our_bot "$pid"; then echo "$pid"; return 0; fi
    rm -f "$PID_FILE"
  fi
  # tsx 会 fork 一个子进程，两个都匹配；取最早的那个（父进程）
  all_bot_pids | head -1
}

autostart_loaded() {
  launchctl list 2>/dev/null | grep -q "$PLIST_NAME"
}

warn_if_autostart() {
  if autostart_loaded; then
    echo "⚠️  launchd 开机自启服务 (${PLIST_NAME}) 处于加载状态。"
    echo "   它会在进程退出后自动把 bot 拉起来，手动 stop 挡不住它。"
    echo "   本机若不想常驻，先执行：./ctl.sh autostart off"
    echo ""
  fi
}

cmd_start() {
  local pid
  pid="$(running_pid || true)"
  if [ -n "$pid" ]; then
    echo "✅ bot 已经在运行了 (PID $pid)，无需重复启动"
    return 0
  fi

  # launchd 已加载时绝不手动 nohup fork：stop 之后到 launchd 的 KeepAlive 真正
  # 把它拉起来之间有个空档（ThrottleInterval 10s），这段时间 running_pid 是空的，
  # 如果这里再手动 fork 一个，就会跟 launchd 稍后拉起的那个变成两个实例同时
  # 长轮询——这正是之前 restart 之后出现 4 个 pid 的原因。autostart 开着时，
  # 交给 launchd 自己重启，不要跟它抢。
  if autostart_loaded; then
    echo "🦞 launchd 常驻已启用，交给 launchd 拉起（不手动 fork，避免和它抢）…"
    launchctl kickstart -k "gui/$(id -u)/$PLIST_NAME" 2>/dev/null \
      || { echo "❌ launchctl kickstart 失败"; return 1; }
    sleep 2
    pid="$(running_pid || true)"
    if [ -n "$pid" ]; then
      echo "✅ 已启动 (PID $pid)"
      echo "   日志：$LOG_FILE   （./ctl.sh logs 实时看）"
    else
      echo "❌ 启动失败，最后 20 行错误日志："
      tail -20 "$ERR_FILE" || true
      return 1
    fi
    return 0
  fi

  echo "🦞 启动 Heinu1 WeChat Bot（后台）…"
  cd "$BOT_DIR"
  nohup ./start.sh >>"$LOG_FILE" 2>>"$ERR_FILE" &
  local newpid=$!
  echo "$newpid" >"$PID_FILE"
  sleep 2
  if is_our_bot "$newpid" || kill -0 "$newpid" 2>/dev/null; then
    echo "✅ 已启动 (PID $newpid)"
    echo "   日志：$LOG_FILE   （./ctl.sh logs 实时看）"
    echo ""
    echo "   若这是本机第一次运行 / token 已过期，需要扫码："
    echo "   先 ./ctl.sh stop，再 ./ctl.sh fg 在前台扫二维码。"
  else
    rm -f "$PID_FILE"
    echo "❌ 启动失败，最后 20 行错误日志："
    tail -20 "$ERR_FILE" || true
    return 1
  fi
}

cmd_fg() {
  local pid
  pid="$(running_pid || true)"
  if [ -n "$pid" ]; then
    echo "❌ bot 已在运行 (PID $pid)，先 ./ctl.sh stop"
    return 1
  fi
  warn_if_autostart
  echo "🦞 前台启动（Ctrl-C 退出）…"
  cd "$BOT_DIR"
  exec ./start.sh "$@"
}

cmd_stop() {
  local pid
  pid="$(running_pid || true)"
  if [ -z "$pid" ]; then
    echo "ℹ️  bot 没有在运行"
    rm -f "$PID_FILE"
    autostart_loaded && echo "   （但 launchd 自启服务仍是加载状态，随时可能把它拉起来）"
    return 0
  fi
  echo "🛑 停止 bot (PID $pid)…"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "   进程没响应 SIGTERM，发 SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi
  # tsx 的子进程、以及 npm start 起的相对路径实例，一并收掉
  for p in $(all_bot_pids); do kill -9 "$p" 2>/dev/null || true; done
  rm -f "$PID_FILE"
  echo "✅ 已停止"
  if autostart_loaded; then
    echo "⚠️  launchd 自启服务仍加载着，它会在 ~10s 内把 bot 重新拉起来。"
    echo "   要彻底停：./ctl.sh autostart off"
  fi
}

cmd_status() {
  local pid
  pid="$(running_pid || true)"
  if [ -n "$pid" ]; then
    echo "状态：🟢 运行中 (PID $pid)"
    ps -o pid,etime,rss,command= -p "$pid" | sed 's/^/      /'
  else
    echo "状态：⚪️ 未运行"
  fi

  # 同一个账号被两个实例长轮询 → 每条微信消息会被回两遍。tsx 自己会 fork 一个
  # 子进程，所以「一个实例」正常是 2 个 pid；多于 2 个就是真的起重了。
  local pids count
  pids="$(all_bot_pids | tr '\n' ' ')"
  count="$(echo $pids | wc -w | tr -d ' ')"
  if [ "$count" -gt 2 ]; then
    echo ""
    echo "⚠️  检测到多个 bot 实例在跑 (PID: $pids)"
    echo "   两个实例会同时长轮询同一个账号，每条消息被处理两遍（微信里表现为回复两次）。"
    echo "   通常是 launchd 已经起了一个，又手动跑了 npm start。"
    echo "   处理：./ctl.sh stop && ./ctl.sh start  （或只留 launchd：./ctl.sh stop 后不要手动起）"
  fi
  if autostart_loaded; then
    echo "开机自启：🟢 已启用（launchd ${PLIST_NAME}）"
  elif [ -f "$PLIST_DEST" ]; then
    echo "开机自启：⚪️ 已禁用（plist 文件还在：${PLIST_DEST}）"
  else
    echo "开机自启：⚪️ 未安装"
  fi
  echo "日志：$LOG_FILE"
  [ -f "$LOG_FILE" ] && echo "最近 5 行：" && tail -5 "$LOG_FILE" | sed 's/^/      /'
}

cmd_logs() {
  touch "$LOG_FILE"
  tail -f "$LOG_FILE"
}

cmd_autostart() {
  case "${1:-status}" in
    status)
      if autostart_loaded; then echo "🟢 开机自启：已启用"; else echo "⚪️ 开机自启：已禁用"; fi
      ;;
    off)
      launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null \
        || launchctl unload "$PLIST_DEST" 2>/dev/null \
        || true
      echo "✅ 已关闭开机自启（bot 进程也随之退出）"
      echo "   之后用 ./ctl.sh start / stop 手动控制"
      ;;
    on)
      if [ ! -f "$PLIST_DEST" ]; then
        echo "❌ 没找到 $PLIST_DEST，先跑一次：bash setup.sh"
        return 1
      fi
      launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null \
        || launchctl load "$PLIST_DEST" 2>/dev/null \
        || true
      echo "✅ 已开启开机自启，bot 将常驻并自动重启"
      ;;
    *)
      echo "用法：./ctl.sh autostart status|off|on"; return 1 ;;
  esac
}

case "${1:-status}" in
  start)     cmd_start ;;
  fg)        shift; cmd_fg "$@" ;;
  stop)      cmd_stop ;;
  restart)   cmd_stop; sleep 1; cmd_start ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  autostart) shift; cmd_autostart "$@" ;;
  *)
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    exit 1 ;;
esac
