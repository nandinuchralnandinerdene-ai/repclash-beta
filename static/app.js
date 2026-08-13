// =============================================================================
// REPCLASH — client
// V1.2: proper Ready state machine (WAITING -> READY -> IN_PROGRESS ->
// COMPLETED), server-synchronized countdown/timer, rematch flow. All V1.1
// protections (CSRF header, resume-after-refresh, stricter AI detection,
// manual-tap cooldown, resilient polling, nav-lock during match) preserved.
// =============================================================================

const CONFIG = {
  DOWN_ANGLE: 90,
  UP_ANGLE: 160,
  MIN_SHOULDER_MOVEMENT_RATIO: 0.035,
  MIN_REP_INTERVAL_MS: 500,
  MIN_LANDMARK_VISIBILITY: 0.5,
  MIN_BODY_VISIBILITY: 0.35,
  MAX_HIP_SAG_DEVIATION: 35,
  MANUAL_TAP_COOLDOWN_MS: 500,
  MAX_PUSHUPS_60S: 150,
  FEEDBACK_MIN_DISPLAY_MS: 800,
  POSE_MODEL_TIMEOUT_MS: 15000,
  MATCH_DURATION_SECONDS: 60,
  READY_POLL_MS: 1000,
  REMATCH_POLL_MS: 1500,
  CAMERA_READY_STABILITY_MS: 1000, // all conditions must hold continuously this long before auto-ready fires
  MIN_LIGHTING_BRIGHTNESS: 40, // 0-255 average luma; below this is flagged as too dark

  // --- Rep-counting reliability (root-cause fixes, not "maximum strictness") ---
  // A state transition (up->down or down->up) must hold for this many
  // CONSECUTIVE frames before it commits — filters single-frame pose
  // jitter from flipping the state machine without requiring every frame
  // to be perfect (that's a debounce window, not a stricter threshold).
  REP_STATE_CONFIRM_FRAMES: 2,
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
  MIN_SHOULDER_MOVEMENT_RATIO_OF_TORSO: 0.18,
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
let manualTapCooldownUntil = 0;
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
  try {
    me = await api("/me");
    updateUserBadge();
    await resumeActiveMatchIfAny();
  } catch (e) {
    showScreen("login");
  }
})();

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

// ---------------------------------------------------------------- auth tabs
document.getElementById("tabLoginBtn").addEventListener("click", () => {
  document.getElementById("tabLoginBtn").classList.add("active");
  document.getElementById("tabSignupBtn").classList.remove("active");
  document.getElementById("loginForm").classList.remove("hidden");
  document.getElementById("signupForm").classList.add("hidden");
});

document.getElementById("tabSignupBtn").addEventListener("click", () => {
  document.getElementById("tabSignupBtn").classList.add("active");
  document.getElementById("tabLoginBtn").classList.remove("active");
  document.getElementById("signupForm").classList.remove("hidden");
  document.getElementById("loginForm").classList.add("hidden");
});

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
  const errEl = document.getElementById("signupError");
  errEl.textContent = "";
  if (!username || !password) { errEl.textContent = "Please enter your username and password"; return; }
  try {
    me = await api("/signup", { method: "POST", body: JSON.stringify({ username, password }) });
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

async function loadProfile() {
  try {
    currentProfile = await api("/profile");
  } catch (e) {
    return; // best effort — leave whatever was last rendered
  }
  const p = currentProfile;

  document.getElementById("profileAvatar").textContent = avatarEmoji(p.avatar_id);
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
  document.getElementById("editProfileError").textContent = "";
  document.getElementById("editProfileForm").classList.remove("hidden");
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
  const errorEl = document.getElementById("editProfileError");

  const body = { bio, avatar_id: avatarId };
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
        li.innerHTML = `<span class="lbRank">${rankLabel}</span><span class="lbName"><strong>${u.username}</strong>${meTag}<br><span class="hint">${u.rank_tier} · ${u.wins}W/${u.losses}L/${u.draws}D</span></span><span class="lbElo">${u.elo}</span>`;
      } else {
        const sign = u.elo_gain > 0 ? "+" : "";
        li.innerHTML = `<span class="lbRank">${rankLabel}</span><span class="lbName"><strong>${u.username}</strong>${meTag}<br><span class="hint">${u.matches_in_window} matches</span></span><span class="lbElo">${sign}${u.elo_gain}</span>`;
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

function enterReadyScreen(match) {
  document.getElementById("opponentName").textContent =
    match.is_bot_match ? "🤖 Bot" : currentOpponent.username;
  document.getElementById("opponentElo").textContent = currentOpponent.elo;
  document.getElementById("readyTitle").textContent =
    match.is_bot_match ? "Bot Match Found!" : "Opponent Found!";
  updateReadyStatusUI(match);
  showScreen("ready");
  pollReadyState();
  startReadyCameraCheck();
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
    document.getElementById("readyCheckStatusText").textContent = "✓ YOU'RE READY — waiting for opponent…";
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
  let message = "⚠️ Move into camera view";

  if (result.landmarks && result.landmarks.length > 0) {
    const lm = result.landmarks[0];
    const leftVis = (lm[11]?.visibility || 0) + (lm[13]?.visibility || 0) + (lm[15]?.visibility || 0) + (lm[27]?.visibility || 0);
    const rightVis = (lm[12]?.visibility || 0) + (lm[14]?.visibility || 0) + (lm[16]?.visibility || 0) + (lm[28]?.visibility || 0);
    const useRight = rightVis >= leftVis;
    const idx = useRight ? [12, 14, 16, 24, 26, 28] : [11, 13, 15, 23, 25, 27];
    const parts = idx.map(i => lm[i]);
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
      message = "⚠️ Show your full body to the camera";
    } else if (!lightingOk) {
      message = "⚠️ Improve lighting";
    } else {
      allValid = true;
    }
  }

  if (allValid) {
    if (readyStableSince === null) readyStableSince = performance.now();
    const elapsed = performance.now() - readyStableSince;
    if (elapsed >= CONFIG.CAMERA_READY_STABILITY_MS) {
      statusText.textContent = "✓ You're ready!";
      stopReadyCameraCheck();
      sendReadySignal();
      return;
    }
    statusText.textContent = "✓ Good position — hold still…";
  } else {
    readyStableSince = null;
    statusText.textContent = message;
  }

  requestAnimationFrame(readyCameraCheckLoop);
}

// Resume a match that's already in_progress (e.g. after a refresh) using
// the server's authoritative timestamps rather than restarting a local timer.
function resumeInProgressMatch(match) {
  stopReadyCameraCheck();
  pushupCount = 0;
  document.getElementById("pushupCount").textContent = "0";
  showScreen("match");
  startCamera().then(() => {
    scheduleSynchronizedStart(match.exercise_starts_at, match.expires_at);
  });
}

function beginSynchronizedMatch(match) {
  stopReadyCameraCheck();
  pushupCount = 0;
  document.getElementById("pushupCount").textContent = "0";
  showScreen("match");
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

async function startCamera() {
  const video = document.getElementById("cameraVideo");
  const statusEl = document.getElementById("cameraStatus");
  repState = "up";
  downShoulderY = null;
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
  setManualButtonEnabled(false);

  try {
    statusEl.textContent = "📷 Starting camera…";
    statusEl.classList.remove("hidden");

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 640, height: 480 },
      audio: false,
    });
    video.srcObject = cameraStream;
    await video.play();

    statusEl.textContent = "🧠 Loading AI model… (first time takes ~10-15s)";

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("pose model load timed out")), CONFIG.POSE_MODEL_TIMEOUT_MS)
    );
    await Promise.race([loadPoseModel(), timeoutPromise]);

    statusEl.classList.add("hidden");
  } catch (err) {
    console.error("Camera/pose init failed:", err);
    statusEl.textContent = "⚠️ AI counting unavailable — use the Add Rep Manually button";
    setManualButtonEnabled(true);
  }
}

function setManualButtonEnabled(enabled) {
  const btn = document.getElementById("manualAddBtn");
  btn.disabled = !enabled;
  btn.classList.toggle("navDisabled", !enabled);
}

function stopCamera() {
  detectionRunning = false;
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
      const leftVis = (lm[11]?.visibility || 0) + (lm[13]?.visibility || 0) + (lm[15]?.visibility || 0);
      const rightVis = (lm[12]?.visibility || 0) + (lm[14]?.visibility || 0) + (lm[16]?.visibility || 0);
      const useRight = rightVis >= leftVis;
      const idx = useRight ? [12, 14, 16, 24, 26, 28] : [11, 13, 15, 23, 25, 27];
      const [s, e, w, hip, knee, ankle] = idx.map(i => lm[i]);

      if (s && e && w) {
        const toPx = p => ({ x: p.x * canvas.width, y: p.y * canvas.height });
        const angle = angleBetween(toPx(s), toPx(e), toPx(w));
        const shoulderPx = toPx(s);
        const hipPx = hip ? toPx(hip) : null;

        ctx.strokeStyle = "#3ce8ff";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(toPx(s).x, toPx(s).y);
        ctx.lineTo(toPx(e).x, toPx(e).y);
        ctx.lineTo(toPx(w).x, toPx(w).y);
        ctx.stroke();
        [s, e, w].forEach(p => {
          const px = toPx(p);
          ctx.fillStyle = "#ff5a3c";
          ctx.beginPath();
          ctx.arc(px.x, px.y, 6, 0, 2 * Math.PI);
          ctx.fill();
        });

        const coreVisible = [s, e, w, hip].every(p => (p?.visibility || 0) > CONFIG.MIN_LANDMARK_VISIBILITY);
        const bodyVisible = [knee, ankle].every(p => (p?.visibility || 0) > CONFIG.MIN_BODY_VISIBILITY);

        let goodAlignment = true;
        if (hip && knee && coreVisible) {
          const hipAngle = angleBetween(toPx(s), toPx(hip), toPx(knee));
          goodAlignment = Math.abs(180 - hipAngle) < CONFIG.MAX_HIP_SAG_DEVIATION;
        }

        // Practical, non-blocking liveness signal — see checkLivenessSignal
        // for what this is (and isn't). Never affects canCount/rep counting.
        if (coreVisible) {
          const zResult = checkLivenessSignal({ shoulder: s, elbow: e, wrist: w, hip, knee, ankle }, flatZStreak);
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
        } else if (!goodAlignment) {
          setDetectionFeedback("Keep your body straight (don't sag your hips).");
        } else if (repState === "down") {
          setDetectionFeedback("Go a bit lower and fully extend your arms!");
        } else {
          setDetectionFeedback("Good — keep going!");
        }

        const canCount = coreVisible && bodyVisible && goodAlignment;

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

        // Debounce: a threshold crossing must hold for REP_STATE_CONFIRM_FRAMES
        // consecutive frames before the state actually transitions — a
        // single noisy frame (pose jitter) can no longer flip the state
        // machine on its own.
        if (repState === "up" && angle < CONFIG.DOWN_ANGLE) {
          pendingDownFrames += 1;
          pendingUpFrames = 0;
          if (pendingDownFrames >= CONFIG.REP_STATE_CONFIRM_FRAMES) {
            repState = "down";
            pendingDownFrames = 0;
            downShoulderY = shoulderPx.y;
            downBodyScale = hipPx ? Math.hypot(shoulderPx.x - hipPx.x, shoulderPx.y - hipPx.y) : null;
            repWasValidThroughout = canCount;
            invalidStreak = 0;
          }
        } else if (repState === "down" && angle > CONFIG.UP_ANGLE) {
          pendingUpFrames += 1;
          pendingDownFrames = 0;
          if (pendingUpFrames >= CONFIG.REP_STATE_CONFIRM_FRAMES) {
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
            const shoulderMoved =
              downShoulderY !== null && Math.abs(shoulderPx.y - downShoulderY) > threshold;
            const enoughTimePassed = now - lastRepTimestamp > CONFIG.MIN_REP_INTERVAL_MS;
            const underCeiling = pushupCount < CONFIG.MAX_PUSHUPS_60S;

            if (repWasValidThroughout && canCount && shoulderMoved && enoughTimePassed && underCeiling) {
              lastRepTimestamp = now;
              pushupCount += 1;
              document.getElementById("pushupCount").textContent = pushupCount;
              if (navigator.vibrate) navigator.vibrate(15);
              playBeep(660, 0.08);
              setDetectionFeedback("Nice rep! 👍");
            }
            downShoulderY = null;
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

document.getElementById("manualAddBtn").addEventListener("click", () => {
  const now = performance.now();
  if (now < manualTapCooldownUntil) return;
  if (pushupCount >= CONFIG.MAX_PUSHUPS_60S) return;
  manualTapCooldownUntil = now + CONFIG.MANUAL_TAP_COOLDOWN_MS;
  pushupCount += 1;
  document.getElementById("pushupCount").textContent = pushupCount;
  playBeep(660, 0.08);
});

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

const NOTIF_POLL_MS = 15000;   // how often to refresh the unread-count badge
const HEARTBEAT_MS = 40000;    // how often to ping /api/heartbeat (last_seen)
let notifPollInterval = null;
let heartbeatInterval = null;

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
  notifPollInterval = setInterval(refreshUnreadBadge, NOTIF_POLL_MS);
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
  const who = n.actor_username || "Someone";
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
          <span class="friendListName">${u.username}</span>
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
        <span class="friendListName">${req.username}</span>
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
        <span class="friendListName">${req.username}</span>
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
        <span class="friendListName">${f.username}<br><span class="hint">${f.rank_tier} · ${f.elo} Elo${f.current_streak >= 2 ? " · 🔥" + f.current_streak : ""}</span></span>
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

    document.getElementById("publicProfileElo").textContent = p.elo;
    document.getElementById("publicProfileWins").textContent = p.wins;
    document.getElementById("publicProfileLosses").textContent = p.losses;
    document.getElementById("publicProfileBest").textContent = p.best_pushups;

    const achGrid = document.getElementById("publicProfileAchievements");
    achGrid.innerHTML = "";
    achGrid.className = "achievementsGridSmall";
    p.achievements.forEach(a => {
      const box = document.createElement("div");
      box.className = "achBadge" + (a.unlocked ? " unlocked" : " locked");
      box.title = a.name;
      box.textContent = a.icon;
      achGrid.appendChild(box);
    });

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
        li.innerHTML = `<span class="lbRank">${rankLabel}</span><span class="lbName"><strong>${u.username}</strong><br><span class="hint">${u.rank_tier}</span></span><span class="lbElo">${u.elo}</span>`;
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
  loadRpgHome();
  showScreen("rpgHome");
});

// screens map + setActiveNav need the new RPG screens/tab included.
screens.rpgHome = document.getElementById("rpgHomeScreen");
screens.rpgBattle = document.getElementById("rpgBattleScreen");
screens.rpgResult = document.getElementById("rpgResultScreen");
IN_MATCH_SCREENS.add("rpgBattle");

const _origSetActiveNav = setActiveNav;
setActiveNav = function(activeBtn) {
  document.getElementById("navRpgBtn").classList.remove("active");
  _origSetActiveNav(activeBtn);
};

let rpgProfileCache = null;

async function loadRpgHome() {
  try {
    const [profile, monsters, current] = await Promise.all([
      api("/rpg/profile"), api("/rpg/monsters"), api("/rpg/encounters/current"),
    ]);
    rpgProfileCache = profile;
    renderRpgHeader(profile);

    const continueBox = document.getElementById("rpgContinueBattleBox");
    if (current.active) {
      continueBox.classList.remove("hidden");
      continueBox.innerHTML = `
        <div class="monsterCardIcon">${current.monster_icon}</div>
        <div>
          <div class="monsterCardName">${current.monster_name}</div>
          <div class="hint">${current.monster_hp} / ${current.monster_max_hp} HP remaining</div>
        </div>
        <button id="rpgContinueBattleBtn">CONTINUE BATTLE</button>
        <button id="rpgChangeMonsterBtn" class="secondary">CHANGE MONSTER</button>
      `;
      document.getElementById("rpgContinueBattleBtn").addEventListener("click", () => {
        enterRpgBattle(current.encounter_id, current.monster_name, current.monster_icon,
          current.monster_hp, current.monster_max_hp);
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

    const grid = document.getElementById("monsterGrid");
    grid.innerHTML = "";
    monsters.forEach(m => {
      const card = document.createElement("div");
      card.className = "monsterCard";
      card.innerHTML = `
        <div class="monsterCardIcon">${m.icon}</div>
        <div class="monsterCardName">${m.name}</div>
        <div class="hint">${m.max_hp} HP · +${m.xp_reward} XP · +${m.gold_reward} Gold</div>
        <button class="monsterBattleBtn" data-id="${m.id}">BATTLE</button>
      `;
      card.querySelector(".monsterBattleBtn").addEventListener("click", () => startRpgBattle(m.id));
      grid.appendChild(card);
    });
  } catch (e) { /* best effort */ }
}

function renderRpgHeader(profile) {
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
    enterRpgBattle(current.encounter_id, current.monster_name, current.monster_icon,
      current.monster_hp, current.monster_max_hp);
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
  try {
    const res = await api("/rpg/encounters/start", { method: "POST", body: JSON.stringify({ monster_id: monsterId }) });
    const monsters = await api("/rpg/monsters");
    const monster = monsters.find(m => m.id === monsterId);
    rpgLevelBeforeBattle = rpgProfileCache ? rpgProfileCache.rpg_level : 1;
    enterRpgBattle(res.encounter_id, monster.name, monster.icon, res.monster_hp, res.monster_hp);
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
function enterRpgBattle(encounterId, monsterName, monsterIcon, monsterHp, monsterMaxHp) {
  rpgEncounterId = encounterId;
  rpgRepCount = 0;
  rpgMonsterHp = monsterHp;
  rpgMonsterMaxHp = monsterMaxHp;
  document.getElementById("battleMonsterName").textContent = monsterName;
  document.getElementById("battleMonsterIcon").textContent = monsterIcon;
  document.getElementById("rpgRepCount").textContent = "0";
  updateMonsterHpBar();
  showScreen("rpgBattle");
  ensureCameraSetupThenProceed(async () => {
    await startRpgCamera();
    rpgDetectionRunning = true;
    requestAnimationFrame(rpgDetectionLoop);
  });
}

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
let rpgPendingDownFrames = 0;
let rpgPendingUpFrames = 0;
let rpgRepWasValidThroughout = true;
let rpgInvalidStreak = 0;
let rpgLastRepTimestamp = 0;
let rpgLastFeedbackText = "";
let rpgLastFeedbackChangeTime = 0;
let rpgFlatZStreak = 0;
let rpgLivenessWarningShown = false;

async function startRpgCamera() {
  const video = document.getElementById("rpgCameraVideo");
  const statusEl = document.getElementById("rpgCameraStatus");
  rpgRepState = "up";
  rpgDownShoulderY = null;
  rpgDownBodyScale = null;
  rpgPendingDownFrames = 0;
  rpgPendingUpFrames = 0;
  rpgRepWasValidThroughout = true;
  rpgInvalidStreak = 0;
  rpgLastRepTimestamp = 0;
  rpgFlatZStreak = 0;
  rpgLivenessWarningShown = false;
  setRpgManualButtonEnabled(false);

  try {
    statusEl.textContent = "📷 Starting camera…";
    statusEl.classList.remove("hidden");
    rpgCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 640, height: 480 }, audio: false,
    });
    video.srcObject = rpgCameraStream;
    await video.play();

    statusEl.textContent = "🧠 Loading AI model…";
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("pose model load timed out")), CONFIG.POSE_MODEL_TIMEOUT_MS)
    );
    await Promise.race([loadPoseModel(), timeoutPromise]); // SAME singleton model as PvP
    rpgPoseReady = true;
    statusEl.classList.add("hidden");
  } catch (err) {
    console.error("RPG camera/pose init failed:", err);
    statusEl.textContent = "⚠️ Camera unavailable — use Add Rep Manually below";
    setRpgManualButtonEnabled(true);
  }
}

function setRpgManualButtonEnabled(enabled) {
  const btn = document.getElementById("rpgManualAddBtn");
  btn.disabled = !enabled;
  btn.classList.toggle("navDisabled", !enabled);
}

function stopRpgCamera() {
  rpgDetectionRunning = false;
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
      const leftVis = (lm[11]?.visibility || 0) + (lm[13]?.visibility || 0) + (lm[15]?.visibility || 0);
      const rightVis = (lm[12]?.visibility || 0) + (lm[14]?.visibility || 0) + (lm[16]?.visibility || 0);
      const useRight = rightVis >= leftVis;
      const idx = useRight ? [12, 14, 16, 24, 26, 28] : [11, 13, 15, 23, 25, 27];
      const [s, e, w, hip, knee, ankle] = idx.map(i => lm[i]);

      if (s && e && w) {
        const toPx = p => ({ x: p.x * canvas.width, y: p.y * canvas.height });
        const angle = angleBetween(toPx(s), toPx(e), toPx(w)); // SAME shared math as PvP
        const shoulderPx = toPx(s);
        const hipPx = hip ? toPx(hip) : null;

        ctx.strokeStyle = "#3ce8ff";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(toPx(s).x, toPx(s).y);
        ctx.lineTo(toPx(e).x, toPx(e).y);
        ctx.lineTo(toPx(w).x, toPx(w).y);
        ctx.stroke();
        [s, e, w].forEach(p => {
          const px = toPx(p);
          ctx.fillStyle = "#ff5a3c";
          ctx.beginPath();
          ctx.arc(px.x, px.y, 6, 0, 2 * Math.PI);
          ctx.fill();
        });

        // SAME thresholds/structure as PvP's detectionLoop — RPG must not
        // require anything beyond what PvP requires.
        const coreVisible = [s, e, w, hip].every(p => (p?.visibility || 0) > CONFIG.MIN_LANDMARK_VISIBILITY);
        const bodyVisible = [knee, ankle].every(p => (p?.visibility || 0) > CONFIG.MIN_BODY_VISIBILITY);
        let goodAlignment = true;
        if (hip && knee && coreVisible) {
          const hipAngle = angleBetween(toPx(s), toPx(hip), toPx(knee));
          goodAlignment = Math.abs(180 - hipAngle) < CONFIG.MAX_HIP_SAG_DEVIATION;
        }

        // SAME non-blocking liveness signal as PvP — never affects canCount.
        if (coreVisible) {
          const zResult = checkLivenessSignal({ shoulder: s, elbow: e, wrist: w, hip, knee, ankle }, rpgFlatZStreak);
          rpgFlatZStreak = zResult.streak;
          if (zResult.shouldWarn && !rpgLivenessWarningShown) {
            rpgLivenessWarningShown = true;
            showNotice("⚠️ This camera feed looks unusually flat for a real person — make sure you're live in front of the camera, not a recording.", 6000);
          }
        }

        if (!coreVisible) setRpgFeedback("⚠️ Show your full body to the camera.");
        else if (!bodyVisible) setRpgFeedback("Stand sideways, full body in frame.");
        else if (!goodAlignment) setRpgFeedback("Keep your body straight.");
        else if (rpgRepState === "down") setRpgFeedback("Go deeper, extend your arms!");
        else setRpgFeedback("Good — keep going!");

        const canCount = coreVisible && bodyVisible && goodAlignment;

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
          if (rpgPendingDownFrames >= CONFIG.REP_STATE_CONFIRM_FRAMES) {
            rpgRepState = "down";
            rpgPendingDownFrames = 0;
            rpgDownShoulderY = shoulderPx.y;
            rpgDownBodyScale = hipPx ? Math.hypot(shoulderPx.x - hipPx.x, shoulderPx.y - hipPx.y) : null;
            rpgRepWasValidThroughout = canCount;
            rpgInvalidStreak = 0;
          }
        } else if (rpgRepState === "down" && angle > CONFIG.UP_ANGLE) {
          rpgPendingUpFrames += 1;
          rpgPendingDownFrames = 0;
          if (rpgPendingUpFrames >= CONFIG.REP_STATE_CONFIRM_FRAMES) {
            rpgRepState = "up";
            rpgPendingUpFrames = 0;
            const now = performance.now();
            const threshold = rpgDownBodyScale
              ? CONFIG.MIN_SHOULDER_MOVEMENT_RATIO_OF_TORSO * rpgDownBodyScale
              : CONFIG.MIN_SHOULDER_MOVEMENT_RATIO * canvas.height;
            const shoulderMoved =
              rpgDownShoulderY !== null && Math.abs(shoulderPx.y - rpgDownShoulderY) > threshold;
            const enoughTimePassed = now - rpgLastRepTimestamp > CONFIG.MIN_REP_INTERVAL_MS;

            if (rpgRepWasValidThroughout && canCount && shoulderMoved && enoughTimePassed) {
              rpgLastRepTimestamp = now;
              registerRpgRep();
            }
            rpgDownShoulderY = null;
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

document.getElementById("rpgManualAddBtn").addEventListener("click", () => {
  const now = performance.now();
  if (now < manualTapCooldownUntil) return;
  manualTapCooldownUntil = now + CONFIG.MANUAL_TAP_COOLDOWN_MS;
  registerRpgRep();
});

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
  icon.classList.remove("rpgMonsterShake");
  void icon.offsetWidth; // restart the animation even on rapid consecutive hits
  icon.classList.add("rpgMonsterShake");

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
    const stepMs = prefersReducedMotion ? 150 : 900;

    finalHitBanner.classList.remove("hidden");
    icon.classList.remove("rpgMonsterShake");
    void icon.offsetWidth;
    icon.classList.add("rpgMonsterShake");

    setTimeout(() => {
      finalHitBanner.classList.add("hidden");
      icon.classList.add("rpgMonsterDefeated");
      defeatedBanner.classList.remove("hidden");
      setTimeout(() => {
        defeatedBanner.classList.add("hidden");
        icon.classList.remove("rpgMonsterDefeated", "rpgMonsterShake");
        resolve();
      }, prefersReducedMotion ? 150 : 1200);
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
  document.getElementById("rpgResultSubtitle").textContent = `${outcome.reward.monster_name} defeated`;
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
  } else {
    levelUpEl.classList.add("hidden");
  }

  showScreen("rpgResult");
  // Refresh RPG profile (XP/level/rank/gold/defeated/XP-bar progress) from
  // the server after victory rather than relying on the stale pre-battle
  // cache — the next time Home/RPG is opened it will already be correct.
  api("/rpg/profile").then(p => { rpgProfileCache = p; }).catch(() => {});
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
      document.getElementById("homeRpgContinueIcon").textContent = current.monster_icon;
      document.getElementById("homeRpgContinueName").textContent = current.monster_name;
      document.getElementById("homeRpgContinueHp").textContent = `${current.monster_hp} / ${current.monster_max_hp} HP`;
      card.classList.remove("hidden");
      document.getElementById("homeRpgContinueBtn").onclick = () => {
        setActiveNav(document.getElementById("navRpgBtn"));
        enterRpgBattle(current.encounter_id, current.monster_name, current.monster_icon,
          current.monster_hp, current.monster_max_hp);
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

async function startSetupCamera() {
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

      const leftVis = (lm[11]?.visibility || 0) + (lm[13]?.visibility || 0) + (lm[15]?.visibility || 0) + (lm[27]?.visibility || 0);
      const rightVis = (lm[12]?.visibility || 0) + (lm[14]?.visibility || 0) + (lm[16]?.visibility || 0) + (lm[28]?.visibility || 0);
      const useRight = rightVis >= leftVis;
      const idx = useRight ? [12, 14, 16, 24, 26, 28] : [11, 13, 15, 23, 25, 27];
      const parts = idx.map(i => lm[i]);
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