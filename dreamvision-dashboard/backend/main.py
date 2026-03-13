from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.security import OAuth2PasswordRequestForm
from database import init_db, insert_data, get_all_data
from auth import verify_password, create_access_token, decode_access_token, oauth2_scheme, get_user
import base64
import os
import re
import json
from fpdf import FPDF
from fastapi.responses import FileResponse

# Initialize the database on startup
init_db()

app = FastAPI(title="DreamVision Dashboard API")

# Setup CORS to allow the frontend to fetch data without issues
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve the images directory statically (single mount - FIX: removed duplicate)
os.makedirs("images", exist_ok=True)
app.mount("/images", StaticFiles(directory="images"), name="images")

# API routes and WebSocket management below...

# Manage WebSocket connections
class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"[WS] New client connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            print(f"[WS] Client disconnected. Total: {len(self.active_connections)}")

    async def broadcast(self, message: list):
        dead = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                dead.append(connection)  # FIX: track failed connections
        # Remove dead connections after iteration to avoid modifying list mid-loop
        for conn in dead:
            self.disconnect(conn)

manager = ConnectionManager()

@app.post("/upload")
async def upload_data(data: dict):
    
    # 1. Handle Base64 Thermal Image Saving
    thermal_image_data = data.get("thermal_image", "")
    image_path = ""
    
    if thermal_image_data:
        try:
            # Create a safe filename using machine and timestamp
            machine_clean = re.sub(r'[^a-zA-Z0-9]', '_', data.get("machine", "Unknown"))
            ts_clean = re.sub(r'[^0-9]', '', data.get("timestamp", ""))
            filename = f"{machine_clean}_{ts_clean}.jpg"
            filepath = os.path.join("images", filename)
            
            # Decode and write to file
            with open(filepath, "wb") as f:
                f.write(base64.b64decode(thermal_image_data))
                
            image_path = f"/images/{filename}"
        except Exception as e:
            print(f"Error saving image: {e}")
    
    # 2. Store metadata (and file path) into SQLite
    insert_data(
        machine_name=data.get("machine", "Unknown"),
        temperature=data.get("temperature", 0.0),
        status=data.get("status", "UNKNOWN"),
        timestamp=data.get("timestamp"),
        thermal_image=image_path,  # We now store the PATH, not the Base64
        hotspots=json.dumps(data.get("hotspots", []))
    )
    
    # Broadcast the new data list to all connected websockets
    # KEY SMOOTHNESS FIX: attach live base64 image to the last entry so the
    # browser can render it directly — no second HTTP request needed.
    latest_data = get_all_data(limit=100)
    if thermal_image_data and latest_data:
        # Shallow-copy last entry so we don't mutate the DB row
        live_entry = dict(latest_data[-1])
        live_entry["live_image_b64"] = thermal_image_data
        latest_data = latest_data[:-1] + [live_entry]
    await manager.broadcast(latest_data)
    
    return {"status": "stored", "image_path": image_path}

@app.post("/login")
def login(form_data: OAuth2PasswordRequestForm = Depends()):
    user = get_user(form_data.username)
    if not user or not verify_password(form_data.password, user["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token = create_access_token(data={"sub": user["username"], "role": user["role"]})
    return {"access_token": access_token, "token_type": "bearer", "role": user["role"]}

@app.get("/data")
def get_historical_data(limit: int = 100, token: str = Depends(oauth2_scheme)):
    # Protect with traditional HTTP Bearer Auth
    payload = decode_access_token(token)
    if not payload:
         raise HTTPException(status_code=401, detail="Invalid token")
    
    # Fetch latest entries from SQLite
    data = get_all_data(limit=limit)
    return data

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = None):
    # Protect WebSocket via query parameter "token"
    if not token or not decode_access_token(token):
        print(f"[WS] Connection REJECTED: Invalid or missing token")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
        
    print(f"[WS] Connection ACCEPTED for token: {token[:10]}...")
    await manager.connect(websocket)
    # Send initial data upon connection
    await websocket.send_json(get_all_data(limit=100))
    try:
        while True:
            # We don't expect messages from the client
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

@app.get("/report/{item_id}")
async def generate_report(item_id: int, token: str = Depends(oauth2_scheme)):
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    # 1. Fetch data from DB
    from database import DB_FILE
    import sqlite3
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM thermal_data WHERE id = ?", (item_id,))
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        raise HTTPException(status_code=404, detail="Incident not found")
    
    data = dict(row)
    
    # 2. Create PDF
    pdf = FPDF()
    pdf.add_page()
    
    # Header
    pdf.set_font("Arial", "B", 16)
    pdf.cell(190, 10, "DreamVision Incident Report", ln=True, align="C")
    pdf.set_font("Arial", "", 12)
    pdf.cell(190, 10, f"Generated on: {data['timestamp']}", ln=True, align="C")
    pdf.ln(10)
    
    # Details
    pdf.set_font("Arial", "B", 12)
    pdf.cell(40, 10, "Machine:")
    pdf.set_font("Arial", "", 12)
    pdf.cell(100, 10, data["machine_name"], ln=True)
    
    pdf.set_font("Arial", "B", 12)
    pdf.cell(40, 10, "Temperature:")
    pdf.set_font("Arial", "", 12)
    pdf.cell(100, 10, f"{data['temperature']} C", ln=True)
    
    pdf.set_font("Arial", "B", 12)
    pdf.cell(40, 10, "Status:")
    pdf.set_font("Arial", "", 12)
    pdf.cell(100, 10, data["status"], ln=True)
    
    pdf.ln(10)
    
    # Image
    if data["thermal_image"]:
        # Relative path from backend
        img_path = data["thermal_image"].lstrip("/")
        if os.path.exists(img_path):
            pdf.image(img_path, x=10, y=pdf.get_y(), w=100)
            pdf.ln(80) # Move down after image
            
    # Hotspots
    if data["hotspots"]:
        try:
            hotspots = json.loads(data["hotspots"])
            if hotspots:
                pdf.set_font("Arial", "B", 12)
                pdf.cell(190, 10, "Detected Hotspots:", ln=True)
                pdf.set_font("Arial", "", 10)
                for i, hs in enumerate(hotspots):
                    pdf.cell(190, 8, f"#{i+1}: Loc({hs['x']}, {hs['y']}) | Size: {hs['area']}px | Peak: {hs['max_val']} C", ln=True)
        except:
            pass
            
    # Footer
    pdf.set_y(-30)
    pdf.set_font("Arial", "I", 8)
    pdf.cell(190, 10, "Confidential - DreamVision Thermal Monitoring System", align="C")
    
    report_filename = f"report_{item_id}.pdf"
    report_path = os.path.join("images", report_filename)
    pdf.output(report_path)
    
    return FileResponse(report_path, filename=report_filename, media_type="application/pdf")

# Serve the frontend directory statically (Catch-all mount)
# This must remain at the very end to avoid shadowing API routes like /login
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
