from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
import json, os, uuid, base64
from datetime import datetime
from functools import wraps

app = Flask(__name__, static_folder="static")
app.secret_key = os.environ.get("SECRET_KEY", "boardprep-dev-secret-change-in-prod")

DATA_FILE = os.environ.get("DATA_FILE", "data.json")
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXT = {"png", "jpg", "jpeg", "gif", "webp"}

# ── Data helpers ──────────────────────────────────────────────────────────────


def load_data():
    if not os.path.exists(DATA_FILE):
        return {"users": []}
    with open(DATA_FILE, "r") as f:
        data = json.load(f)
    # Migrate old format (had "subjects"/"notes" at root) to new format
    if "users" not in data:
        data = {"users": []}
        save_data(data)
    return data


def save_data(data):
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


def init_data():
    if not os.path.exists(DATA_FILE):
        save_data({"users": []})


init_data()


def get_user(data, user_id):
    return next((u for u in data["users"] if u["id"] == user_id), None)


def get_user_by_username(data, username):
    return next(
        (u for u in data["users"] if u["username"].lower() == username.lower()), None
    )


# ── Auth decorator ────────────────────────────────────────────────────────────


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)

    return decorated


def owner_required(f):
    """Route must have <user_id> param — checks session matches it."""

    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Unauthorized"}), 401
        if session["user_id"] != kwargs.get("user_id"):
            return jsonify({"error": "Forbidden"}), 403
        return f(*args, **kwargs)

    return decorated


# ══════════════════════════════════════════════════════════════════════════════
#  AUTH
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/auth/register", methods=["POST"])
def register():
    data = load_data()
    body = request.json
    username = (body.get("username") or "").strip()
    password = (body.get("password") or "").strip()
    display_name = (body.get("display_name") or username).strip()

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400
    if len(username) < 3:
        return jsonify({"error": "Username must be at least 3 characters"}), 400
    if len(password) < 4:
        return jsonify({"error": "Password must be at least 4 characters"}), 400
    if get_user_by_username(data, username):
        return jsonify({"error": "Username already taken"}), 409

    user = {
        "id": str(uuid.uuid4()),
        "username": username,
        "display_name": display_name,
        "password_hash": generate_password_hash(password),
        "avatar": None,
        "subjects": [],
        "notes": [],
        "created_at": datetime.now().isoformat(),
    }
    data["users"].append(user)
    save_data(data)

    session["user_id"] = user["id"]
    return jsonify(safe_user(user)), 201


@app.route("/api/auth/login", methods=["POST"])
def login():
    data = load_data()
    body = request.json
    username = (body.get("username") or "").strip()
    password = (body.get("password") or "").strip()

    user = get_user_by_username(data, username)
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid username or password"}), 401

    session["user_id"] = user["id"]
    return jsonify(safe_user(user))


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/auth/me", methods=["GET"])
def me():
    if "user_id" not in session:
        return jsonify({"error": "Not logged in"}), 401
    data = load_data()
    user = get_user(data, session["user_id"])
    if not user:
        session.clear()
        return jsonify({"error": "User not found"}), 404
    return jsonify(safe_user(user))


def safe_user(u):
    """Return user object without password hash."""
    return {
        "id": u["id"],
        "username": u["username"],
        "display_name": u["display_name"],
        "avatar": u.get("avatar"),
        "created_at": u["created_at"],
    }


# ══════════════════════════════════════════════════════════════════════════════
#  PROFILES  (public listing — anyone can see, no auth needed)
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/profiles", methods=["GET"])
def list_profiles():
    data = load_data()
    profiles = []
    for u in data["users"]:
        total, done = calc_progress(u)
        pct = 0 if total == 0 else round((done / total) * 100)
        profiles.append({
            "id": u["id"],
            "username": u["username"],
            "display_name": u["display_name"],
            "avatar": u.get("avatar"),
            "subject_count": len(u.get("subjects", [])),
            "progress_pct": pct,
            "created_at": u["created_at"],
        })
    return jsonify(profiles)


@app.route("/api/profiles/<user_id>", methods=["GET"])
def get_profile(user_id):
    """
    Public profile info only (no subjects/notes).
    Must supply correct password to get full data — see /api/profiles/<id>/unlock
    """
    data = load_data()
    user = get_user(data, user_id)
    if not user:
        return jsonify({"error": "Not found"}), 404
    total, done = calc_progress(user)
    pct = 0 if total == 0 else round((done / total) * 100)
    return jsonify({
        **safe_user(user),
        "subject_count": len(user.get("subjects", [])),
        "progress_pct": pct,
    })


def calc_progress(user):
    total = done = 0
    for s in user.get("subjects", []):
        for ss in s.get("subsections", []):
            if not ss.get("topics"):
                total += 1
                if ss.get("done"):
                    done += 1
            else:
                total += len(ss["topics"])
                done += sum(1 for t in ss["topics"] if t.get("done"))
    return total, done


# ══════════════════════════════════════════════════════════════════════════════
#  PROFILE SETTINGS  (owner only)
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/profiles/<user_id>/settings", methods=["PUT"])
@owner_required
def update_profile(user_id):
    data = load_data()
    user = get_user(data, user_id)
    if not user:
        return jsonify({"error": "Not found"}), 404
    body = request.json
    if "display_name" in body:
        dn = body["display_name"].strip()
        if dn:
            user["display_name"] = dn
    if "new_password" in body and body["new_password"]:
        if not body.get("current_password"):
            return jsonify({"error": "Current password required"}), 400
        if not check_password_hash(user["password_hash"], body["current_password"]):
            return jsonify({"error": "Current password is wrong"}), 401
        user["password_hash"] = generate_password_hash(body["new_password"])
    save_data(data)
    return jsonify(safe_user(user))


@app.route("/api/profiles/<user_id>/avatar", methods=["POST"])
@owner_required
def upload_avatar(user_id):
    data = load_data()
    user = get_user(data, user_id)
    if not user:
        return jsonify({"error": "Not found"}), 404

    if "avatar" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    f = request.files["avatar"]
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in ALLOWED_EXT:
        return jsonify({"error": "Invalid file type"}), 400

    # Store as base64 data-URL so we don't need static file serving complexity
    raw = f.read()
    if len(raw) > 2 * 1024 * 1024:  # 2 MB limit
        return jsonify({"error": "Image too large (max 2MB)"}), 400

    mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
    b64 = base64.b64encode(raw).decode()
    user["avatar"] = f"data:{mime};base64,{b64}"
    save_data(data)
    return jsonify(safe_user(user))


# ══════════════════════════════════════════════════════════════════════════════
#  SUBJECTS  (owner only)
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/profiles/<user_id>/subjects", methods=["GET"])
@owner_required
def get_subjects(user_id):
    data = load_data()
    user = get_user(data, user_id)
    return jsonify(user.get("subjects", []))


@app.route("/api/profiles/<user_id>/subjects", methods=["POST"])
@owner_required
def add_subject(user_id):
    data = load_data()
    user = get_user(data, user_id)
    body = request.json
    subject = {
        "id": str(uuid.uuid4()),
        "name": body["name"],
        "color": body.get("color", "#4f8ef7"),
        "subsections": [],
        "created_at": datetime.now().isoformat(),
    }
    user.setdefault("subjects", []).append(subject)
    save_data(data)
    return jsonify(subject), 201


@app.route("/api/profiles/<user_id>/subjects/<subject_id>", methods=["PUT"])
@owner_required
def update_subject(user_id, subject_id):
    data = load_data()
    user = get_user(data, user_id)
    body = request.json
    for s in user.get("subjects", []):
        if s["id"] == subject_id:
            s["name"] = body.get("name", s["name"])
            s["color"] = body.get("color", s["color"])
            save_data(data)
            return jsonify(s)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/profiles/<user_id>/subjects/<subject_id>", methods=["DELETE"])
@owner_required
def delete_subject(user_id, subject_id):
    data = load_data()
    user = get_user(data, user_id)
    user["subjects"] = [s for s in user.get("subjects", []) if s["id"] != subject_id]
    save_data(data)
    return jsonify({"ok": True})


# ── Subsections ───────────────────────────────────────────────────────────────


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections", methods=["POST"]
)
@owner_required
def add_subsection(user_id, subject_id):
    data = load_data()
    user = get_user(data, user_id)
    body = request.json
    ss = {
        "id": str(uuid.uuid4()),
        "name": body["name"],
        "done": False,
        "topics": [],
        "created_at": datetime.now().isoformat(),
    }
    for s in user.get("subjects", []):
        if s["id"] == subject_id:
            s["subsections"].append(ss)
            save_data(data)
            return jsonify(ss), 201
    return jsonify({"error": "Not found"}), 404


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections/<sub_id>",
    methods=["PUT"],
)
@owner_required
def update_subsection(user_id, subject_id, sub_id):
    data = load_data()
    user = get_user(data, user_id)
    body = request.json
    for s in user.get("subjects", []):
        if s["id"] == subject_id:
            for ss in s["subsections"]:
                if ss["id"] == sub_id:
                    ss["name"] = body.get("name", ss["name"])
                    ss["done"] = body.get("done", ss["done"])
                    save_data(data)
                    return jsonify(ss)
    return jsonify({"error": "Not found"}), 404


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections/<sub_id>",
    methods=["DELETE"],
)
@owner_required
def delete_subsection(user_id, subject_id, sub_id):
    data = load_data()
    user = get_user(data, user_id)
    for s in user.get("subjects", []):
        if s["id"] == subject_id:
            s["subsections"] = [ss for ss in s["subsections"] if ss["id"] != sub_id]
            save_data(data)
            return jsonify({"ok": True})
    return jsonify({"error": "Not found"}), 404


# ── Topics ────────────────────────────────────────────────────────────────────


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections/<sub_id>/topics",
    methods=["POST"],
)
@owner_required
def add_topic(user_id, subject_id, sub_id):
    data = load_data()
    user = get_user(data, user_id)
    body = request.json
    topic = {
        "id": str(uuid.uuid4()),
        "name": body["name"],
        "done": False,
        "created_at": datetime.now().isoformat(),
    }
    for s in user.get("subjects", []):
        if s["id"] == subject_id:
            for ss in s["subsections"]:
                if ss["id"] == sub_id:
                    ss["topics"].append(topic)
                    save_data(data)
                    return jsonify(topic), 201
    return jsonify({"error": "Not found"}), 404


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections/<sub_id>/topics/<topic_id>",
    methods=["PUT"],
)
@owner_required
def update_topic(user_id, subject_id, sub_id, topic_id):
    data = load_data()
    user = get_user(data, user_id)
    body = request.json
    for s in user.get("subjects", []):
        if s["id"] == subject_id:
            for ss in s["subsections"]:
                if ss["id"] == sub_id:
                    for t in ss["topics"]:
                        if t["id"] == topic_id:
                            t["name"] = body.get("name", t["name"])
                            t["done"] = body.get("done", t["done"])
                            save_data(data)
                            return jsonify(t)
    return jsonify({"error": "Not found"}), 404


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections/<sub_id>/topics/<topic_id>",
    methods=["DELETE"],
)
@owner_required
def delete_topic(user_id, subject_id, sub_id, topic_id):
    data = load_data()
    user = get_user(data, user_id)
    for s in user.get("subjects", []):
        if s["id"] == subject_id:
            for ss in s["subsections"]:
                if ss["id"] == sub_id:
                    ss["topics"] = [t for t in ss["topics"] if t["id"] != topic_id]
                    save_data(data)
                    return jsonify({"ok": True})
    return jsonify({"error": "Not found"}), 404


# ── Notes ─────────────────────────────────────────────────────────────────────


@app.route("/api/profiles/<user_id>/notes", methods=["GET"])
@owner_required
def get_notes(user_id):
    data = load_data()
    user = get_user(data, user_id)
    return jsonify(user.get("notes", []))


@app.route("/api/profiles/<user_id>/notes", methods=["POST"])
@owner_required
def add_note(user_id):
    data = load_data()
    user = get_user(data, user_id)
    body = request.json
    note = {
        "id": str(uuid.uuid4()),
        "title": body.get("title", "Untitled"),
        "content": body.get("content", ""),
        "color": body.get("color", "#fef08a"),
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }
    user.setdefault("notes", []).append(note)
    save_data(data)
    return jsonify(note), 201


@app.route("/api/profiles/<user_id>/notes/<note_id>", methods=["PUT"])
@owner_required
def update_note(user_id, note_id):
    data = load_data()
    user = get_user(data, user_id)
    body = request.json
    for n in user.get("notes", []):
        if n["id"] == note_id:
            n["title"] = body.get("title", n["title"])
            n["content"] = body.get("content", n["content"])
            n["color"] = body.get("color", n["color"])
            n["updated_at"] = datetime.now().isoformat()
            save_data(data)
            return jsonify(n)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/profiles/<user_id>/notes/<note_id>", methods=["DELETE"])
@owner_required
def delete_note(user_id, note_id):
    data = load_data()
    user = get_user(data, user_id)
    user["notes"] = [n for n in user.get("notes", []) if n["id"] != note_id]
    save_data(data)
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  ADMIN
# ══════════════════════════════════════════════════════════════════════════════

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin1234")


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("is_admin"):
            return jsonify({"error": "Admin access required"}), 403
        return f(*args, **kwargs)

    return decorated


@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    body = request.json
    if body.get("password") != ADMIN_PASSWORD:
        return jsonify({"error": "Wrong admin password"}), 401
    session["is_admin"] = True
    return jsonify({"ok": True})


@app.route("/api/admin/logout", methods=["POST"])
def admin_logout():
    session.pop("is_admin", None)
    return jsonify({"ok": True})


@app.route("/api/admin/me", methods=["GET"])
def admin_me():
    if not session.get("is_admin"):
        return jsonify({"error": "Not logged in"}), 401
    return jsonify({"ok": True, "is_admin": True})


@app.route("/api/admin/users", methods=["GET"])
@admin_required
def admin_list_users():
    data = load_data()
    result = []
    for u in data["users"]:
        total, done = calc_progress(u)
        pct = 0 if total == 0 else round((done / total) * 100)
        result.append({
            "id": u["id"],
            "username": u["username"],
            "display_name": u["display_name"],
            "avatar": u.get("avatar"),
            "subject_count": len(u.get("subjects", [])),
            "notes_count": len(u.get("notes", [])),
            "progress_pct": pct,
            "created_at": u["created_at"],
        })
    return jsonify(result)


@app.route("/api/admin/users/<user_id>", methods=["DELETE"])
@admin_required
def admin_delete_user(user_id):
    data = load_data()
    before = len(data["users"])
    data["users"] = [u for u in data["users"] if u["id"] != user_id]
    if len(data["users"]) == before:
        return jsonify({"error": "User not found"}), 404
    save_data(data)
    return jsonify({"ok": True})


# ── Serve frontend ────────────────────────────────────────────────────────────


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/admin")
def admin_page():
    return send_from_directory("static", "admin.html")


@app.route("/<path:path>")
def catch_all(path):
    return send_from_directory("static", "index.html")


if __name__ == "__main__":
    app.run(debug=True, port=5000)
