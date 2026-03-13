import sqlite3
import os
from datetime import datetime

# Find the database directory relative to this file
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_FILE = os.path.join(BASE_DIR, "database", "dreamvision.db")

def init_db():
    # FIX: ensure the database directory exists before connecting
    os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS thermal_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            machine_name TEXT,
            temperature REAL,
            status TEXT,
            timestamp TEXT,
            thermal_image TEXT,
            hotspots TEXT
        )
    ''')
    conn.commit()
    conn.close()

def insert_data(machine_name, temperature, status, timestamp=None, thermal_image="", hotspots="[]"):
    if not timestamp:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO thermal_data (machine_name, temperature, status, timestamp, thermal_image, hotspots)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (machine_name, temperature, status, timestamp, thermal_image, hotspots))
    conn.commit()
    conn.close()

def get_all_data(limit=100):
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM thermal_data ORDER BY id DESC LIMIT ?', (limit,))
    rows = cursor.fetchall()
    conn.close()
    
    # Reverse the list so the frontend gets them in chronological order
    data = [dict(row) for row in rows]
    data.reverse()
    return data
