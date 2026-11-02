@echo off
title TouchBridge Launcher
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━
echo    TouchBridge Launcher
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━

echo [1/3] Installing Python deps...
python -m pip install -r python-server\requirements.txt -q

if not exist "electron-app\node_modules" (
  echo [2/3] Installing Node deps...
  cd electron-app
  npm install
  cd ..
)

echo [3/3] Starting app...
cd electron-app
npm start
