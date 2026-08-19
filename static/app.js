// =============================================================================
// VISOREP — client
// V1.2: proper Ready state machine (WAITING -> READY -> IN_PROGRESS ->
// COMPLETED), server-synchronized countdown/timer, rematch flow. All V1.1
// protections (CSRF header, resume-after-refresh, stricter AI detection,
// manual-tap cooldown, resilient polling, nav-lock during match) preserved.
// =============================================================================

const CONFIG = {
  DOWN_ANGLE: 90,
  UP_ANGLE: 160,
  MIN_SHOULDER_MOVEMENT_RATIO: 0.025, // V1.16: was 0.035 — see note on MIN_SHOULDER_MOVEMENT_RATIO_OF_TORSO below (this is only the frame-relative fallback, rarely the active path)
  // V1.20: split PvP/RPG — see below. This shared constant is GONE;
  // replaced by PVP_MIN_REP_INTERVAL_MS / RPG_MIN_REP_INTERVAL_MS.
  MIN_LANDMARK_VISIBILITY: 0.5,
  MIN_BODY_VISIBILITY: 0.35,
  MAX_HIP_DEVIATION_RATIO: 0.13, // hip's perpendicular distance from the shoulder-ankle line, as a fraction of body length — see computeHipAlignment()
  MAX_PUSHUPS_60S: 150,
  FEEDBACK_MIN_DISPLAY_MS: 800,
  POSE_MODEL_TIMEOUT_MS: 15000,
  MATCH_DURATION_SECONDS: 60,
  READY_POLL_MS: 1000,
  REMATCH_POLL_MS: 1500,
  CAMERA_READY_STABILITY_MS: 1000, // all conditions must hold continuously this long before auto-ready fires
  RPG_COUNTDOWN_STEP_MS: 700, // duration each of "3", "2", "1", "GO!" is shown for
  MIN_LIGHTING_BRIGHTNESS: 40, // 0-255 average luma; below this is flagged as too dark

  // --- Rep-counting reliability (root-cause fixes, not "maximum strictness") ---
  // A threshold crossing must hold for this many CONSECUTIVE frames before
  // the state actually transitions — filters single-frame pose jitter from
  // flipping the state machine on its own. Split into two directions:
  // V1.18: entering "down" only used to require the SAME 2-frame confirm
  // as completing the rep — but that ate into the very short down-phase
  // window of a genuinely fast push-up (done explosively, e.g. right at
  // the start of a match when someone goes all-out), so the bottom
  // position was sometimes never even confirmed before the angle bounced
  // back up, and the rep was silently dropped before it ever reached the
  // shoulder-movement/timing checks below. Entering "down" doesn't count
  // anything by itself — the shoulder-movement threshold and the UP-side
  // confirm below are what actually guard against a fake/jitter rep — so
  // relaxing this side to 1 frame costs no protection.
  DOWN_STATE_CONFIRM_FRAMES: 1,
  // V1.20: PvP and RPG have different products goals — PvP is a speed
  // competition (accuracy is secondary to responsiveness), RPG is not
  // (the player isn't racing anyone, so form/stability matters more than
  // shaving frames). Split accordingly instead of forcing one value to
  // serve both.
  //
  // PvP: 1 frame — the FIRST frame the angle clears UP_ANGLE commits the
  // rep. A genuinely explosive push-up's up-phase can be very short; any
  // extra confirm frame here directly adds latency/dropped-rep risk for
  // exactly the fast reps PvP is supposed to reward. This does NOT
  // remove rep validation — shoulderMoved (real peak displacement),
  // repWasValidThroughout (continuous visibility during the down phase),
  // and PVP_MIN_REP_INTERVAL_MS below are unchanged and still have to
  // pass before a rep counts; only the "wait one more frame after the
  // angle already cleared" tax is gone.
  PVP_UP_STATE_CONFIRM_FRAMES: 1,
  // RPG: unchanged at 2 — no product reason to relax it, so it keeps the
  // extra frame of resistance to a single noisy angle spike.
  RPG_UP_STATE_CONFIRM_FRAMES: 2,
  // During the "down" phase of a rep, framing/alignment may briefly drop
  // out (this many consecutive bad frames is tolerated) without
  // invalidating the rep — but a SUSTAINED loss (e.g. only head/upper
  // body visible for the bulk of the movement) does invalidate it, even
  // if visibility happens to look fine again by the moment the rep
  // completes. This is what "canCount checked only at the final frame"
  // was missing.
  REP_VALIDITY_GRACE_FRAMES: 3,
  // Estimated fraction of the person's own shoulder-to-hip pixel distance
  // (not a fixed fraction of the raw video frame) the shoulder must move
  // vertically for a rep to count. Normalizing by body scale means the
  // same real-world movement counts consistently whether the camera is
  // close or far — untested against a real camera, expect to tune.
  // V1.16 calibration fix: the ROOT CAUSE of valid reps being rejected
  // after the landmark-stability pass was traced (not guessed) to how
  // shoulder movement was measured — see downShoulderYExtreme in
  // detectionLoop/rpgDetectionLoop. It used to compare two single
  // instantaneous samples taken exactly at the down/up transition
  // instants; EMA smoothing (needed for landmark stability) attenuates
  // the amplitude of a signal sampled that way, so genuine movement could
  // be undercounted. Fixed at the SOURCE by tracking the actual peak
  // displacement reached at any point during the down phase instead of
  // two boundary samples — that fix alone recovers most of the lost
  // signal. This threshold is ALSO modestly relaxed (was 0.18) as a
  // safety margin for the smoothing that necessarily still exists even in
  // the peak value. Reasoned from the tracking pipeline's behavior, not
  // yet validated against real camera footage — expect to tune further
  // once real push-ups are actually tested.
  MIN_SHOULDER_MOVEMENT_RATIO_OF_TORSO: 0.13,

  // V1.20: MIN_REP_INTERVAL_MS split PvP/RPG — its ONLY job is stopping
  // one physical push-up's bottom-of-rep bounce from being counted as two
  // reps; it is a debounce floor, not a speed cap (real protection
  // against fake/partial reps is the angle debounce + shoulderMoved peak-
  // displacement check above, both unchanged).
  //
  // PvP: 150ms — was 300ms (shared value, tuned before PvP/RPG were
  // split). PvP explicitly rewards speed, and a genuinely fast competitive
  // push-up cadence can run under 300ms rep-to-rep, so that floor was
  // itself capping legitimate speed. 150ms is still comfortably longer
  // than a single bounce/oscillation at the bottom of ONE rep (which
  // registers as a few tens of ms at most between angle samples), so
  // double-counting protection is intact.
  PVP_MIN_REP_INTERVAL_MS: 150,
  // RPG: unchanged at 300ms — no product reason to relax it.
  RPG_MIN_REP_INTERVAL_MS: 300,

  // --- V1.15: landmark side-lock + temporal stability (root-cause fix for
  // the shoulder/elbow/wrist "jumping between joints / switching sides"
  // problem — see poseTracker* below) ---
  POSE_SIDE_SWITCH_CONFIRM_FRAMES: 8, // the OTHER side must be clearly better for this many CONSECUTIVE frames before we switch
  POSE_SIDE_SWITCH_MARGIN: 0.20,      // "clearly better" = otherVis - lockedVis exceeds this, on the same 0-3 visibility-sum scale as leftVis/rightVis
  LANDMARK_SMOOTHING_ALPHA: 0.35,     // EMA weight on the new raw sample; higher = more responsive, lower = smoother/laggier
  // V1.19: was 0.12 — too tight for a genuinely FAST push-up. A person
  // exploding through a rep can move their shoulder/elbow/wrist well over
  // 12% of the frame between two processed inference frames (frame-to-
  // frame gaps aren't constant — pose inference itself, not just the
  // camera, sets the effective rate). At 0.12 that fast, correct motion
  // kept getting misread as a "jump" and held/frozen — see
  // LANDMARK_REACQUIRE_FRAMES below for what that did to fast reps.
  // Raised to give real fast motion room; the SEPARATE anatomy-geometry
  // check (ANATOMY_RATIO_TOLERANCE) still catches actual misdetections,
  // since a wrongly-placed landmark almost always breaks arm proportions
  // too, regardless of how far it jumped.
  MAX_LANDMARK_JUMP: 0.22,
  ANATOMY_RATIO_TOLERANCE: 0.45,      // max fractional change (this frame vs person's own recent running-average) allowed in shoulder-elbow / elbow-wrist distance before the frame is treated as noisy
  UNSTABLE_TRACKING_FRAMES: 15,       // consecutive noisy/held frames before we surface "AI is re-locking your arm" instead of silently guessing
  // V1.17 fix: a jump/geometry "hold" used to have no way back — if the
  // raw sample kept landing far from the (now stale) anchor, e.g. because
  // the person stepped out of frame and back in, it held forever and the
  // red dots never re-found the joint. This many CONSECUTIVE frames of
  // the raw sample disagreeing with the anchor is treated as a genuine
  // re-lock instead of noise, and the tracker snaps to the new position.
  // V1.19: was 6 — with a fast/continuous rep (not a return-to-frame
  // event), every held frame freezes the angle entirely, so 6 held frames
  // in a row could silently swallow an entire rep transition (angle
  // never crosses DOWN_ANGLE while frozen). Combined with the
  // MAX_LANDMARK_JUMP raise above, actual re-lock events should now be
  // rarer AND cheaper when they do happen.
  LANDMARK_REACQUIRE_FRAMES: 3,
};

const API = "/api";
let me = null;
let currentMatchId = null;
let matchTimerInterval = null;
let queuePollInterval = null;
let resultPollInterval = null;
let readyPollInterval = null;
let rematchPollInterval = null;
let waitingSecondsElapsed = 0;
let pushupCount = 0;
let currentOpponent = null;
let iAmPlayer1 = null;

const screens = {
  login: document.getElementById("loginScreen"),
  lobby: document.getElementById("lobbyScreen"),
  profile: document.getElementById("profileScreen"),
  friends: document.getElementById("friendsScreen"),
  publicProfile: document.getElementById("publicProfileScreen"),
  waiting: document.getElementById("waitingScreen"),
  ready: document.getElementById("readyScreen"),
  match: document.getElementById("matchScreen"),
  pending: document.getElementById("pendingResultScreen"),
  result: document.getElementById("resultScreen"),
  cameraSetup: document.getElementById("cameraSetupScreen"),
};

const IN_MATCH_SCREENS = new Set(["ready", "match", "pending", "cameraSetup"]);

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
  const homeBtn = document.getElementById("navHomeBtn");
  const profileBtn = document.getElementById("navProfileBtn");
  const friendsBtn = document.getElementById("navFriendsBtn");
  if (name === "lobby") setActiveNav(homeBtn);
  else if (name === "profile") setActiveNav(profileBtn);
  else if (name === "friends") setActiveNav(friendsBtn);
  setNavEnabled(!IN_MATCH_SCREENS.has(name));
}

function setNavEnabled(enabled) {
  ["navHomeBtn", "navFriendsBtn", "navProfileBtn", "logoutBtn", "notifBellBtn"].forEach(id => {
    const btn = document.getElementById(id);
    btn.disabled = !enabled;
    btn.classList.toggle("navDisabled", !enabled);
  });
}

function stopAllPolling() {
  clearInterval(queuePollInterval);
  clearInterval(resultPollInterval);
  clearInterval(readyPollInterval);
  clearInterval(rematchPollInterval);
  clearInterval(matchTimerInterval);
  clearInterval(liveCountPollInterval);
  stopReadyCameraCheck();
}

// ---------------------------------------------------------------- API helper
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "PushUpEloClient",
      },
      credentials: "same-origin",
      ...options,
    });
  } catch (networkErr) {
    showConnectionBanner();
    throw new Error("network error — please check your connection");
  }
  hideConnectionBanner();

  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

// Camera-active indicator: a visible "🔴 CAMERA ACTIVE" pill shown ONLY
// while a given camera stream is genuinely live, toggled right alongside
// the actual getUserMedia()/getTracks().stop() calls below — never on
// login/signup/home/profile/notifications, since nothing there ever
// touches the camera in the first place.
// SECURITY: usernames are user-controlled and rendered via innerHTML in
// several list views (leaderboards, friend lists/requests, notifications).
// Escape before interpolating — the alternative is stored XSS via a
// malicious username (e.g. signing up as `<img src=x onerror=...>`).
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function setCameraActiveIndicator(elementId, active) {
  const el = document.getElementById(elementId);
  if (el) el.classList.toggle("hidden", !active);
}

let connectionBannerTimeout = null;
function showConnectionBanner() {
  const el = document.getElementById("connectionBanner");
  el.classList.remove("hidden");
  clearTimeout(connectionBannerTimeout);
  connectionBannerTimeout = setTimeout(() => el.classList.add("hidden"), 4000);
}
function hideConnectionBanner() {
  document.getElementById("connectionBanner").classList.add("hidden");
}

let noticeBannerTimeout = null;
function showNotice(text, ms = 4000) {
  const el = document.getElementById("noticeBanner");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(noticeBannerTimeout);
  noticeBannerTimeout = setTimeout(() => el.classList.add("hidden"), ms);
}

function updateUserBadge() {
  document.getElementById("userBadge").classList.remove("hidden");
  document.getElementById("userName").textContent = me.username;
  document.getElementById("userElo").textContent = me.elo;
}

// ---------------------------------------------------------------- bootstrap
(async function bootstrap() {
  // Reveal the Google buttons only if the server actually has OAuth
  // configured — otherwise clicking them would just 503.
  try {
    const g = await api("/auth/google/status");
    if (g.available) {
      document.getElementById("googleLoginBtn").classList.remove("hidden");
      document.getElementById("googleSignupBtn").classList.remove("hidden");
    }
  } catch (e) { /* non-critical */ }

  // A password-reset email link lands here as /?reset_token=... — pick it
  // up, show the reset form, then scrub the token out of the visible URL.
  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get("reset_token");
  if (params.get("google_login") === "success") {
    history.replaceState({}, "", window.location.pathname);
  } else if (params.get("google_error")) {
    showNotice(`⚠️ Google sign-in failed (${params.get("google_error")})`);
    history.replaceState({}, "", window.location.pathname);
  }

  try {
    me = await api("/me");
    updateUserBadge();
    await resumeActiveMatchIfAny();
  } catch (e) {
    showScreen("login");
    if (resetToken) {
      showAuthForm("reset");
      document.getElementById("resetPasswordForm").dataset.token = resetToken;
      history.replaceState({}, "", window.location.pathname);
    }
  }
})();

// ---------------------------------------------------------------- auth sub-forms
// loginForm / signupForm / forgotPasswordForm / resetPasswordForm are all
// panels within loginScreen — this toggles which one is visible, separately
// from showScreen() (which operates at the whole-screen level).
function showAuthForm(which) {
  const forms = { login: "loginForm", signup: "signupForm", forgot: "forgotPasswordForm", reset: "resetPasswordForm" };
  Object.values(forms).forEach(id => document.getElementById(id).classList.add("hidden"));
  document.getElementById(forms[which]).classList.remove("hidden");
  document.getElementById("tabLoginBtn").classList.toggle("active", which === "login");
  document.getElementById("tabSignupBtn").classList.toggle("active", which === "signup");
}

document.getElementById("forgotPasswordLinkBtn").addEventListener("click", () => showAuthForm("forgot"));
document.getElementById("forgotPasswordBackBtn").addEventListener("click", () => showAuthForm("login"));

document.getElementById("forgotPasswordSubmitBtn").addEventListener("click", async () => {
  const email = document.getElementById("forgotPasswordEmailInput").value.trim();
  const msgEl = document.getElementById("forgotPasswordMsg");
  const errEl = document.getElementById("forgotPasswordError");
  msgEl.textContent = ""; errEl.textContent = "";
  if (!email) { errEl.textContent = "Please enter your email"; return; }
  try {
    const r = await api("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
    // Dev-mode fallback (no SMTP configured on the server) hands back the
    // link directly instead of pretending an email went out — surface that
    // honestly rather than hiding it.
    msgEl.textContent = r.reset_link
      ? `DEV MODE (no email provider configured): ${r.reset_link}`
      : r.status;
  } catch (e) {
    errEl.textContent = e.message;
  }
});

document.getElementById("resetPasswordSubmitBtn").addEventListener("click", async () => {
  const form = document.getElementById("resetPasswordForm");
  const token = form.dataset.token;
  const password = document.getElementById("resetPasswordInput").value;
  const msgEl = document.getElementById("resetPasswordMsg");
  const errEl = document.getElementById("resetPasswordError");
  msgEl.textContent = ""; errEl.textContent = "";
  if (!token) { errEl.textContent = "Reset link is invalid — please request a new one"; return; }
  if (!password) { errEl.textContent = "Please enter a new password"; return; }
  try {
    await api("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password }) });
    msgEl.textContent = "Password reset — you can log in now.";
    setTimeout(() => showAuthForm("login"), 1500);
  } catch (e) {
    errEl.textContent = e.message;
  }
});

document.getElementById("googleLoginBtn").addEventListener("click", () => {
  window.location.href = API + "/auth/google/login";
});
document.getElementById("googleSignupBtn").addEventListener("click", () => {
  window.location.href = API + "/auth/google/login";
});

// ---------------------------------------------------------------- auth tabs
document.getElementById("tabLoginBtn").addEventListener("click", () => showAuthForm("login"));
document.getElementById("tabSignupBtn").addEventListener("click", () => showAuthForm("signup"));

async function resumeActiveMatchIfAny() {
  try {
    const current = await api("/match/current");

    if (current.cancelled_match_id) {
      showNotice("⚠️ Match cancelled — your opponent wasn't ready in time. No Elo was lost.");
      showScreen("lobby");
      loadLeaderboard();
      return;
    }

    if (!current.active) {
      if (current.waiting_in_queue) {
        waitingSecondsElapsed = 0;
        showScreen("waiting");
        pollQueue();
        return;
      }
      if (current.recent_match_id) {
        try {
          const match = await api(`/match/${current.recent_match_id}`);
          currentMatchId = current.recent_match_id;
          iAmPlayer1 = match.player1.id === me.id;
          currentOpponent = iAmPlayer1 ? match.player2 : match.player1;
          showResult(match);
          return;
        } catch (e) { /* fall through to lobby */ }
      }
      showScreen("lobby");
      loadLeaderboard();
      return;
    }

    currentMatchId = current.match_id;
    const match = await api(`/match/${current.match_id}`);
    iAmPlayer1 = match.player1.id === me.id;
    currentOpponent = iAmPlayer1 ? match.player2 : match.player1;

    if (match.status === "ready") {
      enterReadyScreen(match);
    } else if (match.status === "in_progress") {
      if (current.already_submitted) {
        showScreen("pending");
        document.getElementById("pendingHint").textContent =
          "Reconnecting to your match — waiting for opponent…";
        pollForResult();
      } else {
        // Resume mid-exercise using the server's authoritative timestamps.
        resumeInProgressMatch(match);
      }
    }
  } catch (e) {
    showScreen("lobby");
    loadLeaderboard();
  }
}



// ---------------------------------------------------------------- login
document.getElementById("loginBtn").addEventListener("click", async () => {
  const username = document.getElementById("loginUsernameInput").value.trim();
  const password = document.getElementById("loginPasswordInput").value;
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  if (!username || !password) { errEl.textContent = "Please enter your username and password"; return; }
  try {
    me = await api("/login", { method: "POST", body: JSON.stringify({ username, password }) });
    updateUserBadge();
    await resumeActiveMatchIfAny();
  } catch (e) {
    errEl.textContent = e.message;
  }
});

// ---------------------------------------------------------------- signup
document.getElementById("signupBtn").addEventListener("click", async () => {
  const username = document.getElementById("signupUsernameInput").value.trim();
  const password = document.getElementById("signupPasswordInput").value;
  const email = document.getElementById("signupEmailInput").value.trim();
  const errEl = document.getElementById("signupError");
  errEl.textContent = "";
  if (!username || !password) { errEl.textContent = "Please enter your username and password"; return; }
  try {
    me = await api("/signup", { method: "POST", body: JSON.stringify({ username, password, email: email || undefined }) });
    updateUserBadge();
    showScreen("lobby");
    loadLeaderboard();
  } catch (e) {
    errEl.textContent = e.message;
  }
});

// ---------------------------------------------------------------- logout
document.getElementById("logoutBtn").addEventListener("click", async () => {
  try { await api("/logout", { method: "POST" }); } catch (e) { /* log out locally regardless */ }
  stopAllPolling();
  me = null;
  document.getElementById("userBadge").classList.add("hidden");
  document.getElementById("loginUsernameInput").value = "";
  document.getElementById("loginPasswordInput").value = "";
  showScreen("login");
});

// ---------------------------------------------------------------- nav
function setActiveNav(activeBtn) {
  document.getElementById("navHomeBtn").classList.remove("active");
  document.getElementById("navProfileBtn").classList.remove("active");
  document.getElementById("navFriendsBtn").classList.remove("active");
  activeBtn.classList.add("active");
}

document.getElementById("navHomeBtn").addEventListener("click", () => {
  setActiveNav(document.getElementById("navHomeBtn"));
  loadLeaderboard();
  showScreen("lobby");
});

document.getElementById("navProfileBtn").addEventListener("click", () => {
  setActiveNav(document.getElementById("navProfileBtn"));
  loadProfile();
  showScreen("profile");
});

document.getElementById("navFriendsBtn").addEventListener("click", () => {
  setActiveNav(document.getElementById("navFriendsBtn"));
  loadFriendsScreen();
  showScreen("friends");
});

const OUTCOME_LABELS = { win: "🏆 Won", loss: "😤 Lost", draw: "🤝 Draw" };
const AVATAR_EMOJIS = ["🙂", "😎", "🦁", "🐯", "🐺", "🦅", "🐉", "🥷"]; // index = avatar_id - 1

// Countries selectable on the profile — code list mirrors the server's
// VALID_COUNTRY_CODES whitelist exactly. Sorted by name for the dropdown.
const COUNTRIES = [
  ["AF","Afghanistan"],["AL","Albania"],["DZ","Algeria"],["AD","Andorra"],["AO","Angola"],
  ["AG","Antigua and Barbuda"],["AR","Argentina"],["AM","Armenia"],["AU","Australia"],["AT","Austria"],
  ["AZ","Azerbaijan"],["BS","Bahamas"],["BH","Bahrain"],["BD","Bangladesh"],["BB","Barbados"],
  ["BY","Belarus"],["BE","Belgium"],["BZ","Belize"],["BJ","Benin"],["BT","Bhutan"],
  ["BO","Bolivia"],["BA","Bosnia and Herzegovina"],["BW","Botswana"],["BR","Brazil"],["BN","Brunei"],
  ["BG","Bulgaria"],["BF","Burkina Faso"],["BI","Burundi"],["CV","Cabo Verde"],["KH","Cambodia"],
  ["CM","Cameroon"],["CA","Canada"],["CF","Central African Republic"],["TD","Chad"],["CL","Chile"],
  ["CN","China"],["CO","Colombia"],["KM","Comoros"],["CG","Congo"],["CD","Congo (DRC)"],
  ["CR","Costa Rica"],["CI","Côte d'Ivoire"],["HR","Croatia"],["CU","Cuba"],["CY","Cyprus"],
  ["CZ","Czechia"],["DK","Denmark"],["DJ","Djibouti"],["DM","Dominica"],["DO","Dominican Republic"],
  ["EC","Ecuador"],["EG","Egypt"],["SV","El Salvador"],["GQ","Equatorial Guinea"],["ER","Eritrea"],
  ["EE","Estonia"],["SZ","Eswatini"],["ET","Ethiopia"],["FJ","Fiji"],["FI","Finland"],
  ["FR","France"],["GA","Gabon"],["GM","Gambia"],["GE","Georgia"],["DE","Germany"],
  ["GH","Ghana"],["GR","Greece"],["GD","Grenada"],["GT","Guatemala"],["GN","Guinea"],
  ["GW","Guinea-Bissau"],["GY","Guyana"],["HT","Haiti"],["HN","Honduras"],["HK","Hong Kong"],
  ["HU","Hungary"],["IS","Iceland"],["IN","India"],["ID","Indonesia"],["IR","Iran"],
  ["IQ","Iraq"],["IE","Ireland"],["IL","Israel"],["IT","Italy"],["JM","Jamaica"],
  ["JP","Japan"],["JO","Jordan"],["KZ","Kazakhstan"],["KE","Kenya"],["KI","Kiribati"],
  ["KP","North Korea"],["KR","South Korea"],["KW","Kuwait"],["KG","Kyrgyzstan"],["LA","Laos"],
  ["LV","Latvia"],["LB","Lebanon"],["LS","Lesotho"],["LR","Liberia"],["LY","Libya"],
  ["LI","Liechtenstein"],["LT","Lithuania"],["LU","Luxembourg"],["MO","Macao"],["MG","Madagascar"],
  ["MW","Malawi"],["MY","Malaysia"],["MV","Maldives"],["ML","Mali"],["MT","Malta"],
  ["MH","Marshall Islands"],["MR","Mauritania"],["MU","Mauritius"],["MX","Mexico"],["FM","Micronesia"],
  ["MD","Moldova"],["MC","Monaco"],["MN","Mongolia"],["ME","Montenegro"],["MA","Morocco"],
  ["MZ","Mozambique"],["MM","Myanmar"],["NA","Namibia"],["NR","Nauru"],["NP","Nepal"],
  ["NL","Netherlands"],["NZ","New Zealand"],["NI","Nicaragua"],["NE","Niger"],["NG","Nigeria"],
  ["MK","North Macedonia"],["NO","Norway"],["OM","Oman"],["PK","Pakistan"],["PW","Palau"],
  ["PS","Palestine"],["PA","Panama"],["PG","Papua New Guinea"],["PY","Paraguay"],["PE","Peru"],
  ["PH","Philippines"],["PL","Poland"],["PT","Portugal"],["QA","Qatar"],["RO","Romania"],
  ["RU","Russia"],["RW","Rwanda"],["KN","Saint Kitts and Nevis"],["LC","Saint Lucia"],["VC","Saint Vincent and the Grenadines"],
  ["WS","Samoa"],["SM","San Marino"],["ST","Sao Tome and Principe"],["SA","Saudi Arabia"],["SN","Senegal"],
  ["RS","Serbia"],["SC","Seychelles"],["SL","Sierra Leone"],["SG","Singapore"],["SK","Slovakia"],
  ["SI","Slovenia"],["SB","Solomon Islands"],["SO","Somalia"],["ZA","South Africa"],["SS","South Sudan"],
  ["ES","Spain"],["LK","Sri Lanka"],["SD","Sudan"],["SR","Suriname"],["SE","Sweden"],
  ["CH","Switzerland"],["SY","Syria"],["TW","Taiwan"],["TJ","Tajikistan"],["TZ","Tanzania"],
  ["TH","Thailand"],["TL","Timor-Leste"],["TG","Togo"],["TO","Tonga"],["TT","Trinidad and Tobago"],
  ["TN","Tunisia"],["TR","Turkey"],["TM","Turkmenistan"],["TV","Tuvalu"],["UG","Uganda"],
  ["UA","Ukraine"],["AE","United Arab Emirates"],["GB","United Kingdom"],["US","United States"],["UY","Uruguay"],
  ["UZ","Uzbekistan"],["VU","Vanuatu"],["VA","Vatican City"],["VE","Venezuela"],["VN","Vietnam"],
  ["YE","Yemen"],["ZM","Zambia"],["ZW","Zimbabwe"],
];
const COUNTRY_NAME_BY_CODE = Object.fromEntries(COUNTRIES);

function countryFlagEmoji(code) {
  if (!code || code.length !== 2) return "";
  const base = 127397; // regional indicator 'A' offset from 'A' char code
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => c.charCodeAt(0) + base));
}

// Renders a country value that may be either a known ISO code (new data:
// flag + English name) or legacy free text typed before this feature
// existed (displayed as-is, since we never force-migrate old profiles).
function countryDisplay(value) {
  if (!value) return "";
  const name = COUNTRY_NAME_BY_CODE[value.toUpperCase()];
  return name ? `${countryFlagEmoji(value)} ${name}` : value;
}

let currentProfile = null;
let currentProfileAchievements = [];
let currentAchCategory = "all";


function renderAchievements(achievements, category) {
  currentProfileAchievements = achievements;
  const grid = document.getElementById("achievementsGrid");
  grid.innerHTML = "";
  const filtered = category === "all" ? achievements : achievements.filter(a => a.category === category);
  if (filtered.length === 0) {
    grid.innerHTML = `<p class="hint">No achievements in this category.</p>`;
    return;
  }
  filtered.forEach(a => {
    const card = document.createElement("div");
    card.className = "achCard" + (a.unlocked ? " unlocked" : " locked");
    card.innerHTML = `
      <div class="achCardIcon">${a.unlocked ? a.icon : "🔒"}</div>
      <div class="achCardName">${a.name}</div>
      <div class="achCardDesc">${a.description}</div>
      <div class="achCardFooter">
        <span class="achCardXp">+${a.xp_reward} XP</span>
        <span class="achCardStatus">${a.unlocked ? "✓ UNLOCKED" : "🔒 LOCKED"}</span>
      </div>
    `;
    grid.appendChild(card);
  });
}

document.querySelectorAll(".achCatTab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".achCatTab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentAchCategory = btn.dataset.cat;
    renderAchievements(currentProfileAchievements, currentAchCategory);
  });
});

function avatarEmoji(avatarId) {
  return AVATAR_EMOJIS[(avatarId || 1) - 1] || AVATAR_EMOJIS[0];
}

// Renders a profile picture if one is set, falling back to the emoji
// avatar on load error (e.g. a friends-only picture the viewer can't see,
// or no picture at all) — this is what lets match intro / battle bar show
// real pictures without duplicating the friends-only check client-side.
function renderAvatarInto(imgElId, emojiElId, pictureUrl, avatarId) {
  const img = document.getElementById(imgElId);
  const emoji = document.getElementById(emojiElId);
  if (pictureUrl) {
    img.onerror = () => { img.classList.add("hidden"); emoji.classList.remove("hidden"); };
    img.src = pictureUrl;
    img.classList.remove("hidden");
    emoji.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    emoji.classList.remove("hidden");
  }
  emoji.textContent = avatarEmoji(avatarId);
}

async function loadProfile() {
  try {
    currentProfile = await api("/profile");
  } catch (e) {
    return; // best effort — leave whatever was last rendered
  }
  const p = currentProfile;

  renderAvatarInto("profileAvatarImg", "profileAvatarEmoji", p.profile_picture_url, p.avatar_id);
  document.getElementById("profileUsername").textContent = p.username;
  document.getElementById("profileRankBadge").textContent = `${p.rank_tier} · #${p.elo_rank}`;
  const countryEl = document.getElementById("profileCountry");
  if (p.country) {
    let text = countryDisplay(p.country);
    if (p.country_rank) text += ` · #${p.country_rank} (of ${p.country_player_count.toLocaleString()})`;
    countryEl.textContent = text;
    countryEl.classList.remove("hidden");
  } else { countryEl.classList.add("hidden"); }
  const bioEl = document.getElementById("profileBio");
  if (p.bio) { bioEl.textContent = p.bio; bioEl.classList.remove("hidden"); }
  else { bioEl.classList.add("hidden"); }

  document.getElementById("levelLabel").textContent = `LEVEL ${p.level}`;
  document.getElementById("xpLabel").textContent = `${p.xp - p.xp_for_current_level} / ${p.xp_for_next_level - p.xp_for_current_level} XP`;
  const span = p.xp_for_next_level - p.xp_for_current_level;
  const progress = span > 0 ? Math.min(100, 100 * (p.xp - p.xp_for_current_level) / span) : 100;
  document.getElementById("xpBarFill").style.width = progress + "%";

  document.getElementById("profileElo").textContent = p.elo;
  document.getElementById("profilePeakElo").textContent = p.peak_elo;
  document.getElementById("profileWins").textContent = p.wins;
  document.getElementById("profileLosses").textContent = p.losses;
  document.getElementById("profileDraws").textContent = p.draws;
  document.getElementById("profileWinRate").textContent = p.win_rate + "%";
  document.getElementById("profileBest").textContent = p.best_pushups;
  document.getElementById("profileTotalPushups").textContent = p.total_pushups;

  const rpgSection = document.getElementById("profileRpgSection");
  if (p.rpg) {
    rpgSection.classList.remove("hidden");
    document.getElementById("profileRpgCharacterPortrait").innerHTML = renderEquippedCharacter(p.rpg, 120);
    document.getElementById("profileRpgLevelRankText").textContent = `LEVEL ${p.rpg.rpg_level} · ${p.rpg.rpg_rank.toUpperCase()}`;
    document.getElementById("profileRpgBadge").innerHTML = renderRankBadge(p.rpg.rpg_rank, 48);
    document.getElementById("profileRpgLevel").textContent = p.rpg.rpg_level;
    document.getElementById("profileRpgRank").textContent = p.rpg.rpg_rank;
    document.getElementById("profileRpgRealms").textContent = `${p.rpg.realms_completed} / ${p.rpg.realms_total}`;
    document.getElementById("profileRpgEmberfallReps").textContent =
      `${p.rpg.emberfall_progress_value.toLocaleString()} / ${p.rpg.emberfall_progress_total.toLocaleString()} reps reclaimed`;
    document.getElementById("profileRpgShieldLine").textContent = `🔰 ${p.rpg.current_shield}`;
    const eqEl = document.getElementById("profileRpgEquipment");
    eqEl.innerHTML = "";
    Object.keys(EQUIPMENT_SLOT_ICONS).forEach(slot => {
      const acquired = !!(p.rpg.equipment && p.rpg.equipment[slot]);
      const itemName = acquired ? p.rpg.equipment[slot].item_name : null;
      const chip = document.createElement("div");
      chip.className = "equipmentChip" + (acquired ? " equipmentChipAcquired" : " equipmentChipLocked");
      const iconHtml = slot === "chest" && acquired
        ? renderEquipmentArt(itemName, true, 20)
        : equipmentIconSvg(slot, acquired, 20);
      chip.innerHTML = `<span class="equipmentChipIcon">${iconHtml}</span><span class="hint">${acquired ? escapeHtml(itemName) : EQUIPMENT_SLOT_LABELS[slot]}</span><span>${acquired ? "✓" : "🔒"}</span>`;
      eqEl.appendChild(chip);
    });
  } else {
    rpgSection.classList.add("hidden");
  }

  renderAchievements(p.achievements, currentAchCategory);

  try {
    const matches = await api("/my-matches");
    const list = document.getElementById("matchHistoryList");
    list.innerHTML = "";
    if (matches.length === 0) {
      const li = document.createElement("li");
      li.className = "emptyState";
      li.innerHTML = `<div class="emptyStateTitle">🥊 YOUR FIRST DUEL IS WAITING</div><div class="hint">Find an opponent to get started.</div>`;
      list.appendChild(li);
      return;
    }
    matches.forEach(m => {
      const li = document.createElement("li");
      li.className = "historyItem outcome-" + m.outcome;
      const oppLabel = m.opponent_username + (m.is_bot_match ? " (Bot)" : "");
      li.innerHTML = `
        <span class="historyOutcome">${OUTCOME_LABELS[m.outcome]}</span>
        <span class="historyOpponent">${oppLabel}</span>
        <span class="historyScore">${m.my_count} : ${m.opponent_count}</span>
      `;
      list.appendChild(li);
    });
  } catch (e) { /* best effort */ }
}

// ---------------------------------------------------------------- profile editing
document.getElementById("editProfileBtn").addEventListener("click", () => {
  if (!currentProfile) return;
  setCountryPickerValue(currentProfile.country || "");
  document.getElementById("editBioInput").value = currentProfile.bio || "";
  const picker = document.getElementById("avatarPicker");
  picker.innerHTML = "";
  let selected = currentProfile.avatar_id || 1;
  AVATAR_EMOJIS.forEach((emoji, i) => {
    const id = i + 1;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatarOption" + (id === selected ? " selected" : "");
    btn.textContent = emoji;
    btn.addEventListener("click", () => {
      selected = id;
      picker.querySelectorAll(".avatarOption").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      picker.dataset.selected = id;
    });
    picker.appendChild(btn);
  });
  picker.dataset.selected = selected;
  document.getElementById("editEmailInput").value = currentProfile.email || "";
  document.getElementById("editProfileVisibilitySelect").value = currentProfile.profile_visibility || "public";
  renderProfilePicturePreview(currentProfile.profile_picture_url);
  document.getElementById("editProfileError").textContent = "";
  document.getElementById("profilePictureError").textContent = "";
  document.getElementById("editProfileForm").classList.remove("hidden");
});

// ---------------------------------------------------------------- profile picture
function renderProfilePicturePreview(url) {
  const img = document.getElementById("profilePicturePreviewImg");
  const emptyLabel = document.getElementById("profilePictureEmptyLabel");
  const removeBtn = document.getElementById("removeProfilePictureBtn");
  if (url) {
    img.src = url; // server already appends a ?v= cache-busting version — no client-side hack needed
    img.classList.remove("hidden");
    emptyLabel.classList.add("hidden");
    removeBtn.classList.remove("hidden");
  } else {
    img.classList.add("hidden");
    emptyLabel.classList.remove("hidden");
    removeBtn.classList.add("hidden");
  }
}

// Single place that reacts to the current user's picture actually
// changing — `me` is the source of truth used by match intro / battle bar
// (and stays correct there since those re-render from `me` fresh at the
// start of each match), `currentProfile` drives the Profile page. Both are
// updated together so nothing on screen — Profile header, Edit Profile
// preview — is left showing a stale picture without a refresh/re-login.
function applyProfilePictureUpdate(url) {
  if (me) me.profile_picture_url = url;
  if (currentProfile) currentProfile.profile_picture_url = url;
  renderProfilePicturePreview(url);
  if (!document.getElementById("profileScreen").classList.contains("hidden")) {
    renderAvatarInto("profileAvatarImg", "profileAvatarEmoji", url, currentProfile ? currentProfile.avatar_id : 1);
  }
}

document.getElementById("profilePictureFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const errEl = document.getElementById("profilePictureError");
  errEl.textContent = "";
  if (!file) return;
  const formData = new FormData();
  formData.append("picture", file);
  try {
    // Deliberately NOT using the shared api() helper — it always sets
    // Content-Type: application/json, which would break a multipart
    // upload (the browser needs to set its own boundary).
    const res = await fetch(API + "/profile/picture", {
      method: "POST",
      headers: { "X-Requested-With": "PushUpEloClient" },
      credentials: "same-origin",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "upload failed");
    applyProfilePictureUpdate(data.profile_picture_url);
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    e.target.value = "";
  }
});

document.getElementById("removeProfilePictureBtn").addEventListener("click", async () => {
  try {
    await fetch(API + "/profile/picture", {
      method: "DELETE",
      headers: { "X-Requested-With": "PushUpEloClient" },
      credentials: "same-origin",
    });
    applyProfilePictureUpdate(null);
  } catch (e) { /* best effort */ }
});

// ---------------------------------------------------------------- country picker
function setCountryPickerValue(code) {
  const input = document.getElementById("editCountryInput");
  const hidden = document.getElementById("editCountryCode");
  if (code && COUNTRY_NAME_BY_CODE[code.toUpperCase()]) {
    hidden.value = code.toUpperCase();
    input.value = countryDisplay(code);
  } else {
    // Legacy free-text value (pre-dropdown) or empty — keep it visible in
    // the box but there's no matching code to save unless the user picks
    // a real country from the list.
    hidden.value = "";
    input.value = code || "";
  }
  input.dataset.original = input.value;
}

function renderCountryOptions(query) {
  const list = document.getElementById("countryOptions");
  const q = query.trim().toLowerCase();
  const matches = (q
    ? COUNTRIES.filter(([, name]) => name.toLowerCase().includes(q))
    : COUNTRIES
  ).slice(0, 8);
  list.innerHTML = "";
  if (matches.length === 0) {
    list.classList.add("hidden");
    return;
  }
  matches.forEach(([code, name]) => {
    const li = document.createElement("li");
    li.textContent = `${countryFlagEmoji(code)} ${name}`;
    li.addEventListener("mousedown", (ev) => {
      ev.preventDefault(); // keep focus so blur doesn't close before click registers
      setCountryPickerValue(code);
      list.classList.add("hidden");
    });
    list.appendChild(li);
  });
  list.classList.remove("hidden");
}

document.getElementById("editCountryInput").addEventListener("input", (e) => {
  document.getElementById("editCountryCode").value = ""; // typing invalidates the prior selection
  renderCountryOptions(e.target.value);
});
document.getElementById("editCountryInput").addEventListener("focus", (e) => {
  renderCountryOptions(e.target.value);
});
document.getElementById("editCountryInput").addEventListener("blur", () => {
  document.getElementById("countryOptions").classList.add("hidden");
});

document.getElementById("cancelEditProfileBtn").addEventListener("click", () => {
  document.getElementById("editProfileForm").classList.add("hidden");
});

document.getElementById("saveProfileBtn").addEventListener("click", async () => {
  const countryInput = document.getElementById("editCountryInput");
  const countryCode = document.getElementById("editCountryCode").value; // set only via picking an option
  const bio = document.getElementById("editBioInput").value.trim();
  const avatarId = parseInt(document.getElementById("avatarPicker").dataset.selected, 10) || 1;
  const email = document.getElementById("editEmailInput").value.trim();
  const profileVisibility = document.getElementById("editProfileVisibilitySelect").value;
  const errorEl = document.getElementById("editProfileError");

  const body = {
    bio, avatar_id: avatarId, email,
    profile_visibility: profileVisibility,
  };
  if (countryCode) {
    body.country = countryCode; // user picked a real country from the list
  } else if (countryInput.value.trim() === "") {
    body.country = ""; // user intentionally cleared the field
  } else if (countryInput.value !== countryInput.dataset.original) {
    // User typed something but never selected a suggestion — don't submit
    // unrecognized free text (server would reject it), and don't silently
    // clear their existing value either. Ask them to pick from the list.
    errorEl.textContent = "Please pick a country from the list.";
    return;
  }
  // else: field untouched (still shows the original legacy value, if any)
  // — omit "country" entirely so the existing DB value is left alone.

  try {
    await api("/profile", { method: "PUT", body: JSON.stringify(body) });
    document.getElementById("editProfileForm").classList.add("hidden");
    await loadProfile();
  } catch (e) {
    errorEl.textContent = e.message;
  }
});

// ---------------------------------------------------------------- lobby / leaderboard
let currentLeaderboardTab = "all";

document.querySelectorAll(".lbTab").forEach(btn => {
  btn.addEventListener("click", () => {
    // V1.4: "friends" is handled by its own dedicated listener further
    // down (different endpoint: /api/friends/leaderboard) — don't let
    // this generic all/weekly/monthly handler also react to it.
    if (btn.dataset.tab === "friends") return;
    document.querySelectorAll(".lbTab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentLeaderboardTab = btn.dataset.tab;
    loadLeaderboard();
  });
});

async function loadLeaderboard() {
  try {
    const tab = currentLeaderboardTab;
    const rows = await api(`/leaderboard?tab=${tab}`);
    const list = document.getElementById("leaderboardList");
    list.innerHTML = "";
    rows.slice(0, 10).forEach((u, i) => {
      const li = document.createElement("li");
      li.className = "lbRow";
      if (i === 0) li.classList.add("lbRowTop1");
      else if (i === 1) li.classList.add("lbRowTop2");
      else if (i === 2) li.classList.add("lbRowTop3");
      if (me && u.id === me.id) li.classList.add("lbRowMe");
      const rankLabel = i < 3 ? ["🥇", "🥈", "🥉"][i] : `#${i + 1}`;
      const meTag = (me && u.id === me.id) ? ` <span class="lbYouTag">YOU</span>` : "";
      if (tab === "all") {
        li.innerHTML = `<span class="lbRank">${rankLabel}</span><span class="lbName"><strong>${escapeHtml(u.username)}</strong>${meTag}<br><span class="hint">${escapeHtml(u.rank_tier)} · ${u.wins}W/${u.losses}L/${u.draws}D</span></span><span class="lbElo">${u.elo}</span>`;
      } else {
        const sign = u.elo_gain > 0 ? "+" : "";
        li.innerHTML = `<span class="lbRank">${rankLabel}</span><span class="lbName"><strong>${escapeHtml(u.username)}</strong>${meTag}<br><span class="hint">${u.matches_in_window} matches</span></span><span class="lbElo">${sign}${u.elo_gain}</span>`;
      }
      list.appendChild(li);
    });
    if (me) {
      document.getElementById("heroEloValue").textContent = me.elo.toLocaleString();
      document.getElementById("myRankLine").textContent =
        `${me.wins}W · ${me.losses}L · ${me.draws}D`;
      try {
        const r = await api("/leaderboard/my-rank");
        document.getElementById("heroGlobalRankValue").textContent = `#${r.rank.toLocaleString()}`;
        document.getElementById("heroPlayerCountLine").textContent =
          `🌎 ${r.total_players.toLocaleString()} players worldwide`;
        const countryBox = document.getElementById("heroCountryStatBox");
        if (r.country && r.country_rank) {
          document.getElementById("heroCountryLabel").textContent = countryDisplay(r.country);
          document.getElementById("heroCountryRankValue").textContent = `#${r.country_rank.toLocaleString()}`;
          countryBox.classList.remove("hidden");
        } else {
          countryBox.classList.add("hidden");
        }
      } catch (e) { /* non-critical */ }
    }
  } catch (e) { /* non-critical */ }
}

// ---------------------------------------------------------------- achievement toast queue
let achievementQueue = [];
let achievementToastShowing = false;

function queueAchievementToasts(achievements) {
  if (!achievements || achievements.length === 0) return;
  achievementQueue.push(...achievements);
  if (!achievementToastShowing) showNextAchievementToast();
}

function showNextAchievementToast() {
  if (achievementQueue.length === 0) {
    achievementToastShowing = false;
    return;
  }
  achievementToastShowing = true;
  const a = achievementQueue.shift();
  const toast = document.getElementById("achievementToast");
  document.getElementById("achievementToastIcon").textContent = a.icon;
  document.getElementById("achievementToastName").textContent = a.name;
  document.getElementById("achievementToastDesc").textContent = a.description;
  document.getElementById("achievementToastXp").textContent = `+${a.xp_reward} XP`;
  toast.classList.remove("hidden");
  playBeep(1046, 0.12);
  setTimeout(() => {
    toast.classList.add("hidden");
    setTimeout(showNextAchievementToast, 300);
  }, 3200);
}

document.getElementById("findMatchBtn").addEventListener("click", async () => {
  try {
    const res = await api("/queue/join", { method: "POST" });
    waitingSecondsElapsed = 0;
    showScreen("waiting");
    if (res.status === "matched") {
      enterMatch(res.match_id);
    } else {
      pollQueue();
    }
  } catch (e) {
    alert(e.message);
  }
});

function pollQueue() {
  clearInterval(queuePollInterval);
  queuePollInterval = setInterval(async () => {
    waitingSecondsElapsed += 1;
    document.getElementById("waitingHint").textContent =
      `Searching for another player… (${waitingSecondsElapsed}s)`;
    try {
      const res = await api("/queue/status");
      if (res.status === "matched") {
        clearInterval(queuePollInterval);
        enterMatch(res.match_id);
        return;
      }
      if (waitingSecondsElapsed >= 10) {
        clearInterval(queuePollInterval);
        const botRes = await api("/queue/bot-match", { method: "POST" });
        enterMatch(botRes.match_id);
      }
    } catch (e) { /* keep polling next tick */ }
  }, 1000);
}

document.getElementById("cancelQueueBtn").addEventListener("click", async () => {
  clearInterval(queuePollInterval);
  try { await api("/queue/leave", { method: "POST" }); } catch (e) { /* best effort */ }
  showScreen("lobby");
});

// ---------------------------------------------------------------- READY (V1.2)
async function enterMatch(matchId) {
  currentMatchId = matchId;
  const match = await api(`/match/${matchId}`);
  iAmPlayer1 = match.player1.id === me.id;
  currentOpponent = iAmPlayer1 ? match.player2 : match.player1;
  enterReadyScreen(match);
}

// ---------------------------------------------------------------- AI camera onboarding
// First-time users get the full explainer (why the camera needs a moment
// before it starts counting); returning users get one short line plus a
// "How it works?" link to reopen the same explainer on demand.
//
// V1.11: this is now a PERSISTENT PER-ACCOUNT flag (me.has_seen_pushup_
// how_it_works, backed by /api/me + POST /api/pushup-how-it-works-seen)
// instead of localStorage — survives switching devices/browsers, and
// existing accounts were backfilled to "already seen" server-side during
// migration, so nobody who has used the app before gets interrupted.
const GET_INTO_POSITION_LONG_TEXT = "Place your hands under your shoulders, keep your body straight, and make sure your full body is visible.";
const GET_INTO_POSITION_SHORT_TEXT = "Get into position. Wait for GO.";

function hasSeenAiIntro() {
  return !!(me && me.has_seen_pushup_how_it_works);
}

function showAiIntroModal() {
  document.getElementById("aiIntroModal").classList.remove("hidden");
}

function dismissAiIntroModal() {
  document.getElementById("aiIntroModal").classList.add("hidden");
  if (me) me.has_seen_pushup_how_it_works = true;
  api("/pushup-how-it-works-seen", { method: "POST" }).catch(() => {
    // Best-effort — even if this particular save fails, the in-memory
    // `me` flag above still prevents re-showing it again THIS session;
    // it'll simply re-persist next time they dismiss it.
  });
}

document.getElementById("aiIntroContinueBtn").addEventListener("click", () => {
  const firstTime = !hasSeenAiIntro();
  dismissAiIntroModal();
  document.getElementById("getIntoPositionInstructions").textContent = GET_INTO_POSITION_SHORT_TEXT;
  // Only a first-time viewing was actually gating the PvP camera check —
  // reopening via "How it works?" (see below) must NOT restart it.
  if (firstTime) startReadyCameraCheck();
});

// ---------------------------------------------------------------- RPG-specific onboarding
// SEPARATE from the PvP explainer above (has_seen_rpg_how_it_works, its
// own persistent per-account flag) — a player's first RPG entry gets the
// RPG-specific game-loop explainer even if they've already dismissed the
// PvP one, and vice versa.
function hasSeenRpgIntro() {
  return !!(me && me.has_seen_rpg_how_it_works);
}

function showRpgIntroModal() {
  document.getElementById("rpgIntroModal").classList.remove("hidden");
}

function dismissRpgIntroModal() {
  document.getElementById("rpgIntroModal").classList.add("hidden");
  if (me) me.has_seen_rpg_how_it_works = true;
  api("/rpg-how-it-works-seen", { method: "POST" }).catch(() => {
    // Best-effort, same reasoning as the PvP dismiss handler above.
  });
}

document.getElementById("rpgIntroContinueBtn").addEventListener("click", () => {
  dismissRpgIntroModal();
  if (pendingRpgBattleStart !== null) {
    const monsterId = pendingRpgBattleStart;
    pendingRpgBattleStart = null;
    _startRpgBattleAfterIntro(monsterId);
  }
});

document.getElementById("howItWorksLinkBtn").addEventListener("click", () => {
  showAiIntroModal();
});

function enterReadyScreen(match) {
  document.getElementById("opponentName").textContent =
    match.is_bot_match ? "🤖 Bot" : currentOpponent.username;
  document.getElementById("opponentElo").textContent = currentOpponent.elo;
  document.getElementById("readyTitle").textContent =
    match.is_bot_match ? "Bot Match Found!" : "Opponent Found!";

  // Player intro / VS row — best-effort using whatever `me` and
  // currentOpponent already carry (both come from user_to_dict, which now
  // includes profile_picture_url); no extra request, no extra delay.
  document.getElementById("matchIntroMeName").textContent = me.username;
  renderAvatarInto("matchIntroMeImg", "matchIntroMeEmoji", me.profile_picture_url, me.avatar_id);
  document.getElementById("matchIntroOppName").textContent =
    match.is_bot_match ? "Bot" : currentOpponent.username;
  renderAvatarInto(
    "matchIntroOppImg", "matchIntroOppEmoji",
    match.is_bot_match ? null : currentOpponent.profile_picture_url,
    currentOpponent.avatar_id
  );

  // Global rank (leaderboard position) — the player asked to see this
  // while queued for/playing a 1v1, not just buried on the Profile
  // screen. Reuses the exact same elo_rank the Profile page already
  // computes; fetched here only if not already cached from a Profile
  // visit this session, so most of the time this is free.
  const meRankEl = document.getElementById("matchIntroMeRank");
  if (currentProfile && typeof currentProfile.elo_rank === "number") {
    meRankEl.textContent = `Global Rank #${currentProfile.elo_rank}`;
  } else {
    meRankEl.textContent = "";
    api("/profile").then(p => {
      currentProfile = p;
      meRankEl.textContent = `Global Rank #${p.elo_rank}`;
    }).catch(() => { /* best effort — ready screen still works without it */ });
  }

  updateReadyStatusUI(match);
  showScreen("ready");
  pollReadyState();

  const instructionsEl = document.getElementById("getIntoPositionInstructions");
  if (hasSeenAiIntro()) {
    instructionsEl.textContent = GET_INTO_POSITION_SHORT_TEXT;
    startReadyCameraCheck();
  } else {
    instructionsEl.textContent = GET_INTO_POSITION_LONG_TEXT;
    showAiIntroModal(); // startReadyCameraCheck() fires from aiIntroContinueBtn instead
  }
}

function updateReadyStatusUI(match) {
  const myReady = iAmPlayer1 ? match.player1_ready : match.player2_ready;
  const oppReady = iAmPlayer1 ? match.player2_ready : match.player1_ready;
  const myEl = document.getElementById("myReadyStatus");
  const oppEl = document.getElementById("oppReadyStatus");
  myEl.textContent = myReady ? "✅ READY" : "⏳ Waiting";
  myEl.className = "readyStatusValue" + (myReady ? " isReady" : "");
  oppEl.textContent = oppReady ? "✅ READY" : "⏳ Waiting";
  oppEl.className = "readyStatusValue" + (oppReady ? " isReady" : "");
  if (myReady) {
    stopReadyCameraCheck();
    document.getElementById("readyCheckStatusText").textContent = "POSITION READY ✓ — waiting for opponent…";
  }
}

// Sends the READY signal exactly once per match — used by both the
// auto-ready camera check and the manual fallback button. The server's
// /match/<id>/ready endpoint is itself idempotent, so this guard is a
// courtesy (avoids redundant requests), not a correctness requirement.
let readySentForMatchId = null;
async function sendReadySignal() {
  if (readySentForMatchId === currentMatchId) return;
  readySentForMatchId = currentMatchId;
  try {
    const match = await api(`/match/${currentMatchId}/ready`, { method: "POST" });
    updateReadyStatusUI(match);
    if (match.status === "in_progress") {
      clearInterval(readyPollInterval);
      beginSynchronizedMatch(match);
    }
  } catch (e) {
    readySentForMatchId = null; // allow retry (e.g. transient network error)
    alert(e.message);
  }
}

document.getElementById("startMatchBtn").addEventListener("click", () => {
  sendReadySignal();
});

function pollReadyState() {
  clearInterval(readyPollInterval);
  readyPollInterval = setInterval(async () => {
    try {
      const match = await api(`/match/${currentMatchId}`);
      if (match.status === "cancelled") {
        clearInterval(readyPollInterval);
        stopReadyCameraCheck();
        showNotice("⚠️ Match cancelled — your opponent wasn't ready in time. No Elo was lost.");
        showScreen("lobby");
        loadLeaderboard();
        return;
      }
      if (match.status === "in_progress") {
        clearInterval(readyPollInterval);
        beginSynchronizedMatch(match);
        return;
      }
      updateReadyStatusUI(match);
    } catch (e) { /* keep polling next tick */ }
  }, CONFIG.READY_POLL_MS);
}

// ---------------------------------------------------------------- auto-ready camera check
// Replaces the old "press Ready manually" flow: pressing a button risked
// knocking the player out of position right before the match starts.
// Instead this watches the SAME shared pose landmarker used everywhere
// else (loadPoseModel() — no second detector) and calls the existing,
// already-idempotent /match/<id>/ready endpoint automatically once body
// position + lighting have been continuously valid for
// CONFIG.CAMERA_READY_STABILITY_MS. If the camera/AI model can't start at
// all, it falls back to the manual button so play is never blocked.
let readyCameraStream = null;
let readyCameraCheckRunning = false;
let readyStableSince = null;
let readyBrightnessCanvas = null;

async function startReadyCameraCheck() {
  readyStableSince = null;
  resetPoseTracker(pvpPoseTracker); // same tracker the actual match will use (see startCamera) — locks a side here so the match doesn't have to re-lock from scratch
  const video = document.getElementById("readyCameraVideo");
  const statusText = document.getElementById("readyCheckStatusText");
  const fallbackBtn = document.getElementById("startMatchBtn");
  fallbackBtn.classList.add("hidden");
  try {
    statusText.textContent = "📷 Starting camera…";
    readyCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 640, height: 480 }, audio: false,
    });
    video.srcObject = readyCameraStream;
    await video.play();
    setCameraActiveIndicator("readyCameraActiveIndicator", true);

    statusText.textContent = "🧠 Loading AI model…";
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), CONFIG.POSE_MODEL_TIMEOUT_MS)
    );
    await Promise.race([loadPoseModel(), timeoutPromise]); // SAME shared model

    readyCameraCheckRunning = true;
    requestAnimationFrame(readyCameraCheckLoop);
  } catch (err) {
    console.error("Ready camera check init failed:", err);
    stopReadyCameraCheck();
    statusText.textContent = "⚠️ Camera unavailable — tap Ready when you're set.";
    fallbackBtn.classList.remove("hidden");
  }
}

function stopReadyCameraCheck() {
  readyCameraCheckRunning = false;
  readyStableSince = null;
  setCameraActiveIndicator("readyCameraActiveIndicator", false);
  if (readyCameraStream) {
    readyCameraStream.getTracks().forEach(t => t.stop());
    readyCameraStream = null;
  }
}

// Genuine (not simulated) lighting check: downsamples the current video
// frame to a tiny offscreen canvas and averages luma. Cheap enough to run
// every frame; avoids claiming a "lighting" check without actually
// measuring anything.
function estimateBrightness(video) {
  if (!readyBrightnessCanvas) {
    readyBrightnessCanvas = document.createElement("canvas");
    readyBrightnessCanvas.width = 20;
    readyBrightnessCanvas.height = 15;
  }
  const ctx = readyBrightnessCanvas.getContext("2d");
  ctx.drawImage(video, 0, 0, 20, 15);
  const data = ctx.getImageData(0, 0, 20, 15).data;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return total / (data.length / 4);
}

// The Ready check answers ONE question: "is this player positioned in
// front of the camera with their full body visible?" It intentionally
// does NOT validate push-up geometry (elbow angle, hip alignment, side
// orientation) — that's what the match/RPG detectors are for. Keeping
// this simple means a player who is simply standing in frame becomes
// ready, without having to get into push-up position first.
function readyCameraCheckLoop() {
  if (!readyCameraCheckRunning) return;
  const video = document.getElementById("readyCameraVideo");
  const canvas = document.getElementById("readyCameraCanvas");
  const statusText = document.getElementById("readyCheckStatusText");

  if (video.readyState < 2 || !poseLandmarker) {
    requestAnimationFrame(readyCameraCheckLoop);
    return;
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  const result = poseLandmarker.detectForVideo(video, performance.now());
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let allValid = false;
  let message = "Move into camera view";

  if (result.landmarks && result.landmarks.length > 0) {
    const lm = result.landmarks[0];
    // SAME shared side-lock/smoothing pipeline as the actual match/RPG
    // loops (see trackPoseLandmarks) — no separate landmark-selection
    // logic for the Ready screen. No rep is ever in progress here, so
    // side-switching is always allowed (pass "up").
    const tracked = trackPoseLandmarks(pvpPoseTracker, lm, "up");
    const idxObj = POSE_SIDE_LANDMARKS[tracked.side];
    const parts = [idxObj.shoulder, idxObj.elbow, idxObj.wrist, idxObj.hip, idxObj.knee, idxObj.ankle].map(i => lm[i]);
    const fullBodyVisible = parts.every(p => (p?.visibility || 0) > CONFIG.MIN_BODY_VISIBILITY);
    const lightingOk = estimateBrightness(video) >= CONFIG.MIN_LIGHTING_BRIGHTNESS;

    const toPx = p => ({ x: p.x * canvas.width, y: p.y * canvas.height });
    ctx.fillStyle = "#3ce8ff";
    parts.forEach(p => {
      if (!p) return;
      const px = toPx(p);
      ctx.beginPath();
      ctx.arc(px.x, px.y, 5, 0, 2 * Math.PI);
      ctx.fill();
    });

    if (!fullBodyVisible) {
      message = "Make sure your full body is visible";
    } else if (!lightingOk) {
      message = "Improve lighting";
    } else {
      allValid = true;
    }
  }

  if (allValid) {
    if (readyStableSince === null) readyStableSince = performance.now();
    const elapsed = performance.now() - readyStableSince;
    if (elapsed >= CONFIG.CAMERA_READY_STABILITY_MS) {
      statusText.textContent = "POSITION READY ✓";
      stopReadyCameraCheck();
      sendReadySignal();
      return;
    }
    statusText.textContent = "Good position — hold still…";
  } else {
    readyStableSince = null;
    statusText.textContent = message;
  }

  requestAnimationFrame(readyCameraCheckLoop);
}

// Populates the small avatars above the shared battle bar — same
// picture-with-emoji-fallback pattern as the match intro, no new request.
function renderBattleBarAvatars(isBotMatch) {
  renderAvatarInto("battleBarMeImg", "battleBarMeEmoji", me.profile_picture_url, me.avatar_id);
  renderAvatarInto(
    "battleBarOppImg", "battleBarOppEmoji",
    isBotMatch ? null : (currentOpponent ? currentOpponent.profile_picture_url : null),
    currentOpponent ? currentOpponent.avatar_id : 1
  );
}

// Resume a match that's already in_progress (e.g. after a refresh) using
// the server's authoritative timestamps rather than restarting a local timer.
function resumeInProgressMatch(match) {
  stopReadyCameraCheck();
  pushupCount = 0;
  document.getElementById("pushupCount").textContent = "0";
  showScreen("match");
  renderBattleBarAvatars(match.is_bot_match);
  startCamera().then(() => {
    scheduleSynchronizedStart(match.exercise_starts_at, match.expires_at);
  });
}

function beginSynchronizedMatch(match) {
  stopReadyCameraCheck();
  pushupCount = 0;
  document.getElementById("pushupCount").textContent = "0";
  showScreen("match");
  renderBattleBarAvatars(match.is_bot_match);
  startCamera().then(() => {
    scheduleSynchronizedStart(match.exercise_starts_at, match.expires_at);
  });
}

// ---------------------------------------------------------------- synchronized countdown + timer
// Both players compute their countdown/timer from the SAME server
// timestamps (exercise_starts_at, expires_at), so independent of small
// network jitter, both start the exercise at approximately the same
// moment — this is what makes the countdown "synchronized" per V1.2 spec,
// without needing WebSockets.
function scheduleSynchronizedStart(exerciseStartsAt, expiresAt) {
  const overlay = document.getElementById("countdownOverlay");
  const numberEl = document.getElementById("countdownNumber");
  const hintEl = document.getElementById("countdownHint");
  hintEl.classList.remove("hidden");

  function tick() {
    const now = Date.now() / 1000;
    const secondsUntilStart = exerciseStartsAt - now;

    if (secondsUntilStart > 0.15) {
      overlay.classList.remove("hidden");
      const displayNum = Math.ceil(secondsUntilStart);
      if (numberEl.textContent !== String(displayNum)) {
        numberEl.textContent = displayNum;
        playBeep(440, 0.08);
      }
      requestAnimationFrame(tick);
    } else {
      numberEl.textContent = "GO!";
      hintEl.classList.add("hidden");
      playBeep(880, 0.15);
      setTimeout(() => overlay.classList.add("hidden"), 400);
      startAuthoritativeTimer(exerciseStartsAt, expiresAt);
    }
  }
  tick();
}

// The visible 60s timer is driven by wall-clock comparisons against the
// server's exercise_starts_at, NOT a local decrementing counter — this
// avoids setInterval drift and means a paused/backgrounded tab catches up
// correctly instead of silently falling behind.
function startAuthoritativeTimer(exerciseStartsAt, expiresAt) {
  const timerEl = document.getElementById("timer");
  detectionRunning = true;
  requestAnimationFrame(detectionLoop);
  startLiveCountPolling();

  clearInterval(matchTimerInterval);
  matchTimerInterval = setInterval(async () => {
    const now = Date.now() / 1000;
    const remaining = Math.max(0, Math.round(exerciseStartsAt + CONFIG.MATCH_DURATION_SECONDS - now));
    timerEl.textContent = remaining;
    timerEl.classList.toggle("timerUrgent", remaining <= 10);
    if (remaining <= 0) {
      clearInterval(matchTimerInterval);
      stopLiveCountPolling();
      stopCamera();
      await finishMatch();
    }
  }, 250); // finer-grained than 1000ms so the "0" moment lands promptly
}

// ---------------------------------------------------------------- real-time opponent rep count
// Display-only — the /live-count endpoint never affects Elo, win/loss, or
// total_pushups (those still come exclusively from the one-shot final
// submit at match end). This purely drives the shared battle bar.
let liveCountPollInterval = null;
let lastLeadState = null;

function startLiveCountPolling() {
  lastLeadState = null;
  updateBattleBar(0, 0);
  clearInterval(liveCountPollInterval);
  liveCountPollInterval = setInterval(async () => {
    if (!currentMatchId) return;
    try {
      const res = await api(`/match/${currentMatchId}/live-count`, {
        method: "POST",
        body: JSON.stringify({ count: pushupCount }),
      });
      updateBattleBar(pushupCount, res.opponent_live_count);
    } catch (e) { /* best effort — never blocks gameplay */ }
  }, 1500);
}

function stopLiveCountPolling() {
  clearInterval(liveCountPollInterval);
}

// oppCount === null means we have no real data yet (e.g. bot matches,
// which never post a live count, or the very first poll) — shown as "—",
// never estimated/simulated/guessed.
function updateBattleBar(myCount, oppCount) {
  const haveOpp = oppCount !== null && oppCount !== undefined;
  const oppForRatio = haveOpp ? oppCount : 0;
  const total = myCount + oppForRatio;
  // Explicit 0/0 handling per spec: exactly centered, not a divide-by-zero.
  const ratio = total > 0 ? myCount / total : 0.5;

  document.getElementById("battleBarYouFill").style.width = (ratio * 100) + "%";
  document.getElementById("battleBarMarker").style.left = (ratio * 100) + "%";

  const youCountEl = document.getElementById("battleBarYouCount");
  if (youCountEl.textContent !== String(myCount)) {
    youCountEl.textContent = myCount;
    youCountEl.classList.add("battleBarCountPulse");
    setTimeout(() => youCountEl.classList.remove("battleBarCountPulse"), 250);
  }
  const oppCountEl = document.getElementById("battleBarOppCount");
  const oppDisplay = haveOpp ? String(oppCount) : "—";
  if (oppCountEl.textContent !== oppDisplay) {
    oppCountEl.textContent = oppDisplay;
    if (haveOpp) {
      oppCountEl.classList.add("battleBarCountPulse");
      setTimeout(() => oppCountEl.classList.remove("battleBarCountPulse"), 250);
    }
  }

  const statusEl = document.getElementById("battleBarStatus");
  const closeNote = document.getElementById("battleBarCloseNote");
  if (!haveOpp) {
    statusEl.textContent = "";
    if (closeNote) closeNote.classList.add("hidden");
    return;
  }

  let leadState;
  if (myCount > oppCount) leadState = "you";
  else if (oppCount > myCount) leadState = "opp";
  else leadState = "tied";

  const leadChanged = leadState !== lastLeadState;
  if (leadState === "you") {
    statusEl.textContent = (leadChanged && lastLeadState !== null) ? "YOU TAKE THE LEAD!" : "YOU'RE IN THE LEAD";
  } else if (leadState === "opp") {
    statusEl.textContent = (leadChanged && lastLeadState !== null) ? "THEY TAKE THE LEAD!" : "THEY'RE IN THE LEAD";
  } else {
    statusEl.textContent = "TIED";
  }
  if (leadChanged) {
    statusEl.classList.add("battleBarStatusPulse");
    setTimeout(() => statusEl.classList.remove("battleBarStatusPulse"), 300);
    lastLeadState = leadState;
  }

  const diff = Math.abs(myCount - oppCount);
  const closeMatch = total >= 6 && diff > 0 && diff <= 2; // small, real gap — not for 0-0/near-zero starts
  document.getElementById("battleBarCloseNote").classList.toggle("hidden", !closeMatch);
}

// ---------------------------------------------------------------- sound
let soundEnabled = true;
let audioCtx = null;

document.getElementById("soundToggleBtn").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  document.getElementById("soundToggleBtn").textContent = soundEnabled ? "🔊 Sound" : "🔇 Muted";
});

function playBeep(freq, duration) {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) { /* audio unsupported/blocked — skip silently */ }
}

// ---------------------------------------------------------------- AI push-up detection
let poseLandmarker = null;
let cameraStream = null;
let detectionRunning = false;
let repState = "up";
let downShoulderY = null;
let downBodyScale = null;
// V1.16 calibration fix: the actual peak displacement reached ANY TIME
// during the down phase, not just a single sample at the down/up
// transition instants — see the shoulder-movement rewrite below for why.
let downShoulderYExtreme = 0;
let lastPvpRepRejectedReason = null; // dev-debug only — why the last completed down->up cycle didn't count
let pendingDownFrames = 0;
let pendingUpFrames = 0;
let repWasValidThroughout = true;
let invalidStreak = 0;
let lastRepTimestamp = 0;
let lastFeedbackText = "";
let lastFeedbackChangeTime = 0;
let flatZStreak = 0;
let livenessWarningShown = false;

// --- Practical, honest liveness signal — NOT robust anti-spoofing ---
// MediaPipe's pose landmarker returns an approximate relative-depth (z)
// alongside x/y for every landmark. A genuinely 3D human body produces a
// real spread of z-values across the shoulder/elbow/wrist/hip/knee/ankle
// chain even viewed from the side; a flat video played back on a second
// screen held up to the camera tends to collapse toward a much flatter
// z-spread, since the source image itself has no real depth for the
// model to estimate from.
//
// This is a WEAK, UNCALIBRATED signal (no real camera available to tune
// it against) — it is surfaced as an informational warning only. It NEVER
// blocks gameplay, never withholds a rep, and can be wrong in either
// direction (an unusual angle/lighting could trigger it for a real user;
// a well-lit, well-angled recording might not trigger it at all). This is
// not — and is not claimed to be — reliable anti-spoofing.
const LIVENESS_MIN_Z_SPREAD = 0.05; // untested against a real camera — expect to tune
const LIVENESS_SUSTAINED_FRAMES = 180; // ~3s at 60fps of consistently-flat z before warning once

function computeZSpread(pts) {
  const zs = Object.values(pts).filter(p => p && typeof p.z === "number").map(p => p.z);
  if (zs.length < 4) return null;
  const mean = zs.reduce((a, v) => a + v, 0) / zs.length;
  const variance = zs.reduce((a, v) => a + (v - mean) ** 2, 0) / zs.length;
  return Math.sqrt(variance);
}

// Tracks the flat-z streak and reports whether a one-time notice should
// fire. `pts` is the same landmark chain already used for counting — no
// extra pose-model calls. Caller owns the streak/shown state (module-level
// vars, reset per camera session) since JS doesn't pass primitives by
// reference.
function checkLivenessSignal(pts, streak) {
  const zSpread = computeZSpread(pts);
  if (zSpread === null) return { streak, shouldWarn: false };
  if (zSpread < LIVENESS_MIN_Z_SPREAD) {
    streak += 1;
  } else {
    streak = 0;
  }
  return { streak, shouldWarn: streak === LIVENESS_SUSTAINED_FRAMES };
}

async function loadPoseModel() {
  if (poseLandmarker) return poseLandmarker;
  const { PoseLandmarker, FilesetResolver } = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14"
  );
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "CPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  return poseLandmarker;
}

function angleBetween(a, b, c) {
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const magAB = Math.hypot(ab.x, ab.y);
  const magCB = Math.hypot(cb.x, cb.y);
  if (magAB === 0 || magCB === 0) return 180;
  const cos = Math.max(-1, Math.min(1, dot / (magAB * magCB)));
  return (Math.acos(cos) * 180) / Math.PI;
}

// Shared by BOTH PvP and RPG push-up detection (previously two separate,
// near-identical shoulder->hip->knee ANGLE checks — this replaces both
// with one function, used from both places).
//
// Why a line-deviation model instead of an angle: measuring the
// shoulder-hip-knee ANGLE is overly sensitive right at the hip — a small
// natural hip position change swings that angle a lot near a mostly-
// straight body, which is what made the old check feel stricter than a
// real push-up actually requires. Measuring how far the hip strays
// (perpendicular, body-scale-normalized) from the overall shoulder-to-
// ankle reference line tolerates the natural curvature a real push-up has
// while still catching genuine extreme sag/pike.
function computeHipAlignment(shoulderPx, hipPx, anklePx) {
  const abx = anklePx.x - shoulderPx.x, aby = anklePx.y - shoulderPx.y;
  const bodyLength = Math.hypot(abx, aby);
  if (bodyLength < 1) return { ratio: 0, direction: null };
  const apx = hipPx.x - shoulderPx.x, apy = hipPx.y - shoulderPx.y;
  const t = (apx * abx + apy * aby) / (abx * abx + aby * aby);
  const projX = shoulderPx.x + t * abx, projY = shoulderPx.y + t * aby;
  const ratio = Math.hypot(hipPx.x - projX, hipPx.y - projY) / bodyLength;
  // "down" on screen is unambiguous regardless of which way the person
  // faces, so comparing hip.y to the line's y at that point directly
  // tells sag (hip drooping toward the floor) from pike (hip raised).
  const direction = hipPx.y > projY ? "sag" : "pike";
  return { ratio, direction };
}

// =============================================================================
// V1.15 — Shared landmark side-lock + temporal tracking pipeline.
//
// ONE definition, used by Ready/PvP AND RPG (see poseTrackerFor() below) —
// per spec, no separate landmark logic per screen.
//
// Root-cause fix for "shoulder/elbow/wrist jump between joints or switch
// sides": the old code picked left-vs-right FRESH every single frame from
// that frame's visibility sum alone, so a tiny noise-level confidence
// wobble could flip the entire arm chain frame-to-frame. This replaces
// that with: lock a side once selected, require the OTHER side to be
// clearly and consistently better before switching, never switch mid-rep,
// and smooth/validate the actual landmark positions before they ever
// reach angleBetween().
//
// Pipeline (matches the spec's diagram exactly):
//   raw MediaPipe landmarks -> locked side -> confidence validation ->
//   temporal smoothing -> motion-continuity check -> anatomical-geometry
//   validation -> smoothed shoulder/elbow/wrist -> angleBetween() -> rep
//   state machine.
// =============================================================================
const POSE_SIDE_LANDMARKS = {
  left:  { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
};
const POSE_TRACKED_KEYS = ["shoulder", "elbow", "wrist", "hip", "knee", "ankle"];

function createPoseTrackerState() {
  return {
    lockedSide: null,           // "left" | "right" | null
    sideSwitchStreak: 0,        // consecutive frames the OTHER side has been clearly better
    smoothed: {},                // key -> {x, y} in NORMALIZED (0-1) coords, post-EMA
    heldThisFrame: {},           // key -> true if this frame reused the previous smoothed point (jump/geometry rejected)
    armLen: { shoulderElbow: null, elbowWrist: null }, // slow running-average distances (normalized), this person's own baseline
    unstableStreak: 0,           // consecutive frames where a CORE point (shoulder/elbow/wrist) had to be held
    jumpStreak: {},               // key -> consecutive frames the RAW sample has landed far from the held anchor (re-lock detector)
    geometryFailStreak: 0,        // consecutive frames the arm geometry check has failed (re-lock detector)
  };
}
let pvpPoseTracker = createPoseTrackerState();
let rpgPoseTracker = createPoseTrackerState();

function resetPoseTracker(state) {
  state.lockedSide = null;
  state.sideSwitchStreak = 0;
  state.smoothed = {};
  state.heldThisFrame = {};
  state.armLen = { shoulderElbow: null, elbowWrist: null };
  state.unstableStreak = 0;
  state.jumpStreak = {};
  state.geometryFailStreak = 0;
}

// `lm` = the raw MediaPipe landmark array for one frame. `repStateNow` =
// the CALLER's current "up"/"down" state (used only to forbid a side
// switch mid-rep, per spec — the tracker itself has no rep concept).
// Returns smoothed, NORMALIZED points ({x,y,visibility}) plus tracking
// status; caller converts to pixel space and feeds them into the
// existing angle/hip/rep logic exactly as before.
function trackPoseLandmarks(state, lm, repStateNow) {
  const leftVis = (lm[11]?.visibility || 0) + (lm[13]?.visibility || 0) + (lm[15]?.visibility || 0);
  const rightVis = (lm[12]?.visibility || 0) + (lm[14]?.visibility || 0) + (lm[16]?.visibility || 0);

  if (state.lockedSide === null) {
    // Initial pick only — no hysteresis needed yet, nothing to protect.
    state.lockedSide = rightVis >= leftVis ? "right" : "left";
    state.sideSwitchStreak = 0;
  } else if (repStateNow !== "down") {
    // Section 8: NEVER re-evaluate a side switch while a rep is in the
    // "down" phase, regardless of how confident the other side looks.
    const lockedVis = state.lockedSide === "right" ? rightVis : leftVis;
    const otherVis = state.lockedSide === "right" ? leftVis : rightVis;
    if (otherVis - lockedVis > CONFIG.POSE_SIDE_SWITCH_MARGIN) {
      state.sideSwitchStreak += 1;
      if (state.sideSwitchStreak >= CONFIG.POSE_SIDE_SWITCH_CONFIRM_FRAMES) {
        state.lockedSide = state.lockedSide === "right" ? "left" : "right";
        state.sideSwitchStreak = 0;
        // Reset smoothing/geometry baselines — a genuinely new side means
        // a genuinely new set of joints, no continuity to preserve.
        state.smoothed = {};
        state.armLen = { shoulderElbow: null, elbowWrist: null };
        state.jumpStreak = {};
        state.geometryFailStreak = 0;
      }
    } else {
      state.sideSwitchStreak = 0; // needs to be SUSTAINED, not cumulative across gaps
    }
  }

  const idx = POSE_SIDE_LANDMARKS[state.lockedSide];
  const rawByKey = {};
  POSE_TRACKED_KEYS.forEach(key => { rawByKey[key] = lm[idx[key]]; });

  state.heldThisFrame = {};
  const out = {};
  POSE_TRACKED_KEYS.forEach(key => {
    const raw = rawByKey[key];
    const prevSmoothed = state.smoothed[key];
    if (!raw) {
      // No landmark at all this frame — keep whatever we last had (if
      // anything); the visibility/coreVisible checks downstream already
      // handle "missing" correctly via a 0 visibility.
      out[key] = prevSmoothed ? { ...prevSmoothed, visibility: 0 } : null;
      return;
    }

    let candidate = { x: raw.x, y: raw.y };
    let held = false;
    let reacquired = false;

    // Motion continuity: a real joint can't teleport frame-to-frame — BUT
    // if the raw sample keeps landing far from the held anchor for several
    // CONSECUTIVE frames (not just one noisy frame), that's not noise
    // anymore — it means the person actually moved there (e.g. stepped
    // out of frame and back in) and the old anchor is simply stale. Treat
    // that as a genuine re-lock instead of holding forever, or this key
    // can never recover once it starts holding.
    if (prevSmoothed && (key === "shoulder" || key === "elbow" || key === "wrist")) {
      const jump = Math.hypot(candidate.x - prevSmoothed.x, candidate.y - prevSmoothed.y);
      if (jump > CONFIG.MAX_LANDMARK_JUMP) {
        const streak = (state.jumpStreak[key] || 0) + 1;
        state.jumpStreak[key] = streak;
        if (streak >= CONFIG.LANDMARK_REACQUIRE_FRAMES) {
          reacquired = true; // accept the raw candidate as-is, snap to it below
          state.jumpStreak[key] = 0;
        } else {
          candidate = { x: prevSmoothed.x, y: prevSmoothed.y };
          held = true;
        }
      } else {
        state.jumpStreak[key] = 0;
      }
    }

    // Temporal smoothing (EMA) — applied to whatever we're accepting this
    // frame (the raw sample, the held previous point, or — on the frame a
    // re-lock is confirmed — a hard snap straight to the new position
    // rather than an EMA crawl back from the now-stale anchor).
    const smoothed = reacquired || !prevSmoothed
      ? candidate
      : {
          x: CONFIG.LANDMARK_SMOOTHING_ALPHA * candidate.x + (1 - CONFIG.LANDMARK_SMOOTHING_ALPHA) * prevSmoothed.x,
          y: CONFIG.LANDMARK_SMOOTHING_ALPHA * candidate.y + (1 - CONFIG.LANDMARK_SMOOTHING_ALPHA) * prevSmoothed.y,
        };

    state.smoothed[key] = smoothed;
    state.heldThisFrame[key] = held;
    out[key] = { x: smoothed.x, y: smoothed.y, visibility: raw.visibility || 0 };
  });

  // Anatomical geometry check — shoulder/elbow/wrist must keep forming a
  // plausible arm, judged against THIS person's own recent measurements
  // (never a hardcoded arm length). Only evaluated once a baseline exists.
  if (out.shoulder && out.elbow && out.wrist) {
    const seDist = Math.hypot(out.shoulder.x - out.elbow.x, out.shoulder.y - out.elbow.y);
    const ewDist = Math.hypot(out.elbow.x - out.wrist.x, out.elbow.y - out.wrist.y);
    const geometryOk = (label, dist, historyKey) => {
      const avg = state.armLen[historyKey];
      if (avg === null || avg === 0) {
        state.armLen[historyKey] = dist; // establish baseline
        return true;
      }
      const changeFrac = Math.abs(dist - avg) / avg;
      if (changeFrac > CONFIG.ANATOMY_RATIO_TOLERANCE) {
        return false; // this frame's geometry doesn't look like the same arm — don't fold it into the baseline
      }
      state.armLen[historyKey] = avg * 0.95 + dist * 0.05; // slow-moving baseline, only updated on plausible frames
      return true;
    };
    const seOk = geometryOk("shoulder-elbow", seDist, "shoulderElbow");
    const ewOk = geometryOk("elbow-wrist", ewDist, "elbowWrist");
    if (!seOk || !ewOk) {
      state.geometryFailStreak += 1;
      if (state.geometryFailStreak >= CONFIG.LANDMARK_REACQUIRE_FRAMES) {
        // Several consecutive frames all disagree with the old baseline —
        // the baseline itself is stale (e.g. distance-to-camera changed
        // while the person was out of frame), not a fluke. Re-baseline to
        // what we're actually seeing now instead of holding elbow/wrist
        // forever against a measurement that will never match again.
        state.armLen.shoulderElbow = seDist;
        state.armLen.elbowWrist = ewDist;
        state.geometryFailStreak = 0;
      } else {
        // Geometry violated — fall back to holding elbow/wrist at their
        // previous smoothed positions rather than feeding a physically
        // implausible arm shape into the angle calculation.
        ["elbow", "wrist"].forEach(key => {
          const prevSmoothed = state.smoothed[key];
          if (prevSmoothed) {
            out[key] = { x: prevSmoothed.x, y: prevSmoothed.y, visibility: out[key]?.visibility || 0 };
            state.heldThisFrame[key] = true;
          }
        });
      }
    } else {
      state.geometryFailStreak = 0;
    }
  }

  const coreHeld = ["shoulder", "elbow", "wrist"].some(key => state.heldThisFrame[key]);
  state.unstableStreak = coreHeld ? state.unstableStreak + 1 : 0;
  const tracking = state.unstableStreak >= CONFIG.UNSTABLE_TRACKING_FRAMES ? "unstable" : "stable";

  return { side: state.lockedSide, points: out, tracking, coreHeldThisFrame: coreHeld };
}

// Shared visual treatment for the shoulder->elbow->wrist chain — used by
// BOTH detectionLoop and rpgDetectionLoop. A landmark drawn in the normal
// color is a fresh, trusted sample this frame; one drawn in the "held"
// color means the tracker is temporarily reusing its last stable position
// (a jump or anatomy-check rejection) rather than a fresh raw sample —
// visually distinct so it's obvious when tracking is compensating for a
// noisy frame instead of pretending everything is equally fresh.
function drawTrackedArm(ctx, toPx, s, e, w, heldMap) {
  const sPx = toPx(s), ePx = toPx(e), wPx = toPx(w);
  ctx.strokeStyle = "#3ce8ff";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(sPx.x, sPx.y);
  ctx.lineTo(ePx.x, ePx.y);
  ctx.lineTo(wPx.x, wPx.y);
  ctx.stroke();
  [["shoulder", s], ["elbow", e], ["wrist", w]].forEach(([key, p]) => {
    const px = toPx(p);
    const isHeld = !!(heldMap && heldMap[key]);
    ctx.fillStyle = isHeld ? "#ffb84d" : "#ff5a3c"; // amber = held/uncertain this frame, red = fresh/stable
    ctx.beginPath();
    ctx.arc(px.x, px.y, isHeld ? 7 : 6, 0, 2 * Math.PI);
    ctx.fill();
    if (isHeld) {
      ctx.strokeStyle = "#ffb84d";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px.x, px.y, 10, 0, 2 * Math.PI);
      ctx.stroke();
    }
  });
}

// Dev-only visual debug overlay — gated on the SAME existing
// localStorage.pushupElo_debug flag, never shown to normal users.
function isPoseDebugEnabled() {
  try { return localStorage.getItem("pushupElo_debug") === "1"; } catch (e) { return false; }
}
function renderPoseDebugOverlay(elId, tracked, angle, repStateNow, counting) {
  if (!isPoseDebugEnabled()) return;
  let el = document.getElementById(elId);
  if (!el) {
    el = document.createElement("pre");
    el.id = elId;
    el.style.cssText = "position:absolute;top:4px;left:4px;z-index:20;background:rgba(0,0,0,0.75);color:#3ce8ff;" +
      "font:11px/1.4 monospace;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;margin:0;";
    document.body.appendChild(el);
  }
  const canvasEl = document.getElementById(elId === "pvpPoseDebug" ? "cameraCanvas" : "rpgCameraCanvas");
  if (canvasEl) {
    const rect = canvasEl.getBoundingClientRect();
    el.style.top = `${rect.top + window.scrollY + 4}px`;
    el.style.left = `${rect.left + window.scrollX + 4}px`;
  }
  const p = tracked.points;
  const fmt = pt => pt ? pt.visibility.toFixed(2) : "—";
  let lines =
    `SIDE: ${(tracked.side || "—").toUpperCase()}\n` +
    `SIDE LOCKED: ${tracked.side ? "YES" : "NO"}\n` +
    `TRACKING: ${tracked.tracking.toUpperCase()}${tracked.tracking === "unstable" ? " (holding previous landmarks)" : ""}\n` +
    `ANGLE: ${angle !== null ? Math.round(angle) + "°" : "—"}\n` +
    `CONFIDENCE  S ${fmt(p.shoulder)}  E ${fmt(p.elbow)}  W ${fmt(p.wrist)}\n` +
    `REP STATE: ${repStateNow.toUpperCase()}`;

  // V1.16: exact rejection-reason readout — the whole point of this pass
  // was "tell me EXACTLY why my real push-up was rejected," not just
  // whether tracking looks stable.
  if (counting) {
    const canvasScale = counting.canvasHeight || 1;
    const movementRatio = counting.shoulderMovement / canvasScale;
    const thresholdRatio = counting.movementThreshold / canvasScale;
    lines += `\nSHOULDER MOVEMENT: ${movementRatio.toFixed(3)}\n` +
      `THRESHOLD: ${thresholdRatio.toFixed(3)}\n` +
      `CAN COUNT: ${counting.canCount ? "YES" : "NO"}`;
    if (!counting.canCount) {
      let reason;
      if (!counting.coreVisible) reason = "shoulder/elbow/wrist/hip not clearly visible";
      else if (!counting.bodyVisible) reason = "full body (knee/ankle) not visible";
      else if (tracked.tracking === "unstable") reason = "tracking unstable — re-locking arm";
      else if (!counting.goodAlignment) reason = `hip alignment (${counting.hipDirection || "sag/pike"}) out of range`;
      else reason = "waiting — no rep transition yet";
      lines += `\nREASON: ${reason}`;
    } else if (counting.lastRepRejectedReason) {
      lines += `\nLAST REP REJECTED: ${counting.lastRepRejectedReason}`;
    }
  }
  el.textContent = lines;
  el.style.display = "block";
}
function hidePoseDebugOverlay(elId) {
  const el = document.getElementById(elId);
  if (el) el.style.display = "none";
}

async function startCamera() {
  const video = document.getElementById("cameraVideo");
  const statusEl = document.getElementById("cameraStatus");
  repState = "up";
  downShoulderY = null;
  downShoulderYExtreme = 0;
  downBodyScale = null;
  pendingDownFrames = 0;
  pendingUpFrames = 0;
  repWasValidThroughout = true;
  invalidStreak = 0;
  lastRepTimestamp = 0;
  lastFeedbackText = "";
  lastFeedbackChangeTime = 0;
  flatZStreak = 0;
  livenessWarningShown = false;
  resetPoseTracker(pvpPoseTracker);

  try {
    statusEl.textContent = "📷 Starting camera…";
    statusEl.classList.remove("hidden");

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 640, height: 480 },
      audio: false,
    });
    video.srcObject = cameraStream;
    await video.play();
    setCameraActiveIndicator("cameraActiveIndicator", true);

    statusEl.textContent = "🧠 Loading AI model… (first time takes ~10-15s)";

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("pose model load timed out")), CONFIG.POSE_MODEL_TIMEOUT_MS)
    );
    await Promise.race([loadPoseModel(), timeoutPromise]);

    statusEl.classList.add("hidden");
  } catch (err) {
    console.error("Camera/pose init failed:", err);
    // No manual fallback — camera/AI detection is the only way to
    // register a rep, so if it can't start, reps simply can't be
    // registered until the camera becomes available again.
    statusEl.textContent = "⚠️ Camera/AI counting unavailable — reps can't be counted until it's working.";
  }
}

function stopCamera() {
  detectionRunning = false;
  setCameraActiveIndicator("cameraActiveIndicator", false);
  hidePoseDebugOverlay("pvpPoseDebug");
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
}

function setDetectionFeedback(text) {
  const now = performance.now();
  if (text === lastFeedbackText) return;
  if (now - lastFeedbackChangeTime < CONFIG.FEEDBACK_MIN_DISPLAY_MS) return;
  lastFeedbackText = text;
  lastFeedbackChangeTime = now;
  const hintEl = document.getElementById("detectionHint");
  if (hintEl) hintEl.textContent = text;
}

function detectionLoop() {
  if (!detectionRunning) return;
  const video = document.getElementById("cameraVideo");
  const canvas = document.getElementById("cameraCanvas");

  if (video.readyState >= 2 && poseLandmarker) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");

    const result = poseLandmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (result.landmarks && result.landmarks.length > 0) {
      const lm = result.landmarks[0];
      const tracked = trackPoseLandmarks(pvpPoseTracker, lm, repState);
      const { shoulder: s, elbow: e, wrist: w, hip, knee, ankle } = tracked.points;

      if (s && e && w) {
        const toPx = p => ({ x: p.x * canvas.width, y: p.y * canvas.height });
        const angle = angleBetween(toPx(s), toPx(e), toPx(w));
        const shoulderPx = toPx(s);
        const hipPx = hip ? toPx(hip) : null;

        drawTrackedArm(ctx, toPx, s, e, w, pvpPoseTracker.heldThisFrame);

        const coreVisible = [s, e, w, hip].every(p => (p?.visibility || 0) > CONFIG.MIN_LANDMARK_VISIBILITY);
        const bodyVisible = [knee, ankle].every(p => (p?.visibility || 0) > CONFIG.MIN_BODY_VISIBILITY);

        let goodAlignment = true;
        let hipDirection = null;
        if (hip && ankle && bodyVisible) {
          const { ratio, direction } = computeHipAlignment(shoulderPx, toPx(hip), toPx(ankle));
          goodAlignment = ratio < CONFIG.MAX_HIP_DEVIATION_RATIO;
          hipDirection = direction;
        }

        // Practical, non-blocking liveness signal — see checkLivenessSignal
        // for what this is (and isn't). Never affects canCount/rep counting.
        // Uses the RAW (pre-smoothing) landmarks for the locked side —
        // liveness is a depth-variance check on .z, which the smoothed
        // tracker output intentionally doesn't carry (it only tracks x/y).
        if (coreVisible) {
          const rawIdx = POSE_SIDE_LANDMARKS[tracked.side];
          const rawPts = { shoulder: lm[rawIdx.shoulder], elbow: lm[rawIdx.elbow], wrist: lm[rawIdx.wrist],
                            hip: lm[rawIdx.hip], knee: lm[rawIdx.knee], ankle: lm[rawIdx.ankle] };
          const zResult = checkLivenessSignal(rawPts, flatZStreak);
          flatZStreak = zResult.streak;
          if (zResult.shouldWarn && !livenessWarningShown) {
            livenessWarningShown = true;
            showNotice("⚠️ This camera feed looks unusually flat for a real person — make sure you're live in front of the camera, not a recording.", 6000);
          }
        }

        if (!coreVisible) {
          setDetectionFeedback("⚠️ Show your full body to the camera.");
        } else if (!bodyVisible) {
          setDetectionFeedback("Stand sideways with your full body visible.");
        } else if (tracked.tracking === "unstable") {
          setDetectionFeedback("⚠️ Keep your side position — AI is re-locking your arm.");
        } else if (!goodAlignment) {
          setDetectionFeedback(hipDirection === "sag" ? "Move your hips slightly up." : "Lower your hips slightly.");
        } else if (repState === "down") {
          setDetectionFeedback("Go a bit lower and fully extend your arms!");
        } else {
          setDetectionFeedback("Good — keep going!");
        }

        // Section 14: never count off an unstable/held tracking frame —
        // wait for the tracker to recover rather than guessing.
        const canCount = coreVisible && bodyVisible && goodAlignment && tracked.tracking === "stable";

        // V1.16: continuously track the peak shoulder displacement reached
        // at ANY point during the down phase — not just a single sample at
        // the down/up transition instants. EMA smoothing (needed for the
        // landmark-stability fix) attenuates the amplitude of a fast
        // oscillating signal like shoulder.y during a real push-up, so
        // sampling only at the two transition boundaries could
        // systematically underestimate genuine movement and reject valid
        // reps. Tracking the running extreme fixes this without touching
        // the smoothing itself — still built entirely from the SAME
        // validated/smoothed points, never raw landmarks.
        if (repState === "down" && downShoulderY !== null) {
          downShoulderYExtreme = Math.max(downShoulderYExtreme, Math.abs(shoulderPx.y - downShoulderY));
        }

        renderPoseDebugOverlay("pvpPoseDebug", tracked, angle, repState, {
          shoulderMovement: downShoulderYExtreme,
          movementThreshold: downBodyScale ? CONFIG.MIN_SHOULDER_MOVEMENT_RATIO_OF_TORSO * downBodyScale : CONFIG.MIN_SHOULDER_MOVEMENT_RATIO * canvas.height,
          canvasHeight: canvas.height,
          canCount, coreVisible, bodyVisible, goodAlignment, hipDirection,
          lastRepRejectedReason: lastPvpRepRejectedReason,
        });

        // Continuously track validity through the "down" phase — brief
        // drops (pose jitter, a frame of low confidence) are tolerated,
        // but a sustained loss (e.g. the person drifted out of frame
        // mid-rep, or only their upper body was ever really visible)
        // invalidates the rep even if canCount happens to be true again
        // by the exact frame the rep completes.
        if (repState === "down") {
          if (canCount) {
            invalidStreak = 0;
          } else {
            invalidStreak += 1;
            if (invalidStreak > CONFIG.REP_VALIDITY_GRACE_FRAMES) repWasValidThroughout = false;
          }
        }

        // Debounce: a threshold crossing must hold for N consecutive frames
        // before the state actually transitions — entering "down" and
        // completing the rep use different N (see CONFIG comments).
        if (repState === "up" && angle < CONFIG.DOWN_ANGLE) {
          pendingDownFrames += 1;
          pendingUpFrames = 0;
          if (pendingDownFrames >= CONFIG.DOWN_STATE_CONFIRM_FRAMES) {
            repState = "down";
            pendingDownFrames = 0;
            downShoulderY = shoulderPx.y;
            downShoulderYExtreme = 0;
            downBodyScale = hipPx ? Math.hypot(shoulderPx.x - hipPx.x, shoulderPx.y - hipPx.y) : null;
            repWasValidThroughout = canCount;
            invalidStreak = 0;
          }
        } else if (repState === "down" && angle > CONFIG.UP_ANGLE) {
          pendingUpFrames += 1;
          pendingDownFrames = 0;
          if (pendingUpFrames >= CONFIG.PVP_UP_STATE_CONFIRM_FRAMES) {
            repState = "up";
            pendingUpFrames = 0;
            const now = performance.now();

            // Movement threshold normalized by the person's OWN body
            // scale (shoulder-to-hip distance captured at the start of
            // the down phase) instead of a fixed fraction of the raw
            // video frame — so the same real-world shoulder travel counts
            // consistently whether they're close to or far from the
            // camera. Falls back to the old frame-relative measure only
            // if the hip wasn't visible when the down phase started.
            const threshold = downBodyScale
              ? CONFIG.MIN_SHOULDER_MOVEMENT_RATIO_OF_TORSO * downBodyScale
              : CONFIG.MIN_SHOULDER_MOVEMENT_RATIO * canvas.height;
            // Peak displacement reached anywhere during the down phase
            // (see the tracking update above) — NOT a single sample taken
            // right at this noisy transition instant.
            downShoulderYExtreme = Math.max(downShoulderYExtreme, Math.abs(shoulderPx.y - downShoulderY));
            const shoulderMoved = downShoulderY !== null && downShoulderYExtreme > threshold;
            // See CONFIG.PVP_MIN_REP_INTERVAL_MS comment: this is a
            // debounce floor against double-counting one push-up, not a
            // speed cap — it must stay low enough that legitimately fast
            // reps pass. PvP-specific (not shared with RPG) since PvP is
            // the speed-competition mode.
            const enoughTimePassed = now - lastRepTimestamp > CONFIG.PVP_MIN_REP_INTERVAL_MS;
            const underCeiling = pushupCount < CONFIG.MAX_PUSHUPS_60S;

            if (repWasValidThroughout && canCount && shoulderMoved && enoughTimePassed && underCeiling) {
              lastRepTimestamp = now;
              pushupCount += 1;
              document.getElementById("pushupCount").textContent = pushupCount;
              if (navigator.vibrate) navigator.vibrate(15);
              playBeep(660, 0.08);
              setDetectionFeedback("Nice rep! 👍");
              lastPvpRepRejectedReason = null;
            } else if (isPoseDebugEnabled()) {
              // Dev-debug only — pinpoint exactly which condition killed
              // this specific down->up cycle, not just a generic "no."
              if (!repWasValidThroughout) lastPvpRepRejectedReason = "lost tracking/visibility during the down phase";
              else if (!shoulderMoved) lastPvpRepRejectedReason = `shoulder movement too small (${(downShoulderYExtreme / canvas.height).toFixed(3)} < ${(threshold / canvas.height).toFixed(3)})`;
              else if (!enoughTimePassed) lastPvpRepRejectedReason = "too soon after the previous rep";
              else if (!underCeiling) lastPvpRepRejectedReason = "60s rep ceiling reached";
              else lastPvpRepRejectedReason = "angle never reached UP threshold cleanly";
            }
            downShoulderY = null;
            downShoulderYExtreme = 0;
            downBodyScale = null;
          }
        } else {
          // Threshold condition didn't hold this frame — the debounce
          // window resets; must be N CONSECUTIVE qualifying frames.
          if (repState === "up") pendingDownFrames = 0;
          if (repState === "down") pendingUpFrames = 0;
        }
      }
    } else {
      setDetectionFeedback("⚠️ Body not detected — stand in front of the camera.");
      if (repState === "down") {
        invalidStreak += 1;
        if (invalidStreak > CONFIG.REP_VALIDITY_GRACE_FRAMES) repWasValidThroughout = false;
      }
    }
  }

  requestAnimationFrame(detectionLoop);
}

async function finishMatch() {
  document.getElementById("myFinalCount").textContent = pushupCount;
  showScreen("pending");
  try {
    const match = await api(`/match/${currentMatchId}/submit`, {
      method: "POST",
      body: JSON.stringify({ count: pushupCount }),
    });
    if (match.status === "completed") {
      showResult(match);
    } else {
      pollForResult();
    }
  } catch (e) {
    document.getElementById("pendingHint").textContent =
      "Failed to submit: " + e.message + " — retrying…";
    setTimeout(finishMatch, 2000);
  }
}

function pollForResult() {
  clearInterval(resultPollInterval);
  resultPollInterval = setInterval(async () => {
    try {
      const match = await api(`/match/${currentMatchId}`);
      if (match.status === "completed") {
        clearInterval(resultPollInterval);
        showResult(match);
      }
    } catch (e) { /* keep polling next tick */ }
  }, 1000);
}

// ---------------------------------------------------------------- result
function showResult(match) {
  const meIsP1 = match.player1.id === me.id;
  const myData = meIsP1 ? match.player1 : match.player2;
  const oppData = meIsP1 ? match.player2 : match.player1;
  const myCount = meIsP1 ? match.player1_count : match.player2_count;
  const oppCount = meIsP1 ? match.player2_count : match.player1_count;

  let title;
  if (match.winner_id === null) title = "🤝 DRAW";
  else if (match.winner_id === me.id) title = "🏆 VICTORY";
  else title = "😤 DEFEAT";

  document.getElementById("resultTitle").textContent = title;
  document.getElementById("resultMeName").textContent = "You (" + myData.username + ")";
  document.getElementById("resultMeCount").textContent = myCount;
  document.getElementById("resultOppName").textContent = oppData.username;
  document.getElementById("resultOppCount").textContent = oppCount;

  const eloDiffMe = myData.elo - me.elo;
  const meEl = document.getElementById("resultMeElo");
  meEl.textContent = (eloDiffMe > 0 ? "+" : "") + eloDiffMe + " Elo → " + myData.elo;
  meEl.className = "eloChange " + (eloDiffMe > 0 ? "up" : eloDiffMe < 0 ? "down" : "flat");

  const eloDiffOpp = oppData.elo - (currentOpponent ? currentOpponent.elo : oppData.elo);
  const oppEl = document.getElementById("resultOppElo");
  oppEl.textContent = (eloDiffOpp > 0 ? "+" : "") + eloDiffOpp + " Elo → " + oppData.elo;
  oppEl.className = "eloChange " + (eloDiffOpp > 0 ? "up" : eloDiffOpp < 0 ? "down" : "flat");

  const pbBadge = document.getElementById("personalBestBadge");
  const streakBadge = document.getElementById("streakBadge");
  if (match.is_new_personal_best) pbBadge.classList.remove("hidden");
  else pbBadge.classList.add("hidden");
  if (match.your_streak && match.your_streak >= 2) {
    streakBadge.textContent = `🔥 ${match.your_streak} match win streak!`;
    streakBadge.classList.remove("hidden");
  } else {
    streakBadge.classList.add("hidden");
  }

  // V1.3: XP / level progression — all values come from the server
  // (match.xp_awarded / new_level / leveled_up), never computed client-side.
  const xpGained = match.xp_awarded || 0;
  document.getElementById("resultXpGained").textContent = `+${xpGained} XP`;
  const level = match.new_level || 1;
  const xpForLevel = getXpForLevelClientEstimate(level);
  const xpForNext = getXpForLevelClientEstimate(level + 1);
  const yourXp = match.your_xp || 0;
  document.getElementById("resultLevelLabel").textContent = `LEVEL ${level}`;
  document.getElementById("resultXpLabel").textContent = `${yourXp - xpForLevel} / ${xpForNext - xpForLevel} XP`;
  const span = xpForNext - xpForLevel;
  const progress = span > 0 ? Math.min(100, 100 * (yourXp - xpForLevel) / span) : 100;
  document.getElementById("resultXpBarFill").style.width = progress + "%";

  const levelUpBanner = document.getElementById("resultLevelUpBanner");
  if (match.leveled_up) {
    levelUpBanner.textContent = `🎉 LEVEL UP! You reached Level ${level}.`;
    levelUpBanner.classList.remove("hidden");
    playBeep(1318, 0.2);
    spawnEmberParticles(levelUpBanner, 8);
  } else {
    levelUpBanner.classList.add("hidden");
  }

  if (match.achievements_unlocked && match.achievements_unlocked.length > 0) {
    queueAchievementToasts(match.achievements_unlocked);
  }

  me = myData;
  updateUserBadge();
  resetRematchUI();
  showScreen("result");
  if (!match.is_bot_match) pollRematchStatus();
}

// Mirrors the server's get_xp_for_level() curve for display purposes only
// (the server-computed new_level/your_xp are always authoritative — this
// just re-derives the level's XP *boundaries* to draw the progress bar).
function getXpForLevelClientEstimate(level) {
  if (level <= 1) return 0;
  let total = 0;
  for (let lvl = 2; lvl <= level; lvl++) total += 50 * lvl;
  return total;
}

document.getElementById("playAgainBtn").addEventListener("click", () => {
  clearInterval(rematchPollInterval);
  loadLeaderboard();
  showScreen("lobby");
});

// ---------------------------------------------------------------- rematch (V1.2)
function resetRematchUI() {
  document.getElementById("rematchBtn").classList.remove("hidden");
  document.getElementById("rematchBtn").disabled = false;
  document.getElementById("rematchStatus").classList.add("hidden");
  document.getElementById("rematchRespondBox").classList.add("hidden");
}

document.getElementById("rematchBtn").addEventListener("click", async () => {
  try {
    const res = await api(`/match/${currentMatchId}/rematch`, { method: "POST" });
    if (res.status === "created") {
      clearInterval(rematchPollInterval);
      await enterMatch(res.new_match_id);
      return;
    }
    document.getElementById("rematchBtn").disabled = true;
    document.getElementById("rematchStatus").textContent = "Waiting… (opponent needs to accept)";
    document.getElementById("rematchStatus").classList.remove("hidden");
  } catch (e) {
    alert(e.message);
  }
});

document.getElementById("rematchAcceptBtn").addEventListener("click", async () => {
  try {
    const res = await api(`/match/${currentMatchId}/rematch-respond`, {
      method: "POST",
      body: JSON.stringify({ accept: true }),
    });
    if (res.status === "created") {
      clearInterval(rematchPollInterval);
      await enterMatch(res.new_match_id);
    }
  } catch (e) {
    alert(e.message);
  }
});

document.getElementById("rematchDeclineBtn").addEventListener("click", async () => {
  try {
    await api(`/match/${currentMatchId}/rematch-respond`, {
      method: "POST",
      body: JSON.stringify({ accept: false }),
    });
    document.getElementById("rematchRespondBox").classList.add("hidden");
  } catch (e) { /* best effort */ }
});

function pollRematchStatus() {
  clearInterval(rematchPollInterval);
  rematchPollInterval = setInterval(async () => {
    try {
      const res = await api(`/match/${currentMatchId}/rematch-status`);
      if (res.status === "pending" && !res.is_me_requester) {
        document.getElementById("rematchBtn").classList.add("hidden");
        document.getElementById("rematchRequestText").textContent =
          `${res.requester_username} wants a rematch.`;
        document.getElementById("rematchRespondBox").classList.remove("hidden");
      } else if ((res.status === "created" || res.status === "accepted") && res.new_match_id) {
        // BUG FIX: the requester's poll previously only handled 'created',
        // but /rematch-status reports the opponent's acceptance as
        // 'accepted' (see rematch_requests.status in app.py) — so the
        // requester never left the "Waiting..." screen once the other
        // player clicked Accept. Both statuses mean the same thing here:
        // a new match now exists and this player should enter it.
        clearInterval(rematchPollInterval);
        await enterMatch(res.new_match_id);
      } else if (res.status === "declined" || res.status === "expired") {
        clearInterval(rematchPollInterval);
        resetRematchUI();
      }
    } catch (e) { /* keep polling next tick */ }
  }, CONFIG.REMATCH_POLL_MS);
}

// =============================================================================
// V1.4: Social system — friends, player search, public profiles, challenges,
// notifications, activity feed, friends leaderboard, lightweight online status.
// =============================================================================

// ROOT CAUSE (challenge delivery bug): this used to be a single 15000ms
// interval, so a freshly-sent challenge could sit unseen for up to 15s —
// which reads as "the second challenge failed to arrive" even though the
// server-side notification was created correctly (visiting Notifications
// triggers an immediate un-cached fetch, which is why it "worked" there).
// Fix: poll faster while the tab is actually visible/focused (where an
// "immediate" delivery actually matters to the user), fall back to a slow
// interval while backgrounded to avoid extra server load, and force one
// immediate refresh the moment the tab regains focus/visibility.
const NOTIF_POLL_MS_ACTIVE = 3000;    // foregrounded: fast enough to feel immediate
const NOTIF_POLL_MS_BACKGROUND = 20000; // backgrounded: don't burn requests on a tab no one is watching
const HEARTBEAT_MS = 40000;    // how often to ping /api/heartbeat (last_seen)
let notifPollInterval = null;
let heartbeatInterval = null;

function currentNotifPollMs() {
  return (typeof document !== "undefined" && document.hidden) ? NOTIF_POLL_MS_BACKGROUND : NOTIF_POLL_MS_ACTIVE;
}

const OUTCOME_ICON = {
  FRIEND_REQUEST: "👋", FRIEND_ACCEPTED: "🤝", CHALLENGE_RECEIVED: "⚔️",
  CHALLENGE_ACCEPTED: "✅", CHALLENGE_DECLINED: "❌",
};
const ACTIVITY_TEXT = {
  LEVEL_UP: (n, ref) => `${n} reached Level ${ref}.`,
  ACHIEVEMENT_UNLOCKED: (n, ref) => `${n} unlocked "${ref}".`,
  PERSONAL_BEST: (n, ref) => `${n} set a new personal best (${ref}).`,
  WIN_STREAK: (n, ref) => `${n} is on a ${ref}-match win streak!`,
  RANK_REACHED: (n) => `${n} reached a new rank.`,
};

// ---------------------------------------------------------------- heartbeat / online status
function startHeartbeat() {
  clearInterval(heartbeatInterval);
  api("/heartbeat", { method: "POST" }).catch(() => {});
  heartbeatInterval = setInterval(() => {
    api("/heartbeat", { method: "POST" }).catch(() => {});
  }, HEARTBEAT_MS);
}

// ---------------------------------------------------------------- notifications
function startNotifPolling() {
  clearInterval(notifPollInterval);
  refreshUnreadBadge();
  notifPollInterval = setInterval(refreshUnreadBadge, currentNotifPollMs());
}

// Re-arm the interval at the right cadence when visibility changes, and —
// this is the part that actually fixes "only shows up after opening
// Notifications" — fetch immediately the moment the tab becomes visible
// again instead of waiting for the next tick.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!notifPollInterval) return; // not logged in / polling not started yet
    clearInterval(notifPollInterval);
    notifPollInterval = setInterval(refreshUnreadBadge, currentNotifPollMs());
    if (!document.hidden) refreshUnreadBadge();
  });
}

async function refreshUnreadBadge() {
  try {
    const r = await api("/notifications/unread-count");
    const badge = document.getElementById("notifUnreadBadge");
    if (r.count > 0) {
      badge.textContent = r.count > 99 ? "99+" : r.count;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  } catch (e) { /* non-critical */ }

  // Also check for a fresh incoming challenge to surface as a modal —
  // lightweight: only look at the few most recent notifications.
  try {
    const notifs = await api("/notifications?limit=5");

    const freshChallenge = notifs.find(n => n.type === "CHALLENGE_RECEIVED" && !n.is_read);
    const challengeModalEl = document.getElementById("challengeModal");
    if (freshChallenge && String(freshChallenge.id) !== challengeModalEl.dataset.shownFor) {
      showChallengeModal(freshChallenge);
    }

    // BUG FIX: the CHALLENGER's browser previously stayed on the "Waiting
    // for opponent" screen even after the opponent accepted — they had to
    // refresh manually. Auto-detect CHALLENGE_ACCEPTED and enter the match.
    const currentScreen = Object.keys(screens).find(k => !screens[k].classList.contains("hidden"));
    const alreadyMidFlow = IN_MATCH_SCREENS.has(currentScreen);
    const acceptedNotif = notifs.find(n => n.type === "CHALLENGE_ACCEPTED" && !n.is_read);
    if (acceptedNotif && acceptedNotif.reference_id && !alreadyMidFlow) {
      // Mark read FIRST — this is what makes reprocessing safe: if this
      // fires twice in a race (e.g. two overlapping polls), only one can
      // see is_read=0, since the read call is awaited before acting.
      await api(`/notifications/${acceptedNotif.id}/read`, { method: "POST" });
      await enterMatch(acceptedNotif.reference_id);
    }
  } catch (e) { /* non-critical */ }
}

document.getElementById("notifBellBtn").addEventListener("click", async () => {
  const panel = document.getElementById("notifPanel");
  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  try {
    const notifs = await api("/notifications?limit=30");
    const list = document.getElementById("notifPanelList");
    list.innerHTML = "";
    if (notifs.length === 0) {
      list.innerHTML = `<li class="historyEmpty">No notifications.</li>`;
    } else {
      notifs.forEach(n => {
        const li = document.createElement("li");
        li.className = "notifItem" + (n.is_read ? "" : " unread");
        const ago = timeAgo(n.created_at);
        li.innerHTML = `
          <span class="notifIcon">${OUTCOME_ICON[n.type] || "🔔"}</span>
          <span class="notifText">${notifText(n)}<br><span class="hint">${ago}</span></span>
        `;
        li.addEventListener("click", async () => {
          if (!n.is_read) {
            await api(`/notifications/${n.id}/read`, { method: "POST" });
            li.classList.remove("unread");
            refreshUnreadBadge();
          }
        });
        list.appendChild(li);
      });
    }
    panel.classList.remove("hidden");
  } catch (e) { /* best effort */ }
});

document.getElementById("markAllReadBtn").addEventListener("click", async () => {
  try {
    await api("/notifications/read-all", { method: "POST" });
    document.querySelectorAll("#notifPanelList .notifItem").forEach(li => li.classList.remove("unread"));
    refreshUnreadBadge();
  } catch (e) { /* best effort */ }
});

function notifText(n) {
  const who = escapeHtml(n.actor_username || "Someone");
  switch (n.type) {
    case "FRIEND_REQUEST": return `${who} sent a friend request.`;
    case "FRIEND_ACCEPTED": return `${who} accepted your friend request.`;
    case "CHALLENGE_RECEIVED": return `${who} challenged you.`;
    case "CHALLENGE_ACCEPTED": return `${who} accepted your challenge.`;
    case "CHALLENGE_DECLINED": return `${who} declined your challenge.`;
    default: return `${who}`;
  }
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------------------------------------------------------------- challenge modal
function showChallengeModal(notif) {
  const modal = document.getElementById("challengeModal");
  modal.dataset.shownFor = notif.id;
  modal.dataset.notifId = notif.id;
  modal.dataset.challengeId = notif.reference_id;
  document.getElementById("challengeModalText").textContent =
    `${notif.actor_username || "A friend"} challenged you!`;
  modal.classList.remove("hidden");
}

document.getElementById("challengeAcceptBtn").addEventListener("click", async () => {
  const modal = document.getElementById("challengeModal");
  const chalId = modal.dataset.challengeId;
  const notifId = modal.dataset.notifId;
  modal.classList.add("hidden");
  let res = null;
  try {
    res = await api(`/challenges/${chalId}/accept`, { method: "POST" });
  } catch (e) {
    alert(e.message);
  }
  // Always mark the originating notification read, even on failure (e.g. the
  // challenge already expired/was resolved elsewhere) — otherwise it keeps
  // being picked up as "fresh" by polling and reopens this modal forever.
  if (notifId) {
    try { await api(`/notifications/${notifId}/read`, { method: "POST" }); } catch (e2) { /* best effort */ }
    refreshUnreadBadge();
  }
  if (res && res.status === "accepted" && res.match_id) {
    await enterMatch(res.match_id);
  }
});

document.getElementById("challengeDeclineBtn").addEventListener("click", async () => {
  const modal = document.getElementById("challengeModal");
  const chalId = modal.dataset.challengeId;
  const notifId = modal.dataset.notifId;
  modal.classList.add("hidden");
  try { await api(`/challenges/${chalId}/decline`, { method: "POST" }); } catch (e) { /* best effort */ }
  if (notifId) {
    try { await api(`/notifications/${notifId}/read`, { method: "POST" }); } catch (e2) { /* best effort */ }
    refreshUnreadBadge();
  }
});

// ---------------------------------------------------------------- friends screen
async function loadFriendsScreen() {
  document.getElementById("playerSearchResults").innerHTML = "";
  document.getElementById("playerSearchInput").value = "";
  await Promise.all([loadFriendRequests(), loadFriendsList(), loadFriendsActivity()]);
}

let searchDebounceTimer = null;
document.getElementById("playerSearchInput").addEventListener("input", (e) => {
  clearTimeout(searchDebounceTimer);
  const q = e.target.value.trim();
  const resultsEl = document.getElementById("playerSearchResults");
  if (!q) { resultsEl.innerHTML = ""; return; }
  searchDebounceTimer = setTimeout(async () => {
    try {
      const results = await api(`/players/search?q=${encodeURIComponent(q)}`);
      resultsEl.innerHTML = "";
      results.forEach(u => {
        const li = document.createElement("li");
        li.className = "friendListItem";
        li.innerHTML = `
          <span class="onlineDot ${u.online ? "isOnline" : ""}"></span>
          <span class="avatarSmall">${avatarEmoji(u.avatar_id)}</span>
          <span class="friendListName">${escapeHtml(u.username)}</span>
          <span class="hint">${u.rank_tier} · ${u.elo}</span>
        `;
        li.addEventListener("click", () => openPublicProfile(u.username));
        resultsEl.appendChild(li);
      });
      if (results.length === 0) resultsEl.innerHTML = `<li class="historyEmpty">No results.</li>`;
    } catch (e) { /* best effort */ }
  }, 300);
});

async function loadFriendRequests() {
  try {
    const r = await api("/friends/requests");
    const incoming = document.getElementById("incomingRequestsList");
    const outgoing = document.getElementById("outgoingRequestsList");
    incoming.innerHTML = "";
    outgoing.innerHTML = "";

    if (r.incoming.length === 0 && r.outgoing.length === 0) {
      document.getElementById("friendRequestsBox").classList.add("hidden");
      return;
    }
    document.getElementById("friendRequestsBox").classList.remove("hidden");

    r.incoming.forEach(req => {
      const div = document.createElement("div");
      div.className = "requestCard";
      div.innerHTML = `
        <span class="avatarSmall">${avatarEmoji(req.avatar_id)}</span>
        <span class="friendListName">${escapeHtml(req.username)}</span>
        <button class="reqAcceptBtn" data-id="${req.id}">Accept</button>
        <button class="reqDeclineBtn secondary" data-id="${req.id}">Decline</button>
      `;
      incoming.appendChild(div);
    });
    incoming.querySelectorAll(".reqAcceptBtn").forEach(btn => {
      btn.addEventListener("click", async () => {
        await api(`/friends/requests/${btn.dataset.id}/accept`, { method: "POST" });
        loadFriendsScreen();
      });
    });
    incoming.querySelectorAll(".reqDeclineBtn").forEach(btn => {
      btn.addEventListener("click", async () => {
        await api(`/friends/requests/${btn.dataset.id}/decline`, { method: "POST" });
        loadFriendsScreen();
      });
    });

    r.outgoing.forEach(req => {
      const div = document.createElement("div");
      div.className = "requestCard";
      div.innerHTML = `
        <span class="avatarSmall">${avatarEmoji(req.avatar_id)}</span>
        <span class="friendListName">${escapeHtml(req.username)}</span>
        <span class="hint">Pending…</span>
        <button class="reqCancelBtn secondary" data-id="${req.id}">Cancel</button>
      `;
      outgoing.appendChild(div);
    });
    outgoing.querySelectorAll(".reqCancelBtn").forEach(btn => {
      btn.addEventListener("click", async () => {
        await api(`/friends/requests/${btn.dataset.id}/cancel`, { method: "POST" });
        loadFriendsScreen();
      });
    });
  } catch (e) { /* best effort */ }
}

async function loadFriendsList() {
  try {
    const friends = await api("/friends");
    document.getElementById("friendsCount").textContent = friends.length;
    const list = document.getElementById("friendsList");
    list.innerHTML = "";
    if (friends.length === 0) {
      list.innerHTML = `<li class="emptyState"><div class="emptyStateTitle">🤝 BUILD YOUR RIVALRY</div><div class="hint">Find players to challenge.</div></li>`;
      return;
    }
    friends.forEach(f => {
      const li = document.createElement("li");
      li.className = "friendListItem";
      li.innerHTML = `
        <span class="onlineDot ${f.online ? "isOnline" : ""}"></span>
        <span class="avatarSmall">${avatarEmoji(f.avatar_id)}</span>
        <span class="friendListName">${escapeHtml(f.username)}<br><span class="hint">${escapeHtml(f.rank_tier)} · ${f.elo} Elo${f.current_streak >= 2 ? " · 🔥" + f.current_streak : ""}</span></span>
        <button class="challengeBtn" data-id="${f.id}">Challenge</button>
      `;
      li.querySelector(".friendListName").addEventListener("click", () => openPublicProfile(f.username));
      li.querySelector(".challengeBtn").addEventListener("click", async (ev) => {
        ev.stopPropagation();
        try {
          const res = await api("/challenges", { method: "POST", body: JSON.stringify({ challenged_id: f.id }) });
          if (res.status === "accepted" && res.match_id) {
            await enterMatch(res.match_id);
          } else {
            showNotice(`Challenge sent to ${f.username}.`);
          }
        } catch (e) {
          alert(e.message);
        }
      });
      list.appendChild(li);
    });
  } catch (e) { /* best effort */ }
}

async function loadFriendsActivity() {
  try {
    const activity = await api("/friends/activity");
    const list = document.getElementById("friendsActivityList");
    list.innerHTML = "";
    if (activity.length === 0) {
      list.innerHTML = `<li class="historyEmpty">No recent activity.</li>`;
      return;
    }
    activity.forEach(a => {
      const li = document.createElement("li");
      li.className = "historyItem";
      const textFn = ACTIVITY_TEXT[a.event_type];
      li.textContent = textFn ? textFn(a.username, a.reference_id) : `${a.username}`;
      list.appendChild(li);
    });
  } catch (e) { /* best effort */ }
}

// ---------------------------------------------------------------- public profile
async function openPublicProfile(username) {
  try {
    const p = await api(`/players/${encodeURIComponent(username)}`);
    document.getElementById("publicProfileAvatar").textContent = avatarEmoji(p.avatar_id);
    document.getElementById("publicProfileUsername").textContent = p.username;
    document.getElementById("publicProfileRankBadge").textContent = `${p.rank_tier} · ${p.elo} Elo`;
    const countryEl = document.getElementById("publicProfileCountry");
    if (p.country) { countryEl.textContent = countryDisplay(p.country); countryEl.classList.remove("hidden"); }
    else countryEl.classList.add("hidden");
    const bioEl = document.getElementById("publicProfileBio");
    if (p.bio) { bioEl.textContent = p.bio; bioEl.classList.remove("hidden"); }
    else bioEl.classList.add("hidden");
    const joinEl = document.getElementById("publicProfileJoinDate");
    if (p.created_at) {
      const d = new Date(p.created_at);
      joinEl.textContent = isNaN(d) ? "" : `Joined ${d.toLocaleDateString(undefined, { year: "numeric", month: "long" })}`;
      joinEl.classList.toggle("hidden", isNaN(d));
    } else {
      joinEl.classList.add("hidden");
    }

    const restrictedNote = document.getElementById("publicProfileRestrictedNote");
    const rpgSection = document.getElementById("publicProfileRpgSection");
    const statsBox = document.getElementById("publicProfileStats");
    const achTitle = document.getElementById("publicProfileAchTitle");
    const achGrid = document.getElementById("publicProfileAchievements");

    if (p.restricted) {
      restrictedNote.classList.remove("hidden");
      rpgSection.classList.add("hidden");
      statsBox.classList.add("hidden");
      achTitle.classList.add("hidden");
      achGrid.innerHTML = "";
      renderPublicProfileAction(p);
      showScreen("publicProfile");
      return;
    }
    restrictedNote.classList.add("hidden");
    statsBox.classList.remove("hidden");
    achTitle.classList.remove("hidden");

    document.getElementById("publicProfileElo").textContent = p.elo;
    document.getElementById("publicProfilePeakElo").textContent = p.peak_elo;
    const totalMatches = p.wins + p.losses + p.draws;
    document.getElementById("publicProfileWinRate").textContent =
      totalMatches > 0 ? `${Math.round(100 * p.wins / totalMatches)}%` : "—";
    document.getElementById("publicProfileTotalMatches").textContent = totalMatches;
    document.getElementById("publicProfileWins").textContent = p.wins;
    document.getElementById("publicProfileLosses").textContent = p.losses;
    document.getElementById("publicProfileBest").textContent = p.best_pushups;
    document.getElementById("publicProfileTotalPushups").textContent = p.total_pushups;

    // Character + RPG progression — same renderEquippedCharacter() used
    // everywhere else; this player's ACTUAL current tier, never a
    // default/placeholder (p.rpg is null only if they've genuinely never
    // touched the RPG at all).
    if (p.rpg) {
      rpgSection.classList.remove("hidden");
      document.getElementById("publicProfileCharacterPortrait").innerHTML = renderEquippedCharacter(p.rpg, 110);
      document.getElementById("publicProfileRpgBadge").innerHTML = renderRankBadge(p.rpg.rpg_rank, 36);
      document.getElementById("publicProfileRpgLevelText").textContent = `LEVEL ${p.rpg.rpg_level} · ${p.rpg.rpg_rank.toUpperCase()}`;
      document.getElementById("publicProfileEmberfallReps").textContent =
        `${p.rpg.emberfall_progress_value.toLocaleString()} / ${p.rpg.emberfall_progress_total.toLocaleString()} reps reclaimed`;
      document.getElementById("publicProfileChestLabel").textContent = `🛡 ${p.rpg.current_armor}`;
      document.getElementById("publicProfileShieldLabel").textContent = `🔰 ${p.rpg.current_shield}`;
      document.getElementById("publicProfileRealmsLine").textContent =
        `Realms Reclaimed: ${p.rpg.realms_completed} / ${p.rpg.realms_total}`;
    } else {
      rpgSection.classList.add("hidden");
    }

    achGrid.innerHTML = "";
    achGrid.className = "achievementsGridSmall";
    p.achievements.forEach(a => {
      const box = document.createElement("div");
      box.className = "achBadge" + (a.unlocked ? " unlocked" : " locked");
      box.title = a.name;
      box.textContent = a.icon;
      achGrid.appendChild(box);
    });
    achTitle.textContent = `Achievements (${p.achievement_count} / ${p.achievement_total})`;

    renderPublicProfileAction(p);
    showScreen("publicProfile");
  } catch (e) {
    alert(e.message);
  }
}

function renderPublicProfileAction(p) {
  const area = document.getElementById("publicProfileActionArea");
  area.innerHTML = "";
  if (p.relationship === "self") return;

  const btn = document.createElement("button");
  if (p.relationship === "friends") {
    btn.textContent = "⚔️ Challenge";
    btn.addEventListener("click", async () => {
      try {
        const res = await api("/challenges", { method: "POST", body: JSON.stringify({ challenged_id: p.id }) });
        if (res.status === "accepted" && res.match_id) await enterMatch(res.match_id);
        else showNotice(`Challenge sent to ${p.username}.`);
      } catch (e) { alert(e.message); }
    });
  } else if (p.relationship === "request_sent") {
    btn.textContent = "⏳ Request Sent";
    btn.disabled = true;
  } else if (p.relationship === "request_received") {
    btn.textContent = "✅ Accept";
    btn.addEventListener("click", async () => {
      await api(`/friends/requests/${p.request_id}/accept`, { method: "POST" });
      openPublicProfile(p.username);
    });
  } else {
    btn.textContent = "➕ Add Friend";
    btn.addEventListener("click", async () => {
      await api("/friends/request", { method: "POST", body: JSON.stringify({ receiver_id: p.id }) });
      openPublicProfile(p.username);
    });
  }
  area.appendChild(btn);
}

document.getElementById("backFromPublicProfileBtn").addEventListener("click", () => {
  showScreen("friends");
});

// ---------------------------------------------------------------- friends leaderboard on lobby leaderboard tabs
// (Reuses the existing #lbTab mechanism — add a 4th tab entry if present in HTML.)
document.querySelectorAll(".lbTab[data-tab='friends']").forEach(btn => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".lbTab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    try {
      const rows = await api("/friends/leaderboard");
      const list = document.getElementById("leaderboardList");
      list.innerHTML = "";
      if (rows.length === 0) {
        list.innerHTML = `<li class="lbEmptyState">
          <div class="lbEmptyTitle">🤝 LOOKING FOR OPPONENTS?</div>
          <div class="hint">Add friends to compete with.</div>
        </li>`;
        return;
      }
      rows.forEach((u, i) => {
        const li = document.createElement("li");
        li.className = "lbRow";
        if (i === 0) li.classList.add("lbRowTop1");
        else if (i === 1) li.classList.add("lbRowTop2");
        else if (i === 2) li.classList.add("lbRowTop3");
        const rankLabel = i < 3 ? ["🥇", "🥈", "🥉"][i] : `#${i + 1}`;
        li.innerHTML = `<span class="lbRank">${rankLabel}</span><span class="lbName"><strong>${escapeHtml(u.username)}</strong><br><span class="hint">${escapeHtml(u.rank_tier)}</span></span><span class="lbElo">${u.elo}</span>`;
        list.appendChild(li);
      });
    } catch (e) { /* non-critical */ }
  });
});

// Start social background tasks once logged in.
const _origResumeActiveMatchIfAny = resumeActiveMatchIfAny;
resumeActiveMatchIfAny = async function() {
  startHeartbeat();
  startNotifPolling();
  return _origResumeActiveMatchIfAny.apply(this, arguments);
};

// =============================================================================
// V1.5: RPG system — home screen, monster list, battle (reuses the SAME
// pose model singleton, angleBetween() math, and CONFIG thresholds as PvP
// via loadPoseModel()/angleBetween() above — NOT a second AI detector,
// just a parallel camera-loop wired to the RPG screen's own DOM elements
// and its own (separate) rep-detection state, since the PvP loop is
// tightly coupled to PvP-specific globals (pushupCount, currentMatchId)
// and refactoring that proven, heavily-tested code was judged riskier
// than this small amount of parallel wiring.
// =============================================================================

document.getElementById("navRpgBtn").addEventListener("click", () => {
  setActiveNav(document.getElementById("navRpgBtn"));
  loadRpgWorld();
  showScreen("rpgWorld");
});

// screens map + setActiveNav need the new RPG screens/tab included.
screens.rpgWorld = document.getElementById("rpgWorldScreen");
screens.rpgHome = document.getElementById("rpgHomeScreen");
screens.rpgBattle = document.getElementById("rpgBattleScreen");
screens.rpgResult = document.getElementById("rpgResultScreen");
IN_MATCH_SCREENS.add("rpgBattle");

document.getElementById("rpgBackToWorldBtn").addEventListener("click", () => {
  loadRpgWorld();
  showScreen("rpgWorld");
});

const _origSetActiveNav = setActiveNav;
setActiveNav = function(activeBtn) {
  document.getElementById("navRpgBtn").classList.remove("active");
  _origSetActiveNav(activeBtn);
};

// =============================================================================
// VISOREP RPG — original SVG asset library (NO emoji as primary art)
// -----------------------------------------------------------------------------
// Every function below returns a self-contained inline <svg> string. Each
// call gets a unique id suffix so gradients/filters never collide when the
// same badge/emblem renders more than once on a page (e.g. RPG home +
// Profile at the same time). These are original vector constructions —
// simple, clean geometric shapes, not photorealistic illustration; see the
// implementation report for what's still a placeholder awaiting real
// artwork versus what's final.
// =============================================================================
let _svgIdCounter = 0;
function _svgId(prefix) { return `${prefix}${_svgIdCounter++}`; }

// ---- Rank badges: Novice -> Legend, each visually DISTINCT (not just a
// recolor) — escalating silhouette complexity, wing flares, and glow,
// styled after the approved dark-fantasy reference board's badge row. ----
const RPG_RANK_THEME = {
  Novice:  { primary: "#8a6a4a", secondary: "#3a2f22", glow: null,                     wings: 0, icon: "none" },
  Fighter: { primary: "#9aa0aa", secondary: "#2a2c31", glow: null,                     wings: 0, icon: "blade" },
  Warrior: { primary: "#c0a060", secondary: "#2a1f14", glow: "#c0a06033",             wings: 1, icon: "crossblades" },
  Elite:   { primary: "#2aa6b7", secondary: "#12262a", glow: "#2aa6b755",             wings: 1, icon: "spark" },
  Master:  { primary: "#ffb347", secondary: "#2a220f", glow: "#ffb34766",             wings: 2, icon: "star" },
  Legend:  { primary: "#ff5a1f", secondary: "#1c0906", glow: "#ff5a1f88",             wings: 2, icon: "aura" },
};
function rankBadgeSvg(rank, size = 56) {
  const t = RPG_RANK_THEME[rank] || RPG_RANK_THEME.Novice;
  const id = _svgId("rank");
  // Pointed hexagonal shield, closer to the reference badge silhouette
  // than a rounded crest — flat shoulders, sharp base point.
  const shield = "M32 4 L52 12 L52 30 C52 46 44 54 32 60 C20 54 12 46 12 30 L12 12 Z";
  let wings = "";
  for (let i = 0; i < t.wings; i++) {
    const y = 22 + i * 8;
    wings += `<path d="M12 ${y} L2 ${y - 4} L4 ${y + 6} L12 ${y + 4} Z M52 ${y} L62 ${y - 4} L60 ${y + 6} L52 ${y + 4} Z" fill="${t.primary}" opacity="${0.85 - i * 0.15}"/>`;
  }
  let icon = "";
  if (t.icon === "blade") icon = `<path d="M32 20 L32 44 M26 24 L38 24" stroke="${t.secondary}" stroke-width="2.5" stroke-linecap="round"/>`;
  if (t.icon === "crossblades") icon = `<path d="M23 20 L41 42 M41 20 L23 42" stroke="${t.secondary}" stroke-width="2.5" stroke-linecap="round"/>`;
  if (t.icon === "spark") icon = `<path d="M32 18 L36 30 L32 30 L36 44 L26 28 L31 28 Z" fill="${t.secondary}"/>`;
  if (t.icon === "star") icon = `<path d="M32 18 L35 27 L44 27 L37 33 L39 42 L32 37 L25 42 L27 33 L20 27 L29 27 Z" fill="${t.secondary}"/>`;
  if (t.icon === "aura") icon = `<circle cx="32" cy="32" r="6" fill="${t.secondary}"/><circle cx="32" cy="32" r="10" fill="none" stroke="${t.secondary}" stroke-width="1.5" opacity="0.7"/><circle cx="32" cy="32" r="14" fill="none" stroke="${t.primary}" stroke-width="1" opacity="0.4"/>`;
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${t.primary}"/><stop offset="100%" stop-color="${t.secondary}"/>
      </linearGradient>
      ${t.glow ? `<filter id="${id}f" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : ""}
    </defs>
    ${wings}
    <path d="${shield}" fill="url(#${id}g)" stroke="${t.secondary}" stroke-width="2" ${t.glow ? `filter="url(#${id}f)"` : ""}/>
    <path d="${shield}" transform="scale(0.82)" transform-origin="32 32" fill="none" stroke="${t.primary}" stroke-width="1" opacity="0.4"/>
    ${icon}
  </svg>`;
}

// ---- Realm emblems — a shield crest with a realm-specific glyph, styled
// after the reference board's realm badges. ----
const REALM_THEME = {
  emberfall:  { primary: "#ff5a1f", secondary: "#2a1610", glyph: "flame" },
  thornveil:  { primary: "#5fae5a", secondary: "#152a18", glyph: "thorn" },
  stoneheart: { primary: "#9aa0aa", secondary: "#22262c", glyph: "peak" },
  ironreach:  { primary: "#c7c9cf", secondary: "#26282e", glyph: "tower" },
  stormspire: { primary: "#2aa6b7", secondary: "#12262a", glyph: "bolt" },
};
function realmEmblemSvg(code, size = 40) {
  const t = REALM_THEME[code] || REALM_THEME.emberfall;
  const id = _svgId("realm");
  const shield = "M32 6 L50 14 V30 C50 42 42 50 32 56 C22 50 14 42 14 30 V14 Z";
  let glyph = "";
  if (t.glyph === "flame") glyph = `<path d="M32 16 C26 24 22 28 22 35 C22 42 27 46 32 46 C37 46 42 42 42 35 C42 30 39 27 37 23 C37 27 34 28 33 25 C31 21 34 18 32 16 Z" fill="${t.primary}"/>`;
  if (t.glyph === "thorn") glyph = `<path d="M32 16 L32 46 M32 22 L25 27 M32 28 L39 33 M32 34 L25 39" stroke="${t.primary}" stroke-width="2.5" stroke-linecap="round" fill="none"/>`;
  if (t.glyph === "peak") glyph = `<path d="M19 42 L27 24 L33 33 L38 26 L45 42 Z" fill="${t.primary}"/>`;
  if (t.glyph === "tower") glyph = `<path d="M25 44 V27 H29 V23 H35 V27 H39 V44 Z M28 23 V19 H31 V23 M33 23 V19 H36 V23" fill="${t.primary}"/>`;
  if (t.glyph === "bolt") glyph = `<path d="M35 16 L24 34 L31 34 L28 46 L41 27 L33 27 Z" fill="${t.primary}"/>`;
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${t.secondary}"/><stop offset="100%" stop-color="#0a0b0d"/></linearGradient></defs>
    <path d="${shield}" fill="url(#${id}g)" stroke="${t.primary}" stroke-width="2"/>
    <path d="${shield}" transform="scale(0.86)" transform-origin="32 32" fill="none" stroke="${t.primary}" stroke-width="1" opacity="0.4"/>
    ${glyph}
  </svg>`;
}

// ---- Emberfall location markers — one glyph per named location. ----
function locationMarkerSvg(locationName, isBoss, size = 34) {
  const primary = isBoss ? "#ff5a3c" : "#ffb84d";
  const secondary = isBoss ? "#2a1008" : "#241a0d";
  const id = _svgId("loc");
  const glyphs = {
    "Ashen Gate": `<path d="M18 44 V24 Q32 12 46 24 V44 M18 44 H46 M24 44 V30 M40 44 V30" stroke="${primary}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
    "Cinder Road": `<path d="M16 44 L32 16 L48 44 Z" fill="none" stroke="${primary}" stroke-width="2.5"/><circle cx="32" cy="34" r="2.5" fill="${primary}"/>`,
    "Ember Ruins": `<path d="M20 44 V26 H27 V44 M37 44 V20 H44 V44" stroke="${primary}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
    "Fallen Shrine": `<path d="M16 26 L32 16 L48 26 M20 26 V44 H44 V26" stroke="${primary}" stroke-width="2.5" fill="none" stroke-linejoin="round"/>`,
    "Iron Bastion": `<path d="M22 44 V22 H27 V18 H37 V22 H42 V44 Z M27 22 H37" stroke="${primary}" stroke-width="2.5" fill="none" stroke-linejoin="round"/>`,
    "Ashen Guardian": `<path d="M32 14 L44 22 V36 C44 44 38 48 32 50 C26 48 20 44 20 36 V22 Z" fill="none" stroke="${primary}" stroke-width="2.5"/><circle cx="32" cy="30" r="4" fill="${primary}"/>`,
  };
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="${id}g"><stop offset="0%" stop-color="${secondary}"/><stop offset="100%" stop-color="#0c0d10"/></radialGradient></defs>
    <circle cx="32" cy="32" r="28" fill="url(#${id}g)" stroke="${primary}" stroke-width="1.5" opacity="0.9"/>
    ${glyphs[locationName] || glyphs["Ember Ruins"]}
  </svg>`;
}

// ---- Monster silhouettes — generic tier-based shapes (placeholder art;
// see final report). Keyed by difficulty tier, boss gets its own larger
// winged silhouette rather than a scaled-up regular monster. ----
function monsterSilhouetteSvg(difficulty, isBoss, size = 44) {
  const id = _svgId("mon");
  const primary = isBoss ? "#c94b3a" : "#8a93a3";
  if (isBoss) {
    return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs><radialGradient id="${id}g"><stop offset="0%" stop-color="${primary}55"/><stop offset="100%" stop-color="transparent"/></radialGradient></defs>
      <circle cx="32" cy="32" r="30" fill="url(#${id}g)"/>
      <path d="M32 12 L14 26 L18 44 L32 54 L46 44 L50 26 Z M22 22 L10 16 L18 30 Z M42 22 L54 16 L46 30 Z" fill="${primary}" opacity="0.9"/>
      <circle cx="26" cy="30" r="2" fill="#160a08"/><circle cx="38" cy="30" r="2" fill="#160a08"/>
    </svg>`;
  }
  const shapes = [
    `<circle cx="32" cy="36" r="16" fill="${primary}"/>`, // 1: slime blob
    `<path d="M32 14 C22 14 18 24 20 34 L16 44 L26 40 L32 44 L38 40 L48 44 L44 34 C46 24 42 14 32 14 Z" fill="${primary}"/>`, // 2: goblin
    `<path d="M32 14 C24 14 20 20 20 26 C20 30 22 32 22 32 L18 46 H46 L42 32 C42 32 44 30 44 26 C44 20 40 14 32 14 Z M26 24 h4 v4 h-4 Z M34 24 h4 v4 h-4 Z" fill="${primary}"/>`, // 3: skeleton
    `<path d="M32 12 C20 12 16 22 18 32 C14 34 14 44 20 48 H44 C50 44 50 34 46 32 C48 22 44 12 32 12 Z" fill="${primary}"/>`, // 4: orc
    `<path d="M32 16 L24 10 L26 20 C18 22 14 30 16 40 L12 46 L22 44 L32 50 L42 44 L52 46 L48 40 C50 30 46 22 38 20 L40 10 Z" fill="${primary}"/>`, // 5: demon
  ];
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">${shapes[Math.min(difficulty, shapes.length) - 1] || shapes[0]}</svg>`;
}

// ---- Equipment icon — chest armor (the only slot populated in V1). ----
function equipmentIconSvg(slot, acquired, size = 28) {
  const id = _svgId("eq");
  const primary = acquired ? "#ffb84d" : "#5a5f6b";
  if (slot === "chest") {
    return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>${acquired ? `<filter id="${id}f"><feGaussianBlur stdDeviation="1.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : ""}</defs>
      <path d="M32 12 L44 18 V30 C44 42 38 48 32 52 C26 48 20 42 20 30 V18 Z M32 18 V46" fill="${acquired ? primary + "33" : "transparent"}" stroke="${primary}" stroke-width="2.5" ${acquired ? `filter="url(#${id}f)"` : ""}/>
    </svg>`;
  }
  if (slot === "shield") {
    return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>${acquired ? `<filter id="${id}f"><feGaussianBlur stdDeviation="1.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : ""}</defs>
      <path d="M32 10 L48 16 V30 C48 42 41 50 32 54 C23 50 16 42 16 30 V16 Z" fill="${acquired ? primary + "33" : "transparent"}" stroke="${primary}" stroke-width="2.5" ${acquired ? `filter="url(#${id}f)"` : ""}/>
      <path d="M32 20 L32 44 M22 28 L42 28" stroke="${primary}" stroke-width="2" opacity="${acquired ? 0.8 : 0.4}"/>
    </svg>`;
  }
  // Generic locked-slot placeholder for equipment types with no icon defined yet.
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="32" cy="32" r="20" fill="none" stroke="${primary}" stroke-width="2.5" stroke-dasharray="4 4"/>
  </svg>`;
}

// =============================================================================
// VISOREP RPG — real uploaded artwork layer (one clean asset-resolution
// system; the SVG functions above become the FALLBACK for any asset here,
// never a competing/duplicate system — see renderX() helpers below).
// =============================================================================
// Monster theme name -> its Emberfall location (mirrors the backend's
// EMBERFALL_MONSTER_THEME table) — used to give NORMAL encounters a
// subtle location-appropriate backdrop too, not just the boss.
const MONSTER_LOCATION = {
  "Ember Slime": "Ashen Gate",
  "Ash Goblin": "Cinder Road",
  "Cinder Skeleton": "Ember Ruins",
  "Flame Orc": "Fallen Shrine",
  "Ash Demon": "Iron Bastion",
  "The Ashen Guardian": "Ashen Guardian",
};

const RPG_ASSETS = {
  world: {
    world_map: "/static/rpg/world/five_realms_world_map.jpg",
    emberfall_journey_map: "/static/rpg/world/emberfall_journey_map.jpg",
  },
  ranks: {
    Novice: "/static/rpg/ranks/novice.png",
    Fighter: "/static/rpg/ranks/fighter.png",
    Warrior: "/static/rpg/ranks/warrior.png",
    Elite: "/static/rpg/ranks/elite.png",
    Master: "/static/rpg/ranks/master.png",
    Legend: "/static/rpg/ranks/legend.png",
  },
  monsters: {
    "Ember Slime": "/static/rpg/monsters/ember_slime.png",
    "Ash Goblin": "/static/rpg/monsters/ash_goblin.png",
    "Cinder Skeleton": "/static/rpg/monsters/cinder_skeleton.jpg",
    "Flame Orc": "/static/rpg/monsters/flame_orc.jpg",
    "Ash Demon": "/static/rpg/monsters/ash_demon.jpg",
    "The Ashen Guardian": "/static/rpg/monsters/ashen_guardian.jpg",
  },
  locations: {
    "Ashen Gate": "/static/rpg/locations/ashen_gate.jpg",
    "Cinder Road": "/static/rpg/locations/cinder_road.jpg",
    "Ember Ruins": "/static/rpg/locations/ember_ruins.jpg",
    "Fallen Shrine": "/static/rpg/locations/fallen_shrine.jpg",
    "Iron Bastion": "/static/rpg/locations/iron_bastion.jpg",
    "Ashen Guardian": "/static/rpg/locations/ashen_guardian_arena.jpg",
  },
  // All 6 chest-armor tiers have their own icon art (used for the small
  // "equipment reward" contexts — realm-complete modal, armor-upgrade
  // modal, equipment chips). The CHARACTER display uses the full
  // pre-composited character-with-armor-and-shield renders instead (see
  // CHARACTER_BY_CHEST_TIER below), which is the better source now that
  // real shield-bearing art exists for every tier.
  equipment: {
    "Worn Emberplate": "/static/rpg/equipment/worn_emberplate.png",
    "Ashwood Chestplate": "/static/rpg/equipment/ashwood_chestplate.png",
    "Cinder Ironplate": "/static/rpg/equipment/cinder_ironplate.png",
    "Embergold Chestplate": "/static/rpg/equipment/embergold_chestplate.png",
    "Obsidian Flameplate": "/static/rpg/equipment/obsidian_flameplate.png",
    "Legendary Emberplate": "/static/rpg/equipment/legendary_emberplate.png",
  },
  character: "/static/rpg/characters/base_character.png",
};

// Pre-composited "character actually wearing this chest tier + shield"
// renders — real supplied art (not a guessed CSS overlay position),
// keyed by the exact armor_name string the backend already returns as
// current_armor. All 6 tiers now show a real, distinct shield:
//   Worn / Ashwood: from the original armor-render batch (shield was
//     already present in those two).
//   Cinder / Embergold / Obsidian / Legendary: from a follow-up shield
//     sheet, mapped to tiers by theme (Embergold's shield is literally
//     gold; Legendary's is the most ornate; Obsidian's is the only
//     dark/black-based palette of the set; Cinder got the simplest
//     ember-red design). This mapping was a judgment call, not something
//     labeled tier-by-tier in the source — flagged clearly so it's easy
//     to correct if any pairing should swap.
// Real (armor, shield) pairs across the full progression — as of the
// V1.12 correction, chest armor and shield now share the EXACT SAME
// 7-tier boundaries (0-999/1000-2499/2500-4499/4500-6499/6500-8499/
// 8500-9999/10000+), so they always change together, at the same
// instant. The earlier mismatch risk (Legendary armor showing before
// Legendary shield was earned) can no longer happen by construction —
// there is no gap-fallback logic needed anymore.
//   0–999      No Chest Armor      + Base Shield       -> base_character.png
//   1000–2499  Worn Emberplate     + Worn Shield        -> worn_emberplate.jpg
//   2500–4499  Ashwood Chestplate  + Ashwood Shield      -> ashwood_chestplate.jpg
//   4500–6499  Cinder Ironplate    + Cinder Shield       -> cinder_ironplate.jpg
//   6500–8499  Embergold Chestplate + Embergold Shield   -> embergold_chestplate.jpg
//   8500–9999  Obsidian Flameplate + Obsidian Shield     -> obsidian_flameplate.jpg
//   10000+     Legendary Emberplate + Legendary Shield   -> legendary_emberplate.jpg
//
// HONESTY NOTE (unchanged from before): the shield actually pictured in
// each of these 6 renders was never individually verified/labeled as
// "this is tier X's shield" — the ARMOR match is confirmed (filenames
// name the correct armor), the shield in-frame is the best available,
// not a verified tier-accurate match. For 0-999 reps there is no armor
// OR shield art at all — base_character.png is the plain unarmored
// render with no shield depicted; that's a known, documented gap, not
// something faked with CSS.
const CHARACTER_BY_CHEST_TIER = {
  "Worn Emberplate": "/static/rpg/characters/worn_emberplate.jpg",
  "Ashwood Chestplate": "/static/rpg/characters/ashwood_chestplate.jpg",
  "Cinder Ironplate": "/static/rpg/characters/cinder_ironplate.jpg",
  "Embergold Chestplate": "/static/rpg/characters/embergold_chestplate.jpg",
  "Obsidian Flameplate": "/static/rpg/characters/obsidian_flameplate.jpg",
  "Legendary Emberplate": "/static/rpg/characters/legendary_emberplate.jpg",
  // "No Chest Armor" (0-999 reps) intentionally has no entry here — falls
  // through to RPG_ASSETS.character (base_character.png) in the renderer
  // below, which is exactly correct: no armor equipped yet.
};

const SHIELD_TIER_ASSETS = {};

const SHIELD_TIER_LADDER = [
  { name: "Base Shield", min: 0 },
  { name: "Worn Shield", min: 1000 },
  { name: "Ashwood Shield", min: 2500 },
  { name: "Cinder Shield", min: 4500 },
  { name: "Embergold Shield", min: 6500 },
  { name: "Obsidian Shield", min: 8500 },
  { name: "Legendary Shield", min: 10000 },
];

// A missing/failed image must never crash the RPG page — every render
// helper below emits an <img> with onerror swapping to the existing SVG
// fallback already built (rankBadgeSvg / monsterSilhouetteSvg / etc.),
// never emoji, per spec.
function renderRankBadge(rank, size = 56) {
  const url = RPG_ASSETS.ranks[rank];
  const fallback = rankBadgeSvg(rank, size).replace(/"/g, "&quot;");
  if (!url) return rankBadgeSvg(rank, size);
  return `<img src="${url}" alt="${rank} badge" loading="lazy" style="width:${size}px;height:${size}px;object-fit:contain"
    onerror="this.outerHTML='${fallback}'">`;
}

function renderMonsterArt(themeName, difficulty, isBoss, size = 120) {
  const url = RPG_ASSETS.monsters[themeName];
  const fallback = monsterSilhouetteSvg(difficulty, isBoss, size).replace(/"/g, "&quot;");
  if (!url) return monsterSilhouetteSvg(difficulty, isBoss, size);
  return `<img src="${url}" alt="${escapeHtml(themeName)}" loading="lazy" style="width:${size}px;height:${size}px;object-fit:contain"
    onerror="this.outerHTML='${fallback}'">`;
}

function renderEquipmentArt(armorName, acquired, size = 96) {
  const url = RPG_ASSETS.equipment[armorName];
  const fallback = equipmentIconSvg("chest", acquired, size).replace(/"/g, "&quot;");
  if (!url) return equipmentIconSvg("chest", acquired, size);
  return `<img src="${url}" alt="${escapeHtml(armorName)}" loading="lazy" style="width:${size}px;height:${size}px;object-fit:contain"
    onerror="this.outerHTML='${fallback}'">`;
}

function renderPlayerCharacter(size = 140) {
  return `<img src="${RPG_ASSETS.character}" alt="Your character" loading="lazy" style="width:${size}px;height:auto;object-fit:contain"
    onerror="this.style.display='none'">`;
}

// Renders the character wearing their ACTUAL current chest tier — reads
// profile.current_armor (the same server-computed field already shown as
// text everywhere else). At 0-999 reps current_armor is "No Chest Armor"
// (not in CHARACTER_BY_CHEST_TIER), which correctly falls through to the
// plain base character render — never Worn Emberplate this early. This
// is the ONE reusable character renderer — Home, RPG Home, World Map,
// Profile, and Public Profile all call this same function; nothing
// hardcodes a character implementation per-screen.
function renderEquippedCharacter(profile, size = 140) {
  const armorName = profile && profile.current_armor;
  const url = armorName && CHARACTER_BY_CHEST_TIER[armorName];
  const finalUrl = url || RPG_ASSETS.character; // "No Chest Armor" / unknown tier -> base character, never broken
  return `<img src="${finalUrl}" alt="Your character${url ? ' wearing ' + armorName : ''}" loading="lazy"
    style="width:${size}px;height:auto;object-fit:contain;display:block;"
    onerror="this.src='${RPG_ASSETS.character}';this.onerror=null;">`;
}

// Compact text ladder for shield progression (Feature 5) — current tier
// highlighted, future tiers muted, each showing its real required reps.
// No image per tier (see SHIELD_TIER_ASSETS note) — this is honest text,
// not a fabricated visual.
function renderShieldTierLadder(currentShieldName, embersProgress) {
  const rows = SHIELD_TIER_LADDER.map((tier, i) => {
    const isCurrent = tier.name === currentShieldName;
    const isPast = !isCurrent && embersProgress >= tier.min && SHIELD_TIER_LADDER.findIndex(t => t.name === currentShieldName) > i;
    const cls = isCurrent ? "shieldTierRow shieldTierCurrent" : isPast ? "shieldTierRow shieldTierPast" : "shieldTierRow shieldTierLocked";
    return `<div class="${cls}">
      <span class="shieldTierName">${isCurrent ? "→ " : isPast ? "✓ " : ""}${escapeHtml(tier.name)}</span>
      <span class="hint">${tier.min.toLocaleString()}+ reps</span>
    </div>`;
  });
  return `<div id="shieldTierLadder">${rows.join("")}</div>`;
}

function renderLocationBackdrop(locationName) {
  const url = RPG_ASSETS.locations[locationName];
  // background-size/position set explicitly here too (belt-and-suspenders
  // with the .rpgMapNode base rule) — this is exactly the pair of
  // properties a `background:` SHORTHAND elsewhere could silently reset;
  // setting them inline makes that class of bug impossible regardless of
  // what other CSS rules are added later.
  return url ? `background-image:url('${url}');background-size:cover;background-position:center;background-repeat:no-repeat;` : "";
}

// ---------------------------------------------------------------- World Map
const REALM_ICONS = { emberfall: "🔥", thornveil: "🌿", stoneheart: "🪨", ironreach: "⚔️", stormspire: "⚡" };
const EQUIPMENT_SLOT_ICONS = { chest: "🛡", legs: "🦵", core: "🧱", power: "⚡", shoulders: "🛡" };
const EQUIPMENT_SLOT_LABELS = { chest: "Chest", legs: "Legs", core: "Core", power: "Power", shoulders: "Shoulders" };

// Approximate hotspot positions (% of the map image's width/height),
// eyeballed against the actual uploaded five_realms_world_map.jpg
// artwork's five visible regions — forest (Thornveil), grey stone peaks
// (Stoneheart), the fortress (Ironreach), the storm citadel (Stormspire),
// and the volcanic peak (Emberfall). Purely presentational coordinates;
// realm identity/status/locking all still come from the real API data.
// Marker anchor points (label/emblem position) — same as before.
const REALM_HOTSPOTS = {
  thornveil:  { left: 14, top: 42 },
  stoneheart: { left: 45, top: 22 },
  ironreach:  { left: 80, top: 50 },
  stormspire: { left: 80, top: 12 },
  emberfall:  { left: 50, top: 78 },
};
// Territory glow extents (% of map width/height) — eyeballed against the
// actual artwork's visible regions. NOT precise geographic borders (the
// source is a single raster painting with no real vector boundaries) —
// a soft, visually-believable glow footprint over each region, per the
// "don't pretend real boundaries exist" note.
const REALM_TERRITORIES = {
  thornveil:  { left: 14, top: 40, width: 34, height: 46 },
  stoneheart: { left: 45, top: 20, width: 30, height: 40 },
  ironreach:  { left: 80, top: 48, width: 34, height: 44 },
  stormspire: { left: 80, top: 12, width: 34, height: 36 },
  emberfall:  { left: 50, top: 76, width: 40, height: 42 },
};

async function loadRpgWorld() {
  try {
    const [world, profile] = await Promise.all([api("/rpg/world"), api("/rpg/profile")]);
    rpgProfileCache = profile;
    renderRpgCharacterStrip(profile);

    const layer = document.getElementById("rpgWorldMapHotspots");
    layer.innerHTML = "";
    const markers = [];
    world.realms.forEach(r => {
      const pos = REALM_HOTSPOTS[r.code];
      const territory = REALM_TERRITORIES[r.code];
      if (!pos) return;
      const stateClass = r.status === "completed" ? "realmHotspotCompleted"
        : r.status === "locked" ? "realmHotspotLocked" : "realmHotspotAvailable";
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = `realmHotspot ${stateClass}`;
      marker.style.left = `${pos.left}%`;
      marker.style.top = `${pos.top}%`;
      if (territory) {
        // Territory glow is a sibling behind the marker, sized/positioned
        // over the realm's visible region — revealed on hover via CSS,
        // kept as a persistent low glow for the current (available) realm.
        marker.style.setProperty("--territory-left", `${territory.left}%`);
        marker.style.setProperty("--territory-top", `${territory.top}%`);
        marker.style.setProperty("--territory-width", `${territory.width}%`);
        marker.style.setProperty("--territory-height", `${territory.height}%`);
      }
      marker.setAttribute("aria-label", `${r.display_name} — ${r.status === "locked" ? "coming soon" : r.status === "completed" ? "reclaimed" : "you are here"}`);
      const stateIcon = r.status === "completed" ? "✓" : r.status === "locked" ? "🔒" : "📍";
      marker.innerHTML = `
        <span class="realmHotspotTerritory" aria-hidden="true"></span>
        <span class="realmHotspotEmblem">${realmEmblemSvg(r.code, 40)}</span>
        <span class="realmHotspotState">${stateIcon}</span>
        <span class="realmHotspotLabel">${escapeHtml(r.display_name)}</span>
      `;
      marker.addEventListener("click", () => openRealm(r));
      // Hovering one realm dims the others slightly — makes the hovered
      // territory feel like it's being "selected" out of the whole map.
      marker.addEventListener("mouseenter", () => {
        markers.forEach(m => { if (m !== marker) m.classList.add("realmHotspotDimmed"); });
      });
      marker.addEventListener("mouseleave", () => {
        markers.forEach(m => m.classList.remove("realmHotspotDimmed"));
      });
      markers.push(marker);
      layer.appendChild(marker);
    });
  } catch (e) { /* best effort */ }
}

function exerciseLabel(exerciseType) {
  return ({ push_up: "Push-up", lunge: "Lunge", plank: "Plank", squat: "Squat", shoulder_press: "Shoulder Exercise" })[exerciseType] || exerciseType;
}

// Deliberately NOT a labeled "Chest / Legs / Core / Power / Shoulders" row
// — that read as a fitness-dashboard body-part selector rather than an
// RPG. The world map only ever shows a single fragment count; the
// per-slot breakdown (with body-part names) lives on the Profile screen
// instead, where it's expected context rather than primary navigation.
function renderRpgCharacterStrip(profile) {
  const acquired = profile.equipment ? Object.keys(profile.equipment).length : 0;
  document.getElementById("rpgCharacterFragments").textContent = `${acquired} / 5 Fragments Reclaimed`;
  document.getElementById("rpgCharacterLevelLine").textContent = `Level ${profile.rpg_level} · ${profile.rpg_rank}`;
  document.getElementById("rpgCharacterEmoji").innerHTML = equipmentIconSvg("chest", acquired > 0, 30);
  document.getElementById("rpgCharacterBadge").innerHTML = renderRankBadge(profile.rpg_rank, 40);
  document.getElementById("rpgCharacterPortrait").innerHTML = renderEquippedCharacter(profile, 72);
}

function openRealm(realm) {
  if (realm.status === "locked") {
    showRealmLockedModal(realm);
    return;
  }
  document.getElementById("rpgHomeRealmEmblem").innerHTML = realmEmblemSvg(realm.code, 32);
  document.getElementById("rpgHomeRealmTitle").textContent = realm.display_name.toUpperCase();
  document.getElementById("rpgHomeRealmSubtitle").textContent = realm.subtitle;
  loadRpgHome(realm.code);
  showScreen("rpgHome");
}

function showRealmLockedModal(realm) {
  document.getElementById("realmLockedEmblem").innerHTML = realmEmblemSvg(realm.code, 48);
  document.getElementById("realmLockedName").textContent = realm.display_name;
  document.getElementById("realmLockedExercise").textContent = exerciseLabel(realm.exercise_type).toUpperCase();
  document.getElementById("realmLockedModal").classList.remove("hidden");
}
document.getElementById("realmLockedCloseBtn").addEventListener("click", () => {
  document.getElementById("realmLockedModal").classList.add("hidden");
});

function showRealmCompleteModal(info, realmsCompleted, realmsTotal) {
  document.getElementById("realmCompleteRewardIcon").innerHTML = renderEquipmentArt(info.reward_name, true, 96);
  document.getElementById("realmCompleteName").textContent = `${info.realm_display_name.toUpperCase()} DEFEATED`;
  document.getElementById("realmCompleteRewardName").textContent = `${info.reward_name.toUpperCase()} ACQUIRED`;
  document.getElementById("realmCompleteCounter").textContent = `REALMS: ${realmsCompleted} / ${realmsTotal}`;
  document.getElementById("realmCompleteModal").classList.remove("hidden");
  spawnEmberParticles(document.getElementById("realmCompleteRewardIcon"), 14);
  playBeep(1318, 0.25);
}
document.getElementById("realmCompleteCloseBtn").addEventListener("click", () => {
  document.getElementById("realmCompleteModal").classList.add("hidden");
});

document.getElementById("shieldLadderToggleBtn").addEventListener("click", () => {
  document.getElementById("shieldLadderWrap").classList.toggle("hidden");
});

let rpgProfileCache = null;
let rpgCurrentRealmCode = "emberfall"; // only playable realm in V1 — kept as a variable, not hardcoded inline, so this generalizes cleanly once more realms ship
let rpgPendingArmorUpgrade = null; // set by any /hit response that crossed a milestone; shown next time loadRpgHome() runs
let rpgPendingShieldUpgrade = null;
let rpgPendingRealmCompleted = null;

// Spawns a small burst of ember-spark particles inside `container` (which
// must be position:relative/inset for them to radiate from center) —
// pure CSS-driven (see .emberParticle keyframes), removed automatically
// after their animation ends so they never pile up across repeated
// celebrations.
function spawnEmberParticles(container, count = 10) {
  if (!container) return;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("span");
    p.className = "emberParticle";
    const angle = (360 / count) * i + (Math.random() * 20 - 10);
    const dist = 40 + Math.random() * 30;
    p.style.setProperty("--particle-angle", `${angle}deg`);
    p.style.setProperty("--particle-dist", `${dist}px`);
    p.style.setProperty("--particle-delay", `${Math.random() * 0.15}s`);
    container.appendChild(p);
    p.addEventListener("animationend", () => p.remove());
  }
}

// Tier "intensity" — used purely to scale the celebration (particle count
// / glow strength), each tier progressively more impressive, per spec.
const EQUIPMENT_TIER_INTENSITY = {
  "Worn Emberplate": 1, "Ashwood Chestplate": 2, "Cinder Ironplate": 3,
  "Embergold Chestplate": 4, "Obsidian Flameplate": 5, "Legendary Emberplate": 6,
};

// The combined "NEW EQUIPMENT" reveal — armor chest AND shield now change
// together (synchronized boundaries), so this shows both at once with the
// character actually wearing the new tier, rather than two separate
// modals for the same moment.
function showNewEquipmentModal(armorInfo, shieldInfo, profileAfter) {
  const box = document.getElementById("armorUpgradeModalBox");
  const isLegendary = shieldInfo && shieldInfo.shield_name === "Legendary Shield";
  box.classList.toggle("legendaryMoment", isLegendary);
  document.getElementById("armorUpgradeKicker").textContent = isLegendary ? "LEGENDARY SHIELD UNLOCKED" : "NEW EQUIPMENT";

  const charWrap = document.getElementById("armorUpgradeCharacterWrap");
  charWrap.innerHTML = renderEquippedCharacter(profileAfter, 130);
  const charImg = charWrap.querySelector("img");
  if (charImg) charImg.classList.add("equipmentRevealChar");

  document.getElementById("armorUpgradeArt").innerHTML = "";
  document.getElementById("armorUpgradeName").textContent = armorInfo ? armorInfo.armor_name.toUpperCase() : "";
  document.getElementById("armorUpgradeShieldName").textContent = shieldInfo ? shieldInfo.shield_name.toUpperCase() : "";
  document.getElementById("armorUpgradeReps").textContent = isLegendary
    ? "10,000 EMBERFALL REPS"
    : `${(armorInfo || shieldInfo).reps_reclaimed.toLocaleString()} reps reclaimed`;
  document.getElementById("armorUpgradeModal").classList.remove("hidden");

  const intensity = EQUIPMENT_TIER_INTENSITY[armorInfo && armorInfo.armor_name] || 3;
  spawnEmberParticles(charWrap, isLegendary ? 18 : 4 + intensity * 2);
  playBeep(isLegendary ? 1318 : 700 + intensity * 60, isLegendary ? 0.25 : 0.12 + intensity * 0.015);
}
document.getElementById("armorUpgradeCloseBtn").addEventListener("click", () => {
  document.getElementById("armorUpgradeModal").classList.add("hidden");
  document.getElementById("armorUpgradeModalBox").classList.remove("legendaryMoment");
  if (rpgPendingRealmCompleted) {
    const info = rpgPendingRealmCompleted;
    rpgPendingRealmCompleted = null;
    rpgProfileCache && showRealmCompleteModal(info, rpgProfileCache.realms_completed, rpgProfileCache.realms_total);
  }
});

async function loadRpgHome(realmCode) {
  if (realmCode) rpgCurrentRealmCode = realmCode;
  try {
    const [profile, realm, current] = await Promise.all([
      api("/rpg/profile"), api(`/rpg/realm/${rpgCurrentRealmCode}`), api("/rpg/encounters/current"),
    ]);
    rpgProfileCache = profile;
    renderRpgHeader(profile);

    // Show any armor/shield upgrade / realm completion earned during the
    // just-finished battle — now that we're safely back on RPG home, not
    // mid-camera-exercise. Armor+shield now change TOGETHER (synchronized
    // boundaries), so they're shown as ONE combined reveal, then realm
    // completion (if any) follows.
    if (rpgPendingArmorUpgrade || rpgPendingShieldUpgrade) {
      const armorInfo = rpgPendingArmorUpgrade;
      const shieldInfo = rpgPendingShieldUpgrade;
      rpgPendingArmorUpgrade = null;
      rpgPendingShieldUpgrade = null;
      showNewEquipmentModal(armorInfo, shieldInfo, profile);
    } else if (rpgPendingRealmCompleted) {
      const info = rpgPendingRealmCompleted;
      rpgPendingRealmCompleted = null;
      showRealmCompleteModal(info, profile.realms_completed, profile.realms_total);
    }

    document.getElementById("rpgHomeRealmFlavor").textContent = realm.theme;
    document.getElementById("rpgRealmProgressPct").textContent = `${realm.progress_pct}% Reclaimed`;
    document.getElementById("rpgRealmProgressFill").style.width = `${realm.progress_pct}%`;
    document.getElementById("rpgRealmProgressReps").textContent =
      `${realm.progress_value.toLocaleString()} / ${realm.progress_total.toLocaleString()} reps reclaimed`;
    document.getElementById("rpgCurrentArmorArt").innerHTML = renderEquipmentArt(realm.current_armor, true, 64);
    document.getElementById("rpgCurrentArmorName").textContent = realm.current_armor;
    document.getElementById("rpgCurrentShieldName").textContent = profile.current_shield;
    document.getElementById("shieldLadderWrap").innerHTML = renderShieldTierLadder(profile.current_shield, realm.progress_value);

    const continueBox = document.getElementById("rpgContinueBattleBox");
    if (current.active) {
      continueBox.classList.remove("hidden");
      continueBox.innerHTML = `
        <div class="monsterCardIcon">${renderMonsterArt(current.monster_theme_name || current.monster_name, current.monster_difficulty, current.monster_is_boss, 34)}</div>
        <div>
          <div class="monsterCardName">${escapeHtml(current.monster_theme_name || current.monster_name)}</div>
          <div class="hint">${current.monster_hp} / ${current.monster_max_hp} HP remaining</div>
        </div>
        <button id="rpgContinueBattleBtn">CONTINUE BATTLE</button>
        <button id="rpgChangeMonsterBtn" class="secondary">CHANGE MONSTER</button>
      `;
      document.getElementById("rpgContinueBattleBtn").addEventListener("click", () => {
        enterRpgBattle(current.encounter_id, current.monster_theme_name || current.monster_name,
          current.monster_difficulty, current.monster_is_boss, current.monster_hp, current.monster_max_hp);
      });
      document.getElementById("rpgChangeMonsterBtn").addEventListener("click", async () => {
        const ok = confirm("Abandon current battle and choose another monster? You will not receive XP or Gold for it.");
        if (!ok) return;
        try {
          await api(`/rpg/encounters/${current.encounter_id}/abandon`, { method: "POST" });
          loadRpgHome();
        } catch (e) {
          alert(e.message);
        }
      });
    } else {
      continueBox.classList.add("hidden");
    }

    renderRpgLocalMap(realm.locations, realm.monsters, realm.progress_value);
  } catch (e) { /* best effort */ }
}

// The local journey map — connected location nodes standing in for the
// old flat "pick any monster" grid. Battling is unchanged (same
// startRpgBattle(monsterId) call, same existing encounter/combat system);
// this only changes how the choice is PRESENTED, matching each location
// 1:1 with the existing monster roster in the same fixed order.
const LOCATION_STATUS_ICON = { completed: "✓", current: "→", upcoming: "🔒" };

function renderRpgLocalMap(locations, monsters, progressValue) {
  const monsterById = {};
  monsters.forEach(m => { monsterById[m.id] = m; });

  const track = document.getElementById("rpgLocalMap");
  track.innerHTML = "";
  locations.forEach((loc, i) => {
    const m = monsterById[loc.monster_id];
    const node = document.createElement("div");
    node.className = `rpgMapNode rpgMapNode-${loc.status}` + (loc.is_boss ? " rpgMapNodeBoss" : "");
    const backdropStyle = renderLocationBackdrop(loc.location_name);
    if (backdropStyle) node.style.cssText += backdropStyle;

    // Exact progress toward THIS location's unlock, using the existing
    // reps_min/reps_max the realm API already returns — no new/invented
    // progression math, just reading the real milestone boundaries.
    let progressHtml = "";
    if (loc.status === "upcoming") {
      const repsRemaining = Math.max(0, loc.reps_min - progressValue);
      const pct = Math.min(100, Math.round(100 * progressValue / loc.reps_min));
      progressHtml = `
        <div class="rpgMapNodeReq">Requires ${loc.reps_min.toLocaleString()} reps</div>
        <div class="rpgMapNodeProgressTrack"><div class="rpgMapNodeProgressFill" style="width:${pct}%"></div></div>
        <div class="hint">${repsRemaining.toLocaleString()} reps remaining</div>
      `;
    } else if (loc.status === "current" && i < locations.length - 1) {
      const next = locations[i + 1];
      const span = next.reps_min - loc.reps_min;
      const pct = span > 0 ? Math.min(100, Math.round(100 * (progressValue - loc.reps_min) / span)) : 100;
      const repsUntilNext = Math.max(0, next.reps_min - progressValue);
      progressHtml = `
        <div class="rpgMapNodeReq">Progress toward ${escapeHtml(next.location_name)}</div>
        <div class="rpgMapNodeProgressTrack"><div class="rpgMapNodeProgressFill" style="width:${pct}%"></div></div>
        <div class="hint">${repsUntilNext.toLocaleString()} reps until ${escapeHtml(next.location_name)}</div>
      `;
    }

    // Locked-location UX: an upcoming location does NOT get a misleading
    // BATTLE button — presentational only, the underlying /encounters/start
    // endpoint still allows any order, this just guides the player clearly.
    const actionHtml = loc.status === "upcoming"
      ? `<div class="rpgMapNodeLockedNote">Complete the previous encounter to unlock.</div>`
      : `<button class="monsterBattleBtn" data-id="${loc.monster_id}">${loc.status === "completed" ? "BATTLE AGAIN" : "BATTLE"}</button>`;
    node.innerHTML = `
      <div class="rpgMapNodeOverlay">
        <div class="rpgMapNodeStatus">${LOCATION_STATUS_ICON[loc.status]}</div>
        <div class="rpgMapNodeIcon">${locationMarkerSvg(loc.location_name, loc.is_boss, loc.is_boss ? 52 : 40)}</div>
        <div class="rpgMapNodeName">${escapeHtml(loc.location_name)}</div>
        ${loc.is_boss ? '<div class="monsterBossTag">REALM BOSS</div>' : ""}
        ${m ? `<div class="hint">${m.max_hp} HP · +${m.xp_reward} XP · +${m.gold_reward} Gold</div>` : ""}
        ${progressHtml}
        ${actionHtml}
      </div>
    `;
    if (loc.status !== "upcoming") {
      node.querySelector(".monsterBattleBtn").addEventListener("click", () => startRpgBattle(loc.monster_id));
    }
    track.appendChild(node);
    if (i < locations.length - 1) {
      const connector = document.createElement("div");
      connector.className = "rpgMapConnector";
      track.appendChild(connector);
    }
  });
}

function renderRpgHeader(profile) {
  document.getElementById("rpgHomeCharacterPortrait").innerHTML = renderEquippedCharacter(profile, 56);
  document.getElementById("rpgHeaderBadge").innerHTML = renderRankBadge(profile.rpg_rank, 44);
  document.getElementById("rpgLevelValue").textContent = profile.rpg_level;
  document.getElementById("rpgRankValue").textContent = profile.rpg_rank;
  document.getElementById("rpgGoldValue").textContent = profile.gold;
  document.getElementById("rpgDefeatedValue").textContent = profile.monsters_defeated;
  const span = profile.rpg_xp_for_next_level - profile.rpg_xp_for_current_level;
  const progress = span > 0 ? Math.min(100, 100 * (profile.rpg_xp - profile.rpg_xp_for_current_level) / span) : 100;
  document.getElementById("rpgXpBarFill").style.width = progress + "%";
  document.getElementById("rpgXpLabel").textContent =
    `${profile.rpg_xp - profile.rpg_xp_for_current_level} / ${span} XP`;
}

// ---------------------------------------------------------------- resume on RPG tab open / bootstrap
async function resumeRpgBattleIfAny() {
  try {
    const current = await api("/rpg/encounters/current");
    if (!current.active) return false;
    enterRpgBattle(current.encounter_id, current.monster_theme_name || current.monster_name,
      current.monster_difficulty, current.monster_is_boss, current.monster_hp, current.monster_max_hp);
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- start / enter battle
let rpgEncounterId = null;
let rpgLevelBeforeBattle = 1;
let rpgRepCount = 0;
let rpgMonsterHp = 0;
let rpgMonsterMaxHp = 0;

async function startRpgBattle(monsterId) {
  // V1.14: RPG now shows its OWN dedicated onboarding (game loop +
  // camera basics) on first RPG entry — separate flag from the PvP
  // explainer, so a player who already dismissed the PvP one still sees
  // this once, and vice versa.
  if (!hasSeenRpgIntro()) {
    pendingRpgBattleStart = monsterId;
    showRpgIntroModal();
    return;
  }
  await _startRpgBattleAfterIntro(monsterId);
}

let pendingRpgBattleStart = null;

async function _startRpgBattleAfterIntro(monsterId) {
  try {
    const res = await api("/rpg/encounters/start", { method: "POST", body: JSON.stringify({ monster_id: monsterId }) });
    const monsters = await api("/rpg/monsters");
    const monster = monsters.find(m => m.id === monsterId);
    rpgLevelBeforeBattle = rpgProfileCache ? rpgProfileCache.rpg_level : 1;
    enterRpgBattle(res.encounter_id, monster.theme_name || monster.name, monster.difficulty, monster.is_boss, res.monster_hp, res.monster_hp);
  } catch (e) {
    if (e.message && e.message.includes("already have an active encounter")) {
      // Resume instead of failing — the user likely double-clicked or
      // already has a battle in progress from an earlier session.
      const resumed = await resumeRpgBattleIfAny();
      if (!resumed) alert(e.message);
    } else {
      alert(e.message);
    }
  }
}

// RPG is TIMELESS (V1.5 correction pass) — no countdown, no timer, no
// "time up" state. A battle simply runs until the monster is defeated or
// the player leaves (Leave Battle just navigates away; the encounter
// itself stays active server-side and is fully resumable later).
function enterRpgBattle(encounterId, monsterName, difficulty, isBoss, monsterHp, monsterMaxHp) {
  rpgEncounterId = encounterId;
  rpgRepCount = 0;
  rpgMonsterHp = monsterHp;
  rpgMonsterMaxHp = monsterMaxHp;
  rpgIsBossBattle = isBoss;
  document.getElementById("battleMonsterName").textContent = monsterName;
  document.getElementById("battleMonsterIcon").innerHTML = renderMonsterArt(monsterName, difficulty, isBoss, isBoss ? 90 : 130);
  document.getElementById("rpgRepCount").textContent = "0";
  updateMonsterHpBar();

  // Boss presentation — Ashen Guardian gets the dedicated arena backdrop,
  // a larger/dramatic HP bar treatment, and a brief entrance flash, so
  // it's unmistakably a different kind of encounter. NORMAL fights
  // (Slime, Goblin, etc.) now ALSO get a location-appropriate backdrop
  // (Ashen Gate for Slime, Cinder Road for Goblin, ...) — same mechanism,
  // much subtler opacity and no dark-flash intro/boss label, so a normal
  // fight still clearly reads as "normal," just no longer a flat empty
  // panel behind the monster.
  const screen = document.getElementById("rpgBattleScreen");
  const arena = document.getElementById("rpgBattleArenaOverlay");
  const bossLabel = document.getElementById("battleBossLabel");
  screen.classList.toggle("bossEncounter", isBoss);
  bossLabel.classList.toggle("hidden", !isBoss);
  const locationName = MONSTER_LOCATION[monsterName];
  const backdropUrl = locationName && RPG_ASSETS.locations[locationName];
  if (isBoss) {
    arena.style.backgroundImage = "url('/static/rpg/locations/ashen_guardian_arena.jpg')";
    arena.classList.add("hasBackdrop");
    const flash = document.getElementById("rpgBattleIntroFlash");
    flash.classList.remove("hidden");
    flash.classList.remove("rpgBossIntroPlay");
    void flash.offsetWidth;
    flash.classList.add("rpgBossIntroPlay");
    playBeep(220, 0.3);
    setTimeout(() => flash.classList.add("hidden"), 1300);
  } else if (backdropUrl) {
    arena.style.backgroundImage = `url('${backdropUrl}')`;
    arena.classList.add("hasBackdrop");
  } else {
    arena.style.backgroundImage = "";
    arena.classList.remove("hasBackdrop");
  }

  showScreen("rpgBattle");
  // V1.17: no separate RPG camera-setup/check screen anymore — go straight
  // into the battle screen, initialize the camera, then run the 3-2-1-GO!
  // countdown before rep registration turns on (see runRpgCountdown).
  // PvP's own camera-check flow (startReadyCameraCheck) is untouched.
  (async () => {
    await startRpgCamera();
    rpgDetectionRunning = true;
    requestAnimationFrame(rpgDetectionLoop);
    await runRpgCountdown();
  })();
}
let rpgIsBossBattle = false;

function updateMonsterHpBar() {
  const pct = rpgMonsterMaxHp > 0 ? Math.max(0, 100 * rpgMonsterHp / rpgMonsterMaxHp) : 0;
  document.getElementById("monsterHpBarFill").style.width = pct + "%";
  document.getElementById("monsterHpText").textContent = `${rpgMonsterHp} / ${rpgMonsterMaxHp}`;
}

// "Leave Battle" (V1.5 correction, Option A — the preferred design): does
// NOT end or abandon the encounter. It stays active server-side; the
// player can return to it later via "Continue Battle" on the RPG home
// screen. This only stops the local camera/detection loop and navigates away.
document.getElementById("rpgFleeBtn").addEventListener("click", () => {
  stopRpgCamera();
  showScreen("rpgHome");
  loadRpgHome();
});

// ---------------------------------------------------------------- sound (reuses playBeep from PvP)
document.getElementById("rpgSoundToggleBtn").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  document.getElementById("rpgSoundToggleBtn").textContent = soundEnabled ? "🔊 Sound" : "🔇 Muted";
});

// ---------------------------------------------------------------- camera + detection (parallel to PvP's,
// same model/thresholds, own DOM elements + own state)
let rpgPoseReady = false;
let rpgCameraStream = null;
let rpgDetectionRunning = false;
let rpgRepState = "up";
let rpgDownShoulderY = null;
let rpgDownBodyScale = null;
let rpgDownShoulderYExtreme = 0; // SAME peak-tracking fix as PvP — see detectionLoop
let lastRpgRepRejectedReason = null; // dev-debug only, mirrors lastPvpRepRejectedReason
let rpgPendingDownFrames = 0;
let rpgPendingUpFrames = 0;
let rpgRepWasValidThroughout = true;
let rpgInvalidStreak = 0;
let rpgLastRepTimestamp = 0;
let rpgLastFeedbackText = "";
let rpgLastFeedbackChangeTime = 0;
let rpgFlatZStreak = 0;
let rpgLivenessWarningShown = false;

// Gates whether a detected (or, formerly, manually-tapped) rep is actually
// allowed to register. False for the whole battle-start countdown so a
// pose transition during "3, 2, 1" can never become the first counted rep;
// flipped true only once the countdown reaches "GO!" (see runRpgCountdown).
let rpgRepRegistrationEnabled = false;
// Bumped whenever the current battle/camera session ends (flee, defeat,
// or a new battle starting) so a countdown left over from a battle the
// player already exited can't reach into a later session and flip
// rpgRepRegistrationEnabled back on after the fact.
let rpgCountdownToken = 0;

// Pulled out of startRpgCamera so the countdown can also call it right
// before "GO!" — discards any state a pose transition during the
// countdown may have left behind, so the battle always starts clean.
function resetRpgRepDetectionState() {
  rpgRepState = "up";
  rpgDownShoulderY = null;
  rpgDownShoulderYExtreme = 0;
  rpgDownBodyScale = null;
  rpgPendingDownFrames = 0;
  rpgPendingUpFrames = 0;
  rpgRepWasValidThroughout = true;
  rpgInvalidStreak = 0;
  rpgLastRepTimestamp = 0;
  rpgFlatZStreak = 0;
  rpgLivenessWarningShown = false;
  resetPoseTracker(rpgPoseTracker);
}

async function startRpgCamera() {
  const video = document.getElementById("rpgCameraVideo");
  const statusEl = document.getElementById("rpgCameraStatus");
  resetRpgRepDetectionState();

  try {
    statusEl.textContent = "📷 Starting camera…";
    statusEl.classList.remove("hidden");
    rpgCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 640, height: 480 }, audio: false,
    });
    video.srcObject = rpgCameraStream;
    await video.play();
    setCameraActiveIndicator("rpgCameraActiveIndicator", true);

    statusEl.textContent = "🧠 Loading AI model…";
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("pose model load timed out")), CONFIG.POSE_MODEL_TIMEOUT_MS)
    );
    await Promise.race([loadPoseModel(), timeoutPromise]); // SAME singleton model as PvP
    rpgPoseReady = true;
    statusEl.classList.add("hidden");
  } catch (err) {
    console.error("RPG camera/pose init failed:", err);
    // No manual fallback — camera/AI detection is the only way to
    // register a rep, same rule as PvP.
    statusEl.textContent = "⚠️ Camera unavailable — reps can't be counted until it's working.";
  }
}

// Runs the 3-2-1-GO! overlay. Called every time a battle screen is
// entered (new battle, continue, or resume-after-refresh all funnel
// through enterRpgBattle), after the camera/pose model has initialized.
// The AI may already be tracking pose during this — that's fine, it just
// can't register a rep yet (rpgRepRegistrationEnabled stays false).
async function runRpgCountdown() {
  const overlay = document.getElementById("rpgCountdownOverlay");
  rpgRepRegistrationEnabled = false;
  const myToken = ++rpgCountdownToken;
  if (!overlay) { rpgRepRegistrationEnabled = true; return; }

  overlay.classList.remove("hidden");
  const steps = ["3", "2", "1", "GO!"];
  for (const step of steps) {
    if (myToken !== rpgCountdownToken) return; // superseded — battle was left/replaced mid-countdown
    overlay.textContent = step;
    playBeep(step === "GO!" ? 880 : 440, 0.12);
    await new Promise(resolve => setTimeout(resolve, CONFIG.RPG_COUNTDOWN_STEP_MS));
  }
  if (myToken !== rpgCountdownToken) return;
  overlay.classList.add("hidden");

  // Clean slate right before enabling counting — see function comment above.
  resetRpgRepDetectionState();
  rpgRepRegistrationEnabled = true;
}

function stopRpgCamera() {
  rpgDetectionRunning = false;
  rpgRepRegistrationEnabled = false;
  rpgCountdownToken++; // invalidate any in-flight countdown for this session
  setCameraActiveIndicator("rpgCameraActiveIndicator", false);
  hidePoseDebugOverlay("rpgPoseDebug");
  if (rpgCameraStream) {
    rpgCameraStream.getTracks().forEach(t => t.stop());
    rpgCameraStream = null;
  }
}

function setRpgFeedback(text) {
  const now = performance.now();
  if (text === rpgLastFeedbackText) return;
  if (now - rpgLastFeedbackChangeTime < CONFIG.FEEDBACK_MIN_DISPLAY_MS) return;
  rpgLastFeedbackText = text;
  rpgLastFeedbackChangeTime = now;
  document.getElementById("rpgDetectionHint").textContent = text;
}

function rpgDetectionLoop() {
  if (!rpgDetectionRunning) return;
  const video = document.getElementById("rpgCameraVideo");
  const canvas = document.getElementById("rpgCameraCanvas");

  if (video.readyState >= 2 && rpgPoseReady && poseLandmarker) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    const result = poseLandmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (result.landmarks && result.landmarks.length > 0) {
      const lm = result.landmarks[0];
      const tracked = trackPoseLandmarks(rpgPoseTracker, lm, rpgRepState); // SAME shared tracker as PvP
      const { shoulder: s, elbow: e, wrist: w, hip, knee, ankle } = tracked.points;

      if (s && e && w) {
        const toPx = p => ({ x: p.x * canvas.width, y: p.y * canvas.height });
        const angle = angleBetween(toPx(s), toPx(e), toPx(w)); // SAME shared math as PvP
        const shoulderPx = toPx(s);
        const hipPx = hip ? toPx(hip) : null;

        drawTrackedArm(ctx, toPx, s, e, w, rpgPoseTracker.heldThisFrame); // SAME shared drawing as PvP

        // SAME thresholds/structure as PvP's detectionLoop — RPG must not
        // require anything beyond what PvP requires.
        const coreVisible = [s, e, w, hip].every(p => (p?.visibility || 0) > CONFIG.MIN_LANDMARK_VISIBILITY);
        const bodyVisible = [knee, ankle].every(p => (p?.visibility || 0) > CONFIG.MIN_BODY_VISIBILITY);
        let goodAlignment = true;
        let hipDirection = null;
        if (hip && ankle && bodyVisible) {
          const { ratio, direction } = computeHipAlignment(shoulderPx, toPx(hip), toPx(ankle)); // SAME shared function as PvP
          goodAlignment = ratio < CONFIG.MAX_HIP_DEVIATION_RATIO;
          hipDirection = direction;
        }

        // SAME non-blocking liveness signal as PvP — never affects canCount.
        // Uses RAW (pre-smoothing) landmarks — see PvP's detectionLoop for why.
        if (coreVisible) {
          const rawIdx = POSE_SIDE_LANDMARKS[tracked.side];
          const rawPts = { shoulder: lm[rawIdx.shoulder], elbow: lm[rawIdx.elbow], wrist: lm[rawIdx.wrist],
                            hip: lm[rawIdx.hip], knee: lm[rawIdx.knee], ankle: lm[rawIdx.ankle] };
          const zResult = checkLivenessSignal(rawPts, rpgFlatZStreak);
          rpgFlatZStreak = zResult.streak;
          if (zResult.shouldWarn && !rpgLivenessWarningShown) {
            rpgLivenessWarningShown = true;
            showNotice("⚠️ This camera feed looks unusually flat for a real person — make sure you're live in front of the camera, not a recording.", 6000);
          }
        }

        if (!coreVisible) setRpgFeedback("⚠️ Show your full body to the camera.");
        else if (!bodyVisible) setRpgFeedback("Stand sideways, full body in frame.");
        else if (tracked.tracking === "unstable") setRpgFeedback("⚠️ Keep your side position — AI is re-locking your arm.");
        else if (!goodAlignment) setRpgFeedback(hipDirection === "sag" ? "Move your hips slightly up." : "Lower your hips slightly.");
        else if (rpgRepState === "down") setRpgFeedback("Go deeper, extend your arms!");
        else setRpgFeedback("Good — keep going!");

        // Section 14: never count off an unstable/held tracking frame.
        const canCount = coreVisible && bodyVisible && goodAlignment && tracked.tracking === "stable";

        // SAME peak-tracking fix as PvP — see detectionLoop for why.
        if (rpgRepState === "down" && rpgDownShoulderY !== null) {
          rpgDownShoulderYExtreme = Math.max(rpgDownShoulderYExtreme, Math.abs(shoulderPx.y - rpgDownShoulderY));
        }

        renderPoseDebugOverlay("rpgPoseDebug", tracked, angle, rpgRepState, {
          shoulderMovement: rpgDownShoulderYExtreme,
          movementThreshold: rpgDownBodyScale ? CONFIG.MIN_SHOULDER_MOVEMENT_RATIO_OF_TORSO * rpgDownBodyScale : CONFIG.MIN_SHOULDER_MOVEMENT_RATIO * canvas.height,
          canvasHeight: canvas.height,
          canCount, coreVisible, bodyVisible, goodAlignment, hipDirection,
          lastRepRejectedReason: lastRpgRepRejectedReason,
        });

        // SAME continuous-validity + debounce + body-scale-normalized
        // logic as PvP's detectionLoop — see the detailed comments there.
        if (rpgRepState === "down") {
          if (canCount) {
            rpgInvalidStreak = 0;
          } else {
            rpgInvalidStreak += 1;
            if (rpgInvalidStreak > CONFIG.REP_VALIDITY_GRACE_FRAMES) rpgRepWasValidThroughout = false;
          }
        }

        if (rpgRepState === "up" && angle < CONFIG.DOWN_ANGLE) {
          rpgPendingDownFrames += 1;
          rpgPendingUpFrames = 0;
          if (rpgPendingDownFrames >= CONFIG.DOWN_STATE_CONFIRM_FRAMES) {
            rpgRepState = "down";
            rpgPendingDownFrames = 0;
            rpgDownShoulderY = shoulderPx.y;
            rpgDownShoulderYExtreme = 0;
            rpgDownBodyScale = hipPx ? Math.hypot(shoulderPx.x - hipPx.x, shoulderPx.y - hipPx.y) : null;
            rpgRepWasValidThroughout = canCount;
            rpgInvalidStreak = 0;
          }
        } else if (rpgRepState === "down" && angle > CONFIG.UP_ANGLE) {
          rpgPendingUpFrames += 1;
          rpgPendingDownFrames = 0;
          if (rpgPendingUpFrames >= CONFIG.RPG_UP_STATE_CONFIRM_FRAMES) {
            rpgRepState = "up";
            rpgPendingUpFrames = 0;
            const now = performance.now();
            const threshold = rpgDownBodyScale
              ? CONFIG.MIN_SHOULDER_MOVEMENT_RATIO_OF_TORSO * rpgDownBodyScale
              : CONFIG.MIN_SHOULDER_MOVEMENT_RATIO * canvas.height;
            rpgDownShoulderYExtreme = Math.max(rpgDownShoulderYExtreme, Math.abs(shoulderPx.y - rpgDownShoulderY));
            const shoulderMoved = rpgDownShoulderY !== null && rpgDownShoulderYExtreme > threshold;
            const enoughTimePassed = now - rpgLastRepTimestamp > CONFIG.RPG_MIN_REP_INTERVAL_MS;

            if (rpgRepRegistrationEnabled && rpgRepWasValidThroughout && canCount && shoulderMoved && enoughTimePassed) {
              rpgLastRepTimestamp = now;
              registerRpgRep();
              lastRpgRepRejectedReason = null;
            } else if (isPoseDebugEnabled()) {
              if (!rpgRepRegistrationEnabled) lastRpgRepRejectedReason = "countdown not finished yet";
              else if (!rpgRepWasValidThroughout) lastRpgRepRejectedReason = "lost tracking/visibility during the down phase";
              else if (!shoulderMoved) lastRpgRepRejectedReason = `shoulder movement too small (${(rpgDownShoulderYExtreme / canvas.height).toFixed(3)} < ${(threshold / canvas.height).toFixed(3)})`;
              else if (!enoughTimePassed) lastRpgRepRejectedReason = "too soon after the previous rep";
              else lastRpgRepRejectedReason = "angle never reached UP threshold cleanly";
            }
            rpgDownShoulderY = null;
            rpgDownShoulderYExtreme = 0;
            rpgDownBodyScale = null;
          }
        } else {
          if (rpgRepState === "up") rpgPendingDownFrames = 0;
          if (rpgRepState === "down") rpgPendingUpFrames = 0;
        }
      }
    } else {
      setRpgFeedback("⚠️ Body not found — stand in front of the camera.");
      if (rpgRepState === "down") {
        rpgInvalidStreak += 1;
        if (rpgInvalidStreak > CONFIG.REP_VALIDITY_GRACE_FRAMES) rpgRepWasValidThroughout = false;
      }
    }
  }

  requestAnimationFrame(rpgDetectionLoop);
}

// ---------------------------------------------------------------- rep -> damage submission
// IMPORTANT: each valid rep queues exactly ONE unit, flushed to the server
// as a DELTA (not a running total) — this is the exact contract
// /api/rpg/encounters/<id>/hit expects (reps = new reps THIS call, not
// cumulative). A queue+in-flight-guard avoids ever double-submitting the
// same rep if detections arrive faster than the network round trip.
let rpgPendingReps = 0;
let rpgHitRequestInFlight = false;

function registerRpgRep() {
  rpgRepCount += 1;
  const repEl = document.getElementById("rpgRepCount");
  repEl.textContent = rpgRepCount;
  repEl.classList.remove("rpgRepPulse");
  void repEl.offsetWidth; // restart animation even on rapid consecutive reps
  repEl.classList.add("rpgRepPulse");
  if (navigator.vibrate) navigator.vibrate(15);
  playBeep(660, 0.08);
  rpgPendingReps += 1;
  flushPendingRpgReps();
}

async function flushPendingRpgReps() {
  if (rpgHitRequestInFlight || rpgPendingReps === 0 || !rpgEncounterId) return;
  const toSend = rpgPendingReps;
  rpgPendingReps = 0;
  rpgHitRequestInFlight = true;
  try {
    const res = await api(`/rpg/encounters/${rpgEncounterId}/hit`, {
      method: "POST", body: JSON.stringify({ reps: toSend }),
    });
    rpgMonsterHp = res.monster_hp;
    updateMonsterHpBar();
    showRpgHitFeedback(res.damage_dealt, res.monster_hp);

    // V1.9: armor-upgrade / shield-upgrade / realm-completion can fire on
    // ANY hit (not just the one that defeats a monster) — queue it and
    // show it once the player is back on RPG home, never mid-camera-exercise.
    if (res.emberfall_progress) {
      if (res.emberfall_progress.armor_upgraded) rpgPendingArmorUpgrade = res.emberfall_progress.armor_upgraded;
      if (res.emberfall_progress.shield_upgraded) rpgPendingShieldUpgrade = res.emberfall_progress.shield_upgraded;
      if (res.emberfall_progress.realm_completed) rpgPendingRealmCompleted = res.emberfall_progress.realm_completed;
    }

    // Authoritative stop trigger: HP <= 0 always means the fight is over,
    // regardless of whether THIS specific request happened to carry the
    // reward payload (see finishRpgBattle for why relying on `defeated`
    // alone left a gap — the request that reduces HP to 0 always sets
    // `defeated`, but a rare concurrent-claim race, or recovering from a
    // response we never received, could otherwise leave the client
    // showing "battle in progress" with 0 HP forever).
    if (res.monster_hp <= 0) {
      await finishRpgBattle(res.defeated);
      return;
    }
  } catch (e) {
    // The hit may have failed because the encounter is no longer active —
    // e.g. an earlier hit actually landed and finished the monster
    // server-side, but its response was lost (network hiccup) before we
    // could see it. Check the real server state rather than assuming the
    // battle is still ongoing, so the player is never stuck on a frozen
    // screen. If the check itself fails, leave everything as-is; the next
    // detected rep will retry.
    if (rpgDetectionRunning) {
      try {
        const current = await api("/rpg/encounters/current");
        if (!current.active) {
          await finishRpgBattle(null);
          return;
        }
      } catch (e2) { /* couldn't verify — leave battle running, will retry */ }
    }
  } finally {
    rpgHitRequestInFlight = false;
    if (rpgDetectionRunning && rpgPendingReps > 0) flushPendingRpgReps();
  }
}

// Single, idempotent "battle is over" transition — the only place that
// stops detection/camera/timer and shows a result, called from whichever
// code path first detects the fight is finished. `reward` is the reward
// payload from OUR OWN hit response if it won the claim; it's null when
// we're recovering from a lost response and someone else's request (or an
// earlier one of ours) already claimed the reward — in that case we do
// NOT fabricate a reward (no second reward system, no duplicate XP/Gold),
// we just stop cleanly and return to RPG home.
let rpgBattleFinishing = false;
async function finishRpgBattle(reward) {
  if (rpgBattleFinishing) return; // guards against double-entry (test 9)
  rpgBattleFinishing = true;
  rpgDetectionRunning = false;
  stopRpgCamera();
  rpgMonsterHp = 0;
  updateMonsterHpBar();

  if (reward) {
    await playRpgDefeatSequence();
    showRpgResult({ victory: true, reward });
  } else {
    try { rpgProfileCache = await api("/rpg/profile"); } catch (e) { /* best effort */ }
    showScreen("rpgHome");
    loadRpgHome();
  }
  rpgBattleFinishing = false;
}

// Fast (~150-250ms), CSS-only feedback for an accepted hit. Never awaited
// by the rep-processing path above, so it can never delay/block the next
// rep being detected or sent.
function showRpgHitFeedback(damage, newHp) {
  const icon = document.getElementById("battleMonsterIcon");
  const shakeClass = rpgIsBossBattle ? "rpgBossHitShake" : "rpgMonsterShake";
  icon.classList.remove("rpgMonsterShake", "rpgBossHitShake");
  void icon.offsetWidth; // restart the animation even on rapid consecutive hits
  icon.classList.add(shakeClass);

  const dmgEl = document.getElementById("rpgDamagePopup");
  dmgEl.textContent = `-${damage}`;
  dmgEl.classList.remove("rpgDamagePopupPlay");
  void dmgEl.offsetWidth;
  dmgEl.classList.add("rpgDamagePopupPlay");

  const hpFill = document.getElementById("monsterHpBarFill");
  hpFill.classList.remove("rpgHpFlash");
  void hpFill.offsetWidth;
  hpFill.classList.add("rpgHpFlash");
  hpFill.classList.toggle("rpgHpDanger", newHp > 0 && rpgMonsterMaxHp > 0 && newHp <= rpgMonsterMaxHp * 0.25);

  // Boss hits carry more weight: a brief red flash across the whole
  // battle screen, on top of the monster's own (larger) shake above.
  if (rpgIsBossBattle) {
    const screen = document.getElementById("rpgBattleScreen");
    screen.classList.remove("rpgBossFlash");
    void screen.offsetWidth;
    screen.classList.add("rpgBossFlash");
  }
}

// The final hit gets a brief (~1.5-3s total) special sequence before the
// result screen appears — FINAL HIT -> monster shake -> DEFEATED -> result.
// HP is already frozen at 0 by the time this runs (rpgDetectionRunning is
// set false first, so no further reps can be processed during this window).
function playRpgDefeatSequence() {
  return new Promise(resolve => {
    const icon = document.getElementById("battleMonsterIcon");
    const finalHitBanner = document.getElementById("rpgFinalHitBanner");
    const defeatedBanner = document.getElementById("rpgDefeatedBanner");
    const prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stepMs = prefersReducedMotion ? 150 : (rpgIsBossBattle ? 1200 : 900);
    const shakeClass = rpgIsBossBattle ? "rpgBossHitShake" : "rpgMonsterShake";

    if (rpgIsBossBattle) {
      defeatedBanner.textContent = "ASHEN GUARDIAN DEFEATED";
      spawnEmberParticles(document.getElementById("battleMonsterHeader"), 16);
    } else {
      defeatedBanner.textContent = "DEFEATED!";
    }

    finalHitBanner.classList.remove("hidden");
    icon.classList.remove("rpgMonsterShake", "rpgBossHitShake");
    void icon.offsetWidth;
    icon.classList.add(shakeClass);

    setTimeout(() => {
      finalHitBanner.classList.add("hidden");
      icon.classList.add("rpgMonsterDefeated");
      defeatedBanner.classList.remove("hidden");
      setTimeout(() => {
        defeatedBanner.classList.add("hidden");
        icon.classList.remove("rpgMonsterDefeated", "rpgMonsterShake", "rpgBossHitShake");
        resolve();
      }, prefersReducedMotion ? 150 : (rpgIsBossBattle ? 1600 : 1200));
    }, stepMs);
  });
}

// ---------------------------------------------------------------- result
function showRpgResult(outcome) {
  const rewardsEl = document.getElementById("rpgResultRewards");
  const levelUpEl = document.getElementById("rpgLevelUpBanner");
  document.getElementById("rpgResultDamage").textContent = rpgMonsterMaxHp - rpgMonsterHp;

  const defeatedBefore = rpgProfileCache ? rpgProfileCache.monsters_defeated : 0;
  document.getElementById("rpgResultDefeated").textContent = `${defeatedBefore} → ${defeatedBefore + 1}`;

  document.getElementById("rpgResultTitle").textContent = "VICTORY!";
  document.getElementById("rpgResultSubtitle").textContent = `${outcome.reward.monster_theme_name || outcome.reward.monster_name} defeated`;
  document.getElementById("rpgResultXp").textContent = `+${outcome.reward.xp_reward} XP`;
  document.getElementById("rpgResultGold").textContent = `+${outcome.reward.gold_reward} Gold`;
  rewardsEl.classList.remove("hidden");
  rewardsEl.classList.remove("rpgRewardPop");
  void rewardsEl.offsetWidth;
  rewardsEl.classList.add("rpgRewardPop");
  if (outcome.reward.leveled_up) {
    levelUpEl.textContent = `🎉 LEVEL UP! You reached RPG Level ${outcome.reward.new_rpg_level}.`;
    levelUpEl.classList.remove("hidden");
    playBeep(1318, 0.2);
    spawnEmberParticles(levelUpEl, 8);
  } else {
    levelUpEl.classList.add("hidden");
  }

  showScreen("rpgResult");
  // Refresh RPG profile (XP/level/rank/gold/defeated/XP-bar progress) from
  // the server after victory rather than relying on the stale pre-battle
  // cache — the next time Home/RPG is opened it will already be correct.
  api("/rpg/profile").then(p => {
    rpgProfileCache = p;
    // The realm-completion moment (boss defeats only) layers ON TOP of the
    // normal victory screen rather than replacing it — the player still
    // sees the monster-defeat rewards, then this marketing-worthy moment.
    if (outcome.reward.realm_completed) {
      showRealmCompleteModal(outcome.reward.realm_completed, p.realms_completed, p.realms_total);
    }
  }).catch(() => {});
}

document.getElementById("rpgBattleAgainBtn").addEventListener("click", () => {
  showScreen("rpgHome");
  loadRpgHome();
});
document.getElementById("rpgBackToHomeBtn").addEventListener("click", () => {
  showScreen("rpgHome");
  loadRpgHome();
});

// After normal PvP resume logic runs, check for a resumable RPG battle —
// but ONLY to populate the optional "Continue Battle" card on Home. RPG is
// optional: login must always land on the normal Home/Lobby, never force
// the player into an old encounter or its camera. The previous behavior
// (auto-calling resumeRpgBattleIfAny(), which navigates straight into
// showScreen("rpgBattle") and starts the camera) was the root cause of
// that bug and has been removed — this only fetches state and renders a
// card the user can freely ignore.
const _origResumeActiveMatchIfAny2 = resumeActiveMatchIfAny;
resumeActiveMatchIfAny = async function() {
  await _origResumeActiveMatchIfAny2.apply(this, arguments);
  refreshHomeRpgContinueCard();
};

async function refreshHomeRpgContinueCard() {
  const card = document.getElementById("homeRpgContinueCard");
  try {
    const current = await api("/rpg/encounters/current");
    if (current.active) {
      document.getElementById("homeRpgContinueIcon").innerHTML = renderMonsterArt(current.monster_theme_name || current.monster_name, current.monster_difficulty, current.monster_is_boss, 30);
      document.getElementById("homeRpgContinueName").textContent = current.monster_theme_name || current.monster_name;
      document.getElementById("homeRpgContinueHp").textContent = `${current.monster_hp} / ${current.monster_max_hp} HP`;
      card.classList.remove("hidden");
      document.getElementById("homeRpgContinueBtn").onclick = () => {
        setActiveNav(document.getElementById("navRpgBtn"));
        enterRpgBattle(current.encounter_id, current.monster_theme_name || current.monster_name,
          current.monster_difficulty, current.monster_is_boss, current.monster_hp, current.monster_max_hp);
      };
    } else {
      card.classList.add("hidden");
    }
  } catch (e) {
    card.classList.add("hidden"); // best effort — never block/alter Home on failure
  }
}

// =============================================================================
// V1.5 correction: first-time AI camera onboarding. Reuses the SAME
// loadPoseModel()/angleBetween() as PvP/RPG (no third detector) for its
// live "body detected" / "full body visible" checks — the only two
// signals the existing algorithm can actually infer reliably. Side-view
// is NOT something the detector classifies, so it's shown as a static
// instruction only, never a fake live check (per the correction spec's
// explicit warning against inventing capabilities the detector lacks).
// =============================================================================

const CAMERA_SETUP_STORAGE_KEY = "pushupElo_cameraSetupDone";
let setupCameraStream = null;
let setupDetectionRunning = false;
let pendingSetupAction = null;

function ensureCameraSetupThenProceed(actionFn) {
  if (localStorage.getItem(CAMERA_SETUP_STORAGE_KEY) === "true") {
    actionFn();
    return;
  }
  pendingSetupAction = actionFn;
  showScreen("cameraSetup");
  startSetupCamera();
}

let setupPoseTracker = createPoseTrackerState();
async function startSetupCamera() {
  resetPoseTracker(setupPoseTracker);
  const video = document.getElementById("setupCameraVideo");
  const statusEl = document.getElementById("setupCameraStatus");
  try {
    statusEl.textContent = "📷 Starting camera…";
    statusEl.classList.remove("hidden");
    setupCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 640, height: 480 }, audio: false,
    });
    video.srcObject = setupCameraStream;
    await video.play();
    setCameraActiveIndicator("setupCameraActiveIndicator", true);

    statusEl.textContent = "🧠 Loading AI model…";
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), CONFIG.POSE_MODEL_TIMEOUT_MS)
    );
    await Promise.race([loadPoseModel(), timeoutPromise]); // SAME shared model
    statusEl.classList.add("hidden");
    setupDetectionRunning = true;
    requestAnimationFrame(setupDetectionLoop);
  } catch (err) {
    console.error("Camera setup init failed:", err);
    statusEl.textContent = "⚠️ Camera unavailable — you can still continue and use manual rep entry.";
  }
}

function stopSetupCamera() {
  setupDetectionRunning = false;
  setCameraActiveIndicator("setupCameraActiveIndicator", false);
  if (setupCameraStream) {
    setupCameraStream.getTracks().forEach(t => t.stop());
    setupCameraStream = null;
  }
}

function setupDetectionLoop() {
  if (!setupDetectionRunning) return;
  const video = document.getElementById("setupCameraVideo");
  const canvas = document.getElementById("setupCameraCanvas");
  const bodyCheck = document.getElementById("setupCheckBody");
  const fullBodyCheck = document.getElementById("setupCheckFullBody");

  if (video.readyState >= 2 && poseLandmarker) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    const result = poseLandmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (result.landmarks && result.landmarks.length > 0) {
      const lm = result.landmarks[0];
      bodyCheck.textContent = "🟢 Body detected";
      bodyCheck.classList.add("setupCheckGood");

      // SAME shared side-lock/smoothing pipeline as every other camera
      // screen (see trackPoseLandmarks) — no separate landmark-selection
      // logic here either. No rep in progress, so side-switching stays
      // always allowed (pass "up").
      const tracked = trackPoseLandmarks(setupPoseTracker, lm, "up");
      const idxObj = POSE_SIDE_LANDMARKS[tracked.side];
      const parts = [idxObj.shoulder, idxObj.elbow, idxObj.wrist, idxObj.hip, idxObj.knee, idxObj.ankle].map(i => lm[i]);
      const fullBodyVisible = parts.every(p => (p?.visibility || 0) > CONFIG.MIN_BODY_VISIBILITY);
      const personTooSmall = parts.every(p => p) && (Math.max(...parts.map(p => p.y)) - Math.min(...parts.map(p => p.y))) < 0.25;

      if (fullBodyVisible) {
        fullBodyCheck.textContent = "🟢 Full body visible — good position";
        fullBodyCheck.classList.add("setupCheckGood");
      } else if (personTooSmall) {
        fullBodyCheck.textContent = "🔴 Move closer to the camera";
        fullBodyCheck.classList.remove("setupCheckGood");
      } else {
        fullBodyCheck.textContent = "🔴 Move farther away so your full body is visible";
        fullBodyCheck.classList.remove("setupCheckGood");
      }

      // Draw a light skeleton for visual feedback, same style as match/RPG cameras.
      const toPx = p => ({ x: p.x * canvas.width, y: p.y * canvas.height });
      ctx.fillStyle = "#3ce8ff";
      parts.forEach(p => {
        if (!p) return;
        const px = toPx(p);
        ctx.beginPath();
        ctx.arc(px.x, px.y, 5, 0, 2 * Math.PI);
        ctx.fill();
      });
    } else {
      bodyCheck.textContent = "🔴 Body detected";
      bodyCheck.classList.remove("setupCheckGood");
      fullBodyCheck.textContent = "🔴 Full body visible";
      fullBodyCheck.classList.remove("setupCheckGood");
    }
  }

  requestAnimationFrame(setupDetectionLoop);
}

document.getElementById("setupContinueBtn").addEventListener("click", () => {
  stopSetupCamera();
  localStorage.setItem(CAMERA_SETUP_STORAGE_KEY, "true");
  const action = pendingSetupAction;
  pendingSetupAction = null;
  if (action) action();
});