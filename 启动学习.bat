@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  河南干部网络学院 - 自动学习助手
echo ============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js,请先安装 Node.js 22.12 或更高版本后重试。
  echo        下载: https://nodejs.org/
  pause
  exit /b 1
)
for /f "tokens=1 delims=v" %%v in ('node -p "process.versions.node"') do set NODE_VER=%%v
for /f "tokens=1,2 delims=." %%a in ("%NODE_VER%") do (
  if %%a LSS 22 (
    echo [错误] Node.js 版本过低(%NODE_VER%)，需要 22.12 或更高版本。
    pause
    exit /b 1
  )
)
if not exist node_modules (
  echo 首次运行,正在安装依赖,请稍候...
  call npm ci
  if errorlevel 1 (
    echo [提示] npm ci 失败,改用 npm install 重试...
    call npm install
  )
  if errorlevel 1 (
    echo [错误] 依赖安装失败,请检查网络后重试。
    pause
    exit /b 1
  )
)
echo 启动中,请不要关闭本窗口...
echo 首次运行请在弹出的浏览器窗口中手动输入账号密码。
echo.
node auto-learn.mjs %*
echo.
echo 程序已结束。
pause