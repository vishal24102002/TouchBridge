import socket
import threading
import pyautogui

HOST = "0.0.0.0"
PORT = 9999
debug=False

def handle_client(conn, addr):
    print(f"Connected by {addr}")
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)  # Disable Nagle's algorithm
    try:
        with conn:
            buffer = ""
            while True:
                data = conn.recv(1024).decode()
                if not data:
                    break

                buffer += data
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    process_command(line.strip())
    except Exception as e:
        print(f"Connection error: {e}")

def process_command(cmd):
    if debug:
        print(f"Received: {cmd}")
    try:
        if cmd.startswith("mouse_move:"):
            dx, dy = map(int, cmd.replace("mouse_move:", "").split(","))
            pyautogui.moveRel(dx, dy)
        elif cmd == "mouse_click":
            pyautogui.click()
        elif cmd == "mouse_right_click":
            pyautogui.click(button='right')
        elif cmd.startswith("key:"):
            key = cmd.replace("key:", "")
            pyautogui.write(key, interval=0.01)  # faster key typing
    except Exception as e:
        print(f"Command error: {e}")

def start_server():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((HOST, PORT))
        s.listen()
        print(f"Server listening on {HOST}:{PORT}")
        while True:
            conn, addr = s.accept()
            threading.Thread(target=handle_client, args=(conn, addr), daemon=True).start()

if __name__ == "__main__":
    start_server()
