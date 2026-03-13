"""
DreamVision ESP32 Camera Reader - Optimized
=============================================
Frame format (10256 bytes total):
  [0-11]    : '   #2808GFRA'  -> 12-byte packet header (skip)
  [12-171]  : zeros/padding   -> 160 bytes (skip)
  [172-331] : sensor row 0    -> 160 bytes metadata (skip)
  [332-10251]: thermal pixels -> 9920 bytes = 80x62 uint16 LE
  [10252-55]: 'XXXX'          -> 4-byte CRC (skip)

Performance: socket reading and HTTP upload run in separate threads.
If upload is slow, old frames are dropped so socket is always drained.
"""
import socket
import numpy as np
import cv2
import base64
import requests
import time
import threading
import queue

# --- Connection ---
CAMERA_HOST = "192.168.4.1"
CAMERA_PORT = 3333
SERVER_URL  = "http://localhost:8000/upload"
MACHINE_ID  = "ESP32_THERMAL_CAM"

# --- Frame Protocol (confirmed from live diagnostic) ---
TCP_FRAME_SIZE = 10256
STRIP_HEAD     = 332          # 12-byte header + 160-byte zeros + 160-byte row-0 metadata
STRIP_TAIL     = 4            # 4-byte CRC 'XXXX'
RAW_DATA_SIZE  = 9920         # 80 x 62 x 2 bytes
WIDTH          = 80
HEIGHT         = 62

# --- Socket buffer: large to handle burst data without drops ---
RECV_BUFSIZE   = 131072       # 128KB recv buffer

# --- Start-stream command: WREG 0xB1 = 0x03 ---
def _make_wreg_cmd(addr: int, val: int) -> bytes:
    payload = f"000CWREG{addr:02X}{val:02X}".encode()
    crc = sum(payload) & 0xFFFF
    return b"   #" + payload + f"{crc:04X}".encode()

START_CMD = _make_wreg_cmd(0xB1, 0x03)

# ---------------------------------------------------------------
# Temperature helpers
# ---------------------------------------------------------------
def raw_to_celsius(raw: np.ndarray) -> np.ndarray:
    temps = raw.astype(np.float32) * 0.0984 - 265.82
    return np.clip(temps, -20.0, 150.0)   # realistic thermal cam range

# ---------------------------------------------------------------
# Camera connection
# ---------------------------------------------------------------
def connect_camera() -> socket.socket:
    while True:
        sock = None  # FIX: initialize before try so except clause is always safe
        try:
            print(f"[*] Connecting to {CAMERA_HOST}:{CAMERA_PORT}...")
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, RECV_BUFSIZE)
            sock.settimeout(10)
            sock.connect((CAMERA_HOST, CAMERA_PORT))
            sock.sendall(START_CMD)
            print(f"[+] Connected and stream started.")
            # Consume the WREG ACK quickly
            sock.settimeout(1)
            try:
                sock.recv(64)
            except socket.timeout:
                pass
            sock.settimeout(15)
            return sock
        except Exception as e:
            print(f"[!] Connection failed: {e}. Retrying in 3s...")
            try: sock.close()
            except: pass
            time.sleep(3)

# ---------------------------------------------------------------
# Frame processor
# ---------------------------------------------------------------
def process_frame(packet: bytes) -> dict:
    pixel_bytes = packet[STRIP_HEAD : STRIP_HEAD + RAW_DATA_SIZE]
    raw = np.frombuffer(pixel_bytes, dtype="<u2").reshape((HEIGHT, WIDTH))
    temps = raw_to_celsius(raw)

    max_temp = float(temps.max())
    avg_temp = float(temps.mean())
    
    status = "SAFE"
    if max_temp >= 120:
        status = "FIRE RISK"
    elif max_temp >= 90:
        status = "DANGER"
    elif max_temp >= 60:
        status = "WARNING"

    # ── Step 1: Global contrast stretch (percentile) ─────────────────
    p2, p98 = np.percentile(temps, 2), np.percentile(temps, 98)
    stretched = np.clip((temps - p2) / (p98 - p2 + 0.01) * 255, 0, 255).astype(np.uint8)

    # ── Step 2: CLAHE — local contrast (pro thermal camera technique) ─
    # Splits image into tiles and equalises each one independently,
    # revealing detail in both hot AND cool regions simultaneously.
    clahe   = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4))
    enhanced = clahe.apply(stretched)

    # ── Step 3: Perceptually sharp colourmap ─────────────────────────
    # INFERNO: black→purple→red→yellow→white — maximum perceptual depth
    heatmap = cv2.applyColorMap(enhanced, cv2.COLORMAP_INFERNO)

    # ── Hotspot detection (uses CLAHE output for accuracy) ───────────
    thr = int(np.percentile(enhanced, 85))
    _, timg = cv2.threshold(enhanced, thr, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(timg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hotspots = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area > 3: # require minimum size
            x, y, w, h = cv2.boundingRect(cnt)
            roi_max_temp = float(temps[y:y+h, x:x+w].max())
            if roi_max_temp > (avg_temp + 10):
                hotspots.append({
                    "x": int(x), "y": int(y), "w": int(w), "h": int(h),
                    "area": int(area),
                    "max_val": round(roi_max_temp, 1)
                })
    hotspots.sort(key=lambda h: h["max_val"], reverse=True)

    # ── Step 4: 4x Lanczos upscale to 640x496 ────────────────────────
    heatmap = cv2.resize(heatmap, (640, 496), interpolation=cv2.INTER_LANCZOS4)

    # ── Step 5: Stronger unsharp mask (1.8 weight) ───────────────────
    blur    = cv2.GaussianBlur(heatmap, (0, 0), sigmaX=1.5)
    heatmap = cv2.addWeighted(heatmap, 1.8, blur, -0.8, 0)

    # ── Encode at quality 95 ──────────────────────────────────────────
    _, buf = cv2.imencode(".jpg", heatmap, [cv2.IMWRITE_JPEG_QUALITY, 95])
    img_b64 = base64.b64encode(buf).decode("utf-8")

    return {
        "machine":       MACHINE_ID,
        "temperature":   round(max_temp, 1),
        "avg_temp":      round(avg_temp, 1),
        "status":        status,
        "timestamp":     time.strftime("%Y-%m-%d %H:%M:%S"),
        "thermal_image": img_b64,
        "hotspots":      hotspots
    }

# ---------------------------------------------------------------
# Background upload thread
# Works from a queue. If a new frame arrives before the old one
# is uploaded, the old frame is dropped (always show latest data).
# ---------------------------------------------------------------
def upload_worker(upload_queue: queue.Queue, counters: dict):
    session = requests.Session()   # reuse TCP connection to backend
    while True:
        payload = upload_queue.get()
        if payload is None:        # sentinel to stop
            break
        try:
            r = session.post(SERVER_URL, json=payload, timeout=5)
            if r.status_code == 200:
                counters["sent"] += 1
                n = len(payload["hotspots"])
                print(f"  >> max={payload['temperature']}°C | "
                      f"avg={payload['avg_temp']}°C | "
                      f"{payload['status']} | hotspots={n}")
            else:
                print(f"  [!] Backend HTTP {r.status_code}")
        except Exception as e:
            print(f"  [!] Upload error: {e}")
        finally:
            upload_queue.task_done()

# ---------------------------------------------------------------
# Main
# ---------------------------------------------------------------
def main():
    print("=" * 60)
    print("  DreamVision ESP32 Camera Reader (Optimized)")
    print(f"  Camera : {CAMERA_HOST}:{CAMERA_PORT}")
    print(f"  Backend: {SERVER_URL}")
    print(f"  Frame  : {TCP_FRAME_SIZE}B | {WIDTH}x{HEIGHT}px")
    print("=" * 60)

    # Upload queue: size 1 so we always process the LATEST frame
    upload_queue = queue.Queue(maxsize=1)
    counters     = {"sent": 0, "total": 0, "dropped": 0}

    uploader = threading.Thread(target=upload_worker, args=(upload_queue, counters),
                                daemon=True)
    uploader.start()

    rx_buf = b""
    sock   = connect_camera()

    try:
        while True:
            try:
                chunk = sock.recv(RECV_BUFSIZE)
                if not chunk:
                    print("[!] Camera disconnected. Reconnecting...")
                    sock.close()
                    rx_buf = b""
                    sock = connect_camera()
                    continue

                rx_buf += chunk

                # Process all complete frames
                while len(rx_buf) >= TCP_FRAME_SIZE:
                    packet = rx_buf[:TCP_FRAME_SIZE]
                    rx_buf = rx_buf[TCP_FRAME_SIZE:]
                    counters["total"] += 1

                    # Validate header
                    if packet[:4] != b"   #":
                        idx = rx_buf.find(b"   #")
                        if idx >= 0:
                            rx_buf = rx_buf[idx:]
                        else:
                            rx_buf = b""
                        continue

                    payload = process_frame(packet)

                    # Non-blocking put: drop old frame if uploader is busy
                    try:
                        upload_queue.put_nowait(payload)
                    except queue.Full:
                        try:
                            upload_queue.get_nowait()   # discard old
                        except queue.Empty:
                            pass
                        upload_queue.put_nowait(payload)
                        counters["dropped"] += 1

            except socket.timeout:
                print("[!] Socket timeout. Reconnecting...")
                sock.close()
                rx_buf = b""
                sock = connect_camera()
            except (ConnectionError, OSError, Exception) as e:
                print(f"[!] Error: {e}. Reconnecting...")
                try: sock.close()
                except: pass
                rx_buf = b""
                sock = connect_camera()

    except KeyboardInterrupt:
        print("\n[*] Stopped by user.")
    finally:
        try: sock.close()
        except: pass
        upload_queue.put(None)   # stop uploader
        t  = counters["total"]
        s  = counters["sent"]
        dr = counters["dropped"]
        print(f"[*] Frames: received={t}, uploaded={s}, dropped={dr}")

if __name__ == "__main__":
    main()
