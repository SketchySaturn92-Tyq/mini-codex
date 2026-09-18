#!/bin/zsh
# 双击这个文件，就会启动 mini-codex 的网页界面并自动打开浏览器。
# 关掉这个终端窗口，服务就停了。

cd "$(dirname "$0")" || exit 1

# 尽力把 nvm 装的 node 找回来（双击运行时 Shell 环境可能不完整）
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "没有找到 node。请先安装 Node 18 或更新版本（https://nodejs.org），再双击本文件。"
  echo ""
  read -r "?按回车键关闭窗口…"
  exit 1
fi

echo "正在启动 mini-codex 网页界面，浏览器会自动打开…"
echo "（想停止，回到这个窗口按 Ctrl+C，或者直接关掉窗口）"
echo ""
node bin/mini-codex.js --web
