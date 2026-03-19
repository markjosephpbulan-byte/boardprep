from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
import json, os, uuid, base64, random, string
import psycopg2
import psycopg2.extras
from datetime import datetime, timedelta
from functools import wraps
from collections import defaultdict
import threading
import requests as http_requests

app = Flask(__name__, static_folder="static")
app.secret_key = os.environ.get("SECRET_KEY", "boardprep-dev-secret-change-in-prod")

DATABASE_URL = os.environ.get("DATABASE_URL", "")

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
ALLOWED_EXT = {"png", "jpg", "jpeg", "gif", "webp"}

# ══════════════════════════════════════════════════════════════════════════════
#  DATABASE
# ══════════════════════════════════════════════════════════════════════════════


def get_db():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL environment variable not set")
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = False
    return conn


def db_execute(query, params=(), fetch="none"):
    conn = get_db()
    try:
        cur = conn.cursor()
        cur.execute(query, params)
        result = None
        if fetch == "one":
            row = cur.fetchone()
            result = dict(row) if row else None
        elif fetch == "all":
            rows = cur.fetchall()
            result = [dict(r) for r in rows]
        conn.commit()
        cur.close()
        return result
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()


def init_db():
    db_execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            TEXT PRIMARY KEY,
            username      TEXT UNIQUE NOT NULL,
            display_name  TEXT NOT NULL,
            email         TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            avatar        TEXT,
            exam_date     TEXT,
            created_at    TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    db_execute("""
        CREATE TABLE IF NOT EXISTS subjects (
            id         TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            color      TEXT DEFAULT '#4f8ef7',
            position   INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    db_execute("""
        CREATE TABLE IF NOT EXISTS subsections (
            id         TEXT PRIMARY KEY,
            subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            user_id    TEXT NOT NULL,
            name       TEXT NOT NULL,
            done       BOOLEAN DEFAULT FALSE,
            position   INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    db_execute("""
        CREATE TABLE IF NOT EXISTS topics (
            id            TEXT PRIMARY KEY,
            subsection_id TEXT NOT NULL REFERENCES subsections(id) ON DELETE CASCADE,
            user_id       TEXT NOT NULL,
            name          TEXT NOT NULL,
            done          BOOLEAN DEFAULT FALSE,
            position      INTEGER DEFAULT 0,
            created_at    TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    db_execute("""
        CREATE TABLE IF NOT EXISTS notes (
            id         TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title      TEXT DEFAULT 'Untitled',
            content    TEXT DEFAULT '',
            color      TEXT DEFAULT '#fef08a',
            done       BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)


try:
    init_db()
    print("[DB] Tables ready")
except Exception as e:
    print(f"[DB] Init warning: {e}")

# ══════════════════════════════════════════════════════════════════════════════
#  RATE LIMITER
# ══════════════════════════════════════════════════════════════════════════════


class RateLimiter:
    def __init__(self):
        self._counts = defaultdict(list)
        self._lock = threading.Lock()

    def is_allowed(self, key, max_requests, window_seconds):
        now = datetime.now()
        cutoff = now - timedelta(seconds=window_seconds)
        with self._lock:
            self._counts[key] = [t for t in self._counts[key] if t > cutoff]
            if len(self._counts[key]) >= max_requests:
                return False
            self._counts[key].append(now)
            return True


limiter = RateLimiter()


def get_client_ip():
    return (
        request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        or request.remote_addr
        or "0.0.0.0"
    )


def rate_limit(max_requests, window_seconds, scope=""):
    def decorator(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            ip = get_client_ip()
            key = f"{scope or f.__name__}:{ip}"
            if not limiter.is_allowed(key, max_requests, window_seconds):
                return jsonify({
                    "error": f"Too many requests. Please wait {window_seconds} seconds and try again."
                }), 429
            return f(*args, **kwargs)

        return wrapped

    return decorator


# ══════════════════════════════════════════════════════════════════════════════
#  EMAIL (Brevo)
# ══════════════════════════════════════════════════════════════════════════════

BREVO_API_KEY = os.environ.get("BREVO_API_KEY", "")
EMAIL_FROM = os.environ.get("EMAIL_FROM", "BoardPrep PH")
EMAIL_ADDRESS = os.environ.get("EMAIL_ADDRESS", "noreply@boardprep.ph")
EMAIL_ENABLED = bool(BREVO_API_KEY)

pending_verifications = {}
pending_resets = {}


def generate_code():
    return "".join(random.choices(string.digits, k=6))


def _brevo_send(to_email, subject, html_body):
    if not EMAIL_ENABLED:
        print(f"[DEV EMAIL] To: {to_email} | Subject: {subject}")
        return True, None
    try:
        resp = http_requests.post(
            "https://api.brevo.com/v3/smtp/email",
            headers={"api-key": BREVO_API_KEY, "Content-Type": "application/json"},
            json={
                "sender": {"name": EMAIL_FROM, "email": EMAIL_ADDRESS},
                "to": [{"email": to_email}],
                "subject": subject,
                "htmlContent": html_body,
            },
            timeout=10,
        )
        if resp.status_code in (200, 201):
            return True, None
        try:
            err = resp.json().get("message") or str(resp.status_code)
        except Exception:
            err = str(resp.status_code)
        return False, f"({resp.status_code}) {err}"
    except Exception as e:
        return False, str(e)


def _code_email_html(code, code_color, subtitle, footer):
    return f"""
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;
                background:#0d1117;color:#e8edf5;border-radius:12px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="font-size:2rem">&#128218;</div>
        <h1 style="color:#f5c842;font-size:1.4rem;margin:8px 0">BoardPrep PH</h1>
        <p style="color:#8b97a8;font-size:0.9rem">Board Exam Learning Tracker</p>
      </div>
      <p style="color:#8b97a8;margin-bottom:24px">{subtitle}</p>
      <div style="background:#1e2736;border:2px solid {code_color};border-radius:12px;
                  padding:24px;text-align:center;margin-bottom:24px;">
        <div style="font-size:2.5rem;font-weight:800;letter-spacing:12px;
                    color:{code_color};font-family:monospace">{code}</div>
        <div style="color:#8b97a8;font-size:0.8rem;margin-top:8px">
          This code expires in 10 minutes</div>
      </div>
      <p style="color:#5a6678;font-size:0.8rem;text-align:center">{footer}</p>
    </div>"""


def send_verification_email(to_email, code, display_name):
    html = _code_email_html(
        code,
        "#f5c842",
        f"Hi <strong>{display_name}</strong>, enter this code to complete your registration:",
        "If you did not request this, you can safely ignore this email.",
    )
    return _brevo_send(to_email, "Your BoardPrep PH Verification Code", html)


def send_reset_email(to_email, code, display_name):
    html = _code_email_html(
        code,
        "#f56565",
        f"Hi <strong>{display_name}</strong>, use this code to reset your password:",
        "If you did not request this, your password has not been changed.",
    )
    return _brevo_send(to_email, "BoardPrep PH — Password Reset Code", html)


# ══════════════════════════════════════════════════════════════════════════════
#  DB HELPERS
# ══════════════════════════════════════════════════════════════════════════════


def get_user_by_id(user_id):
    return db_execute("SELECT * FROM users WHERE id=%s", (user_id,), fetch="one")


def get_user_by_username(username):
    return db_execute(
        "SELECT * FROM users WHERE LOWER(username)=LOWER(%s)", (username,), fetch="one"
    )


def get_user_by_email(email):
    return db_execute(
        "SELECT * FROM users WHERE LOWER(email)=LOWER(%s)", (email,), fetch="one"
    )


def safe_user(u):
    return {
        "id": u["id"],
        "username": u["username"],
        "display_name": u["display_name"],
        "email": u.get("email", ""),
        "avatar": u.get("avatar"),
        "exam_date": u.get("exam_date"),
        "created_at": str(u.get("created_at", "")),
    }


def get_subjects_for_user(user_id):
    subjects = (
        db_execute(
            "SELECT * FROM subjects WHERE user_id=%s ORDER BY position, created_at",
            (user_id,),
            fetch="all",
        )
        or []
    )
    for s in subjects:
        subsections = (
            db_execute(
                "SELECT * FROM subsections WHERE subject_id=%s ORDER BY position, created_at",
                (s["id"],),
                fetch="all",
            )
            or []
        )
        for ss in subsections:
            ss["done"] = bool(ss["done"])
            topics = (
                db_execute(
                    "SELECT * FROM topics WHERE subsection_id=%s ORDER BY position, created_at",
                    (ss["id"],),
                    fetch="all",
                )
                or []
            )
            for t in topics:
                t["done"] = bool(t["done"])
                t["created_at"] = str(t["created_at"])
            ss["topics"] = topics
            ss["created_at"] = str(ss["created_at"])
        s["subsections"] = subsections
        s["created_at"] = str(s["created_at"])
    return subjects


def calc_progress_db(user_id):
    row = db_execute(
        """
        SELECT COUNT(t.id) as total,
               SUM(CASE WHEN t.done THEN 1 ELSE 0 END) as done
        FROM topics t
        JOIN subsections ss ON ss.id = t.subsection_id
        JOIN subjects s ON s.id = ss.subject_id
        WHERE s.user_id = %s
    """,
        (user_id,),
        fetch="one",
    )
    total = int(row["total"] or 0)
    done = int(row["done"] or 0)
    nt = db_execute(
        """
        SELECT COUNT(ss.id) as cnt,
               SUM(CASE WHEN ss.done THEN 1 ELSE 0 END) as done_cnt
        FROM subsections ss
        WHERE ss.user_id=%s
          AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.subsection_id=ss.id)
    """,
        (user_id,),
        fetch="one",
    )
    total += int(nt["cnt"] or 0)
    done += int(nt["done_cnt"] or 0)
    return total, done


# ══════════════════════════════════════════════════════════════════════════════
#  AUTH DECORATORS
# ══════════════════════════════════════════════════════════════════════════════


def owner_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Unauthorized"}), 401
        if session["user_id"] != kwargs.get("user_id"):
            return jsonify({"error": "Forbidden"}), 403
        return f(*args, **kwargs)

    return decorated


# ══════════════════════════════════════════════════════════════════════════════
#  AUTH ROUTES
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/auth/request-code", methods=["POST"])
@rate_limit(5, 600, "request_code")
def request_code():
    body = request.json or {}
    username = (body.get("username") or "").strip()
    password = (body.get("password") or "").strip()
    email = (body.get("email") or "").strip().lower()
    display_name = (body.get("display_name") or username).strip()

    if not username:
        return jsonify({"error": "Username is required"}), 400
    if len(username) < 3:
        return jsonify({"error": "Username must be at least 3 characters"}), 400
    if not password or len(password) < 4:
        return jsonify({"error": "Password must be at least 4 characters"}), 400
    if not email or "@" not in email:
        return jsonify({"error": "A valid email address is required"}), 400
    if get_user_by_username(username):
        return jsonify({"error": "Username already taken"}), 409
    if get_user_by_email(email):
        return jsonify({"error": "An account with this email already exists"}), 409

    code = generate_code()
    pending_verifications[email] = {
        "code": code,
        "username": username,
        "display_name": display_name,
        "password_hash": generate_password_hash(password),
        "expires_at": (datetime.now() + timedelta(minutes=10)).isoformat(),
    }
    ok, err = send_verification_email(email, code, display_name)
    if not ok:
        return jsonify({"error": f"Failed to send email: {err}"}), 500
    return jsonify({"ok": True, "email": email, "dev_mode": not EMAIL_ENABLED})


@app.route("/api/auth/register", methods=["POST"])
@rate_limit(10, 600, "register")
def register():
    body = request.json or {}
    email = (body.get("email") or "").strip().lower()
    code = (body.get("code") or "").strip()

    pending = pending_verifications.get(email)
    if not pending:
        return jsonify({
            "error": "No pending verification. Please request a new code."
        }), 400
    if datetime.now() > datetime.fromisoformat(pending["expires_at"]):
        del pending_verifications[email]
        return jsonify({"error": "Code has expired. Please request a new one."}), 400
    if pending["code"] != code:
        return jsonify({"error": "Incorrect code. Please try again."}), 401
    if get_user_by_username(pending["username"]):
        del pending_verifications[email]
        return jsonify({
            "error": "Username was just taken. Please choose another."
        }), 409

    uid = str(uuid.uuid4())
    db_execute(
        "INSERT INTO users (id, username, display_name, email, password_hash) VALUES (%s,%s,%s,%s,%s)",
        (
            uid,
            pending["username"],
            pending["display_name"],
            email,
            pending["password_hash"],
        ),
    )
    del pending_verifications[email]
    user = get_user_by_id(uid)
    session["user_id"] = uid
    return jsonify(safe_user(user)), 201


@app.route("/api/auth/login", methods=["POST"])
@rate_limit(10, 300, "login")
def login():
    body = request.json or {}
    username = (body.get("username") or "").strip()
    password = (body.get("password") or "").strip()
    user = get_user_by_username(username)
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
    user = get_user_by_id(session["user_id"])
    if not user:
        session.clear()
        return jsonify({"error": "User not found"}), 404
    return jsonify(safe_user(user))


@app.route("/api/auth/forgot-password", methods=["POST"])
@rate_limit(5, 600, "forgot_password")
def forgot_password():
    body = request.json or {}
    email = (body.get("email") or "").strip().lower()
    if not email or "@" not in email:
        return jsonify({"error": "Please enter a valid email address."}), 400
    user = get_user_by_email(email)
    if user:
        code = generate_code()
        pending_resets[email] = {
            "code": code,
            "user_id": user["id"],
            "expires_at": (datetime.now() + timedelta(minutes=10)).isoformat(),
        }
        ok, err = send_reset_email(email, code, user["display_name"])
        if not ok:
            return jsonify({"error": f"Failed to send email: {err}"}), 500
    return jsonify({"ok": True, "dev_mode": not EMAIL_ENABLED})


@app.route("/api/auth/reset-password", methods=["POST"])
@rate_limit(10, 600, "reset_password")
def reset_password():
    body = request.json or {}
    email = (body.get("email") or "").strip().lower()
    code = (body.get("code") or "").strip()
    new_password = (body.get("new_password") or "").strip()
    if not email or not code or not new_password:
        return jsonify({"error": "All fields are required."}), 400
    if len(new_password) < 4:
        return jsonify({"error": "Password must be at least 4 characters."}), 400
    pending = pending_resets.get(email)
    if not pending:
        return jsonify({
            "error": "No reset request found. Please request a new code."
        }), 400
    if datetime.now() > datetime.fromisoformat(pending["expires_at"]):
        del pending_resets[email]
        return jsonify({"error": "Code has expired. Please request a new one."}), 400
    if pending["code"] != code:
        return jsonify({"error": "Incorrect code. Please try again."}), 401
    user = get_user_by_id(pending["user_id"])
    if not user:
        del pending_resets[email]
        return jsonify({"error": "Account not found."}), 404
    db_execute(
        "UPDATE users SET password_hash=%s WHERE id=%s",
        (generate_password_hash(new_password), pending["user_id"]),
    )
    del pending_resets[email]
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  PROFILES  (public)
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/profiles", methods=["GET"])
def list_profiles():
    users = db_execute("SELECT * FROM users ORDER BY created_at", fetch="all") or []
    profiles = []
    for u in users:
        total, done = calc_progress_db(u["id"])
        pct = 0 if total == 0 else round((done / total) * 100)
        sc = db_execute(
            "SELECT COUNT(*) as c FROM subjects WHERE user_id=%s",
            (u["id"],),
            fetch="one",
        )
        profiles.append({
            "id": u["id"],
            "username": u["username"],
            "display_name": u["display_name"],
            "avatar": u.get("avatar"),
            "subject_count": int(sc["c"] or 0),
            "progress_pct": pct,
            "created_at": str(u["created_at"]),
        })
    return jsonify(profiles)


@app.route("/api/profiles/<user_id>", methods=["GET"])
def get_profile(user_id):
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "Not found"}), 404
    total, done = calc_progress_db(user_id)
    pct = 0 if total == 0 else round((done / total) * 100)
    sc = db_execute(
        "SELECT COUNT(*) as c FROM subjects WHERE user_id=%s", (user_id,), fetch="one"
    )
    return jsonify({
        **safe_user(user),
        "subject_count": int(sc["c"] or 0),
        "progress_pct": pct,
    })


# ══════════════════════════════════════════════════════════════════════════════
#  PROFILE SETTINGS  (owner only)
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/profiles/<user_id>/settings", methods=["PUT"])
@owner_required
def update_profile(user_id):
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "Not found"}), 404
    body = request.json or {}
    if "username" in body:
        new_username = (body["username"] or "").strip().lower()
        if not new_username:
            return jsonify({"error": "Username cannot be empty"}), 400
        if len(new_username) < 3:
            return jsonify({"error": "Username must be at least 3 characters"}), 400
        if not new_username.replace("_", "").replace(".", "").isalnum():
            return jsonify({
                "error": "Username can only contain letters, numbers, _ and ."
            }), 400
        existing = get_user_by_username(new_username)
        if existing and existing["id"] != user_id:
            return jsonify({"error": "Username already taken"}), 409
        db_execute("UPDATE users SET username=%s WHERE id=%s", (new_username, user_id))
    if "display_name" in body:
        dn = (body["display_name"] or "").strip()
        if dn:
            db_execute("UPDATE users SET display_name=%s WHERE id=%s", (dn, user_id))
    if "exam_date" in body:
        db_execute(
            "UPDATE users SET exam_date=%s WHERE id=%s", (body["exam_date"], user_id)
        )
    if "new_password" in body and body["new_password"]:
        if not body.get("current_password"):
            return jsonify({"error": "Current password required"}), 400
        if not check_password_hash(user["password_hash"], body["current_password"]):
            return jsonify({"error": "Current password is wrong"}), 401
        db_execute(
            "UPDATE users SET password_hash=%s WHERE id=%s",
            (generate_password_hash(body["new_password"]), user_id),
        )
    return jsonify(safe_user(get_user_by_id(user_id)))


@app.route("/api/profiles/<user_id>/avatar", methods=["POST"])
@owner_required
def upload_avatar(user_id):
    if "avatar" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    f = request.files["avatar"]
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in ALLOWED_EXT:
        return jsonify({"error": "Invalid file type"}), 400
    raw = f.read()
    if len(raw) > 2 * 1024 * 1024:
        return jsonify({"error": "Image too large (max 2MB)"}), 400
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
    b64 = base64.b64encode(raw).decode()
    avatar = f"data:{mime};base64,{b64}"
    db_execute("UPDATE users SET avatar=%s WHERE id=%s", (avatar, user_id))
    return jsonify(safe_user(get_user_by_id(user_id)))


@app.route("/api/profiles/<user_id>/delete-account", methods=["POST"])
@owner_required
def delete_own_account(user_id):
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "Not found"}), 404
    body = request.json or {}
    password = body.get("password", "")
    if not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Incorrect password"}), 401
    db_execute("DELETE FROM users WHERE id=%s", (user_id,))
    session.clear()
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  SUBJECTS
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/profiles/<user_id>/subjects", methods=["GET"])
@owner_required
def get_subjects(user_id):
    return jsonify(get_subjects_for_user(user_id))


@app.route("/api/profiles/<user_id>/subjects", methods=["POST"])
@owner_required
def add_subject(user_id):
    body = request.json or {}
    name = body.get("name", "").strip()
    color = body.get("color", "#4f8ef7")
    if not name:
        return jsonify({"error": "Name is required"}), 400
    sid = str(uuid.uuid4())
    db_execute(
        "INSERT INTO subjects (id, user_id, name, color) VALUES (%s,%s,%s,%s)",
        (sid, user_id, name, color),
    )
    s = db_execute("SELECT * FROM subjects WHERE id=%s", (sid,), fetch="one")
    s["subsections"] = []
    s["created_at"] = str(s["created_at"])
    return jsonify(s), 201


@app.route("/api/profiles/<user_id>/subjects/<subject_id>", methods=["PUT"])
@owner_required
def update_subject(user_id, subject_id):
    body = request.json or {}
    name = body.get("name", "").strip()
    color = body.get("color", "#4f8ef7")
    db_execute(
        "UPDATE subjects SET name=%s, color=%s WHERE id=%s AND user_id=%s",
        (name, color, subject_id, user_id),
    )
    s = db_execute("SELECT * FROM subjects WHERE id=%s", (subject_id,), fetch="one")
    if not s:
        return jsonify({"error": "Not found"}), 404
    s["created_at"] = str(s["created_at"])
    return jsonify(s)


@app.route("/api/profiles/<user_id>/subjects/<subject_id>", methods=["DELETE"])
@owner_required
def delete_subject(user_id, subject_id):
    db_execute("DELETE FROM subjects WHERE id=%s AND user_id=%s", (subject_id, user_id))
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  SUBSECTIONS
# ══════════════════════════════════════════════════════════════════════════════


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections", methods=["POST"]
)
@owner_required
def add_subsection(user_id, subject_id):
    body = request.json or {}
    name = body.get("name", "").strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400
    ssid = str(uuid.uuid4())
    db_execute(
        "INSERT INTO subsections (id, subject_id, user_id, name) VALUES (%s,%s,%s,%s)",
        (ssid, subject_id, user_id, name),
    )
    ss = db_execute("SELECT * FROM subsections WHERE id=%s", (ssid,), fetch="one")
    ss["done"] = bool(ss["done"])
    ss["topics"] = []
    ss["created_at"] = str(ss["created_at"])
    return jsonify(ss), 201


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections/<sub_id>",
    methods=["PUT"],
)
@owner_required
def update_subsection(user_id, subject_id, sub_id):
    body = request.json or {}
    if "name" in body:
        db_execute(
            "UPDATE subsections SET name=%s WHERE id=%s AND user_id=%s",
            (body["name"], sub_id, user_id),
        )
    if "done" in body:
        db_execute(
            "UPDATE subsections SET done=%s WHERE id=%s AND user_id=%s",
            (bool(body["done"]), sub_id, user_id),
        )
    ss = db_execute("SELECT * FROM subsections WHERE id=%s", (sub_id,), fetch="one")
    if not ss:
        return jsonify({"error": "Not found"}), 404
    ss["done"] = bool(ss["done"])
    ss["created_at"] = str(ss["created_at"])
    return jsonify(ss)


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections/<sub_id>",
    methods=["DELETE"],
)
@owner_required
def delete_subsection(user_id, subject_id, sub_id):
    db_execute("DELETE FROM subsections WHERE id=%s AND user_id=%s", (sub_id, user_id))
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  TOPICS
# ══════════════════════════════════════════════════════════════════════════════


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections/<sub_id>/topics",
    methods=["POST"],
)
@owner_required
def add_topic(user_id, subject_id, sub_id):
    body = request.json or {}
    name = body.get("name", "").strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400
    tid = str(uuid.uuid4())
    db_execute(
        "INSERT INTO topics (id, subsection_id, user_id, name) VALUES (%s,%s,%s,%s)",
        (tid, sub_id, user_id, name),
    )
    t = db_execute("SELECT * FROM topics WHERE id=%s", (tid,), fetch="one")
    t["done"] = bool(t["done"])
    t["created_at"] = str(t["created_at"])
    return jsonify(t), 201


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections/<sub_id>/topics/<topic_id>",
    methods=["PUT"],
)
@owner_required
def update_topic(user_id, subject_id, sub_id, topic_id):
    body = request.json or {}
    if "name" in body:
        db_execute(
            "UPDATE topics SET name=%s WHERE id=%s AND user_id=%s",
            (body["name"], topic_id, user_id),
        )
    if "done" in body:
        db_execute(
            "UPDATE topics SET done=%s WHERE id=%s AND user_id=%s",
            (bool(body["done"]), topic_id, user_id),
        )
    t = db_execute("SELECT * FROM topics WHERE id=%s", (topic_id,), fetch="one")
    if not t:
        return jsonify({"error": "Not found"}), 404
    t["done"] = bool(t["done"])
    t["created_at"] = str(t["created_at"])
    return jsonify(t)


@app.route(
    "/api/profiles/<user_id>/subjects/<subject_id>/subsections/<sub_id>/topics/<topic_id>",
    methods=["DELETE"],
)
@owner_required
def delete_topic(user_id, subject_id, sub_id, topic_id):
    db_execute("DELETE FROM topics WHERE id=%s AND user_id=%s", (topic_id, user_id))
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  NOTES
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/profiles/<user_id>/notes", methods=["GET"])
@owner_required
def get_notes(user_id):
    notes = (
        db_execute(
            "SELECT * FROM notes WHERE user_id=%s ORDER BY created_at DESC",
            (user_id,),
            fetch="all",
        )
        or []
    )
    for n in notes:
        n["done"] = bool(n["done"])
        n["created_at"] = str(n["created_at"])
        n["updated_at"] = str(n["updated_at"])
    return jsonify(notes)


@app.route("/api/profiles/<user_id>/notes", methods=["POST"])
@owner_required
def add_note(user_id):
    body = request.json or {}
    nid = str(uuid.uuid4())
    title = body.get("title", "Untitled")
    content = body.get("content", "")
    color = body.get("color", "#fef08a")
    db_execute(
        "INSERT INTO notes (id, user_id, title, content, color) VALUES (%s,%s,%s,%s,%s)",
        (nid, user_id, title, content, color),
    )
    n = db_execute("SELECT * FROM notes WHERE id=%s", (nid,), fetch="one")
    n["done"] = bool(n["done"])
    n["created_at"] = str(n["created_at"])
    n["updated_at"] = str(n["updated_at"])
    return jsonify(n), 201


@app.route("/api/profiles/<user_id>/notes/<note_id>", methods=["PUT"])
@owner_required
def update_note(user_id, note_id):
    body = request.json or {}
    fields = []
    vals = []
    if "title" in body:
        fields.append("title=%s")
        vals.append(body["title"])
    if "content" in body:
        fields.append("content=%s")
        vals.append(body["content"])
    if "color" in body:
        fields.append("color=%s")
        vals.append(body["color"])
    if "done" in body:
        fields.append("done=%s")
        vals.append(bool(body["done"]))
    if fields:
        fields.append("updated_at=NOW()")
        vals.extend([note_id, user_id])
        db_execute(
            f"UPDATE notes SET {', '.join(fields)} WHERE id=%s AND user_id=%s", vals
        )
    n = db_execute("SELECT * FROM notes WHERE id=%s", (note_id,), fetch="one")
    if not n:
        return jsonify({"error": "Not found"}), 404
    n["done"] = bool(n["done"])
    n["created_at"] = str(n["created_at"])
    n["updated_at"] = str(n["updated_at"])
    return jsonify(n)


@app.route("/api/profiles/<user_id>/notes/<note_id>", methods=["DELETE"])
@owner_required
def delete_note(user_id, note_id):
    db_execute("DELETE FROM notes WHERE id=%s AND user_id=%s", (note_id, user_id))
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  ADMIN
# ══════════════════════════════════════════════════════════════════════════════

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin1234")


def check_admin_auth():
    header_pw = request.headers.get("X-Admin-Password", "")
    if header_pw and header_pw == ADMIN_PASSWORD:
        return True
    return bool(session.get("is_admin"))


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not check_admin_auth():
            return jsonify({"error": "Admin access required"}), 403
        return f(*args, **kwargs)

    return decorated


@app.route("/api/admin/login", methods=["POST"])
@rate_limit(5, 600, "admin_login")
def admin_login():
    body = request.json or {}
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
    if not check_admin_auth():
        return jsonify({"error": "Not logged in"}), 401
    return jsonify({"ok": True, "is_admin": True})


@app.route("/api/admin/users", methods=["GET"])
@admin_required
def admin_list_users():
    users = (
        db_execute("SELECT * FROM users ORDER BY created_at DESC", fetch="all") or []
    )
    result = []
    for u in users:
        total, done = calc_progress_db(u["id"])
        pct = 0 if total == 0 else round((done / total) * 100)
        sc = db_execute(
            "SELECT COUNT(*) as c FROM subjects WHERE user_id=%s",
            (u["id"],),
            fetch="one",
        )
        nc = db_execute(
            "SELECT COUNT(*) as c FROM notes WHERE user_id=%s", (u["id"],), fetch="one"
        )
        result.append({
            "id": u["id"],
            "username": u["username"],
            "display_name": u["display_name"],
            "email": u.get("email", "—"),
            "avatar": u.get("avatar"),
            "subject_count": int(sc["c"] or 0),
            "notes_count": int(nc["c"] or 0),
            "progress_pct": pct,
            "created_at": str(u["created_at"]),
        })
    return jsonify(result)


@app.route("/api/admin/users/<user_id>", methods=["DELETE"])
@admin_required
def admin_delete_user(user_id):
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    db_execute("DELETE FROM users WHERE id=%s", (user_id,))
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  CONFIG + FRONTEND
# ══════════════════════════════════════════════════════════════════════════════

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")


@app.route("/api/config", methods=["GET"])
def get_config():
    return jsonify({"gemini_key": GEMINI_API_KEY})


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/admin")
def admin_page():
    return send_from_directory("static", "admin.html")


@app.route("/privacy")
def privacy_page():
    return send_from_directory("static", "privacy.html")


@app.route("/<path:path>")
def catch_all(path):
    return send_from_directory("static", "index.html")


if __name__ == "__main__":
    app.run(debug=True, port=5000)
