from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
import json, os, uuid, base64, random, string, hmac, hashlib
import psycopg2
import psycopg2.extras
from datetime import datetime, timedelta
from functools import wraps
from collections import defaultdict
import threading
import requests as http_requests

# Load .env file for local development
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass  # dotenv not installed — use system env vars (Railway)

from flask import make_response
import gzip
import io

app = Flask(__name__, static_folder="static")
app.secret_key = os.environ.get("SECRET_KEY", "boardprep-dev-secret-change-in-prod")
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SECURE"] = False  # Allow HTTP in local dev

# Tell browser to cache static files aggressively
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 31536000  # 1 year for static files


@app.after_request
def add_performance_headers(response):
    """Add headers that make the browser and CDN cache responses efficiently."""
    # Compress JSON responses — safely handle streaming/direct passthrough responses
    try:
        if (
            response.content_type.startswith("application/json")
            and response.direct_passthrough is False
            and len(response.data) > 1024
            and "gzip" in request.headers.get("Accept-Encoding", "")
        ):
            compressed = gzip.compress(response.data, compresslevel=6)
            if len(compressed) < len(response.data):
                response.data = compressed
                response.headers["Content-Encoding"] = "gzip"
                response.headers["Vary"] = "Accept-Encoding"
    except Exception:
        pass  # Skip compression if response doesn't support it

    # Cache static files for 1 year (they have unique names via versioning)
    if request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    # Cache profile list for 30s in browser too
    elif request.path == "/api/profiles" and response.status_code == 200:
        response.headers["Cache-Control"] = "public, max-age=30"
    # Never cache API responses that change per-user
    elif request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"

    # Security headers (good practice)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    return response


DATABASE_URL = os.environ.get("DATABASE_URL", "")

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
ALLOWED_EXT = {"png", "jpg", "jpeg", "gif", "webp"}

# ══════════════════════════════════════════════════════════════════════════════
#  DATABASE — Connection Pool (reuses connections, much faster)
# ══════════════════════════════════════════════════════════════════════════════

from psycopg2 import pool as pg_pool

_pool = None


def get_pool():
    """Create the connection pool once, reuse forever."""
    global _pool
    if _pool is None:
        if not DATABASE_URL:
            raise RuntimeError("DATABASE_URL environment variable not set")
        _pool = pg_pool.ThreadedConnectionPool(
            minconn=1,  # keep 1 connection warm (Railway free tier friendly)
            maxconn=5,  # max 5 simultaneous connections (free tier safe)
            dsn=DATABASE_URL
            + (
                ""
                if "keepalives" in DATABASE_URL
                else "?keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=5"
                if "?" not in DATABASE_URL
                else "&keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=5"
            ),
            cursor_factory=psycopg2.extras.RealDictCursor,
        )
        print("[DB] Connection pool created ✅")
    return _pool


def db_execute(query, params=(), fetch="none"):
    """Run a query using a pooled connection — fast."""
    pool = get_pool()
    conn = pool.getconn()
    try:
        conn.autocommit = False
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
        pool.putconn(conn)  # return connection to pool — NOT closed


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
            is_paused       BOOLEAN DEFAULT FALSE,
            is_pro          BOOLEAN DEFAULT TRUE,
            plan            TEXT DEFAULT 'trial',
            plan_expires    TIMESTAMPTZ,
            pro_since       TIMESTAMPTZ DEFAULT NOW(),
            streak          INTEGER DEFAULT 0,
            last_study_date DATE,
            created_at      TIMESTAMPTZ DEFAULT NOW()
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
            note          TEXT DEFAULT '',
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
    db_execute("""
        CREATE TABLE IF NOT EXISTS banned_emails (
            email         TEXT PRIMARY KEY,
            banned_until  TIMESTAMPTZ NOT NULL,
            reason        TEXT DEFAULT 'repeated account abuse',
            created_at    TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    db_execute("""
        CREATE TABLE IF NOT EXISTS deleted_accounts (
            id         SERIAL PRIMARY KEY,
            email      TEXT NOT NULL,
            deleted_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    db_execute("""
        CREATE TABLE IF NOT EXISTS flashcards (
            id             TEXT PRIMARY KEY,
            subject_id     TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            subsection_id  TEXT REFERENCES subsections(id) ON DELETE CASCADE,
            user_id        TEXT NOT NULL,
            question       TEXT NOT NULL,
            answer         TEXT NOT NULL DEFAULT '',
            created_at     TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    # Indexes — make WHERE user_id=? and WHERE subject_id=? queries instant
    db_execute("CREATE INDEX IF NOT EXISTS idx_subjects_user    ON subjects(user_id)")
    db_execute(
        "CREATE INDEX IF NOT EXISTS idx_subsections_subj ON subsections(subject_id)"
    )
    db_execute(
        "CREATE INDEX IF NOT EXISTS idx_subsections_user ON subsections(user_id)"
    )
    db_execute(
        "CREATE INDEX IF NOT EXISTS idx_topics_subsect   ON topics(subsection_id)"
    )
    db_execute("CREATE INDEX IF NOT EXISTS idx_topics_user      ON topics(user_id)")
    db_execute("CREATE INDEX IF NOT EXISTS idx_notes_user       ON notes(user_id)")
    db_execute(
        "CREATE INDEX IF NOT EXISTS idx_flashcards_subject ON flashcards(subject_id)"
    )
    db_execute(
        "CREATE INDEX IF NOT EXISTS idx_flashcards_user    ON flashcards(user_id)"
    )
    db_execute(
        "CREATE INDEX IF NOT EXISTS idx_users_username   ON users(LOWER(username))"
    )
    db_execute("CREATE INDEX IF NOT EXISTS idx_users_email      ON users(LOWER(email))")


try:
    get_pool()  # warm up the pool immediately on startup
    # Check if tables exist — skip init if they do (saves 13 DB round trips on restart)
    existing = db_execute(
        """
        SELECT COUNT(*) as c FROM information_schema.tables
        WHERE table_schema='public' AND table_name='users'
    """,
        fetch="one",
    )
    if not existing or int(existing.get("c", 0)) == 0:
        init_db()
        print("[DB] Tables created ✅")
    else:
        # Still create indexes (idempotent) but skip table creation
        db_execute(
            "CREATE INDEX IF NOT EXISTS idx_subjects_user    ON subjects(user_id)"
        )
        db_execute(
            "CREATE INDEX IF NOT EXISTS idx_subsections_subj ON subsections(subject_id)"
        )
        db_execute(
            "CREATE INDEX IF NOT EXISTS idx_subsections_user ON subsections(user_id)"
        )
        db_execute(
            "CREATE INDEX IF NOT EXISTS idx_topics_subsect   ON topics(subsection_id)"
        )
        db_execute("CREATE INDEX IF NOT EXISTS idx_topics_user      ON topics(user_id)")
        db_execute("CREATE INDEX IF NOT EXISTS idx_notes_user       ON notes(user_id)")
        # Safe migrations for existing DBs
        try:
            db_execute(
                "ALTER TABLE topics ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''"
            )
        except Exception:
            pass
        try:
            db_execute(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_paused BOOLEAN DEFAULT FALSE"
            )
            db_execute(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_pro BOOLEAN DEFAULT TRUE"
            )
            db_execute(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'trial'"
            )
            db_execute(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires TIMESTAMPTZ"
            )
            db_execute(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_since TIMESTAMPTZ DEFAULT NOW()"
            )
            # Fix existing trial accounts that have NULL plan_expires — set to 7 days from created_at
            db_execute("""
                UPDATE users SET plan_expires = created_at + INTERVAL '7 days'
                WHERE plan = 'trial' AND plan_expires IS NULL
            """)
        except Exception:
            pass
        # Streak columns — separate block so it always runs
        try:
            db_execute(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0"
            )
            db_execute(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_study_date DATE"
            )
            print("[DB] Streak columns ready ✅")
        except Exception as e:
            print(f"[DB] Streak migration error: {e}")
        try:
            db_execute("""
                CREATE TABLE IF NOT EXISTS banned_emails (
                    email TEXT PRIMARY KEY,
                    banned_until TIMESTAMPTZ NOT NULL,
                    reason TEXT DEFAULT 'repeated account abuse',
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            db_execute("""
                CREATE TABLE IF NOT EXISTS deleted_accounts (
                    id SERIAL PRIMARY KEY,
                    email TEXT NOT NULL,
                    deleted_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
        except Exception:
            pass
        try:
            db_execute("""
                CREATE TABLE IF NOT EXISTS flashcards (
                    id             TEXT PRIMARY KEY,
                    subject_id     TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
                    subsection_id  TEXT REFERENCES subsections(id) ON DELETE CASCADE,
                    user_id        TEXT NOT NULL,
                    question       TEXT NOT NULL,
                    answer         TEXT NOT NULL DEFAULT '',
                    created_at     TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            try:
                db_execute(
                    "ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS subsection_id TEXT REFERENCES subsections(id) ON DELETE CASCADE"
                )
            except Exception:
                pass
            db_execute(
                "CREATE INDEX IF NOT EXISTS idx_flashcards_subject ON flashcards(subject_id)"
            )
            db_execute(
                "CREATE INDEX IF NOT EXISTS idx_flashcards_user    ON flashcards(user_id)"
            )
        except Exception:
            pass
        # done_at columns for analytics (tracks WHEN topics/subsections were completed)
        try:
            db_execute(
                "ALTER TABLE topics ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ"
            )
            db_execute(
                "ALTER TABLE subsections ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ"
            )
            print("[DB] done_at columns ready ✅")
        except Exception as e:
            print(f"[DB] done_at migration: {e}")
        print("[DB] Ready ✅ (tables already exist)")
except Exception as e:
    print(f"[DB] ❌ FAILED: {e}")
    if DATABASE_URL:
        safe_url = DATABASE_URL.split("@")[1] if "@" in DATABASE_URL else "unknown"
        print(f"[DB] Tried connecting to: ...@{safe_url}")

# ══════════════════════════════════════════════════════════════════════════════
#  PLAN EXPIRY + EMAIL BAN SYSTEM
# ══════════════════════════════════════════════════════════════════════════════


def check_and_pause_expired_plans():
    """
    Smart auto-pause — runs on every login.
    - basic_pro_bonus expired → downgrade to basic (11 months remaining), NOT paused
    - trial/pro/basic expired  → pause account
    """
    try:
        # 1. Downgrade basic_pro_bonus to basic (don't pause — they paid for 1 year)
        db_execute("""
            UPDATE users
            SET is_pro=FALSE, plan='basic',
                plan_expires=plan_expires + INTERVAL '11 months'
            WHERE plan = 'basic_pro_bonus'
              AND plan_expires IS NOT NULL
              AND plan_expires < NOW()
              AND is_paused = FALSE
        """)
        # 2. Pause everything else that has expired (trial, pro, basic)
        db_execute("""
            UPDATE users
            SET is_paused = TRUE, is_pro = FALSE, plan = 'expired'
            WHERE plan_expires IS NOT NULL
              AND plan_expires < NOW()
              AND is_paused = FALSE
              AND plan != 'basic_pro_bonus'
        """)
    except Exception as e:
        print(f"[AutoPause] Error: {e}")


def is_email_banned(email):
    """Return ban record if email is banned, else None."""
    try:
        return db_execute(
            "SELECT banned_until FROM banned_emails WHERE LOWER(email)=LOWER(%s) AND banned_until > NOW()",
            (email,),
            fetch="one",
        )
    except Exception:
        return None


def record_account_deletion(email):
    """Track deletions. Ban email for 2 months after 3 deletions in 60 days."""
    try:
        db_execute(
            "INSERT INTO deleted_accounts (email, deleted_at) VALUES (LOWER(%s), NOW())",
            (email,),
        )
        count = db_execute(
            """
            SELECT COUNT(*) as c FROM deleted_accounts
            WHERE LOWER(email)=LOWER(%s)
              AND deleted_at > NOW() - INTERVAL '60 days'
        """,
            (email,),
            fetch="one",
        )
        if count and int(count.get("c", 0)) >= 3:
            db_execute(
                """
                INSERT INTO banned_emails (email, banned_until, reason)
                VALUES (LOWER(%s), NOW() + INTERVAL '2 months', '3+ account deletions in 60 days')
                ON CONFLICT (email) DO UPDATE SET banned_until = NOW() + INTERVAL '2 months'
            """,
                (email,),
            )
            print(f"[Ban] {email} banned for 2 months")
    except Exception as e:
        print(f"[RecordDeletion] Error: {e}")


# ══════════════════════════════════════════════════════════════════════════════
#  STREAK SYSTEM
# ══════════════════════════════════════════════════════════════════════════════


def update_streak(user_id):
    """
    Called whenever a user marks something as done.
    - If last_study_date is today → no change (already counted)
    - If last_study_date is yesterday → increment streak
    - If last_study_date is 2+ days ago → reset streak to 1
    - If never studied before → set streak to 1
    """
    try:
        from datetime import date

        today = date.today()
        yesterday = today - timedelta(days=1)

        user = db_execute(
            "SELECT streak, last_study_date FROM users WHERE id=%s",
            (user_id,),
            fetch="one",
        )
        if not user:
            return

        last = user.get("last_study_date")
        current_streak = int(user.get("streak") or 0)

        # Already studied today — no update needed
        if last and str(last) == str(today):
            return

        if last and str(last) == str(yesterday):
            # Studied yesterday → extend streak
            new_streak = current_streak + 1
        else:
            # Missed a day or first time → start fresh
            new_streak = 1

        db_execute(
            "UPDATE users SET streak=%s, last_study_date=%s WHERE id=%s",
            (new_streak, today, user_id),
        )
        invalidate_user_cache(user_id)
    except Exception as e:
        print(f"[Streak] Error: {e}")


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


# ── Simple in-memory cache ────────────────────────────────────────────────────
class SimpleCache:
    """Cache values in memory with a TTL (time-to-live) in seconds."""

    def __init__(self):
        self._store = {}
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            item = self._store.get(key)
            if item and datetime.now() < item["expires"]:
                return item["value"]
            if item:
                del self._store[key]
            return None

    def set(self, key, value, ttl_seconds=30):
        with self._lock:
            self._store[key] = {
                "value": value,
                "expires": datetime.now() + timedelta(seconds=ttl_seconds),
            }

    def delete(self, key):
        with self._lock:
            self._store.pop(key, None)

    def delete_prefix(self, prefix):
        """Delete all keys starting with a prefix."""
        with self._lock:
            keys = [k for k in self._store if k.startswith(prefix)]
            for k in keys:
                del self._store[k]


cache = SimpleCache()


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
    key = f"user:{user_id}"
    cached = cache.get(key)
    if cached is not None:
        return cached
    user = db_execute("SELECT * FROM users WHERE id=%s", (user_id,), fetch="one")
    if user:
        cache.set(key, user, ttl_seconds=10)
    return user


def invalidate_user_cache(user_id):
    cache.delete(f"user:{user_id}")


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
        "is_pro": bool(u.get("is_pro", True)),
        "plan": u.get("plan", "trial"),
        "plan_expires": str(u.get("plan_expires", ""))
        if u.get("plan_expires")
        else None,
        "pro_since": str(u.get("pro_since", "")),
        "streak": int(u.get("streak") or 0),
        "last_study_date": str(u.get("last_study_date", ""))
        if u.get("last_study_date")
        else None,
        "created_at": str(u.get("created_at", "")),
        "user_type": u.get("user_type") or "board_exam",
        "profession": u.get("profession"),
    }


def get_subjects_for_user(user_id):
    """
    Load all subjects/subsections/topics in 3 queries total instead of
    1 + N + N*M queries. Much faster for users with many subjects.
    """
    # Query 1 — all subjects
    subjects = (
        db_execute(
            "SELECT * FROM subjects WHERE user_id=%s ORDER BY position, created_at",
            (user_id,),
            fetch="all",
        )
        or []
    )
    if not subjects:
        return []

    subject_ids = [s["id"] for s in subjects]

    # Query 2 — all subsections for these subjects in one go
    placeholders = ",".join(["%s"] * len(subject_ids))
    all_subsections = (
        db_execute(
            f"SELECT * FROM subsections WHERE subject_id IN ({placeholders}) ORDER BY position, created_at",
            subject_ids,
            fetch="all",
        )
        or []
    )

    subsection_ids = [ss["id"] for ss in all_subsections]

    # Query 3 — all topics for these subsections in one go
    all_topics = []
    if subsection_ids:
        ph2 = ",".join(["%s"] * len(subsection_ids))
        all_topics = (
            db_execute(
                f"SELECT * FROM topics WHERE subsection_id IN ({ph2}) ORDER BY position, created_at",
                subsection_ids,
                fetch="all",
            )
            or []
        )

    # Group topics by subsection_id
    topics_by_ss = {}
    for t in all_topics:
        t["done"] = bool(t["done"])
        t["note"] = t.get("note") or ""
        t["created_at"] = str(t["created_at"])
        topics_by_ss.setdefault(t["subsection_id"], []).append(t)

    # Group subsections by subject_id
    ss_by_subject = {}
    for ss in all_subsections:
        ss["done"] = bool(ss["done"])
        ss["created_at"] = str(ss["created_at"])
        ss["topics"] = topics_by_ss.get(ss["id"], [])
        ss_by_subject.setdefault(ss["subject_id"], []).append(ss)

    # Assemble final structure
    for s in subjects:
        s["subsections"] = ss_by_subject.get(s["id"], [])
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
        "INSERT INTO users (id, username, display_name, email, password_hash, plan, plan_expires) VALUES (%s,%s,%s,%s,%s,'trial', NOW() + INTERVAL '7 days')",
        (
            uid,
            pending["username"],
            pending["display_name"],
            email,
            pending["password_hash"],
        ),
    )
    del pending_verifications[email]
    invalidate_profiles_cache()
    user = get_user_by_id(uid)
    session["user_id"] = uid
    return jsonify(safe_user(user)), 201


@app.route("/api/auth/login", methods=["POST"])
@rate_limit(10, 300, "login")
def login():
    # Auto-pause expired plans on every login attempt
    check_and_pause_expired_plans()

    body = request.json or {}
    identifier = (body.get("identifier") or body.get("username") or "").strip()
    password = (body.get("password") or "").strip()
    if not identifier or not password:
        return jsonify({"error": "Please enter your username/email and password."}), 400
    # Try username first, then email
    user = get_user_by_username(identifier)
    if not user:
        user = db_execute(
            "SELECT * FROM users WHERE LOWER(email)=LOWER(%s)",
            (identifier,),
            fetch="one",
        )
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Incorrect username/email or password."}), 401
    if user.get("is_paused"):
        session["user_id"] = user["id"]  # allow checkout API calls from paused view
        return jsonify({"error": "paused", "user": safe_user(user)}), 403
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


@app.route("/api/auth/me-full", methods=["GET"])
def me_full():
    """Return user + subjects + notes in ONE request — eliminates 2 round trips."""
    if "user_id" not in session:
        return jsonify({"error": "Not logged in"}), 401
    uid = session["user_id"]
    user = get_user_by_id(uid)
    if not user:
        session.clear()
        return jsonify({"error": "User not found"}), 404
    if user.get("is_paused"):
        session.clear()
        return jsonify({
            "error": "Your account has been paused. Please contact the admin."
        }), 403
    subjects = get_subjects_for_user(uid)
    notes = (
        db_execute(
            "SELECT * FROM notes WHERE user_id=%s ORDER BY created_at DESC",
            (uid,),
            fetch="all",
        )
        or []
    )
    for n in notes:
        n["done"] = bool(n["done"])
        n["created_at"] = str(n["created_at"])
        n["updated_at"] = str(n["updated_at"])
    return jsonify({"user": safe_user(user), "subjects": subjects, "notes": notes})


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
    invalidate_user_cache(pending["user_id"])
    del pending_resets[email]
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  PROFILES  (public)
# ══════════════════════════════════════════════════════════════════════════════


def invalidate_profiles_cache():
    """Call this whenever any user's data changes."""
    cache.delete("profiles_list")


@app.route("/api/profiles", methods=["GET"])
def list_profiles():
    # Serve from cache if fresh — landing page doesn't need real-time data
    cached = cache.get("profiles_list")
    if cached is not None:
        return jsonify(cached)
    try:
        # One query for all users
        users = db_execute("SELECT * FROM users ORDER BY created_at", fetch="all") or []
        if not users:
            return jsonify([])

        # One query for all subject counts
        subject_counts = (
            db_execute(
                """
            SELECT user_id, COUNT(*) as c
            FROM subjects GROUP BY user_id
        """,
                fetch="all",
            )
            or []
        )
        sc_map = {r["user_id"]: int(r["c"]) for r in subject_counts}

        # One query for all topic progress
        topic_progress = (
            db_execute(
                """
            SELECT s.user_id,
                   COUNT(t.id) as total,
                   SUM(CASE WHEN t.done THEN 1 ELSE 0 END) as done
            FROM subjects s
            LEFT JOIN subsections ss ON ss.subject_id = s.id
            LEFT JOIN topics t ON t.subsection_id = ss.id
            GROUP BY s.user_id
        """,
                fetch="all",
            )
            or []
        )
        tp_map = {
            r["user_id"]: (int(r["total"] or 0), int(r["done"] or 0))
            for r in topic_progress
        }

        # One query for subsection-only progress (no topics)
        ss_progress = (
            db_execute(
                """
            SELECT ss.user_id,
                   COUNT(ss.id) as cnt,
                   SUM(CASE WHEN ss.done THEN 1 ELSE 0 END) as done_cnt
            FROM subsections ss
            WHERE NOT EXISTS (SELECT 1 FROM topics t WHERE t.subsection_id=ss.id)
            GROUP BY ss.user_id
        """,
                fetch="all",
            )
            or []
        )
        ssp_map = {
            r["user_id"]: (int(r["cnt"] or 0), int(r["done_cnt"] or 0))
            for r in ss_progress
        }

        profiles = []
        for u in users:
            uid = u["id"]
            t_total, t_done = tp_map.get(uid, (0, 0))
            s_cnt, s_done = ssp_map.get(uid, (0, 0))
            total = t_total + s_cnt
            done = t_done + s_done
            pct = 0 if total == 0 else round((done / total) * 100)
            profiles.append({
                "id": uid,
                "username": u["username"],
                "display_name": u["display_name"],
                "avatar": u.get("avatar"),
                "subject_count": sc_map.get(uid, 0),
                "progress_pct": pct,
                "created_at": str(u["created_at"]),
            })
        cache.set("profiles_list", profiles, ttl_seconds=30)
        return jsonify(profiles)
    except Exception as e:
        print(f"[DB ERROR] list_profiles: {e}")
        return jsonify({
            "error": "Could not load profiles. Please refresh the page."
        }), 500


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


@app.route("/api/profiles/<user_id>/setup-profile", methods=["POST"])
@owner_required
def setup_profile(user_id):
    body = request.json or {}
    user_type = (body.get("user_type") or "board_exam").strip()
    profession = (body.get("profession") or "").strip() or None
    password = body.get("password", "")
    replace_subjects = bool(body.get("replace_subjects", False))

    # Check if user already has subjects (existing user flow)
    row = db_execute(
        "SELECT COUNT(*) as c FROM subjects WHERE user_id=%s", (user_id,), fetch="one"
    )
    existing_count = row["c"] if row else 0

    # Always require password when a password is submitted (profile modal)
    # Skip only for fresh registrations (0 subjects, no password sent)
    if password:
        user = get_user_by_id(user_id)
        if not user or not check_password_hash(user["password_hash"], password):
            return jsonify({"error": "Incorrect password"}), 403
    elif existing_count > 0:
        # Has subjects but sent no password — reject (registration flow always has 0 subjects)
        return jsonify({
            "error": "Password is required to change your study profile."
        }), 403

    db_execute(
        "UPDATE users SET user_type=%s, profession=%s WHERE id=%s",
        (user_type, profession, user_id),
    )
    invalidate_user_cache(user_id)

    # Replace subjects if requested (user switching learner type)
    if replace_subjects and existing_count > 0:
        db_execute("DELETE FROM subjects WHERE user_id=%s", (user_id,))
        existing_count = 0

    # Seed subjects only if user has none yet
    if existing_count == 0 and profession:
        seed_profession_subjects(user_id, profession)

    user = get_user_by_id(user_id)
    return jsonify(safe_user(user)), 200


@app.route("/api/profiles/<user_id>/settings", methods=["PUT"])
@owner_required
def update_profile(user_id):
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "Not found"}), 404
    body = request.json or {}
    fields = []
    vals = []

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
        fields.append("username=%s")
        vals.append(new_username)

    if "display_name" in body:
        dn = (body["display_name"] or "").strip()
        if dn:
            fields.append("display_name=%s")
            vals.append(dn)

    if "exam_date" in body:
        fields.append("exam_date=%s")
        vals.append(body["exam_date"])

    if "new_password" in body and body["new_password"]:
        if not body.get("current_password"):
            return jsonify({"error": "Current password required"}), 400
        if not check_password_hash(user["password_hash"], body["current_password"]):
            return jsonify({"error": "Current password is wrong"}), 401
        fields.append("password_hash=%s")
        vals.append(generate_password_hash(body["new_password"]))

    # ONE query instead of up to 4 separate ones
    if fields:
        vals.append(user_id)
        db_execute(f"UPDATE users SET {', '.join(fields)} WHERE id=%s", vals)

    invalidate_user_cache(user_id)
    invalidate_profiles_cache()
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
    invalidate_user_cache(user_id)
    invalidate_profiles_cache()
    return jsonify(safe_user(get_user_by_id(user_id)))


@app.route("/api/profiles/<user_id>/avatar", methods=["DELETE"])
@owner_required
def remove_avatar(user_id):
    """Remove profile picture — set avatar to NULL."""
    db_execute("UPDATE users SET avatar=NULL WHERE id=%s", (user_id,))
    invalidate_user_cache(user_id)
    invalidate_profiles_cache()
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
    email = user.get("email", "")
    db_execute("DELETE FROM users WHERE id=%s", (user_id,))
    record_account_deletion(email)
    invalidate_profiles_cache()
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
    invalidate_profiles_cache()
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
        done_val = bool(body["done"])
        if done_val:
            db_execute(
                "UPDATE subsections SET done=%s, done_at=NOW() WHERE id=%s AND user_id=%s",
                (done_val, sub_id, user_id),
            )
        else:
            db_execute(
                "UPDATE subsections SET done=%s, done_at=NULL WHERE id=%s AND user_id=%s",
                (done_val, sub_id, user_id),
            )
        if done_val:
            update_streak(user_id)
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
        "INSERT INTO topics (id, subsection_id, user_id, name, note) VALUES (%s,%s,%s,%s,%s)",
        (tid, sub_id, user_id, name, ""),
    )
    t = db_execute("SELECT * FROM topics WHERE id=%s", (tid,), fetch="one")
    t["done"] = bool(t["done"])
    t["note"] = t.get("note") or ""
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
        done_val = bool(body["done"])
        if done_val:
            db_execute(
                "UPDATE topics SET done=%s, done_at=NOW() WHERE id=%s AND user_id=%s",
                (done_val, topic_id, user_id),
            )
        else:
            db_execute(
                "UPDATE topics SET done=%s, done_at=NULL WHERE id=%s AND user_id=%s",
                (done_val, topic_id, user_id),
            )
        if done_val:
            update_streak(user_id)
    if "note" in body:
        db_execute(
            "UPDATE topics SET note=%s WHERE id=%s AND user_id=%s",
            (body["note"], topic_id, user_id),
        )
    t = db_execute("SELECT * FROM topics WHERE id=%s", (topic_id,), fetch="one")
    if not t:
        return jsonify({"error": "Not found"}), 404
    t["done"] = bool(t["done"])
    t["note"] = t.get("note") or ""
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
    # All data in 5 queries total regardless of user count
    users = (
        db_execute("SELECT * FROM users ORDER BY created_at DESC", fetch="all") or []
    )
    if not users:
        return jsonify([])

    sc_rows = (
        db_execute(
            "SELECT user_id, COUNT(*) as c FROM subjects GROUP BY user_id", fetch="all"
        )
        or []
    )
    sc_map = {r["user_id"]: int(r["c"]) for r in sc_rows}

    nc_rows = (
        db_execute(
            "SELECT user_id, COUNT(*) as c FROM notes GROUP BY user_id", fetch="all"
        )
        or []
    )
    nc_map = {r["user_id"]: int(r["c"]) for r in nc_rows}

    tp_rows = (
        db_execute(
            """
        SELECT s.user_id,
               COUNT(t.id) as total,
               SUM(CASE WHEN t.done THEN 1 ELSE 0 END) as done
        FROM subjects s
        LEFT JOIN subsections ss ON ss.subject_id = s.id
        LEFT JOIN topics t ON t.subsection_id = ss.id
        GROUP BY s.user_id
    """,
            fetch="all",
        )
        or []
    )
    tp_map = {
        r["user_id"]: (int(r["total"] or 0), int(r["done"] or 0)) for r in tp_rows
    }

    ssp_rows = (
        db_execute(
            """
        SELECT ss.user_id,
               COUNT(ss.id) as cnt,
               SUM(CASE WHEN ss.done THEN 1 ELSE 0 END) as done_cnt
        FROM subsections ss
        WHERE NOT EXISTS (SELECT 1 FROM topics t WHERE t.subsection_id=ss.id)
        GROUP BY ss.user_id
    """,
            fetch="all",
        )
        or []
    )
    ssp_map = {
        r["user_id"]: (int(r["cnt"] or 0), int(r["done_cnt"] or 0)) for r in ssp_rows
    }

    result = []
    for u in users:
        uid = u["id"]
        t_total, t_done = tp_map.get(uid, (0, 0))
        s_cnt, s_done = ssp_map.get(uid, (0, 0))
        total = t_total + s_cnt
        done = t_done + s_done
        pct = 0 if total == 0 else round((done / total) * 100)
        result.append({
            "id": uid,
            "username": u["username"],
            "display_name": u["display_name"],
            "email": u.get("email", "—"),
            "avatar": u.get("avatar"),
            "subject_count": sc_map.get(uid, 0),
            "notes_count": nc_map.get(uid, 0),
            "progress_pct": pct,
            "is_paused": bool(u.get("is_paused", False)),
            "is_pro": bool(u.get("is_pro", True)),
            "plan": u.get("plan", "trial"),
            "plan_expires": str(u.get("plan_expires", ""))
            if u.get("plan_expires")
            else None,
            "pro_since": str(u.get("pro_since", "")),
            "created_at": str(u["created_at"]),
            "user_type": u.get("user_type") or "board_exam",
            "profession": u.get("profession"),
        })
    return jsonify(result)


@app.route("/api/admin/analytics", methods=["GET"])
@admin_required
def admin_analytics():
    # Total topics
    total_topics = db_execute("SELECT COUNT(*) as c FROM topics", fetch="one") or {}

    # Total notes
    total_notes = db_execute("SELECT COUNT(*) as c FROM notes", fetch="one") or {}

    # Active users (have at least 1 subject)
    active_users = (
        db_execute(
            """
        SELECT COUNT(DISTINCT user_id) as c FROM subjects
    """,
            fetch="one",
        )
        or {}
    )

    # Drop-off funnel
    total_users = db_execute("SELECT COUNT(*) as c FROM users", fetch="one") or {}

    # Users with 0 subjects (signed up but did nothing)
    no_subjects = (
        db_execute(
            """
        SELECT COUNT(*) as c FROM users u
        WHERE NOT EXISTS (SELECT 1 FROM subjects s WHERE s.user_id = u.id)
    """,
            fetch="one",
        )
        or {}
    )

    # Users with subjects but no sub-subjects
    no_subsections = (
        db_execute(
            """
        SELECT COUNT(DISTINCT s.user_id) as c FROM subjects s
        WHERE NOT EXISTS (SELECT 1 FROM subsections ss WHERE ss.user_id = s.user_id)
    """,
            fetch="one",
        )
        or {}
    )

    # Users with sub-subjects but no topics
    no_topics = (
        db_execute(
            """
        SELECT COUNT(DISTINCT ss.user_id) as c FROM subsections ss
        WHERE NOT EXISTS (SELECT 1 FROM topics t WHERE t.user_id = ss.user_id)
    """,
            fetch="one",
        )
        or {}
    )

    # New users last 7 days grouped by date
    growth = (
        db_execute(
            """
        SELECT DATE(created_at) as day, COUNT(*) as c
        FROM users
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
        ORDER BY day ASC
    """,
            fetch="all",
        )
        or []
    )

    return jsonify({
        "total_topics": int(total_topics.get("c", 0)),
        "total_notes": int(total_notes.get("c", 0)),
        "active_users": int(active_users.get("c", 0)),
        "total_users": int(total_users.get("c", 0)),
        "funnel": {
            "no_subjects": int(no_subjects.get("c", 0)),
            "no_subsections": int(no_subsections.get("c", 0)),
            "no_topics": int(no_topics.get("c", 0)),
        },
        "growth": [{"day": str(r["day"]), "count": int(r["c"])} for r in growth],
    })


@app.route("/api/admin/users/<user_id>/pause", methods=["POST"])
@admin_required
def admin_pause_user(user_id):
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    # Toggle pause state
    new_state = not bool(user.get("is_paused", False))
    db_execute("UPDATE users SET is_paused=%s WHERE id=%s", (new_state, user_id))
    invalidate_user_cache(user_id)
    return jsonify({"ok": True, "is_paused": new_state})


def _apply_plan(user_id, plan):
    """
    Core plan-setting logic shared by admin_set_plan and the PayMongo webhook.
    Returns (msg, True) on success or (error_msg, False) on invalid plan.
    """
    if plan == "pro_4mo":
        db_execute(
            """
            UPDATE users SET is_pro=TRUE, is_paused=FALSE,
            plan='pro', plan_expires=NOW() + INTERVAL '4 months'
            WHERE id=%s
        """,
            (user_id,),
        )
        return "Pro plan set for 4 months ✅", True

    elif plan == "basic_1yr":
        db_execute(
            """
            UPDATE users SET is_pro=TRUE, is_paused=FALSE,
            plan='basic_pro_bonus', plan_expires=NOW() + INTERVAL '1 month'
            WHERE id=%s
        """,
            (user_id,),
        )
        return "Basic (1yr) + 1 month Pro bonus set ✅", True

    elif plan == "basic":
        db_execute(
            """
            UPDATE users SET is_pro=FALSE, is_paused=FALSE,
            plan='basic', plan_expires=NOW() + INTERVAL '1 year'
            WHERE id=%s
        """,
            (user_id,),
        )
        return "Basic plan set for 1 year ✅", True

    elif plan == "revoke":
        db_execute(
            """
            UPDATE users SET is_pro=FALSE, is_paused=FALSE,
            plan='basic', plan_expires=NULL
            WHERE id=%s
        """,
            (user_id,),
        )
        return "Reverted to Basic (no expiry) ✅", True

    elif plan == "pro_bonus":
        db_execute(
            """
            UPDATE users SET is_pro=TRUE, is_paused=FALSE,
            plan='pro_bonus', plan_expires=NOW() + INTERVAL '1 month'
            WHERE id=%s
        """,
            (user_id,),
        )
        return "1 month Pro bonus granted ✅ (pauses after 1 month)", True

    elif plan == "trial":
        db_execute(
            """
            UPDATE users SET is_pro=TRUE, is_paused=FALSE,
            plan='trial', plan_expires=NOW() + INTERVAL '7 days'
            WHERE id=%s
        """,
            (user_id,),
        )
        return "Trial reset for 7 days ✅", True

    else:
        return "Invalid plan", False


@app.route("/api/admin/users/<user_id>/set-plan", methods=["POST"])
@admin_required
def admin_set_plan(user_id):
    """
    Set a user's plan. Plans:
      - 'pro_4mo'    → Pro for 4 months (₱100)
      - 'basic_1yr'  → Basic for 1 year (₱70) + Pro bonus for 1 month
      - 'basic'      → Basic (no expiry, manually managed)
      - 'trial'      → Reset to trial (7 days from now)
      - 'revoke'     → Remove Pro, set Basic immediately
    """
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    body = request.json or {}
    plan = body.get("plan", "")

    msg, ok = _apply_plan(user_id, plan)
    if not ok:
        return jsonify({"error": msg}), 400

    invalidate_user_cache(user_id)
    user = get_user_by_id(user_id)
    return jsonify({
        "ok": True,
        "msg": msg,
        "is_pro": bool(user.get("is_pro")),
        "plan": user.get("plan"),
        "plan_expires": str(user.get("plan_expires", ""))
        if user.get("plan_expires")
        else None,
    })


@app.route("/api/admin/users/<user_id>/toggle-pro", methods=["POST"])
@admin_required
def admin_toggle_pro(user_id):
    """Kept for backward compat — just toggles is_pro"""
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    new_state = not bool(user.get("is_pro", True))
    db_execute("UPDATE users SET is_pro=%s WHERE id=%s", (new_state, user_id))
    invalidate_user_cache(user_id)
    return jsonify({"ok": True, "is_pro": new_state})


# ── PayMongo Payment Routes ────────────────────────────────────────────────


@app.route("/api/payment/create-checkout", methods=["POST"])
def create_checkout():
    """Create a PayMongo checkout session and return the URL."""
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 401
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    if not PAYMONGO_SECRET_KEY:
        return jsonify({"error": "Payment not configured"}), 503

    body = request.json or {}
    plan = body.get("plan", "")

    if plan == "pro_4mo":
        amount = 10000  # ₱100 in centavos
        item_name = "BoardPrep PH — Pro Plan (4 months)"
    elif plan == "basic_1yr":
        amount = 7000  # ₱70 in centavos
        item_name = "BoardPrep PH — Basic Plan (1 year + 1 month Pro bonus)"
    else:
        return jsonify({"error": "Invalid plan"}), 400

    encoded_key = base64.b64encode(f"{PAYMONGO_SECRET_KEY}:".encode()).decode()

    try:
        resp = http_requests.post(
            f"{PAYMONGO_API}/checkout_sessions",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Basic {encoded_key}",
            },
            json={
                "data": {
                    "attributes": {
                        "line_items": [
                            {
                                "currency": "PHP",
                                "amount": amount,
                                "name": item_name,
                                "quantity": 1,
                            }
                        ],
                        "payment_method_types": ["gcash", "paymaya", "card", "dob"],
                        "success_url": "https://boardprepph.com/?payment=success",
                        "cancel_url": "https://boardprepph.com/?payment=cancel",
                        "metadata": {
                            "user_id": user_id,
                            "plan": plan,
                        },
                        "description": item_name,
                    }
                }
            },
            timeout=15,
        )
        data = resp.json()
        if not resp.ok:
            err = data.get("errors", [{}])[0].get("detail", "PayMongo error")
            return jsonify({"error": err}), 502
        checkout_url = data["data"]["attributes"]["checkout_url"]
        return jsonify({"checkout_url": checkout_url})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/payment/webhook", methods=["POST"])
def payment_webhook():
    """Receive PayMongo webhook events and auto-upgrade the user's plan."""
    raw_body = request.get_data()
    sig_header = request.headers.get("Paymongo-Signature", "")

    # Verify webhook signature
    if PAYMONGO_WEBHOOK_SECRET and sig_header:
        try:
            # PayMongo signature: t=timestamp,te=hash,li=hash
            parts = dict(p.split("=", 1) for p in sig_header.split(",") if "=" in p)
            timestamp = parts.get("t", "")
            provided_sig = parts.get("te", "")
            message = f"{timestamp}.{raw_body.decode('utf-8')}"
            expected = hmac.new(
                PAYMONGO_WEBHOOK_SECRET.encode(),
                message.encode(),
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(expected, provided_sig):
                return jsonify({"error": "Invalid signature"}), 400
        except Exception:
            return jsonify({"error": "Signature verification failed"}), 400

    try:
        payload = request.get_json(force=True) or {}
        event_type = payload.get("data", {}).get("attributes", {}).get("type", "")

        if event_type != "checkout_session.payment.paid":
            return jsonify({"received": True})

        # Extract metadata from the checkout session
        cs_data = payload["data"]["attributes"].get("data", {})
        meta = cs_data.get("attributes", {}).get("metadata", {})
        user_id = meta.get("user_id")
        plan = meta.get("plan")
        payment_id = payload["data"].get("id", "")
        amount_paid = cs_data.get("attributes", {}).get("amount", 0)

        if not user_id or not plan:
            return jsonify({"error": "Missing metadata"}), 400

        user = get_user_by_id(user_id)
        if not user:
            return jsonify({"error": "User not found"}), 404

        # Apply the plan (same logic as admin buttons)
        msg, ok = _apply_plan(user_id, plan)
        if not ok:
            return jsonify({"error": msg}), 400

        # Update last_paid_at on users table
        db_execute(
            "UPDATE users SET last_paid_at=NOW() WHERE id=%s",
            (user_id,),
        )

        # Record in payments table
        db_execute(
            """
            INSERT INTO payments (id, user_id, plan, amount, status, created_at)
            VALUES (%s, %s, %s, %s, 'paid', NOW())
            ON CONFLICT (id) DO NOTHING
            """,
            (payment_id or f"pm_{user_id}_{plan}", user_id, plan, amount_paid),
        )

        invalidate_user_cache(user_id)

        # Send confirmation email
        plan_label = (
            "Pro Plan (4 months)"
            if plan == "pro_4mo"
            else "Basic Plan (1 year + 1 month Pro bonus)"
        )
        amount_display = f"₱{amount_paid // 100}" if amount_paid else "—"
        email_html = f"""
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;
                    background:#0d1117;color:#e8edf5;border-radius:12px;">
          <div style="text-align:center;margin-bottom:24px;">
            <div style="font-size:2rem">&#128218;</div>
            <h1 style="color:#f5c842;font-size:1.4rem;margin:8px 0">BoardPrep PH</h1>
            <p style="color:#8b97a8;font-size:0.9rem">Payment Confirmed</p>
          </div>
          <p style="color:#e8edf5;font-size:1rem;margin-bottom:16px">
            Hi <strong>{user.get("display_name", "")}</strong>,
          </p>
          <p style="color:#8b97a8;margin-bottom:24px">
            Your payment has been received and your account has been upgraded successfully!
          </p>
          <div style="background:#1e2736;border:2px solid #f5c842;border-radius:12px;
                      padding:20px;text-align:center;margin-bottom:24px;">
            <div style="color:#f5c842;font-size:1.1rem;font-weight:700">{plan_label}</div>
            <div style="color:#8b97a8;font-size:0.9rem;margin-top:4px">Amount paid: {amount_display}</div>
          </div>
          <p style="color:#8b97a8;font-size:0.85rem;text-align:center">
            Log in now to continue studying. Good luck on your board exam! 🎓
          </p>
          <div style="text-align:center;margin-top:20px">
            <a href="https://boardprepph.com" style="background:#f5c842;color:#0d1117;
               padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:0.9rem">
              Go to BoardPrep PH →
            </a>
          </div>
        </div>
        """
        _brevo_send(
            user.get("email", ""), "Payment Confirmed — BoardPrep PH", email_html
        )

        return jsonify({"received": True})
    except Exception as e:
        print(f"[Webhook] Error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/payments", methods=["GET"])
@admin_required
def admin_get_payments():
    """Return last payment date per user (for admin panel display)."""
    rows = (
        db_execute(
            """
        SELECT user_id, MAX(created_at) as last_paid_at, MAX(amount) as last_amount,
               MAX(plan) as last_plan
        FROM payments
        WHERE status = 'paid'
        GROUP BY user_id
        """,
            fetch="all",
        )
        or []
    )
    result = {}
    for r in rows:
        result[r["user_id"]] = {
            "last_paid_at": str(r["last_paid_at"]) if r.get("last_paid_at") else None,
            "last_amount": r.get("last_amount"),
            "last_plan": r.get("last_plan"),
        }
    return jsonify(result)


# ── End PayMongo Routes ────────────────────────────────────────────────────


@app.route("/api/admin/run-migrations", methods=["POST"])
@admin_required
def run_migrations():
    """Manually run any pending DB migrations."""
    results = []
    try:
        db_execute(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0"
        )
        results.append("✅ streak column")
    except Exception as e:
        results.append(f"❌ streak: {e}")
    try:
        db_execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_study_date DATE")
        results.append("✅ last_study_date column")
    except Exception as e:
        results.append(f"❌ last_study_date: {e}")
    return jsonify({"ok": True, "results": results})


@admin_required
def admin_banned_emails():
    bans = (
        db_execute(
            "SELECT email, banned_until, reason, created_at FROM banned_emails WHERE banned_until > NOW() ORDER BY created_at DESC",
            fetch="all",
        )
        or []
    )
    for b in bans:
        b["banned_until"] = str(b["banned_until"])
        b["created_at"] = str(b["created_at"])
    return jsonify(bans)


@app.route("/api/admin/banned-emails/<path:email>", methods=["DELETE"])
@admin_required
def admin_unban_email(email):
    db_execute("DELETE FROM banned_emails WHERE LOWER(email)=LOWER(%s)", (email,))
    return jsonify({"ok": True})


@app.route("/api/admin/users/<user_id>", methods=["DELETE"])
@admin_required
def admin_delete_user(user_id):
    body = request.json or {}
    otp = str(body.get("otp", "")).strip()

    # Verify OTP
    with _delete_otp_lock:
        exp = _delete_otp_store.get(otp)
        if not exp:
            return jsonify({"error": "Invalid OTP. Please request a new one."}), 401
        if datetime.now() > exp:
            _delete_otp_store.clear()
            return jsonify({"error": "OTP has expired. Please request a new one."}), 401
        _delete_otp_store.clear()  # consume OTP — one use only

    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    email = user.get("email", "")
    db_execute("DELETE FROM users WHERE id=%s", (user_id,))
    record_account_deletion(email)
    invalidate_profiles_cache()
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  FLASHCARDS
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/profiles/<user_id>/flashcards", methods=["GET"])
@owner_required
def get_flashcards(user_id):
    subject_id = request.args.get("subject_id")
    subsection_id = request.args.get("subsection_id")
    if subsection_id:
        cards = (
            db_execute(
                "SELECT * FROM flashcards WHERE user_id=%s AND subsection_id=%s ORDER BY created_at",
                (user_id, subsection_id),
                fetch="all",
            )
            or []
        )
    elif subject_id:
        cards = (
            db_execute(
                "SELECT * FROM flashcards WHERE user_id=%s AND subject_id=%s ORDER BY created_at",
                (user_id, subject_id),
                fetch="all",
            )
            or []
        )
    else:
        cards = (
            db_execute(
                "SELECT * FROM flashcards WHERE user_id=%s ORDER BY created_at",
                (user_id,),
                fetch="all",
            )
            or []
        )
    for c in cards:
        c["created_at"] = str(c["created_at"])
        c["subsection_id"] = c.get("subsection_id")
    return jsonify(cards)


@app.route("/api/profiles/<user_id>/flashcards", methods=["POST"])
@owner_required
def add_flashcard(user_id):
    body = request.json or {}
    subject_id = (body.get("subject_id") or "").strip()
    raw_ss = body.get("subsection_id")
    subsection_id = (
        raw_ss.strip() if isinstance(raw_ss, str) and raw_ss.strip() else None
    )
    question = (body.get("question") or "").strip()
    answer = (body.get("answer") or "").strip()
    if not question:
        return jsonify({"error": "Question is required"}), 400
    if not subject_id:
        return jsonify({"error": "Subject is required"}), 400
    fid = str(uuid.uuid4())
    db_execute(
        "INSERT INTO flashcards (id, subject_id, subsection_id, user_id, question, answer) VALUES (%s,%s,%s,%s,%s,%s)",
        (fid, subject_id, subsection_id, user_id, question, answer),
    )
    card = db_execute("SELECT * FROM flashcards WHERE id=%s", (fid,), fetch="one")
    card["created_at"] = str(card["created_at"])
    card["subsection_id"] = card.get("subsection_id")
    return jsonify(card), 201


@app.route("/api/profiles/<user_id>/flashcards/<card_id>", methods=["PUT"])
@owner_required
def update_flashcard(user_id, card_id):
    body = request.json or {}
    if "question" in body:
        db_execute(
            "UPDATE flashcards SET question=%s WHERE id=%s AND user_id=%s",
            (body["question"], card_id, user_id),
        )
    if "answer" in body:
        db_execute(
            "UPDATE flashcards SET answer=%s WHERE id=%s AND user_id=%s",
            (body["answer"], card_id, user_id),
        )
    card = db_execute("SELECT * FROM flashcards WHERE id=%s", (card_id,), fetch="one")
    if not card:
        return jsonify({"error": "Not found"}), 404
    card["created_at"] = str(card["created_at"])
    return jsonify(card)


@app.route("/api/profiles/<user_id>/flashcards/<card_id>", methods=["DELETE"])
@owner_required
def delete_flashcard(user_id, card_id):
    db_execute("DELETE FROM flashcards WHERE id=%s AND user_id=%s", (card_id, user_id))
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  ADMIN — OTP DELETE VERIFICATION
# ══════════════════════════════════════════════════════════════════════════════

ADMIN_EMAIL = "markjosephpbulan@gmail.com"
_delete_otp_store = {}
_delete_otp_lock = threading.Lock()


@app.route("/api/admin/request-delete-otp", methods=["POST"])
@admin_required
def request_delete_otp():
    """Generate a 6-digit OTP and email it to the admin for delete verification."""
    import random as _random

    otp = "".join([str(_random.randint(0, 9)) for _ in range(6)])
    exp = datetime.now() + timedelta(minutes=10)

    with _delete_otp_lock:
        _delete_otp_store.clear()
        _delete_otp_store[otp] = exp

    html = f"""
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem">
            <h2 style="color:#f5c842;margin-bottom:8px">🗑️ Account Deletion OTP</h2>
            <p style="color:#555;margin-bottom:1.5rem">You requested to delete an account on BoardPrep PH Admin.</p>
            <div style="background:#f8f9fa;border:1px solid #dee2e6;border-radius:10px;padding:1.5rem;text-align:center;margin-bottom:1.5rem">
                <div style="font-size:2.5rem;font-weight:800;letter-spacing:0.5rem;color:#f5c842">{otp}</div>
                <div style="color:#888;font-size:0.82rem;margin-top:6px">Valid for 10 minutes · One use only</div>
            </div>
            <p style="color:#888;font-size:0.8rem">If you did not request this, ignore this email. No account has been deleted yet.</p>
        </div>
    """

    ok, err = _brevo_send(ADMIN_EMAIL, f"BoardPrep PH Admin — Delete OTP: {otp}", html)
    if not ok:
        print(f"[Admin OTP] {otp} (email failed: {err})")
        return jsonify({"error": f"Failed to send OTP email: {err}"}), 503

    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
#  PDF → FLASHCARD GENERATION
# ══════════════════════════════════════════════════════════════════════════════

# ── PayMongo Payment Gateway ──
PAYMONGO_SECRET_KEY = os.environ.get("PAYMONGO_SECRET_KEY", "")
PAYMONGO_PUBLIC_KEY = os.environ.get("PAYMONGO_PUBLIC_KEY", "")
PAYMONGO_WEBHOOK_SECRET = os.environ.get("PAYMONGO_WEBHOOK_SECRET", "")
PAYMONGO_API = "https://api.paymongo.com/v1"

# ── Subject Templates ──
SUBJECT_TEMPLATES = {
    "ece": [
        {
            "name": "Mathematics",
            "color": "#4f8ef7",
            "subsections": [
                "Differential Calculus",
                "Integral Calculus",
                "Differential Equation",
                "Advanced Engineering Mathematics for ECE",
                "Engineering Data Analysis",
                "Electromagnetics",
                "Signals, Spectra & Signal Processing",
                "Feedback and Control Systems",
            ],
        },
        {
            "name": "General Engineering and Applied Sciences",
            "color": "#3ecf8e",
            "subsections": [
                "Chemistry for Engineers",
                "Physics for Engineers",
                "Engineering Economics",
                "Engineering Management",
                "Technopreneurship 101",
                "Physics 2",
                "Materials Science and Engineering",
                "Computer Programming",
                "Environment Science and Engineering",
                "ECE Laws, Contracts, Ethics, Standards & Safety",
                "CAD",
            ],
        },
        {
            "name": "Electronics Engineering",
            "color": "#f5c842",
            "subsections": [
                "DC Electrical Circuits",
                "AC Electrical Circuits",
                "Electromagnetics",
                "Electronic Devices and Circuits",
                "Electronic Circuit Analysis and Design",
                "Electronic Systems and Design",
                "Logic Circuits and Switching Theory",
                "Microprocessor & Microcontroller Systems and Design",
                "Feedback and Control Systems",
            ],
        },
        {
            "name": "Electronics Systems and Technologies",
            "color": "#a78bfa",
            "subsections": [
                "Signals, Spectra, Signal Processing",
                "Principles of Communications",
                "Digital Communications",
                "Transmission and Antenna Systems",
                "Electronics 3: Electronic Systems and Design",
                "Data Communications",
            ],
        },
    ],
    "ee": [
        {
            "name": "Mathematics",
            "color": "#f5a742",
            "subsections": [
                "Algebra",
                "Trigonometry",
                "Analytical Geometry",
                "Differential Calculus & Differential Equations",
                "Integral Calculus",
                "Complex Numbers",
                "Probability & Statistics",
                "Matrices",
                "Power Series",
                "Fourier Analysis",
                "Laplace Transforms",
            ],
        },
        {
            "name": "Engineering Sciences and Allied Subjects",
            "color": "#4f8ef7",
            "subsections": [
                "General Chemistry",
                "College Physics",
                "Computer Fundamentals & Programming",
                "Engineering Materials",
                "Engineering Mechanics",
                "Fluid Mechanics",
                "Strength of Materials",
                "Thermodynamics",
                "Electrical Engineering Law",
                "Engineering Economics",
                "Engineering Management",
                "Contracts & Specifications",
                "Code of Professional Ethics",
                "Philippine Electrical Code (Parts 1 & 2)",
            ],
        },
        {
            "name": "Electrical Engineering Professional Subjects",
            "color": "#3ecf8e",
            "subsections": [
                "Electric Circuits",
                "Electronic Theory & Circuits",
                "Energy Conversion",
                "Power Transmission and Distribution",
                "Instrumentation & Measurement",
                "Circuit and Line Protection",
                "Control Systems",
                "Principles of Communication",
                "Electrical Machines",
                "Electrical Equipment, Components & Devices",
                "Electric Systems",
                "Power Plant",
                "Electronic Power Equipment",
                "Illumination",
                "Building Wiring",
            ],
        },
    ],
    "ce": [
        {
            "name": "Mathematics, Surveying & Transportation Engineering",
            "color": "#4f8ef7",
            "subsections": [
                "Algebra",
                "Plane and Spherical Trigonometry",
                "Analytic Geometry",
                "Differential and Integral Calculus",
                "Descriptive and Solid Geometry",
                "Surveying",
                "Transportation and Highway Engineering",
                "Engineering Economy",
                "Physics for Engineers",
                "Engineering Data Analysis",
                "Numerical Methods",
            ],
        },
        {
            "name": "Hydraulics and Geotechnical Engineering",
            "color": "#3ecf8e",
            "subsections": [
                "Fluid Properties",
                "Hydrostatic Pressures",
                "Fluid Flow",
                "Buoyancy and Flotation",
                "Water Supply and Distribution",
                "Seepage and Flow Through Soil",
                "Soil Properties and Classification",
                "Permeability",
                "Stresses in Soil Mass",
                "Soil Strength and Testing",
                "Bearing Capacity",
                "Compaction and Settlement",
                "Lateral Earth Pressures",
                "Slope Stability Analysis",
                "Foundation Engineering",
            ],
        },
        {
            "name": "Structural Engineering and Construction",
            "color": "#f5c842",
            "subsections": [
                "Engineering Mechanics",
                "Strength of Materials",
                "Theory of Structures",
                "Analysis and Design of Reinforced Concrete Structures",
                "Analysis and Design of Steel Structures",
                "Analysis and Design of Timber Structures",
                "Foundation Engineering and Design",
                "Construction Materials, Methods and Management",
            ],
        },
    ],
    "me": [
        {
            "name": "Mathematics, Engineering Economics & Basic Sciences",
            "color": "#a78bfa",
            "subsections": [
                "Algebra",
                "Plane Trigonometry",
                "Analytic Geometry",
                "Differential and Integral Calculus",
                "Differential Equations",
                "Probability and Statistics",
                "Engineering Economics",
                "Mechanical Engineering Law and Ethics",
                "Chemistry",
                "Physics and Modern Physics",
                "Strength of Materials",
                "Thermodynamics",
                "Fluid Mechanics",
            ],
        },
        {
            "name": "Power and Industrial Plant Engineering",
            "color": "#f56565",
            "subsections": [
                "Fuels and Combustion",
                "Thermodynamics",
                "Internal Combustion Engines",
                "Steam Power Plant",
                "Diesel Engine Power Plant",
                "Gas Turbine Power Plant",
                "Combined Cycle Power Plant",
                "Hydro-electric Power Plant",
                "Geothermal Power Plant",
                "Non-conventional Sources of Energy",
                "Heat Transfer",
                "Refrigeration Principles",
                "Psychrometric Properties and Air Conditioning",
                "Fluid Machineries",
                "Piping Systems and Insulation",
                "Industrial Safety and Pollution Control",
            ],
        },
        {
            "name": "Machine Design, Materials and Shop Practices",
            "color": "#3ecf8e",
            "subsections": [
                "Kinematics",
                "Cam and Gear Systems",
                "Stress Analysis",
                "Material Properties and Selection",
                "Tolerances and Fits",
                "Bearings",
                "Transmission Systems (Belts, Chains, Gears)",
                "Fasteners",
                "Springs and Shafts",
                "Brakes and Clutches",
                "Welding and Welded Joints",
                "Manufacturing Processes",
                "Engineering Materials",
            ],
        },
    ],
    "nursing": [
        {
            "name": "Nursing Practice I: Foundations of Nursing",
            "color": "#ec4899",
            "subsections": [
                "Anatomy & Physiology",
                "Microbiology",
                "Basic Nursing Concepts",
                "Nursing Research",
                "Professional Adjustments & Ethics",
            ],
        },
        {
            "name": "Nursing Practice II: Community Health Nursing",
            "color": "#f472b6",
            "subsections": [
                "Community Health Nursing Principles",
                "Epidemiology",
                "Public Health",
                "Health Promotion",
                "Disease Prevention",
                "Communicable Disease Nursing",
            ],
        },
        {
            "name": "Nursing Practice III: Maternal & Child Nursing",
            "color": "#a78bfa",
            "subsections": [
                "Maternal Nursing (Obstetrics)",
                "Pediatric Nursing",
                "Family Centered Care",
                "Growth & Development",
                "Reproductive Health",
            ],
        },
        {
            "name": "Nursing Practice IV: Medical-Surgical & Psychiatric Nursing",
            "color": "#818cf8",
            "subsections": [
                "Adult Health Nursing",
                "Medical-Surgical Conditions",
                "Pathophysiology",
                "Psychiatric & Mental Health Nursing",
                "Psychosocial Alterations",
                "Pharmacology & Therapeutics",
                "Nutrition & Diet Therapy",
            ],
        },
        {
            "name": "Nursing Practice V: Leadership, Management & Trends",
            "color": "#60a5fa",
            "subsections": [
                "Nursing Leadership & Management",
                "Nursing Ethics",
                "Legal & Professional Issues",
                "Trends & Issues in Nursing",
                "Quality Improvement",
                "Delegation & Collaboration",
            ],
        },
    ],
    "pharmacy": [
        {
            "name": "Pharmaceutical Chemistry",
            "color": "#06b6d4",
            "subsections": [
                "Inorganic Pharmaceutical & Medicinal Chemistry",
                "Organic Pharmaceutical & Medicinal Chemistry",
                "Qualitative Pharmaceutical Chemistry",
            ],
        },
        {
            "name": "Pharmacognosy",
            "color": "#0ea5e9",
            "subsections": [
                "Plant Chemistry",
                "Biochemistry",
                "Natural Products",
            ],
        },
        {
            "name": "Practice of Pharmacy",
            "color": "#3b82f6",
            "subsections": [
                "Compounding & Dispensing Pharmacy",
                "Clinical & Hospital Pharmacy",
                "Pharmaceutical Calculations",
                "Patient Counseling",
            ],
        },
        {
            "name": "Pharmacology & Pharmacokinetics",
            "color": "#6366f1",
            "subsections": [
                "Drug Actions & Mechanisms",
                "Pharmacokinetics",
                "Toxicology",
                "Incompatibilities & Adverse Drug Reactions",
            ],
        },
        {
            "name": "Pharmaceutics",
            "color": "#8b5cf6",
            "subsections": [
                "Manufacturing Pharmacy",
                "Pharmaceutical Dosage Forms",
                "Physical Pharmacy",
                "Jurisprudence & Ethics",
                "Regulatory Affairs",
            ],
        },
        {
            "name": "Quality Assurance & Quality Control",
            "color": "#a78bfa",
            "subsections": [
                "Microbiology & Public Health",
                "Qualitative Pharmaceutical Chemistry",
                "Drug Testing with Instrumentation",
                "Pharmaceutical Analysis",
            ],
        },
    ],
    "cpa": [
        {
            "name": "Financial Accounting & Reporting (FAR)",
            "color": "#f59e0b",
            "subsections": [
                "Financial Reporting Framework (PFRS/PAS)",
                "Conceptual Framework",
                "Financial Assets",
                "Non-Financial Assets",
                "Financial Liabilities & Provisions",
                "Shareholders' Equity",
                "Revenue Recognition (PFRS 15)",
                "Financial Statement Presentation",
                "Leases",
            ],
        },
        {
            "name": "Advanced Financial Accounting & Reporting (AFAR)",
            "color": "#f97316",
            "subsections": [
                "Partnership Accounting & Liquidation",
                "Corporate Liquidation",
                "Joint Arrangements (PFRS 11)",
                "Business Combinations (PFRS 3)",
                "Consolidated Financial Statements",
                "Foreign Currency Transactions",
                "Home Office & Branch Accounting",
                "Not-for-Profit Organizations",
                "Government Accounting (GAM)",
            ],
        },
        {
            "name": "Management Advisory Services (MAS)",
            "color": "#eab308",
            "subsections": [
                "Cost Accounting Fundamentals",
                "Costing Methods (Job Order, Process, ABC, Standard)",
                "Variance Analysis",
                "Cost-Volume-Profit Analysis",
                "Budgeting & Planning",
                "Strategic Cost Management (TQM, JIT)",
                "Financial Statement Analysis",
                "Working Capital Management",
                "Capital Structure & Cost of Capital",
                "Capital Budgeting (NPV, IRR, Payback)",
            ],
        },
        {
            "name": "Auditing",
            "color": "#84cc16",
            "subsections": [
                "Fundamentals of Assurance",
                "PSA Planning & Risk Assessment",
                "PSA Audit Evidence",
                "PSA Audit Reporting",
                "Professional Ethics & Independence",
                "Fraud & Irregularities",
                "Working Papers & Documentation",
                "Practical Audit Procedures",
            ],
        },
        {
            "name": "Taxation",
            "color": "#10b981",
            "subsections": [
                "Tax Fundamentals & Administration",
                "Individual Income Taxation",
                "Corporate Income Taxation (RCIT, MCIT)",
                "Gross Income & Deductions",
                "Transfer Taxes (Estate, Donor's)",
                "Value-Added Tax (VAT)",
                "Percentage Taxes",
                "Excise Taxes",
                "Documentary Stamp Tax",
                "Local Taxation",
                "Tax Remedies & Collection",
            ],
        },
        {
            "name": "Regulatory Framework for Business Transactions (RFBT)",
            "color": "#3ecf8e",
            "subsections": [
                "Obligations",
                "Contracts",
                "Law on Sales & Warranties",
                "Credit Transactions",
                "Revised Corporation Code",
                "Partnership Law",
                "Agency",
                "Negotiable Instruments Law",
                "Insurance Code",
                "Other Business Laws",
            ],
        },
    ],
    "architecture": [
        {
            "name": "History, Theory & Practice of Architecture",
            "color": "#8b5cf6",
            "subsections": [
                "History of Architecture (Ancient to Modern)",
                "Architecture in Asia and Pacific",
                "Philippine Architecture & Heritage Conservation",
                "Processes in Architectural Design",
                "Elements of Architecture and Basic Principles of Design",
                "Design Perception and Psychology of Space",
                "Tropical Architecture",
                "Professional Standards and Legal Framework (RA 9266)",
                "Role and Responsibilities of Architects",
            ],
        },
        {
            "name": "Technical Systems",
            "color": "#7c3aed",
            "subsections": [
                "Structural Systems and Principles",
                "Load Analysis and Transfer",
                "Foundations and Ground Support",
                "Steel Construction",
                "Concrete Construction",
                "Wood Construction",
                "Masonry and Membrane Structures",
                "Building Technology & Sustainability",
                "Sanitary and Plumbing Systems",
                "Electrical and Power Systems",
                "Mechanical Systems (HVAC & Fire Protection)",
                "Illumination and Acoustics",
            ],
        },
        {
            "name": "Architectural Design and Site Planning",
            "color": "#a78bfa",
            "subsections": [
                "Design Principles and Aesthetics",
                "Spatial Planning",
                "Building Aesthetics",
                "Aesthetic, Functional & Structural Considerations",
                "Site Analysis and Development",
                "Landscape Design",
                "Ecological Considerations",
                "Site Development Planning",
            ],
        },
    ],
    "mining": [
        {
            "name": "Mining Engineering I",
            "color": "#78716c",
            "subsections": [
                "Mineral Prospecting and Exploration",
                "Mine Planning, Design and Development",
                "Mining Methods (Surface, Underground, Quarrying)",
                "Mine Ventilation, Safety and Health",
                "Rock Mechanics in Mine Engineering",
            ],
        },
        {
            "name": "Mining Engineering II",
            "color": "#57534e",
            "subsections": [
                "Sampling and Ore Reserve Estimation",
                "Mine Economics, Valuation and Feasibility Studies",
                "Computer Applications in Mining",
                "Mine and Mineral Land Surveying",
                "Mining Laws and Ethics",
            ],
        },
        {
            "name": "Mining Engineering III",
            "color": "#a8a29e",
            "subsections": [
                "General Geology",
                "Mineralogy and Petrology",
                "Economic Geology",
                "Structural Geology",
                "Principles of Metallurgy",
                "Mineral Processing and Technology",
                "Assaying",
                "Environmental Concerns and Sustainability in Mining",
            ],
        },
    ],
    "che": [
        {
            "name": "Physical and Chemical Principles",
            "color": "#10b981",
            "subsections": [
                "General Inorganic Chemistry",
                "Organic Chemistry",
                "Analytical Chemistry",
                "Physical Chemistry",
                "Chemical Engineering Thermodynamics",
            ],
        },
        {
            "name": "Chemical Engineering Principles",
            "color": "#059669",
            "subsections": [
                "Chemical Engineering Calculations",
                "Unit Operations and Processes",
                "Plant Design and Process Engineering",
                "Chemical Process Industries",
                "Biochemical Engineering",
                "Instrumentation and Process Control",
                "Environmental Engineering",
            ],
        },
        {
            "name": "General Engineering, Ethics and Contracts",
            "color": "#34d399",
            "subsections": [
                "Mathematics",
                "Physics",
                "Engineering Mechanics",
                "Laws, Contracts, and Ethics",
            ],
        },
    ],
    "ge": [
        {
            "name": "Laws, Rules and Regulations",
            "color": "#3b82f6",
            "subsections": [
                "Public Land Laws",
                "Laws on Property",
                "Laws on Natural Resources",
                "Land Registration Laws",
                "Land Reform Laws",
                "Laws on Obligation and Contracts",
                "Professional and Ethical Practice",
                "Rules and Regulations Governing Land Surveying",
            ],
        },
        {
            "name": "Mathematics",
            "color": "#60a5fa",
            "subsections": [
                "Algebra",
                "Solid Geometry",
                "Analytical Geometry",
                "Plane and Spherical Trigonometry",
                "Differential Calculus",
                "Integral Calculus",
                "Engineering Mechanics",
                "Engineering Economics",
                "Least Squares",
            ],
        },
        {
            "name": "Theory and Practice of Surveying",
            "color": "#2dd4bf",
            "subsections": [
                "Property Surveying",
                "Isolated, Mineral and Mining Surveys",
                "Cadastral Land Surveying",
                "Astronomy",
                "Route Surveys and Earthworks",
                "Hydrographic and Topographic Surveying",
                "Photogrammetry",
                "Engineering and Construction Surveying",
            ],
        },
        {
            "name": "Geodesy",
            "color": "#06b6d4",
            "subsections": [
                "Geodetic Surveying",
                "Geodetic Astronomy",
                "Geodetic Triangulation",
                "Geodetic Leveling",
                "Gravity Measurement",
                "Least Squares Adjustment",
                "Map Projection Formulas",
            ],
        },
        {
            "name": "Cartography",
            "color": "#0ea5e9",
            "subsections": [
                "Plotting and Mapping",
                "Map Projections",
                "Preparation of Survey Plans",
                "GIS Mapping",
                "Photogrammetric Plotting",
                "Unmanned Aerial Systems (UAS) / Drone Mapping",
            ],
        },
    ],
    "cee": [
        {
            "name": "Mathematics",
            "color": "#4f8ef7",
            "subsections": [
                "Arithmetic & Number Sense",
                "Algebra",
                "Linear Equations & Inequalities",
                "Quadratic Equations & Functions",
                "Geometry",
                "Trigonometry",
                "Statistics & Probability",
                "Word Problems & Problem Solving",
            ],
        },
        {
            "name": "English Language Proficiency",
            "color": "#22c55e",
            "subsections": [
                "Vocabulary & Word Meanings",
                "Grammar & Correct Usage",
                "Reading Comprehension",
                "Figures of Speech & Literary Devices",
                "Verbal Analogies",
                "Writing & Composition",
            ],
        },
        {
            "name": "Science",
            "color": "#f59e0b",
            "subsections": [
                "Biology \u2013 Cells & Life Processes",
                "Biology \u2013 Genetics & Evolution",
                "Biology \u2013 Ecology",
                "Chemistry \u2013 Matter & Atoms",
                "Chemistry \u2013 Chemical Reactions",
                "Chemistry \u2013 Acids, Bases & Solutions",
                "Physics \u2013 Motion & Forces",
                "Physics \u2013 Energy & Waves",
                "Physics \u2013 Electricity & Magnetism",
                "Earth Science & Astronomy",
            ],
        },
        {
            "name": "Filipino / Wika at Panitikan",
            "color": "#ef4444",
            "subsections": [
                "Tamang Gamit ng Wika",
                "Bahagi ng Pananalita",
                "Sawikain at Idioma",
                "Tayutay / Pigura ng Pananalita",
                "Pagbabasa at Pag-unawa",
                "Panitikang Pilipino",
            ],
        },
        {
            "name": "Abstract Reasoning & Mental Ability",
            "color": "#8b5cf6",
            "subsections": [
                "Logical Reasoning & Problem Solving",
                "Pattern Recognition",
                "Verbal Analogies",
                "Data Interpretation",
                "Spatial Reasoning & Visualization",
            ],
        },
        {
            "name": "General Knowledge",
            "color": "#06b6d4",
            "subsections": [
                "Philippine History",
                "Philippine Government & Constitution",
                "World History & Geography",
                "Current Events & Contemporary Issues",
                "Philippine Culture, Arts & Literature",
            ],
        },
    ],
}


def seed_profession_subjects(user_id, profession):
    template = SUBJECT_TEMPLATES.get((profession or "").lower())
    if not template:
        return
    # Build all rows first, then bulk-insert in 2 queries (avoids N round trips)
    subject_rows = []
    subsection_rows = []
    for pos, subj in enumerate(template):
        sid = str(uuid.uuid4())
        subject_rows.append((sid, user_id, subj["name"], subj["color"], pos))
        for sspos, ssname in enumerate(subj["subsections"]):
            subsection_rows.append((str(uuid.uuid4()), sid, user_id, ssname, sspos))

    pool = get_pool()
    conn = pool.getconn()
    try:
        conn.autocommit = False
        cur = conn.cursor()
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO subjects (id, user_id, name, color, position) VALUES %s",
            subject_rows,
        )
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO subsections (id, subject_id, user_id, name, position) VALUES %s",
            subsection_rows,
        )
        conn.commit()
        cur.close()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)


# ── Vertex AI Express Mode (bills to GCP $300 credit) ──
VERTEX_AI_EXPRESS_KEY = os.environ.get("VERTEX_AI_EXPRESS_KEY", "")
VERTEX_AI_MODEL = "gemini-2.5-flash-lite"


def _vertex_url():
    return (
        f"https://generativelanguage.googleapis.com/v1beta/models"
        f"/{VERTEX_AI_MODEL}:generateContent?key={VERTEX_AI_EXPRESS_KEY}"
    )


@app.route("/api/profiles/<user_id>/generate-pdf-flashcards", methods=["POST"])
@owner_required
def generate_flashcards_from_pdf(user_id):
    """
    Upload a PDF → extract text → call Gemini → return Q&A pairs.
    PDF is processed entirely in memory and NEVER stored in the database.
    """
    try:
        import re as _re
        import io as _io

        # Pro-only feature check
        user = get_user_by_id(user_id)
        if not user or not user.get("is_pro", True):
            return jsonify({
                "error": "This feature requires a Pro account. Please upgrade to continue."
            }), 403

        if not VERTEX_AI_EXPRESS_KEY:
            return jsonify({
                "error": "AI generation is not configured on this server."
            }), 503

        # ── 1. Validate file upload ───────────────────────────────────────────────
        if "pdf" not in request.files:
            return jsonify({"error": "No PDF file uploaded."}), 400

        pdf_file = request.files["pdf"]
        if not pdf_file.filename or not pdf_file.filename.lower().endswith(".pdf"):
            return jsonify({"error": "Please upload a valid PDF file."}), 400

        raw_bytes = pdf_file.read()
        if len(raw_bytes) == 0:
            return jsonify({"error": "The uploaded PDF is empty."}), 400
        if len(raw_bytes) > 20 * 1024 * 1024:
            return jsonify({"error": "PDF is too large. Maximum size is 20MB."}), 400

        # ── 2. Get request params ─────────────────────────────────────────────────
        max_cards = min(int(request.form.get("max_cards", 10)), 50)
        subject_name = request.form.get("subject_name", "this subject")

        # ── 3. Extract text from PDF ──────────────────────────────────────────────
        pdf_text = None
        pdf_error = None

        def extract_pdf():
            nonlocal pdf_text, pdf_error
            try:
                import pypdf

                reader = pypdf.PdfReader(_io.BytesIO(raw_bytes))
                max_pages = min(len(reader.pages), 8)  # max 8 pages
                texts = []
                for i in range(max_pages):
                    try:
                        t = reader.pages[i].extract_text() or ""
                        if t.strip():
                            texts.append(t)
                    except Exception:
                        continue
                pdf_text = "\n".join(texts).strip()
            except Exception as e:
                pdf_error = str(e)

        import threading as _threading

        t = _threading.Thread(target=extract_pdf, daemon=True)
        t.start()
        t.join(timeout=20)  # 20 second max for PDF extraction

        if t.is_alive():
            return jsonify({
                "error": "PDF extraction timed out. Try a smaller or simpler PDF."
            }), 400
        if pdf_error:
            return jsonify({"error": f"Could not read PDF: {pdf_error[:80]}"}), 400

        if not pdf_text or len(pdf_text) < 50:
            return jsonify({
                "error": "Could not extract readable text. Make sure the PDF is not a scanned image."
            }), 400

        if len(pdf_text) > 3000:
            pdf_text = pdf_text[:3000]

        prompt = (
            f"You are an expert board exam question writer for Filipino professional licensure examinations. "
            f'Your task is to generate {max_cards} high-quality flashcard Q&A pairs from the study material below about "{subject_name}". '
            f"\n\nWHAT TO FOCUS ON:\n"
            f"- Key definitions, terms, and concepts\n"
            f"- Laws, theorems, principles, and formulas\n"
            f"- Classifications, types, and categories\n"
            f"- Important facts that appear in board exams\n"
            f"\nWHAT TO IGNORE:\n"
            f"- Author names, book titles, chapter objectives, page numbers\n"
            f"\nRULES:\n"
            f"- Questions must test actual subject knowledge\n"
            f"- Answers must be direct and factual (1-2 sentences only)\n"
            f"- LANGUAGE: Match the language of the study material exactly. Do NOT translate.\n"
            f"\nOutput ONLY valid JSON:\n"
            f'{{"flashcards":[{{"question":"...","answer":"..."}}]}}\n'
            f"\nStudy material:\n{pdf_text}"
        )

        # ── 4. Call Gemini via Vertex AI ──────────────────────────────────────────
        try:
            resp = http_requests.post(
                _vertex_url(),
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                    "generationConfig": {"maxOutputTokens": 8192, "temperature": 0.4},
                },
                timeout=45,
            )
            if resp.ok:
                data = resp.json()
                raw_text = (
                    data
                    .get("candidates", [{}])[0]
                    .get("content", {})
                    .get("parts", [{}])[0]
                    .get("text", "")
                ).strip()
            else:
                try:
                    err_msg = (
                        resp
                        .json()
                        .get("error", {})
                        .get("message", str(resp.status_code))
                    )
                except Exception:
                    err_msg = str(resp.status_code)
                return jsonify({"error": f"AI service error: {err_msg[:150]}"}), 502
        except Exception as e:
            return jsonify({
                "error": f"AI service timeout. Please try again. ({str(e)[:80]})"
            }), 503

        if not raw_text:
            return jsonify({
                "error": "AI returned an empty response. Please try again."
            }), 500

        # ── 5. Parse response ─────────────────────────────────────────────────────
        try:
            raw_text = _re.sub(r"^```(?:json)?\s*", "", raw_text, flags=_re.MULTILINE)
            raw_text = _re.sub(r"\s*```$", "", raw_text, flags=_re.MULTILINE)
            raw_text = raw_text.strip()
            json_match = _re.search(r"\{.*\}", raw_text, _re.DOTALL)
            if json_match:
                raw_text = json_match.group(0)
            parsed = json.loads(raw_text)
            cards = parsed.get("flashcards", [])
            if not cards or not isinstance(cards, list):
                raise ValueError("No flashcards in response")
            result = []
            for c in cards:
                q = str(c.get("question", "")).strip()
                a = str(c.get("answer", "")).strip()
                if q and a:
                    result.append({"question": q, "answer": a})
            if not result:
                raise ValueError("All cards were empty")
            return jsonify({"flashcards": result, "count": len(result)})
        except Exception as e:
            return jsonify({
                "error": f"Could not parse AI response. Please try again. ({str(e)[:80]})"
            }), 500

    except Exception as e:
        print(f"[PDF Generate CRASH] {type(e).__name__}: {e}")
        return jsonify({"error": f"Server error: {str(e)[:100]}"}), 500


# ══════════════════════════════════════════════════════════════════════════════
#  AI STUDY CHAT
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/profiles/<user_id>/chat-history", methods=["GET"])
@owner_required
def get_chat_history(user_id):
    try:
        messages = (
            db_execute(
                """
            SELECT id, role, content, created_at
            FROM chat_messages
            WHERE user_id=%s
            ORDER BY created_at ASC
            LIMIT 50
        """,
                (user_id,),
                fetch="all",
            )
            or []
        )
        for m in messages:
            m["created_at"] = str(m["created_at"])
        return jsonify(messages)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/profiles/<user_id>/chat", methods=["POST"])
@owner_required
def chat_with_ai(user_id):
    try:
        # Pro-only (not trial)
        user = get_user_by_id(user_id)
        if not user:
            return jsonify({"error": "User not found"}), 404
        if not user.get("is_pro") or user.get("plan") == "trial":
            return jsonify({"error": "pro_required"}), 403

        if not VERTEX_AI_EXPRESS_KEY:
            return jsonify({"error": "AI not configured"}), 503

        body = request.json or {}
        user_message = (body.get("message") or "").strip()
        if not user_message:
            return jsonify({"error": "Message is required"}), 400
        if len(user_message) > 2000:
            return jsonify({"error": "Message too long (max 2000 characters)"}), 400

        # ── Build context from user data ──────────────────────────────────────
        subjects_raw = get_subjects_for_user(user_id)
        total_topics = sum(
            len(ss.get("topics", []))
            for s in subjects_raw
            for ss in s.get("subsections", [])
        )
        done_topics = sum(
            1
            for s in subjects_raw
            for ss in s.get("subsections", [])
            for t in ss.get("topics", [])
            if t.get("done")
        )
        progress_pct = (
            0 if total_topics == 0 else round((done_topics / total_topics) * 100)
        )

        subject_list = []
        for s in subjects_raw:
            ss_names = [ss["name"] for ss in s.get("subsections", [])]
            subject_list.append(
                f"- {s['name']}"
                + (f" (subsections: {', '.join(ss_names)})" if ss_names else "")
            )
        subjects_text = (
            "\n".join(subject_list) if subject_list else "No subjects added yet."
        )

        exam_date_text = ""
        if user.get("exam_date"):
            try:
                from datetime import date

                exam = date.fromisoformat(user["exam_date"])
                days_left = (exam - date.today()).days
                exam_date_text = (
                    f"Board exam date: {user['exam_date']} ({days_left} days away)"
                )
            except Exception:
                exam_date_text = f"Board exam date: {user['exam_date']}"

        system_prompt = f"""You are Tsuki, a friendly and encouraging AI study assistant for BoardPrep PH — a board exam review tracker for Filipino students.

USER PROFILE:
- Name: {user.get("display_name", "reviewer")} (@{user.get("username", "")})
- Study streak: {user.get("streak", 0)} day(s) 🔥
- Overall progress: {progress_pct}% done ({done_topics}/{total_topics} topics)
- {exam_date_text}

SUBJECTS BEING REVIEWED:
{subjects_text}

YOUR ROLE:
- Answer board exam review questions clearly and accurately
- Suggest what to study next based on their subjects and progress
- Motivate the user — especially reference their streak if it's impressive
- Be friendly, warm, and encouraging like a kuya/ate study buddy
- Keep responses concise (3-5 sentences unless a detailed explanation is needed)
- Respond in the SAME LANGUAGE the user uses (Filipino/Tagalog or English)
- Never make up facts — if unsure, say so honestly
- Format with bullet points or numbered lists when listing steps or items

FLASHCARD GENERATION:
- If the user asks you to make/create/generate flashcards OR questions for any subject or topic, you MUST respond ONLY with valid JSON in this exact format — no extra text before or after, no markdown fences:
{{"flashcards": [{{"question": "...", "answer": "..."}}], "subject": "exact subject name", "subsection": "exact subsection name or null", "message": "short friendly message in same language as user"}}
- Maximum 10 flashcards per request
- Questions must test actual knowledge
- Answers must be direct and factual (1-2 sentences max)
- Match subject/subsection name EXACTLY from the user's list above
- If user says "mathematics" and subject is "Mathematics" — use "Mathematics"
- IMPORTANT: Output raw JSON only, starting with {{ and ending with }}"""

        # ── Detect flashcard intent — broader keywords ────────────────────────
        msg_lower = user_message.lower()
        flashcard_keywords = [
            "flashcard",
            "flash card",
            "tanong",
            "questions for",
            "make me",
            "create",
            "generate",
            "gumawa",
            "make a",
            "give me question",
            "give me flashcard",
        ]
        wants_flashcards = any(kw in msg_lower for kw in flashcard_keywords)

        # ── Get recent chat history for context ───────────────────────────────
        # (fetched before clarification check so we can inspect last message)
        history = (
            db_execute(
                """
            SELECT role, content FROM chat_messages
            WHERE user_id=%s
            ORDER BY created_at DESC LIMIT 10
        """,
                (user_id,),
                fetch="all",
            )
            or []
        )
        history.reverse()

        # If the user's last message is a follow-up reply to our clarification prompt
        # (e.g. they typed "Differential Equation" in response to "which subject?"),
        # treat it as a flashcard request even if no flashcard keywords are present
        if not wants_flashcards and history:
            _last_asst = next(
                (h["content"] for h in reversed(history) if h["role"] == "assistant"),
                "",
            )
            if "Which subject or sub-subject should I focus on?" in _last_asst:
                wants_flashcards = True

        # Build Gemini conversation
        contents = []
        for h in history:
            contents.append({
                "role": "user" if h["role"] == "user" else "model",
                "parts": [{"text": h["content"]}],
            })
        contents.append({"role": "user", "parts": [{"text": user_message}]})

        # ── Call Gemini ───────────────────────────────────────────────────────
        if wants_flashcards:
            # Strict JSON-only prompt for flashcard generation
            # Extract how many cards the user wants
            import re as _re2

            num_match = _re2.search(r"\b(\d+)\b", user_message)
            num_cards = min(int(num_match.group(1)), 10) if num_match else 10

            # Clean message — remove filler words before matching
            msg_lower2 = user_message.lower()
            msg_clean = _re2.sub(
                r"\b(subject|sub-subject|subsection|topic|chapter|my|the|for|on|about|please|thank|you|can|make|create|generate|give|me|a|an|some|flashcard[s]?|question[s]?)\b",
                " ",
                msg_lower2,
            ).strip()

            target_subject = subjects_raw[0]["name"] if subjects_raw else "General"
            target_subject_id = subjects_raw[0]["id"] if subjects_raw else ""
            target_ss_name = None
            target_ss_id = None

            def match_score(candidate_name, msg):
                """Score how well candidate_name matches the message. Higher = better."""
                words = [w for w in candidate_name.lower().split() if len(w) >= 2]
                if not words:
                    return 0
                score = sum(1 for w in words if w in msg)
                msg_words = [w for w in msg.split() if len(w) >= 2]
                score += sum(0.5 for w in msg_words if w in candidate_name.lower())
                return score

            # Build negation set — penalize subjects/subsections matching "not X" / "hindi X"
            import re as _re_neg

            _negation_patterns = _re_neg.findall(r"\b(?:not|hindi)\s+(\w+)", msg_clean)
            negated_words = set(w.lower() for w in _negation_patterns)

            def penalized_score(candidate_name, msg):
                base = match_score(candidate_name, msg)
                penalty = sum(2 for w in negated_words if w in candidate_name.lower())
                return base - penalty

            # Always check subsections first — they are more specific
            best_ss_score = 0
            for s in subjects_raw:
                for ss in s.get("subsections", []):
                    score = penalized_score(ss["name"], msg_clean)
                    if score > best_ss_score:
                        best_ss_score = score
                        target_ss_name = ss["name"]
                        target_ss_id = ss["id"]
                        target_subject = s["name"]
                        target_subject_id = s["id"]

            # Only fall back to subject-level if NO subsection matched at all
            if best_ss_score == 0:
                best_s_score = 0
                for s in subjects_raw:
                    score = penalized_score(s["name"], msg_clean)
                    if score > best_s_score:
                        best_s_score = score
                        target_subject = s["name"]
                        target_subject_id = s["id"]
                target_ss_name = None
                target_ss_id = None

                # No subject/subsection recognized — ask for clarification (once only)
                if best_s_score == 0:
                    # If user already got a clarification, do not loop — fall back to first subject
                    _already_clarified = history and any(
                        "Which subject or sub-subject should I focus on?"
                        in (h.get("content") or "")
                        for h in history
                        if h["role"] == "assistant"
                    )
                    if not _already_clarified:
                        options_lines = []
                        for s in subjects_raw:
                            ss_names = [ss["name"] for ss in s.get("subsections", [])]
                            if ss_names:
                                options_lines.append(
                                    f"• {s['name']} — {', '.join(ss_names)}"
                                )
                            else:
                                options_lines.append(f"• {s['name']}")
                        if options_lines:
                            options_text = "\n".join(options_lines)
                            example_hint = (
                                subjects_raw[0]["name"]
                                if subjects_raw
                                else "Mathematics"
                            )
                        else:
                            options_text = "• (no subjects added yet — add some in your tracker first!)"
                            example_hint = "Mathematics"
                        clarification_reply = (
                            "Sure, I'd love to make flashcards for you! "
                            "Which subject or sub-subject should I focus on? Here's what you're studying:\n\n"
                            f"{options_text}\n\n"
                            f'Just tell me which one (e.g. "flashcards for {example_hint}") and I\'ll get right on it! \U0001f60a'
                        )
                        db_execute(
                            "INSERT INTO chat_messages (user_id, role, content) VALUES (%s, 'user', %s)",
                            (user_id, user_message),
                        )
                        db_execute(
                            "INSERT INTO chat_messages (user_id, role, content) VALUES (%s, 'assistant', %s)",
                            (user_id, clarification_reply),
                        )
                        return jsonify({"reply": clarification_reply})
                    # else: fall through — generate with subjects_raw[0] as fallback

            # ── Detect explicit mode — user specified their own content focus ──────
            matched_name_words = set(
                w
                for w in (target_ss_name or target_subject or "").lower().split()
                if len(w) >= 2
            )
            residual_words = [
                w for w in msg_clean.split() if w and w not in matched_name_words
            ]
            explicit_mode = len(residual_words) >= 3

            # ── Build context instruction based on match level and completion status
            context_instruction = ""
            if not explicit_mode:
                if target_ss_id:
                    # Subsection matched — inject topics (incomplete first, then done)
                    topic_names_incomplete = []
                    topic_names_done = []
                    for s in subjects_raw:
                        if s["id"] == target_subject_id:
                            for ss in s.get("subsections", []):
                                if ss["id"] == target_ss_id:
                                    for t in ss.get("topics", []):
                                        if t.get("done"):
                                            topic_names_done.append(t["name"])
                                        else:
                                            topic_names_incomplete.append(t["name"])
                                    break
                            break
                    all_topics = [
                        f"{n} [NOT YET DONE]" for n in topic_names_incomplete
                    ] + [f"{n} [DONE]" for n in topic_names_done]
                    if all_topics:
                        context_instruction = (
                            f"The sub-subject '{target_ss_name}' has these topics "
                            f"(prioritize NOT YET DONE ones): {', '.join(all_topics)}. "
                            f"Generate flashcards covering these topics proportionally, "
                            f"focusing more on the not-yet-done ones."
                        )
                    else:
                        context_instruction = (
                            f"Generate flashcards broadly covering '{target_ss_name}'."
                        )
                else:
                    # Subject matched — inject sub-subjects (incomplete first, then done)
                    ss_incomplete = []
                    ss_done = []
                    for s in subjects_raw:
                        if s["id"] == target_subject_id:
                            for ss in s.get("subsections", []):
                                topics = ss.get("topics", [])
                                all_done = bool(topics) and all(
                                    t.get("done") for t in topics
                                )
                                if all_done:
                                    ss_done.append(ss["name"])
                                else:
                                    ss_incomplete.append(ss["name"])
                            break
                    all_ss = [f"{n} [NOT YET DONE]" for n in ss_incomplete] + [
                        f"{n} [DONE]" for n in ss_done
                    ]
                    if all_ss:
                        context_instruction = (
                            f"The subject '{target_subject}' has these sub-subjects "
                            f"(prioritize NOT YET DONE ones): {', '.join(all_ss)}. "
                            f"Generate flashcards sampling across these sub-subjects, "
                            f"focusing more on the not-yet-done ones."
                        )
                    else:
                        context_instruction = (
                            f"Generate flashcards broadly covering '{target_subject}'."
                        )
            else:
                context_instruction = (
                    f"The user has specified their own content focus in their message. "
                    f"Respect their specification and generate flashcards accordingly "
                    f"within '{target_ss_name or target_subject}'."
                )

            # Language: only Filipino for Filipino-language subjects, always English otherwise
            _filipino_subject_kws = [
                "filipino",
                "pilipino",
                "tagalog",
                "panitikan",
                "komunikasyon",
                "wika",
                "araling",
                "edukasyon",
            ]
            _subject_is_filipino = any(
                kw in (target_ss_name or target_subject or "").lower()
                for kw in _filipino_subject_kws
            )
            fc_lang = "Filipino/Tagalog" if _subject_is_filipino else "English"

            # Difficulty detection from user message
            _hard_kws = [
                "hard",
                "difficult",
                "advanced",
                "challenging",
                "complex",
                "tough",
                "harder",
                "harder",
            ]
            _easy_kws = ["easy", "basic", "simple", "beginner", "introductory"]
            _med_kws = ["medium", "intermediate", "moderate"]
            if any(kw in msg_lower2 for kw in _hard_kws):
                difficulty_instruction = "Difficulty: HARD — use complex, multi-step, application-based, and analysis questions. Avoid simple recall. Require deeper understanding."
            elif any(kw in msg_lower2 for kw in _easy_kws):
                difficulty_instruction = "Difficulty: EASY — use straightforward recall and definition questions."
            elif any(kw in msg_lower2 for kw in _med_kws):
                difficulty_instruction = (
                    "Difficulty: MEDIUM — mix recall and application questions."
                )
            else:
                difficulty_instruction = (
                    "Difficulty: MEDIUM — mix recall and application questions."
                )

            # Formula/equation emphasis detection
            _formula_kws = [
                "formula",
                "formulas",
                "equation",
                "equations",
                "derivation",
                "derive",
                "compute",
                "calculate",
                "solve",
            ]
            if any(kw in msg_lower2 for kw in _formula_kws):
                formula_instruction = "- IMPORTANT: Include questions involving specific formulas and equations. Show the formula in LaTeX in the answer."
            else:
                formula_instruction = ""

            fc_system = f"""You are Tsuki, an expert board exam flashcard generator for BoardPrep PH — a Filipino professional licensure exam review app.

Generate exactly {num_cards} high-quality flashcard Q&A pairs for: "{target_ss_name or target_subject}".

{context_instruction}

Rules:
- LANGUAGE: ALWAYS write in {fc_lang}. Do NOT switch languages. For English: write everything in English only.
- Questions must test real board exam knowledge — definitions, laws, theorems, formulas, problem-solving
- Answers must be direct and factual (1-3 sentences; include the formula or value if applicable)
- {difficulty_instruction}
{formula_instruction}
- For ALL math/physics formulas use LaTeX with $ delimiters: $x^n$, $\\frac{{dy}}{{dx}}$, $\\sin(\\theta)$, $V = IR$, $P = \\frac{{W}}{{t}}$
- Cover diverse topics — do not repeat the same concept

You MUST output ONLY raw JSON starting with {{ and ending with }}. No markdown, no backticks, no explanation.
Required format:
{{"flashcards":[{{"question":"...","answer":"..."}}],"subject":"{target_subject}","subsection":{f'"{target_ss_name}"' if target_ss_name else "null"},"message":"friendly short message to {user.get("display_name", "reviewer")}"}}"""

            resp = http_requests.post(
                _vertex_url(),
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{"role": "user", "parts": [{"text": fc_system}]}],
                    "generationConfig": {"maxOutputTokens": 4096, "temperature": 0.4},
                },
                timeout=30,
            )
        else:
            # Normal chat call
            resp = http_requests.post(
                _vertex_url(),
                headers={"Content-Type": "application/json"},
                json={
                    "system_instruction": {"parts": [{"text": system_prompt}]},
                    "contents": contents,
                    "generationConfig": {"maxOutputTokens": 4096, "temperature": 0.4},
                },
                timeout=30,
            )

        if not resp.ok:
            try:
                err = resp.json().get("error", {}).get("message", str(resp.status_code))
            except Exception:
                err = str(resp.status_code)
            return jsonify({"error": f"AI error: {err[:150]}"}), 502

        data = resp.json()
        ai_reply = (
            data
            .get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        ).strip()

        if not ai_reply:
            return jsonify({"error": "AI returned empty response"}), 500

        # ── Check if response is flashcard JSON — always try ─────────────────
        import re as _re, json as _json

        flashcard_data = None
        # Default save_reply — if it looks like raw JSON, save a placeholder instead
        if ai_reply.strip().startswith("{") and '"flashcards"' in ai_reply:
            save_reply = "✨ Flashcards generated!"
        else:
            save_reply = ai_reply

        try:
            clean = ai_reply.strip()
            # Remove all markdown code fences (```json, ```, etc.)
            clean = _re.sub(r"```(?:json)?\s*", "", clean)
            clean = clean.replace("`", "").strip()
            json_match = _re.search(r"\{.*\}", clean, _re.DOTALL)
            if json_match:
                # Fix ALL invalid JSON backslash sequences before parsing.
                # Covers: LaTeX letter commands (\frac \sin \Omega),
                # LaTeX special chars (\{ \} \, \; \! \|), and anything else invalid.
                def _fix_latex_json(s):
                    def _repl(m):
                        if m.group(1) is not None:
                            return m.group(0)  # valid \uXXXX unicode escape — keep
                        seq = m.group(2)
                        # Valid single-char JSON escapes: " \ / b f n r t u
                        if len(seq) == 1 and seq in '"\\\/bfnrtu':
                            return m.group(0)
                        return "\\\\" + seq  # double-escape everything else

                    # Alt 1: valid \uXXXX  |  Alt 2: letter command or any other char
                    return _re.sub(
                        r'\\(u[0-9a-fA-F]{4})|\\([a-zA-Z]+|[^"\\\s])', _repl, s
                    )

                parsed = _json.loads(_fix_latex_json(json_match.group(0)))
                if "flashcards" in parsed and isinstance(parsed["flashcards"], list):
                    cards = [
                        c
                        for c in parsed["flashcards"]
                        if c.get("question") and c.get("answer")
                    ][:10]
                    if cards:
                        flashcard_data = {
                            "flashcards": cards,
                            "subject": parsed.get("subject", ""),
                            "subsection": parsed.get("subsection"),
                            "message": parsed.get(
                                "message", f"Here are {len(cards)} flashcards!"
                            ),
                        }
                        # Use pre-matched IDs if we already found them
                        if wants_flashcards and target_subject_id:
                            flashcard_data["subject_id"] = target_subject_id
                            flashcard_data["subject_name"] = target_subject
                            if target_ss_id:
                                flashcard_data["subsection_id"] = target_ss_id
                                flashcard_data["subsection_name"] = target_ss_name
                        else:
                            # Try to match from parsed subject name
                            for s in subjects_raw:
                                if (
                                    s["name"].lower()
                                    == flashcard_data["subject"].lower()
                                ):
                                    flashcard_data["subject_id"] = s["id"]
                                    flashcard_data["subject_name"] = s["name"]
                                    if flashcard_data.get("subsection"):
                                        for ss in s.get("subsections", []):
                                            if (
                                                ss["name"].lower()
                                                == (
                                                    flashcard_data["subsection"] or ""
                                                ).lower()
                                            ):
                                                flashcard_data["subsection_id"] = ss[
                                                    "id"
                                                ]
                                                flashcard_data["subsection_name"] = ss[
                                                    "name"
                                                ]
                                                break
                                    break
                            if not flashcard_data.get("subject_id") and subjects_raw:
                                flashcard_data["subject_id"] = subjects_raw[0]["id"]
                                flashcard_data["subject_name"] = subjects_raw[0]["name"]
                        save_reply = flashcard_data["message"]
        except Exception as _fc_err:
            print(f"[Flashcard parse error] {type(_fc_err).__name__}: {_fc_err}")
            flashcard_data = None

        # ── Save both messages to DB ──────────────────────────────────────────
        db_execute(
            "INSERT INTO chat_messages (user_id, role, content) VALUES (%s, 'user', %s)",
            (user_id, user_message),
        )
        db_execute(
            "INSERT INTO chat_messages (user_id, role, content) VALUES (%s, 'assistant', %s)",
            (user_id, save_reply),
        )

        # ── Keep only last 50 messages ────────────────────────────────────────
        db_execute(
            """
            DELETE FROM chat_messages
            WHERE user_id=%s AND id NOT IN (
                SELECT id FROM chat_messages
                WHERE user_id=%s
                ORDER BY created_at DESC LIMIT 50
            )
        """,
            (user_id, user_id),
        )

        if flashcard_data:
            return jsonify({"reply": save_reply, "flashcards": flashcard_data})
        return jsonify({"reply": ai_reply})

    except Exception as e:
        print(f"[Chat Error] {e}")
        return jsonify({"error": f"Server error: {str(e)[:100]}"}), 500


# ══════════════════════════════════════════════════════════════════════════════
#  STUDY ANALYTICS DASHBOARD
# ══════════════════════════════════════════════════════════════════════════════


@app.route("/api/profiles/<user_id>/analytics", methods=["GET"])
@owner_required
def get_analytics(user_id):
    """
    Returns all data needed to render the Study Analytics Dashboard.
    Computes: overall stats, per-subject breakdown, readiness score,
    achievement badges, weekly velocity, heatmap, pace projection.
    """
    from datetime import date as _date

    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "Not found"}), 404

    today = _date.today()

    # ── 1. Overall topic stats ──────────────────────────────────────────────
    topic_stats = (
        db_execute(
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
        or {}
    )
    topics_total = int(topic_stats.get("total") or 0)
    topics_done = int(topic_stats.get("done") or 0)

    # Subsection-only (no topics) stats
    ss_stats = (
        db_execute(
            """
        SELECT COUNT(ss.id) as total,
               SUM(CASE WHEN ss.done THEN 1 ELSE 0 END) as done
        FROM subsections ss
        WHERE ss.user_id = %s
          AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.subsection_id = ss.id)
    """,
            (user_id,),
            fetch="one",
        )
        or {}
    )
    ss_only_total = int(ss_stats.get("total") or 0)
    ss_only_done = int(ss_stats.get("done") or 0)

    grand_total = topics_total + ss_only_total
    grand_done = topics_done + ss_only_done
    overall_pct = round((grand_done / grand_total) * 100) if grand_total > 0 else 0

    # ── 2. Per-subject breakdown ────────────────────────────────────────────
    subjects_raw = (
        db_execute(
            """
        SELECT s.id, s.name, s.color,
               COUNT(t.id)                                      AS topic_total,
               SUM(CASE WHEN t.done THEN 1 ELSE 0 END)         AS topic_done,
               COUNT(DISTINCT ss.id)                            AS ss_total,
               SUM(CASE WHEN ss.done THEN 1 ELSE 0 END)        AS ss_done
        FROM subjects s
        LEFT JOIN subsections ss ON ss.subject_id = s.id
        LEFT JOIN topics t ON t.subsection_id = ss.id
        WHERE s.user_id = %s
        GROUP BY s.id, s.name, s.color
        ORDER BY s.position, s.created_at
    """,
            (user_id,),
            fetch="all",
        )
        or []
    )

    fc_rows = (
        db_execute(
            """
        SELECT subject_id, COUNT(*) as cnt
        FROM flashcards WHERE user_id = %s GROUP BY subject_id
    """,
            (user_id,),
            fetch="all",
        )
        or []
    )
    fc_map = {r["subject_id"]: int(r["cnt"]) for r in fc_rows}

    subject_list = []
    any_subject_100 = False
    for s in subjects_raw:
        t_total = int(s.get("topic_total") or 0)
        t_done = int(s.get("topic_done") or 0)
        ss_t = int(s.get("ss_total") or 0)
        ss_d = int(s.get("ss_done") or 0)
        if t_total > 0:
            pct = round((t_done / t_total) * 100)
        elif ss_t > 0:
            pct = round((ss_d / ss_t) * 100)
        else:
            pct = 0
        if pct >= 100:
            any_subject_100 = True
        subject_list.append({
            "id": s["id"],
            "name": s["name"],
            "color": s["color"] or "#4f8ef7",
            "topics_done": t_done,
            "topics_total": t_total,
            "subsections_done": ss_d,
            "subsections_total": ss_t,
            "flashcards": fc_map.get(s["id"], 0),
            "pct": pct,
        })

    # ── 3. Weekly velocity (last 8 weeks, needs done_at) ───────────────────
    velocity_rows = []
    try:
        velocity_rows = (
            db_execute(
                """
            SELECT DATE_TRUNC('week', done_at) AS week_start, COUNT(*) AS cnt
            FROM topics
            WHERE user_id = %s AND done_at IS NOT NULL
              AND done_at >= NOW() - INTERVAL '8 weeks'
            GROUP BY week_start ORDER BY week_start
        """,
                (user_id,),
                fetch="all",
            )
            or []
        )
    except Exception:
        pass

    velocity_map = {}
    for r in velocity_rows:
        if r.get("week_start"):
            velocity_map[str(r["week_start"])[:10]] = int(r["cnt"])

    velocity_data = []
    velocity_labels = []
    dow = today.weekday()  # 0=Mon … 6=Sun
    for i in range(7, -1, -1):
        wk_start = today - timedelta(days=dow + i * 7)
        velocity_data.append(velocity_map.get(str(wk_start), 0))
        velocity_labels.append(wk_start.strftime("%b %d"))

    # ── 4. Heatmap (last 84 days, needs done_at) ───────────────────────────
    heatmap = {}
    try:
        hm_topic_rows = (
            db_execute(
                """
            SELECT DATE(done_at) AS study_date, COUNT(*) AS cnt
            FROM topics
            WHERE user_id = %s AND done_at IS NOT NULL
              AND done_at >= NOW() - INTERVAL '84 days'
            GROUP BY DATE(done_at)
        """,
                (user_id,),
                fetch="all",
            )
            or []
        )
        hm_ss_rows = (
            db_execute(
                """
            SELECT DATE(done_at) AS study_date, COUNT(*) AS cnt
            FROM subsections
            WHERE user_id = %s AND done_at IS NOT NULL
              AND done_at >= NOW() - INTERVAL '84 days'
              AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.subsection_id = subsections.id)
            GROUP BY DATE(done_at)
        """,
                (user_id,),
                fetch="all",
            )
            or []
        )
        for r in hm_topic_rows:
            if r.get("study_date"):
                heatmap[str(r["study_date"])] = int(r["cnt"])
        for r in hm_ss_rows:
            if r.get("study_date"):
                d = str(r["study_date"])
                heatmap[d] = heatmap.get(d, 0) + int(r["cnt"])
    except Exception:
        pass

    # ── 5. Pace projection ─────────────────────────────────────────────────
    streak = int(user.get("streak") or 0)
    exam_date_str = user.get("exam_date")
    days_to_exam = None
    pace_pct = None
    daily_target = None

    if exam_date_str:
        try:
            exam_dt = datetime.strptime(exam_date_str, "%Y-%m-%d").date()
            days_to_exam = (exam_dt - today).days
            if days_to_exam > 0 and grand_total > 0:
                # Average topics/day over last 14 days
                recent_row = (
                    db_execute(
                        """
                    SELECT COUNT(*) AS cnt FROM topics
                    WHERE user_id = %s AND done_at IS NOT NULL
                      AND done_at >= NOW() - INTERVAL '14 days'
                """,
                        (user_id,),
                        fetch="one",
                    )
                    or {}
                )
                recent_cnt = int(recent_row.get("cnt") or 0)
                avg_daily = recent_cnt / 14.0 if recent_cnt > 0 else 0

                if avg_daily > 0:
                    projected = grand_done + avg_daily * days_to_exam
                    pace_pct = min(round((projected / grand_total) * 100), 100)
                else:
                    # No done_at velocity data yet — show current completion as baseline
                    pace_pct = overall_pct

                remaining = max(grand_total - grand_done, 0)
                daily_target = (
                    max(1, round(remaining / days_to_exam)) if remaining > 0 else 0
                )
        except Exception:
            pass

    # ── 6. Readiness score ─────────────────────────────────────────────────
    completion_f = grand_done / max(grand_total, 1)
    streak_f = min(streak / 30.0, 1.0)
    pace_f = (pace_pct / 100.0) if pace_pct is not None else completion_f
    readiness = round((completion_f * 0.6 + streak_f * 0.2 + pace_f * 0.2) * 100)

    if readiness >= 90:
        readiness_label = "You're ready. Exam? Bring it. 🔥"
        readiness_color = "gold"
    elif readiness >= 71:
        readiness_label = "You're on track! Keep it up."
        readiness_color = "green"
    elif readiness >= 41:
        readiness_label = "Good start. Push harder."
        readiness_color = "yellow"
    else:
        readiness_label = "Let's get moving. Your exam is coming."
        readiness_color = "red"

    # ── 7. Total flashcards ────────────────────────────────────────────────
    fc_total_row = (
        db_execute(
            "SELECT COUNT(*) as cnt FROM flashcards WHERE user_id=%s",
            (user_id,),
            fetch="one",
        )
        or {}
    )
    total_flashcards = int(fc_total_row.get("cnt") or 0)

    # ── 8. Badge helpers (max topics/day, night owl) ───────────────────────
    max_topics_day = 0
    studied_at_night = False
    try:
        mx_row = (
            db_execute(
                """
            SELECT MAX(cnt) AS mx FROM (
                SELECT COUNT(*) AS cnt FROM topics
                WHERE user_id=%s AND done_at IS NOT NULL
                GROUP BY DATE(done_at)
            ) sub
        """,
                (user_id,),
                fetch="one",
            )
            or {}
        )
        max_topics_day = int(mx_row.get("mx") or 0)

        owl_row = (
            db_execute(
                """
            SELECT COUNT(*) AS cnt FROM topics
            WHERE user_id=%s AND done_at IS NOT NULL
              AND EXTRACT(HOUR FROM done_at) >= 22
        """,
                (user_id,),
                fetch="one",
            )
            or {}
        )
        studied_at_night = int(owl_row.get("cnt") or 0) > 0
    except Exception:
        pass

    # ── 9. Achievement badges ──────────────────────────────────────────────
    badges = [
        {
            "id": "first_step",
            "name": "First Step",
            "icon": "👣",
            "desc": "Completed your first topic",
            "earned": grand_done >= 1,
        },
        {
            "id": "getting_started",
            "name": "Getting Started",
            "icon": "🚀",
            "desc": "10 topics completed",
            "earned": grand_done >= 10,
        },
        {
            "id": "streak_3",
            "name": "Streak Starter",
            "icon": "🔥",
            "desc": "3-day study streak",
            "earned": streak >= 3,
        },
        {
            "id": "streak_7",
            "name": "On Fire",
            "icon": "🔥",
            "desc": "7-day study streak",
            "earned": streak >= 7,
        },
        {
            "id": "streak_30",
            "name": "Legendary",
            "icon": "⚡",
            "desc": "30-day study streak",
            "earned": streak >= 30,
        },
        {
            "id": "flashcard_fan",
            "name": "Flashcard Fan",
            "icon": "🎴",
            "desc": "50+ flashcards created",
            "earned": total_flashcards >= 50,
        },
        {
            "id": "subject_master",
            "name": "Subject Master",
            "icon": "🎓",
            "desc": "100% on any subject",
            "earned": any_subject_100,
        },
        {
            "id": "half_way",
            "name": "Half Way Hero",
            "icon": "🏅",
            "desc": "50% overall topics done",
            "earned": overall_pct >= 50,
        },
        {
            "id": "almost_there",
            "name": "Almost There",
            "icon": "🎯",
            "desc": "90% overall done",
            "earned": overall_pct >= 90,
        },
        {
            "id": "champion",
            "name": "Champion",
            "icon": "🏆",
            "desc": "100% overall — incredible!",
            "earned": overall_pct >= 100,
        },
        {
            "id": "speed_studier",
            "name": "Speed Studier",
            "icon": "⚡",
            "desc": "10+ topics in one day",
            "earned": max_topics_day >= 10,
        },
        {
            "id": "night_owl",
            "name": "Night Owl",
            "icon": "🦉",
            "desc": "Studied after 10 PM",
            "earned": studied_at_night,
        },
    ]

    return jsonify({
        "overall": {
            "topics_done": grand_done,
            "topics_total": grand_total,
            "pct": overall_pct,
        },
        "streak": streak,
        "exam_date": exam_date_str,
        "days_to_exam": days_to_exam,
        "readiness": readiness,
        "readiness_label": readiness_label,
        "readiness_color": readiness_color,
        "subjects": subject_list,
        "velocity": {"data": velocity_data, "labels": velocity_labels},
        "heatmap": heatmap,
        "pace_pct": pace_pct,
        "daily_target": daily_target,
        "badges": badges,
        "total_flashcards": total_flashcards,
    })


@app.route("/api/profiles/<user_id>/chat-history", methods=["DELETE"])
@owner_required
def clear_chat_history(user_id):
    try:
        db_execute("DELETE FROM chat_messages WHERE user_id=%s", (user_id,))
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.errorhandler(500)
def internal_error(e):
    print(f"[500 ERROR] {e}")
    return jsonify({"error": f"Internal server error: {str(e)[:100]}"}), 500


@app.errorhandler(404)
def not_found(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory("static", "index.html")


@app.route("/api/config", methods=["GET"])
def get_config():
    # No longer expose the key — return empty for backward compat
    return jsonify({"gemini_key": ""})


@app.route("/api/profiles/<user_id>/daily-motivation", methods=["POST"])
@owner_required
def daily_motivation(user_id):
    """Generate daily motivation via Gemini on the backend — key never exposed."""
    body = request.json or {}
    name = (body.get("name") or "reviewer")[:50]
    subjects = (body.get("subjects") or "")[:200]
    pct = int(body.get("pct") or 0)

    if not VERTEX_AI_EXPRESS_KEY:
        return jsonify({"error": "AI not configured"}), 503

    prompt = (
        f"Write a short motivational message (3-4 sentences, under 70 words) for "
        f"{name}, a Filipino board exam reviewer. Subjects: {subjects}. "
        f"Progress: {pct}% done. Use one natural Tagalog word. "
        f"No bullet points. End with one short powerful sentence."
    )

    try:
        resp = http_requests.post(
            _vertex_url(),
            headers={"Content-Type": "application/json"},
            json={
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"maxOutputTokens": 150, "temperature": 0.9},
            },
            timeout=15,
        )
        if resp.ok:
            data = resp.json()
            candidate = data.get("candidates", [{}])[0]
            part = candidate.get("content", {}).get("parts", [{}])[0]
            message = part.get("text", "").strip()
            if message:
                return jsonify({"message": message})
    except Exception:
        pass

    return jsonify({"error": "fallback"}), 500


@app.route("/sw.js")
def service_worker():
    response = send_from_directory("static", "sw.js")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Content-Type"] = "application/javascript"
    return response


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/admin")
@app.route("/admin/")
def admin_page():
    return send_from_directory("static", "admin.html")


@app.route("/privacy")
def privacy_page():
    return send_from_directory("static", "privacy.html")


@app.route("/static/manifest.json")
def manifest():
    return send_from_directory("static", "manifest.json")


@app.route("/<path:path>")
def catch_all(path):
    # Never serve index.html for admin or api routes
    if path.startswith("admin") or path.startswith("api/"):
        from flask import abort

        abort(404)
    return send_from_directory("static", "index.html")


if __name__ == "__main__":
    app.run(debug=True, port=5000)
