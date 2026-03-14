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
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS asset_configs (
            machine_name TEXT PRIMARY KEY,
            display_name TEXT,
            threshold REAL,
            x REAL,
            y REAL,
            radius REAL
        )
    ''')
    
    # MIGRATION: Add display_name if it doesn't exist
    try:
        cursor.execute("ALTER TABLE asset_configs ADD COLUMN display_name TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass # Column already exists
    # Seed no longer used for dynamic Hotspot mapping
    # cursor.execute("SELECT COUNT(*) FROM asset_configs")
    # if cursor.fetchone()[0] == 0:
    #     defaults = [
    #         ("Motor A", 85.0, 20.0, 30.0, 55.0),
    #         ("Motor B", 85.0, 50.0, 20.0, 55.0),
    #         ("Motor C", 85.0, 80.0, 40.0, 55.0),
    #         ("Conveyor Belt", 80.0, 40.0, 70.0, 60.0),
    #         ("Pump Unit", 90.0, 75.0, 80.0, 55.0),
    #         ("ESP32_THERMAL_CAM", 120.0, 15.0, 15.0, 50.0)
    #     ]
    #     cursor.executemany("INSERT INTO asset_configs VALUES (?, ?, ?, ?, ?)", defaults)
    #     conn.commit()
    conn.close()

def reset_database():
    """Wipes all thermal data and asset configurations."""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM thermal_data")
    cursor.execute("DELETE FROM asset_configs")
    conn.commit()
    conn.close()

def update_asset_config(machine_name, threshold, display_name=None):
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    if display_name:
        cursor.execute('''
            UPDATE asset_configs SET threshold = ?, display_name = ? WHERE machine_name = ?
        ''', (threshold, display_name, machine_name))
    else:
        cursor.execute('''
            UPDATE asset_configs SET threshold = ? WHERE machine_name = ?
        ''', (threshold, machine_name))
    conn.commit()
    conn.close()

def get_asset_configs():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM asset_configs")
    rows = cursor.fetchall()
    conn.close()
    return {row["machine_name"]: dict(row) for row in rows}

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
