import socket
import time
import subprocess

def check_connection(target_ip, target_port):
    print(f"[*] Testing connection to ESP32 Hotspot at {target_ip}:{target_port}...")
    
    # 1. Ping test (basic visibility)
    try:
        # -n 1 for Windows, -c 1 for Linux/Mac
        ping_param = "-n" if "nt" in __import__('os').name else "-c"
        ping_result = subprocess.run(['ping', ping_param, '1', target_ip], capture_output=True, text=True, timeout=5)
        
        if ping_result.returncode == 0:
            print("[+] Network Success: PC can 'ping' the ESP32.")
        else:
            print("[-] Network Failure: PC cannot ping 192.168.4.1. Are you connected to the ESP32 Wi-Fi?")
            return False
    except Exception as e:
        print(f"[-] Ping timed out or failed: {e}")
        return False

    # 2. TCP Port test
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(3) # Pure standard library timeout
        result = sock.connect_ex((target_ip, target_port))
        if result == 0:
            print(f"[+] Protocol Success: TCP Port {target_port} is OPEN and reachable.")
            sock.close()
            return True
        else:
            print(f"[-] Protocol Failure: Port {target_port} is CLOSED. Is the ESP32 firmware running?")
            sock.close()
            return False
    except Exception as e:
        print(f"[!] Connection error: {e}")
        return False

if __name__ == "__main__":
    check_connection("192.168.4.1", 3333)
