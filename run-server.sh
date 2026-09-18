#!/bin/zsh
# 在后台启动 mini-codex 网页服务，不打开任何窗口。
# 已经在跑就直接退出，重复调用是安全的。
# 日志写到项目内的 .mini-codex/server.log。

cd "$(dirname "$0")" || exit 1
PORT="${MINI_CODEX_PORT:-3333}"
LOG_DIR=".mini-codex"
mkdir -p "$LOG_DIR"

# 端口已被占用 = 服务已在运行，什么都不做
if /usr/bin/nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
  exit 0
fi

# 找 node：不依赖 PATH，也不依赖 nvm 的交互式初始化 ——
# 从 App 图标启动时环境很干净，PATH 里通常什么都没有。
NODE_BIN=""
if [ -d "$HOME/.nvm/versions/node" ]; then
  newest="$(/bin/ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | /usr/bin/sort -V | /usr/bin/tail -1)"
  if [ -n "$newest" ] && [ -x "$HOME/.nvm/versions/node/$newest/bin/node" ]; then
    NODE_BIN="$HOME/.nvm/versions/node/$newest/bin/node"
  fi
fi
if [ -z "$NODE_BIN" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  found="$(command -v node 2>/dev/null)"
  [ -n "$found" ] && NODE_BIN="$found"
fi

if [ -z "$NODE_BIN" ]; then
  echo "$(date '+%F %T') 找不到 node，无法启动。请先安装 Node 18+。" >> "$LOG_DIR/server.log"
  exit 1
fi

echo "$(date '+%F %T') 启动服务：$NODE_BIN，端口 $PORT" >> "$LOG_DIR/server.log"
exec "$NODE_BIN" bin/mini-codex.js --web --port "$PORT" --no-open >> "$LOG_DIR/server.log" 2>&1
