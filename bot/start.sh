#!/bin/bash
# Wrapper script for launchd — ensures proper PATH and Node.js environment

# Homebrew (Apple Silicon / Intel)
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Claude Code CLI (~/.local/bin/claude)
export PATH="$HOME/.local/bin:$PATH"

# nvm (if installed)
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Volta (if installed)
export VOLTA_HOME="$HOME/.volta"
[ -d "$VOLTA_HOME/bin" ] && export PATH="$VOLTA_HOME/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Proxy for Anthropic API access — uncomment if behind a firewall/VPN
# export HTTP_PROXY="http://127.0.0.1:7890"
# export HTTPS_PROXY="http://127.0.0.1:7890"
# export ALL_PROXY="socks5://127.0.0.1:7890"

exec node "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/src/main.ts" "$@"
