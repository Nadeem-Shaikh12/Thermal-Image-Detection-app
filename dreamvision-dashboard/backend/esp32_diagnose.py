"""
ESP32 Raw Byte Diagnostic Tool (v2) - With Handshake
======================================================
Sends the WREG command '   #000CWREGB103XXXX' to start streaming.
CRC is a simple byte sum (from util.c getCRC).

Run: python esp32_diagnose.py
"""
import socket
import time
import struct

CAMERA_HOST = "192.168.4.1"
CAMERA_PORT = 3333
CAPTURE_SECONDS = 20

def get_crc(data: bytes) -> int:
    """CRC = simple sum of bytes, from getCRC() in util.c"""
    return sum(data) & 0xFFFF

def build_wreg_cmd(addr: int, val: int) -> bytes:
    """
    Build a WREG command packet:
      Format: '   #' + LEN(4 hex) + 'WREG' + ADDR(2 hex) + VAL(2 hex) + CRC(4 hex)
      LEN counts bytes from after '#' to end, excluding the leading 3 spaces.
      
    Tested with getCRC logic from util.c (simple sum of bytes of the payload after '#').
    """
    cmd_name = b"WREG"
    addr_str = f"{addr:02X}".encode()
    val_str  = f"{val:02X}".encode()
    
    # Total payload (after '#'): LEN(4) + CMD(4) + DATA(4) + CRC(4) = 16 chars
    # But LEN encodes the length of CMD+DATA+CRC = 4+4+4 = 12 = 0x000C
    payload_for_crc = f"000C".encode() + cmd_name + addr_str + val_str  # = b"000CWREGB103"
    crc_val = get_crc(payload_for_crc)
    crc_str = f"{crc_val:04X}".encode()
    
    # Full packet: 3 spaces + # + payload + CRC
    packet = b"   #" + payload_for_crc + crc_str
    return packet

def main():
    print("=" * 60)
    print("  ESP32 Diagnostic v2 (with WREG start command)")
    print(f"  Host: {CAMERA_HOST}:{CAMERA_PORT}")
    print("=" * 60)

    # Build the start command: Write Register 0xB1 = 0x03 (start capture)
    wreg_cmd = build_wreg_cmd(0xB1, 0x03)
    print(f"\n[*] WREG command (start stream): {wreg_cmd}")
    print(f"    = {wreg_cmd.hex()}")

    print(f"\n[1] Connecting to ESP32...")
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(10)
        sock.connect((CAMERA_HOST, CAMERA_PORT))
        sock.settimeout(5)
        print(f"    Connected! at {time.strftime('%H:%M:%S')}")
    except Exception as e:
        print(f"    FAILED: {e}")
        return

    # First, try receiving some data WITHOUT sending any command
    print(f"\n[2] Waiting 3s without sending anything...")
    all_data = b""
    deadline = time.time() + 3
    while time.time() < deadline:
        try:
            chunk = sock.recv(65536)
            if not chunk:
                break
            all_data += chunk
        except socket.timeout:
            pass

    if all_data:
        print(f"    >> Got {len(all_data)} bytes WITHOUT sending any command!")
        print(f"    This means firmware auto-streams after TCP connect.")
    else:
        print(f"    >> No data without command. Sending WREG start command...")
        sock.sendall(wreg_cmd)
        print(f"    WREG B1=03 sent!")

        # Now check for ACK
        print(f"\n[3] Waiting for ACK (up to 5s)...")
        ack_data = b""
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                chunk = sock.recv(1024)
                if not chunk:
                    break
                ack_data += chunk
            except socket.timeout:
                break
        if ack_data:
            print(f"    ACK received: {ack_data[:50]} ({len(ack_data)} bytes)")
        else:
            print(f"    No ACK received.")

        # Now capture data
        print(f"\n[4] Capturing stream for {CAPTURE_SECONDS}s...")
        sock.settimeout(2)
        start = time.time()
        last_report = start
        while (time.time() - start) < CAPTURE_SECONDS:
            try:
                chunk = sock.recv(65536)
                if not chunk:
                    print("    ESP32 closed the connection.")
                    break
                all_data += chunk
            except socket.timeout:
                pass
            if time.time() - last_report >= 3:
                last_report = time.time()
                elapsed = time.time() - start
                print(f"    {elapsed:.0f}s: {len(all_data)} bytes received so far...")

    sock.close()

    total = len(all_data)
    print(f"\n[5] Total received: {total} bytes")

    if total == 0:
        print("\n!!! STILL NO DATA. Trying alternate command...")
        print("    Try to POWER CYCLE the ESP32 (unplug + replug) then run again.")
        return

    # Analyze
    print(f"\n--- Frame analysis ---")
    for frame_size in [9920, 10240, 10256, 10560]:
        if total >= frame_size:
            full_frames = total // frame_size
            fps = full_frames / CAPTURE_SECONDS
            print(f"  {frame_size} B/frame → {full_frames} frames @ ~{fps:.1f} fps")

    print(f"\n--- First 32 bytes (hex) ---")
    print(" ".join(f"{b:02X}" for b in all_data[:32]))

    # Try temperatures
    if total >= 10:
        vals = struct.unpack_from(f"<{min(200, total//2)}H", all_data, 0)
        celsius = [round(v * 0.0984 - 265.82, 1) for v in vals[:8]]
        print(f"\n--- First 8 values as Celsius ---")
        print(f"  {celsius}")

if __name__ == "__main__":
    main()
