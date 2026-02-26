# ⬡ TouchBridge

Modern Remote Desktop — Electron + React + Python (`server_2.py`)

## Quick Start

```bash
# Linux / macOS
chmod +x start.sh && ./start.sh

# Windows
start.bat
```

## Architecture

- **Python server** (`server_2.py`) — TCP server on ports 8080 (screen) + 9999 (control)
  - X11: `xdotool` for input simulation
  - Wayland: `ydotool` for input simulation
  - Windows: `pyautogui` native
- **Electron main** — spawns Python, bridges TCP via IPC handlers
- **React UI** — 5 color themes, Server/Client modes, full shortcut panel

## Themes
🖤 Obsidian · 🌌 Aurora · 🔥 Ember · 🧊 Arctic · 💚 Matrix

## Ports
| Port | Purpose |
|------|---------|
| 8080 | Screen capture (JPEG over TCP) |
| 9999 | Remote control commands |

## Linux Setup
```bash
# X11
sudo apt install xdotool

# Wayland
sudo apt install ydotool
sudo systemctl enable --now ydotoold
```
