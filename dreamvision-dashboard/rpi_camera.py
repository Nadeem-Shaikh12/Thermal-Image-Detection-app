import cv2
import numpy as np
import base64
import requests
import time

# --- Configuration variables ---
# Look up your ESP32's assigned IP address on your network router
ESP32_STREAM_URL = "http://192.168.4.1:3333" # Correct Gateway IP
SERVER_URL = "http://localhost:8000/upload"
MACHINE_ID = "Motor A" # Identifier for the machine this camera is pointing at

print(f"Starting DreamVision Raspberry Pi Camera node for {MACHINE_ID}...")
print(f"Connecting to ESP32 stream at: {ESP32_STREAM_URL}")

cap = cv2.VideoCapture(ESP32_STREAM_URL)

while True:
    ret, frame = cap.read()
    
    if not ret:
        print(f"Failed to grab frame from {ESP32_STREAM_URL}. Retrying...")
        time.sleep(2)
        # Attempt to reconnect the stream
        cap = cv2.VideoCapture(ESP32_STREAM_URL)
        continue

    # Convert BGR frame from ESP32 to grayscale to calculate intensity/temperature relative proxies
    if len(frame.shape) == 3:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    else:
        gray = frame

    avg = np.mean(gray)
    max_val = np.max(gray)

    # Convert the frame to a visually distinct COLORMAP_JET heatmap for the dashboard 
    heatmap = cv2.applyColorMap(gray, cv2.COLORMAP_JET)

    status = "OK"
    # Stage 10.4 Smart Logic: Threshold based on relative peak vs average
    # We flag NOK (Overheating) if max intensity exceeds the background average by 20 AND crosses an absolute floor (e.g., 80)
    if max_val > avg + 20 and max_val > 80: 
        status = "NOK"

    # Encode the visualization to send to the backend
    _, buffer = cv2.imencode(".jpg", heatmap)
    img_base64 = base64.b64encode(buffer).decode("utf-8")

    payload = {
        "machine": MACHINE_ID,
        "temperature": int(max_val),
        "status": status,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "thermal_image": img_base64
    }

    try:
        res = requests.post(SERVER_URL, json=payload)
        print(f"[{payload['timestamp']}] Sent {MACHINE_ID} - Temp: {int(max_val)} - Status: {status} -> DB Response: {res.status_code}")
    except requests.exceptions.RequestException as e:
        print(f"Connection to Backend Server failed: {e}")
        
    # Cap framerate to avoid flooding the backend with 30fps HTTP requests
    time.sleep(1)
