import socket
import threading

def check_address(ip, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.0)
    result = s.connect_ex((ip, port))
    if result == 0:
        print(f"\n--- FOUND IT! {ip}:{port} is OPEN ---")
    s.close()

def main():
    print("Starting network scan on 192.168.4.x subnet...")
    print("This may take 10-20 seconds. Please wait...")
    
    # Common ports for Waveshare/ESP32 thermal cameras
    target_ports = [3333, 80, 81, 8080]
    
    threads = []
    for i in range(1, 255):
        ip = f"192.168.4.{i}"
        for port in target_ports:
            t = threading.Thread(target=check_address, args=(ip, port))
            t.start()
            threads.append(t)
            
            # Limit thread count to avoid system hang
            if len(threads) > 100:
                for th in threads: th.join()
                threads = []

    for th in threads: th.join()
    print("\nScan complete.")

if __name__ == "__main__":
    main()
