import requests
import time
import random
import cv2
import numpy as np
import base64

SERVER_URL = "http://localhost:8000/upload"
machines = ["Motor A", "Motor B", "Motor C", "Conveyor Belt", "Pump Unit", "ESP32_THERMAL_CAM"]

print("Starting Advanced Raspberry Pi Thermal Camera Simulator (OpenCV Enabled)...")

def generate_synthetic_thermal_frame(overheat=False, near_threshold=False):
    """
    Generate a 80x62 synthetic thermal frame.
    """
    # Base temperature background (ambient 30-40C)
    base_temp = np.random.normal(loc=35, scale=5, size=(62, 80))
    
    # Create a hot spot representing the machine
    center_y, center_x = 31, 40
    y, x = np.ogrid[-center_y:62-center_y, -center_x:80-center_x]
    
    # Create radial gradient for the hotspot
    distance = np.sqrt(x*x + y*y)
    
    if overheat:
        # Strictly cap for demo (prevents backend 120C FIRE RISK classification)
        peak_temp = random.uniform(70, 85)
        spread = 12
    elif near_threshold:
        # Warning zone: 60-70°C 
        peak_temp = random.uniform(60, 70)
        spread = 15
    else:
        peak_temp = random.uniform(40, 55)
        spread = 18
        
    hotspot = np.exp(-(distance**2) / (2.0 * spread**2)) * peak_temp
    
    # Combine background and hotspot
    frame = base_temp + hotspot
    return frame

def frame_to_heatmap_base64(frame):
    """
    Converts 80x62 raw thermal frame to a COLORMAP_JET heatmap.
    """
    # Normalize frame to 0-255 for OpenCV colormap
    min_val = np.min(frame)
    max_val = np.max(frame)
    
    if max_val - min_val == 0:
        normalized = np.zeros_like(frame, dtype=np.uint8)
    else:
        normalized = ((frame - min_val) / (max_val - min_val) * 255.0).astype(np.uint8)
        
    # Apply JET heatmap (Blue=Cold, Red=Hot)
    heatmap = cv2.applyColorMap(normalized, cv2.COLORMAP_JET)
    
    # Resize for dashboard (maintaining 80:62 aspect ratio roughly)
    heatmap = cv2.resize(heatmap, (640, 496), interpolation=cv2.INTER_CUBIC)
    
    # Encode as JPEG
    _, buffer = cv2.imencode('.jpg', heatmap)
    
    # Convert to base64 string
    b64_str = base64.b64encode(buffer).decode('utf-8')
    return b64_str

while True:
    machine = random.choice(machines)
    
    # Probability distribution for danger zone demo:
    # 20% → Overheating (danger zone)
    # 30% → Near threshold (warning zone)
    # 50% → Normal operation (safe zone)
    roll = random.random()
    is_overheating = roll < 0.2
    is_near_threshold = 0.2 <= roll < 0.5
    
    # 1. Capture/Generate Frame (80x62)
    frame = generate_synthetic_thermal_frame(overheat=is_overheating, near_threshold=is_near_threshold)
    
    # 2. Status Classification
    avg_temp = np.mean(frame)
    max_temp = np.max(frame)
    
    status = "SAFE"
    if max_temp >= 120:
        status = "FIRE RISK"
    elif max_temp >= 90:
        status = "DANGER"
    elif max_temp >= 60:
        status = "WARNING"
        
    # 3. Generate Heatmap
    encoded_image = frame_to_heatmap_base64(frame)
    
    # --- AI-Powered Hotspot Localization ---
    hotspots = []
    # Convert frame to 0-255 for thresholding
    f_min, f_max = np.min(frame), np.max(frame)
    frame_8bit = (((frame - f_min) / (f_max - f_min)) * 255).astype(np.uint8) if f_max > f_min else np.zeros_like(frame, dtype=np.uint8)
    
    _, thresh = cv2.threshold(frame_8bit, 180, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area > 2:
            x, y, w, h = cv2.boundingRect(cnt)
            roi_max_temp = float(np.max(frame[y:y+h, x:x+w]))
            if roi_max_temp > (avg_temp + 10):
                hotspots.append({
                    "x": int(x), "y": int(y), "w": int(w), "h": int(h),
                    "area": int(area),
                    "max_val": round(roi_max_temp, 1)
                })
        
    data = {
        "machine": machine,
        "temperature": round(max_temp, 2), # Send maximum recorded temp in the frame
        "status": status,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "thermal_image": encoded_image,
        "hotspots": hotspots
    }
    
    try:
        res = requests.post(SERVER_URL, json=data)
        print(f"[{data['timestamp']}] Sent {data['machine']} (80x62) - MAX: {round(max_temp, 1)}°C - {status}")
    except Exception as e:
        print(f"Failed to connect to server: {e}")
        
    time.sleep(2)
