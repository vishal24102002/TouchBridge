"""
Remote Desktop Server - Cross-platform (Linux X11/Wayland & Windows)
Combines screen sharing with remote control
Supports Wayland display server on Linux
"""
import cv2
from mss import mss
import pyautogui
import socket
import threading
import subprocess
import platform
import numpy as np
import os
import sys
from pathlib import Path

# Try to import colorama, fall back to no color if not available
try:
    from colorama import Fore, init
    init(autoreset=True)
except ImportError:
    class Fore:
        GREEN = RED = CYAN = YELLOW = MAGENTA = WHITE = ""

# Configuration
SCREEN_SHARE_PORT = 8080
CONTROL_PORT = 9999
HOST = "0.0.0.0"
DEBUG = True

# Platform detection
SYSTEM = platform.system()
IS_LINUX = SYSTEM == "Linux"
IS_WINDOWS = SYSTEM == "Windows"
IS_MAC = SYSTEM == "Darwin"

class RemoteDesktopServer:
    """
    Main server class that handles both screen sharing and remote control
    Supports Linux (X11 & Wayland), Windows, and macOS
    """
    
    def __init__(self, host=HOST, screen_port=SCREEN_SHARE_PORT, control_port=CONTROL_PORT):
        self.host = host
        self.screen_port = screen_port
        self.control_port = control_port
        self.running = True
        self.system = SYSTEM
        
        # Detect display server on Linux
        self.display_server = None
        self.is_wayland = False
        self.has_xdotool = False
        self.has_ydotool = False
        
        if IS_LINUX:
            self.display_server = self._detect_display_server()
            self.is_wayland = (self.display_server == "wayland")
            
            if self.is_wayland:
                print(f"{Fore.CYAN}Wayland display server detected{Fore.WHITE}")
                self.has_ydotool = self._check_ydotool()
                if not self.has_ydotool:
                    print(f"{Fore.YELLOW}Warning: ydotool not found. Input simulation may be limited.{Fore.WHITE}")
                    print(f"{Fore.YELLOW}Install with: sudo apt install ydotool{Fore.WHITE}")
                    print(f"{Fore.YELLOW}Enable service: sudo systemctl enable --now ydotoold{Fore.WHITE}")
            else:
                print(f"{Fore.CYAN}X11 display server detected{Fore.WHITE}")
                self.has_xdotool = self._check_xdotool()
                if not self.has_xdotool:
                    print(f"{Fore.YELLOW}Warning: xdotool not found. Some features may be limited.{Fore.WHITE}")
                    print(f"{Fore.YELLOW}Install with: sudo apt install xdotool{Fore.WHITE}")
        
        print(f"{Fore.CYAN}Platform detected: {self.system}{Fore.WHITE}")
    
    def _detect_display_server(self):
        """Detect if running on Wayland or X11"""
        # Check XDG_SESSION_TYPE environment variable
        session_type = os.environ.get('XDG_SESSION_TYPE', '').lower()
        if session_type:
            return session_type
        
        # Check WAYLAND_DISPLAY
        if os.environ.get('WAYLAND_DISPLAY'):
            return 'wayland'
        
        # Check DISPLAY (X11)
        if os.environ.get('DISPLAY'):
            return 'x11'
        
        return 'unknown'
    
    def _check_xdotool(self):
        """Check if xdotool is available on Linux"""
        try:
            subprocess.run(['xdotool', 'version'],
                          stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE,
                          check=True)
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False
    
    def _check_ydotool(self):
        """Check if ydotool is available for Wayland"""
        try:
            subprocess.run(['ydotool', '--version'],
                          stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE,
                          check=True)
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False
    
    def start(self):
        """Start both screen sharing and control servers"""
        print(f"{Fore.GREEN}Starting Remote Desktop Server...{Fore.WHITE}")
        print(f"Screen sharing on port: {self.screen_port}")
        print(f"Control receiving on port: {self.control_port}")
        
        # Start control server in a separate thread
        control_thread = threading.Thread(target=self.start_control_server, daemon=True)
        control_thread.start()
        
        # Start screen sharing server in main thread
        self.start_screen_server()
    
    def start_control_server(self):
        """Handle incoming control commands"""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((self.host, self.control_port))
            s.listen()
            print(f"{Fore.CYAN}Control server listening on {self.host}:{self.control_port}{Fore.WHITE}")
            
            while self.running:
                try:
                    conn, addr = s.accept()
                    print(f"{Fore.YELLOW}Control connection from {addr}{Fore.WHITE}")
                    threading.Thread(target=self.handle_control_client, args=(conn, addr), daemon=True).start()
                except Exception as e:
                    if self.running:
                        print(f"Control server error: {e}")
    
    def handle_control_client(self, conn, addr):
        """Process control commands from client"""
        print(f"Control client connected: {addr}")
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        
        try:
            with conn:
                buffer = ""
                while self.running:
                    data = conn.recv(1024).decode('utf-8', errors='ignore')
                    if not data:
                        break
                    
                    buffer += data
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        self.process_command(line.strip())
        except Exception as e:
            print(f"Control connection error: {e}")
        finally:
            print(f"{Fore.YELLOW}Control client {addr} disconnected{Fore.WHITE}")
    
    def process_command(self, cmd):
        """Execute control commands"""
        if DEBUG:
            print(f"{Fore.MAGENTA}Command: {cmd}{Fore.WHITE}")
        
        try:
            if IS_LINUX:
                if self.is_wayland:
                    self._process_wayland_command(cmd)
                else:
                    self._process_linux_x11_command(cmd)
            elif IS_WINDOWS:
                self._process_windows_command(cmd)
            elif IS_MAC:
                self._process_mac_command(cmd)
            else:
                self._process_generic_command(cmd)
        except Exception as e:
            print(f"Command error: {e}")
    
    def _process_wayland_command(self, cmd):
        """Process Wayland-specific commands using ydotool"""
        # Mouse commands
        if cmd.startswith("mouse_move:"):
            dx, dy = map(int, cmd.replace("mouse_move:", "").split(","))
            if self.has_ydotool:
                # Get current position and calculate absolute position
                current_x, current_y = pyautogui.position()
                new_x = current_x + dx
                new_y = current_y + dy
                subprocess.run(['ydotool', 'mousemove', '--absolute', str(new_x), str(new_y)],
                             stderr=subprocess.DEVNULL)
            else:
                # Fallback to pyautogui (may not work on all Wayland compositors)
                try:
                    pyautogui.moveRel(dx, dy)
                except:
                    print("Mouse move not supported without ydotool on Wayland")
        
        elif cmd == "mouse_click":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'click', '0xC0'],  # Left click (down+up)
                             stderr=subprocess.DEVNULL)
            else:
                try:
                    pyautogui.click()
                except:
                    print("Mouse click not supported without ydotool on Wayland")
        
        elif cmd == "mouse_right_click":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'click', '0xC1'],  # Right click
                             stderr=subprocess.DEVNULL)
            else:
                try:
                    pyautogui.click(button='right')
                except:
                    print("Right click not supported without ydotool on Wayland")
        
        elif cmd == "mouse_double_click":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'click', '0xC0'],
                             stderr=subprocess.DEVNULL)
                subprocess.run(['ydotool', 'click', '0xC0'],
                             stderr=subprocess.DEVNULL)
            else:
                try:
                    pyautogui.doubleClick()
                except:
                    print("Double click not supported without ydotool on Wayland")
        
        # Keyboard input
        elif cmd.startswith("key:"):
            key = cmd.replace("key:", "")
            if self.has_ydotool:
                subprocess.run(['ydotool', 'type', key],
                             stderr=subprocess.DEVNULL)
            else:
                try:
                    pyautogui.write(key, interval=0.01)
                except:
                    print("Keyboard input not supported without ydotool on Wayland")
        
        # Media controls (using key codes)
        elif cmd == "media_play_pause":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '164:1', '164:0'],  # KEY_PLAYPAUSE
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "volume_up":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '115:1', '115:0'],  # KEY_VOLUMEUP
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "volume_down":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '114:1', '114:0'],  # KEY_VOLUMEDOWN
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "volume_mute":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '113:1', '113:0'],  # KEY_MUTE
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "media_next":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '163:1', '163:0'],  # KEY_NEXTSONG
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "media_prev":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '165:1', '165:0'],  # KEY_PREVIOUSSONG
                             stderr=subprocess.DEVNULL)
        
        # Shortcuts using ydotool
        elif cmd == "shortcut:backspace":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '14:1', '14:0'],  # KEY_BACKSPACE
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:enter":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '28:1', '28:0'],  # KEY_ENTER
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:escape":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '1:1', '1:0'],  # KEY_ESC
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:alt_tab":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '56:1', '15:1', '15:0', '56:0'],  # ALT+TAB
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:ctrl_tab":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '29:1', '15:1', '15:0', '29:0'],  # CTRL+TAB
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:ctrl_c":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '29:1', '46:1', '46:0', '29:0'],  # CTRL+C
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:ctrl_v":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '29:1', '47:1', '47:0', '29:0'],  # CTRL+V
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:ctrl_x":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '29:1', '45:1', '45:0', '29:0'],  # CTRL+X
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:ctrl_z":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '29:1', '44:1', '44:0', '29:0'],  # CTRL+Z
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:ctrl_a":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '29:1', '30:1', '30:0', '29:0'],  # CTRL+A
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:alt_f4":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '56:1', '62:1', '62:0', '56:0'],  # ALT+F4
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:win_d":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '125:1', '32:1', '32:0', '125:0'],  # SUPER+D
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:win_l":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '125:1', '38:1', '38:0', '125:0'],  # SUPER+L
                             stderr=subprocess.DEVNULL)
        
        # Arrow keys
        elif cmd == "shortcut:arrow_right":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '106:1', '106:0'],  # KEY_RIGHT
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:arrow_left":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '105:1', '105:0'],  # KEY_LEFT
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:arrow_up":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '103:1', '103:0'],  # KEY_UP
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:arrow_down":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '108:1', '108:0'],  # KEY_DOWN
                             stderr=subprocess.DEVNULL)
        
        # Page navigation
        elif cmd == "shortcut:page_up":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '104:1', '104:0'],  # KEY_PAGEUP
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:page_down":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '109:1', '109:0'],  # KEY_PAGEDOWN
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:home":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '102:1', '102:0'],  # KEY_HOME
                             stderr=subprocess.DEVNULL)
        
        elif cmd == "shortcut:end":
            if self.has_ydotool:
                subprocess.run(['ydotool', 'key', '107:1', '107:0'],  # KEY_END
                             stderr=subprocess.DEVNULL)
        
        # Application launchers (cross-distro compatible)
        elif cmd == "open_chrome":
            self._open_browser_linux()
        
        elif cmd == "open_browser":
            self._open_browser_linux()
        
        elif cmd == "custom:open_folder":
            self._open_file_manager_linux()
        
        elif cmd == "open_terminal":
            self._open_terminal_linux()
        
        else:
            print(f"Unknown command: {cmd}")
    
    def _process_linux_x11_command(self, cmd):
        """Process Linux X11-specific commands (using xdotool)"""
        # Mouse commands
        if cmd.startswith("mouse_move:"):
            dx, dy = map(int, cmd.replace("mouse_move:", "").split(","))
            pyautogui.moveRel(dx, dy)
        
        elif cmd == "mouse_click":
            pyautogui.click()
        
        elif cmd == "mouse_right_click":
            pyautogui.click(button='right')
        
        elif cmd == "mouse_double_click":
            pyautogui.doubleClick()
        
        # Keyboard input
        elif cmd.startswith("key:"):
            key = cmd.replace("key:", "")
            pyautogui.write(key, interval=0.01)
        
        # Media controls
        elif cmd == "media_play_pause":
            if self.has_xdotool:
                subprocess.run(['xdotool', 'key', 'XF86AudioPlay'], stderr=subprocess.DEVNULL)
            else:
                pyautogui.press('playpause')
        
        elif cmd == "volume_up":
            if self.has_xdotool:
                subprocess.run(['xdotool', 'key', 'XF86AudioRaiseVolume'], stderr=subprocess.DEVNULL)
            else:
                pyautogui.press('volumeup')
        
        elif cmd == "volume_down":
            if self.has_xdotool:
                subprocess.run(['xdotool', 'key', 'XF86AudioLowerVolume'], stderr=subprocess.DEVNULL)
            else:
                pyautogui.press('volumedown')
        
        elif cmd == "volume_mute":
            if self.has_xdotool:
                subprocess.run(['xdotool', 'key', 'XF86AudioMute'], stderr=subprocess.DEVNULL)
            else:
                pyautogui.press('volumemute')
        
        elif cmd == "media_next":
            if self.has_xdotool:
                subprocess.run(['xdotool', 'key', 'XF86AudioNext'], stderr=subprocess.DEVNULL)
            else:
                pyautogui.press('nexttrack')
        
        elif cmd == "media_prev":
            if self.has_xdotool:
                subprocess.run(['xdotool', 'key', 'XF86AudioPrev'], stderr=subprocess.DEVNULL)
            else:
                pyautogui.press('prevtrack')
        
        # Shortcuts
        elif cmd == "shortcut:backspace":
            pyautogui.press('backspace')
        
        elif cmd == "shortcut:enter":
            pyautogui.press('enter')
        
        elif cmd == "shortcut:escape":
            pyautogui.press('escape')
        
        elif cmd == "shortcut:alt_tab":
            pyautogui.hotkey('alt', 'tab')
        
        elif cmd == "shortcut:ctrl_tab":
            pyautogui.hotkey('ctrl', 'tab')
        
        elif cmd == "shortcut:ctrl_c":
            pyautogui.hotkey('ctrl', 'c')
        
        elif cmd == "shortcut:ctrl_v":
            pyautogui.hotkey('ctrl', 'v')
        
        elif cmd == "shortcut:ctrl_x":
            pyautogui.hotkey('ctrl', 'x')
        
        elif cmd == "shortcut:ctrl_z":
            pyautogui.hotkey('ctrl', 'z')
        
        elif cmd == "shortcut:ctrl_a":
            pyautogui.hotkey('ctrl', 'a')
        
        elif cmd == "shortcut:alt_f4":
            pyautogui.hotkey('alt', 'F4')
        
        elif cmd == "shortcut:win_d":
            pyautogui.hotkey('super', 'd')
        
        elif cmd == "shortcut:win_l":
            if self.has_xdotool:
                subprocess.run(['xdotool', 'key', 'Super_L+l'], stderr=subprocess.DEVNULL)
            else:
                pyautogui.hotkey('super', 'l')
        
        # Arrow keys
        elif cmd == "shortcut:arrow_right":
            if self.has_xdotool:
                subprocess.run(['xdotool', 'key', 'Right'], stderr=subprocess.DEVNULL)
            else:
                pyautogui.press('right')
        
        elif cmd == "shortcut:arrow_left":
            if self.has_xdotool:
                subprocess.run(['xdotool', 'key', 'Left'], stderr=subprocess.DEVNULL)
            else:
                pyautogui.press('left')
        
        elif cmd == "shortcut:arrow_up":
            pyautogui.press('up')
        
        elif cmd == "shortcut:arrow_down":
            pyautogui.press('down')
        
        # Page navigation
        elif cmd == "shortcut:page_up":
            pyautogui.press('pageup')
        
        elif cmd == "shortcut:page_down":
            pyautogui.press('pagedown')
        
        elif cmd == "shortcut:home":
            pyautogui.press('home')
        
        elif cmd == "shortcut:end":
            pyautogui.press('end')
        
        # Application launchers
        elif cmd == "open_chrome":
            self._open_browser_linux()
        
        elif cmd == "open_browser":
            self._open_browser_linux()
        
        elif cmd == "custom:open_folder":
            self._open_file_manager_linux()
        
        elif cmd == "open_terminal":
            self._open_terminal_linux()
        
        else:
            print(f"Unknown command: {cmd}")
    
    def _process_windows_command(self, cmd):
        """Process Windows-specific commands"""
        # Mouse commands
        if cmd.startswith("mouse_move:"):
            dx, dy = map(int, cmd.replace("mouse_move:", "").split(","))
            pyautogui.moveRel(dx, dy)
        
        elif cmd == "mouse_click":
            pyautogui.click()
        
        elif cmd == "mouse_right_click":
            pyautogui.click(button='right')
        
        elif cmd == "mouse_double_click":
            pyautogui.doubleClick()
        
        # Keyboard input
        elif cmd.startswith("key:"):
            key = cmd.replace("key:", "")
            pyautogui.write(key, interval=0.01)
        
        # Media controls
        elif cmd == "media_play_pause":
            pyautogui.press('playpause')
        
        elif cmd == "volume_up":
            pyautogui.press('volumeup')
        
        elif cmd == "volume_down":
            pyautogui.press('volumedown')
        
        elif cmd == "volume_mute":
            pyautogui.press('volumemute')
        
        elif cmd == "media_next":
            pyautogui.press('nexttrack')
        
        elif cmd == "media_prev":
            pyautogui.press('prevtrack')
        
        # Shortcuts
        elif cmd == "shortcut:backspace":
            pyautogui.press('backspace')
        
        elif cmd == "shortcut:enter":
            pyautogui.press('enter')
        
        elif cmd == "shortcut:escape":
            pyautogui.press('escape')
        
        elif cmd == "shortcut:alt_tab":
            pyautogui.hotkey('alt', 'tab')
        
        elif cmd == "shortcut:ctrl_tab":
            pyautogui.hotkey('ctrl', 'tab')
        
        elif cmd == "shortcut:ctrl_c":
            pyautogui.hotkey('ctrl', 'c')
        
        elif cmd == "shortcut:ctrl_v":
            pyautogui.hotkey('ctrl', 'v')
        
        elif cmd == "shortcut:ctrl_x":
            pyautogui.hotkey('ctrl', 'x')
        
        elif cmd == "shortcut:ctrl_z":
            pyautogui.hotkey('ctrl', 'z')
        
        elif cmd == "shortcut:ctrl_a":
            pyautogui.hotkey('ctrl', 'a')
        
        elif cmd == "shortcut:alt_f4":
            pyautogui.hotkey('alt', 'F4')
        
        elif cmd == "shortcut:win_d":
            pyautogui.hotkey('win', 'd')
        
        elif cmd == "shortcut:win_l":
            pyautogui.hotkey('win', 'l')
        
        # Arrow keys
        elif cmd == "shortcut:arrow_right":
            pyautogui.press('right')
        
        elif cmd == "shortcut:arrow_left":
            pyautogui.press('left')
        
        elif cmd == "shortcut:arrow_up":
            pyautogui.press('up')
        
        elif cmd == "shortcut:arrow_down":
            pyautogui.press('down')
        
        # Page navigation
        elif cmd == "shortcut:page_up":
            pyautogui.press('pageup')
        
        elif cmd == "shortcut:page_down":
            pyautogui.press('pagedown')
        
        elif cmd == "shortcut:home":
            pyautogui.press('home')
        
        elif cmd == "shortcut:end":
            pyautogui.press('end')
        
        # Windows-specific shortcuts
        elif cmd == "shortcut:win_r":
            pyautogui.hotkey('win', 'r')
        
        elif cmd == "shortcut:win_e":
            pyautogui.hotkey('win', 'e')
        
        elif cmd == "shortcut:ctrl_alt_del":
            pyautogui.hotkey('ctrl', 'alt', 'del')
        
        # Application launchers
        elif cmd == "open_chrome":
            try:
                subprocess.Popen(['chrome.exe'])
            except:
                try:
                    subprocess.Popen([r'C:\Program Files\Google\Chrome\Application\chrome.exe'])
                except:
                    try:
                        subprocess.Popen([r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'])
                    except:
                        print("Chrome not found")
        
        elif cmd == "open_browser":
            subprocess.Popen(['start', '', 'http://'], shell=True)
        
        elif cmd == "custom:open_folder":
            subprocess.Popen(['explorer.exe'])
        
        elif cmd == "open_terminal":
            try:
                subprocess.Popen(['wt.exe'])
            except:
                subprocess.Popen(['cmd.exe'])
        
        elif cmd == "open_notepad":
            subprocess.Popen(['notepad.exe'])
        
        else:
            print(f"Unknown command: {cmd}")
    
    def _process_mac_command(self, cmd):
        """Process macOS-specific commands"""
        if cmd.startswith("mouse_move:"):
            dx, dy = map(int, cmd.replace("mouse_move:", "").split(","))
            pyautogui.moveRel(dx, dy)
        
        elif cmd == "mouse_click":
            pyautogui.click()
        
        elif cmd == "mouse_right_click":
            pyautogui.click(button='right')
        
        elif cmd.startswith("key:"):
            key = cmd.replace("key:", "")
            pyautogui.write(key, interval=0.01)
        
        else:
            self._process_generic_command(cmd)
    
    def _process_generic_command(self, cmd):
        """Process generic commands for any platform"""
        if cmd.startswith("mouse_move:"):
            dx, dy = map(int, cmd.replace("mouse_move:", "").split(","))
            pyautogui.moveRel(dx, dy)
        
        elif cmd == "mouse_click":
            pyautogui.click()
        
        elif cmd == "mouse_right_click":
            pyautogui.click(button='right')
        
        elif cmd.startswith("key:"):
            key = cmd.replace("key:", "")
            pyautogui.write(key, interval=0.01)
        
        else:
            print(f"Unknown/unsupported command: {cmd}")
    
    def _open_browser_linux(self):
        """Open web browser on Linux (cross-distro)"""
        browsers = [
            'google-chrome',
            'chromium-browser',
            'chromium',
            'firefox',
            'mozilla',
            'opera',
            'brave-browser',
            'vivaldi',
            'xdg-open'
        ]
        
        for browser in browsers:
            try:
                subprocess.Popen([browser],
                               stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
                print(f"Opened browser: {browser}")
                return
            except FileNotFoundError:
                continue
        
        print("No browser found")
    
    def _open_file_manager_linux(self):
        """Open file manager on Linux (cross-distro)"""
        file_managers = [
            'nautilus',  # GNOME
            'dolphin',   # KDE
            'thunar',    # XFCE
            'pcmanfm',   # LXDE
            'nemo',      # Cinnamon
            'caja',      # MATE
            'konqueror',
            'xdg-open',
        ]
        
        for fm in file_managers:
            try:
                subprocess.Popen([fm],
                               stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
                print(f"Opened file manager: {fm}")
                return
            except FileNotFoundError:
                continue
        
        print("No file manager found")
    
    def _open_terminal_linux(self):
        """Open terminal on Linux (cross-distro)"""
        terminals = [
            'gnome-terminal',
            'konsole',
            'xfce4-terminal',
            'xterm',
            'lxterminal',
            'mate-terminal',
            'terminator',
            'alacritty',
            'kitty',
            'tilix',
        ]
        
        for terminal in terminals:
            try:
                subprocess.Popen([terminal],
                               stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
                print(f"Opened terminal: {terminal}")
                return
            except FileNotFoundError:
                continue
        
        print("No terminal found")
    
    def start_screen_server(self):
        """Handle screen sharing"""
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        print(f"{Fore.CYAN}Screen server created{Fore.WHITE}")
        
        hostname = socket.gethostname()
        print(f"Hostname: {hostname}")
        
        try:
            server.bind((self.host, self.screen_port))
            server.listen(1)
            print(f"{Fore.GREEN}Waiting for screen sharing connections...{Fore.WHITE}")
            
            while self.running:
                try:
                    client, addr = server.accept()
                    print(f"{Fore.YELLOW}Screen client connected: {addr}{Fore.WHITE}")
                    threading.Thread(target=self.handle_screen_client, args=(client, addr), daemon=True).start()
                except Exception as e:
                    if self.running:
                        print(f"Screen server error: {e}")
        except Exception as e:
            print(f"Failed to start screen server: {e}")
        finally:
            server.close()
    
    def _capture_screen_wayland(self):
        """Capture screen on Wayland using D-Bus portal (fast method)"""
        try:
            # Try using PIL with pyscreenshot for Wayland
            try:
                import pyscreenshot as ImageGrab
                img = ImageGrab.grab()
                img_array = np.array(img)
                img_array = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
                cv2.imwrite('transfer_scr.jpeg', img_array, [cv2.IMWRITE_JPEG_QUALITY, 80])
                return True
            except:
                pass
            
            # Fallback to PIL/Pillow with direct screen capture
            try:
                from PIL import ImageGrab
                img = ImageGrab.grab()
                img_array = np.array(img)
                img_array = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
                cv2.imwrite('transfer_scr.jpeg', img_array, [cv2.IMWRITE_JPEG_QUALITY, 80])
                return True
            except:
                pass
            
            # If PIL doesn't work on Wayland, use mss with XWayland fallback
            try:
                with mss() as sct:
                    monitor = sct.monitors[1]  # Primary monitor
                    sct_img = sct.grab(monitor)
                    img_array = np.array(sct_img)
                    if img_array.shape[2] == 4:  # BGRA
                        img_array = cv2.cvtColor(img_array, cv2.COLOR_BGRA2BGR)
                    cv2.imwrite('transfer_scr.jpeg', img_array, [cv2.IMWRITE_JPEG_QUALITY, 80])
                    return True
            except:
                pass
                
            return False
            
        except Exception as e:
            print(f"Wayland capture error: {e}")
            return False
    
    def _capture_screen_x11(self):
        """Capture screen on X11 using mss (fast method)"""
        try:
            with mss() as sct:
                monitor = sct.monitors[1]  # Primary monitor
                sct_img = sct.grab(monitor)
                
                # Convert to numpy array
                img_array = np.array(sct_img)
                
                # Handle different color formats
                if img_array.shape[2] == 4:  # BGRA
                    img_array = cv2.cvtColor(img_array, cv2.COLOR_BGRA2BGR)
                
                # Use lower JPEG quality for faster encoding and smaller file size
                cv2.imwrite('transfer_scr.jpeg', img_array, [cv2.IMWRITE_JPEG_QUALITY, 80])
                return True
        except Exception as e:
            print(f"X11 screen capture error: {e}")
            return False
    
    def handle_screen_client(self, client, addr):
        """Send screen captures to client"""
        try:
            with client:
                while self.running:
                    data = client.recv(1024).decode('utf-8', errors='ignore')
                    if not data:
                        break
                    
                    print(f"{Fore.GREEN}Sending screen to {addr}{Fore.WHITE}")
                    #client.send("data transfer successful".encode())
                    #client.send('received_scr.jpeg'.encode())
                    
                    # Capture screen based on display server
                    success = False
                    if self.is_wayland:
                        success = self._capture_screen_wayland()
                    else:
                        success = self._capture_screen_x11()
                    
                    if not success:
                        print(f"{Fore.RED}Failed to capture screen{Fore.WHITE}")
                        break
                    
                    # Send the image file
                    with open('transfer_scr.jpeg', 'rb') as file:
                        while True:
                            chunk = file.read(1024)
                            if not chunk:
                                break
                            client.sendall(chunk)
                    
                    print(f"{Fore.GREEN}Screen transmitted successfully{Fore.WHITE}")
                    
                    break
        except Exception as e:
            print(f"Screen client error: {e}")
        finally:
            print(f"{Fore.YELLOW}Screen client {addr} disconnected{Fore.WHITE}")
            try:
                if os.path.exists('transfer_scr.jpeg'):
                    os.remove('transfer_scr.jpeg')
                if os.path.exists('transfer_scr.png'):
                    os.remove('transfer_scr.png')
            except:
                pass
    
    def stop(self):
        """Gracefully stop the server"""
        print(f"{Fore.YELLOW}Stopping server...{Fore.WHITE}")
        self.running = False

if __name__ == "__main__":
    print(f"{Fore.RED}{'='*70}")
    print("Remote Desktop Server - Screen Sharing + Remote Control")
    print(f"Platform: {SYSTEM}")
    print(f"{'='*70}{Fore.WHITE}")
    
    try:
        server = RemoteDesktopServer()
        server.start()
    except KeyboardInterrupt:
        print(f"\n{Fore.YELLOW}Server stopped by user{Fore.WHITE}")
    except Exception as e:
        print(f"{Fore.RED}Error: {e}{Fore.WHITE}")
        sys.exit(1)
