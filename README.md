# DreamVision Thermal Monitoring Dashboard 🌡️🛡️

DreamVision is an industrial-grade thermal monitoring system designed to detect fires, hotspots, and machine overheating in real-time. Built specifically for integration with ESP32-based thermal cameras (like MLX90640), it provides a robust, fail-safe dashboard for factory safety.

## 🚀 Key Features

### 1. Industrial-Grade Logic
- **Fire Risk Detection:** Alarms trigger only after persistence checks (3 frames) to avoid false positives.
- **Hotspot Tracking:** Minimum area and temperature contrast filtering.
- **Tiered Alerts:** Four status levels: `SAFE`, `WARNING`, `DANGER`, and `FIRE RISK`.

### 2. Smart Danger Zone Map
- **Spatial ROI Monitoring:** Tracks temperatures in specific factory zones using thermal hotspot coordinates.
- **Pulsing Animations:** Clear visual indicators for machines in critical states.
- **Trend Forecasting:** AI-driven linear regression for heat trend predictions.

### 3. ESP32 & Simulator Support
- **Live Feed Connectivity:** Dedicated logic for ESP32 camera hardware.
- **Advanced Simulator:** Includes a Python-based simulator with OpenCV enhancements for testing.

### 4. Advanced Analytics
- **Historical Analysis:** Historical heat trend data and predictive maintenance deltas.
- **Report Generation:** Automated PDF incident reports for high-temperature events.

## 🛠️ Tech Stack
- **Frontend:** HTML5, Vanilla CSS3 (Modern Glassmorphism Design), JavaScript (ES6+), Chart.js
- **Backend:** Python (FastAPI), Uvicorn, SQLite, FPDF
- **Camera Pipeline:** NumPy, OpenCV, Base64 Encoding

## 📦 Installation & Setup

### 1. Prerequisites
- Python 3.8+
- Node.js (Optional, for frontend serving if not using FastAPI)

### 2. Install Dependencies
```bash
pip install fastapi uvicorn requests numpy opencv-python fpdf
```

### 3. Run the Dashboard
1. **Start Backend:** 
   Double-click `1_start_server.bat` or run:
   ```bash
   cd backend
   uvicorn main:app --reload --port 8000
   ```
2. **Start Simulator (for testing):**
   ```bash
   python rpi_simulator.py
   ```
3. **Open Dashboard:**
   Visit [http://localhost:8000](http://localhost:8000)

## 👤 Credentials (Default)
- **Username:** `admin`
- **Password:** `admin`

## 📄 License
This project is developed for industrial monitoring and safety purposes.
