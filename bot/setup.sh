#!/bin/bash
# Heinu1 WeChat Bot — 安装脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.heinu1.wechat-bot"
PLIST_SRC="$SCRIPT_DIR/launchd/$PLIST_NAME.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
DATA_DIR="$HOME/.heinu1-bot"

echo "🦞 Heinu1 WeChat Bot 安装脚本"
echo "================================"
echo ""

# 1. 安装 npm 依赖
echo "📦 安装依赖..."
cd "$SCRIPT_DIR"
npm install
echo "✅ 依赖安装完成"
echo ""

# 2. 权限
chmod +x "$SCRIPT_DIR/start.sh"

# 3. 创建数据目录
mkdir -p "$DATA_DIR"

# 4. 安装 launchd plist
echo "⚙️  配置 macOS 开机自启服务..."
mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DEST"

# 卸载旧版本（如果存在）
launchctl unload "$PLIST_DEST" 2>/dev/null || true

echo ""
echo "✅ 安装完成！"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📱 下一步：完成微信登录"
echo "   运行：  cd $SCRIPT_DIR && npm start"
echo "   扫码后，机器人会自动注册为开机自启服务"
echo ""
echo "📝 常用命令："
echo "   npm start                       首次登录 / 手动启动"
echo "   npm run relogin                 重新扫码登录"
echo "   npm run logs                    实时查看日志"
echo "   launchctl load   $PLIST_DEST    加载服务（开机自启）"
echo "   launchctl unload $PLIST_DEST    停止开机自启"
echo "   launchctl start  $PLIST_NAME    手动启动服务"
echo "   launchctl stop   $PLIST_NAME    手动停止服务"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "⚙️  权限模式（当前：bypassPermissions = 全自动）"
echo "   修改 launchd/$PLIST_NAME.plist 中的 CLAUDE_PERMISSION_MODE："
echo "   - bypassPermissions  全自动执行（推荐家用）"
echo "   - acceptEdits        自动执行编辑，其他询问"
echo "   - default            每次操作都询问"
