"""Create (or change the password of) a RideCentric login. Sign-up on the website is turned off, so this is how accounts are made.

    python add_user.py                 ask for a username and password
    python add_user.py anna            create / update the user "anna", ask for the password
    python add_user.py --list          show the existing usernames

Run it in the same folder as main.py. On Windows use:  py add_user.py
Standard library only; passwords are hashed exactly like main.py does before they are saved to users.json.
"""
import getpass
import hashlib
import json
import os
import sys

USERS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "users.json")


def hash_password(password):  # keep identical to hash_password() in main.py
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def load_users():
    try:
        with open(USERS_FILE, "r") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def save_users(users):
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=4)


def main(argv):
    users = load_users()
    if "--list" in argv:
        print("Users: " + (", ".join(u.get("username", "?") for u in users) or "(none yet)"))
        return 0
    names = [a for a in argv if not a.startswith("-")]
    username = (names[0] if names else input("Username: ")).strip()
    if not username:
        print("A username is required.")
        return 1
    existing = next((u for u in users if u.get("username") == username), None)
    if existing:
        print(f'"{username}" already exists: the password will be replaced.')
    password = getpass.getpass("Password: ").strip()
    if not password:
        print("A password is required.")
        return 1
    if getpass.getpass("Repeat password: ").strip() != password:
        print("The two passwords are different. Nothing was saved.")
        return 1
    if existing:
        existing["password"] = hash_password(password)
    else:
        users.append({"username": username, "password": hash_password(password)})
    save_users(users)
    print(f'Saved. "{username}" can now log in.')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
