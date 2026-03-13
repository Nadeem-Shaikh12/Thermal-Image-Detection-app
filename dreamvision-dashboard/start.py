"""
DreamVision Smart Launcher
===========================
Automatically detects whether the ESP32 Thermal Camera is reachable on WiFi.

  - If connected to ESP32 WiFi (192.168.4.1):  runs rpi_camera_reader.py
  - If NOT connected:                           runs rpi_simulator.py

Usage:
    python start.py
    python start.py --sim       # force simulator
    python start.py --camera    # force real camera
"""
import socket
import subprocess
import sys
import os
import time

CAMERA_HOST = "192.168.4.1"
CAMERA_PORT = 3333
CHECK_TIMEOUT = 3  # seconds

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CAMERA_READER = os.path.join(BASE_DIR, "backend", "rpi_camera_reader.py")
SIMULATOR    = os.path.join(BASE_DIR, "rpi_simulator.py")


def is_esp32_reachable() -> bool:
    """Try opening a TCP connection to the ESP32 camera. Returns True if reachable."""
    print(f"[*] Checking for ESP32 camera at {CAMERA_HOST}:{CAMERA_PORT} ...")
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(CHECK_TIMEOUT)
        sock.connect((CAMERA_HOST, CAMERA_PORT))
        sock.close()
        return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False


def run_script(path: str, label: str):
    print(f"\n{'='*55}")
    print(f"  DreamVision — {label}")
    print(f"  Running: {os.path.basename(path)}")
    print(f"{'='*55}\n")
    try:
        subprocess.run([sys.executable, path], check=True)
    except KeyboardInterrupt:
        print("\n[*] Stopped by user.")


def main():
    args = sys.argv[1:]

    if "--sim" in args:
        print("[!] Forced simulator mode.")
        run_script(SIMULATOR, "Simulator Mode")
        return

    if "--camera" in args:
        print("[!] Forced camera reader mode.")
        run_script(CAMERA_READER, "ESP32 Hardware Camera")
        return

    # --- Auto-detect ---
    print("\n" + "="*55)
    print("  DreamVision Smart Launcher")
    print("="*55)
    print("  Connect your PC to the ESP32 WiFi network first.")
    print("  Default ESP32 AP: SSID varies, IP = 192.168.4.1")
    print("="*55 + "\n")

    if is_esp32_reachable():
        print("[+] ESP32 camera detected! Starting hardware camera reader...")
        time.sleep(1)
        run_script(CAMERA_READER, "ESP32 Hardware Camera")
    else:
        print("[!] ESP32 camera NOT found at 192.168.4.1")
        print("[>] Starting simulator instead (demo mode)...")
        print()
        print("    To use the real camera:")
        print("    1. Connect PC WiFi to the ESP32 hotspot")
        print("    2. Re-run: python start.py")
        print("    3. Or force it: python start.py --camera")
        print()
        time.sleep(1)
        run_script(SIMULATOR, "Simulator (Demo) Mode")


if __name__ == "__main__":
    main()
