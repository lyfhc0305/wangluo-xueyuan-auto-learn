#!/usr/bin/env bash
# 河南干部网络学院 - 自动学习助手 (macOS / Linux 启动脚本)
set -e
cd "$(dirname "$0")"

echo "============================================"
echo " 河南干部网络学院 - 自动学习助手"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js,请先安装 Node.js 后重试。"
  echo "       macOS:  brew install node"
  echo "       Ubuntu: sudo apt install nodejs npm"
  echo "       下载:   https://nodejs.org/"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行,正在安装依赖,请稍候..."
  npm install
fi

echo "启动中,请不要关闭本窗口..."
echo "首次运行请在浏览器窗口中手动输入账号密码。"
echo
node auto-learn.mjs "$@"