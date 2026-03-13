import os
import jwt
import hashlib
import hmac
from datetime import datetime, timedelta
from fastapi import HTTPException, status
from fastapi.security import OAuth2PasswordBearer

# FIX: load secret key from environment variable for security
SECRET_KEY = os.environ.get("DREAMVISION_SECRET_KEY", "dreamvision_super_secret_key")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")

def _hash_password(password: str) -> str:
    """Hash a password using HMAC-SHA256 (no external libraries needed)."""
    return hmac.new(SECRET_KEY.encode(), password.encode(), hashlib.sha256).hexdigest()

# User database with hashed passwords
# To change password, update the hash: _hash_password("newpassword")
users_db = {
    "admin": {
        "username": "admin",
        "full_name": "Admin Supervisor",
        "hashed_password": _hash_password("admin123"),
        "role": "admin"
    },
    "operator": {
        "username": "operator",
        "full_name": "Line Operator",
        "hashed_password": _hash_password("operator123"),
        "role": "operator"
    }
}

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify password by hashing and comparing (constant-time)."""
    return hmac.compare_digest(
        _hash_password(plain_password),
        hashed_password
    )

def get_user(username: str):
    return users_db.get(username)

def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def decode_access_token(token: str):
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
