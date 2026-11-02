#!/bin/bash
# TouchBridge - Linux/macOS Launch Script
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   TouchBridge Launcher"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Install Python deps
echo "[1/3] Checking Python deps..."
pip3 install -r python-server/requirements.txt -q --break-system-packages 2>/dev/null || \
  pip3 install -r python-server/requirements.txt -q

# Install Node deps
if [ ! -d "electron-app/node_modules" ]; then
  echo "[2/3] Installing Node deps..."
  cd electron-app && npm install && cd ..
fi

echo "[3/3] Starting app..."
cd electron-app
npm start
