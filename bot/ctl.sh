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

# 进程是不是我们的 bot：PID 存在，且命令行里确实是本目录的 src/main.ts
is_our_bot() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -o command= -p "$pid" 2>/dev/null | grep -q "$BOT_DIR/src/main.ts"
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
  pgrep -f "$BOT_DIR/src/main.ts" 2>/dev/null | head -1
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
  warn_if_autostart
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
  # tsx 的子进程可能还活着，一并收掉
  pkill -f "$BOT_DIR/src/main.ts" 2>/dev/null || true
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
