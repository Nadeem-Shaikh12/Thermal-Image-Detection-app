"""
Generate fresh bcrypt hashes for auth.py
Run once: python gen_hashes.py
Then copy the output into auth.py
"""
import bcrypt

admin_hash = bcrypt.hashpw(b"admin123", bcrypt.gensalt(rounds=12)).decode()
operator_hash = bcrypt.hashpw(b"operator123", bcrypt.gensalt(rounds=12)).decode()

print(f"admin_hash    = \"{admin_hash}\"")
print(f"operator_hash = \"{operator_hash}\"")
