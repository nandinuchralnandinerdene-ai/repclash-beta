"""
Push-Up Elo — signup/login + matchmaking + synchronized 60-second push-up
count-off with chess-style Elo.

V1.3 — player identity & progression: XP, levels, achievements, rank
tiers, peak Elo, weekly/monthly leaderboards, richer profile. Elo remains
the sole competitive rating; XP is a fully separate progression track and
never affects Elo or matchmaking. All V1.1/V1.2 protections (CSRF,
race-condition fixes, anti-cheat, atomic finalize, rematch transaction)
are preserved unchanged.

Run:
    pip install -r requirements.txt
    python app.py
Open http://localhost:5000 in TWO browser tabs (or two devices on the
same network) to simulate two players finding each other. Each needs
its own account (sign up separately).
"""

import os
import sqlite3
import random
import time
from datetime import datetime, timezone
from functools import wraps
from flask import Flask, g, jsonify, render_template, request, session
from werkzeug.exceptions import HTTPException
from werkzeug.security import generate_password_hash, check_password_hash

try:
    from flask_limiter import Limiter
    from flask_limiter.util import get_remote_address
    LIMITER_AVAILABLE = True
except ImportError:
    LIMITER_AVAILABLE = False

DB_PATH = "pushup_elo.db"
STARTING_ELO = 1200
K_FACTOR = 32
MATCH_DURATION_SECONDS = 60

# V1.2: how long the on-screen 3-2-1-GO countdown takes, in whole seconds,
# between the server starting the match (both ready) and the exercise
# window actually beginning. This time is carved out BEFORE
# exercise_starts_at, so it never eats into the 60-second exercise period —
# see try_start_match() below.
READY_COUNTDOWN_SECONDS = 4

# V1.2: how long a match may sit in the 'ready' state before it's cancelled
# (nobody awarded a win/loss — it just never happened). 30s is enough time
# to read the "Opponent found!" screen and tap Ready without being so long
# that a genuinely absent player leaves their opponent waiting a long time.
READY_TIMEOUT_SECONDS = 30

# Extra time allowed past the 60s exercise window before a submission is
# rejected — covers normal network latency for the final submit. Kept small
# on purpose: with V1.2's synchronized start, players no longer need slack
# for "reading the ready screen" (that's now the separate READY phase), so
# this only has to cover genuine round-trip latency.
SUBMIT_GRACE_SECONDS = 15

BOT_USER_ID = 1
BOT_USERNAME = "Bot"
MIN_PASSWORD_LENGTH = 6
MAX_USERNAME_LENGTH = 20
# Anti-cheat: a generous but finite ceiling on push-ups in one 60s match.
# Elite athletes can do ~1/sec; 150 gives huge headroom while still
# rejecting obviously fabricated values (e.g. someone submitting 9999).
MAX_PLAUSIBLE_PUSHUPS_60S = 150
RECENT_RESULT_WINDOW_SECONDS = 120
# How long a pending rematch request stays open before it's considered
# stale and can no longer be accepted.
REMATCH_REQUEST_TIMEOUT_SECONDS = 60

# --- V1.3: XP amounts. XP is a separate progression track from Elo — it
# never influences matchmaking or the Elo calculation, only account level.
XP_MATCH_COMPLETED = 20
XP_WIN = 30
XP_DRAW = 15
XP_LOSS = 10
XP_PERSONAL_BEST = 50

MAX_BIO_LENGTH = 140
AVATAR_COUNT = 8  # predefined avatar ids: 1..AVATAR_COUNT (emoji-based, no uploads)

# ISO 3166-1 alpha-2 codes accepted for the profile "country" field. Stored
# value is always the 2-letter code (e.g. "MN"); names/flags are rendered
# client-side from the matching list in app.js. Pre-V1.5 rows may still hold
# a free-text country name typed by the user — those are left as-is (not
# migrated/cleared) and simply displayed verbatim as a legacy fallback.
VALID_COUNTRY_CODES = {
    "AF", "AL", "DZ", "AD", "AO", "AG", "AR", "AM", "AU", "AT", "AZ", "BS", "BH", "BD", "BB",
    "BY", "BE", "BZ", "BJ", "BT", "BO", "BA", "BW", "BR", "BN", "BG", "BF", "BI", "CV", "KH",
    "CM", "CA", "CF", "TD", "CL", "CN", "CO", "KM", "CG", "CD", "CR", "CI", "HR", "CU", "CY",
    "CZ", "DK", "DJ", "DM", "DO", "EC", "EG", "SV", "GQ", "ER", "EE", "SZ", "ET", "FJ", "FI",
    "FR", "GA", "GM", "GE", "DE", "GH", "GR", "GD", "GT", "GN", "GW", "GY", "HT", "HN", "HK",
    "HU", "IS", "IN", "ID", "IR", "IQ", "IE", "IL", "IT", "JM", "JP", "JO", "KZ", "KE", "KI",
    "KP", "KR", "KW", "KG", "LA", "LV", "LB", "LS", "LR", "LY", "LI", "LT", "LU", "MO", "MG",
    "MW", "MY", "MV", "ML", "MT", "MH", "MR", "MU", "MX", "FM", "MD", "MC", "MN", "ME", "MA",
    "MZ", "MM", "NA", "NR", "NP", "NL", "NZ", "NI", "NE", "NG", "MK", "NO", "OM", "PK", "PW",
    "PS", "PA", "PG", "PY", "PE", "PH", "PL", "PT", "QA", "RO", "RU", "RW", "KN", "LC", "VC",
    "WS", "SM", "ST", "SA", "SN", "RS", "SC", "SL", "SG", "SK", "SI", "SB", "SO", "ZA", "SS",
    "ES", "LK", "SD", "SR", "SE", "CH", "SY", "TW", "TJ", "TZ", "TH", "TL", "TG", "TO", "TT",
    "TN", "TR", "TM", "TV", "UG", "UA", "AE", "GB", "US", "UY", "UZ", "VU", "VA", "VE", "VN",
    "YE", "ZM", "ZW",
}

# --- V1.4: social system constants ---
CHALLENGE_TIMEOUT_SECONDS = 120   # pending challenge auto-expires after this
ONLINE_THRESHOLD_SECONDS = 60     # last_seen within this window = "online"
PLAYER_SEARCH_LIMIT = 20
FRIENDS_ACTIVITY_LIMIT = 20
NOTIFICATIONS_PAGE_SIZE = 30

# Centralized notification types (V1.4 spec: don't hardcode strings everywhere)
NOTIF_FRIEND_REQUEST = "FRIEND_REQUEST"
NOTIF_FRIEND_ACCEPTED = "FRIEND_ACCEPTED"
NOTIF_CHALLENGE_RECEIVED = "CHALLENGE_RECEIVED"
NOTIF_CHALLENGE_ACCEPTED = "CHALLENGE_ACCEPTED"
NOTIF_CHALLENGE_DECLINED = "CHALLENGE_DECLINED"

# Centralized activity event types
ACTIVITY_LEVEL_UP = "LEVEL_UP"
ACTIVITY_ACHIEVEMENT_UNLOCKED = "ACHIEVEMENT_UNLOCKED"
ACTIVITY_PERSONAL_BEST = "PERSONAL_BEST"
ACTIVITY_WIN_STREAK = "WIN_STREAK"
ACTIVITY_RANK_REACHED = "RANK_REACHED"
# Only emit a WIN_STREAK activity at these milestones — avoids spamming the
# feed with an event after every single win.
WIN_STREAK_MILESTONES = {3, 5, 10, 15, 20}

# --- V1.5: RPG constants ---
# IMPORTANT: RPG progression is a COMPLETELY SEPARATE track from both Elo
# (competitive skill) and the existing V1.3 account XP/level (kept as-is
# for backward compatibility — see users.xp/level, untouched by RPG).
# Nothing in this section may ever write to users.elo or users.xp.
RPG_BASE_DAMAGE_PER_REP = 1          # 1 valid push-up rep = 1 base damage point
RPG_XP_PER_MONSTER_DEFEAT = 25
RPG_GOLD_PER_MONSTER_DEFEAT = 10
# DESIGN: RPG is intentionally TIMELESS — there is no encounter duration or
# expiry. A monster fight can span multiple sessions (start today, continue
# tomorrow); it only ends via defeat or the player explicitly leaving (which
# just navigates away — the encounter stays 'active' and resumable, per the
# "Leave Battle" design in the V1.5 correction pass).
#
# RPG_MAX_REPS_PER_HIT is a DIFFERENT thing: an anti-cheat sanity bound on a
# SINGLE /hit request's claimed rep count (matches PvP's
# MAX_PLAUSIBLE_PUSHUPS_60S in value, but is its own constant since it means
# something different here — a per-request cap, not a total-battle limit).
RPG_MAX_REPS_PER_HIT = 150

RPG_RANK_TITLES = [
    (1, "Novice"),
    (5, "Fighter"),
    (10, "Warrior"),
    (20, "Elite"),
    (35, "Master"),
    (50, "Legend"),
]

# Small, high-quality initial roster — difficulty roughly maps to how many
# 60-second encounters an average player needs to defeat it (Slime: 1,
# Dragon: several). Architecture supports adding more later via this list.
RPG_MONSTER_DEFS = [
    ("Slime", "A wobbly blob. Barely a threat.", 15, 1, 15, 5, "🟢"),
    ("Goblin", "Sneaky and quick, but fragile.", 30, 2, 20, 8, "👺"),
    ("Skeleton", "Rattling bones, surprisingly tough.", 50, 3, 30, 12, "💀"),
    ("Orc", "Brutish and heavily armored.", 80, 4, 40, 18, "👹"),
    ("Demon", "A fearsome foe from the depths.", 130, 5, 60, 28, "😈"),
    ("Dragon", "Legendary. Only the strong prevail.", 220, 6, 100, 50, "🐉"),
]


# ---------------------------------------------------------------------------
# V1.3: Level system — one centralized curve used everywhere.
# Level 1 -> 0 XP, Level 2 -> 100, Level 3 -> 250, Level 4 -> 450, ...
# Each level's requirement grows by 50 more than the previous increment
# (increment for reaching level L, L>=2, is 50*L XP).
# ---------------------------------------------------------------------------
def get_xp_for_level(level):
    """Total XP required to REACH `level` (level 1 requires 0)."""
    if level <= 1:
        return 0
    return sum(50 * lvl for lvl in range(2, level + 1))


def get_level_from_xp(xp):
    """Highest level whose XP requirement is met by `xp`."""
    level = 1
    while get_xp_for_level(level + 1) <= xp:
        level += 1
    return level


# ---------------------------------------------------------------------------
# V1.5: RPG level curve — DELIBERATELY SEPARATE from get_xp_for_level/
# get_level_from_xp above (those remain the V1.3 account-progression track).
# RPG progression is slower-growing and designed for long-term play:
# Level 1->0, 2->200, 3->500, 5->1400, 10->5400, 20->20900, 35->62900, 50->127400
# (increment for reaching level L, L>=2, is 100*L XP — steeper than the
# V1.3 curve, since RPG XP is earned much more frequently via monster
# battles than PvP-match XP was, so levels need to cost more to avoid
# the "hit max level instantly" problem the spec explicitly warns against).
def get_rpg_xp_for_level(level):
    if level <= 1:
        return 0
    return sum(100 * lvl for lvl in range(2, level + 1))


def get_rpg_level_from_xp(xp):
    level = 1
    while get_rpg_xp_for_level(level + 1) <= xp:
        level += 1
    return level


def get_rpg_rank_from_level(level):
    """Purely a visual title derived from RPG level — documented thresholds
    in RPG_RANK_TITLES above. Mirrors get_rank_from_elo's "derived, not a
    second hidden rating" design."""
    title = RPG_RANK_TITLES[0][1]
    for threshold, name in RPG_RANK_TITLES:
        if level >= threshold:
            title = name
        else:
            break
    return title


# ---------------------------------------------------------------------------
# V1.3: Rank tiers — purely a visual label derived from Elo. Elo itself
# remains the only real rating; this is not a second hidden rating.
# ---------------------------------------------------------------------------
RANK_TIERS = [
    (0, "Bronze"),
    (1200, "Silver"),
    (1350, "Gold III"),
    (1450, "Gold II"),
    (1550, "Gold I"),
    (1650, "Platinum III"),
    (1750, "Platinum II"),
    (1850, "Platinum I"),
    (1950, "Diamond III"),
    (2050, "Diamond II"),
    (2150, "Diamond I"),
    (2250, "Master"),
    (2400, "Grandmaster"),
]


def get_rank_from_elo(elo):
    rank = RANK_TIERS[0][1]
    for threshold, name in RANK_TIERS:
        if elo >= threshold:
            rank = name
        else:
            break
    return rank


# ---------------------------------------------------------------------------
# V1.3: Achievement definitions — single centralized list. Adding a new
# achievement means adding one row here; init_db() seeds/updates the
# `achievements` table from this list on every startup (idempotent).
# (code, name, description, icon, category, xp_reward)
# ---------------------------------------------------------------------------
ACHIEVEMENT_DEFS = [
    ("FIRST_REP", "First Rep", "Complete your very first push-up.", "☝️", "beginner", 10),
    ("FIRST_MATCH", "First Steps", "Complete your first match.", "🎯", "beginner", 20),
    ("FIRST_WIN", "First Blood", "Win your first match.", "🏆", "beginner", 30),
    ("TEN_MATCHES", "Getting Started", "Complete 10 matches.", "🔟", "beginner", 40),
    ("HUNDRED_PUSHUPS", "Century", "Reach 100 total push-ups.", "💯", "beginner", 30),
    ("TEN_WINS", "Competitor", "Win 10 matches.", "🥇", "competitive", 60),
    ("RIVAL", "Rival", "Defeat the same opponent 3 times.", "😤", "competitive", 50),
    ("FIVE_WIN_STREAK", "On Fire", "Reach a 5-win streak.", "🔥", "competitive", 60),
    ("TEN_WIN_STREAK", "Unstoppable", "Reach a 10-win streak.", "🚀", "competitive", 100),
    ("REACH_SILVER", "Climber", "Reach the Silver rank.", "🥈", "competitive", 40),
    ("REACH_1500", "Rising Star", "Reach 1500 Elo.", "⭐", "competitive", 80),
    ("REACH_1800", "Elite", "Reach 1800 Elo.", "💎", "competitive", 120),
    ("REACH_2000", "Champion", "Reach 2000 Elo.", "👑", "competitive", 200),
    ("PERSONAL_BEST", "Personal Best", "Set a new personal best.", "📈", "performance", 25),
    ("THOUSAND_PUSHUPS", "Iron Body", "Reach 1,000 total push-ups.", "💪", "performance", 80),
    ("FIVE_THOUSAND_PUSHUPS", "Legend", "Reach 5,000 total push-ups.", "🏋️", "performance", 200),
    ("MONSTER_SLAYER", "Monster Slayer", "Defeat your first RPG monster.", "🗡️", "rpg", 20),
    ("GOBLIN_HUNTER", "Goblin Hunter", "Defeat 10 RPG monsters.", "🛡️", "rpg", 60),
    ("DRAGON_SLAYER", "Dragon Slayer", "Defeat the Dragon.", "🐉", "rpg", 150),
    ("RPG_VETERAN", "RPG Veteran", "Reach RPG Level 10.", "🎖️", "rpg", 100),
]

app = Flask(__name__)

# --- Security: SECRET_KEY -------------------------------------------------
_env_secret = os.environ.get("SECRET_KEY")
if _env_secret:
    app.secret_key = _env_secret
else:
    app.secret_key = "dev-only-secret-change-me"
    print(
        "\n⚠️  WARNING: SECRET_KEY environment variable is not set.\n"
        "   Using an insecure default — fine for local testing, but NEVER\n"
        "   deploy this publicly without setting a real SECRET_KEY.\n"
    )

# --- Security: session cookie hardening ------------------------------------
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("FORCE_HTTPS_COOKIES") == "1",
)

# --- Security: rate limiting -----------------------------------------------
if LIMITER_AVAILABLE:
    limiter = Limiter(get_remote_address, app=app, storage_uri="memory://")
else:
    limiter = None
    print(
        "\n⚠️  flask-limiter is not installed — /api/login and /api/signup\n"
        "   will NOT be rate-limited. Run: pip install -r requirements.txt\n"
    )


def rate_limit(rule):
    """No-op decorator if flask-limiter isn't installed, so the app still runs."""
    def decorator(f):
        return limiter.limit(rule)(f) if limiter else f
    return decorator


# --- Security: lightweight CSRF defense ------------------------------------
CSRF_HEADER_NAME = "X-Requested-With"
CSRF_HEADER_VALUE = "PushUpEloClient"


@app.before_request
def check_csrf_header():
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.path.startswith("/api/"):
        if request.headers.get(CSRF_HEADER_NAME) != CSRF_HEADER_VALUE:
            return jsonify(error="missing client header"), 403


# --- Global error handler ---------------------------------------------------
@app.errorhandler(Exception)
def handle_unexpected_error(e):
    if isinstance(e, HTTPException):
        return jsonify(error=e.description), e.code
    if isinstance(e, OverflowError):
        # An ID in the URL was too large to fit SQLite's 64-bit INTEGER —
        # this is bad client input, not a server bug.
        return jsonify(error="invalid id"), 400
    if isinstance(e, sqlite3.OperationalError) and ("locked" in str(e).lower() or "busy" in str(e).lower()):
        # Under heavy concurrent write load, SQLite can exceed our 5s busy
        # timeout even on endpoints that don't use an explicit BEGIN
        # IMMEDIATE retry block (e.g. signup, profile edit). This is
        # transient contention, not a bug — tell the client to retry
        # instead of surfacing it as a raw 500.
        return jsonify(error="server is busy, please try again"), 503
    app.logger.exception("Unhandled error")
    return jsonify(error="Дотоод алдаа гарлаа. Дахин оролдоно уу."), 500


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10.0)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def _table_columns(db, table):
    return {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}


def init_db():
    """Create tables if missing, and safely ADD any new columns a newer
    version needs to an EXISTING database without touching current rows.
    Never drops or recreates tables — existing users/Elo/match history are
    preserved. Safe to call repeatedly (idempotent)."""
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT,
            elo INTEGER NOT NULL DEFAULT 1200,
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            draws INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS queue (
            user_id INTEGER PRIMARY KEY REFERENCES users(id),
            joined_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player1_id INTEGER NOT NULL REFERENCES users(id),
            player2_id INTEGER NOT NULL REFERENCES users(id),
            player1_count INTEGER,
            player2_count INTEGER,
            winner_id INTEGER,
            status TEXT NOT NULL DEFAULT 'in_progress',
            is_bot_match INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rematch_requests (
            original_match_id INTEGER PRIMARY KEY REFERENCES matches(id),
            requester_id INTEGER NOT NULL REFERENCES users(id),
            new_match_id INTEGER REFERENCES matches(id),
            status TEXT NOT NULL DEFAULT 'pending',
            created_at REAL NOT NULL
        );
        """
    )

    # --- V1.1 migration ---
    user_cols = _table_columns(db, "users")
    if "best_pushups" not in user_cols:
        db.execute("ALTER TABLE users ADD COLUMN best_pushups INTEGER NOT NULL DEFAULT 0")
    if "current_streak" not in user_cols:
        db.execute("ALTER TABLE users ADD COLUMN current_streak INTEGER NOT NULL DEFAULT 0")

    match_cols = _table_columns(db, "matches")
    if "started_at" not in match_cols:
        db.execute("ALTER TABLE matches ADD COLUMN started_at REAL")
    if "expires_at" not in match_cols:
        db.execute("ALTER TABLE matches ADD COLUMN expires_at REAL")
    # Backfill NULL started_at/expires_at on any pre-V1.1 rows so old
    # in-progress matches don't crash the new expiry checks.
    db.execute(
        """UPDATE matches SET started_at = ?, expires_at = ?
           WHERE started_at IS NULL""",
        (time.time(), time.time() + MATCH_DURATION_SECONDS + SUBMIT_GRACE_SECONDS),
    )

    # --- V1.2 migration: ready-state columns ---
    # player1_ready / player2_ready: has that player pressed Ready yet?
    # ready_deadline: epoch seconds after which an unREADY-ed match auto-cancels.
    # exercise_starts_at: epoch seconds when the 60s exercise window actually
    #   begins (started_at + READY_COUNTDOWN_SECONDS) — the client's visible
    #   timer counts down from this, NOT from started_at, so the 3-2-1-GO
    #   countdown never eats into the 60 seconds.
    if "player1_ready" not in match_cols:
        db.execute("ALTER TABLE matches ADD COLUMN player1_ready INTEGER NOT NULL DEFAULT 0")
    if "player2_ready" not in match_cols:
        db.execute("ALTER TABLE matches ADD COLUMN player2_ready INTEGER NOT NULL DEFAULT 0")
    if "ready_deadline" not in match_cols:
        db.execute("ALTER TABLE matches ADD COLUMN ready_deadline REAL")
    if "exercise_starts_at" not in match_cols:
        db.execute("ALTER TABLE matches ADD COLUMN exercise_starts_at REAL")
    # Any row that already has started_at set (V1.1-era row, created before
    # the ready-state existed) is, by definition, already past the ready
    # phase — mark both sides ready and backfill exercise_starts_at so V1.2
    # code paths that assume it's set never see NULL for these old rows.
    db.execute(
        """UPDATE matches SET player1_ready = 1, player2_ready = 1,
           exercise_starts_at = started_at
           WHERE started_at IS NOT NULL AND exercise_starts_at IS NULL"""
    )

    # Make sure the bot user exists so bot-matches have a valid FK target.
    row = db.execute("SELECT id, username FROM users WHERE id = ?", (BOT_USER_ID,)).fetchone()
    if row is None:
        db.execute(
            "INSERT INTO users (id, username, elo, created_at) VALUES (?, ?, ?, ?)",
            (BOT_USER_ID, BOT_USERNAME, STARTING_ELO, now_iso()),
        )
    elif row["username"] != BOT_USERNAME:
        print(
            f"\n⚠️  WARNING: user id {BOT_USER_ID} is '{row['username']}', not "
            f"'{BOT_USERNAME}'. Bot matchmaking may not work correctly.\n"
        )

    # --- V1.3 migration ---------------------------------------------------
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS achievements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            icon TEXT NOT NULL,
            category TEXT NOT NULL,
            xp_reward INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS user_achievements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            achievement_id INTEGER NOT NULL REFERENCES achievements(id),
            unlocked_at REAL NOT NULL,
            triggering_match_id INTEGER REFERENCES matches(id),
            UNIQUE(user_id, achievement_id)
        );

        CREATE TABLE IF NOT EXISTS xp_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            amount INTEGER NOT NULL,
            reason TEXT NOT NULL,
            reference_id INTEGER,
            created_at REAL NOT NULL,
            UNIQUE(user_id, reason, reference_id)
        );

        CREATE INDEX IF NOT EXISTS idx_xp_tx_user ON xp_transactions(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_ach_user ON user_achievements(user_id);
        CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
        CREATE INDEX IF NOT EXISTS idx_users_elo ON users(elo);
        CREATE INDEX IF NOT EXISTS idx_users_country_elo ON users(country, elo);
        """
    )

    user_cols_v13 = _table_columns(db, "users")
    total_pushups_is_new = "total_pushups" not in user_cols_v13
    if "xp" not in user_cols_v13:
        db.execute("ALTER TABLE users ADD COLUMN xp INTEGER NOT NULL DEFAULT 0")
    if "peak_elo" not in user_cols_v13:
        db.execute("ALTER TABLE users ADD COLUMN peak_elo INTEGER NOT NULL DEFAULT 1200")
        # Backfill: best available estimate for existing users is their
        # current Elo (we have no historical high-water-mark). Peak Elo
        # only ever increases from here forward, so this is a safe floor.
        db.execute("UPDATE users SET peak_elo = elo WHERE peak_elo < elo")
    if total_pushups_is_new:
        db.execute("ALTER TABLE users ADD COLUMN total_pushups INTEGER NOT NULL DEFAULT 0")
    if "longest_streak" not in user_cols_v13:
        db.execute("ALTER TABLE users ADD COLUMN longest_streak INTEGER NOT NULL DEFAULT 0")
        db.execute("UPDATE users SET longest_streak = current_streak WHERE longest_streak < current_streak")
    if "country" not in user_cols_v13:
        db.execute("ALTER TABLE users ADD COLUMN country TEXT")
    if "bio" not in user_cols_v13:
        db.execute("ALTER TABLE users ADD COLUMN bio TEXT")
    if "avatar_id" not in user_cols_v13:
        db.execute("ALTER TABLE users ADD COLUMN avatar_id INTEGER NOT NULL DEFAULT 1")

    if total_pushups_is_new:
        # One-time backfill: reconstruct each user's lifetime push-up total
        # from their actual completed-match history (accurate, not a guess).
        rows = db.execute(
            """SELECT player1_id AS uid, player1_count AS cnt FROM matches
               WHERE status='completed' AND player1_count IS NOT NULL
               UNION ALL
               SELECT player2_id AS uid, player2_count AS cnt FROM matches
               WHERE status='completed' AND player2_count IS NOT NULL"""
        ).fetchall()
        totals = {}
        for r in rows:
            totals[r["uid"]] = totals.get(r["uid"], 0) + r["cnt"]
        for uid, total in totals.items():
            db.execute("UPDATE users SET total_pushups = ? WHERE id = ?", (total, uid))

    match_cols_v13 = _table_columns(db, "matches")
    for col in ("player1_elo_before", "player1_elo_after", "player2_elo_before", "player2_elo_after"):
        if col not in match_cols_v13:
            db.execute(f"ALTER TABLE matches ADD COLUMN {col} INTEGER")

    # V1.6: display-only LIVE rep counts, separate from the anti-cheat-
    # protected final player1_count/player2_count (which are still
    # single-shot, NULL-gated, and remain the only source of truth for
    # Elo/win-loss). These are freely overwritable while in_progress and
    # exist purely so opponents can see each other's current rep count
    # during the match — never used for scoring.
    match_cols_v16 = _table_columns(db, "matches")
    if "player1_live_count" not in match_cols_v16:
        db.execute("ALTER TABLE matches ADD COLUMN player1_live_count INTEGER")
    if "player2_live_count" not in match_cols_v16:
        db.execute("ALTER TABLE matches ADD COLUMN player2_live_count INTEGER")

    # Seed/update achievement definitions from ACHIEVEMENT_DEFS (idempotent —
    # existing rows are updated in place by code, never duplicated thanks to
    # the UNIQUE(code) constraint).
    for code, name, desc, icon, category, xp_reward in ACHIEVEMENT_DEFS:
        db.execute(
            """INSERT INTO achievements (code, name, description, icon, category, xp_reward)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(code) DO UPDATE SET
                 name=excluded.name, description=excluded.description,
                 icon=excluded.icon, category=excluded.category, xp_reward=excluded.xp_reward""",
            (code, name, desc, icon, category, xp_reward),
        )

    # --- V1.4 migration: social system --------------------------------
    user_cols_v14 = _table_columns(db, "users")
    if "last_seen" not in user_cols_v14:
        db.execute("ALTER TABLE users ADD COLUMN last_seen REAL")

    db.executescript(
        """
        -- Friendship: one canonical row per pair, stored with the smaller
        -- user id first (user_low < user_high) so (A,B) and (B,A) can
        -- never both exist — enforced by the UNIQUE constraint below,
        -- avoiding a duplicate/asymmetric friendship representation.
        CREATE TABLE IF NOT EXISTS friendships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_low INTEGER NOT NULL REFERENCES users(id),
            user_high INTEGER NOT NULL REFERENCES users(id),
            created_at REAL NOT NULL,
            UNIQUE(user_low, user_high)
        );

        CREATE TABLE IF NOT EXISTS friend_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL REFERENCES users(id),
            receiver_id INTEGER NOT NULL REFERENCES users(id),
            status TEXT NOT NULL DEFAULT 'pending',
            created_at REAL NOT NULL,
            responded_at REAL
        );
        -- A partial unique index (SQLite supports WHERE on indexes) means
        -- only ONE row per (sender, receiver) may be 'pending' at a time —
        -- but the sender is free to re-request after a prior request was
        -- declined/cancelled, since THOSE rows don't match the WHERE clause.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_req_pending
            ON friend_requests(sender_id, receiver_id) WHERE status = 'pending';
        CREATE INDEX IF NOT EXISTS idx_friend_req_receiver ON friend_requests(receiver_id, status);
        CREATE INDEX IF NOT EXISTS idx_friend_req_sender ON friend_requests(sender_id, status);

        CREATE TABLE IF NOT EXISTS challenges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            challenger_id INTEGER NOT NULL REFERENCES users(id),
            challenged_id INTEGER NOT NULL REFERENCES users(id),
            status TEXT NOT NULL DEFAULT 'pending',
            created_at REAL NOT NULL,
            responded_at REAL,
            match_id INTEGER REFERENCES matches(id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_pending
            ON challenges(challenger_id, challenged_id) WHERE status = 'pending';
        CREATE INDEX IF NOT EXISTS idx_challenge_challenged ON challenges(challenged_id, status);

        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            type TEXT NOT NULL,
            actor_id INTEGER REFERENCES users(id),
            reference_id INTEGER,
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON notifications(user_id, is_read);

        CREATE TABLE IF NOT EXISTS activity_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            event_type TEXT NOT NULL,
            reference_id INTEGER,
            created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_activity_user_created ON activity_events(user_id, created_at);
        """
    )

    # --- V1.5 migration: RPG foundation --------------------------------
    # rpg_players: ONE ROW PER USER, entirely separate from users.xp/level
    # (the V1.3 account-progression track) and from users.elo (competitive
    # rating). Created lazily on first RPG interaction (see get_or_create_
    # rpg_player) rather than for every existing user here, since most
    # existing users have never touched the RPG — this keeps the migration
    # itself cheap and avoids a full table scan/insert on every startup.
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS rpg_players (
            user_id INTEGER PRIMARY KEY REFERENCES users(id),
            rpg_xp INTEGER NOT NULL DEFAULT 0,
            gold INTEGER NOT NULL DEFAULT 0,
            total_damage INTEGER NOT NULL DEFAULT 0,
            monsters_defeated INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS monsters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            description TEXT NOT NULL,
            max_hp INTEGER NOT NULL,
            difficulty INTEGER NOT NULL,
            xp_reward INTEGER NOT NULL,
            gold_reward INTEGER NOT NULL,
            icon TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1
        );

        -- One encounter = one battle against one monster. Mirrors the
        -- existing PvP `matches` table's state-machine shape on purpose
        -- (ACTIVE -> COMPLETED/FAILED/EXPIRED/CANCELLED) so the same
        -- mental model applies, without reusing the matches table itself
        -- (a monster fight is not a PvP match — different participants,
        -- different reward type, no Elo).
        CREATE TABLE IF NOT EXISTS encounters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            monster_id INTEGER NOT NULL REFERENCES monsters(id),
            monster_hp INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            started_at REAL NOT NULL,
            expires_at REAL NOT NULL,
            completed_at REAL
        );
        CREATE INDEX IF NOT EXISTS idx_encounters_user_status ON encounters(user_id, status);
        -- BUG FIX: enforces at most one ACTIVE encounter per user at the
        -- database level — closes a real race where two near-simultaneous
        -- /start requests could both pass the "no active encounter" check
        -- before either INSERT committed, producing two active encounters
        -- for the same user. Confirmed via barrier-synchronized concurrent
        -- test before this fix (2 of 5 trials reproduced it).
        CREATE UNIQUE INDEX IF NOT EXISTS idx_encounters_one_active
            ON encounters(user_id) WHERE status = 'active';

        -- Reward ledger — same idempotent design as xp_transactions:
        -- UNIQUE(user_id, reason, reference_id) means a given event (e.g.
        -- "defeated encounter #42") can only ever grant its reward once,
        -- regardless of how many times the awarding code path is called
        -- (retry, concurrent request, etc).
        CREATE TABLE IF NOT EXISTS rpg_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            transaction_type TEXT NOT NULL,
            amount INTEGER NOT NULL,
            reason TEXT NOT NULL,
            reference_id INTEGER,
            created_at REAL NOT NULL,
            UNIQUE(user_id, reason, reference_id, transaction_type)
        );
        CREATE INDEX IF NOT EXISTS idx_rpg_tx_user ON rpg_transactions(user_id);
        """
    )

    # Seed/update the initial monster roster (idempotent via UNIQUE(name)).
    for name, desc, max_hp, difficulty, xp_reward, gold_reward, icon in RPG_MONSTER_DEFS:
        db.execute(
            """INSERT INTO monsters (name, description, max_hp, difficulty, xp_reward, gold_reward, icon, active)
               VALUES (?, ?, ?, ?, ?, ?, ?, 1)
               ON CONFLICT(name) DO UPDATE SET
                 description=excluded.description, max_hp=excluded.max_hp,
                 difficulty=excluded.difficulty, xp_reward=excluded.xp_reward,
                 gold_reward=excluded.gold_reward, icon=excluded.icon""",
            (name, desc, max_hp, difficulty, xp_reward, gold_reward, icon),
        )

    db.commit()
    db.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Elo
# ---------------------------------------------------------------------------
def expected_score(rating_a, rating_b):
    return 1 / (1 + 10 ** ((rating_b - rating_a) / 400))


def update_elo(rating_a, rating_b, score_a):
    """score_a: 1 = win, 0.5 = draw, 0 = loss (from player A's perspective)."""
    exp_a = expected_score(rating_a, rating_b)
    new_a = round(rating_a + K_FACTOR * (score_a - exp_a))
    exp_b = expected_score(rating_b, rating_a)
    new_b = round(rating_b + K_FACTOR * ((1 - score_a) - exp_b))
    return new_a, new_b


# ---------------------------------------------------------------------------
# Routes — pages
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            return jsonify(error="not logged in"), 401
        return f(*args, **kwargs)
    return wrapper


# ---------------------------------------------------------------------------
# Routes — API — auth
# ---------------------------------------------------------------------------
@app.route("/api/signup", methods=["POST"])
@rate_limit("5 per minute")
def signup():
    body = request.json or {}
    username = body.get("username", "").strip()
    password = body.get("password", "")

    if not username or not password:
        return jsonify(error="username and password required"), 400
    if len(username) > MAX_USERNAME_LENGTH:
        return jsonify(error=f"username must be at most {MAX_USERNAME_LENGTH} characters"), 400
    if not username.isprintable() or "\n" in username or "\t" in username:
        return jsonify(error="username contains invalid characters"), 400
    if len(password) < MIN_PASSWORD_LENGTH:
        return jsonify(error=f"password must be at least {MIN_PASSWORD_LENGTH} characters"), 400
    if username.lower() == BOT_USERNAME.lower():
        return jsonify(error="that username is reserved"), 400

    db = get_db()
    existing = db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if existing is not None:
        return jsonify(error="username already taken"), 409

    cur = db.execute(
        "INSERT INTO users (username, password_hash, elo, created_at) VALUES (?, ?, ?, ?)",
        (username, generate_password_hash(password), STARTING_ELO, now_iso()),
    )
    db.commit()
    user_id = cur.lastrowid
    session["user_id"] = user_id
    row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return jsonify(user_to_dict(row))


@app.route("/api/login", methods=["POST"])
@rate_limit("5 per minute")
def login():
    body = request.json or {}
    username = body.get("username", "").strip()
    password = body.get("password", "")

    db = get_db()
    row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if row is None or not row["password_hash"] or not check_password_hash(row["password_hash"], password):
        return jsonify(error="invalid username or password"), 401

    session["user_id"] = row["id"]
    return jsonify(user_to_dict(row))


@app.route("/api/logout", methods=["POST"])
def logout():
    session.pop("user_id", None)
    return jsonify(status="logged_out")


@app.route("/api/me")
def me():
    if "user_id" not in session:
        return jsonify(error="not logged in"), 401
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE id = ?", (session["user_id"],)).fetchone()
    if row is None:
        session.pop("user_id", None)
        return jsonify(error="not logged in"), 401
    return jsonify(user_to_dict(row))


# ---------------------------------------------------------------------------
# Routes — API — matchmaking
# ---------------------------------------------------------------------------
@app.route("/api/queue/join", methods=["POST"])
@login_required
def queue_join():
    user_id = session["user_id"]
    db = get_db()

    existing = find_active_match_for_user(db, user_id)
    if existing:
        return jsonify(status="matched", match_id=existing["id"])

    # BUG FIX (V1.1, race condition): BEGIN IMMEDIATE grabs SQLite's write
    # lock right away so two players calling /queue/join at nearly the same
    # instant can't both grab the same waiting opponent.
    try:
        db.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError:
        return jsonify(error="server is busy, please try again"), 503

    try:
        opponent = db.execute(
            "SELECT * FROM queue WHERE user_id != ? ORDER BY joined_at ASC LIMIT 1",
            (user_id,),
        ).fetchone()

        if opponent:
            opponent_id = opponent["user_id"]
            db.execute("DELETE FROM queue WHERE user_id IN (?, ?)", (user_id, opponent_id))
            # V1.2: matches now start in the 'ready' state — NOT
            # 'in_progress'. started_at/expires_at stay NULL until both
            # players press Ready (see try_start_match()); this is the core
            # V1.2 fix — the 60s timer no longer starts at match-creation.
            cur = db.execute(
                """INSERT INTO matches
                   (player1_id, player2_id, status, created_at, ready_deadline)
                   VALUES (?, ?, 'ready', ?, ?)""",
                (user_id, opponent_id, now_iso(), time.time() + READY_TIMEOUT_SECONDS),
            )
            db.commit()
            return jsonify(status="matched", match_id=cur.lastrowid)

        db.execute(
            "INSERT OR REPLACE INTO queue (user_id, joined_at) VALUES (?, ?)",
            (user_id, now_iso()),
        )
        db.commit()
        return jsonify(status="waiting")
    except Exception:
        db.rollback()
        raise


@app.route("/api/queue/status")
@login_required
def queue_status():
    user_id = session["user_id"]
    db = get_db()
    match = find_active_match_for_user(db, user_id)
    if match:
        return jsonify(status="matched", match_id=match["id"])

    still_waiting = db.execute(
        "SELECT 1 FROM queue WHERE user_id = ?", (user_id,)
    ).fetchone()
    return jsonify(status="waiting" if still_waiting else "not_in_queue")


@app.route("/api/queue/leave", methods=["POST"])
@login_required
def queue_leave():
    user_id = session["user_id"]
    db = get_db()
    db.execute("DELETE FROM queue WHERE user_id = ?", (user_id,))
    db.commit()
    return jsonify(status="left")


@app.route("/api/queue/bot-match", methods=["POST"])
@login_required
def bot_match():
    """No human opponent showed up in time — spin up a bot match instead."""
    user_id = session["user_id"]
    db = get_db()

    existing = find_active_match_for_user(db, user_id)
    if existing:
        return jsonify(status="matched", match_id=existing["id"])

    # BUG FIX (race condition): a concurrent /queue/join for this same user
    # (a human opponent matching with them at almost the same instant) could
    # previously interleave with this endpoint's unlocked
    # check-then-delete-then-create sequence — e.g. both operations could
    # each believe they're the one creating this user's match, leaving the
    # user in two matches at once, or the bot-match call could delete the
    # queue entry a human queue_join was about to match against. BEGIN
    # IMMEDIATE serializes this against queue_join's own BEGIN IMMEDIATE
    # (SQLite only lets one writer hold the lock at a time), so whichever
    # request commits first is the one that "wins".
    try:
        db.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError:
        return jsonify(error="server is busy, please try again"), 503

    try:
        # Re-check inside the lock: a concurrent queue_join may have
        # already matched this user with a real human while we were
        # waiting for the write lock.
        existing = find_active_match_for_user(db, user_id)
        if existing:
            db.commit()
            return jsonify(status="matched", match_id=existing["id"])

        db.execute("DELETE FROM queue WHERE user_id = ?", (user_id,))
        match_id = create_bot_match(db, user_id)
        db.commit()
        return jsonify(status="matched", match_id=match_id)
    except Exception:
        db.rollback()
        raise


def determine_bot_target_reps(player_elo):
    """Generates the Bot's ONE authoritative target rep count for a match —
    stored once at creation and used for both the live progression and the
    final score, per the requirement that they never disagree.

    There is no existing Elo-to-performance dataset in this codebase to
    draw from (checked before writing this), so this is a reasoned,
    clearly-approximate model, not one calibrated against real match data:
    STARTING_ELO (1200) is treated as roughly a ~22-rep/60s performance,
    scaling modestly with Elo from there. Expect to tune once real match
    data exists — these are starting values, not sacred constants.
    """
    if player_elo < 1000:
        spread = 75
    elif player_elo < 1300:
        spread = 100
    elif player_elo < 1600:
        spread = 100
    elif player_elo < 1900:
        spread = 125
    else:
        spread = 150

    bot_effective_elo = max(400, player_elo + random.randint(-spread, spread))

    base_reps = 22 + (bot_effective_elo - STARTING_ELO) / 40.0
    base_reps += random.uniform(-2, 2)  # a little extra noise so a fixed effective Elo doesn't always play identically

    target = round(base_reps)
    return max(3, min(target, MAX_PLAUSIBLE_PUSHUPS_60S - 10))


def compute_bot_live_count(target, elapsed_seconds, duration_seconds, match_id):
    """Deterministic, monotonically non-decreasing live progression toward
    the Bot's fixed target — recomputed from (match_id, elapsed time) on
    every call rather than stored/incremented, so it's cheap (no extra
    writes, no background job) and always consistent for repeated requests
    at the same elapsed time. The exponent gives each match a slightly
    different, deterministic pacing (front-loaded vs. back-loaded) without
    ever letting the count decrease or exceed the target."""
    if duration_seconds <= 0 or target <= 0:
        return target if elapsed_seconds >= duration_seconds else 0
    fraction = max(0.0, min(1.0, elapsed_seconds / duration_seconds))
    if fraction >= 1.0:
        return target
    # Deterministic per-match exponent in [0.85, 1.15] — purely a function
    # of match_id, not true randomness, so it's stable across repeated
    # calls but varies match to match.
    seed = (match_id * 2654435761) % 1000
    exponent = 0.85 + (seed / 1000) * 0.30
    progressed_fraction = fraction ** exponent
    return max(0, min(target, round(target * progressed_fraction)))


def create_bot_match(db, user_id):
    """Shared by the initial Bot fallback and Bot rematches. The Bot is
    marked ready (player2_ready=1) immediately at creation — it has no UI
    to press Ready, so the match starts the instant the human presses
    Ready themselves (see try_start_match())."""
    player_row = db.execute("SELECT elo FROM users WHERE id = ?", (user_id,)).fetchone()
    player_elo = player_row["elo"] if player_row else STARTING_ELO
    bot_count = determine_bot_target_reps(player_elo)
    cur = db.execute(
        """INSERT INTO matches
           (player1_id, player2_id, player2_count, status, is_bot_match,
            created_at, ready_deadline, player2_ready)
           VALUES (?, ?, ?, 'ready', 1, ?, ?, 1)""",
        (user_id, BOT_USER_ID, bot_count, now_iso(),
         time.time() + READY_TIMEOUT_SECONDS),
    )
    return cur.lastrowid


# ---------------------------------------------------------------------------
# Routes — API — ready / synchronized start (V1.2)
# ---------------------------------------------------------------------------
def try_start_match(db, match_id):
    """Attempts the atomic 'ready' -> 'in_progress' transition once both
    sides are ready. Safe to call from multiple concurrent requests — the
    conditional UPDATE's WHERE clause means only one caller can actually
    win the transition (same atomic-claim pattern as finalize_match)."""
    started_at = time.time()
    exercise_starts_at = started_at + READY_COUNTDOWN_SECONDS
    claimed = db.execute(
        """UPDATE matches SET
             status = 'in_progress',
             started_at = ?,
             exercise_starts_at = ?,
             expires_at = ?
           WHERE id = ? AND status = 'ready'
             AND player1_ready = 1 AND player2_ready = 1""",
        (started_at, exercise_starts_at,
         exercise_starts_at + MATCH_DURATION_SECONDS + SUBMIT_GRACE_SECONDS,
         match_id),
    )
    db.commit()
    return claimed.rowcount > 0


def cancel_if_ready_timed_out(db, match):
    """Lazily cancels a match that's been sitting in 'ready' too long
    (someone never pressed Ready). No Elo/W-L is touched — the match
    simply never happened. Returns the (possibly updated) match row."""
    if match["status"] != "ready" or not match["ready_deadline"]:
        return match
    if time.time() <= match["ready_deadline"]:
        return match
    db.execute(
        "UPDATE matches SET status = 'cancelled' WHERE id = ? AND status = 'ready'",
        (match["id"],),
    )
    db.commit()
    return db.execute("SELECT * FROM matches WHERE id = ?", (match["id"],)).fetchone()


@app.route("/api/match/<int:match_id>/ready", methods=["POST"])
@login_required
def mark_ready(match_id):
    user_id = session["user_id"]
    db = get_db()
    match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if match is None:
        return jsonify(error="match not found"), 404
    if user_id not in (match["player1_id"], match["player2_id"]):
        return jsonify(error="user is not in this match"), 403

    match = cancel_if_ready_timed_out(db, match)

    # Idempotent: pressing Ready again (double-click, retry) after the
    # match already moved on is harmless — just return current state
    # rather than erroring, per the V1.2 spec's idempotency requirement.
    if match["status"] != "ready":
        return jsonify(match_to_dict(db, match))

    col = "player1_ready" if user_id == match["player1_id"] else "player2_ready"
    # Idempotent + race-safe: this only matters the first time (repeat
    # calls just re-set the same value to 1, harmless), and since it's a
    # single UPDATE statement SQLite serializes it against any concurrent
    # ready call from the other player.
    db.execute(f"UPDATE matches SET {col} = 1 WHERE id = ? AND status = 'ready'", (match_id,))
    db.commit()

    # BUG-PRONE MOMENT (see V1.1 QA notes): if both players' ready calls
    # land at nearly the same instant, BOTH could reach this point believing
    # "both ready". try_start_match()'s conditional UPDATE (status='ready'
    # in its WHERE clause) means only one of them actually performs the
    # started_at/expires_at transition — the other's call is a no-op.
    try_start_match(db, match_id)

    match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    return jsonify(match_to_dict(db, match))


@app.route("/api/match/current")
@login_required
def match_current():
    """Lets the client recover its place after a page refresh: whether
    there's an unresolved match (any of ready/in_progress), whether it's
    still waiting in the queue, or whether a match just completed while
    disconnected."""
    user_id = session["user_id"]
    db = get_db()
    match = find_active_match_for_user(db, user_id)
    if match:
        match = cancel_if_ready_timed_out(db, match)
        if match["status"] == "cancelled":
            return jsonify(active=False, waiting_in_queue=False, cancelled_match_id=match["id"])
        i_am_p1 = match["player1_id"] == user_id
        my_count = match["player1_count"] if i_am_p1 else match["player2_count"]
        return jsonify(
            active=True,
            match_id=match["id"],
            already_submitted=my_count is not None,
        )

    still_waiting = db.execute("SELECT 1 FROM queue WHERE user_id = ?", (user_id,)).fetchone()
    if still_waiting:
        return jsonify(active=False, waiting_in_queue=True)

    recent = db.execute(
        """SELECT * FROM matches
           WHERE (player1_id = ? OR player2_id = ?) AND status = 'completed'
             AND started_at > ?
           ORDER BY id DESC LIMIT 1""",
        (user_id, user_id, time.time() - RECENT_RESULT_WINDOW_SECONDS),
    ).fetchone()
    if recent:
        return jsonify(active=False, waiting_in_queue=False, recent_match_id=recent["id"])

    return jsonify(active=False, waiting_in_queue=False)


@app.route("/api/match/<int:match_id>")
def match_status(match_id):
    db = get_db()
    match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if match is None:
        return jsonify(error="match not found"), 404

    match = cancel_if_ready_timed_out(db, match)

    # Edge case: opponent disconnects / never submits during IN_PROGRESS.
    if match["status"] == "in_progress" and match["expires_at"] and time.time() > match["expires_at"]:
        db.execute(
            """UPDATE matches SET
               player1_count = COALESCE(player1_count, 0),
               player2_count = COALESCE(player2_count, 0)
               WHERE id = ?""",
            (match_id,),
        )
        db.commit()
        finalize_match(db, match_id)
        match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()

    result = match_to_dict(db, match)
    # V1.3: whichever player is polling (not necessarily the one whose
    # submit triggered finalize_match) gets their OWN progression info —
    # derived from persisted state, so it's correct regardless of timing.
    session_uid = session.get("user_id")
    if match["status"] == "completed" and session_uid in (match["player1_id"], match["player2_id"]):
        result.update(get_match_progression_for_user(db, match_id, session_uid))

    return jsonify(result)


@app.route("/api/match/<int:match_id>/submit", methods=["POST"])
@login_required
def submit_count(match_id):
    body = request.json or {}
    user_id = session["user_id"]
    count = body.get("count")

    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        return jsonify(error="valid count required"), 400
    if count > MAX_PLAUSIBLE_PUSHUPS_60S:
        return jsonify(error="count exceeds plausible maximum for one match"), 400

    db = get_db()
    match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if match is None:
        return jsonify(error="match not found"), 404
    if match["status"] != "in_progress":
        return jsonify(error="match is not in progress"), 409
    if user_id not in (match["player1_id"], match["player2_id"]):
        return jsonify(error="user is not in this match"), 403

    i_am_p1 = user_id == match["player1_id"]

    if match["expires_at"] and time.time() > match["expires_at"] + 10:
        return jsonify(error="match window has expired"), 410

    col = "player1_count" if i_am_p1 else "player2_count"
    cur = db.execute(
        f"UPDATE matches SET {col} = ? WHERE id = ? AND {col} IS NULL",
        (count, match_id),
    )
    db.commit()
    if cur.rowcount == 0:
        return jsonify(error="you already submitted a result for this match"), 409

    match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if match["player1_count"] is not None and match["player2_count"] is not None:
        finalize_match(db, match_id)
        match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()

    result = match_to_dict(db, match)
    if match["status"] == "completed":
        me_row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        result["your_personal_best"] = me_row["best_pushups"]
        result["is_new_personal_best"] = count >= me_row["best_pushups"] and count > 0
        result["your_streak"] = me_row["current_streak"]
        result.update(get_match_progression_for_user(db, match_id, user_id))
    return jsonify(result)


# ---------------------------------------------------------------------------
# Routes — API — rematch (V1.2)
# ---------------------------------------------------------------------------
@app.route("/api/match/<int:match_id>/live-count", methods=["POST"])
@login_required
def submit_live_count(match_id):
    """Display-only running rep count during an in-progress match — lets
    both players see each other's current count in real time. Completely
    separate from submit_count(): this is always-overwritable (no
    NULL-gate, no anti-replay), because it never feeds Elo, win/loss, or
    total_pushups — those all still come exclusively from the one-shot
    final submit. Returns the opponent's live count in the same response
    so the frontend needs only one round trip per poll, not two."""
    body = request.json or {}
    count = body.get("count")
    user_id = session["user_id"]

    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        return jsonify(error="valid count required"), 400
    if count > MAX_PLAUSIBLE_PUSHUPS_60S:
        return jsonify(error="count exceeds plausible maximum for one match"), 400

    db = get_db()
    match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if match is None:
        return jsonify(error="match not found"), 404
    if user_id not in (match["player1_id"], match["player2_id"]):
        return jsonify(error="user is not in this match"), 403
    if match["status"] != "in_progress":
        # Not an error — the match may have just finalized between the
        # client's last frame and this request. Just report no live data.
        return jsonify(opponent_live_count=None, status=match["status"])

    i_am_p1 = user_id == match["player1_id"]
    col = "player1_live_count" if i_am_p1 else "player2_live_count"
    db.execute(f"UPDATE matches SET {col} = ? WHERE id = ?", (count, match_id))
    db.commit()

    if match["is_bot_match"]:
        # The Bot never calls this endpoint itself, so its live count is
        # computed on the fly from the same single target stored at match
        # creation (player2_count) — never a second/different random
        # number, and never exceeding that target. No extra writes, no
        # background job: just elapsed time vs. the stored target.
        elapsed = time.time() - (match["exercise_starts_at"] or match["started_at"] or time.time())
        opponent_live_count = compute_bot_live_count(
            match["player2_count"], elapsed, MATCH_DURATION_SECONDS, match_id
        )
    else:
        opp_col = "player2_live_count" if i_am_p1 else "player1_live_count"
        opp_row = db.execute(f"SELECT {opp_col} AS v FROM matches WHERE id = ?", (match_id,)).fetchone()
        opponent_live_count = opp_row["v"]

    return jsonify(opponent_live_count=opponent_live_count, status="in_progress")


@app.route("/api/match/<int:match_id>/rematch", methods=["POST"])
@login_required
def request_rematch(match_id):
    """Called by either participant of a COMPLETED match. For a Bot match,
    a fresh Bot match is created immediately (no second human to ask). For
    a human match, this records a pending request; if the OTHER player also
    calls this endpoint (both independently want a rematch), it's treated
    as a mutual accept and the new match is created right away — otherwise
    the other player must explicitly accept via /rematch-respond."""
    user_id = session["user_id"]
    db = get_db()
    match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if match is None:
        return jsonify(error="match not found"), 404
    if user_id not in (match["player1_id"], match["player2_id"]):
        return jsonify(error="user is not in this match"), 403
    if match["status"] != "completed":
        return jsonify(error="match is not completed"), 409

    if match["is_bot_match"]:
        new_match_id = create_bot_match(db, user_id)
        db.commit()
        return jsonify(status="created", new_match_id=new_match_id)

    opponent_id = match["player2_id"] if user_id == match["player1_id"] else match["player1_id"]
    existing = db.execute(
        "SELECT * FROM rematch_requests WHERE original_match_id = ?", (match_id,)
    ).fetchone()

    if existing and existing["status"] == "pending" and time.time() - existing["created_at"] > REMATCH_REQUEST_TIMEOUT_SECONDS:
        db.execute("UPDATE rematch_requests SET status = 'expired' WHERE original_match_id = ?", (match_id,))
        db.commit()
        existing = None

    if existing is None or existing["status"] in ("declined", "expired"):
        db.execute(
            """INSERT INTO rematch_requests (original_match_id, requester_id, status, created_at)
               VALUES (?, ?, 'pending', ?)
               ON CONFLICT(original_match_id) DO UPDATE SET
                 requester_id = excluded.requester_id, status = 'pending', created_at = excluded.created_at,
                 new_match_id = NULL""",
            (match_id, user_id, time.time()),
        )
        db.commit()
        return jsonify(status="requested")

    if existing["status"] == "pending" and existing["requester_id"] == user_id:
        return jsonify(status="requested")  # idempotent — already asked

    if existing["status"] == "pending" and existing["requester_id"] == opponent_id:
        # Both players want a rematch — mutual accept.
        return _accept_rematch(db, match, match_id)

    if existing["status"] == "accepted":
        return jsonify(status="created", new_match_id=existing["new_match_id"])

    return jsonify(status="requested")


@app.route("/api/match/<int:match_id>/rematch-status")
@login_required
def rematch_status(match_id):
    user_id = session["user_id"]
    db = get_db()
    match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if match is None or user_id not in (match["player1_id"], match["player2_id"]):
        return jsonify(error="match not found"), 404

    req = db.execute(
        "SELECT * FROM rematch_requests WHERE original_match_id = ?", (match_id,)
    ).fetchone()
    if not req:
        return jsonify(status="none")
    if req["status"] == "pending" and time.time() - req["created_at"] > REMATCH_REQUEST_TIMEOUT_SECONDS:
        db.execute("UPDATE rematch_requests SET status = 'expired' WHERE original_match_id = ?", (match_id,))
        db.commit()
        return jsonify(status="expired")

    requester = db.execute("SELECT username FROM users WHERE id = ?", (req["requester_id"],)).fetchone()
    return jsonify(
        status=req["status"],
        requester_id=req["requester_id"],
        requester_username=requester["username"] if requester else "?",
        is_me_requester=req["requester_id"] == user_id,
        new_match_id=req["new_match_id"],
    )


@app.route("/api/match/<int:match_id>/rematch-respond", methods=["POST"])
@login_required
def respond_rematch(match_id):
    user_id = session["user_id"]
    body = request.json or {}
    accept = bool(body.get("accept"))

    db = get_db()
    match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if match is None or user_id not in (match["player1_id"], match["player2_id"]):
        return jsonify(error="match not found"), 404

    req = db.execute(
        "SELECT * FROM rematch_requests WHERE original_match_id = ?", (match_id,)
    ).fetchone()
    if not req or req["status"] != "pending":
        return jsonify(error="no pending rematch request"), 409
    if req["requester_id"] == user_id:
        return jsonify(error="cannot respond to your own request"), 403

    if not accept:
        db.execute("UPDATE rematch_requests SET status = 'declined' WHERE original_match_id = ?", (match_id,))
        db.commit()
        return jsonify(status="declined")

    return _accept_rematch(db, match, match_id)


def _accept_rematch(db, original_match, match_id):
    """Atomically claims a pending rematch request AND creates the new
    match AND records new_match_id — all as one transaction. If two
    requests try to accept the same rematch concurrently, only one wins
    the claim (same conditional-UPDATE pattern used elsewhere); if
    anything fails after the claim but before the match is fully created,
    the whole transaction rolls back so the claim itself is undone too —
    no orphan 'accepted' request left pointing at nothing."""
    try:
        db.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError:
        return jsonify(error="server is busy, please try again"), 503

    try:
        claimed = db.execute(
            "UPDATE rematch_requests SET status = 'accepted' WHERE original_match_id = ? AND status = 'pending'",
            (match_id,),
        )
        if claimed.rowcount == 0:
            # Someone else already accepted/it expired — nothing to roll
            # back (we haven't written anything), just close the txn.
            db.commit()
            req = db.execute("SELECT * FROM rematch_requests WHERE original_match_id = ?", (match_id,)).fetchone()
            if req and req["status"] == "accepted":
                return jsonify(status="created", new_match_id=req["new_match_id"])
            return jsonify(error="rematch request no longer available"), 409

        cur = db.execute(
            """INSERT INTO matches (player1_id, player2_id, status, created_at, ready_deadline)
               VALUES (?, ?, 'ready', ?, ?)""",
            (original_match["player1_id"], original_match["player2_id"], now_iso(),
             time.time() + READY_TIMEOUT_SECONDS),
        )
        new_match_id = cur.lastrowid
        db.execute(
            "UPDATE rematch_requests SET new_match_id = ? WHERE original_match_id = ?",
            (new_match_id, match_id),
        )
        db.commit()
        return jsonify(status="created", new_match_id=new_match_id)
    except Exception:
        db.rollback()
        raise


LEADERBOARD_WINDOWS = {"weekly": 7, "monthly": 30}


@app.route("/api/leaderboard")
def leaderboard():
    tab = request.args.get("tab", "all")
    db = get_db()

    if tab not in LEADERBOARD_WINDOWS:
        # Default / 'all': unchanged from V1.1/V1.2 — current Elo ranking.
        rows = db.execute(
            """SELECT * FROM users WHERE id != ?
               ORDER BY elo DESC, wins DESC LIMIT 50""",
            (BOT_USER_ID,),
        ).fetchall()
        return jsonify([user_to_dict(r) for r in rows])

    # Weekly/monthly: rank by Elo GAINED within the window, computed from
    # each match's actual recorded before/after Elo (not a re-sort of
    # current Elo pretending to be historical). Only completed
    # human-vs-human-or-bot matches within the window count.
    days = LEADERBOARD_WINDOWS[tab]
    cutoff_iso = datetime.fromtimestamp(time.time() - days * 86400, tz=timezone.utc).isoformat()
    rows = db.execute(
        """
        SELECT u.id, u.username, u.avatar_id, u.elo, SUM(delta) AS elo_gain, COUNT(*) AS matches_in_window
        FROM (
            SELECT player1_id AS user_id, (player1_elo_after - player1_elo_before) AS delta
            FROM matches WHERE status='completed' AND player1_elo_after IS NOT NULL AND created_at >= ?
            UNION ALL
            SELECT player2_id AS user_id, (player2_elo_after - player2_elo_before) AS delta
            FROM matches WHERE status='completed' AND player2_elo_after IS NOT NULL AND created_at >= ?
        ) deltas
        JOIN users u ON u.id = deltas.user_id
        WHERE u.id != ?
        GROUP BY u.id
        ORDER BY elo_gain DESC
        LIMIT 50
        """,
        (cutoff_iso, cutoff_iso, BOT_USER_ID),
    ).fetchall()
    return jsonify([
        {
            "id": r["id"], "username": r["username"], "avatar_id": r["avatar_id"],
            "elo": r["elo"], "elo_gain": r["elo_gain"], "matches_in_window": r["matches_in_window"],
            "rank_tier": get_rank_from_elo(r["elo"]),
        }
        for r in rows
    ])


@app.route("/api/leaderboard/my-rank")
@login_required
def my_leaderboard_rank():
    """All-time Elo rank position for the current user — so the UI can
    show 'Your Rank: #1,284' even when far outside the top-50 list.
    Also returns real DB-derived global/country player counts and, when
    the player has a country set, their rank within that country. All
    values are computed directly from the users table — never hardcoded."""
    user_id = session["user_id"]
    db = get_db()
    me_row = db.execute("SELECT elo, country FROM users WHERE id = ?", (user_id,)).fetchone()
    if me_row is None:
        return jsonify(error="not found"), 404
    return jsonify(compute_rank_stats(db, me_row["elo"], me_row["country"]))


@app.route("/api/my-matches")
@login_required
def my_matches():
    """Recent completed matches for the current user — powers the profile page."""
    user_id = session["user_id"]
    db = get_db()
    rows = db.execute(
        """SELECT * FROM matches
           WHERE (player1_id = ? OR player2_id = ?) AND status = 'completed'
           ORDER BY id DESC LIMIT 20""",
        (user_id, user_id),
    ).fetchall()

    results = []
    for match in rows:
        i_am_p1 = match["player1_id"] == user_id
        opponent_id = match["player2_id"] if i_am_p1 else match["player1_id"]
        opponent = db.execute("SELECT * FROM users WHERE id = ?", (opponent_id,)).fetchone()
        my_count = match["player1_count"] if i_am_p1 else match["player2_count"]
        opp_count = match["player2_count"] if i_am_p1 else match["player1_count"]

        if match["winner_id"] is None:
            outcome = "draw"
        elif match["winner_id"] == user_id:
            outcome = "win"
        else:
            outcome = "loss"

        results.append({
            "match_id": match["id"],
            "opponent_username": opponent["username"] if opponent else "?",
            "my_count": my_count,
            "opponent_count": opp_count,
            "outcome": outcome,
            "is_bot_match": bool(match["is_bot_match"]),
            "created_at": match["created_at"],
        })

    return jsonify(results)


def compute_rank_stats(db, elo, country):
    """Real DB-derived global rank/count, plus country rank/count when a
    country is set. Shared by /api/profile and /api/leaderboard/my-rank so
    the two never drift out of sync."""
    total_players = db.execute(
        "SELECT COUNT(*) c FROM users WHERE id != ?", (BOT_USER_ID,)
    ).fetchone()["c"]
    rank = db.execute(
        "SELECT COUNT(*) + 1 AS rank FROM users WHERE elo > ? AND id != ?",
        (elo, BOT_USER_ID),
    ).fetchone()["rank"]
    stats = {"rank": rank, "total_players": total_players, "country": country}
    if country:
        stats["country_player_count"] = db.execute(
            "SELECT COUNT(*) c FROM users WHERE country = ? AND id != ?",
            (country, BOT_USER_ID),
        ).fetchone()["c"]
        stats["country_rank"] = db.execute(
            "SELECT COUNT(*) + 1 AS rank FROM users WHERE elo > ? AND country = ? AND id != ?",
            (elo, country, BOT_USER_ID),
        ).fetchone()["rank"]
    return stats


@app.route("/api/profile")
@login_required
def get_profile():
    """V1.3 Profile 2.0 — the rich player-identity payload. Kept separate
    from the lightweight /api/me (used for session bootstrap) so ordinary
    session checks don't pay for the extra achievement/rank queries."""
    user_id = session["user_id"]
    db = get_db()
    u = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if u is None:
        return jsonify(error="not found"), 404

    total_matches = u["wins"] + u["losses"] + u["draws"]
    win_rate = round(100 * u["wins"] / total_matches, 1) if total_matches > 0 else 0.0
    level = get_level_from_xp(u["xp"])
    rank_stats = compute_rank_stats(db, u["elo"], u["country"])

    all_achievements = db.execute("SELECT * FROM achievements ORDER BY id").fetchall()
    unlocked = {
        r["achievement_id"]: r["unlocked_at"]
        for r in db.execute("SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?", (user_id,)).fetchall()
    }
    achievements = [
        {
            "code": a["code"], "name": a["name"], "description": a["description"],
            "icon": a["icon"], "category": a["category"], "xp_reward": a["xp_reward"],
            "unlocked": a["id"] in unlocked,
            "unlocked_at": unlocked.get(a["id"]),
        }
        for a in all_achievements
    ]

    return jsonify({
        "id": u["id"],
        "username": u["username"],
        "country": u["country"],
        "bio": u["bio"],
        "avatar_id": u["avatar_id"],
        "elo": u["elo"],
        "peak_elo": u["peak_elo"],
        "rank_tier": get_rank_from_elo(u["elo"]),
        "elo_rank": rank_stats["rank"],
        "total_players": rank_stats["total_players"],
        "country_rank": rank_stats.get("country_rank"),
        "country_player_count": rank_stats.get("country_player_count"),
        "level": level,
        "xp": u["xp"],
        "xp_for_current_level": get_xp_for_level(level),
        "xp_for_next_level": get_xp_for_level(level + 1),
        "wins": u["wins"],
        "losses": u["losses"],
        "draws": u["draws"],
        "total_matches": total_matches,
        "win_rate": win_rate,
        "best_pushups": u["best_pushups"],
        "total_pushups": u["total_pushups"],
        "current_streak": u["current_streak"],
        "longest_streak": u["longest_streak"],
        "achievements": achievements,
        "avatar_count": AVATAR_COUNT,
    })


@app.route("/api/profile", methods=["PUT"])
@login_required
def update_profile():
    """Lets the authenticated user edit ONLY their own country/bio/avatar.
    Username is intentionally not editable in V1.3. Nothing here can touch
    Elo, XP, level, wins, or any other server-controlled progression value
    — those fields simply aren't accepted from the request body."""
    body = request.json or {}
    user_id = session["user_id"]
    db = get_db()

    updates = {}
    if "bio" in body:
        bio = (body["bio"] or "").strip()
        if len(bio) > MAX_BIO_LENGTH:
            return jsonify(error=f"bio must be at most {MAX_BIO_LENGTH} characters"), 400
        if not bio.isprintable():
            return jsonify(error="bio contains invalid characters"), 400
        updates["bio"] = bio or None

    if "country" in body:
        country = (body["country"] or "").strip().upper()
        if country and country not in VALID_COUNTRY_CODES:
            return jsonify(error="unknown country code"), 400
        updates["country"] = country or None

    if "avatar_id" in body:
        avatar_id = body["avatar_id"]
        if not isinstance(avatar_id, int) or isinstance(avatar_id, bool) or not (1 <= avatar_id <= AVATAR_COUNT):
            return jsonify(error=f"avatar_id must be an integer from 1 to {AVATAR_COUNT}"), 400
        updates["avatar_id"] = avatar_id

    if not updates:
        return jsonify(error="nothing to update"), 400

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    db.execute(f"UPDATE users SET {set_clause} WHERE id = ?", (*updates.values(), user_id))
    db.commit()
    return get_profile()


# ---------------------------------------------------------------------------
# V1.4 — social system helpers
# ---------------------------------------------------------------------------
def create_notification(db, user_id, notif_type, actor_id=None, reference_id=None):
    """Centralized notification creation — every notification in the app
    goes through this one function, per the V1.4 spec."""
    db.execute(
        "INSERT INTO notifications (user_id, type, actor_id, reference_id, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)",
        (user_id, notif_type, actor_id, reference_id, time.time()),
    )


def _mark_challenge_notification_read(db, challenge_id, challenged_id):
    """A CHALLENGE_RECEIVED notification is only actionable while its
    challenge is genuinely pending. This clears it server-side the moment
    the challenge resolves — accepted, declined, or cancelled — regardless
    of WHICH code path resolved it (the accept/decline modal, the
    reverse-challenge auto-accept shortcut in send_challenge, or an
    unfriend cancellation). Doing this here, at the single source of
    truth for challenge state, is what actually fixes stale challenges
    reappearing on next login/poll — relying on the client to remember to
    mark it read only covers the paths the client happens to trigger."""
    db.execute(
        """UPDATE notifications SET is_read = 1
           WHERE user_id = ? AND type = ? AND reference_id = ? AND is_read = 0""",
        (challenged_id, NOTIF_CHALLENGE_RECEIVED, challenge_id),
    )


def create_activity(db, user_id, event_type, reference_id=None):
    """Centralized activity-feed event creation."""
    db.execute(
        "INSERT INTO activity_events (user_id, event_type, reference_id, created_at) VALUES (?, ?, ?, ?)",
        (user_id, event_type, reference_id, time.time()),
    )


def are_friends(db, user_a, user_b):
    lo, hi = (user_a, user_b) if user_a < user_b else (user_b, user_a)
    return db.execute(
        "SELECT 1 FROM friendships WHERE user_low = ? AND user_high = ?", (lo, hi)
    ).fetchone() is not None


def public_user_dict(db, row):
    """Public-safe subset of a user row — used for search results, public
    profiles, and friends lists. Never includes password_hash or any
    session/account-internal field."""
    last_seen = row["last_seen"]
    online = bool(last_seen and (time.time() - last_seen) < ONLINE_THRESHOLD_SECONDS)
    return {
        "id": row["id"],
        "username": row["username"],
        "avatar_id": row["avatar_id"],
        "country": row["country"],
        "bio": row["bio"],
        "elo": row["elo"],
        "peak_elo": row["peak_elo"],
        "rank_tier": get_rank_from_elo(row["elo"]),
        "level": get_level_from_xp(row["xp"]),
        "wins": row["wins"],
        "losses": row["losses"],
        "draws": row["draws"],
        "current_streak": row["current_streak"],
        "best_pushups": row["best_pushups"],
        "online": online,
    }


# ---------------------------------------------------------------------------
# Routes — API — player search & public profiles (V1.4)
# ---------------------------------------------------------------------------
@app.route("/api/players/search")
@login_required
def search_players():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify([])
    db = get_db()
    rows = db.execute(
        """SELECT * FROM users WHERE username LIKE ? AND id != ? AND id != ?
           ORDER BY elo DESC LIMIT ?""",
        (f"%{q}%", BOT_USER_ID, session["user_id"], PLAYER_SEARCH_LIMIT),
    ).fetchall()
    return jsonify([public_user_dict(db, r) for r in rows])


@app.route("/api/players/<username>")
@login_required
def public_profile(username):
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if row is None or row["id"] == BOT_USER_ID:
        return jsonify(error="player not found"), 404

    my_id = session["user_id"]
    data = public_user_dict(db, row)
    data["total_pushups"] = row["total_pushups"]
    data["longest_streak"] = row["longest_streak"]

    all_ach = db.execute("SELECT * FROM achievements ORDER BY id").fetchall()
    unlocked = {
        r["achievement_id"]
        for r in db.execute("SELECT achievement_id FROM user_achievements WHERE user_id = ?", (row["id"],)).fetchall()
    }
    data["achievements"] = [
        {"code": a["code"], "name": a["name"], "icon": a["icon"], "unlocked": a["id"] in unlocked}
        for a in all_ach
    ]

    if row["id"] == my_id:
        data["relationship"] = "self"
    elif are_friends(db, my_id, row["id"]):
        data["relationship"] = "friends"
    else:
        outgoing = db.execute(
            "SELECT id FROM friend_requests WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'",
            (my_id, row["id"]),
        ).fetchone()
        incoming = db.execute(
            "SELECT id FROM friend_requests WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'",
            (row["id"], my_id),
        ).fetchone()
        if outgoing:
            data["relationship"] = "request_sent"
            data["request_id"] = outgoing["id"]
        elif incoming:
            data["relationship"] = "request_received"
            data["request_id"] = incoming["id"]
        else:
            data["relationship"] = "none"

    return jsonify(data)


# ---------------------------------------------------------------------------
# Routes — API — friends (V1.4)
# ---------------------------------------------------------------------------
@app.route("/api/friends/request", methods=["POST"])
@login_required
def send_friend_request():
    body = request.json or {}
    receiver_id = body.get("receiver_id")
    sender_id = session["user_id"]

    if not isinstance(receiver_id, int) or isinstance(receiver_id, bool):
        return jsonify(error="valid receiver_id required"), 400
    if receiver_id == sender_id:
        return jsonify(error="cannot send a friend request to yourself"), 400

    db = get_db()
    receiver = db.execute("SELECT id FROM users WHERE id = ? AND id != ?", (receiver_id, BOT_USER_ID)).fetchone()
    if receiver is None:
        return jsonify(error="user not found"), 404
    if are_friends(db, sender_id, receiver_id):
        return jsonify(error="already friends"), 409

    # If the OTHER person already sent US a pending request, treat this as
    # a mutual accept instead of creating a second, redundant request —
    # same pattern used for V1.2 rematch mutual-requests.
    reverse = db.execute(
        "SELECT * FROM friend_requests WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'",
        (receiver_id, sender_id),
    ).fetchone()
    if reverse:
        return _accept_friend_request(db, reverse)

    try:
        db.execute(
            "INSERT INTO friend_requests (sender_id, receiver_id, status, created_at) VALUES (?, ?, 'pending', ?)",
            (sender_id, receiver_id, time.time()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        # Partial unique index caught a duplicate pending request — fine,
        # it means one already exists (possibly from a concurrent call).
        db.rollback()
        existing = db.execute(
            "SELECT id FROM friend_requests WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'",
            (sender_id, receiver_id),
        ).fetchone()
        return jsonify(status="pending", request_id=existing["id"] if existing else None)

    req_id = db.execute(
        "SELECT id FROM friend_requests WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'",
        (sender_id, receiver_id),
    ).fetchone()["id"]
    create_notification(db, receiver_id, NOTIF_FRIEND_REQUEST, actor_id=sender_id, reference_id=req_id)
    db.commit()
    return jsonify(status="pending", request_id=req_id)


def _accept_friend_request(db, req):
    """Atomically claims a pending friend request and creates the
    friendship. The conditional UPDATE (WHERE status='pending') means
    concurrent duplicate accept attempts can only let one caller through —
    same proven pattern as _accept_rematch / try_start_match."""
    try:
        db.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError:
        return jsonify(error="server is busy, please try again"), 503

    try:
        claimed = db.execute(
            "UPDATE friend_requests SET status = 'accepted', responded_at = ? WHERE id = ? AND status = 'pending'",
            (time.time(), req["id"]),
        )
        if claimed.rowcount == 0:
            db.commit()
            current = db.execute("SELECT status FROM friend_requests WHERE id = ?", (req["id"],)).fetchone()
            if current and current["status"] == "accepted":
                return jsonify(status="accepted")
            return jsonify(error="request no longer pending"), 409

        lo, hi = sorted((req["sender_id"], req["receiver_id"]))
        db.execute(
            "INSERT OR IGNORE INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)",
            (lo, hi, time.time()),
        )
        # Clean up any stray reverse-direction pending request so it
        # doesn't linger as a dangling row now that they're friends.
        db.execute(
            "UPDATE friend_requests SET status = 'cancelled', responded_at = ? WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'",
            (time.time(), req["receiver_id"], req["sender_id"]),
        )
        create_notification(db, req["sender_id"], NOTIF_FRIEND_ACCEPTED, actor_id=req["receiver_id"])
        db.commit()
        return jsonify(status="accepted")
    except Exception:
        db.rollback()
        raise


@app.route("/api/friends/requests/<int:request_id>/accept", methods=["POST"])
@login_required
def accept_friend_request(request_id):
    db = get_db()
    req = db.execute("SELECT * FROM friend_requests WHERE id = ?", (request_id,)).fetchone()
    if req is None:
        return jsonify(error="request not found"), 404
    if req["receiver_id"] != session["user_id"]:
        return jsonify(error="you cannot accept another user's request"), 403
    if req["status"] != "pending":
        return jsonify(error="request is no longer pending"), 409
    return _accept_friend_request(db, req)


@app.route("/api/friends/requests/<int:request_id>/decline", methods=["POST"])
@login_required
def decline_friend_request(request_id):
    db = get_db()
    req = db.execute("SELECT * FROM friend_requests WHERE id = ?", (request_id,)).fetchone()
    if req is None:
        return jsonify(error="request not found"), 404
    if req["receiver_id"] != session["user_id"]:
        return jsonify(error="you cannot decline another user's request"), 403
    db.execute(
        "UPDATE friend_requests SET status = 'declined', responded_at = ? WHERE id = ? AND status = 'pending'",
        (time.time(), request_id),
    )
    db.commit()
    return jsonify(status="declined")


@app.route("/api/friends/requests/<int:request_id>/cancel", methods=["POST"])
@login_required
def cancel_friend_request(request_id):
    db = get_db()
    req = db.execute("SELECT * FROM friend_requests WHERE id = ?", (request_id,)).fetchone()
    if req is None:
        return jsonify(error="request not found"), 404
    if req["sender_id"] != session["user_id"]:
        return jsonify(error="you cannot cancel another user's request"), 403
    db.execute(
        "UPDATE friend_requests SET status = 'cancelled', responded_at = ? WHERE id = ? AND status = 'pending'",
        (time.time(), request_id),
    )
    db.commit()
    return jsonify(status="cancelled")


@app.route("/api/friends/requests")
@login_required
def list_friend_requests():
    user_id = session["user_id"]
    db = get_db()
    incoming = db.execute(
        """SELECT fr.id, fr.created_at, u.id AS user_id, u.username, u.avatar_id
           FROM friend_requests fr JOIN users u ON u.id = fr.sender_id
           WHERE fr.receiver_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC""",
        (user_id,),
    ).fetchall()
    outgoing = db.execute(
        """SELECT fr.id, fr.created_at, u.id AS user_id, u.username, u.avatar_id
           FROM friend_requests fr JOIN users u ON u.id = fr.receiver_id
           WHERE fr.sender_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC""",
        (user_id,),
    ).fetchall()
    return jsonify(
        incoming=[dict(r) for r in incoming],
        outgoing=[dict(r) for r in outgoing],
    )


@app.route("/api/friends", methods=["GET"])
@login_required
def list_friends():
    user_id = session["user_id"]
    db = get_db()
    rows = db.execute(
        """SELECT u.* FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
           WHERE f.user_low = ? OR f.user_high = ?
           ORDER BY u.elo DESC""",
        (user_id, user_id, user_id),
    ).fetchall()
    return jsonify([public_user_dict(db, r) for r in rows])


@app.route("/api/friends/<int:friend_id>", methods=["DELETE"])
@login_required
def remove_friend(friend_id):
    user_id = session["user_id"]
    db = get_db()
    lo, hi = sorted((user_id, friend_id))
    cur = db.execute("DELETE FROM friendships WHERE user_low = ? AND user_high = ?", (lo, hi))
    # Also cancel any pending challenge between them so it can't be
    # accepted after the friendship (and the ability to challenge) is gone.
    cancelled = db.execute(
        """SELECT id, challenged_id FROM challenges
           WHERE status = 'pending'
             AND ((challenger_id = ? AND challenged_id = ?) OR (challenger_id = ? AND challenged_id = ?))""",
        (user_id, friend_id, friend_id, user_id),
    ).fetchall()
    db.execute(
        """UPDATE challenges SET status = 'cancelled', responded_at = ?
           WHERE status = 'pending'
             AND ((challenger_id = ? AND challenged_id = ?) OR (challenger_id = ? AND challenged_id = ?))""",
        (time.time(), user_id, friend_id, friend_id, user_id),
    )
    for row in cancelled:
        _mark_challenge_notification_read(db, row["id"], row["challenged_id"])
    db.commit()
    if cur.rowcount == 0:
        return jsonify(error="not friends"), 404
    return jsonify(status="removed")


@app.route("/api/friends/leaderboard")
@login_required
def friends_leaderboard():
    user_id = session["user_id"]
    db = get_db()
    rows = db.execute(
        """SELECT u.* FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
           WHERE f.user_low = ? OR f.user_high = ?
           ORDER BY u.elo DESC LIMIT 50""",
        (user_id, user_id, user_id),
    ).fetchall()
    return jsonify([public_user_dict(db, r) for r in rows])


@app.route("/api/friends/activity")
@login_required
def friends_activity():
    user_id = session["user_id"]
    db = get_db()
    rows = db.execute(
        """SELECT ae.event_type, ae.reference_id, ae.created_at, u.username, u.avatar_id
           FROM activity_events ae
           JOIN friendships f ON (
               (f.user_low = ? AND f.user_high = ae.user_id) OR
               (f.user_high = ? AND f.user_low = ae.user_id)
           )
           JOIN users u ON u.id = ae.user_id
           ORDER BY ae.created_at DESC LIMIT ?""",
        (user_id, user_id, FRIENDS_ACTIVITY_LIMIT),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


# ---------------------------------------------------------------------------
# Routes — API — challenges (V1.4) — reuses the existing match engine
# ---------------------------------------------------------------------------
@app.route("/api/challenges", methods=["POST"])
@login_required
def send_challenge():
    body = request.json or {}
    challenged_id = body.get("challenged_id")
    challenger_id = session["user_id"]

    if not isinstance(challenged_id, int) or isinstance(challenged_id, bool):
        return jsonify(error="valid challenged_id required"), 400
    if challenged_id == challenger_id:
        return jsonify(error="cannot challenge yourself"), 400

    db = get_db()
    if not are_friends(db, challenger_id, challenged_id):
        return jsonify(error="you can only challenge friends"), 403

    reverse = db.execute(
        "SELECT * FROM challenges WHERE challenger_id = ? AND challenged_id = ? AND status = 'pending'",
        (challenged_id, challenger_id),
    ).fetchone()
    if reverse:
        return _accept_challenge(db, reverse)

    try:
        db.execute(
            "INSERT INTO challenges (challenger_id, challenged_id, status, created_at) VALUES (?, ?, 'pending', ?)",
            (challenger_id, challenged_id, time.time()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        existing = db.execute(
            "SELECT id FROM challenges WHERE challenger_id = ? AND challenged_id = ? AND status = 'pending'",
            (challenger_id, challenged_id),
        ).fetchone()
        return jsonify(status="pending", challenge_id=existing["id"] if existing else None)

    chal_id = db.execute(
        "SELECT id FROM challenges WHERE challenger_id = ? AND challenged_id = ? AND status = 'pending'",
        (challenger_id, challenged_id),
    ).fetchone()["id"]
    create_notification(db, challenged_id, NOTIF_CHALLENGE_RECEIVED, actor_id=challenger_id, reference_id=chal_id)
    db.commit()
    return jsonify(status="pending", challenge_id=chal_id)


def _accept_challenge(db, chal):
    """Atomically claims a pending challenge and creates exactly one new
    match via the EXISTING match engine (status='ready', same READY/
    countdown/timer machinery as queue and bot matches — no second match
    engine). Guards against either player already being in an active match."""
    try:
        db.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError:
        return jsonify(error="server is busy, please try again"), 503

    try:
        claimed = db.execute(
            "UPDATE challenges SET status = 'accepted', responded_at = ? WHERE id = ? AND status = 'pending'",
            (time.time(), chal["id"]),
        )
        if claimed.rowcount == 0:
            db.commit()
            current = db.execute("SELECT status, match_id FROM challenges WHERE id = ?", (chal["id"],)).fetchone()
            if current and current["status"] == "accepted":
                return jsonify(status="accepted", match_id=current["match_id"])
            return jsonify(error="challenge no longer pending"), 409

        a, b = chal["challenger_id"], chal["challenged_id"]
        if find_active_match_for_user(db, a) or find_active_match_for_user(db, b):
            db.execute("UPDATE challenges SET status = 'cancelled' WHERE id = ?", (chal["id"],))
            _mark_challenge_notification_read(db, chal["id"], chal["challenged_id"])
            db.commit()
            return jsonify(error="one of the players is already in a match"), 409

        cur = db.execute(
            """INSERT INTO matches (player1_id, player2_id, status, created_at, ready_deadline)
               VALUES (?, ?, 'ready', ?, ?)""",
            (a, b, now_iso(), time.time() + READY_TIMEOUT_SECONDS),
        )
        new_match_id = cur.lastrowid
        db.execute("UPDATE challenges SET match_id = ? WHERE id = ?", (new_match_id, chal["id"]))
        create_notification(db, chal["challenger_id"], NOTIF_CHALLENGE_ACCEPTED, actor_id=chal["challenged_id"], reference_id=new_match_id)
        _mark_challenge_notification_read(db, chal["id"], chal["challenged_id"])
        db.commit()
        return jsonify(status="accepted", match_id=new_match_id)
    except Exception:
        db.rollback()
        raise


@app.route("/api/challenges/<int:challenge_id>/accept", methods=["POST"])
@login_required
def accept_challenge(challenge_id):
    db = get_db()
    chal = db.execute("SELECT * FROM challenges WHERE id = ?", (challenge_id,)).fetchone()
    if chal is None:
        return jsonify(error="challenge not found"), 404
    if chal["challenged_id"] != session["user_id"]:
        return jsonify(error="you cannot accept another user's challenge"), 403
    if chal["status"] != "pending":
        return jsonify(error="challenge is no longer pending"), 409
    return _accept_challenge(db, chal)


@app.route("/api/challenges/<int:challenge_id>/decline", methods=["POST"])
@login_required
def decline_challenge(challenge_id):
    db = get_db()
    chal = db.execute("SELECT * FROM challenges WHERE id = ?", (challenge_id,)).fetchone()
    if chal is None:
        return jsonify(error="challenge not found"), 404
    if chal["challenged_id"] != session["user_id"]:
        return jsonify(error="you cannot decline another user's challenge"), 403
    cur = db.execute(
        "UPDATE challenges SET status = 'declined', responded_at = ? WHERE id = ? AND status = 'pending'",
        (time.time(), challenge_id),
    )
    if cur.rowcount > 0:
        create_notification(db, chal["challenger_id"], NOTIF_CHALLENGE_DECLINED, actor_id=chal["challenged_id"])
    _mark_challenge_notification_read(db, challenge_id, chal["challenged_id"])
    db.commit()
    return jsonify(status="declined")


# ---------------------------------------------------------------------------
# Routes — API — notifications (V1.4)
# ---------------------------------------------------------------------------
@app.route("/api/notifications")
@login_required
def list_notifications():
    user_id = session["user_id"]
    try:
        limit = min(int(request.args.get("limit", NOTIFICATIONS_PAGE_SIZE)), 100)
        offset = max(int(request.args.get("offset", 0)), 0)
    except (TypeError, ValueError):
        return jsonify(error="invalid pagination parameters"), 400

    db = get_db()
    rows = db.execute(
        """SELECT n.*, u.username AS actor_username FROM notifications n
           LEFT JOIN users u ON u.id = n.actor_id
           WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT ? OFFSET ?""",
        (user_id, limit, offset),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/notifications/unread-count")
@login_required
def unread_notification_count():
    user_id = session["user_id"]
    db = get_db()
    count = db.execute(
        "SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0", (user_id,)
    ).fetchone()["c"]
    return jsonify(count=count)


@app.route("/api/notifications/<int:notif_id>/read", methods=["POST"])
@login_required
def mark_notification_read(notif_id):
    user_id = session["user_id"]
    db = get_db()
    notif = db.execute("SELECT user_id FROM notifications WHERE id = ?", (notif_id,)).fetchone()
    if notif is None:
        return jsonify(error="notification not found"), 404
    if notif["user_id"] != user_id:
        return jsonify(error="you cannot modify another user's notification"), 403
    db.execute("UPDATE notifications SET is_read = 1 WHERE id = ?", (notif_id,))
    db.commit()
    return jsonify(status="read")


@app.route("/api/notifications/read-all", methods=["POST"])
@login_required
def mark_all_notifications_read():
    user_id = session["user_id"]
    db = get_db()
    db.execute("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", (user_id,))
    db.commit()
    return jsonify(status="read")


# ---------------------------------------------------------------------------
# Routes — API — online status (V1.4)
# ---------------------------------------------------------------------------
@app.route("/api/heartbeat", methods=["POST"])
@login_required
def heartbeat():
    """Lightweight, explicit endpoint for the client to call every ~30-45s
    to update last_seen — deliberately NOT piggybacked onto every request
    (which would add a write to every hot-path API call)."""
    db = get_db()
    db.execute("UPDATE users SET last_seen = ? WHERE id = ?", (time.time(), session["user_id"]))
    db.commit()
    return jsonify(status="ok")


# ---------------------------------------------------------------------------
# Routes — API — RPG (V1.5)
# ---------------------------------------------------------------------------
def rpg_player_to_dict(row):
    return {
        "rpg_xp": row["rpg_xp"],
        "rpg_level": get_rpg_level_from_xp(row["rpg_xp"]),
        "rpg_rank": get_rpg_rank_from_level(get_rpg_level_from_xp(row["rpg_xp"])),
        "rpg_xp_for_current_level": get_rpg_xp_for_level(get_rpg_level_from_xp(row["rpg_xp"])),
        "rpg_xp_for_next_level": get_rpg_xp_for_level(get_rpg_level_from_xp(row["rpg_xp"]) + 1),
        "gold": row["gold"],
        "total_damage": row["total_damage"],
        "monsters_defeated": row["monsters_defeated"],
    }


@app.route("/api/rpg/profile")
@login_required
def rpg_profile():
    db = get_db()
    player = get_or_create_rpg_player(db, session["user_id"])
    return jsonify(rpg_player_to_dict(player))


@app.route("/api/rpg/monsters")
@login_required
def list_monsters():
    db = get_db()
    rows = db.execute("SELECT * FROM monsters WHERE active = 1 ORDER BY difficulty").fetchall()
    return jsonify([
        {
            "id": r["id"], "name": r["name"], "description": r["description"],
            "max_hp": r["max_hp"], "difficulty": r["difficulty"],
            "xp_reward": r["xp_reward"], "gold_reward": r["gold_reward"], "icon": r["icon"],
        }
        for r in rows
    ])


@app.route("/api/rpg/encounters/current")
@login_required
def rpg_encounter_current():
    """Refresh/resume support — mirrors /api/match/current for PvP. Lets
    the frontend recover an in-progress battle after a page reload instead
    of silently starting a new one."""
    db = get_db()
    enc = find_active_encounter_for_user(db, session["user_id"])
    if not enc:
        return jsonify(active=False)
    enc = expire_if_stale(db, enc)
    if enc["status"] != "active":
        return jsonify(active=False)
    monster = db.execute("SELECT * FROM monsters WHERE id = ?", (enc["monster_id"],)).fetchone()
    return jsonify(
        active=True, encounter_id=enc["id"], monster_hp=enc["monster_hp"],
        monster_max_hp=monster["max_hp"], monster_name=monster["name"], monster_icon=monster["icon"],
        started_at=enc["started_at"], expires_at=enc["expires_at"],
    )


def find_active_encounter_for_user(db, user_id):
    return db.execute(
        "SELECT * FROM encounters WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
        (user_id,),
    ).fetchone()


def expire_if_stale(db, encounter):
    """RPG is timeless (V1.5 correction pass) — encounters no longer
    auto-expire based on elapsed time. This function is kept as a no-op
    passthrough (rather than removing all its call sites individually) so
    an encounter could still be time-limited in the future without
    touching every call site again — for now it simply returns the
    encounter unchanged."""
    return encounter


@app.route("/api/rpg/encounters/start", methods=["POST"])
@login_required
def start_encounter():
    body = request.json or {}
    monster_id = body.get("monster_id")
    user_id = session["user_id"]

    if not isinstance(monster_id, int) or isinstance(monster_id, bool):
        return jsonify(error="valid monster_id required"), 400

    db = get_db()
    existing = find_active_encounter_for_user(db, user_id)
    if existing:
        existing = expire_if_stale(db, existing)
        if existing["status"] == "active":
            return jsonify(error="you already have an active encounter"), 409

    monster = db.execute("SELECT * FROM monsters WHERE id = ? AND active = 1", (monster_id,)).fetchone()
    if monster is None:
        return jsonify(error="monster not found"), 404

    get_or_create_rpg_player(db, user_id)
    now = time.time()
    # expires_at is a legacy NOT NULL column from before RPG was made
    # timeless — it's no longer enforced (expire_if_stale() is a no-op),
    # so we just store a far-future placeholder to satisfy the schema.
    try:
        cur = db.execute(
            """INSERT INTO encounters (user_id, monster_id, monster_hp, status, started_at, expires_at)
               VALUES (?, ?, ?, 'active', ?, ?)""",
            (user_id, monster_id, monster["max_hp"], now, now + 3153600000),  # +100 years
        )
    except sqlite3.IntegrityError:
        # The partial unique index caught a concurrent duplicate start —
        # someone else's request already created the active encounter.
        db.rollback()
        return jsonify(error="you already have an active encounter"), 409
    db.commit()
    return jsonify(encounter_id=cur.lastrowid, monster_hp=monster["max_hp"], monster_max_hp=monster["max_hp"])


@app.route("/api/rpg/encounters/<int:encounter_id>")
@login_required
def get_encounter(encounter_id):
    db = get_db()
    enc = db.execute("SELECT * FROM encounters WHERE id = ?", (encounter_id,)).fetchone()
    if enc is None:
        return jsonify(error="encounter not found"), 404
    if enc["user_id"] != session["user_id"]:
        return jsonify(error="not your encounter"), 403
    enc = expire_if_stale(db, enc)
    monster = db.execute("SELECT * FROM monsters WHERE id = ?", (enc["monster_id"],)).fetchone()
    return jsonify(
        id=enc["id"], status=enc["status"], monster_hp=enc["monster_hp"],
        monster_max_hp=monster["max_hp"], monster_name=monster["name"],
        expires_at=enc["expires_at"],
    )


@app.route("/api/rpg/encounters/<int:encounter_id>/abandon", methods=["POST"])
@login_required
def abandon_encounter(encounter_id):
    """Lets the player intentionally give up on an active encounter to
    choose a different monster — no XP, no Gold, no defeat credit. Only
    the encounter owner can abandon it, and only while it's still active
    (already-completed/abandoned encounters return 409, matching the
    idempotent-failure style used elsewhere in this file)."""
    db = get_db()
    enc = db.execute("SELECT * FROM encounters WHERE id = ?", (encounter_id,)).fetchone()
    if enc is None:
        return jsonify(error="encounter not found"), 404
    if enc["user_id"] != session["user_id"]:
        return jsonify(error="not your encounter"), 403
    if enc["status"] != "active":
        return jsonify(error="encounter is not active"), 409
    db.execute(
        "UPDATE encounters SET status = 'abandoned', completed_at = ? WHERE id = ?",
        (time.time(), encounter_id),
    )
    db.commit()
    return jsonify(status="abandoned")


@app.route("/api/rpg/encounters/<int:encounter_id>/hit", methods=["POST"])
@login_required
def submit_hit(encounter_id):
    """Applies damage from AI-detected valid push-up reps. The client
    sends the NUMBER OF REPS it detected (same anti-cheat-bounded value
    the existing PvP submit endpoint accepts) — NEVER a raw damage number.
    The server computes damage from reps using the fixed, server-side
    formula, exactly like PvP push-up counts are validated, not trusted
    as pre-computed results."""
    body = request.json or {}
    reps = body.get("reps")
    user_id = session["user_id"]

    if not isinstance(reps, int) or isinstance(reps, bool) or reps < 0:
        return jsonify(error="valid reps required"), 400
    if reps > RPG_MAX_REPS_PER_HIT:
        return jsonify(error="reps exceed plausible maximum for a single hit"), 400

    db = get_db()
    enc = db.execute("SELECT * FROM encounters WHERE id = ?", (encounter_id,)).fetchone()
    if enc is None:
        return jsonify(error="encounter not found"), 404
    if enc["user_id"] != user_id:
        return jsonify(error="not your encounter"), 403
    enc = expire_if_stale(db, enc)
    if enc["status"] != "active":
        return jsonify(error="encounter is not active"), 409

    damage = reps * RPG_BASE_DAMAGE_PER_REP
    new_hp = max(0, enc["monster_hp"] - damage)

    # Atomic claim on the HP update — mirrors the PvP submit's conditional
    # UPDATE pattern, so two concurrent hit requests for the same
    # encounter can't both apply damage from a stale HP read.
    cur = db.execute(
        "UPDATE encounters SET monster_hp = ? WHERE id = ? AND status = 'active' AND monster_hp = ?",
        (new_hp, encounter_id, enc["monster_hp"]),
    )
    db.commit()
    if cur.rowcount == 0:
        # Someone/something else changed the HP between our read and
        # write (concurrent hit) — fetch fresh state and report it rather
        # than silently dropping the damage.
        enc = db.execute("SELECT * FROM encounters WHERE id = ?", (encounter_id,)).fetchone()
        return jsonify(error="encounter state changed, please retry", monster_hp=enc["monster_hp"]), 409

    db.execute(
        "UPDATE rpg_players SET total_damage = total_damage + ?, updated_at = ? WHERE user_id = ?",
        (damage, time.time(), user_id),
    )
    # V1.6: users.total_pushups must represent ALL valid push-ups across
    # both PvP and RPG. PvP already updates it at match finalization; this
    # is the RPG-side equivalent — incremented here, exactly once, only
    # for reps the server just accepted (the atomic HP-claim above already
    # guarantees this code path runs once per accepted hit, not per retry).
    db.execute(
        "UPDATE users SET total_pushups = total_pushups + ? WHERE id = ?",
        (reps, user_id),
    )
    db.commit()

    result = {"monster_hp": new_hp, "damage_dealt": damage, "defeated": False}

    if new_hp <= 0:
        result["defeated"] = _finalize_encounter_victory(db, encounter_id, user_id)

    return jsonify(result)


def _finalize_encounter_victory(db, encounter_id, user_id):
    """Atomically claims encounter completion and grants the reward
    exactly once — same claim-then-reward pattern as PvP finalize_match/
    award_xp. Returns the reward dict, or False if another concurrent
    request already completed this encounter (rowcount 0)."""
    claimed = db.execute(
        "UPDATE encounters SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'active'",
        (time.time(), encounter_id),
    )
    db.commit()
    if claimed.rowcount == 0:
        return False

    enc = db.execute("SELECT * FROM encounters WHERE id = ?", (encounter_id,)).fetchone()
    monster = db.execute("SELECT * FROM monsters WHERE id = ?", (enc["monster_id"],)).fetchone()
    player_before = db.execute("SELECT rpg_xp FROM rpg_players WHERE user_id = ?", (user_id,)).fetchone()
    level_before = get_rpg_level_from_xp(player_before["rpg_xp"])

    award_rpg_reward(db, user_id, "rpg_xp", monster["xp_reward"], "monster_defeat", encounter_id)
    award_rpg_reward(db, user_id, "gold", monster["gold_reward"], "monster_defeat", encounter_id)
    db.execute(
        "UPDATE rpg_players SET monsters_defeated = monsters_defeated + 1, updated_at = ? WHERE user_id = ?",
        (time.time(), user_id),
    )
    db.commit()

    player_after = db.execute("SELECT rpg_xp, monsters_defeated FROM rpg_players WHERE user_id = ?", (user_id,)).fetchone()
    level_after = get_rpg_level_from_xp(player_after["rpg_xp"])
    check_and_unlock_rpg_achievements(db, user_id, monster["name"], player_after["monsters_defeated"], level_after)
    db.commit()
    return {
        "monster_name": monster["name"], "xp_reward": monster["xp_reward"], "gold_reward": monster["gold_reward"],
        "leveled_up": level_after > level_before, "new_rpg_level": level_after,
    }


def check_and_unlock_rpg_achievements(db, user_id, monster_name, monsters_defeated, rpg_level):
    """RPG-side counterpart to check_and_unlock_achievements() — same
    idempotent unlock_achievement() helper, just triggered by monster
    defeats/RPG level instead of PvP match results. No triggering_match_id
    is set (these aren't PvP matches)."""
    if monsters_defeated >= 1:
        unlock_achievement(db, user_id, "MONSTER_SLAYER")
    if monsters_defeated >= 10:
        unlock_achievement(db, user_id, "GOBLIN_HUNTER")
    if monster_name == "Dragon":
        unlock_achievement(db, user_id, "DRAGON_SLAYER")
    if rpg_level >= 10:
        unlock_achievement(db, user_id, "RPG_VETERAN")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
def find_active_match_for_user(db, user_id):
    # V1.2: "active" now covers both the READY phase and IN_PROGRESS — a
    # match the user should be resumed into on refresh, or that blocks them
    # from queueing for a second one, includes both states.
    return db.execute(
        """SELECT * FROM matches
           WHERE (player1_id = ? OR player2_id = ?) AND status IN ('ready', 'in_progress')
           ORDER BY id DESC LIMIT 1""",
        (user_id, user_id),
    ).fetchone()


def finalize_match(db, match_id):
    """Atomically claims and resolves a match. Safe to call from multiple
    concurrent requests for the same match_id — only the caller that wins
    the conditional UPDATE below actually applies the Elo change."""
    claimed = db.execute(
        "UPDATE matches SET status = 'completed' WHERE id = ? AND status = 'in_progress'",
        (match_id,),
    )
    db.commit()
    if claimed.rowcount == 0:
        return

    match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    p1, p2 = match["player1_id"], match["player2_id"]
    c1, c2 = match["player1_count"] or 0, match["player2_count"] or 0
    u1 = db.execute("SELECT * FROM users WHERE id = ?", (p1,)).fetchone()
    u2 = db.execute("SELECT * FROM users WHERE id = ?", (p2,)).fetchone()

    if c1 > c2:
        winner_id, score1 = p1, 1
    elif c2 > c1:
        winner_id, score1 = p2, 0
    else:
        winner_id, score1 = None, 0.5

    new_elo1, new_elo2 = update_elo(u1["elo"], u2["elo"], score1)

    def apply_result(user, count, my_elo, score):
        best = max(user["best_pushups"], count)
        peak = max(user["peak_elo"], my_elo)
        total_pu = user["total_pushups"] + count
        if score == 1:
            streak = user["current_streak"] + 1
            result_col = "wins = wins + 1"
        elif score == 0:
            streak = 0
            result_col = "losses = losses + 1"
        else:
            streak = 0
            result_col = "draws = draws + 1"
        longest = max(user["longest_streak"], streak)
        db.execute(
            f"""UPDATE users SET elo = ?, best_pushups = ?, current_streak = ?,
                peak_elo = ?, total_pushups = ?, longest_streak = ?,
                {result_col} WHERE id = ?""",
            (my_elo, best, streak, peak, total_pu, longest, user["id"]),
        )

    apply_result(u1, c1, new_elo1, score1)
    apply_result(u2, c2, new_elo2, 1 - score1)
    db.execute(
        """UPDATE matches SET winner_id = ?,
           player1_elo_before = ?, player1_elo_after = ?,
           player2_elo_before = ?, player2_elo_after = ?
           WHERE id = ?""",
        (winner_id, u1["elo"], new_elo1, u2["elo"], new_elo2, match["id"]),
    )
    db.commit()

    # --- V1.3: XP + achievements. Awarded server-side only, right here,
    # using the ORIGINAL (pre-match) best_pushups captured in u1/u2 above
    # to correctly detect a genuine new personal best. award_xp() and
    # unlock_achievement() are both idempotent (unique-constraint backed),
    # so even though this whole finalize_match() only ever runs once per
    # match (guarded by the atomic status claim above), the awarding
    # helpers are safe in isolation too.
    for user_row, count, score in ((u1, c1, score1), (u2, c2, 1 - score1)):
        uid = user_row["id"]
        award_xp(db, uid, XP_MATCH_COMPLETED, "match_completed", match_id)
        if score == 1:
            award_xp(db, uid, XP_WIN, "win", match_id)
        elif score == 0:
            award_xp(db, uid, XP_LOSS, "loss", match_id)
        else:
            award_xp(db, uid, XP_DRAW, "draw", match_id)
        is_new_pb = count >= user_row["best_pushups"] and count > 0
        if is_new_pb:
            award_xp(db, uid, XP_PERSONAL_BEST, "personal_best", match_id)
        db.commit()
        # V1.4: friend-activity-feed events — only for genuinely notable
        # transitions (not every match), so the feed doesn't get spammy.
        old_xp = user_row["xp"]
        new_xp = db.execute("SELECT xp FROM users WHERE id = ?", (uid,)).fetchone()["xp"]
        if get_level_from_xp(new_xp) > get_level_from_xp(old_xp):
            create_activity(db, uid, ACTIVITY_LEVEL_UP, get_level_from_xp(new_xp))
        if is_new_pb:
            create_activity(db, uid, ACTIVITY_PERSONAL_BEST, count)
        new_streak = db.execute("SELECT current_streak FROM users WHERE id = ?", (uid,)).fetchone()["current_streak"]
        if new_streak in WIN_STREAK_MILESTONES:
            create_activity(db, uid, ACTIVITY_WIN_STREAK, new_streak)
        old_rank = get_rank_from_elo(user_row["elo"])
        new_elo_val = new_elo1 if uid == p1 else new_elo2
        new_rank = get_rank_from_elo(new_elo_val)
        rank_order = [name for _, name in RANK_TIERS]
        if rank_order.index(new_rank) > rank_order.index(old_rank):
            create_activity(db, uid, ACTIVITY_RANK_REACHED, None)
        newly_unlocked = check_and_unlock_achievements(db, uid, is_new_pb, match_id)
        if winner_id == uid:
            opponent_id = p2 if uid == p1 else p1
            wins_vs_opponent = db.execute(
                """SELECT COUNT(*) c FROM matches WHERE status = 'completed' AND winner_id = ?
                   AND ((player1_id = ? AND player2_id = ?) OR (player1_id = ? AND player2_id = ?))""",
                (uid, uid, opponent_id, opponent_id, uid),
            ).fetchone()["c"]
            if wins_vs_opponent >= 3:
                rival_result = unlock_achievement(db, uid, "RIVAL", match_id)
                if rival_result:
                    newly_unlocked.append(rival_result)
        for ach in newly_unlocked:
            create_activity(db, uid, ACTIVITY_ACHIEVEMENT_UNLOCKED, ach["code"])
    db.commit()


# ---------------------------------------------------------------------------
# V1.3: XP + achievement helpers
# ---------------------------------------------------------------------------
def award_xp(db, user_id, amount, reason, reference_id):
    """Awards XP exactly once per (user, reason, reference_id) — enforced
    by a UNIQUE constraint on xp_transactions, so concurrent or duplicate
    calls for the same event are safely ignored (INSERT fails, no XP is
    double-added). Returns True if this call newly awarded XP."""
    try:
        db.execute(
            "INSERT INTO xp_transactions (user_id, amount, reason, reference_id, created_at) VALUES (?, ?, ?, ?, ?)",
            (user_id, amount, reason, reference_id, time.time()),
        )
    except sqlite3.IntegrityError:
        return False
    db.execute("UPDATE users SET xp = xp + ? WHERE id = ?", (amount, user_id))
    return True


# ---------------------------------------------------------------------------
# V1.5: RPG helpers
# ---------------------------------------------------------------------------
def get_or_create_rpg_player(db, user_id):
    row = db.execute("SELECT * FROM rpg_players WHERE user_id = ?", (user_id,)).fetchone()
    if row is not None:
        return row
    now = time.time()
    db.execute(
        "INSERT INTO rpg_players (user_id, created_at, updated_at) VALUES (?, ?, ?)",
        (user_id, now, now),
    )
    db.commit()
    return db.execute("SELECT * FROM rpg_players WHERE user_id = ?", (user_id,)).fetchone()


def award_rpg_reward(db, user_id, transaction_type, amount, reason, reference_id):
    """RPG equivalent of award_xp() — SAME idempotency pattern (unique
    constraint on the transaction row). transaction_type is 'rpg_xp' or
    'gold'. Returns True if this call newly granted the reward."""
    try:
        db.execute(
            """INSERT INTO rpg_transactions (user_id, transaction_type, amount, reason, reference_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (user_id, transaction_type, amount, reason, reference_id, time.time()),
        )
    except sqlite3.IntegrityError:
        return False
    col = "rpg_xp" if transaction_type == "rpg_xp" else "gold"
    db.execute(
        f"UPDATE rpg_players SET {col} = {col} + ?, updated_at = ? WHERE user_id = ?",
        (amount, time.time(), user_id),
    )
    return True


def unlock_achievement(db, user_id, code, match_id=None):
    """Unlocks an achievement exactly once — enforced by the
    UNIQUE(user_id, achievement_id) constraint on user_achievements, so
    concurrent duplicate unlock attempts are safely ignored (only one
    INSERT wins; SQLite's write-lock serializes the race). Returns the
    achievement dict if newly unlocked by this call, else None."""
    ach = db.execute("SELECT * FROM achievements WHERE code = ?", (code,)).fetchone()
    if not ach:
        return None
    try:
        db.execute(
            "INSERT INTO user_achievements (user_id, achievement_id, unlocked_at, triggering_match_id) VALUES (?, ?, ?, ?)",
            (user_id, ach["id"], time.time(), match_id),
        )
    except sqlite3.IntegrityError:
        return None
    award_xp(db, user_id, ach["xp_reward"], "achievement", ach["id"])
    return {
        "code": ach["code"], "name": ach["name"], "description": ach["description"],
        "icon": ach["icon"], "xp_reward": ach["xp_reward"],
    }


def check_and_unlock_achievements(db, user_id, is_new_personal_best, match_id=None):
    """Server-side achievement evaluation — reads FRESH stats from the DB
    (never trusts the client) and unlocks anything newly earned. Safe to
    call redundantly; already-unlocked achievements are no-ops."""
    u = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    total_matches = u["wins"] + u["losses"] + u["draws"]
    unlocked = []

    def try_unlock(code):
        result = unlock_achievement(db, user_id, code, match_id)
        if result:
            unlocked.append(result)

    if total_matches >= 1:
        try_unlock("FIRST_MATCH")
    if u["total_pushups"] >= 1:
        try_unlock("FIRST_REP")
    if u["wins"] >= 1:
        try_unlock("FIRST_WIN")
    if total_matches >= 10:
        try_unlock("TEN_MATCHES")
    if u["total_pushups"] >= 100:
        try_unlock("HUNDRED_PUSHUPS")
    if u["wins"] >= 10:
        try_unlock("TEN_WINS")
    if u["current_streak"] >= 5:
        try_unlock("FIVE_WIN_STREAK")
    if u["current_streak"] >= 10:
        try_unlock("TEN_WIN_STREAK")
    if u["elo"] >= 1200:
        try_unlock("REACH_SILVER")
    if u["elo"] >= 1500:
        try_unlock("REACH_1500")
    if u["elo"] >= 1800:
        try_unlock("REACH_1800")
    if u["elo"] >= 2000:
        try_unlock("REACH_2000")
    if is_new_personal_best:
        try_unlock("PERSONAL_BEST")
    if u["total_pushups"] >= 1000:
        try_unlock("THOUSAND_PUSHUPS")
    if u["total_pushups"] >= 5000:
        try_unlock("FIVE_THOUSAND_PUSHUPS")

    return unlocked


def get_match_progression_for_user(db, match_id, user_id):
    """Derives 'what did THIS match do for THIS player' (XP, achievements,
    level-up) purely from persisted, idempotent state — xp_transactions
    rows keyed by reference_id=match_id, and user_achievements rows whose
    triggering_match_id matches. This works correctly regardless of WHICH
    of the two players' requests actually triggered finalize_match(),
    since both players independently query their own progression here."""
    me = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()

    xp_row = db.execute(
        """SELECT COALESCE(SUM(amount), 0) AS total FROM xp_transactions
           WHERE user_id = ? AND reference_id = ?
             AND reason IN ('match_completed', 'win', 'draw', 'loss', 'personal_best')""",
        (user_id, match_id),
    ).fetchone()
    xp_from_match = xp_row["total"]

    ach_rows = db.execute(
        """SELECT a.code, a.name, a.description, a.icon, a.xp_reward FROM user_achievements ua
           JOIN achievements a ON a.id = ua.achievement_id
           WHERE ua.user_id = ? AND ua.triggering_match_id = ?""",
        (user_id, match_id),
    ).fetchall()
    achievements = [dict(r) for r in ach_rows]
    xp_awarded = xp_from_match + sum(a["xp_reward"] for a in achievements)

    xp_after = me["xp"]
    xp_before = xp_after - xp_awarded
    level_before = get_level_from_xp(max(0, xp_before))
    level_after = get_level_from_xp(xp_after)

    return {
        "xp_awarded": xp_awarded,
        "achievements_unlocked": achievements,
        "leveled_up": level_after > level_before,
        "new_level": level_after,
        "your_xp": xp_after,
    }


def user_to_dict(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "elo": row["elo"],
        "wins": row["wins"],
        "losses": row["losses"],
        "draws": row["draws"],
        "best_pushups": row["best_pushups"],
        "current_streak": row["current_streak"],
        "xp": row["xp"],
        "level": get_level_from_xp(row["xp"]),
        "rank_tier": get_rank_from_elo(row["elo"]),
        "avatar_id": row["avatar_id"],
    }


def match_to_dict(db, match):
    p1 = db.execute("SELECT * FROM users WHERE id = ?", (match["player1_id"],)).fetchone()
    p2 = db.execute("SELECT * FROM users WHERE id = ?", (match["player2_id"],)).fetchone()
    return {
        "id": match["id"],
        "status": match["status"],
        "is_bot_match": bool(match["is_bot_match"]),
        "player1": user_to_dict(p1),
        "player2": user_to_dict(p2),
        "player1_count": match["player1_count"],
        "player2_count": match["player2_count"],
        "winner_id": match["winner_id"],
        "match_duration_seconds": MATCH_DURATION_SECONDS,
        "started_at": match["started_at"],
        "exercise_starts_at": match["exercise_starts_at"],
        "expires_at": match["expires_at"],
        "player1_ready": bool(match["player1_ready"]),
        "player2_ready": bool(match["player2_ready"]),
        "ready_deadline": match["ready_deadline"],
    }


# Runs whenever this module is imported — by `python app.py` for local
# dev AND by gunicorn/any WSGI server in production (which imports `app`
# directly and never executes the `if __name__ == "__main__"` block below).
# Safe to call on every startup: init_db() is idempotent.
init_db()

if __name__ == "__main__":
    # debug=True and the Werkzeug dev server are for LOCAL DEVELOPMENT ONLY.
    # In production, gunicorn (see Procfile) serves `app` directly and this
    # block never runs — see DEPLOYMENT.md for production setup.
    app.run(debug=True, host="0.0.0.0", port=5000, threaded=True)