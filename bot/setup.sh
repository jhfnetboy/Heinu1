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

# 3. 安装 bin 工具到 ~/bin
echo "🔧 安装 bin 工具..."
mkdir -p "$HOME/bin"
cp "$SCRIPT_DIR/../bin/provider_balance.py" "$HOME/bin/provider_balance.py"
chmod +x "$HOME/bin/provider_balance.py"
echo "   ✅ provider_balance.py → ~/bin/"
echo "      用法：python3 ~/bin/provider_balance.py  (或配置 see 别名)"
echo ""

# 4. 创建数据目录
mkdir -p "$DATA_DIR"

# 4. 安装 launchd plist（用本机实际路径替换模板占位符）
echo "⚙️  配置 macOS 开机自启服务..."
mkdir -p "$HOME/Library/LaunchAgents"

# 卸载旧版本（如果存在），再写入按本机路径渲染的配置
launchctl unload "$PLIST_DEST" 2>/dev/null || true

sed -e "s|__BOT_DIR__|$SCRIPT_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DEST"

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
echo "⚙️  执行后端：Codex（AGENT_PROVIDER=codex）"
echo "   模型默认 gpt-6-luna / medium，可用微信 /model 命令切换。"
echo "   权限：CODEX_SANDBOX_MODE=danger-full-access，approval_policy=never。"
echo "   如需原 Claude 后端，改已安装 plist 中 AGENT_PROVIDER=claude 后重载。"
