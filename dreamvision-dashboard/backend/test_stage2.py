import requests
import time
import json

BASE_URL = "http://localhost:8000"
LOGIN_URL = f"{BASE_URL}/login"
UPLOAD_URL = f"{BASE_URL}/upload"

def test_stage2_logic():
    print("[*] Starting Stage 2 Verification...")
    
    # 1. Login to get token
    print("[*] Authenticating...")
    try:
        res = requests.post(LOGIN_URL, data={"username": "admin", "password": "admin123"})
        res.raise_for_status()
        token = res.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        print("[+] Auth successful.")
    except Exception as e:
        print(f"[!] Auth failed. (Is server running?) Error: {e}")
        return

    # 2. Check Configs
    print("[*] Checking Asset Configs...")
    res = requests.get(f"{BASE_URL}/configs", headers=headers)
    configs = res.json()
    print(f"[+] Received {len(configs)} configs.")
    
    # 3. Simulate Data Upload & Verify Health Score
    print("[*] Simulating Normal Data for Motor A...")
    data = {
        "machine": "Motor A",
        "temperature": 45.0,
        "status": "SAFE",
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "hotspots": []
    }
    res = requests.post(UPLOAD_URL, json=data)
    score1 = res.json().get("health_score")
    print(f"[+] Motor A Health Score (Normal): {score1}")

    print("[*] Simulating Critical Data for Motor A (Spike)...")
    data["temperature"] = 82.0 # Near 85 threshold
    res = requests.post(UPLOAD_URL, json=data)
    score2 = res.json().get("health_score")
    print(f"[+] Motor A Health Score (Critical): {score2}")
    
    if score2 < score1:
        print("[+ SUCCESS] Health scoring engine is responsive to temperature increases.")
    else:
        print("[! FAILURE] Health score did not drop as expected.")

    # 4. Test Config Update
    print("[*] Updating Threshold for Motor A to 70...")
    res = requests.post(f"{BASE_URL}/update_config", headers=headers, json={
        "machine_name": "Motor A",
        "threshold": 70.0
    })
    print(f"[+] Config update status: {res.json().get('status')}")
    
    # Verify persistence
    res = requests.get(f"{BASE_URL}/configs", headers=headers)
    new_threshold = res.json()["Motor A"]["threshold"]
    if new_threshold == 70.0:
        print("[+ SUCCESS] Configuration update persisted in DB.")
    else:
        print(f"[! FAILURE] Configuration persistent failed. Got {new_threshold}")

if __name__ == "__main__":
    test_stage2_logic()
