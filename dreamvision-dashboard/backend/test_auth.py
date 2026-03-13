from auth import verify_password, get_user

def test_auth():
    username = "admin"
    password = "admin123"
    
    user = get_user(username)
    if not user:
        print(f"FAILED: User {username} not found")
        return
        
    is_valid = verify_password(password, user["hashed_password"])
    if is_valid:
        print(f"SUCCESS: {username} authenticated correctly")
    else:
        print(f"FAILED: {username} authentication failed")
        print(f"Plain: {password}")
        print(f"Hashed: {user['hashed_password']}")

if __name__ == "__main__":
    test_auth()
