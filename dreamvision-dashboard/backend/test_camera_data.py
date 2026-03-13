import socket
import time

CAMERA_HOST = "192.168.4.1"
CAMERA_PORT = 3333

def test_data():
    print(f"[*] Connecting to {CAMERA_HOST}:{CAMERA_PORT}...")
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(10)
        sock.connect((CAMERA_HOST, CAMERA_PORT))
        print("[+] Connected! Sending 'wake-up' command...")
        sock.sendall(b"#") # Send a start character
        print("[+] Sent. Waiting for data...")
        
        start_time = time.time()
        total_received = 0
        while time.time() - start_time < 10:
            data = sock.recv(1024)
            if not data:
                print("[!] Connection closed by peer.")
                break
            total_received += len(data)
            print(f"[*] Received {len(data)} bytes (Total: {total_received})")
            
        sock.close()
        print(f"[*] Finished. Total received in 10s: {total_received} bytes.")
    except Exception as e:
        print(f"[!] Error: {e}")

if __name__ == "__main__":
    test_data()
